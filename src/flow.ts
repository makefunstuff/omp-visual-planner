/**
 * The block-by-block flow shared by the terminal screen, web mode and the
 * prompt composer: which verbs a purpose offers, what a status is called, how
 * the outline is walked, and how a request is composed. Pure — no pi-tui.
 */
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ActionKind, BeginInput } from "./actions.ts";
import {
	type BatchMember,
	type ComposeOptions,
	type RelatedContext,
	clip,
	composeBatchPrompt,
	composePrompt,
	pathLabel,
} from "./compose.ts";
import {
	type Block,
	type BlockStatus,
	type DiagramDocument,
	type ExtractResult,
	type Intent,
	type Purpose,
	type Scope,
	type SourceRef,
	type Surface,
	type Venue,
	VENUES,
	descendantIds,
	eachBlock,
	findBlockLocation,
	createBlock,
	formatSourceRef,
} from "./model.ts";
import {
	type DocumentStore,
	type SaveResult,
	codebaseMapPath,
	defaultDiscoveryPath,
	defaultDocumentPath,
	displayPath,
	freshChangePath,
} from "./store.ts";
import type { SyncContext } from "./drift.ts";

export type VerbId = "refine" | "breakdown" | "execute" | "replan" | "prune" | "sync" | "clarify";

export interface Verb {
	id: VerbId;
	label: string;
	key: string;
	intent: Intent;
	kind: ActionKind;
}

const REFINE: Verb = { id: "refine", label: "Refine", key: "r", intent: "enhance", kind: "enhance" };
const REPLAN: Verb = { id: "replan", label: "Replan", key: "t", intent: "replan", kind: "replan" };
const EXECUTE: Verb = { id: "execute", label: "Execute", key: "X", intent: "execute", kind: "execute" };
/** Re-grounds a block whose cited code drifted. Offered by the drift views, not by `verbsFor`. */
export const SYNC: Verb = { id: "sync", label: "Sync", key: "Y", intent: "sync", kind: "sync" };
/** Answers a question about cited lines. Offered by the file viewers, not by `verbsFor`. */
export const CLARIFY: Verb = { id: "clarify", label: "Ask", key: "Q", intent: "clarify", kind: "clarify" };

/** The block verbs a document offers, in display order. */
export function verbsFor(purpose: Purpose): Verb[] {
	switch (purpose) {
		case "brainstorm":
			return [REFINE, { id: "breakdown", label: "Expand", key: "b", intent: "decompose", kind: "decompose" }, REPLAN];
		case "plan":
			return [
				REFINE,
				{ id: "breakdown", label: "Break down", key: "b", intent: "decompose", kind: "decompose" },
				REPLAN,
				EXECUTE,
			];
		case "explore":
			return [
				{ id: "refine", label: "Investigate", key: "r", intent: "investigate", kind: "investigate" },
				{ id: "breakdown", label: "Map inside", key: "b", intent: "decompose", kind: "decompose" },
				REPLAN,
			];
	}
}

/** A verb by id: every verb `verbsFor` offers, plus Sync and Ask. */
export function verbById(purpose: Purpose, id: string): Verb | undefined {
	if (id === "sync") return SYNC;
	if (id === "clarify") return CLARIFY;
	return verbsFor(purpose).find(verb => verb.id === id);
}

export type LineRequestKind = "change" | "ask";

/** The block a request on selected code lines adds: a change to make, or a question to answer. */
export function lineRequestBlock(input: { kind: LineRequestKind; text: string; source: SourceRef }): Block {
	const first = input.text.split("\n").find(line => line.trim().length > 0)?.trim() ?? "";
	return input.kind === "change"
		? createBlock({ title: clip(first, 60), description: input.text.trim(), sources: [input.source], evidence: "observed" })
		: createBlock({
				title: clip(`Q: ${first}`, 60),
				description: `Question: ${input.text.trim()}`,
				sources: [input.source],
				evidence: "unknown",
			});
}

/** The request a line request previews: Ask for a question, the purpose's Refine for a change. */
export function lineRequestVerb(purpose: Purpose, kind: LineRequestKind): Verb {
	return kind === "ask" ? CLARIFY : verbsFor(purpose).find(verb => verb.id === "refine")!;
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

export interface UseCandidate {
	block: Block;
	depth: number;
	used: boolean;
}

/** Blocks `blockId` may use, in document order: everything except itself, what contains it and what it contains. */
export function useCandidates(document: DiagramDocument, blockId: string): UseCandidate[] {
	const location = findBlockLocation(document.root, blockId);
	if (!location) return [];
	const excluded = new Set([blockId, ...location.ancestors.map(ancestor => ancestor.id), ...descendantIds(location.block)]);
	const candidates: UseCandidate[] = [];
	for (const entry of eachBlock(document.root)) {
		if (excluded.has(entry.block.id)) continue;
		candidates.push({
			block: entry.block,
			depth: entry.ancestors.length,
			used: location.block.uses?.includes(entry.block.id) ?? false,
		});
	}
	return candidates;
}

/** What just happened, in words: the moved block and the links extract turned into uses. */
export function extractedMessage(document: DiagramDocument, blockId: string, result: ExtractResult): string {
	const title = (id: string): string => {
		const block = findBlockLocation(document.root, id)?.block;
		return block === undefined ? id : block.title.length > 0 ? block.title : block.id;
	};
	const links = result.converted.length;
	const tail = links > 0 ? `; ${links} link${links === 1 ? "" : "s"} became uses` : "";
	return `extracted "${title(blockId)}" — "${title(result.formerParentId)}" now uses it${tail}`;
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

export interface NextStep {
	/** The one control to put first. */
	label: string;
	/** One sentence for the idle hint. */
	detail: string;
	verb?: VerbId;
	act: "verb" | "status" | "implement" | "enter" | "add";
}

/** The fence Refine draws for a page or component. */
const WIREFRAME = /^\s*(```|~~~)\s*wireframe\b/m;

/** The body of the first wireframe fence in a description, or undefined when there is none. */
export function wireframeOf(description: string): string | undefined {
	const lines = description.split("\n");
	const start = lines.findIndex(line => /^\s*(```|~~~)\s*wireframe\b/.test(line));
	if (start === -1) return undefined;
	const marker = lines[start]!.trim().slice(0, 3);
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trimStart().startsWith(marker)) break;
		body.push(line);
	}
	return body.join("\n");
}

function sketchStep(block: Block): NextStep {
	return {
		label: "Sketch",
		detail: `This ${block.surface} has no mockup yet. Sketch draws a wireframe and an HTML mockup: layout, primary action and states.`,
		verb: "refine",
		act: "verb",
	};
}

/** What to do with the focused block. Both surfaces show this instead of a key list. */
export function nextStep(document: DiagramDocument, block: Block | undefined): NextStep {
	const purpose = document.purpose;
	if (!block) {
		return document.root.blocks.length === 0
			? { label: "Add a block", detail: "Start with one block. The next action is always on the focused block.", act: "add" }
			: { label: "Select a block", detail: "Select a block. The next action is on that block, not on the project.", act: "add" };
	}
	const children = block.children?.blocks ?? [];
	const written = block.description.trim().length > 0 || block.acceptanceCriteria.length > 0;
	const unsketched = block.surface !== undefined && (block.mockup === undefined || !WIREFRAME.test(block.description));
	if (purpose === "brainstorm") {
		if (unsketched) return sketchStep(block);
		return written
			? { label: "Implement", detail: "The idea is written. Implement turns this into a plan and opens Execute on this block.", act: "implement" }
			: { label: "Expand", detail: "This is still a title. Expand it, or dump a line onto it.", verb: "breakdown", act: "verb" };
	}
	if (purpose === "explore") {
		if (block.sources.length === 0) {
			return { label: "Investigate", detail: "No citation yet. Investigate fills this block from code you can open.", verb: "refine", act: "verb" };
		}
		if (block.status === "open") return { label: "Mark explored", detail: "Cited. Marking it explored leaves the walk for the full page.", act: "status" };
		return children.length === 0
			? { label: "Map inside", detail: "Explored, and nothing is nested yet. Map inside only if this block still hides structure.", verb: "breakdown", act: "verb" }
			: { label: "Open inside", detail: "The internals are mapped. Open them.", act: "enter" };
	}
	if (unsketched && block.status !== "done") return sketchStep(block);
	if (children.length > 0) {
		const open = children.find(child => child.status !== "done");
		return open
			? { label: "Open inside", detail: `"${open.title}" is not done. Execute runs a leaf, not this parent.`, act: "enter" }
			: { label: "Execute", detail: "The children are done or ready. Execute dispatches the ready leaves.", verb: "execute", act: "verb" };
	}
	if (!written) return { label: "Refine", detail: "No description yet. Refine this block before executing it.", verb: "refine", act: "verb" };
	if (block.status === "done") return { label: "Next open", detail: "This leaf is done. n selects the next open block.", act: "add" };
	return {
		label: "Execute",
		detail: block.status === "open" ? "Written. Execute runs this leaf. Space marks it planned if you want that recorded first." : "Planned. Execute runs this leaf.",
		verb: "execute",
		act: "verb",
	};
}

export interface ScreenCard {
	id: string;
	title: string;
	surface: Surface;
	/** Ancestor titles joined with " › "; empty at top level. */
	path: string;
	hasMockup: boolean;
	wireframe: string | undefined;
	/** Pages this page navigates to; empty for a component. */
	links: { id: string; title: string; label: string }[];
	/** Surfaces that use or contain this component; empty for a page. */
	usedBy: { id: string; title: string }[];
}

export interface ScreenBoard {
	pages: ScreenCard[];
	components: ScreenCard[];
}

/** Every page and component in document order, with page navigation and where each component is used. */
export function screenBoard(document: DiagramDocument): ScreenBoard {
	const all = [...eachBlock(document.root)];
	const titleOf = (block: Block): string => (block.title.length > 0 ? block.title : block.id);
	const board: ScreenBoard = { pages: [], components: [] };
	for (const { block, diagram, ancestors } of all) {
		const surface = block.surface;
		if (surface === undefined) continue;
		const links: ScreenCard["links"] = [];
		const usedBy: ScreenCard["usedBy"] = [];
		if (surface === "page") {
			for (const edge of diagram.edges) {
				const otherId = edge.from === block.id ? edge.to : edge.to === block.id && edge.direction === "both" ? edge.from : undefined;
				if (otherId === undefined || otherId === block.id) continue;
				const other = diagram.blocks.find(candidate => candidate.id === otherId);
				if (other?.surface === "page") links.push({ id: other.id, title: titleOf(other), label: edge.label });
			}
		} else {
			const containers = new Set(ancestors.map(ancestor => ancestor.id));
			for (const { block: user } of all) {
				if (user.surface === undefined || user.id === block.id) continue;
				if (containers.has(user.id) || user.uses?.includes(block.id)) usedBy.push({ id: user.id, title: titleOf(user) });
			}
		}
		const card: ScreenCard = {
			id: block.id,
			title: titleOf(block),
			surface,
			path: ancestors.map(titleOf).join(" › "),
			hasMockup: block.mockup !== undefined,
			wireframe: wireframeOf(block.description),
			links,
			usedBy,
		};
		(surface === "page" ? board.pages : board.components).push(card);
	}
	return board;
}

export type PageField =
	| "title"
	| "description"
	| "expectedOutput"
	| "criteria"
	| "evidence"
	| "enhance"
	| "execute"
	| "surface"
	| "venue"
	| "sources";

/** Fields a block's page shows, in order. */
export function pageFields(purpose: Purpose): PageField[] {
	if (purpose === "brainstorm") return ["title", "description", "surface"];
	if (purpose === "explore") return ["title", "description", "evidence", "sources", "enhance"];
	return [
		"title",
		"description",
		"expectedOutput",
		"criteria",
		"evidence",
		"surface",
		"venue",
		"enhance",
		"execute",
		"sources",
	];
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
		case "surface":
			return "surface";
		case "venue":
			return "venue";
		case "sources":
			return purpose === "explore" ? "anchors" : "sources";
	}
}

export interface ProjectAction {
	/** The request this action submits, or the start flow it opens. */
	kind: "draft" | "discover" | "change" | "replan" | "prune" | "execute";
	label: string;
}

const PROJECT_REPLAN: ProjectAction = { kind: "replan", label: "Replan the document" };
const PROJECT_PRUNE: ProjectAction = { kind: "prune", label: "Prune unnecessary blocks" };
const PROJECT_CHANGE: ProjectAction = { kind: "change", label: "Plan a change to this codebase" };

/**
 * Whole-document actions offered when no block is focused. `draft`, `discover`
 * and `change` start a new document; `replan` and `prune` submit a project-scope
 * request against the one that is open.
 */
export function projectActions(purpose: Purpose): ProjectAction[] {
	if (purpose === "brainstorm") return [{ kind: "draft", label: "Seed from a prompt" }, PROJECT_REPLAN, PROJECT_PRUNE];
	if (purpose === "explore") return [{ kind: "discover", label: "Map a codebase" }, PROJECT_CHANGE, PROJECT_REPLAN, PROJECT_PRUNE];
	return [
		{ kind: "draft", label: "Draft from a brief" },
		{ kind: "discover", label: "Discover a codebase" },
		PROJECT_CHANGE,
		PROJECT_REPLAN,
		PROJECT_PRUNE,
		{ kind: "execute", label: "Execute ready leaves" },
	];
}

export type DocumentStart =
	| { kind: "draft"; goal: string; purpose: "brainstorm" | "plan" }
	| { kind: "discover"; target: string }
	| { kind: "change"; goal: string };

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
	} else if (start.kind === "change") {
		// A change plan gets its own file: it never overwrites the workspace plan or a map.
		const title = start.goal.split("\n").find(line => line.trim().length > 0)?.trim().slice(0, 60) || "New change";
		document = store.newDocument({ title, goal: start.goal.trim(), purpose: "plan" }, freshChangePath(cwd, title));
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
	/** Outside blocks the judge ranked for this request; included at or above the floor. */
	related?: RelatedContext;
	/** A change plan's map and starting points. */
	change?: ComposeOptions["change"];
	/** What drifted, for a Sync. */
	drift?: SyncContext;
}): ComposedRequest {
	const { document, kind, intent, scope, codeRoot } = input;
	const requestId = input.requestId ?? crypto.randomUUID();
	const composed = composePrompt(
		document,
		scope,
		intent,
		kind === "execute"
			? { codeRoot }
			: {
					request: { requestId, baseRevision: document.revision },
					codeRoot,
					related: input.related,
					change: input.change,
					drift: input.drift,
				},
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

/**
 * Where a change plan starts. The map is the explore document open now, else
 * the workspace's `discover .` map; starting points are the blocks marked on an
 * explore document. Read before `startDocument` replaces the document.
 */
export function changeContext(
	document: DiagramDocument | undefined,
	documentPath: string | undefined,
	cwd: string,
	markedIds: readonly string[],
	selected: readonly SourceRef[] = [],
): NonNullable<ComposeOptions["change"]> {
	const exploring = document?.purpose === "explore" ? document : undefined;
	const map = exploring !== undefined && documentPath !== undefined ? documentPath : codebaseMapPath(cwd);
	const startingPoints: NonNullable<ComposeOptions["change"]>["startingPoints"] = [];
	if (exploring) {
		for (const id of markedIds) {
			const location = findBlockLocation(exploring.root, id);
			if (!location) continue;
			startingPoints.push({
				path: pathLabel(location, exploring),
				description: clip(location.block.description, 400),
				sources: [...location.block.sources],
			});
		}
	}
	for (const source of selected) {
		startingPoints.push({ path: formatSourceRef(source), description: "selected in the file viewer", sources: [source] });
	}
	return { ...(map !== undefined ? { mapPath: displayPath(map, cwd) } : {}), startingPoints };
}

/** A batch request the member prompts, the parent prompt and the preview could not be built for. */
export class BatchError extends Error {}

/** Where a batch's per-member instruction files live. Small, and left to the OS temp cleaner. */
export function batchDir(batchId: string): string {
	return join(tmpdir(), "omp-visual-planner", batchId);
}

export interface ComposedBatch {
	batchId: string;
	requests: BeginInput[];
	/** One instructions file per member, for its subagent to read. */
	files: { path: string; text: string }[];
	/** What the parent session is sent. */
	prompt: string;
	/** The parent prompt followed by every member's file. */
	preview: string;
	label: string;
	size: number;
}

/**
 * One block request per marked block, run in parallel by subagents the parent
 * session spawns. Throws `BatchError` when the set cannot run as a batch.
 */
export function composeBatch(input: {
	document: DiagramDocument;
	verb: Verb;
	ids: readonly string[];
	branchKey: string;
	baseDigest: string | undefined;
	codeRoot: string;
	batchId?: string;
	requestIds?: readonly string[];
	related?: ReadonlyMap<string, RelatedContext>;
	/** What drifted, for a Sync batch. */
	drift?: SyncContext;
}): ComposedBatch {
	const { document, verb, ids } = input;
	if (verb.kind === "execute") throw new BatchError("execute does not run as a batch; use Execute on the parent");
	if (ids.length < 2) throw new BatchError("mark at least two blocks for a batch");
	const locations = ids.map(id => {
		const location = findBlockLocation(document.root, id);
		if (!location) throw new BatchError(`no block ${id}`);
		return location;
	});
	const marked = new Set(ids);
	const titleOf = (block: Block): string => (block.title.length > 0 ? block.title : block.id);
	for (const location of locations) {
		const outer = location.ancestors.find(ancestor => marked.has(ancestor.id));
		if (outer) throw new BatchError(`"${titleOf(location.block)}" is inside "${titleOf(outer)}"; unmark one of them`);
	}
	const batchId = input.batchId ?? crypto.randomUUID();
	const requests: BeginInput[] = [];
	const files: ComposedBatch["files"] = [];
	const members: BatchMember[] = [];
	ids.forEach((id, index) => {
		const requestId = input.requestIds?.[index] ?? crypto.randomUUID();
		const scope: Scope = { kind: "block", id };
		const composed = composePrompt(document, scope, verb.intent, {
			codeRoot: input.codeRoot,
			related: input.related?.get(id),
			returnVia: "output",
			drift: input.drift,
		});
		const path = join(batchDir(batchId), `${requestId}.md`);
		files.push({ path, text: composed.text });
		members.push({ requestId, baseRevision: document.revision, label: composed.label, path });
		requests.push({
			requestId,
			kind: verb.kind,
			intent: verb.intent,
			scope,
			label: composed.label,
			branchKey: input.branchKey,
			documentId: document.id,
			baseRevision: document.revision,
			baseDigest: input.baseDigest,
			prompt: composed.text,
			batchId,
		});
	});
	const prompt = composeBatchPrompt(verb.label, members);
	const preview = `${prompt}\n${files.map(file => `---- ${file.path} ----\n${file.text}`).join("\n")}`;
	return { batchId, requests, files, prompt, preview, label: `${verb.label} × ${ids.length} blocks`, size: preview.length };
}

export function venueOf(block: Block): Venue {
	return block.venue ?? "here";
}

export type HoldKind = "brainstorm" | "refine" | "blocked" | "done" | "container";

export interface DispatchLeaf {
	id: string;
	title: string;
	venue: Venue;
	acceptance: string[];
	notes: string;
	/** The files this leaf changes, as the plan cites them. */
	sources: SourceRef[];
}

export interface DispatchHold {
	id: string;
	title: string;
	kind: HoldKind;
	reason: string;
}

export interface DispatchPlan {
	/** Ready leaves, inbound neighbors in this list first. */
	run: DispatchLeaf[];
	held: DispatchHold[];
}

/** Execute found nothing it is allowed to run. */
export class DispatchError extends Error {}

/** Leaves an execute covers. A parent is a container: only its descendant leaves run. */
function leavesIn(document: DiagramDocument, scope: Scope): { leaves: Block[]; container: Block | undefined } {
	if (scope.kind === "block" && scope.id !== undefined) {
		const location = findBlockLocation(document.root, scope.id);
		if (!location) return { leaves: [], container: undefined };
		if ((location.block.children?.blocks.length ?? 0) === 0) return { leaves: [location.block], container: undefined };
		const leaves = [...eachBlock(location.block.children!)].map(entry => entry.block).filter(block => (block.children?.blocks.length ?? 0) === 0);
		return { leaves, container: location.block };
	}
	const all = [...eachBlock(document.root)];
	if (scope.kind === "project" || scope.id === undefined || scope.id === document.root.id) {
		return { leaves: all.map(entry => entry.block).filter(block => (block.children?.blocks.length ?? 0) === 0), container: undefined };
	}
	const owned = all.filter(entry => {
		const inside = entry.diagram.id === scope.id || entry.ancestors.some(ancestor => ancestor.children?.id === scope.id);
		return inside && (entry.block.children?.blocks.length ?? 0) === 0;
	});
	return { leaves: owned.map(entry => entry.block), container: undefined };
}

function inboundOpen(document: DiagramDocument, block: Block, running: ReadonlySet<string>): string | undefined {
	const location = findBlockLocation(document.root, block.id);
	if (!location) return undefined;
	for (const edge of location.diagram.edges) {
		if (edge.to !== block.id) continue;
		const from = location.diagram.blocks.find(candidate => candidate.id === edge.from);
		if (!from || from.status === "done" || running.has(from.id)) continue;
		return from.title.length > 0 ? from.title : from.id;
	}
	return undefined;
}

/**
 * What a leaf waits for through `uses`: its own and every ancestor's — a
 * subsystem's needs are its parts' needs.
 */
function usesOf(document: DiagramDocument, block: Block): string[] {
	const location = findBlockLocation(document.root, block.id);
	if (!location) return [];
	return [...location.ancestors, block].flatMap(holder => holder.uses ?? []);
}

function usesOpen(document: DiagramDocument, block: Block, running: ReadonlySet<string>): string | undefined {
	for (const id of usesOf(document, block)) {
		const used = findBlockLocation(document.root, id)?.block;
		if (!used || used.status === "done" || running.has(used.id)) continue;
		return used.title.length > 0 ? used.title : used.id;
	}
	return undefined;
}

/**
 * What an execute may run. Only a settled plan leaf with acceptance criteria runs.
 * Open ideas stay on the proposal path. A parent is never one job.
 */
export function planDispatch(document: DiagramDocument, scope: Scope): DispatchPlan {
	const { leaves, container } = leavesIn(document, scope);
	const held: DispatchHold[] = [];
	if (container) {
		held.push({
			id: container.id,
			title: container.title,
			kind: "container",
			reason: "a parent is not one job; only its ready leaves run",
		});
	}
	const ready: Block[] = [];
	for (const block of leaves) {
		const title = block.title.length > 0 ? block.title : block.id;
		if (document.purpose !== "plan") {
			held.push({ id: block.id, title, kind: "refine", reason: "execute is only for a plan" });
			continue;
		}
		if (block.status === "done") {
			held.push({ id: block.id, title, kind: "done", reason: "already done" });
			continue;
		}
		const named = scope.kind === "block" && scope.id === block.id;
		const authored = block.description.trim().length > 0 || block.acceptanceCriteria.length > 0;
		const planned = block.status === "settled" && block.acceptanceCriteria.length > 0;
		if (named ? !authored : !planned) {
			const kind = !authored ? "brainstorm" : "refine";
			const reason = !authored
				? "still an idea — refine or break it down first"
				: block.status === "settled"
					? "settled, but it has no acceptance criteria"
					: "still open — settle it before executing";
			held.push({ id: block.id, title, kind, reason });
			continue;
		}
		ready.push(block);
	}
	const running = new Set(ready.map(block => block.id));
	const runnable: Block[] = [];
	for (const block of ready) {
		const waiting = inboundOpen(document, block, running) ?? usesOpen(document, block, running);
		if (waiting) {
			held.push({
				id: block.id,
				title: block.title.length > 0 ? block.title : block.id,
				kind: "blocked",
				reason: `blocked on ${waiting}`,
			});
			running.delete(block.id);
			continue;
		}
		runnable.push(block);
	}
	const pending = new Set(runnable.map(block => block.id));
	const ordered: Block[] = [];
	const rest = [...runnable];
	while (rest.length > 0) {
		const index = rest.findIndex(block => {
			if (usesOf(document, block).some(id => pending.has(id))) return false;
			const location = findBlockLocation(document.root, block.id);
			if (!location) return true;
			return !location.diagram.edges.some(edge => edge.to === block.id && pending.has(edge.from));
		});
		const next = rest.splice(index === -1 ? 0 : index, 1)[0]!;
		pending.delete(next.id);
		ordered.push(next);
	}
	return {
		run: ordered.map(block => ({
			id: block.id,
			title: block.title.length > 0 ? block.title : block.id,
			venue: venueOf(block),
			acceptance: [...block.acceptanceCriteria],
			notes: block.actions.execute.trim(),
			sources: [...block.sources],
		})),
		held,
	};
}

const VENUE_HEADING: Record<Venue, string> = {
	here: "Here — do these in this session",
	subagent: "Subagent — one subagent per leaf, in this workspace. Do not do these inline",
	worktree: "Worktree — one isolated worktree per leaf. Do not do these in this checkout",
};

/** The execute task text. Throws when nothing in the scope may run. */
export function renderDispatch(document: DiagramDocument, scope: Scope): string {
	const plan = planDispatch(document, scope);
	if (plan.run.length === 0) {
		const why = plan.held.map(item => `${item.title}: ${item.reason}`).join("; ");
		throw new DispatchError(why.length > 0 ? why : "nothing in this scope is ready to execute");
	}
	const lines = [
		"Execute only the ready leaves listed below, in the order given. Do not decompose further, do not reassign a leaf to a different venue, and do not modify the planner document. The human marks a leaf done after looking at the result.",
		"A leaf with no venue was assigned here.",
	];
	for (const venue of VENUES) {
		const leaves = plan.run.filter(leaf => leaf.venue === venue);
		if (leaves.length === 0) continue;
		lines.push("", `## ${VENUE_HEADING[venue]}`);
		for (const leaf of leaves) {
			lines.push(`- [${leaf.id}] ${leaf.title}`);
			if (leaf.acceptance.length > 0) lines.push(`  acceptance: ${leaf.acceptance.join("; ")}`);
			if (leaf.sources.length > 0) lines.push(`  files: ${leaf.sources.map(formatSourceRef).join(", ")}`);
			if (leaf.notes.length > 0) lines.push(`  notes: ${leaf.notes}`);
		}
	}
	if (plan.held.length > 0) {
		lines.push("", "## Not run");
		for (const item of plan.held) lines.push(`- [${item.id}] ${item.title}: ${item.reason}`);
	}
	return lines.join("\n");
}
