import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanTree } from "../src/tree.ts";
import { type ViewerHandle, cookieName, startViewer, stopViewer } from "../src/viewer.ts";

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function harness(options: { withRoot?: boolean } = {}) {
	const repo = await mkdtemp(join(tmpdir(), "omp-visual-planner-viewer-"));
	cleanup.push(() => rm(repo, { recursive: true, force: true }));
	const root = join(repo, "docs/plan");
	if (options.withRoot !== false) {
		await mkdir(join(root, "1-ui/design"), { recursive: true });
		await mkdir(join(root, "2-api"), { recursive: true });
		await writeFile(join(root, "index.md"), "# Service\n\nThe goal.\n");
		await writeFile(join(root, "1-ui/index.md"), "# UI\n\nCalls [the API](../2-api/).\n");
		await writeFile(join(root, "1-ui/design/preview.html"), "<p>mockup</p>");
		await writeFile(join(root, "2-api/index.md"), "# API\n");
	}
	const key = `test-${crypto.randomUUID()}`;
	const handle: ViewerHandle = startViewer({ key, rootDir: root, repoDir: repo });
	cleanup.push(() => stopViewer(key));
	const origin = `http://127.0.0.1:${handle.port}`;
	const cookie = `${cookieName(handle.port)}=${handle.token}`;
	const get = (path: string) => fetch(`${origin}${path}`, { headers: { cookie } });
	return { repo, root, handle, origin, cookie, get };
}

describe("viewer access", () => {
	test("the link token is exchanged for a cookie; nothing is served without it", async () => {
		const { handle, origin, cookie } = await harness();
		expect((await fetch(`${origin}/`)).status).toBe(403);
		expect((await fetch(`${origin}/api/tree`)).status).toBe(401);
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

	test("two viewers keep separate cookies on the same loopback host", async () => {
		const first = await harness();
		const second = await harness();
		const exchange = async (h: typeof first) =>
			(await fetch(`${h.origin}/?token=${h.handle.token}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
		const a = await exchange(first);
		const b = await exchange(second);
		expect(a.split("=")[0]).not.toBe(b.split("=")[0]);
		const both = `${a}; ${b}`;
		expect((await fetch(`${first.origin}/api/tree`, { headers: { cookie: both } })).status).toBe(200);
		expect((await fetch(`${second.origin}/api/tree`, { headers: { cookie: both } })).status).toBe(200);
	});

	test("another host name is refused, and nothing but GET is allowed", async () => {
		const { handle, cookie, origin } = await harness();
		expect((await fetch(`${origin}/api/tree`, { headers: { cookie, host: `evil.example:${handle.port}` } })).status).toBe(421);
		const post = await fetch(`${origin}/api/tree`, { method: "POST", headers: { cookie } });
		expect(post.status).toBe(405);
	});
});

describe("viewer api", () => {
	test("/api/tree returns the tree and answers 204 until a file changes", async () => {
		const { root, get } = await harness();
		const response = await get("/api/tree");
		expect(response.status).toBe(200);
		const tree = (await response.json()) as PlanTree;
		expect(tree.rootLabel).toBe("docs/plan");
		expect(tree.root.title).toBe("Service");
		expect(tree.root.children.map(child => child.title)).toEqual(["UI", "API"]);
		expect(tree.root.children[0]!.arrows).toEqual([{ to: "2-api", label: "the API" }]);

		expect((await get(`/api/tree?since=${tree.version}`)).status).toBe(204);
		await writeFile(join(root, "2-api/index.md"), "# API, renamed\n");
		const changed = await get(`/api/tree?since=${tree.version}`);
		expect(changed.status).toBe(200);
		const next = (await changed.json()) as PlanTree;
		expect(next.version).not.toBe(tree.version);
		expect(next.root.children[1]!.title).toBe("API, renamed");
	});

	test("/api/preview serves a node's HTML as text, and nothing outside the tree", async () => {
		const { repo, root, get } = await harness();
		const preview = await get("/api/preview?path=1-ui");
		expect(preview.status).toBe(200);
		expect(preview.headers.get("content-type")).toStartWith("text/plain");
		expect(await preview.text()).toBe("<p>mockup</p>");

		const none = await get("/api/preview?path=2-api");
		expect(none.status).toBe(404);
		expect(await none.json()).toEqual({ error: "no preview for 2-api" });

		await writeFile(join(repo, "secret.html"), "secret");
		await mkdir(join(root, "2-api/design"));
		await symlink(join(repo, "secret.html"), join(root, "2-api/design/preview.html"));
		await get("/api/tree");
		const escaped = await get("/api/preview?path=2-api");
		expect(escaped.status).toBe(404);
		expect(await escaped.json()).toEqual({ error: "no preview for 2-api" });
	});

	test("a missing root is a 404 with its error", async () => {
		const { get } = await harness({ withRoot: false });
		const response = await get("/api/tree");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "no plan tree at docs/plan: the directory does not exist" });
	});
});
