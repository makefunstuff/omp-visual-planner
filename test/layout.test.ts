import { describe, expect, test } from "bun:test";
import { type Box, HEAD, layoutTree } from "../src/layout.ts";
import type { Arrow, TreeNode } from "../src/tree.ts";

function n(path: string, children: TreeNode[] = [], arrows: Arrow[] = []): TreeNode {
	return { path, name: path.split("/").pop() || "root", title: path || "root", status: "open", body: "", arrows, sources: [], children, problems: [] };
}

const tree = n("", [
	n("a", [n("a/1", [], [{ to: "b/2/x", label: "feeds" }]), n("a/2"), n("a/3"), n("a/4"), n("a/5")]),
	n("b", [n("b/1"), n("b/2", [n("b/2/x")])], [{ to: "b/1", label: "owns" }]),
	n("c"),
]);

const inside = (inner: Box, outer: Box) =>
	inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

describe("nested layout", () => {
	test("every child lies inside its parent and siblings do not overlap", () => {
		const { boxes, width, height } = layoutTree(tree, new Set());
		expect(boxes.map(box => box.path)).toEqual(["", "a", "a/1", "a/2", "a/3", "a/4", "a/5", "b", "b/1", "b/2", "b/2/x", "c"]);
		const byPath = new Map(boxes.map(box => [box.path, box]));
		expect(byPath.get("")).toMatchObject({ x: 0, y: 0, w: width, h: height });
		for (const box of boxes.slice(1)) {
			expect(inside(box, byPath.get(parentOf(box.path))!)).toBe(true);
			for (const other of boxes.slice(1)) {
				if (other !== box && parentOf(other.path) === parentOf(box.path)) expect(overlap(box, other)).toBe(false);
			}
		}
	});

	test("collapsing a node hides its descendants and takes the arrows aimed at them", () => {
		const { boxes, wires } = layoutTree(tree, new Set(["b"]));
		expect(boxes.some(box => box.path.startsWith("b/"))).toBe(false);
		expect(boxes.find(box => box.path === "b")).toMatchObject({ collapsed: true, childCount: 2 });
		// a/1 → b/2/x lands on b; b → b/1 now starts and ends on b and is dropped.
		expect(wires.map(({ from, to, label }) => ({ from, to, label }))).toEqual([{ from: "a/1", to: "b", label: "feeds" }]);
	});

	test("a wire between nested boxes starts at the outer box's header", () => {
		const { boxes, wires } = layoutTree(tree, new Set());
		const b = boxes.find(box => box.path === "b")!;
		const b1 = boxes.find(box => box.path === "b/1")!;
		const wire = wires.find(candidate => candidate.from === "b" && candidate.to === "b/1")!;
		expect(wire).toMatchObject({ x1: b.x + b.w / 2, y1: b.y + HEAD, x2: b1.x + b1.w / 2, y2: b1.y });
	});
});
