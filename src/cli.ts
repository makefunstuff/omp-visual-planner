/**
 * The plan view without OMP:
 *
 *   bun src/cli.ts [dir] [--port <n>]
 *
 * `dir` defaults to docs/plan, resolved against the working directory, which is
 * also the repository sources are resolved against.
 */
import { resolve } from "node:path";
import { displayPath } from "./tree.ts";
import { openBrowser, startViewer, stopViewer } from "./viewer.ts";

const USAGE = "usage: bun src/cli.ts [dir] [--port <n>]";

function usage(message: string): never {
	console.error(`${message}\n${USAGE}`);
	process.exit(2);
}

let dir: string | undefined;
let port: number | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
	const arg = args[i]!;
	if (arg === "--port" || arg.startsWith("--port=")) {
		const value = arg === "--port" ? args[(i += 1)] : arg.slice("--port=".length);
		if (value === undefined || !/^\d+$/.test(value) || Number(value) > 65535) usage(`--port needs a number, got ${value ?? "nothing"}`);
		port = Number(value);
	} else if (arg === "-h" || arg === "--help") {
		console.log(USAGE);
		process.exit(0);
	} else if (arg.startsWith("-")) {
		usage(`unknown flag ${arg}`);
	} else if (dir === undefined) {
		dir = arg;
	} else {
		usage(`one directory only, got ${dir} and ${arg}`);
	}
}

const repoDir = process.cwd();
const rootDir = resolve(repoDir, dir ?? "docs/plan");
const key = "cli";
const handle = startViewer({ key, rootDir, repoDir, port });
const link = `${handle.url}?token=${handle.token}`;
console.log(`plan view of ${displayPath(rootDir, repoDir)}: ${link}`);
console.log("Ctrl+C stops it");
openBrowser(link);
process.on("SIGINT", () => {
	stopViewer(key);
	process.exit(0);
});
