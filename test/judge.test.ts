import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolvePlannerJudge } from "../src/judge.ts";

type Context = Pick<ExtensionContext, "models" | "modelRegistry">;

/** A fake extension context: only the facades `resolvePlannerJudge` reads. */
function context(model: unknown, resolved: unknown = { ok: true }, judgePool: unknown[] = []): Context {
	return {
		models: { resolve: () => model },
		modelRegistry: { getApiKeyAndHeaders: async () => resolved, getAvailable: () => judgePool },
	} as never;
}

describe("resolvePlannerJudge", () => {
	test("a document with no judge role refuses with the setting to fix", async () => {
		const found = await resolvePlannerJudge(context(undefined));
		expect(found).toEqual({ ok: false, reason: "no judge model role is set (modelRoles.judge)" });
	});

	test("an unset role falls back to the first authenticated System One model", async () => {
		const found = await resolvePlannerJudge(
			context(undefined, { ok: true }, [
				{ provider: "local", id: "lfm2", api: "openai-completions", baseUrl: "http://x" },
				{ provider: "typesafe", id: "jev-latest", api: "typesafe", baseUrl: "https://api.typesafe.ai" },
			]),
		);
		expect(found.ok).toBe(true);
		expect(found.ok ? found.label : "").toBe("typesafe/jev-latest");
	});

	test("a chat-model judge role is refused instead of prompting it per block", async () => {
		const found = await resolvePlannerJudge(
			context({ provider: "local", id: "lfm2", api: "openai-completions", baseUrl: "http://x" }),
		);
		expect(found.ok).toBe(false);
		expect(found.ok ? "" : found.reason).toContain("a chat model");
	});

	test("a credential failure names the model and the reason", async () => {
		const found = await resolvePlannerJudge(
			context({ provider: "local", id: "laya", api: "typesafe", baseUrl: "http://x" }, { ok: false, error: "no key" }),
		);
		expect(found).toEqual({ ok: false, reason: "local/laya: no key" });
	});

	test("a keyless System One server is judged through the TypeSafe wire", async () => {
		const received: { authorization: string | null; body: unknown }[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				received.push({
					authorization: request.headers.get("authorization"),
					body: await request.json(),
				});
				return Response.json({
					model: "laya",
					answers: { q0: { type: "noul", noul: 0.9 } },
					usage: { input_tokens: 5, output_tokens: 0, cost: 0 },
				});
			},
		});
		try {
			const model = { provider: "laya", id: "laya", api: "typesafe", baseUrl: `http://127.0.0.1:${server.port}` };
			const found = await resolvePlannerJudge(context(model, { ok: true }));
			if (!found.ok) throw new Error(found.reason);
			expect(found.label).toBe("laya/laya");
			const result = await found.judge.judge({
				state: "s",
				questions: { q0: { type: "noul", instructions: "i" } },
			});
			expect(result.answers.q0).toEqual({ type: "noul", noul: 0.9 });
			expect(received).toHaveLength(1);
			const first = received[0];
			if (!first) throw new Error("no request reached the stub");
			expect(first.body).toEqual({
				state: "s",
				model: "laya",
				questions: { q0: { type: "noul", instructions: "i" } },
			});
			// A keyless server carries only the sentinel; Laya without LAYA_API_KEY
			// ignores it, and no real credential is ever sent to it.
			expect(first.authorization).toBe("Bearer N/A");
		} finally {
			server.stop(true);
		}
	});
});
