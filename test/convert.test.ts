import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertDocument } from "../scripts/json-to-tree.ts";
import { readTree } from "../src/tree.ts";

const cleanup: string[] = [];
afterEach(async () => {
	for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

function block(id: string, title: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		title,
		description: "",
		expectedOutput: "",
		acceptanceCriteria: [],
		position: { x: 0, y: 0 },
		sources: [],
		evidence: "inferred",
		status: "open",
		actions: { enhance: "", execute: "" },
		children: null,
		...extra,
	};
}

const document = {
	schemaVersion: 1,
	id: "doc",
	title: "Cockpit",
	goal: "One panel.",
	purpose: "plan",
	revision: 3,
	root: {
		id: "root",
		blocks: [
			block("app", "App: the shell!", {
				description: "The page.\n\n```wireframe\n[ top bar ]\n[ cards   ]\n```\n\nAfter the fence.",
				surface: "page",
				mockup: "<p>app</p>",
				status: "settled",
				venue: "worktree",
				children: {
					id: "d1",
					blocks: [
						block("store", "Store", {
							acceptanceCriteria: ["reads the inventory"],
							sources: [{ path: "src/store.ts", startLine: 3, endLine: 9 }, { path: "README.md" }],
							expectedOutput: "A module.",
							actions: { enhance: "tighten", execute: "" },
						}),
						block("card", "Card", { surface: "component", uses: ["store"], venue: "here" }),
					],
					edges: [{ id: "e1", from: "card", to: "store", label: "reads", direction: "forward" }],
				},
			}),
		],
		edges: [],
	},
};

async function temp(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "omp-visual-planner-convert-"));
	cleanup.push(dir);
	return dir;
}

describe("json-to-tree", () => {
	test("a schema-1 document becomes directories, front matter, links and design files", async () => {
		const repo = await temp();
		const out = join(repo, "docs/plan");
		expect(await convertDocument(document, out, repo, "architecture.json")).toBe(4);

		expect(await readFile(join(out, "index.md"), "utf8")).toBe("# Cockpit\n\nOne panel.\n\n_Converted from `architecture.json` (purpose: plan)._\n");
		const app = join(out, "01-app-the-shell");
		expect((await readdir(app)).sort()).toEqual(["01-store", "02-card", "design", "index.md"]);
		expect(await readFile(join(app, "index.md"), "utf8")).toBe(
			"---\nstatus: settled\nvenue: worktree\n---\n# App: the shell!\n\nThe page.\n\nAfter the fence.\n",
		);
		expect(await readFile(join(app, "design/preview.html"), "utf8")).toBe("<p>app</p>");
		expect(await readFile(join(app, "design/design.md"), "utf8")).toBe("```wireframe\n[ top bar ]\n[ cards   ]\n```\n");

		expect(await readFile(join(app, "01-store/index.md"), "utf8")).toBe(
			[
				"# Store",
				"",
				"## Expected output",
				"",
				"A module.",
				"",
				"## Acceptance criteria",
				"",
				"- [ ] reads the inventory",
				"",
				"## Sources",
				"",
				"- [src/store.ts:3-9](../../../../src/store.ts#L3-L9)",
				"- [README.md](../../../../README.md)",
				"",
				"## Notes",
				"",
				"enhance: tighten",
				"",
			].join("\n"),
		);
		expect(await readFile(join(app, "02-card/index.md"), "utf8")).toBe("# Card\n\n## Links\n\n- [reads](../01-store/)\n- [uses](../01-store/)\n");
		expect(await readFile(join(app, "02-card/design/design.md"), "utf8")).toBe("Surface: component — not sketched yet.\n");

		// The reader sees what the converter meant.
		const tree = await readTree(out, repo);
		const [store, card] = tree.root.children[0]!.children;
		expect(tree.root.children[0]).toMatchObject({ title: "App: the shell!", status: "settled", venue: "worktree", design: { preview: true } });
		expect(store!.sources).toEqual([{ path: "src/store.ts", startLine: 3, endLine: 9 }, { path: "README.md" }]);
		expect(card!.arrows).toEqual([
			{ to: "01-app-the-shell/01-store", label: "reads" },
			{ to: "01-app-the-shell/01-store", label: "uses" },
		]);
	});

	test("a non-empty target and other schemas are refused", async () => {
		const repo = await temp();
		const out = join(repo, "plan");
		await mkdir(out);
		await writeFile(join(out, "keep.md"), "mine");
		await expect(convertDocument(document, out, repo, "a.json")).rejects.toThrow(`${out} is not empty`);
		await expect(convertDocument({ ...document, schemaVersion: 2 }, join(repo, "other"), repo, "a.json")).rejects.toThrow(
			"only schema-1 planner documents convert",
		);
		expect(await readdir(out)).toEqual(["keep.md"]);
	});
});
