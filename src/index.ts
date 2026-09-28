/**
 * omp-visual-planner: `/diagram` opens a read-only view of a plan tree (a
 * directory of markdown files, docs/plan by default) and `/diagram stop` stops
 * it. The plan itself is written by the agent through the plan-tree skill, or
 * by hand in any editor. Nothing here patches OMP core or global configuration.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { displayPath } from "./tree.ts";
import { openBrowser, startViewer, stopViewer } from "./viewer.ts";

const STATUS_KEY = "visual-planner-web";
const DEFAULT_ROOT = "docs/plan";

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() ?? "anonymous";
}

export default function ompVisualPlanner(pi: ExtensionAPI): void {
	pi.registerCommand("diagram", {
		description: "Open the read-only plan view of a plan tree (default docs/plan); /diagram stop stops it",
		getArgumentCompletions: prefix => ("stop".startsWith(prefix) ? [{ value: "stop", label: "stop" }] : null),
		handler: async (args, ctx) => {
			const argument = args.trim();
			if (argument === "stop") {
				const stopped = stopViewer(sessionKey(ctx));
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(stopped ? "visual planner: plan view stopped" : "visual planner: no plan view is running", "info");
				return;
			}
			const rootDir = resolve(ctx.cwd, argument || DEFAULT_ROOT);
			const shown = displayPath(rootDir, ctx.cwd);
			const handle = startViewer({ key: sessionKey(ctx), rootDir, repoDir: ctx.cwd });
			const link = `${handle.url}?token=${handle.token}`;
			ctx.ui.setStatus(STATUS_KEY, `plan ${handle.url}`);
			openBrowser(link);
			ctx.ui.notify(
				[
					`plan view of ${shown}: ${handle.url}`,
					`open: ${link}`,
					"stop with /diagram stop; it also stops when this session ends",
					...(existsSync(join(rootDir, "index.md")) ? [] : [`no ${shown}/index.md yet — /skill:plan-tree plan <goal> drafts one`]),
				].join("\n"),
				"info",
			);
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopViewer(sessionKey(ctx));
	});
}
