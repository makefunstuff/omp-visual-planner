/**
 * The plan tree: a directory of markdown files, one directory per node.
 *
 * A node is a directory; its `index.md` is the node's text, every subdirectory
 * except `design/` and dot-names is a child, and links between nodes are the
 * diagram's arrows. This module only reads: nothing here writes to the tree.
 * The format is specified once, in skills/plan-tree/SKILL.md.
 */
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Heading, Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";

export type Status = "open" | "settled" | "done";
export type Venue = "subagent" | "worktree";

export interface SourceLink {
	/** Relative to the repository, POSIX. */
	path: string;
	startLine?: number;
	endLine?: number;
}

export interface Arrow {
	/** The target node's path. */
	to: string;
	label: string;
}

export interface TreeNode {
	/** Relative to the tree root, POSIX; `""` for the root. */
	path: string;
	/** The directory name. */
	name: string;
	title: string;
	status: Status;
	/** Absent means this session. */
	venue?: Venue;
	body: string;
	arrows: Arrow[];
	sources: SourceLink[];
	/** Present when the node has a `design/` folder. */
	design?: { markdown?: string; preview: boolean };
	children: TreeNode[];
	problems: string[];
}

export interface PlanTree {
	version: string;
	/** The root relative to the repository (POSIX), or its absolute path when outside it. */
	rootLabel: string;
	root: TreeNode;
}

export class TreeError extends Error {
	override name = "TreeError";
}

const STATUSES: readonly Status[] = ["open", "settled", "done"];
const DESIGN = "design";

// ---------------------------------------------------------------------------
// One index.md
// ---------------------------------------------------------------------------

export interface ParsedIndex {
	status: Status;
	venue?: Venue;
	title?: string;
	body: string;
	links: { href: string; label: string }[];
	problems: string[];
}

/** A leading `---` line up to the next `---` line; the rest is markdown. */
function splitFrontMatter(text: string): { yaml: string | undefined; markdown: string } {
	const open = /^---[ \t]*\r?\n/.exec(text);
	if (!open) return { yaml: undefined, markdown: text };
	const close = /^---[ \t]*(?:\r?\n|$)/m;
	const rest = text.slice(open[0].length);
	const end = close.exec(rest);
	if (!end) return { yaml: undefined, markdown: text };
	return { yaml: rest.slice(0, end.index), markdown: rest.slice(end.index + end[0].length) };
}

function readFrontMatter(yaml: string, problems: string[]): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(yaml);
	} catch (error) {
		problems.push(`front matter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
	if (parsed === null || parsed === undefined) return {};
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		problems.push("front matter must be key: value pairs");
		return {};
	}
	return parsed as Record<string, unknown>;
}

function eachNode(node: Nodes, visit: (node: Nodes) => void): void {
	visit(node);
	if ("children" in node) for (const child of node.children) eachNode(child, visit);
}

/** Front matter, title, body and every link of one `index.md`. Pure. */
export function parseIndex(text: string): ParsedIndex {
	const problems: string[] = [];
	const { yaml, markdown } = splitFrontMatter(text);
	const fields = yaml === undefined ? {} : readFrontMatter(yaml, problems);

	let status: Status = "open";
	if (fields.status !== undefined) {
		if (STATUSES.includes(fields.status as Status)) status = fields.status as Status;
		else problems.push("status must be open, settled or done");
	}
	let venue: Venue | undefined;
	if (fields.venue !== undefined) {
		if (fields.venue === "subagent" || fields.venue === "worktree") venue = fields.venue;
		else if (fields.venue !== "here") problems.push("venue must be here, subagent or worktree");
	}

	const tree: Root = fromMarkdown(markdown);
	const heading = tree.children.find((node): node is Heading => node.type === "heading" && node.depth === 1);
	let title: string | undefined;
	let body = markdown;
	if (heading) {
		title = toString(heading).trim() || undefined;
		const start = heading.position?.start.offset;
		const end = heading.position?.end.offset;
		if (start !== undefined && end !== undefined) body = markdown.slice(0, start) + markdown.slice(end);
	}
	body = body.replace(/^(?:[ \t]*\r?\n)+/, "");

	const definitions = new Map<string, string>();
	eachNode(tree, node => {
		if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
	});
	const links: { href: string; label: string }[] = [];
	eachNode(tree, node => {
		if (node.type === "link") links.push({ href: node.url, label: toString(node).trim() });
		else if (node.type === "linkReference") {
			const href = definitions.get(node.identifier);
			if (href !== undefined) links.push({ href, label: toString(node).trim() });
		}
	});

	return { status, ...(venue ? { venue } : {}), ...(title !== undefined ? { title } : {}), body, links, problems };
}

// ---------------------------------------------------------------------------
// Walking the directories
// ---------------------------------------------------------------------------

/** `path` relative to `base` (POSIX) when inside it, else absolute. */
export function displayPath(path: string, base: string): string {
	const rel = relative(resolve(base), resolve(path));
	if (rel === "") return ".";
	if (isOutside(rel)) return resolve(path);
	return toPosix(rel);
}

function toPosix(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

function isOutside(rel: string): boolean {
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

interface Walked {
	path: string;
	dir: string;
	name: string;
	index: Stats | undefined;
	designDir: boolean;
	designMd: Stats | undefined;
	preview: Stats | undefined;
	children: Walked[];
}

async function regularFile(path: string): Promise<Stats | undefined> {
	try {
		const stats = await lstat(path);
		return stats.isFile() ? stats : undefined;
	} catch {
		return undefined;
	}
}

async function walk(dir: string, path: string, name: string): Promise<Walked> {
	let entries: Dirent[] = [];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		// unreadable: a node with no children
	}
	const designDir = entries.some(entry => entry.name === DESIGN && entry.isDirectory());
	const childNames = entries
		.filter(entry => entry.isDirectory() && entry.name !== DESIGN && !entry.name.startsWith("."))
		.map(entry => entry.name)
		.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
	const [index, designMd, preview, children] = await Promise.all([
		regularFile(join(dir, "index.md")),
		designDir ? regularFile(join(dir, DESIGN, "design.md")) : undefined,
		designDir ? regularFile(join(dir, DESIGN, "preview.html")) : undefined,
		Promise.all(childNames.map(child => walk(join(dir, child), path === "" ? child : `${path}/${child}`, child))),
	]);
	return { path, dir, name, index, designDir, designMd, preview, children };
}

function stamp(stats: Stats | undefined): string {
	return stats ? `${stats.mtimeMs}:${stats.size}` : "-";
}

function versionOf(root: Walked): string {
	const lines: string[] = [];
	const add = (node: Walked): void => {
		lines.push(`${node.path}|index.md|${stamp(node.index)}`);
		lines.push(`${node.path}|design/design.md|${stamp(node.designMd)}`);
		lines.push(`${node.path}|design/preview.html|${stamp(node.preview)}`);
		for (const child of node.children) add(child);
	};
	add(root);
	lines.sort();
	return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** Changes whenever a node is added or removed, or any node file changes; `"missing"` without a root. */
export async function treeVersion(rootDir: string): Promise<string> {
	const root = resolve(rootDir);
	if (!(await isDirectory(root))) return "missing";
	return versionOf(await walk(root, "", basename(root)));
}

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

interface Pending {
	node: TreeNode;
	dir: string;
	links: { href: string; label: string }[];
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function build(walked: Walked, pending: Pending[]): Promise<TreeNode> {
	const text = walked.index ? await readText(join(walked.dir, "index.md")) : undefined;
	const problems: string[] = [];
	const parsed = text === undefined ? undefined : parseIndex(text);
	if (text === undefined) problems.push("index.md is missing");
	else problems.push(...parsed!.problems);
	const design = walked.designDir
		? {
				...(walked.designMd ? { markdown: (await readText(join(walked.dir, DESIGN, "design.md"))) ?? "" } : {}),
				preview: walked.preview !== undefined,
			}
		: undefined;
	const node: TreeNode = {
		path: walked.path,
		name: walked.name,
		title: parsed?.title ?? walked.name,
		status: parsed?.status ?? "open",
		...(parsed?.venue ? { venue: parsed.venue } : {}),
		body: parsed?.body ?? "",
		arrows: [],
		sources: [],
		...(design ? { design } : {}),
		children: await Promise.all(walked.children.map(child => build(child, pending))),
		problems,
	};
	pending.push({ node, dir: walked.dir, links: parsed?.links ?? [] });
	return node;
}

type Resolved = { kind: "node"; path: string } | { kind: "source"; source: SourceLink };

function lineRange(fragment: string): { startLine?: number; endLine?: number } {
	const match = /^L(\d+)(?:-L?(\d+))?$/.exec(fragment);
	if (!match) return {};
	const startLine = Number(match[1]);
	return match[2] === undefined ? { startLine } : { startLine, endLine: Number(match[2]) };
}

function resolveLink(href: string, dir: string, rootDir: string, repoDir: string, nodes: ReadonlySet<string>): Resolved | undefined {
	const hash = href.indexOf("#");
	const fragment = hash === -1 ? "" : href.slice(hash + 1);
	let target = hash === -1 ? href : href.slice(0, hash);
	const query = target.indexOf("?");
	if (query !== -1) target = target.slice(0, query);
	try {
		target = decodeURIComponent(target);
	} catch {
		return undefined;
	}
	if (target === "" || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
	const absolute = resolve(dir, target);

	const inRoot = relative(rootDir, absolute);
	if (!isOutside(inRoot)) {
		let path = toPosix(inRoot);
		if (path === "index.md") path = "";
		else if (path.endsWith("/index.md")) path = path.slice(0, -"/index.md".length);
		return nodes.has(path) ? { kind: "node", path } : undefined;
	}
	const inRepo = relative(repoDir, absolute);
	if (inRepo === "" || isOutside(inRepo)) return undefined;
	return { kind: "source", source: { path: toPosix(inRepo), ...lineRange(fragment) } };
}

/** Reads the whole tree; a missing root is a `TreeError`. */
export async function readTree(rootDir: string, repoDir: string): Promise<PlanTree> {
	const root = resolve(rootDir);
	const repo = resolve(repoDir);
	const rootLabel = displayPath(root, repo);
	if (!(await isDirectory(root))) throw new TreeError(`no plan tree at ${rootLabel}: the directory does not exist`);

	const walked = await walk(root, "", basename(root));
	const pending: Pending[] = [];
	const tree = await build(walked, pending);

	const byPath = new Map(pending.map(entry => [entry.node.path, entry.node]));
	const paths = new Set(byPath.keys());
	for (const { node, dir, links } of pending) {
		const arrows = new Set<string>();
		const sources = new Set<string>();
		for (const link of links) {
			const resolved = resolveLink(link.href, dir, root, repo, paths);
			if (!resolved) continue;
			if (resolved.kind === "node") {
				if (resolved.path === node.path) continue;
				const label = link.label || byPath.get(resolved.path)!.title;
				const key = `${resolved.path}\n${label}`;
				if (arrows.has(key)) continue;
				arrows.add(key);
				node.arrows.push({ to: resolved.path, label });
			} else {
				const { path, startLine, endLine } = resolved.source;
				const key = `${path}\n${startLine ?? ""}\n${endLine ?? ""}`;
				if (sources.has(key)) continue;
				sources.add(key);
				node.sources.push(resolved.source);
			}
		}
	}
	return { version: versionOf(walked), rootLabel, root: tree };
}
