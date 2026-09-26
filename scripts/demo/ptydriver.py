"""Minimal PTY driver: spawn a command, send keys, capture every byte with timing.

Emits an asciicast v2 stream on disk so the recording can be replayed or
re-rendered later without re-running the demo.
"""

from __future__ import annotations

import codecs
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


class Drivers:
    def __init__(self, cast_path: str, argv: list[str] | None = None, cwd: str = ".", cols: int = 120, rows: int = 34):
        self.cast_path = cast_path
        self.cols = cols
        self.rows = rows
        self.started = time.time()
        self.frames: list[tuple[float, str]] = []
        argv = argv or ["omp"]
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLUMNS"] = str(cols)
            os.environ["LINES"] = str(rows)
            os.execvp(argv[0], argv)
            os._exit(127)
        self.pid = pid
        self.fd = fd
        self.resize(cols, rows)
        os.set_blocking(fd, False)
        # Incremental decoding: a read can split a multi-byte glyph in half.
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    # -- terminal plumbing -------------------------------------------------
    def resize(self, cols: int, rows: int) -> None:
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.cols, self.rows = cols, rows

    def _drain(self) -> str:
        out = []
        while True:
            try:
                chunk = os.read(self.fd, 65536)
            except BlockingIOError:
                break
            except OSError:
                break
            if not chunk:
                break
            out.append(self.decoder.decode(chunk))
            if len(chunk) < 65536:
                # keep draining until the kernel buffer is empty
                ready, _, _ = select.select([self.fd], [], [], 0)
                if not ready:
                    break
        return "".join(out)

    def record_for(self, seconds: float) -> str:
        """Collect output for `seconds`, storing it as cast frames."""
        deadline = time.time() + seconds
        collected = ""
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            ready, _, _ = select.select([self.fd], [], [], min(0.05, remaining))
            if ready:
                data = self._drain()
                if data:
                    self.frames.append((time.time() - self.started, data))
                    collected += data
        return collected

    # -- input -------------------------------------------------------------
    def send(self, data: bytes) -> None:
        os.write(self.fd, data)

    def text(self, value: str, per_char: float = 0.035) -> None:
        for ch in value:
            self.send(ch.encode())
            self.record_for(per_char)

    def keys(self, values: list[bytes], gap: float = 0.08) -> None:
        for value in values:
            self.send(value)
            self.record_for(gap)

    def line(self, value: str) -> None:
        self.text(value, per_char=0.02)
        self.send(b"\r")
        self.record_for(0.4)

    def wait(self, seconds: float) -> None:
        self.record_for(seconds)

    # -- output ------------------------------------------------------------
    def finish(self, path: str | None = None) -> None:
        self.record_for(0.6)
        target = path or self.cast_path
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"version": 2, "width": self.cols, "height": self.rows, "env": {"TERM": "xterm-256color"}}) + "\n")
            for stamp, data in self.frames:
                handle.write(json.dumps([round(stamp, 4), "o", data]) + "\n")
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(40):
            try:
                os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                break
            time.sleep(0.05)
