<script lang="ts">
	import { allNodes, app, canvas } from "./app.svelte.ts";
	import MockupFrame from "./parts/MockupFrame.svelte";
	import Canvas from "./views/Canvas.svelte";
	import Page from "./views/Page.svelte";

	const nodes = $derived(app.tree ? allNodes(app.tree.root) : []);
	const settled = $derived(nodes.filter(node => node.status === "settled").length);
	const done = $derived(nodes.filter(node => node.status === "done").length);
	let innerWidth = $state(1280);

	function onKeydown(event: KeyboardEvent): void {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key === "f") {
			event.preventDefault();
			canvas.fit();
		} else if (event.key === "Escape") {
			if (app.fullSize !== null) app.fullSize = null;
			else app.selected = null;
		}
	}
</script>

<svelte:window onkeydown={onKeydown} bind:innerWidth />

<header class="top">
	{#if app.tree}
		<span class="root">{app.tree.rootLabel}</span>
		<span>{nodes.length} nodes · {settled} settled · {done} done</span>
	{/if}
	{#if app.error}<span class="error">{app.error}</span>{/if}
	<span class="push"></span>
	{#if app.updatedAt}<span class="subtle">updated {app.updatedAt}</span>{/if}
	<button onclick={() => canvas.fit()} disabled={!app.tree}>Fit</button>
</header>
<div class="main">
	<Canvas />
	{#if app.tree && app.selected !== null}<Page />{/if}
</div>
{#if app.fullSize !== null}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="full" onclick={() => (app.fullSize = null)}>
		<div class="full-body">
			<MockupFrame html={app.fullSize} width={Math.min(1280, Math.round(innerWidth * 0.9))} />
			<button onclick={() => (app.fullSize = null)}>Close</button>
		</div>
	</div>
{/if}
<div class="offline" class:on={app.offline}>disconnected — run /diagram again</div>
