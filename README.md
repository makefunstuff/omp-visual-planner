# omp-visual-planner

An OMP extension for visual architecture work: nested blocks you can navigate,
annotate, and turn into scoped prompts — for planning a system you have not
built yet, and for mapping one you have not read.

It is not a second agent harness. The extension owns the diagram and the
proposal protocol; OMP owns the model, the tools, and the permissions. A
diagram never changes because a model said so: a model can only *stage* a
proposal, and a human accepts or rejects it inside the overlay.

The `diatui` ratatui prototype this grew out of is gone — its board format is
still imported (`demo.json` shows one).

## Demo

![omp-visual-planner: new project, existing codebase, deep nesting](docs/demo.gif)

One recorded session, three scenarios: a **new project** (blocks, an observed
source reference, a labelled relationship with explicit ports), an **existing
codebase** (`/diagram discover` — the agent reads the files, stages `observed`
blocks that cite real line ranges, and the human accepts the proposal), and a
design **nested four levels deep**.

- `docs/demo.mp4` — same recording, full quality
- `docs/demo.cast.gz` — the asciicast, replayable in any player
- `scripts/demo/` — the recorder that produced it

## Install

OMP installs extensions as **plugins**. One command, no global config editing:

```sh
# from a local checkout: link the working tree, edits picked up on reload
omp plugin link /path/to/omp-visual-planner     # alias: omp install <path>

# from npm or a marketplace ref, once this package is published
omp install omp-visual-planner                  # scope: user (default) or --scope project
```

`plugin link` symlinks the checkout into `~/.omp/plugins/node_modules/` and
records it in `~/.omp/plugins/omp-plugins.lock.json`; the extension is then
auto-discovered by every session. Verify and manage it with:

```sh
omp plugin list                 # ● omp-visual-planner@0.1.0
omp plugin doctor               # manifest, link target, enabled state
omp plugin uninstall omp-visual-planner
```

Inside a session, `/reload-plugins` re-reads every installed plugin without a
restart.

A project-scoped install (`--scope project`) is available for marketplace
installs only; from a checkout, use one of the file-based routes below instead.

### Other supported install routes

| scope | how | notes |
|---|---|---|
| user (official) | `omp plugin link <path>` / `omp install <path>` | auto-discovered, nothing else to configure |
| user (file) | `ln -s <path> ~/.omp/agent/extensions/omp-visual-planner` | directory manifests are read from `package.json#omp.extensions` |
| project | `<repo>/.omp/extensions/omp-visual-planner` (link or copy) | opt-in per project, native to that repo |
| explicit | `extensions:` list in `~/.omp/agent/config.yml` or `<repo>/.omp/config.yml` | a path to the checkout directory, resolved through `package.json#omp.extensions` |
| dev / no install | `omp --no-extensions -e <path>/src/index.ts` | explicit load; `--no-extensions` keeps ambient discovery off |

The plugin manifest is the `omp` key in `package.json`:

```json
{ "omp": { "extensions": ["./src/index.ts"] } }
```

### Then, in a session

| command | effect |
|---|---|
| `/diagram` | open the active document, or offer New if there is none |
| `/diagram new` | start a new document at `.omp-visual-planner/architecture.json` |
| `/diagram open <path>` | open a document (legacy boards import automatically) |
| `/diagram draft` | draft an architecture from a planning brief |
| `/diagram discover [path]` | map an existing codebase (default: cwd) |

The overlay is a full-screen terminal mode. The host owns the alternate screen
and restores the transcript, editor, and cursor focus when you leave.

## Keys

| key | action |
|---|---|
| `h/j/k/l`, arrows | select a block directionally |
| `Tab` / `Shift+Tab` | cycle blocks in the current diagram |
| `H/J/K/L` | move the selected block one cell |
| `Ctrl+arrows` | pan the canvas by four cells |
| `o` | add a block |
| `Enter` | descend into the selected block's subsystem |
| `Backspace` | ascend one level |
| `i` | focus the inspector (and back) |
| `a` | action menu: Draft, Discover, Enhance, Refresh, Investigate, Recommend, Execute |
| `p` | preview the composed prompt for this scope |
| `R` | review a staged proposal |
| `e` | link the selected block to another (arrows/Tab pick, `Enter` commits, `Esc` cancels) |
| `x` | list and edit the selected block's relationships |
| `d` | delete the selected block and its subtree |
| `u` / `Ctrl+R` | undo / redo |
| `s` | save (prompts for a path when the document has none) |
| `n` | select the next `unknown` block |
| `?` | help |
| `Esc` / `Ctrl+C` | close (with Save / Discard / Cancel when dirty) |

Inspector: `j`/`k` move between fields, `Enter` opens or edits the field, `o`
adds a source reference, `m` edits one, `d` removes one. `Enter` on a source
reference opens a read-only, line-numbered source pane inside the overlay.

## The four gestures

1. **Outline** — `o`, `H/J/K/L`, `Enter`, `Backspace`. Blocks nest without limit;
   `children` are the next level of the same subsystem.
2. **Compose** — `p` shows the exact payload for the current scope: authored
   descriptions, expected outputs, acceptance criteria, source references, and
   relationships that leave the scope. Copy it to the prompt editor (`c`) or
   export it (`w`) instead of submitting.
3. **Enhance / Investigate** — `a`. The model reads what it needs with its own
   tools and stages a proposal. You review a structural diff and accept or
   reject it. Rejecting leaves your document untouched; accepting is one
   undoable edit that stays unsaved until you press `s`.
4. **Execute** — `a` → Execute. The scope's composed prompt becomes one
   attributed OMP prompt; OMP decomposes the work and decides on subagents.
   Submission is reported as *submitted*, never as completed, and the diagram
   is not touched. An execution request carries no proposal token.

## Evidence, not vibes

Every block carries `evidence` and cards render it as a badge: `*` observed,
`?` unknown, nothing for inferred. A block claiming `observed` **must** cite at
least one `sources` entry, or the document is rejected naming the block — a
diagram can never look more certain than its evidence. Discovery prompts forbid
paths that were not read. `n` walks you to the next unknown block.

## Proposal protocol

Actions that expect a proposal compose a prompt containing a request token. The
model answers by calling `visual_planner_propose` once with:

```json
{ "requestId": "…", "baseRevision": 0, "summary": "…", "replacement": { } }
```

The tool validates the replacement's shape against the request's scope, checks
the document id, base revision, on-disk digest, and branch, and then *stages*
it. It cannot apply anything, and it takes no filesystem path. Unknown,
cancelled, reused, wrong-branch, and stale requests are refused with a reason.

Tools:

- `visual_planner_read({ scope? })` — active document or one scope, with
  revision, ids, and evidence.
- `visual_planner_propose({ requestId, baseRevision, summary, replacement })` —
  stage a proposal for review.

## Document format

`.omp-visual-planner/architecture.json`, schema version 1. Saving is explicit:
the writer refuses to overwrite a file that changed on disk since it was
loaded, and writes atomically through a sibling temporary file.

```json
{
  "schemaVersion": 1,
  "id": "…",
  "title": "Service",
  "goal": "ship auth",
  "revision": 3,
  "root": {
    "id": "…",
    "blocks": [
      {
        "id": "…",
        "title": "API",
        "description": "HTTP surface",
        "expectedOutput": "REST endpoints",
        "acceptanceCriteria": ["401 without a token"],
        "position": { "x": 2, "y": 2 },
        "sources": [{ "path": "src/app.ts", "startLine": 10, "endLine": 40 }],
        "evidence": "observed",
        "actions": { "enhance": "", "execute": "" },
        "children": null
      }
    ],
    "edges": [
      {
        "id": "…",
        "from": "…",
        "to": "…",
        "label": "stores",
        "direction": "forward",
        "routing": "auto",
        "fromPort": "east",
        "toPort": "west"
      }
    ]
  }
}
```

- IDs are UUIDs and stay stable when a block is moved or renamed.
- Nested containment is a tree; edges connect blocks within one diagram.
  Cycles and multiple labelled relationships are fine — arrows describe
  architecture, not an execution schedule. Self-edges are rejected.
- `actions.enhance` / `actions.execute` are instruction text for prompts. They
  are never executed as shell.
- Legacy `{ "boxes": [...], "edges": [...] }` boards import once, keeping the
  first text line as the title and the rest as the description; the legacy file
  is never overwritten.

## Development

```sh
bun install
bun test          # 114 tests
bun run check     # tsc --noEmit
```

`scripts/demo/` records the terminal demo: `ptydriver.py` spawns a real `omp`
in a PTY and writes an asciicast, `scenario_full.py` drives the three
scenarios, and `render.py` replays the cast through a small VT parser into PNG
frames plus an MP4 and a GIF.

```sh
python3 scripts/demo/scenario_full.py /tmp/demo.cast     # DEMO_CWD=/path/to/workspace
~/.venvs/demo-recorder/bin/python scripts/demo/render.py /tmp/demo.cast /tmp/demo-frames
```

Modules: `src/model.ts` (schema, validation, graph operations), `src/store.ts`
(project documents, digests, undo), `src/compose.ts` (scope prompts),
`src/actions.ts` (request/proposal lifecycle), `src/ui.ts` (canvas, inspector,
review), `src/index.ts` (commands, tools, session lifecycle).

Two constraints discovered by running inside OMP, both load-bearing:

- pi-tui can resolve to a second module graph for an extension, so only the
  package *root* is imported (`@oh-my-pi/pi-tui`). Helpers that live on subpaths
  and read pi-tui's module-level theme singleton (`chrome/overlay-box`,
  `render/code-cell`) are reimplemented locally against the theme the host
  hands the extension.
- the host paints only the topmost fullscreen overlay, and a host dialog moves
  focus to the composer underneath it. Every list, confirmation, and text field
  therefore lives inside the overlay, using the native `Editor` widget for text.
