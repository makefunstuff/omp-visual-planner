/**
 * Diagram + inspector surface.
 *
 * Everything the planner needs lives inside this one overlay: the host paints
 * only the topmost fullscreen overlay on the alternate screen, and a host
 * dialog would move focus to the composer underneath it. So lists,
 * confirmations and review screens are rendered here, and text fields use the
 * native `Editor` widget mounted in this component.
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, Theme, ThemeColor, TUI } from "@oh-my-pi/pi-tui";
import {
	Editor,
	Ellipsis,
	getEditorTheme,
	sliceByColumn,
	getLanguageFromPath,
	highlightCode,
	parseKey,
	replaceTabs,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import {
	type ActionKind,
	type ActionRegistry,
	type BeginInput,
	type JournalEntry,
	retentionErrors,
} from "./actions.ts";
import { blockToMarkdown, markdownToBlock } from "./block-markdown.ts";
import { ScopeError } from "./compose.ts";
import {
	type ComposedRequest,
	type DocumentStart,
	type PageField,
	type ProjectAction,
	codeRootFor,
	composeRequest,
	fieldLabel,
	nextOpenBlock,
	nextStep,
	nextStatus,
	outlineRows,
	pageFields,
	progressLabel,
	projectActions,
	startDocument,
	statusCycle,
	statusGlyph,
	statusLabel,
	venueOf,
	verbsFor,
} from "./flow.ts";
import type {
	ArkTypeNamespace,
	Block,
	BlockPosition,
	Diagram,
	DiagramDocument,
	Edge,
	EdgeDirection,
	EdgePort,
	EdgeRouting,
	Intent,
	Scope,
	SourceRef,
} from "./model.ts";
import {
	EDGE_DIRECTIONS,
	EDGE_PORTS,
	EDGE_ROUTINGS,
	EVIDENCE_VALUES,
	PURPOSES,
	VENUES,
	addBlock,
	addEdge,
	createBlock,
	createEdge,
	cycleBlock,
	descendantIds,
	eachDiagram,
	findBlockLocation,
	findDiagramPath,
	findOwnedDiagram,
	moveBlockInOrder,
	formatSourceRef,
	nearestBlock,
	parseSourceRef,
	removeBlock,
} from "./model.ts";
import type { DocumentStore } from "./store.ts";
import { MAX_VIEWER_FILE_BYTES, PROJECT_DIR, applyReplacement, displayPath } from "./store.ts";

export const INSPECTOR_WIDTH = 34;
export const MIN_WIDTH = 40;
export const MIN_ROWS = 10;

export interface ScreenOptions {
	tui: TUI;
	theme: Theme;
	ui: ExtensionUIContext;
	store: DocumentStore;
	registry: ActionRegistry;
	arktype: ArkTypeNamespace;
	cwd: string;
	branchKey: string;
	/** Prefill for "save as". */
	documentPathHint: string;
	/** False in print/RPC mode, where nothing can be submitted. */
	hasUI: boolean;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	/** Block to focus when the screen opens, if it still exists. */
	initialSelection?: string;
	/** Shared focus with other surfaces (web mode) on the same session. */
	link?: ScreenLink;
	/**
	 * The user's own editor ($VISUAL / $EDITOR) for one text file; undefined
	 * when none is configured. Resolves to the saved text, or null to discard.
	 */
	externalEditor?: (text: string, name: string) => Promise<string | null>;
}

export interface SharedFocus {
	selected: string | undefined;
	stack: string[];
}

export interface ScreenLink {
	/** Record this screen's focus where the other surfaces read it. */
	publish(selected: string | undefined, stack: string[]): void;
	/** Called when another surface changed the session; returns the unsubscribe. */
	subscribe(listener: (focus: SharedFocus) => void): () => void;
}

export type ScreenResult =
	| { kind: "closed" }
	| { kind: "submit"; request: BeginInput; prompt: string };


/** Which flow to open straight away when the command asked for one. */
export interface ScreenStart {
	action?: "draft" | "discover";
	target?: string;
	purpose?: "brainstorm" | "plan";
}

// ---------------------------------------------------------------------------
// Pure geometry, routing and diffing
// ---------------------------------------------------------------------------

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export const CARD_HEIGHT = 4;

/** Border, a space, the title, a space, border: a title of up to 28 columns is never cut. */
export function cardWidth(title: string): number {
	return Math.max(12, Math.min(32, visibleWidth(title) + 4));
}

export function cardRect(block: Block): Rect {
	return { x: block.position.x, y: block.position.y, w: cardWidth(block.title), h: CARD_HEIGHT };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Two cells to the right of the selected card, pushed down until it is free. */
export function placeNewBlock(diagram: Diagram, selectedId?: string): BlockPosition {
	const taken = diagram.blocks.map(cardRect);
	const selected = selectedId === undefined ? undefined : diagram.blocks.find(block => block.id === selectedId);
	const anchor = selected ? cardRect(selected) : undefined;
	const width = cardWidth("New block");
	let candidate: Rect = anchor
		? { x: anchor.x + anchor.w + 2, y: anchor.y, w: width, h: CARD_HEIGHT }
		: { x: 2, y: 2, w: width, h: CARD_HEIGHT };
	for (let step = 0; step < 500 && taken.some(rect => rectsOverlap(candidate, rect)); step += 1) {
		candidate = { ...candidate, y: candidate.y + 1 };
	}
	return { x: candidate.x, y: candidate.y };
}

const GRID_COLUMNS = 3;
const GRID_GAP_X = 4;
const GRID_GAP_Y = 2;

/** Rows of three in authored order, starting at `top`. Cards in a row never touch; rows never share cells. */
function gridPlace(blocks: Block[], top: number): void {
	let y = top;
	for (let start = 0; start < blocks.length; start += GRID_COLUMNS) {
		let x = 2;
		for (const block of blocks.slice(start, start + GRID_COLUMNS)) {
			block.position = { x, y };
			x += cardWidth(block.title) + GRID_GAP_X;
		}
		y += CARD_HEIGHT + GRID_GAP_Y;
	}
}

/** Re-lay a whole diagram on the grid, keeping authored order. */
export function tidyDiagram(diagram: Diagram): void {
	gridPlace(diagram.blocks, 2);
}

/** Place blocks a proposal introduced below what each diagram already holds. */
export function layoutNewBlocks(root: Diagram, newIds: readonly string[]): void {
	if (newIds.length === 0) return;
	const fresh = new Set(newIds);
	for (const diagram of eachDiagram(root)) {
		const added = diagram.blocks.filter(block => fresh.has(block.id));
		if (added.length === 0) continue;
		const kept = diagram.blocks.filter(block => !fresh.has(block.id));
		const top = kept.length === 0 ? 2 : Math.max(...kept.map(block => block.position.y + CARD_HEIGHT)) + GRID_GAP_Y;
		gridPlace(added, top);
	}
}

/**
 * Apply a reviewed proposal the way every surface does: structure from the model,
 * layout from the planner. A replan or prune that would drop settled work is
 * refused before anything is touched — status belongs to the human, and this is
 * the one place every surface applies a proposal.
 */
export function acceptReplacement(
	document: DiagramDocument,
	replacement: DiagramDocument | Block | Diagram,
	targetId: string | undefined,
	request: Pick<JournalEntry, "intent" | "scope">,
): void {
	const refused = retentionErrors(request, document, replacement);
	if (refused.length > 0) throw new Error(refused.join("; "));
	// Replace first: a document-scope proposal swaps `document.root` itself, so the
	// root to lay out must be read after the replacement, not before it.
	const added = applyReplacement(document, replacement, targetId);
	layoutNewBlocks(document.root, added);
}

export interface Layout {
	stacked: boolean;
	canvasWidth: number;
	inspectorWidth: number;
	bodyHeight: number;
	tooSmall: boolean;
}

export function layoutFor(width: number, rows: number): Layout {
	const bodyHeight = Math.max(0, rows - 4);
	const tooSmall = width < MIN_WIDTH || rows < MIN_ROWS;
	const stacked = width < 100;
	if (stacked) {
		const inner = Math.max(0, width - 4);
		return { stacked, canvasWidth: inner, inspectorWidth: inner, bodyHeight, tooSmall };
	}
	const inspectorWidth = Math.min(INSPECTOR_WIDTH, Math.max(0, width - 40));
	return { stacked, canvasWidth: Math.max(0, width - inspectorWidth - 5), inspectorWidth, bodyHeight, tooSmall };
}

type Port = Exclude<EdgePort, "auto">;

const PORT_STEPS: Record<Port, { dx: number; dy: number }> = {
	east: { dx: 1, dy: 0 },
	west: { dx: -1, dy: 0 },
	south: { dx: 0, dy: 1 },
	north: { dx: 0, dy: -1 },
};

const OPPOSITE: Record<Port, Port> = { east: "west", west: "east", north: "south", south: "north" };

/** The glyph points along the direction of travel INTO the target, not out of its face. */
const ENTRY_ARROWS: Record<Port, string> = { east: "<", west: ">", north: "v", south: "^" };

function portPoint(rect: Rect, port: Port): { x: number; y: number } {
	const cx = rect.x + Math.floor(rect.w / 2);
	const cy = rect.y + Math.floor(rect.h / 2);
	if (port === "east") return { x: rect.x + rect.w, y: cy };
	if (port === "west") return { x: rect.x - 1, y: cy };
	if (port === "south") return { x: cx, y: rect.y + rect.h };
	return { x: cx, y: rect.y - 1 };
}

/** Facing ports: east/west when horizontal distance dominates, north/south otherwise. */
export function autoPorts(from: Rect, to: Rect): { from: Port; to: Port } {
	const dcx = to.x + to.w / 2 - (from.x + from.w / 2);
	const dcy = to.y + to.h / 2 - (from.y + from.h / 2);
	if (Math.abs(dcx) >= Math.abs(dcy)) return dcx >= 0 ? { from: "east", to: "west" } : { from: "west", to: "east" };
	return dcy >= 0 ? { from: "south", to: "north" } : { from: "north", to: "south" };
}

export interface EdgeRoute {
	/** Polyline vertices in world cells, from the source port to the target entry. */
	points: { x: number; y: number }[];
	arrow: string;
}

/** Direction-change glyph key: `dx,dy->dx,dy`. */
export const CORNERS: Record<string, string> = {
	"1,0->0,1": "topRight",
	"1,0->0,-1": "bottomRight",
	"-1,0->0,1": "topLeft",
	"-1,0->0,-1": "bottomLeft",
	"0,1->1,0": "bottomLeft",
	"0,1->-1,0": "bottomRight",
	"0,-1->1,0": "topLeft",
	"0,-1->-1,0": "topRight",
};

/**
 * Bounded orthogonal path: leave the source port, bend at most twice, enter the
 * target port. No unbounded scan, no obstacle search.
 */
export function routeEdge(
	from: Rect,
	to: Rect,
	options: { fromPort: EdgePort; toPort: EdgePort; routing: EdgeRouting },
): EdgeRoute {
	let fromPort = options.fromPort;
	let toPort = options.toPort;
	if (fromPort === "auto" && toPort === "auto") {
		const auto = autoPorts(from, to);
		fromPort = auto.from;
		toPort = auto.to;
	} else if (fromPort === "auto") {
		fromPort = OPPOSITE[toPort as Port];
	} else if (toPort === "auto") {
		toPort = OPPOSITE[fromPort as Port];
	}
	const exit = portPoint(from, fromPort as Port);
	const entry = portPoint(to, toPort as Port);
	const exitStub = {
		x: exit.x + PORT_STEPS[fromPort as Port].dx,
		y: exit.y + PORT_STEPS[fromPort as Port].dy,
	};
	const entryStub = {
		x: entry.x + PORT_STEPS[toPort as Port].dx,
		y: entry.y + PORT_STEPS[toPort as Port].dy,
	};
	const corner =
		options.routing === "vertical-first" ? { x: exitStub.x, y: entryStub.y } : { x: entryStub.x, y: exitStub.y };
	const points: { x: number; y: number }[] = [exit, exitStub];
	if (corner.x !== exitStub.x || corner.y !== exitStub.y) points.push(corner);
	if (entryStub.x !== corner.x || entryStub.y !== corner.y) points.push(entryStub);
	if (entry.x !== entryStub.x || entry.y !== entryStub.y) points.push(entry);
	return { points, arrow: ENTRY_ARROWS[toPort as Port] };
}

/** Box-glyph name for a direction change at a polyline vertex, if it is a bend. */
export function cornerName(incoming: { dx: number; dy: number }, outgoing: { dx: number; dy: number }): string | undefined {
	return CORNERS[`${incoming.dx},${incoming.dy}->${outgoing.dx},${outgoing.dy}`];
}

/** One changed field of a kept block, as the text a reviewer compares. */
export interface FieldChange {
	field: DiffField;
	from: string;
	to: string;
}

export interface DocumentDiff {
	added: { id: string; title: string; path: string }[];
	removed: { id: string; title: string; path: string }[];
	modified: { id: string; title: string; changes: FieldChange[]; path: string }[];
	edgesAdded: string[];
	edgesRemoved: string[];
	edgesModified: string[];
	titleChanged?: { from: string; to: string };
	goalChanged?: { from: string; to: string };
}

/**
 * Fields a proposal can change on a block it keeps. Children are not one of
 * them: the nested walk already reports every block added or removed inside.
 */
const BLOCK_FIELDS = ["title", "description", "expectedOutput", "acceptanceCriteria", "sources", "evidence", "actions", "position"] as const;
export type DiffField = (typeof BLOCK_FIELDS)[number];

/** A field as lines of text: one criterion or reference per line, so a reviewer compares line by line. */
function fieldText(block: Block, field: DiffField): string {
	switch (field) {
		case "acceptanceCriteria":
			return block.acceptanceCriteria.join("\n");
		case "sources":
			return block.sources.map(formatSourceRef).join("\n");
		case "actions":
			return [block.actions.enhance, block.actions.execute].filter(text => text.trim().length > 0).join("\n");
		case "position":
			return `${block.position.x},${block.position.y}`;
		default:
			return block[field];
	}
}

function edgeSignature(edge: Edge): string {
	return [edge.from, edge.to, edge.label, edge.direction, edge.routing, edge.fromPort, edge.toPort].join("|");
}

export function emptyDiff(): DocumentDiff {
	return { added: [], removed: [], modified: [], edgesAdded: [], edgesRemoved: [], edgesModified: [] };
}

/** Structural, order-insensitive comparison used by the review screen. */
export function diffDocuments(before: DiagramDocument, after: DiagramDocument): DocumentDiff {
	const diff = emptyDiff();
	if (before.title !== after.title) diff.titleChanged = { from: before.title, to: after.title };
	if (before.goal !== after.goal) diff.goalChanged = { from: before.goal, to: after.goal };

	const walk = (a: Diagram, b: Diagram, path: string): void => {
		const beforeBlocks = new Map(a.blocks.map(block => [block.id, block]));
		const afterBlocks = new Map(b.blocks.map(block => [block.id, block]));
		for (const [id, block] of beforeBlocks) {
			if (!afterBlocks.has(id)) diff.removed.push({ id, title: block.title, path });
		}
		for (const [id, block] of afterBlocks) {
			const previous = beforeBlocks.get(id);
			if (!previous) {
				diff.added.push({ id, title: block.title, path });
				continue;
			}
			const fields = BLOCK_FIELDS.filter(field => JSON.stringify(previous[field]) !== JSON.stringify(block[field]));
			if (fields.length === 0) continue;
			const changes = fields.map(field => ({ field, from: fieldText(previous, field), to: fieldText(block, field) }));
			diff.modified.push({ id, title: block.title, changes, path });
		}
		const beforeEdges = new Map(a.edges.map(edge => [edge.id, edge]));
		const afterEdges = new Map(b.edges.map(edge => [edge.id, edge]));
		const label = (edge: Edge, diagram: Diagram): string => {
			const name = (id: string): string => {
				const block = diagram.blocks.find(candidate => candidate.id === id);
				return block === undefined ? id : block.title.length > 0 ? block.title : id;
			};
			return `${name(edge.from)} -> ${name(edge.to)}${edge.label.length > 0 ? ` (${edge.label})` : ""}`;
		};
		for (const [id, edge] of beforeEdges) {
			if (!afterEdges.has(id)) diff.edgesRemoved.push(label(edge, a));
		}
		for (const [id, edge] of afterEdges) {
			const previous = beforeEdges.get(id);
			if (!previous) diff.edgesAdded.push(label(edge, b));
			else if (edgeSignature(previous) !== edgeSignature(edge)) diff.edgesModified.push(label(edge, b));
		}
		const collect = (diagram: Diagram, label: string, into: DocumentDiff["added"] | DocumentDiff["removed"]): void => {
			for (const block of diagram.blocks) {
				into.push({ id: block.id, title: block.title, path: label });
				if (block.children) collect(block.children, `${label} > ${block.title}`, into);
			}
		};
		for (const block of b.blocks) {
			const previous = beforeBlocks.get(block.id);
			if (!block.children) continue;
			if (previous?.children) walk(previous.children, block.children, `${path} > ${block.title}`);
			else collect(block.children, `${path} > ${block.title}`, diff.added);
		}
		for (const block of a.blocks) {
			if (!block.children) continue;
			if (!afterBlocks.get(block.id)?.children) collect(block.children, `${path} > ${block.title}`, diff.removed);
		}
	};
	walk(before.root, after.root, "root");
	return diff;
}

export function diffIsEmpty(diff: DocumentDiff): boolean {
	return (
		diff.added.length === 0 &&
		diff.removed.length === 0 &&
		diff.modified.length === 0 &&
		diff.edgesAdded.length === 0 &&
		diff.edgesRemoved.length === 0 &&
		diff.edgesModified.length === 0 &&
		diff.titleChanged === undefined &&
		diff.goalChanged === undefined
	);
}

// ---------------------------------------------------------------------------
// Canvas cells
// ---------------------------------------------------------------------------

type StyleKey =
	| "plain"
	| "border"
	| "borderSelected"
	| "title"
	| "titleSelected"
	| "muted"
	| "mutedSelected"
	| "edge"
	| "edgeSelected"
	| "line"
	| "lineSelected"
	| "unknown"
	| "observed";

interface Cell {
	ch: string;
	style: StyleKey;
}

function paint(theme: Theme, key: StyleKey, text: string): string {
	if (text.length === 0) return text;
	if (key === "plain") return text;
	if (key === "border") return theme.fg("border", text);
	if (key === "borderSelected") return theme.fg("accent", text);
	if (key === "title") return theme.fg("text", text);
	if (key === "titleSelected") return theme.bold(theme.fg("accent", text));
	if (key === "muted") return theme.fg("muted", text);
	if (key === "mutedSelected") return theme.fg("text", text);
	if (key === "edge") return theme.fg("borderMuted", text);
	if (key === "edgeSelected") return theme.fg("accent", text);
	if (key === "line") return theme.fg("borderMuted", text);
	if (key === "lineSelected") return theme.fg("accent", text);
	if (key === "unknown") return theme.fg("warning", text);
	return theme.fg("success", text);
}

class Grid {
	readonly width: number;
	readonly height: number;
	readonly #cells: Cell[];

	constructor(width: number, height: number) {
		this.width = Math.max(0, width);
		this.height = Math.max(0, height);
		this.#cells = Array.from({ length: this.width * this.height }, () => ({ ch: " ", style: "plain" as StyleKey }));
	}

	put(x: number, y: number, text: string, style: StyleKey): void {
		if (y < 0 || y >= this.height) return;
		let column = x;
		for (const ch of text) {
			const chWidth = visibleWidth(ch);
			if (chWidth === 0) continue;
			if (column >= 0 && column < this.width) {
				this.#cells[y * this.width + column] = { ch, style };
				for (let extra = 1; extra < chWidth; extra += 1) {
					if (column + extra < this.width) this.#cells[y * this.width + column + extra] = { ch: "", style };
				}
			}
			column += chWidth;
		}
	}

	#isFree(column: number, y: number): boolean {
		if (y < 0 || y >= this.height || column < 0 || column >= this.width) return false;
		const cell = this.#cells[y * this.width + column]!;
		if (cell.ch === "" || cell.ch === " ") return true;
		return cell.style === "line" || cell.style === "lineSelected" || cell.style === "edge" || cell.style === "edgeSelected";
	}

	/**
	 * Write over free cells only: a relationship label must never cover a card.
	 * Returns false when not a single character fitted.
	 */
	putFitting(x: number, y: number, text: string, style: StyleKey, minColumn: number, maxColumn: number): boolean {
		if (!this.#isFree(x, y)) return false;
		let column = x;
		let wrote = false;
		for (const ch of text) {
			const chWidth = visibleWidth(ch);
			if (chWidth === 0) continue;
			if (column + chWidth > maxColumn || !this.#isFree(column, y)) {
				if (wrote) this.put(column, y, "…", style);
				return wrote;
			}
			if (column >= minColumn) {
				this.put(column, y, ch, style);
				wrote = true;
			}
			column += chWidth;
		}
		return wrote;
	}

	line(y: number, theme: Theme): string {
		if (y < 0 || y >= this.height) return "";
		const parts: string[] = [];
		let run = "";
		let runStyle: StyleKey = "plain";
		for (let column = 0; column < this.width; column += 1) {
			const cell = this.#cells[y * this.width + column]!;
			if (cell.style !== runStyle) {
				parts.push(paint(theme, runStyle, run));
				run = "";
				runStyle = cell.style;
			}
			run += cell.ch;
		}
		parts.push(paint(theme, runStyle, run));
		return parts.join("");
	}
}

// ---------------------------------------------------------------------------
// Panel chrome
//
// These mirror `@oh-my-pi/pi-tui/chrome/overlay-box` visually. That module is
// not on the pi-tui package root, and its subpath resolves to a second pi-tui
// module graph whose theme singleton the host never initialises, so importing
// it would render with an undefined theme. The helpers here take the theme the
// host handed this extension instead.
// ---------------------------------------------------------------------------

function panelTop(theme: Theme, width: number, title: string, color: ThemeColor = "border"): string {
	const box = theme.boxRound;
	const inner = Math.max(0, width - 2);
	if (title.length === 0) return theme.fg(color, box.topLeft + box.horizontal.repeat(inner) + box.topRight);
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
	const fill = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		theme.fg(color, box.topLeft + box.horizontal) +
		theme.bold(theme.fg(color, shown)) +
		theme.fg(color, box.horizontal.repeat(fill) + box.topRight)
	);
}

function panelRule(theme: Theme, width: number): string {
	const box = theme.boxRound;
	return theme.fg("border", box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
}

function panelBottom(theme: Theme, width: number): string {
	const box = theme.boxRound;
	return theme.fg("border", box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight);
}

function panelRow(theme: Theme, content: string, width: number): string {
	const box = theme.boxRound;
	const inner = Math.max(0, width - 4);
	const body = inner > 0 ? pad(content, inner) : "";
	return `${theme.fg("border", box.vertical)} ${body} ${theme.fg("border", box.vertical)}`;
}

/** Numbered, syntax-highlighted source lines for the read-only source pane. */
export function renderSourceLines(
	theme: Theme,
	code: string,
	path: string,
	firstLine: number,
	width: number,
): string[] {
	const lines = highlightCode(code, getLanguageFromPath(path), theme);
	const gutter = String(firstLine + Math.max(0, lines.length - 1)).length;
	const bodyWidth = Math.max(1, width - gutter - 1);
	return lines.map((line, index) => {
		const number = theme.fg("muted", String(firstLine + index).padStart(gutter));
		return `${number} ${truncateToWidth(line, bodyWidth)}`;
	});
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

type FieldId =
	| "title"
	| "description"
	| "expectedOutput"
	| "criteria"
	| "evidence"
	| "enhance"
	| "venue"
	| "execute"
	| `source:${number}`
	| "source:add"
	| "edge:label"
	| "edge:direction"
	| "edge:routing"
	| "edge:fromPort"
	| "edge:toPort";

interface EditModal {
	kind: "edit";
	title: string;
	editor: Editor;
}

interface ListModal {
	kind: "list";
	title: string;
	items: string[];
	index: number;
	footer: string;
	onEnter: (index: number) => void;
	/** Optional `d` handler for list rows that can be removed. */
	onDelete?: (index: number) => void;
}

interface TextModal {
	kind: "text";
	title: string;
	lines: string[];
	offset: number;
}

interface ReviewModal {
	kind: "review";
	offset: number;
	requestId: string;
	entry: JournalEntry;
	diff: DocumentDiff;
	error?: string;
}

interface ConfirmModal {
	kind: "confirm";
	title: string;
	message: string;
	confirmLabel: string;
	onConfirm: () => void;
}

interface CloseModal {
	kind: "close";
	index: number;
}

type Modal = EditModal | ListModal | TextModal | ReviewModal | ConfirmModal | CloseModal;

interface PreviewPending {
	composed: ComposedRequest;
	kind: ActionKind;
	intent: Intent;
	scope: Scope;
	/** The token embedded in the previewed prompt; the submitted request must reuse it. */
	requestId: string;
	/** The directory the request may read, fixed when it was previewed. */
	codeRoot: string;
	save?: Promise<unknown>;
}

interface Override {
	kind: ActionKind;
	scope: Scope;
	/** A new document to create and save before the request is composed. */
	start?: DocumentStart;
}

interface SourceView {
	title: string;
	source: SourceRef;
	/** Raw file lines; only visible lines are highlighted on render. */
	lines: string[];
	offset: number;
	path?: string;
	error?: string;
}

export class DiagramScreen implements Component {
	readonly debugId = "omp-visual-planner";
	readonly debugKind = "VisualPlanner";

	readonly #options: ScreenOptions;
	readonly #done: (result: ScreenResult) => void;

	#stack: string[];
	#selected: string | undefined;
	#selectedEdge: string | undefined;
	/** In the outline view, `canvas` means the outline list has focus and `inspector` the block page. */
	#pane: "canvas" | "inspector" = "canvas";
	#view: "outline" | "canvas" = "outline";
	#collapsed = new Set<string>();
	#grounded = false;
	#outlineTop = 0;
	#modal: Modal | undefined;
	#linkFrom: string | undefined;
	#linkTarget: string | undefined;
	#sourceView: SourceView | undefined;
	#citationPreview: { key: string; lines: string[] } | undefined;
	#preview: PreviewPending | undefined;
	#viewport = { left: 0, top: 0 };
	#fieldIndex = 0;
	#message: string;
	#lastWidth = 120;
	#unsubscribe: (() => void) | undefined;
	#published = "";
	/** Redraws once a second while the agent works, so the elapsed clock and spinner move. */
	#ticker: ReturnType<typeof setInterval> | undefined;

	constructor(options: ScreenOptions, done: (result: ScreenResult) => void, start?: ScreenStart) {
		this.#options = options;
		this.#done = result => {
			this.#stopTicker();
			this.#unsubscribe?.();
			this.#unsubscribe = undefined;
			done(result);
		};
		// A cold start may have nothing on disk: the empty state is still a usable
		// surface, so the store gets an in-memory document to render and save.
		const document = options.store.document ?? options.store.newDocument({ title: "New architecture" });
		this.#stack = [document.root.id];
		const initial =
			options.initialSelection !== undefined && findBlockLocation(document.root, options.initialSelection)
				? options.initialSelection
				: document.root.blocks[0]?.id;
		if (initial !== undefined) this.#focus(initial);
		// Only an import notice greets you; the status line computes key hints and the staged-proposal marker itself.
		this.#message = options.store.importNotice === undefined ? "" : `${options.store.importNotice}; press s to choose a new path`;
		const staged = this.#stagedEntry();
		if (start?.action === "draft") {
			this.#beginDraft(start.purpose ?? "plan");
		} else if (start?.action === "discover") {
			this.#beginDiscover(start.target ?? ".");
		} else if (staged && staged.documentId === document.id) {
			// Opening the planner is how a human comes back to a staged proposal,
			// so show it rather than making them find the R binding.
			this.#openReview();
		}
		this.#unsubscribe = options.link?.subscribe(focus => this.#followExternal(focus));
		this.#publish();
	}

	/** Tell the other surfaces where focus is, when it moved. */
	#publish(): void {
		const key = `${this.#selected ?? ""}|${this.#stack.join("/")}`;
		if (key === this.#published) return;
		this.#published = key;
		this.#options.link?.publish(this.#selected, [...this.#stack]);
	}

	/**
	 * Another surface changed the session: redraw, and follow its focus unless
	 * a dialog here is bound to the block it opened on.
	 */
	#followExternal(focus: SharedFocus): void {
		const busy = this.#modal !== undefined || this.#sourceView !== undefined || this.#linkFrom !== undefined;
		if (!busy && focus.selected !== this.#selected) {
			const root = this.#document.root;
			if (focus.selected !== undefined && findBlockLocation(root, focus.selected)) {
				this.#focus(focus.selected);
				if (this.#view === "canvas") this.#ensureVisible();
			} else if (focus.selected === undefined) {
				const path = findDiagramPath(root, focus.stack.at(-1) ?? root.id);
				this.#stack = (path ?? [root]).map(diagram => diagram.id);
				this.#selected = undefined;
				this.#selectedEdge = undefined;
			}
			this.#published = `${this.#selected ?? ""}|${this.#stack.join("/")}`;
		}
		this.#options.tui.requestRender();
	}

	/**
	 * Focus a block anywhere in the document. The diagram stack follows it, so
	 * every editor that works on "the selected block in the current diagram"
	 * works unchanged from the outline.
	 */
	#focus(blockId: string): void {
		const location = findBlockLocation(this.#document.root, blockId);
		if (!location) return;
		this.#selected = blockId;
		this.#selectedEdge = undefined;
		this.#stack = findDiagramPath(this.#document.root, location.diagram.id)!.map(diagram => diagram.id);
	}

	/** Diagram ids from the root to the diagram on screen. */
	navigationStack(): string[] {
		return [...this.#stack];
	}

	navigationSelection(): string | undefined {
		return this.#selected;
	}

	#stopTicker(): void {
		clearInterval(this.#ticker);
		this.#ticker = undefined;
	}

	/** The agent's request on this branch while it is still running, and the ticker that animates it. */
	#working(): JournalEntry | undefined {
		const pending = this.#options.registry.pending();
		const working = pending?.state === "pending" ? pending : undefined;
		if (working && this.#ticker === undefined) {
			this.#ticker = setInterval(() => this.#options.tui.requestRender(), 1000);
			this.#ticker.unref?.();
		} else if (!working) {
			this.#stopTicker();
		}
		return working;
	}

	dispose(): void {
		this.#stopTicker();
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#dropModal();
	}

	invalidate(): void {
		this.#options.tui.requestRender();
	}

	setMessage(message: string): void {
		this.#message = message;
		this.#options.tui.requestRender();
	}

	// ------------------------------------------------------------------
	// Derived state
	// ------------------------------------------------------------------

	get #document(): DiagramDocument {
		return this.#options.store.require();
	}

	get #diagram(): Diagram {
		const id = this.#stack[this.#stack.length - 1]!;
		return findDiagramPath(this.#document.root, id)?.at(-1) ?? this.#document.root;
	}

	get #block(): Block | undefined {
		if (this.#selected === undefined) return undefined;
		return this.#diagram.blocks.find(block => block.id === this.#selected);
	}

	get #edge(): Edge | undefined {
		if (this.#selectedEdge === undefined) return undefined;
		return this.#diagram.edges.find(edge => edge.id === this.#selectedEdge);
	}

	get #fields(): FieldId[] {
		const edge = this.#edge;
		if (edge) return ["edge:label", "edge:direction", "edge:routing", "edge:fromPort", "edge:toPort"];
		const block = this.#block;
		if (!block) return [];
		const ids: FieldId[] = [];
		for (const field of pageFields(this.#document.purpose)) {
			if (field !== "sources") {
				ids.push(field);
				continue;
			}
			for (let index = 0; index < block.sources.length; index += 1) ids.push(`source:${index}`);
			ids.push("source:add");
		}
		return ids;
	}

	/** The purpose's word for a field, for prompts and inspector rows. */
	#labelOf(field: FieldId): string {
		if (field.startsWith("source")) return fieldLabel(this.#document.purpose, "sources");
		if (field.startsWith("edge:")) return field;
		return fieldLabel(this.#document.purpose, field as PageField);
	}

	#hasAuthoredContent(): boolean {
		const document = this.#options.store.document;
		if (!document) return false;
		return document.root.blocks.length > 0 || document.root.edges.length > 0 || document.goal.trim().length > 0;
	}

	#stagedEntry(): JournalEntry | undefined {
		return this.#options.registry
			.entries.filter(entry => entry.state === "staged" && entry.branchKey === this.#options.branchKey)
			.at(-1);
	}

	#diagramOf(document: DiagramDocument, diagramId: string): Diagram {
		return findDiagramPath(document.root, diagramId)?.at(-1) ?? document.root;
	}

	#transact(mutate: (document: DiagramDocument) => void, message: string): void {
		try {
			this.#options.store.transact(mutate);
			this.#message = message;
		} catch (error) {
			this.#message = error instanceof Error ? error.message : String(error);
		}
		this.#options.tui.requestRender();
	}

	// ------------------------------------------------------------------
	// Input routing
	// ------------------------------------------------------------------

	/** A message answers the key that caused it; the next key clears it and brings the hints back. */
	handleInput(data: string): void {
		this.#message = "";
		this.#route(data);
		this.#publish();
	}

	#route(data: string): void {
		const key = parseKey(data);
		if (this.#modal) {
			this.#handleModalInput(data, key);
			return;
		}
		if (this.#sourceView) {
			const view = this.#sourceView;
			if (key === "escape" || key === "ctrl+c") {
				this.#sourceView = undefined;
				this.#message = "closed the source view";
			} else if (!view.error) {
				const visible = Math.max(1, Math.min(layoutFor(this.#lastWidth, this.#options.tui.terminal.rows).bodyHeight, 100) - 2);
				const last = Math.max(0, view.lines.length - visible);
				switch (key) {
					case "j":
					case "down": view.offset = Math.min(last, view.offset + 1); break;
					case "k":
					case "up": view.offset = Math.max(0, view.offset - 1); break;
					case "pageDown": view.offset = Math.min(last, view.offset + visible); break;
					case "pageUp": view.offset = Math.max(0, view.offset - visible); break;
					case "g":
					case "home": view.offset = 0; break;
					case "G":
					case "end": view.offset = last; break;
				}
			}
			this.#options.tui.requestRender();
			return;
		}
		if (key === undefined) return;
		// A pending link owns the keyboard: the inspector's field shortcuts must
		// not swallow the target picker's arrows, Tab or Enter.
		if (this.#linkFrom !== undefined) {
			if (key === "escape") {
				this.#linkFrom = undefined;
				this.#linkTarget = undefined;
				this.#message = "link cancelled";
			} else if (key === "tab" || key === "shift+tab") {
				const step = key === "tab" ? 1 : -1;
				const found = cycleBlock(this.#diagram, this.#linkTarget, step);
				if (found !== undefined && found !== this.#linkFrom) this.#linkTarget = found;
			} else {
				this.#handleCanvasKey(key);
			}
			this.#options.tui.requestRender();
			return;
		}
		if (key === "ctrl+c") {
			this.#requestClose();
			return;
		}
		if (key === "escape") {
			// Escape backs out of the page (or inspector) first; only then does it close.
			if (this.#pane === "inspector") {
				this.#pane = "canvas";
				this.#options.tui.requestRender();
				return;
			}
			this.#requestClose();
			return;
		}
		if (this.#pane === "inspector" && this.#handleInspectorKey(key)) {
			this.#options.tui.requestRender();
			return;
		}
		if (this.#view === "outline") this.#handleOutlineKey(key);
		else this.#handleCanvasKey(key);
		this.#options.tui.requestRender();
	}

	/** Keys both views share: status, verbs, flow navigation, purpose and view. */
	#handleFlowKey(key: string): boolean {
		switch (key) {
			case "space":
				this.#cycleStatus();
				return true;
			case "g":
				if (this.#document.purpose !== "explore") return false;
				this.#grounded = !this.#grounded;
				this.#message = this.#grounded ? "showing only cited blocks" : "showing every claim";
				return true;
			case "n":
				this.#goNextOpen();
				return true;
			case "r":
			case "b":
			case "t":
			case "X":
				this.#runVerb(key);
				return true;
			case "p":
				this.#runVerb("r");
				return true;
			case "P":
				this.#openPurposeMenu();
				return true;
			case "v":
				this.#toggleView();
				return true;
			case "x":
				this.#openIncidentEdges();
				return true;
			case "d":
				this.#confirmDeleteBlock();
				return true;
			case "u":
				this.#message = this.#options.store.undo() ? "undone" : "nothing to undo";
				this.#ensureVisible();
				return true;
			case "ctrl+r":
				this.#message = this.#options.store.redo() ? "redone" : "nothing to redo";
				this.#ensureVisible();
				return true;
			case "a":
				this.#openActionMenu();
				return true;
			case "s":
				this.#save();
				return true;
			case "R":
				this.#openReview();
				return true;
			case "T":
				this.#tidy();
				return true;
			case "E":
				void this.#editExternally();
				return true;
			case "?":
				this.#openHelp();
				return true;
			default:
				return false;
		}
	}

	#handleOutlineKey(key: string): void {
		const rows = outlineRows(this.#document, this.#collapsed);
		const index = rows.findIndex(row => row.block.id === this.#selected);
		const row = rows[index];
		switch (key) {
			case "j":
			case "down": {
				const next = index === -1 ? rows[0] : rows[index + 1];
				if (next) this.#focus(next.block.id);
				return;
			}
			case "k":
			case "up": {
				const previous = index === -1 ? rows[0] : rows[index - 1];
				if (previous) this.#focus(previous.block.id);
				return;
			}
			case "h":
			case "left":
				if (!row) return;
				if (row.hasChildren && !row.collapsed) this.#collapsed.add(row.block.id);
				else if (row.parentId !== undefined) this.#focus(row.parentId);
				return;
			case "l":
			case "right":
				if (!row) return;
				if (row.collapsed) this.#collapsed.delete(row.block.id);
				else if (row.hasChildren) this.#focus(row.block.children!.blocks[0]!.id);
				return;
			case "J":
				this.#reorder(1);
				return;
			case "K":
				this.#reorder(-1);
				return;
			case "o":
				this.#addOutlineBlock("sibling");
				return;
			case "O":
				this.#addOutlineBlock("child");
				return;
			case "enter":
			case "i":
				if (key === "enter" && this.#walking(this.#block) && this.#block?.sources[0]) {
					void this.#loadSource(this.#block.sources[0]);
					return;
				}
				this.#pane = "inspector";
				this.#fieldIndex = 0;
				return;
			case "e":
				this.#openLinkPicker();
				return;
			default:
				this.#handleFlowKey(key);
		}
	}

	#reorder(delta: -1 | 1): void {
		const block = this.#block;
		if (!block) {
			this.#message = "select a block first";
			return;
		}
		const blocks = this.#diagram.blocks;
		const target = blocks.findIndex(candidate => candidate.id === block.id) + delta;
		if (target < 0 || target >= blocks.length) {
			this.#message = delta < 0 ? "already first" : "already last";
			return;
		}
		this.#transact(document => {
			moveBlockInOrder(document.root, block.id, delta);
		}, `moved "${block.title}" ${delta < 0 ? "up" : "down"}`);
	}

	/** Add a block after the focused one, or inside it, and name it straight away. */
	#addOutlineBlock(mode: "sibling" | "child"): void {
		const focused = this.#selected === undefined ? undefined : findBlockLocation(this.#document.root, this.#selected);
		if (mode === "child" && !focused) {
			this.#message = "select a block first";
			return;
		}
		const parent = mode === "child" ? focused!.block : undefined;
		const diagram = parent ? parent.children : (focused?.diagram ?? this.#document.root);
		const afterId = mode === "sibling" ? focused?.block.id : undefined;
		const position = diagram ? placeNewBlock(diagram, afterId) : { x: 2, y: 2 };
		const block = createBlock({ x: position.x, y: position.y });
		this.#transact(
			document => {
				if (parent) {
					const owner = findBlockLocation(document.root, parent.id)!.block;
					owner.children ??= { id: crypto.randomUUID(), blocks: [], edges: [] };
					addBlock(document.root, owner.children.id, block);
					return;
				}
				const target = focused ? focused.diagram.id : document.root.id;
				addBlock(document.root, target, block, afterId);
			},
			parent ? `added a block inside "${parent.title}"` : "added a block",
		);
		if (parent) this.#collapsed.delete(parent.id);
		this.#focus(block.id);
		this.#openTextPrompt("title", "", text => {
			if (text.trim().length > 0) this.#commitBlockField("title", text);
		});
	}

	#cycleStatus(): void {
		const block = this.#block;
		if (!block) {
			this.#message = "select a block first";
			return;
		}
		const purpose = this.#document.purpose;
		const next = nextStatus(purpose, block.status);
		if (next === undefined) {
			this.#message = "brainstorm ideas have no status";
			return;
		}
		const blockId = block.id;
		this.#transact(document => {
			const target = findBlockLocation(document.root, blockId);
			if (target) target.block.status = next;
		}, `"${block.title}" is now ${statusLabel(purpose, next)}`);
	}

	#goNextOpen(): void {
		const document = this.#document;
		const found = nextOpenBlock(document, this.#selected);
		if (found === undefined) {
			this.#message = document.purpose === "brainstorm" ? "no blocks yet" : "nothing left open";
			return;
		}
		const before = this.#diagram.id;
		this.#focus(found);
		if (this.#view === "canvas") {
			if (this.#diagram.id !== before) this.#viewport = { left: 0, top: 0 };
			this.#ensureVisible();
		}
		this.#message = `next: "${this.#block?.title ?? found}"`;
	}

	#runVerb(key: string): void {
		const purpose = this.#document.purpose;
		const verb = verbsFor(purpose).find(candidate => candidate.key === key);
		if (!verb) {
			this.#message = `no ${key} action for a ${purpose} document`;
			return;
		}
		const block = this.#block;
		if (!block) {
			this.#message = "select a block first";
			return;
		}
		this.#openPreview(verb.intent, { kind: verb.kind, scope: { kind: "block", id: block.id } });
	}

	#openPurposeMenu(): void {
		const current = this.#document.purpose;
		this.#modal = {
			kind: "list",
			title: "what is this document for?",
			items: [...PURPOSES],
			index: PURPOSES.indexOf(current),
			footer: "j/k select   Enter choose   Esc close",
			onEnter: index => {
				this.#modal = undefined;
				const choice = PURPOSES[index];
				if (!choice || choice === current) return;
				this.#fieldIndex = 0;
				this.#transact(document => {
					document.purpose = choice;
				}, `purpose: ${choice}`);
			},
		};
	}

	/**
	 * Open the focused block as a markdown file in the user's editor. The TUI
	 * steps aside while it runs; the saved file comes back as one undoable edit.
	 */
	async #editExternally(): Promise<void> {
		const block = this.#block;
		if (!block) {
			this.#message = "select a block first";
			return;
		}
		const edit = this.#options.externalEditor;
		if (!edit) {
			this.#message = "set $VISUAL or $EDITOR to edit blocks in your editor";
			return;
		}
		const blockId = block.id;
		const before = blockToMarkdown(block, this.#document.purpose);
		const tui = this.#options.tui;
		let after: string | null = null;
		let failure: string | undefined;
		tui.stop();
		try {
			after = await edit(before, block.title);
		} catch (error) {
			failure = `could not run the editor: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			tui.start();
			tui.requestRender(true);
		}
		if (failure !== undefined) {
			this.#message = failure;
		} else if (after === null) {
			this.#message = "editor exited without saving; the block is unchanged";
		} else if (after === before) {
			this.#message = "no changes";
		} else {
			const current = findBlockLocation(this.#document.root, blockId)?.block;
			if (!current) {
				this.#message = "that block was deleted while you were editing it";
			} else {
				const next = markdownToBlock(after, current);
				this.#transact(document => {
					const target = findBlockLocation(document.root, blockId)?.block;
					if (!target) throw new Error("that block was deleted while you were editing it");
					target.title = next.title;
					target.description = next.description;
					target.expectedOutput = next.expectedOutput;
					target.acceptanceCriteria = next.acceptanceCriteria;
					target.sources = next.sources;
					target.actions = { enhance: next.enhance, execute: next.execute };
				}, `updated "${next.title}" from your editor`);
			}
		}
		this.#publish();
		this.#options.tui.requestRender();
	}

	/** Re-lay the diagram that holds the focus (the one on screen in the map) on the grid. */
	#tidy(): void {
		const diagramId = this.#diagram.id;
		this.#transact(document => tidyDiagram(this.#diagramOf(document, diagramId)), "tidied the diagram");
		this.#viewport = { left: 0, top: 0 };
		this.#ensureVisible();
	}

	#toggleView(): void {
		this.#view = this.#view === "outline" ? "canvas" : "outline";
		this.#viewport = { left: 0, top: 0 };
		this.#linkFrom = undefined;
		this.#linkTarget = undefined;
		this.#fieldIndex = 0;
		if (this.#view === "canvas") this.#ensureVisible();
		this.#message = this.#view === "canvas" ? "map view — v returns to the outline" : "outline view";
	}

	/** Outline linking: pick a sibling from a list, then name the relationship. */
	#openLinkPicker(): void {
		const block = this.#block;
		if (!block) {
			this.#message = "select a block first";
			return;
		}
		const diagramId = this.#diagram.id;
		const others = this.#diagram.blocks.filter(candidate => candidate.id !== block.id);
		if (others.length === 0) {
			this.#message = "need another block in this diagram to link";
			return;
		}
		this.#modal = {
			kind: "list",
			title: `link "${block.title}" to…`,
			items: others.map(candidate => candidate.title || "(untitled)"),
			index: 0,
			footer: "j/k select   Enter choose   Esc close",
			onEnter: index => {
				this.#modal = undefined;
				const target = others[index];
				if (!target) return;
				this.#openTextPrompt("relationship label", "", label => {
					const edge = createEdge({ from: block.id, to: target.id, label: label.trim() });
					this.#transact(document => {
						if (!addEdge(document.root, diagramId, edge)) throw new Error("that relationship would be invalid");
					}, `linked "${block.title}" → "${target.title}"`);
				});
			},
		};
	}

	#handleCanvasKey(key: string): void {
		switch (key) {
			case "h":
			case "left":
				this.#moveSelection("h");
				return;
			case "j":
			case "down":
				this.#moveSelection("j");
				return;
			case "k":
			case "up":
				this.#moveSelection("k");
				return;
			case "l":
			case "right":
				this.#moveSelection("l");
				return;
			case "tab":
				this.#cycle(1);
				return;
			case "shift+tab":
				this.#cycle(-1);
				return;
			case "H":
				this.#moveBlock(-1, 0);
				return;
			case "J":
				this.#moveBlock(0, 1);
				return;
			case "K":
				this.#moveBlock(0, -1);
				return;
			case "L":
				this.#moveBlock(1, 0);
				return;
			case "ctrl+left":
				this.#pan(-4, 0);
				return;
			case "ctrl+right":
				this.#pan(4, 0);
				return;
			case "ctrl+up":
				this.#pan(0, -4);
				return;
			case "ctrl+down":
				this.#pan(0, 4);
				return;
			case "o":
				this.#addBlock();
				return;
			case "i":
				this.#toggleInspector();
				return;
			case "enter":
				if (this.#linkFrom !== undefined) this.#commitLink();
				else this.#descend();
				return;
			case "backspace":
				this.#ascend();
				return;
			case "e":
				this.#startLink();
				return;
			default:
				this.#handleFlowKey(key);
		}
	}

	#pan(dx: number, dy: number): void {
		this.#viewport = { left: Math.max(0, this.#viewport.left + dx), top: Math.max(0, this.#viewport.top + dy) };
	}

	#toggleInspector(): void {
		if (this.#pane === "inspector") {
			this.#pane = "canvas";
			return;
		}
		this.#pane = "inspector";
		this.#fieldIndex = 0;
	}

	#cycle(step: 1 | -1): void {
		const found = cycleBlock(this.#diagram, this.#selected, step);
		if (found !== undefined) this.#selected = found;
		this.#selectedEdge = undefined;
		this.#ensureVisible();
	}

	#moveSelection(direction: "h" | "j" | "k" | "l"): void {
		if (this.#linkFrom !== undefined) {
			const found = nearestBlock(this.#diagram, this.#linkTarget ?? this.#linkFrom, direction);
			if (found !== undefined) this.#linkTarget = found;
			return;
		}
		const current = this.#selected;
		if (current === undefined) {
			this.#selected = this.#diagram.blocks[0]?.id;
			return;
		}
		const found = nearestBlock(this.#diagram, current, direction);
		if (found !== undefined) {
			this.#selected = found;
			this.#selectedEdge = undefined;
			this.#ensureVisible();
		}
	}

	#moveBlock(dx: number, dy: number): void {
		const block = this.#block;
		if (!block) return;
		this.#transact(document => {
			const target = findBlockLocation(document.root, block.id);
			if (!target) return;
			target.block.position = {
				x: Math.max(0, target.block.position.x + dx),
				y: Math.max(0, target.block.position.y + dy),
			};
		}, `moved ${block.title}`);
		this.#ensureVisible();
	}

	#addBlock(): void {
		const diagramId = this.#diagram.id;
		const position = placeNewBlock(this.#diagram, this.#selected);
		const block = createBlock({ x: position.x, y: position.y });
		this.#transact(document => {
			addBlock(document.root, diagramId, block);
		}, "added a block");
		this.#selected = block.id;
		this.#selectedEdge = undefined;
		this.#ensureVisible();
	}

	#descend(): void {
		const block = this.#block;
		if (!block) return;
		if (!block.children) {
			this.#transact(document => {
				const target = findBlockLocation(document.root, block.id);
				if (target) target.block.children = { id: crypto.randomUUID(), blocks: [], edges: [] };
			}, `entered ${block.title}`);
		}
		const updated = findBlockLocation(this.#document.root, block.id)?.block;
		if (!updated?.children) return;
		this.#stack.push(updated.children.id);
		this.#selected = updated.children.blocks[0]?.id;
		this.#selectedEdge = undefined;
		this.#viewport = { left: 0, top: 0 };
		this.#pane = "canvas";
	}

	#ascend(): void {
		if (this.#stack.length <= 1) {
			this.#message = "already at the top level";
			return;
		}
		const leaving = this.#stack.pop()!;
		const owner = findOwnedDiagram(this.#document.root, leaving);
		this.#selected = owner?.owner.id ?? this.#document.root.blocks[0]?.id;
		this.#selectedEdge = undefined;
		this.#pane = "canvas";
		this.#viewport = { left: 0, top: 0 };
		this.#ensureVisible();
	}

	#ensureVisible(): void {
		const block = this.#block;
		if (!block) return;
		const rect = cardRect(block);
		const layout = layoutFor(this.#lastWidth, this.#options.tui.terminal.rows);
		if (rect.x < this.#viewport.left) this.#viewport.left = rect.x;
		if (rect.y < this.#viewport.top) this.#viewport.top = rect.y;
		if (rect.x + rect.w > this.#viewport.left + layout.canvasWidth) {
			this.#viewport.left = Math.max(0, rect.x + rect.w - layout.canvasWidth);
		}
		if (rect.y + rect.h > this.#viewport.top + layout.bodyHeight) {
			this.#viewport.top = Math.max(0, rect.y + rect.h - layout.bodyHeight);
		}
	}

	#startLink(): void {
		const block = this.#block;
		if (!block || this.#diagram.blocks.length < 2) {
			this.#message = "need two blocks in this diagram to link";
			return;
		}
		this.#pane = "canvas";
		this.#linkFrom = block.id;
		this.#linkTarget = this.#diagram.blocks.find(candidate => candidate.id !== block.id)?.id;
		this.#message = `linking from ${block.title}: arrows or Tab pick a target, Enter commits, Escape cancels`;
	}

	#commitLink(): void {
		const from = this.#linkFrom;
		const to = this.#linkTarget;
		this.#linkFrom = undefined;
		this.#linkTarget = undefined;
		if (from === undefined || to === undefined || from === to) {
			this.#message = "link cancelled";
			return;
		}
		const diagramId = this.#diagram.id;
		const edge = createEdge({ from, to });
		this.#transact(document => {
			if (!addEdge(document.root, diagramId, edge)) throw new Error("that relationship would be invalid");
		}, "added a relationship");
		this.#selectedEdge = edge.id;
		this.#pane = "inspector";
		this.#fieldIndex = 0;
	}

	#openIncidentEdges(): void {
		const block = this.#block;
		if (!block) return;
		const edges = this.#diagram.edges.filter(edge => edge.from === block.id || edge.to === block.id);
		if (edges.length === 0) {
			this.#message = `${block.title} has no relationships in this diagram`;
			return;
		}
		const items = edges.map(edge => {
			const other = this.#diagram.blocks.find(
				candidate => candidate.id === (edge.from === block.id ? edge.to : edge.from),
			);
			const arrow = edge.from === block.id ? "->" : "<-";
			return `${arrow} ${other?.title ?? "?"}${edge.label.length > 0 ? ` "${edge.label}"` : ""} (${edge.direction}, ${edge.routing})`;
		});
		this.#modal = {
			kind: "list",
			title: `relationships of ${block.title}`,
			items,
			index: 0,
			footer: "j/k select   Enter edit   x delete   Esc close",
			onEnter: index => {
				const edge = edges[index];
				this.#modal = undefined;
				if (!edge) return;
				this.#selectedEdge = edge.id;
				this.#pane = "inspector";
				this.#fieldIndex = 0;
				this.#message = "editing relationship; d removes it here";
			},
			onDelete: index => {
				const edge = edges[index];
				if (!edge) return;
				const edgeId = edge.id;
				const diagramId = this.#diagram.id;
				this.#modal = undefined;
				this.#transact(document => {
					const diagram = this.#diagramOf(document, diagramId);
					diagram.edges = diagram.edges.filter(candidate => candidate.id !== edgeId);
				}, "deleted relationship");
			},
		};
	}

	#confirmDeleteBlock(): void {
		const block = this.#block;
		if (!block) return;
		const count = descendantIds(block).length;
		const diagramId = this.#diagram.id;
		this.#modal = {
			kind: "confirm",
			title: "delete block",
			message: `Delete "${block.title}"${count > 1 ? ` and its ${count - 1} nested block(s)` : ""}? Its relationships go too.`,
			confirmLabel: "Delete",
			onConfirm: () => {
				this.#transact(document => {
					removeBlock(this.#diagramOf(document, diagramId), block.id);
				}, `deleted ${block.title}`);
				if (this.#selected === block.id) {
					this.#selected = this.#diagram.blocks[0]?.id;
					this.#selectedEdge = undefined;
				}
			},
		};
	}

	// ------------------------------------------------------------------
	// Inspector
	// ------------------------------------------------------------------

	#handleInspectorKey(key: string): boolean {
		const fields = this.#fields;
		if (fields.length === 0) return false;
		const index = Math.min(this.#fieldIndex, fields.length - 1);
		const field = fields[index]!;
		if (key === "j" || key === "down") {
			this.#fieldIndex = (index + 1) % fields.length;
			return true;
		}
		if (key === "k" || key === "up") {
			this.#fieldIndex = (index - 1 + fields.length) % fields.length;
			return true;
		}
		if (key === "o" && field.startsWith("source")) {
			this.#openTextPrompt("add source reference (path or path:10-40)", "", value => {
				const source = parseSourceRef(value);
				const block = this.#block;
				if (source.path.length === 0 || !block) return;
				this.#transact(document => {
					findBlockLocation(document.root, block.id)?.block.sources.push(source);
				}, `added source ${source.path}`);
			});
			return true;
		}
		if (key === "m" && field.startsWith("source:") && field !== "source:add") {
			const source = this.#block?.sources[Number(field.slice("source:".length))];
			if (source) {
				this.#openTextPrompt("edit source reference", formatSourceRef(source), value => {
					const next = parseSourceRef(value);
					const block = this.#block;
					const sourceIndex = Number(field.slice("source:".length));
					if (next.path.length === 0 || !block) return;
					this.#transact(document => {
						const target = findBlockLocation(document.root, block.id);
						if (target?.block.sources[sourceIndex]) target.block.sources[sourceIndex] = next;
					}, `updated source ${next.path}`);
				});
			}
			return true;
		}
		if (key === "d") {
			if (field.startsWith("source:") && field !== "source:add") {
				const block = this.#block;
				const sourceIndex = Number(field.slice("source:".length));
				if (!block) return true;
				this.#transact(document => {
					findBlockLocation(document.root, block.id)?.block.sources.splice(sourceIndex, 1);
				}, "removed source reference");
				this.#fieldIndex = Math.max(0, index - 1);
				return true;
			}
			if (field.startsWith("edge:")) {
				this.#deleteEdge();
				return true;
			}
			return false;
		}
		if (key === "enter") {
			this.#activateField(field);
			return true;
		}
		return false;
	}

	#activateField(field: FieldId): void {
		const block = this.#block;
		const edge = this.#edge;
		if (field === "evidence" && block) {
			const next = EVIDENCE_VALUES[(EVIDENCE_VALUES.indexOf(block.evidence) + 1) % EVIDENCE_VALUES.length]!;
			if (next === "observed" && block.sources.length === 0) {
				this.#message = "add a source reference first: observed blocks must cite what was read";
				return;
			}
			this.#transact(document => {
				const target = findBlockLocation(document.root, block.id);
				if (target) target.block.evidence = next;
			}, `evidence ${next}`);
			return;
		}
		if (field === "venue" && block) {
			const order = ["here", "subagent", "worktree"] as const;
			const next = order[(order.indexOf(block.venue ?? "here") + 1) % order.length]!;
			this.#transact(document => {
				const target = findBlockLocation(document.root, block.id);
				if (!target) return;
				if (next === "here") delete target.block.venue;
				else target.block.venue = next;
			}, `venue ${next}`);
			return;
		}
		if (field === "source:add") {
			this.#openTextPrompt("add source reference (path or path:10-40)", "", value => {
				const source = parseSourceRef(value);
				if (source.path.length === 0 || !block) return;
				this.#transact(document => {
					findBlockLocation(document.root, block.id)?.block.sources.push(source);
				}, `added source ${source.path}`);
			});
			return;
		}
		if (field.startsWith("source:") && block) {
			const source = block.sources[Number(field.slice("source:".length))];
			if (source) void this.#loadSource(source);
			return;
		}
		if (field.startsWith("edge:")) {
			if (!edge) return;
			if (field === "edge:label") {
				this.#openTextPrompt("relationship label", edge.label, value => {
					const edgeId = edge.id;
					const diagramId = this.#diagram.id;
					this.#transact(document => {
						const target = this.#diagramOf(document, diagramId).edges.find(candidate => candidate.id === edgeId);
						if (target) target.label = value;
					}, "updated relationship label");
				});
				return;
			}
			const cycles: Record<string, readonly string[]> = {
				"edge:direction": EDGE_DIRECTIONS,
				"edge:routing": EDGE_ROUTINGS,
				"edge:fromPort": EDGE_PORTS,
				"edge:toPort": EDGE_PORTS,
			};
			const options = cycles[field];
			if (!options) return;
			const name = field.slice("edge:".length) as "direction" | "routing" | "fromPort" | "toPort";
			const next = options[(options.indexOf(edge[name]) + 1) % options.length]!;
			const edgeId = edge.id;
			const diagramId = this.#diagram.id;
			this.#transact(document => {
				const target = this.#diagramOf(document, diagramId).edges.find(candidate => candidate.id === edgeId);
				if (!target) return;
				if (name === "direction") target.direction = next as EdgeDirection;
				if (name === "routing") target.routing = next as EdgeRouting;
				if (name === "fromPort") target.fromPort = next as EdgePort;
				if (name === "toPort") target.toPort = next as EdgePort;
			}, `${field} = ${next}`);
			return;
		}
		if (!block) return;
		const prefills: Record<string, string> = {
			title: block.title,
			description: block.description,
			expectedOutput: block.expectedOutput,
			criteria: block.acceptanceCriteria.join("\n"),
			enhance: block.actions.enhance,
			execute: block.actions.execute,
		};
		const prefill = prefills[field];
		if (prefill === undefined) return;
		this.#openTextPrompt(this.#labelOf(field), prefill, value => this.#commitBlockField(field, value));
	}

	#commitBlockField(field: FieldId, text: string): void {
		const block = this.#block;
		if (!block) return;
		const blockId = block.id;
		this.#transact(document => {
			const target = findBlockLocation(document.root, blockId);
			if (!target) return;
			if (field === "title") target.block.title = text.trim().length > 0 ? text.trim() : target.block.title;
			if (field === "description") target.block.description = text;
			if (field === "expectedOutput") target.block.expectedOutput = text;
			if (field === "enhance") target.block.actions.enhance = text;
			if (field === "execute") target.block.actions.execute = text;
			if (field === "criteria") {
				target.block.acceptanceCriteria = text
					.split("\n")
					.map(line => line.trim())
					.filter(line => line.length > 0);
			}
		}, `updated ${field}`);
	}

	#deleteEdge(): void {
		const edge = this.#edge;
		if (!edge) return;
		const edgeId = edge.id;
		const diagramId = this.#diagram.id;
		this.#transact(document => {
			const diagram = this.#diagramOf(document, diagramId);
			diagram.edges = diagram.edges.filter(candidate => candidate.id !== edgeId);
		}, "deleted relationship");
		this.#selectedEdge = undefined;
		this.#fieldIndex = 0;
	}

	// ------------------------------------------------------------------
	// Text prompts and the source pane
	// ------------------------------------------------------------------

	#openTextPrompt(title: string, prefill: string, onCommit: (text: string) => void): void {
		this.#dropModal();
		const editor = new Editor(getEditorTheme());
		editor.setBorderVisible(false);
		editor.setPromptGutter("");
		editor.setPaddingX(0);
		editor.setMaxHeight(10);
		editor.setText(prefill);
		editor.focused = true;
		editor.onSubmit = text => {
			this.#dropModal();
			onCommit(text);
		};
		this.#modal = { kind: "edit", title: `${title} — Enter accepts, Esc cancels`, editor };
		this.#options.tui.requestRender();
	}

	/** Release the active text field, including its paste state. */
	#dropModal(): void {
		if (this.#modal?.kind === "edit") this.#modal.editor.clearPasteState();
		this.#modal = undefined;
	}

	async #loadSource(source: SourceRef): Promise<void> {
		const absolute = isAbsolute(source.path) ? source.path : resolvePath(this.#options.cwd, source.path);
		const title = displayPath(absolute, this.#options.cwd);
		try {
			const info = await stat(absolute);
			if (info.size > MAX_VIEWER_FILE_BYTES) {
				this.#sourceView = {
					title,
					source,
					lines: [],
					offset: 0,
					error: `${absolute} is ${info.size} bytes; the source pane refuses files over ${MAX_VIEWER_FILE_BYTES}`,
				};
				this.#options.tui.requestRender();
				return;
			}
			const text = await readFile(absolute, "utf8");
			const lines = text.split("\n");
			const visible = Math.max(1, Math.min(layoutFor(this.#lastWidth, this.#options.tui.terminal.rows).bodyHeight, 100) - 2);
			const offset = Math.min(Math.max(0, (source.startLine ?? 1) - 4), Math.max(0, lines.length - visible));
			this.#sourceView = { title, source, lines, offset, path: absolute };
		} catch (error) {
			this.#sourceView = {
				title,
				source,
				lines: [],
				offset: 0,
				error: `cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		this.#options.tui.requestRender();
	}
	/** A few syntax-highlighted lines of the focused block's first citation, loaded once per range. */
	#citationLines(block: Block, width: number): string[] {
		const source = block.sources[0];
		if (!source) return [];
		const key = `${source.path}:${source.startLine ?? ""}:${source.endLine ?? ""}`;
		if (this.#citationPreview?.key === key) return this.#citationPreview.lines;
		this.#citationPreview = { key, lines: [this.#options.theme.fg("muted", "reading source…")] };
		void this.#readCitation(block, key, width);
		return this.#citationPreview.lines;
	}

	async #readCitation(block: Block, key: string, width: number): Promise<void> {
		const source = block.sources[0];
		if (!source || this.#citationPreview?.key !== key) return;
		const absolute = isAbsolute(source.path) ? source.path : resolvePath(this.#options.cwd, source.path);
		try {
			const info = await stat(absolute);
			if (info.size > MAX_VIEWER_FILE_BYTES) {
				this.#citationPreview = { key, lines: [this.#options.theme.fg("error", "cited file is too large to highlight")] };
			} else {
				const text = await readFile(absolute, "utf8");
				const all = text.split("\n");
				const start = Math.max(1, source.startLine ?? 1);
				const end = Math.min(all.length, Math.max(source.endLine ?? start, start));
				// Tabs expanded, then the shared indent removed: a snippet from deep inside a
				// function should not spend half the pane on leading whitespace.
				const slice = all.slice(start - 1, Math.min(end, start + 7)).map(line => replaceTabs(line));
				const indent = Math.min(...slice.filter(line => line.trim().length > 0).map(line => line.length - line.trimStart().length));
				const code = slice.map(line => line.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
				const highlighted = renderSourceLines(this.#options.theme, code, source.path, start, Math.max(12, width));
				const more = end > start + 7 ? [this.#options.theme.fg("muted", `… ${end - start - 7} more lines — Enter opens the file`)] : [];
				if (this.#citationPreview?.key !== key) return;
				this.#citationPreview = { key, lines: [...highlighted, ...more] };
			}
		} catch (error) {
			if (this.#citationPreview?.key !== key) return;
			this.#citationPreview = {
				key,
				lines: [this.#options.theme.fg("error", `cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`)],
			};
		}
		this.#options.tui.requestRender();
	}


	// ------------------------------------------------------------------
	// Actions, preview, review
	// ------------------------------------------------------------------

	#openActionMenu(): void {
		const pending = this.#options.registry.pending();
		const purpose = this.#document.purpose;
		const block = this.#block;
		const choices: { label: string; run: () => void }[] = [];
		if (block) {
			for (const verb of verbsFor(purpose)) {
				choices.push({
					label: `${verb.label} "${block.title}"   ${verb.key}`,
					run: () => this.#openPreview(verb.intent, { kind: verb.kind, scope: { kind: "block", id: block.id } }),
				});
			}
		}
		for (const action of projectActions(purpose)) {
			choices.push({ label: `${action.label}…`, run: () => this.#runProjectAction(action) });
		}
		choices.push({ label: "Change purpose   P", run: () => this.#openPurposeMenu() });
		if (pending) {
			choices.push({
				label: "Discard pending request",
				run: () => {
					this.#options.registry.resolve(pending.requestId, "discarded");
					this.#message = "pending request discarded; a late proposal for it will be refused";
				},
			});
		}
		this.#modal = {
			kind: "list",
			title: "actions",
			items: choices.map(choice => choice.label),
			index: 0,
			footer: "j/k select   Enter choose   Esc close",
			onEnter: index => {
				this.#modal = undefined;
				choices[index]?.run();
			},
		};
	}

	/** One whole-document action: start a new document, or preview a project-scope request. */
	#runProjectAction(action: ProjectAction): void {
		if (action.kind === "draft") {
			this.#beginDraft(this.#document.purpose === "brainstorm" ? "brainstorm" : "plan");
			return;
		}
		if (action.kind === "discover") {
			this.#beginDiscover(".");
			return;
		}
		this.#openPreview(action.kind, { kind: action.kind, scope: { kind: "project" } });
	}

	#beginDraft(purpose: "brainstorm" | "plan"): void {
		this.#openTextPrompt("what is this about? (becomes the goal)", "", goal => {
			if (goal.trim().length === 0) {
				this.#message = "a draft needs a goal";
				this.#options.tui.requestRender();
				return;
			}
			this.#openPreview("plan", { kind: "draft", scope: { kind: "project" }, start: { kind: "draft", goal, purpose } });
		});
	}

	#beginDiscover(target: string): void {
		this.#openTextPrompt("codebase path to map", target, value => {
			this.#openPreview("discover", {
				kind: "discover",
				scope: { kind: "project" },
				start: { kind: "discover", target: value.trim() || "." },
			});
		});
	}

	#openPreview(intent: Intent, override: Override): void {
		const { kind, scope } = override;
		let save: Promise<unknown> | undefined;
		if (override.start) {
			// Starting a new document replaces the in-memory one, so a document with
			// authored content must be saved first. A fresh empty document has
			// nothing to lose and is replaced silently.
			if (this.#options.store.dirty && this.#hasAuthoredContent()) {
				this.#message = "save this document (s) before starting a new one";
				this.#options.tui.requestRender();
				return;
			}
			const started = startDocument(this.#options.store, this.#options.cwd, override.start);
			this.#stack = [started.document.root.id];
			this.#selected = undefined;
			this.#selectedEdge = undefined;
			this.#viewport = { left: 0, top: 0 };
			this.#collapsed.clear();
			save = started.save.then(result => {
				if (!result.ok) this.#message = result.errors.join("; ");
				this.#options.tui.requestRender();
				return result;
			});
		}
		const codeRoot = codeRootFor(this.#options.cwd, override.start);
		let composed: ComposedRequest;
		try {
			composed = composeRequest({
				document: this.#document,
				kind,
				intent,
				scope,
				branchKey: this.#options.branchKey,
				baseDigest: this.#options.store.diskDigest,
				codeRoot,
			});
		} catch (error) {
			this.#message = error instanceof ScopeError ? error.message : String(error);
			return;
		}
		this.#preview = { composed, kind, intent, scope, requestId: composed.request.requestId, codeRoot, save };
		this.#modal = { kind: "text", title: `preview — ${composed.label} (${composed.size} chars)`, lines: composed.prompt.split("\n"), offset: 0 };
	}

	#submitPreview(): void {
		const preview = this.#preview;
		if (!preview) return;
		if (this.#options.store.dirty) {
			this.#modal = {
				kind: "confirm",
				title: "unsaved changes",
				message: "Save the authored document before submitting?",
				confirmLabel: "Save",
				onConfirm: () => {
					void this.#options.store.save().then(result => {
						if (!result.ok) {
							this.#message = result.errors.join("; ");
							this.#options.tui.requestRender();
							return;
						}
						void this.#finishSubmit(preview);
					});
				},
			};
			return;
		}
		void this.#finishSubmit(preview);
	}

	async #finishSubmit(preview: PreviewPending): Promise<void> {
		if (preview.save) await preview.save;
		if (!this.#options.hasUI) {
			this.#message = "the planner needs an interactive session to submit";
			return;
		}
		if (!this.#options.isIdle() || this.#options.hasPendingMessages()) {
			this.#message = "OMP is busy; finish or cancel the current task before submitting.";
			this.#options.tui.requestRender();
			return;
		}
		// Recompose against the saved document so the request carries the digest it was saved with.
		let composed: ComposedRequest;
		try {
			composed = composeRequest({
				document: this.#document,
				kind: preview.kind,
				intent: preview.intent,
				scope: preview.scope,
				branchKey: this.#options.branchKey,
				baseDigest: this.#options.store.diskDigest,
				codeRoot: preview.codeRoot,
				requestId: preview.requestId,
			});
		} catch (error) {
			this.#message = error instanceof ScopeError ? error.message : String(error);
			this.#options.tui.requestRender();
			return;
		}
		this.#preview = undefined;
		this.#modal = undefined;
		this.#done({ kind: "submit", request: composed.request, prompt: composed.prompt });
	}

	#openReview(): void {
		const entry = this.#stagedEntry();
		if (!entry?.proposal) {
			this.#message = "no staged proposal to review";
			return;
		}
		const projected = this.#project(entry);
		if (!projected.ok) {
			this.#modal = {
				kind: "review",
				offset: 0,
				requestId: entry.requestId,
				entry,
				diff: emptyDiff(),
				error: projected.errors.join("; "),
			};
			return;
		}
		this.#modal = {
			kind: "review",
			offset: 0,
			requestId: entry.requestId,
			entry,
			diff: diffDocuments(this.#document, projected.document),
		};
	}

	#project(entry: JournalEntry): { ok: true; document: DiagramDocument } | { ok: false; errors: string[] } {
		const proposal = entry.proposal;
		if (!proposal) return { ok: false, errors: ["that request has no staged proposal"] };
		const clone = structuredClone(this.#document);
		try {
			acceptReplacement(clone, proposal.replacement, entry.scope.id, entry);
		} catch (error) {
			return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
		}
		return { ok: true, document: clone };
	}

	async #acceptReview(requestId: string): Promise<void> {
		const entry = this.#options.registry.entryFor(requestId);
		if (!entry?.proposal) return;
		const digest = await this.#options.store.currentDiskDigest();
		const applicable = this.#options.registry.checkApplicable(requestId, {
			revision: this.#document.revision,
			digest,
			documentId: this.#document.id,
			branchKey: this.#options.branchKey,
		});
		if (!applicable.ok) {
			this.#options.registry.resolve(requestId, "stale", applicable.errors.join("; "));
			this.#modal = {
				kind: "review",
				offset: 0,
				requestId,
				entry,
				diff: emptyDiff(),
				error: `${applicable.errors.join("; ")} — reject it, or run the action again`,
			};
			this.#options.tui.requestRender();
			return;
		}
		const proposal = entry.proposal;
		const before = this.#document.revision;
		this.#transact(document => acceptReplacement(document, proposal.replacement, entry.scope.id, entry), "proposal accepted");
		this.#options.registry.resolve(requestId, "accepted");
		this.#modal = undefined;
		if (this.#document.revision !== before) this.#message = this.#acceptedMessage(entry);
		this.#publish();
		this.#options.tui.requestRender();
	}

	/** After an accept, point at the human's next move: settle the block, then move on. */
	#acceptedMessage(entry: JournalEntry): string {
		const document = this.#document;
		const purpose = document.purpose;
		if (purpose === "brainstorm") return "proposal accepted";
		const scoped =
			entry.scope.kind === "block" && entry.scope.id !== undefined
				? findBlockLocation(document.root, entry.scope.id)?.block
				: undefined;
		if (scoped) {
			this.#collapsed.delete(scoped.id);
			this.#focus(scoped.id);
		}
		const next = nextStatus(purpose, scoped?.status ?? "open");
		const label = next === undefined ? "" : (statusLabel(purpose, next) ?? "");
		return `accepted — space marks "${scoped?.title ?? document.title}" ${label}, n goes to the next open block`;
	}

	#rejectReview(requestId: string): void {
		this.#options.registry.resolve(requestId, "rejected");
		this.#modal = undefined;
		this.#message = "proposal rejected; the authored document is unchanged";
		this.#options.tui.requestRender();
	}

	// ------------------------------------------------------------------
	// Help, save, close
	// ------------------------------------------------------------------

	/** The key sheet: grouped by what you are doing, in this document's words. */
	#openHelp(): void {
		const theme = this.#options.theme;
		const purpose = this.#document.purpose;
		const cycle = statusCycle(purpose).map(status => statusLabel(purpose, status)).join(" → ");
		const row = (keys: string, what: string): string => `  ${keys.padEnd(16)}${what}`;
		const section = (title: string, rows: string[]): string[] => [theme.bold(title), ...rows, ""];
		const verbs = verbsFor(purpose).map(verb => row(verb.key, `${verb.label} the focused block — previewed first`));
		const move =
			this.#view === "outline"
				? section("Move", [
						row("j / k", "next / previous block"),
						row("h / l", "collapse or go to the parent / expand or go inside"),
						row("n", purpose === "brainstorm" ? "next idea" : "next open block"),
						row("v", "switch to the map"),
					])
				: section("Map", [
						row("arrows", "select the nearest block that way"),
						row("Tab", "cycle blocks in this diagram"),
						row("Enter / Bksp", "go inside the block / up one level"),
						row("H J K L", "move the selected block one cell"),
						row("Ctrl+arrows", "pan"),
						row("i", "inspect the block's fields"),
						row("T", "tidy this diagram onto a grid"),
						row("v", "back to the outline"),
					]);
		const edit = section("Edit", [
			row("Enter", "open the page: j/k picks a field, Enter edits it, Esc returns"),
			...(purpose === "explore" ? [row("Enter (cited)", "in the walk, open the cited source; i opens the page")] : []),
			row("o / O", purpose === "brainstorm" ? "add an idea after this one / dump a line inside it" : "add a block after this one / inside it"),
			row("J / K", "move the block down / up among its siblings"),
			...(cycle.length > 0 ? [row("space", `step the status: ${cycle}`)] : []),
			...(purpose === "explore" ? [row("g", "grounded: hide blocks without a citation")] : []),
			row("e / x", "link to a sibling / list and edit its links"),
			row("E", "edit the whole block as markdown in $VISUAL or $EDITOR"),
			row("d", "delete the block and everything inside it"),
			row("u / Ctrl+R", "undo / redo"),
		]);
		const agent = section("Ask the agent — you review every proposal", [
			...verbs,
			row("a", "all actions, including whole-document replan and prune"),
			row("R", "review a staged proposal: Enter accepts, r rejects"),
		]);
		const document = section("Document", [
			row("s", "save — nothing is written until you do"),
			row("P", "change what the document is for"),
			row("Esc", "back out; on the outline it closes the planner"),
		]);
		this.#modal = {
			kind: "text",
			title: "keys",
			lines: [...move, ...edit, ...agent, ...document].slice(0, -1),
			offset: 0,
		};
	}

	#save(): void {
		if (this.#options.store.path === undefined) {
			this.#openTextPrompt("save as", this.#options.documentPathHint, value => {
				if (value.length === 0) return;
				void this.#options.store.saveAs(value).then(result => {
					this.#message = result.ok ? savedMessage(result, this.#options.cwd) : result.errors.join("; ");
					this.#options.tui.requestRender();
				});
			});
			return;
		}
		void this.#options.store.save().then(result => {
			this.#message = result.ok ? savedMessage(result, this.#options.cwd) : result.errors.join("; ");
			this.#options.tui.requestRender();
		});
	}

	#requestClose(): void {
		if (this.#options.store.dirty) {
			this.#modal = { kind: "close", index: 0 };
			return;
		}
		this.#close();
	}

	#close(): void {
		this.#preview = undefined;
		this.#sourceView = undefined;
		this.#dropModal();
		this.#done({ kind: "closed" });
	}

	// ------------------------------------------------------------------
	// Modal input
	// ------------------------------------------------------------------

	/** Scroll keys for the preview, the key sheet and the review; the renderer clamps the far end. */
	#scrolled(offset: number, key: string | undefined): number {
		const page = Math.max(1, layoutFor(this.#lastWidth, this.#options.tui.terminal.rows).bodyHeight - 4);
		switch (key) {
			case "j":
			case "down":
				return offset + 1;
			case "k":
			case "up":
				return Math.max(0, offset - 1);
			case "pageDown":
			case "space":
				return offset + page;
			case "pageUp":
				return Math.max(0, offset - page);
			case "g":
			case "home":
				return 0;
			case "G":
			case "end":
				return Number.MAX_SAFE_INTEGER;
			default:
				return offset;
		}
	}

	#handleModalInput(data: string, key: string | undefined): void {
		const modal = this.#modal;
		if (!modal) return;
		if (modal.kind === "edit") {
			if (key === "escape") {
				this.#dropModal();
				this.#message = "edit cancelled";
				this.#options.tui.requestRender();
				return;
			}
			modal.editor.handleInput(data);
			this.#options.tui.requestRender();
			return;
		}
		if (modal.kind === "text") {
			// The key sheet is read-only; only a request preview submits.
			if (key === "escape" || (!this.#preview && (key === "enter" || key === "q" || key === "?"))) {
				this.#modal = undefined;
				this.#preview = undefined;
				this.#options.tui.requestRender();
				return;
			}
			if (key === "enter") {
				this.#submitPreview();
				return;
			}
			if (key === "c" && this.#preview) {
				this.#options.ui.setEditorText(this.#preview.composed.prompt);
				this.#message = "copied the request into the prompt editor";
				this.#options.tui.requestRender();
				return;
			}
			if (key === "w" && this.#preview) {
				void this.#exportPrompt(resolvePath(this.#options.cwd, PROJECT_DIR, "prompt.md"));
				return;
			}
			modal.offset = this.#scrolled(modal.offset, key);
			this.#options.tui.requestRender();
			return;
		}
		if (modal.kind === "list") {
			if (key === "escape" || key === "q") {
				this.#modal = undefined;
				this.#options.tui.requestRender();
				return;
			}
			if (key === "j" || key === "down") modal.index = Math.min(modal.items.length - 1, modal.index + 1);
			if (key === "k" || key === "up") modal.index = Math.max(0, modal.index - 1);
			if ((key === "x" || key === "d") && modal.onDelete) {
				modal.onDelete(modal.index);
				this.#options.tui.requestRender();
				return;
			}
			if (key === "enter") {
				modal.onEnter(modal.index);
				this.#options.tui.requestRender();
				return;
			}
			this.#options.tui.requestRender();
			return;
		}
		if (modal.kind === "review") {
			if (key === "escape") {
				this.#modal = undefined;
				this.#options.tui.requestRender();
				return;
			}
			if (modal.error === undefined && (key === "enter" || key === "a")) {
				void this.#acceptReview(modal.requestId);
				return;
			}
			if (key === "r" || key === "d") {
				this.#rejectReview(modal.requestId);
				return;
			}
			modal.offset = this.#scrolled(modal.offset, key);
			this.#options.tui.requestRender();
			return;
		}
		if (modal.kind === "confirm") {
			if (key === "escape" || key === "n") {
				this.#modal = undefined;
				this.#options.tui.requestRender();
				return;
			}
			if (key === "enter" || key === "y") {
				const run = modal.onConfirm;
				this.#modal = undefined;
				run();
				this.#options.tui.requestRender();
				return;
			}
			return;
		}
		if (key === "j" || key === "down") modal.index = Math.min(2, modal.index + 1);
		if (key === "k" || key === "up") modal.index = Math.max(0, modal.index - 1);
		if (key === "escape") {
			this.#modal = undefined;
			this.#options.tui.requestRender();
			return;
		}
		if (key === "enter") {
			const choice = ["Save", "Discard", "Cancel"][modal.index]!;
			this.#modal = undefined;
			if (choice === "Cancel") {
				this.#options.tui.requestRender();
				return;
			}
			if (choice === "Discard") {
				this.#close();
				return;
			}
			void this.#options.store.save().then(result => {
				if (!result.ok) {
					this.#message = result.errors.join("; ");
					this.#options.tui.requestRender();
					return;
				}
				this.#close();
			});
			return;
		}
		this.#options.tui.requestRender();
	}

	async #exportPrompt(path: string): Promise<void> {
		const composed = this.#preview?.composed;
		if (!composed) return;
		try {
			await Bun.write(path, composed.prompt);
			this.#message = `exported ${displayPath(path, this.#options.cwd)}`;
		} catch (error) {
			this.#message = `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.#options.tui.requestRender();
	}

	// ------------------------------------------------------------------
	// Rendering
	// ------------------------------------------------------------------

	/**
	 * Tabs are expanded at this one boundary: widths count a tab as three
	 * columns, the terminal would jump to the next tab stop, and a cited file
	 * indented with tabs would otherwise shear the whole screen.
	 */
	render(width: number): readonly string[] {
		this.#lastWidth = width;
		const rows = this.#options.tui.terminal.rows;
		const layout = layoutFor(width, rows);
		if (layout.tooSmall) return this.#renderTooSmall(width, rows);
		const lines: string[] = [panelTop(this.#options.theme, width, this.#screenTitle())];
		lines.push(this.#renderBreadcrumb(width));
		const body = this.#modal || this.#sourceView ? this.#renderOverlayBody(width, layout) : this.#renderBody(width, layout);
		while (body.length < layout.bodyHeight) body.push(" ".repeat(width));
		lines.push(...body.slice(0, layout.bodyHeight));
		lines.push(this.#renderStatus(width));
		lines.push(panelBottom(this.#options.theme, width));
		while (lines.length < rows) lines.push(" ".repeat(width));
		return lines.slice(0, Math.max(1, rows)).map(line => (line.includes("\t") ? replaceTabs(line) : line));
	}

	#screenTitle(): string {
		const dirty = this.#options.store.dirty ? " *" : "";
		return `omp-visual-planner — ${this.#document.title}${dirty} · ${this.#document.purpose}`;
	}

	#renderTooSmall(width: number, rows: number): readonly string[] {
		const message = [
			`terminal is ${width}x${rows}`,
			`needs ${MIN_WIDTH}x${MIN_ROWS} to draw`,
			"",
			this.#options.store.dirty ? "[s] save as…   [x] discard and close" : "[Esc] close",
		];
		const lines: string[] = [panelTop(this.#options.theme, width, "omp-visual-planner")];
		for (let index = 0; index < Math.max(1, rows - 2); index += 1) lines.push(panelRow(this.#options.theme, message[index] ?? "", width));
		lines.push(panelBottom(this.#options.theme, width));
		return lines.slice(0, Math.max(1, rows));
	}

	/** Where you are: the outline follows the focused block, the map the diagram on screen. Keys live in the status line. */
	#renderBreadcrumb(width: number): string {
		const parts =
			this.#view === "outline"
				? this.#focusPath()
				: [
						this.#document.title,
						...this.#stack.slice(1).map(diagramId => findOwnedDiagram(this.#document.root, diagramId)?.owner.title ?? "?"),
					];
		const theme = this.#options.theme;
		const trail = parts.slice(0, -1).map(part => `${part} › `).join("");
		return truncateToWidth(` ${theme.fg("muted", trail)}${theme.bold(parts.at(-1) ?? "")}`, width, Ellipsis.Unicode, true);
	}

	/** Document title, ancestors and the focused block. */
	#focusPath(): string[] {
		const document = this.#document;
		const location = this.#selected === undefined ? undefined : findBlockLocation(document.root, this.#selected);
		if (!location) return [document.title];
		return [document.title, ...location.ancestors.map(block => block.title), location.block.title];
	}

	#renderBody(width: number, layout: Layout): string[] {
		if (this.#view === "outline") return this.#renderOutlineBody(width, layout);
		if (layout.stacked) {
			const inner = layout.canvasWidth;
			const lines = this.#pane === "inspector" ? this.#inspectorLines(inner, layout.bodyHeight) : this.#canvasLines(inner, layout.bodyHeight);
			return lines.map(line => panelRow(this.#options.theme, line, inner + 4));
		}
		const canvas = this.#canvasLines(layout.canvasWidth, layout.bodyHeight);
		const inspector = this.#inspectorLines(layout.inspectorWidth, layout.bodyHeight);
		const lines: string[] = [];
		for (let index = 0; index < layout.bodyHeight; index += 1) {
			lines.push(`│ ${pad(canvas[index] ?? "", layout.canvasWidth)}│ ${pad(inspector[index] ?? "", layout.inspectorWidth)}│`);
		}
		return lines;
	}

	/** Outline on the left, the focused block's page on the right; stacked terminals show one. */
	#renderOutlineBody(width: number, layout: Layout): string[] {
		const theme = this.#options.theme;
		const height = layout.bodyHeight;
		const inner = Math.max(0, width - 4);
		if (layout.stacked) {
			const lines = this.#pane === "inspector" ? this.#pageLines(inner, height) : this.#outlineLines(inner, height);
			return Array.from({ length: height }, (_, index) => panelRow(theme, lines[index] ?? "", width));
		}
		const outlineWidth = Math.min(48, Math.max(28, Math.floor(width * 0.38)));
		const pageWidth = Math.max(0, inner - outlineWidth - 3);
		const outline = this.#outlineLines(outlineWidth, height);
		const page = this.#pageLines(pageWidth, height);
		const separator = theme.fg("border", "│");
		return Array.from({ length: height }, (_, index) =>
			panelRow(theme, `${pad(outline[index] ?? "", outlineWidth)} ${separator} ${pad(page[index] ?? "", pageWidth)}`, width),
		);
	}

	#outlineLines(width: number, height: number): string[] {
		const theme = this.#options.theme;
		const document = this.#document;
		const purpose = document.purpose;
		const rows = outlineRows(document, this.#collapsed);
		if (rows.length === 0) {
			const copy =
				purpose === "brainstorm"
					? ["empty mind map", "o add an idea   a seed from a prompt"]
					: purpose === "explore"
						? ["nothing mapped yet", "a map a codebase"]
						: ["nothing planned yet", "o add a block   a draft or discover"];
			return ["", theme.fg("muted", ` ${copy[0]}`), "", ` ${copy[1]}`].map(line => truncateToWidth(line, width));
		}
		const focusIndex = rows.findIndex(row => row.block.id === this.#selected);
		if (focusIndex !== -1) {
			if (focusIndex < this.#outlineTop) this.#outlineTop = focusIndex;
			if (focusIndex >= this.#outlineTop + height) this.#outlineTop = focusIndex - height + 1;
		}
		this.#outlineTop = Math.max(0, Math.min(this.#outlineTop, Math.max(0, rows.length - height)));
		const pending = this.#options.registry.pending();
		const pendingBlock = pending?.scope.kind === "block" ? pending.scope.id : undefined;
		const lines: string[] = [];
		for (const row of rows.slice(this.#outlineTop, this.#outlineTop + height)) {
			const block = row.block;
			const focused = block.id === this.#selected;
			const twisty = row.hasChildren ? (row.collapsed ? "▸" : "▾") : " ";
			const glyph = statusGlyph(purpose, block.status);
			// Evidence is marked only where it tells you something: in an exploration every
			// block should be cited, so the uncited ones are dimmed instead of the rest starred.
			const uncited = purpose === "explore" && block.evidence !== "observed";
			const badge =
				purpose === "brainstorm"
					? ""
					: block.evidence === "unknown"
						? theme.fg("warning", " ?")
						: block.evidence === "observed" && purpose === "plan"
							? theme.fg("success", " *")
							: "";
			const marker =
				pending && pendingBlock === block.id
					? pending.state === "staged"
						? theme.fg("accent", " ◆ review")
						: theme.fg("accent", ` ${spinnerFrame()} working`)
					: "";
			const title = block.title.length > 0 ? block.title : "(untitled)";
			const name = focused ? theme.bold(title) : uncited ? theme.fg("muted", title) : title;
			const prefix = focused ? theme.fg("accent", "›") : " ";
			const text = truncateToWidth(`${prefix} ${"  ".repeat(row.depth)}${twisty} ${glyph}${glyph ? " " : ""}${name}${badge}${marker}`, width, Ellipsis.Unicode);
			lines.push(focused ? theme.bg("selectedBg", pad(text, width)) : text);
		}
		return lines;
	}

	/**
	 * A block body for the page: prose wraps, fenced code keeps its lines
	 * (truncated, never wrapped) behind a muted gutter with the language on the
	 * fence. At most `limit` lines; the rest is a muted "… E opens it all".
	 */
	#markdownLines(text: string, width: number, limit: number): string[] {
		const theme = this.#options.theme;
		const out: string[] = [];
		let fence: string | undefined;
		let fenceLang = "";
		let fenced: string[] = [];
		let prose: string[] = [];
		const flush = () => {
			if (prose.length > 0) out.push(...wrapTextWithAnsi(prose.join("\n"), Math.max(1, width)));
			prose = [];
		};
		const flushFence = () => {
			const highlighted = highlightCode(fenced.join("\n"), fenceLang || undefined, theme);
			for (const line of highlighted) {
				out.push(`${theme.fg("muted", "│")} ${truncateToWidth(line, Math.max(1, width - 2))}`);
			}
			fenced = [];
		};
		for (const line of text.split("\n")) {
			const opener = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
			if (fence === undefined && opener) {
				flush();
				fence = opener[1];
				fenceLang = opener[2] ?? "";
				out.push(theme.fg("muted", `┌ ${fenceLang || "code"}`));
			} else if (fence !== undefined && line.trim().startsWith(fence)) {
				flushFence();
				fence = undefined;
				fenceLang = "";
				out.push(theme.fg("muted", "└"));
			} else if (fence !== undefined) {
				fenced.push(line.replaceAll("\t", "  "));
			} else {
				prose.push(line);
			}
		}
		if (fence !== undefined) flushFence();
		flush();
		if (out.length <= limit) return out;
		return [...out.slice(0, limit - 1), theme.fg("muted", `… ${out.length - limit + 1} more lines — E opens it all`)];
	}

	/**
	 * The focused block's page. Browsing the outline shows only what is written;
	 * Enter opens every field with a cursor. Brainstorm ideas and unexplored
	 * blocks browse as a walk instead, and open the same editable page.
	 */
	#pageLines(width: number, height: number): string[] {
		const theme = this.#options.theme;
		const document = this.#document;
		const purpose = document.purpose;
		const block = this.#block;
		const editing = this.#pane === "inspector";
		if (!editing && this.#walking(block)) return this.#walkLines(width, height);
		const muted = (text: string): string => theme.fg("muted", text);
		const lines: string[] = [];
		if (!block) {
			lines.push(`  ${theme.bold(document.title)}`, `  ${muted(`${purpose} · ${progressLabel(document)}`)}`);
			if (document.goal.trim().length > 0) {
				lines.push("", `  ${muted("goal")}`, ...wrapTextWithAnsi(document.goal.trim(), Math.max(1, width - 4)).slice(0, 6).map(line => `    ${line}`));
			}
			const actions = projectActions(purpose).map(action => action.label.toLowerCase());
			lines.push("", ...wrapTextWithAnsi(muted(`a  ${actions.join(" · ")}`), Math.max(1, width - 2)).map(line => `  ${line}`));
			return this.#withFooter(lines, this.#stepLines(undefined, width), width, height, 0);
		}
		const fields = this.#fields;
		const current = editing ? fields[Math.min(this.#fieldIndex, Math.max(0, fields.length - 1))] : undefined;
		let focusLine = 0;
		const cursor = (focused: boolean): string => {
			if (focused) focusLine = lines.length;
			return focused ? `${theme.fg("accent", "›")} ` : "  ";
		};
		const status = statusLabel(purpose, block.status);
		const badge = status === undefined ? "" : `  ${theme.fg("accent", `${statusGlyph(purpose, block.status)} ${status}`)}`;
		lines.push(`${cursor(current === "title")}${theme.bold(block.title.length > 0 ? block.title : "(untitled)")}${badge}`);
		if (!editing && purpose !== "brainstorm") {
			const meta = [`${muted("evidence")} ${block.evidence}`];
			if (purpose === "plan") meta.push(`${muted("venue")} ${venueOf(block)}`);
			lines.push(`  ${meta.join("   ")}`);
		}
		lines.push("");
		const missing: string[] = [];
		for (const field of pageFields(purpose)) {
			if (field === "title" || (!editing && (field === "evidence" || field === "venue"))) continue;
			const name = fieldLabel(purpose, field);
			if (field === "sources") {
				if (block.sources.length === 0 && !editing) continue;
				lines.push(`  ${muted(name)}`);
				block.sources.forEach((source, index) => lines.push(`${cursor(current === `source:${index}`)}  ${formatSourceRef(source)}`));
				if (editing) lines.push(`${cursor(current === "source:add")}  ${muted("+ add a reference")}`);
				continue;
			}
			const body = this.#fieldBody(block, field, Math.max(1, width - 4));
			if (body.length === 0 && !editing) {
				if (purpose === "plan" && (field === "description" || field === "expectedOutput" || field === "criteria")) missing.push(name);
				continue;
			}
			lines.push(`${cursor(current === field)}${muted(name)}`);
			lines.push(...(body.length > 0 ? body : [muted("—")]).map(line => `    ${line}`));
		}
		if (missing.length > 0) lines.push("", `  ${muted(`not written yet: ${missing.join(" · ")}`)}`);
		lines.push(...this.#neighbourLines(block, false));
		return this.#withFooter(lines, this.#stepLines(block, width), width, height, focusLine);
	}

	/** A field's value as page lines; none when it is empty. */
	#fieldBody(block: Block, field: PageField, width: number): string[] {
		const theme = this.#options.theme;
		const wrap = (text: string, max: number): string[] => (text.trim().length === 0 ? [] : wrapTextWithAnsi(text.trim(), width).slice(0, max));
		const choices = (values: readonly string[], chosen: string): string[] => [
			values.map(value => (value === chosen ? theme.fg("accent", `[${value}]`) : theme.fg("muted", value))).join("  "),
		];
		switch (field) {
			case "description":
				return block.description.trim().length === 0 ? [] : this.#markdownLines(block.description.trim(), width, 16);
			case "expectedOutput":
				return wrap(block.expectedOutput, 6);
			case "criteria":
				return block.acceptanceCriteria.flatMap(criterion => wrapTextWithAnsi(`• ${criterion}`, width));
			case "evidence":
				return choices(EVIDENCE_VALUES, block.evidence);
			case "venue":
				return choices(VENUES, venueOf(block));
			case "enhance":
				return wrap(block.actions.enhance, 3);
			case "execute":
				return wrap(block.actions.execute, 3);
			default:
				return [];
		}
	}

	/** A block's first citation for one line: `path:10-40 +2`, or why there is none. */
	#citeLabel(block: Block): string {
		const source = block.sources[0];
		if (source) return formatSourceRef(source) + (block.sources.length > 1 ? ` +${block.sources.length - 1}` : "");
		return this.#document.purpose === "explore" ? `not cited · ${block.evidence}` : "";
	}

	/** What is inside the block and what it is linked to; grounded mode drops uncited blocks. */
	#neighbourLines(block: Block, cite: boolean): string[] {
		const theme = this.#options.theme;
		const purpose = this.#document.purpose;
		const muted = (text: string): string => theme.fg("muted", text);
		const shown = (candidate: Block): boolean => !this.#grounded || candidate.evidence === "observed";
		const name = (candidate: Block): string => {
			const title = candidate.title.length > 0 ? candidate.title : "(untitled)";
			const glyph = statusGlyph(purpose, candidate.status);
			const reference = cite ? this.#citeLabel(candidate) : "";
			const text = purpose === "explore" && candidate.evidence !== "observed" ? muted(title) : title;
			return `${glyph.length > 0 ? `${glyph} ` : ""}${text}${reference.length > 0 ? `  ${muted(reference)}` : ""}`;
		};
		const lines: string[] = [];
		const inside = (block.children?.blocks ?? []).filter(shown);
		if (inside.length > 0) {
			lines.push("", `  ${muted(`inside (${inside.length})`)}`, ...inside.slice(0, 12).map(child => `    ${name(child)}`));
			if (inside.length > 12) lines.push(`    ${muted(`… ${inside.length - 12} more`)}`);
		}
		const linked = this.#diagram.edges.flatMap(edge => {
			const inbound = edge.to === block.id;
			const otherId = edge.from === block.id ? edge.to : inbound ? edge.from : undefined;
			const other = otherId === undefined ? undefined : this.#diagram.blocks.find(candidate => candidate.id === otherId);
			if (!other || !shown(other)) return [];
			return [`    ${inbound ? "←" : "→"} ${name(other)}${edge.label.length > 0 ? muted(` · ${edge.label}`) : ""}`];
		});
		if (linked.length > 0) lines.push("", `  ${muted("linked")}`, ...linked);
		return lines;
	}

	/** The one next step for the focused block, pinned under both the page and the walk. */
	#stepLines(block: Block | undefined, width: number): string[] {
		const theme = this.#options.theme;
		const step = nextStep(this.#document, block);
		return wrapTextWithAnsi(`${theme.fg("accent", `→ ${step.label}`)}  ${theme.fg("muted", step.detail)}`, Math.max(1, width)).slice(0, 2);
	}

	/**
	 * Pin `footer` to the bottom of a pane; the body scrolls so `focusLine` stays
	 * on screen. Sections open with a blank line whether or not the one before
	 * them rendered, so runs of blanks collapse to one here.
	 */
	#withFooter(lines: string[], footer: string[], width: number, height: number, focusLine: number): string[] {
		const body: string[] = [];
		let focus = focusLine;
		lines.forEach((line, index) => {
			if (line.length === 0 && (body.length === 0 || body.at(-1)!.length === 0)) {
				if (index < focusLine) focus -= 1;
				return;
			}
			body.push(line);
		});
		const room = Math.max(1, height - footer.length - 1);
		const start = focus >= room ? focus - room + 1 : 0;
		const visible = body.slice(start, start + room);
		while (visible.length < room) visible.push("");
		return [...visible, "", ...footer].slice(0, height).map(line => truncateToWidth(line, width, Ellipsis.Unicode));
	}

	#walking(block: Block | undefined): boolean {
		const purpose = this.#document.purpose;
		if (purpose === "brainstorm") return true;
		return purpose === "explore" && (block === undefined || block.status === "open");
	}

	/** The walk: the focused block, its citation and note, then what is inside and linked. */
	#walkLines(width: number, height: number): string[] {
		const theme = this.#options.theme;
		const document = this.#document;
		const purpose = document.purpose;
		const block = this.#block;
		const muted = (text: string): string => theme.fg("muted", text);
		const lines: string[] = [];
		if (!block) {
			lines.push(`  ${theme.bold(document.title)}`);
			if (document.goal.trim().length > 0) lines.push(...wrapTextWithAnsi(muted(document.goal.trim()), Math.max(1, width - 2)).slice(0, 4).map(line => `  ${line}`));
			lines.push("", `  ${muted(purpose === "brainstorm" ? "o dumps an idea; j moves onto one" : "j moves onto the first block")}`);
			return this.#withFooter(lines, this.#stepLines(undefined, width), width, height, 0);
		}
		const status = statusLabel(purpose, block.status);
		const badge = status === undefined ? "" : `  ${theme.fg("accent", `${statusGlyph(purpose, block.status)} ${status}`)}`;
		lines.push(`  ${theme.bold(block.title.length > 0 ? block.title : "(untitled)")}${badge}`);
		const reference = this.#citeLabel(block);
		if (reference.length > 0) lines.push(`  ${theme.fg(block.sources.length > 0 ? "accent" : "muted", reference)}`);
		lines.push(...this.#citationLines(block, Math.max(12, width - 2)).map(line => `  ${line}`));
		if (block.description.trim().length > 0) {
			lines.push("", ...this.#markdownLines(block.description.trim(), Math.max(1, width - 2), 6).map(line => `  ${line}`));
		}
		lines.push(...this.#neighbourLines(block, purpose === "explore"));
		if (purpose === "brainstorm" && (block.children?.blocks.length ?? 0) === 0) {
			lines.push("", `  ${muted("nothing inside yet — O dumps a line onto it")}`);
		}
		return this.#withFooter(lines, this.#stepLines(block, width), width, height, 0);
	}

	#canvasLines(width: number, height: number): string[] {
		const grid = new Grid(width, height);
		const diagram = this.#diagram;
		if (diagram.blocks.length === 0) {
			const empty = ["No blocks in this subsystem yet.", "", "[o] add a block      [a] draft from prompt"];
			const top = Math.max(0, Math.floor(height / 2) - 1);
			for (let index = 0; index < empty.length; index += 1) {
				const text = empty[index]!;
				grid.put(Math.max(0, Math.floor((width - visibleWidth(text)) / 2)), top + index, text, index === 0 ? "muted" : "title");
			}
		} else {
			const { left, top } = this.#viewport;
			const labels: { edge: Edge; route: EdgeRoute; selected: boolean }[] = [];
			for (const edge of diagram.edges) {
				const from = diagram.blocks.find(block => block.id === edge.from);
				const to = diagram.blocks.find(block => block.id === edge.to);
				if (!from || !to) continue;
				const selected = edge.id === this.#selectedEdge;
				const route = routeEdge(cardRect(from), cardRect(to), {
					fromPort: edge.fromPort,
					toPort: edge.toPort,
					routing: edge.routing,
				});
				this.#drawRoute(grid, route, left, top, selected);
				labels.push({ edge, route, selected });
			}
			for (const block of diagram.blocks) {
				const linkCandidate = this.#linkFrom !== undefined && block.id === this.#linkTarget;
				this.#drawCard(grid, block, left, top, block.id === this.#selected, linkCandidate);
			}
			// Labels go on after the cards, into free cells only: a relationship
			// label may never cover a card, and is simply omitted when the cards
			// leave no room.
			for (const { edge, route, selected } of labels) {
				if (edge.label.length === 0) continue;
				const anchor = route.points[Math.max(1, Math.floor(route.points.length / 2) - 1)] ?? route.points[0]!;
				const style: StyleKey = selected ? "edgeSelected" : "edge";
				const text = ` ${edge.label} `;
				const placed =
					grid.putFitting(anchor.x - left + 1, anchor.y - top, text, style, 0, width) ||
					grid.putFitting(anchor.x - left + 1, anchor.y - top - 1, text, style, 0, width) ||
					grid.putFitting(anchor.x - left + 1, anchor.y - top + 1, text, style, 0, width);
				void placed;
			}
		}
		const lines: string[] = [];
		for (let index = 0; index < height; index += 1) lines.push(grid.line(index, this.#options.theme));
		return lines;
	}

	#drawRoute(grid: Grid, route: EdgeRoute, left: number, top: number, selected: boolean): void {
		const style: StyleKey = selected ? "lineSelected" : "line";
		const box: Record<string, string> = this.#options.theme.boxSharp as unknown as Record<string, string>;
		for (let index = 0; index < route.points.length - 1; index += 1) {
			const a = route.points[index]!;
			const b = route.points[index + 1]!;
			const dx = Math.sign(b.x - a.x);
			const dy = Math.sign(b.y - a.y);
			if (dx === 0 && dy === 0) continue;
			const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
			for (let step = 1; step <= steps; step += 1) {
				const glyph = dx !== 0 ? box.horizontal : box.vertical;
				grid.put(a.x + dx * step - left, a.y + dy * step - top, glyph ?? (dx !== 0 ? "-" : "|"), style);
			}
		}
		for (let index = 1; index < route.points.length - 1; index += 1) {
			const previous = route.points[index - 1]!;
			const current = route.points[index]!;
			const next = route.points[index + 1]!;
			const name = cornerName(
				{ dx: Math.sign(current.x - previous.x), dy: Math.sign(current.y - previous.y) },
				{ dx: Math.sign(next.x - current.x), dy: Math.sign(next.y - current.y) },
			);
			const glyph = name === undefined ? undefined : box[name];
			if (glyph !== undefined) grid.put(current.x - left, current.y - top, glyph, style);
		}
		const entry = route.points[route.points.length - 1]!;
		grid.put(entry.x - left, entry.y - top, route.arrow, selected ? "edgeSelected" : "edge");
	}

	#drawCard(grid: Grid, block: Block, left: number, top: number, selected: boolean, linkCandidate: boolean): void {
		const rect = cardRect(block);
		const box = this.#options.theme.boxSharp;
		const border: StyleKey = selected || linkCandidate ? "borderSelected" : "border";
		const x = rect.x - left;
		const y = rect.y - top;
		grid.put(x, y, box.topLeft + box.horizontal.repeat(Math.max(0, rect.w - 2)) + box.topRight, border);
		grid.put(x, y + 1, box.vertical, border);
		grid.put(x, y + 2, box.vertical, border);
		grid.put(x, y + 3, box.bottomLeft + box.horizontal.repeat(Math.max(0, rect.w - 2)) + box.bottomRight, border);
		// Status sits on the top border; evidence and "has inside" use the right padding cell,
		// so the title keeps the full width `cardWidth` reserved for it.
		const glyph = statusGlyph(this.#document.purpose, block.status);
		if (glyph.length > 0) grid.put(x + 1, y, glyph, border);
		const badge = block.evidence === "unknown" ? "?" : block.evidence === "observed" ? "*" : "";
		const badgeStyle: StyleKey = block.evidence === "unknown" ? "unknown" : block.evidence === "observed" ? "observed" : "plain";
		const title = truncateToWidth(block.title.length > 0 ? block.title : "(untitled)", Math.max(0, rect.w - 4));
		grid.put(x + 2, y + 1, title, selected ? "titleSelected" : "title");
		if (badge.length > 0) grid.put(x + rect.w - 2, y + 1, badge, badgeStyle);
		const description = truncateToWidth(block.description.replace(/\s+/g, " ").trim(), Math.max(0, rect.w - 4));
		grid.put(x + 2, y + 2, description, selected ? "mutedSelected" : "muted");
		if (block.children && block.children.blocks.length > 0) {
			grid.put(x + rect.w - 2, y + 2, "▸", selected ? "borderSelected" : "muted");
		}
	}

	/** The map's side panel: the same page the outline shows for a block, or a relationship's own fields. */
	#inspectorLines(width: number, height: number): string[] {
		const edge = this.#edge;
		if (!edge) {
			if (this.#block) return this.#pageLines(width, height);
			return [this.#options.theme.fg("muted", "nothing selected")];
		}
		const theme = this.#options.theme;
		const fields = this.#fields;
		const index = Math.min(this.#fieldIndex, Math.max(0, fields.length - 1));
		const name = (id: string): string => this.#diagram.blocks.find(block => block.id === id)?.title || id;
		const values: Record<string, [string, string]> = {
			"edge:label": ["label", edge.label.length > 0 ? edge.label : "—"],
			"edge:direction": ["direction", edge.direction],
			"edge:routing": ["routing", edge.routing],
			"edge:fromPort": ["from port", edge.fromPort],
			"edge:toPort": ["to port", edge.toPort],
		};
		const lines = [theme.bold(`${name(edge.from)} → ${name(edge.to)}`), theme.fg("muted", "relationship"), ""];
		fields.forEach((field, fieldIndex) => {
			const [label, value] = values[field] ?? [field, ""];
			const focused = this.#pane === "inspector" && fieldIndex === index;
			lines.push(`${focused ? theme.fg("accent", "›") : " "} ${theme.fg("muted", `${label}:`)} ${value}`);
		});
		return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode)).slice(0, height);
	}

	/**
	 * One status line: where you are, what the agent is doing, then the last
	 * message — or, when there is none, the keys that work right now.
	 */
	#renderStatus(width: number): string {
		const theme = this.#options.theme;
		const document = this.#document;
		const segments: string[] = [];
		if (this.#view === "outline") {
			if (this.#pane === "canvas" && this.#walking(this.#block)) segments.push(this.#grounded ? "walk · grounded" : "walk");
			segments.push(progressLabel(document));
		} else {
			const blocks = this.#diagram.blocks;
			const unknown = blocks.filter(block => block.evidence === "unknown").length;
			segments.push(`map · ${blocks.length} block${blocks.length === 1 ? "" : "s"}${unknown > 0 ? ` · ${unknown} unknown` : ""}`);
		}
		if (this.#stagedEntry()) segments.push(theme.fg("accent", "◆ proposal ready — R reviews"));
		const working = this.#working();
		if (working) segments.push(theme.fg("accent", `${spinnerFrame()} agent working ${elapsedClock(working.createdAt)}`));
		const tail = this.#message.length > 0 ? this.#message : theme.fg("muted", this.#keyHints());
		return truncateToWidth(` ${segments.join("  ")}   ${tail}`, width, Ellipsis.Unicode, true);
	}

	/** The keys that do something in the current context, most useful first; `?` lists the rest. */
	#keyHints(): string {
		// A dialog pins its own keys at its foot.
		if (this.#modal) return "";
		if (this.#sourceView) return "j/k scroll  PgUp/PgDn page  g/G ends  Esc back";
		if (this.#linkFrom !== undefined) return "arrows or Tab pick the target  Enter links  Esc cancels";
		const purpose = this.#document.purpose;
		if (this.#view === "canvas") {
			return this.#pane === "inspector"
				? "? keys  j/k field  Enter edit  i back to the map"
				: "? keys  arrows select  Enter inside  Backspace up  H/J/K/L move  o add  e link  i inspect  v outline";
		}
		if (this.#pane === "inspector") return "? keys  j/k field  Enter edit  E whole block in $EDITOR  Esc back";
		const block = this.#block;
		// Most specific first: the status line is cut from the right on narrow terminals.
		const hints = ["? keys"];
		if (this.#walking(block) && block?.sources[0]) hints.push("Enter source  i edit");
		else hints.push("Enter edit");
		if (purpose === "brainstorm") hints.push("O dump a line");
		if (purpose === "plan") hints.push("space status");
		if (purpose === "explore") hints.push("space explored", `g ${this.#grounded ? "all claims" : "grounded"}`);
		hints.push(...verbsFor(purpose).map(verb => `${verb.key} ${verb.label.toLowerCase()}`));
		if (purpose !== "brainstorm") hints.push("o/O add");
		hints.push("v map");
		return hints.join("  ");
	}

	#renderOverlayBody(width: number, layout: Layout): string[] {
		const height = layout.bodyHeight;
		const theme = this.#options.theme;
		// The page stays visible behind a dialog, dimmed, so you still see where you are
		// without mistaking it for part of the dialog.
		const lines = this.#renderBody(width, layout).map(line => theme.fg("dim", stripTerminalSequences(line)));
		while (lines.length < height) lines.push(" ".repeat(width));
		const modal = this.#modal;
		let boxWidth = Math.min(width, 100);
		let title = "";
		let content: string[] = [];
		let footer: string | undefined;
		/** The slice of `all` that fits above the footer, starting at `offset` clamped to the end. */
		const scroll = (all: string[], offset: number): { lines: string[]; offset: number } => {
			const room = Math.max(1, Math.min(height, 100) - 2 - (footer === undefined ? 0 : 2));
			const start = Math.min(offset, Math.max(0, all.length - room));
			return { lines: all.slice(start, start + room), offset: start };
		};

		if (this.#sourceView && !modal) {
			boxWidth = width;
			const view = this.#sourceView;
			if (view.error) {
				title = `source: ${view.title}`;
				content = wrapTextWithAnsi(view.error, Math.max(10, boxWidth - 4)).map(line => theme.fg("error", line));
			} else {
				const visible = Math.max(1, Math.min(height, 100) - 2);
				view.offset = Math.min(view.offset, Math.max(0, view.lines.length - visible));
				const last = Math.min(view.lines.length, view.offset + visible);
				title = `source: ${view.title} · ${view.offset + 1}-${last}/${view.lines.length}`;
				const code = view.lines.slice(view.offset, last).join("\n");
				content = renderSourceLines(theme, code, view.path ?? view.source.path, view.offset + 1, Math.max(10, boxWidth - 4));
			}
		} else if (modal?.kind === "edit") {
			title = modal.title;
			content = [...modal.editor.render(Math.max(10, boxWidth - 4))];
		} else if (modal?.kind === "text") {
			boxWidth = Math.min(width, 110);
			title = modal.title;
			footer = this.#preview
				? "Enter submit  c copy to the prompt editor  w export markdown  j/k PgUp/PgDn scroll  Esc back"
				: "j/k scroll  Esc close";
			const wrapped = modal.lines.flatMap(line => (line.length === 0 ? [""] : wrapTextWithAnsi(line, Math.max(10, boxWidth - 4))));
			const shown = scroll(wrapped, modal.offset);
			modal.offset = shown.offset;
			content = shown.lines;
		} else if (modal?.kind === "list") {
			title = modal.title;
			footer = modal.footer;
			content = modal.items.map((item, index) => theme.fg(index === modal.index ? "accent" : "text", `${index === modal.index ? "›" : " "} ${item}`));
		} else if (modal?.kind === "review") {
			boxWidth = Math.min(width, 110);
			title = "review proposal";
			footer =
				modal.error === undefined
					? "Enter accept  r reject  j/k scroll  Esc later — an accepted proposal stays unsaved until s"
					: "r reject  Esc later";
			const shown = scroll(this.#diffLines(modal, Math.max(10, boxWidth - 4)), modal.offset);
			modal.offset = shown.offset;
			content = shown.lines;
		} else if (modal?.kind === "confirm") {
			title = modal.title;
			footer = `Enter ${modal.confirmLabel}  Esc cancel`;
			content = wrapTextWithAnsi(modal.message, Math.max(10, boxWidth - 4));
		} else if (modal?.kind === "close") {
			title = "unsaved changes";
			footer = "j/k choose  Enter confirm  Esc cancel";
			content = [
				"The authored document has unsaved changes.",
				"",
				...["Save", "Discard", "Cancel"].map((choice, index) =>
					theme.fg(index === modal.index ? "accent" : "text", `${index === modal.index ? "›" : " "} ${choice}`),
				),
			];
		}

		const body = footer === undefined ? content : [...content, "", theme.fg("muted", footer)];
		const boxHeight = Math.max(3, Math.min(height, body.length + 2, 100));
		const top = Math.max(0, Math.floor((height - boxHeight) / 2));
		const left = Math.max(0, Math.floor((width - boxWidth) / 2));
		const box: string[] = [panelTop(theme, boxWidth, title, "borderAccent")];
		for (let index = 0; index < boxHeight - 2; index += 1) box.push(panelRow(theme, body[index] ?? "", boxWidth));
		box.push(panelBottom(theme, boxWidth));
		for (let index = 0; index < box.length; index += 1) {
			const row = top + index;
			if (row >= lines.length) break;
			const line = lines[row] ?? "";
			const before = sliceByColumn(line, 0, left, true);
			const afterStart = left + boxWidth;
			const after = sliceByColumn(line, afterStart, Math.max(0, width - afterStart), true);
			lines[row] = `${before}${box[index]}${after}`;
		}
		return lines.slice(0, height);
	}

	/** The review: what the proposal rewrites, adds and removes, with the text before and after. */
	#diffLines(modal: ReviewModal, width: number): string[] {
		const theme = this.#options.theme;
		const purpose = this.#document.purpose;
		const muted = (text: string): string => theme.fg("muted", text);
		const lines: string[] = [theme.bold(modal.entry.label)];
		const summary = modal.entry.proposal?.summary ?? "";
		if (summary.length > 0) lines.push(...wrapTextWithAnsi(summary, width));
		lines.push("");
		if (modal.error) return [...lines, ...wrapTextWithAnsi(theme.fg("error", modal.error), width)];
		const diff = modal.diff;
		if (diffIsEmpty(diff)) return [...lines, muted("no change: the proposal matches the document")];
		const where = (path: string): string => (path === "root" ? "" : muted(`  in ${path.replace(/^root > /, "").replaceAll(" > ", " › ")}`));
		/** Lines only before are removed, lines only after are added; unchanged lines are counted, not repeated. */
		const change = (label: string, from: string, to: string): string[] => {
			const before = from.split("\n").filter(line => line.trim().length > 0);
			const after = to.split("\n").filter(line => line.trim().length > 0);
			const wrap = (sign: string, line: string): string[] => wrapTextWithAnsi(`${sign} ${line}`, Math.max(10, width - 6)).map(part => `      ${part}`);
			const out = [`    ${muted(label)}`];
			for (const line of before.filter(line => !after.includes(line))) out.push(...wrap("-", line).map(part => theme.fg("error", part)));
			for (const line of after.filter(line => !before.includes(line))) out.push(...wrap("+", line).map(part => theme.fg("success", part)));
			const kept = after.filter(line => before.includes(line)).length;
			if (kept > 0) out.push(`      ${muted(`${kept} unchanged`)}`);
			if (before.length === 0) out.splice(1, 0, `      ${muted("was empty")}`);
			if (after.length === 0) out.push(`      ${muted("now empty")}`);
			return out;
		};
		const labels: Record<DiffField, string> = {
			title: "title",
			description: fieldLabel(purpose, "description"),
			expectedOutput: fieldLabel(purpose, "expectedOutput"),
			acceptanceCriteria: fieldLabel(purpose, "criteria"),
			sources: fieldLabel(purpose, "sources"),
			evidence: "evidence",
			actions: "agent notes",
			position: "position on the map",
		};
		if (diff.titleChanged || diff.goalChanged) {
			lines.push(theme.bold("document"));
			if (diff.titleChanged) lines.push(...change("title", diff.titleChanged.from, diff.titleChanged.to));
			if (diff.goalChanged) lines.push(...change("goal", diff.goalChanged.from, diff.goalChanged.to));
			lines.push("");
		}
		for (const entry of diff.modified) {
			lines.push(`${theme.fg("warning", "~")} ${theme.bold(entry.title)}${where(entry.path)}`);
			for (const item of entry.changes) lines.push(...change(labels[item.field], item.from, item.to));
			lines.push("");
		}
		if (diff.added.length > 0) {
			lines.push(theme.bold(`added (${diff.added.length})`), ...diff.added.map(entry => `  ${theme.fg("success", `+ ${entry.title}`)}${where(entry.path)}`), "");
		}
		if (diff.removed.length > 0) {
			lines.push(theme.bold(`removed (${diff.removed.length})`), ...diff.removed.map(entry => `  ${theme.fg("error", `- ${entry.title}`)}${where(entry.path)}`), "");
		}
		const links = [
			...diff.edgesAdded.map(edge => theme.fg("success", `+ ${edge}`)),
			...diff.edgesRemoved.map(edge => theme.fg("error", `- ${edge}`)),
			...diff.edgesModified.map(edge => theme.fg("warning", `~ ${edge}`)),
		];
		if (links.length > 0) lines.push(theme.bold("links"), ...links.map(line => `  ${line}`), "");
		while (lines.at(-1) === "") lines.pop();
		return lines.map(line => truncateToWidth(line, width));
	}
}

/** Save confirmation, saying when an existing file was replaced. */
export function savedMessage(result: { path: string; replaced?: boolean }, cwd: string): string {
	const target = displayPath(result.path, cwd);
	return result.replaced === true ? `saved ${target} (replaced the existing file)` : `saved ${target}`;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** A spinner frame from the wall clock, so every redraw advances it without state. */
function spinnerFrame(now = Date.now()): string {
	return SPINNER[Math.floor(now / 1000) % SPINNER.length]!;
}

/** `m:ss` since an ISO timestamp. */
function elapsedClock(since: string, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function pad(text: string, width: number): string {
	const clipped = truncateToWidth(text, width);
	const remaining = width - visibleWidth(clipped);
	return remaining > 0 ? clipped + " ".repeat(remaining) : clipped;
}
