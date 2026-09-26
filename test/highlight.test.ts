import { describe, expect, test } from "bun:test";
import { highlightLines } from "../src/highlight.ts";

describe("highlighting for the web viewer", () => {
	test("spans reproduce the file exactly, line by line, with token classes", () => {
		const code = 'export function add(a: number): number {\n\n  return a + 1; // one\n}\nconst s = "x";';
		const lines = highlightLines(code, "src/math.ts")!;
		expect(lines.map(line => line.map(([, text]) => text).join(""))).toEqual(code.split("\n"));
		const classes = new Set<string>(lines.flat().map(([kind]) => kind));
		for (const kind of ["keyword", "function", "type", "number", "comment", "string"]) expect(classes).toContain(kind);
		expect(lines[1]).toEqual([]);
	});

	test("an unknown language is plain text, not a guess", () => {
		expect(highlightLines("anything", "notes.unknownext")).toBeUndefined();
	});
});
