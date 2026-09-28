<script lang="ts">
	import type { Block } from "../../src/model.ts";
	import { app, focusLists } from "../app.svelte.ts";
	import BlockRow from "./BlockRow.svelte";
	/** Inside and linked, as sections of rows. An empty "inside" shows only when `emptyText` says what to do about it. */
	let { block, emptyText }: { block: Block | null; emptyText: string } = $props();
	const hood = $derived(focusLists());
	const linked = $derived([
		...hood.inputs.filter(link => link.kind === "edge").map(link => ({ link, arrow: "←" })),
		...hood.outputs.filter(link => link.kind === "edge").map(link => ({ link, arrow: "→" })),
	]);
	const uses = $derived(hood.inputs.filter(link => link.kind === "uses"));
	const usedBy = $derived(hood.outputs.filter(link => link.kind === "uses"));
</script>

{#if hood.children.length || emptyText}
	<section>
		<div class="section-head">{block ? "Inside" : "Top level"} · {hood.children.length}</div>
		{#each hood.children as child (child.id)}<BlockRow block={child} />{/each}
		{#if !hood.children.length}
			<p class="subtle">{app.grounded ? "Nothing cited inside. Turn grounded off to see the guesses." : emptyText}</p>
		{/if}
	</section>
{/if}
{#if linked.length}
	<section>
		<div class="section-head">Linked · {linked.length}</div>
		{#each linked as { link, arrow }, index (index)}<BlockRow block={link.block} {arrow} edgeLabel={link.label} />{/each}
	</section>
{/if}
<!-- Reuse carries no arrow and no label: it points at a block defined elsewhere. -->
{#if uses.length}
	<section>
		<div class="section-head">Uses · {uses.length}</div>
		{#each uses as link (link.block.id)}<BlockRow block={link.block} />{/each}
	</section>
{/if}
{#if usedBy.length}
	<section>
		<div class="section-head">Used by · {usedBy.length}</div>
		{#each usedBy as link (link.block.id)}<BlockRow block={link.block} />{/each}
	</section>
{/if}
