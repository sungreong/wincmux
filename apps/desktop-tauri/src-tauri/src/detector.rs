use regex::Regex;
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
}

pub struct Resume {
    pub tool: String,
    pub cmd: String,
}

#[derive(Default)]
pub struct Conversation {
    assistant: bool,
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
            ..Self::default()
        }
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
        }
    }

    pub fn output(&mut self, text: &str) -> (Option<Notice>, Option<Resume>) {
        self.output.push_str(text);
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
        if !self.assistant {
            return (None, resume);
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
                return (
                    Some(Notice {
                        kind: "assistant_prompt",
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
        let clean = ANSI.replace_all(&self.output, "").into_owned();
        self.complete(&clean)
    }

    fn complete(&mut self, text: &str) -> Option<Notice> {
        if self.turn <= self.done {
            return None;
        }
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
