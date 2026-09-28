/**
 * Type-checks the browser page, Svelte components included, with the repo's own
 * TypeScript (7). svelte2tsx turns each component into TypeScript in a scratch
 * mirror of web/ (so nothing is written into the sources); `src` and
 * `node_modules` are linked in, and tsc checks the mirror. Svelte compiler
 * warnings fail the check as well.
 *
 *   bun scripts/check-web.ts
 */
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Glob } from "bun";
import { VERSION, compile } from "svelte/compiler";

const root = new URL("../", import.meta.url).pathname;
const scratch = await mkdtemp(join(tmpdir(), "omp-visual-planner-check-web-"));
try {
	await cp(join(root, "web"), join(scratch, "web"), { recursive: true });
	await symlink(join(root, "src"), join(scratch, "src"));
	// The mirror's node_modules links every package in, except two: svelte2tsx parses
	// with the TypeScript compiler API, which TypeScript 7 (the native compiler this
	// repo checks with) no longer ships, so a private copy of it gets TypeScript 6.
	const modules = join(scratch, "node_modules");
	await mkdir(modules);
	for (const name of await readdir(join(root, "node_modules"))) {
		if (name === "typescript" || name === "svelte2tsx") continue;
		await symlink(join(root, "node_modules", name), join(modules, name));
	}
	await symlink(join(root, "node_modules/typescript6"), join(modules, "typescript"));
	await cp(join(root, "node_modules/svelte2tsx"), join(modules, "svelte2tsx"), { recursive: true });
	const { svelte2tsx } = (await import(join(modules, "svelte2tsx/index.mjs"))) as typeof import("svelte2tsx");
	let warnings = 0;
	for await (const file of new Glob("web/**/*.svelte").scan(root)) {
		const source = await Bun.file(join(root, file)).text();
		// The Svelte compiler's own warnings (a11y, unused, reactivity) fail the check too.
		for (const warning of compile(source, { filename: file }).warnings) {
			warnings += 1;
			console.error(`${file}(${warning.start?.line ?? 0}): ${warning.code}: ${warning.message.split("\n")[0]}`);
		}
		const { code } = svelte2tsx(source, { filename: file, isTsFile: true, mode: "ts", version: VERSION });
		// `./App.svelte` resolves to `App.svelte.tsx`; a `.ts` suffix would collide with `app.svelte.ts` on a case-insensitive disk.
		const out = join(scratch, `${file}.tsx`);
		await mkdir(dirname(out), { recursive: true });
		await Bun.write(out, code);
	}
	const shims = ["node_modules/svelte2tsx/svelte-shims-v4.d.ts", "node_modules/svelte2tsx/svelte-jsx-v4.d.ts"];
	await Bun.write(
		join(scratch, "tsconfig.json"),
		JSON.stringify({
			extends: join(root, "web/tsconfig.json"),
			compilerOptions: { jsx: "preserve", noEmit: true },
			include: ["web/**/*.ts", "web/**/*.tsx", ...shims],
		}),
	);
	const tsc = Bun.spawnSync([join(root, "node_modules/.bin/tsc"), "--noEmit", "-p", join(scratch, "tsconfig.json")], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
	// Report paths as the sources they came from.
	const report = (tsc.stdout.toString() + tsc.stderr.toString()).replaceAll(/(web\/[^\s(:]+\.svelte)\.tsx/g, "$1");
	if (report.trim()) console.error(report.trim());
	process.exitCode = tsc.exitCode || (warnings > 0 ? 1 : 0);
} finally {
	await rm(scratch, { recursive: true, force: true });
}
