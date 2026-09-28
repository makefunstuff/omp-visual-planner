/**
 * The plan view's page: a Svelte app (web/) built by scripts/build-web.ts into
 * one self-contained HTML file. No plan data is interpolated; the tree arrives
 * through `/api/tree` and renders as text.
 */
import { readFileSync } from "node:fs";

export const WEB_PAGE = readFileSync(new URL("./web-page.html", import.meta.url), "utf8");
