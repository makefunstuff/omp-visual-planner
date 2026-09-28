<script lang="ts">
	import { PURPOSES } from "../../src/model.ts";
	import { app, fit, mapView, op, openDrift, st, toggleFiles, toggleMap, toggleSurface } from "../app.svelte.ts";
	import Activity from "./Activity.svelte";

	const ws = $derived(st());
	const doc = $derived(ws.document);
	let title = $state("");
	let editing = false;
	$effect.pre(() => {
		if (!editing) title = doc?.title ?? "";
	});
</script>

<header class="hud top" id="topbar">
	<div class="left">
		<input
			class="doc"
			id="docTitle"
			title="Document title — click to rename"
			spellcheck="false"
			size={Math.max(12, Math.min(44, title.length + 1))}
			disabled={!doc}
			bind:value={title}
			onfocus={() => (editing = true)}
			onblur={() => (editing = false)}
			onkeydown={event => (event.key === "Enter" || event.key === "Escape") && event.currentTarget.blur()}
			onchange={() => title.trim() && op({ op: "patchDocument", title: title.trim() })}
		/>
		{#if doc}
			<div class="purpose" id="purposeWrap">
				<button
					type="button"
					id="purpose"
					title="What this document is for"
					onclick={event => {
						event.stopPropagation();
						app.purposeOpen = !app.purposeOpen;
					}}>{doc.purpose}</button
				>
				{#if app.purposeOpen}
					<div class="menu" id="purposeMenu">
						{#each PURPOSES as value (value)}
							<button
								class={value === doc.purpose ? "on" : ""}
								onclick={event => {
									event.stopPropagation();
									app.purposeOpen = false;
									if (value !== doc.purpose) void op({ op: "setPurpose", purpose: value });
								}}>{value}</button
							>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
		<span class="muted" id="progress">{ws.flow?.progress ?? ""}</span>
		<span class="dirty" class:on={ws.dirty} id="dirty" title="Edits are in memory until you save">● unsaved</span>
		<!-- The page carries its own breadcrumb; the map needs one to climb back out. -->
		<span class="crumbs" id="crumbs">
			{#if app.surface === "map" && ws.breadcrumb.length > 1}
				{#each ws.breadcrumb as crumb, index (crumb.diagramId)}
					{@const here = index === ws.breadcrumb.length - 1}
					{#if index > 0}<span class="muted">›</span>{/if}
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_missing_attribute -->
					<a class={here ? "here" : ""} onclick={() => !here && op({ op: "navigate", diagramId: crumb.diagramId })}>{crumb.title}</a>
				{/each}
			{/if}
		</span>
	</div>
	<div class="right">
		<Activity />
		<button class="ghost" id="undo" title="Undo (⌘Z)" disabled={!ws.canUndo} onclick={() => op({ op: "undo" })}>Undo</button>
		<button class="ghost" id="redo" title="Redo (⇧⌘Z)" disabled={!ws.canRedo} onclick={() => op({ op: "redo" })}>Redo</button>
		<span class="sep"></span>
		<button class="ghost" id="filesToggle" title="Files in this workspace (/)" onclick={() => toggleFiles()}>Files</button>
		<button class="ghost" id="driftToggle" title="Check cited code against the diagram (D)" onclick={() => doc && openDrift()}>Drift</button>
		<button class="ghost" id="screensToggle" title="Every page and component, drawn (S)" onclick={() => toggleSurface("screens")}>{app.surface === "screens" ? "Page" : "Screens"}</button>
		<button class="ghost" id="mapToggle" title="Switch between the block page and the map (v)" onclick={toggleMap}>{app.surface === "map" ? "Page" : "Map"}</button>
		{#if app.surface === "map"}
			<button class="ghost" id="tidy" title="Lay this level out on the grid (T)" disabled={!doc} onclick={async () => { await op({ op: "tidy" }); fit(); }}>Tidy</button>
			<button class="ghost" id="fit" title="Fit to screen (F)" disabled={!doc} onclick={fit}>Fit</button>
			<span class="zoom" id="zoom">{Math.round(mapView().k * 100)}%</span>
		{/if}
		<span class="sep"></span>
		<button class="primary" id="save" title="Save (⌘S)" disabled={!doc || !ws.dirty} onclick={() => op({ op: "save" })}>Save</button>
	</div>
</header>
