---
name: plan-tree
description: >
  Plan, map or brainstorm as a tree of markdown directories (docs/plan by
  default): one directory per node with index.md, nested directories as
  children, links between nodes as the diagram's arrows, design/ for a node's
  wireframe and HTML preview. Use to draft a plan from a goal, map a codebase,
  enhance, decompose, investigate, replan, prune or execute a node, plan a
  change, sync a node with its code, or answer a question about cited code.
  Invoke as /skill:plan-tree <intent> <node> [note]. Git is the history.
---

# Plan tree

A plan is a directory tree of markdown files, committed next to the code. It is greppable, needs no plugin, and a plan change sits next to the code change in the same diff. `/diagram` (omp-visual-planner) or `bun src/cli.ts <dir>` shows it as nested boxes with arrows; that view is read-only. You and the human edit the files.

Git is the history: an iteration is reviewed with `git diff -- <tree root>` and dropped with `git restore -- <tree root>`. `/tree` and `/fork` move the conversation only; they never restore files. Never keep alternate plans as extra copies of the tree.

## Format

### Tree

- A node is a directory. Its `index.md` is the node's text.
- Every subdirectory is a child node, except `design/` and names starting with `.`. Symlinked directories and files are skipped.
- The root is the tree directory (default `docs/plan/`); its `index.md` is the root node, the project. Any directory with an `index.md` can be a tree root.
- A node's identity is its path relative to the root (POSIX; `""` for the root).
- Children are ordered by directory name, numerically (`2-a` before `10-b`). Name directories `NN-slug` (`01-parser`, `02-cli`) to fix an order; the prefix never shows, because the title comes from `index.md`.
- A directory without `index.md` is still a node, titled by its directory name, and carries the problem `index.md is missing`.

### Node file `index.md`

```markdown
---
status: settled
venue: subagent
---
# Title

Free markdown. [feeds](../feature-2/) is an arrow to a sibling;
[flow.ts:145-149](../../../src/flow.ts#L145-L149) is a source (from `docs/plan/feature-1/`).

## Acceptance criteria

- [ ] one criterion per item
```

- Front matter is optional YAML. `status` is `open`, `settled` or `done` (absent means `open`). `venue` is `here`, `subagent` or `worktree` (absent or `here` means this session). Other keys are ignored. Invalid values show as problems in the view and fall back to the default.
- The title is the first `# ` heading; without one, the directory name. The body is everything else.
- `## Acceptance criteria` is an ordinary section; `execute` uses it to decide whether a leaf is ready.
- Only the human sets `status: done`.

### Arrows and sources

Every markdown link in `index.md` (inline, or reference-style through a definition) is resolved against the node's directory, after dropping `?query` and `#fragment` and URL-decoding:

- Empty, fragment-only, absolute (`/…`) and scheme (`https:`, `mailto:`) links are ignored.
- A link to a node directory inside the tree, or to that node's `index.md`, is an **arrow** from this node to that one. Its label is the link text; empty text takes the target's title. Write the relation as the text: `[feeds](../02-cli/)`, `[uses](../../03-store/)`, `[after](../01-parser/)`.
- A link outside the tree but inside the repo is a **source**: `[parser.ts:10-20](../../../src/parser.ts#L10-L20)`. Lines come from a `#L10` or `#L10-L20` fragment.
- Anything else (other files in the tree, paths outside the repo) is neither.

Paths are relative to the node's own directory: count the `../` from `docs/plan/<node path>/` to the target. A wrong count silently drops the arrow or source.

### Design folder `design/`

- `design/design.md`: the node's design. One ```` ```wireframe ```` fence (at most 12 lines of 60 columns: regions top to bottom, the primary action, real labels), then one line per state; components are drawn as labelled boxes. The root's `design/design.md` is the design system: other designs use its tokens by name.
- `design/preview.html`: one self-contained HTML document with inline CSS showing the default state at 1280×800. No `<script>`, no external URL, at most 40,000 characters. Tokens come from the nearest ancestor `design/design.md` that defines them, else the repo's root `DESIGN.md`, else greys only.
- A node with a `design/` folder is a designed node.

## Intents

Invoked as `/skill:plan-tree <intent> <node> [note]`, or in plain words. `<node>` is a path relative to the tree root or to the repo; empty or `.` is the root. The tree root defaults to `docs/plan/`.

|Intent|Scope and effect|Must not|
|---|---|---|
|`plan <goal>`|A root with no child nodes: write the root `index.md` (title, goal as body) and top-level child nodes, nesting only what is clear.|Run on a root that already has children (say so).|
|`discover [code path] [tree dir]`|Map existing code (default `.`) into a tree (default `docs/plan/` only while it has no children; otherwise ask for a directory): entry points, packages and top-level modules as top-level nodes; nest internals only after reading them; every claim cites its code as a source link.|Describe code it did not read.|
|`enhance <node> [note]`|Rewrite that node's `index.md` title, body and acceptance criteria; for a designed node also (re)draw `design/design.md` and `design/preview.html`.|Add, remove or rename directories.|
|`decompose <node> [note]`|Add child directories, each with an `index.md` (title, body, acceptance criteria), and links between them where one feeds another.|Change the node's own text.|
|`investigate <node> [note]`|Read the code the node links to (search when it has none), rewrite the body from what was read, add source links; add children only when the code shows them.|Guess.|
|`replan <node> [note]`|Rework the subtree: add, remove, rename or move child directories and rewrite their text.|Remove, rename or move a node whose status is `settled` or `done`, or anything outside the node.|
|`prune <node> [note]`|Remove child subtrees that do not earn their place; name each removal and its reason in the reply.|Remove `settled` or `done` nodes.|
|`execute <node> [note]`|A leaf: implement it in the repo against its acceptance criteria, in its venue (`subagent`: one subagent for that leaf; `worktree`: an isolated worktree, never this checkout; else here). A parent: its leaves that are `settled` and have acceptance criteria, in an order that respects their links (read the link text: "uses", "needs", "after", "feeds"); ask when the order is unclear.|Set `status: done` (the human does), change the plan files.|
|`change <goal>`|Read the code first, then add one subtree under the root for the change: top-level children for the parts of the code it touches, each linking the files it changes; concrete edits nested under them with acceptance criteria.|Touch other subtrees.|
|`sync <node>`|Re-read the code the node links to; rewrite the text and source links (line ranges) where the code changed; drop a source whose code is gone.|Change status.|
|`clarify <node>`|Answer the question in the node's body from the code it links to: append a paragraph starting `Answer:` and link every range relied on.|Change the title or structure.|

## Rules for every intent

- One intent per turn.
- Read the node's files, and the nodes it links to, before writing.
- Touch only the named scope.
- Never rename a directory you did not create.
- Do not reformat text you did not change.
- Do not commit.
- A named node that does not exist is reported, not created (except by `plan`, `discover` and `change`).
- Iterations are git (and `/tree` for the conversation), never extra copies of the tree.
- Finish with the list of changed paths and `git diff -- <tree root>` as the way to review.

## Example

```text
docs/plan/
  index.md                  # the project
  design/
    preview.html
    design.md               # the design system
  feature-1/
    index.md
    implementation-1/
      index.md
      design/
        preview.html
        design.md
    implementation-2/       # no index.md yet: titled by its name, flagged
```

`docs/plan/feature-1/implementation-1/index.md`:

```markdown
---
status: settled
venue: worktree
---
# Parse the config file

Reads `config.toml` into typed settings; [feeds](../implementation-2/) the loader.
Starts from [config.ts:1-40](../../../../src/config.ts#L1-L40).

## Acceptance criteria

- [ ] an unknown key is an error naming the key and its line
- [ ] a missing file falls back to the defaults
```
