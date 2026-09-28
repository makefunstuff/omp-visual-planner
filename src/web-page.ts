/**
 * The plan view's page, built from web/ by scripts/build-web.ts (run by
 * `bun install`). Read per request, so a rebuild shows up on reload. No plan
 * data is interpolated; the tree arrives through `/api/tree`.
 */
import { readFile } from "node:fs/promises";

const PAGE = new URL("../dist/web-page.html", import.meta.url);

export async function webPage(): Promise<string | undefined> {
	try {
		return await readFile(PAGE, "utf8");
	} catch {
		return undefined;
	}
}

export const MISSING_PAGE = `the page is not built: run bun install (or bun scripts/build-web.ts) in ${new URL("..", PAGE).pathname}`;
