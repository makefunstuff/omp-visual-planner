import { describe, expect, test } from "bun:test";
import { composePrompt } from "../src/compose.ts";
import { DispatchError, planDispatch } from "../src/flow.ts";
import { createBlock, createDocument, createEdge, addBlock, addEdge } from "../src/model.ts";

function plan() {
	const document = createDocument({ title: "Tool", purpose: "plan" });
	const parent = createBlock({ id: "parent", title: "Parser", status: "settled", acceptanceCriteria: ["parses"] });
	const ready = createBlock({
		id: "ready",
		title: "Flags",
		status: "settled",
		acceptanceCriteria: ["rejects an unknown flag"],
		actions: { enhance: "", execute: "keep the parser strict" },
		venue: "subagent",
	});
	const idea = createBlock({ id: "idea", title: "Colors", status: "open" });
	const done = createBlock({ id: "done", title: "Offsets", status: "done", acceptanceCriteria: ["prints the offset"] });
	parent.children = { id: "inner", blocks: [ready, idea, done], edges: [] };
	addBlock(document.root, document.root.id, parent);
	addEdge(document.root, "inner", createEdge({ from: "done", to: "ready" }));
	return { document, parent, ready };
}

describe("execute dispatch", () => {
	test("a parent runs its ready leaves and names the venue", () => {
		const { document } = plan();
		const dispatch = planDispatch(document, { kind: "block", id: "parent" });
		expect(dispatch.run.map(leaf => leaf.id)).toEqual(["ready"]);
		expect(dispatch.run[0]).toMatchObject({ venue: "subagent", notes: "keep the parser strict" });
		expect(dispatch.held.map(item => item.kind)).toEqual(["container", "brainstorm", "done"]);
		const prompt = composePrompt(document, { kind: "block", id: "parent" }, "execute").text;
		expect(prompt).toContain("Subagent — one subagent per leaf");
		expect(prompt).toContain("[ready] Flags");
		expect(prompt).toContain("rejects an unknown flag");
		expect(prompt).not.toContain("decide yourself");
		expect(prompt).toContain("Not run");
	});

	test("Execute on an open leaf that already has a description runs it", () => {
		const document = createDocument({ title: "Tool", purpose: "plan" });
		addBlock(document.root, document.root.id, createBlock({
			id: "input",
			title: "Validating the input file",
			description: "Confirm the input is a readable file.",
			status: "open",
		}));
		const dispatch = planDispatch(document, { kind: "block", id: "input" });
		expect(dispatch.run.map(leaf => leaf.id)).toEqual(["input"]);
		expect(dispatch.held).toEqual([]);
	});


	test("a blocked leaf is not run, and an unblocked one is ordered after its neighbor", () => {
		const document = createDocument({ title: "Tool", purpose: "plan" });
		const first = createBlock({ id: "first", title: "Read", status: "settled", acceptanceCriteria: ["reads"], venue: "worktree" });
		const second = createBlock({ id: "second", title: "Write", status: "settled", acceptanceCriteria: ["writes"] });
		const waiting = createBlock({ id: "waiting", title: "Share", status: "settled", acceptanceCriteria: ["shares"] });
		const open = createBlock({ id: "open", title: "Draft", status: "open", description: "not settled" });
		addBlock(document.root, document.root.id, first);
		addBlock(document.root, document.root.id, second);
		addBlock(document.root, document.root.id, waiting);
		addBlock(document.root, document.root.id, open);
		addEdge(document.root, document.root.id, createEdge({ from: "first", to: "second" }));
		addEdge(document.root, document.root.id, createEdge({ from: "open", to: "waiting" }));

		const dispatch = planDispatch(document, { kind: "project" });
		expect(dispatch.run.map(leaf => leaf.id)).toEqual(["first", "second"]);
		expect(dispatch.run[0]?.venue).toBe("worktree");
		expect(dispatch.run[1]?.venue).toBe("here");
		expect(dispatch.held.find(item => item.id === "waiting")?.kind).toBe("blocked");
	});

	test("nothing ready is an error, not a prompt", () => {
		const document = createDocument({ title: "Tool", purpose: "plan" });
		addBlock(document.root, document.root.id, createBlock({ id: "idea", title: "Idea" }));
		expect(() => composePrompt(document, { kind: "block", id: "idea" }, "execute")).toThrow(DispatchError);
	});
});
