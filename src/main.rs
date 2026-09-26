mod model;
mod render;

use clap::Parser;
use crossterm::event::{self, Event, KeyEventKind, KeyCode, KeyModifiers};
use model::{Board, Dir};

#[derive(Parser)]
#[command(name = "diatui", about = "visual brainstorming board (terminal UI)")]
struct Cli {
    /// board file to open (json)
    file: Option<String>,
}

#[derive(PartialEq, Clone, Copy)]
enum Mode {
    Normal,
    Insert,
    Edge,
    Command,
    Help,
}

struct App {
    board: Board,
    sel: Option<usize>,
    mode: Mode,
    cur_line: usize,
    cur_col: usize,
    edge_from: Option<usize>,
    edge_to: Option<usize>,
    cmd: String,
    status: String,
    quit: bool,
}

impl App {
    fn new() -> Self {
        App {
            board: Board::default(),
            sel: None,
            mode: Mode::Normal,
            cur_line: 0,
            cur_col: 0,
            edge_from: None,
            edge_to: None,
            cmd: String::new(),
            status: String::from("? for help"),
            quit: false,
        }
    }

    fn set_status(&mut self, s: &str) {
        self.status = s.to_string();
    }

    fn clamp_cursor(&mut self) {
        if let Some(i) = self.sel {
            let lines = self.board.boxes[i].lines();
            let n = lines.len().max(1);
            self.cur_line = self.cur_line.min(n - 1);
            let maxcol = lines
                .get(self.cur_line)
                .map(|l| l.chars().count())
                .unwrap_or(0);
            self.cur_col = self.cur_col.min(maxcol);
        }
    }

    fn split_lines(text: &str) -> Vec<String> {
        let mut v: Vec<String> = text.lines().map(str::to_string).collect();
        if v.is_empty() {
            v.push(String::new());
        }
        v
    }

    /// Read the selected box's text and width without holding a borrow.
    fn cur_state(&self) -> Option<(String, usize)> {
        self.sel.map(|i| {
            (
                self.board.boxes[i].text.clone(),
                self.board.boxes[i].width_cells() as usize,
            )
        })
    }

    fn commit(&mut self, lines: Vec<String>) {
        if let Some(i) = self.sel {
            self.board.boxes[i].text = lines.join("\n");
        }
        self.clamp_cursor();
        
    }

    // ---------- insert mode ----------

    fn insert_char(&mut self, c: char) {
        let Some((text, width)) = self.cur_state() else {
            return;
        };
        let mut lines = Self::split_lines(&text);
        while lines.len() <= self.cur_line {
            lines.push(String::new());
        }
        let col = self.cur_col.min(lines[self.cur_line].chars().count());
        lines[self.cur_line].insert(col, c);
        if lines[self.cur_line].chars().count() > width {
            let s = std::mem::take(&mut lines[self.cur_line]);
            let mut chars: Vec<char> = s.chars().collect();
            let head: String = chars.drain(..width).collect();
            let tail: String = chars.iter().collect();
            let tail_len = tail.chars().count();
            lines[self.cur_line] = head;
            lines.insert(self.cur_line + 1, tail);
            self.cur_line += 1;
            self.cur_col = tail_len;
        } else {
            self.cur_col = col + 1;
        }
        self.commit(lines);
    }

    fn insert_newline(&mut self) {
        let Some((text, _)) = self.cur_state() else {
            return;
        };
        let mut lines = Self::split_lines(&text);
        while lines.len() <= self.cur_line {
            lines.push(String::new());
        }
        let line = std::mem::take(&mut lines[self.cur_line]);
        let col = self.cur_col.min(line.chars().count());
        let head: String = line.chars().take(col).collect();
        let tail: String = line.chars().skip(col).collect();
        lines[self.cur_line] = head;
        lines.insert(self.cur_line + 1, tail);
        self.cur_line += 1;
        self.cur_col = 0;
        self.commit(lines);
    }

    fn backspace(&mut self) {
        let Some((text, _)) = self.cur_state() else {
            return;
        };
        let mut lines = Self::split_lines(&text);
        while lines.len() <= self.cur_line {
            lines.push(String::new());
        }
        if self.cur_col > 0 {
            lines[self.cur_line].remove(self.cur_col - 1);
            self.cur_col -= 1;
        } else if self.cur_line > 0 {
            lines.remove(self.cur_line);
            self.cur_line -= 1;
            self.cur_col = lines[self.cur_line].chars().count();
        }
        self.commit(lines);
    }

    fn move_cursor(&mut self, dline: i32, dcol: i32) {
        let Some((text, _)) = self.cur_state() else {
            return;
        };
        let lines = Self::split_lines(&text);
        let l = (self.cur_line as i32 + dline).clamp(0, lines.len() as i32 - 1);
        let maxcol = lines[l as usize].chars().count() as i32;
        self.cur_line = l as usize;
        self.cur_col = (self.cur_col as i32 + dcol).clamp(0, maxcol) as usize;
        
    }

    // ---------- normal mode ----------

    fn move_sel(&mut self, dir: Dir) {
        let Some(i) = self.sel else {
            self.set_status("no box — o creates one");
            
            return;
        };
        if let Some(j) = self.board.nearest(i, dir) {
            self.sel = Some(j);
            self.clamp_cursor();
        }
        
    }

    fn move_box(&mut self, dir: Dir) {
        let Some(i) = self.sel else {
            return;
        };
        let (dx, dy) = dir.vec();
        let b = &mut self.board.boxes[i];
        b.x += dx;
        b.y += dy;
        
    }

    fn new_box_right(&mut self) {
        let (x, y) = match self.sel {
            Some(i) => {
                let b = &self.board.boxes[i];
                (b.x + b.width_cells() + 2, b.y)
            }
            None => (2, 2),
        };
        let i = self.board.add_box(x, y, String::new());
        self.sel = Some(i);
        self.cur_line = 0;
        self.cur_col = 0;
        self.mode = Mode::Insert;
        self.set_status("insert — Esc for normal");
        
    }

    fn del_box(&mut self) {
        let Some(i) = self.sel else {
            return;
        };
        self.board.remove(i);
        self.sel = self.board.boxes.first().map(|_| 0);
        self.clamp_cursor();
        self.set_status("deleted");
        
    }

    // ---------- edge mode ----------

    fn start_edge(&mut self) {
        let Some(i) = self.sel else {
            self.set_status("no box selected");
            return;
        };
        self.mode = Mode::Edge;
        self.edge_from = Some(i);
        self.edge_to = None;
        self.set_status("target: h/j/k/l, Enter confirm, Esc cancel");
        
    }

    fn edge_pick(&mut self, dir: Dir) {
        let Some(f) = self.edge_from else {
            return;
        };
        if let Some(t) = self.board.nearest(f, dir) {
            if t != f {
                self.edge_to = Some(t);
                
            }
        }
    }

    fn confirm_edge(&mut self) {
        if let (Some(f), Some(t)) = (self.edge_from, self.edge_to) {
            self.board.edges.push(model::Edge { from: f, to: t });
            self.set_status("edge added");
        }
        self.mode = Mode::Normal;
        self.edge_from = None;
        self.edge_to = None;
        
    }

    fn cancel_edge(&mut self) {
        self.mode = Mode::Normal;
        self.edge_from = None;
        self.edge_to = None;
        
    }

    // ---------- command mode ----------

    fn start_command(&mut self) {
        self.mode = Mode::Command;
        self.cmd.clear();
        
    }

    fn cmd_enter(&mut self) {
        let s = std::mem::take(&mut self.cmd);
        self.exec_command(&s);
    }

    fn exec_command(&mut self, input: &str) {
        let mut it = input.trim().split_ascii_whitespace();
        match it.next() {
            Some("q") | Some("quit") => self.quit = true,
            Some("w") => {
                let file = it.next().unwrap_or("board.json");
                let json = serde_json::to_string_pretty(&self.board).expect("serialize");
                match std::fs::write(file, json) {
                    Ok(()) => self.set_status(&format!("wrote {file}")),
                    Err(e) => self.set_status(&format!("write failed: {e}")),
                }
            }
            Some("e") => match it.next() {
                Some(file) => match std::fs::read_to_string(file) {
                    Ok(s) => match serde_json::from_str::<Board>(&s) {
                        Ok(b) => {
                            self.board = b;
                            self.sel = self.board.boxes.first().map(|_| 0);
                            self.clamp_cursor();
                            self.set_status(&format!("opened {file}"));
                        }
                        Err(e) => self.set_status(&format!("parse failed: {e}")),
                    },
                    Err(e) => self.set_status(&format!("read failed: {e}")),
                },
                None => self.set_status("usage: :e <file>"),
            },
            Some("export") => {
                let file = it.next().unwrap_or("board.spec.md");
                match std::fs::write(file, self.board.spec_md()) {
                    Ok(()) => self.set_status(&format!("exported {file}")),
                    Err(e) => self.set_status(&format!("export failed: {e}")),
                }
            }
            Some("clear") => {
                self.board = Board::default();
                self.sel = None;
                self.set_status("cleared");
            }
            Some("help") => self.mode = Mode::Help,
            Some(other) => self.set_status(&format!("unknown: :{other}")),
            None => {}
        }
        self.mode = Mode::Normal;
        
    }

    // ---------- input dispatch ----------

    fn on_key(&mut self, key: KeyCode) {
        match self.mode {
            Mode::Normal => self.on_normal(key),
            Mode::Insert => self.on_insert(key),
            Mode::Edge => self.on_edge(key),
            Mode::Command => self.on_command(key),
            Mode::Help => {
                if matches!(key, KeyCode::Esc | KeyCode::Char('?')) {
                    self.mode = Mode::Normal;
                    
                }
            }
        }
    }

    fn on_normal(&mut self, key: KeyCode) {
        match key {
            KeyCode::Char('h') => self.move_sel(Dir::H),
            KeyCode::Char('j') => self.move_sel(Dir::J),
            KeyCode::Char('k') => self.move_sel(Dir::K),
            KeyCode::Char('l') => self.move_sel(Dir::L),
            KeyCode::Left => self.move_sel(Dir::H),
            KeyCode::Down => self.move_sel(Dir::J),
            KeyCode::Up => self.move_sel(Dir::K),
            KeyCode::Right => self.move_sel(Dir::L),
            KeyCode::Char('H') => self.move_box(Dir::H),
            KeyCode::Char('J') => self.move_box(Dir::J),
            KeyCode::Char('K') => self.move_box(Dir::K),
            KeyCode::Char('L') => self.move_box(Dir::L),
            KeyCode::Char('i') => {
                if self.sel.is_some() {
                    self.mode = Mode::Insert;
                    self.clamp_cursor();
                    self.set_status("insert — Esc for normal");
                }
            }
            KeyCode::Char('o') => self.new_box_right(),
            KeyCode::Char('d') => self.del_box(),
            KeyCode::Char('e') => self.start_edge(),
            KeyCode::Char(':') => self.start_command(),
            KeyCode::Char('?') => {
                self.mode = Mode::Help;
                
            }
            KeyCode::Char('q') => self.quit = true,
            _ => {}
        }
    }

    fn on_insert(&mut self, key: KeyCode) {
        match key {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                self.set_status("normal");
                
            }
            KeyCode::Enter => self.insert_newline(),
            KeyCode::Backspace => self.backspace(),
            KeyCode::Left => self.move_cursor(0, -1),
            KeyCode::Right => self.move_cursor(0, 1),
            KeyCode::Up => self.move_cursor(-1, 0),
            KeyCode::Down => self.move_cursor(1, 0),
            KeyCode::Char(c) => {
                if (c as u32) >= 0x20 && (c as u32) <= 0x7e {
                    self.insert_char(c);
                }
            }
            _ => {}
        }
    }

    fn on_edge(&mut self, key: KeyCode) {
        match key {
            KeyCode::Char('h') => self.edge_pick(Dir::H),
            KeyCode::Char('j') => self.edge_pick(Dir::J),
            KeyCode::Char('k') => self.edge_pick(Dir::K),
            KeyCode::Char('l') => self.edge_pick(Dir::L),
            KeyCode::Enter => self.confirm_edge(),
            KeyCode::Esc => self.cancel_edge(),
            _ => {}
        }
    }

    fn on_command(&mut self, key: KeyCode) {
        match key {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                self.cmd.clear();
                
            }
            KeyCode::Enter => self.cmd_enter(),
            KeyCode::Backspace => {
                self.cmd.pop();
                
            }
            KeyCode::Char(c) => {
                self.cmd.push(c);
                
            }
            _ => {}
        }
    }

    fn frame(&self) -> render::Frame<'_> {
        let label = match self.mode {
            Mode::Normal => " NORMAL ",
            Mode::Insert => " INSERT ",
            Mode::Edge => " EDGE ",
            Mode::Command => " CMD ",
            Mode::Help => " HELP ",
        };
        render::Frame {
            board: &self.board,
            sel: self.sel,
            mode_label: label,
            status: &self.status,
            cmd: (self.mode == Mode::Command).then(|| self.cmd.as_str()),
            edge_from: self.edge_from,
            edge_to: self.edge_to,
            help: self.mode == Mode::Help,
            insert: self.mode == Mode::Insert,
            cursor: (self.cur_line, self.cur_col),
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    let mut app = App::new();
    if let Some(f) = &cli.file {
        match std::fs::read_to_string(f) {
            Ok(s) => match serde_json::from_str::<Board>(&s) {
                Ok(b) => {
                    app.board = b;
                    app.sel = app.board.boxes.first().map(|_| 0);
                    app.clamp_cursor();
                }
                Err(e) => app.set_status(&format!("parse failed: {e}")),
            },
            Err(e) => app.set_status(&format!("load failed: {f} — {e}")),
        }
    }

    let mut terminal = ratatui::init();

    loop {
        terminal.draw(|f| render::draw(&app.frame(), f))?;
        if app.quit {
            break;
        }
        if let Ok(ev) = event::read() {
            match ev {
                Event::Key(k)
                    if k.kind == KeyEventKind::Press
                        && !k.modifiers.contains(KeyModifiers::CONTROL) =>
                {
                    app.on_key(k.code)
                }
                // raw mode disables ISIG, so Ctrl+C arrives as a key event
                Event::Key(k)
                    if k.kind == KeyEventKind::Press
                        && k.modifiers.contains(KeyModifiers::CONTROL)
                        && k.code == KeyCode::Char('c') =>
                {
                    app.quit = true;
                }
                _ => {}
            }
        }
    }

    ratatui::restore();
    Ok(())
}

#[cfg(test)]
mod app_flow {
    use super::App;
    use crossterm::event::KeyCode;

    #[test]
    fn type_save_export_flow() {
        let mut app = App::new();
        app.on_key(KeyCode::Char('o')); // new box, insert mode
        for c in "hello world".chars() {
            app.on_key(KeyCode::Char(c));
        }
        app.on_key(KeyCode::Esc); // back to normal
        app.on_key(KeyCode::Char(':')); // command line
        for c in "w /tmp/diatui-test.json".chars() {
            app.on_key(KeyCode::Char(c));
        }
        app.on_key(KeyCode::Enter); // :w
        app.on_key(KeyCode::Char(':'));
        for c in "export /tmp/diatui-test.spec.md".chars() {
            app.on_key(KeyCode::Char(c));
        }
        app.on_key(KeyCode::Enter); // :export

        let json = std::fs::read_to_string("/tmp/diatui-test.json").expect("read json");
        assert!(json.contains("hello"));
        assert!(json.contains("world"));
        let spec = std::fs::read_to_string("/tmp/diatui-test.spec.md").expect("read spec");
        assert!(spec.contains("hello"));
        assert!(spec.contains("world"));
    }
}
