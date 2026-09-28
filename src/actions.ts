/**
 * Request / proposal lifecycle.
 *
 * A request token is the only way a model can influence the document: it stages
 * a proposal for one pending request, on one branch, against one base revision
 * and one on-disk digest. Everything else is an explicit error. Accepting a
 * proposal is a UI action, never a tool call.
 */
import {
	type ArkTypeNamespace,
	type Block,
	type Diagram,
	type DiagramDocument,
	type Intent,
	type Scope,
	findBlockLocation,
	findDiagram,
	validateBlock,
	validateDiagram,
	validateDocument,
} from "./model.ts";
import { applyReplacement } from "./store.ts";

export type ActionKind =
	| "draft"
	| "discover"
	| "enhance"
	| "decompose"
	| "investigate"
	| "execute"
	| "replan"
	| "prune"
	| "change"
	| "sync"
	| "clarify";

export type JournalState =
	| "pending"
	| "submitted"
	| "staged"
	| "accepted"
	| "rejected"
	| "discarded"
	| "failed"
	| "stale";

export interface StagedProposal {
	summary: string;
	replacement: DiagramDocument | Block | Diagram;
	stagedAt: string;
}

export interface JournalEntry {
	requestId: string;
	kind: ActionKind;
	intent: Intent;
	scope: Scope;
	label: string;
	branchKey: string;
	documentId: string;
	baseRevision: number;
	baseDigest: string | undefined;
	prompt: string;
	createdAt: string;
	state: JournalState;
	stateReason?: string;
	proposal?: StagedProposal;
	/** Shared by every request one batch started; absent on a single request. */
	batchId?: string;
}

export interface BeginInput {
	requestId: string;
	kind: ActionKind;
	intent: Intent;
	scope: Scope;
	label: string;
	branchKey: string;
	documentId: string;
	baseRevision: number;
	baseDigest: string | undefined;
	prompt: string;
	batchId?: string;
}

export interface StageContext {
	branchKey: string;
	documentId: string;
	/** Digest of the project file as it is on disk right now. */
	diskDigest: string | undefined;
	/**
	 * The document the request was written against. With it, staging refuses a
	 * replan or prune that would drop settled work; without it, `stage` loses
	 * that check (acceptance keeps it either way).
	 */
	document?: DiagramDocument;
	arktype: ArkTypeNamespace;
}

export interface StageFailure {
	ok: false;
	errors: string[];
}

export interface StageSuccess {
	ok: true;
	entry: JournalEntry;
	proposal: StagedProposal;
}

export type StageOutcome = StageSuccess | StageFailure;

/** Result of `ActionRegistry.begin`. */
export type BeginOutcome = { ok: true; entry: JournalEntry } | StageFailure;

/** Result of `ActionRegistry.checkApplicable`. */
export type ApplyOutcome = { ok: true; entry: JournalEntry } | StageFailure;

const JOURNAL_LIMIT = 50;

function isDocumentReplacement(value: DiagramDocument | Block | Diagram): value is DiagramDocument {
	return "schemaVersion" in value;
}

function isDiagramReplacement(value: DiagramDocument | Block | Diagram): value is Diagram {
	return !("schemaVersion" in value) && "blocks" in value;
}

/** Structural and ownership validation for one replacement against its request. */
export function validateReplacement(
	entry: Pick<JournalEntry, "scope" | "documentId">,
	replacement: unknown,
	arktype: ArkTypeNamespace,
): { ok: true; replacement: DiagramDocument | Block | Diagram } | StageFailure {
	if (typeof replacement !== "object" || replacement === null) {
		return { ok: false, errors: ["replacement must be an object"] };
	}
	if (isDocumentReplacement(replacement as DiagramDocument)) {
		if (entry.scope.kind !== "project") {
			return {
				ok: false,
				errors: [`a document replacement is only valid for a project-scope request, not ${entry.scope.kind}`],
			};
		}
		const validated = validateDocument(replacement, arktype);
		if (!validated.ok) return { ok: false, errors: validated.errors };
		if (validated.document.id !== entry.documentId) {
			return {
				ok: false,
				errors: [`replacement document id ${validated.document.id} does not match ${entry.documentId}`],
			};
		}
		return { ok: true, replacement: validated.document };
	}
	if (isDiagramReplacement(replacement as Diagram)) {
		if (entry.scope.kind !== "diagram") {
			return {
				ok: false,
				errors: [`a diagram replacement needs a diagram-scope request, not ${entry.scope.kind}`],
			};
		}
		const validated = validateDiagram(replacement, arktype);
		if (!validated.ok) return { ok: false, errors: validated.errors };
		if (entry.scope.id === undefined) {
			return { ok: false, errors: ["this request has no diagram id to match"] };
		}
		if (validated.diagram.id !== entry.scope.id) {
			return {
				ok: false,
				errors: [`replacement diagram id ${validated.diagram.id} does not match the requested ${entry.scope.id}`],
			};
		}
		return { ok: true, replacement: validated.diagram };
	}
	if (entry.scope.kind !== "block") {
		return { ok: false, errors: [`a block replacement needs a block-scope request, not ${entry.scope.kind}`] };
	}
	const validated = validateBlock(replacement, arktype);
	if (!validated.ok) return { ok: false, errors: validated.errors };
	if (entry.scope.id === undefined) {
		return { ok: false, errors: ["this request has no block id to match"] };
	}
	if (validated.block.id !== entry.scope.id) {
		return {
			ok: false,
			errors: [`replacement block id ${validated.block.id} does not match the requested ${entry.scope.id}`],
		};
	}
	return { ok: true, replacement: validated.block };
}

/** Every block in these trees, depth-first: parents before their children. */
function* walkBlocks(blocks: readonly Block[]): Generator<Block> {
	for (const block of blocks) {
		yield block;
		if (block.children) yield* walkBlocks(block.children.blocks);
	}
}

/** The blocks a replacement introduces, whatever shape the scope asks for. */
function replacementRoots(replacement: DiagramDocument | Block | Diagram): readonly Block[] {
	if (isDocumentReplacement(replacement)) return replacement.root.blocks;
	if (isDiagramReplacement(replacement)) return replacement.blocks;
	return [replacement];
}

/** The blocks a scope covers in the document it was written against. */
function scopedBlocks(document: DiagramDocument, scope: Scope): Block[] | undefined {
	if (scope.kind === "project") return [...walkBlocks(document.root.blocks)];
	if (scope.id === undefined) return undefined;
	if (scope.kind === "block") {
		const location = findBlockLocation(document.root, scope.id);
		return location ? [...walkBlocks([location.block])] : undefined;
	}
	const diagram = scope.id === document.root.id ? document.root : findDiagram(document.root, scope.id);
	return diagram ? [...walkBlocks(diagram.blocks)] : undefined;
}

/**
 * Blocks a proposal may not drop. Status belongs to the human: a replan or a
 * prune may restructure everything unsettled, but a block the human already
 * settled (planned, explored or done) must survive inside its scope under the
 * same id. Every other request kind is untouched by this rule.
 */
export function retentionErrors(
	request: Pick<JournalEntry, "intent" | "scope">,
	document: DiagramDocument,
	replacement: DiagramDocument | Block | Diagram,
): string[] {
	if (request.intent !== "replan" && request.intent !== "prune" && request.intent !== "sync") return [];
	const scoped = scopedBlocks(document, request.scope);
	if (!scoped) return [];
	const survivors = new Set([...walkBlocks(replacementRoots(replacement))].map(block => block.id));
	const dropped = scoped.filter(block => block.status !== "open" && !survivors.has(block.id));
	if (dropped.length === 0) return [];
	const names = dropped.slice(0, 5).map(block => `"${block.title || block.id}" (${block.id})`).join(", ");
	const more = dropped.length > 5 ? ` and ${dropped.length - 5} more` : "";
	return [
		`this ${request.intent} would drop settled work: ${names}${more} — a ${request.intent} keeps every block the human settled, under its id`,
	];
}
/**
 * The branch token to restore when the same session is opened again.
 *
 * A resume gets a new leaf id, but that is not a branch move. A pending or
 * staged request must keep the token it was created with, or the generated
 * proposal is marked stale and the reopened planner looks empty.
 */
export function resumeBranchToken(journal: readonly Pick<JournalEntry, "state" | "branchKey">[], liveToken: string): string {
	for (let index = journal.length - 1; index >= 0; index -= 1) {
		const entry = journal[index];
		if (!entry) continue;
		if ((entry.state === "pending" || entry.state === "staged") && entry.branchKey.length > 0) return entry.branchKey;
	}
	return liveToken;
}

/** How long a fresh request may sit pending while the agent has not picked it up yet. */
export const STALL_GRACE_MS = 5_000;

/**
 * A pending request nobody is working on: the agent is idle and the request is
 * past the grace a submit needs to start a turn. A refused stage keeps a request
 * pending, so without this the surfaces would show it as running forever.
 */
export function isStalled(entry: Pick<JournalEntry, "state" | "createdAt">, agentBusy: boolean, now = Date.now()): boolean {
	return entry.state === "pending" && !agentBusy && now - Date.parse(entry.createdAt) >= STALL_GRACE_MS;
}

/**
 * One journal per session. `branchKey` identifies the branch/tree position a
 * request belongs to, so a request cannot be satisfied from somewhere else.
 */
export class ActionRegistry {
	#entries: JournalEntry[] = [];
	#branchKey: string;

	constructor(branchKey: string) {
		this.#branchKey = branchKey;
	}

	get branchKey(): string {
		return this.#branchKey;
	}

	get entries(): readonly JournalEntry[] {
		return this.#entries;
	}

	entryFor(requestId: string): JournalEntry | undefined {
		return this.#entries.find(entry => entry.requestId === requestId);
	}

	/** Every request this branch is waiting on — pending or staged — in the order they were created. */
	active(): JournalEntry[] {
		return this.#entries.filter(
			entry => entry.branchKey === this.#branchKey && (entry.state === "pending" || entry.state === "staged"),
		);
	}

	/**
	 * Move to a branch/tree position. Requests owned by another position are
	 * invalidated — never silently inherited.
	 */
	adoptBranch(branchKey: string, restored?: readonly JournalEntry[]): void {
		this.#branchKey = branchKey;
		if (restored) {
			this.#entries = restored.map(entry => structuredClone(entry));
		}
		for (const entry of this.#entries) {
			if (entry.branchKey === branchKey) continue;
			if (entry.state === "pending" || entry.state === "staged") {
				entry.state = "stale";
				entry.stateReason = `branch changed to ${branchKey}`;
			}
		}
	}

	begin(input: BeginInput): BeginOutcome {
		const active = this.active()[0];
		if (active) {
			return {
				ok: false,
				errors: [
					`request ${active.requestId} (${active.kind}) is still ${active.state}; review, reject or discard it before starting another`,
				],
			};
		}
		const entry: JournalEntry = {
			...input,
			createdAt: new Date().toISOString(),
			state: input.kind === "execute" ? "submitted" : "pending",
		};
		this.#entries.push(entry);
		this.#trim();
		return { ok: true, entry };
	}

	/**
	 * Start several block requests at once, one per block, all sharing a `batchId`.
	 * Each is staged and reviewed on its own; the batch only starts them together.
	 */
	beginBatch(inputs: readonly BeginInput[]): { ok: true; entries: JournalEntry[] } | StageFailure {
		const active = this.active()[0];
		if (active) {
			return {
				ok: false,
				errors: [
					`request ${active.requestId} (${active.kind}) is still ${active.state}; review, reject or discard it before starting another`,
				],
			};
		}
		if (inputs.length < 2) return { ok: false, errors: ["a batch needs at least two requests"] };
		for (const input of inputs) {
			if (input.kind === "execute" || input.scope.kind !== "block") {
				const kind = input.kind === "execute" ? input.kind : input.scope.kind;
				return { ok: false, errors: [`a batch holds block requests, not ${kind}`] };
			}
		}
		const seen = new Set<string>();
		for (const input of inputs) {
			const id = input.scope.id ?? "";
			if (seen.has(id)) return { ok: false, errors: [`block ${id} appears twice in one batch`] };
			seen.add(id);
		}
		const batchId = inputs[0]!.batchId;
		if (batchId === undefined || inputs.some(input => input.batchId !== batchId)) {
			return { ok: false, errors: ["every request in a batch carries the same batchId"] };
		}
		const createdAt = new Date().toISOString();
		const entries = inputs.map((input): JournalEntry => ({ ...input, createdAt, state: "pending" }));
		this.#entries.push(...entries);
		this.#trim();
		return { ok: true, entries };
	}

	/**
	 * The planner saved the file itself; requests written against the old bytes stay valid.
	 * An outside edit never equals `previous`, so it still makes them stale.
	 */
	rebase(previous: string, next: string): void {
		for (const entry of this.active()) {
			if (entry.baseDigest === previous) entry.baseDigest = next;
		}
	}

	stage(requestId: string, summary: string, replacement: unknown, context: StageContext): StageOutcome {
		const entry = this.entryFor(requestId);
		if (!entry) {
			return { ok: false, errors: [`unknown requestId ${requestId}; no request with that token is registered`] };
		}
		if (entry.branchKey !== context.branchKey) {
			return {
				ok: false,
				errors: [`request ${requestId} was created on another branch (${entry.branchKey}); it cannot be staged here`],
			};
		}
		if (entry.state === "stale") {
			return { ok: false, errors: [`request ${requestId} is stale: ${entry.stateReason ?? "superseded"}`] };
		}
		if (entry.state !== "pending") {
			return { ok: false, errors: [`request ${requestId} is ${entry.state}, not awaiting a proposal`] };
		}
		if (entry.documentId !== context.documentId) {
			return {
				ok: false,
				errors: [`request ${requestId} belongs to document ${entry.documentId}, but ${context.documentId} is open`],
			};
		}
		if (entry.baseDigest !== undefined && context.diskDigest !== undefined && entry.baseDigest !== context.diskDigest) {
			return {
				ok: false,
				errors: ["the project file changed on disk while this request was in flight; regenerate instead of staging"],
			};
		}
		if (typeof summary !== "string" || summary.trim().length === 0) {
			return { ok: false, errors: ["summary must describe the change"] };
		}
		const validated = validateReplacement(entry, replacement, context.arktype);
		if (!validated.ok) return validated;
		if (context.document) {
			const retained = retentionErrors(entry, context.document, validated.replacement);
			if (retained.length > 0) return { ok: false, errors: retained };
			// Validate the document this change would produce: `validateBlock` and
			// `validateDiagram` see one scope in isolation, so a dangling `uses` or an
			// id clash with a block outside the scope would otherwise surface only at
			// accept, inside `store.transact`, where the agent can no longer see it.
			const projected = structuredClone(context.document);
			try {
				applyReplacement(projected, validated.replacement, entry.scope.id);
			} catch (error) {
				return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
			}
			const whole = validateDocument(projected, context.arktype);
			if (!whole.ok) {
				return {
					ok: false,
					errors: whole.errors.map(error => `after this change the document would be invalid: ${error}`),
				};
			}
		}
		const proposal: StagedProposal = {
			summary: summary.trim(),
			replacement: validated.replacement,
			stagedAt: new Date().toISOString(),
		};
		entry.state = "staged";
		entry.proposal = proposal;
		return { ok: true, entry, proposal };
	}

	/**
	 * Refuse a proposal that no longer matches the document it was written against.
	 * A project replacement swaps the whole tree, so any revision bump is a conflict.
	 * A block or diagram replacement is applied onto the current document: edits
	 * outside that target (including ones made while a nested refinement ran) do
	 * not make it unapplicable.
	 */
	checkApplicable(
		requestId: string,
		current: { revision: number; digest: string | undefined; documentId: string; branchKey: string },
	): ApplyOutcome {
		const entry = this.entryFor(requestId);
		if (!entry) return { ok: false, errors: [`unknown requestId ${requestId}`] };
		if (entry.state !== "staged") return { ok: false, errors: [`request ${requestId} is ${entry.state}, not staged`] };
		if (entry.branchKey !== current.branchKey) {
			return { ok: false, errors: [`request ${requestId} belongs to another branch`] };
		}
		if (entry.documentId !== current.documentId) {
			return { ok: false, errors: [`request ${requestId} belongs to document ${entry.documentId}`] };
		}
		if (entry.scope.kind === "project" && entry.baseRevision !== current.revision) {
			return {
				ok: false,
				errors: [
					`document moved from revision ${entry.baseRevision} to ${current.revision} while the request ran; regenerate instead of merging`,
				],
			};
		}
		if (entry.baseDigest !== undefined && current.digest !== undefined && entry.baseDigest !== current.digest) {
			return { ok: false, errors: ["the project file changed on disk while the request ran; regenerate instead of merging"] };
		}
		return { ok: true, entry };
	}

	resolve(requestId: string, state: "accepted" | "rejected" | "discarded" | "failed" | "stale", reason?: string): boolean {
		const entry = this.entryFor(requestId);
		if (!entry) return false;
		entry.state = state;
		if (reason !== undefined) entry.stateReason = reason;
		return true;
	}

	serialize(): JournalEntry[] {
		return this.#entries.map(entry => structuredClone(entry));
	}

	#trim(): void {
		if (this.#entries.length <= JOURNAL_LIMIT) return;
		this.#entries.splice(0, this.#entries.length - JOURNAL_LIMIT);
	}
}
