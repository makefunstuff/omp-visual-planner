<script lang="ts">
	import { parseMarkdown } from "../markdown.ts";
	let { text, onclick }: { text: string; onclick?: () => void } = $props();
	const blocks = $derived(parseMarkdown(text));
</script>

{#snippet inline(parts: { kind: string; text: string }[])}
	{#each parts as part, index (index)}{#if part.kind === "code"}<code>{part.text}</code>{:else if part.kind === "strong"}<strong>{part.text}</strong>{:else}{part.text}{/if}{/each}
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="md" title="Click to edit" {onclick}>
	{#each blocks as block, index (index)}
		{#if block.kind === "code"}
			<div class="code">{#if block.lang}<span class="lang">{block.lang}</span>{/if}<pre>{block.text}</pre></div>
		{:else if block.kind === "h"}
			<div class="h">{@render inline(block.parts)}</div>
		{:else if block.kind === "ul"}
			<ul>
				{#each block.items as item, itemIndex (itemIndex)}
					<li class={item.box === undefined ? "" : "task"}>{#if item.box !== undefined}<span class="box">{item.box}</span>{/if}{@render inline(item.parts)}</li>
				{/each}
			</ul>
		{:else}
			<p>{@render inline(block.parts)}</p>
		{/if}
	{/each}
</div>
