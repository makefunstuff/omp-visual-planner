import { describe, expect, test } from "bun:test";
import {
	FOCUS_CENTER,
	focusCounts,
	focusNeighborhood,
	focusTarget,
	moveFocusCursor,
	nextOpenBlock,
	nextStatus,
	nextStep,
	normalizeFocusCursor,
	outlineRows,
	projectActions,
	useCandidates,
	verbsFor,
} from "../src/flow.ts";
import { PURPOSES, createBlock, createDiagram, createDocument, createEdge } from "../src/model.ts";

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

describe("focus diagram", () => {
	/** root: a (children: a1), b, c; edges b→a "feeds" (forward), a→c "emits" (none). */
	function graph() {
		const document = createDocument({ title: "Graph", purpose: "explore" });
		const a1 = createBlock({ id: "a1", title: "A1" });
		a1.uses = ["c"];
		const a = createBlock({ id: "a", title: "A", children: createDiagram({ id: "a-inner", blocks: [a1] }) });
		const b = createBlock({ id: "b", title: "B" });
		const c = createBlock({ id: "c", title: "C" });
		document.root.blocks.push(a, b, c);
		document.root.edges.push(
			createEdge({ id: "e1", from: "b", to: "a", label: "feeds", direction: "forward" }),
			createEdge({ id: "e2", from: "a", to: "c", label: "emits", direction: "none" }),
		);
		return document;
	}

	test("the neighbourhood splits links by direction and keeps the parent structural", () => {
		const document = graph();
		const a = focusNeighborhood(document, "a");
		expect(a.parent).toBeUndefined();
		expect(a.inputs.map(link => [link.block.id, link.label, link.direction])).toEqual([["b", "feeds", "forward"]]);
		expect(a.outputs.map(link => [link.block.id, link.label, link.direction])).toEqual([["c", "emits", "none"]]);
		expect(a.children.map(child => child.id)).toEqual(["a1"]);
		expect(focusNeighborhood(document, "a1").parent?.id).toBe("a");
		// No block reads as the document itself: its top-level blocks hang below.
		expect(focusNeighborhood(document, undefined).children.map(block => block.id)).toEqual(["a", "b", "c"]);
	});

	test("shown hides a filtered endpoint from both sides", () => {
		const document = graph();
		const hood = focusNeighborhood(document, "a", block => block.id !== "b");
		expect(hood.inputs).toEqual([]);
		expect(hood.outputs.map(link => link.block.id)).toEqual(["c"]);
	});

	test("a block linked both ways appears on both sides", () => {
		const document = graph();
		document.root.edges.push(createEdge({ id: "e3", from: "c", to: "a", label: "back" }));
		const hood = focusNeighborhood(document, "a");
		expect(hood.inputs.map(link => link.block.id)).toEqual(["b", "c"]);
		expect(hood.outputs.map(link => link.block.id)).toEqual(["c"]);
	});

	test("a use reads as an input labelled uses, and back as used by", () => {
		const document = graph();
		expect(focusNeighborhood(document, "a1").inputs.map(link => [link.block.id, link.label, link.kind])).toEqual([
			["c", "uses", "uses"],
		]);
		const users = focusNeighborhood(document, "c").outputs.filter(link => link.kind === "uses");
		expect(users.map(link => link.block.id)).toEqual(["a1"]);
		expect(users[0]!.label).toBe("used by");
	});

	test("candidates are everything but itself, its ancestors and its descendants", () => {
		const document = graph();
		expect(useCandidates(document, "a1").map(candidate => candidate.block.id)).toEqual(["b", "c"]);
		expect(useCandidates(document, "a1").map(candidate => candidate.used)).toEqual([false, true]);
		expect(useCandidates(document, "ghost")).toEqual([]);
	});

	const counts = { up: 1, in: 2, out: 1, down: 3 };

	test("left and down reach the inputs and the children; edges stop at the last item", () => {
		expect(moveFocusCursor(FOCUS_CENTER, "left", counts)).toEqual({ slot: "in", index: 0 });
		expect(moveFocusCursor({ slot: "in", index: 0 }, "down", counts)).toEqual({ slot: "in", index: 1 });
		expect(moveFocusCursor({ slot: "in", index: 1 }, "down", counts)).toEqual({ slot: "in", index: 1 });
		expect(moveFocusCursor({ slot: "in", index: 1 }, "right", counts)).toEqual(FOCUS_CENTER);
		expect(moveFocusCursor({ slot: "in", index: 1 }, "up", counts)).toEqual({ slot: "in", index: 0 });
		expect(moveFocusCursor({ slot: "in", index: 1 }, "left", counts)).toEqual({ slot: "in", index: 1 });
	});

	test("down walks the children and up returns to the centre", () => {
		let cursor = moveFocusCursor(FOCUS_CENTER, "down", counts);
		expect(cursor).toEqual({ slot: "down", index: 0 });
		for (let step = 0; step < 3; step += 1) cursor = moveFocusCursor(cursor, "right", counts);
		expect(cursor).toEqual({ slot: "down", index: 2 });
		expect(moveFocusCursor(cursor, "right", counts)).toEqual({ slot: "down", index: 2 });
		expect(moveFocusCursor(cursor, "up", counts)).toEqual(FOCUS_CENTER);
		expect(moveFocusCursor({ slot: "down", index: 0 }, "left", counts)).toEqual({ slot: "down", index: 0 });
	});

	test("up and right reach the parent and the outputs", () => {
		const up = moveFocusCursor(FOCUS_CENTER, "up", counts);
		expect(up).toEqual({ slot: "up", index: 0 });
		expect(moveFocusCursor(up, "left", counts)).toEqual(up);
		expect(moveFocusCursor(up, "down", counts)).toEqual(FOCUS_CENTER);
		const out = moveFocusCursor(moveFocusCursor(up, "down", counts), "right", counts);
		expect(out).toEqual({ slot: "out", index: 0 });
		expect(moveFocusCursor(out, "left", counts)).toEqual(FOCUS_CENTER);
	});

	test("nothing around the block means nothing to move to", () => {
		const empty = { up: 0, in: 0, out: 0, down: 0 };
		for (const move of ["up", "down", "left", "right"] as const) {
			expect(moveFocusCursor(FOCUS_CENTER, move, empty)).toEqual(FOCUS_CENTER);
		}
		expect(normalizeFocusCursor({ slot: "in", index: 5 }, counts)).toEqual(FOCUS_CENTER);
		expect(normalizeFocusCursor({ slot: "in", index: 1 }, counts)).toEqual({ slot: "in", index: 1 });
	});

	test("the target is the block under the cursor", () => {
		const document = graph();
		const hood = focusNeighborhood(document, "a");
		expect(focusTarget(hood, FOCUS_CENTER)).toBeUndefined();
		expect(focusTarget(hood, { slot: "in", index: 0 })?.id).toBe("b");
		expect(focusTarget(hood, { slot: "out", index: 0 })?.id).toBe("c");
		expect(focusTarget(hood, { slot: "down", index: 0 })?.id).toBe("a1");
		expect(focusTarget(hood, { slot: "down", index: 9 })).toBeUndefined();
		expect(focusTarget(hood, { slot: "up", index: 0 })).toBeUndefined();
		expect(focusCounts(hood)).toEqual({ up: 0, in: 1, out: 1, down: 1 });
	});
});
