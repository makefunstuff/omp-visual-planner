/**
 * One-shot converter: a schema-1 planner document (.omp-visual-planner/*.json)
 * into a plan tree of markdown directories.
 *
 *   bun scripts/json-to-tree.ts <document.json> <out-dir> [--repo <dir>]
 *
 * `--repo` (default: the working directory) is what the document's source paths
 * are relative to. The out-dir must not exist or be empty.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

// Only what the converter reads of a schema-1 document.
interface SourceRef {
	path: string;
	startLine?: number;
	endLine?: number;
}
interface Block {
	id: string;
	title: string;
	description?: string;
	expectedOutput?: string;
	acceptanceCriteria?: string[];
	sources?: SourceRef[];
	status?: string;
	venue?: string;
	surface?: string;
	mockup?: string;
	uses?: string[];
	actions?: { enhance?: string; execute?: string };
	children?: Diagram | null;
}
interface Edge {
	from: string;
	to: string;
	label?: string;
}
interface Diagram {
	blocks: Block[];
	edges?: Edge[];
}
interface Document {
	schemaVersion: number;
	title?: string;
	goal?: string;
	purpose?: string;
	root: Diagram;
}

export class ConvertError extends Error {
	override name = "ConvertError";
}

function slug(title: string): string {
	const cut = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	return cut || "node";
}

/** A link destination the tree reader decodes back. */
function href(path: string): string {
	return path.split(sep).join("/").replace(/[ ()<>]/g, char => encodeURIComponent(char));
}

/** Link text that cannot close the brackets. */
function text(label: string): string {
	return label.replace(/[\\[\]]/g, char => `\\${char}`);
}

/** The first ```wireframe fence, and the description without it (flow.ts's detection). */
function splitWireframe(description: string): { rest: string; fence: string | undefined } {
	const lines = description.split("\n");
	const start = lines.findIndex(line => /^\s*(```|~~~)\s*wireframe\b/.test(line));
	if (start === -1) return { rest: description, fence: undefined };
	const marker = lines[start]!.trim().slice(0, 3);
	let end = lines.length - 1;
	for (let i = start + 1; i < lines.length; i += 1) {
		if (lines[i]!.trimStart().startsWith(marker)) {
			end = i;
			break;
		}
	}
	const before = lines.slice(0, start);
	const after = lines.slice(end + 1);
	// The blank lines that framed the fence collapse into one.
	if (before.at(-1)?.trim() === "" && after[0]?.trim() === "") after.shift();
	return { rest: [...before, ...after].join("\n"), fence: lines.slice(start, end + 1).join("\n") };
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
	try {
		if (!(await stat(dir)).isDirectory()) return false;
	} catch {
		return true;
	}
	return (await readdir(dir)).length === 0;
}

export async function convertDocument(document: unknown, outDir: string, repoDir: string, sourceLabel: string): Promise<number> {
	const doc = document as Document;
	if (typeof document !== "object" || document === null || doc.schemaVersion !== 1 || !Array.isArray(doc.root?.blocks)) {
		throw new ConvertError("only schema-1 planner documents convert");
	}
	const out = resolve(outDir);
	const repo = resolve(repoDir);
	if (!(await isEmptyOrMissing(out))) throw new ConvertError(`${outDir} is not empty`);

	// Every block's directory first: edges and uses may point anywhere in the document.
	const dirs = new Map<string, string>();
	const titles = new Map<string, string>();
	const assign = (diagram: Diagram, parent: string): void => {
		const width = Math.max(2, String(diagram.blocks.length).length);
		diagram.blocks.forEach((block, index) => {
			const dir = join(parent, `${String(index + 1).padStart(width, "0")}-${slug(block.title)}`);
			dirs.set(block.id, dir);
			titles.set(block.id, block.title);
			if (block.children) assign(block.children, dir);
		});
	};
	assign(doc.root, out);

	await mkdir(out, { recursive: true });
	const root = [`# ${doc.title ?? "Plan"}`, ""];
	if (doc.goal?.trim()) root.push(doc.goal.trim(), "");
	root.push(`_Converted from \`${sourceLabel}\` (purpose: ${doc.purpose ?? "plan"})._`, "");
	await writeFile(join(out, "index.md"), root.join("\n"));

	let count = 1;
	const write = async (diagram: Diagram): Promise<void> => {
		for (const block of diagram.blocks) {
			count += 1;
			const dir = dirs.get(block.id)!;
			await mkdir(dir, { recursive: true });
			const link = (target: string) => `${href(relative(dir, target))}/`;
			const { rest, fence } = splitWireframe(block.description ?? "");

			const lines: string[] = [];
			const venue = block.venue === "subagent" || block.venue === "worktree" ? block.venue : undefined;
			const status = block.status && block.status !== "open" ? block.status : undefined;
			if (status || venue) lines.push("---", ...(status ? [`status: ${status}`] : []), ...(venue ? [`venue: ${venue}`] : []), "---");
			lines.push(`# ${block.title}`, "");
			if (rest.trim()) lines.push(rest.trim(), "");
			if (block.expectedOutput?.trim()) lines.push("## Expected output", "", block.expectedOutput.trim(), "");
			const criteria = block.acceptanceCriteria ?? [];
			if (criteria.length > 0) lines.push("## Acceptance criteria", "", ...criteria.map(item => `- [ ] ${item}`), "");
			const sources = block.sources ?? [];
			if (sources.length > 0) {
				lines.push("## Sources", "");
				for (const source of sources) {
					const range = source.startLine === undefined ? "" : source.endLine === undefined ? `${source.startLine}` : `${source.startLine}-${source.endLine}`;
					const fragment = source.startLine === undefined ? "" : source.endLine === undefined ? `#L${source.startLine}` : `#L${source.startLine}-L${source.endLine}`;
					lines.push(`- [${text(source.path + (range ? `:${range}` : ""))}](${href(relative(dir, join(repo, source.path)))}${fragment})`);
				}
				lines.push("");
			}
			const links = [
				...(diagram.edges ?? [])
					.filter(edge => edge.from === block.id && dirs.has(edge.to))
					.map(edge => `- [${text(edge.label?.trim() || titles.get(edge.to)!)}](${link(dirs.get(edge.to)!)})`),
				...(block.uses ?? []).filter(id => dirs.has(id)).map(id => `- [uses](${link(dirs.get(id)!)})`),
			];
			if (links.length > 0) lines.push("## Links", "", ...links, "");
			const notes = [
				...(block.actions?.enhance?.trim() ? [`enhance: ${block.actions.enhance.trim()}`] : []),
				...(block.actions?.execute?.trim() ? [`execute: ${block.actions.execute.trim()}`] : []),
			];
			if (notes.length > 0) lines.push("## Notes", "", notes.join("\n\n"), "");
			await writeFile(join(dir, "index.md"), lines.join("\n"));

			const design = fence !== undefined ? `${fence}\n` : block.surface && !block.mockup ? `Surface: ${block.surface} — not sketched yet.\n` : undefined;
			if (block.mockup || design !== undefined) await mkdir(join(dir, "design"), { recursive: true });
			if (block.mockup) await writeFile(join(dir, "design", "preview.html"), block.mockup);
			if (design !== undefined) await writeFile(join(dir, "design", "design.md"), design);

			if (block.children) await write(block.children);
		}
	};
	await write(doc.root);
	return count;
}

const USAGE = "usage: bun scripts/json-to-tree.ts <document.json> <out-dir> [--repo <dir>]";

if (import.meta.main) {
	const positional: string[] = [];
	let repo = process.cwd();
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--repo") {
			const value = args[(i += 1)];
			if (value === undefined) {
				console.error(`--repo needs a directory\n${USAGE}`);
				process.exit(2);
			}
			repo = value;
		} else if (arg.startsWith("-")) {
			console.error(`unknown flag ${arg}\n${USAGE}`);
			process.exit(2);
		} else positional.push(arg);
	}
	if (positional.length !== 2) {
		console.error(USAGE);
		process.exit(2);
	}
	const [input, outDir] = positional as [string, string];
	let document: unknown;
	try {
		document = JSON.parse(await readFile(input, "utf8"));
	} catch (error) {
		console.error(`cannot read ${input}: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	try {
		const count = await convertDocument(document, outDir, repo, input);
		console.log(`wrote ${count} nodes under ${outDir}`);
	} catch (error) {
		if (!(error instanceof ConvertError)) throw error;
		console.error(error.message);
		process.exit(1);
	}
}
