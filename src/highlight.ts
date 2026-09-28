/**
 * Syntax highlighting for web mode, with the same native highlighter the
 * terminal uses. It emits ANSI colors per token class; each class is given its
 * own marker color here, so the output reads back as `[class, text]` spans the
 * page styles with its own tokens. Nothing from the file becomes markup.
 */
import { type HighlightColors, highlightCode, supportsLanguage } from "@oh-my-pi/pi-natives";
import { getLanguageFromPath } from "@oh-my-pi/pi-tui";

export const TOKEN_CLASSES = [
	"comment",
	"keyword",
	"function",
	"variable",
	"string",
	"number",
	"type",
	"operator",
	"punctuation",
] as const;
export type TokenClass = (typeof TOKEN_CLASSES)[number];

/** One run of text; class "" is plain. */
export type Span = [TokenClass | "", string];

const MARKERS = Object.fromEntries(TOKEN_CLASSES.map((name, index) => [name, `\x1b[38;5;${16 + index}m`])) as Record<
	TokenClass,
	string
>;
const BY_MARKER = new Map<string, TokenClass>(TOKEN_CLASSES.map(name => [MARKERS[name], name]));
const ESCAPE = /\x1b\[[0-9;]*m/g;

/** Highlighted lines for a file, or undefined when its language is unknown. */
export function highlightLines(code: string, path: string): Span[][] | undefined {
	return highlightLanguage(code, getLanguageFromPath(path));
}

/** Highlighted lines for code in a named language (a fence tag such as `ts`), or undefined when it is unknown. */
export function highlightLanguage(code: string, language: string | undefined): Span[][] | undefined {
	if (!language || !supportsLanguage(language)) return undefined;
	let colored: string;
	try {
		colored = highlightCode(code, language, MARKERS as HighlightColors);
	} catch {
		return undefined;
	}
	const lines: Span[][] = [[]];
	let current: TokenClass | "" = "";
	const push = (text: string) => {
		const parts = text.split("\n");
		parts.forEach((part, index) => {
			if (index > 0) lines.push([]);
			if (part.length > 0) lines.at(-1)!.push([current, part]);
		});
	};
	let last = 0;
	for (const match of colored.matchAll(ESCAPE)) {
		push(colored.slice(last, match.index));
		// A marker opens its class; any other sequence (a reset) closes it.
		current = BY_MARKER.get(match[0]) ?? "";
		last = match.index! + match[0].length;
	}
	push(colored.slice(last));
	return lines;
}
