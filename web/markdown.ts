/**
 * The block-description markdown the page reads, parsed with mdast (CommonMark
 * plus GFM task lists) into data the Markdown component renders as text:
 * authored text never becomes markup.
 */
import type { PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";

export type Inline = { kind: "text" | "code" | "strong"; text: string };

export type MarkdownBlock =
	| { kind: "p"; parts: Inline[] }
	| { kind: "h"; parts: Inline[] }
	| { kind: "code"; lang: string; text: string }
	| { kind: "ul"; items: { box: string | undefined; parts: Inline[] }[] };

function parse(text: string): RootContent[] {
	return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }).children;
}

/** Inline code and bold keep their look; everything else reads as its text. */
function inline(nodes: readonly PhrasingContent[]): Inline[] {
	return nodes.map(node =>
		node.type === "inlineCode" ? { kind: "code", text: node.value } : node.type === "strong" ? { kind: "strong", text: toString(node) } : { kind: "text", text: toString(node) },
	);
}

function block(node: RootContent): MarkdownBlock | undefined {
	switch (node.type) {
		case "code":
			return { kind: "code", lang: node.lang ?? "", text: node.value };
		case "heading":
			return { kind: "h", parts: inline(node.children) };
		case "paragraph":
			return { kind: "p", parts: inline(node.children) };
		case "list":
			return {
				kind: "ul",
				items: node.children.map(item => {
					const first = item.children[0];
					const parts = first?.type === "paragraph" ? inline(first.children) : [{ kind: "text" as const, text: toString(item) }];
					return { box: item.checked === null || item.checked === undefined ? undefined : item.checked ? "[x] " : "[ ] ", parts };
				}),
			};
		default: {
			const text = toString(node).trim();
			return text ? { kind: "p", parts: [{ kind: "text", text }] } : undefined;
		}
	}
}

export function parseMarkdown(text: string): MarkdownBlock[] {
	return parse(text).flatMap(node => block(node) ?? []);
}

/** The collapsed node's two lines: the prose, without code or markup. */
export function summary(text: string): string {
	return parse(text)
		.filter(node => node.type !== "code")
		.map(node => toString(node))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

export function hasCode(text: string): boolean {
	return parse(text).some(node => node.type === "code");
}
