<script lang="ts">
	import type { Block } from "../../src/model.ts";
	import { app, ask, op } from "../app.svelte.ts";
	import MockupFrame from "./MockupFrame.svelte";
	/** A block's mockup, with a full-size view and a way to remove it. */
	let { block }: { block: Block } = $props();
</script>

{#if block.mockup}
	{@const html = block.mockup}
	<section class="mockup">
		<div class="section-head">Mockup</div>
		<MockupFrame {html} width={640} />
		<div class="row">
			<button title="The mockup at up to 1280×800" onclick={() => (app.modal = { kind: "mockup", html })}>Full size</button>
			<button
				class="ghost danger"
				title="Only you remove a mockup; a proposal can only replace it"
				onclick={() =>
					ask("Remove this mockup? Sketch can draw it again.", "Remove", () => void op({ op: "patchBlock", id: block.id, fields: { mockup: "" } }))}>Remove</button
			>
		</div>
	</section>
{/if}
