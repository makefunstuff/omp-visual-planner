use crate::model::{BoxT, Board};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Text};
use ratatui::widgets::{Block, BorderType, Paragraph, Widget};

pub struct Frame<'a> {
    pub board: &'a Board,
    pub sel: Option<usize>,
    pub mode_label: &'a str,
    pub status: &'a str,
    pub cmd: Option<&'a str>,
    pub edge_from: Option<usize>,
    pub edge_to: Option<usize>,
    pub help: bool,
    pub insert: bool,
    pub cursor: (usize, usize),
}

pub fn draw(f: &Frame, frame: &mut ratatui::Frame) {
    let area = frame.area();
    let buf = frame.buffer_mut();
    draw_edges(f, buf);
    draw_boxes(f, buf);
    draw_caret(f, buf);
    draw_status(f, area, buf);
    if f.help {
        draw_help(area, buf);
    }
}

/// Box extent in character cells: text size + 1-cell border each side.
fn box_rect(b: &BoxT) -> Rect {
    let lines = b.lines();
    let w = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0) + 2;
    Rect::new(b.x as u16, b.y as u16, w as u16, lines.len() as u16 + 2)
}

fn put(buf: &mut Buffer, x: i32, y: i32, c: char) {
    let a = buf.area();
    if x < 0 || y < 0 || x as u16 >= a.width || y as u16 >= a.height {
        return;
    }
    buf.set_string(x as u16, y as u16, c.to_string(), Style::default());
}

fn draw_boxes(f: &Frame, buf: &mut Buffer) {
    for (i, b) in f.board.boxes.iter().enumerate() {
        let r = box_rect(b);
        let style = if Some(i) == f.sel {
            Style::new().add_modifier(Modifier::REVERSED)
        } else {
            Style::default()
        };
        let text: Text = b.lines().iter().map(|l| Line::from(&**l)).collect();
        Paragraph::new(text)
            .block(Block::bordered().border_type(BorderType::Rounded).style(style))
            .render(r, buf);
    }
}

fn draw_edges(f: &Frame, buf: &mut Buffer) {
    let mut pairs: Vec<(usize, usize)> = f.board.edges.iter().map(|e| (e.from, e.to)).collect();
    if let (Some(a), Some(b)) = (f.edge_from, f.edge_to) {
        pairs.push((a, b));
    }
    for (fi, ti) in pairs {
        if let (Some(a), Some(b)) = (f.board.boxes.get(fi), f.board.boxes.get(ti)) {
            draw_edge(buf, box_rect(a), box_rect(b));
        }
    }
}

/// Orthogonal connector: leave `a`'s border toward `b`, enter `b`'s border,
/// arrowhead at the entry. One L-bend when the two segments are not aligned.
fn draw_edge(buf: &mut Buffer, a: Rect, b: Rect) {
    if a == b {
        return;
    }
    let ax = a.x as i32 + a.width as i32 / 2;
    let ay = a.y as i32 + a.height as i32 / 2;
    let bx = b.x as i32 + b.width as i32 / 2;
    let by = b.y as i32 + b.height as i32 / 2;
    let dx = bx - ax;
    let dy = by - ay;

    if dx.abs() >= dy.abs() {
        let exit_x = if dx > 0 { a.right() as i32 } else { a.x as i32 - 1 };
        let entry_x = if dx > 0 { b.x as i32 - 1 } else { b.right() as i32 };
        let (exit_y, entry_y) = (ay, by);
        let step = dx.signum();
        let mut x = exit_x;
        while x != entry_x {
            put(buf, x, exit_y, '─');
            x += step;
        }
        if exit_y != entry_y {
            let corner = match (dx > 0, dy > 0) {
                (true, true) => '┐',
                (true, false) => '┘',
                (false, true) => '┌',
                (false, false) => '└',
            };
            put(buf, entry_x, exit_y, corner);
            let vstep = dy.signum();
            let mut y = exit_y + vstep;
            while y != entry_y {
                put(buf, entry_x, y, '│');
                y += vstep;
            }
            put(buf, entry_x, entry_y, if dy > 0 { '↓' } else { '↑' });
        } else {
            put(buf, entry_x, entry_y, if dx > 0 { '→' } else { '←' });
        }
    } else {
        let exit_y = if dy > 0 { a.bottom() as i32 } else { a.y as i32 - 1 };
        let entry_y = if dy > 0 { b.y as i32 - 1 } else { b.bottom() as i32 };
        let (exit_x, entry_x) = (ax, bx);
        let step = dy.signum();
        let mut y = exit_y;
        while y != entry_y {
            put(buf, exit_x, y, '│');
            y += step;
        }
        if exit_x != entry_x {
            let corner = match (dy > 0, dx > 0) {
                (true, true) => '└',
                (true, false) => '┘',
                (false, true) => '┌',
                (false, false) => '┐',
            };
            put(buf, exit_x, entry_y, corner);
            let hstep = dx.signum();
            let mut x = exit_x + hstep;
            while x != entry_x {
                put(buf, x, entry_y, '─');
                x += hstep;
            }
            put(buf, entry_x, entry_y, if dx > 0 { '→' } else { '←' });
        } else {
            put(buf, entry_x, entry_y, if dy > 0 { '↓' } else { '↑' });
        }
    }
}

fn draw_caret(f: &Frame, buf: &mut Buffer) {
    if !f.insert {
        return;
    }
    let Some(i) = f.sel else {
        return;
    };
    let b = &f.board.boxes[i];
    let r = box_rect(b);
    let x = r.x as i32 + 1 + f.cursor.1 as i32;
    let y = r.y as i32 + 1 + f.cursor.0 as i32;
    let a = buf.area();
    if x < a.x as i32
        || y < a.y as i32
        || x >= a.right() as i32
        || y >= a.bottom() as i32
        || x < r.x as i32 + 1
        || y < r.y as i32 + 1
        || x >= r.x as i32 + r.width as i32 - 1
        || y >= r.y as i32 + r.height as i32 - 1
    {
        return;
    }
    buf.set_string(
        x as u16,
        y as u16,
        "█",
        Style::new().add_modifier(Modifier::REVERSED),
    );
}

fn draw_status(f: &Frame, area: Rect, buf: &mut Buffer) {
    let y = area.y + area.height - 1;
    let mid = f.cmd.map(|c| format!(":{c}")).unwrap_or_else(|| f.status.to_string());
    let s = format!(" {}  {}  [?] help ", f.mode_label, mid);
    let s: String = s.chars().take(area.width as usize).collect();
    buf.set_stringn(
        0,
        y,
        &s,
        area.width as usize,
        Style::new().add_modifier(Modifier::REVERSED),
    );
}

fn draw_help(area: Rect, buf: &mut Buffer) {
    const W: u16 = 50;
    const H: u16 = 15;
    let x = area.x + (area.width.saturating_sub(W)) / 2;
    let y = area.y + (area.height.saturating_sub(H)) / 2;
    let r = Rect::new(x, y, W, H);
    let text = Text::from(vec![
        Line::from(""),
        Line::from("  h/j/k/l  arrows    move selection"),
        Line::from("  H/J/K/L             move box"),
        Line::from("  o                   new box (right)"),
        Line::from("  i                   insert into box"),
        Line::from("  d                   delete box"),
        Line::from("  e                   link: h/j/k/l, Enter, Esc"),
        Line::from("  :w [file]           save board json"),
        Line::from("  :e <file>           open board json"),
        Line::from("  :export [file]      export spec markdown"),
        Line::from("  :clear              clear board"),
        Line::from("  ?                   this help"),
        Line::from("  q                   quit"),
        Line::from(""),
    ]);
    Paragraph::new(text)
        .block(Block::bordered().border_type(BorderType::Rounded).title(" diatui "))
        .render(r, buf);
}
