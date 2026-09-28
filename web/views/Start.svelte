<script lang="ts">
	import { PURPOSES } from "../../src/model.ts";
	import { app, op, st, startProject } from "../app.svelte.ts";
	import Choices from "../parts/Choices.svelte";
	import Elapsed from "../parts/Elapsed.svelte";
	import Spinner from "../parts/Spinner.svelte";

	/** A document with nothing in it: create one, start one, or follow the agent drafting it. */
	const ws = $derived(st());
	const doc = $derived(ws.document);
	const pending = $derived(ws.requests.find(request => !request.blockId));
	const starts = $derived((ws.flow?.projectActions ?? []).filter(action => ["draft", "discover", "change"].includes(action.kind)));
	const working = $derived(
		pending?.kind === "draft" ? "The agent is drafting this plan" : pending?.kind === "change" ? "The agent is reading the code and planning the change" : "The agent is mapping the codebase",
	);
	let title = $state("");
	let about = $state("");
	const discard = (requestId: string) => op({ op: "discard", requestId });
</script>

<div class="start" id="start">
	{#if !doc}
		<h1>New document</h1>
		<input type="text" placeholder="title" bind:value={title} />
		<div class="row">
			<Choices values={PURPOSES} current={app.newPurpose} onPick={value => (app.newPurpose = value)} />
			<button class="primary" onclick={() => op({ op: "newDocument", title: title.trim() || undefined, purpose: app.newPurpose })}>Create</button>
		</div>
	{:else if doc.root.blocks.length === 0 && pending}
		<h1>{doc.title}</h1>
		{#if pending.state === "pending" && pending.stalled}
			<div class="hint stalled">The agent finished without a proposal. Discard the request, or ask again.</div>
			<div class="row"><button class="ghost" title="Stop waiting; a late proposal for it will be refused" onclick={() => discard(pending.requestId)}>discard</button></div>
		{:else if pending.state === "pending"}
			<div class="working"><Spinner /><span>{working}</span><Elapsed since={pending.since} /></div>
			<div class="hint">Follow it in the terminal. Its proposal appears here for review when it is done.</div>
			<div class="row"><button class="ghost" title="Stop waiting; a late proposal for it will be refused" onclick={() => discard(pending.requestId)}>discard</button></div>
		{:else}
			<div class="hint">The proposal is ready — review it bottom right.</div>
		{/if}
	{:else if doc.root.blocks.length === 0}
		<h1>{doc.title}</h1>
		<input type="text" placeholder="what is this about? (or a path to map)" bind:value={about} />
		<!-- An empty document can only be started: replan, prune and execute need blocks. -->
		<div class="row">
			{#each starts as action (action.kind)}
				<button class={action.kind === "draft" ? "primary" : ""} onclick={() => startProject(action.kind, about)}>{action.label}</button>
			{/each}
			<button onclick={() => op({ op: "addBlock" })}>+ first block</button>
		</div>
		<div class="hint">Start with the outcome you want, then work on one block at a time.</div>
	{:else}
		<div class="hint" style="pointer-events:none">Nothing inside yet — add a child block or return to the project.</div>
	{/if}
</div>
