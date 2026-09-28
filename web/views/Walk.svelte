<script lang="ts">
	import type { Block } from "../../src/model.ts";
	import type { FocusLink } from "../../src/focus.ts";
	import { app, cursorNow, focus, focusLists, op, openFile, st, uncited } from "../app.svelte.ts";
	import { citationOf, selectedBlock } from "../doc.ts";
	import ActionRow from "../parts/ActionRow.svelte";
	import Choices from "../parts/Choices.svelte";
	import InlineText from "../parts/InlineText.svelte";
	import Markdown from "../parts/Markdown.svelte";
	import MockupSection from "../parts/MockupSection.svelte";
	import StepButton from "../parts/StepButton.svelte";
	import StepDetail from "../parts/StepDetail.svelte";

	/** The walk: the focused block as a readable card, its graph drawn around it. */
	const ws = $derived(st());
	const doc = $derived(ws.document!);
	const flow = $derived(ws.flow!);
	const block = $derived(selectedBlock(ws));
	const hood = $derived(focusLists());
	const cursor = $derived(cursorNow(hood));
	const patch = (fields: Record<string, unknown>) => op({ op: "patchBlock", id: block!.id, fields });
	let dump = $state("");
</script>

{#snippet node(target: Block, isCursor: boolean)}
	{@const cite = doc.purpose === "explore" ? citationOf(target) : ""}
	<button
		class="f-node{uncited(target) ? ' dim' : ''}{isCursor ? ' cursor' : ''}"
		title={flow.status?.labels[target.status]}
		onclick={() => focus(target.id)}
	>
		{#if flow.status}<span class="glyph">{flow.status.glyphs[target.status]}</span>{/if}
		<span class="name">{target.title || "(untitled)"}</span>
		{#if cite}<span class="cite">{cite}</span>{/if}
	</button>
{/snippet}

{#snippet wire(link: FocusLink, arrow: string)}
	<span class="f-wire {link.direction}{link.kind === 'uses' ? ' uses' : ''}"><span class="f-label">{link.label}</span><span class="f-dir">{arrow}</span></span>
{/snippet}

<div class="walk">
	<div class="walk-head">
		<div class="label">{doc.purpose} · walk</div>
		{#if doc.purpose === "explore"}
			<button class={app.grounded ? "primary" : ""} title="g: hide blocks without a citation" onclick={() => (app.grounded = !app.grounded)}>
				{app.grounded ? "grounded" : "all claims"}
			</button>
		{/if}
	</div>
	<div class="focus">
		{#if block}
			<!-- Up: the parent block, or the document it sits in. -->
			<div class="f-up">
				{#if hood.parent}{@render node(hood.parent, cursor.slot === "up")}{:else}<button class="top" title="Overview" onclick={() => focus(null)}>{doc.title}</button>{/if}
				<div class="f-vwire"></div>
			</div>
		{/if}
		<!-- In: what this block reads from. -->
		<div class="f-in">
			{#each hood.inputs as link, index (index)}
				<div class="f-item">{@render node(link.block, cursor.slot === "in" && cursor.index === index)}{@render wire(link, "←")}</div>
			{/each}
		</div>
		<div class="f-card{cursor.slot === 'center' ? ' cursor' : ''}">
			{#if !block}
				<h1>{doc.title}</h1>
				{#if doc.goal}<p class="note">{doc.goal}</p>{/if}
				<div class="actions"><StepButton block={null} /></div>
				<StepDetail />
			{:else}
				{@const cite = citationOf(block)}
				<h1><InlineText value={block.title} placeholder="Name this idea" commit={value => value.trim() && patch({ title: value.trim() })} /></h1>
				{#if flow.status}<span class="f-status">{flow.status.glyphs[block.status]} {flow.status.labels[block.status]}</span>{/if}
				{#if flow.fields.some(entry => entry.field === "surface")}
					<Choices values={["none", "page", "component"]} current={block.surface ?? "none"} onPick={value => patch({ surface: value })} />
				{/if}
				{#if cite}
					<button class="cite" title="Open the cited range" onclick={() => openFile(block.sources[0]!.path, block.sources[0]!.startLine)}>{cite}</button>
				{:else if doc.purpose === "explore"}
					<p class="uncited">not cited · {block.evidence}</p>
				{/if}
				{#if block.description.trim() && app.editBodyOf !== block.id}
					<Markdown text={block.description} onclick={() => (app.editBodyOf = block.id)} />
				{:else}
					<InlineText
						value={block.description}
						placeholder={doc.purpose === "brainstorm" ? "One line about it" : "Notes"}
						commit={value => patch({ description: value })}
						onDone={() => (app.editBodyOf = null)}
						autofocus={app.editBodyOf === block.id}
					/>
				{/if}
				<MockupSection {block} />
				<ActionRow {block} structure={false} />
				<StepDetail />
			{/if}
		</div>
		<!-- Out: what this block feeds. -->
		<div class="f-out">
			{#each hood.outputs as link, index (index)}
				<div class="f-item">{@render wire(link, "→")}{@render node(link.block, cursor.slot === "out" && cursor.index === index)}</div>
			{/each}
		</div>
		<!-- Down: what is inside. -->
		<div class="f-down">
			{#if block}<div class="f-vwire"></div>{/if}
			<div class="f-kids-head">{block ? "Inside" : "Top level"} · {hood.children.length}</div>
			{#if hood.children.length}
				<div class="f-kids">
					{#each hood.children as child, index (child.id)}{@render node(child, cursor.slot === "down" && cursor.index === index)}{/each}
				</div>
			{:else}
				<p class="subtle">
					{doc.purpose === "brainstorm"
						? "Nothing inside yet. Dump a line below."
						: app.grounded
							? "Nothing cited inside. Turn grounded off to see the guesses."
							: "Nothing mapped inside yet."}
				</p>
			{/if}
			{#if doc.purpose === "brainstorm"}
				<input
					id="dump"
					class="dump"
					spellcheck="false"
					placeholder={block ? `Dump a line onto “${block.title || "this idea"}” and press Enter` : "Dump the first idea and press Enter"}
					bind:value={dump}
					onkeydown={event => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						const title = dump.trim();
						if (!title) return;
						dump = "";
						void op(block ? { op: "addBlock", parentId: block.id, title } : { op: "addBlock", title });
					}}
				/>
			{/if}
		</div>
	</div>
</div>
