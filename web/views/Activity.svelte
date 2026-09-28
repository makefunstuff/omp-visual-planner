<script lang="ts">
	import { app, op, st } from "../app.svelte.ts";
	import Elapsed from "../parts/Elapsed.svelte";
	import Spinner from "../parts/Spinner.svelte";

	/** The HUD's one line of progress: a click in flight, else the agent's requests and how long they have run. */
	const requests = $derived(st().requests);
	// A pending request is only "working" while the agent runs a turn; one it left without a proposal is stalled.
	const pending = $derived(requests.filter(request => request.state === "pending" && !request.stalled));
	const stalled = $derived(requests.filter(request => request.state === "pending" && request.stalled));
	const staged = $derived(requests.filter(request => request.state === "staged").length);
	const discard = async (list: { requestId: string }[]) => {
		for (const request of list) await op({ op: "discard", requestId: request.requestId });
	};
</script>

{#snippet discardButton(list: { requestId: string }[])}
	{#if list.length === 1}
		<button class="ghost" title="Stop waiting; a late proposal for it will be refused" onclick={() => discard(list)}>discard</button>
	{:else}
		<button class="ghost" title="Stop waiting; late proposals for them will be refused" onclick={() => discard(list)}>discard all</button>
	{/if}
{/snippet}

{#if app.inFlight > 0 || pending.length || stalled.length || staged}
	<span class="activity" id="activity">
		{#if app.inFlight > 0}
			<Spinner /><span class="what">{app.inFlightWord}…</span>
		{:else if pending.length}
			<Spinner />
			<span class="what" title={pending.map(request => request.label).join("\n")}>agent working: {pending.length === 1 ? pending[0]!.label : `${pending.length} requests`}</span>
			<Elapsed since={pending[0]!.since} />
			{@render discardButton(pending)}
		{:else if stalled.length}
			<span class="what stalled" title={stalled.map(request => request.label).join("\n")}>! {stalled.length === 1 ? stalled[0]!.label : `${stalled.length} requests`} — agent finished without a proposal</span>
			{@render discardButton(stalled)}
		{:else}
			<span class="what">◆ {staged} {staged === 1 ? "proposal" : "proposals"} ready to review</span>
		{/if}
	</span>
{/if}
