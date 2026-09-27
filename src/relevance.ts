/**
 * Judged related context.
 *
 * A request that changes one block or one subsystem is composed from that scope
 * alone; the blocks outside it are named, if at all, as a flat catalogue. This
 * module asks a System One judge — one narrow yes/no question per outside block —
 * which of them an agent should read before touching the scope, so the prompt
 * can carry exactly those, and the preview can say what it found.
 */
import type { Judge, JudgmentRequest, NoulQuestion } from "@oh-my-pi/pi-ai";
import {
	type RelatedContext,
	clip,
	pathLabel,
	relatedIds,
	resolveScope,
} from "./compose.ts";
import type { PlannerJudge } from "./judge.ts";
import {
	type Block,
	type BlockLocation,
	type DiagramDocument,
	type Intent,
	type Scope,
	eachBlock,
	findBlockLocation,
	findOwnedDiagram,
} from "./model.ts";

export const QUESTIONS_PER_REQUEST = 40;
export const MAX_RANKED = 160;
export const RANK_TIMEOUT_MS = 10_000;
export const RELATED_INSTRUCTIONS = "Should an agent that is about to change the focused block read this other block first?";
export const RELATED_CRITERIA = {
	true: "the other block feeds, depends on, duplicates, or constrains the focused block, so changing the focused block without reading it risks contradicting or breaking it",
	false: "the other block is unrelated work: the focused block can change without reading it",
} as const;

/** Every request narrower than the project, except execute, carries related context. */
export function wantsRelated(intent: Intent, scope: Scope): boolean {
	return intent !== "execute" && scope.kind !== "project";
}

/** The block a scope is centred on: the scope block, or the block owning a subsystem scope. */
function focusOf(document: DiagramDocument, scope: Scope): Block | undefined {
	if (scope.kind === "block") return scope.id ? findBlockLocation(document.root, scope.id)?.block : undefined;
	if (scope.kind === "diagram") return scope.id ? findOwnedDiagram(document.root, scope.id)?.owner : undefined;
	return undefined;
}

/** Outside blocks worth asking about, in document order, at most MAX_RANKED. */
export function relatedCandidates(document: DiagramDocument, scope: Scope): BlockLocation[] {
	const resolution = resolveScope(document, scope);
	if (!resolution) return [];
	const inside = new Set(resolution.locations.map(location => location.block.id));
	// Already named in the prompt: what the scope uses, what uses the scope, and
	// the boundary relationships. Asking about them would only repeat the prompt.
	const linked = new Set<string>();
	for (const location of resolution.locations) {
		for (const id of location.block.uses ?? []) linked.add(id);
	}
	for (const location of eachBlock(document.root)) {
		if (inside.has(location.block.id)) continue;
		for (const id of location.block.uses ?? []) {
			if (inside.has(id)) linked.add(location.block.id);
		}
	}
	for (const relationship of resolution.boundary) linked.add(relationship.outside.id);
	return [...eachBlock(document.root)]
		.filter(location => !inside.has(location.block.id) && !linked.has(location.block.id))
		.slice(0, MAX_RANKED);
}

export interface RelatedBatch {
	request: JudgmentRequest<Record<string, NoulQuestion>>;
	ids: string[];
}

/** The candidate blocks chunked into judge requests; the focus state is shared across them. */
export function relatedBatches(document: DiagramDocument, scope: Scope): RelatedBatch[] {
	const resolution = resolveScope(document, scope);
	if (!resolution) return [];
	const focus = focusOf(document, scope);
	if (!focus) return [];
	const candidates = relatedCandidates(document, scope);
	if (candidates.length === 0) return [];
	const state: Record<string, string> = { focus: resolution.label };
	const notes = clip(focus.description, 800);
	if (notes.length > 0) state.notes = notes;
	const acceptance = focus.acceptanceCriteria.slice(0, 5).join("; ");
	if (acceptance.length > 0) state.acceptance = acceptance;
	const goal = clip(document.goal, 300);
	if (goal.length > 0) state.goal = goal;
	const batches: RelatedBatch[] = [];
	for (let start = 0; start < candidates.length; start += QUESTIONS_PER_REQUEST) {
		const chunk = candidates.slice(start, start + QUESTIONS_PER_REQUEST);
		const questions: Record<string, NoulQuestion> = {};
		const ids: string[] = [];
		chunk.forEach((location, index) => {
			const description = clip(location.block.description, 240);
			const other = ` Other block: ${pathLabel(location, document)}.${description.length > 0 ? ` ${description}` : ""}`;
			questions[`q${index}`] = {
				type: "noul",
				instructions: `${RELATED_INSTRUCTIONS}${other}`,
				criteria: { ...RELATED_CRITERIA },
			};
			ids.push(location.block.id);
		});
		batches.push({ request: { state, questions }, ids });
	}
	return batches;
}

export interface RankResult {
	context: RelatedContext;
	asked: number;
	cost: number;
}

/**
 * Ask the judge about every candidate. One failed batch fails the ranking: a
 * partial answer set would misstate which blocks are related.
 */
export async function rankRelated(
	judge: Judge,
	label: string,
	document: DiagramDocument,
	scope: Scope,
	signal?: AbortSignal,
): Promise<RankResult> {
	const batches = relatedBatches(document, scope);
	if (batches.length === 0) return { context: { judge: label, ranked: [] }, asked: 0, cost: 0 };
	const results = await Promise.all(batches.map(batch => judge.judge(batch.request, { signal })));
	const ranked: { id: string; probability: number }[] = [];
	let asked = 0;
	let cost = 0;
	batches.forEach((batch, index) => {
		const result = results[index];
		if (!result) return;
		asked += batch.ids.length;
		cost += result.usage.cost.total;
		batch.ids.forEach((id, question) => {
			const answer = result.answers[`q${question}`];
			if (answer?.type === "noul") ranked.push({ id, probability: answer.noul });
		});
	});
	// Stable sort keeps ties in document order: batches, and ids within them, are
	// pushed in document order.
	ranked.sort((a, b) => b.probability - a.probability);
	return { context: { judge: label, ranked }, asked, cost };
}

export type RelatedOutcome =
	| { ok: true; context: RelatedContext; asked: number; elapsedMs: number; cost: number }
	| { ok: false; reason: string };

export type RelatedRanker = (document: DiagramDocument, scope: Scope, signal: AbortSignal) => Promise<RelatedOutcome>;

/** A ranker bound to the session's judge role, resolved lazily per preview. */
export function relatedRanker(lookup: () => Promise<PlannerJudge>): RelatedRanker {
	return async (document, scope, signal) => {
		const found = await lookup();
		if (!found.ok) return { ok: false, reason: found.reason };
		const bounded = AbortSignal.any([signal, AbortSignal.timeout(RANK_TIMEOUT_MS)]);
		const start = performance.now();
		try {
			const result = await rankRelated(found.judge, found.label, document, scope, bounded);
			return { ok: true, ...result, elapsedMs: Math.round(performance.now() - start) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const timedOut = bounded.aborted && !signal.aborted;
			return { ok: false, reason: `${found.label}: ${timedOut ? "timed out after 10 s" : message}` };
		}
	};
}

/** One line for the preview title: what the judge found, or why it did not run. */
export function relatedSummary(status: RelatedOutcome | "pending"): string {
	if (status === "pending") return "ranking related context…";
	if (!status.ok) return `related context off: ${status.reason}`;
	if (status.asked === 0) return "related context: nothing outside this scope to rank";
	return `related context: ${relatedIds(status.context).length} of ${status.asked} blocks · ${status.context.judge} · ${(status.elapsedMs / 1000).toFixed(1)} s · $${status.cost.toFixed(5)}`;
}
