import { describe, expect, test } from "bun:test";
import { nextOpenBlock, nextStatus, nextStep, outlineRows, projectActions, verbsFor } from "../src/flow.ts";
import { PURPOSES, createBlock, createDiagram, createDocument } from "../src/model.ts";

/** root: a (settled, children: a1 open), b (open) */
function fixture() {
	const document = createDocument({ title: "Plan", purpose: "plan" });
	const a1 = createBlock({ id: "a1", title: "A1" });
	const a = createBlock({ id: "a", title: "A", status: "settled", children: createDiagram({ blocks: [a1] }) });
	const b = createBlock({ id: "b", title: "B" });
	document.root.blocks.push(a, b);
	return document;
}

describe("next open block", () => {
	test("walks depth-first, skips settled and done blocks, and wraps", () => {
		const document = fixture();
		expect(nextOpenBlock(document, "a")).toBe("a1");
		expect(nextOpenBlock(document, "a1")).toBe("b");
		expect(nextOpenBlock(document, "b")).toBe("a1");
		document.root.blocks[1]!.status = "done";
		expect(nextOpenBlock(document, "a1")).toBe("a1");
		document.root.blocks[0]!.children!.blocks[0]!.status = "settled";
		expect(nextOpenBlock(document, "a")).toBeUndefined();
	});

	test("a brainstorm has no status, so it is simply the next idea", () => {
		const document = fixture();
		document.purpose = "brainstorm";
		expect(nextOpenBlock(document, "a")).toBe("a1");
		expect(nextOpenBlock(document, "b")).toBe("a");
	});
});

describe("outline", () => {
	test("a collapsed block hides its subtree but still shows it has children", () => {
		const document = fixture();
		expect(outlineRows(document, new Set()).map(row => `${row.depth}:${row.block.id}`)).toEqual(["0:a", "1:a1", "0:b"]);
		const collapsed = outlineRows(document, new Set(["a"]));
		expect(collapsed.map(row => row.block.id)).toEqual(["a", "b"]);
		expect(collapsed[0]).toMatchObject({ hasChildren: true, collapsed: true });
	});
});

describe("purpose vocabulary", () => {
	test("explore offers investigation verbs and no execution", () => {
		expect(verbsFor("explore").map(verb => verb.label)).toEqual(["Investigate", "Map inside", "Replan"]);
		expect(verbsFor("plan").map(verb => verb.key)).toEqual(["r", "b", "t", "X"]);
	});

	test("every purpose replans a block, and only the project offers prune", () => {
		for (const purpose of PURPOSES) {
			expect(verbsFor(purpose).find(verb => verb.id === "replan")).toMatchObject({
				label: "Replan",
				key: "t",
				intent: "replan",
				kind: "replan",
			});
			const kinds = projectActions(purpose).map(action => action.kind);
			expect(kinds.slice(-2)).toEqual(purpose === "plan" ? ["prune", "execute"] : ["replan", "prune"]);
			expect(verbsFor(purpose).some(verb => verb.id === "prune")).toBe(false);
		}
	});

	test("a status outside the purpose's cycle restarts it; brainstorm has none", () => {
		expect(nextStatus("explore", "done")).toBe("open");
		expect(nextStatus("plan", "done")).toBe("open");
		expect(nextStatus("plan", "open")).toBe("settled");
		expect(nextStatus("brainstorm", "open")).toBeUndefined();
	});
});

describe("next step", () => {
	test("a written open leaf is Execute, not a status lecture", () => {
		const document = createDocument({ title: "Tool", purpose: "plan" });
		const block = createBlock({ id: "input", title: "Input", description: "Check the file.", status: "open" });
		document.root.blocks.push(block);
		expect(nextStep(document, block)).toMatchObject({ label: "Execute", act: "verb", verb: "execute" });
	});

	test("a written brainstorm idea points at Implement", () => {
		const document = createDocument({ title: "Tool", purpose: "brainstorm" });
		const block = createBlock({ id: "idea", title: "Idea", description: "A note." });
		document.root.blocks.push(block);
		expect(nextStep(document, block).act).toBe("implement");
	});
});
