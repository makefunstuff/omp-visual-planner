use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Serialize, Deserialize)]
pub struct BoxT {
    pub x: i32,
    pub y: i32,
    pub text: String,
}

impl BoxT {
    pub fn lines(&self) -> Vec<&str> {
        self.text.lines().collect()
    }

    /// width in cells: widest line, clamped 6..=48
    pub fn width_cells(&self) -> i32 {
        let max = self.lines().iter().map(|l| l.chars().count() as i32).max().unwrap_or(0);
        max.clamp(6, 48)
    }

    pub fn height_cells(&self) -> i32 {
        self.lines().len() as i32 + 2
    }

    /// (x, y, w, h) in cells
    pub fn rect(&self) -> (i32, i32, i32, i32) {
        (self.x, self.y, self.width_cells(), self.height_cells())
    }

    pub fn center(&self) -> (i32, i32) {
        let (x, y, w, h) = self.rect();
        (x + w / 2, y + h / 2)
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Dir {
    H,
    J,
    K,
    L,
}

impl Dir {
    pub fn vec(self) -> (i32, i32) {
        match self {
            Dir::H => (-1, 0),
            Dir::J => (0, 1),
            Dir::K => (0, -1),
            Dir::L => (1, 0),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Edge {
    pub from: usize,
    pub to: usize,
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Board {
    #[serde(default)]
    pub boxes: Vec<BoxT>,
    #[serde(default)]
    pub edges: Vec<Edge>,
}

impl Board {
    pub fn add_box(&mut self, x: i32, y: i32, text: String) -> usize {
        self.boxes.push(BoxT { x, y, text });
        self.boxes.len() - 1
    }

    pub fn remove(&mut self, i: usize) {
        self.boxes.remove(i);
        self.edges.retain(|e| e.from != i && e.to != i);
        for e in &mut self.edges {
            if e.from > i {
                e.from -= 1;
            }
            if e.to > i {
                e.to -= 1;
            }
        }
    }

    /// Nearest box strictly in the given direction (nearest-neighbor, Neovim-style).
    pub fn nearest(&self, from: usize, dir: Dir) -> Option<usize> {
        let (acx, acy) = self.boxes[from].center();
        let (dx, dy) = dir.vec();
        let mut best: Option<(i64, usize)> = None;
        for (j, b) in self.boxes.iter().enumerate() {
            if j == from {
                continue;
            }
            let (bcx, bcy) = b.center();
            let ddx = (bcx - acx) as i64;
            let ddy = (bcy - acy) as i64;
            let along = ddx * dx as i64 + ddy * dy as i64;
            if along <= 0 {
                continue;
            }
            let perp = if dx != 0 { ddy.abs() } else { ddx.abs() };
            let score = along * 2 + perp;
            if best.map_or(true, |(s, _)| score < s) {
                best = Some((score, j));
            }
        }
        best.map(|(_, j)| j)
    }

    /// Display names: first line of each box; `box<N>` fallback; deduped with ` (n)`.
    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .boxes
            .iter()
            .enumerate()
            .map(|(i, b)| {
                b.lines()
                    .first()
                    .map(|l| l.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| format!("box{}", i + 1))
            })
            .collect();
        let mut seen: HashMap<String, i32> = HashMap::new();
        for name in names.iter_mut() {
            let count = seen.entry(name.clone()).or_insert(0);
            *count += 1;
            if *count > 1 {
                *name = format!("{} ({})", name, count);
            }
        }
        names
    }

    /// Structured spec for an LLM: boxes as sections, edges as `a -> b`.
    pub fn spec_md(&self) -> String {
        let names = self.names();
        let mut s = String::from("# Mindboard\n\n");
        if self.boxes.is_empty() {
            s.push_str("_empty board_\n");
            return s;
        }
        s.push_str("## Boxes\n");
        for (i, b) in self.boxes.iter().enumerate() {
            s.push_str(&format!("\n### {}\n", names[i]));
            let body = b.text.lines().skip(1).collect::<Vec<&str>>().join("\n");
            let body = body.trim();
            if !body.is_empty() {
                s.push_str(body);
                s.push('\n');
            }
        }
        s.push_str("\n## Edges\n");
        if self.edges.is_empty() {
            s.push_str("_none_\n");
        } else {
            for e in &self.edges {
                s.push_str(&format!("- {} -> {}\n", names[e.from], names[e.to]));
            }
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board() -> Board {
        let mut b = Board::default();
        b.add_box(0, 0, "auth\nlogin and tokens".into());
        b.add_box(20, 0, "db".into());
        b.add_box(10, 10, "api".into());
        b.edges.push(Edge { from: 0, to: 1 });
        b
    }

    #[test]
    fn spec_contains_boxes_and_edges() {
        let s = board().spec_md();
        assert!(s.contains("### auth"));
        assert!(s.contains("login and tokens"));
        assert!(s.contains("- auth -> db"));
    }

    #[test]
    fn nearest_prefers_direction() {
        let b = board();
        assert_eq!(b.nearest(2, Dir::K), Some(0));
        assert_eq!(b.nearest(0, Dir::L), Some(2));
        assert_eq!(b.nearest(1, Dir::H), Some(2));
    }

    #[test]
    fn remove_box_drops_edges() {
        let mut b = board();
        b.remove(0);
        assert_eq!(b.boxes.len(), 2);
        assert_eq!(b.edges.len(), 0);
    }

    #[test]
    fn names_dedupe() {
        let mut b = Board::default();
        b.add_box(0, 0, "x".into());
        b.add_box(0, 0, "x".into());
        assert_eq!(b.names(), vec!["x".to_string(), "x (2)".to_string()]);
    }

    #[test]
    fn width_clamps() {
        let short = BoxT { x: 0, y: 0, text: "hi".into() };
        assert_eq!(short.width_cells(), 6);
        let long = BoxT { x: 0, y: 0, text: "a".repeat(99).into() };
        assert_eq!(long.width_cells(), 48);
    }
}
