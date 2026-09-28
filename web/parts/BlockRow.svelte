<script lang="ts">
	import type { Block } from "../../src/model.ts";
	import { focus, st, uncited } from "../app.svelte.ts";
	import { citationOf } from "../doc.ts";
	/** One clickable row for a block: an arrow for direction, its status, title, the link's label, and in explore its citation. */
	let { block, arrow = "", edgeLabel = "" }: { block: Block; arrow?: string; edgeLabel?: string } = $props();
	const status = $derived(st().flow?.status);
	const cite = $derived(st().document?.purpose === "explore" ? citationOf(block) : "");
</script>

<button class="move{uncited(block) ? ' dim' : ''}" title={status?.labels[block.status]} onclick={() => focus(block.id)}>
	{#if arrow}<span class="arrow">{arrow}</span>{/if}
	{#if status}<span class="glyph">{status.glyphs[block.status]}</span>{/if}
	<span class="name">{block.title || "(untitled)"}</span>
	{#if edgeLabel}<span class="edge">· {edgeLabel}</span>{/if}
	{#if cite}<span class="cite">{cite}</span>{/if}
</button>
