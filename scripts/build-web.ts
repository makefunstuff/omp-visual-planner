/**
 * Compiles web/ (Svelte) into one self-contained page, dist/web-page.html,
 * which the viewer serves. Runs on `bun install`; rerun after editing web/.
 * The page's CSP allows only inline scripts and styles, so both are inlined.
 */
import { SveltePlugin } from "bun-plugin-svelte";

const ROOT = new URL("../", import.meta.url);

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
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>plan</title>
<style>
${css}</style>
</head>
<body>
<script type="module">${script}</script>
</body>
</html>
`;
const out = new URL("dist/web-page.html", ROOT);
await Bun.write(out, page);
console.log(`wrote ${out.pathname} (${page.length} bytes)`);
