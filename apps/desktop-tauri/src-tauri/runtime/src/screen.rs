use serde_json::{json, Value};
use std::{collections::VecDeque, num::NonZeroU16};

const SCROLL_BYTES: usize = 256 * 1024;
#[derive(Default)]
struct Callbacks {
    rows: VecDeque<String>,
    bytes: usize,
    replies: String,
}
impl vt100::Callbacks for Callbacks {
    fn on_scroll(&mut self, row: vt100::capture::RowContents<'_>, alternate: bool) {
        if alternate {
            return;
        }
        let mut text = String::from("\x1b[0m");
        let _ = row.write_formatted_basic(&mut text, &mut Default::default());
        text.push_str("\x1b[0m\r\n");
        self.bytes += text.len();
        self.rows.push_back(text);
        while self.bytes > SCROLL_BYTES {
            self.bytes -= self.rows.pop_front().unwrap().len();
        }
    }
    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        i: Option<u8>,
        _: Option<u8>,
        p: &[&[u16]],
        c: char,
    ) {
        let first = p.first().and_then(|p| p.first()).copied().unwrap_or(0);
        match (i, c, first) {
            (None, 'n', 6) => {
                let (r, c) = screen.cursor_position();
                self.replies.push_str(&format!("\x1b[{};{}R", r + 1, c + 1));
            }
            (Some(b'?'), 'n', 6) => {
                let (r, c) = screen.cursor_position();
                self.replies
                    .push_str(&format!("\x1b[?{};{}R", r + 1, c + 1));
            }
            (None, 'n', 5) => self.replies.push_str("\x1b[0n"),
            (None, 'c', 0) => self.replies.push_str("\x1b[?1;2c"),
            (Some(b'>'), 'c', 0) => self.replies.push_str("\x1b[>0;276;0c"),
            _ => {}
        }
    }
}
pub struct Screen {
    parser: vt100::Parser<Callbacks>,
}
impl Default for Screen {
    fn default() -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(
                NonZeroU16::new(30).unwrap(),
                NonZeroU16::new(120).unwrap(),
                0,
                Callbacks::default(),
            ),
        }
    }
}
impl Screen {
    pub fn process(&mut self, text: &str) -> String {
        self.parser.process(text.as_bytes());
        std::mem::take(&mut self.parser.callbacks_mut().replies)
    }
    pub fn validate_size(cols: u16, rows: u16) -> Result<(), String> {
        // Two fixed-size cell grids plus serialization must fit the 8 MiB budget.
        if cols == 0 || rows == 0 || (cols as usize) * (rows as usize) > 32_768 {
            return Err("terminal screen exceeds the 8 MiB state budget".into());
        }
        Ok(())
    }
    pub fn size(&self) -> (u16, u16) {
        let (rows, cols) = self.parser.screen().size();
        (cols.get(), rows.get())
    }
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.parser.set_size(
            NonZeroU16::new(rows).unwrap(),
            NonZeroU16::new(cols).unwrap(),
        );
    }
    pub fn snapshot(&self, end: usize) -> Value {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let mut history = String::new();
        for row in &self.parser.callbacks().rows {
            history.push_str(row);
        }
        // Push retained lines into xterm's scrollback before painting its viewport.
        if !history.is_empty() {
            history.push_str(&"\r\n".repeat(rows.get() as usize));
        }
        json!({"screen":screen.wincmux_snapshot(),"history":history,"rows":rows.get(),"cols":cols.get(),"end_offset":end})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restores_both_buffers_modes_and_korean() {
        let mut s = Screen::default();
        s.process("normal 한글  A\x1b[?1049h\x1b[31mALT\x1b[?2004h");
        let snapshot = s.snapshot(42);
        let mut t = Screen::default();
        t.process(snapshot["screen"].as_str().unwrap());
        assert!(t.parser.screen().alternate_screen());
        assert!(t.parser.screen().bracketed_paste());
        assert_eq!(t.parser.screen().contents(), s.parser.screen().contents());
        s.process("\x1b[?1049l");
        t.process("\x1b[?1049l");
        assert_eq!(t.parser.screen().contents(), s.parser.screen().contents());
    }
    #[test]
    fn queries_work_without_viewer_and_sizes_are_bounded() {
        let mut s = Screen::default();
        assert_eq!(s.process("\x1b[6n"), "\x1b[1;1R");
        assert!(Screen::validate_size(32767, 32767).is_err());
        for _ in 0..12000 {
            s.process("line 한글\r\n");
        }
        assert!(s.parser.callbacks().bytes <= SCROLL_BYTES);
    }
}
