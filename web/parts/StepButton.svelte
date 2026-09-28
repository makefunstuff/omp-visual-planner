<script lang="ts">
	import type { Block } from "../../src/model.ts";
	import { runStep, st } from "../app.svelte.ts";
	let { block }: { block: Block | null } = $props();
	const step = $derived(st().flow?.next);
</script>

{#if step}<button class="primary" title={step.detail} onclick={() => runStep(block)}>{step.label}</button>{/if}
