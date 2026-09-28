<script lang="ts">
	import { tick } from "svelte";
	/** Acceptance as a checklist: one "[ ]" line per criterion, Enter adds the next, empty lines drop out. */
	let { items, placeholder, commit }: { items: string[]; placeholder: string; commit: (value: string) => void } = $props();
	let box: HTMLDivElement;
	let editing = false;
	let serial = 0;
	let lines = $state<{ id: number; text: string }[]>([]);
	$effect.pre(() => {
		if (!editing) lines = (items.length ? items : [""]).map(text => ({ id: serial++, text }));
	});
	async function focusLine(index: number): Promise<void> {
		await tick();
		box.querySelectorAll("textarea")[index]?.focus();
	}
	function fit(node: HTMLTextAreaElement) {
		const run = (): void => {
			node.style.height = "auto";
			node.style.height = `${node.scrollHeight}px`;
		};
		requestAnimationFrame(run);
		node.addEventListener("input", run);
		return { destroy: () => node.removeEventListener("input", run) };
	}
</script>

<div
	bind:this={box}
	onfocusin={() => (editing = true)}
	onfocusout={event => {
		if (box.contains(event.relatedTarget as Node | null)) return;
		editing = false;
		const next = lines.map(line => line.text.trim()).filter(Boolean);
		if (next.join("\n") !== items.join("\n")) commit(next.join("\n"));
	}}
>
	{#each lines as line, index (line.id)}
		<div class="line">
			<span class="lead">[ ]</span>
			<textarea
				class="text"
				rows="1"
				{placeholder}
				spellcheck="false"
				use:fit
				bind:value={line.text}
				onkeydown={event => {
					if (event.key === "Enter") {
						event.preventDefault();
						lines.splice(index + 1, 0, { id: serial++, text: "" });
						void focusLine(index + 1);
					}
					if (event.key === "Backspace" && line.text === "" && lines.length > 1) {
						event.preventDefault();
						lines.splice(index, 1);
						void focusLine(Math.max(0, index - 1));
					}
				}}
			></textarea>
		</div>
	{/each}
</div>
