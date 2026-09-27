/**
 * Web mode: an on-demand local server for one session's planner.
 *
 * The TUI overlay stays the default surface. `/diagram web` starts a loopback
 * server bound to the session's own store and journal — the same objects the
 * overlay and the tools use — so a browser tab, the overlay, and a model's
 * proposal all see one document. Nothing here can apply a proposal without a
 * human pressing Accept, and nothing here reaches the filesystem except the
 * store's own guarded save.
 *
 * Access: loopback bind, a per-server token exchanged once for an HttpOnly
 * SameSite=Strict cookie, a Host check against DNS rebinding, and an Origin
 * check on every write.
 */
import type { Server } from "bun";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ActionKind, ActionRegistry, BeginInput, JournalEntry } from "./actions.ts";
import {
	type DocumentStart,
	type PageField,
	type ProjectAction,
	type VerbId,
	codeRootFor,
	composeRequest,
	fieldLabel,
	nextOpenBlock,
	nextStep,
	pageFields,
	progressLabel,
	projectActions,
	startDocument,
	statusCycle,
	statusGlyph,
	statusLabel,
	verbsFor,
} from "./flow.ts";
import {
	BLOCK_STATUSES,
	type Block,
	type BlockStatus,
	type Diagram,
	type DiagramDocument,
	type Evidence,
	type Intent,
	type Scope,
	type Venue,
	EVIDENCE_VALUES,
	PURPOSES,
	VENUES,
	type Purpose,
	addBlock,
	addEdge,
	createBlock,
	createEdge,
	findBlockLocation,
	findDiagram,
	findDiagramPath,
	formatSourceRef,
	moveBlockInOrder,
	removeBlock,
} from "./model.ts";
import { type DocumentStore, defaultDocumentPath, displayPath } from "./store.ts";
import { type DocumentDiff, acceptReplacement, diffDocuments, emptyDiff, placeNewBlock, tidyDiagram } from "./ui.ts";
import { WEB_PAGE } from "./web-page.ts";
import { highlightLines } from "./highlight.ts";
import { inspectSource } from "./code-evidence.ts";
import { listWorkspaceFiles, readWorkspaceFile, workspacePath } from "./workspace-files.ts";

export const WEB_HOSTNAME = "127.0.0.1";
/**
 * Cookies are scoped by host, not port: two sessions' servers on 127.0.0.1
 * would overwrite one shared cookie and log each other's tab out.
 */
export function cookieName(port: number): string {
	return `ovp_token_${port}`;
}

/** The slice of a planner session web mode reads and mutates. */
export interface WebSession {
	store: DocumentStore;
	registry: ActionRegistry;
	stack: string[];
	selected: string | undefined;
	branchToken: string;
}

export interface WebBinding {
	sessionId: string;
	cwd: string;
	getSession: () => WebSession | undefined;
	/** Called after every successful mutation (the extension persists session metadata). */
	onChange: () => void;
	/** Register a request and hand its prompt to the agent, exactly as the overlay does. */
	submit: (request: BeginInput, prompt: string) => { ok: true; message: string } | { ok: false; error: string };
}

export interface WebHandle {
	url: string;
	port: number;
	token: string;
	stop: () => void;
}

interface Entry {
	server: Server<undefined>;
	port: number;
	token: string;
	binding: WebBinding;
}

/**
 * Process-wide, so a plugin reload (which re-executes this module) can find the
 * servers the previous module instance started.
 */
const REGISTRY: Map<string, Entry> = ((globalThis as Record<symbol, unknown>)[
	Symbol.for("omp-visual-planner.web")
] ??= new Map<string, Entry>()) as Map<string, Entry>;

export function webUrl(port: number): string {
	return `http://${WEB_HOSTNAME}:${port}/`;
}

export function runningWeb(sessionId: string): WebHandle | undefined {
	const entry = REGISTRY.get(sessionId);
	return entry ? handleOf(sessionId, entry) : undefined;
}

function handleOf(sessionId: string, entry: Entry): WebHandle {
	return {
		url: webUrl(entry.port),
		port: entry.port,
		token: entry.token,
		stop: () => stopWeb(sessionId),
	};
}

/**
 * Start, or rebind a running server. A plugin reload re-executes this module
 * while the listener (kept in the process-wide registry) survives; rebinding
 * swaps in the new module's handler and session in place, so an open tab
 * keeps its address and cookie.
 */
export function startWeb(binding: WebBinding): WebHandle {
	const existing = REGISTRY.get(binding.sessionId);
	if (existing) {
		existing.binding = binding;
		existing.server.reload({ fetch: request => handle(existing, request) });
		return handleOf(binding.sessionId, existing);
	}
	const entry = { port: 0, token: randomBytes(32).toString("hex"), binding } as Entry;
	entry.server = Bun.serve({ hostname: WEB_HOSTNAME, port: 0, fetch: request => handle(entry, request) });
	entry.port = entry.server.port ?? 0;
	REGISTRY.set(binding.sessionId, entry);
	return handleOf(binding.sessionId, entry);
}

/** Best effort, like `omp stats`: a missing opener only means the user clicks the printed link. */
export function openBrowser(url: string): void {
	const [command, ...args] =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: ["xdg-open", url];
	try {
		Bun.spawn([command!, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
	} catch {
		// no opener on this machine
	}
}

export function stopWeb(sessionId: string): boolean {
	const entry = REGISTRY.get(sessionId);
	if (!entry) return false;
	entry.server.stop(true);
	REGISTRY.delete(sessionId);
	return true;
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

const SECURITY_HEADERS: Record<string, string> = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
};

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: SECURITY_HEADERS });
}

function sameToken(candidate: string | undefined, token: string): boolean {
	if (candidate === undefined || candidate.length !== token.length) return false;
	return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

function cookieToken(request: Request, port: number): string | undefined {
	const header = request.headers.get("cookie");
	if (!header) return undefined;
	const wanted = cookieName(port);
	for (const part of header.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === wanted) return rest.join("=");
	}
	return undefined;
}

async function handle(entry: Entry, request: Request): Promise<Response> {
	const url = new URL(request.url);
	const origin = `http://${WEB_HOSTNAME}:${entry.port}`;
	// DNS rebinding: a page on another name resolving to loopback must not reach us.
	if (request.headers.get("host") !== `${WEB_HOSTNAME}:${entry.port}`) {
		return new Response("wrong host", { status: 421, headers: SECURITY_HEADERS });
	}

	if (url.pathname === "/" && request.method === "GET") {
		const offered = url.searchParams.get("token") ?? undefined;
		if (offered !== undefined) {
			if (!sameToken(offered, entry.token)) return new Response("bad token", { status: 403, headers: SECURITY_HEADERS });
			// Exchange the link token for a cookie and drop it from the address bar.
			return new Response(null, {
				status: 303,
				headers: {
					...SECURITY_HEADERS,
					location: "/",
					"set-cookie": `${cookieName(entry.port)}=${entry.token}; HttpOnly; SameSite=Strict; Path=/`,
				},
			});
		}
		if (!sameToken(cookieToken(request, entry.port), entry.token)) {
			return new Response("open the link printed by /diagram web", { status: 403, headers: SECURITY_HEADERS });
		}
		return new Response(WEB_PAGE, {
			headers: {
				...SECURITY_HEADERS,
				"content-type": "text/html; charset=utf-8",
				"content-security-policy":
					"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			},
		});
	}

	if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404, headers: SECURITY_HEADERS });
	if (!sameToken(cookieToken(request, entry.port), entry.token)) return json({ error: "unauthorized" }, 401);

	const session = entry.binding.getSession();
	if (!session) return json({ error: "the planner session is gone; run /diagram web again" }, 410);

	if (url.pathname === "/api/state" && request.method === "GET") {
		const state = stateOf(session, entry.binding);
		if (url.searchParams.get("since") === state.version) return new Response(null, { status: 204, headers: SECURITY_HEADERS });
		return json(state);
	}

	if (url.pathname === "/api/files" && request.method === "GET") {
		return json(await listWorkspaceFiles(entry.binding.cwd));
	}

	if (url.pathname === "/api/file" && request.method === "GET") {
		const read = await readWorkspaceFile(entry.binding.cwd, url.searchParams.get("path") ?? "");
		if (!read.ok) return json({ error: read.error }, read.status);
		// Spans, not HTML: the page styles token classes; file text never becomes markup.
		return json({ ...read, tokens: highlightLines(read.lines.join("\n"), read.path) ?? null });
	}

	if (url.pathname === "/api/insight" && request.method === "GET") {
		const line = Number(url.searchParams.get("line"));
		const insight = await inspectSource(entry.binding.cwd, url.searchParams.get("path") ?? "", line);
		return insight.ok ? json(insight) : json({ error: insight.error }, insight.status);
	}

	if (url.pathname === "/api/op" && request.method === "POST") {
		if (request.headers.get("origin") !== origin) return json({ error: "cross-origin write refused" }, 403);
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return json({ error: "body must be JSON" }, 400);
		}
		const result = await applyOp(session, entry.binding, body);
		if (!result.ok) {
			const failure: Record<string, unknown> = { error: result.error, state: stateOf(session, entry.binding) };
			if (result.needsSave) failure.needsSave = true;
			return json(failure, result.status ?? 400);
		}
		if (result.changed) entry.binding.onChange();
		const success: Record<string, unknown> = { message: result.message, state: stateOf(session, entry.binding) };
		if (result.preview) success.preview = result.preview;
		return json(success);
	}

	return json({ error: "not found" }, 404);
}

// ---------------------------------------------------------------------------
// State projection
// ---------------------------------------------------------------------------

export interface WebReview {
	requestId: string;
	label: string;
	summary: string;
	diff: DocumentDiff;
	error?: string;
}

export interface WebFlow {
	verbs: { id: VerbId; label: string; key: string }[];
	/** Null for a brainstorm, whose ideas carry no status. */
	status: { cycle: BlockStatus[]; labels: Record<string, string>; glyphs: Record<string, string> } | null;
	fields: { field: PageField; label: string }[];
	projectActions: ProjectAction[];
	progress: string;
	nextOpen: string | undefined;
	next: { label: string; detail: string; verb?: string; act: "verb" | "status" | "implement" | "enter" | "add" };
}

export interface WebState {
	version: string;
	sessionId: string;
	path: string | undefined;
	dirty: boolean;
	canUndo: boolean;
	canRedo: boolean;
	document: DiagramDocument | undefined;
	purpose: Purpose | undefined;
	flow: WebFlow | undefined;
	stack: string[];
	breadcrumb: { diagramId: string; title: string }[];
	selected: string | undefined;
	review: WebReview | undefined;
	/** The request this branch waits on: what it is, where, and since when (ISO time) — for progress UI. */
	pending:
		| { requestId: string; label: string; state: string; kind: string; since: string; blockId: string | undefined }
		| undefined;
}

/** Every label the page shows comes from the shared flow, never from the page itself. */
function flowOf(document: DiagramDocument, selected: string | undefined): WebFlow {
	const purpose = document.purpose;
	const cycle = statusCycle(purpose);
	return {
		verbs: verbsFor(purpose).map(verb => ({ id: verb.id, label: verb.label, key: verb.key })),
		status:
			cycle.length === 0
				? null
				: {
						cycle,
						labels: Object.fromEntries(BLOCK_STATUSES.map(status => [status, statusLabel(purpose, status) ?? status])),
						glyphs: Object.fromEntries(BLOCK_STATUSES.map(status => [status, statusGlyph(purpose, status)])),
					},
		fields: pageFields(purpose).map(field => ({ field, label: fieldLabel(purpose, field) })),
		projectActions: projectActions(purpose),
		progress: progressLabel(document),
		nextOpen: nextOpenBlock(document, selected),
		next: nextStep(document, selected ? findBlockLocation(document.root, selected)?.block : undefined),
	};
}

function stagedEntry(session: WebSession): JournalEntry | undefined {
	const entry = session.registry.pending();
	return entry?.state === "staged" && entry.proposal ? entry : undefined;
}

function project(document: DiagramDocument, entry: JournalEntry): { ok: true; document: DiagramDocument } | { ok: false; error: string } {
	const proposal = entry.proposal;
	if (!proposal) return { ok: false, error: "that request has no staged proposal" };
	const clone = structuredClone(document);
	try {
		acceptReplacement(clone, proposal.replacement, entry.scope.id, entry);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	return { ok: true, document: clone };
}

/** Keep navigation inside the document: stale ids fall back to the root. */
function normalizeStack(session: WebSession, document: DiagramDocument): string[] {
	const path: string[] = [];
	for (const id of session.stack) {
		if (!findDiagram(document.root, id)) break;
		path.push(id);
	}
	if (path[0] !== document.root.id) return [document.root.id];
	return path;
}

function breadcrumbOf(document: DiagramDocument, stack: string[]): { diagramId: string; title: string }[] {
	const crumbs = [{ diagramId: document.root.id, title: document.title }];
	for (const diagramId of stack.slice(1)) {
		const owner = ownerOf(document.root, diagramId);
		crumbs.push({ diagramId, title: owner?.title ?? "?" });
	}
	return crumbs;
}

function ownerOf(root: Diagram, diagramId: string): Block | undefined {
	for (const diagram of findDiagramPath(root, diagramId) ?? []) {
		for (const block of diagram.blocks) if (block.children?.id === diagramId) return block;
	}
	return undefined;
}

export function stateOf(session: WebSession, binding: WebBinding): WebState {
	const document = session.store.document;
	const stack = document ? normalizeStack(session, document) : [];
	const staged = stagedEntry(session);
	let review: WebReview | undefined;
	if (staged && document) {
		const base = { requestId: staged.requestId, label: staged.label, summary: staged.proposal?.summary ?? "" };
		if (staged.documentId !== document.id) {
			review = { ...base, diff: emptyDiff(), error: `this proposal belongs to document ${staged.documentId}` };
		} else {
			const projected = project(document, staged);
			review = projected.ok
				? { ...base, diff: diffDocuments(document, projected.document) }
				: { ...base, diff: emptyDiff(), error: projected.error };
		}
	}
	const pendingEntry = session.registry.pending();
	const version = [
		document?.id ?? "-",
		document?.revision ?? -1,
		session.store.dirty ? 1 : 0,
		session.store.canUndo ? 1 : 0,
		session.store.canRedo ? 1 : 0,
		session.store.path ?? "",
		stack.join("/"),
		session.selected ?? "",
		session.registry.entries.map(entry => `${entry.requestId}:${entry.state}`).join(","),
	].join("|");
	return {
		version,
		sessionId: binding.sessionId,
		path: session.store.path === undefined ? undefined : displayPath(session.store.path, binding.cwd),
		dirty: session.store.dirty,
		canUndo: session.store.canUndo,
		canRedo: session.store.canRedo,
		document,
		purpose: document?.purpose,
		flow: document ? flowOf(document, session.selected) : undefined,
		stack,
		breadcrumb: document ? breadcrumbOf(document, stack) : [],
		selected: session.selected,
		review,
		pending: pendingEntry
			? {
					requestId: pendingEntry.requestId,
					label: pendingEntry.label,
					state: pendingEntry.state,
					kind: pendingEntry.kind,
					since: pendingEntry.createdAt,
					blockId: pendingEntry.scope.kind === "block" ? pendingEntry.scope.id : undefined,
				}
			: undefined,
	};
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

type OpResult =
	| { ok: true; changed: boolean; message: string; preview?: { label: string; text: string; size: number } }
	| { ok: false; error: string; status?: number; needsSave?: boolean };

function str(value: unknown, name: string): string {
	if (typeof value !== "string") throw new OpError(`${name} must be a string`);
	return value;
}

function num(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new OpError(`${name} must be a finite number`);
	return Math.round(value);
}

class OpError extends Error {}

const BLOCK_TEXT_FIELDS = ["title", "description", "expectedOutput"] as const;
const BLOCK_ACTION_FIELDS = ["enhance", "execute"] as const;

/** Focus a block: selection plus the diagram path that holds it, as the overlay does. */
function focusBlock(session: WebSession, document: DiagramDocument, id: string): void {
	const location = findBlockLocation(document.root, id);
	if (!location) throw new OpError(`no block ${id}`);
	session.selected = id;
	session.stack = (findDiagramPath(document.root, location.diagram.id) ?? [document.root]).map(diagram => diagram.id);
}

function optionalId(value: unknown, name: string): string | undefined {
	return value === undefined || value === null ? undefined : str(value, name);
}

/**
 * Every op is one validated store transaction (or a navigation/selection
 * change). Unknown ops and fields are refused by name, never ignored.
 */
export async function applyOp(session: WebSession, binding: WebBinding, body: unknown): Promise<OpResult> {
	if (typeof body !== "object" || body === null) return { ok: false, error: "op body must be an object" };
	const op = body as Record<string, unknown>;
	const store = session.store;
	try {
		if (op.op === "newDocument") {
			const purpose = op.purpose === undefined ? "plan" : str(op.purpose, "purpose");
			if (!PURPOSES.includes(purpose as Purpose)) throw new OpError(`purpose must be one of ${PURPOSES.join(", ")}`);
			const fallback = purpose === "brainstorm" ? "New brainstorm" : purpose === "explore" ? "New map" : "New plan";
			const title = str(op.title ?? fallback, "title").trim() || fallback;
			if (store.dirty) throw new OpError("the open document has unsaved edits; save or undo them first");
			const document = store.newDocument({ title, purpose: purpose as Purpose }, defaultDocumentPath(binding.cwd));
			session.stack = [document.root.id];
			session.selected = undefined;
			return { ok: true, changed: true, message: `new document ${title}` };
		}
		if (op.op === "submit" && op.start !== undefined) return await submitStart(session, binding, op);
		const document = store.document;
		if (!document) throw new OpError("no document is open; create one first");
		const stack = normalizeStack(session, document);
		const diagramId = stack.at(-1) ?? document.root.id;

		switch (op.op) {
			case "focus": {
				const id = optionalId(op.id, "id");
				if (id === undefined) session.selected = undefined;
				else focusBlock(session, document, id);
				return { ok: true, changed: true, message: "" };
			}
			case "setStatus": {
				const id = str(op.id, "id");
				const status = str(op.status, "status");
				if (!BLOCK_STATUSES.includes(status as BlockStatus)) {
					throw new OpError(`status must be one of ${BLOCK_STATUSES.join(", ")}`);
				}
				store.transact(draft => {
					const target = findBlockLocation(draft.root, id);
					if (!target) throw new OpError(`no block ${id}`);
					target.block.status = status as BlockStatus;
				});
				const label = statusLabel(document.purpose, status as BlockStatus) ?? status;
				return { ok: true, changed: true, message: `now ${label}` };
			}
			case "setPurpose": {
				const purpose = str(op.purpose, "purpose");
				if (!PURPOSES.includes(purpose as Purpose)) throw new OpError(`purpose must be one of ${PURPOSES.join(", ")}`);
				store.transact(draft => {
					draft.purpose = purpose as Purpose;
				});
				return { ok: true, changed: true, message: `purpose: ${purpose}` };
			}
			case "reorder": {
				const id = str(op.id, "id");
				if (op.delta !== 1 && op.delta !== -1) throw new OpError("delta must be 1 or -1");
				const delta = op.delta;
				store.transact(draft => {
					if (!findBlockLocation(draft.root, id)) throw new OpError(`no block ${id}`);
					if (!moveBlockInOrder(draft.root, id, delta)) throw new OpError(delta < 0 ? "already first" : "already last");
				});
				return { ok: true, changed: true, message: "" };
			}
			case "preview": {
				const { verb, scope } = requestScope(document, op);
				const composed = composeRequest({
					document,
					kind: verb.kind,
					intent: verb.intent,
					scope,
					branchKey: session.branchToken,
					baseDigest: store.diskDigest,
					codeRoot: codeRootFor(binding.cwd, undefined),
				});
				return {
					ok: true,
					changed: false,
					message: "",
					preview: { label: composed.label, text: composed.prompt, size: composed.size },
				};
			}
			case "submit": {
				const { verb, scope } = requestScope(document, op);
				const saved = await saveBeforeSubmit(store, op);
				if (saved) return saved;
				const composed = composeRequest({
					document: store.require(),
					kind: verb.kind,
					intent: verb.intent,
					scope,
					branchKey: session.branchToken,
					baseDigest: store.diskDigest,
					codeRoot: codeRootFor(binding.cwd, undefined),
				});
				const outcome = binding.submit(composed.request, composed.prompt);
				if (!outcome.ok) return { ok: false, error: outcome.error };
				return { ok: true, changed: true, message: outcome.message };
			}
			case "discard": {
				const requestId = str(op.requestId, "requestId");
				const entry = session.registry.entryFor(requestId);
				if (entry?.state !== "pending" && entry?.state !== "staged") throw new OpError(`request ${requestId} is not pending`);
				session.registry.resolve(requestId, "discarded");
				return { ok: true, changed: true, message: "request discarded; a late proposal for it will be refused" };
			}
			case "navigate": {
				const target = str(op.diagramId, "diagramId");
				const index = stack.indexOf(target);
				if (index < 0) throw new OpError(`diagram ${target} is not on the current path`);
				session.stack = stack.slice(0, index + 1);
				session.selected = undefined;
				return { ok: true, changed: true, message: "" };
			}
			case "enter": {
				const id = str(op.id, "id");
				const location = findBlockLocation(document.root, id);
				if (!location) throw new OpError(`no block ${id}`);
				if (!location.block.children) {
					store.transact(draft => {
						const target = findBlockLocation(draft.root, id);
						if (target) target.block.children = { id: crypto.randomUUID(), blocks: [], edges: [] };
					});
				}
				const children = findBlockLocation(store.require().root, id)?.block.children;
				if (!children) throw new OpError("could not open the subsystem");
				// Descend along the block's own path, whatever the current view.
				const ownerPath = findDiagramPath(store.require().root, children.id) ?? [];
				session.stack = ownerPath.map(diagram => diagram.id);
				session.selected = children.blocks[0]?.id;
				return { ok: true, changed: true, message: `entered ${location.block.title}` };
			}
			case "patchDocument": {
				const title = op.title === undefined ? undefined : str(op.title, "title");
				const goal = op.goal === undefined ? undefined : str(op.goal, "goal");
				store.transact(draft => {
					if (title !== undefined && title.trim().length > 0) draft.title = title.trim();
					if (goal !== undefined) draft.goal = goal;
				});
				return { ok: true, changed: true, message: "document updated" };
			}
			case "patchBlock": {
				const id = str(op.id, "id");
				const fields = op.fields;
				if (typeof fields !== "object" || fields === null) throw new OpError("fields must be an object");
				const patch = fields as Record<string, unknown>;
				for (const key of Object.keys(patch)) {
					const editable =
						(BLOCK_TEXT_FIELDS as readonly string[]).includes(key) ||
						(BLOCK_ACTION_FIELDS as readonly string[]).includes(key) ||
						key === "evidence" ||
						key === "acceptanceCriteria" ||
						key === "venue";
					if (!editable) throw new OpError(`field ${key} cannot be edited here`);
				}
				if (patch.evidence !== undefined && !EVIDENCE_VALUES.includes(patch.evidence as Evidence)) {
					throw new OpError(`evidence must be one of ${EVIDENCE_VALUES.join(", ")}`);
				}
				if (patch.venue !== undefined && !VENUES.includes(patch.venue as Venue)) {
					throw new OpError(`venue must be one of ${VENUES.join(", ")}`);
				}
				const criteria =
					patch.acceptanceCriteria === undefined
						? undefined
						: str(patch.acceptanceCriteria, "acceptanceCriteria")
								.split("\n")
								.map(line => line.trim())
								.filter(line => line.length > 0);
				store.transact(draft => {
					const target = findBlockLocation(draft.root, id);
					if (!target) throw new OpError(`no block ${id}`);
					for (const key of BLOCK_TEXT_FIELDS) {
						if (patch[key] === undefined) continue;
						const value = str(patch[key], key);
						if (key === "title" && value.trim().length === 0) continue;
						target.block[key] = key === "title" ? value.trim() : value;
					}
					for (const key of BLOCK_ACTION_FIELDS) {
						if (patch[key] !== undefined) target.block.actions[key] = str(patch[key], key);
					}
					if (patch.evidence !== undefined) target.block.evidence = patch.evidence as Evidence;
					if (patch.venue !== undefined) {
						if (patch.venue === "here") delete target.block.venue;
						else target.block.venue = patch.venue as Venue;
					}
					if (criteria !== undefined) target.block.acceptanceCriteria = criteria;
				});
				return { ok: true, changed: true, message: "block updated" };
			}
			case "moveBlock": {
				const id = str(op.id, "id");
				const x = Math.max(0, num(op.x, "x"));
				const y = Math.max(0, num(op.y, "y"));
				const current = findBlockLocation(document.root, id);
				if (!current) throw new OpError(`no block ${id}`);
				if (current.block.position.x === x && current.block.position.y === y) {
					return { ok: true, changed: false, message: "" };
				}
				store.transact(draft => {
					const target = findBlockLocation(draft.root, id);
					if (target) target.block.position = { x, y };
				});
				return { ok: true, changed: true, message: "" };
			}
			case "addBlock": {
				const parentId = optionalId(op.parentId, "parentId");
				const afterId = optionalId(op.afterId, "afterId");
				const parent = parentId === undefined ? undefined : findBlockLocation(document.root, parentId);
				if (parentId !== undefined && !parent) throw new OpError(`no block ${parentId}`);
				const anchor = afterId === undefined ? undefined : findBlockLocation(document.root, afterId);
				if (afterId !== undefined && !anchor) throw new OpError(`no block ${afterId}`);
				const target: Diagram | undefined = parent
					? (parent.block.children ?? undefined)
					: (anchor?.diagram ?? findDiagram(document.root, diagramId));
				const placed =
					op.x !== undefined && op.y !== undefined
						? { x: Math.max(0, num(op.x, "x")), y: Math.max(0, num(op.y, "y")) }
						: target
							? placeNewBlock(target, parent ? undefined : afterId)
							: { x: 2, y: 2 };
				const block = createBlock({
					title: op.title === undefined ? "New block" : str(op.title, "title").trim() || "New block",
					x: placed.x,
					y: placed.y,
				});
				store.transact(draft => {
					if (parentId !== undefined) {
						const owner = findBlockLocation(draft.root, parentId)!.block;
						owner.children ??= { id: crypto.randomUUID(), blocks: [], edges: [] };
						addBlock(draft.root, owner.children.id, block);
						return;
					}
					const into = anchor ? anchor.diagram.id : diagramId;
					if (!addBlock(draft.root, into, block, afterId)) throw new OpError("the current diagram is gone");
				});
				focusBlock(session, store.require(), block.id);
				return { ok: true, changed: true, message: "added a block" };
			}
			case "addSource": {
				const id = str(op.id, "id");
				const path = workspacePath(str(op.path, "path").trim());
				if (path === undefined) throw new OpError("path must be relative to the workspace");
				const startLine = op.startLine === undefined ? undefined : num(op.startLine, "startLine");
				const endLine = op.endLine === undefined ? startLine : num(op.endLine, "endLine");
				if (startLine !== undefined && (startLine < 1 || endLine === undefined || endLine < startLine)) {
					throw new OpError("lines must be a range starting at 1");
				}
				const source = startLine === undefined ? { path } : { path, startLine, endLine };
				store.transact(draft => {
					const target = findBlockLocation(draft.root, id);
					if (!target) throw new OpError(`no block ${id}`);
					target.block.sources.push(source);
				});
				return { ok: true, changed: true, message: `anchored to ${formatSourceRef(source)}` };
			}
			case "removeSource": {
				const id = str(op.id, "id");
				const index = num(op.index, "index");
				store.transact(draft => {
					const target = findBlockLocation(draft.root, id);
					if (!target?.block.sources[index]) throw new OpError(`no source ${index} on block ${id}`);
					target.block.sources.splice(index, 1);
				});
				return { ok: true, changed: true, message: "anchor removed" };
			}
			case "removeBlock": {
				const id = str(op.id, "id");
				const location = findBlockLocation(document.root, id);
				if (!location) throw new OpError(`no block ${id}`);
				store.transact(draft => {
					removeBlock(draft.root, id);
				});
				if (session.selected === id) session.selected = undefined;
				return { ok: true, changed: true, message: `deleted ${location.block.title}` };
			}
			case "addEdge": {
				const from = str(op.from, "from");
				const to = str(op.to, "to");
				const label = op.label === undefined ? "" : str(op.label, "label");
				const edge = createEdge({ from, to, label });
				store.transact(draft => {
					if (!addEdge(draft.root, diagramId, edge)) {
						throw new OpError("both ends must be different blocks in the current diagram");
					}
				});
				return { ok: true, changed: true, message: "added a relationship" };
			}
			case "patchEdge": {
				const id = str(op.id, "id");
				const label = str(op.label, "label");
				store.transact(draft => {
					const edge = findDiagram(draft.root, diagramId)?.edges.find(candidate => candidate.id === id);
					if (!edge) throw new OpError(`no relationship ${id} in this diagram`);
					edge.label = label;
				});
				return { ok: true, changed: true, message: "relationship updated" };
			}
			case "removeEdge": {
				const id = str(op.id, "id");
				store.transact(draft => {
					const diagram = findDiagram(draft.root, diagramId);
					if (!diagram?.edges.some(candidate => candidate.id === id)) throw new OpError(`no relationship ${id} in this diagram`);
					diagram.edges = diagram.edges.filter(candidate => candidate.id !== id);
				});
				return { ok: true, changed: true, message: "deleted relationship" };
			}
			case "undo":
				return store.undo() ? { ok: true, changed: true, message: "undone" } : { ok: false, error: "nothing to undo" };
			case "redo":
				return store.redo() ? { ok: true, changed: true, message: "redone" } : { ok: false, error: "nothing to redo" };
			case "save": {
				const result = await store.save();
				if (!result.ok) return { ok: false, error: result.errors.join("; ") };
				const target = displayPath(result.path, binding.cwd);
				return {
					ok: true,
					changed: true,
					message: result.replaced === true ? `saved ${target} (replaced the existing file)` : `saved ${target}`,
				};
			}
			case "accept": {
				const requestId = str(op.requestId, "requestId");
				const entry = session.registry.entryFor(requestId);
				if (!entry?.proposal) throw new OpError("that request has no staged proposal");
				const digest = await store.currentDiskDigest();
				const applicable = session.registry.checkApplicable(requestId, {
					revision: document.revision,
					digest,
					documentId: document.id,
					branchKey: session.branchToken,
				});
				if (!applicable.ok) {
					session.registry.resolve(requestId, "stale", applicable.errors.join("; "));
					binding.onChange();
					return { ok: false, error: `${applicable.errors.join("; ")} — run the action again` };
				}
				const proposal = entry.proposal;
				store.transact(draft => acceptReplacement(draft, proposal.replacement, entry.scope.id, entry));
				session.registry.resolve(requestId, "accepted");
				return { ok: true, changed: true, message: "proposal accepted; save to write it" };
			}
			case "tidy": {
				store.transact(draft => {
					const diagram = findDiagram(draft.root, diagramId);
					if (!diagram) throw new OpError("the current diagram is gone");
					tidyDiagram(diagram);
				});
				return { ok: true, changed: true, message: "tidied the diagram" };
			}
			case "reject": {
				const requestId = str(op.requestId, "requestId");
				const entry = session.registry.entryFor(requestId);
				if (entry?.state !== "staged") throw new OpError(`request ${requestId} is not staged`);
				session.registry.resolve(requestId, "rejected");
				return { ok: true, changed: true, message: "proposal rejected; the document is unchanged" };
			}
			default:
				throw new OpError(`unknown op ${JSON.stringify(op.op)}`);
		}
	} catch (error) {
		if (error instanceof OpError) return { ok: false, error: error.message };
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** The verb and block an op names, checked against what the document's purpose offers. */
function verbRequest(document: DiagramDocument, op: Record<string, unknown>) {
	const verbId = str(op.verb, "verb");
	const verb = verbsFor(document.purpose).find(candidate => candidate.id === verbId);
	if (!verb) throw new OpError(`no ${verbId} action for a ${document.purpose} document`);
	const id = str(op.id, "id");
	if (!findBlockLocation(document.root, id)) throw new OpError(`no block ${id}`);
	return { verb, id };
}

/** Project-level changes use the same staged-proposal protocol as a block replan. */
function requestScope(document: DiagramDocument, op: Record<string, unknown>): { verb: { kind: ActionKind; intent: Intent }; scope: Scope } {
	if (op.verb === "prune") {
		if (op.id !== undefined) throw new OpError("prune applies to the whole document");
		return { verb: { kind: "prune", intent: "prune" }, scope: { kind: "project" } };
	}
	if (op.verb === "replan" && op.id === undefined) {
		return { verb: { kind: "replan", intent: "replan" }, scope: { kind: "project" } };
	}
	if (op.verb === "execute" && op.id === undefined) {
		return { verb: { kind: "execute", intent: "execute" }, scope: { kind: "project" } };
	}
	const { verb, id } = verbRequest(document, op);
	return { verb, scope: { kind: "block", id } };
}

/**
 * A request is composed against the saved file. Unsaved edits answer 409 so
 * the page can ask; `saveFirst` saves them and carries on.
 */
async function saveBeforeSubmit(store: DocumentStore, op: Record<string, unknown>): Promise<OpResult | undefined> {
	if (!store.dirty) return undefined;
	if (op.saveFirst !== true) return { ok: false, error: "unsaved edits", status: 409, needsSave: true };
	const saved = await store.save();
	return saved.ok ? undefined : { ok: false, error: saved.errors.join("; ") };
}

/** Start a fresh document (draft or discover) and submit its first request. */
async function submitStart(session: WebSession, binding: WebBinding, op: Record<string, unknown>): Promise<OpResult> {
	const store = session.store;
	const start = parseStart(op.start);
	if (store.dirty && (store.document?.root.blocks.length ?? 0) > 0) {
		throw new OpError("save this document before starting a new one");
	}
	const started = startDocument(store, binding.cwd, start);
	session.stack = [started.document.root.id];
	session.selected = undefined;
	const saved = await started.save;
	if (!saved.ok) return { ok: false, error: saved.errors.join("; ") };
	const draft = start.kind === "draft";
	const composed = composeRequest({
		document: store.require(),
		kind: draft ? "draft" : "discover",
		intent: draft ? "plan" : "discover",
		scope: { kind: "project" },
		branchKey: session.branchToken,
		baseDigest: store.diskDigest,
		codeRoot: codeRootFor(binding.cwd, start),
	});
	const outcome = binding.submit(composed.request, composed.prompt);
	if (!outcome.ok) return { ok: false, error: outcome.error };
	return { ok: true, changed: true, message: outcome.message };
}

function parseStart(value: unknown): DocumentStart {
	if (typeof value !== "object" || value === null) throw new OpError("start must be an object");
	const start = value as Record<string, unknown>;
	if (start.kind === "draft") {
		const goal = str(start.goal, "goal");
		if (goal.trim().length === 0) throw new OpError("a draft needs a goal");
		const purpose = start.purpose === "brainstorm" ? "brainstorm" : "plan";
		return { kind: "draft", goal, purpose };
	}
	if (start.kind === "discover") {
		const target = start.target === undefined ? "." : str(start.target, "target").trim() || ".";
		return { kind: "discover", target };
	}
	throw new OpError("start.kind must be draft or discover");
}
