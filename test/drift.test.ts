import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDrift, gitHead, reanchorMoved, stampMissing, syncTargets } from "../src/drift.ts";
import { type DiagramDocument, type SourceRef, createBlock, createDiagram, createDocument } from "../src/model.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const hasGit = Bun.spawnSync(["git", "--version"]).exitCode === 0;

async function workspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "omp-planner-drift-"));
	directories.push(dir);
	await mkdir(join(dir, "src"));
	return dir;
}

const TEN = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);

function documentCiting(sources: SourceRef[]): DiagramDocument {
	const document = createDocument({ title: "Drift" });
	document.root.blocks.push(createBlock({ id: "api", title: "API", sources }));
	return document;
}

function git(dir: string, ...args: string[]): void {
	const run = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "pipe" });
	if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

function commit(dir: string): void {
	git(dir, "add", "-A");
	git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "x");
}

describe("citation checks", () => {
	test("a cited range reads fresh, moved, changed and missing as the file changes", async () => {
		const dir = await workspace();
		const file = join(dir, "src", "a.ts");
		await writeFile(file, TEN.join("\n"));
		const [source] = await stampMissing(dir, [{ path: "src/a.ts", startLine: 3, endLine: 5 }]);
		expect(source!.digest).toBeString();
		const document = documentCiting([source!]);
		expect((await checkDrift(dir, document)).citations[0]!.state).toBe("fresh");

		await writeFile(file, ["new 1", "new 2", ...TEN].join("\n"));
		const moved = await checkDrift(dir, document);
		expect(moved.citations[0]).toMatchObject({ state: "moved", movedTo: { startLine: 5, endLine: 7 } });

		const clone = structuredClone(document);
		expect(reanchorMoved(clone, moved)).toBe(1);
		expect(clone.root.blocks[0]!.sources[0]).toMatchObject({ startLine: 5, endLine: 7, digest: source!.digest });
		expect((await checkDrift(dir, clone)).citations[0]!.state).toBe("fresh");

		const edited = ["new 1", "new 2", ...TEN];
		edited[5] = "line 4, rewritten";
		await writeFile(file, edited.join("\n"));
		expect((await checkDrift(dir, clone)).citations[0]).toMatchObject({ state: "changed", reason: "the cited lines changed" });

		await unlink(file);
		expect((await checkDrift(dir, clone)).citations[0]!.state).toBe("missing");
	});

	test("an unfingerprinted citation is unstamped and an existing directory is fresh", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "src", "a.ts"), TEN.join("\n"));
		const report = await checkDrift(dir, documentCiting([{ path: "src/a.ts", startLine: 1, endLine: 2 }, { path: "src" }]));
		expect(report.citations.map(check => check.state)).toEqual(["unstamped", "fresh"]);
	});

	test("Sync covers a drifted parent, not its drifted child as well", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "src", "a.ts"), TEN.join("\n"));
		const [stamped] = await stampMissing(dir, [{ path: "src/a.ts", startLine: 1, endLine: 2 }]);
		const document = documentCiting([stamped!]);
		const child = createBlock({ id: "child", title: "Child", sources: [{ ...stamped! }] });
		document.root.blocks[0]!.children = createDiagram({ blocks: [child] });
		await writeFile(join(dir, "src", "a.ts"), ["changed", ...TEN.slice(1)].join("\n"));
		const report = await checkDrift(dir, document);
		expect(report.citations.map(check => check.state)).toEqual(["changed", "changed"]);
		expect(syncTargets(document, report)).toEqual(["api"]);
	});
});

describe("uncited changes", () => {
	test.skipIf(!hasGit)("lists changed and new files since the baseline that no block cites", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "src", "a.ts"), TEN.join("\n"));
		await writeFile(join(dir, "src", "c.ts"), "c\n");
		git(dir, "init", "-q");
		commit(dir);
		const [source] = await stampMissing(dir, [{ path: "src/a.ts", startLine: 1, endLine: 2 }]);
		const document = documentCiting([source!]);
		// Backdated, so a file written right after it has a later mtime.
		document.baseline = { commit: gitHead(dir)!, at: new Date(Date.now() - 2000).toISOString() };
		await writeFile(join(dir, "src", "a.ts"), ["changed", ...TEN].join("\n"));
		await writeFile(join(dir, "src", "b.ts"), "b\n");
		await writeFile(join(dir, "src", "c.ts"), "c changed\n");
		const report = await checkDrift(dir, document);
		expect(report.uncovered).toEqual({ ok: true, commit: document.baseline.commit!, files: ["src/b.ts", "src/c.ts"], truncated: false });
	});

	test("without a baseline it says how to start one", async () => {
		const dir = await workspace();
		const report = await checkDrift(dir, documentCiting([]));
		expect(report.uncovered.ok).toBe(false);
		expect(report.uncovered.ok ? "" : report.uncovered.reason).toStartWith("no baseline recorded");
	});
});
