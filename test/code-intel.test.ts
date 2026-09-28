import { describe, expect, test } from "bun:test";
import { identifiersOn, normalizeLocations, normalizeOutline } from "../src/code-intel.ts";

const R = (a: number, b: number) => ({ start: { line: a, character: 0 }, end: { line: b, character: 0 } });

describe("language-server answers", () => {
	test("a DocumentSymbol tree flattens depth-first with 1-based lines", () => {
		const outline = normalizeOutline(
			[{ name: "A", kind: 5, range: R(0, 9), selectionRange: R(0, 0), children: [{ name: "m", kind: 6, range: R(2, 4), selectionRange: R(2, 2) }] }],
			String,
		);
		expect(outline).toEqual([
			{ name: "A", kind: "5", startLine: 1, endLine: 10, depth: 0 },
			{ name: "m", kind: "6", startLine: 3, endLine: 5, depth: 1 },
		]);
	});

	test("SymbolInformation reads its lines from the location, at depth 0", () => {
		expect(normalizeOutline([{ name: "f", kind: 12, location: { uri: "file:///a.ts", range: R(4, 7) } }], String)).toEqual([
			{ name: "f", kind: "12", startLine: 5, endLine: 8, depth: 0 },
		]);
		expect(normalizeOutline(null, String)).toEqual([]);
	});

	test("locations come from a Location, a Location list or LocationLinks", () => {
		expect(normalizeLocations(null)).toEqual([]);
		expect(normalizeLocations({ uri: "file:///a.ts", range: R(2, 2) })).toEqual([{ uri: "file:///a.ts", line: 3 }]);
		expect(
			normalizeLocations([{ targetUri: "file:///b.ts", targetRange: R(0, 20), targetSelectionRange: R(9, 9), originSelectionRange: R(1, 1) }]),
		).toEqual([{ uri: "file:///b.ts", line: 10 }]);
	});

	test("identifiers on a line keep their first column and are not repeated", () => {
		expect(identifiersOn("const total = sum(items, total)")).toEqual([
			{ name: "const", character: 0 },
			{ name: "total", character: 6 },
			{ name: "sum", character: 14 },
			{ name: "items", character: 18 },
		]);
	});
});
