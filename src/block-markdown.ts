/**
 * One block as a markdown file, for editing in an external editor.
 *
 * `# Title`, then the block's body — free markdown, so code fences, lists and
 * `###` headings are all just part of the text — then one `## <field>` section
 * per structured field the document's purpose uses (or that already holds
 * text, so nothing is ever dropped). Only a `##` line naming a known field ends
 * the body; any other heading, and anything inside a code fence, stays text.
 */
import { type PageField, fieldLabel, pageFields } from "./flow.ts";
import { type Block, PURPOSES, type Purpose, type SourceRef, formatSourceRef, parseSourceRef } from "./model.ts";

type SectionField = Exclude<PageField, "title" | "description" | "evidence">;
const SECTIONS: readonly SectionField[] = ["expectedOutput", "criteria", "sources", "enhance", "execute"];

export interface BlockText {
	title: string;
	description: string;
	expectedOutput: string;
	acceptanceCriteria: string[];
	sources: SourceRef[];
	enhance: string;
	execute: string;
}

const HEADER = "<!-- omp-visual-planner block: the body is free markdown; the ## sections below are read back as fields. -->";

function heading(label: string): string {
	return label.charAt(0).toUpperCase() + label.slice(1);
}

function sectionText(block: Block, field: SectionField): string {
	switch (field) {
		case "expectedOutput":
			return block.expectedOutput.trim();
		case "criteria":
			return block.acceptanceCriteria.map(item => `- [ ] ${item}`).join("\n");
		case "sources":
			return block.sources.map(source => `- ${formatSourceRef(source)}`).join("\n");
		case "enhance":
			return block.actions.enhance.trim();
		case "execute":
			return block.actions.execute.trim();
	}
}

export function blockToMarkdown(block: Block, purpose: Purpose): string {
	const shown = new Set(pageFields(purpose));
	const parts = [HEADER, "", `# ${block.title}`, ""];
	if (block.description.trim().length > 0) parts.push(block.description.trim(), "");
	for (const field of SECTIONS) {
		const text = sectionText(block, field);
		if (!shown.has(field) && text.length === 0) continue;
		parts.push(`## ${heading(fieldLabel(purpose, field))}`, "");
		if (text.length > 0) parts.push(text, "");
	}
	return `${parts.join("\n").trimEnd()}\n`;
}

/** Every label any purpose uses for a section, so switching purpose never orphans a heading. */
function sectionByHeading(): Map<string, SectionField> {
	const map = new Map<string, SectionField>();
	for (const purpose of PURPOSES) {
		for (const field of SECTIONS) map.set(fieldLabel(purpose, field).toLowerCase(), field);
	}
	return map;
}

const FENCE = /^\s*(```|~~~)/;

function listItems(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "").trim())
		.filter(line => line.length > 0);
}

/**
 * Read an edited file back. A missing `# Title` keeps the current title; a
 * section that was deleted from the file clears that field.
 */
export function markdownToBlock(markdown: string, current: Block): BlockText {
	const known = sectionByHeading();
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let title: string | undefined;
	const body: string[] = [];
	const sections = new Map<SectionField, string[]>();
	let into: string[] = body;
	let fence: string | undefined;
	for (const line of lines) {
		const opener = FENCE.exec(line)?.[1];
		if (fence !== undefined) {
			if (opener === fence) fence = undefined;
			into.push(line);
			continue;
		}
		if (opener !== undefined) {
			fence = opener;
			into.push(line);
			continue;
		}
		const onlyPreamble = body.every(entry => entry.trim().length === 0 || /^<!--.*-->$/.test(entry.trim()));
		if (title === undefined && into === body && /^#\s+\S/.test(line) && onlyPreamble) {
			title = line.replace(/^#\s+/, "").trim();
			continue;
		}
		const section = /^##\s+(.+?)\s*$/.exec(line)?.[1];
		const field = section === undefined ? undefined : known.get(section.toLowerCase());
		if (field !== undefined) {
			into = [];
			sections.set(field, into);
			continue;
		}
		into.push(line);
	}
	const text = (field: SectionField) => (sections.get(field) ?? []).join("\n").trim();
	const description = body
		.join("\n")
		.replace(/^\s*<!--[\s\S]*?-->\s*/, "")
		.trim();
	return {
		title: title && title.length > 0 ? title : current.title,
		description,
		expectedOutput: text("expectedOutput"),
		acceptanceCriteria: listItems(text("criteria")),
		sources: listItems(text("sources")).map(parseSourceRef).filter(source => source.path.length > 0),
		enhance: text("enhance"),
		execute: text("execute"),
	};
}
