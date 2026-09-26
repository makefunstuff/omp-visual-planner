/**
 * Hand a file to the user's own editor ($VISUAL, then $EDITOR) the way the OMP
 * host does for its prompt: the caller stops the TUI, the editor inherits the
 * terminal, and the TUI starts again when it exits. The host's helper is not
 * exported to extensions, so this is the same few lines.
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function editorCommand(env: Record<string, string | undefined> = process.env): string | undefined {
	return env.VISUAL?.trim() || env.EDITOR?.trim() || undefined;
}

/**
 * Edit `text` in `command`. Resolves to the saved text, or `null` when the
 * editor exits non-zero (`:cq` in Vim) — which means "discard".
 */
export async function editInEditor(command: string, text: string, name: string): Promise<string | null> {
	const safe = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "block";
	const file = join(tmpdir(), `omp-visual-planner-${crypto.randomUUID().slice(0, 8)}-${safe}.md`);
	try {
		await Bun.write(file, text);
		// `sh -c 'cmd "$1"'` keeps editor arguments ($EDITOR="nvim -u NONE") intact and the path unquoted-safe.
		const child = Bun.spawn(["sh", "-c", `${command} "$1"`, "sh", file], {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		if ((await child.exited) !== 0) return null;
		return await Bun.file(file).text();
	} finally {
		await rm(file, { force: true });
	}
}
