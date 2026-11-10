use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

const HISTORY_BYTES: usize = 600_000;

#[derive(Default)]
pub struct History {
    chunks: VecDeque<String>,
    start: usize,
    end: usize,
    read_at: usize,
}

impl History {
    pub fn append(&mut self, chunk: &str) -> usize {
        self.end += chunk.len();
        self.chunks.push_back(chunk.into());
        let keep_from = self.end.saturating_sub(HISTORY_BYTES);
        while self.start < keep_from {
            let first = self
                .chunks
                .front_mut()
                .expect("history contains pending bytes");
            let trim = keep_from - self.start;
            if trim >= first.len() {
                self.start += first.len();
                self.chunks.pop_front();
            } else {
                let trim = boundary_after(first, trim);
                self.start += trim;
                first.drain(..trim);
            }
        }
        self.end
    }

    fn slice(&self, start: usize, end: usize) -> (String, usize) {
        let start = start.clamp(self.start, self.end);
        let end = end.clamp(start, self.end);
        let mut result = String::with_capacity(end - start);
        let mut offset = self.start;
        let mut consumed = start;
        for chunk in &self.chunks {
            let next = offset + chunk.len();
            if next > start && offset < end {
                let lo = boundary_after(chunk, start.saturating_sub(offset));
                let hi = boundary_after(chunk, (end - offset).min(chunk.len()));
                result.push_str(&chunk[lo..hi]);
                consumed = offset + hi;
            }
            if next >= end {
                break;
            }
            offset = next;
        }
        (result, consumed)
    }

    pub fn tail(&self, limit: usize, after: Option<usize>) -> (String, usize) {
        let from = after
            .unwrap_or_else(|| self.end.saturating_sub(limit))
            .clamp(self.start, self.end);
        self.slice(
            from,
            self.end.min(from.saturating_add(limit)).max(self.start),
        )
    }

    pub fn end_offset(&self) -> usize {
        self.end
    }

    pub fn read(&mut self, limit: usize) -> (String, usize) {
        let from = self.read_at.max(self.start);
        let result = self.slice(from, from.saturating_add(limit));
        self.read_at = result.1;
        result
    }
}

fn boundary_after(s: &str, mut index: usize) -> usize {
    while !s.is_char_boundary(index) {
        index += 1;
    }
    index
}

#[derive(Default)]
struct Utf8Decoder(Vec<u8>);

impl Utf8Decoder {
    fn push(&mut self, chunk: &[u8]) -> String {
        self.0.extend_from_slice(chunk);
        let mut rest = self.0.as_slice();
        let mut output = String::with_capacity(rest.len());
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    output.push_str(text);
                    rest = &[];
                    break;
                }
                Err(error) => {
                    let (valid, invalid) = rest.split_at(error.valid_up_to());
                    output.push_str(std::str::from_utf8(valid).expect("validated UTF-8 prefix"));
                    let Some(length) = error.error_len() else {
                        rest = invalid;
                        break;
                    };
                    output.push('\u{fffd}');
                    rest = &invalid[length..];
                }
            }
        }
        let consumed = self.0.len() - rest.len();
        self.0.drain(..consumed);
        output
    }
}

pub struct Terminal {
    pub pid: u32,
    pub workspace: String,
    pub history: Arc<Mutex<History>>,
    alive: AtomicBool,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

pub struct Spawned {
    pub terminal: Arc<Terminal>,
    reader: Box<dyn Read + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Spawned {
    pub fn new(cmd: &str, args: &[String], cwd: &Path, workspace: &str) -> Result<Self, String> {
        let pair = native_pty_system()
            .openpty(size(120, 30))
            .map_err(string_error)?;
        let mut command = CommandBuilder::new(cmd);
        command.args(args);
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "wincmux");
        for (key, fallback) in [
            ("LANG", "ko_KR.UTF-8"),
            ("LC_ALL", "ko_KR.UTF-8"),
            ("LC_CTYPE", "ko_KR.UTF-8"),
            ("PYTHONUTF8", "1"),
            ("PYTHONIOENCODING", "utf-8"),
        ] {
            command.env(key, std::env::var(key).unwrap_or_else(|_| fallback.into()));
        }
        let reader = pair.master.try_clone_reader().map_err(string_error)?;
        let writer = pair.master.take_writer().map_err(string_error)?;
        let child = pair.slave.spawn_command(command).map_err(string_error)?;
        let terminal = Arc::new(Terminal {
            pid: child.process_id().unwrap_or_default(),
            workspace: workspace.into(),
            history: Arc::default(),
            alive: AtomicBool::new(true),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(child.clone_killer()),
        });
        Ok(Self {
            terminal,
            reader,
            child,
        })
    }

    pub fn run(
        self,
        mut on_output: impl FnMut(String, usize) + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) {
        let Self {
            terminal,
            mut reader,
            mut child,
        } = self;
        let history = Arc::clone(&terminal.history);
        let input = Arc::clone(&terminal);
        let output = thread::spawn(move || {
            let mut buffer = [0; 16 * 1024];
            let mut decoder = Utf8Decoder::default();
            let mut startup = Some(String::new());
            loop {
                let count = match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
                let mut text = decoder.push(&buffer[..count]);
                if let Some(mut prefix) = startup.take() {
                    const CURSOR_QUERY: &str = "\x1b[6n";
                    prefix.push_str(&text);
                    if prefix.len() < CURSOR_QUERY.len() && CURSOR_QUERY.starts_with(&prefix) {
                        startup = Some(prefix);
                        continue;
                    }
                    // portable-pty enables PSEUDOCONSOLE_INHERIT_CURSOR. Answer the
                    // startup query even if this pane has no attached WebView yet.
                    if prefix.starts_with(CURSOR_QUERY) && input.write("\x1b[1;1R").is_ok() {
                        prefix.drain(..CURSOR_QUERY.len());
                    }
                    text = prefix;
                }
                if !text.is_empty() {
                    let end = history.lock().unwrap().append(&text);
                    on_output(text, end);
                }
            }
        });
        thread::spawn(move || {
            let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
            terminal.alive.store(false, Ordering::Release);
            terminal.writer.lock().unwrap().take();
            // Drain the output on its dedicated thread while the pseudoconsole closes.
            let master = terminal.master.lock().unwrap().take();
            drop(master);
            let _ = output.join();
            on_exit(code);
        });
    }
}

impl Terminal {
    pub fn write(&self, text: &str) -> Result<(), String> {
        let mut writer = self.writer.lock().unwrap();
        writer
            .as_mut()
            .ok_or("PTY session not attached")?
            .write_all(text.as_bytes())
            .map_err(string_error)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("PTY session not attached")?
            .resize(size(cols, rows))
            .map_err(string_error)
    }

    pub fn close(&self) {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        #[cfg(windows)]
        if self.pid != 0
            && hidden_command("taskkill")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .output()
                .is_ok_and(|result| result.status.success())
        {
            return;
        }
        let _ = self.killer.lock().unwrap().kill();
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub fn hidden_command(program: &str) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

fn string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_decoder_preserves_korean_spaces_and_vt_across_byte_boundaries() {
        let text = "한글  A   가가가 🧪\x1b[31m\r\n";
        let mut decoder = Utf8Decoder::default();
        let decoded: String = text
            .as_bytes()
            .iter()
            .map(|byte| decoder.push(&[*byte]))
            .collect();
        assert_eq!(decoded, text);
    }

    #[test]
    fn history_offsets_and_reads_stay_on_utf8_boundaries() {
        let mut history = History::default();
        assert_eq!(history.append("가나  🧪"), 12);
        assert_eq!(history.read(1), ("가".into(), 3));
        assert_eq!(history.read(3), ("나".into(), 6));
        assert_eq!(history.tail(5, None).0, " 🧪");
        assert_eq!(history.tail(8, Some(3)), ("나  🧪".into(), 12));
        history.append(&"가".repeat(HISTORY_BYTES / 3 + 2));
        assert_eq!(history.tail(HISTORY_BYTES, None).0.len(), HISTORY_BYTES);
    }
}
