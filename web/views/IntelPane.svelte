<script lang="ts">
	import { type Viewer, openFile } from "../app.svelte.ts";
	import Spinner from "../parts/Spinner.svelte";
	import TokenText from "../parts/TokenText.svelte";

	/** The symbol or outline pane above the code: the shapes intel-view.ts builds, the same the terminal draws. */
	let { viewer }: { viewer: Viewer } = $props();
	const intel = $derived(viewer.intel!);
	const width = (numbers: number[]) => String(Math.max(0, ...numbers)).length;
</script>

<div class="intel">
	<div class="head">
		<span class="name">{intel.title}</span>
		<button class="ghost" title="Close" onclick={() => (viewer.intel = null)}>×</button>
	</div>
	{#if intel.loading}
		<div class="subtle"><Spinner /> asking the language server…</div>
	{:else if !intel.data.ok}
		<div class="subtle">{intel.data.reason}</div>
	{:else if intel.mode === "outline"}
		{@const rows = intel.data.view ?? []}
		{@const digits = width(rows.map(row => row.startLine))}
		{#if !rows.length}<div class="subtle">no symbols</div>{/if}
		{#each rows as row, index (index)}
			<button
				class="loc sym-row"
				title="{row.kind} {row.name} · lines {row.startLine}–{row.endLine}"
				onclick={() => {
					viewer.selection = { a: row.startLine, b: row.endLine };
					viewer.line = row.startLine;
				}}
			>
				<span class="tree">{row.tree}</span><span class="kind">{row.kind}</span><span class="sym">{row.name}</span><span class="ln">{String(row.startLine).padStart(digits)}</span>
			</button>
		{/each}
	{:else if intel.data.view}
		{@const view = intel.data.view}
		{#each view.hover as part, index (index)}
			{#if part.kind === "rule"}<hr />
			{:else if part.kind === "text"}<p class="hover-text">{part.text}</p>
			{:else}<pre class="hover-code">{#each part.code.split("\n") as text, line (line)}<TokenText tokens={part.tokens?.[line]} {text} />{"\n"}{/each}</pre>{/if}
		{/each}
		{#each [["Definition", String(view.definitions.reduce((sum, group) => sum + group.count, 0)), view.definitions], ["References", view.referenceTotal, view.references]] as const as [title, total, groups] (title)}
			<div class="section-head">{title} · {total}</div>
			{#if !groups.length}<div class="subtle">none</div>{/if}
			{#each groups as group (group.path)}
				{@const digits = width(group.locations.map(location => location.line))}
				<div class="file-head"><span class="path">{group.path}</span><span class="count">{group.count}</span></div>
				{#each group.locations as location, index (index)}
					<button class="loc ref-row" title="Open {group.path}:{location.line}" onclick={() => openFile(group.path, location.line)}>
						<span class="ln">{String(location.line).padStart(digits)}</span><span class="preview"><TokenText tokens={location.tokens} text={location.preview} /></span>
					</button>
				{/each}
			{/each}
		{/each}
	{/if}
</div>
