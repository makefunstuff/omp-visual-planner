/**
 * Bounded, read-only source insight for one cited anchor line.
 *
 * A document cites code as `path:start-end`; when a person opens one of those
 * anchors the page asks what the cited line actually belongs to. The answer
 * comes from the same Tree-sitter grammars the highlighter uses: the outermost
 * syntax block that begins on the line, plus the chain of parser nodes the line
 * sits inside. Both are syntax, and `limitation` says so — nothing here claims
 * to be a semantic reference.
 *
 * No language server is consulted here: this answer is syntax only and never
 * starts a server. Semantic lookups (hover, definition, references, outline)
 * live in `code-intel.ts` and run only when a person asks for one.
 *
 * Reads go through `readWorkspaceFile`, so only files inside the workspace are
 * reachable and the viewer's byte and line limits still bound the work.
 */
import { type BlockRange, blockRangeAt, type NodeSpan, nodeChainAt, supportsLanguage } from "@oh-my-pi/pi-natives";
import { getLanguageFromPath } from "@oh-my-pi/pi-tui";
import { MAX_SERVED_LINES, readWorkspaceFile } from "./workspace-files.ts";

/** Enclosing parser nodes reported for a line, innermost first. */
const MAX_REPORTED_NODES = 8;

/** Set whenever a parser block was resolved: the result is syntax, not semantics. */
export const SYNTAX_ONLY_LIMITATION =
	"syntax only: the range and node kinds come from a Tree-sitter parse and no language server is queried, so there are no semantic references, types or diagnostics";

/** 1-indexed inclusive line span of a resolved block. */
export interface SourceRange {
	startLine: number;
	endLine: number;
}

/** One enclosing parser node; `kind` is a grammar kind such as `function_declaration`. */
export interface SourceNode {
	kind: string;
	startLine: number;
	endLine: number;
}

export interface SourceInsight {
	/** Workspace-relative path that was inspected. */
	path: string;
	/** The cited 1-indexed line, echoed back. */
	line: number;
	/** Outermost syntax block beginning on `line`, when a parser resolved one. */
	range?: SourceRange;
	/** Enclosing parser nodes, innermost first, at most 8 of them. */
	symbols?: SourceNode[];
	/** What the result covers and what it does not; always set. */
	limitation: string;
}

export type SourceInspection = (SourceInsight & { ok: true }) | { ok: false; status: number; error: string };

/**
 * Inspect one cited line, refusing anything outside the workspace.
 *
 * Failures follow `readWorkspaceFile`: 400 for a path that is not
 * workspace-relative or is not a file, 403 when a symlink leads out of the
 * workspace, 404 when it is missing, 413 and 415 when it is too large or
 * binary. A line past the end of the file is not a failure — it comes back with
 * a `limitation` and no context.
 */
export async function inspectSource(cwd: string, path: string, line: number): Promise<SourceInspection> {
	if (!Number.isSafeInteger(line) || line < 1) return { ok: false, status: 400, error: "line must be a positive whole number" };
	const read = await readWorkspaceFile(cwd, path);
	if (!read.ok) return read;
	if (line > read.lines.length) {
		return {
			ok: true,
			path: read.path,
			line,
			limitation: read.truncated
				? `line ${line} is beyond the ${MAX_SERVED_LINES} lines this reader serves`
				: `${read.path} has only ${read.lines.length} line${read.lines.length === 1 ? "" : "s"}`,
		};
	}
	const code = read.lines.join("\n");
	let range: BlockRange | null = null;
	let chain: NodeSpan[] | null = null;
	let failed = false;
	try {
		range = blockRangeAt({ code, path: read.path, line });
		chain = nodeChainAt({ code, path: read.path, line });
	} catch {
		failed = true;
	}
	const language = getLanguageFromPath(read.path);
	let limitation: string;
	if (range) limitation = SYNTAX_ONLY_LIMITATION;
	else if (failed) limitation = "the parser could not read this file, so the cited line has no syntax context";
	else if (language !== undefined && supportsLanguage(language)) limitation = `no syntax block begins at line ${line}`;
	else limitation = `no Tree-sitter grammar for ${language ?? "this file type"}, so the cited line has no syntax context`;
	const insight: SourceInsight = { path: read.path, line, limitation };
	if (range) insight.range = { startLine: range.startLine, endLine: range.endLine };
	if (chain)
		insight.symbols = chain
			.slice(0, MAX_REPORTED_NODES)
			.map(node => ({ kind: node.kind, startLine: node.startLine, endLine: node.endLine }));
	return { ok: true, ...insight };
}
