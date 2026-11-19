use crate::screen::PromptState;
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
    LazyLock::new(|| Regex::new(r"(?i)\b(?:claude|codex|gemini|gpt-\S+|sonnet|opus)\b").unwrap());
static AGENT_LAUNCH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)(?:^|[\r\n])\s*(?:&\s*)?(?:'[^']*[\\/])?(?:codex|claude|gemini)(?:\.(?:exe|cmd|ps1))?'?(?:\s|$)")
        .unwrap()
});
static GEMINI_LAUNCH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?im)(?:^|[\r\n])\s*(?:&\s*)?(?:'[^']*[\\/])?gemini(?:\.(?:exe|cmd|ps1))?'?(?:\s|$)",
    )
    .unwrap()
});
static RESUME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(claude|codex)\s+(--resume|--session|resume)\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:[^0-9a-f-]|$)").unwrap()
});
static READY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)\?\s*for\s*shortcuts|ready to help|what would you like to work on|how can i help|what can i help|anything else|(?:waiting|ready)[^.\n]{0,80}(?:request|input|prompt|instructions)|^\s*[›>]\s*$|대기\s*중입니다|도와드릴까요|필요하실\s*때\s*말씀").unwrap()
});
static DONE_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bfor\s+\d+(?:\.\d+)?\s*s\s*[·•]\s*done\b").unwrap());
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
    hook_provider: Option<String>,
    hook_agent_id: Option<String>,
    hook_event: Option<String>,
    hook_turn_id: Option<String>,
    hook_count: u64,
    hook_completed_count: u64,
    terminal_completed_count: u64,
    last_terminal_output: Option<Instant>,
    screen_prompt_visible: bool,
    screen_prompt_empty: bool,
    screen_agent_composer: bool,
    screen_done_fingerprint: Option<u64>,
    submitted_done_fingerprint: Option<u64>,
    startup_ready_seen: bool,
    agent_turn_submitted: bool,
    hook_seen_at: Option<u64>,
    hook_active: bool,
    awaiting_prompt_hook: bool,
    gemini_session: bool,
    gemini_title: &'static str,
    gemini_working_seen: bool,
}

impl Conversation {
    pub fn new(command: &str, args: &[String]) -> Self {
        let assistant =
            ASSISTANT.is_match(command) || args.iter().any(|arg| ASSISTANT.is_match(arg));
        let gemini_session = ASSISTANT.is_match(command)
            && command.to_ascii_lowercase().contains("gemini")
            || args
                .iter()
                .any(|arg| arg.to_ascii_lowercase().contains("gemini-cli"));
        Self {
            assistant,
            gemini_session,
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
        json!({"state":self.state,"source":self.source,"reason":self.reason,"revision":self.revision,
            "terminal_completed_count":self.terminal_completed_count,"terminal_ready":self.terminal_ready(),
            "terminal_prompt_visible":self.screen_prompt_visible,"terminal_prompt_empty":self.screen_prompt_empty,
            "hook":{"received":self.hook_count>0,"active":self.hook_active,"count":self.hook_count,
                "provider":self.hook_provider,"agent_id":self.hook_agent_id,
                "last_event":self.hook_event,"last_seen_at":self.hook_seen_at,
                "completed_count":self.hook_completed_count}})
    }

    pub fn hook(
        &mut self,
        provider: &str,
        event: &str,
        agent_id: Option<&str>,
        turn_id: Option<&str>,
    ) -> Result<Option<Notice>, String> {
        if !matches!(provider, "codex" | "claude") {
            return Err("unsupported hook provider".into());
        }
        if !matches!(
            event,
            "SessionStart"
                | "UserPromptSubmit"
                | "PermissionRequest"
                | "Stop"
                | "StopFailure"
                | "SessionEnd"
        ) {
            return Err("unsupported hook event".into());
        }
        if event != "SessionStart"
            && self.hook_active
            && self.hook_provider.as_deref() != Some(provider)
        {
            return Err("hook provider changed without a new session".into());
        }
        if event == "SessionStart"
            && self.hook_active
            && self
                .hook_agent_id
                .as_deref()
                .is_some_and(|old| Some(old) != agent_id)
        {
            return Err("another agent session is still active in this terminal".into());
        }
        if event != "SessionStart"
            && self.hook_active
            && self
                .hook_agent_id
                .as_deref()
                .is_some_and(|old| agent_id.is_some_and(|new| new != old))
        {
            return Err("hook agent identity does not match this terminal".into());
        }
        let duplicate_stop = event == "Stop"
            && matches!(self.hook_event.as_deref(), Some("Stop"))
            && (matches!(self.state, "done" | "idle")
                || (turn_id.is_some() && self.hook_turn_id.as_deref() == turn_id));
        let stale_stop = event == "Stop" && self.awaiting_prompt_hook;
        self.assistant = true;
        self.hook_count += 1;
        self.changed = true;
        self.hook_seen_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs());
        self.hook_event = Some(event.into());
        self.hook_provider = Some(provider.into());
        if event == "SessionStart" {
            self.agent_turn_submitted = false;
            self.startup_ready_seen = false;
            self.awaiting_prompt_hook = false;
            self.explicit = false;
            self.hook_agent_id = agent_id.map(str::to_owned);
            self.hook_turn_id = None;
            self.hook_active = true;
            self.set_state(
                "unknown",
                "hook",
                "Agent session started; waiting for a turn",
            );
        } else if event == "SessionEnd" {
            self.startup_ready_seen = false;
            self.awaiting_prompt_hook = false;
            self.hook_active = false;
            self.hook_agent_id = None;
            self.hook_turn_id = None;
            self.set_state("unknown", "hook", "Agent session ended");
        } else {
            self.hook_active = true;
            if event == "UserPromptSubmit" {
                self.agent_turn_submitted = true;
                self.startup_ready_seen = false;
                self.awaiting_prompt_hook = false;
            }
            if let Some(id) = agent_id {
                self.hook_agent_id = Some(id.into());
            }
            if let Some(id) = turn_id {
                self.hook_turn_id = Some(id.into());
            }
            match event {
                "UserPromptSubmit" => self.set_state("working", "hook", "Agent turn started"),
                "PermissionRequest" => self.set_state("blocked", "hook", "Agent requests input"),
                "Stop" if !duplicate_stop && !stale_stop => {
                    self.hook_completed_count += 1;
                    self.set_state("done", "hook", "Agent turn completed")
                }
                "StopFailure" => self.set_state("error", "hook", "Agent turn failed"),
                _ => {}
            }
        }
        Ok(match event {
            "PermissionRequest" | "StopFailure" if !duplicate_stop => Some(Notice {
                kind: "assistant_prompt",
                title: "Assistant needs attention",
                body: self.reason.clone(),
                key: format!("hook:{event}:{}", self.revision),
                source: "hook",
            }),
            "Stop" if !duplicate_stop && !stale_stop => Some(Notice {
                kind: "task_done",
                title: "Assistant response completed",
                body: self.reason.clone(),
                key: format!("hook:Stop:{}", self.revision),
                source: "hook",
            }),
            _ => None,
        })
    }

    pub fn hook_process_gone(&mut self) {
        self.awaiting_prompt_hook = false;
        self.hook_active = false;
        self.hook_agent_id = None;
        self.hook_turn_id = None;
        self.set_state(
            "unknown",
            "hook",
            "Previously observed agent process exited",
        );
    }
    pub fn hook_binding(&self) -> Option<(&str, &str)> {
        self.hook_active.then_some((
            self.hook_provider.as_deref()?,
            self.hook_agent_id.as_deref()?,
        ))
    }
    pub fn hook_ready(&self, provider: &str, agent_id: &str) -> bool {
        self.hook_submit_state(provider, agent_id)
            && self.screen_prompt_visible
            && (self.hook_event.as_deref() != Some("SessionStart") || self.initial_terminal_ready())
    }
    pub fn hook_submit_state(&self, provider: &str, agent_id: &str) -> bool {
        self.hook_binding() == Some((provider, agent_id))
            && !self.awaiting_prompt_hook
            && ((self.hook_event.as_deref() == Some("Stop")
                && matches!(self.state, "done" | "idle"))
                || (self.hook_event.as_deref() == Some("SessionStart")
                    && self.startup_ready_seen
                    && !self.agent_turn_submitted))
    }
    pub fn hook_completed_count(&self) -> u64 {
        self.hook_completed_count
    }
    pub fn terminal_completed_count(&self) -> u64 {
        self.terminal_completed_count
    }
    pub fn terminal_ready(&self) -> bool {
        self.terminal_submit_state()
            && self.screen_prompt_visible
            && self
                .last_terminal_output
                .is_some_and(|at| at.elapsed() >= Duration::from_millis(1500))
    }
    fn initial_terminal_ready(&self) -> bool {
        self.startup_ready_seen
            && !self.agent_turn_submitted
            && self.screen_prompt_visible
            && self.screen_agent_composer
            && self
                .last_terminal_output
                .is_some_and(|at| at.elapsed() >= Duration::from_millis(1500))
    }
    pub fn terminal_submit_state(&self) -> bool {
        self.terminal_submit_allowed(false)
    }
    pub fn terminal_pasted_followup_can_submit(&self) -> bool {
        self.terminal_submit_allowed(true)
    }
    fn terminal_submit_allowed(&self, pasted: bool) -> bool {
        if self.explicit && !self.hook_active {
            return self.source == "osc7501"
                && matches!(self.state, "done" | "idle")
                && self.screen_prompt_visible
                && (pasted || self.screen_prompt_empty);
        }
        self.terminal_complete_state()
            || (!self.hook_active
                && self.startup_ready_seen
                && !self.agent_turn_submitted
                && self.screen_prompt_visible
                && self.screen_agent_composer)
    }
    pub fn recognize_agent_process(&mut self) {
        self.assistant = true;
    }
    pub fn terminal_complete_state(&self) -> bool {
        !self.hook_active
            && self.source == "pattern"
            && matches!(self.state, "done" | "idle")
            && self.terminal_completed_count > 0
    }
    pub fn scheduled_terminal_input(&mut self) {
        self.submitted_done_fingerprint = self.screen_done_fingerprint;
        self.agent_turn_submitted = true;
        self.startup_ready_seen = false;
        self.turn += 1;
        self.output.clear();
        self.last_output = None;
        self.last_terminal_output = None;
        self.approval.clear();
        self.screen_prompt_visible = false;
        self.screen_prompt_empty = false;
        self.screen_agent_composer = false;
        self.set_state(
            "working",
            "pattern",
            "Follow-up prompt submitted; waiting for terminal output",
        );
    }
    pub fn observe_screen(&mut self, prompt: PromptState) -> Option<Notice> {
        if let Some(fingerprint) = prompt.completion_fingerprint {
            self.screen_done_fingerprint = Some(fingerprint);
        }
        if (prompt.startup_ready
            || (self.gemini_session && self.gemini_title == "ready" && prompt.gemini_composer))
            && !self.agent_turn_submitted
        {
            self.startup_ready_seen = true;
        }
        if self.screen_prompt_visible != prompt.visible
            || self.screen_prompt_empty != (prompt.visible && prompt.empty)
        {
            self.changed = true;
        }
        self.screen_prompt_visible = prompt.visible;
        self.screen_prompt_empty = prompt.visible && prompt.empty;
        self.screen_agent_composer = prompt.visible && prompt.agent_composer;
        if self.gemini_session {
            if self.gemini_title == "ready"
                && self.gemini_working_seen
                && self.agent_turn_submitted
                && self.turn > self.done
                && prompt.visible
                && !self.hook_active
            {
                self.gemini_working_seen = false;
                let clean = ANSI.replace_all(&self.output, "").replace(['\r', '\0'], "");
                return self.complete_confirmed(&clean);
            }
            return None;
        }
        if !self.assistant
            || self.hook_active
            || self.explicit
            || (self.turn <= self.done && !(self.turn == 0 && self.terminal_completed_count == 0))
            || !prompt.visible
        {
            return None;
        }
        let clean = ANSI.replace_all(&self.output, "").replace(['\r', '\0'], "");
        let fresh_completion = prompt.completion_fingerprint.is_some()
            && prompt.completion_fingerprint != self.submitted_done_fingerprint;
        // The PTY can redraw an identical completion line at the same row for
        // consecutive turns. Raw output is cleared on submit, so a marker in
        // this turn's output is fresh even if the screen hash is unchanged.
        let raw_completion = DONE_MARKER.is_match(&clean);
        (fresh_completion || raw_completion)
            .then(|| self.complete_confirmed(&clean))
            .flatten()
    }
    pub fn scheduled_input(&mut self) {
        self.agent_turn_submitted = true;
        self.startup_ready_seen = false;
        self.awaiting_prompt_hook = true;
        self.set_state(
            "working",
            "scheduled",
            "Follow-up prompt submitted; awaiting agent hook",
        );
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
                            if let Some(state) = state.filter(|_| !self.hook_active) {
                                if matches!(state, "done" | "idle")
                                    && self.agent_turn_submitted
                                    && !matches!(self.state, "done" | "idle")
                                {
                                    self.terminal_completed_count += 1;
                                    self.done = self.turn;
                                }
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
                    } else if self.gemini_session && !self.hook_active {
                        let title = payload
                            .strip_prefix("]0;")
                            .or_else(|| payload.strip_prefix("]2;"));
                        let status = title.and_then(|title| {
                            if title.starts_with("◇  Ready") {
                                Some("ready")
                            } else if title.starts_with("✦  ") || title.starts_with("⏲  Working")
                            {
                                Some("working")
                            } else if title.starts_with("✋  Action Required") {
                                Some("blocked")
                            } else {
                                None
                            }
                        });
                        if let Some(status) = status {
                            self.gemini_title = status;
                            if status == "working" {
                                self.gemini_working_seen = true;
                                self.set_state(
                                    "working",
                                    "pattern",
                                    "Gemini CLI reports work in progress",
                                );
                            } else if status == "blocked" {
                                self.set_state("blocked", "pattern", "Gemini CLI requests input");
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
        self.assistant |= AGENT_LAUNCH.is_match(&self.input);
        self.gemini_session |= GEMINI_LAUNCH.is_match(&self.input);
        let keys = PASTE.replace_all(text, "");
        if keys.contains(['\r', '\n']) {
            self.submitted_done_fingerprint = self.screen_done_fingerprint;
            if self.screen_agent_composer
                && (self.startup_ready_seen
                    || (self.gemini_session && self.gemini_title == "ready"))
            {
                self.agent_turn_submitted = true;
                self.startup_ready_seen = false;
            }
            self.turn += 1;
            self.output.clear();
            self.last_output = None;
            self.approval.clear();
            self.screen_prompt_visible = false;
            self.screen_prompt_empty = false;
            self.screen_agent_composer = false;
            if self.hook_active {
                self.awaiting_prompt_hook = true;
                self.set_state(
                    "working",
                    "hook",
                    "Terminal input submitted; awaiting agent hook",
                );
            } else if self.assistant && !self.explicit {
                self.set_state("working", "pattern", "Submitted agent input");
            }
        }
    }

    pub fn output(&mut self, text: &str) -> (Option<Notice>, Option<Resume>) {
        self.last_terminal_output = Some(Instant::now());
        let previous = self.revision;
        let visible = self.parse_status(text);
        self.output.push_str(&visible);
        keep_tail(&mut self.output, 8_192);
        let clean = ANSI.replace_all(&self.output, "").replace(['\r', '\0'], "");
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
        if self.explicit || self.hook_active || !self.assistant {
            let notice = if self.explicit && !self.hook_active && self.revision != previous {
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
            if !self.gemini_session && READY.is_match(recent) {
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
        if !self.explicit && !self.hook_active && self.state == "working" {
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
        self.complete_confirmed(text)
    }

    fn complete_confirmed(&mut self, text: &str) -> Option<Notice> {
        self.set_state("done", "pattern", "Agent ready prompt detected");
        self.done = self.turn;
        self.terminal_completed_count += 1;
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
    use crate::screen::Screen;

    #[test]
    fn gemini_title_requires_a_working_turn_and_visible_composer() {
        let mut d = Conversation::new("powershell", &[]);
        let mut screen = Screen::default();
        d.input("gemini\r");
        d.output("\x1b]0;◇  Ready (project)\x07");
        screen.process("\x1b[?2004h\x1b[10;1H>   Type your message or @path/to/file\x1b[10;3H");
        d.observe_screen(screen.prompt_state());
        assert!(d.terminal_submit_state(), "Gemini accepts a first prompt");
        d.input("First request\r");
        assert!(!d.terminal_submit_state());
        d.output("\x1b]0;✦  Working… (project)\x07");
        d.observe_screen(screen.prompt_state());
        assert!(!d.terminal_submit_state());
        d.output("\x1b]0;◇  Ready (project)\x07");
        screen.process("\x1b[10;1H\x1b[2KNo prompt here\x1b[10;3H");
        assert!(d.observe_screen(screen.prompt_state()).is_none());
        screen.process("\x1b[10;1H\x1b[2K>   Type your message or @path/to/file\x1b[10;3H");
        assert!(d.observe_screen(screen.prompt_state()).is_some());
        assert_eq!(d.terminal_completed_count(), 1);
        assert!(d.observe_screen(screen.prompt_state()).is_none());
    }
    #[test]
    fn completed_claude_redraw_uses_the_visible_marker_when_raw_tail_lost_it() {
        let mut d = Conversation::new("powershell", &[]);
        let mut screen = Screen::default();
        d.input("claude\r");
        d.scheduled_terminal_input();
        d.output("The answer was rendered through ANSI cursor movements");
        screen.process("\x1b[?2004h\x1b[8;1H✻ Crunched for 1s · done 오후 8:36\x1b[10;1H────────────────────\x1b[11;1H❯ \x1b[12;1H────────────────────\x1b[11;3H");
        assert!(d.observe_screen(screen.prompt_state()).is_some());
        assert_eq!(d.terminal_completed_count(), 1);
    }

    #[test]
    fn hook_turn_boundaries_override_terminal_patterns_and_keep_health() {
        let mut d = Conversation::new("powershell", &[]);
        assert_eq!(d.snapshot()["hook"]["received"], false);
        d.hook("codex", "SessionStart", Some("agent-a"), None)
            .unwrap();
        d.hook("codex", "UserPromptSubmit", Some("agent-a"), Some("turn-1"))
            .unwrap();
        assert_eq!(d.snapshot()["state"], "working");
        d.output("Do you want to proceed? ready to help");
        d.output("\x1b]7501;state=done\x07");
        assert_eq!(d.snapshot()["state"], "working");
        d.hook(
            "codex",
            "PermissionRequest",
            Some("agent-a"),
            Some("turn-1"),
        )
        .unwrap();
        assert_eq!(d.snapshot()["state"], "blocked");
        assert!(d
            .hook("codex", "Stop", Some("agent-a"), Some("turn-1"))
            .unwrap()
            .is_some());
        let revision = d.revision;
        d.acknowledge(revision);
        assert_eq!(d.snapshot()["state"], "idle");
        assert!(d
            .hook("codex", "Stop", Some("agent-a"), Some("turn-1"))
            .unwrap()
            .is_none());
        assert_eq!(d.snapshot()["state"], "idle");
        assert_eq!(d.snapshot()["hook"]["count"], 5);
        assert_eq!(d.snapshot()["hook"]["last_event"], "Stop");
        assert!(d.snapshot()["hook"]["last_seen_at"].as_u64().is_some());
    }

    #[test]
    fn scheduled_input_waits_for_a_new_prompt_hook_before_accepting_stop() {
        let mut d = Conversation::new("claude", &[]);
        d.hook("claude", "SessionStart", Some("agent-a"), None)
            .unwrap();
        d.hook("claude", "Stop", Some("agent-a"), None).unwrap();
        d.observe_screen(PromptState {
            visible: true,
            empty: true,
            ..Default::default()
        });
        assert!(d.hook_ready("claude", "agent-a"));
        d.scheduled_input();
        assert!(!d.hook_ready("claude", "agent-a"));
        assert!(d
            .hook("claude", "Stop", Some("agent-a"), None)
            .unwrap()
            .is_none());
        assert_eq!(d.snapshot()["state"], "working");
        d.hook("claude", "UserPromptSubmit", Some("agent-a"), None)
            .unwrap();
        d.hook("claude", "Stop", Some("agent-a"), None).unwrap();
        assert!(d.hook_ready("claude", "agent-a"));
    }

    #[test]
    fn manual_enter_invalidates_an_old_stop_until_a_new_hook_arrives() {
        let mut d = Conversation::new("codex", &[]);
        d.hook("codex", "SessionStart", Some("agent-a"), None)
            .unwrap();
        d.hook("codex", "Stop", Some("agent-a"), None).unwrap();
        d.observe_screen(PromptState {
            visible: true,
            empty: true,
            ..Default::default()
        });
        assert!(d.hook_ready("codex", "agent-a"));
        d.input("new prompt\r");
        assert!(!d.hook_ready("codex", "agent-a"));
        assert_eq!(d.snapshot()["state"], "working");
        d.hook("codex", "UserPromptSubmit", Some("agent-a"), Some("turn-2"))
            .unwrap();
        d.hook("codex", "Stop", Some("agent-a"), Some("turn-2"))
            .unwrap();
        d.observe_screen(PromptState {
            visible: true,
            empty: true,
            ..Default::default()
        });
        assert!(d.hook_ready("codex", "agent-a"));
    }

    #[test]
    fn completion_counter_advances_only_on_a_new_turn_boundary() {
        let mut d = Conversation::new("claude", &[]);
        d.hook("claude", "SessionStart", Some("agent-a"), None)
            .unwrap();
        d.hook("claude", "UserPromptSubmit", Some("agent-a"), None)
            .unwrap();
        d.hook("claude", "Stop", Some("agent-a"), None).unwrap();
        assert_eq!(d.hook_completed_count(), 1);
        d.hook("claude", "Stop", Some("agent-a"), None).unwrap();
        assert_eq!(d.hook_completed_count(), 1);
        d.hook("claude", "UserPromptSubmit", Some("agent-a"), None)
            .unwrap();
        d.hook("claude", "Stop", Some("agent-a"), None).unwrap();
        assert_eq!(d.hook_completed_count(), 2);
    }

    #[test]
    fn hook_refuses_other_agent_and_clears_authority_on_session_end() {
        let mut d = Conversation::new("powershell", &[]);
        d.hook("claude", "SessionStart", Some("agent-a"), None)
            .unwrap();
        assert!(d.hook("codex", "Stop", Some("agent-a"), None).is_err());
        assert!(d.hook("claude", "Stop", Some("agent-b"), None).is_err());
        assert!(d
            .hook("claude", "SessionStart", Some("agent-b"), None)
            .is_err());
        d.hook("claude", "SessionEnd", Some("agent-a"), None)
            .unwrap();
        assert_eq!(d.snapshot()["hook"]["active"], false);
        d.hook("codex", "SessionStart", Some("agent-b"), None)
            .unwrap();
        assert_eq!(d.snapshot()["hook"]["provider"], "codex");
    }

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
    fn codex_redraw_completion_uses_visible_prompt_and_preserves_typed_draft() {
        let mut detector = Conversation::new("codex.exe", &[]);
        let mut screen = crate::screen::Screen::default();
        detector.input("안녕\r");
        let response = "The change is ready.\r\nCogitated for 25s · done";
        screen.process(response);
        detector.output(response);
        assert!(detector.observe_screen(screen.prompt_state()).is_none());
        let redraw = "\x1b[8;1H› ";
        screen.process(redraw);
        assert!(detector.output(redraw).0.is_none());
        assert!(detector.observe_screen(screen.prompt_state()).is_some());
        assert_eq!(detector.terminal_completed_count(), 1);
        detector.last_terminal_output = Some(Instant::now() - Duration::from_secs(2));
        assert!(detector.terminal_ready());
        screen.process("변경사항 리뷰해줘");
        detector.output("변경사항 리뷰해줘");
        detector.observe_screen(screen.prompt_state());
        detector.last_terminal_output = Some(Instant::now() - Duration::from_secs(2));
        assert!(detector.terminal_ready());
        assert!(!detector.snapshot()["terminal_prompt_empty"]
            .as_bool()
            .unwrap());
        assert_eq!(detector.terminal_completed_count(), 1);
        detector.input("\r");
        assert_eq!(detector.terminal_completed_count(), 1);
        assert!(detector.observe_screen(screen.prompt_state()).is_none());
    }

    #[test]
    fn old_completion_above_composer_does_not_release_next_queued_turn() {
        let mut detector = Conversation::new("claude.exe", &[]);
        let mut screen = crate::screen::Screen::default();
        screen.process("\x1b[2;1HClaude Code v2.1.326\x1b[10;1H✻ Worked for 1s · done\x1b[27;1H❯ ");
        detector.input("first\r");
        assert!(detector.observe_screen(screen.prompt_state()).is_some());
        detector.scheduled_terminal_input();
        assert!(detector.observe_screen(screen.prompt_state()).is_none());
        screen.process("\x1b[12;1H✻ Cooked for 2s · done\x1b[27;1H❯ ");
        assert!(detector.observe_screen(screen.prompt_state()).is_some());
        assert_eq!(detector.terminal_completed_count(), 2);
    }

    #[test]
    fn explicit_idle_status_allows_start_and_next_turn_only_after_new_status() {
        let mut detector = Conversation::new("codex.exe", &[]);
        let mut screen = crate::screen::Screen::default();
        screen.process("\x1b[27;1H› Ask Codex to do anything\x1b[30;1H? for shortcuts\x1b[27;3H");
        detector.input("\r"); // Startup selection, before the actual composer appeared.
        detector.output("\x1b]7501;state=idle\x07");
        detector.observe_screen(screen.prompt_state());
        detector.last_terminal_output = Some(Instant::now() - Duration::from_secs(2));
        assert!(detector.terminal_ready());
        let before = detector.terminal_completed_count();
        detector.scheduled_terminal_input();
        assert!(!detector.terminal_submit_state());
        detector.output("\x1b]7501;state=working\x07");
        assert!(!detector.terminal_submit_state());
        detector.output("\x1b]7501;state=done\x07");
        detector.observe_screen(screen.prompt_state());
        assert!(detector.terminal_completed_count() > before);
        detector.last_terminal_output = Some(Instant::now() - Duration::from_secs(2));
        assert!(detector.terminal_ready());
    }

    #[test]
    fn explicit_idle_can_submit_the_queue_paste_but_busy_cannot() {
        let mut detector = Conversation::new("codex.exe", &[]);
        let mut screen = Screen::default();
        detector.output("\x1b]7501;state=idle\x07");
        screen.process("\x1b[27;1H› Ask Codex to do anything\x1b[30;1H? for shortcuts\x1b[27;3H");
        detector.observe_screen(screen.prompt_state());
        assert!(detector.terminal_submit_state());
        screen.process("\x1b[27;1H\x1b[2K› Next prompt");
        detector.observe_screen(screen.prompt_state());
        assert!(!detector.terminal_submit_state());
        assert!(detector.terminal_pasted_followup_can_submit());
        detector.output("\x1b]7501;state=working\x07");
        assert!(!detector.terminal_pasted_followup_can_submit());
    }

    #[test]
    fn mentioning_claude_in_shell_output_does_not_identify_an_agent() {
        let mut detector = Conversation::new("powershell.exe", &[]);
        let mut screen = crate::screen::Screen::default();
        let output = "The README mentions Claude.\r\nCogitated for 25s · done\x1b[10;1H› ";
        screen.process(output);
        detector.output(output);
        assert!(detector.observe_screen(screen.prompt_state()).is_none());
        assert_eq!(detector.terminal_completed_count(), 0);
    }

    #[test]
    fn startup_ready_is_revoked_when_the_first_agent_turn_is_submitted() {
        let mut detector = Conversation::new("claude.exe", &[]);
        let mut screen = crate::screen::Screen::default();
        let startup = "\x1b[?2004h\x1b[1;1HClaude Code v2.1.326\x1b[10;1H────────────────────\x1b[11;1H❯ Try \"write a test for <filepath>\"\x1b[12;1H────────────────────\x1b[13;1H  ▸▸ auto mode on (shift+tab to cycle)\x1b[11;3H";
        screen.process(startup);
        detector.output(startup);
        detector.observe_screen(screen.prompt_state());
        detector.last_terminal_output = Some(Instant::now() - Duration::from_secs(2));
        assert!(detector.terminal_ready());
        let mut hooked = Conversation::new("claude.exe", &[]);
        hooked
            .hook("claude", "SessionStart", Some("startup-agent"), None)
            .unwrap();
        hooked.output(startup);
        hooked.observe_screen(screen.prompt_state());
        hooked.last_terminal_output = Some(Instant::now() - Duration::from_secs(2));
        assert!(hooked.hook_ready("claude", "startup-agent"));
        hooked
            .hook("claude", "UserPromptSubmit", Some("startup-agent"), None)
            .unwrap();
        assert!(!hooked.hook_ready("claude", "startup-agent"));
        detector.input("first task\r");
        assert!(!detector.terminal_submit_state());
        assert!(!detector.terminal_ready());
    }

    #[test]
    fn claude_trust_menu_enter_does_not_consume_first_prompt() {
        let mut detector = Conversation::new("claude.exe", &[]);
        let mut screen = crate::screen::Screen::default();
        let composer = "\x1b[2J\x1b[1;1HClaude Code v2.1.328\x1b[10;1H────────────────────\x1b[11;1H❯ Try \"fix lint errors\"\x1b[12;1H────────────────────\x1b[13;1H  ⏵⏵ auto mode on (shift+tab to cycle)\x1b[11;3H";
        screen.process(composer);
        detector.observe_screen(screen.prompt_state());
        screen.process("\x1b[2J\x1b[7;1H› No, exit\x1b[8;1H  Yes, I trust this folder\x1b[7;3H");
        detector.observe_screen(screen.prompt_state());
        assert!(!detector.terminal_submit_state());
        detector.input("\r");
        screen.process(composer);
        detector.observe_screen(screen.prompt_state());
        detector.last_terminal_output = Some(Instant::now() - Duration::from_secs(2));
        assert!(detector.terminal_ready());
    }

    #[test]
    fn first_agent_turn_can_complete_without_a_recorded_enter() {
        let mut detector = Conversation::new("codex.exe", &[]);
        let mut screen = crate::screen::Screen::default();
        let redraw = "Cogitated for 25s · done\x1b[10;1H› ";
        screen.process(redraw);
        detector.output(redraw);
        assert!(detector.observe_screen(screen.prompt_state()).is_some());
        assert_eq!(detector.terminal_completed_count(), 1);
        detector.output("\x1b[10;1H› ");
        assert!(detector.observe_screen(screen.prompt_state()).is_none());
        assert_eq!(detector.terminal_completed_count(), 1);
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
