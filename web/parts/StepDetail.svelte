<script lang="ts">
	import { st } from "../app.svelte.ts";
	const step = $derived(st().flow?.next);
</script>

{#if step}<p class="step-detail">{step.detail}</p>{/if}
