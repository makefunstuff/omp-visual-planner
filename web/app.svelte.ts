/**
 * The page's state and every action it takes. The server owns the document and
 * the session; this module owns only what is this tab's own: which surface is on
 * screen, marks, the open dialog, the file viewer, the map's pan and zoom.
 */
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import type { IntelOutcome } from "../src/code-intel.ts";
import type { SourceInsight } from "../src/code-evidence.ts";
import { FOCUS_CENTER, type FocusCursor, type FocusNeighborhood, focusNeighborhood, normalizeFocusCursor } from "../src/focus.ts";
import type { Span } from "../src/highlight.ts";
import type { OutlineTreeRow } from "../src/intel-view.ts";
import type { Block, SourceRef } from "../src/model.ts";
import type { WebPreview, WebState, WebSymbolView } from "../src/web.ts";
import { currentDiagram, findBlock, rectOf, selectedBlock, usersCut } from "./doc.ts";

export type Surface = "page" | "map" | "screens";

export interface Preview extends WebPreview {
	verb: string;
	id?: string;
	ids?: string[];
	batch?: boolean;
}

export interface TextDialog {
	title: string;
	placeholder: string;
	hint: string;
}

export type Modal =
	| { kind: "confirm"; text: string; yes: string; onYes: () => void; back: Modal | null }
	| { kind: "preview"; preview: Preview }
	| ({ kind: "text"; onSubmit: (text: string) => void } & TextDialog)
	| { kind: "mockup"; html: string }
	| { kind: "keys" }
	| { kind: "drift" }
	| { kind: "uses"; id: string }
	| { kind: "extract"; id: string };

export type Intel =
	| { mode: "outline"; title: string; loading: true }
	| { mode: "symbol"; title: string; loading: true }
	| { mode: "outline"; title: string; loading: false; data: IntelOutcome<unknown> & { view?: OutlineTreeRow[] } }
	| { mode: "symbol"; title: string; loading: false; data: IntelOutcome<unknown> & { view?: WebSymbolView } };

export interface Viewer {
	path: string;
	lines: string[];
	tokens: Span[][] | null;
	truncated: boolean;
	/** A line to scroll to once, then cleared. */
	line: number | null;
	selection: { a: number; b: number } | null;
	wide: boolean;
	intel: Intel | null;
}

export type Insight = (SourceInsight & { summary?: string; error?: undefined }) | { error: string };

export interface MapView {
	x: number;
	y: number;
	k: number;
}

export const app = $state({
	state: null as WebState | null,
	message: "",
	messageIsError: false,
	offline: false,
	inFlight: 0,
	inFlightWord: "",
	surface: "page" as Surface,
	grounded: false,
	purposeOpen: false,
	newPurpose: "plan",
	selectedEdge: null as string | null,
	editTitleOf: null as string | null,
	editBodyOf: null as string | null,
	centerOn: null as string | null,
	reviewIndex: 0,
	modal: null as Modal | null,
	filesOpen: null as boolean | null,
	files: null as string[] | null,
	filesTruncated: false,
	filesFilter: "",
	viewer: null as Viewer | null,
	/** The walk's highlight, for the block it was moved on. */
	focusCursor: { for: undefined as string | undefined, ...FOCUS_CENTER },
	/** A tick for spinners and elapsed clocks. */
	now: Date.now(),
});

/** Blocks picked for a parallel batch: this page's own, not saved, not shared with the terminal. */
export const marked = new SvelteSet<string>();
export const openDirs = new SvelteSet<string>([""]);
/** Tree-sitter answers for `path:line`, fetched once each. */
export const insights = new SvelteMap<string, Insight>();
/** diagram id -> map pan and zoom; not document content. */
const views: Record<string, MapView> = $state({});

setInterval(() => (app.now = Date.now()), 100);

/** The loaded state; components below the App gate only render once it exists. */
export function st(): WebState {
	return app.state!;
}

// ---------------------------------------------------------------- server

const BUSY_WORDS: Record<string, string> = {
	save: "saving",
	submit: "sending to the agent",
	accept: "applying",
	preview: "composing and ranking context",
	previewBatch: "composing and ranking context",
	submitBatch: "sending to the agent",
	tidy: "tidying",
	undo: "undoing",
	redo: "redoing",
	checkDrift: "checking drift",
	reanchor: "re-anchoring",
	recordBaseline: "recording baseline",
	stillTrue: "re-fingerprinting",
	lineRequest: "adding the block",
};

let opCount = 0;

export interface OpAnswer {
	ok: boolean;
	status: number;
	data: { error?: string; message?: string; state?: WebState; needsSave?: boolean; preview?: WebPreview };
}

/** Every write goes through here. Resolves to { ok, status, data } and never throws. */
export async function op(body: Record<string, unknown>): Promise<OpAnswer> {
	// The button that was clicked shows it is working until the answer lands.
	const button = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
	button?.classList.add("pending");
	app.inFlight += 1;
	app.inFlightWord = BUSY_WORDS[String(body.op)] ?? "working";
	let response: Response | null;
	try {
		opCount += 1;
		response = await fetch("/api/op", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	} catch {
		app.offline = true;
		response = null;
	} finally {
		app.inFlight -= 1;
		button?.classList.remove("pending");
	}
	if (!response) return { ok: false, status: 0, data: {} };
	const data = (await response.json().catch(() => ({}))) as OpAnswer["data"];
	opCount += 1;
	if (data.state) app.state = data.state;
	if (!response.ok && !data.needsSave) flash(data.error ?? `request failed: ${response.status}`, true);
	else if (data.message) flash(data.message, false);
	return { ok: response.ok, status: response.status, data };
}

let messageTimer: ReturnType<typeof setTimeout> | undefined;

/** A message answers one action, then the status line goes back to the keys; errors stay a little longer. */
export function flash(text: string, isError: boolean): void {
	app.message = text;
	app.messageIsError = isError;
	clearTimeout(messageTimer);
	messageTimer = setTimeout(() => (app.message = ""), isError ? 15000 : 6000);
}

export async function poll(): Promise<void> {
	try {
		const url = `/api/state${app.state ? `?since=${encodeURIComponent(app.state.version)}` : ""}`;
		const issuedAt = opCount;
		const response = await fetch(url);
		app.offline = !response.ok && response.status !== 204;
		// A poll issued before an op may answer after it: its state is older, so drop it.
		if (response.status === 200 && issuedAt === opCount) {
			const next = (await response.json()) as WebState;
			if (issuedAt === opCount) {
				const followFocus = app.state && next.selected !== app.state.selected;
				app.state = next;
				if (followFocus && next.selected) app.centerOn = next.selected;
			}
		}
	} catch {
		app.offline = true;
	}
	setTimeout(poll, 500);
}

// ---------------------------------------------------------------- reading the document

export function shown(block: Block): boolean {
	return !app.grounded || block.evidence === "observed";
}

export function uncited(block: Block): boolean {
	return st().document?.purpose === "explore" && block.evidence !== "observed";
}

/** Brainstorm is always a walk. Explore walks until a block is settled; plan stays a page. */
export function walking(): boolean {
	const state = app.state;
	const doc = state?.document;
	if (!state || !doc || app.surface !== "page") return false;
	if (doc.purpose === "brainstorm") return true;
	if (doc.purpose !== "explore") return false;
	const block = selectedBlock(state);
	return !block || block.status === "open";
}

/** The focused block's neighbourhood, resolved against the grounded filter; the parent is structural, never filtered. */
export function focusLists(): FocusNeighborhood {
	const state = st();
	return focusNeighborhood(state.document!, state.selected, shown);
}

export function focusCountsOf(hood: FocusNeighborhood) {
	return { up: hood.parent ? 1 : 0, in: hood.inputs.length, out: hood.outputs.length, down: hood.children.length };
}

/** The cursor to draw, reset to the centre whenever focus moved. */
export function cursorNow(hood: FocusNeighborhood): FocusCursor {
	return app.focusCursor.for !== st().selected ? FOCUS_CENTER : normalizeFocusCursor(app.focusCursor, focusCountsOf(hood));
}

/** The keys that do something right now, most useful first; the status line cuts from the right. */
export function keyHints(): [string, string][] {
	const state = st();
	const doc = state.document;
	if (!doc || !state.flow) return [];
	const flow = state.flow;
	const block = selectedBlock(state);
	if (app.surface === "map") return [["drag", "move"], ["dbl-click", "add"], ["Enter", "inside"], ["Esc", "up"], ["v", "page"], ["F", "fit"], ["T", "tidy"]];
	const hints: [string, string][] = [["j k", "move"]];
	if (walking()) {
		hints.push(["arrows", "walk"]);
		const hood = focusLists();
		if (cursorTarget(cursorNow(hood), hood)) hints.push(["Enter", "go"], ["Esc", "back"]);
	}
	if (block) {
		if (flow.status) hints.push(["space", doc.purpose === "explore" ? "explored" : "status"]);
		if (doc.purpose === "explore") hints.push(["g", app.grounded ? "all claims" : "grounded"]);
		for (const verb of flow.verbs) hints.push([verb.key, verb.label.toLowerCase()]);
	}
	if (doc.purpose !== "brainstorm") hints.push(["n", "next open"]);
	hints.push(doc.purpose === "brainstorm" ? ["o", "dump a line"] : ["o O", "add / inside"], ["m", "mark"], ["/", "files"], ["v", "map"], ["S", "screens"]);
	return hints;
}

/** The block the cursor points at, or undefined on the centre. */
export function cursorTarget(cursor: FocusCursor, hood: FocusNeighborhood): Block | undefined {
	if (cursor.slot === "up") return cursor.index === 0 ? hood.parent : undefined;
	if (cursor.slot === "in") return hood.inputs[cursor.index]?.block;
	if (cursor.slot === "out") return hood.outputs[cursor.index]?.block;
	if (cursor.slot === "down") return hood.children[cursor.index];
	return undefined;
}

// ---------------------------------------------------------------- dialogs

export function closeModal(): void {
	app.modal = null;
}

/** A yes/cancel question; either answer returns to the dialog it was asked over, then yes runs `onYes`. */
export function ask(text: string, yes: string, onYes: () => void): void {
	app.modal = { kind: "confirm", text, yes, onYes, back: app.modal };
}

export const CHANGE_DIALOG: TextDialog = {
	title: "Plan a change to this codebase",
	placeholder: "What should change? e.g. add a JSON export to the report command",
	hint: "Opens a new plan under .omp-visual-planner/changes/. The agent reads the code before it proposes anything.",
};

export function openTextDialog(dialog: TextDialog, onSubmit: (text: string) => void): void {
	app.modal = { kind: "text", ...dialog, onSubmit };
}

// ---------------------------------------------------------------- requests

export async function openPreview(verb: string, id?: string): Promise<void> {
	const result = await op({ op: "preview", verb, id });
	if (!result.ok || !result.data.preview) return;
	app.modal = { kind: "preview", preview: { verb, id, ...result.data.preview } };
}

/** Blocks as one batch — the marked ones unless named: the parent prompt and every subagent's instructions, previewed first. */
export async function openBatchPreview(verb: string, ids: string[] = [...marked]): Promise<void> {
	const result = await op({ op: "previewBatch", verb, ids });
	if (!result.ok || !result.data.preview) return;
	app.modal = { kind: "preview", preview: { batch: true, verb, ids, ...result.data.preview } };
}

async function submitAsking(body: Record<string, unknown>, onDone: () => void): Promise<void> {
	const result = await op(body);
	if (result.status === 409 && result.data.needsSave) {
		ask("This document has unsaved edits. Save them and submit?", "Save and submit", () =>
			op({ ...body, saveFirst: true }).then(next => {
				if (next.ok) onDone();
				else closeModal();
			}),
		);
		return;
	}
	if (result.ok) onDone();
}

export function submitPreview(preview: Preview): Promise<void> {
	if (preview.batch) {
		return submitAsking({ op: "submitBatch", verb: preview.verb, ids: preview.ids }, () => {
			if (preview.verb !== "sync") marked.clear();
			closeModal();
		});
	}
	return submitAsking({ op: "submit", verb: preview.verb, id: preview.id }, closeModal);
}

export function startProject(kind: string, text: string): void {
	const doc = st().document!;
	if (kind === "prune" || kind === "replan" || kind === "execute") {
		void openPreview(kind);
		return;
	}
	if (kind === "draft") {
		if (!text.trim()) return flash("a draft needs a goal: type what this is about", true);
		void op({ op: "submit", start: { kind: "draft", goal: text, purpose: doc.purpose === "brainstorm" ? "brainstorm" : "plan" } });
		return;
	}
	if (kind === "change") {
		if (!text.trim()) return flash("a change needs a goal: type what should change", true);
		void op({ op: "submit", start: { kind: "change", goal: text, marked: [...marked] } }).then(result => {
			if (result.ok) marked.clear();
		});
		return;
	}
	void op({ op: "submit", start: { kind: "discover", target: text.trim() || "." } });
}

export async function implementBlock(id: string): Promise<void> {
	if (st().document?.purpose === "brainstorm") {
		const switched = await op({ op: "setPurpose", purpose: "plan" });
		if (!switched.ok) return;
	}
	await openPreview("execute", id);
}

export function stepStatus(block: Block): void {
	const status = st().flow?.status;
	if (!status) return flash("brainstorm ideas have no status", true);
	const index = status.cycle.indexOf(block.status);
	void op({ op: "setStatus", id: block.id, status: index === -1 ? status.cycle[0] : status.cycle[(index + 1) % status.cycle.length] });
}

export function focus(id: string | null, center = false): Promise<OpAnswer> {
	if (center && id) app.centerOn = id;
	return op({ op: "focus", id });
}

/** The one next step for the focused block (or the project). */
export function runStep(block: Block | null): void {
	const flow = st().flow!;
	const step = flow.next;
	if (step.act === "verb" && step.verb) void openPreview(step.verb, block?.id);
	else if (step.act === "implement" && block) void implementBlock(block.id);
	else if (step.act === "status" && block) stepStatus(block);
	else if (step.act === "enter" && block) void op({ op: "enter", id: block.id });
	else if (flow.nextOpen) void focus(flow.nextOpen, true);
	else void op(block ? { op: "addBlock", afterId: block.id } : { op: "addBlock" });
}

export function toggleMark(id: string): void {
	const block = findBlock(st().document, id);
	if (!block) return;
	const title = block.title || "(untitled)";
	if (marked.delete(id)) flash(`unmarked “${title}”`, false);
	else {
		marked.add(id);
		flash(`marked “${title}” · ${marked.size} marked`, false);
	}
}

export function removeBlock(block: Block): void {
	const users = usersCut(st().document!, block);
	const loses = users > 0 ? ` ${users} block${users === 1 ? " that uses it loses" : "s that use it lose"} that link.` : "";
	ask(`Delete ${block.title || "this block"} and everything inside it?${loses}`, "Delete", () => void op({ op: "removeBlock", id: block.id }));
}

/** Add a block for selected lines — a change or a question — and open the preview of its request. */
export async function lineRequest(kind: "change" | "ask", text: string, range: SourceRef): Promise<void> {
	const result = await op({ op: "lineRequest", kind, text, ...range });
	const preview = result.data.preview;
	if (!result.ok || !preview?.request) return;
	app.modal = { kind: "preview", preview: { ...preview, verb: preview.request.verb, id: preview.request.id } };
}

export async function openDrift(): Promise<void> {
	const result = await op({ op: "checkDrift" });
	if (result.ok) app.modal = { kind: "drift" };
}

export function toggleSurface(target: "map" | "screens"): void {
	app.surface = app.surface === target ? "page" : target;
}

// ---------------------------------------------------------------- files and code

export async function loadFiles(): Promise<void> {
	const response = await fetch("/api/files").catch(() => null);
	if (!response?.ok) return flash("could not list the workspace files", true);
	const data = (await response.json()) as { files: string[]; truncated: boolean };
	const first = app.files === null;
	app.files = data.files;
	app.filesTruncated = data.truncated;
	// A small workspace opens fully expanded; a large one starts at its top level.
	if (first && data.files.length <= 150) for (const path of data.files) revealDirs(path);
}

function revealDirs(path: string): void {
	const parts = path.split("/");
	for (let i = 1; i < parts.length; i += 1) openDirs.add(`${parts.slice(0, i).join("/")}/`);
}

export function toggleFiles(open = !app.filesOpen): void {
	app.filesOpen = open;
	if (open) void loadFiles();
}

export async function openFile(path: string, line?: number): Promise<void> {
	const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`).catch(() => null);
	const data = (response ? await response.json().catch(() => ({})) : {}) as { error?: string; path: string; lines: string[]; tokens: Span[][] | null; truncated: boolean };
	if (!response?.ok) return flash(data.error ?? `could not open ${path}`, true);
	// Reveal the file in the tree, too.
	revealDirs(path);
	app.viewer = { path: data.path, lines: data.lines, tokens: data.tokens, truncated: data.truncated, line: line ?? null, selection: null, wide: app.viewer?.wide ?? false, intel: null };
	// The viewer takes the right side: keep the focused block in what is left.
	if (app.state?.selected) app.centerOn = app.state.selected;
}

const pendingInsights = new Set<string>();

/** Tree-sitter context for `path:line`, fetched once; undefined until it lands. */
export function insightFor(path: string, line: number, refresh = false): Insight | undefined {
	const key = `${path}:${line}`;
	if ((refresh || !insights.has(key)) && !pendingInsights.has(key)) {
		pendingInsights.add(key);
		void fetch(`/api/insight?path=${encodeURIComponent(path)}&line=${line}`)
			.then(response => response.json() as Promise<Insight>)
			.catch((): Insight => ({ error: "could not read source insight" }))
			.then(result => {
				pendingInsights.delete(key);
				insights.set(key, result);
			});
	}
	return insights.get(key);
}

/** A language-server answer; a failed request reads as `{ ok: false, reason }`. */
async function intelFetch<T>(url: string): Promise<IntelOutcome<unknown> & T> {
	const response = await fetch(url).catch(() => null);
	if (!response) return { ok: false, reason: "offline" } as IntelOutcome<unknown> & T;
	const data = (await response.json().catch(() => ({ ok: false, reason: "could not read the answer" }))) as { error?: string };
	return (data.error ? { ok: false, reason: data.error } : data) as IntelOutcome<unknown> & T;
}

/** The latest intel lookup; an answer to an older one, or to a pane since closed, is dropped. */
let intelTicket = 0;

function stillAsked(ticket: number, path: string): boolean {
	return ticket === intelTicket && app.viewer?.path === path && !!app.viewer.intel;
}

export async function openOutline(path: string): Promise<void> {
	const viewer = app.viewer;
	if (!viewer) return;
	const ticket = ++intelTicket;
	viewer.intel = { mode: "outline", title: "Outline", loading: true };
	const data = await intelFetch<{ view?: OutlineTreeRow[] }>(`/api/outline?path=${encodeURIComponent(path)}`);
	if (!stillAsked(ticket, path) || !app.viewer) return;
	app.viewer.intel = { mode: "outline", title: `Outline${data.ok ? ` · ${data.server}` : ""}`, loading: false, data };
}

export async function openSymbol(path: string, line: number, character: number, name: string): Promise<void> {
	const viewer = app.viewer;
	if (!viewer) return;
	const ticket = ++intelTicket;
	viewer.intel = { mode: "symbol", title: name, loading: true };
	const data = await intelFetch<{ view?: WebSymbolView }>(`/api/symbol?path=${encodeURIComponent(path)}&line=${line}&character=${character}`);
	if (!stillAsked(ticket, path) || !app.viewer) return;
	app.viewer.intel = { mode: "symbol", title: `${name}${data.ok ? ` · ${data.server}` : ""}`, loading: false, data };
}

function viewKey(): string {
	return (app.state ? currentDiagram(app.state)?.id : undefined) ?? "-";
}

/** The diagram on screen's pan and zoom. */
export function mapView(): MapView {
	return views[viewKey()] ?? { x: 60, y: 90, k: 1 };
}

export function setMapView(next: MapView): void {
	views[viewKey()] = next;
}

/** The part of the window the map can use: between the open drawers, below the top bar. */
export function freeArea(): { left: number; top: number; width: number; height: number } {
	const files = document.getElementById("files");
	const viewer = document.getElementById("viewer");
	const left = files ? files.getBoundingClientRect().right : 0;
	const right = viewer ? viewer.getBoundingClientRect().left : window.innerWidth;
	const top = document.getElementById("topbar")?.getBoundingClientRect().bottom ?? 0;
	const bottom = window.innerHeight - (document.getElementById("statusbar")?.getBoundingClientRect().top ?? window.innerHeight);
	return { left, top, width: Math.max(200, right - left), height: Math.max(160, window.innerHeight - top - bottom) };
}

/** Zoom and pan so the diagram on screen fills the free area. */
export function fit(): void {
	const diagram = app.state ? currentDiagram(app.state) : null;
	if (!diagram || diagram.blocks.length === 0) return;
	const rects = diagram.blocks.map(rectOf);
	const minX = Math.min(...rects.map(r => r.x));
	const minY = Math.min(...rects.map(r => r.y));
	const maxX = Math.max(...rects.map(r => r.x + r.w));
	const maxY = Math.max(...rects.map(r => r.y + r.h));
	const area = freeArea();
	const k = Math.min(1.25, Math.max(1, area.width - 48) / Math.max(1, maxX - minX), Math.max(1, area.height - 48) / Math.max(1, maxY - minY));
	setMapView({ k, x: area.left + (area.width - (maxX - minX) * k) / 2 - minX * k, y: area.top + (area.height - (maxY - minY) * k) / 2 - minY * k });
}

export function toggleMap(): void {
	toggleSurface("map");
	if (app.surface === "map") requestAnimationFrame(fit);
}
