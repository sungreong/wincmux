use crate::{remote::Remote, ssh_terminal::quote};
use serde::Serialize;
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

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Launch {
    Shell,
    Claude,
    Codex,
    Gemini,
}

const USER_BIN_PATH: &str = "PATH=\"$HOME/.local/bin:$PATH\"; export PATH;";
const CONTAINER_SHELL: &str = "PATH=\"$HOME/.local/bin:$PATH\"; export PATH; if command -v bash >/dev/null 2>&1; then exec bash -i; fi; exec sh -i";
const SSH_SHELL: &str =
    "PATH=\"$HOME/.local/bin:$PATH\"; export PATH; exec \"${SHELL:-/bin/sh}\" -i";
pub const SHELL_READY_MARKER: &[u8] = b"\x1b]777;wincmux-shell-ready\x07";

#[derive(Default)]
pub struct ShellHandoff {
    matched: usize,
}

impl ShellHandoff {
    pub fn observe(&mut self, bytes: &[u8]) -> bool {
        for &byte in bytes {
            self.matched = if byte == SHELL_READY_MARKER[self.matched] {
                self.matched + 1
            } else if byte == SHELL_READY_MARKER[0] {
                1
            } else {
                0
            };
            if self.matched == SHELL_READY_MARKER.len() {
                self.matched = 0;
                return true;
            }
        }
        false
    }
}

#[derive(Serialize)]
pub struct AgentInstall {
    code: &'static str,
    command: &'static str,
    install_command: &'static str,
    verify: String,
    requires: &'static str,
    missing_tools: Vec<&'static str>,
}

impl Launch {
    pub fn parse(value: &Value) -> Result<Self, String> {
        match value.as_str().unwrap_or("shell") {
            "shell" => Ok(Self::Shell),
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "gemini" => Ok(Self::Gemini),
            _ => Err("실행할 도구를 선택하세요.".into()),
        }
    }

    fn program(self) -> Option<&'static str> {
        match self {
            Self::Shell => None,
            Self::Claude => Some("claude"),
            Self::Codex => Some("codex"),
            Self::Gemini => Some("gemini"),
        }
    }

    pub fn command(self, path: &str, container: bool) -> String {
        if self.program().is_none() {
            return if container {
                CONTAINER_SHELL
            } else {
                SSH_SHELL
            }
            .into();
        }
        self.login_command(
            path,
            &self.agent_command(
                if container {
                    CONTAINER_SHELL
                } else {
                    SSH_SHELL
                },
                None,
                false,
            ),
        )
    }

    pub fn container_command(self) -> String {
        if self.program().is_none() {
            return CONTAINER_SHELL.into();
        }
        self.agent_command(CONTAINER_SHELL, None, false)
    }

    pub fn resume_command(
        self,
        path: &str,
        container: bool,
        id: Option<&str>,
        picker: bool,
    ) -> String {
        self.login_command(
            path,
            &self.agent_command(
                if container {
                    CONTAINER_SHELL
                } else {
                    SSH_SHELL
                },
                id,
                picker,
            ),
        )
    }

    pub fn container_resume_command(self, id: Option<&str>, picker: bool) -> String {
        self.agent_command(CONTAINER_SHELL, id, picker)
    }

    fn agent_command(self, fallback: &str, id: Option<&str>, picker: bool) -> String {
        let agent = self.program().expect("agent command requires a CLI");
        let command = match (self, id, picker) {
            (Self::Claude, Some(id), _) => format!("\"$executable\" --resume {id}"),
            (Self::Codex, Some(id), _) => format!("\"$executable\" resume {id}"),
            (Self::Claude, None, true) => "\"$executable\" --resume".into(),
            (Self::Codex, None, true) => "\"$executable\" resume".into(),
            _ => "\"$executable\"".into(),
        };
        let run = if matches!(self, Self::Codex) {
            format!("if [ -n \"${{OPENAI_API_KEY:-}}${{CODEX_ACCESS_TOKEN:-}}${{OPENAI_IDENTITY_TOKEN_FILE:-}}\" ] || \"$executable\" login status >/dev/null 2>&1 || \"$executable\" login --device-auth; then {command}; else printf '%s\\n' 'Codex 기기 코드 로그인이 완료되지 않았습니다. 계정에서 기기 코드 로그인을 허용한 뒤 다시 실행하세요.' >&2; fi")
        } else {
            command
        };
        format!(
            "{USER_BIN_PATH} {} if [ -f \"$executable\" ] && [ -x \"$executable\" ]; then if {run}; then :; fi; printf '\\033]777;wincmux-shell-ready\\007'; {fallback}; fi; printf '%s\\n' {} >&2; exit 127",
            Self::locate(agent),
            quote(self.missing())
        )
    }

    pub fn probe(self, path: &str, ssh: bool) -> Option<String> {
        let agent = self.program()?;
        let mut check = format!(
            "{} if [ -f \"$executable\" ] && [ -x \"$executable\" ]; then printf '\\nWINCMUX_AGENT_FOUND\\n'; else printf '\\nWINCMUX_AGENT_MISSING\\n';",
            Self::locate(agent),
        );
        for tool in self.install_tools() {
            check.push_str(&format!(
                " command -v {tool} >/dev/null 2>&1 || printf 'WINCMUX_INSTALL_NEEDS=%s\\n' '{tool}';"
            ));
        }
        check.push_str(" fi");
        Some(if ssh {
            self.login_command(path, &check)
        } else {
            check
        })
    }

    fn install_tools(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &["curl", "bash"],
            Self::Codex => &["curl", "mktemp"],
            Self::Gemini => &["node", "npm"],
            Self::Shell => &[],
        }
    }

    pub fn install_guide(self, output: &str) -> Option<AgentInstall> {
        let agent = self.program()?;
        let codex_install = "_wincmux_script=$(mktemp) && curl -fL https://chatgpt.com/codex/install.sh -o \"$_wincmux_script\" && sh \"$_wincmux_script\"; _wincmux_result=$?; if [ -n \"$_wincmux_script\" ]; then rm -f \"$_wincmux_script\"; fi; if [ \"$_wincmux_result\" -eq 0 ]; then PATH=\"$HOME/.local/bin:$PATH\"; export PATH; codex --version; else printf 'Codex installation failed (exit %s)\\n' \"$_wincmux_result\"; fi";
        let (command, install_command, requires) = match self {
            Self::Claude => (
                "bash -c 'set -o pipefail; curl -fL https://claude.ai/install.sh | bash'",
                "bash -c 'set -o pipefail; curl -fL https://claude.ai/install.sh | bash' && { if command -v claude >/dev/null 2>&1; then claude --version; else \"$HOME/.local/bin/claude\" --version; fi; }",
                "curl, Bash",
            ),
            Self::Codex => (
                codex_install,
                codex_install,
                "curl, mktemp",
            ),
            Self::Gemini => (
                "npm install -g @google/gemini-cli",
                "npm install -g @google/gemini-cli && gemini --version",
                "Node.js 20 이상, npm",
            ),
            Self::Shell => return None,
        };
        let missing_tools = self
            .install_tools()
            .iter()
            .copied()
            .filter(|tool| {
                output
                    .lines()
                    .any(|line| line.trim().strip_prefix("WINCMUX_INSTALL_NEEDS=") == Some(*tool))
            })
            .collect();
        Some(AgentInstall {
            code: "agent_missing",
            command,
            install_command,
            verify: format!("{agent} --version"),
            requires,
            missing_tools,
        })
    }

    fn locate(agent: &str) -> String {
        format!(
            "executable=$(command -v {agent} 2>/dev/null); if [ ! -f \"$executable\" ] || [ ! -x \"$executable\" ]; then executable=\"$HOME/.local/bin/{agent}\"; fi;"
        )
    }

    fn missing(self) -> &'static str {
        match self {
            Self::Claude => "이 환경에서 Claude Code를 찾을 수 없습니다. 해당 서버나 컨테이너에 설치된 CLI와 PATH를 확인하세요.",
            Self::Codex => "이 환경에서 Codex를 찾을 수 없습니다. 해당 서버나 컨테이너에 설치된 CLI와 PATH를 확인하세요.",
            Self::Gemini => "이 환경에서 Gemini CLI를 찾을 수 없습니다. 해당 서버나 컨테이너에 설치된 CLI와 PATH를 확인하세요.",
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
    SendNow(u64),
    Cancel(u64),
    Toggle(u64),
}

impl Composer {
    pub fn parse(action: &str, params: &Value) -> Result<Self, String> {
        if matches!(action, "agent-cancel" | "agent-toggle" | "agent-send-now") {
            let id = params["item"].as_u64().ok_or("대기 항목을 선택하세요.")?;
            return Ok(match action {
                "agent-cancel" => Self::Cancel(id),
                "agent-toggle" => Self::Toggle(id),
                _ => Self::SendNow(id),
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
    pub fn pending_count(&self) -> usize {
        self.queue.len()
    }

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
            self.announce(screen_notice.or(notice));
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
            Composer::SendNow(id) => {
                if self.paste_at.is_some() || self.queue.front().is_some_and(|item| item.pasted) {
                    self.error = Some("붙여넣은 초안을 먼저 확인한 뒤 다시 보내세요.");
                    return None;
                }
                let Some(index) = self
                    .queue
                    .iter()
                    .position(|item| item.id == id && !item.pasted)
                else {
                    self.error = Some("대기 입력을 찾을 수 없습니다.");
                    return None;
                };
                let text = self.queue[index].text.clone();
                let Some(mut data) = self.paste(&text) else {
                    self.error =
                        Some("여러 줄 입력을 즉시 보내려면 에이전트의 붙여넣기 모드가 필요합니다.");
                    return None;
                };
                data.push(b'\r');
                self.queue.remove(index);
                self.quota.input(&format!("{text}\n"));
                self.detector.scheduled_terminal_input();
                return Some(data);
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
    fn agent_exit_returns_to_an_interactive_shell() {
        for launch in [Launch::Claude, Launch::Codex] {
            let docker = launch.container_command();
            assert!(docker.contains("then :; fi; printf"));
            assert!(docker.contains("wincmux-shell-ready"));
            assert!(docker.contains(CONTAINER_SHELL));
            assert!(!docker.contains("exec \"$executable\""));
            let ssh = launch.command("/tmp", false);
            assert!(ssh.contains(SSH_SHELL));
        }
    }

    #[test]
    fn saved_conversations_resume_through_agent_commands() {
        let id = "01a1ec05-2e34-7501-a052-3ee0951e1f54";
        let claude = Launch::Claude.container_resume_command(Some(id), false);
        assert!(claude.contains(&format!("\"$executable\" --resume {id}")));
        assert!(claude.contains("wincmux-shell-ready"));
        let codex = Launch::Codex.resume_command("/app/project", false, Some(id), false);
        assert!(codex.contains(&format!("\"$executable\" resume {id}")));
        assert!(codex.contains("login --device-auth"));
        assert!(Launch::Claude
            .container_resume_command(None, true)
            .contains("\"$executable\" --resume"));
    }

    #[test]
    fn installed_agent_is_on_new_shell_and_agent_paths() {
        for script in [CONTAINER_SHELL, SSH_SHELL] {
            assert!(script.starts_with(USER_BIN_PATH));
        }
        for launch in [Launch::Claude, Launch::Codex] {
            assert!(launch.container_command().starts_with(USER_BIN_PATH));
        }
        let guide = Launch::Codex
            .install_guide("WINCMUX_AGENT_MISSING")
            .unwrap();
        assert!(guide.command.contains("export PATH; codex --version"));
        assert!(guide
            .install_command
            .contains("export PATH; codex --version"));
    }

    #[test]
    fn codex_uses_device_login_only_when_no_credential_is_available() {
        let codex = Launch::Codex.container_command();
        assert!(
            codex.contains("login status >/dev/null 2>&1 || \"$executable\" login --device-auth")
        );
        assert!(codex.contains("OPENAI_API_KEY"));
        assert!(codex.contains("CODEX_ACCESS_TOKEN"));
        assert!(codex.contains("then \"$executable\"; else printf"));
        assert!(!Launch::Claude.container_command().contains("--device-auth"));
    }

    #[test]
    fn sends_a_selected_queued_message_immediately_and_keeps_the_rest() {
        let mut agent = AgentSession::new(Launch::Codex, 100, 24).unwrap();
        agent.output(READY.as_bytes());
        for text in ["first", "second"] {
            agent.apply(Composer::Add {
                text: text.into(),
                due_at: None,
            });
        }
        let selected = agent.queue[1].id;
        let data = agent.apply(Composer::SendNow(selected));
        assert_eq!(data, Some(b"\x1b[200~second\x1b[201~\r".to_vec()));
        assert_eq!(agent.queue.len(), 1);
        assert_eq!(agent.queue[0].text, "first");
    }

    #[test]
    fn immediate_send_keeps_the_queue_when_another_draft_is_pasted() {
        let mut agent = AgentSession::new(Launch::Claude, 100, 24).unwrap();
        agent.apply(Composer::Add {
            text: "first".into(),
            due_at: None,
        });
        agent.apply(Composer::Add {
            text: "second".into(),
            due_at: None,
        });
        agent.queue[0].pasted = true;
        let selected = agent.queue[1].id;
        assert!(agent.apply(Composer::SendNow(selected)).is_none());
        assert_eq!(agent.queue.len(), 2);
        assert!(agent.error.is_some());
    }

    #[test]
    fn pasted_followup_submits_when_visible_even_if_detector_state_changed() {
        let mut agent = AgentSession::new(Launch::Codex, 100, 24).unwrap();
        agent.output(READY.as_bytes());
        agent.apply(Composer::Add {
            text: "second question".into(),
            due_at: None,
        });
        std::thread::sleep(Duration::from_millis(1600));
        assert_eq!(
            agent.tick(),
            Some(b"\x1b[200~second question\x1b[201~".to_vec())
        );
        agent.detector.scheduled_terminal_input();
        agent.output(b"\x1b[10;1H\x1b[2K\xe2\x80\xba second question\x1b[10;18H");
        assert!(!agent.detector.terminal_pasted_followup_can_submit());
        agent.paste_at = Some(Instant::now() - Duration::from_millis(500));
        assert_eq!(agent.tick(), Some(vec![b'\r']));
        assert!(agent.queue.is_empty());
    }

    #[test]
    fn shell_handoff_detects_a_split_terminal_marker() {
        let mut handoff = ShellHandoff::default();
        assert!(!handoff.observe(b"terminal output\x1b]777;wincmux-"));
        assert!(handoff.observe(b"shell-ready\x07root@container:/app# "));
        assert!(!handoff.observe(b"shell prompt"));
    }

    #[test]
    fn gemini_install_guide_only_lists_its_missing_dependencies() {
        let launch = Launch::parse(&json!("gemini")).unwrap();
        let guide = launch
            .install_guide(
                "WINCMUX_AGENT_MISSING\nWINCMUX_INSTALL_NEEDS=npm\nWINCMUX_INSTALL_NEEDS=curl",
            )
            .unwrap();
        assert_eq!(guide.command, "npm install -g @google/gemini-cli");
        assert_eq!(
            guide.install_command,
            "npm install -g @google/gemini-cli && gemini --version"
        );
        assert_eq!(guide.verify, "gemini --version");
        assert_eq!(guide.missing_tools, ["npm"]);
    }

    #[test]
    fn claude_install_command_reports_download_failures_and_checks_the_installed_binary() {
        let guide = Launch::Claude
            .install_guide("WINCMUX_AGENT_MISSING")
            .unwrap();
        assert!(guide.command.contains("set -o pipefail"));
        assert!(guide.install_command.contains("set -o pipefail"));
        assert!(guide
            .install_command
            .contains("curl -fL https://claude.ai/install.sh"));
        assert!(guide.install_command.contains("claude --version"));
        assert_eq!(
            serde_json::to_value(&guide).unwrap()["install_command"],
            guide.install_command
        );
        assert_eq!(guide.missing_tools, Vec::<&str>::new());
    }

    #[test]
    fn gemini_followup_waits_for_its_ready_prompt() {
        let mut agent = AgentSession::new(Launch::Gemini, 100, 24).unwrap();
        agent.apply(Composer::Add {
            text: "hello".into(),
            due_at: None,
        });
        assert!(agent.tick().is_none());
        agent.output(b"\x1b[?2004h\x1b[10;1H> Type your message or @path/to/file\x1b[10;3H");
        assert!(agent.tick().is_none());
        agent.output("\x1b]0;◇  Ready (fixture)\x07".as_bytes());
        std::thread::sleep(Duration::from_millis(1600));
        assert_eq!(agent.tick(), Some(b"\x1b[200~hello\x1b[201~".to_vec()));
    }

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
