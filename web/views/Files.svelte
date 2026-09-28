<script lang="ts">
	import { app, loadFiles, openDirs, openFile, st } from "../app.svelte.ts";
	import { citations, selectedBlock } from "../doc.ts";

	type Tree = { dirs: Map<string, Tree>; files: string[] };
	type Row = { kind: "dir"; key: string; name: string; open: boolean; depth: number } | { kind: "file"; path: string; label: string; depth: number };

	const ws = $derived(st());
	const cites = $derived(citations(ws.document));
	const mine = $derived(new Set(selectedBlock(ws)?.sources.map(source => source.path) ?? []));
	const rows = $derived.by((): Row[] | null => {
		const files = app.files;
		if (!files) return null;
		const query = app.filesFilter.trim().toLowerCase();
		if (query) return files.filter(path => path.toLowerCase().includes(query)).slice(0, 300).map(path => ({ kind: "file", path, label: path, depth: 0 }));
		const tree: Tree = { dirs: new Map(), files: [] };
		for (const path of files) {
			let node = tree;
			for (const part of path.split("/").slice(0, -1)) {
				if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
				node = node.dirs.get(part)!;
			}
			node.files.push(path);
		}
		const out: Row[] = [];
		const draw = (node: Tree, prefix: string, depth: number): void => {
			for (const [name, child] of node.dirs) {
				const key = `${prefix}${name}/`;
				const open = openDirs.has(key);
				out.push({ kind: "dir", key, name, open, depth });
				if (open) draw(child, key, depth + 1);
			}
			for (const path of node.files) out.push({ kind: "file", path, label: path.slice(prefix.length), depth });
		};
		draw(tree, "", 0);
		return out;
	});
</script>

<aside class="drawer files" id="files">
	<div class="bar">
		<span class="name">files</span>
		<button class="ghost" title="Reload the file list" onclick={loadFiles}>↻</button>
		<button class="ghost" title="Close (/ reopens)" onclick={() => (app.filesOpen = false)}>×</button>
	</div>
	<div class="bar">
		<input type="text" placeholder="filter files… (/)" spellcheck="false" bind:value={app.filesFilter} onkeydown={event => event.key === "Escape" && event.currentTarget.blur()} />
	</div>
	<div class="scroll tree">
		{#if !rows}
			<div class="note">loading…</div>
		{:else}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			{#each rows as row (row.kind === "dir" ? row.key : row.path)}
				{#if row.kind === "dir"}
					<div class="item dir" style="padding-left:{8 + row.depth * 14}px" onclick={() => (row.open ? openDirs.delete(row.key) : openDirs.add(row.key))}>
						<span>{row.open ? "[-] " : "[+] "}{row.name}/</span>
					</div>
				{:else}
					{@const count = (cites.get(row.path) ?? []).length}
					<div
						class="item{app.viewer?.path === row.path ? ' open' : ''}{mine.has(row.path) ? ' mine' : ''}"
						style="padding-left:{8 + row.depth * 14}px"
						title={row.path}
						onclick={() => openFile(row.path)}
					>
						<span class="fname">{row.label}</span>
						{#if count}<span class="cites" title="{count} block(s) anchored here">·{count}</span>{/if}
					</div>
				{/if}
			{/each}
			{#if app.filesFilter.trim() && rows.length === 0}<div class="note">no file matches</div>{/if}
			{#if !app.filesFilter.trim() && app.filesTruncated}<div class="note">…the list stops at 5000 files; filter to find the rest</div>{/if}
		{/if}
	</div>
</aside>
