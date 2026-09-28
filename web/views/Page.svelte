<script lang="ts">
	import { findNode } from "../../src/layout.ts";
	import { GLYPHS, allNodes, app } from "../app.svelte.ts";
	import Markdown from "../parts/Markdown.svelte";
	import MockupFrame from "../parts/MockupFrame.svelte";

	const PREVIEW_WIDTH = 380;

	const tree = $derived(app.tree!);
	const node = $derived(app.selected === null ? undefined : findNode(tree.root, app.selected));
	const nodes = $derived(allNodes(tree.root));
	const titles = $derived(new Map(nodes.map(other => [other.path, other.title])));
	const file = $derived(node ? `${tree.rootLabel}/${node.path === "" ? "" : `${node.path}/`}index.md` : "");
	const linkedFrom = $derived(
		node ? nodes.flatMap(other => other.arrows.filter(arrow => arrow.to === node.path).map(arrow => ({ from: other.path, label: arrow.label }))) : [],
	);

	/** The preview's HTML, fetched when the node is selected and again when the tree changes. */
	let preview = $state<{ path: string; html: string } | null>(null);
	$effect(() => {
		const path = node?.design?.preview ? node.path : null;
		void tree.version;
		if (path === null) {
			preview = null;
			return;
		}
		let current = true;
		void fetch(`/api/preview?path=${encodeURIComponent(path)}`)
			.then(response => (response.ok ? response.text() : null))
			.then(html => {
				if (current) preview = html === null ? null : { path, html };
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	});
	const html = $derived(preview && preview.path === node?.path ? preview.html : null);
</script>

{#if node}
	<aside class="page">
		<div class="file">{file}</div>
		<h1>{node.title}</h1>
		<div class="status">{GLYPHS[node.status]} {node.status}{#if node.venue}{` · venue: ${node.venue}`}{/if}</div>
		{#if node.problems.length > 0}
			<ul class="problems">
				{#each node.problems as problem (problem)}<li>{problem}</li>{/each}
			</ul>
		{/if}
		{#if node.body.trim()}<section><Markdown text={node.body} /></section>{/if}
		{#if node.arrows.length > 0}
			<section>
				<div class="section-head">links to</div>
				{#each node.arrows as arrow (`${arrow.to}\n${arrow.label}`)}
					<button class="link" onclick={() => (app.selected = arrow.to)}>→ {titles.get(arrow.to)}: {arrow.label}</button>
				{/each}
			</section>
		{/if}
		{#if linkedFrom.length > 0}
			<section>
				<div class="section-head">linked from</div>
				{#each linkedFrom as link (`${link.from}\n${link.label}`)}
					<button class="link" onclick={() => (app.selected = link.from)}>← {titles.get(link.from)}: {link.label}</button>
				{/each}
			</section>
		{/if}
		{#if node.sources.length > 0}
			<section>
				<div class="section-head">sources</div>
				{#each node.sources as source (`${source.path}:${source.startLine}-${source.endLine}`)}
					<div class="source">
						{source.path}{#if source.startLine !== undefined}:{source.startLine}{#if source.endLine !== undefined}-{source.endLine}{/if}{/if}
					</div>
				{/each}
			</section>
		{/if}
		{#if node.design}
			<section>
				<div class="section-head">design</div>
				{#if node.design.markdown}<Markdown text={node.design.markdown} />{/if}
				{#if html !== null}
					<div class="preview">
						<MockupFrame {html} width={PREVIEW_WIDTH} />
						<button onclick={() => (app.fullSize = html)}>Full size</button>
					</div>
				{:else if !node.design.markdown && !node.design.preview}
					<p class="subtle">design/ is empty</p>
				{/if}
			</section>
		{/if}
	</aside>
{/if}
