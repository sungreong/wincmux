use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    hash::{Hash, Hasher},
    num::NonZeroU16,
    sync::LazyLock,
};

const SCROLL_BYTES: usize = 256 * 1024;
static DONE_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bfor\s+\d+(?:\.\d+)?\s*s\s*[·•]\s*done(?:\s|$)").unwrap());
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

#[derive(Clone, Copy, Default)]
pub struct PromptState {
    pub visible: bool,
    pub empty: bool,
    pub startup_ready: bool,
    pub gemini_composer: bool,
    pub completion_visible: bool,
    pub completion_fingerprint: Option<u64>,
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
    pub fn bracketed_paste(&self) -> bool {
        self.parser.screen().bracketed_paste()
    }
    pub fn prompt_state(&self) -> PromptState {
        let screen = self.parser.screen();
        let (cursor_row, cursor_col) = screen.cursor_position();
        let (_, cols) = screen.size();
        let rows: Vec<String> = screen.rows(0, cols.get()).collect();
        let at = cursor_row as usize;
        let Some(line) = rows.get(at) else {
            return PromptState::default();
        };
        let trimmed = line.trim_start();
        let suffix = trimmed
            .strip_prefix('›')
            .or_else(|| trimmed.strip_prefix('❯'))
            .or_else(|| trimmed.strip_prefix('>'));
        match suffix {
            Some(rest) => {
                let rule = |row: Option<&String>| {
                    row.is_some_and(|row| {
                        let text = row.trim();
                        text.chars().count() >= 8 && text.chars().all(|ch| ch == '─')
                    })
                };
                let claude_chrome = at > 0
                    && rule(rows.get(at - 1))
                    && rule(rows.get(at + 1))
                    && rows
                        .iter()
                        .take(at)
                        .any(|row| row.contains("Claude Code v"))
                    && rows
                        .iter()
                        .skip(at + 2)
                        .take(3)
                        .any(|row| row.contains("shift+tab to cycle"));
                let placeholder_at_cursor = cursor_col as usize
                    <= line.chars().take_while(|ch| ch.is_whitespace()).count() + 2;
                let placeholder = rest.trim().starts_with("Try \"")
                    && rest.trim().ends_with('"')
                    && placeholder_at_cursor;
                let codex_chrome = rows
                    .iter()
                    .skip(at + 1)
                    .take(8)
                    .any(|row| row.contains("? for shortcuts"));
                let gemini_composer =
                    placeholder_at_cursor && rest.trim() == "Type your message or @path/to/file";
                let empty = rest.trim().is_empty()
                    || (claude_chrome && placeholder)
                    || gemini_composer
                    || (codex_chrome
                        && placeholder_at_cursor
                        && rest.trim() == "Ask Codex to do anything");
                let done_lines: Vec<_> = rows
                    .iter()
                    .take(at)
                    .enumerate()
                    .filter(|(_, row)| DONE_LINE.is_match(row))
                    .collect();
                let completion_fingerprint = (!done_lines.is_empty()).then(|| {
                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                    for (index, line) in &done_lines {
                        index.hash(&mut hasher);
                        line.hash(&mut hasher);
                    }
                    hasher.finish()
                });
                PromptState {
                    visible: true,
                    empty,
                    startup_ready: empty && (claude_chrome || codex_chrome),
                    gemini_composer,
                    completion_visible: completion_fingerprint.is_some(),
                    completion_fingerprint,
                }
            }
            None => PromptState::default(),
        }
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
    pub fn text_snapshot(&self) -> Value {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let (cursor_row, cursor_col) = screen.cursor_position();
        let lines: Vec<String> = screen
            .rows(0, cols.get())
            .map(|row| row.trim_end().to_owned())
            .collect();
        json!({
            "lines":lines,
            "rows":rows.get(),
            "cols":cols.get(),
            "cursor_row":cursor_row,
            "cursor_col":cursor_col,
            "bracketed_paste":screen.bracketed_paste(),
        })
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
    #[test]
    fn claude_startup_suggestion_is_an_empty_composer_not_a_typed_draft() {
        let mut screen = Screen::default();
        screen.process("\x1b[?2004h\x1b[1;1HClaude Code v2.1.326\x1b[10;1H────────────────────\x1b[11;1H❯ Try \"write a test for <filepath>\"\x1b[12;1H────────────────────\x1b[13;1H  ▸▸ auto mode on (shift+tab to cycle)\x1b[11;3H");
        let prompt = screen.prompt_state();
        assert!(prompt.visible && prompt.empty && prompt.startup_ready);
        screen.process("\x1b[11;1H\x1b[2K❯ 내가 입력한 글");
        let draft = screen.prompt_state();
        assert!(draft.visible && !draft.empty && !draft.startup_ready);
        screen.process("\x1b[11;1H\x1b[2K❯ Try \"write a test for <filepath>\"");
        assert!(
            !screen.prompt_state().empty,
            "typed placeholder text remains a draft"
        );
    }
    #[test]
    fn claude_logo_and_nonbreaking_space_still_identify_the_initial_composer() {
        let mut screen = Screen::default();
        screen.process("\x1b[?2004h\x1b[1;1H ▐▛███▛█   Claude Code v2.1.326\x1b[10;1H────────────────────\x1b[11;1H❯\u{a0}Try \"edit <filepath> to…\"\x1b[12;1H────────────────────\x1b[13;1H  ⏵⏵ auto mode on (shift+tab to cycle)\x1b[11;3H");
        let prompt = screen.prompt_state();
        assert!(prompt.visible && prompt.empty && prompt.startup_ready);
    }
    #[test]
    fn narrow_codex_footer_wrap_does_not_make_empty_composer_look_typed() {
        let mut screen = Screen::default();
        screen.resize(61, 35);
        screen.process("\x1b[?2004h\x1b[31;1H› Ask Codex to do anything\x1b[35;1H  ← for agents · ? for shortcuts   ⚠ 7 warnings · f2 to view\x1b[31;3H");
        let prompt = screen.prompt_state();
        assert!(prompt.visible && prompt.empty && prompt.startup_ready);
        screen.process("\x1b[31;1H\x1b[2K› 내가 작성한 내용\x1b[31;12H");
        assert!(!screen.prompt_state().empty);
    }
    #[test]
    fn gemini_placeholder_is_empty_but_a_typed_draft_is_not() {
        let mut screen = Screen::default();
        screen.process("\x1b[?2004h\x1b[10;1H>   Type your message or @path/to/file\x1b[10;3H");
        let prompt = screen.prompt_state();
        assert!(prompt.visible && prompt.empty && prompt.gemini_composer);
        screen.process("\x1b[10;1H\x1b[2K> Review changes\x1b[10;17H");
        let draft = screen.prompt_state();
        assert!(draft.visible && !draft.empty && !draft.gemini_composer);
    }
    #[test]
    fn text_snapshot_reports_the_visible_grid_and_input_mode() {
        let mut screen = Screen::default();
        screen.process("\x1b[?2004h\x1b[3;1Hanswer\x1b[10;1H> ready\x1b[10;3H");
        let text = screen.text_snapshot();
        assert_eq!(text["lines"][2], "answer");
        assert_eq!(text["lines"][9], "> ready");
        assert_eq!(text["cursor_row"], 9);
        assert_eq!(text["bracketed_paste"], true);
    }
    #[test]
    fn visible_claude_completion_is_detected_next_to_the_composer() {
        let mut screen = Screen::default();
        screen.process("\x1b[?2004h\x1b[8;1H✻ Crunched for 1s · done 오후 8:36\x1b[10;1H────────────────────\x1b[11;1H❯ \x1b[12;1H────────────────────\x1b[11;3H");
        assert!(screen.prompt_state().completion_visible);
    }
}
