import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNTAX_ONLY_LIMITATION, type SourceInsight, inspectSource } from "../src/code-evidence.ts";

/** A cited declaration at line 5, its body at line 6, an arrow const at line 10. */
const SOURCE = [
	"export interface Token {",
	"\tvalue: string;",
	"}",
	"",
	"export function mint(value: string): Token {",
	"\tconst token = { value };",
	"\treturn token;",
	"}",
	"",
	"export const revoke = (token: Token): void => {",
	"\tvoid token;",
	"};",
].join("\n");

type Insight = SourceInsight & { ok: true };

const directories: string[] = [];

async function workspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "omp-visual-planner-"));
	directories.push(dir);
	return dir;
}

async function inspected(cwd: string, path: string, line: number): Promise<Insight> {
	const insight = await inspectSource(cwd, path, line);
	expect(insight.ok).toBe(true);
	if (!insight.ok) throw new Error(insight.error);
	return insight;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("source insight", () => {
	test("a cited line in a TypeScript function resolves to that function's syntax range", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "tokens.ts"), SOURCE);
		const declaration = await inspected(dir, "tokens.ts", 5);
		expect(declaration.range).toEqual({ startLine: 5, endLine: 8 });
		expect(declaration.limitation).toBe(SYNTAX_ONLY_LIMITATION);
		const body = await inspected(dir, "tokens.ts", 6);
		// The node kinds are grammar kinds, innermost first: syntax, never a reference.
		const kinds = body.symbols?.map(node => node.kind) ?? [];
		expect(kinds).toContain("function_declaration");
		expect(kinds.at(-1)).toBe("export_statement");
		// The closing brace begins no block, but the line is still inside the function.
		const closing = await inspected(dir, "tokens.ts", 8);
		expect(closing.range).toBeUndefined();
		expect(closing.limitation).toBe("no syntax block begins at line 8");
		expect(closing.symbols?.map(node => node.kind)).toContain("function_declaration");
	});

	test("a file type without a grammar reports that the line has no syntax context", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "notes.txt"), "just prose\nsecond line\n");
		const insight = await inspected(dir, "notes.txt", 1);
		expect(insight.range).toBeUndefined();
		expect(insight.symbols).toBeUndefined();
		expect(insight.limitation).toContain("no Tree-sitter grammar");
	});

	test("a path that leaves the workspace is refused", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "tokens.ts"), SOURCE);
		const outside = await workspace();
		await writeFile(join(outside, "outside.ts"), "export const x = 1;\n");
		await symlink(join(outside, "outside.ts"), join(dir, "link.ts"));

		const traversal = await inspectSource(dir, "../outside.ts", 1);
		expect(traversal).toMatchObject({ ok: false, status: 400 });
		expect(traversal.ok ? "" : traversal.error).toContain("relative to the workspace");
		expect(await inspectSource(dir, join(dir, "tokens.ts"), 1)).toMatchObject({ ok: false, status: 400 });
		// The symlink is inside the workspace; its target is not.
		expect(await inspectSource(dir, "link.ts", 1)).toMatchObject({ ok: false, status: 403 });
		expect(await inspectSource(dir, "missing.ts", 1)).toMatchObject({ ok: false, status: 404 });
		expect(await inspectSource(dir, "tokens.ts", 0)).toMatchObject({ ok: false, status: 400 });
	});

	test("a line past the end of the file is an empty answer, not a failure", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "tokens.ts"), SOURCE);
		const insight = await inspected(dir, "tokens.ts", 99);
		expect(insight.range).toBeUndefined();
		expect(insight.symbols).toBeUndefined();
		expect(insight.limitation).toBe("tokens.ts has only 12 lines");
	});
});
