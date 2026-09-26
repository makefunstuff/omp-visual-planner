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
	validateBlock,
	validateDiagram,
	validateDocument,
} from "./model.ts";

export type ActionKind = "draft" | "discover" | "enhance" | "refresh" | "recommend" | "investigate" | "execute";

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
}

export interface StageContext {
	branchKey: string;
	documentId: string;
	/** Digest of the project file as it is on disk right now. */
	diskDigest: string | undefined;
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

	/** The one request this branch is waiting on, if any. */
	pending(): JournalEntry | undefined {
		return this.#entries.find(
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
		const active = this.pending();
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
		const proposal: StagedProposal = {
			summary: summary.trim(),
			replacement: validated.replacement,
			stagedAt: new Date().toISOString(),
		};
		entry.state = "staged";
		entry.proposal = proposal;
		return { ok: true, entry, proposal };
	}

	/** Refuse a proposal that no longer matches the document it was written against. */
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
		if (entry.baseRevision !== current.revision) {
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
