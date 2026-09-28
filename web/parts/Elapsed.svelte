<script lang="ts">
	import { app } from "../app.svelte.ts";
	let { since }: { since: string } = $props();
	const seconds = $derived(Math.max(0, Math.floor((app.now - Date.parse(since)) / 1000)));
</script>

<span class="elapsed">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
