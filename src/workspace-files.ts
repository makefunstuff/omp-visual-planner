/**
 * Read-only access to the workspace for web mode's file tree and viewer.
 *
 * Only paths inside the workspace are served: a request is resolved and then
 * real-pathed, so neither `..` nor a symlink can reach outside it. Files are
 * listed with `git ls-files` when the workspace is a repository (so
 * `.gitignore` applies), otherwise by a bounded walk that skips dependency and
 * build directories.
 */
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { MAX_VIEWER_FILE_BYTES, PROJECT_DIR } from "./store.ts";

export const MAX_LISTED_FILES = 5000;
export const MAX_SERVED_LINES = 5000;

export const SKIPPED_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"vendor",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".venv",
	"__pycache__",
	".next",
	PROJECT_DIR,
]);

export interface FileList {
	files: string[];
	truncated: boolean;
}

export async function listWorkspaceFiles(root: string): Promise<FileList> {
	const git = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd: root,
		stdout: "pipe",
		stderr: "ignore",
	});
	let files: string[];
	if (git.exitCode === 0) {
		files = git.stdout
			.toString()
			.split("\0")
			.filter(path => path.length > 0 && !path.split("/").some(part => SKIPPED_DIRECTORIES.has(part)));
	} else {
		files = [];
		const walk = async (directory: string): Promise<void> => {
			if (files.length > MAX_LISTED_FILES) return;
			const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				const path = directory ? `${directory}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path);
				} else if (entry.isFile()) {
					files.push(path);
				}
			}
		};
		await walk("");
	}
	files.sort();
	return { files: files.slice(0, MAX_LISTED_FILES), truncated: files.length > MAX_LISTED_FILES };
}

/** A workspace-relative path, normalized; undefined when it is absolute or climbs out. */
export function workspacePath(path: string): string | undefined {
	if (path.length === 0 || isAbsolute(path)) return undefined;
	const normal = normalize(path).split(sep).join("/");
	if (normal === ".." || normal.startsWith("../")) return undefined;
	return normal;
}

export type FileRead =
	| { ok: true; path: string; lines: string[]; truncated: boolean }
	| { ok: false; status: number; error: string };

export async function readWorkspaceFile(root: string, path: string): Promise<FileRead> {
	const relativePath = workspacePath(path);
	if (relativePath === undefined) return { ok: false, status: 400, error: "path must be relative to the workspace" };
	const realRoot = await realpath(root);
	let real: string;
	try {
		real = await realpath(resolve(root, relativePath));
	} catch {
		return { ok: false, status: 404, error: `no file ${relativePath}` };
	}
	const inside = relative(realRoot, real);
	if (inside.startsWith("..") || isAbsolute(inside)) return { ok: false, status: 403, error: "that path leaves the workspace" };
	const info = await stat(real);
	if (!info.isFile()) return { ok: false, status: 400, error: `${relativePath} is not a file` };
	if (info.size > MAX_VIEWER_FILE_BYTES) return { ok: false, status: 413, error: `${relativePath} is ${info.size} bytes; the viewer stops at ${MAX_VIEWER_FILE_BYTES}` };
	const text = await readFile(real, "utf8");
	if (text.includes("\0")) return { ok: false, status: 415, error: `${relativePath} is a binary file` };
	const lines = text.split("\n");
	return { ok: true, path: relativePath, lines: lines.slice(0, MAX_SERVED_LINES), truncated: lines.length > MAX_SERVED_LINES };
}
