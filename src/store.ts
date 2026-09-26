/**
 * Project documents on disk.
 *
 * The store is the only writer. It keeps the last on-disk digest so an
 * external edit is refused rather than silently overwritten, and it keeps the
 * in-memory undo history so a rejection leaves authored state untouched.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	type ArkTypeNamespace,
	type Block,
	type BlockStatus,
	type Diagram,
	type DiagramDocument,
	type Purpose,
	SCHEMA_VERSION,
	createDocument,
	eachBlock,
	findBlockLocation,
	findOwnedDiagram,
	importLegacyBoard,
	validateDocument,
} from "./model.ts";

export const PROJECT_DIR = ".omp-visual-planner";
export const DISCOVERY_DIR = "discovery";
export const DEFAULT_DOCUMENT_NAME = "architecture.json";
export const SESSION_NAMESPACE = "makefunstuff.omp-visual-planner.state";

/** Files above this size are never read blindly into a viewer. */
export const MAX_VIEWER_FILE_BYTES = 2 * 1024 * 1024;

export function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "repo";
}

export function defaultDocumentPath(cwd: string): string {
	return join(cwd, PROJECT_DIR, DEFAULT_DOCUMENT_NAME);
}

/** A persisted path is relative to the session's project, not the process cwd. */
export function resolveSessionPath(path: string | undefined, cwd: string): string {
	const chosen = path && path.length > 0 ? path : defaultDocumentPath(cwd);
	return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);
}

/** Discovery drafts land beside the project file, one document per target directory. */
export function defaultDiscoveryPath(cwd: string, target: string): string {
	const resolved = resolve(cwd, target).replace(/[/\\]+$/, "");
	const head = resolved.split(/[/\\]/).pop() ?? "";
	return join(cwd, PROJECT_DIR, DISCOVERY_DIR, `${slugify(head)}.json`);
}

export function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return rel.length > 0 && !rel.startsWith("..") ? rel : path;
}

/**
 * Explicit field order, so two structurally equal documents serialize
 * byte-identically — including text a model authored in a different key order.
 */
function normalizeDocument(document: DiagramDocument): DiagramDocument {
	const normalizeDiagram = (diagram: Diagram): Diagram => ({
		id: diagram.id,
		blocks: diagram.blocks.map(block => ({
			id: block.id,
			title: block.title,
			description: block.description,
			expectedOutput: block.expectedOutput,
			acceptanceCriteria: [...block.acceptanceCriteria],
			position: { x: block.position.x, y: block.position.y },
			sources: block.sources.map(source => {
				const entry: { path: string; startLine?: number; endLine?: number } = { path: source.path };
				if (source.startLine !== undefined) entry.startLine = source.startLine;
				if (source.endLine !== undefined) entry.endLine = source.endLine;
				return entry;
			}),
			evidence: block.evidence,
			status: block.status,
			actions: { enhance: block.actions.enhance, execute: block.actions.execute },
			children: block.children ? normalizeDiagram(block.children) : null,
		})),
		edges: diagram.edges.map(edge => ({
			id: edge.id,
			from: edge.from,
			to: edge.to,
			label: edge.label,
			direction: edge.direction,
			routing: edge.routing,
			fromPort: edge.fromPort,
			toPort: edge.toPort,
		})),
	});
	return {
		schemaVersion: SCHEMA_VERSION,
		id: document.id,
		title: document.title,
		goal: document.goal,
		purpose: document.purpose,
		revision: document.revision,
		root: normalizeDiagram(document.root),
	};
}

export function serializeDocument(document: DiagramDocument): string {
	return `${JSON.stringify(normalizeDocument(document), null, 2)}\n`;
}

export function digestOfText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export type OpenResult =
	| { ok: true; kind: "project" | "legacy-import"; path: string; summary: string }
	| { ok: false; kind: "missing" | "malformed"; path: string; errors: string[] };

export type SaveResult =
	| { ok: true; path: string; digest: string; replaced?: boolean }
	| { ok: false; kind: "conflict" | "error" | "no-document" | "no-path"; path?: string; errors: string[] };

export interface StoreSnapshot {
	document: DiagramDocument;
	path: string | undefined;
	dirty: boolean;
}

export class DocumentStore {
	readonly #arktype: ArkTypeNamespace;
	#path: string | undefined;
	#document: DiagramDocument | undefined;
	#diskDigest: string | undefined;
	#dirty = false;
	#undo: DiagramDocument[] = [];
	#redo: DiagramDocument[] = [];
	/** Why the document on disk is not a project document, when it was imported. */
	#importNotice: string | undefined;

	constructor(arktype: ArkTypeNamespace) {
		this.#arktype = arktype;
	}

	get path(): string | undefined {
		return this.#path;
	}

	get document(): DiagramDocument | undefined {
		return this.#document;
	}

	/** Required document accessor for callers that already established presence. */
	require(): DiagramDocument {
		if (!this.#document) throw new Error("no project document is open");
		return this.#document;
	}

	get dirty(): boolean {
		return this.#dirty;
	}

	get hasDocument(): boolean {
		return this.#document !== undefined;
	}

	get importNotice(): string | undefined {
		return this.#importNotice;
	}

	get canUndo(): boolean {
		return this.#undo.length > 0;
	}

	get canRedo(): boolean {
		return this.#redo.length > 0;
	}

	get diskDigest(): string | undefined {
		return this.#diskDigest;
	}

	snapshot(): StoreSnapshot {
		return { document: this.require(), path: this.#path, dirty: this.#dirty };
	}

	newDocument(init: { title?: string; goal?: string; purpose?: Purpose } = {}, path?: string): DiagramDocument {
		this.#document = createDocument(init);
		this.#path = path;
		this.#diskDigest = undefined;
		this.#dirty = true;
		this.#undo = [];
		this.#redo = [];
		this.#importNotice = undefined;
		return this.#document;
	}

	/** Install a document that is already known valid (a reviewed proposal). */
	adopt(document: DiagramDocument, path: string | undefined): void {
		this.#document = document;
		this.#path = path;
		this.#dirty = true;
		this.#undo = [];
		this.#redo = [];
	}

	async open(path: string): Promise<OpenResult> {
		path = resolve(path);
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
				return { ok: false, kind: "missing", path, errors: [`no file at ${path}`] };
			}
			return { ok: false, kind: "malformed", path, errors: [`cannot read ${path}: ${String(error)}`] };
		}

		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			return { ok: false, kind: "malformed", path, errors: [`${path} is not valid JSON: ${String(error)}`] };
		}

		const candidate = raw as { schemaVersion?: unknown };
		if (typeof raw === "object" && raw !== null && candidate.schemaVersion === undefined) {
			const imported = importLegacyBoard(raw);
			if (!imported.ok) {
				return { ok: false, kind: "malformed", path, errors: imported.errors };
			}
			this.#document = imported.document;
			this.#path = undefined;
			this.#diskDigest = undefined;
			this.#dirty = true;
			this.#undo = [];
			this.#redo = [];
			this.#importNotice = imported.summary;
			return { ok: true, kind: "legacy-import", path, summary: imported.summary };
		}

		const validated = validateDocument(raw, this.#arktype);
		if (!validated.ok) {
			return { ok: false, kind: "malformed", path, errors: validated.errors };
		}
		this.#document = validated.document;
		this.#path = path;
		this.#diskDigest = digestOfText(text);
		this.#dirty = false;
		this.#undo = [];
		this.#redo = [];
		this.#importNotice = undefined;
		return { ok: true, kind: "project", path, summary: `opened ${path}` };
	}

	/**
	 * One undoable edit. The callback mutates a draft; the live document is
	 * replaced only once the draft validates, so a rejected edit changes
	 * nothing. The revision increments exactly once for the whole transaction.
	 */
	transact(mutate: (document: DiagramDocument) => void): void {
		const current = this.require();
		const draft = structuredClone(current);
		mutate(draft);
		const validated = validateDocument(draft, this.#arktype);
		if (!validated.ok) {
			throw new Error(`edit would produce an invalid document: ${validated.errors.join("; ")}`);
		}
		draft.revision = current.revision + 1;
		this.#undo.push(current);
		if (this.#undo.length > 200) this.#undo.shift();
		this.#redo = [];
		this.#document = draft;
		this.#dirty = true;
	}

	undo(): boolean {
		const document = this.require();
		const previous = this.#undo.pop();
		if (!previous) return false;
		this.#redo.push(structuredClone(document));
		this.#document = previous;
		this.#dirty = true;
		return true;
	}

	redo(): boolean {
		const document = this.require();
		const next = this.#redo.pop();
		if (!next) return false;
		this.#undo.push(structuredClone(document));
		this.#document = next;
		this.#dirty = true;
		return true;
	}

	async save(): Promise<SaveResult> {
		if (!this.#document) return { ok: false, kind: "no-document", errors: ["no project document is open"] };
		if (!this.#path) return { ok: false, kind: "no-path", errors: ["no save path is set"] };
		return this.saveAs(this.#path);
	}

	async saveAs(path: string): Promise<SaveResult> {
		path = resolve(path);
		const document = this.#document;
		if (!document) return { ok: false, kind: "no-document", errors: ["no project document is open"] };
		const text = serializeDocument(document);
		const digest = digestOfText(text);

		// Refuse to overwrite a file that changed since *we* last read or wrote it.
		// With no baseline there is nothing of ours to protect: the path was
		// chosen explicitly (Save As, or the tool's derived output path), so
		// writing it is the requested action. Treating that case as a conflict
		// made a re-run of a command that targets its own file impossible.
		const existing = await readFile(path, "utf8").catch(() => undefined);
		const replaced = existing !== undefined;
		if (replaced && this.#diskDigest !== undefined && digestOfText(existing) !== this.#diskDigest) {
			return {
				ok: false,
				kind: "conflict",
				path,
				errors: [`${path} changed on disk since it was loaded; reload or save elsewhere`],
			};
		}

		const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
		try {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(temporary, text, "utf8");
			await rename(temporary, path);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			return { ok: false, kind: "error", path, errors: [`cannot write ${path}: ${String(error)}`] };
		}
		this.#path = path;
		this.#diskDigest = digest;
		this.#dirty = false;
		return { ok: true, path, digest, replaced };
	}

	/** Digest of the project file as it is on disk right now, or undefined when there is none. */
	async currentDiskDigest(): Promise<string | undefined> {
		if (this.#path === undefined) return undefined;
		const text = await readFile(this.#path, "utf8").catch(() => undefined);
		return text === undefined ? undefined : digestOfText(text);
	}

	async exists(path: string): Promise<boolean> {
		try {
			return (await stat(path)).isFile();
		} catch {
			return false;
		}
	}
}

/**
 * Apply a validated replacement inside one transaction, preserving identity:
 * the document keeps its id, and a block or diagram replacement keeps the id of
 * the block or diagram it replaces.
 */
export function applyReplacement(
	document: DiagramDocument,
	replacement: DiagramDocument | Block | Diagram,
	targetId: string | undefined,
): string[] {
	// Status and position are the human's: a proposal never changes them. Blocks
	// it introduces start open, and their ids are returned so the caller can
	// place them — a model's coordinates are never trusted for layout.
	const kept = new Map<string, { status: BlockStatus; x: number; y: number }>();
	for (const { block } of eachBlock(document.root)) {
		kept.set(block.id, { status: block.status, x: block.position.x, y: block.position.y });
	}
	replaceStructure(document, replacement, targetId);
	const added: string[] = [];
	for (const { block } of eachBlock(document.root)) {
		const prior = kept.get(block.id);
		if (prior) {
			block.status = prior.status;
			block.position = { x: prior.x, y: prior.y };
		} else {
			block.status = "open";
			added.push(block.id);
		}
	}
	return added;
}

function replaceStructure(
	document: DiagramDocument,
	replacement: DiagramDocument | Block | Diagram,
	targetId: string | undefined,
): void {
	if ("schemaVersion" in replacement) {
		document.root = replacement.root;
		document.title = replacement.title;
		document.goal = replacement.goal;
		return;
	}
	if ("blocks" in replacement) {
		if (targetId === undefined || document.root.id === targetId) {
			document.root = replacement;
			return;
		}
		const owned = findOwnedDiagram(document.root, targetId);
		if (!owned) throw new Error(`no diagram ${targetId} in the document`);
		owned.owner.children = replacement;
		return;
	}
	const blockId = targetId ?? replacement.id;
	const location = findBlockLocation(document.root, blockId);
	if (!location) throw new Error(`no block ${blockId} in the document`);
	const index = location.diagram.blocks.findIndex(block => block.id === blockId);
	location.diagram.blocks[index] = replacement;
}
