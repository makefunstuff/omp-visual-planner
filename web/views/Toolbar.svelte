<script lang="ts">
	import type { Block } from "../../src/model.ts";
	import { op, openPreview, removeBlock, st } from "../app.svelte.ts";
	import StepButton from "../parts/StepButton.svelte";

	let { block }: { block: Block } = $props();
	const flow = $derived(st().flow!);
	const verbs = $derived(flow.verbs.filter(verb => !(flow.next.act === "verb" && flow.next.verb === verb.id)));
</script>

<div class="toolbar">
	<StepButton {block} />
	<span class="sep"></span>
	{#each verbs as verb (verb.id)}
		<button title="{verb.label} ({verb.key})" onclick={() => openPreview(verb.id, block.id)}>{verb.label}<kbd>{verb.key}</kbd></button>
	{/each}
	<span class="sep"></span>
	<button title="Add a block inside (O)" onclick={() => op({ op: "addBlock", parentId: block.id })}>+ inside<kbd>O</kbd></button>
	<button class="danger" title="Delete (⌫)" onclick={() => removeBlock(block)}>delete</button>
</div>
