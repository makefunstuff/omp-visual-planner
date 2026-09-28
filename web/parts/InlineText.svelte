<script lang="ts">
	/** Borderless, self-sizing text that commits when it loses focus; onDone runs first. */
	let {
		value,
		placeholder,
		commit,
		onDone,
		autofocus = false,
	}: { value: string; placeholder: string; commit: (value: string) => void; onDone?: () => void; autofocus?: boolean } = $props();
	let input: HTMLTextAreaElement;
	let focused = false;
	let draft = $state("");
	// The server's value wins until the reader starts typing.
	$effect.pre(() => {
		if (!focused) draft = value;
	});
	function fit(): void {
		input.style.height = "auto";
		input.style.height = `${input.scrollHeight}px`;
	}
	$effect(() => {
		void draft;
		fit();
	});
	$effect(() => {
		if (autofocus) input.focus();
	});
</script>

<textarea
	class="text"
	rows="1"
	{placeholder}
	spellcheck="false"
	bind:this={input}
	bind:value={draft}
	onfocus={() => (focused = true)}
	onkeydown={event => {
		if (event.key === "Escape") {
			draft = value;
			input.blur();
		}
	}}
	onblur={() => {
		focused = false;
		onDone?.();
		if (draft !== value) commit(draft);
	}}
></textarea>
