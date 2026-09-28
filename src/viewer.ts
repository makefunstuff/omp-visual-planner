/**
 * The read-only plan view: a loopback server that serves the built page and
 * the plan tree as JSON. It never writes; editing happens in the user's editor.
 *
 * Access: loopback bind, a per-server token exchanged once for an HttpOnly
 * SameSite=Strict cookie, and a Host check against DNS rebinding.
 */
import type { Server } from "bun";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { findNode } from "./layout.ts";
import { type PlanTree, TreeError, readTree, treeVersion } from "./tree.ts";
import { webPage } from "./web-page.ts";

export const WEB_HOSTNAME = "127.0.0.1";
const PREVIEW_LIMIT = 2 * 1024 * 1024;

/**
 * Cookies are scoped by host, not port: two sessions' servers on 127.0.0.1
 * would overwrite one shared cookie and log each other's tab out.
 */
export function cookieName(port: number): string {
	return `ovp_token_${port}`;
}

export interface ViewerHandle {
	url: string;
	port: number;
	token: string;
	rootDir: string;
}

interface Entry {
	server: Server<undefined>;
	port: number;
	token: string;
	rootDir: string;
	repoDir: string;
	cache: { version: string; tree: PlanTree } | undefined;
}

/**
 * Process-wide, so a plugin reload (which re-executes this module) can find the
 * servers the previous module instance started.
 */
const REGISTRY: Map<string, Entry> = ((globalThis as Record<symbol, unknown>)[
	Symbol.for("omp-visual-planner.viewer")
] ??= new Map<string, Entry>()) as Map<string, Entry>;

function handleOf(entry: Entry): ViewerHandle {
	return { url: `http://${WEB_HOSTNAME}:${entry.port}/`, port: entry.port, token: entry.token, rootDir: entry.rootDir };
}

export function runningViewer(key: string): ViewerHandle | undefined {
	const entry = REGISTRY.get(key);
	return entry ? handleOf(entry) : undefined;
}

/**
 * Start, or rebind a running server. A plugin reload re-executes this module
 * while the listener survives in the registry; rebinding swaps in this module's
 * handler and the new root in place, so an open tab keeps its address and cookie.
 */
export function startViewer(options: { key: string; rootDir: string; repoDir: string; port?: number }): ViewerHandle {
	const rootDir = resolve(options.rootDir);
	const repoDir = resolve(options.repoDir);
	const existing = REGISTRY.get(options.key);
	if (existing) {
		existing.rootDir = rootDir;
		existing.repoDir = repoDir;
		existing.cache = undefined;
		existing.server.reload({ fetch: request => handle(existing, request) });
		return handleOf(existing);
	}
	const entry = { port: 0, token: randomBytes(32).toString("hex"), rootDir, repoDir, cache: undefined } as Entry;
	entry.server = Bun.serve({ hostname: WEB_HOSTNAME, port: options.port ?? 0, fetch: request => handle(entry, request) });
	entry.port = entry.server.port ?? 0;
	REGISTRY.set(options.key, entry);
	return handleOf(entry);
}

export function stopViewer(key: string): boolean {
	const entry = REGISTRY.get(key);
	if (!entry) return false;
	entry.server.stop(true);
	REGISTRY.delete(key);
	return true;
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

async function currentTree(entry: Entry, version: string): Promise<PlanTree> {
	if (entry.cache?.version === version) return entry.cache.tree;
	const tree = await readTree(entry.rootDir, entry.repoDir);
	entry.cache = { version: tree.version, tree };
	return tree;
}

async function preview(entry: Entry, path: string): Promise<Response> {
	const missing = json({ error: `no preview for ${path}` }, 404);
	const tree = entry.cache?.tree ?? (await currentTree(entry, await treeVersion(entry.rootDir)));
	if (!findNode(tree.root, path)?.design?.preview) return missing;
	let file: string;
	let rootReal: string;
	try {
		file = await realpath(join(entry.rootDir, path, "design", "preview.html"));
		rootReal = await realpath(entry.rootDir);
	} catch {
		return missing;
	}
	const rel = relative(rootReal, file);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return missing;
	try {
		if ((await stat(file)).size > PREVIEW_LIMIT) return json({ error: "preview is larger than 2 MB" }, 413);
		return new Response(await readFile(file, "utf8"), {
			headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
		});
	} catch {
		return missing;
	}
}

async function handle(entry: Entry, request: Request): Promise<Response> {
	const url = new URL(request.url);
	// DNS rebinding: a page on another name resolving to loopback must not reach us.
	if (request.headers.get("host") !== `${WEB_HOSTNAME}:${entry.port}`) {
		return new Response("wrong host", { status: 421, headers: SECURITY_HEADERS });
	}
	if (request.method !== "GET") {
		return new Response("method not allowed", { status: 405, headers: { ...SECURITY_HEADERS, allow: "GET" } });
	}

	if (url.pathname === "/") {
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
			return new Response("open the link printed by /diagram", { status: 403, headers: SECURITY_HEADERS });
		}
		return new Response(await webPage(), {
			headers: {
				...SECURITY_HEADERS,
				"content-type": "text/html; charset=utf-8",
				"content-security-policy":
					"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			},
		});
	}

	if (url.pathname !== "/api/tree" && url.pathname !== "/api/preview") {
		return new Response("not found", { status: 404, headers: SECURITY_HEADERS });
	}
	if (!sameToken(cookieToken(request, entry.port), entry.token)) return json({ error: "unauthorized" }, 401);

	if (url.pathname === "/api/preview") return preview(entry, url.searchParams.get("path") ?? "");

	const version = await treeVersion(entry.rootDir);
	if (version !== "missing" && url.searchParams.get("since") === version) {
		return new Response(null, { status: 204, headers: SECURITY_HEADERS });
	}
	try {
		return json(await currentTree(entry, version));
	} catch (error) {
		if (error instanceof TreeError) return json({ error: error.message }, 404);
		throw error;
	}
}
