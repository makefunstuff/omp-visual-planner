<script lang="ts">
	import type { Block } from "../../src/model.ts";
	import { app, implementBlock, op, openPreview, removeBlock, st } from "../app.svelte.ts";
	import StepButton from "./StepButton.svelte";
	/** The block's controls: the one next step first, the other verbs, then structure; delete stands apart. */
	let { block, structure }: { block: Block; structure: boolean } = $props();
	const flow = $derived(st().flow!);
	const purpose = $derived(st().document!.purpose);
	const step = $derived(flow.next);
	const verbs = $derived(flow.verbs.filter(verb => !(step.act === "verb" && step.verb === verb.id)));
</script>

<div class="actions">
	<StepButton {block} />
	{#each verbs as verb (verb.id)}
		<button title="{verb.label} ({verb.key}): previews the request first" onclick={() => openPreview(verb.id, block.id)}>{verb.label}…</button>
	{/each}
	{#if purpose === "brainstorm" && step.act !== "implement"}
		<button title="Turn this into a plan and open Execute for this block" onclick={() => implementBlock(block.id)}>Implement…</button>
	{/if}
	{#if purpose === "explore" && block.status === "open" && step.act !== "status"}
		<button title="space" onclick={() => op({ op: "setStatus", id: block.id, status: "settled" })}>Mark explored</button>
	{/if}
	<button title="Link this block to a reusable block anywhere (U)" onclick={() => (app.modal = { kind: "uses", id: block.id })}>Uses…</button>
	{#if flow.extractTargets.length}
		<button title="Move it up a level to share it; the block that held it uses it (M)" onclick={() => (app.modal = { kind: "extract", id: block.id })}>Extract…</button>
	{/if}
	{#if structure}
		<button title="Add a block inside this one (O)" onclick={() => op({ op: "addBlock", parentId: block.id })}>+ inside</button>
		<button class="danger ghost push" title="Delete this block and everything inside it (⌫)" onclick={() => removeBlock(block)}>Delete</button>
	{/if}
</div>
