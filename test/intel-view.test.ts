import { describe, expect, test } from "bun:test";
import { groupLocations, hoverParts, outlineTree, symbolView, syntaxSummary } from "../src/intel-view.ts";

describe("hover markdown", () => {
	test("a fenced signature, a rule and prose become code, a separator and plain text", () => {
		const hover = "```typescript\nfunction f(a: number): string\n```\n---\nDoes **things** with `a`.\n\n*@param* `a` — the [input](http://x)";
		expect(hoverParts(hover)).toEqual([
			{ kind: "code", language: "typescript", code: "function f(a: number): string" },
			{ kind: "rule" },
			{ kind: "text", text: "Does things with a." },
			{ kind: "text", text: "@param a — the input" },
		]);
	});

	test("escape sequences and control characters never reach the view; an unclosed fence runs to the end", () => {
		expect(hoverParts("\x1b[31mred\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07\x07\n```\nlet x\r\n")).toEqual([
			{ kind: "text", text: "red link" },
			{ kind: "code", language: undefined, code: "let x" },
		]);
	});

	test("rules at either end and stacked rules collapse", () => {
		expect(hoverParts("---\nplain\n***\n___\n")).toEqual([{ kind: "text", text: "plain" }]);
	});
});

describe("outline tree", () => {
	test("nested symbols with mixed kinds draw connectors that follow their siblings", () => {
		const rows = outlineTree([
			{ name: "Store", kind: "Class", startLine: 1, endLine: 40, depth: 0 },
			{ name: "path", kind: "Property", startLine: 2, endLine: 2, depth: 1 },
			{ name: "save", kind: "Method", startLine: 10, endLine: 30, depth: 1 },
			{ name: "temp", kind: "Variable", startLine: 12, endLine: 12, depth: 2 },
			{ name: "load", kind: "Method", startLine: 32, endLine: 39, depth: 1 },
			{ name: "open", kind: "Function", startLine: 42, endLine: 50, depth: 0 },
			{ name: "Weird", kind: "Macro", startLine: 52, endLine: 52, depth: 0 },
		]);
		expect(rows.map(row => `${row.tree}${row.kind} ${row.name}`)).toEqual([
			"class Store",
			"├─ prop path",
			"├─ method save",
			"│  └─ var temp",
			"└─ method load",
			"fn open",
			"macro Weird",
		]);
	});

	test("an ancestor with no later sibling leaves its column blank", () => {
		const rows = outlineTree([
			{ name: "A", kind: "Class", startLine: 1, endLine: 9, depth: 0 },
			{ name: "m", kind: "Method", startLine: 2, endLine: 8, depth: 1 },
			{ name: "x", kind: "Variable", startLine: 3, endLine: 3, depth: 2 },
			{ name: "y", kind: "Variable", startLine: 4, endLine: 4, depth: 2 },
		]);
		expect(rows.map(row => row.tree)).toEqual(["", "└─ ", "   ├─ ", "   └─ "]);
	});
});

describe("definitions and references", () => {
	test("references across two files group by file, the open file first, lines ascending, truncation kept", () => {
		const view = symbolView(
			{
				hover: "",
				definitions: [{ path: "src/b.ts", line: 3, preview: "export const total = 0;" }],
				references: [
					{ path: "src/b.ts", line: 9, preview: "total += 1;" },
					{ path: "src/a.ts", line: 20, preview: "use(total)" },
					{ path: "src/b.ts", line: 3, preview: "export const total = 0;" },
					{ path: "src/a.ts", line: 4, preview: "import { total }" },
				],
				truncated: true,
			},
			"src/a.ts",
		);
		expect(view.referenceTotal).toBe("4+");
		expect(view.references.map(group => [group.path, group.count, group.locations.map(location => location.line)])).toEqual([
			["src/a.ts", 2, [4, 20]],
			["src/b.ts", 2, [3, 9]],
		]);
		expect(view.definitions).toEqual([{ path: "src/b.ts", count: 1, locations: [{ path: "src/b.ts", line: 3, preview: "export const total = 0;" }] }]);
	});

	test("previews lose control sequences", () => {
		expect(groupLocations([{ path: "a.ts", line: 1, preview: "x\x1b[2J\x07y" }], undefined)[0]!.locations[0]!.preview).toBe("xy");
	});
});

describe("syntax insight", () => {
	test("node kinds read as words, innermost first, with the block they cover", () => {
		expect(
			syntaxSummary({
				symbols: [
					{ kind: "return_statement", startLine: 14, endLine: 14 },
					{ kind: "function_declaration", startLine: 12, endLine: 30 },
				],
				range: { startLine: 12, endLine: 30 },
				limitation: "syntax only: …",
			}),
		).toBe("syntax only · return statement in function declaration · block 12–30 (19 lines)");
	});

	test("with no parser context the limitation is the answer", () => {
		expect(syntaxSummary({ limitation: "no Tree-sitter grammar for this file type" })).toBe("no Tree-sitter grammar for this file type");
	});
});
