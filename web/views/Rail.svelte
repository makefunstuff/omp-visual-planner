<script lang="ts">
	import type { Block } from "../../src/model.ts";
	import { CHANGE_DIALOG, focus, marked, op, openBatchPreview, openTextDialog, st, startProject, toggleMark, uncited } from "../app.svelte.ts";
	import { driftStates, findBlock, usedCounts } from "../doc.ts";
	import RequestMark from "../parts/RequestMark.svelte";

	/** The outline beside the page and the walk: every block, its status, the focused one marked. */
	const ws = $derived(st());
	const doc = $derived(ws.document!);
	const flow = $derived(ws.flow!);
	const status = $derived(flow.status);
	const counts = $derived(usedCounts(doc));
	const requestFor = $derived(new Map(ws.requests.filter(request => request.blockId).map(request => [request.blockId!, request])));
	const rows = $derived.by(() => {
		const out: { block: Block; depth: number }[] = [];
		const walk = (blocks: Block[], depth: number): void => {
			for (const block of blocks) {
				out.push({ block, depth });
				if (block.children) walk(block.children.blocks, depth + 1);
			}
		};
		walk(doc.root.blocks, 0);
		return out;
	});
	const change = $derived(doc.purpose === "explore");
	let rail: HTMLElement;

	// Marks on blocks that are gone are dropped.
	$effect(() => {
		for (const id of [...marked]) if (!findBlock(doc, id)) marked.delete(id);
	});
	// Keyboard focus moves may leave the rail's viewport: follow them, never fight a scroll the reader made.
	$effect(() => {
		void ws.selected;
		rail.querySelector(".row.current")?.scrollIntoView({ block: "nearest" });
	});
</script>

<nav class="rail" id="rail" aria-label="Building blocks" bind:this={rail}>
	<div class="label">Outline</div>
	{#if marked.size > 0}
		<div class="batch">
			<span>{marked.size} marked</span>
			{#if marked.size >= 2}
				{#each flow.verbs.filter(verb => verb.id !== "execute") as verb (verb.id)}
					<button title="One subagent per block; each proposal is reviewed on its own" onclick={() => openBatchPreview(verb.id)}>{verb.label} ×{marked.size}…</button>
				{/each}
			{/if}
			{#if change}
				<button title="A new plan that starts reading from these blocks" onclick={() => openTextDialog(CHANGE_DIALOG, goal => startProject("change", goal))}>Plan a change from {marked.size} marked…</button>
			{/if}
			<button class="ghost" onclick={() => marked.clear()}>clear</button>
			{#if marked.size === 1 && !change}<span class="subtle">mark one more to run in parallel</span>{/if}
		</div>
	{/if}
	{#each rows as { block, depth } (block.id)}
		{@const request = requestFor.get(block.id)}
		{@const reused = counts.get(block.id) ?? 0}
		{@const drifted = driftStates(ws, block.id).filter(kind => kind === "changed" || kind === "missing" || kind === "moved")}
		<button
			class="row{block.id === ws.selected ? ' current' : ''}{uncited(block) ? ' dim' : ''}{marked.has(block.id) ? ' marked' : ''}"
			style="padding-left:{8 + depth * 16}px"
			title={status?.labels[block.status]}
			onclick={event => (event.shiftKey ? toggleMark(block.id) : focus(block.id))}
		>
			{#if status}<span class="glyph">{status.glyphs[block.status]}</span>{/if}
			<span class="name">{block.title || "(untitled)"}</span>
			{#if drifted.length}<span class="drift" title="cited code {[...new Set(drifted)].join(', ')} — Drift (D)">≠</span>{/if}
			{#if marked.has(block.id)}<span class="check" title="marked for a parallel batch (m)">✓</span>{/if}
			{#if reused > 0}<span class="reuse" title="used by {reused} {reused === 1 ? 'block' : 'blocks'}">×{reused}</span>{/if}
			{#if request}<RequestMark {request} />{/if}
		</button>
	{/each}
	<div class="actions">
		<button title="Add a block after the focused one (o)" onclick={() => op(ws.selected ? { op: "addBlock", afterId: ws.selected } : { op: "addBlock" })}>+ block</button>
		{#if flow.nextOpen && doc.purpose !== "brainstorm"}
			<button title="n" onclick={() => focus(flow.nextOpen!)}>next open</button>
		{/if}
		<button title="The whole document (Esc)" onclick={() => focus(null)}>overview</button>
	</div>
</nav>
