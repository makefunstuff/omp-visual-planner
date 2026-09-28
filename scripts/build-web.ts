/**
 * Builds the browser page: compiles web/ (Svelte) into one self-contained HTML
 * file, src/web-page.html, which web-page.ts serves as is. The page's CSP allows
 * only inline scripts and styles, so the bundle and the stylesheet are inlined.
 *
 *   bun scripts/build-web.ts           write src/web-page.html
 *   bun scripts/build-web.ts --check   exit 1 when it is not what web/ builds
 */
import { SveltePlugin } from "bun-plugin-svelte";

const ROOT = new URL("../", import.meta.url);
export const PAGE = new URL("src/web-page.html", ROOT);

export async function buildWebPage(): Promise<string> {
	const result = await Bun.build({
		entrypoints: [new URL("web/main.ts", ROOT).pathname],
		target: "browser",
		minify: true,
		plugins: [SveltePlugin({ development: false })],
	});
	if (!result.success) throw new AggregateError(result.logs, "the web page did not build");
	let script = "";
	let css = await Bun.file(new URL("web/app.css", ROOT)).text();
	for (const output of result.outputs) {
		if (output.kind === "entry-point") script += await output.text();
		else if (output.path.endsWith(".css")) css += await output.text();
	}
	// Inline: nothing in the bundle may close the element it sits in.
	script = script.replaceAll("</script", "<\\/script");
	css = css.replaceAll("</style", "<\\/style");
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		"<title>visual planner</title>",
		"<!-- Built by scripts/build-web.ts from web/; edit the sources and rebuild. -->",
		`<style>\n${css}</style>`,
		"</head>",
		"<body>",
		`<script type="module">${script}</script>`,
		"</body>",
		"</html>",
		"",
	].join("\n");
}

if (import.meta.main) {
	const page = await buildWebPage();
	if (process.argv.includes("--check")) {
		const current = await Bun.file(PAGE).text();
		if (current !== page) {
			console.error("src/web-page.html is stale: run bun scripts/build-web.ts");
			process.exit(1);
		}
	} else {
		await Bun.write(PAGE, page);
		console.log(`wrote ${PAGE.pathname} (${page.length} bytes)`);
	}
}
