/**
 * The web-mode page: a Svelte app (web/) built by scripts/build-web.ts into one
 * self-contained HTML file. No session data is interpolated; everything arrives
 * through `/api/state` and renders as text. Labels, verbs and statuses come from
 * `state.flow` (the same `flow.ts` the terminal overlay uses).
 */
import { readFileSync } from "node:fs";

export const WEB_PAGE = readFileSync(new URL("./web-page.html", import.meta.url), "utf8");
