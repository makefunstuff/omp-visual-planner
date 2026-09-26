# omp-visual-planner

An OMP extension for planning systems and mapping codebases as nested blocks. It is built for OMP, not as a plugin for other harnesses. Work on one block at a time in a terminal or browser; use the map when relationships or layout matter. A model can stage a proposal, but only a person can accept it.

The same decomposition, without the map, is one skill: [`skills/decompose`](skills/decompose/SKILL.md). The use case is the agent plus `/tree`, which OMP and pi already have. The agent edits one markdown file of nested bullets, the way Logseq nests blocks. `/tree` is how you go back to an earlier decomposition. No second integration. OMP loads the skill with this plugin. For pi, link the directory:

```sh
ln -s /path/to/omp-visual-planner/skills/decompose ~/.pi/agent/skills/decompose
```

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

The terminal opens on a nested outline and the selected block's page. The focused block leads with one next step; `r`, `b`, `t`, and `X` are the rest. `space` advances its status; `n` selects the next open block. `R` reviews a staged proposal. `v` switches to the coordinate map, `E` edits a block as Markdown in `$VISUAL`/`$EDITOR`, and `s` saves. Press `?` for the full key list.

Brainstorm, and an explore block you have not settled, open on a **walk**: the focused block, what is inside it, and the blocks it connects to. Dump a line onto the focused idea (Enter in the browser, `O` in the terminal). In explore, a citation is the subtitle, uncited blocks are dim, and **grounded** (`g`) hides them. Mark a block explored to get the full page. Plan documents stay on that page. **Map** is coordinates. Both views share the session.

| Purpose | Block actions | Human status |
|---|---|---|
| brainstorm | Refine, Expand, Replan | none |
| plan | Refine, Break down, Replan, Execute | todo → planned → done |
| explore | Investigate, Map inside, Replan | unexplored → explored |

## Use cases

Four sessions. In each one the model may only stage a proposal. You accept it, or you do not. Saving is a separate key.

### Brainstorm an idea

You have a product thought and no structure. You do not want implementation steps.

```text
/diagram new brainstorm
```

The document opens on a walk. Dump the first line (`O` in the terminal, Enter in the browser). Dump the next line onto that idea to nest it, or onto the empty project to add a sibling. `r` previews Refine for the focused idea: title and note only, no new blocks. `b` previews Expand: sub-ideas come back as children. Accept the diff, then walk into one child and repeat. `space` does nothing here. Ideas have no status. There is no Execute verb. Once the idea has a note, the next step is **Implement**: it switches the document to a plan and opens Execute on that block.

When the map is the thing you want to look at, `v` (or Map in the browser). Relationships are context, not a schedule.

### Explore a codebase

You are new to a repository and want a map grounded in files, not a redesign.

```text
/diagram discover .
/diagram web
```

Discover submits a project-scope request. The proposal is a document of blocks with source ranges. Reject anything that cites a path you cannot open. After accept, the walk shows a citation under each block. Uncited blocks are dim. `g` hides them. Open a citation (`Enter` on the source row, or the path in the browser file tree). **Inspect syntax** is a Tree-sitter range, not a type or a reference.

`r` on one block is Investigate: it may fill description, evidence, sources, and children, and only from code it read. `b` is Map inside, for one subsystem, not the whole repo. `space` marks the block explored and leaves the walk for the full page. Do not use this purpose to plan new work. That is a plan document.

### Research a question interactively

You are not mapping a repository and you are not shipping a feature. You are pulling a question apart and keeping the evidence next to the claim.

```text
/diagram new explore
```

Skip Discover. Author the question yourself (`o` in the terminal, **+ block** in the browser), then the competing claims as its children (`O`, or **+ inside**). Do not use Map inside for that. Map inside asks the model to derive children from code. Each claim gets a source reference (`path` or `path:10-40`) only after you have opened that range. Evidence stays `unknown` or `inferred` until a source exists. `observed` without a source is refused. Investigate (`r`) on one claim, review the diff, and reject a citation you did not check. `g` hides claims that are not grounded. `space` marks a claim explored. `n` selects the next open one.

This is the same document type as codebase exploration. The difference is that you author the blocks, and the model only fills the one you point at.

### Refine an existing project

A plan already exists. One block is thin, or the nesting is wrong. You do not want a new document.

```text
/diagram open .omp-visual-planner/architecture.json
```

`n` moves to the next todo. `r` previews Refine for that block: description, expected output, acceptance criteria. It must not add or remove blocks. `b` is the separate request that adds children. `t` replans that block and its subtree. Settled and done blocks stay, under the same ids. A project replan or prune is `a`, and the same retention rule applies to the whole document.

Accept, then `s`. Acceptance is unsaved until you save. Undo is still available before that.

Execute is not refine. On the block you clicked, a written leaf runs even while it is still todo. A parent does not run: `X` dispatches only the ready leaves under it, and a leaf in that sweep still has to be planned and have acceptance criteria. Set venue on the block page, or Enter on the venue row in the terminal: `here`, `subagent`, or `worktree`. Unset means here. Execute ready leaves, from `a` or the project page, is that sweep for the whole plan. The prompt names the venue. This plugin does not spawn the subagent or the worktree, and it does not mark the leaf done. You do, after you have looked at the result.

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
