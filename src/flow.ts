/**
 * The block-by-block flow shared by the terminal screen, web mode and the
 * prompt composer: which verbs a purpose offers, what a status is called, how
 * the outline is walked, and how a request is composed. Pure — no pi-tui.
 */
import { basename, resolve } from "node:path";
import type { ActionKind, BeginInput } from "./actions.ts";
import { composePrompt } from "./compose.ts";
import {
	type Block,
	type BlockStatus,
	type DiagramDocument,
	type Intent,
	type Purpose,
	type Scope,
	eachBlock,
} from "./model.ts";
import { type DocumentStore, type SaveResult, defaultDiscoveryPath, defaultDocumentPath } from "./store.ts";

export type VerbId = "refine" | "breakdown" | "execute";

export interface Verb {
	id: VerbId;
	label: string;
	key: string;
	intent: Intent;
	kind: ActionKind;
}

const REFINE: Verb = { id: "refine", label: "Refine", key: "r", intent: "enhance", kind: "enhance" };
const EXECUTE: Verb = { id: "execute", label: "Execute", key: "X", intent: "execute", kind: "execute" };

/** The block verbs a document offers, in display order. */
export function verbsFor(purpose: Purpose): Verb[] {
	switch (purpose) {
		case "brainstorm":
			return [REFINE, { id: "breakdown", label: "Expand", key: "b", intent: "decompose", kind: "decompose" }];
		case "plan":
			return [REFINE, { id: "breakdown", label: "Break down", key: "b", intent: "decompose", kind: "decompose" }, EXECUTE];
		case "explore":
			return [
				{ id: "refine", label: "Investigate", key: "r", intent: "investigate", kind: "investigate" },
				{ id: "breakdown", label: "Map inside", key: "b", intent: "decompose", kind: "decompose" },
			];
	}
}

/** Statuses a human steps through with one key; brainstorm ideas have none. */
export function statusCycle(purpose: Purpose): BlockStatus[] {
	if (purpose === "plan") return ["open", "settled", "done"];
	if (purpose === "explore") return ["open", "settled"];
	return [];
}

export function statusLabel(purpose: Purpose, status: BlockStatus): string | undefined {
	if (purpose === "plan") return status === "open" ? "todo" : status === "settled" ? "planned" : "done";
	if (purpose === "explore") return status === "open" ? "unexplored" : "explored";
	return undefined;
}

export function statusGlyph(purpose: Purpose, status: BlockStatus): string {
	if (purpose === "plan") return status === "open" ? "○" : status === "settled" ? "◐" : "●";
	if (purpose === "explore") return status === "open" ? "○" : "●";
	return "";
}

/** The status after `status` in the cycle, wrapping; a status outside the cycle restarts it. */
export function nextStatus(purpose: Purpose, status: BlockStatus): BlockStatus | undefined {
	const cycle = statusCycle(purpose);
	if (cycle.length === 0) return undefined;
	const index = cycle.indexOf(status);
	return index === -1 ? cycle[0] : cycle[(index + 1) % cycle.length];
}

export interface OutlineRow {
	block: Block;
	depth: number;
	diagramId: string;
	parentId: string | undefined;
	hasChildren: boolean;
	collapsed: boolean;
}

/** Visible outline rows in depth-first authored order; a collapsed block hides its subtree. */
export function outlineRows(document: DiagramDocument, collapsed: ReadonlySet<string>): OutlineRow[] {
	const rows: OutlineRow[] = [];
	for (const { block, diagram, ancestors } of eachBlock(document.root)) {
		if (ancestors.some(ancestor => collapsed.has(ancestor.id))) continue;
		const hasChildren = (block.children?.blocks.length ?? 0) > 0;
		rows.push({
			block,
			depth: ancestors.length,
			diagramId: diagram.id,
			parentId: ancestors.at(-1)?.id,
			hasChildren,
			collapsed: hasChildren && collapsed.has(block.id),
		});
	}
	return rows;
}

/**
 * The next block to work on after `afterId`, wrapping, over every block.
 * Brainstorm has no status, so it is simply the next block.
 */
export function nextOpenBlock(document: DiagramDocument, afterId: string | undefined): string | undefined {
	const blocks = [...eachBlock(document.root)].map(location => location.block);
	const start = afterId === undefined ? -1 : blocks.findIndex(block => block.id === afterId);
	for (let step = 1; step <= blocks.length; step += 1) {
		const candidate = blocks[(start + step + blocks.length) % blocks.length]!;
		if (document.purpose === "brainstorm" || candidate.status === "open") return candidate.id;
	}
	return undefined;
}

export function progressLabel(document: DiagramDocument): string {
	const blocks = [...eachBlock(document.root)].map(location => location.block);
	if (document.purpose === "brainstorm") return `${blocks.length} ideas`;
	if (document.purpose === "explore") {
		return `${blocks.filter(block => block.status !== "open").length}/${blocks.length} explored`;
	}
	const planned = blocks.filter(block => block.status !== "open").length;
	const done = blocks.filter(block => block.status === "done").length;
	return `${planned}/${blocks.length} planned · ${done} done`;
}

export type PageField =
	| "title"
	| "description"
	| "expectedOutput"
	| "criteria"
	| "evidence"
	| "enhance"
	| "execute"
	| "sources";

/** Fields a block's page shows, in order. */
export function pageFields(purpose: Purpose): PageField[] {
	if (purpose === "brainstorm") return ["title", "description"];
	if (purpose === "explore") return ["title", "description", "evidence", "sources", "enhance"];
	return ["title", "description", "expectedOutput", "criteria", "evidence", "enhance", "execute", "sources"];
}

export function fieldLabel(purpose: Purpose, field: PageField): string {
	switch (field) {
		case "title":
			return "title";
		case "description":
			return purpose === "brainstorm" ? "note" : purpose === "explore" ? "notes" : "what";
		case "expectedOutput":
			return "expected output";
		case "criteria":
			return "acceptance";
		case "evidence":
			return "evidence";
		case "enhance":
			return purpose === "explore" ? "investigate notes" : "refine notes";
		case "execute":
			return "execute notes";
		case "sources":
			return purpose === "explore" ? "anchors" : "sources";
	}
}

export interface ProjectAction {
	kind: "draft" | "discover";
	label: string;
}

/** Whole-document requests offered when no block is focused. */
export function projectActions(purpose: Purpose): ProjectAction[] {
	if (purpose === "brainstorm") return [{ kind: "draft", label: "Seed from a prompt" }];
	if (purpose === "explore") return [{ kind: "discover", label: "Map a codebase" }];
	return [
		{ kind: "draft", label: "Draft from a brief" },
		{ kind: "discover", label: "Discover a codebase" },
	];
}

export type DocumentStart =
	| { kind: "draft"; goal: string; purpose: "brainstorm" | "plan" }
	| { kind: "discover"; target: string };

/** Replace the store's document with a fresh, named one and start saving it. */
export function startDocument(
	store: DocumentStore,
	cwd: string,
	start: DocumentStart,
): { document: DiagramDocument; save: Promise<SaveResult> } {
	let document: DiagramDocument;
	if (start.kind === "draft") {
		const firstLine = start.goal.split("\n").find(line => line.trim().length > 0)?.trim().slice(0, 60);
		const title = firstLine || (start.purpose === "brainstorm" ? "New brainstorm" : "New plan");
		document = store.newDocument(
			{ title, goal: start.goal.trim(), purpose: start.purpose },
			store.path ?? defaultDocumentPath(cwd),
		);
	} else {
		const name = basename(resolve(cwd, start.target)) || start.target;
		document = store.newDocument(
			{ title: `Discovery: ${name}`, goal: `Map the codebase under ${start.target}`, purpose: "explore" },
			defaultDiscoveryPath(cwd, start.target),
		);
	}
	return { document, save: store.save() };
}

export interface ComposedRequest {
	request: BeginInput;
	prompt: string;
	label: string;
	size: number;
}

/** Compose the prompt and the registry entry for one request. Throws `ScopeError` for an unknown scope. */
export function composeRequest(input: {
	document: DiagramDocument;
	kind: ActionKind;
	intent: Intent;
	scope: Scope;
	branchKey: string;
	baseDigest: string | undefined;
	/** Absolute directory the request may read: the discovery target, else the workspace. */
	codeRoot: string;
	requestId?: string;
}): ComposedRequest {
	const { document, kind, intent, scope, codeRoot } = input;
	const requestId = input.requestId ?? crypto.randomUUID();
	const composed = composePrompt(
		document,
		scope,
		intent,
		kind === "execute" ? { codeRoot } : { request: { requestId, baseRevision: document.revision }, codeRoot },
	);
	return {
		request: {
			requestId,
			kind,
			intent,
			scope,
			label: composed.label,
			branchKey: input.branchKey,
			documentId: document.id,
			baseRevision: document.revision,
			baseDigest: input.baseDigest,
			prompt: composed.text,
		},
		prompt: composed.text,
		label: composed.label,
		size: composed.size,
	};
}

/** The directory a request may read: a discovery reads its target, everything else the workspace. */
export function codeRootFor(cwd: string, start: DocumentStart | undefined): string {
	return start?.kind === "discover" ? resolve(cwd, start.target) : resolve(cwd);
}
