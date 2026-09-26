import { describe, expect, test } from "bun:test";
import { createBlock, createDiagram, createDocument, createEdge, formatSourceRef, parseSourceRef } from "../src/model.ts";
import {
	CARD_HEIGHT,
	acceptReplacement,
	cardRect,
	cardWidth,
	cornerName,
	diffDocuments,
	diffIsEmpty,
	emptyDiff,
	layoutFor,
	placeNewBlock,
	routeEdge,
	tidyDiagram,
} from "../src/ui.ts";

function overlaps(blocks: ReturnType<typeof createBlock>[]): boolean {
	const rects = blocks.map(cardRect);
	return rects.some((a, i) =>
		rects.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h),
	);
}

function rect(x: number, y: number, w = 16, h = CARD_HEIGHT) {
	return { x, y, w, h };
}

describe("card geometry", () => {
	test("card width clamps between 12 and 32", () => {
		expect(cardWidth("hi")).toBe(12);
		expect(cardWidth("a".repeat(100))).toBe(32);
		expect(cardWidth("a".repeat(20))).toBe(22);
	});

	test("a card is four rows tall", () => {
		const block = createBlock({ id: "a", title: "API", x: 5, y: 7 });
		expect(cardRect(block)).toEqual({ x: 5, y: 7, w: 12, h: 4 });
	});

	test("a blank diagram places the first block at (2,2)", () => {
		expect(placeNewBlock(createDiagram({ blocks: [] }))).toEqual({ x: 2, y: 2 });
	});

	test("a new block sits two cells after the selected card and never overlaps", () => {
		const diagram = createDiagram({ blocks: [] });
		const first = createBlock({ id: "a", title: "API", x: 2, y: 2 });
		diagram.blocks.push(first);
		const placed = placeNewBlock(diagram, "a");
		expect(placed).toEqual({ x: 2 + 12 + 2, y: 2 });

		// A block already sitting at the target pushes the new one down.
		diagram.blocks.push(createBlock({ id: "b", title: "DB", x: 16, y: 2 }));
		const second = placeNewBlock(diagram, "a");
		expect(second.x).toBe(16);
		expect(second.y).toBeGreaterThan(2);
	});

	test("blocks a proposal adds are placed by the planner, never at the model's coordinates", () => {
		// The shape a model actually sent: a 3x2 grid two cells apart, every card on top of the next.
		const document = createDocument();
		const tokens = createBlock({ id: "tokens", title: "Tokens", x: 9, y: 9 });
		document.root.blocks.push(tokens);
		const titles = ["Token model & signing", "Issuance", "Verification", "Session & refresh store", "Refresh & rotation", "Revocation & logout"];
		const children = createDiagram({
			blocks: titles.map((title, index) => createBlock({ id: `c${index}`, title, x: (index % 3) * 2, y: Math.floor(index / 3) * 2 })),
		});
		acceptReplacement(document, { ...tokens, position: { x: 0, y: 0 }, children }, "tokens", {
			intent: "plan",
			scope: { kind: "block", id: "tokens" },
		});
		const placed = document.root.blocks[0]!;
		expect(placed.position).toEqual({ x: 9, y: 9 });
		expect(overlaps(placed.children!.blocks)).toBe(false);
		expect(placed.children!.blocks.map(block => block.title)).toEqual(titles);
	});

	test("a whole-document proposal is laid out too, nested levels included", () => {
		// What a discovery sent: one block at x=0 and one at x=380, a child on top of its parent's origin.
		const document = createDocument();
		const child = createBlock({ id: "c", title: "add()", x: 0, y: 0 });
		const replacement = createDocument({ id: document.id, title: "Discovery" });
		replacement.root.blocks.push(
			createBlock({ id: "a", title: "src/math.ts", x: 0, y: 0, children: createDiagram({ blocks: [child] }) }),
			createBlock({ id: "b", title: "No manifest", x: 380, y: 0 }),
		);
		acceptReplacement(document, replacement, undefined, { intent: "discover", scope: { kind: "project" } });
		expect(document.root.blocks.map(block => block.position)).toEqual([
			{ x: 2, y: 2 },
			{ x: 2 + cardWidth("src/math.ts") + 4, y: 2 },
		]);
		expect(document.root.blocks[0]!.children!.blocks[0]!.position).toEqual({ x: 2, y: 2 });
	});

	test("a prune that would drop settled work is refused before anything is applied", () => {
		const document = createDocument({ id: "doc-1", title: "Service" });
		document.root.blocks.push(
			createBlock({ id: "api", title: "API", status: "settled" }),
			createBlock({ id: "db", title: "Database" }),
		);
		const droppingApi = structuredClone(document);
		droppingApi.root.blocks = droppingApi.root.blocks.filter(block => block.id !== "api");
		const prune = { intent: "prune", scope: { kind: "project" } } as const;

		expect(() => acceptReplacement(document, droppingApi, undefined, prune)).toThrow(/"API" \(api\)/);
		expect(document.root.blocks.map(block => block.id)).toEqual(["api", "db"]);

		// The same prune without the settled block lands, keeping what remains.
		const droppingDb = structuredClone(document);
		droppingDb.root.blocks = droppingDb.root.blocks.filter(block => block.id !== "db");
		acceptReplacement(document, droppingDb, undefined, prune);
		expect(document.root.blocks.map(block => block.id)).toEqual(["api"]);
	});

	test("tidy removes every overlap and keeps authored order", () => {
		const diagram = createDiagram({ blocks: ["a", "b", "c", "d"].map(id => createBlock({ id, title: id, x: 0, y: 0 })) });
		expect(overlaps(diagram.blocks)).toBe(true);
		tidyDiagram(diagram);
		expect(overlaps(diagram.blocks)).toBe(false);
		expect(diagram.blocks[0]!.position).toEqual({ x: 2, y: 2 });
	});
});

describe("layout", () => {
	test("a wide terminal splits canvas and a 34-column inspector", () => {
		const layout = layoutFor(120, 36);
		expect(layout.stacked).toBe(false);
		expect(layout.inspectorWidth).toBe(34);
		expect(layout.canvasWidth).toBe(120 - 34 - 5);
		expect(layout.bodyHeight).toBe(32);
		expect(layout.tooSmall).toBe(false);
	});

	test("a narrow terminal stacks the panes", () => {
		const layout = layoutFor(80, 24);
		expect(layout.stacked).toBe(true);
		expect(layout.canvasWidth).toBe(76);
		expect(layout.tooSmall).toBe(false);
	});

	test("a tiny terminal is reported instead of drawn", () => {
		expect(layoutFor(30, 24).tooSmall).toBe(true);
		expect(layoutFor(80, 6).tooSmall).toBe(true);
	});
});

describe("edge routing", () => {
	test("an auto route between side-by-side cards leaves east and enters west", () => {
		const route = routeEdge(rect(2, 2), rect(30, 2), { fromPort: "auto", toPort: "auto", routing: "auto" });
		expect(route.arrow).toBe(">");
		expect(route.points[0]).toEqual({ x: 2 + 16, y: 4 });
		expect(route.points.at(-1)).toEqual({ x: 30 - 1, y: 4 });
	});

	test("a stacked pair routes vertically", () => {
		const route = routeEdge(rect(2, 2), rect(2, 20), { fromPort: "auto", toPort: "auto", routing: "auto" });
		expect(route.arrow).toBe("v");
		expect(route.points.at(-1)!.y).toBe(19);
	});

	test("every segment is axis-aligned and the polyline is bounded", () => {
		const cases: { from: ReturnType<typeof rect>; to: ReturnType<typeof rect> }[] = [
			{ from: rect(0, 0), to: rect(40, 30) },
			{ from: rect(40, 30), to: rect(0, 0) },
			{ from: rect(10, 40), to: rect(10, 2) },
			{ from: rect(60, 10), to: rect(2, 10) },
		];
		for (const { from, to } of cases) {
			for (const routing of ["auto", "horizontal-first", "vertical-first"] as const) {
				const route = routeEdge(from, to, { fromPort: "auto", toPort: "auto", routing });
				expect(route.points.length).toBeLessThanOrEqual(5);
				for (let index = 0; index < route.points.length - 1; index += 1) {
					const a = route.points[index]!;
					const b = route.points[index + 1]!;
					expect(a.x === b.x || a.y === b.y).toBe(true);
				}
			}
		}
	});

	test("explicit ports override the automatic choice", () => {
		const route = routeEdge(rect(2, 2), rect(30, 2), { fromPort: "south", toPort: "north", routing: "auto" });
		expect(route.points[0]).toEqual({ x: 2 + 8, y: 2 + 4 });
		expect(route.points.at(-1)).toEqual({ x: 30 + 8, y: 1 });
		expect(route.arrow).toBe("v");
	});

	test("one explicit port completes the pair with its opposite", () => {
		const route = routeEdge(rect(2, 2), rect(30, 2), { fromPort: "auto", toPort: "north", routing: "auto" });
		expect(route.points[0]).toEqual({ x: 2 + 8, y: 2 + 4 });
		expect(route.arrow).toBe("v");
	});

	test("corner names cover the eight direction changes and nothing else", () => {
		expect(cornerName({ dx: 1, dy: 0 }, { dx: 0, dy: 1 })).toBe("topRight");
		expect(cornerName({ dx: 0, dy: -1 }, { dx: -1, dy: 0 })).toBe("topRight");
		expect(cornerName({ dx: -1, dy: 0 }, { dx: 0, dy: -1 })).toBe("bottomLeft");
		expect(cornerName({ dx: 0, dy: 1 }, { dx: 1, dy: 0 })).toBe("bottomLeft");
		expect(cornerName({ dx: 1, dy: 0 }, { dx: 1, dy: 0 })).toBeUndefined();
		expect(cornerName({ dx: 1, dy: 0 }, { dx: -1, dy: 0 })).toBeUndefined();
	});
});

describe("document diff", () => {
	function fixture() {
		const document = createDocument({ id: "doc-1", title: "Service", goal: "Ship" });
		const api = createBlock({ id: "api", title: "API", description: "surface" });
		const db = createBlock({ id: "db", title: "Database" });
		document.root.blocks.push(api, db);
		document.root.edges.push(createEdge({ id: "e1", from: "api", to: "db", label: "stores" }));
		return document;
	}

	test("an identical document has an empty diff", () => {
		const document = fixture();
		expect(diffIsEmpty(diffDocuments(document, structuredClone(document)))).toBe(true);
		expect(diffIsEmpty(emptyDiff())).toBe(true);
	});

	test("reports additions, removals, field changes and relationship changes", () => {
		const before = fixture();
		const after = structuredClone(before);
		after.title = "Service v2";
		after.root.blocks[0]!.description = "new surface";
		after.root.blocks.push(createBlock({ id: "auth", title: "Auth" }));
		after.root.blocks.splice(1, 1);
		after.root.edges = [];
		const diff = diffDocuments(before, after);
		expect(diffIsEmpty(diff)).toBe(false);
		expect(diff.titleChanged).toEqual({ from: "Service", to: "Service v2" });
		expect(diff.added.map(entry => entry.id)).toEqual(["auth"]);
		expect(diff.removed.map(entry => entry.id)).toEqual(["db"]);
		expect(diff.modified).toEqual([{ id: "api", title: "API", fields: ["description"], path: "root" }]);
		expect(diff.edgesRemoved).toEqual(['API -> Database (stores)']);
	});

	test("nested additions are reported with their path", () => {
		const before = fixture();
		const after = structuredClone(before);
		after.root.blocks[0]!.children = createDiagram({ id: "inner", blocks: [createBlock({ id: "auth", title: "Auth" })] });
		const diff = diffDocuments(before, after);
		expect(diff.added).toEqual([{ id: "auth", title: "Auth", path: "root > API" }]);
		expect(diff.modified.map(entry => entry.fields)).toEqual([["children"]]);
	});
});

describe("source references", () => {
	test("round-trips path, path:line and path:range", () => {
		expect(parseSourceRef("src/app.ts")).toEqual({ path: "src/app.ts" });
		expect(parseSourceRef("src/app.ts:12")).toEqual({ path: "src/app.ts", startLine: 12, endLine: 12 });
		expect(parseSourceRef("src/app.ts:12-40 ")).toEqual({ path: "src/app.ts", startLine: 12, endLine: 40 });
		expect(formatSourceRef({ path: "a.ts", startLine: 3, endLine: 9 })).toBe("a.ts:3-9");
		expect(formatSourceRef({ path: "a.ts" })).toBe("a.ts");
	});
});
