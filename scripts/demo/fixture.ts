import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createBlock, createDiagram, createDocument, createEdge } from "../../src/model.ts";
import { serializeDocument } from "../../src/store.ts";

const workspace = process.argv[2];
if (!workspace) throw new Error("usage: bun scripts/demo/fixture.ts <workspace>");

await mkdir(join(workspace, "src"), { recursive: true });
for (const name of ["flow.ts", "actions.ts"]) {
	await copyFile(new URL(`../../src/${name}`, import.meta.url), join(workspace, "src", name));
}

const document = createDocument({
	id: "demo-document",
	title: "Visual planner",
	goal: "Understand the planner's block workflow and reviewed proposals",
	purpose: "explore",
});
document.root.id = "demo-root";
const workflow = createBlock({
	id: "workflow",
	title: "Block workflow",
	description: "A focused page turns an architecture block into an inspectable unit of work.",
	evidence: "observed",
	status: "settled",
	sources: [{ path: "src/flow.ts", startLine: 145, endLine: 149 }],
	x: 2, y: 2,
	children: createDiagram({
		id: "workflow-inside",
		blocks: [
			createBlock({ id: "purpose", title: "Purpose and status", description: "Purpose selects the available fields and human-owned status.", x: 2, y: 2 }),
			createBlock({ id: "next", title: "Next open block", description: "Continue one block at a time without losing the outline.", x: 28, y: 2 }),
		],
		edges: [createEdge({ id: "flow-edge", from: "purpose", to: "next", label: "guides" })],
	}),
});
const proposals = createBlock({
	id: "proposals",
	title: "Reviewed proposals",
	description: "Replan or prune through a staged structural diff, never a silent rewrite.",
	evidence: "observed",
	sources: [{ path: "src/actions.ts", startLine: 305, endLine: 350 }],
	x: 31, y: 2,
});
const map = createBlock({
	id: "map",
	title: "Coordinate map",
	description: "Optional layout for spatial relationships between blocks.",
	x: 58, y: 2,
});
document.root.blocks.push(workflow, proposals, map);
document.root.edges.push(createEdge({ id: "review-edge", from: "workflow", to: "proposals", label: "review", fromPort: "east", toPort: "west" }));
await Bun.write(join(workspace, "architecture.json"), serializeDocument(document));
console.log(join(workspace, "architecture.json"));
