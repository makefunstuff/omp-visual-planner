<script lang="ts">
	let { values, current, onPick }: { values: readonly string[]; current: string; onPick: (value: string) => void } = $props();
</script>

<div class="seg" role="group">
	{#each values as value (value)}
		<button type="button" class={value === current ? "on" : ""} onclick={() => value !== current && onPick(value)}>{value}</button>
	{/each}
</div>
