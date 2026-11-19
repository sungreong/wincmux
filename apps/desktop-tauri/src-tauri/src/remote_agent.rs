use crate::{remote::Remote, ssh_terminal::quote};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use wincmux_runtime::{
    detector::{Conversation, Notice},
    reminders::{LimitDetector, QuotaNotice},
    screen::{PromptAgent, Screen},
    terminal::Utf8Decoder,
};

#[derive(Clone, Copy)]
pub enum Launch {
    Shell,
    Claude,
    Codex,
}

impl Launch {
    pub fn parse(value: &Value) -> Result<Self, String> {
        match value.as_str().unwrap_or("shell") {
            "shell" => Ok(Self::Shell),
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            _ => Err("실행할 도구를 선택하세요.".into()),
        }
    }

    fn program(self) -> Option<&'static str> {
        match self {
            Self::Shell => None,
            Self::Claude => Some("claude"),
            Self::Codex => Some("codex"),
        }
    }

    pub fn command(self, path: &str, container: bool) -> String {
        if self.program().is_none() {
            return if container {
                "exec sh -i"
            } else {
                "exec \"${SHELL:-/bin/sh}\" -i"
            }
            .into();
        }
        self.login_command(path, &self.container_command())
    }

    pub fn container_command(self) -> String {
        let Some(agent) = self.program() else {
            return "exec sh -i".into();
        };
        format!(
            "{} if [ -f \"$executable\" ] && [ -x \"$executable\" ]; then exec \"$executable\"; fi; printf '%s\\n' {} >&2; exit 127",
            Self::locate(agent),
            quote(self.missing())
        )
    }

    pub fn probe(self, path: &str, ssh: bool) -> Option<String> {
        let agent = self.program()?;
        let check = format!(
            "{} if [ -f \"$executable\" ] && [ -x \"$executable\" ]; then printf '\\nWINCMUX_AGENT_FOUND\\n'; else printf '\\nWINCMUX_AGENT_MISSING\\n'; fi",
            Self::locate(agent)
        );
        Some(if ssh {
            self.login_command(path, &check)
        } else {
            check
        })
    }

    fn locate(agent: &str) -> String {
        format!(
            "executable=$(command -v {agent} 2>/dev/null); if [ ! -f \"$executable\" ] || [ ! -x \"$executable\" ]; then executable=\"$HOME/.local/bin/{agent}\"; fi;"
        )
    }

    pub fn missing(self) -> &'static str {
        match self {
            Self::Claude => "이 환경에서 Claude Code를 찾을 수 없습니다. 해당 서버나 컨테이너에 설치된 CLI와 PATH를 확인하세요.",
            Self::Codex => "이 환경에서 Codex를 찾을 수 없습니다. 해당 서버나 컨테이너에 설치된 CLI와 PATH를 확인하세요.",
            Self::Shell => "원격 셸을 실행할 수 없습니다.",
        }
    }

    fn login_command(self, path: &str, script: &str) -> String {
        let command = quote(&format!("cd {} || exit 1; {script}", quote(path)));
        format!("if [ -x /bin/bash ]; then exec /bin/bash -lic {command}; else exec sh -lc {command}; fi")
    }
}

pub enum Composer {
    Add { text: String, due_at: Option<u64> },
    Insert(String),
    Cancel(u64),
    Toggle(u64),
}

impl Composer {
    pub fn parse(action: &str, params: &Value) -> Result<Self, String> {
        if matches!(action, "agent-cancel" | "agent-toggle") {
            let id = params["item"].as_u64().ok_or("대기 항목을 선택하세요.")?;
            return Ok(if action == "agent-cancel" {
                Self::Cancel(id)
            } else {
                Self::Toggle(id)
            });
        }
        let text = params["text"]
            .as_str()
            .unwrap_or_default()
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        if text.trim().is_empty()
            || text.len() > 16_000
            || text
                .chars()
                .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\t'))
        {
            return Err("입력할 메시지를 확인하세요. 최대 16,000바이트까지 지원합니다.".into());
        }
        if action == "agent-insert" {
            return Ok(Self::Insert(text));
        }
        Ok(Self::Add {
            text,
            due_at: params["due_at"].as_u64(),
        })
    }
}

struct Queued {
    id: u64,
    text: String,
    due_at: Option<u64>,
    paused: bool,
    pasted: bool,
}

pub struct AgentSession {
    detector: Conversation,
    quota: LimitDetector,
    alerts: Option<mpsc::Sender<AgentAlert>>,
    screen: Screen,
    prompt_agent: PromptAgent,
    decoder: Utf8Decoder,
    last: Value,
    queue: VecDeque<Queued>,
    next_id: u64,
    paste_at: Option<Instant>,
    error: Option<&'static str>,
}

enum AgentAlert {
    Notice(Notice),
    Quota(QuotaNotice),
}

impl AgentSession {
    pub fn new(launch: Launch, cols: u16, rows: u16) -> Option<Self> {
        let mut screen = Screen::default();
        if Screen::validate_size(cols, rows).is_ok() {
            screen.resize(cols, rows);
        }
        Some(Self {
            detector: Conversation::new(launch.program()?, &[]),
            quota: LimitDetector::new(launch.program()?, &[]),
            alerts: None,
            screen,
            prompt_agent: PromptAgent::from_program(launch.program()?),
            decoder: Utf8Decoder::default(),
            last: Value::Null,
            queue: VecDeque::new(),
            next_id: 0,
            paste_at: None,
            error: None,
        })
    }

    pub fn bind_alerts(&mut self, remote: Arc<Remote>, project: Value, sid: String) {
        let (sender, mut receiver) = mpsc::channel(32);
        self.alerts = Some(sender);
        tokio::spawn(async move {
            let mut registered = false;
            while let Some(alert) = receiver.recv().await {
                let (method, params) = match alert {
                    AgentAlert::Notice(notice) => (
                        "notify.push",
                        json!({
                            "workspace_id":project["id"], "session_id":sid, "kind":notice.kind,
                            "title":notice.title, "body":notice.body, "source_kind":notice.source,
                            "source":"remote-agent", "level":if notice.kind == "task_done" {"success"} else {"info"},
                            "dedup_key":format!("{sid}|{}|{}",notice.kind,notice.key)
                        }),
                    ),
                    AgentAlert::Quota(notice) => (
                        "reminder.remote_quota",
                        json!({
                            "workspace_id":project["id"], "session_id":sid, "notice":notice
                        }),
                    ),
                };
                for delay in [0, 250, 750] {
                    if delay > 0 {
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    }
                    if !registered {
                        registered = remote
                            .rpc("remote_project.register", project.clone())
                            .await
                            .is_ok();
                    }
                    if registered && remote.rpc(method, params.clone()).await.is_ok() {
                        break;
                    }
                    registered = false;
                }
            }
        });
    }

    fn announce(&self, notice: Option<Notice>) {
        if let (Some(report), Some(notice)) = (&self.alerts, notice) {
            let _ = report.try_send(AgentAlert::Notice(notice));
        }
    }

    pub fn output(&mut self, data: &[u8]) {
        let text = self.decoder.push(data);
        if !text.is_empty() {
            self.screen.process(&text);
            self.quota.output(&text, Instant::now());
            let (notice, _) = self.detector.output(&text);
            let screen_notice = self
                .detector
                .observe_screen(self.screen.agent_prompt_state(self.prompt_agent));
            self.announce(notice.or(screen_notice));
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        if Screen::validate_size(cols, rows).is_ok() {
            self.screen.resize(cols, rows);
        }
    }

    pub fn manual(&mut self, text: &[u8]) {
        if self.paste_at.take().is_some() {
            self.error = Some(
                "터미널의 초안을 확인하세요. 중복 제출을 방지하기 위해 자동 Enter를 보류했습니다.",
            );
        }
        let text = String::from_utf8_lossy(text);
        self.quota.input(&text);
        self.detector.input(&text);
    }

    pub fn apply(&mut self, operation: Composer) -> Option<Vec<u8>> {
        self.error = None;
        match operation {
            Composer::Add { text, due_at } if self.queue.len() < 32 => {
                self.next_id += 1;
                self.queue.push_back(Queued {
                    id: self.next_id,
                    text,
                    due_at,
                    paused: false,
                    pasted: false,
                });
            }
            Composer::Add { .. } => self.error = Some("터미널당 대기 입력은 32개까지 가능합니다."),
            Composer::Cancel(id) => {
                if self
                    .queue
                    .front()
                    .is_some_and(|item| item.id == id && item.pasted)
                {
                    self.paste_at = None;
                }
                self.queue.retain(|item| item.id != id);
            }
            Composer::Toggle(id) => {
                if let Some(item) = self
                    .queue
                    .iter_mut()
                    .find(|item| item.id == id && !item.pasted)
                {
                    item.paused = !item.paused;
                }
            }
            Composer::Insert(text) => {
                if let Some(bytes) = self.paste(&text) {
                    self.manual(&bytes);
                    return Some(bytes);
                }
                self.error = Some("에이전트의 여러 줄 붙여넣기가 준비되면 다시 시도하세요.");
            }
        }
        None
    }

    pub fn tick(&mut self) -> Option<Vec<u8>> {
        let notice = self.detector.idle();
        self.announce(notice);
        if let (Some(report), Some(notice)) = (&self.alerts, self.quota.poll(Instant::now())) {
            if let Err(mpsc::error::TrySendError::Full(AgentAlert::Quota(notice))) =
                report.try_send(AgentAlert::Quota(notice))
            {
                self.quota.retry(notice);
            }
        }
        let item = self.queue.front()?;
        let prompt = self.screen.agent_prompt_state(self.prompt_agent);
        if let Some(since) = self.paste_at {
            if since.elapsed() >= Duration::from_secs(5) {
                self.paste_at = None;
                self.error =
                    Some("초안 확인이 필요합니다. 내용을 확인하고 터미널에서 직접 제출하세요.");
            } else if since.elapsed() >= Duration::from_millis(350)
                && self.detector.terminal_pasted_followup_can_submit()
                && prompt.visible
                && !prompt.empty
            {
                self.paste_at = None;
                if let Some(item) = self.queue.pop_front() {
                    self.quota.input(&format!("{}\n", item.text));
                }
                self.detector.scheduled_terminal_input();
                return Some(vec![b'\r']);
            }
            return None;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if item.pasted
            || item.paused
            || item.due_at.is_some_and(|at| at > now)
            || !self.detector.terminal_ready()
            || !prompt.empty
        {
            return None;
        }
        let Some(data) = self.paste(&item.text) else {
            self.error = Some("에이전트의 여러 줄 붙여넣기를 기다리고 있습니다.");
            return None;
        };
        self.error = None;
        self.queue.front_mut().unwrap().pasted = true;
        self.paste_at = Some(Instant::now());
        Some(data)
    }

    fn paste(&self, text: &str) -> Option<Vec<u8>> {
        if self.screen.bracketed_paste() {
            return Some(format!("\x1b[200~{text}\x1b[201~").into_bytes());
        }
        (!text.contains(['\n', '\t'])).then(|| text.as_bytes().to_vec())
    }

    pub fn notify(&mut self, stream: &Channel<Value>) {
        let mut state = self.detector.snapshot();
        if state["terminal_ready"] == true && state["state"] == "unknown" {
            state["state"] = json!("idle");
        }
        state["queue"] = json!(self
            .queue
            .iter()
            .map(|item| json!({
                "id":item.id,"preview":item.text.chars().take(100).collect::<String>(),
                "paused":item.paused,"pasted":item.pasted,"due_at":item.due_at
            }))
            .collect::<Vec<_>>());
        state["message"] = json!(self.error);
        if state != self.last {
            let _ = stream.send(json!({"agent":state}));
            self.last = state;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const READY: &str = "\x1b[2J\x1b[1;1HOpenAI Codex\x1b[10;1H› Ask Codex to do anything\x1b[14;1H? for shortcuts\x1b[10;3H\x1b[?2004h";

    #[test]
    fn sends_in_order_only_after_the_next_idle_composer() {
        let mut agent = AgentSession::new(Launch::Codex, 100, 24).unwrap();
        for text in ["first", "second"] {
            agent.apply(Composer::Add {
                text: text.into(),
                due_at: None,
            });
        }
        assert!(agent.tick().is_none());
        agent.output(READY.as_bytes());
        std::thread::sleep(Duration::from_millis(1600));
        assert_eq!(agent.tick(), Some(b"\x1b[200~first\x1b[201~".to_vec()));
        agent.paste_at = Some(Instant::now() - Duration::from_millis(500));
        assert!(
            agent.tick().is_none(),
            "wait for the agent to render the draft"
        );
        agent.output("\x1b[10;1H\x1b[2K› first".as_bytes());
        assert_eq!(agent.tick(), Some(vec![b'\r']));
        agent.output(b"\x1b[2J\x1b[1;1HWorking");
        assert!(agent.tick().is_none(), "keep the second input waiting");
        agent.output(READY.as_bytes());
        assert!(
            agent.tick().is_none(),
            "a redrawn prompt alone cannot complete the turn"
        );
        agent.output("\x1b[6;1H✻ Worked for 2s · done\x1b[10;3H".as_bytes());
        std::thread::sleep(Duration::from_millis(1600));
        assert_eq!(agent.tick(), Some(b"\x1b[200~second\x1b[201~".to_vec()));
    }

    #[test]
    fn leaves_a_pasted_draft_for_manual_review_after_keyboard_input() {
        let mut agent = AgentSession::new(Launch::Claude, 100, 24).unwrap();
        agent.apply(Composer::Add {
            text: "draft".into(),
            due_at: None,
        });
        agent.queue.front_mut().unwrap().pasted = true;
        agent.paste_at = Some(Instant::now());
        agent.manual(b"x");
        assert!(agent.tick().is_none());
        assert!(agent.error.is_some());
        assert!(agent.queue.front().unwrap().pasted);
    }

    #[test]
    fn identifies_the_claude_composer_after_the_banner_scrolls_away() {
        let mut agent = AgentSession::new(Launch::Claude, 100, 15).unwrap();
        agent.output("────────────────────\r\n❯ Try \"hello\"\r\n────────────────────\r\n1 more notice hidden (ctrl+o to expand)\x1b[2;3H".as_bytes());
        let prompt = agent.screen.agent_prompt_state(PromptAgent::Claude);
        assert!(prompt.startup_ready && prompt.empty);
        assert!(!agent.screen.prompt_state().startup_ready);
    }
}
