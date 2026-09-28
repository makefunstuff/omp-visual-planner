<script lang="ts">
	import { CHANGE_DIALOG, app, focus, insightFor, op, openFile, openPreview, openTextDialog, st, startProject } from "../app.svelte.ts";
	import { citationCheck, currentDiagram, ownerOfDiagram, rangeText, selectedBlock } from "../doc.ts";
	import ActionRow from "../parts/ActionRow.svelte";
	import Checklist from "../parts/Checklist.svelte";
	import Choices from "../parts/Choices.svelte";
	import InlineText from "../parts/InlineText.svelte";
	import Markdown from "../parts/Markdown.svelte";
	import MockupSection from "../parts/MockupSection.svelte";
	import NeighbourSections from "../parts/NeighbourSections.svelte";
	import StepButton from "../parts/StepButton.svelte";
	import StepDetail from "../parts/StepDetail.svelte";

	/** The document is authored as decisions and outcomes; the map only visualizes them. */
	const ws = $derived(st());
	const doc = $derived(ws.document);
	const flow = $derived(ws.flow!);
	const block = $derived(selectedBlock(ws));
	const project = $derived(flow.projectActions.filter(action => ["change", "replan", "prune", "execute"].includes(action.kind)));
	const linked = $derived.by(() => {
		const diagram = currentDiagram(ws);
		return !!block && !!diagram?.edges.some(edge => edge.from === block.id || edge.to === block.id);
	});
	/** Anchors whose syntax the reader asked to see. */
	let inspected = $state<Record<string, true>>({});
	const patch = (fields: Record<string, unknown>) => op({ op: "patchBlock", id: block!.id, fields });
</script>

<!-- Nothing to work on yet: the start panel is the whole page. -->
{#if doc && doc.root.blocks.length > 0}
	<div class="content">
		{#if !block}
			<div class="label">{doc.purpose} · overview</div>
			<h1>{doc.title}</h1>
			<p class="subtle">{doc.goal || "No goal written yet. Rename and describe the document in the top bar."}</p>
			<p class="subtle">{flow.progress}</p>
			<div class="actions">
				<StepButton block={null} />
				{#each project as action (action.kind)}
					{#if action.kind === "change"}
						<button title="A new plan for a change to this codebase; the agent reads the code first" onclick={() => openTextDialog(CHANGE_DIALOG, goal => startProject("change", goal))}>{action.label}…</button>
					{:else}
						<button title="Previews the request first" onclick={() => openPreview(action.kind)}>{action.label}…</button>
					{/if}
				{/each}
				<button onclick={() => op({ op: "addBlock" })}>+ block</button>
			</div>
			<StepDetail />
			<NeighbourSections block={null} emptyText="Nothing here yet. Add the first block." />
		{:else}
			<div class="label crumbline">
				{#each ws.breadcrumb as crumb, index (crumb.diagramId)}
					{@const owner = index === 0 ? null : ownerOfDiagram(doc, crumb.diagramId)}
					{#if index > 0}{" › "}{/if}<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_missing_attribute -->
					<a title={index === 0 ? "Overview" : "Open this block"} onclick={() => focus(owner ? owner.id : null)}>{crumb.title}</a>
				{/each}
			</div>
			<h1><InlineText value={block.title} placeholder="Block title" commit={value => value.trim() && patch({ title: value.trim() })} /></h1>
			{#if flow.status}
				<div class="status" role="group" aria-label="status">
					{#each flow.status.cycle as status (status)}
						<button class={block.status === status ? "active" : ""} title="space steps the status" onclick={() => op({ op: "setStatus", id: block.id, status })}>
							{flow.status.glyphs[status]} {flow.status.labels[status]}
						</button>
					{/each}
				</div>
			{/if}
			<section>
				<div class="fields">
					{#each flow.fields.filter(entry => !["title", "sources", "enhance", "execute"].includes(entry.field)) as { field, label } (field)}
						<div class={field === "description" ? "wide" : ""}>
							<div class="label">{label}</div>
							{#if field === "description"}
								{#if block.description.trim() && app.editBodyOf !== block.id}
									<Markdown text={block.description} onclick={() => (app.editBodyOf = block.id)} />
								{:else}
									<InlineText
										value={block.description}
										placeholder={"What is this building block for? Markdown works, ``` for code."}
										commit={value => patch({ description: value })}
										onDone={() => (app.editBodyOf = null)}
										autofocus={app.editBodyOf === block.id}
									/>
								{/if}
							{:else if field === "criteria"}
								<Checklist items={block.acceptanceCriteria} placeholder="How you will know it is done" commit={value => patch({ acceptanceCriteria: value })} />
							{:else if field === "venue"}
								<Choices values={["here", "subagent", "worktree"]} current={block.venue ?? "here"} onPick={value => patch({ venue: value })} />
							{:else if field === "surface"}
								<Choices values={["none", "page", "component"]} current={block.surface ?? "none"} onPick={value => patch({ surface: value })} />
							{:else if field === "evidence"}
								<Choices values={["unknown", "inferred", "observed"]} current={block.evidence} onPick={value => patch({ evidence: value })} />
							{:else if field === "expectedOutput"}
								<InlineText value={block.expectedOutput} placeholder="What does it produce?" commit={value => patch({ expectedOutput: value })} />
							{/if}
						</div>
					{/each}
				</div>
			</section>
			<MockupSection {block} />
			<ActionRow {block} structure={true} />
			<StepDetail />
			<NeighbourSections {block} emptyText="" />
			{#if !linked}
				<section>
					<div class="section-head">Linked · 0</div>
					<p class="subtle">None yet. Draw a link on the Map when one block needs another's output.</p>
				</section>
			{/if}
			{#if block.sources.length}
				<section class="sources">
					<div class="section-head">Code evidence · {block.sources.length}</div>
					{#each block.sources as source, index (index)}
						{@const line = source.startLine || 1}
						{@const key = `${source.path}:${line}`}
						{@const check = citationCheck(ws, block.id, index, source)}
						{@const insight = inspected[key] ? insightFor(source.path, line) : undefined}
						<div class="srcrow">
							<button class="path" title="Open in the file viewer" onclick={() => openFile(source.path, source.startLine)}>{rangeText(source)}</button>
							<button
								class="ghost"
								title="Tree-sitter range and node kinds; no language server"
								onclick={() => {
									inspected[key] = true;
									insightFor(source.path, line, true);
								}}>inspect syntax</button
							>
							{#if check}<span class="drift-state" title={check.reason ?? ""}>{check.state}</span>{/if}
							{#if check?.state === "changed"}
								<button class="ghost" title="The code changed but this block still describes it: take the new lines as its fingerprint" onclick={() => op({ op: "stillTrue", id: block.id, index })}>Still true</button>
							{/if}
						</div>
						{#if insight}
							<div class="insight">{insight.error ?? insight.summary ?? insight.limitation}</div>
						{/if}
					{/each}
				</section>
			{/if}
		{/if}
	</div>
{/if}
