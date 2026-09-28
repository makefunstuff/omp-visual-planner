<script lang="ts">
	/** A mockup drawn at 1280×800, scaled into a box; sandboxed: no scripts, no same-origin access. */
	let { html, width }: { html: string; width: number } = $props();
	const scale = $derived(width / 1280);
</script>

<div class="mockup-box" style="width:{width}px;height:{Math.round(800 * scale)}px">
	<iframe
		sandbox=""
		referrerpolicy="no-referrer"
		title="mockup"
		tabindex="-1"
		srcdoc={html}
		style="width:1280px;height:800px;border:0;transform:scale({scale});transform-origin:0 0;pointer-events:none"
	></iframe>
</div>
