/**
 * Durable nested-diagram document contract.
 *
 * One module owns the schema, the runtime validation, and the graph operations:
 * tool parameters, file validation, proposal validation and prompt composition
 * all build from the definitions here, so a document that validates once is
 * valid everywhere.
 */
import type { OmpErrors, type as ArkType, Type } from "@oh-my-pi/omptype";

/** Only schema `1` is interpreted. Unknown versions are rejected, never migrated silently. */
export const SCHEMA_VERSION = 1 as const;

export type Evidence = "observed" | "inferred" | "unknown";
export type EdgeDirection = "forward" | "both" | "none";
export type EdgeRouting = "auto" | "horizontal-first" | "vertical-first";
export type EdgePort = "auto" | "north" | "east" | "south" | "west";
export type Purpose = "brainstorm" | "plan" | "explore";
export type BlockStatus = "open" | "settled" | "done";
/** Where a ready leaf is executed. Omitted means this session. */
export type Venue = "here" | "subagent" | "worktree";
/** What a person looks at: a whole page or screen, or a reusable piece of UI inside pages. Omitted for everything else. */
export type Surface = "page" | "component";

export interface SourceRef {
	path: string;
	startLine?: number;
	endLine?: number;
	/** sha256 of the cited lines (trailing whitespace trimmed per line), recorded when the citation was made. Absent: never fingerprinted. Directories are never fingerprinted. */
	digest?: string;
}

export interface BlockPosition {
	x: number;
	y: number;
}

/** Free-text instructions. They are data for the composed prompt, never shell expressions. */
export interface BlockActions {
	enhance: string;
	execute: string;
}

export interface Block {
	id: string;
	title: string;
	description: string;
	expectedOutput: string;
	acceptanceCriteria: string[];
	position: BlockPosition;
	sources: SourceRef[];
	evidence: Evidence;
	status: BlockStatus;
	/** Omitted means `here`. A proposal never changes it; acceptance keeps the human's choice. */
	venue?: Venue;
	/** Omitted for blocks nobody looks at. A proposal may add one; acceptance never changes or removes one the block already has. */
	surface?: Surface;
	/** A self-contained HTML/CSS mockup of a surface, drawn by Sketch. Shown only in a sandboxed frame. Omitted when empty. */
	mockup?: string;
	/** Ids of blocks this block reuses: a shared block is defined once and linked from anywhere. Omitted when empty. */
	uses?: string[];
	actions: BlockActions;
	children: Diagram | null;
}

export interface Edge {
	id: string;
	from: string;
	to: string;
	label: string;
	direction: EdgeDirection;
	routing: EdgeRouting;
	fromPort: EdgePort;
	toPort: EdgePort;
}

export interface Diagram {
	id: string;
	blocks: Block[];
	edges: Edge[];
}

export interface DiagramDocument {
	schemaVersion: typeof SCHEMA_VERSION;
	id: string;
	title: string;
	goal: string;
	purpose: Purpose;
	revision: number;
	/** Where uncited-change tracking starts: the git HEAD (absent outside a repository) and ISO time of the last Record baseline. */
	baseline?: { commit?: string; at: string };
	root: Diagram;
}

/** What a composed prompt, an action, or a proposal request covers. */
export interface Scope {
	kind: "block" | "diagram" | "project";
	id?: string;
}

export type Intent =
	| "plan"
	| "discover"
	| "enhance"
	| "decompose"
	| "investigate"
	| "execute"
	| "replan"
	| "prune"
	| "change"
	| "sync"
	| "clarify";

export type Direction = "h" | "j" | "k" | "l";

/** Cycle order used by the inspector and by the schema itself. */
export const EVIDENCE_VALUES: readonly Evidence[] = ["observed", "inferred", "unknown"];
export const PURPOSES: readonly Purpose[] = ["brainstorm", "plan", "explore"];
export const BLOCK_STATUSES: readonly BlockStatus[] = ["open", "settled", "done"];
export const VENUES: readonly Venue[] = ["here", "subagent", "worktree"];
export const SURFACES: readonly Surface[] = ["page", "component"];
export const EDGE_DIRECTIONS: readonly EdgeDirection[] = ["forward", "both", "none"];
export const EDGE_ROUTINGS: readonly EdgeRouting[] = ["auto", "horizontal-first", "vertical-first"];
export const EDGE_PORTS: readonly EdgePort[] = ["auto", "north", "east", "south", "west"];
/** The largest mockup a block may carry, in characters. */
export const MOCKUP_MAX_CHARS = 40_000;

export type ArkTypeNamespace = typeof ArkType;

const DEFINITIONS = {
	Evidence: "'observed'|'inferred'|'unknown'",
	Direction: "'forward'|'both'|'none'",
	Routing: "'auto'|'horizontal-first'|'vertical-first'",
	Port: "'auto'|'north'|'east'|'south'|'west'",
	Status: "'open'|'settled'|'done'",
	Venue: "'here'|'subagent'|'worktree'",
	Surface: "'page'|'component'",
	Purpose: "'brainstorm'|'plan'|'explore'",
	SourceRef: { path: "string", "startLine?": "number", "endLine?": "number", "digest?": "string" },
	BlockPosition: { x: "number", y: "number" },
	BlockActions: { enhance: "string", execute: "string" },
	Block: {
		id: "string",
		title: "string",
		description: "string",
		expectedOutput: "string",
		acceptanceCriteria: "string[]",
		position: "BlockPosition",
		sources: "SourceRef[]",
		evidence: "Evidence",
		"status?": "Status",
		"venue?": "Venue",
		"surface?": "Surface",
		"mockup?": "string",
		"uses?": "string[]",
		actions: "BlockActions",
	},
	Edge: {
		id: "string",
		from: "string",
		to: "string",
		label: "string",
		direction: "Direction",
		routing: "Routing",
		fromPort: "Port",
		toPort: "Port",
	},
	Diagram: { id: "string", blocks: "Block[]", edges: "Edge[]" },
	DiagramDocument: {
		schemaVersion: String(SCHEMA_VERSION),
		id: "string",
		title: "string",
		goal: "string",
		"purpose?": "Purpose",
		revision: "number",
		"baseline?": { "commit?": "string", at: "string" },
		root: "Diagram",
	},
} as const;

/**
 * Schemas built from the host-injected builder. Recursive by construction:
 * `Block.children` references `Diagram`, which references `Block` again. The
 * installed Zod compatibility shim has no lazy API, so recursion must come
 * from an arktype scope.
 */
export interface DiagramSchemas {
	SourceRef: Type<SourceRef>;
	BlockActions: Type<BlockActions>;
	BlockPosition: Type<BlockPosition>;
	Edge: Type<Edge>;
	Block: Type<Block>;
	Diagram: Type<Diagram>;
	DiagramDocument: Type<DiagramDocument>;
}

/** Parameter schema for `visual_planner_read`. Omitted scope means the active diagram. */
export interface ReadScopeInput {
	scope?: Scope;
}

/** Parameter schema for `visual_planner_propose`. */
export interface ProposeInput {
	requestId: string;
	baseRevision: number;
	summary: string;
	replacement: DiagramDocument | Block | Diagram;
}

export interface ToolParameterSchemas {
	read: Type<ReadScopeInput>;
	propose: Type<ProposeInput>;
}

const schemaCache = new WeakMap<ArkTypeNamespace, DiagramSchemas>();
const toolSchemaCache = new WeakMap<ArkTypeNamespace, ToolParameterSchemas>();

export function schemasFor(arktype: ArkTypeNamespace): DiagramSchemas {
	const cached = schemaCache.get(arktype);
	if (cached) return cached;
	const exported = arktype.scope(DEFINITIONS).export(
		"SourceRef",
		"BlockActions",
		"BlockPosition",
		"Edge",
		"Block",
		"Diagram",
		"DiagramDocument",
	);
	const schemas: DiagramSchemas = {
		SourceRef: exported.SourceRef as unknown as Type<SourceRef>,
		BlockActions: exported.BlockActions as unknown as Type<BlockActions>,
		BlockPosition: exported.BlockPosition as unknown as Type<BlockPosition>,
		Edge: exported.Edge as unknown as Type<Edge>,
		Block: exported.Block as unknown as Type<Block>,
		Diagram: exported.Diagram as unknown as Type<Diagram>,
		DiagramDocument: exported.DiagramDocument as unknown as Type<DiagramDocument>,
	};
	schemaCache.set(arktype, schemas);
	return schemas;
}

export function toolSchemasFor(arktype: ArkTypeNamespace): ToolParameterSchemas {
	const cached = toolSchemaCache.get(arktype);
	if (cached) return cached;
	const readExport = arktype
		.scope({ Scope: { kind: "'block'|'diagram'|'project'", "id?": "string" }, ReadScope: { "scope?": "Scope" } })
		.export("ReadScope");
	// The replacement is a union of the three shapes a request may cover; scope
	// ownership is checked against the pending request after the structural parse.
	const proposeExport = arktype
		.scope({
			...DEFINITIONS,
			Propose: {
				requestId: "string",
				baseRevision: "number",
				summary: "string",
				replacement: "DiagramDocument|Block|Diagram",
			},
		})
		.export("Propose");
	const schemas: ToolParameterSchemas = {
		read: readExport.ReadScope as unknown as Type<ReadScopeInput>,
		propose: proposeExport.Propose as unknown as Type<ProposeInput>,
	};
	toolSchemaCache.set(arktype, schemas);
	return schemas;
}

function failed(value: unknown, arktype: ArkTypeNamespace): value is OmpErrors {
	return value instanceof arktype.errors;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createBlock(
	init: Partial<Omit<Block, "id" | "position">> & { id?: string; x?: number; y?: number } = {},
): Block {
	return {
		id: init.id ?? crypto.randomUUID(),
		title: init.title ?? "New block",
		description: init.description ?? "",
		expectedOutput: init.expectedOutput ?? "",
		acceptanceCriteria: init.acceptanceCriteria ? [...init.acceptanceCriteria] : [],
		position: { x: init.x ?? 2, y: init.y ?? 2 },
		sources: init.sources ? init.sources.map(s => ({ ...s })) : [],
		evidence: init.evidence ?? "inferred",
		status: init.status ?? "open",
		...(init.venue !== undefined && init.venue !== "here" ? { venue: init.venue } : {}),
		...(init.surface !== undefined ? { surface: init.surface } : {}),
		...(init.mockup !== undefined && init.mockup.length > 0 ? { mockup: init.mockup } : {}),
		...(init.uses !== undefined && init.uses.length > 0 ? { uses: [...init.uses] } : {}),
		actions: init.actions ? { ...init.actions } : { enhance: "", execute: "" },
		children: init.children === undefined ? null : init.children,
	};
}

export function createEdge(init: Partial<Omit<Edge, "id">> & { from: string; to: string; id?: string }): Edge {
	return {
		id: init.id ?? crypto.randomUUID(),
		from: init.from,
		to: init.to,
		label: init.label ?? "",
		direction: init.direction ?? "forward",
		routing: init.routing ?? "auto",
		fromPort: init.fromPort ?? "auto",
		toPort: init.toPort ?? "auto",
	};
}

export function createDiagram(init: Partial<Diagram> & { id?: string } = {}): Diagram {
	return { id: init.id ?? crypto.randomUUID(), blocks: init.blocks ?? [], edges: init.edges ?? [] };
}

export function createDocument(
	init: { title?: string; goal?: string; purpose?: Purpose; id?: string } = {},
): DiagramDocument {
	return {
		schemaVersion: SCHEMA_VERSION,
		id: init.id ?? crypto.randomUUID(),
		title: init.title ?? "Untitled architecture",
		goal: init.goal ?? "",
		purpose: init.purpose ?? "plan",
		revision: 0,
		root: createDiagram(),
	};
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

export interface BlockLocation {
	block: Block;
	/** Blocks from the root down to (excluding) `block`. */
	ancestors: Block[];
	/** The diagram that owns `block`. */
	diagram: Diagram;
}

export function* eachDiagram(root: Diagram): Generator<Diagram> {
	yield root;
	for (const block of root.blocks) {
		if (block.children) yield* eachDiagram(block.children);
	}
}

export function* eachBlock(root: Diagram, ancestors: Block[] = []): Generator<BlockLocation> {
	for (const block of root.blocks) {
		yield { block, ancestors, diagram: root };
		if (block.children) yield* eachBlock(block.children, [...ancestors, block]);
	}
}

export function findBlockLocation(root: Diagram, blockId: string): BlockLocation | undefined {
	for (const location of eachBlock(root)) {
		if (location.block.id === blockId) return location;
	}
	return undefined;
}

/** Diagrams from the root to `diagramId` inclusive. */
export function findDiagramPath(root: Diagram, diagramId: string): Diagram[] | undefined {
	if (root.id === diagramId) return [root];
	for (const block of root.blocks) {
		if (!block.children) continue;
		const path = findDiagramPath(block.children, diagramId);
		if (path) return [root, ...path];
	}
	return undefined;
}

export function findDiagram(root: Diagram, diagramId: string): Diagram | undefined {
	return findDiagramPath(root, diagramId)?.at(-1);
}

/** The block whose `children` is `diagramId`, for structural replacement. */
export function findOwnedDiagram(root: Diagram, diagramId: string): { owner: Block; diagram: Diagram } | undefined {
	for (const block of root.blocks) {
		if (!block.children) continue;
		if (block.children.id === diagramId) return { owner: block, diagram: block.children };
		const deeper = findOwnedDiagram(block.children, diagramId);
		if (deeper) return deeper;
	}
	return undefined;
}

/** IDs of every block in the subtree rooted at `block`, including `block` itself. */
export function descendantIds(block: Block): string[] {
	const ids = [block.id];
	if (block.children) {
		for (const child of block.children.blocks) ids.push(...descendantIds(child));
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/** Remove the block and its whole subtree, dropping every incident edge and every use of it. */
export function removeBlock(root: Diagram, blockId: string): boolean {
	for (const diagram of eachDiagram(root)) {
		const index = diagram.blocks.findIndex(b => b.id === blockId);
		if (index === -1) continue;
		const doomed = new Set(descendantIds(diagram.blocks[index]!));
		diagram.blocks.splice(index, 1);
		diagram.edges = diagram.edges.filter(e => !doomed.has(e.from) && !doomed.has(e.to));
		for (const { block } of eachBlock(root)) dropUses(block, doomed);
		return true;
	}
	return false;
}

/** Delete every id in `doomed` from `block.uses`, removing the key when it empties. */
function dropUses(block: Block, doomed: ReadonlySet<string>): void {
	if (block.uses === undefined) return;
	block.uses = block.uses.filter(id => !doomed.has(id));
	if (block.uses.length === 0) delete block.uses;
}

/** Append `targetId` to `userId`'s uses. Returns why it may not, or undefined on success. */
export function addUse(root: Diagram, userId: string, targetId: string): string | undefined {
	const user = findBlockLocation(root, userId);
	if (!user) return `no block ${userId}`;
	const target = findBlockLocation(root, targetId);
	if (user.block.uses?.includes(targetId)) {
		return `"${blockName(user.block)}" already uses "${target ? blockName(target.block) : targetId}"`;
	}
	const refusal = usesRefusal(user, targetId, target);
	if (refusal) return `"${blockName(user.block)}" ${refusal}`;
	(user.block.uses ??= []).push(targetId);
	return undefined;
}

/** Drop `targetId` from `userId`'s uses. False when the user is unknown or does not use the target. */
export function removeUse(root: Diagram, userId: string, targetId: string): boolean {
	const user = findBlockLocation(root, userId);
	if (!user?.block.uses?.includes(targetId)) return false;
	user.block.uses = user.block.uses.filter(id => id !== targetId);
	if (user.block.uses.length === 0) delete user.block.uses;
	return true;
}

/**
 * The blocks outside `blockId`'s subtree that use anything inside it — the links
 * a deletion would cut. Empty for an unknown id.
 */
export function usersOutside(root: Diagram, blockId: string): Block[] {
	const location = findBlockLocation(root, blockId);
	if (!location) return [];
	const inside = new Set(descendantIds(location.block));
	const users: Block[] = [];
	for (const { block } of eachBlock(root)) {
		if (inside.has(block.id)) continue;
		if (block.uses?.some(id => inside.has(id))) users.push(block);
	}
	return users;
}

export interface ExtractTarget {
	diagramId: string;
	/** The ancestor the block will sit right after. */
	anchorId: string;
	label: string;
}

/** Levels `blockId` can move up to, nearest first: every diagram above it that holds one of its ancestors. */
export function extractTargets(root: Diagram, blockId: string): ExtractTarget[] {
	const location = findBlockLocation(root, blockId);
	if (!location) return [];
	const path = findDiagramPath(root, location.diagram.id);
	if (!path) return [];
	const targets: ExtractTarget[] = [];
	for (let level = path.length - 2; level >= 0; level -= 1) {
		const anchor = location.ancestors[level];
		if (!anchor) continue;
		const label =
			level === 0
				? `top level, next to "${blockName(anchor)}"`
				: `inside "${blockName(location.ancestors[level - 1]!)}", next to "${blockName(anchor)}"`;
		targets.push({ diagramId: path[level]!.id, anchorId: anchor.id, label });
	}
	return targets;
}

export interface ExtractResult {
	/** The block that held it; it now uses it. */
	formerParentId: string;
	/** Former sibling links turned into uses: `userId` now uses `usedId`. Uses carry no label, so `label` is gone from the document. */
	converted: { userId: string; usedId: string; label: string }[];
}

/** Append `id` to `block.uses`, skipping a duplicate. */
function pushUse(block: Block, id: string): void {
	if (block.uses?.includes(id)) return;
	(block.uses ??= []).push(id);
}

/**
 * Move `blockId`, with everything inside it, up into `targetDiagramId`, right after the ancestor that
 * diagram holds. It keeps its id, status and contents. The block that held it now uses it, and each link
 * to a former sibling becomes a use: an edge's `to` uses its `from`, the dependency direction execute already reads.
 */
export function extractBlock(
	root: Diagram,
	blockId: string,
	targetDiagramId: string,
	position: BlockPosition,
): ExtractResult {
	const location = findBlockLocation(root, blockId);
	if (!location) throw new Error(`no block ${blockId}`);
	const block = location.block;
	const parent = location.ancestors.at(-1);
	if (!parent) throw new Error(`"${blockName(block)}" is already at the top level`);
	const path = findDiagramPath(root, location.diagram.id);
	const level = path?.findIndex(diagram => diagram.id === targetDiagramId) ?? -1;
	if (!path || level === -1 || level === path.length - 1) {
		throw new Error(`"${blockName(block)}" can only move up to a level that contains it`);
	}
	const from = location.diagram;
	const converted: ExtractResult["converted"] = [];
	for (const edge of from.edges) {
		if (edge.from !== blockId && edge.to !== blockId) continue;
		converted.push({ userId: edge.to, usedId: edge.from, label: edge.label });
	}
	from.edges = from.edges.filter(edge => edge.from !== blockId && edge.to !== blockId);
	const source = from.blocks.findIndex(candidate => candidate.id === blockId);
	if (source !== -1) from.blocks.splice(source, 1);
	block.position = { ...position };
	const anchor = location.ancestors[level]!;
	const siblings = path[level]!.blocks;
	const at = siblings.findIndex(candidate => candidate.id === anchor.id);
	siblings.splice(at === -1 ? siblings.length : at + 1, 0, block);
	pushUse(parent, blockId);
	for (const link of converted) {
		const user = link.userId === blockId ? block : from.blocks.find(candidate => candidate.id === link.userId);
		if (user) pushUse(user, link.usedId);
	}
	return { formerParentId: parent.id, converted };
}

/**
 * Insert a block into a diagram: right after `afterId` when that block is in the
 * diagram, otherwise at the end. Returns false when the diagram is unknown.
 */
export function addBlock(root: Diagram, diagramId: string, block: Block, afterId?: string): boolean {
	const diagram = findDiagram(root, diagramId);
	if (!diagram) return false;
	const anchor = afterId === undefined ? -1 : diagram.blocks.findIndex(b => b.id === afterId);
	if (anchor === -1) diagram.blocks.push(block);
	else diagram.blocks.splice(anchor + 1, 0, block);
	return true;
}

/** Swap a block with its neighbour in authored order. False at either end or for an unknown id. */
export function moveBlockInOrder(root: Diagram, blockId: string, delta: -1 | 1): boolean {
	for (const diagram of eachDiagram(root)) {
		const index = diagram.blocks.findIndex(b => b.id === blockId);
		if (index === -1) continue;
		const target = index + delta;
		if (target < 0 || target >= diagram.blocks.length) return false;
		const [block] = diagram.blocks.splice(index, 1);
		diagram.blocks.splice(target, 0, block!);
		return true;
	}
	return false;
}

/** Append an edge. Rejects unknown endpoints and self-edges. */
export function addEdge(root: Diagram, diagramId: string, edge: Edge): boolean {
	const diagram = findDiagram(root, diagramId);
	if (!diagram) return false;
	if (edge.from === edge.to) return false;
	const ids = new Set(diagram.blocks.map(b => b.id));
	if (!ids.has(edge.from) || !ids.has(edge.to)) return false;
	diagram.edges.push(edge);
	return true;
}

/** Every edge in `root`'s diagrams that touches `blockId`. */
export function incidentEdges(root: Diagram, blockId: string): { diagram: Diagram; edge: Edge }[] {
	const found: { diagram: Diagram; edge: Edge }[] = [];
	for (const diagram of eachDiagram(root)) {
		for (const edge of diagram.edges) {
			if (edge.from === blockId || edge.to === blockId) found.push({ diagram, edge });
		}
	}
	return found;
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

const DIRECTION_VECTORS: Record<Direction, { dx: number; dy: number }> = {
	h: { dx: -1, dy: 0 },
	j: { dx: 0, dy: 1 },
	k: { dx: 0, dy: -1 },
	l: { dx: 1, dy: 0 },
};

/** Nearest block strictly in the given direction, scored along-axis first. */
export function nearestBlock(diagram: Diagram, fromId: string, direction: Direction): string | undefined {
	const from = diagram.blocks.find(b => b.id === fromId);
	if (!from) return undefined;
	const { dx, dy } = DIRECTION_VECTORS[direction];
	let best: { score: number; id: string } | undefined;
	for (const candidate of diagram.blocks) {
		if (candidate.id === fromId) continue;
		const ddx = candidate.position.x - from.position.x;
		const ddy = candidate.position.y - from.position.y;
		const along = ddx * dx + ddy * dy;
		if (along <= 0) continue;
		const perpendicular = dx !== 0 ? Math.abs(ddy) : Math.abs(ddx);
		const score = along * 2 + perpendicular;
		if (!best || score < best.score) best = { score, id: candidate.id };
	}
	return best?.id;
}

/** Deterministic Tab order: authored block order in the current diagram. */
export function cycleBlock(diagram: Diagram, currentId: string | undefined, step: 1 | -1 = 1): string | undefined {
	if (diagram.blocks.length === 0) return undefined;
	const index = currentId === undefined ? -1 : diagram.blocks.findIndex(b => b.id === currentId);
	const base = index === -1 ? (step === 1 ? -1 : 0) : index;
	const count = diagram.blocks.length;
	return diagram.blocks[(((base + step) % count) + count) % count]!.id;
}

/** Parse `path:10-40`, `path:12`, or a bare path. */
export function parseSourceRef(text: string): SourceRef {
	const trimmed = text.trim();
	const match = /^(.*?):(\d+)(?:-(\d+))?$/.exec(trimmed);
	if (!match || match[1] === undefined || match[1] === "") return { path: trimmed };
	const start = Number(match[2]);
	return { path: match[1], startLine: start, endLine: match[3] === undefined ? start : Number(match[3]) };
}

export function formatSourceRef(source: SourceRef): string {
	if (source.startLine === undefined) return source.path;
	return `${source.path}:${source.startLine}-${source.endLine ?? source.startLine}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationResult =
	| { ok: true; document: DiagramDocument }
	| { ok: false; errors: string[]; document?: undefined };

interface IdLedger {
	errors: string[];
	seen: Map<string, string>;
}

function blockName(block: Block): string {
	return block.title.length > 0 ? block.title : block.id;
}

/** Why `user` may not use `targetId` — the tail of a sentence — or undefined when it may. */
function usesRefusal(user: BlockLocation, targetId: string, target: BlockLocation | undefined): string | undefined {
	if (targetId === user.block.id) return "cannot use itself";
	if (!target) return `cannot use ${targetId}, which is not in the document`;
	if (user.ancestors.some(ancestor => ancestor.id === targetId)) {
		return `cannot use "${blockName(target.block)}", which contains it`;
	}
	if (target.ancestors.some(ancestor => ancestor.id === user.block.id)) {
		return `cannot use "${blockName(target.block)}", which is inside it`;
	}
	return undefined;
}

function claimId(ledger: IdLedger, id: string, what: string): void {
	if (id.length === 0) {
		ledger.errors.push(`${what} has an empty id`);
		return;
	}
	const previous = ledger.seen.get(id);
	if (previous) {
		ledger.errors.push(`duplicate id ${id} (${previous} and ${what})`);
		return;
	}
	ledger.seen.set(id, what);
}

function checkBlock(block: Block, label: string, ledger: IdLedger): void {
	claimId(ledger, block.id, `block "${label}"`);
	if (!Number.isInteger(block.position.x) || !Number.isInteger(block.position.y)) {
		ledger.errors.push(`block "${label}" has non-integer position (${block.position.x}, ${block.position.y})`);
	}
	if (block.evidence === "observed" && block.sources.length === 0) {
		ledger.errors.push(`block "${label}" is evidence "observed" but carries no sources`);
	}
	for (const source of block.sources) {
		if (source.path.length === 0) {
			ledger.errors.push(`block "${label}" has a source with an empty path`);
		}
		const { startLine, endLine } = source;
		if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
			ledger.errors.push(`block "${label}" source ${source.path} has invalid startLine ${startLine}`);
		}
		if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
			ledger.errors.push(`block "${label}" source ${source.path} has invalid endLine ${endLine}`);
		}
		if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
			ledger.errors.push(`block "${label}" source ${source.path} has endLine ${endLine} before startLine ${startLine}`);
		}
	}
	if (block.mockup !== undefined && block.mockup.length > MOCKUP_MAX_CHARS) {
		ledger.errors.push(`block "${label}" mockup is ${block.mockup.length} characters; the limit is ${MOCKUP_MAX_CHARS}`);
	}
}

function checkDiagram(diagram: Diagram, label: string, ledger: IdLedger): void {
	claimId(ledger, diagram.id, `diagram ${label}`);
	const localIds = new Set<string>();
	for (const block of diagram.blocks) {
		const where = block.title.length > 0 ? block.title : block.id;
		checkBlock(block, where, ledger);
		localIds.add(block.id);
	}
	for (const edge of diagram.edges) {
		claimId(ledger, edge.id, `edge ${edge.id}`);
	}
	for (const edge of diagram.edges) {
		if (edge.from === edge.to) {
			ledger.errors.push(`edge ${edge.id} is a self-edge on block ${edge.from}; self-edges are not supported`);
			continue;
		}
		if (!localIds.has(edge.from)) ledger.errors.push(`edge ${edge.id} starts at unknown block ${edge.from}`);
		if (!localIds.has(edge.to)) ledger.errors.push(`edge ${edge.id} ends at unknown block ${edge.to}`);
	}
	for (const block of diagram.blocks) {
		if (!block.children) continue;
		const where = block.title.length > 0 ? block.title : block.id;
		checkDiagram(block.children, `${label} > ${where}`, ledger);
	}
}

/**
 * The `uses` relation: a shared block is defined once and linked from anywhere.
 * Cycles stay allowed, the same way sibling edges already allow cycles.
 */
function checkUses(root: Diagram, ledger: IdLedger): void {
	const map = new Map<string, BlockLocation>();
	for (const location of eachBlock(root)) {
		if (!map.has(location.block.id)) map.set(location.block.id, location);
	}
	for (const location of eachBlock(root)) {
		const { block } = location;
		if (block.uses === undefined) continue;
		const seen = new Set<string>();
		for (const id of block.uses) {
			if (seen.has(id)) {
				ledger.errors.push(`block "${blockName(block)}" uses ${id} twice`);
				continue;
			}
			seen.add(id);
			const tail = usesRefusal(location, id, map.get(id));
			if (tail) ledger.errors.push(`block "${blockName(block)}" ${tail}`);
		}
	}
}

/**
 * Structural parse plus graph-level checks. The version check runs first so an
 * unknown schema version is reported as such instead of as a shape mismatch.
 */
export function validateDocument(value: unknown, arktype: ArkTypeNamespace): ValidationResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, errors: ["document must be a JSON object"] };
	}
	const version = (value as { schemaVersion?: unknown }).schemaVersion;
	if (version !== SCHEMA_VERSION) {
		return {
			ok: false,
			errors: [`unsupported schemaVersion ${JSON.stringify(version)}; this build reads only version ${SCHEMA_VERSION}`],
		};
	}
	const parsed = schemasFor(arktype).DiagramDocument(value);
	if (failed(parsed, arktype)) return { ok: false, errors: [parsed.summary] };
	const document = parsed as DiagramDocument;
	document.purpose ??= "plan";
	fillDefaults(document.root);
	const ledger: IdLedger = { errors: [], seen: new Map() };
	claimId(ledger, document.id, "document");
	checkDiagram(document.root, "root", ledger);
	checkUses(document.root, ledger);
	if (ledger.errors.length > 0) return { ok: false, errors: ledger.errors };
	return { ok: true, document };
}

export function validateBlock(
	value: unknown,
	arktype: ArkTypeNamespace,
): { ok: true; block: Block } | { ok: false; errors: string[] } {
	const parsed = schemasFor(arktype).Block(value);
	if (failed(parsed, arktype)) return { ok: false, errors: [parsed.summary] };
	const block = parsed as Block;
	fillDefaults({ id: "", blocks: [block], edges: [] });
	const ledger: IdLedger = { errors: [], seen: new Map() };
	checkBlock(block, block.title.length > 0 ? block.title : block.id, ledger);
	if (block.children) checkDiagram(block.children, `block ${block.title}`, ledger);
	if (ledger.errors.length > 0) return { ok: false, errors: ledger.errors };
	return { ok: true, block };
}

export function validateDiagram(
	value: unknown,
	arktype: ArkTypeNamespace,
): { ok: true; diagram: Diagram } | { ok: false; errors: string[] } {
	const parsed = schemasFor(arktype).Diagram(value);
	if (failed(parsed, arktype)) return { ok: false, errors: [parsed.summary] };
	const diagram = parsed as Diagram;
	fillDefaults(diagram);
	const ledger: IdLedger = { errors: [], seen: new Map() };
	checkDiagram(diagram, "replacement", ledger);
	if (ledger.errors.length > 0) return { ok: false, errors: ledger.errors };
	return { ok: true, diagram };
}

/** Fields that version-1 files may omit: every block without a status reads as `open`. */
function fillDefaults(diagram: Diagram): void {
	for (const { block } of eachBlock(diagram)) block.status ??= "open";
}

// ---------------------------------------------------------------------------
// Legacy `{ boxes, edges }` boards
// ---------------------------------------------------------------------------

export interface LegacyBoard {
	boxes: { x: number; y: number; text: string }[];
	edges: { from: number; to: number }[];
}

export interface LegacyImportResult {
	ok: true;
	document: DiagramDocument;
	summary: string;
}

export type LegacyImportFailure = { ok: false; errors: string[] };

/**
 * Convert a ratatui-era board into one diagram. The first text line becomes the
 * title, the remaining lines the description — the same reading the old
 * renderer and `spec_md` used. Endpoint indexes are validated, never trusted.
 */
export function importLegacyBoard(value: unknown): LegacyImportResult | LegacyImportFailure {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, errors: ["legacy board must be a JSON object"] };
	}
	const candidate = value as { schemaVersion?: unknown; boxes?: unknown; edges?: unknown };
	if (candidate.schemaVersion !== undefined) {
		return { ok: false, errors: ["this file already carries a schemaVersion; open it as a project document"] };
	}
	if (!Array.isArray(candidate.boxes) || !Array.isArray(candidate.edges)) {
		return { ok: false, errors: ["legacy board must have `boxes` and `edges` arrays"] };
	}
	const errors: string[] = [];
	const diagram = createDiagram();
	candidate.boxes.forEach((raw, index) => {
		const box = raw as { x?: unknown; y?: unknown; text?: unknown };
		if (typeof box.text !== "string") {
			errors.push(`box ${index} is missing string text`);
			return;
		}
		const lines = box.text.split("\n");
		const title = (lines[0] ?? "").trim();
		diagram.blocks.push(
			createBlock({
				title: title.length > 0 ? title : `box${index + 1}`,
				description: lines.slice(1).join("\n").trim(),
				x: Number.isInteger(box.x) ? (box.x as number) : 2,
				y: Number.isInteger(box.y) ? (box.y as number) : 2,
			}),
		);
	});
	candidate.edges.forEach((raw, index) => {
		const edge = raw as { from?: unknown; to?: unknown };
		if (!Number.isInteger(edge.from) || !Number.isInteger(edge.to)) {
			errors.push(`edge ${index} needs integer from/to indexes`);
			return;
		}
		const from = edge.from as number;
		const to = edge.to as number;
		if (from < 0 || from >= diagram.blocks.length || to < 0 || to >= diagram.blocks.length) {
			errors.push(`edge ${index} references box index out of range (${from} -> ${to})`);
			return;
		}
		if (from === to) {
			errors.push(`edge ${index} is a self-edge on box ${from}`);
			return;
		}
		diagram.edges.push(createEdge({ from: diagram.blocks[from]!.id, to: diagram.blocks[to]!.id }));
	});
	if (errors.length > 0) return { ok: false, errors };
	const document: DiagramDocument = { ...createDocument({ title: "Imported board" }), root: diagram };
	return {
		ok: true,
		document,
		summary: `imported ${diagram.blocks.length} block(s) and ${diagram.edges.length} relationship(s) from the legacy board format`,
	};
}
