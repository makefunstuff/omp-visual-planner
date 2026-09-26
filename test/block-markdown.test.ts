import { describe, expect, test } from "bun:test";
import { blockToMarkdown, markdownToBlock } from "../src/block-markdown.ts";
import { createBlock } from "../src/model.ts";

const CODE = ["```ts", "# not a title", "## Acceptance", "export const ttl = 900;", "```"].join("\n");

function block() {
	return createBlock({
		id: "b",
		title: "Issuance",
		description: `Mint tokens.\n\n${CODE}\n\n### Open questions\n- rotate keys?`,
		expectedOutput: "an access/refresh pair",
		acceptanceCriteria: ["401 without credentials", "refresh persisted first"],
		sources: [{ path: "src/issue.ts", startLine: 10, endLine: 40 }],
		actions: { enhance: "tighten the claims", execute: "" },
	});
}

describe("a block as a markdown file", () => {
	test("round-trips every field, with code and sub-headings kept in the body", () => {
		const original = block();
		const text = blockToMarkdown(original, "plan");
		expect(text).toContain("# Issuance");
		expect(text).toContain("## Acceptance\n\n- [ ] 401 without credentials");
		const back = markdownToBlock(text, original);
		expect(back).toEqual({
			title: "Issuance",
			description: original.description,
			expectedOutput: "an access/refresh pair",
			acceptanceCriteria: ["401 without credentials", "refresh persisted first"],
			sources: [{ path: "src/issue.ts", startLine: 10, endLine: 40 }],
			enhance: "tighten the claims",
			execute: "",
		});
	});

	test("edits come back: checked items, plain bullets, a new code block, a cleared section", () => {
		const original = block();
		const edited = [
			"# Token issuance",
			"",
			"Mint tokens.",
			"",
			"```sh",
			"curl -X POST /token",
			"```",
			"",
			"## Acceptance",
			"",
			"- [x] 401 without credentials",
			"* jti on every token",
			"",
			"## Sources",
			"",
			"- src/issue.ts:12",
		].join("\n");
		const back = markdownToBlock(edited, original);
		expect(back.title).toBe("Token issuance");
		expect(back.description).toBe("Mint tokens.\n\n```sh\ncurl -X POST /token\n```");
		expect(back.acceptanceCriteria).toEqual(["401 without credentials", "jti on every token"]);
		expect(back.sources).toEqual([{ path: "src/issue.ts", startLine: 12, endLine: 12 }]);
		// Deleted from the file: cleared, not silently kept.
		expect(back.expectedOutput).toBe("");
		expect(back.enhance).toBe("");
	});

	test("a missing title keeps the current one; another purpose's headings still read back", () => {
		const original = block();
		const back = markdownToBlock("Just a note.\n\n## Anchors\n\n- lib/a.ts\n\n## Investigate notes\n\nread the tests", original);
		expect(back.title).toBe("Issuance");
		expect(back.description).toBe("Just a note.");
		expect(back.sources).toEqual([{ path: "lib/a.ts" }]);
		expect(back.enhance).toBe("read the tests");
	});

	test("a brainstorm file shows only the note, but never drops text a field already holds", () => {
		const idea = createBlock({ title: "Idea", description: "why not", expectedOutput: "kept" });
		const text = blockToMarkdown(idea, "brainstorm");
		expect(text).not.toContain("## Acceptance");
		expect(text).toContain("## Expected output\n\nkept");
	});
});
