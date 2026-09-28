<script lang="ts">
	import { select } from "d3-selection";
	import { type D3ZoomEvent, type ZoomBehavior, zoom, zoomIdentity } from "d3-zoom";
	import { onMount, untrack } from "svelte";
	import type { Block } from "../../src/model.ts";
	import { app, focus, freeArea, mapView, op, setMapView, st, stepStatus } from "../app.svelte.ts";
	import { type Box, SX, SY, currentDiagram, rectOf } from "../doc.ts";
	import { type Point, pullPath, routeEdges } from "../edges.ts";
	import { hasCode, summary } from "../markdown.ts";
	import RequestMark from "../parts/RequestMark.svelte";
	import NodeBody from "./NodeBody.svelte";
	import Toolbar from "./Toolbar.svelte";

	const ws = $derived(st());
	const doc = $derived(ws.document!);
	const flow = $derived(ws.flow!);
	const diagram = $derived(currentDiagram(ws));
	const view = $derived(mapView());
	const requestFor = $derived(new Map(ws.requests.filter(request => request.blockId).map(request => [request.blockId!, request])));

	let viewport: HTMLDivElement;
	let panning = $state(false);
	let world: HTMLDivElement;
	let zoomer: ZoomBehavior<HTMLDivElement, unknown>;
	const nodeEls: Record<string, HTMLDivElement> = {};

	/** One pointer gesture at a time: move a node, or pull a wire from its out port. Panning belongs to d3-zoom. */
	let move = $state<{ id: string; sx: number; sy: number; dx: number; dy: number; moved: boolean } | null>(null);
	let pull = $state<{ from: string; start: Point; end: Point; over: string | null } | null>(null);
	/** Rendered node sizes, measured after layout; edges route between them. */
	let sizes = $state<Record<string, { w: number; h: number }>>({});
	/** Label boxes that fit in free space; null means the label hides and the wire keeps it as a tooltip. */
	let labelBoxes = $state<Record<string, { x: number; y: number; w: number; h: number } | null>>({});

	function nodeWidth(block: Block, selected: boolean): number {
		const r = rectOf(block);
		return selected ? Math.max(r.w, hasCode(block.description) ? 440 : 300) : r.w;
	}

	function boxOf(block: Block): Box {
		const r = rectOf(block);
		const size = sizes[block.id];
		const dragged = move?.id === block.id ? move : null;
		return {
			x: r.x + (dragged ? dragged.dx : 0),
			y: r.y + (dragged ? dragged.dy : 0),
			w: size?.w ?? nodeWidth(block, block.id === ws.selected),
			h: size?.h ?? r.h,
		};
	}

	const boxes = $derived(new Map((diagram?.blocks ?? []).map(block => [block.id, boxOf(block)])));
	const routed = $derived(diagram ? routeEdges(diagram.edges, boxes) : []);

	function toWorld(clientX: number, clientY: number): Point {
		return { x: (clientX - view.x) / view.k, y: (clientY - view.y) / view.k };
	}

	onMount(() => {
		zoomer = zoom<HTMLDivElement, unknown>()
			.scaleExtent([0.3, 2])
			// Ctrl/⌘-wheel and pinch zoom about the pointer; a drag on empty map pans.
			.filter(event => {
				if (event.type === "wheel") return event.ctrlKey || event.metaKey;
				const target = event.target as Element;
				return event.button === 0 && !target.closest(".node, .edge-edit, .edge-hit, input, textarea, select, button");
			})
			.on("start", (event: D3ZoomEvent<HTMLDivElement, unknown>) => (panning = event.sourceEvent?.type === "mousedown"))
			.on("end", () => (panning = false))
			.on("zoom", (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
				const { x, y, k } = event.transform;
				const current = untrack(mapView);
				if (current.x !== x || current.y !== y || current.k !== k) setMapView({ x, y, k });
			});
		select(viewport).call(zoomer).on("dblclick.zoom", null);
		// A plain wheel pans, the way the rest of the page scrolls.
		const wheel = (event: WheelEvent): void => {
			if (event.ctrlKey || event.metaKey) return;
			event.preventDefault();
			const current = mapView();
			setMapView({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY });
		};
		viewport.addEventListener("wheel", wheel, { passive: false });
		return () => viewport.removeEventListener("wheel", wheel);
	});

	// Keep d3's idea of the transform in step with the view set elsewhere (fit, centring, another diagram).
	$effect(() => {
		const { x, y, k } = view;
		if (!zoomer) return;
		const current = (viewport as unknown as { __zoom?: { x: number; y: number; k: number } }).__zoom;
		if (current && current.x === x && current.y === y && current.k === k) return;
		select(viewport).call(zoomer.transform, zoomIdentity.translate(x, y).scale(k));
	});

	// Centre on a block another surface or a key focused.
	$effect(() => {
		const id = app.centerOn;
		if (!id || !diagram) return;
		const target = diagram.blocks.find(block => block.id === id);
		untrack(() => {
			app.centerOn = null;
			if (!target) return;
			const r = rectOf(target);
			const area = freeArea();
			const k = mapView().k;
			setMapView({ k, x: area.left + area.width / 2 - (r.x + r.w / 2) * k, y: area.top + area.height / 2 - (r.y + r.h / 2) * k });
		});
	});

	// Measure nodes after every layout change; only a real change writes back.
	$effect(() => {
		void diagram;
		void ws.selected;
		void app.editTitleOf;
		void app.editBodyOf;
		untrack(() => {
			const next: Record<string, { w: number; h: number }> = {};
			let changed = false;
			for (const block of diagram?.blocks ?? []) {
				const node = nodeEls[block.id];
				if (!node) continue;
				next[block.id] = { w: node.offsetWidth, h: node.offsetHeight };
				const before = sizes[block.id];
				if (!before || before.w !== node.offsetWidth || before.h !== node.offsetHeight) changed = true;
			}
			if (changed || Object.keys(sizes).length !== Object.keys(next).length) sizes = next;
		});
	});

	// Like the terminal: a label goes in free space or not at all.
	$effect(() => {
		void routed;
		untrack(() => {
			const placed: { x: number; y: number; w: number; h: number }[] = [];
			const next: typeof labelBoxes = {};
			const cards = [...boxes.values()];
			const hits = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
				a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
			for (const text of world.querySelectorAll<SVGTextElement>("text.edge-label")) {
				const id = text.dataset.edge!;
				const bbox = text.getBBox();
				const box = { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height };
				if (cards.some(card => hits(box, card)) || placed.some(other => hits(box, other))) next[id] = null;
				else {
					placed.push(box);
					next[id] = box;
				}
			}
			if (JSON.stringify(next) !== JSON.stringify(labelBoxes)) labelBoxes = next;
		});
	});

	// A selected node near the right edge would push its toolbar off screen: slide the toolbar back in.
	$effect(() => {
		void view;
		void ws.selected;
		const bar = world.querySelector<HTMLElement>(".node.selected .toolbar");
		if (!bar) return;
		bar.style.left = "";
		const overflow = bar.getBoundingClientRect().right - (window.innerWidth - 8);
		if (overflow > 0) bar.style.left = `${-1 - overflow / view.k}px`;
	});

	function startMove(event: PointerEvent, block: Block): void {
		const target = event.target as Element;
		if (event.button !== 0 || target.closest("input, textarea, select, button, .md, .srcs, .glyph, .inside, .badge, .port")) return;
		// No text selection while a node is dragged.
		event.preventDefault();
		move = { id: block.id, sx: event.clientX, sy: event.clientY, dx: 0, dy: 0, moved: false };
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
	}

	function dragMove(event: PointerEvent): void {
		if (!move) return;
		move.dx = (event.clientX - move.sx) / view.k;
		move.dy = (event.clientY - move.sy) / view.k;
		if (Math.abs(move.dx) + Math.abs(move.dy) > 3) move.moved = true;
	}

	async function endMove(block: Block): Promise<void> {
		const done = move;
		if (!done) return;
		move = null;
		app.selectedEdge = null;
		if (done.moved) {
			const r = rectOf(block);
			await op({ op: "moveBlock", id: block.id, x: Math.max(0, Math.round((r.x + done.dx) / SX)), y: Math.max(0, Math.round((r.y + done.dy) / SY)) });
		}
		if (st().selected !== block.id) await focus(block.id);
	}

	function startPull(event: PointerEvent, block: Block): void {
		if (event.button !== 0) return;
		event.stopPropagation();
		const box = boxes.get(block.id)!;
		const start = { x: box.x + box.w, y: box.y + box.h / 2 };
		pull = { from: block.id, start, end: start, over: null };
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
	}

	function nodeAt(event: PointerEvent | MouseEvent): string | null {
		return document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".node")?.dataset.id ?? null;
	}

	function dragPull(event: PointerEvent): void {
		if (!pull) return;
		pull.end = toWorld(event.clientX, event.clientY);
		const over = nodeAt(event);
		pull.over = over !== pull.from ? over : null;
	}

	async function endPull(): Promise<void> {
		const done = pull;
		pull = null;
		if (!done?.over) return;
		const result = await op({ op: "addEdge", from: done.from, to: done.over, label: "" });
		const edge = result.ok ? currentDiagram(st())?.edges.at(-1) : undefined;
		if (!edge) return;
		app.selectedEdge = edge.id;
		requestAnimationFrame(() => world.querySelector<HTMLInputElement>(".edge-edit input")?.focus());
	}

	/** A click on empty map: drop the edge selection, then the block selection. */
	function backgroundClick(event: MouseEvent): void {
		const target = event.target as Element;
		if (target.closest(".node, .edge-edit, .edge-hit")) return;
		app.selectedEdge = null;
		if (st().selected) void focus(null);
	}

	async function backgroundDblclick(event: MouseEvent): Promise<void> {
		const target = event.target as Element;
		if (target.closest("input, textarea, select, button, .edge-edit, .node")) return;
		const point = toWorld(event.clientX, event.clientY);
		const result = await op({ op: "addBlock", x: Math.max(0, Math.round(point.x / SX) - 6), y: Math.max(0, Math.round(point.y / SY) - 1) });
		if (result.ok) app.editTitleOf = st().selected ?? null;
	}

	function cycleEvidence(block: Block): void {
		const order = ["observed", "inferred", "unknown"];
		void op({ op: "patchBlock", id: block.id, fields: { evidence: order[(order.indexOf(block.evidence) + 1) % order.length] } });
	}

	function titleEditor(input: HTMLInputElement, block: Block) {
		input.value = block.title;
		requestAnimationFrame(() => {
			input.focus();
			input.select();
		});
		const commit = (): void => {
			const value = input.value.trim();
			app.editTitleOf = null;
			if (value && value !== block.title) void op({ op: "patchBlock", id: block.id, fields: { title: value } });
		};
		const keys = (event: KeyboardEvent): void => {
			if (event.key === "Enter") input.blur();
			if (event.key === "Escape") {
				input.value = block.title;
				input.blur();
			}
		};
		input.addEventListener("blur", commit);
		input.addEventListener("keydown", keys);
		return {
			destroy() {
				input.removeEventListener("blur", commit);
				input.removeEventListener("keydown", keys);
			},
		};
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
	class="viewport"
	class:panning
	id="viewport"
	bind:this={viewport}
	style="background-size:{16 * view.k}px {16 * view.k}px;background-position:{view.x}px {view.y}px"
	onclick={backgroundClick}
	ondblclick={backgroundDblclick}
>
	<div class="world" id="world" bind:this={world} style="transform:translate({view.x}px,{view.y}px) scale({view.k})">
		<svg class="edges" id="edges">
			<defs>
				{#each [["arrow", "#646262"], ["arrow-on", "#007aff"]] as [id, color] (id)}
					<marker {id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
						<path d="M0,0 L10,5 L0,10 z" fill={color} />
					</marker>
				{/each}
			</defs>
			{#each routed as { edge, d, label } (edge.id)}
				{@const on = edge.id === app.selectedEdge}
				{@const marker = `url(#${on ? "arrow-on" : "arrow"})`}
				{@const box = labelBoxes[edge.id]}
				<g class="edge{on ? ' selected' : ''}">
					<path class="edge-line" {d} marker-end={edge.direction !== "none" ? marker : undefined} marker-start={edge.direction === "both" ? marker : undefined} />
					<path
						class="edge-hit"
						{d}
						onpointerdown={event => event.stopPropagation()}
						onclick={event => {
							event.stopPropagation();
							app.selectedEdge = edge.id;
						}}>{#if edge.label && box === null}<title>{edge.label}</title>{/if}</path
					>
					{#if edge.label && !on}
						{#if box}<rect class="edge-label-bg" x={box.x - 4} y={box.y - 1} width={box.w + 8} height={box.h + 2} />{/if}
						<text class="edge-label" data-edge={edge.id} x={label.x} y={label.y + 4} text-anchor="middle" visibility={box ? undefined : "hidden"}>{edge.label}</text>
					{/if}
				</g>
			{/each}
			{#if pull}<path class="wire" d={pullPath(pull.start, pull.end)} />{/if}
		</svg>
		{#each diagram?.blocks ?? [] as block (block.id)}
			{@const selected = block.id === ws.selected}
			{@const r = rectOf(block)}
			{@const box = boxes.get(block.id)!}
			{@const kids = block.children ? block.children.blocks.length : 0}
			{@const glyph = flow.status ? flow.status.glyphs[block.status] : ""}
			{@const request = requestFor.get(block.id)}
			{@const working = !!request && request.state === "pending" && !request.stalled}
			<div
				class="node{selected ? ' selected' : ''}{working ? ' working' : ''}{pull?.over === block.id ? ' target' : ''}"
				data-id={block.id}
				bind:this={nodeEls[block.id]}
				style="left:{box.x}px;top:{box.y}px;width:{nodeWidth(block, selected)}px;{selected ? '' : `height:${r.h}px`}"
				onpointerdown={event => startMove(event, block)}
				onpointermove={dragMove}
				onpointerup={() => endMove(block)}
			>
				<div class="head">
					{#if glyph}<span class="glyph" title="{flow.status!.labels[block.status]} — click to step" onclick={() => stepStatus(block)}>{glyph}</span>{/if}
					{#if app.editTitleOf === block.id}
						<input class="title-edit" type="text" spellcheck="false" use:titleEditor={block} />
					{:else}
						<span class="title" title="Double-click to rename" ondblclick={event => { event.stopPropagation(); app.editTitleOf = block.id; }}>{block.title || "(untitled)"}</span>
					{/if}
					{#if doc.purpose !== "brainstorm"}
						{#if block.evidence === "observed"}<span class="badge observed" title="evidence: observed — click to step" onclick={() => cycleEvidence(block)}>*</span>
						{:else if block.evidence === "unknown"}<span class="badge unknown" title="evidence: unknown — click to step" onclick={() => cycleEvidence(block)}>?</span>
						{:else if selected}<span class="badge" title="evidence: inferred — click to step" onclick={() => cycleEvidence(block)}>~</span>{/if}
					{/if}
					{#if request}<RequestMark {request} clock />{/if}
					{#if selected && flow.status}<span class="state">{flow.status.labels[block.status]}</span>{/if}
					{#if !selected && hasCode(block.description)}<span class="has-code" title="contains code">{"{}"}</span>{/if}
					<span class="inside" title={kids > 0 ? `Open the ${kids} block(s) inside (Enter)` : "Open inside (Enter)"} onclick={() => op({ op: "enter", id: block.id })}>[{kids}]</span>
				</div>
				{#if !selected}<div class="desc{block.description ? '' : ' none'}">{summary(block.description) || "—"}</div>{/if}
				<div class="port in" title="input"></div>
				<div class="port out" title="drag to link" onpointerdown={event => startPull(event, block)} onpointermove={dragPull} onpointerup={endPull}></div>
				{#if selected}
					<NodeBody {block} />
					<Toolbar {block} />
				{/if}
			</div>
		{/each}
		{#each routed.filter(route => route.edge.id === app.selectedEdge) as { edge, label } (edge.id)}
			<div class="edge-edit" style="left:{label.x}px;top:{label.y}px" onpointerdown={event => event.stopPropagation()}>
				<input
					type="text"
					placeholder="label"
					spellcheck="false"
					value={edge.label}
					onkeydown={event => (event.key === "Enter" || event.key === "Escape") && event.currentTarget.blur()}
					onblur={event => event.currentTarget.value !== edge.label && op({ op: "patchEdge", id: edge.id, label: event.currentTarget.value.trim() })}
				/>
				<button
					class="danger"
					title="Delete relationship"
					onclick={() => {
						app.selectedEdge = null;
						void op({ op: "removeEdge", id: edge.id });
					}}>×</button
				>
			</div>
		{/each}
	</div>
</div>
