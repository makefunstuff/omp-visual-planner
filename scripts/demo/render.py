"""Render an asciicast v2 recording into PNG frames, a GIF, and an MP4.

The cast is replayed through a minimal VT parser (cursor positioning, SGR
colours, erase, alternate screen) so the frames are a faithful, crisp
reconstruction of the terminal rather than a pixel grab.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata

from PIL import Image, ImageDraw, ImageFont

CSI_RE = re.compile(r"^([?<>!]?)([0-9;:]*)([a-zA-Z@`~])$")

FONT_PATHS = ["/System/Library/Fonts/Menlo.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]
FALLBACK_FONT = "/System/Library/Fonts/Apple Symbols.ttf"
# Glyphs the terminal may show through a Nerd Font that no installed font has.
SUBSTITUTES = {
    "\u23f5": "\u25b8",
    "\u23f4": "\u25c2",
}
FONT_SIZE = 15
CELL_W = 9
CELL_H = 18
PAD = 12
BG = (24, 24, 27)
DEFAULT_FG = (222, 222, 226)
PALETTE = [
    (40, 42, 46), (224, 108, 117), (152, 195, 121), (229, 192, 123),
    (97, 175, 239), (198, 120, 221), (86, 182, 194), (200, 200, 205),
    (80, 84, 90), (255, 130, 140), (180, 220, 140), (255, 220, 150),
    (130, 200, 255), (220, 160, 240), (120, 210, 220), (245, 245, 250),
]


def xterm256(index: int) -> tuple[int, int, int]:
    if index < 16:
        return PALETTE[index]
    if index < 232:
        index -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return (steps[index // 36], steps[(index // 6) % 6], steps[index % 6])
    level = 8 + (index - 232) * 10
    return (level, level, level)


class Cell:
    __slots__ = ("ch", "fg", "bg", "bold", "dim", "italic", "underline", "inverse")

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.ch = " "
        self.fg = None
        self.bg = None
        self.bold = False
        self.dim = False
        self.italic = False
        self.underline = False
        self.inverse = False

    def copy_from(self, other: "Cell") -> None:
        for slot in self.__slots__:
            setattr(self, slot, getattr(other, slot))


def is_private_use(ch: str) -> bool:
    code = ord(ch)
    return 0xE000 <= code <= 0xF8FF or 0xF0000 <= code <= 0xFFFFD


def char_width(ch: str) -> int:
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


class Screen:
    """Just enough of a VT to reconstruct this app's rendering."""

    def __init__(self, cols: int, rows: int) -> None:
        self.cols, self.rows = cols, rows
        self.grid = [[Cell() for _ in range(cols)] for _ in range(rows)]
        self.alt_grid: list[list[Cell]] | None = None
        self.x = self.y = 0
        self.saved = (0, 0)
        self.fg = self.bg = None
        self.bold = self.dim = self.italic = self.underline = self.inverse = False
        self.pending = ""
        self.state = "text"  # text | esc | csi | osc | osc_st | apc

    # -- grid ops ----------------------------------------------------------
    def clear(self) -> None:
        for row in self.grid:
            for cell in row:
                cell.reset()

    def reset_attrs(self) -> None:
        self.fg = self.bg = None
        self.bold = self.dim = self.italic = self.underline = self.inverse = False

    def put(self, ch: str) -> None:
        width = char_width(ch)
        if width == 0:
            return
        if self.x >= self.cols:
            self.x = 0
            self.y += 1
            if self.y >= self.rows:
                self.scroll()
        if self.y >= self.rows:
            self.y = self.rows - 1
        cell = self.grid[self.y][self.x]
        cell.ch = ch
        cell.fg, cell.bg = self.fg, self.bg
        cell.bold, cell.dim, cell.italic = self.bold, self.dim, self.italic
        cell.underline, cell.inverse = self.underline, self.inverse
        if width == 2 and self.x + 1 < self.cols:
            nxt = self.grid[self.y][self.x + 1]
            nxt.ch = ""
            nxt.fg, nxt.bg = self.fg, self.bg
            nxt.bold, nxt.dim, nxt.italic = self.bold, self.dim, self.italic
        self.x += width

    def scroll(self) -> None:
        self.grid.pop(0)
        self.grid.append([Cell() for _ in range(self.cols)])
        self.y = self.rows - 1

    def erase_line(self, mode: int) -> None:
        if mode == 0:
            span = range(self.x, self.cols)
        elif mode == 1:
            span = range(0, min(self.x + 1, self.cols))
        else:
            span = range(self.cols)
        for col in span:
            self.grid[self.y][col].reset()

    def erase_display(self, mode: int) -> None:
        if mode in (2, 3):
            self.clear()
            return
        if mode == 0:
            self.erase_line(0)
            for row in range(self.y + 1, self.rows):
                for cell in self.grid[row]:
                    cell.reset()
        elif mode == 1:
            self.erase_line(1)
            for row in range(0, self.y):
                for cell in self.grid[row]:
                    cell.reset()

    # -- input -------------------------------------------------------------
    def feed(self, data: str) -> None:
        for ch in data:
            if self.state == "text":
                self._text(ch)
            elif self.state == "esc":
                self._esc(ch)
            elif self.state == "csi":
                self._csi(ch)
            elif self.state == "osc":
                if ch == "\x07":
                    self.state = "text"
                elif ch == "\x1b":
                    self.state = "osc_st"
            elif self.state == "osc_st":
                self.state = "text" if ch == "\\" else "osc"
            elif self.state == "apc":
                if ch == "\x07":
                    self.state = "text"
                elif ch == "\x1b":
                    self.state = "apc_esc"
            elif self.state == "apc_esc":
                self.state = "text" if ch == "\\" else "apc"

    def _text(self, ch: str) -> None:
        if ch == "\x1b":
            self.state = "esc"
        elif ch == "\r":
            self.x = 0
        elif ch == "\n":
            if self.y < self.rows - 1:
                self.y += 1
        elif ch == "\b":
            self.x = max(0, self.x - 1)
        elif ch == "\t":
            self.x = min(self.cols - 1, (self.x // 8 + 1) * 8)
        elif ch == "\x07":
            pass
        elif is_private_use(ch):
            self.put(" ")
        elif ch >= " ":
            self.put(SUBSTITUTES.get(ch, ch))

    def _esc(self, ch: str) -> None:
        if ch == "[":
            self.pending = ""
            self.state = "csi"
        elif ch == "]":
            self.state = "osc"
        elif ch == "_":
            self.state = "apc"
        elif ch in "P^X":
            self.state = "osc"
        elif ch == "7":
            self.saved = (self.x, self.y)
            self.state = "text"
        elif ch == "8":
            self.x, self.y = self.saved
            self.state = "text"
        elif ch in "()#%":
            self.state = "text"
        elif ch in "=>MDEc":
            self.state = "text"
        else:
            self.state = "text"

    def _csi(self, ch: str) -> None:
        if ch == "\x1b":
            self.state = "esc"
            return
        if not (ch.isdigit() or ch in ";:?<>!"):
            match = CSI_RE.match(self.pending + ch)
            self.pending = ""
            self.state = "text"
            if match:
                self._dispatch(match.group(1), match.group(2), match.group(3))
            return
        self.pending += ch

    def _params(self, raw: str) -> list[int]:
        if raw == "":
            return [0]
        out = []
        for part in raw.replace(":", ";").split(";"):
            out.append(int(part) if part.isdigit() else 0)
        return out

    def _dispatch(self, prefix: str, raw: str, final: str) -> None:
        params = self._params(raw)
        first = params[0] if params else 0
        if final == "m" and prefix == "":
            self._sgr(params)
            return
        if final == "H" or final == "f":
            self.y = min(self.rows - 1, max(0, (params[0] or 1) - 1))
            self.x = min(self.cols - 1, max(0, (params[1] if len(params) > 1 else 1) - 1))
            return
        if final == "A":
            self.y = max(0, self.y - (first or 1))
        elif final == "B":
            self.y = min(self.rows - 1, self.y + (first or 1))
        elif final == "C":
            self.x = min(self.cols - 1, self.x + (first or 1))
        elif final == "D":
            self.x = max(0, self.x - (first or 1))
        elif final == "E":
            self.y = min(self.rows - 1, self.y + (first or 1))
            self.x = 0
        elif final == "F":
            self.y = max(0, self.y - (first or 1))
            self.x = 0
        elif final == "G" or final == "`":
            self.x = min(self.cols - 1, max(0, (first or 1) - 1))
        elif final == "d":
            self.y = min(self.rows - 1, max(0, (first or 1) - 1))
        elif final == "J":
            self.erase_display(first)
        elif final == "K":
            self.erase_line(first)
        elif final == "X":
            for col in range(self.x, min(self.cols, self.x + (first or 1))):
                self.grid[self.y][col].reset()
        elif final == "s":
            self.saved = (self.x, self.y)
        elif final == "u":
            self.x, self.y = self.saved
        elif final == "h" and prefix == "?":
            if first == 1049 and self.alt_grid is None:
                self.alt_grid = self.grid
                self.grid = [[Cell() for _ in range(self.cols)] for _ in range(self.rows)]
                self.clear()
        elif final == "l" and prefix == "?":
            if first in (1049, 47) and self.alt_grid is not None:
                self.grid = self.alt_grid
                self.alt_grid = None

    def _sgr(self, params: list[int]) -> None:
        index = 0
        while index < len(params):
            code = params[index]
            if code == 0:
                self.reset_attrs()
            elif code == 1:
                self.bold = True
            elif code == 2:
                self.dim = True
            elif code == 3:
                self.italic = True
            elif code == 4:
                self.underline = True
            elif code == 7:
                self.inverse = True
            elif code == 22:
                self.bold = self.dim = False
            elif code == 23:
                self.italic = False
            elif code == 24:
                self.underline = False
            elif code == 27:
                self.inverse = False
            elif 30 <= code <= 37:
                self.fg = PALETTE[code - 30]
            elif code == 39:
                self.fg = None
            elif 40 <= code <= 47:
                self.bg = PALETTE[code - 40]
            elif code == 49:
                self.bg = None
            elif 90 <= code <= 97:
                self.fg = PALETTE[code - 90 + 8]
            elif 100 <= code <= 107:
                self.bg = PALETTE[code - 100 + 8]
            elif code in (38, 48) and index + 1 < len(params):
                target = "fg" if code == 38 else "bg"
                mode = params[index + 1]
                if mode == 5 and index + 2 < len(params):
                    setattr(self, target, xterm256(params[index + 2]))
                    index += 2
                elif mode == 2 and index + 4 < len(params):
                    setattr(self, target, (params[index + 2], params[index + 3], params[index + 4]))
                    index += 4
            index += 1


class Recorder:
    def __init__(self, cast_path: str) -> None:
        with open(cast_path, encoding="utf-8") as handle:
            header = json.loads(handle.readline())
            self.cols, self.rows = header["width"], header["height"]
            self.events = [json.loads(line) for line in handle if line.strip()]

    def snapshots(self, sample: float = 0.1, max_gap: float = 1.2) -> list[tuple[float, Screen]]:
        screen = Screen(self.cols, self.rows)
        shots: list[tuple[float, Screen]] = []
        last_shot = -1e9
        pending_since: float | None = None
        next_sample = 0.0
        timeline = 0.0
        previous_stamp = 0.0
        for stamp, _, data in self.events:
            gap = stamp - previous_stamp
            if gap > max_gap:
                timeline += max_gap
            else:
                timeline += gap
            previous_stamp = stamp
            screen.feed(data)
            if timeline >= next_sample:
                shots.append((timeline, self._clone(screen)))
                next_sample = timeline + sample
        shots.append((timeline, self._clone(screen)))
        del pending_since, last_shot
        return self._dedupe(shots)

    @staticmethod
    def _clone(screen: Screen) -> Screen:
        copy = Screen(screen.cols, screen.rows)
        copy.grid = [[self_cell_copy(cell) for cell in row] for row in screen.grid]
        copy.x, copy.y = screen.x, screen.y
        return copy

    @staticmethod
    def _dedupe(shots: list[tuple[float, Screen]]) -> list[tuple[float, Screen]]:
        out: list[tuple[float, Screen]] = []
        for stamp, screen in shots:
            if out and same_grid(out[-1][1], screen):
                continue
            out.append((stamp, screen))
        return out


def self_cell_copy(cell: Cell) -> Cell:
    copy = Cell()
    copy.copy_from(cell)
    return copy


def same_grid(a: Screen, b: Screen) -> bool:
    for row_a, row_b in zip(a.grid, b.grid):
        for cell_a, cell_b in zip(row_a, row_b):
            if cell_a.ch != cell_b.ch or cell_a.fg != cell_b.fg or cell_a.bg != cell_b.bg:
                return False
            if (cell_a.bold, cell_a.inverse) != (cell_b.bold, cell_b.inverse):
                return False
    return True


def glyph_font(ch: str, font: ImageFont.FreeTypeFont) -> ImageFont.FreeTypeFont:
    fallback = globals().get("FALLBACK")
    if fallback is None or fallback is font:
        return font
    try:
        if font.getmask(ch).getbbox() is None and fallback.getmask(ch).getbbox() is not None:
            return fallback
    except Exception:
        return font
    return font


def render(screen: Screen, font: ImageFont.FreeTypeFont) -> Image.Image:
    width = PAD * 2 + screen.cols * CELL_W
    height = PAD * 2 + screen.rows * CELL_H
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)
    for y, row in enumerate(screen.grid):
        for x, cell in enumerate(row):
            if cell.ch == "":
                continue
            fg = cell.fg or DEFAULT_FG
            bg = cell.bg
            if cell.inverse:
                fg, bg = (bg or BG), (fg or DEFAULT_FG)
            if cell.dim:
                fg = tuple(int(channel * 0.6) for channel in fg)
            if cell.bold:
                fg = tuple(min(255, int(channel * 1.25)) for channel in fg)
            px, py = PAD + x * CELL_W, PAD + y * CELL_H
            if bg:
                draw.rectangle([px, py, px + CELL_W - 1, py + CELL_H - 1], fill=bg)
            draw.text((px, py), cell.ch, font=glyph_font(cell.ch, font), fill=fg)
            if cell.underline:
                draw.line([px, py + CELL_H - 3, px + CELL_W - 1, py + CELL_H - 3], fill=fg)
    return image


def main() -> None:
    cast_path = sys.argv[1]
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    font_path = next((path for path in FONT_PATHS if os.path.exists(path)), None)
    font = ImageFont.truetype(font_path, FONT_SIZE) if font_path else ImageFont.load_default(size=FONT_SIZE)
    fallback = ImageFont.truetype(FALLBACK_FONT, FONT_SIZE) if os.path.exists(FALLBACK_FONT) else font
    globals()["FALLBACK"] = fallback
    recorder = Recorder(cast_path)
    sample = float(os.environ.get("SAMPLE", "0.1"))
    max_gap = float(os.environ.get("MAX_GAP", "1.2"))
    shots = recorder.snapshots(sample=sample, max_gap=max_gap)
    first_planner = next(
        (index for index, (_, screen) in enumerate(shots)
         if any("omp-visual-planner" in "".join(cell.ch for cell in row) for row in screen.grid)),
        None,
    )
    if first_planner is None:
        raise RuntimeError("recording never showed the planner overlay")
    opening = shots[first_planner:]
    shots = [shot for shot in opening if shot[0] >= opening[0][0] + 0.25] or opening[-1:]
    frames: list[Image.Image] = []
    durations: list[float] = []
    for index, (stamp, screen) in enumerate(shots):
        image = render(screen, font)
        path = os.path.join(out_dir, f"frame-{index:04d}.png")
        image.save(path)
        frames.append(image)
        nxt = shots[index + 1][0] if index + 1 < len(shots) else stamp + 1.0
        durations.append(max(0.08, min(1.2, nxt - stamp)))
    print(f"frames: {len(frames)}  size: {frames[0].size}")
    gif_path = os.path.join(out_dir, "demo.gif")
    frames[0].save(
        gif_path,
        save_all=True,
        append_images=frames[1:],
        duration=[int(value * 1000) for value in durations],
        loop=0,
        optimize=True,
    )
    mp4_path = os.path.join(out_dir, "demo.mp4")
    concat = os.path.join(out_dir, "frames.txt")
    with open(concat, "w", encoding="utf-8") as handle:
        for index, duration in enumerate(durations):
            handle.write(f"file 'frame-{index:04d}.png'\n")
            handle.write(f"duration {duration:.3f}\n")
        handle.write(f"file 'frame-{len(durations) - 1:04d}.png'\n")
    if shutil.which("ffmpeg"):
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                "-i", concat, "-vf", "fps=12,format=yuv420p", "-c:v", "libx264", "-crf", "20", mp4_path,
            ],
            check=True,
        )
        print("mp4:", mp4_path, os.path.getsize(mp4_path), "bytes")
    print("gif:", gif_path, os.path.getsize(gif_path), "bytes")


if __name__ == "__main__":
    main()
