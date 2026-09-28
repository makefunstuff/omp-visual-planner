/**
 * Drift between the diagram and the code it cites.
 *
 * Every citation carries a fingerprint of the lines it cited when it was made.
 * A check re-reads each cited file and classifies the citation: still the same
 * (`fresh`), the same lines at a new position (`moved`), different lines
 * (`changed`), gone (`missing`), never fingerprinted (`unstamped`), or not
 * readable here (`unchecked`). It also lists files changed since the recorded
 * git baseline that no block cites.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type Block,
	type Diagram,
	type DiagramDocument,
	eachBlock,
	findBlockLocation,
	type SourceRef,
} from "./model.ts";
import { digestOfText } from "./store.ts";
import { type FileRead, MAX_SERVED_LINES, readWorkspaceFile, SKIPPED_DIRECTORIES, workspacePath } from "./workspace-files.ts";

export type CitationState = "fresh" | "moved" | "changed" | "missing" | "unstamped" | "unchecked";

export interface CitationCheck {
	blockId: string;
	title: string;
	/** Index of the citation in the block's `sources`. */
	index: number;
	source: SourceRef;
	state: CitationState;
	movedTo?: { startLine: number; endLine: number };
	reason?: string;
}

export interface DriftReport {
	documentId: string;
	revision: number;
	checkedAt: string;
	/** Every citation in the document, in document order. */
	citations: CitationCheck[];
	uncovered: { ok: true; commit: string; files: string[]; truncated: boolean } | { ok: false; reason: string };
}

/** What a Sync request is told about the citations that drifted. */
export interface SyncContext {
	commit?: string;
	citations: CitationCheck[];
}

/** Where a session keeps its latest report, shared between the terminal and the browser. */
export interface DriftHolder {
	drift?: DriftReport;
}

const MAX_UNCOVERED = 200;
const MAX_RELOCATION_WORK = 2_000_000;

export function linesDigest(lines: readonly string[]): string {
	return digestOfText(lines.map(line => line.replace(/\s+$/, "")).join("\n"));
}

export function refKey(source: SourceRef): string {
	return `${source.path}:${source.startLine ?? ""}:${source.endLine ?? ""}`;
}

type Entry = { kind: "directory" } | { kind: "file"; read: FileRead };

/** Reads each path once per call. */
function reader(cwd: string): (path: string) => Promise<Entry> {
	const cache = new Map<string, Promise<Entry>>();
	return path => {
		let entry = cache.get(path);
		if (entry === undefined) {
			entry = (async (): Promise<Entry> => {
				const info = await stat(resolve(cwd, path)).catch(() => undefined);
				if (info?.isDirectory()) return { kind: "directory" };
				return { kind: "file", read: await readWorkspaceFile(cwd, path) };
			})();
			cache.set(path, entry);
		}
		return entry;
	};
}

type Cited = { ok: true; lines: string[] } | { ok: false; why: "truncated" | "range" };

/** The lines a citation covers in a served file. */
function citedLines(lines: readonly string[], truncated: boolean, source: SourceRef): Cited {
	if (source.startLine === undefined) {
		return truncated ? { ok: false, why: "truncated" } : { ok: true, lines: [...lines] };
	}
	const end = source.endLine ?? source.startLine;
	if (truncated && end > MAX_SERVED_LINES) return { ok: false, why: "truncated" };
	if (source.startLine > lines.length) return { ok: false, why: "range" };
	return { ok: true, lines: lines.slice(source.startLine - 1, end) };
}

async function digestWith(read: (path: string) => Promise<Entry>, source: SourceRef): Promise<string | undefined> {
	const entry = await read(source.path);
	if (entry.kind === "directory" || !entry.read.ok) return undefined;
	const cited = citedLines(entry.read.lines, entry.read.truncated, source);
	return cited.ok ? linesDigest(cited.lines) : undefined;
}

/** The fingerprint of what `source` cites now; undefined for a directory or anything unreadable. */
export async function currentDigest(cwd: string, source: SourceRef): Promise<string | undefined> {
	return digestWith(reader(cwd), source);
}

async function stampWith(read: (path: string) => Promise<Entry>, source: SourceRef): Promise<SourceRef> {
	const { digest: _previous, ...rest } = source;
	const digest = await digestWith(read, source);
	return digest === undefined ? rest : { ...rest, digest };
}

/** Copies of `sources`, each fingerprinted from the current code. */
export async function stampSources(cwd: string, sources: readonly SourceRef[]): Promise<SourceRef[]> {
	const read = reader(cwd);
	const stamped: SourceRef[] = [];
	for (const source of sources) stamped.push(await stampWith(read, source));
	return stamped;
}

/** Copies of `sources`: existing fingerprints kept, absent ones taken from the current code. */
export async function stampMissing(cwd: string, sources: readonly SourceRef[]): Promise<SourceRef[]> {
	const read = reader(cwd);
	const stamped: SourceRef[] = [];
	for (const source of sources) stamped.push(source.digest !== undefined ? { ...source } : await stampWith(read, source));
	return stamped;
}

function replacementBlocks(replacement: DiagramDocument | Block | Diagram): Block[] {
	if ("root" in replacement) return [...eachBlock(replacement.root)].map(location => location.block);
	if ("sources" in replacement) {
		return [replacement, ...(replacement.children ? [...eachBlock(replacement.children)].map(location => location.block) : [])];
	}
	return [...eachBlock(replacement)].map(location => location.block);
}

/** Fingerprint every citation in a staged replacement from the current code, overwriting whatever the model supplied. */
export async function stampReplacement(cwd: string, replacement: DiagramDocument | Block | Diagram): Promise<void> {
	const read = reader(cwd);
	for (const block of replacementBlocks(replacement)) {
		const stamped: SourceRef[] = [];
		for (const source of block.sources) stamped.push(await stampWith(read, source));
		block.sources = stamped;
	}
}

/** `next`, with each fingerprint carried over from the same citation in `previous`; new citations have none. */
export function carryDigests(previous: readonly SourceRef[], next: readonly SourceRef[]): SourceRef[] {
	const digests = new Map(previous.map(source => [refKey(source), source.digest]));
	return next.map(source => {
		const { digest: _dropped, ...rest } = source;
		const digest = digests.get(refKey(source));
		return digest === undefined ? rest : { ...rest, digest };
	});
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
	const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
	return { ok: run.exitCode === 0, stdout: run.stdout.toString() };
}

export function gitHead(cwd: string): string | undefined {
	const head = git(cwd, ["rev-parse", "--verify", "HEAD"]);
	return head.ok ? head.stdout.trim() : undefined;
}

async function checkCitation(read: (path: string) => Promise<Entry>, source: SourceRef): Promise<Pick<CitationCheck, "state" | "movedTo" | "reason">> {
	const entry = await read(source.path);
	if (entry.kind === "directory") return { state: "fresh" };
	const file = entry.read;
	if (!file.ok) {
		if (file.status !== 404) return { state: "unchecked", reason: file.error };
		return source.path.endsWith("/")
			? { state: "missing", reason: "the directory is gone" }
			: { state: "missing", reason: "the file is gone (deleted or renamed)" };
	}
	if (source.digest === undefined) return { state: "unstamped" };
	const cited = citedLines(file.lines, file.truncated, source);
	if (!cited.ok && cited.why === "truncated") return { state: "unchecked", reason: `the file is longer than ${MAX_SERVED_LINES} lines` };
	if (cited.ok && linesDigest(cited.lines) === source.digest) return { state: "fresh" };
	if (source.startLine === undefined) return { state: "changed", reason: "the file's content changed" };
	const startLine = source.startLine;
	const length = (source.endLine ?? startLine) - startLine + 1;
	if (length > 0 && file.lines.length * length <= MAX_RELOCATION_WORK) {
		let best: number | undefined;
		for (let i = 0; i + length <= file.lines.length; i++) {
			if (linesDigest(file.lines.slice(i, i + length)) !== source.digest) continue;
			if (best === undefined || Math.abs(i + 1 - startLine) < Math.abs(best + 1 - startLine)) best = i;
		}
		if (best !== undefined) {
			return { state: "moved", movedTo: { startLine: best + 1, endLine: best + length }, reason: "same lines, new position" };
		}
	}
	return { state: "changed", reason: "the cited lines changed" };
}

function covered(file: string, cited: readonly string[]): boolean {
	return cited.some(path => file === path || file.startsWith(`${path}/`));
}

async function uncoveredFiles(cwd: string, document: DiagramDocument): Promise<DriftReport["uncovered"]> {
	const baseline = document.baseline;
	if (!baseline) return { ok: false, reason: "no baseline recorded — Record baseline starts tracking uncited changes" };
	const commit = baseline.commit;
	if (commit === undefined || !git(cwd, ["rev-parse", "--is-inside-work-tree"]).ok) return { ok: false, reason: "not a git repository" };
	if (!git(cwd, ["cat-file", "-e", `${commit}^{commit}`]).ok) {
		return { ok: false, reason: `baseline commit ${commit.slice(0, 12)} is not in this repository` };
	}
	const diff = Bun.spawnSync(["git", "diff", "--name-only", "--relative", "-z", commit], { cwd, stdout: "pipe", stderr: "pipe" });
	if (diff.exitCode !== 0) {
		const first = diff.stderr.toString().split("\n")[0]?.trim() ?? "";
		return { ok: false, reason: `git diff failed: ${first}` };
	}
	const files = new Set(diff.stdout.toString().split("\0").filter(path => path.length > 0));
	const since = Date.parse(baseline.at);
	const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	for (const path of untracked.stdout.split("\0")) {
		if (path.length === 0 || files.has(path)) continue;
		const info = await stat(resolve(cwd, path)).catch(() => undefined);
		if (info !== undefined && info.mtimeMs > since) files.add(path);
	}
	const cited: string[] = [];
	for (const { block } of eachBlock(document.root)) {
		for (const source of block.sources) cited.push((workspacePath(source.path) ?? source.path).replace(/\/+$/, ""));
	}
	const listed = [...files]
		.filter(path => !path.split("/").some(part => SKIPPED_DIRECTORIES.has(part)) && !covered(path, cited))
		.sort();
	return { ok: true, commit, files: listed.slice(0, MAX_UNCOVERED), truncated: listed.length > MAX_UNCOVERED };
}

export async function checkDrift(cwd: string, document: DiagramDocument): Promise<DriftReport> {
	const read = reader(cwd);
	const citations: CitationCheck[] = [];
	for (const { block } of eachBlock(document.root)) {
		const title = block.title.length > 0 ? block.title : block.id;
		for (const [index, source] of block.sources.entries()) {
			citations.push({ blockId: block.id, title, index, source: { ...source }, ...(await checkCitation(read, source)) });
		}
	}
	return {
		documentId: document.id,
		revision: document.revision,
		checkedAt: new Date().toISOString(),
		citations,
		uncovered: await uncoveredFiles(cwd, document),
	};
}

/** Blocks with a changed, missing or moved citation, in document order. */
export function driftedBlockIds(report: DriftReport): string[] {
	const ids = new Set<string>();
	for (const check of report.citations) {
		if (check.state === "changed" || check.state === "missing" || check.state === "moved") ids.add(check.blockId);
	}
	return [...ids];
}

/** Blocks a Sync should cover: those with a changed or missing citation, minus any whose ancestor is already covered. */
export function syncTargets(document: DiagramDocument, report: DriftReport): string[] {
	const drifted = new Set(
		report.citations.filter(check => check.state === "changed" || check.state === "missing").map(check => check.blockId),
	);
	const targets: string[] = [];
	for (const { block, ancestors } of eachBlock(document.root)) {
		if (drifted.has(block.id) && !ancestors.some(ancestor => drifted.has(ancestor.id))) targets.push(block.id);
	}
	return targets;
}

export function syncContext(document: DiagramDocument, report: DriftReport): SyncContext {
	return {
		...(document.baseline?.commit !== undefined ? { commit: document.baseline.commit } : {}),
		citations: report.citations.filter(check => check.state === "changed" || check.state === "missing" || check.state === "moved"),
	};
}

/** Move every moved citation to where its lines are now, keeping its fingerprint. Returns how many moved. */
export function reanchorMoved(document: DiagramDocument, report: DriftReport): number {
	let count = 0;
	for (const check of report.citations) {
		if (check.state !== "moved" || check.movedTo === undefined) continue;
		const source = findBlockLocation(document.root, check.blockId)?.block.sources[check.index];
		if (source === undefined || refKey(source) !== refKey(check.source)) continue;
		source.startLine = check.movedTo.startLine;
		source.endLine = check.movedTo.endLine;
		count++;
	}
	return count;
}

export type DriftCounts = Record<Exclude<CitationState, "fresh">, number>;

export function driftCounts(report: DriftReport): DriftCounts {
	const counts: DriftCounts = { moved: 0, changed: 0, missing: 0, unstamped: 0, unchecked: 0 };
	for (const check of report.citations) if (check.state !== "fresh") counts[check.state] += 1;
	return counts;
}

/**
 * Record baseline: fingerprint every citation that has none (existing
 * fingerprints stay, so a changed citation keeps its flag) and restart
 * uncited-change tracking from HEAD and now. The reads happen here; `apply`
 * is the synchronous edit for one store transaction.
 */
export async function prepareBaseline(
	cwd: string,
	document: DiagramDocument,
): Promise<{ commit: string | undefined; apply: (draft: DiagramDocument) => void }> {
	const stamped = new Map<string, SourceRef[]>();
	for (const { block } of eachBlock(document.root)) stamped.set(block.id, await stampMissing(cwd, block.sources));
	const commit = gitHead(cwd);
	const at = new Date().toISOString();
	return {
		commit,
		apply: draft => {
			for (const { block } of eachBlock(draft.root)) {
				const sources = stamped.get(block.id);
				if (sources !== undefined && sources.length === block.sources.length) block.sources = sources;
			}
			draft.baseline = { ...(commit !== undefined ? { commit } : {}), at };
		},
	};
}

/** The changed citation `index` of block `blockId` in `report`, if the check found one. */
export function changedCheck(report: DriftReport | undefined, blockId: string, index: number): CitationCheck | undefined {
	return report?.citations.find(check => check.blockId === blockId && check.index === index && check.state === "changed");
}
