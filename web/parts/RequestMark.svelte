<script lang="ts">
	import type { WebState } from "../../src/web.ts";
	import Elapsed from "./Elapsed.svelte";
	import Spinner from "./Spinner.svelte";
	/** A block's request: working (spinner), stalled (the idle agent left no proposal), or ready to review. */
	let { request, clock = false }: { request: WebState["requests"][number]; clock?: boolean } = $props();
</script>

{#if request.state !== "pending"}
	<span class="mark" title="proposal ready to review">◆</span>
{:else if request.stalled}
	<span class="mark stalled" title="The agent finished without a proposal. Discard the request, or ask again.">!</span>
{:else}
	<span class="mark" title="the agent is working on this block"><Spinner />{#if clock}{" "}<Elapsed since={request.since} />{/if}</span>
{/if}
