<script lang="ts">
	import type { Block } from "../../src/model.ts";
	import { app, op, openFile, st } from "../app.svelte.ts";
	import { rangeText } from "../doc.ts";
	import Checklist from "../parts/Checklist.svelte";
	import InlineText from "../parts/InlineText.svelte";
	import Markdown from "../parts/Markdown.svelte";

	/** The selected node's content: the fields the purpose shows, as plain editable text. */
	let { block }: { block: Block } = $props();
	const patch = (fields: Record<string, unknown>) => op({ op: "patchBlock", id: block.id, fields });
	const TICKS = "```";
</script>

<div class="body">
	<!-- Title is edited in the head; evidence and status are marks in the head; agent notes live with the request they steer, in the preview. -->
	{#each st().flow!.fields as { field, label } (field)}
		{#if field === "description"}
			{#if block.description.trim() && app.editBodyOf !== block.id}
				<Markdown text={block.description} onclick={() => (app.editBodyOf = block.id)} />
			{:else}
				<InlineText
					value={block.description}
					placeholder="{label}… (markdown: {TICKS} for code)"
					commit={value => patch({ description: value })}
					onDone={() => (app.editBodyOf = null)}
					autofocus={app.editBodyOf === block.id}
				/>
			{/if}
		{:else if field === "expectedOutput"}
			<div class="line"><span class="lead">→</span><InlineText value={block.expectedOutput} placeholder="{label}…" commit={value => patch({ expectedOutput: value })} /></div>
		{:else if field === "criteria"}
			<Checklist items={block.acceptanceCriteria} placeholder="{label}…" commit={value => patch({ acceptanceCriteria: value })} />
		{:else if field === "sources" && block.sources.length > 0}
			<ul class="srcs" title={label}>
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
				{#each block.sources as source, index (index)}<li title="Open in the file viewer" onclick={() => openFile(source.path, source.startLine)}>{rangeText(source)}</li>{/each}
			</ul>
		{/if}
	{/each}
</div>
