<script lang="ts">
	import { app, closeModal, flash, focus, op, openBatchPreview, openDrift, openFile, openPreview, st, submitPreview } from "../app.svelte.ts";
	import { findBlock } from "../doc.ts";
	import InlineText from "../parts/InlineText.svelte";
	import MockupFrame from "../parts/MockupFrame.svelte";

	/** The one dialog slot: a question, a request preview, a text box, a mockup, the key sheet, drift, or a block picker. */
	const modal = $derived(app.modal!);
	const ws = $derived(st());
	let text = $state("");
	let filter = $state("");
	// A dialog opens empty.
	$effect.pre(() => {
		void app.modal;
		text = "";
		filter = "";
	});

	function focusOnMount(node: HTMLElement) {
		requestAnimationFrame(() => node.focus());
	}

	const keyGroups = $derived<[string, [string, string][]][]>([
		["Move", [["j / k", "next / previous block"], ["← ↑ → ↓", "walk the focus diagram (brainstorm, explore)"], ["Enter", "go to the highlighted block"], ["n", "next open block"], ["Esc", "back out: block → overview"], ["v", "switch page ⇄ map"], ["S", "screens: every page and component"], ["/", "find a file"]]],
		["Edit", [["space", "step the status"], ["o / O", "add a block after / inside"], ["U", "uses: link to a reusable block anywhere"], ["M", "extract: move up a level to share it"], ["⌫", "delete the focused block"], ["⌘Z / ⇧⌘Z", "undo / redo"], ["⌘S", "save"], ["g", "grounded: hide uncited blocks (explore)"]]],
		["Ask the agent", [...(ws.flow?.verbs ?? []).map((verb): [string, string] => [verb.key, `${verb.label} the focused block (previewed first)`]), ["m", "mark / unmark for a parallel batch"], ["⇧-click", "mark a row in the outline"], ["Enter", "submit an open preview"], ["D", "check drift: cited code vs the diagram"]]],
		["Map", [["drag", "move a block, or pan"], ["dbl-click", "add a block there"], ["Enter", "go inside the focused block"], ["F2", "rename"], ["F / T", "fit / tidy"]]],
	]);

	/** The block a preview's standing note belongs to, and which of its notes steers this verb. */
	function noteFor(preview: { verb: string; id?: string; batch?: boolean }) {
		const field: "enhance" | "execute" | null = preview.batch ? null : preview.verb === "refine" ? "enhance" : preview.verb === "execute" ? "execute" : null;
		const spec = field ? ws.flow?.fields.find(entry => entry.field === field) : undefined;
		const block = findBlock(ws.document, preview.id);
		return field && spec && block ? { field, label: spec.label, block } : null;
	}

	function copy(value: string): void {
		navigator.clipboard.writeText(value).then(
			() => flash("copied the request", false),
			() => flash("the browser refused the clipboard", true),
		);
	}
</script>

<div class="modal-back" id="modal">
	{#if modal.kind === "confirm"}
		<div class="modal" role="dialog" aria-label={modal.text}>
			<h3>{modal.text}</h3>
			<div class="row">
				<button
					class="primary"
					onclick={() => {
						// `modal` follows app.modal: take the answer before the dialog underneath returns.
						const { back, onYes } = modal;
						app.modal = back;
						onYes();
					}}>{modal.yes}</button
				>
				<button onclick={() => (app.modal = modal.back)}>Cancel</button>
			</div>
		</div>
	{:else if modal.kind === "preview"}
		{@const preview = modal.preview}
		{@const note = noteFor(preview)}
		<div class="modal" role="dialog" aria-label="request preview">
			<h3>Preview — {preview.label} ({preview.size} chars)</h3>
			{#if preview.related}<p class="subtle">{preview.related}</p>{/if}
			{#if note}
				<!-- The block's standing note for this verb lives here, next to the request it steers. -->
				<div class="note">
					<InlineText
						value={note.block.actions[note.field]}
						placeholder="{note.label} for the agent (kept on the block)…"
						commit={async value => {
							await op({ op: "patchBlock", id: note.block.id, fields: { [note.field]: value } });
							void openPreview(preview.verb, preview.id);
						}}
					/>
				</div>
			{/if}
			<pre>{preview.text}</pre>
			<div class="row">
				<button class="primary" title="Enter" onclick={() => submitPreview(preview)}>Submit</button>
				<button title="Copy the request, to paste it somewhere else instead" onclick={() => copy(preview.text)}>Copy</button>
				<button title="Esc" onclick={closeModal}>Cancel</button>
				<span class="hint">
					{preview.batch
						? "Submit sends this to the OMP session, which runs one subagent per block. Each proposal comes back here for review."
						: "Submit sends this to the OMP session. Its proposal comes back here for review."}
				</span>
			</div>
		</div>
	{:else if modal.kind === "text"}
		<div class="modal" role="dialog" aria-label={modal.title}>
			<h3>{modal.title}</h3>
			<textarea rows="4" placeholder={modal.placeholder} spellcheck="false" style="min-height:6em;overflow:auto" bind:value={text} use:focusOnMount></textarea>
			<div class="row">
				<button
					class="primary"
					disabled={!text.trim()}
					onclick={() => {
						const value = text.trim();
						if (!value) return;
						const submit = modal.onSubmit;
						text = "";
						closeModal();
						submit(value);
					}}>Submit</button
				>
				<button onclick={closeModal}>Cancel</button>
				<span class="hint">{modal.hint}</span>
			</div>
		</div>
	{:else if modal.kind === "mockup"}
		<div class="modal" role="dialog" aria-label="mockup" style="width:auto;max-width:none">
			<MockupFrame html={modal.html} width={Math.min(1280, Math.floor(innerWidth * 0.9), Math.floor((innerHeight - 140) * 1.6))} />
			<div class="row">
				<button class="primary" onclick={closeModal}>Close</button>
				<span class="hint">Esc closes · sandboxed: no scripts, no network</span>
			</div>
		</div>
	{:else if modal.kind === "keys"}
		<div class="modal" role="dialog" aria-label="keyboard shortcuts">
			<h3>Keyboard shortcuts</h3>
			<div class="keys">
				{#each keyGroups as [title, rows] (title)}
					<div>
						<h4>{title}</h4>
						{#each rows as [keys, what] (keys + what)}<div class="key"><span class="k"><kbd>{keys}</kbd></span><span>{what}</span></div>{/each}
					</div>
				{/each}
			</div>
			<div class="row"><button class="primary" onclick={closeModal}>Close</button><span class="hint">? toggles this sheet</span></div>
		</div>
	{:else if modal.kind === "drift" && ws.drift}
		{@const d = ws.drift}
		{@const c = d.counts}
		<div class="modal drift-panel" role="dialog" aria-label="drift">
			<h3>Drift — checked {new Date(d.checkedAt).toLocaleTimeString()}</h3>
			{#if d.stale}<p class="hint">The document changed since this check — check again.</p>{/if}
			<p class="subtle">
				{c.changed} changed · {c.missing} missing · {c.moved} moved · {c.unstamped} without a baseline · {c.unchecked} unchecked · {d.uncovered.ok
					? `${d.uncovered.files.length}${d.uncovered.truncated ? "+" : ""}`
					: "?"} uncited changes
			</p>
			<div class="row">
				{#if c.moved}<button title="Point each moved citation at where its lines are now" onclick={() => op({ op: "reanchor" })}>Re-anchor {c.moved} moved</button>{/if}
				{#if d.syncTargets.length}
					<button
						class="primary"
						title="One request per drifted block; each proposal is reviewed on its own"
						onclick={() => {
							const targets = d.syncTargets;
							closeModal();
							if (targets.length === 1) void openPreview("sync", targets[0]);
							else void openBatchPreview("sync", targets);
						}}>Sync…</button
					>
				{/if}
				<button title="Fingerprint citations that have none; uncited changes restart from now" onclick={() => op({ op: "recordBaseline" })}>Record baseline</button>
				<button onclick={openDrift}>Check again</button>
				<button title="Esc" onclick={closeModal}>Close</button>
			</div>
			<div class="rows">
				{#each d.citations as check, index (index)}
					<div class="cite">
						<button
							class="ghost"
							title="Go to this block"
							onclick={() => {
								closeModal();
								app.surface = "page";
								void focus(check.blockId, true);
							}}>{check.title}</button
						>
						<span class="path">{check.source.path}{check.source.startLine ? `:${check.source.startLine}-${check.source.endLine || check.source.startLine}` : ""}</span>
						<span class="drift-state">{check.state}{check.reason ? `: ${check.reason}` : ""}{check.movedTo ? `; now at ${check.movedTo.startLine}-${check.movedTo.endLine}` : ""}</span>
						{#if check.state === "changed"}<button onclick={() => op({ op: "stillTrue", id: check.blockId, index: check.index })}>Still true</button>{/if}
					</div>
				{/each}
				{#if d.uncovered.ok}
					{#each d.uncovered.files as file (file)}
						<div class="cite">
							<button
								class="ghost"
								title="Open it; no block cites it"
								onclick={() => {
									closeModal();
									void openFile(file);
								}}>+ {file}</button
							>
							<span class="path">no block cites it</span>
						</div>
					{/each}
				{:else}
					<div class="cite"><span class="path">uncited changes: {d.uncovered.reason}</span></div>
				{/if}
			</div>
		</div>
	{:else if modal.kind === "uses"}
		{@const block = findBlock(ws.document, modal.id)}
		{@const needle = filter.trim().toLowerCase()}
		{@const rows = (ws.flow?.useCandidates ?? []).filter(candidate => candidate.title.toLowerCase().includes(needle))}
		{@const toggle = (candidate: { id: string; used: boolean }) => op({ op: candidate.used ? "removeUse" : "addUse", id: modal.id, target: candidate.id })}
		<div class="modal picker" role="dialog" aria-label="uses">
			<h3>“{block?.title || "this block"}” uses</h3>
			<input
				type="text"
				placeholder="filter blocks"
				bind:value={filter}
				use:focusOnMount
				onkeydown={event => {
					if (event.key !== "Enter") return;
					event.preventDefault();
					if (rows[0]) void toggle(rows[0]);
				}}
			/>
			{#if rows.length}
				<div class="rows">
					{#each rows as candidate (candidate.id)}
						<button class={candidate.used ? "on" : ""} style="padding-left:{6 + candidate.depth * 16}px" onclick={() => toggle(candidate)}>
							{candidate.used ? "✓ " : "  "}{candidate.title || "(untitled)"}
						</button>
					{/each}
				</div>
			{:else}
				<p class="subtle">No block matches.</p>
			{/if}
			<div class="row">
				<button class="primary" onclick={closeModal}>Done</button>
				<span class="hint">Click or Enter to use a block; click a ✓ block to stop using it.</span>
			</div>
		</div>
	{:else if modal.kind === "extract"}
		{@const block = findBlock(ws.document, modal.id)}
		<div class="modal picker" role="dialog" aria-label="extract">
			<h3>Extract “{block?.title || "this block"}” to a shared level</h3>
			<p class="subtle">It keeps its id, status and everything inside it. The block that held it will use it; its links to former siblings become uses.</p>
			<div class="rows">
				{#each ws.flow?.extractTargets ?? [] as target (target.diagramId)}
					<button
						onclick={() => {
							const id = modal.id;
							closeModal();
							void op({ op: "extract", id, diagramId: target.diagramId });
						}}>{target.label}</button
					>
				{/each}
			</div>
			<div class="row"><button onclick={closeModal}>Cancel</button></div>
		</div>
	{/if}
</div>
