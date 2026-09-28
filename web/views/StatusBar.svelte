<script lang="ts">
	import { app, keyHints, st } from "../app.svelte.ts";
	let { onKeys }: { onKeys: () => void } = $props();
</script>

<footer class="hud status" id="statusbar">
	<span class="message" class:error={!!app.message && app.messageIsError} class:note={!!app.message && !app.messageIsError} id="message">
		{#if app.message}{app.message}{:else}{#each keyHints() as [keys, what] (keys + what)}<span class="hint"><kbd>{keys}</kbd>{what}</span>{/each}{/if}
	</span>
	<button class="ghost" id="keysToggle" title="Keyboard shortcuts (?)" onclick={onKeys}><kbd>?</kbd>shortcuts</button>
	<span class="chip" id="session" title="The OMP session this page edits">session {st().sessionId.slice(0, 8)}</span>
</footer>
