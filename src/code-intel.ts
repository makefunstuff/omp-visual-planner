/**
 * Language-server lookups for the file viewers: a file's outline, and what the
 * server knows about the identifier at a position (hover, definition,
 * references). Tree-sitter context lives in `code-evidence.ts`; this module only
 * asks a language server, and only when the human asks for it.
 *
 * The client is OMP's own (`@oh-my-pi/pi-coding-agent/lsp/*`), the same calls
 * OMP's `lsp` tool makes. It is loaded on first use, so a resolution failure
 * reports itself on the lookup instead of breaking extension load.
 */
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type * as LspClientModule from "@oh-my-pi/pi-coding-agent/lsp/client";
import type * as LspConfigModule from "@oh-my-pi/pi-coding-agent/lsp/config";
import type * as LspServersModule from "@oh-my-pi/pi-coding-agent/lsp/servers";
import type {
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	LspClient,
	ServerConfig,
	SymbolInformation,
	SymbolKind,
} from "@oh-my-pi/pi-coding-agent/lsp/types";
import type * as LspUtilsModule from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { MAX_VIEWER_FILE_BYTES, displayPath } from "./store.ts";
import { readWorkspaceFile } from "./workspace-files.ts";

export interface OutlineSymbol {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
	depth: number;
}

/** `path` is workspace-relative inside the workspace, absolute outside it. */
export interface CodeLocation {
	path: string;
	line: number;
	preview: string;
}

export interface SymbolFacts {
	hover: string;
	definitions: CodeLocation[];
	references: CodeLocation[];
	truncated: boolean;
}

export type IntelOutcome<T> = { ok: true; server: string; value: T } | { ok: false; reason: string };

export interface CodeIntel {
	outline(path: string, signal: AbortSignal): Promise<IntelOutcome<OutlineSymbol[]>>;
	symbolAt(path: string, line: number, character: number, signal: AbortSignal): Promise<IntelOutcome<SymbolFacts>>;
}

export const INTEL_TIMEOUT_MS = 20_000;
export const MAX_REFERENCES = 100;
const PREVIEW_CHARS = 160;
const MAX_IDENTIFIERS = 20;

/**
 * `DocumentSymbol[]` flattened depth-first, or `SymbolInformation[]` at depth 0.
 * `result` is a `textDocument/documentSymbol` answer; `kindName` names a symbol kind.
 */
export function normalizeOutline(result: unknown, kindName: (kind: number) => string): OutlineSymbol[] {
	if (!Array.isArray(result)) return [];
	const symbols: OutlineSymbol[] = [];
	const visit = (item: DocumentSymbol | SymbolInformation, depth: number): void => {
		const kind = kindName(item.kind);
		if ("selectionRange" in item || "children" in item) {
			const symbol = item as DocumentSymbol;
			symbols.push({ name: symbol.name, kind, startLine: symbol.range.start.line + 1, endLine: symbol.range.end.line + 1, depth });
			for (const child of symbol.children ?? []) visit(child, depth + 1);
			return;
		}
		const range = item.location.range;
		symbols.push({ name: item.name, kind, startLine: range.start.line + 1, endLine: range.end.line + 1, depth: 0 });
	};
	for (const item of result as (DocumentSymbol | SymbolInformation)[]) visit(item, 0);
	return symbols;
}

/** A definition or references answer — `Location`, `Location[]`, `LocationLink[]` or null — as 1-based lines. */
export function normalizeLocations(result: unknown): { uri: string; line: number }[] {
	if (result === null || result === undefined) return [];
	const items = (Array.isArray(result) ? result : [result]) as (Location | LocationLink)[];
	return items.map(item =>
		"targetUri" in item
			? { uri: item.targetUri, line: (item.targetSelectionRange ?? item.targetRange).start.line + 1 }
			: { uri: item.uri, line: item.range.start.line + 1 },
	);
}

/** The identifiers on a line, first occurrence of each, with 0-based columns. */
export function identifiersOn(text: string): { name: string; character: number }[] {
	const seen = new Set<string>();
	const found: { name: string; character: number }[] = [];
	for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
		if (seen.has(match[0])) continue;
		seen.add(match[0]);
		found.push({ name: match[0], character: match.index });
		if (found.length === MAX_IDENTIFIERS) break;
	}
	return found;
}

interface LspModules {
	client: typeof LspClientModule;
	config: typeof LspConfigModule;
	servers: typeof LspServersModule;
	utils: typeof LspUtilsModule;
}

interface LspContext {
	lsp: LspModules;
	client: LspClient;
	serverConfig: ServerConfig;
	abs: string;
	limit: AbortSignal;
}

let modules: Promise<LspModules> | undefined;

/**
 * Dynamic on purpose: the host's LSP client is an internal module of the agent
 * package. A static import that fails to resolve would stop the whole extension
 * from loading; loaded here, it only fails the lookup that needed it.
 */
function loadModules(): Promise<LspModules> {
	modules ??= (async () => ({
		client: await import("@oh-my-pi/pi-coding-agent/lsp/client"),
		config: await import("@oh-my-pi/pi-coding-agent/lsp/config"),
		servers: await import("@oh-my-pi/pi-coding-agent/lsp/servers"),
		utils: await import("@oh-my-pi/pi-coding-agent/lsp/utils"),
	}))();
	return modules;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One line of a file, trimmed and clipped; each file is read once per lookup. */
function previewer(): (file: string, line: number) => Promise<string> {
	const files = new Map<string, Promise<string[] | undefined>>();
	return async (file, line) => {
		let lines = files.get(file);
		if (lines === undefined) {
			lines = readFile(file, "utf8")
				.then(text => (text.length > MAX_VIEWER_FILE_BYTES ? undefined : text.split("\n")))
				.catch(() => undefined);
			files.set(file, lines);
		}
		return ((await lines)?.[line - 1] ?? "").trim().slice(0, PREVIEW_CHARS);
	};
}

/** Lookups through OMP's language-server client for files in `cwd`. */
export function lspCodeIntel(cwd: string): CodeIntel {
	async function withClient<T>(path: string, signal: AbortSignal, run: (context: LspContext) => Promise<T>): Promise<IntelOutcome<T>> {
		let lsp: LspModules;
		try {
			lsp = await loadModules();
		} catch (error) {
			modules = undefined;
			return { ok: false, reason: `language server access is unavailable: ${message(error)}` };
		}
		const read = await readWorkspaceFile(cwd, path);
		if (!read.ok) return { ok: false, reason: read.error };
		const abs = resolve(cwd, read.path);
		const server = lsp.servers.getLspServerForFile(lsp.config.getConfig(cwd), abs);
		if (server === null) return { ok: false, reason: `no language server is configured for ${extname(read.path) || read.path} files` };
		const [name, serverConfig] = server;
		const limit = AbortSignal.any([signal, AbortSignal.timeout(INTEL_TIMEOUT_MS)]);
		try {
			const client = await lsp.client.getOrCreateClient(serverConfig, cwd, undefined, limit);
			await lsp.client.reconcileFileFromDisk(client, abs, limit);
			return { ok: true, server: name, value: await run({ lsp, client, serverConfig, abs, limit }) };
		} catch (error) {
			if (limit.aborted && !signal.aborted) {
				return { ok: false, reason: `the language server did not answer within ${INTEL_TIMEOUT_MS / 1000} s` };
			}
			return { ok: false, reason: message(error) };
		}
	}

	return {
		outline: (path, signal) =>
			withClient(path, signal, async ({ lsp, client, abs, limit }) => {
				const result = await lsp.client.sendRequest(
					client,
					"textDocument/documentSymbol",
					{ textDocument: { uri: lsp.utils.fileToUri(abs) } },
					limit,
				);
				return normalizeOutline(result, kind => lsp.utils.symbolKindToName(kind as SymbolKind));
			}),
		symbolAt: (path, line, character, signal) =>
			withClient(path, signal, async ({ lsp, client, serverConfig, abs, limit }) => {
				const textDocument = { uri: lsp.utils.fileToUri(abs) };
				const position = { line: line - 1, character };
				if (lsp.servers.isProjectAwareLspServer(serverConfig)) await lsp.client.waitForProjectLoaded(client, limit);
				const hover = (await lsp.client.sendRequest(client, "textDocument/hover", { textDocument, position }, limit)) as Hover | null;
				const definition = await lsp.client.sendRequest(client, "textDocument/definition", { textDocument, position }, limit);
				const references = await lsp.client.sendRequest(
					client,
					"textDocument/references",
					{ textDocument, position, context: { includeDeclaration: true } },
					limit,
				);
				const preview = previewer();
				const located = async (entries: { uri: string; line: number }[]): Promise<CodeLocation[]> =>
					Promise.all(
						entries.map(async entry => {
							const file = lsp.utils.uriToFile(entry.uri);
							return { path: displayPath(file, cwd), line: entry.line, preview: await preview(file, entry.line) };
						}),
					);
				const allReferences = normalizeLocations(references);
				return {
					hover: hover?.contents ? lsp.utils.extractHoverText(hover.contents) : "",
					definitions: await located(normalizeLocations(definition)),
					references: await located(allReferences.slice(0, MAX_REFERENCES)),
					truncated: allReferences.length > MAX_REFERENCES,
				};
			}),
	};
}
