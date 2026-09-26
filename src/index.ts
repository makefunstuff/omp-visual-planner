/**
 * omp-visual-planner: registration and session lifecycle.
 *
 * One planner session per OMP session: a document store, a request journal, and
 * navigation state persisted in this extension's session-metadata namespace.
 * Nothing here patches OMP core or global configuration.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { JournalEntry } from "./actions.ts";
import { ActionRegistry } from "./actions.ts";
import { resolveScope } from "./compose.ts";
import type { Scope } from "./model.ts";
import { toolSchemasFor } from "./model.ts";
import { DocumentStore, SESSION_NAMESPACE, defaultDocumentPath, displayPath } from "./store.ts";
import type { ScreenResult, ScreenStart } from "./ui.ts";
import { DiagramScreen } from "./ui.ts";

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
		await adoptSession(pi, ctx);
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
	};
	SESSIONS.set(key, created);
	return created;
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
async function adoptSession(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const session = sessionFor(pi, ctx);
	const persisted = readPersisted(ctx);
	// A real branch/tree/session move is the only thing that reassigns
	// ownership, and adopting the new token marks the old position's requests
	// stale instead of inheriting them.
	session.branchToken = branchTokenOf(ctx);
	session.registry.adoptBranch(session.branchToken, persisted?.journal);
	session.stack = persisted?.stack ?? [];
	session.selected = persisted?.selected;
	const path = persisted?.path ?? defaultDocumentPath(ctx.cwd);
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
		await submitRequest(pi, ctx, session, result);
		return;
	}
	const staged = session.registry
		.entries.filter(entry => entry.state === "staged" && entry.branchKey === branchKey)
		.at(-1);
	if (staged) {
		ctx.ui.notify(`visual planner: proposal staged for ${staged.label}; reopen /diagram and press R to review`, "info");
	}
}

async function submitRequest(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	session: PlannerSession,
	result: Extract<ScreenResult, { kind: "submit" }>,
): Promise<void> {
	if (!ctx.isIdle() || ctx.hasPendingMessages()) {
		ctx.ui.notify("visual planner: OMP is busy; finish or cancel the current task before submitting.", "warning");
		return;
	}
	const began = session.registry.begin(result.request);
	if (!began.ok) {
		ctx.ui.notify(`visual planner: ${began.errors.join("; ")}`, "error");
		return;
	}
	persist(pi, session);
	pi.sendUserMessage(result.prompt, { attribution: "agent" });
	ctx.ui.notify(
		result.request.kind === "execute"
			? `visual planner: execution request ${result.request.requestId} submitted (${result.request.label}); the diagram will not change by itself`
			: `visual planner: request ${result.request.requestId} submitted (${result.request.label}); it is not complete until a proposal is reviewed`,
		"info",
	);
}

const HELP_TEXT = [
	"/diagram                   open the active document (or offer New/Open)",
	"/diagram new               start a new document",
	"/diagram open <path>       open a document at a path",
	"/diagram draft             draft an architecture from a brief",
	"/diagram discover [path]   map an existing codebase (default: cwd)",
].join("\n");

export default function ompVisualPlanner(pi: ExtensionAPI): void {
	const toolSchemas = toolSchemasFor(pi.arktype);

	pi.registerCommand("diagram", {
		description: "Open the visual architecture planner (open/new/draft/discover)",
		getArgumentCompletions: prefix => {
			const matches = ["new", "open ", "draft", "discover", "help"].filter(item => item.startsWith(prefix));
			return matches.length > 0 ? matches.map(item => ({ value: item, label: item })) : null;
		},
		handler: async (args, ctx) => {
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
			if (trimmed === "new") {
				const document = session.store.newDocument({ title: "New architecture" }, defaultDocumentPath(ctx.cwd));
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
			if (trimmed === "draft") {
				const notice = await prepareDefault(ctx, session);
				await runScreen(pi, ctx, session, { action: "draft" }, notice);
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
				lines.push(`${indent}- [${location.block.id}] ${location.block.title} (${location.block.evidence})`);
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
		await adoptSession(pi, ctx);
	});
	pi.on("session_branch", async (_event, ctx) => {
		await adoptSession(pi, ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		await adoptSession(pi, ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		await adoptSession(pi, ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		SESSIONS.delete(sessionKey(ctx));
	});
}
