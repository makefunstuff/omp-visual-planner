import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TreeNode, parseIndex, readTree, treeVersion } from "../src/tree.ts";

const cleanup: string[] = [];
afterEach(async () => {
	for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A repo directory with `docs/plan` holding the given files. */
async function repo(files: Record<string, string>): Promise<{ repo: string; root: string }> {
	const dir = await mkdtemp(join(tmpdir(), "omp-visual-planner-tree-"));
	cleanup.push(dir);
	const root = join(dir, "docs/plan");
	await mkdir(root, { recursive: true });
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), text);
	}
	return { repo: dir, root };
}

function node(root: TreeNode, path: string): TreeNode {
	const found = [root, ...root.children.flatMap(function all(child: TreeNode): TreeNode[] {
		return [child, ...child.children.flatMap(all)];
	})].find(candidate => candidate.path === path);
	if (!found) throw new Error(`no node ${path}`);
	return found;
}

describe("tree structure", () => {
	test("children are ordered numerically; design/, dot-names and symlinked directories are not children", async () => {
		const { repo: dir, root } = await repo({
			"docs/plan/index.md": "# Project\n",
			"docs/plan/10-b/index.md": "# Ten\n",
			"docs/plan/2-a/index.md": "# Two\n",
			"docs/plan/design/design.md": "tokens\n",
			"docs/plan/.hidden/index.md": "# Hidden\n",
			"elsewhere/index.md": "# Elsewhere\n",
		});
		await symlink(join(dir, "elsewhere"), join(root, "3-link"));
		const tree = await readTree(root, dir);
		expect(tree.rootLabel).toBe("docs/plan");
		expect(tree.root.title).toBe("Project");
		expect(tree.root.children.map(child => child.path)).toEqual(["2-a", "10-b"]);
		expect(tree.root.design).toEqual({ markdown: "tokens\n", preview: false });
	});

	test("a directory without index.md is a node titled by its name, with the problem", async () => {
		const { repo: dir, root } = await repo({ "docs/plan/index.md": "# P\n", "docs/plan/empty/.keep": "" });
		const empty = node((await readTree(root, dir)).root, "empty");
		expect(empty.title).toBe("empty");
		expect(empty.problems).toEqual(["index.md is missing"]);
		expect(empty.status).toBe("open");
	});

	test("a missing root is an error naming it", async () => {
		const { repo: dir } = await repo({});
		await expect(readTree(join(dir, "nope"), dir)).rejects.toThrow("no plan tree at nope: the directory does not exist");
	});
});

describe("index.md", () => {
	test("front matter sets status and venue; here means this session", () => {
		expect(parseIndex("---\nstatus: settled\nvenue: subagent\n---\n# T\n")).toMatchObject({ status: "settled", venue: "subagent", problems: [] });
		const here = parseIndex("---\nvenue: here\n---\n# T\n");
		expect(here.venue).toBeUndefined();
		expect(here.problems).toEqual([]);
	});

	test("an invalid status or venue is a problem and falls back to the default", () => {
		const parsed = parseIndex("---\nstatus: finished\nvenue: cloud\n---\n# T\n");
		expect(parsed.status).toBe("open");
		expect(parsed.venue).toBeUndefined();
		expect(parsed.problems).toEqual(["status must be open, settled or done", "venue must be here, subagent or worktree"]);
	});

	test("broken or non-mapping front matter is a problem", () => {
		expect(parseIndex("---\nstatus: [open\n---\n# T\n").problems[0]).toStartWith("front matter is not valid YAML: ");
		expect(parseIndex("---\n- a\n- b\n---\n# T\n").problems).toEqual(["front matter must be key: value pairs"]);
	});

	test("the first H1 is the title and leaves the body", () => {
		const parsed = parseIndex("---\nstatus: open\n---\n\n# The *title*\n\nFirst paragraph.\n\n## Acceptance criteria\n\n- [ ] works\n");
		expect(parsed.title).toBe("The title");
		expect(parsed.body).toBe("First paragraph.\n\n## Acceptance criteria\n\n- [ ] works\n");
		expect(parseIndex("Just text.\n").title).toBeUndefined();
	});
});

describe("links", () => {
	test("links to nodes are arrows; code outside the tree is a source; the rest is ignored", async () => {
		const { repo: dir, root } = await repo({
			"docs/plan/index.md": "# P\n",
			"docs/plan/2-a/index.md": "# Alpha\n",
			"docs/plan/3-b/index.md": [
				"# Beta",
				"",
				"[feeds](../2-a/) and [again](../2-a/index.md) and [](../2-a) and [feeds](../2-a/#x).",
				"Uses [the parent][p]; [self](./) is ignored.",
				"[code](../../../src/app.ts#L3-L9), [one](../../../src/app.ts#L4), [dup](../../../src/app.ts#L3-L9).",
				"[design](../2-a/design/design.md), [web](https://example.com), [mail](mailto:x@y), [abs](/etc/passwd), [frag](#top), [out](../../../../outside.txt).",
				"",
				"[p]: ../",
			].join("\n"),
		});
		const beta = node((await readTree(root, dir)).root, "3-b");
		expect(beta.arrows).toEqual([
			{ to: "2-a", label: "feeds" },
			{ to: "2-a", label: "again" },
			{ to: "2-a", label: "Alpha" },
			{ to: "", label: "the parent" },
		]);
		expect(beta.sources).toEqual([
			{ path: "src/app.ts", startLine: 3, endLine: 9 },
			{ path: "src/app.ts", startLine: 4 },
		]);
	});
});

describe("version", () => {
	test("stays equal without changes and changes when a node file changes", async () => {
		const { root } = await repo({ "docs/plan/index.md": "# P\n", "docs/plan/a/index.md": "# A\n" });
		const first = await treeVersion(root);
		expect(await treeVersion(root)).toBe(first);
		await writeFile(join(root, "a/index.md"), "# A, rewritten\n");
		expect(await treeVersion(root)).not.toBe(first);
		expect(await treeVersion(join(root, "missing"))).toBe("missing");
	});
});
