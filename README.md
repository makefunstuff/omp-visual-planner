# omp-visual-planner

An OMP extension for planning systems and mapping codebases as nested blocks. Work on one block at a time in a terminal or browser; use the map when relationships or layout matter. A model can stage a proposal, but only a person can accept it.

[![Discovery of omp-visual-planner](docs/visual-planner-demo.png)](docs/visual-planner-demo.mp4)

[36s demo](docs/visual-planner-demo.mp4). A live browser session: the discovery map of this repo, a cited block opened from the file tree, and the investigate preview before submit. The still above is the poster; the link is the recording.

## Install

From a checkout:

```sh
omp plugin link /path/to/omp-visual-planner
omp plugin doctor
```

The link is user-scoped and follows changes in the checkout. Run `/reload-plugins` in an open session after editing. For a project-only install, link or copy the checkout to `<repo>/.omp/extensions/omp-visual-planner`. To load it explicitly without installation:

```sh
omp --no-extensions -e /path/to/omp-visual-planner/src/index.ts
```

The package is private; the npm install route is not available yet.

## Try it without a model

From this checkout:

```sh
DEMO_DIR="$(mktemp -d)"
bun scripts/demo/fixture.ts "$DEMO_DIR"
omp --cwd "$DEMO_DIR" --no-extensions -e "$PWD/src/index.ts"
```

In OMP, run `/diagram open architecture.json`. Move through the outline with `j`/`k`, press `Enter` for a block page, then `Enter` on its source reference. Scroll with `j`/`k`, arrows, `PgUp`/`PgDn`, or `g`/`G`; `Esc` returns. `t` previews a block replan; `a` offers project replan and prune. **Esc cancels a preview; Enter submits its request to the model.** The generated directory is disposable.

## Commands

| Command | Action |
|---|---|
| `/diagram` | Open the current document or create one |
| `/diagram new [brainstorm\|plan\|explore]` | Create a document (default: plan) |
| `/diagram open <path>` | Open a document; legacy boards import automatically |
| `/diagram draft [brainstorm]` | Ask the model to draft a plan or mind map |
| `/diagram discover [path]` | Ask the model to map an existing codebase (default: cwd) |
| `/diagram web` / `/diagram web stop` | Open/stop the browser view of this session |

The terminal opens on a nested outline and the selected block's page. `space` advances its status; `n` selects the next open block. `r`, `b`, and `t` preview the purpose's refine/investigate, breakdown/map-inside, and replan actions; `R` reviews a staged proposal. `v` switches to the coordinate map, `E` edits a block as Markdown in `$VISUAL`/`$EDITOR`, and `s` saves. Press `?` for the full key list.

Brainstorm, and an explore block you have not settled, open on a **walk**: the focused block, what is inside it, and the blocks it connects to. Dump a line onto the focused idea (Enter in the browser, `O` in the terminal). In explore, a citation is the subtitle, uncited blocks are dim, and **grounded** (`g`) hides them. Mark a block explored to get the full page. Plan documents stay on that page. **Map** is coordinates. Both views share the session.

| Purpose | Block actions | Human status |
|---|---|---|
| brainstorm | Refine, Expand, Replan | none |
| plan | Refine, Break down, Replan, Execute | todo → planned → done |
| explore | Investigate, Map inside, Replan | unexplored → explored |

## Review and evidence

A proposal replaces a block, its nested diagram, or the project only after review. The exact request is previewed first; `c` copies it to the OMP prompt editor and `w` exports it instead of submitting. A model stages its response through `visual_planner_propose`; `R` opens a structural diff to accept or reject. Rejection leaves the document unchanged. Acceptance is one undoable, unsaved edit; press `s` to write it. Replan and prune must retain blocks already settled by the human under the same IDs. Execute submits work to OMP, not a proposal, and does not mark a block done.

Every block marks its evidence `observed`, `inferred`, or `unknown`. `observed` requires a source reference, which may include a line range. Discovery prompts require the agent to read cited files. Browser **Inspect syntax** reports Tree-sitter ranges and node kinds, not LSP references, types, or diagnostics. Browser file reads stay inside the workspace after symlink resolution.

The proposal tool checks the request token, scope, document identity, revision, on-disk digest, and session branch. It stages data; it cannot apply a change or write a file. `visual_planner_read({ scope? })` exposes the active document or one scope to the model.

## Files and development

Documents default to `.omp-visual-planner/architecture.json` (schema version 1). Saving is explicit, atomic, and refuses to overwrite an external edit. Blocks have stable IDs, authored order, optional nested diagrams, and source references; edges connect blocks in the same diagram. Old `{ "boxes": [...], "edges": [...] }` boards import without overwriting the legacy file (`demo.json` is an example).

```sh
bun install
bun run check
bun test
```

The optional terminal recording is [docs/demo.mp4](docs/demo.mp4) ([GIF](docs/demo.gif), [asciicast](docs/demo.cast.gz)). Reproduce it with Python, Pillow, `omp`, Bun, and FFmpeg:

```sh
python3 scripts/demo/scenario_full.py /tmp/planner-demo.cast
python3 scripts/demo/render.py /tmp/planner-demo.cast /tmp/planner-demo-frames
```

The recorder creates and removes its own workspace. It previews a request and does not submit one.
