<script lang="ts">
	import { select } from "d3-selection";
	import { type D3ZoomEvent, type ZoomBehavior, zoom, zoomIdentity } from "d3-zoom";
	import { onMount } from "svelte";
	import { layoutTree } from "../../src/layout.ts";
	import { GLYPHS, app, canvas, collapsed } from "../app.svelte.ts";

	const MARGIN = 24;
	const layout = $derived(app.tree ? layoutTree(app.tree.root, collapsed) : null);

	let viewport: HTMLDivElement;
	let view = $state({ x: 0, y: 0, k: 1 });
	let panning = $state(false);
	let zoomer: ZoomBehavior<HTMLDivElement, unknown> | undefined = $state();
	let fitted = false;

	/** Scale a rectangle of the world into the viewport, with a margin. */
	function fit(path?: string): void {
		if (!layout || !zoomer) return;
		const box = path === undefined ? { x: 0, y: 0, w: layout.width, h: layout.height } : layout.boxes.find(candidate => candidate.path === path);
		if (!box) return;
		const width = viewport.clientWidth;
		const height = viewport.clientHeight;
		const k = Math.min(2, Math.max(0.1, Math.min((width - 2 * MARGIN) / box.w, (height - 2 * MARGIN) / box.h)));
		const x = (width - box.w * k) / 2 - box.x * k;
		const y = (height - box.h * k) / 2 - box.y * k;
		select(viewport).call(zoomer.transform, zoomIdentity.translate(x, y).scale(k));
	}

	onMount(() => {
		const behavior = zoom<HTMLDivElement, unknown>()
			.scaleExtent([0.1, 2])
			// Ctrl/⌘-wheel and pinch zoom about the pointer; a drag pans, a click still selects.
			.filter(event => {
				if (event.type === "wheel") return event.ctrlKey || event.metaKey;
				return !event.button && !(event.target as Element).closest("button");
			})
			.on("start", (event: D3ZoomEvent<HTMLDivElement, unknown>) => (panning = event.sourceEvent?.type === "mousedown"))
			.on("end", () => (panning = false))
			.on("zoom", (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
				const { x, y, k } = event.transform;
				view = { x, y, k };
			});
		select(viewport).call(behavior).on("dblclick.zoom", null);
		// A plain wheel pans, the way the rest of the page scrolls.
		const wheel = (event: WheelEvent): void => {
			if (event.ctrlKey || event.metaKey) return;
			event.preventDefault();
			behavior.translateBy(select(viewport), -event.deltaX / view.k, -event.deltaY / view.k);
		};
		viewport.addEventListener("wheel", wheel, { passive: false });
		zoomer = behavior;
		canvas.fit = fit;
		return () => {
			viewport.removeEventListener("wheel", wheel);
			canvas.fit = () => {};
		};
	});

	// The first tree fits everything; later redraws keep the view.
	$effect(() => {
		if (!layout || !zoomer || fitted) return;
		fitted = true;
		fit();
	});

	function toggle(path: string): void {
		if (collapsed.has(path)) collapsed.delete(path);
		else collapsed.add(path);
	}
</script>

<div class="canvas" class:panning bind:this={viewport} style="background-size:{16 * view.k}px {16 * view.k}px;background-position:{view.x}px {view.y}px">
	{#if layout}
		<div class="world" style="transform:translate({view.x}px,{view.y}px) scale({view.k})">
			{#each layout.boxes as box (box.path)}
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div
					class="box {box.status}"
					class:selected={box.path === app.selected}
					class:odd={box.depth % 2 === 1}
					class:parent={box.childCount > 0 && !box.collapsed}
					data-path={box.path}
					style="left:{box.x}px;top:{box.y}px;width:{box.w}px;height:{box.h}px"
					onclick={event => {
						event.stopPropagation();
						app.selected = box.path;
					}}
					ondblclick={event => {
						event.stopPropagation();
						fit(box.path);
					}}
				>
					<div class="head">
						{#if box.childCount > 0}
							<button
								class="twisty"
								title={box.collapsed ? "expand" : "collapse"}
								onclick={event => {
									event.stopPropagation();
									toggle(box.path);
								}}>{box.collapsed ? "▸" : "▾"}</button
							>
						{/if}
						<span class="glyph">{GLYPHS[box.status]}</span>
						<span class="title" title={box.title}>{box.title}</span>
						{#if box.collapsed}<span class="more">+{box.childCount}</span>{/if}
						{#if box.designed}<span class="badge" title="designed">◇</span>{/if}
						{#if box.problems > 0}<span class="badge bad" title="{box.problems} problem{box.problems === 1 ? '' : 's'}">!</span>{/if}
					</div>
				</div>
			{/each}
			<svg class="wires" width={layout.width} height={layout.height}>
				<defs>
					{#each ["arrow", "arrow-on"] as id (id)}
						<marker {id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
							<path class={id} d="M0,0 L10,5 L0,10 z" />
						</marker>
					{/each}
				</defs>
				{#each layout.wires as wire (`${wire.from}\n${wire.to}\n${wire.label}`)}
					{@const on = app.selected !== null && (wire.from === app.selected || wire.to === app.selected)}
					<g class="wire" class:on>
						<line x1={wire.x1} y1={wire.y1} x2={wire.x2} y2={wire.y2} marker-end="url(#{on ? 'arrow-on' : 'arrow'})" />
						<text x={(wire.x1 + wire.x2) / 2} y={(wire.y1 + wire.y2) / 2 + 4} text-anchor="middle">{wire.label}</text>
					</g>
				{/each}
			</svg>
		</div>
	{/if}
</div>
