<script lang="ts">
	import { app } from "../app.svelte.ts";
	const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
</script>

<span class="spin">{SPIN[Math.floor(app.now / 100) % SPIN.length]}</span>
