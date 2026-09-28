<script lang="ts">
	import type { Span } from "../../src/highlight.ts";
	import { app, focus, insightFor, lineRequest, marked, op, openOutline, openSymbol, openTextDialog, st } from "../app.svelte.ts";
	import { citations, rangeText, selectedBlock } from "../doc.ts";
	import IntelPane from "./IntelPane.svelte";

	/** The read-only file viewer: numbered, highlighted lines, the blocks that cite them, and requests on a selected range. */
	const ws = $derived(st());
	const viewer = $derived(app.viewer!);
	const cites = $derived(citations(ws.document).get(viewer.path) ?? []);
	const focused = $derived(selectedBlock(ws));
	const ranges = $derived(cites.map(({ block, source }) => ({ mine: !!focused && block.id === focused.id, a: source.startLine || 0, b: source.endLine || source.startLine || 0 })));
	const sel = $derived(viewer.selection ? { from: Math.min(viewer.selection.a, viewer.selection.b), to: Math.max(viewer.selection.a, viewer.selection.b) } : null);
	const lines = $derived(sel ? { path: viewer.path, startLine: sel.from, endLine: sel.to } : null);
	const explore = $derived(ws.document?.purpose === "explore");
	const syntax = $derived.by(() => {
		if (!lines) return "";
		const insight = insightFor(lines.path, lines.startLine);
		if (!insight) return "syntax: …";
		return insight.error ?? insight.summary ?? insight.limitation;
	});
	/** Wide: everything right of the file tree, for reading the whole file. */
	const left = $derived.by(() => {
		if (!viewer.wide) return "";
		void app.filesOpen;
		const files = document.getElementById("files");
		return `${files ? files.getBoundingClientRect().right + 12 : 12}px`;
	});
	let body: HTMLDivElement;

	type Piece = { kind: string | null; text: string; col: number; ident: boolean };
	/** A line's parts, each identifier a clickable piece that knows its 0-based column. */
	function pieces(parts: Span[] | [null, string][]): Piece[] {
		const out: Piece[] = [];
		let col = 0;
		for (const [kind, part] of parts) {
			part.split(/([A-Za-z_$][\w$]*)/).forEach((piece, index) => {
				if (!piece) return;
				out.push({ kind: kind || null, text: piece, col, ident: index % 2 === 1 });
				col += piece.length;
			});
		}
		return out;
	}

	// Scroll to a requested line once; a newly opened file starts at the focused block's citation.
	let openedFor = "";
	$effect(() => {
		const fresh = openedFor !== viewer.path;
		openedFor = viewer.path;
		const target = viewer.line || (fresh ? ranges.find(range => range.mine && range.a)?.a : undefined);
		if (!target) return;
		viewer.line = null;
		requestAnimationFrame(() => body?.querySelector(`tr[data-n="${target}"]`)?.scrollIntoView({ block: "center" }));
	});

	function requestChange(): void {
		const range = lines!;
		openTextDialog(
			{
				title: `Request a change to ${range.path}:${range.startLine}-${range.endLine}`,
				placeholder: "What should change in these lines?",
				hint: explore ? "Starts a new change plan from these lines." : "Adds a block citing these lines under the focused block, then previews Refine on it.",
			},
			text =>
				explore
					? void op({ op: "submit", start: { kind: "change", goal: text, marked: [...marked], lines: range } }).then(result => result.ok && marked.clear())
					: void lineRequest("change", text, range),
		);
	}

	function askAbout(): void {
		const range = lines!;
		openTextDialog(
			{
				title: `Ask about ${range.path}:${range.startLine}-${range.endLine}`,
				placeholder: "What do you want to know about these lines?",
				hint: "Adds a question block citing these lines; the agent answers into its notes and you review the answer.",
			},
			text => void lineRequest("ask", text, range),
		);
	}

	/** One listener for every identifier: clicking one asks the language server about it. */
	function identClick(event: MouseEvent): void {
		const ident = (event.target as Element).closest<HTMLElement>(".ident");
		if (!ident) return;
		openSymbol(viewer.path, Number(ident.closest("tr")!.dataset.n), Number(ident.dataset.col), ident.textContent ?? "");
	}
</script>

<aside class="drawer viewer" id="viewer" style:left style:width={viewer.wide ? "auto" : ""}>
	<div class="bar">
		<span class="name" title={viewer.path}>{viewer.path}</span>
		{#if focused}
			<button
				class="primary"
				title="Anchor the focused block to this file{sel ? ' range' : ''}"
				onclick={() => op(sel ? { op: "addSource", id: focused.id, path: viewer.path, startLine: sel.from, endLine: sel.to } : { op: "addSource", id: focused.id, path: viewer.path })}
				>anchor “{focused.title}” → {viewer.path.split("/").pop()}{sel ? `:${sel.from}-${sel.to}` : ""}</button
			>
		{/if}
		{#if lines && ws.document}
			<button title={explore ? "Start a change plan from these lines" : "Add a block citing these lines, then preview Refine on it"} onclick={requestChange}>Request a change…</button>
			<button title="Add a question block citing these lines; the agent answers into it" onclick={askAbout}>Ask…</button>
		{/if}
		<button class="ghost" title="Symbols in this file, from its language server" onclick={() => openOutline(viewer.path)}>Outline</button>
		<span class="meta">{viewer.lines.length} lines{viewer.tokens ? "" : " · plain text"}</span>
		<button class="ghost" title={viewer.wide ? "Narrow the viewer" : "Widen the viewer over the canvas"} onclick={() => (viewer.wide = !viewer.wide)}>{viewer.wide ? "⤡" : "⤢"}</button>
		<button class="ghost" title="Close (Esc)" onclick={() => (app.viewer = null)}>×</button>
	</div>
	<div class="who">
		{#if cites.length === 0}
			<span class="none">no block anchors here yet{focused ? " — click a line number (shift-click extends) to pick a range" : ""}</span>
		{:else}
			{#each cites as { block, source }, index (index)}
				<button
					title="Go to this block"
					onclick={() => {
						void focus(block.id, true);
						if (source.startLine) viewer.line = source.startLine;
					}}>{block.title}{source.startLine ? ` :${rangeText(source).split(":").pop()}` : ""}</button
				>
			{/each}
		{/if}
		{#if lines}<span class="syntax">{syntax}</span>{/if}
	</div>
	{#if viewer.intel}<IntelPane {viewer} />{/if}
	<div class="scroll" bind:this={body}>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<table onclick={identClick}>
			<tbody>
				{#each viewer.lines as text, index (index)}
					{@const n = index + 1}
					{@const hit = ranges.filter(range => range.a && n >= range.a && n <= range.b)}
					<tr class={sel && n >= sel.from && n <= sel.to ? "sel" : hit.some(range => range.mine) ? "mine" : hit.length ? "cited" : ""} data-n={n}>
						<td
							class="n"
							onclick={event => (viewer.selection = event.shiftKey && viewer.selection ? { a: viewer.selection.a, b: n } : { a: n, b: n })}>{n}</td
						>
						<td class="t"
							>{#each pieces(viewer.tokens?.[index] ?? [[null, text]]) as piece, pieceIndex (pieceIndex)}{#if piece.ident}<span
										class="{piece.kind ? `tk-${piece.kind} ` : ''}ident"
										data-col={piece.col}>{piece.text}</span
									>{:else if piece.kind}<span class="tk-{piece.kind}">{piece.text}</span>{:else}{piece.text}{/if}{/each}</td
						>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if viewer.truncated}<div class="note">…showing the first 5000 lines</div>{/if}
	</div>
</aside>
