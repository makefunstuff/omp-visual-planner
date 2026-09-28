<script lang="ts">
	import { app, op, st } from "../app.svelte.ts";
	import MockupFrame from "../parts/MockupFrame.svelte";

	/** The one human gate, one proposal at a time: every changed field before and after, then added, removed and relinked blocks. */
	const ws = $derived(st());
	const reviews = $derived(ws.reviews);
	const index = $derived(Math.min(app.reviewIndex, Math.max(0, reviews.length - 1)));
	const review = $derived(reviews[index]!);
	const diff = $derived(review.diff);
	const empty = $derived(
		!diff.titleChanged && !diff.goalChanged && !diff.added.length && !diff.removed.length && !diff.modified.length && !diff.edgesAdded.length && !diff.edgesRemoved.length && !diff.edgesModified.length,
	);
	const links = $derived([
		...diff.edgesAdded.map(text => ["ins", text]),
		...diff.edgesRemoved.map(text => ["del", text]),
		...diff.edgesModified.map(text => ["same", `changed: ${text}`]),
	]);

	/** Diff field names mapped to the words this document's purpose uses on the page. */
	function changeLabel(field: string): string {
		const pageField = field === "acceptanceCriteria" ? "criteria" : field;
		const spec = ws.flow?.fields.find(entry => entry.field === pageField);
		return spec ? spec.label : ({ actions: "agent notes", position: "position on the map" } as Record<string, string>)[field] ?? field;
	}
	function whereText(path: string): string {
		return path === "root" ? "" : `in ${path.replace(/^root > /, "").split(" > ").join(" › ")}`;
	}
	/** Before and after as lines: removed lines, added lines, and a count of what stayed. */
	function changeLines(from: string, to: string): [string, string][] {
		const before = from.split("\n").filter(line => line.trim());
		const after = to.split("\n").filter(line => line.trim());
		const out: [string, string][] = [];
		if (!before.length) out.push(["same", "was empty"]);
		for (const line of before.filter(line => !after.includes(line))) out.push(["del", line]);
		for (const line of after.filter(line => !before.includes(line))) out.push(["ins", line]);
		const kept = after.filter(line => before.includes(line)).length;
		if (kept) out.push(["same", `${kept} unchanged`]);
		if (!after.length) out.push(["same", "now empty"]);
		return out;
	}
</script>

{#snippet lines(from: string, to: string)}
	{#each changeLines(from, to) as [kind, text], lineIndex (lineIndex)}<div class="diffline {kind}">{text}</div>{/each}
{/snippet}

<section class="review" id="review">
	<header>
		<div class="label">Proposal to review</div>
		{#if reviews.length > 1}
			<div class="queue">
				<button class="ghost" title="Previous proposal" disabled={index === 0} onclick={() => (app.reviewIndex = index - 1)}>‹</button>
				<span>Proposal {index + 1} of {reviews.length}</span>
				<button class="ghost" title="Next proposal" disabled={index === reviews.length - 1} onclick={() => (app.reviewIndex = index + 1)}>›</button>
			</div>
		{/if}
		<h3>{review.label}</h3>
		{#if review.summary}<div class="summary">{review.summary}</div>{/if}
	</header>
	<div class="body">
		{#if review.error}
			<p class="error">{review.error}</p>
		{:else}
			{#if empty}<p class="subtle">No change: the proposal matches the document.</p>{/if}
			{#if diff.titleChanged || diff.goalChanged}
				<h4>Document</h4>
				{#if diff.titleChanged}<div class="field"><div class="name">title</div>{@render lines(diff.titleChanged.from, diff.titleChanged.to)}</div>{/if}
				{#if diff.goalChanged}<div class="field"><div class="name">goal</div>{@render lines(diff.goalChanged.from, diff.goalChanged.to)}</div>{/if}
			{/if}
			{#each diff.modified as entry, entryIndex (entryIndex)}
				<h4>~ {entry.title} <span class="where">{whereText(entry.path)}</span></h4>
				{#each entry.changes as change, changeIndex (changeIndex)}
					<div class="field">
						<div class="name">{changeLabel(change.field)}</div>
						{#if change.field === "mockup"}
							<div class="mockup-diff">
								<div class="side"><div class="name">before</div>{#if change.from}<MockupFrame html={change.from} width={300} />{:else}<div class="diffline same">was empty</div>{/if}</div>
								<div class="side"><div class="name">after</div><MockupFrame html={change.to} width={300} /></div>
							</div>
						{:else}
							{@render lines(change.from, change.to)}
						{/if}
					</div>
				{/each}
			{/each}
			{#if diff.added.length}
				<h4>Added · {diff.added.length}</h4>
				{#each diff.added as entry, addedIndex (addedIndex)}<div class="diffline ins">{entry.title}{entry.surface ? ` [${entry.surface}]` : ""} <span class="where">{whereText(entry.path)}</span></div>{/each}
			{/if}
			{#if diff.removed.length}
				<h4>Removed · {diff.removed.length}</h4>
				{#each diff.removed as entry, removedIndex (removedIndex)}<div class="diffline del">{entry.title} <span class="where">{whereText(entry.path)}</span></div>{/each}
			{/if}
			{#if links.length}
				<h4>Links</h4>
				{#each links as [kind, text], linkIndex (linkIndex)}<div class="diffline {kind}">{text}</div>{/each}
			{/if}
		{/if}
	</div>
	<footer>
		{#if !review.error}<button class="primary" title="Apply it as one undoable edit" onclick={() => op({ op: "accept", requestId: review.requestId })}>Accept</button>{/if}
		<button class="danger" title="Leave the document as it is" onclick={() => op({ op: "reject", requestId: review.requestId })}>Reject</button>
		<span class="hint">{review.error ? "" : "Accepting is undoable and stays unsaved until Save."}</span>
	</footer>
</section>
