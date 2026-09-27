import { describe, expect, test } from "bun:test";
import type { Judge, JudgmentRequest, NoulQuestion, Questions } from "@oh-my-pi/pi-ai";
import { RELATED_INSTRUCTIONS, rankRelated, relatedBatches, relatedCandidates, relatedRanker, relatedSummary } from "../src/relevance.ts";
import { createBlock, createDiagram, createDocument, createEdge } from "../src/model.ts";

function usage(total: number) {
	return {
		input: 1,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1,
		cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

/**
 * root: api, db, worker, cache  (api -> db "stores")
 * api.children: auth, tokens  (auth -> tokens "issues")
 * cache.uses: ["auth"]
 */
function fixture() {
	const document = createDocument({ title: "Service", goal: "Ship auth" });
	const api = createBlock({ id: "api", title: "API", description: "HTTP surface" });
	const db = createBlock({ id: "db", title: "Database" });
	const worker = createBlock({ id: "worker", title: "Worker", description: "Background jobs" });
	const cache = createBlock({ id: "cache", title: "Cache" });
	cache.uses = ["auth"];
	document.root.blocks.push(api, db, worker, cache);
	document.root.edges.push(createEdge({ id: "e-stores", from: "api", to: "db", label: "stores" }));
	const auth = createBlock({ id: "auth", title: "Auth" });
	const tokens = createBlock({ id: "tokens", title: "Tokens" });
	api.children = createDiagram({ id: "api-inner", blocks: [auth, tokens] });
	auth.children = null;
	api.children.edges.push(createEdge({ id: "e-issues", from: "auth", to: "tokens", label: "issues" }));
	return document;
}

/** Answers 0.9 for candidates whose instructions mention "Worker", 0.2 otherwise. */
function fakeJudge(record: JudgmentRequest<Questions>[] = []): Judge {
	return {
		label: "fake",
		judge: async (request: JudgmentRequest<Record<string, NoulQuestion>>) => {
			record.push(request);
			const answers: Record<string, { type: "noul"; noul: number }> = {};
			for (const id in request.questions) {
				const question = request.questions[id];
				if (!question) continue;
				answers[id] = { type: "noul", noul: question.instructions.includes("Worker") ? 0.9 : 0.2 };
			}
			return { api: "typesafe", provider: "fake", model: "fake", answers, usage: usage(0.001) };
		},
	} as unknown as Judge;
}

describe("relatedCandidates", () => {
	test("keeps only blocks the prompt does not already name", () => {
		const ids = relatedCandidates(fixture(), { kind: "block", id: "api" }).map(location => location.block.id);
		// db is a boundary relationship and cache is named by its use of an in-scope block.
		expect(ids).toEqual(["worker"]);
	});

	test("a scope on a nested block excludes what the scope uses and what uses it", () => {
		const ids = relatedCandidates(fixture(), { kind: "block", id: "auth" }).map(location => location.block.id);
		// tokens is a boundary relationship of auth; cache uses auth.
		expect(ids).toEqual(["api", "db", "worker"]);
	});

	test("an unknown scope has no candidates", () => {
		expect(relatedCandidates(fixture(), { kind: "block", id: "ghost" })).toEqual([]);
	});
});

describe("relatedBatches", () => {
	test("asks one noul question per candidate, in document order, naming the block", () => {
		const batches = relatedBatches(fixture(), { kind: "block", id: "auth" });
		expect(batches).toHaveLength(1);
		const batch = batches[0];
		if (!batch) throw new Error("no batch");
		expect(batch.ids).toEqual(["api", "db", "worker"]);
		const ids = Object.keys(batch.request.questions);
		expect(ids).toEqual(["q0", "q1", "q2"]);
		for (const id of ids) {
			const question = batch.request.questions[id];
			if (!question) throw new Error(`missing ${id}`);
			expect(question.type).toBe("noul");
			expect(question.instructions.startsWith(RELATED_INSTRUCTIONS)).toBe(true);
			expect(question.criteria).toMatchObject({});
		}
		expect(batch.request.questions.q0?.instructions).toContain("Service > API");
		expect(batch.request.questions.q2?.instructions).toContain("Service > Worker");
	});

	test("a shared state carries no empty fields", () => {
		const document = fixture();
		const batch = relatedBatches(document, { kind: "block", id: "api" })[0];
		if (!batch) throw new Error("no batch");
		expect(batch.request.state).toEqual({
			focus: 'block "API" (Service > API)',
			notes: "HTTP surface",
			goal: "Ship auth",
		});
	});

	test("more candidates than one request allows are chunked", () => {
		const document = fixture();
		for (let index = 0; index < 45; index += 1) {
			document.root.blocks.push(createBlock({ id: `extra-${index}`, title: `Extra ${index}` }));
		}
		const batches = relatedBatches(document, { kind: "block", id: "auth" });
		expect(batches.map(batch => batch.ids.length)).toEqual([40, 8]);
	});
});

describe("rankRelated", () => {
	test("ranks every candidate by the answer probability", async () => {
		const result = await rankRelated(fakeJudge(), "fake", fixture(), { kind: "block", id: "auth" });
		expect(result.context.ranked[0]?.id).toBe("worker");
		expect(result.asked).toBe(3);
		expect(result.cost).toBeCloseTo(0.001);
	});
});

describe("relatedRanker", () => {
	const signal = new AbortController().signal;

	test("a failing judge reports the error against its label", async () => {
		const judge = {
			label: "fake",
			judge: async () => {
				throw new Error("402 Payment Required");
			},
		} as unknown as Judge;
		const outcome = await relatedRanker(async () => ({ ok: true, judge, label: "fake" }))(
			fixture(),
			{ kind: "block", id: "api" },
			signal,
		);
		expect(outcome).toEqual({ ok: false, reason: "fake: 402 Payment Required" });
	});

	test("a judge role that does not resolve never reaches the wire", async () => {
		const outcome = await relatedRanker(async () => ({ ok: false, reason: "r" }))(
			fixture(),
			{ kind: "block", id: "api" },
			signal,
		);
		expect(outcome).toEqual({ ok: false, reason: "r" });
	});
});

describe("relatedSummary", () => {
	test("names the state in one line", () => {
		expect(relatedSummary("pending")).toBe("ranking related context…");
		expect(relatedSummary({ ok: false, reason: "a chat model" })).toBe("related context off: a chat model");
		expect(relatedSummary({ ok: true, context: { judge: "j", ranked: [] }, asked: 0, elapsedMs: 5, cost: 0 })).toBe(
			"related context: nothing outside this scope to rank",
		);
		expect(
			relatedSummary({
				ok: true,
				context: { judge: "fake", ranked: [{ id: "a", probability: 0.9 }, { id: "b", probability: 0.5 }] },
				asked: 2,
				elapsedMs: 412,
				cost: 0.00021,
			}),
		).toBe("related context: 1 of 2 blocks · fake · 0.4 s · $0.00021");
	});
});
