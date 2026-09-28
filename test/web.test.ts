import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import { ActionRegistry, type BeginInput } from "../src/actions.ts";
import type { CodeIntel } from "../src/code-intel.ts";
import { linesDigest } from "../src/drift.ts";
import { createBlock, createDocument, findBlockLocation } from "../src/model.ts";
import type { RelatedRanker } from "../src/relevance.ts";
import { DocumentStore, serializeDocument } from "../src/store.ts";
import type { ComposedBatch } from "../src/flow.ts";
import { type WebHandle, type WebSession, type WebState, cookieName, startWeb, stopWeb } from "../src/web.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function harness(options: { rankRelated?: RelatedRanker; codeIntel?: CodeIntel; agentBusy?: () => boolean } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "omp-visual-planner-web-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const document = createDocument({ title: "Service" });
	document.root.blocks.push(createBlock({ id: "api", title: "API", x: 2, y: 2 }), createBlock({ id: "db", title: "DB", x: 30, y: 2 }));
	const path = join(dir, "architecture.json");
	await writeFile(path, serializeDocument(document), "utf8");
	const store = new DocumentStore(type);
	await store.open(path);
	const session: WebSession = {
		store,
		registry: new ActionRegistry("s:leaf"),
		stack: [document.root.id],
		selected: undefined,
		branchToken: "s:leaf",
	};
	let changes = 0;
	const submitted: { request: BeginInput; prompt: string }[] = [];
	const batches: ComposedBatch[] = [];
	const sessionId = `test-${crypto.randomUUID()}`;
	const handle = startWeb({
		sessionId,
		cwd: dir,
		getSession: () => session,
		onChange: () => (changes += 1),
		rankRelated: options.rankRelated,
		codeIntel: options.codeIntel,
		agentBusy: options.agentBusy,
		// What the extension does, minus the agent: register the request.
		submit: (request, prompt) => {
			const began = session.registry.begin(request);
			if (!began.ok) return { ok: false, error: began.errors.join("; ") };
			submitted.push({ request, prompt });
			return { ok: true, message: `request ${request.requestId} submitted` };
		},
		submitBatch: async batch => {
			const began = session.registry.beginBatch(batch.requests);
			if (!began.ok) return { ok: false, error: began.errors.join("; ") };
			batches.push(batch);
			return { ok: true, message: "batch submitted" };
		},
	});
	cleanup.push(() => void stopWeb(sessionId));
	const origin = `http://127.0.0.1:${handle.port}`;
	const cookie = `${cookieName(handle.port)}=${handle.token}`;
	const op = (body: unknown) =>
		fetch(`${origin}/api/op`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
	const state = async () => (await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json()) as WebState;
	return { dir, path, document, store, session, handle, origin, cookie, op, state, submitted, batches, changes: () => changes };
}

describe("web mode access", () => {
	test("the link token is exchanged for a cookie; nothing is served without it", async () => {
		const { handle, origin, cookie } = await harness();
		expect((await fetch(`${origin}/`)).status).toBe(403);
		expect((await fetch(`${origin}/api/state`)).status).toBe(401);
		expect((await fetch(`${origin}/?token=${"0".repeat(64)}`, { redirect: "manual" })).status).toBe(403);

		const exchanged = await fetch(`${origin}/?token=${handle.token}`, { redirect: "manual" });
		expect(exchanged.status).toBe(303);
		expect(exchanged.headers.get("location")).toBe("/");
		expect(exchanged.headers.get("set-cookie")).toContain("HttpOnly");
		expect(exchanged.headers.get("set-cookie")).toContain("SameSite=Strict");

		const page = await fetch(`${origin}/`, { headers: { cookie } });
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
	});

	test("the page carries its characters as text, not as \\u escapes", async () => {
		const { origin, cookie } = await harness();
		const page = await (await fetch(`${origin}/`, { headers: { cookie } })).text();
		// Labels written with non-ASCII characters reach the page as those characters.
		for (const text of ["disconnected from the OMP session — run /diagram web again", "● unsaved", "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", "Proposal to review"]) {
			expect(page).toContain(text);
		}
	});

	test("two sessions' tabs keep separate cookies on the same loopback host", async () => {
		const first = await harness();
		const second = await harness();
		const exchange = async (h: typeof first) =>
			(await fetch(`${h.origin}/?token=${h.handle.token}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
		const a = await exchange(first);
		const b = await exchange(second);
		expect(a.split("=")[0]).not.toBe(b.split("=")[0]);
		// The browser sends both cookies to both ports; each server finds its own.
		const both = `${a}; ${b}`;
		expect((await fetch(`${first.origin}/api/state`, { headers: { cookie: both } })).status).toBe(200);
		expect((await fetch(`${second.origin}/api/state`, { headers: { cookie: both } })).status).toBe(200);
	});

	test("another host name and cross-origin writes are refused", async () => {
		const { handle, cookie, origin, store } = await harness();
		const rebound = await fetch(`${origin}/api/state`, { headers: { cookie, host: `evil.example:${handle.port}` } });
		expect(rebound.status).toBe(421);
		const forged = await fetch(`${origin}/api/op`, {
			method: "POST",
			headers: { cookie, origin: "http://evil.example", "content-type": "application/json" },
			body: JSON.stringify({ op: "addBlock", title: "x" }),
		});
		expect(forged.status).toBe(403);
		expect(store.require().root.blocks).toHaveLength(2);
	});
});

describe("web mode editing", () => {
	test("surface is set and cleared from the page, and nothing else is accepted", async () => {
		const { op, store } = await harness();
		expect((await op({ op: "patchBlock", id: "api", fields: { surface: "page" } })).status).toBe(200);
		expect(findBlockLocation(store.require().root, "api")!.block.surface).toBe("page");

		const bad = await op({ op: "patchBlock", id: "api", fields: { surface: "modal" } });
		expect(bad.status).toBe(400);
		/** Our own server's error envelope; `{ error: string }` is the op API's shape. */
		const refusal = (await bad.json()) as { error: string };
		expect(refusal.error).toContain("surface must be one of");

		expect((await op({ op: "patchBlock", id: "api", fields: { surface: "none" } })).status).toBe(200);
		expect(findBlockLocation(store.require().root, "api")!.block.surface).toBeUndefined();
	});

	test("edits are store transactions: validated, undoable, persisted, saved through the guard", async () => {
		const { op, store, session, path, changes } = await harness();

		const added = await op({ op: "addBlock", title: "Cache", x: 10, y: 8 });
		expect(added.status).toBe(200);
		const id = session.selected!;
		expect(findBlockLocation(store.require().root, id)?.block.title).toBe("Cache");

		expect((await op({ op: "patchBlock", id, fields: { description: "hot keys", evidence: "unknown", acceptanceCriteria: "a\n\n b " } })).status).toBe(200);
		const block = findBlockLocation(store.require().root, id)!.block;
		expect(block).toMatchObject({ description: "hot keys", evidence: "unknown", acceptanceCriteria: ["a", "b"] });

		// Refused by name, and nothing changes.
		const revision = store.require().revision;
		const bad = await op({ op: "patchBlock", id, fields: { children: null } });
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: string }).error).toContain("children");
		expect((await op({ op: "addEdge", from: id, to: id })).status).toBe(400);
		expect((await op({ op: "patchBlock", id, fields: { evidence: "certain" } })).status).toBe(400);
		expect(store.require().revision).toBe(revision);

		expect((await op({ op: "addEdge", from: "api", to: id, label: "reads" })).status).toBe(200);
		expect(store.require().root.edges.at(-1)).toMatchObject({ from: "api", to: id, label: "reads" });

		expect((await op({ op: "undo" })).status).toBe(200);
		expect(store.require().root.edges).toHaveLength(0);
		expect(changes()).toBeGreaterThanOrEqual(3);

		const saved = await op({ op: "save" });
		expect(saved.status).toBe(200);
		const onDisk = JSON.parse(await readFile(path, "utf8"));
		expect(onDisk.root.blocks.map((b: { title: string }) => b.title)).toEqual(["API", "DB", "Cache"]);
	});

	test("entering a block creates its subsystem and navigation follows it", async () => {
		const { op, store, session, origin, cookie } = await harness();
		expect((await op({ op: "enter", id: "api" })).status).toBe(200);
		const inner = findBlockLocation(store.require().root, "api")!.block.children!;
		expect(session.stack).toEqual([store.require().root.id, inner.id]);

		await op({ op: "addBlock", title: "Router" });
		expect(inner.id).toBe(findBlockLocation(store.require().root, "api")!.block.children!.id);
		expect(findBlockLocation(store.require().root, "api")!.block.children!.blocks.map(b => b.title)).toEqual(["Router"]);

		const state = (await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json()) as {
			breadcrumb: { title: string }[];
			version: string;
		};
		expect(state.breadcrumb.map(crumb => crumb.title)).toEqual(["Service", "API"]);
		// Unchanged state answers 204 so the page's poll is cheap.
		expect((await fetch(`${origin}/api/state?since=${encodeURIComponent(state.version)}`, { headers: { cookie } })).status).toBe(204);

		expect((await op({ op: "navigate", diagramId: store.require().root.id })).status).toBe(200);
		expect(session.stack).toEqual([store.require().root.id]);
	});

	test("status and order are edits; the flow the page reads follows them", async () => {
		const { op, store, state } = await harness();
		expect((await state()).flow?.progress).toBe("0/2 planned · 0 done");
		expect((await op({ op: "setStatus", id: "api", status: "settled" })).status).toBe(200);
		expect((await state()).flow?.progress).toBe("1/2 planned · 0 done");
		expect((await op({ op: "setStatus", id: "api", status: "finished" })).status).toBe(400);

		const first = await op({ op: "reorder", id: "api", delta: -1 });
		expect(first.status).toBe(400);
		expect(((await first.json()) as { error: string }).error).toBe("already first");
		expect((await op({ op: "reorder", id: "api", delta: 1 })).status).toBe(200);
		expect(store.require().root.blocks.map(block => block.id)).toEqual(["db", "api"]);

		expect((await op({ op: "setPurpose", purpose: "explore" })).status).toBe(200);
		const explored = await state();
		expect(explored.flow?.progress).toBe("1/2 explored");
	});

	test("a child block creates the parent's subsystem and takes focus", async () => {
		const { op, store, session } = await harness();
		expect((await op({ op: "addBlock", title: "Router", parentId: "api" })).status).toBe(200);
		const inner = findBlockLocation(store.require().root, "api")!.block.children!;
		expect(inner.blocks.map(block => block.title)).toEqual(["Router"]);
		expect(session.selected).toBe(inner.blocks[0]!.id);
		expect(session.stack).toEqual([store.require().root.id, inner.id]);
	});

	test("link, extract and unlink a reusable block from the web", async () => {
		const { op, state, store, session } = await harness();
		expect((await op({ op: "addBlock", parentId: "api", title: "Router" })).status).toBe(200);
		const router = session.selected as string;

		expect((await op({ op: "addUse", id: router, target: "db" })).status).toBe(200);
		expect(findBlockLocation(store.require().root, router)!.block.uses).toEqual(["db"]);
		const linked = await state();
		expect(linked.flow!.useCandidates.map(candidate => candidate.id)).toEqual(["db"]);

		const rootId = store.require().root.id;
		expect((await op({ op: "extract", id: router, diagramId: rootId })).status).toBe(200);
		expect(store.require().root.blocks.map(block => block.id)).toEqual(["api", router, "db"]);
		expect(findBlockLocation(store.require().root, "api")!.block.uses).toEqual([router]);

		expect((await op({ op: "removeUse", id: "api", target: router })).status).toBe(200);
		expect(findBlockLocation(store.require().root, "api")!.block.uses).toBeUndefined();
	});
});

describe("web mode requests", () => {
	test("a verb previews without side effects, and unsaved edits must be saved before it is submitted", async () => {
		const { op, store, session, submitted } = await harness();
		const preview = await op({ op: "preview", verb: "refine", id: "api" });
		expect(preview.status).toBe(200);
		expect(((await preview.json()) as { preview: { text: string } }).preview.text).toContain("Refine this block's authored text");
		expect(session.registry.active()).toEqual([]);

		await op({ op: "patchBlock", id: "db", fields: { title: "Postgres" } });
		const refused = await op({ op: "submit", verb: "refine", id: "api" });
		expect(refused.status).toBe(409);
		expect(((await refused.json()) as { needsSave: boolean }).needsSave).toBe(true);
		expect(submitted).toHaveLength(0);

		expect((await op({ op: "submit", verb: "refine", id: "api", saveFirst: true })).status).toBe(200);
		expect(store.dirty).toBe(false);
		expect(submitted).toHaveLength(1);
		expect(submitted[0]!.request).toMatchObject({ kind: "enhance", scope: { kind: "block", id: "api" } });
		expect(session.registry.active()[0]?.requestId).toBe(submitted[0]!.request.requestId);
		expect(submitted[0]!.prompt).toContain(`requestId: ${submitted[0]!.request.requestId}`);
	});

	test("replan and prune use the existing scoped proposal review rather than editing immediately", async () => {
		const { op, store, session, submitted } = await harness();
		const before = serializeDocument(store.require());
		const blockPreview = await op({ op: "preview", verb: "replan", id: "api" });
		expect(blockPreview.status).toBe(200);
		expect((await blockPreview.json() as { preview: { text: string } }).preview.text).toContain("requestId:");
		const projectPreview = await op({ op: "preview", verb: "prune" });
		expect(projectPreview.status).toBe(200);
		expect((await projectPreview.json() as { preview: { text: string } }).preview.text).toContain("replacement");
		expect(serializeDocument(store.require())).toBe(before);
		expect((await op({ op: "submit", verb: "prune" })).status).toBe(200);
		expect(submitted[0]!.request).toMatchObject({ kind: "prune", scope: { kind: "project" } });
		expect(session.registry.active()[0]?.state).toBe("pending");
		expect(serializeDocument(store.require())).toBe(before);
		expect((await op({ op: "discard", requestId: submitted[0]!.request.requestId })).status).toBe(200);
		expect((await op({ op: "submit", verb: "replan" })).status).toBe(200);
		expect(submitted[1]!.request).toMatchObject({ kind: "replan", scope: { kind: "project" } });
	});

	test("a ranking is previewed and submitted, and never reused after an edit", async () => {
		const rankRelated: RelatedRanker = async () => ({
			ok: true,
			context: { judge: "test/jev", ranked: [{ id: "db", probability: 0.88 }] },
			asked: 1,
			elapsedMs: 5,
			cost: 0.00002,
		});
		const { op, submitted } = await harness({ rankRelated });
		const preview = await op({ op: "preview", verb: "refine", id: "api" });
		const body = (await preview.json()) as { preview: { text: string; related?: string } };
		expect(body.preview.related).toStartWith("related context: 1 of 1 blocks");
		expect(body.preview.text).toContain("[db]");
		expect((await op({ op: "submit", verb: "refine", id: "api" })).status).toBe(200);
		expect(submitted[0]!.prompt).toContain("## Related context");
		// The ranking belongs to one revision: an edit between preview and submit drops it.
		await op({ op: "discard", requestId: submitted[0]!.request.requestId });
		await op({ op: "patchBlock", id: "api", fields: { title: "Gateway" } });
		expect((await op({ op: "submit", verb: "refine", id: "api", saveFirst: true })).status).toBe(200);
		expect(submitted[1]!.prompt).not.toContain("## Related context");
	});

	test("a verb the purpose does not offer is refused by name", async () => {
		const { op } = await harness();
		await op({ op: "setPurpose", purpose: "brainstorm" });
		const refused = await op({ op: "preview", verb: "execute", id: "api" });
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: string }).error).toBe("no execute action for a brainstorm document");
	});

	test("a pending request reads as stalled once the agent is idle past the grace, and the page version changes", async () => {
		let busy = true;
		const { session, state } = await harness({ agentBusy: () => busy });
		const began = session.registry.begin({
			requestId: "req-stall",
			kind: "enhance",
			intent: "enhance",
			scope: { kind: "block", id: "api" },
			label: 'block "API"',
			branchKey: "s:leaf",
			documentId: session.store.require().id,
			baseRevision: 0,
			baseDigest: undefined,
			prompt: "",
		});
		if (!began.ok) throw new Error(began.errors.join("; "));
		began.entry.createdAt = new Date(Date.now() - 60_000).toISOString();
		const working = await state();
		expect(working.requests.map(request => [request.state, request.stalled])).toEqual([["pending", false]]);
		busy = false;
		const stalled = await state();
		expect(stalled.requests.map(request => [request.state, request.stalled])).toEqual([["pending", true]]);
		expect(stalled.version).not.toBe(working.version);
	});
});

describe("web mode review", () => {
	function stage(session: WebSession, documentId: string, baseRevision: number) {
		session.registry.begin({
			requestId: "req-1",
			kind: "enhance",
			intent: "enhance",
			scope: { kind: "block", id: "api" },
			label: 'block "API"',
			branchKey: "s:leaf",
			documentId,
			baseRevision,
			baseDigest: undefined,
			prompt: "",
		});
		const staged = session.registry.stage("req-1", "rename the API", createBlock({ id: "api", title: "API v2", x: 2, y: 2 }), {
			branchKey: "s:leaf",
			documentId,
			diskDigest: undefined,
			arktype: type,
		});
		expect(staged.ok).toBe(true);
	}

	test("a staged proposal is shown as a diff and applied only on Accept", async () => {
		const { op, store, session, document, origin, cookie } = await harness();
		stage(session, document.id, 0);

		const state = (await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json()) as WebState;
		expect(state.reviews[0]!.requestId).toBe("req-1");
		expect(state.reviews[0]!.diff.modified).toEqual([
			expect.objectContaining({ title: "API v2", changes: [{ field: "title", from: "API", to: "API v2" }] }),
		]);
		expect(findBlockLocation(store.require().root, "api")!.block.title).toBe("API");

		expect((await op({ op: "accept", requestId: "req-1" })).status).toBe(200);
		expect(findBlockLocation(store.require().root, "api")!.block.title).toBe("API v2");
		expect(session.registry.entryFor("req-1")!.state).toBe("accepted");
		expect(store.dirty).toBe(true);
	});

	test("a block proposal still applies after an unrelated edit", async () => {
		const { op, store, session, document } = await harness();
		stage(session, document.id, 0);
		await op({ op: "patchBlock", id: "db", fields: { title: "Postgres" } });

		expect((await op({ op: "accept", requestId: "req-1" })).status).toBe(200);
		expect(session.registry.entryFor("req-1")!.state).toBe("accepted");
		expect(findBlockLocation(store.require().root, "api")!.block.title).toBe("API v2");
		expect(findBlockLocation(store.require().root, "db")!.block.title).toBe("Postgres");
	});

	test("reject leaves the document untouched", async () => {
		const { op, store, session, document } = await harness();
		stage(session, document.id, 0);
		const revision = store.require().revision;
		expect((await op({ op: "reject", requestId: "req-1" })).status).toBe(200);
		expect(session.registry.entryFor("req-1")!.state).toBe("rejected");
		expect(store.require().revision).toBe(revision);
	});
});

describe("web mode files", () => {
	test("lists the workspace, serves a file inside it, and refuses paths that leave it", async () => {
		const { dir, origin, cookie, op, store } = await harness();
		await mkdir(join(dir, "src"));
		await writeFile(join(dir, "src", "app.ts"), "line one\nline two\n", "utf8");
		await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
		await writeFile(join(dir, "node_modules", "dep", "index.js"), "x", "utf8");
		const outside = await mkdtemp(join(tmpdir(), "omp-visual-planner-outside-"));
		cleanup.push(() => rm(outside, { recursive: true, force: true }));
		await writeFile(join(outside, "secret.txt"), "no", "utf8");
		await symlink(outside, join(dir, "escape"));
		const get = (path: string) => fetch(`${origin}${path}`, { headers: { cookie } });

		const listed = (await (await get("/api/files")).json()) as { files: string[] };
		expect(listed.files).toContain("src/app.ts");
		expect(listed.files.some(file => file.startsWith("node_modules/"))).toBe(false);

		const file = (await (await get("/api/file?path=src/app.ts")).json()) as { lines: string[] };
		expect(file.lines.slice(0, 2)).toEqual(["line one", "line two"]);
		expect((await get("/api/file?path=../etc/passwd")).status).toBe(400);
		expect((await get(`/api/file?path=${encodeURIComponent(join(dir, "src", "app.ts"))}`)).status).toBe(400);
		expect((await get("/api/file?path=escape/secret.txt")).status).toBe(403);
		expect((await fetch(`${origin}/api/files`)).status).toBe(401);

		expect((await op({ op: "addSource", id: "api", path: "src/app.ts", startLine: 2, endLine: 2 })).status).toBe(200);
		expect(findBlockLocation(store.require().root, "api")!.block.sources).toEqual([
			{ path: "src/app.ts", startLine: 2, endLine: 2, digest: linesDigest(["line two"]) },
		]);
		expect((await op({ op: "addSource", id: "api", path: "../x.ts" })).status).toBe(400);
		expect((await op({ op: "removeSource", id: "api", index: 0 })).status).toBe(200);
		expect(findBlockLocation(store.require().root, "api")!.block.sources).toEqual([]);
	});

	test("inspects a cited syntax range without granting file access outside the workspace", async () => {
		const { dir, origin, cookie } = await harness();
		await mkdir(join(dir, "src"));
		await writeFile(join(dir, "src", "app.ts"), "export function serve() {\n  return 42;\n}\n", "utf8");
		const get = (path: string) => fetch(`${origin}${path}`, { headers: { cookie } });
		const inspected = await get("/api/insight?path=src/app.ts&line=1");
		expect(inspected.status).toBe(200);
		const insight = await inspected.json() as { range: { startLine: number; endLine: number }; limitation: string };
		expect(insight.range).toEqual({ startLine: 1, endLine: 3 });
		expect(insight.limitation).toContain("no language server is queried");
		expect((await get("/api/insight?path=../secret.ts&line=1")).status).toBe(400);
		expect((await fetch(`${origin}/api/insight?path=src/app.ts&line=1`)).status).toBe(401);
	});
});

describe("web server lifecycle", () => {
	test("starting twice reuses the server; stop closes the port", async () => {
		const quiet = {
			cwd: "/",
			getSession: () => undefined,
			onChange: () => {},
			submit: () => ({ ok: false as const, error: "" }),
			submitBatch: async () => ({ ok: false as const, error: "" }),
		};
		const again: WebHandle = startWeb({ sessionId: "lifecycle", ...quiet });
		const same = startWeb({ sessionId: "lifecycle", ...quiet });
		expect(same.port).toBe(again.port);
		expect(same.token).toBe(again.token);
		const gone = await fetch(`${again.url}api/state`, { headers: { cookie: `${cookieName(again.port)}=${again.token}` } });
		expect(gone.status).toBe(410);
		expect(stopWeb("lifecycle")).toBe(true);
		await expect(fetch(`${again.url}api/state`)).rejects.toThrow();
	});
});

describe("web mode batches, mockups and change plans", () => {
	test("a batch previews both members, registers both, and each comes back as its own review", async () => {
		const { op, state, session, batches, document } = await harness();
		const preview = await op({ op: "previewBatch", verb: "refine", ids: ["api", "db"] });
		expect(preview.status).toBe(200);
		const previewed = ((await preview.json()) as { preview: { text: string; label: string } }).preview;
		expect(previewed.label).toBe("Refine × 2 blocks");
		expect(session.registry.active()).toEqual([]);

		expect((await op({ op: "submitBatch", verb: "refine", ids: ["api", "db"] })).status).toBe(200);
		const [batch] = batches;
		expect(session.registry.active().map(entry => [entry.scope.id, entry.state])).toEqual([
			["api", "pending"],
			["db", "pending"],
		]);
		for (const request of batch!.requests) expect(batch!.prompt).toContain(`requestId: ${request.requestId}`);
		expect(previewed.text).toContain("# Visual planner batch request");

		for (const request of [...batch!.requests].reverse()) {
			const id = request.scope.id!;
			const staged = session.registry.stage(request.requestId, `refine ${id}`, createBlock({ id, title: `${id} v2`, x: 2, y: 2 }), {
				branchKey: "s:leaf",
				documentId: document.id,
				diskDigest: undefined,
				arktype: type,
			});
			expect(staged.ok).toBe(true);
		}
		expect((await state()).reviews.map(review => review.requestId)).toEqual(batch!.requests.map(request => request.requestId));
	});

	test("execute is refused as a batch", async () => {
		const { op } = await harness();
		const refused = await op({ op: "previewBatch", verb: "execute", ids: ["api", "db"] });
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: string }).error).toBe("no execute batch for a plan document");
	});

	test("the page can clear a mockup but never write one", async () => {
		const { op, store } = await harness();
		store.transact(draft => {
			findBlockLocation(draft.root, "api")!.block.mockup = "<p>API</p>";
		});
		const written = await op({ op: "patchBlock", id: "api", fields: { mockup: "<p/>" } });
		expect(written.status).toBe(400);
		expect(((await written.json()) as { error: string }).error).toBe("mockup can only be cleared here; Sketch draws it");
		expect(findBlockLocation(store.require().root, "api")!.block.mockup).toBe("<p>API</p>");
		expect((await op({ op: "patchBlock", id: "api", fields: { mockup: "" } })).status).toBe(200);
		expect(findBlockLocation(store.require().root, "api")!.block.mockup).toBeUndefined();
	});

	test("a change starts a new plan beside the others and asks the agent to read the code first", async () => {
		const { op, dir, store, submitted } = await harness();
		const started = await op({ op: "submit", start: { kind: "change", goal: "Add export", marked: ["api"] } });
		expect(started.status).toBe(200);
		expect(store.path).toBe(join(dir, ".omp-visual-planner", "changes", "add-export.json"));
		expect(store.require()).toMatchObject({ title: "Add export", purpose: "plan" });
		expect(submitted.at(-1)!.request).toMatchObject({ kind: "change", intent: "change", scope: { kind: "project" } });
		expect(submitted.at(-1)!.prompt).toContain("## Task\nintent: change");
		expect((await op({ op: "submit", start: { kind: "change", goal: "  " } })).status).toBe(400);
	});
});

describe("web mode drift", () => {
	test("check, still true and record baseline work on the citations the page added", async () => {
		const { dir, op, store } = await harness();
		const refused = await op({ op: "preview", verb: "sync", id: "api" });
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: string }).error).toBe("check drift first");

		const checked = await op({ op: "checkDrift" });
		expect(checked.status).toBe(200);
		expect(((await checked.json()) as { state: WebState }).state.drift!.citations).toEqual([]);

		await mkdir(join(dir, "src"));
		await writeFile(join(dir, "src", "app.ts"), "one\ntwo\nthree\n", "utf8");
		expect((await op({ op: "addSource", id: "api", path: "src/app.ts", startLine: 2, endLine: 2 })).status).toBe(200);
		await writeFile(join(dir, "src", "app.ts"), "one\nTWO\nthree\n", "utf8");
		const drifted = (await (await op({ op: "checkDrift" })).json()) as { state: WebState; message: string };
		expect(drifted.state.drift!.counts.changed).toBe(1);
		expect(drifted.state.drift!.syncTargets).toEqual(["api"]);

		const preview = (await (await op({ op: "preview", verb: "sync", id: "api" })).json()) as { preview: { text: string } };
		expect(preview.preview.text).toContain("## Drift");

		const still = (await (await op({ op: "stillTrue", id: "api", index: 0 })).json()) as { state: WebState };
		expect(still.state.drift!.counts.changed).toBe(0);
		expect((await op({ op: "stillTrue", id: "api", index: 0 })).status).toBe(400);

		expect((await op({ op: "recordBaseline" })).status).toBe(200);
		expect(store.require().baseline!.at).toBeString();
	});
});

describe("web mode code-line requests", () => {
	async function withApp(options: Parameters<typeof harness>[0] = {}) {
		const h = await harness(options);
		await mkdir(join(h.dir, "src"));
		await writeFile(join(h.dir, "src", "app.ts"), "a\nb\nc\nd\ne\n", "utf8");
		return h;
	}
	type Answer = { error?: string; preview?: { text: string; request?: { verb: string; id: string } } };

	test("a change request adds a cited block under the focused one and previews Refine", async () => {
		const { op, store } = await withApp();
		expect((await op({ op: "focus", id: "api" })).status).toBe(200);
		const response = await op({ op: "lineRequest", kind: "change", path: "src/app.ts", startLine: 2, endLine: 3, text: "retry on timeout" });
		expect(response.status).toBe(200);
		const answer = (await response.json()) as Answer;
		expect(answer.preview!.request!.verb).toBe("refine");
		expect(answer.preview!.text).toContain("intent: enhance");
		const child = findBlockLocation(store.require().root, "api")!.block.children!.blocks[0]!;
		expect(child.id).toBe(answer.preview!.request!.id);
		expect(child.title).toBe("retry on timeout");
		expect(child.evidence).toBe("observed");
		expect(child.sources).toEqual([{ path: "src/app.ts", startLine: 2, endLine: 3, digest: linesDigest(["b", "c"]) }]);
	});

	test("a question adds a Q: block whose Ask request can be submitted", async () => {
		const { op, store, submitted } = await withApp();
		const answer = (await (await op({ op: "lineRequest", kind: "ask", path: "src/app.ts", startLine: 1, endLine: 1, text: "why a?" })).json()) as Answer;
		expect(answer.preview!.request!.verb).toBe("clarify");
		expect(answer.preview!.text).toContain("intent: clarify");
		const id = answer.preview!.request!.id;
		expect(findBlockLocation(store.require().root, id)!.block.title).toStartWith("Q: ");
		expect((await op({ op: "submit", verb: "clarify", id, saveFirst: true })).status).toBe(200);
		expect(submitted.at(-1)!.request.kind).toBe("clarify");
	});

	test("bad line requests are refused by name", async () => {
		const { op } = await withApp();
		const error = async (body: Record<string, unknown>) => {
			const response = await op({ op: "lineRequest", path: "src/app.ts", startLine: 1, endLine: 1, text: "x", ...body });
			expect(response.status).toBe(400);
			return ((await response.json()) as Answer).error;
		};
		expect(await error({ kind: "ask", text: "  " })).toBe("a question needs text");
		expect(await error({ kind: "change", path: "../x.ts" })).toBe("path must be relative to the workspace");
		expect(await error({ kind: "change", startLine: 3, endLine: 2 })).toBe("lines must be a range starting at 1");
		expect((await op({ op: "setPurpose", purpose: "explore" })).status).toBe(200);
		expect(await error({ kind: "change" })).toBe("in an explore map a change request starts a change plan");
	});

	test("a change plan started from selected lines names them as a starting point", async () => {
		const { op, submitted } = await withApp();
		const response = await op({ op: "submit", start: { kind: "change", goal: "Add retry", lines: { path: "src/app.ts", startLine: 2, endLine: 3 } } });
		expect(response.status).toBe(200);
		expect(submitted.at(-1)!.prompt).toContain("## Starting points");
		expect(submitted.at(-1)!.prompt).toContain("src/app.ts:2-3");
	});

	test("symbol lookups answer unavailable without a language server, and pass a server's answer through with its view", async () => {
		const plain = await withApp();
		const get = (h: typeof plain, path: string) => fetch(`${h.origin}${path}`, { headers: { cookie: h.cookie } });
		expect(await (await get(plain, "/api/symbol?path=src/app.ts&line=1&character=0")).json()).toEqual({
			ok: false,
			reason: "language servers are not available in this session",
		});
		const facts = { hover: "h", definitions: [], references: [{ path: "src/app.ts", line: 1, preview: "x" }], truncated: false };
		const stubbed = await withApp({
			codeIntel: {
				outline: async () => ({ ok: true, server: "stub", value: [] }),
				symbolAt: async () => ({ ok: true, server: "stub", value: facts }),
			},
		});
		const answer = (await (await get(stubbed, "/api/symbol?path=src/app.ts&line=1&character=0")).json()) as { value: unknown; view: unknown };
		expect(answer.value).toEqual(facts);
		expect(answer.view).toEqual({
			hover: [{ kind: "text", text: "h" }],
			definitions: [],
			references: [{ path: "src/app.ts", count: 1, locations: [{ path: "src/app.ts", line: 1, preview: "x", tokens: [["variable", "x"]] }] }],
			referenceTotal: "1",
		});
		expect((await get(stubbed, "/api/symbol?path=src/app.ts&line=0&character=0")).status).toBe(400);
	});
});
