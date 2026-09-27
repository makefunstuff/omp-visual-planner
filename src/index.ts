/**
 * omp-visual-planner: registration and session lifecycle.
 *
 * One planner session per OMP session: a document store, a request journal, and
 * navigation state persisted in this extension's session-metadata namespace.
 * Nothing here patches OMP core or global configuration.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { BeginInput, JournalEntry } from "./actions.ts";
import { ActionRegistry, resumeBranchToken } from "./actions.ts";
import { resolveScope } from "./compose.ts";
import { resolvePlannerJudge } from "./judge.ts";
import type { Purpose, Scope } from "./model.ts";
import { PURPOSES, toolSchemasFor } from "./model.ts";
import { relatedRanker } from "./relevance.ts";
import { DocumentStore, SESSION_NAMESPACE, defaultDocumentPath, displayPath, resolveSessionPath } from "./store.ts";
import type { ScreenResult, ScreenStart } from "./ui.ts";
import { DiagramScreen } from "./ui.ts";
import { editInEditor, editorCommand } from "./editor.ts";
import { type WebBinding, openBrowser, runningWeb, startWeb, stopWeb } from "./web.ts";

const STATUS_KEY = "visual-planner-web";

interface PersistedState {
	path: string | undefined;
	documentId: string | undefined;
	digest: string | undefined;
	stack: string[];
	selected: string | undefined;
	journal: JournalEntry[];
}

interface PlannerSession {
	store: DocumentStore;
	registry: ActionRegistry;
	stack: string[];
	selected: string | undefined;
	/**
	 * Ownership token for in-flight requests. It is frozen for the life of a
	 * branch position: the leaf advances on every turn, so deriving it per call
	 * would invalidate a request the moment its own prompt was submitted. Only a
	 * session start/branch/tree move refreshes it.
	 */
	branchToken: string;
	/** Open overlays, told when something outside them (web mode, a staged proposal) changed the session. */
	listeners: Set<() => void>;
}

function notifyListeners(session: PlannerSession): void {
	for (const listener of session.listeners) listener();
}

const SESSIONS = new Map<string, PlannerSession>();

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() ?? "anonymous";
}

/** A request belongs to one branch position, not to a session as a whole. */
function branchTokenOf(ctx: ExtensionContext): string {
	return `${sessionKey(ctx)}:${ctx.sessionManager.getLeafId() ?? "root"}`;
}

/**
 * Session state, restored on first use.
 *
 * A plugin reload re-executes this module, so the in-memory map starts empty
 * while the session keeps running: nothing would re-emit `session_start`. Every
 * entry point therefore adopts the session's own metadata on first touch.
 */
async function ensureSession(pi: ExtensionAPI, ctx: ExtensionContext): Promise<PlannerSession> {
	const session = sessionFor(pi, ctx);
	if (session.store.document === undefined && session.registry.entries.length === 0) {
		await adoptSession(pi, ctx, "resume");
	}
	return session;
}

function sessionFor(pi: ExtensionAPI, ctx: ExtensionContext): PlannerSession {
	const key = sessionKey(ctx);
	const existing = SESSIONS.get(key);
	if (existing) return existing;
	const created: PlannerSession = {
		store: new DocumentStore(pi.arktype),
		registry: new ActionRegistry(branchTokenOf(ctx)),
		stack: [],
		selected: undefined,
		branchToken: branchTokenOf(ctx),
		listeners: new Set(),
	};
	SESSIONS.set(key, created);
	// After a plugin reload the listener is still up but serves the previous
	// module's state; point it at this one.
	if (runningWeb(key)) startWeb(webBinding(pi, ctx));
	return created;
}

function webBinding(pi: ExtensionAPI, ctx: ExtensionContext): WebBinding {
	const key = sessionKey(ctx);
	return {
		sessionId: key,
		cwd: ctx.cwd,
		getSession: () => SESSIONS.get(key),
		rankRelated: relatedRanker(() => resolvePlannerJudge(ctx)),
		onChange: () => {
			const session = SESSIONS.get(key);
			if (!session) return;
			persist(pi, session);
			notifyListeners(session);
		},
		submit: (request, prompt) => {
			const session = SESSIONS.get(key);
			if (!session) return { ok: false, error: "the planner session is gone" };
			const outcome = submitRequest(pi, ctx, session, request, prompt);
			// The terminal transcript is where the request runs, so say it there too.
			ctx.ui.notify(`visual planner: ${outcome.ok ? outcome.message : outcome.error}`, outcome.ok ? "info" : "warning");
			return outcome;
		},
	};
}

function readPersisted(ctx: ExtensionContext): PersistedState | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== SESSION_NAMESPACE) continue;
		const data = entry.data as Partial<PersistedState> | undefined;
		if (!data) continue;
		return {
			path: typeof data.path === "string" ? data.path : undefined,
			documentId: typeof data.documentId === "string" ? data.documentId : undefined,
			digest: typeof data.digest === "string" ? data.digest : undefined,
			stack: Array.isArray(data.stack) ? data.stack.filter((id): id is string => typeof id === "string") : [],
			selected: typeof data.selected === "string" ? data.selected : undefined,
			journal: Array.isArray(data.journal) ? (data.journal as JournalEntry[]) : [],
		};
	}
	return undefined;
}

function persist(pi: ExtensionAPI, session: PlannerSession): void {
	const document = session.store.document;
	const journal = session.registry.serialize().map(entry => {
		// Only an execution snapshot is worth restoring; a proposal request's
		// payload is not needed to review its proposal.
		if (entry.kind === "execute") return entry;
		return { ...entry, prompt: "" };
	});
	const state: PersistedState = {
		path: session.store.path,
		documentId: document?.id,
		digest: session.store.diskDigest,
		stack: session.stack,
		selected: session.selected,
		journal,
	};
	pi.appendEntry(SESSION_NAMESPACE, state);
}

function dropStaleNavigation(session: PlannerSession): void {
	const document = session.store.document;
	if (!document) return;
	const diagramIds = new Set<string>();
	const blockIds = new Set<string>();
	const walk = (diagram: { id: string; blocks: { id: string; children: unknown }[] }): void => {
		diagramIds.add(diagram.id);
		for (const block of diagram.blocks) {
			blockIds.add(block.id);
			if (block.children) walk(block.children as { id: string; blocks: { id: string; children: unknown }[] });
		}
	};
	walk(document.root);
	const stack = session.stack.filter(id => diagramIds.has(id));
	session.stack = stack.length > 0 ? stack : [document.root.id];
	if (session.selected !== undefined && !blockIds.has(session.selected)) session.selected = undefined;
}

/**
 * Reload branch metadata, then read the project file. A request owned by the
 * previous branch position is invalidated rather than inherited.
 */
async function adoptSession(pi: ExtensionAPI, ctx: ExtensionContext, mode: "resume" | "move" = "move"): Promise<void> {
	const session = sessionFor(pi, ctx);
	const persisted = readPersisted(ctx);
	const liveToken = branchTokenOf(ctx);
	// Reopening the same session must not treat the new leaf as a branch move.
	session.branchToken = mode === "resume" ? resumeBranchToken(persisted?.journal ?? [], liveToken) : liveToken;
	session.registry.adoptBranch(session.branchToken, persisted?.journal);
	session.stack = persisted?.stack ?? [];
	session.selected = persisted?.selected;
	const path = resolveSessionPath(persisted?.path, ctx.cwd);
	const result = await session.store.open(path);
	if (result.ok) {
		if (persisted?.digest !== undefined && session.store.diskDigest !== persisted.digest) {
			ctx.ui.notify(`visual planner: ${displayPath(path, ctx.cwd)} changed on disk since the last request`, "warning");
		}
	} else if (result.kind === "missing" && persisted?.path !== undefined) {
		ctx.ui.notify(
			`visual planner: no project document at ${displayPath(path, ctx.cwd)}; /diagram new starts one`,
			"warning",
		);
	}
	dropStaleNavigation(session);
}

async function prepareDefault(ctx: ExtensionCommandContext, session: PlannerSession): Promise<string | undefined> {
	if (session.store.document) return undefined;
	const path = defaultDocumentPath(ctx.cwd);
	const result = await session.store.open(path);
	if (result.ok) {
		dropStaleNavigation(session);
		return undefined;
	}
	// Nothing on disk yet: the overlay opens on an in-memory document whose empty
	// state offers Add Block and Draft from Prompt, and keeps the default path.
	return result.kind === "missing"
		? `no project document at ${displayPath(path, ctx.cwd)}; add blocks, then press s to choose a path`
		: `could not open ${displayPath(path, ctx.cwd)}: ${result.errors.join("; ")}`;
}

async function runScreen(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	session: PlannerSession,
	start: ScreenStart | undefined,
	notice: string | undefined,
): Promise<void> {
	const branchKey = session.branchToken;
	let screen: DiagramScreen | undefined;
	const result = await ctx.ui.custom<ScreenResult>(
		(tui, theme, _keybindings, done) => {
			screen = new DiagramScreen(
				{
					tui,
					theme,
					ui: ctx.ui,
					store: session.store,
					registry: session.registry,
					arktype: pi.arktype,
					cwd: ctx.cwd,
					branchKey,
					documentPathHint: defaultDocumentPath(ctx.cwd),
					hasUI: ctx.hasUI,
					isIdle: () => ctx.isIdle(),
					hasPendingMessages: () => ctx.hasPendingMessages(),
					rankRelated: relatedRanker(() => resolvePlannerJudge(ctx)),
					initialSelection: session.selected,
					link: {
						// Focus is shared: web mode reads it on its next poll.
						publish: (selected, stack) => {
							session.selected = selected;
							session.stack = stack;
						},
						subscribe: listener => {
							const notify = () => listener({ selected: session.selected, stack: session.stack });
							session.listeners.add(notify);
							return () => session.listeners.delete(notify);
						},
					},
					externalEditor: (() => {
						const command = editorCommand();
						return command === undefined ? undefined : (text: string, name: string) => editInEditor(command, text, name);
					})(),
				},
				done,
				start,
			);
			if (notice !== undefined) screen.setMessage(notice);
			return screen;
		},
		{
			overlay: true,
			overlayOptions: { fullscreen: true, mouseTracking: false, width: "100%", maxHeight: "100%", margin: 0 },
		},
	);
	if (screen) {
		session.stack = screen.navigationStack();
		session.selected = screen.navigationSelection();
	}
	dropStaleNavigation(session);
	persist(pi, session);

	if (result.kind === "submit") {
		const outcome = submitRequest(pi, ctx, session, result.request, result.prompt);
		ctx.ui.notify(`visual planner: ${outcome.ok ? outcome.message : outcome.error}`, outcome.ok ? "info" : "warning");
		return;
	}
	const staged = session.registry
		.entries.filter(entry => entry.state === "staged" && entry.branchKey === branchKey)
		.at(-1);
	if (staged) {
		ctx.ui.notify(`visual planner: proposal staged for ${staged.label}; reopen /diagram and press R to review`, "info");
	}
}

/** Register a request and hand its prompt to the agent. Shared by the overlay and web mode. */
function submitRequest(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	session: PlannerSession,
	request: BeginInput,
	prompt: string,
): { ok: true; message: string } | { ok: false; error: string } {
	if (!ctx.isIdle() || ctx.hasPendingMessages()) {
		return { ok: false, error: "OMP is busy; finish or cancel the current task before submitting." };
	}
	const began = session.registry.begin(request);
	if (!began.ok) return { ok: false, error: began.errors.join("; ") };
	persist(pi, session);
	pi.sendUserMessage(prompt, { attribution: "agent" });
	return {
		ok: true,
		message:
			request.kind === "execute"
				? `sent to the agent: ${request.label}. The plan does not change by itself; mark the block done once you have checked the work.`
				: `sent to the agent: ${request.label}. Its proposal comes back for your review; nothing changes until you accept it.`,
	};
}

const NEW_TITLES: Record<Purpose, string> = { brainstorm: "New brainstorm", plan: "New plan", explore: "New map" };

const HELP_TEXT = [
	"/diagram                        open the active document (or offer New/Open)",
	"/diagram new [brainstorm|plan|explore]   start a new document (default: plan)",
	"/diagram open <path>            open a document at a path",
	"/diagram draft [brainstorm]     draft a plan (or seed a mind map) from a prompt",
	"/diagram discover [path]        map an existing codebase (default: cwd)",
	"/diagram web                    open this session's planner in the browser (local server)",
	"/diagram web stop               stop the local server",
].join("\n");

const COMPLETIONS = [
	"new",
	"new brainstorm",
	"new plan",
	"new explore",
	"open ",
	"draft",
	"draft brainstorm",
	"discover",
	"web",
	"web stop",
	"help",
];

export default function ompVisualPlanner(pi: ExtensionAPI): void {
	const toolSchemas = toolSchemasFor(pi.arktype);

	pi.registerCommand("diagram", {
		description: "Open the visual planner (new/open/draft/discover/web)",
		getArgumentCompletions: prefix => {
			const matches = COMPLETIONS.filter(item => item.startsWith(prefix));
			return matches.length > 0 ? matches.map(item => ({ value: item, label: item })) : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "web stop") {
				const stopped = stopWeb(sessionKey(ctx));
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(stopped ? "visual planner: web server stopped" : "visual planner: no web server is running", "info");
				return;
			}
			if (command === "web") {
				const session = await ensureSession(pi, ctx);
				const notice = await prepareDefault(ctx, session);
				const reused = runningWeb(sessionKey(ctx)) !== undefined;
				const handle = startWeb(webBinding(pi, ctx));
				const link = `${handle.url}?token=${handle.token}`;
				ctx.ui.setStatus(STATUS_KEY, `planner ${handle.url}`);
				openBrowser(link);
				ctx.ui.notify(
					[
						`visual planner: ${reused ? "web server already running" : "web server started"} at ${handle.url}`,
						`open: ${link}`,
						"stop with /diagram web stop; it also stops when this session ends",
						...(notice ? [notice.replace(/; add blocks.*$/, "; create one from the page")] : []),
					].join("\n"),
					"info",
				);
				return;
			}
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("visual planner: the diagram overlay needs an interactive terminal session.", "error");
				return;
			}
			const trimmed = args.trim();
			if (trimmed === "help") {
				ctx.ui.notify(HELP_TEXT, "info");
				return;
			}
			const session = await ensureSession(pi, ctx);
			if (trimmed === "new" || trimmed.startsWith("new ")) {
				const argument = trimmed.slice("new".length).trim() || "plan";
				const purpose = PURPOSES.find(candidate => candidate === argument);
				if (!purpose) {
					ctx.ui.notify(HELP_TEXT, "info");
					return;
				}
				const document = session.store.newDocument({ title: NEW_TITLES[purpose], purpose }, defaultDocumentPath(ctx.cwd));
				session.stack = [document.root.id];
				session.selected = undefined;
				await runScreen(pi, ctx, session, undefined, undefined);
				return;
			}
			if (trimmed.startsWith("open ")) {
				const target = trimmed.slice("open ".length).trim();
				if (target.length === 0) {
					ctx.ui.notify(HELP_TEXT, "info");
					return;
				}
				const opened = await session.store.open(target);
				if (!opened.ok) {
					ctx.ui.notify(`visual planner: ${opened.errors.join("; ")}`, "error");
					return;
				}
				dropStaleNavigation(session);
				session.selected = undefined;
				await runScreen(pi, ctx, session, undefined, opened.kind === "legacy-import" ? opened.summary : undefined);
				return;
			}
			if (trimmed === "draft" || trimmed === "draft brainstorm" || trimmed === "draft plan") {
				const notice = await prepareDefault(ctx, session);
				const purpose = trimmed === "draft brainstorm" ? "brainstorm" : "plan";
				await runScreen(pi, ctx, session, { action: "draft", purpose }, notice);
				return;
			}
			if (trimmed === "discover" || trimmed.startsWith("discover ")) {
				const target = trimmed.startsWith("discover ") ? trimmed.slice("discover ".length).trim() : ".";
				await runScreen(pi, ctx, session, { action: "discover", target: target.length > 0 ? target : "." }, undefined);
				return;
			}
			const notice = await prepareDefault(ctx, session);
			await runScreen(pi, ctx, session, undefined, notice);
		},
	});

	pi.registerTool({
		name: "visual_planner_read",
		label: "Visual planner read",
		description:
			"Read the active omp-visual-planner document (or one block/diagram scope) with its revision and ids. Read before proposing a change.",
		parameters: toolSchemas.read,
		approval: "read",
		loadMode: "discoverable",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const session = await ensureSession(pi, ctx);
			const document = session.store.document;
			if (!document) {
				return {
					content: [
						{
							type: "text" as const,
							text: "no visual planner document is open in this session; ask the user to run /diagram",
						},
					],
					details: { error: "no-document" },
					isError: true,
				};
			}
			const scope: Scope = params.scope ?? { kind: "diagram", id: session.stack.at(-1) ?? document.root.id };
			const resolved = resolveScope(document, scope);
			if (!resolved) {
				const id = scope.id === undefined ? "" : ` "${scope.id}"`;
				return {
					content: [{ type: "text" as const, text: `no ${scope.kind}${id} in this document` }],
					details: { error: "unknown-scope", scope },
					isError: true,
				};
			}
			const lines = [
				`document ${document.id} "${document.title}" revision ${document.revision}${session.store.dirty ? " (unsaved edits)" : ""}`,
				`scope: ${resolved.label}`,
			];
			for (const location of resolved.locations) {
				const indent = "  ".repeat(Math.max(0, location.ancestors.length));
				const uses = location.block.uses;
				const usesPart = uses?.length ? ` uses ${uses.map(id => `[${id}]`).join(" ")}` : "";
				lines.push(
					`${indent}- [${location.block.id}] ${location.block.title} (${location.block.evidence})${usesPart}`,
				);
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					documentId: document.id,
					revision: document.revision,
					dirty: session.store.dirty,
					scope,
					document,
				},
			};
		},
	});

	pi.registerTool({
		name: "visual_planner_propose",
		label: "Visual planner propose",
		description:
			"Stage a proposal for a pending omp-visual-planner request. Only a human-reviewed proposal is applied, and only for the request token that asked for it.",
		parameters: toolSchemas.propose,
		approval: "write",
		loadMode: "discoverable",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const session = await ensureSession(pi, ctx);
			const document = session.store.document;
			if (!document) {
				return {
					content: [{ type: "text" as const, text: "no visual planner document is open in this session" }],
					details: { error: "no-document" },
					isError: true,
				};
			}
			const diskDigest = await session.store.currentDiskDigest();
			const outcome = session.registry.stage(params.requestId, params.summary, params.replacement, {
				branchKey: session.branchToken,
				documentId: document.id,
				document,
				diskDigest,
				arktype: pi.arktype,
			});
			if (!outcome.ok) {
				return {
					content: [{ type: "text" as const, text: `proposal refused: ${outcome.errors.join("; ")}` }],
					details: { requestId: params.requestId, staged: false, errors: outcome.errors },
					isError: true,
				};
			}
			persist(pi, session);
			notifyListeners(session);
			// The overlay closes when a request is submitted, so the human is
			// usually back in the transcript when this arrives: say so here
			// instead of waiting to be discovered in the planner.
			ctx.ui.notify(
				`visual planner: proposal staged for ${outcome.entry.label} — run /diagram to review it`,
				"info",
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `proposal staged for review: ${outcome.proposal.summary}\nIt has NOT been applied — the human accepts or rejects it in the planner overlay. Do not edit the architecture JSON directly.`,
					},
				],
				details: {
					requestId: params.requestId,
					staged: true,
					scope: outcome.entry.scope,
					summary: outcome.proposal.summary,
				},
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await adoptSession(pi, ctx, "resume");
	});
	pi.on("session_branch", async (_event, ctx) => {
		await adoptSession(pi, ctx, "move");
	});
	pi.on("session_tree", async (_event, ctx) => {
		await adoptSession(pi, ctx, "move");
	});
	pi.on("session_switch", async (_event, ctx) => {
		await adoptSession(pi, ctx, "resume");
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopWeb(sessionKey(ctx));
		SESSIONS.delete(sessionKey(ctx));
	});
}
