"""Record the three-act demo: new project, existing codebase, deep nesting.

Drives a real `omp` session in a PTY (the extension is installed as a plugin),
captures every byte, and lets the renderer turn it into a video.
"""

from __future__ import annotations

import glob
import json
import os
import sys
import time

sys.path.insert(0, "/tmp/demo/scripts")
from ptydriver import Drivers

CAST = sys.argv[1]
CWD = "/tmp/demo"
SESSION_SLUG = "*tmp-demo*"

ESC = b"\x1b"
UP, DOWN, LEFT, RIGHT = b"\x1b[A", b"\x1b[B", b"\x1b[D", b"\x1b[C"
ENTER, TAB = b"\r", b"\t"
CTRL_D = b"\x04"

d = Drivers(CAST, cwd=CWD)


def clear_field(width: int = 9) -> None:
    """Empty the editor's prefilled text: cursor to start, then delete forward."""
    d.keys([LEFT] * width)
    d.keys([CTRL_D] * width, gap=0.05)


def rename_block(title: str) -> None:
    """Inspector title field is focused: replace the prefilled title."""
    clear_field()
    d.text(title)
    d.keys([ENTER])
    d.wait(1.0)


def set_description(text: str) -> None:
    d.keys([DOWN, ENTER])
    d.wait(0.3)
    d.text(text)
    d.keys([ENTER])
    d.wait(0.4)


def newest_session_file() -> str | None:
    paths = glob.glob(os.path.expanduser(f"~/.omp/agent/sessions/{SESSION_SLUG}/*.jsonl"))
    return max(paths, key=os.path.getmtime) if paths else None


def wait_for_staged(timeout: float = 420.0) -> bool:
    """Wait while the agent works, then let the overlay repaint with the hint."""
    path = newest_session_file()
    deadline = time.time() + timeout
    while time.time() < deadline:
        d.record_for(2.0)
        if path and os.path.exists(path):
            try:
                with open(path, encoding="utf-8", errors="replace") as handle:
                    if '"staged"' in handle.read():
                        return True
            except OSError:
                pass
    return False


def main() -> None:
    d.wait(3.5)
    d.keys([ESC])                                   # dismiss the update banner
    d.wait(0.5)

    # ---------------------------------------------------------------- act 1
    d.line("/diagram new")
    d.wait(2.0)
    d.keys([b"o"])
    d.wait(0.5)
    d.keys([b"i"])
    d.wait(0.3)
    d.keys([ENTER])
    d.wait(0.4)
    rename_block("API Gateway")
    set_description("Public HTTP surface for mobile clients")
    d.keys([DOWN] * 6)                              # description -> "+ add source reference"
    d.wait(0.3)
    d.keys([ENTER])
    d.wait(0.4)
    d.text("src/gateway.ts:1-80")
    d.keys([ENTER])
    d.wait(0.8)
    d.keys([UP, UP, UP])                            # back to evidence
    d.wait(0.3)
    d.keys([ENTER, ENTER])                          # inferred -> unknown -> observed
    d.wait(1.4)                                     # let the observed badge land on the card

    d.keys([b"i"])                                  # canvas
    d.wait(0.2)
    d.keys([b"o"])                                  # second block
    d.wait(0.5)
    d.keys([b"i"])
    d.wait(0.2)
    d.keys([ENTER])
    d.wait(0.4)
    rename_block("Billing")
    set_description("Invoices, plans and payment callbacks")
    d.keys([b"i"])                                  # canvas
    d.wait(0.2)
    d.keys([b"h"])                                  # back to API Gateway
    d.wait(0.4)
    d.keys([b"e"])                                  # link picker
    d.wait(0.7)
    d.keys([ENTER])                                 # commit: API Gateway -> Billing
    d.wait(0.7)
    d.keys([ENTER])                                 # label field
    d.wait(0.4)
    d.text("charges")
    d.keys([ENTER])
    d.wait(0.5)
    d.keys([DOWN, DOWN, DOWN])                      # from port: auto -> north -> east
    d.keys([ENTER, ENTER])
    d.wait(0.4)
    d.keys([DOWN])                                  # to port: auto -> ... -> west
    d.keys([ENTER, ENTER, ENTER, ENTER])
    d.wait(2.2)                                     # let the finished diagram sit on screen
    d.text("s")                                     # save the design
    d.wait(1.8)
    d.keys([ESC])                                   # leave the overlay: the next command is typed in the composer
    d.wait(1.2)
    print("act 1 done", flush=True)

    # ---------------------------------------------------------------- act 2
    d.line("/diagram discover legacy")
    print("act 2 command sent", flush=True)
    d.wait(1.6)
    d.keys([ENTER])                                 # accept the target path
    d.wait(1.8)
    d.keys([ENTER])                                 # submit the discovery prompt
    d.wait(1.5)
    d.text("")
    d.wait(0.5)
    d.line("/diagram")                              # watch the planner while the agent works
    d.wait(1.2)
    staged = wait_for_staged()
    print("staged:", staged, flush=True)
    if staged:
        d.keys([b"i"])                              # repaint so the staged hint shows
        d.wait(0.8)
        d.keys([b"R"])                              # review
        d.wait(2.6)
        d.keys([ENTER])                             # accept
        d.wait(1.8)
        d.text("s")                                 # save the accepted map
        d.wait(1.6)
    d.keys([ESC])
    d.wait(1.2)
    print("act 2 done", flush=True)

    # ---------------------------------------------------------------- act 3
    d.line("/diagram open .omp-visual-planner/architecture.json")
    print("act 3 command sent", flush=True)
    d.wait(2.0)
    for depth, title in enumerate(["Auth", "Tokens", "Refresh"]):
        d.keys([ENTER])                             # descend one level
        d.wait(1.6)
        d.keys([b"o"])                               # a block inside this subsystem
        d.wait(0.5)
        d.keys([b"i"])
        d.wait(0.3)
        d.keys([ENTER])
        d.wait(0.4)
        rename_block(title)
        d.keys([b"i"])                               # back to the canvas
        d.wait(1.2)                                  # show the nested card and the breadcrumb
    d.text("s")
    d.wait(2.0)
    d.keys([ESC])
    d.wait(1.0)
    print("act 3 done", flush=True)


try:
    main()
finally:
    d.finish()
    print("cast:", CAST, os.path.getsize(CAST), "bytes")
