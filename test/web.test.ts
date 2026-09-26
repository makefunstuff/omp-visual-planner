import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import { ActionRegistry, type BeginInput } from "../src/actions.ts";
import { createBlock, createDocument, findBlockLocation } from "../src/model.ts";
import { DocumentStore, serializeDocument } from "../src/store.ts";
import { type WebHandle, type WebSession, type WebState, startWeb, stopWeb } from "../src/web.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function harness() {
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
	const sessionId = `test-${crypto.randomUUID()}`;
	const handle = startWeb({
		sessionId,
		cwd: dir,
		getSession: () => session,
		onChange: () => (changes += 1),
		// What the extension does, minus the agent: register the request.
		submit: (request, prompt) => {
			const began = session.registry.begin(request);
			if (!began.ok) return { ok: false, error: began.errors.join("; ") };
			submitted.push({ request, prompt });
			return { ok: true, message: `request ${request.requestId} submitted` };
		},
	});
	cleanup.push(() => void stopWeb(sessionId));
	const origin = `http://127.0.0.1:${handle.port}`;
	const cookie = `ovp_token=${handle.token}`;
	const op = (body: unknown) =>
		fetch(`${origin}/api/op`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
	const state = async () => (await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json()) as WebState;
	return { dir, path, document, store, session, handle, origin, cookie, op, state, submitted, changes: () => changes };
}

describe("web mode access", () => {
	test("the link token is exchanged for a cookie; nothing is served without it", async () => {
		const { handle, origin } = await harness();
		expect((await fetch(`${origin}/`)).status).toBe(403);
		expect((await fetch(`${origin}/api/state`)).status).toBe(401);
		expect((await fetch(`${origin}/?token=${"0".repeat(64)}`, { redirect: "manual" })).status).toBe(403);

		const exchanged = await fetch(`${origin}/?token=${handle.token}`, { redirect: "manual" });
		expect(exchanged.status).toBe(303);
		expect(exchanged.headers.get("location")).toBe("/");
		expect(exchanged.headers.get("set-cookie")).toContain("HttpOnly");
		expect(exchanged.headers.get("set-cookie")).toContain("SameSite=Strict");

		const page = await fetch(`${origin}/`, { headers: { cookie: `ovp_token=${handle.token}` } });
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
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
});

describe("web mode requests", () => {
	test("a verb previews without side effects, and unsaved edits must be saved before it is submitted", async () => {
		const { op, store, session, submitted } = await harness();
		const preview = await op({ op: "preview", verb: "refine", id: "api" });
		expect(preview.status).toBe(200);
		expect(((await preview.json()) as { preview: { text: string } }).preview.text).toContain("Refine this block's authored text");
		expect(session.registry.pending()).toBeUndefined();

		await op({ op: "patchBlock", id: "db", fields: { title: "Postgres" } });
		const refused = await op({ op: "submit", verb: "refine", id: "api" });
		expect(refused.status).toBe(409);
		expect(((await refused.json()) as { needsSave: boolean }).needsSave).toBe(true);
		expect(submitted).toHaveLength(0);

		expect((await op({ op: "submit", verb: "refine", id: "api", saveFirst: true })).status).toBe(200);
		expect(store.dirty).toBe(false);
		expect(submitted).toHaveLength(1);
		expect(submitted[0]!.request).toMatchObject({ kind: "enhance", scope: { kind: "block", id: "api" } });
		expect(session.registry.pending()?.requestId).toBe(submitted[0]!.request.requestId);
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
		expect(session.registry.pending()?.state).toBe("pending");
		expect(serializeDocument(store.require())).toBe(before);
		expect((await op({ op: "discard", requestId: submitted[0]!.request.requestId })).status).toBe(200);
		expect((await op({ op: "submit", verb: "replan" })).status).toBe(200);
		expect(submitted[1]!.request).toMatchObject({ kind: "replan", scope: { kind: "project" } });
	});

	test("a verb the purpose does not offer is refused by name", async () => {
		const { op } = await harness();
		await op({ op: "setPurpose", purpose: "brainstorm" });
		const refused = await op({ op: "preview", verb: "execute", id: "api" });
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: string }).error).toBe("no execute action for a brainstorm document");
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

		const state = (await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json()) as {
			review: { requestId: string; diff: { modified: { title: string; fields: string[] }[] } };
		};
		expect(state.review.requestId).toBe("req-1");
		expect(state.review.diff.modified).toEqual([expect.objectContaining({ title: "API v2", fields: ["title"] })]);
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
		expect(findBlockLocation(store.require().root, "api")!.block.sources).toEqual([{ path: "src/app.ts", startLine: 2, endLine: 2 }]);
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
		const quiet = { cwd: "/", getSession: () => undefined, onChange: () => {}, submit: () => ({ ok: false as const, error: "" }) };
		const again: WebHandle = startWeb({ sessionId: "lifecycle", ...quiet });
		const same = startWeb({ sessionId: "lifecycle", ...quiet });
		expect(same.port).toBe(again.port);
		expect(same.token).toBe(again.token);
		const gone = await fetch(`${again.url}api/state`, { headers: { cookie: `ovp_token=${again.token}` } });
		expect(gone.status).toBe(410);
		expect(stopWeb("lifecycle")).toBe(true);
		await expect(fetch(`${again.url}api/state`)).rejects.toThrow();
	});
});
