<script lang="ts">
	import { app, focus, openPreview, st } from "../app.svelte.ts";
	import { findBlock } from "../doc.ts";
	import MockupFrame from "../parts/MockupFrame.svelte";

	/** Every page and component, drawn: the mockup, else the wireframe, else a gap to sketch. */
	const ws = $derived(st());
	const board = $derived(ws.flow?.screens);
	const goTo = (id: string) => focus(id).then(() => (app.surface = "page"));
	type Card = NonNullable<typeof board>["pages"][number];
</script>

{#snippet card(entry: Card)}
	{@const block = findBlock(ws.document, entry.id)}
	<div class="card">
		{#if block?.mockup}<MockupFrame html={block.mockup} width={320} />
		{:else if entry.wireframe !== undefined}<pre>{entry.wireframe}</pre>
		{:else}<div class="none">not sketched</div>{/if}
		<button class="title" title="Open this block's page" onclick={() => goTo(entry.id)}>{entry.title}</button>
		{#if entry.path}<div class="where">{entry.path}</div>{/if}
		{#if entry.links.length}
			<div class="chips">
				{#each entry.links as link (link.id)}
					<button class="ghost" title="Open this page" onclick={() => goTo(link.id)}>→ {link.title}{link.label ? ` · ${link.label}` : ""}</button>
				{/each}
			</div>
		{/if}
		{#if entry.usedBy.length}
			<div class="chips">
				used by:
				{#each entry.usedBy as user (user.id)}<button class="ghost" title="Open this surface" onclick={() => goTo(user.id)}>{user.title}</button>{/each}
			</div>
		{/if}
		{#if ws.document?.purpose !== "explore"}
			<button class="sketch" title="Refine draws a wireframe and an HTML mockup; previewed first" onclick={() => openPreview("refine", entry.id)}>Sketch…</button>
		{/if}
	</div>
{/snippet}

<div class="screens" id="screens">
	{#if board}
		{#if !board.pages.length && !board.components.length}
			<p class="subtle">No pages or components yet. Mark a block as a page or component on its page, then Sketch it.</p>
		{:else}
			<div class="label">Pages · {board.pages.length}</div>
			<div class="grid">{#each board.pages as entry (entry.id)}{@render card(entry)}{/each}</div>
			<div class="label">Components · {board.components.length}</div>
			<div class="grid">{#each board.components as entry (entry.id)}{@render card(entry)}{/each}</div>
		{/if}
	{/if}
</div>
