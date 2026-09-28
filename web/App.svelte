<script lang="ts">
	import { app, loadFiles, walking } from "./app.svelte.ts";
	import { currentDiagram } from "./doc.ts";
	import { onKeydown } from "./keys.ts";
	import BlockPage from "./views/BlockPage.svelte";
	import Files from "./views/Files.svelte";
	import MapView from "./views/MapView.svelte";
	import Modal from "./views/Modal.svelte";
	import Rail from "./views/Rail.svelte";
	import Review from "./views/Review.svelte";
	import Screens from "./views/Screens.svelte";
	import Start from "./views/Start.svelte";
	import StatusBar from "./views/StatusBar.svelte";
	import TopBar from "./views/TopBar.svelte";
	import Viewer from "./views/Viewer.svelte";
	import Walk from "./views/Walk.svelte";

	const ws = $derived(app.state);
	const doc = $derived(ws?.document);
	const emptyRoot = $derived(!!doc && doc.root.blocks.length === 0);
	const startShown = $derived(
		!!ws && !walking() && (!doc || emptyRoot || (app.surface !== "page" && !currentDiagram(ws)?.blocks.length)),
	);

	$effect(() => {
		document.body.classList.toggle("busy", app.inFlight > 0);
		document.body.classList.toggle("reviewing", (ws?.reviews.length ?? 0) > 0);
	});
	// Explore documents are about a codebase: the file tree starts open there.
	$effect(() => {
		if (app.filesOpen !== null || !doc) return;
		app.filesOpen = doc.purpose === "explore" && !walking();
		if (app.filesOpen) void loadFiles();
	});
	// A Uses picker belongs to the block it was opened on.
	$effect(() => {
		if (app.modal?.kind === "uses" && ws?.selected !== app.modal.id) app.modal = null;
	});

	function toggleKeys(): void {
		app.modal = app.modal?.kind === "keys" ? null : { kind: "keys" };
	}
</script>

<svelte:window onkeydown={event => onKeydown(event, toggleKeys)} onclick={() => (app.purposeOpen = false)} />

{#if ws}
	{#if !doc}
		<!-- No document yet: the start panel is the whole page. -->
	{:else if app.surface === "page"}
		<div class="workspace" id="workspace">
			<Rail />
			<main class="block-page" id="blockPage">
				{#if walking()}<Walk />{:else}<BlockPage />{/if}
			</main>
		</div>
	{:else if app.surface === "map"}
		<MapView />
	{:else}
		<Screens />
	{/if}
	<TopBar />
	<StatusBar onKeys={toggleKeys} />
	{#if startShown}<Start />{/if}
	{#if ws.reviews.length}<Review />{/if}
	{#if app.filesOpen && doc}<Files />{/if}
	{#if app.viewer}<Viewer />{/if}
	{#if app.modal}<Modal />{/if}
{/if}
<div class="offline" class:on={app.offline} id="offline">disconnected from the OMP session — run /diagram web again</div>
