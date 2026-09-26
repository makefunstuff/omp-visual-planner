# diatui

Visual brainstorming board for the terminal: boxes with text, directed links,
exported as a spec (markdown or JSON) usable as an LLM prompt.

Terminal UI (ratatui + crossterm). Neovim-style modal keys.

## Run

```
cargo run -- [board.json]
```

## Keys (normal mode)

| key | action |
|---|---|
| `h/j/k/l`, arrows | move selection |
| `H/J/K/L` | move selected box |
| `o` | new box to the right (enters insert) |
| `i` | insert into selected box |
| `d` | delete selected box |
| `e` | link: pick target with `h/j/k/l`, `Enter` confirm, `Esc` cancel |
| `:` | command line |
| `?` | help |
| `q` | quit |

Insert mode: type text; `Enter` newline, `Backspace` delete, arrows move the
caret, `Esc` back to normal. Long lines auto-wrap at the box width.

## Commands

| command | action |
|---|---|
| `:w [file]` | save board as JSON (default `board.json`) |
| `:e <file>` | open board JSON |
| `:export [file]` | export spec markdown (default `board.spec.md`) |
| `:clear` | clear the board |
| `:q` | quit |

## Board format (JSON)

```json
{
  "boxes": [ { "x": 4, "y": 4, "text": "api\npublic REST surface" } ],
  "edges": [ { "from": 0, "to": 1 } ]
}
```

Coordinates are character cells; box size is derived from the text.
