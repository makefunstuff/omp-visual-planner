---
name: decompose
description: >
  Break a problem into a nested bullet tree in one markdown file, the way Logseq
  nests blocks. Use when the user wants to brainstorm, refine, expand, replan,
  prune, or execute a plan and no omp-visual-planner document is open. The
  iteration history is the harness /tree, which OMP and pi already have. One
  node per turn. Do not use this if visual_planner tools are available and a
  planner document is already open.
---

# Decompose

The use case is the agent plus `/tree`. OMP and pi already have both. This skill does not add a planner, a tool, or a plugin.

`/tree` is the history. Each expand, refine, or replan is one turn. If that turn was wrong, the human goes back with `/tree` and continues from the earlier leaf. Do not keep alternate decompositions as extra files.

`PLAN.md` is only the current tree, nested bullets, the way Logseq nests blocks. If `visual_planner_read` is available and a planner document is open, use that. Do not keep a second plan.


## File

Default path is `PLAN.md` at the workspace root. If the user names a file, use that file. Do not create another.

- The only heading is the document title, one `#` line.
- A node is a `- ` bullet. Children are indented two spaces under their parent.
- A field is a child whose text is `key: value`. Known keys: `note`, `status`, `venue`, `id`. Any other child is a sub-node.
- `acceptance` is a field whose children are the criteria, one bullet each.
- Do not use headings, numbered lists, or checkboxes as nodes. A checkbox is allowed only on an acceptance criterion.
- Stay with two-space indents. Do not rewrap the file.

```markdown
# hexdump tool

- purpose: plan
- goal: a small rust hexdump

- Rust hexdump CLI
  - note: dependency-free classic hex dump
  - Validating the input file
    - status: todo
    - note: readable file, or stdin when no path is given
    - acceptance:
      - a missing path is a clear error and a non-zero exit
  - Output formats
    - status: todo
    - note: 16 bytes per line, offset, hex, ASCII
```

`purpose` is `brainstorm`, `plan`, or `explore`. It sits under the title, not under a node.

## One node at a time

Read the file. If it does not exist, write the title and the first node, then stop.

If the user names a node, that is the node. Otherwise take the first `todo` leaf. If there is no status, take the first leaf that has no `note`.

Do only the verb they named. If they named none, do the next step and stop:

- no `note` and no children: expand
- has a `note`, and `purpose` is `brainstorm`: stop. Say the next step is Implement, and wait
- plan leaf with a `note`: stop. Do not execute unless they said execute
- a parent: do not execute it. Name the child that is next

## Verbs

- **refine.** Rewrite that node's title and `note`. Do not add or remove children.
- **expand.** Add children under that node. Leave its `note` alone.
- **replan.** You may add, remove, or retitle under that node. A child with `status: planned` or `status: done` stays, same title, same `id` if it has one.
- **prune.** Remove children that do not earn their place. Never remove `planned` or `done`.
- **execute.** Only a leaf that has a `note`. Do the work in the repo. Do not set `status: done`. The human does that.
  - `venue: subagent` — one subagent, this workspace, that leaf only.
  - `venue: worktree` — do not edit this checkout. Say a worktree is required unless this harness already has one open for that leaf.
  - no venue — do it here.

A leaf in a parent sweep is not ready until it is `planned` and has acceptance criteria. The leaf the user named is ready if it has a `note`, even while it is `todo`.

## Status

`todo`, `planned`, `done`. Omit `status` when `purpose` is `brainstorm`. Do not invent a status.

## After an edit

Show only the node you changed, with its parent bullet so the nesting is visible. Do not reprint the file.
