/**
 * How the file viewers present code intel, shared by the terminal and the
 * browser so both show the same labels. Pure: no highlighter, no theme, no DOM.
 * Each surface highlights the code parts and styles the pieces itself.
 *
 * Everything here is text. Server and file text is stripped of terminal
 * control sequences before it is returned, and nothing is ever turned into
 * markup: a hover's markdown is read into parts, not rendered as HTML.
 */
import type { CodeLocation, OutlineSymbol, SymbolFacts } from "./code-intel.ts";
import type { SourceInsight } from "./code-evidence.ts";

// ---------------------------------------------------------------------------
// Control sequences
// ---------------------------------------------------------------------------

/** CSI and OSC/DCS/APC string sequences, then any other lone escape. */
const ESCAPE_SEQUENCES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\)|\x1b[@-_]?/g;
/** C0 and C1 controls other than tab and newline. */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Text as it may be shown: no escape sequences, no control characters but tab and newline. */
export function stripControls(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(ESCAPE_SEQUENCES, "").replace(CONTROLS, "");
}

// ---------------------------------------------------------------------------
// Hover markdown
// ---------------------------------------------------------------------------

export type HoverPart =
	| { kind: "code"; language: string | undefined; code: string }
	| { kind: "text"; text: string }
	| { kind: "rule" };

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Inline markdown read as plain text: code spans, emphasis and links lose their markers. */
export function plainInline(text: string): string {
	return text
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
		.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
		.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
}

/**
 * A hover's markdown as parts: fenced code with its language, prose paragraphs
 * with inline markers removed, and thematic breaks. An unclosed fence runs to
 * the end. Blank-line runs separate paragraphs; a paragraph keeps its line breaks
 * so list items stay on their own lines.
 */
export function hoverParts(hover: string): HoverPart[] {
	const parts: HoverPart[] = [];
	const lines = stripControls(hover).split("\n");
	let paragraph: string[] = [];
	const flush = (): void => {
		if (paragraph.length > 0) parts.push({ kind: "text", text: paragraph.join("\n") });
		paragraph = [];
	};
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const fence = FENCE_OPEN.exec(line);
		if (fence) {
			flush();
			const marker = fence[1]!;
			const body: string[] = [];
			index += 1;
			while (index < lines.length && !lines[index]!.trim().startsWith(marker)) {
				body.push(lines[index]!);
				index += 1;
			}
			while (body.length > 0 && body.at(-1)!.trim() === "") body.pop();
			const language = fence[2]!.toLowerCase();
			if (body.length > 0) parts.push({ kind: "code", language: language.length > 0 ? language : undefined, code: body.join("\n") });
			continue;
		}
		if (RULE.test(line)) {
			flush();
			if (parts.length > 0 && parts.at(-1)!.kind !== "rule") parts.push({ kind: "rule" });
			continue;
		}
		if (line.trim() === "") {
			flush();
			continue;
		}
		paragraph.push(plainInline(line.trimEnd()));
	}
	flush();
	while (parts.at(-1)?.kind === "rule") parts.pop();
	return parts;
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

/** Short labels for LSP symbol kind names; anything else is lowercased. */
const KIND_LABELS: Readonly<Record<string, string>> = {
	File: "file",
	Module: "mod",
	Namespace: "ns",
	Package: "pkg",
	Class: "class",
	Method: "method",
	Property: "prop",
	Field: "field",
	Constructor: "ctor",
	Enum: "enum",
	Interface: "iface",
	Function: "fn",
	Variable: "var",
	Constant: "const",
	String: "str",
	Number: "num",
	Boolean: "bool",
	Array: "array",
	Object: "obj",
	Key: "key",
	Null: "null",
	EnumMember: "member",
	Struct: "struct",
	Event: "event",
	Operator: "op",
	TypeParameter: "type",
};

export function kindLabel(kind: string): string {
	return KIND_LABELS[kind] ?? stripControls(kind).toLowerCase();
}

export interface OutlineTreeRow {
	/** Tree connectors drawn before the label: `├─ `, `└─ `, and `│  ` for open ancestors. */
	tree: string;
	kind: string;
	name: string;
	startLine: number;
	endLine: number;
}

/**
 * The depth-first symbol list as a tree. A row's connector says whether a later
 * sibling follows it; an ancestor's column keeps a `│` while that ancestor has one.
 * Top-level symbols carry no connector.
 */
export function outlineTree(symbols: readonly OutlineSymbol[]): OutlineTreeRow[] {
	const hasNext: boolean[] = new Array(symbols.length).fill(false);
	const seen: boolean[] = [];
	for (let index = symbols.length - 1; index >= 0; index -= 1) {
		const depth = symbols[index]!.depth;
		hasNext[index] = seen[depth] === true;
		seen[depth] = true;
		seen.length = depth + 1;
	}
	const open: boolean[] = [];
	return symbols.map((symbol, index) => {
		const depth = symbol.depth;
		open[depth] = hasNext[index]!;
		let tree = "";
		for (let level = 1; level < depth; level += 1) tree += open[level] ? "│  " : "   ";
		if (depth > 0) tree += hasNext[index] ? "├─ " : "└─ ";
		return {
			tree,
			kind: kindLabel(symbol.kind),
			name: stripControls(symbol.name),
			startLine: symbol.startLine,
			endLine: symbol.endLine,
		};
	});
}

// ---------------------------------------------------------------------------
// Definitions and references
// ---------------------------------------------------------------------------

export interface LocationGroup {
	path: string;
	count: number;
	locations: CodeLocation[];
}

/** Locations grouped by file: the open file first, then files in first-seen order; lines ascending in each. */
export function groupLocations(locations: readonly CodeLocation[], currentPath: string | undefined): LocationGroup[] {
	const groups = new Map<string, CodeLocation[]>();
	for (const location of locations) {
		const clean = { path: stripControls(location.path), line: location.line, preview: stripControls(location.preview) };
		const list = groups.get(clean.path);
		if (list) list.push(clean);
		else groups.set(clean.path, [clean]);
	}
	const ordered = [...groups.entries()].map(([path, list]) => ({
		path,
		count: list.length,
		locations: list.sort((a, b) => a.line - b.line),
	}));
	const current = ordered.findIndex(group => group.path === currentPath);
	if (current > 0) ordered.unshift(...ordered.splice(current, 1));
	return ordered;
}

/** `12`, or `100+` when the server had more than were kept. */
export function referenceTotal(count: number, truncated: boolean): string {
	return `${count}${truncated ? "+" : ""}`;
}

export interface SymbolView {
	hover: HoverPart[];
	definitions: LocationGroup[];
	references: LocationGroup[];
	referenceTotal: string;
}

export function symbolView(facts: SymbolFacts, currentPath: string | undefined): SymbolView {
	return {
		hover: hoverParts(facts.hover),
		definitions: groupLocations(facts.definitions, currentPath),
		references: groupLocations(facts.references, currentPath),
		referenceTotal: referenceTotal(facts.references.length, facts.truncated),
	};
}

// ---------------------------------------------------------------------------
// Tree-sitter context
// ---------------------------------------------------------------------------

/** `function_declaration` → `function declaration`. */
export function humanizeNodeKind(kind: string): string {
	return stripControls(kind).replace(/[_-]+/g, " ").trim();
}

/**
 * One line for a cited line's syntax context, innermost node first:
 * `syntax only · return statement in function declaration · block 12–30 (19 lines)`.
 * With no parser context it is the insight's own limitation.
 */
export function syntaxSummary(insight: Pick<SourceInsight, "symbols" | "range" | "limitation">): string {
	const nodes = insight.symbols ?? [];
	if (nodes.length === 0) return insight.limitation;
	const chain = nodes.map(node => humanizeNodeKind(node.kind)).join(" in ");
	const range = insight.range;
	const block = range
		? ` · block ${range.startLine}–${range.endLine} (${range.endLine - range.startLine + 1} line${range.endLine === range.startLine ? "" : "s"})`
		: "";
	return `syntax only · ${chain}${block}`;
}
