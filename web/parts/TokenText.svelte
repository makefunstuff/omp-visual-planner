<script lang="ts">
	import type { Span } from "../../src/highlight.ts";
	/** A line as token-class spans when the server highlighted it, else as plain text. Text only, never markup. */
	let { tokens, text }: { tokens: Span[] | null | undefined; text: string } = $props();
</script>

{#if tokens}{#each tokens as [kind, part], index (index)}{#if kind}<span class="tk-{kind}">{part}</span>{:else}{part}{/if}{/each}{:else}{text}{/if}
