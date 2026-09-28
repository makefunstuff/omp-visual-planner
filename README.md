# omp-visual-planner

A plan is a directory tree of markdown files, committed next to the code:

```text
docs/plan/
  index.md                  # the project
  design/
    preview.html
    design.md
  feature-1/
    index.md
    implementation-1/
      index.md
      design/
        preview.html
        design.md
    implementation-2/
```

One directory per node, its `index.md` is the node's text, subdirectories are its children, and links between nodes are the diagram's arrows. It is greppable, needs no plugin, a plan change sits next to the code change in the same diff, and agents and humans read it the same way.

This package has two parts:

- **The `plan-tree` skill** ([`skills/plan-tree/SKILL.md`](skills/plan-tree/SKILL.md)): the format, and the intents an agent runs on a node — `plan`, `discover`, `enhance`, `decompose`, `investigate`, `replan`, `prune`, `execute`, `change`, `sync`, `clarify`. Invoke as `/skill:plan-tree <intent> <node> [note]`.
- **A read-only view**: the whole tree as nested boxes on one zoomable canvas, arrows between them, and the selected node's page beside it. It redraws within a second of any file change. Editing happens in your editor.

Git is the history: review an iteration with `git diff -- docs/plan`, drop it with `git restore -- docs/plan`. `/tree` and `/fork` move the conversation only; they never restore files.

## Use cases

- **Plan a feature before writing it.** `plan <goal>`, then `decompose` the parts that are still vague. Mark a node `settled` once you agree with it; `execute` implements settled leaves that have acceptance criteria, in link order.
- **Learn an unfamiliar codebase.** `discover` maps entry points and modules into nodes that cite the lines they describe; `investigate` goes one node deeper, and `clarify` answers a question in a node from the cited code.
- **Scope a change to existing code.** `change <goal>` reads the code first and adds one subtree: the files it touches, then the concrete edits with acceptance criteria. The plan and the code land in the same commit.
- **Design a screen.** `enhance` on a node with a `design/` folder draws a wireframe and a 1280×800 HTML preview; the view shows the preview beside the node.
- **Keep a plan honest.** `sync` rewrites a node whose cited code moved; `replan` and `prune` rework a subtree without touching settled or done nodes.

## Use

In OMP, load the package directory (so both the extension and `skills/` are found):

```sh
omp -e /path/to/omp-visual-planner
```

- `/diagram [dir]` opens the view of `dir` (default `docs/plan`, relative to the session's working directory) in the browser and prints the link.
- `/diagram stop` stops it; it also stops when the session ends.
- `/skill:plan-tree plan <goal>` drafts a tree; `/skill:plan-tree decompose feature-1` adds children to one node, and so on.

Without OMP:

```sh
bun src/cli.ts [dir] [--port <n>]    # dir defaults to docs/plan; Ctrl+C stops it
```

For pi, link the skill directory:

```sh
ln -s /path/to/omp-visual-planner/skills/plan-tree ~/.pi/agent/skills/plan-tree
```

## The view

- Boxes: status glyph (`○` open, `◐` settled, `●` done), title, `◇` for a node with a `design/` folder, `!` for a node with problems (missing `index.md`, bad front matter). Open nodes have a dashed border, settled and done a solid one, done ones dimmed text.
- Drag or wheel pans; Ctrl/⌘-wheel or pinch zooms; double-click a box zooms to it; `f` or **Fit** fits everything.
- Click a box to open its page: file path, status and venue, problems, the body, `links to` / `linked from` rows, source links, and the design (`design.md` and a sandboxed `preview.html` with **Full size**). The twisty collapses a box; arrows aimed inside it land on it.
- `Esc` closes the full-size preview, else the page.

The server binds `127.0.0.1` on a random port, exchanges the printed link's token for an HttpOnly SameSite=Strict cookie, checks the Host header, and serves only `GET /`, `GET /api/tree` and `GET /api/preview`. It never writes.

## Converting old planner documents

Documents from the earlier JSON planner (`.omp-visual-planner/*.json`, schema version 1) convert once:

```sh
bun scripts/json-to-tree.ts .omp-visual-planner/architecture.json docs/plan [--repo <dir>]
```

Each block becomes an `NN-slug/` directory with its title, description, expected output, acceptance criteria, sources, edges and uses as links, and notes; a mockup becomes `design/preview.html` and a wireframe fence moves to `design/design.md`. The target must not exist or be empty. `evidence` and positions are dropped.

## Layout

```text
src/tree.ts        reads a plan tree: nodes, front matter, arrows, sources, version
src/layout.ts      nested-box layout and arrow geometry (browser-safe)
src/viewer.ts      the loopback server
src/cli.ts         the view without OMP
src/index.ts       the OMP extension: /diagram
web/               the page (Svelte), built into src/web-page.html
scripts/           build-web.ts, check-web.ts, json-to-tree.ts
skills/plan-tree/  the skill; the only place the intents live
```

## Develop

```sh
bun install
bun run build:web   # regenerate src/web-page.html after editing web/
bun run check       # tsc, Svelte check, stale-page check
bun test
```
