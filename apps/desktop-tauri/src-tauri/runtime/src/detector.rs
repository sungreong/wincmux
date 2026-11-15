use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::LazyLock,
    time::{Duration, Instant},
};
use uuid::Uuid;

static ANSI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]").unwrap()
});
static PASTE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\x1b\[200~.*?\x1b\[201~").unwrap());
static ASSISTANT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:claude|codex|gpt-\S+|sonnet|opus)\b").unwrap());
static RESUME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(claude|codex)\s+(--resume|--session|resume)\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:[^0-9a-f-]|$)").unwrap()
});
static READY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)\?\s*for\s*shortcuts|ready to help|what would you like to work on|how can i help|what can i help|anything else|(?:waiting|ready)[^.\n]{0,80}(?:request|input|prompt|instructions)|^\s*[›>]\s*$|대기\s*중입니다|도와드릴까요|필요하실\s*때\s*말씀").unwrap()
});
static APPROVAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)do\s+you\s+want\s+to\s+(?:proceed|continue)\s*\?|(?:waiting|awaiting|need)\s+(?:for\s+)?(?:your\s+)?(?:input|response|confirmation|approval)|run\s+shell\s+command|enter\s+to\s+confirm|esc\s+to\s+cancel|(?:press|hit)\s+enter|\b(?:select|choose)[^.\n]{0,80}\b(?:option|number|choice)|\by\s*/\s*n\b|(?:진행|계속).{0,8}(?:하시겠|할까)|(?:선택|번호).{0,8}(?:입력|해\s*주세요|하세요)|(?:입력을?\s*기다리고|응답을?\s*기다리고)|(?:실행|수정|변경|진행|계속|허용|승인).{0,16}(?:할까요|하시겠습니까|해도\s*될까요)").unwrap()
});
static ACTIVITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)thinking|working|processing|analyzing|summariz|searching|reading|editing|writing|완료|진행|응답|생각|분석|처리|작업|수정|작성|검색|확인|알겠습니다|안녕하세요|[가-힣].{10,}|[.!?]").unwrap()
});

static RESUME_FAILED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)conversation[^\n]{0,180}not\s+found|no\s+conversation").unwrap()
});
static SESSION_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f-]{13,}\b").unwrap());

pub fn missing_conversation(output: &str) -> Option<&str> {
    if !RESUME_FAILED.is_match(output) {
        return None;
    }
    SESSION_TOKEN.find(output).map(|matched| matched.as_str())
}

pub struct Notice {
    pub kind: &'static str,
    pub title: &'static str,
    pub body: String,
    pub key: String,
    pub source: &'static str,
}

pub struct Resume {
    pub tool: String,
    pub cmd: String,
}

#[derive(Default)]
pub struct Conversation {
    assistant: bool,
    state: &'static str,
    source: &'static str,
    reason: String,
    revision: u64,
    changed: bool,
    explicit: bool,
    reported: &'static str,
    osc: String,
    escape: bool,
    input: String,
    output: String,
    turn: u64,
    done: u64,
    last_output: Option<Instant>,
    approval: String,
    resume_seen: HashSet<String>,
}

impl Conversation {
    pub fn new(command: &str, args: &[String]) -> Self {
        let assistant =
            ASSISTANT.is_match(command) || args.iter().any(|arg| ASSISTANT.is_match(arg));
        Self {
            assistant,
            state: "unknown",
            source: "none",
            ..Self::default()
        }
    }

    fn set_state(&mut self, state: &'static str, source: &'static str, reason: &str) {
        if self.state != state || self.source != source || self.reason != reason {
            self.state = state;
            self.source = source;
            self.reason = reason.chars().take(220).collect();
            self.revision += 1;
            self.changed = true;
        }
    }

    pub fn snapshot(&self) -> Value {
        json!({"state":self.state,"source":self.source,"reason":self.reason,"revision":self.revision})
    }

    pub fn take_update(&mut self) -> Option<Value> {
        if !std::mem::take(&mut self.changed) {
            return None;
        }
        Some(self.snapshot())
    }

    pub fn acknowledge(&mut self, revision: u64) {
        if self.state == "done" && self.revision == revision {
            self.set_state("idle", self.source, "Result acknowledged");
        }
    }

    // Keep control sequences across arbitrary PTY chunk boundaries. Other OSCs
    // are ignored by the detector, while the original stream still goes to xterm.
    fn parse_status(&mut self, text: &str) -> String {
        let mut visible = String::new();
        for ch in text.chars() {
            if !self.osc.is_empty() {
                if ch == '\u{7}' || (ch == '\\' && self.osc.ends_with('\u{1b}')) {
                    let payload = std::mem::take(&mut self.osc);
                    let payload = payload.trim_end_matches('\u{1b}');
                    if let Some(fields) = payload.strip_prefix("]7501;") {
                        if let Some(state) =
                            fields.split(':').find_map(|f| f.strip_prefix("state="))
                        {
                            let state = match state {
                                "working" => Some("working"),
                                "blocked" => Some("blocked"),
                                "done" => Some("done"),
                                "idle" => Some("idle"),
                                "error" => Some("error"),
                                _ => None,
                            };
                            if let Some(state) = state {
                                self.explicit = true;
                                self.assistant = true;
                                self.last_output = None;
                                // Repeated done reports must not undo a user's acknowledgement.
                                let duplicate_done = state == "done"
                                    && self.reported == "done"
                                    && self.state == "idle";
                                let unread_idle = state == "idle" && self.state == "done";
                                self.reported = state;
                                if !duplicate_done && !unread_idle {
                                    self.set_state(
                                        state,
                                        "osc7501",
                                        "Program reported status through OSC 7501",
                                    );
                                }
                            }
                        }
                    }
                } else if self.osc.len() < 4096 {
                    self.osc.push(ch);
                } else {
                    // Discard an oversized payload until its terminator.
                    self.osc.clear();
                    self.osc.push('!');
                    self.osc.push(ch);
                }
            } else if self.escape {
                self.escape = false;
                if ch == ']' {
                    self.osc.push(']');
                } else {
                    visible.push('\u{1b}');
                    visible.push(ch);
                }
            } else if ch == '\u{1b}' {
                self.escape = true;
            } else {
                visible.push(ch);
            }
        }
        visible
    }

    pub fn input(&mut self, text: &str) {
        self.input.push_str(text);
        keep_tail(&mut self.input, 800);
        self.assistant |= ASSISTANT.is_match(&self.input);
        let keys = PASTE.replace_all(text, "");
        if keys.contains(['\r', '\n']) {
            self.turn += 1;
            self.output.clear();
            self.last_output = None;
            self.approval.clear();
            if self.assistant && !self.explicit {
                self.set_state("working", "pattern", "Submitted agent input");
            }
        }
    }

    pub fn output(&mut self, text: &str) -> (Option<Notice>, Option<Resume>) {
        let previous = self.revision;
        let visible = self.parse_status(text);
        self.output.push_str(&visible);
        keep_tail(&mut self.output, 8_192);
        let clean = ANSI.replace_all(&self.output, "").replace(['\r', '\0'], "");
        self.assistant |= ASSISTANT.is_match(&clean);
        let resume = RESUME.captures(&clean).and_then(|matched| {
            let tool = matched[1].to_lowercase();
            let command = matched[2].to_lowercase();
            if tool == "claude" && command != "--resume" {
                return None;
            }
            let uuid = Uuid::parse_str(&matched[3]).ok()?;
            let cmd = if tool == "claude" {
                format!("claude --resume {uuid}")
            } else {
                format!("codex resume {uuid}")
            };
            self.resume_seen
                .insert(cmd.clone())
                .then_some(Resume { tool, cmd })
        });
        if self.explicit || !self.assistant {
            let notice = if self.explicit && self.revision != previous {
                match self.state {
                    "done" | "blocked" | "error" => Some(Notice {
                        kind: if self.state == "done" {
                            "task_done"
                        } else {
                            "assistant_prompt"
                        },
                        title: if self.state == "done" {
                            "Assistant response completed"
                        } else {
                            "Assistant needs attention"
                        },
                        body: self.reason.clone(),
                        key: format!("status:{}", self.revision),
                        source: "osc7501",
                    }),
                    _ => None,
                }
            } else {
                None
            };
            return (notice, resume);
        }
        let recent = tail(&clean, 1_600);
        if let Some(found) = APPROVAL.find(recent) {
            let body = found
                .as_str()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if body != self.approval {
                self.approval = body.clone();
                self.last_output = None;
                self.set_state("blocked", "pattern", &body);
                return (
                    Some(Notice {
                        kind: "assistant_prompt",
                        source: "pattern",
                        title: "Assistant needs input",
                        key: body.to_lowercase(),
                        body,
                    }),
                    resume,
                );
            }
            return (None, resume);
        }
        if self.turn > self.done && ACTIVITY.is_match(recent) {
            self.set_state("working", "pattern", "Agent output activity");
            self.last_output = Some(Instant::now());
            if READY.is_match(recent) {
                return (self.complete(&clean), resume);
            }
        }
        (None, resume)
    }

    pub fn idle(&mut self) -> Option<Notice> {
        if !self
            .last_output
            .is_some_and(|time| time.elapsed() >= Duration::from_millis(3500))
        {
            return None;
        }
        self.last_output = None;
        if !self.explicit && self.state == "working" {
            self.set_state(
                "unknown",
                "pattern",
                "Output paused; completion is unconfirmed",
            );
        }
        None
    }

    fn complete(&mut self, text: &str) -> Option<Notice> {
        if self.turn <= self.done {
            return None;
        }
        self.set_state("done", "pattern", "Agent ready prompt detected");
        self.done = self.turn;
        self.last_output = None;
        let mut lines: Vec<_> = text
            .lines()
            .rev()
            .map(str::trim)
            .filter(|line| {
                !line.is_empty() && !READY.is_match(line) && line.chars().any(char::is_alphanumeric)
            })
            .take(3)
            .collect();
        lines.reverse();
        let body: String = lines.join(" ").chars().take(220).collect();
        Some(Notice {
            kind: "task_done",
            source: "pattern",
            title: "Assistant response completed",
            body,
            key: format!("turn:{}", self.turn),
        })
    }
}

fn tail(text: &str, max: usize) -> &str {
    let mut index = text.len().saturating_sub(max);
    while !text.is_char_boundary(index) {
        index += 1;
    }
    &text[index..]
}

fn keep_tail(text: &mut String, max: usize) {
    let trim = text.len() - tail(text, max).len();
    if trim > 0 {
        text.drain(..trim);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc_status_survives_every_chunk_boundary_and_overrides_patterns() {
        let report = "\x1b]7501;state=working:app=custom\x1b\\";
        for split in 0..=report.len() {
            let mut d = Conversation::new("powershell", &[]);
            d.output(&report[..split]);
            d.output(&report[split..]);
            assert_eq!(d.snapshot()["state"], "working");
            d.output("Do you want to proceed? ready to help");
            assert_eq!(d.snapshot()["state"], "working");
            assert_eq!(d.snapshot()["source"], "osc7501");
        }
    }

    #[test]
    fn silence_is_unknown_never_completion() {
        let mut d = Conversation::new("codex", &[]);
        d.input("fix bug\r");
        d.output("Working on the change.");
        d.last_output = Some(Instant::now() - Duration::from_secs(5));
        assert!(d.idle().is_none());
        assert_eq!(d.snapshot()["state"], "unknown");
    }

    #[test]
    fn acknowledgement_is_revision_guarded_and_does_not_clear_blocked() {
        let mut d = Conversation::new("codex", &[]);
        assert!(d.output("\x1b]7501;state=done\x07").0.is_some());
        let revision = d.revision;
        d.acknowledge(revision);
        assert_eq!(d.snapshot()["state"], "idle");
        assert!(d.output("\x1b]7501;state=done\x07").0.is_none());
        d.output("\x1b]7501;state=working\x07");
        d.output("\x1b]7501;state=done\x07");
        d.acknowledge(revision);
        assert_eq!(d.snapshot()["state"], "done");
        d.output("\x1b]7501;state=blocked\x07");
        d.acknowledge(d.revision);
        assert_eq!(d.snapshot()["state"], "blocked");
    }

    #[test]
    fn program_idle_does_not_acknowledge_an_unread_result() {
        let mut d = Conversation::new("codex", &[]);
        d.output("\x1b]7501;state=done\x07");
        d.output("\x1b]7501;state=idle\x07");
        assert_eq!(d.snapshot()["state"], "done");
        d.acknowledge(d.revision);
        assert_eq!(d.snapshot()["state"], "idle");
        d.output("\x1b]7501;state=done\x07");
        assert_eq!(d.snapshot()["state"], "done");
    }

    #[test]
    fn invalid_and_unrelated_oscs_do_not_disable_pattern_detection() {
        let mut d = Conversation::new("codex", &[]);
        d.input("fix\r");
        d.output("\x1b]0;state=done\x07\x1b]7501;state=bogus\x07");
        assert!(!d.explicit);
        assert!(d.output("Do you want to proceed?").0.is_some());
        assert_eq!(d.snapshot()["state"], "blocked");
    }

    #[test]
    fn draft_and_resume_preserve_turn_state() {
        let mut detector = Conversation::new("claude.exe", &[]);
        detector.input("\x1b[200~한글\n질문\x1b[201~");
        assert!(detector
            .output("답변을 작성했습니다.\n? for shortcuts")
            .0
            .is_none());
        detector.input("\r");
        assert_eq!(
            detector
                .output("답변을 작성했습니다.\n? for shortcuts")
                .0
                .unwrap()
                .kind,
            "task_done"
        );
        let resume = "\nclaude --resume 30ae6541-c5a7-47ab-bc93-354686339f5b";
        assert!(detector.output(resume).1.is_some());
        assert!(detector.output(resume).1.is_none());
    }
}
