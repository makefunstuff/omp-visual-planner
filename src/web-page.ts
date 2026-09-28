/**
 * The plan view's page: the Svelte app in web/, compiled on first request into
 * one self-contained HTML document. The page's CSP allows only inline scripts
 * and styles, so the bundle and the stylesheet are inlined. No plan data is
 * interpolated; the tree arrives through `/api/tree`.
 */
import { SveltePlugin } from "bun-plugin-svelte";

const WEB = new URL("../web/", import.meta.url);

async function build(): Promise<string> {
	const result = await Bun.build({
		entrypoints: [new URL("main.ts", WEB).pathname],
		target: "browser",
		minify: true,
		plugins: [SveltePlugin({ development: false })],
	});
	if (!result.success) throw new AggregateError(result.logs, "the web page did not build");
	let script = "";
	let css = await Bun.file(new URL("app.css", WEB)).text();
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
		"<title>plan</title>",
		`<style>\n${css}</style>`,
		"</head>",
		"<body>",
		`<script type="module">${script}</script>`,
		"</body>",
		"</html>",
		"",
	].join("\n");
}

let page: Promise<string> | undefined;

/** Built once per process; a failed build is retried on the next request. */
export function webPage(): Promise<string> {
	page ??= build().catch(error => {
		page = undefined;
		throw error;
	});
	return page;
}
