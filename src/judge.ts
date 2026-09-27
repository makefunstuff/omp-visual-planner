/**
 * The planner's System One judge.
 *
 * Related-context ranking asks the session's `judge` role one narrow yes/no
 * question per outside block. That role is a System One model (Jev on
 * OpenRouter, or Laya behind the same wire); a chat model is refused because
 * dozens of prompts per preview would be slow, costly and uncalibrated.
 */
import {
	type Judge,
	type Model,
	NO_AUTH_SENTINEL,
	TypeSafeJudge,
	isJudgmentApi,
} from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { settings } from "@oh-my-pi/pi-coding-agent";

/** Per-attempt timeout for one judgment request. */
export const JUDGE_TIMEOUT_MS = 8_000;

export type PlannerJudge = { ok: true; judge: Judge; label: string } | { ok: false; reason: string };

/**
 * The `judge` role's configured value, or undefined when settings have not been
 * initialized (tests and tooling run outside a live session).
 */
function configuredJudgeRole(): string | undefined {
	try {
		return settings.getModelRole("judge")?.trim();
	} catch {
		return undefined;
	}
}

/**
 * The model the `judge` role routes to. `ctx.models.resolve` pools `chat`-kind
 * models only, so a System One role — whose model is `judge`-kind — never
 * resolves there; fall back to the role's configured value matched against the
 * session's authenticated judge-kind models.
 */
export function judgeModel(ctx: Pick<ExtensionContext, "models" | "modelRegistry">): Model | undefined {
	const resolved = ctx.models.resolve("@judge");
	if (resolved) return resolved;
	const pool = ctx.modelRegistry.getAvailable("judge").filter(candidate => isJudgmentApi(candidate.api));
	const first = pool[0];
	if (!first) return undefined;
	const configured = configuredJudgeRole();
	if (!configured) return first;
	const wanted = configured.split(",").map(entry => entry.trim());
	return (
		pool.find(candidate => wanted.includes(`${candidate.provider}/${candidate.id}`)) ??
		pool.find(candidate => wanted.includes(candidate.id)) ??
		first
	);
}

/** The session's `judge` role when it is a System One model (Jev, or Laya behind the same wire). */
export async function resolvePlannerJudge(
	ctx: Pick<ExtensionContext, "models" | "modelRegistry">,
): Promise<PlannerJudge> {
	const model = judgeModel(ctx);
	if (!model) return { ok: false, reason: "no judge model role is set (modelRoles.judge)" };
	const label = `${model.provider}/${model.id}`;
	if (!isJudgmentApi(model.api)) {
		return {
			ok: false,
			reason: `the judge role is ${label}, a chat model; related context needs a System One judge such as Jev or Laya`,
		};
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { ok: false, reason: `${label}: ${auth.error}` };
	return {
		ok: true,
		label,
		judge: new TypeSafeJudge({
			apiKey: auth.apiKey ?? NO_AUTH_SENTINEL,
			api: model.api,
			provider: model.provider,
			baseUrl: model.baseUrl,
			model: model.id,
			headers: auth.headers,
			timeoutMs: JUDGE_TIMEOUT_MS,
		}),
	};
}
