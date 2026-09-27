/**
 * The web-mode page: a focused building-block workspace with an optional
 * coordinate map. `web-page.html` is static: no session data is interpolated;
 * everything arrives through `/api/state` and is rendered with textContent.
 * Labels, verbs and statuses come from `state.flow` (the same `flow.ts` the
 * terminal overlay uses). Styling follows the OpenCode DESIGN.md tokens.
 *
 * The page lives in a real HTML file rather than a template literal: Bun
 * rewrites non-ASCII characters in a `String.raw` template to `\uXXXX`
 * escapes, which then reached the page verbatim in its HTML text and titles.
 */
import { readFileSync } from "node:fs";

export const WEB_PAGE = readFileSync(new URL("./web-page.html", import.meta.url), "utf8");
