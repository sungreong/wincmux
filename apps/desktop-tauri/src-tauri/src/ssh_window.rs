use crate::{
    local_docker::DockerHost,
    remote::Remote,
    ssh_auth::{Auth, Handle},
    ssh_config::{self, Profile, Project},
    ssh_credentials,
    ssh_terminal::WorkspaceHost,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tokio::{
    sync::{mpsc, Mutex, Semaphore},
    time::{timeout, Instant},
};
use uuid::Uuid;
use wincmux_runtime::terminal::hidden_command;

const SSH_WINDOW: &str = "ssh-workspace";
const DOCKER_WINDOW: &str = "docker-workspace";
const AUTH_TIMEOUT: Duration = Duration::from_secs(18);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Default)]
struct Connections {
    window: Uuid,
    pending: Option<PendingAuth>,
    tested_manual: Option<Profile>,
    active: Option<Active>,
    docker: Option<Arc<DockerHost>>,
    docker_project: Option<Project>,
    terminals: HashMap<String, WorkspaceTerminal>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ConnectionMode {
    Connect,
    Test,
}

struct PendingAuth {
    id: Uuid,
    deadline: Instant,
    auth: Auth,
    mode: ConnectionMode,
}

struct WorkspaceTerminal {
    project: Project,
    sender: mpsc::Sender<super::ssh_terminal::Input>,
}

struct Active {
    profile: Profile,
    handle: Arc<Handle>,
    credential_key: String,
}

#[derive(Deserialize, Serialize)]
struct DockerWorkspace {
    endpoint: String,
    project: Project,
}

pub struct SshWindow {
    profiles: PathBuf,
    connections: Arc<Mutex<Connections>>,
    pub(super) file_gate: Semaphore,
    opening: Mutex<()>,
    pending_alert: Mutex<Option<Value>>,
}

pub struct WorkspaceWindows {
    ssh: SshWindow,
    docker: SshWindow,
}

impl WorkspaceWindows {
    pub fn new(root: PathBuf) -> Self {
        Self {
            ssh: SshWindow::new(root.clone()),
            docker: SshWindow::new(root),
        }
    }

    pub fn select(&self, window: &WebviewWindow) -> Result<&SshWindow, String> {
        match window.label() {
            SSH_WINDOW => Ok(&self.ssh),
            DOCKER_WINDOW => Ok(&self.docker),
            _ => Err("SSH 또는 Docker 작업공간 창에서만 사용할 수 있습니다.".into()),
        }
    }
}

impl SshWindow {
    fn new(root: PathBuf) -> Self {
        Self {
            profiles: root.join("ssh-profiles.json"),
            connections: Default::default(),
            file_gate: Semaphore::new(1),
            opening: Mutex::default(),
            pending_alert: Mutex::default(),
        }
    }

    pub(super) async fn host(&self) -> Result<WorkspaceHost, String> {
        self.connections.lock().await.host()
    }

    pub(super) async fn notice_project(
        &self,
        host: &WorkspaceHost,
        project: &Project,
    ) -> Result<Value, String> {
        let conn = self.connections.lock().await;
        if !conn.host()?.same_connection(host) {
            return Err("작업공간 연결이 변경되었습니다.".into());
        }
        let (backend, authority, label) = match host {
            WorkspaceHost::Ssh(_) => {
                let active = conn.active.as_ref().unwrap();
                (
                    "ssh",
                    active.credential_key.as_str(),
                    format!("SSH · {}", active.profile.name),
                )
            }
            WorkspaceHost::Docker(docker) => ("docker", docker.endpoint(), "로컬 Docker".into()),
        };
        let identity = json!([authority, project.container, project.path]);
        let id = format!(
            "remote:{backend}:{}",
            URL_SAFE_NO_PAD.encode(identity.to_string())
        );
        let name = match project.container.as_deref() {
            Some(container) => format!(
                "{label} · {} · {}",
                container.chars().take(12).collect::<String>(),
                project.path
            ),
            None => format!("{label} · {}", project.path),
        };
        Ok(json!({"id":id,"backend":backend,"name":name,"path":project.path}))
    }

    pub(super) async fn project(
        &self,
        source_terminal: Option<&str>,
    ) -> Result<(WorkspaceHost, Project), String> {
        let conn = self.connections.lock().await;
        let host = conn.host()?;
        if let Some(id) = source_terminal {
            let project = conn
                .terminals
                .get(id)
                .ok_or("분할할 원본 pane을 찾을 수 없습니다.")?
                .project
                .clone();
            return Ok((host, project));
        }
        let project = match &host {
            WorkspaceHost::Ssh(_) => conn
                .active
                .as_ref()
                .and_then(|active| active.profile.project.as_ref()),
            WorkspaceHost::Docker(_) => conn.docker_project.as_ref(),
        }
        .cloned()
        .ok_or("먼저 작업공간 폴더를 여세요.")?;
        Ok((host, project))
    }

    pub(super) async fn add_terminal(
        &self,
        host: &WorkspaceHost,
        id: String,
        project: Project,
        sender: mpsc::Sender<super::ssh_terminal::Input>,
    ) -> Result<(), String> {
        let mut conn = self.connections.lock().await;
        if !conn
            .host()
            .is_ok_and(|current| current.same_connection(host))
        {
            return Err("작업공간 연결이 변경되었습니다.".into());
        }
        if conn.terminals.len() >= 24 {
            return Err("원격 터미널을 최대 24개까지 열 수 있습니다.".into());
        }
        conn.terminals
            .insert(id, WorkspaceTerminal { project, sender });
        Ok(())
    }

    pub(super) async fn terminal_sender(
        &self,
        id: &str,
    ) -> Option<mpsc::Sender<super::ssh_terminal::Input>> {
        self.connections
            .lock()
            .await
            .terminals
            .get(id)
            .map(|terminal| terminal.sender.clone())
    }

    pub(super) async fn remove_terminal(&self, id: &str) {
        self.connections.lock().await.terminals.remove(id);
    }

    fn profiles(&self) -> Result<Vec<Profile>, String> {
        match std::fs::read(&self.profiles) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|err| err.to_string()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(err) => Err(err.to_string()),
        }
    }

    fn write_profiles(&self, profiles: &[Profile]) -> Result<(), String> {
        Self::write_json(&self.profiles, profiles)
    }

    fn save_connection(&self, profile: &mut Profile) -> Result<Vec<Profile>, String> {
        let mut profiles = self.profiles()?;
        let name = profile.name.trim();
        if let Some(index) = profiles.iter().position(|saved| {
            (name.is_empty() || saved.name == name) && same_profile_target(saved, profile)
        }) {
            let saved = &profiles[index];
            profile.name = saved.name.clone();
            if profile.project.is_none() {
                profile.project = saved.project.clone();
            }
            profiles[index] = profile.clone();
        } else {
            if profiles.len() >= 100 {
                return Err("SSH 연결을 최대 100개까지 저장할 수 있습니다.".into());
            }
            let base = if !name.is_empty() {
                name.to_string()
            } else if !profile.alias.is_empty() {
                profile.alias.clone()
            } else if profile.port == 22 {
                format!("{}@{}", profile.user, profile.host)
            } else {
                format!("{}@{}:{}", profile.user, profile.host, profile.port)
            };
            let mut suffix = String::new();
            for number in 2.. {
                let candidate: String = base.chars().take(64 - suffix.len()).collect();
                let candidate = candidate + &suffix;
                if profiles.iter().all(|saved| saved.name != candidate) {
                    profile.name = candidate;
                    break;
                }
                suffix = format!(" ({number})");
            }
            profiles.push(profile.clone());
        }
        self.write_profiles(&profiles)?;
        Ok(profiles)
    }

    fn docker_workspace_path(&self) -> PathBuf {
        self.profiles.with_file_name("docker-workspace.json")
    }

    fn write_json(path: &Path, value: &(impl Serialize + ?Sized)) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(value).map_err(|err| err.to_string())?;
        let temporary = path.with_extension("tmp");
        std::fs::write(&temporary, bytes)
            .and_then(|_| std::fs::rename(&temporary, path))
            .map_err(|err| err.to_string())
    }

    fn last_docker_project(&self, host: &DockerHost) -> Result<Value, String> {
        let bytes = match std::fs::read(self.docker_workspace_path()) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
            Err(err) => return Err(err.to_string()),
        };
        let saved: DockerWorkspace =
            serde_json::from_slice(&bytes).map_err(|err| err.to_string())?;
        if saved.endpoint != host.endpoint() {
            return Ok(Value::Null);
        }
        Ok(json!(saved.project))
    }
}

impl Connections {
    fn host(&self) -> Result<WorkspaceHost, String> {
        if let Some(docker) = self.docker.as_ref() {
            return Ok(WorkspaceHost::Docker(docker.clone()));
        }
        self.active
            .as_ref()
            .filter(|active| !active.handle.is_closed())
            .map(|active| WorkspaceHost::Ssh(active.handle.clone()))
            .ok_or_else(|| "먼저 작업공간에 연결하세요.".into())
    }
}

#[tauri::command]
pub async fn open_ssh_workspace(app: AppHandle) -> Result<(), String> {
    open_workspace(app, false).await
}

#[tauri::command]
pub async fn open_docker_workspace(app: AppHandle) -> Result<(), String> {
    open_workspace(app, true).await
}

pub async fn open_remote_alert(app: AppHandle, remote: &Remote, id: &str) -> Result<(), String> {
    let result = remote
        .rpc("notify.get", json!({"notification_id":id}))
        .await?;
    let notice = &result["notification"];
    let workspace = notice["workspace_id"].as_str().unwrap_or("");
    let windows = app.state::<WorkspaceWindows>();
    let (state, local, label) = if workspace.starts_with("remote:ssh:") {
        (&windows.ssh, false, SSH_WINDOW)
    } else if workspace.starts_with("remote:docker:") {
        (&windows.docker, true, DOCKER_WINDOW)
    } else {
        return Err("원격 알림을 찾을 수 없습니다.".into());
    };
    *state.pending_alert.lock().await = Some(notice.clone());
    open_workspace(app.clone(), local).await?;
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.emit("wincmux-remote-alert", ());
    }
    Ok(())
}

async fn open_workspace(app: AppHandle, local: bool) -> Result<(), String> {
    let windows = app.state::<WorkspaceWindows>();
    let (label, url, title, state) = if local {
        (
            DOCKER_WINDOW,
            "ssh-workspace.html?mode=docker",
            "WinCMux 로컬 Docker",
            &windows.docker,
        )
    } else {
        (
            SSH_WINDOW,
            "ssh-workspace.html",
            "WinCMux 원격 작업공간",
            &windows.ssh,
        )
    };
    let _launch = state.opening.lock().await;
    if let Some(window) = app.get_webview_window(label) {
        window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|err| err.to_string())?;
        return Ok(());
    }
    let instance = Uuid::new_v4();
    let connections = state.connections.clone();
    *connections.lock().await = Connections {
        window: instance,
        ..Default::default()
    };
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(1180.0, 740.0)
        .min_inner_size(780.0, 530.0)
        .build()
        .map_err(|err| err.to_string())?;
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let connections = connections.clone();
            tauri::async_runtime::spawn(async move {
                let mut conn = connections.lock().await;
                if conn.window == instance {
                    *conn = Connections::default();
                }
            });
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn ssh_workspace(
    window: WebviewWindow,
    windows: State<'_, WorkspaceWindows>,
    remote: State<'_, Arc<Remote>>,
    action: String,
    mut params: Value,
) -> Result<Value, String> {
    let state = windows.select(&window)?;
    let local = window.label() == DOCKER_WINDOW;
    let backend = if local { "docker" } else { "ssh" };
    let prefix = format!("remote:{backend}:");
    match action.as_str() {
        "download" => {
            return crate::ssh_viewer::download(state, &params, window.app_handle()).await
        }
        "take-alert" => {
            return Ok(state
                .pending_alert
                .lock()
                .await
                .take()
                .unwrap_or(Value::Null))
        }
        "alert-list" | "alert-clear" => {
            let method = if action == "alert-list" {
                "notify.unread"
            } else {
                "notify.clear"
            };
            return remote.rpc(method, json!({"remote_backend":backend})).await;
        }
        "alert-read" => {
            let id = params["notification_id"]
                .as_str()
                .ok_or("알림을 선택하세요.")?;
            let result = remote
                .rpc("notify.get", json!({"notification_id":id}))
                .await?;
            if !result["notification"]["workspace_id"]
                .as_str()
                .is_some_and(|id| id.starts_with(&prefix))
            {
                return Err("이 작업공간 유형의 알림을 선택하세요.".into());
            }
            return remote.rpc("notify.mark_read", params).await;
        }
        "reminder.list" => {
            let mut result = remote.rpc(&action, json!({})).await?;
            for (key, id) in [("items", "workspace_id"), ("remote_workspaces", "id")] {
                if let Some(items) = result[key].as_array_mut() {
                    items
                        .retain(|item| item[id].as_str().is_some_and(|id| id.starts_with(&prefix)));
                }
            }
            return Ok(result);
        }
        "reminder.save" | "reminder.cancel" | "reminder.delete" | "reminder.settings.save" => {
            if action == "reminder.save"
                && !params["workspace_id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with(&prefix))
            {
                return Err("예약 대상 작업공간을 확인하세요.".into());
            }
            return remote.rpc(&action, params).await;
        }
        "set-target" => return set_target(state, &remote, params).await,
        "account-status" => {
            let (host, project) = state.project(params["source_terminal_id"].as_str()).await?;
            let cmd = match params["tool"].as_str() {
                Some("claude") => "claude auth status",
                Some("codex") => "codex login status",
                _ => return Err("Unknown profile provider".into()),
            };
            let prefix =
                wincmux_runtime::account_profiles::shell_prefix(&params["account_profiles"])?;
            let tool = params["tool"].as_str().unwrap();
            let script = format!("{prefix}export PATH=\"$HOME/.local/bin:$PATH\"; if command -v python3 >/dev/null; then python3 - {tool} <<'WINCMUX_STATUS'\n{}\nWINCMUX_STATUS\nelif {cmd} >/dev/null 2>&1; then echo '{{\"authenticated\":true}}'; else echo '{{\"authenticated\":false}}'; fi", include_str!("account_status.py"));
            let result = host
                .exec(&project.path, project.container.as_deref(), &script, 4096)
                .await?;
            return serde_json::from_slice(&result)
                .map_err(|_| "로그인 상태를 확인하지 못했습니다.".into());
        }
        "conversation-list" => {
            return crate::remote_conversations::list(
                state,
                params["include_children"].as_bool().unwrap_or(true),
                &wincmux_runtime::account_profiles::shell_prefix(&params["account_profiles"])?,
            )
            .await
        }
        "close-target" => return close_target(state, params).await,
        _ => {}
    }
    if local {
        return match action.as_str() {
            "containers" => {
                let (instance, current) = {
                    let conn = state.connections.lock().await;
                    (conn.window, conn.docker.clone())
                };
                let host = match current {
                    Some(current) => current,
                    None => Arc::new(DockerHost::discover().await?),
                };
                let result = super::ssh_terminal::parse_containers(host.containers().await?)?;
                let mut conn = state.connections.lock().await;
                if conn.window != instance {
                    return Err("Docker 작업공간이 닫혔습니다.".into());
                }
                conn.docker.get_or_insert(host);
                Ok(result)
            }
            "last-project" => {
                let conn = state.connections.lock().await;
                let host = conn
                    .docker
                    .as_ref()
                    .ok_or("먼저 로컬 Docker 목록을 여세요.")?;
                state.last_docker_project(host)
            }
            "browse" | "agent-skills" | "hooks-status" | "hooks-ensure" | "terminal-input"
            | "terminal-resize" | "terminal-close" | "files" | "preview" | "search"
            | "git-status" | "git-diff" | "agent-submit" | "agent-command" | "agent-insert"
            | "agent-cancel" | "agent-toggle" | "agent-send-now" => {
                super::ssh_terminal::action(state, &action, &params).await
            }
            _ => Err("로컬 Docker에서 지원하지 않는 작업입니다.".into()),
        };
    }
    match action.as_str() {
        "profiles" => Ok(json!({"profiles":state.profiles()?,"aliases":ssh_config::aliases()?})),
        "aliases" => Ok(json!(ssh_config::aliases()?)),
        "open-ssh-config" => {
            let path = ssh_config::create_config_file()?;
            crate::desktop::open_vscode(&path).map_err(|err| err.to_string())?;
            Ok(json!({"ok":true}))
        }
        "register-alias" => {
            let alias = params["alias"].as_str().unwrap_or("").trim().to_string();
            let mut conn = state.connections.lock().await;
            let profile = conn
                .tested_manual
                .clone()
                .ok_or("직접 입력한 연결을 먼저 테스트하세요.")?;
            let aliases =
                tokio::task::spawn_blocking(move || ssh_config::save_alias(&alias, &profile))
                    .await
                    .map_err(|err| err.to_string())??;
            conn.tested_manual = None;
            Ok(json!(aliases))
        }
        "pick-key" => {
            let app = window.app_handle().clone();
            tokio::task::spawn_blocking(move || {
                let Some(file) = app.dialog().file().blocking_pick_file() else {
                    return Ok(Value::Null);
                };
                let path = file.into_path().map_err(|err| err.to_string())?;
                Ok(json!(path))
            })
            .await
            .map_err(|err| err.to_string())?
        }
        "disconnect" => {
            let mut conn = state.connections.lock().await;
            *conn = Connections {
                window: conn.window,
                ..Default::default()
            };
            Ok(json!({"ok":true}))
        }
        "connect" | "test-connect" => {
            let mode = if action == "connect" {
                ConnectionMode::Connect
            } else {
                ConnectionMode::Test
            };
            let profile: Profile =
                serde_json::from_value(params).map_err(|_| "SSH 연결 정보를 확인하세요.")?;
            let mut conn = state.connections.lock().await;
            if conn
                .active
                .as_ref()
                .is_some_and(|active| !active.handle.is_closed())
            {
                return Err("현재 연결을 끊은 후 다른 서버에 연결하세요.".into());
            }
            conn.pending = None;
            conn.tested_manual = None;
            let (auth, result) =
                timeout(AUTH_TIMEOUT, Auth::begin(profile))
                    .await
                    .map_err(|_| {
                        "SSH 연결 시간이 초과되었습니다. 주소, 포트, 네트워크를 확인하세요."
                    })??;
            Ok(commit(state, &mut conn, auth, mode, result))
        }
        "confirm" | "answer" => {
            let id = params["id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok());
            let mut conn = state.connections.lock().await;
            if !conn
                .pending
                .as_ref()
                .is_some_and(|pending| Some(pending.id) == id && pending.deadline > Instant::now())
            {
                return Err("SSH 인증 요청이 만료되었습니다. 다시 연결하세요.".into());
            }
            let PendingAuth { mut auth, mode, .. } = conn.pending.take().unwrap();
            let result = if action == "confirm" {
                timeout(AUTH_TIMEOUT, auth.confirm()).await
            } else {
                let answers = serde_json::from_value(params["answers"].take())
                    .map_err(|_| "SSH 인증 입력을 확인하세요.")?;
                timeout(
                    AUTH_TIMEOUT,
                    auth.answer(
                        answers,
                        mode == ConnectionMode::Connect && params["remember"] == true,
                    ),
                )
                .await
            }
            .map_err(|_| "SSH 인증 응답 시간이 초과되었습니다. 다시 연결하세요.")??;
            Ok(commit(state, &mut conn, auth, mode, result))
        }
        "save" => {
            let mut conn = state.connections.lock().await;
            let active = conn
                .active
                .as_mut()
                .filter(|active| !active.handle.is_closed())
                .ok_or("먼저 SSH 서버에 연결하세요.")?;
            if active.profile.project.is_none() {
                return Err("저장할 폴더를 먼저 여세요.".into());
            }
            let profiles = state.save_connection(&mut active.profile)?;
            Ok(json!({"profiles":profiles,"name":active.profile.name}))
        }
        "forget" => {
            let _guard = state.connections.lock().await;
            let mut profiles = state.profiles()?;
            profiles.retain(|profile| profile.name != params["name"].as_str().unwrap_or(""));
            state.write_profiles(&profiles)?;
            Ok(json!({"profiles":profiles}))
        }
        "forget-password" => {
            let conn = state.connections.lock().await;
            let active = conn.active.as_ref().ok_or("SSH 서버에 연결하세요.")?;
            ssh_credentials::remove(&active.credential_key)?;
            Ok(json!({"ok":true}))
        }
        "vscode" => {
            let conn = state.connections.lock().await;
            let profile = &conn
                .active
                .as_ref()
                .ok_or("SSH 서버에 연결하세요.")?
                .profile;
            if profile.alias.is_empty() {
                return Err(
                    "Windows SSH 설정에 있는 별칭으로 연결한 뒤 VS Code에서 열 수 있습니다.".into(),
                );
            }
            let path = profile
                .project
                .as_ref()
                .filter(|project| project.container.is_none())
                .map_or("/", |project| project.path.as_str());
            open_vscode(&profile.alias, path)?;
            Ok(json!({"ok":true}))
        }
        _ => super::ssh_terminal::action(state, &action, &params).await,
    }
}

async fn set_target(state: &SshWindow, remote: &Remote, params: Value) -> Result<Value, String> {
    let mut project: Project =
        serde_json::from_value(params).map_err(|_| "작업공간 폴더를 지정하세요.")?;
    let host = state.host().await?;
    project.path =
        super::ssh_terminal::directory(&host, &project.path, project.container.as_deref()).await?;
    let mut conn = state.connections.lock().await;
    if !conn.host()?.same_connection(&host) {
        return Err("작업공간 연결이 변경되었습니다.".into());
    }
    match &host {
        WorkspaceHost::Ssh(_) => {
            conn.active.as_mut().unwrap().profile.project = Some(project.clone())
        }
        WorkspaceHost::Docker(host) => {
            SshWindow::write_json(
                &state.docker_workspace_path(),
                &DockerWorkspace {
                    endpoint: host.endpoint().into(),
                    project: project.clone(),
                },
            )?;
            conn.docker_project = Some(project.clone());
        }
    }
    let authority = match &host {
        WorkspaceHost::Ssh(_) => conn.active.as_ref().unwrap().credential_key.as_str(),
        WorkspaceHost::Docker(host) => host.endpoint(),
    };
    let account_scope = json!([authority, project.container]).to_string();
    drop(conn);
    let mut result = json!(project);
    result["account_scope"] = json!(account_scope);
    if let Ok(context) = state.notice_project(&host, &project).await {
        if remote
            .rpc("remote_project.register", context.clone())
            .await
            .is_ok()
        {
            result["notification_workspace"] = context["id"].clone();
        }
    }
    Ok(result)
}

async fn close_target(state: &SshWindow, params: Value) -> Result<Value, String> {
    let project: Project =
        serde_json::from_value(params).map_err(|_| "닫을 작업환경을 선택하세요.")?;
    let mut conn = state.connections.lock().await;
    let mut result = json!({"ok":true});
    if let Some(active) = conn.active.as_mut() {
        let mut profiles = state.profiles()?;
        if let Some(saved) = profiles.iter_mut().find(|profile| {
            profile.name == active.profile.name
                && same_profile_target(profile, &active.profile)
                && profile.project.as_ref() == Some(&project)
        }) {
            saved.project = None;
            state.write_profiles(&profiles)?;
            result["profiles"] = json!(profiles);
        }
        if active.profile.project.as_ref() == Some(&project) {
            active.profile.project = None;
        }
    } else if let Some(host) = conn.docker.as_ref() {
        if state.last_docker_project(host)? == json!(project) {
            if let Err(err) = std::fs::remove_file(state.docker_workspace_path()) {
                if err.kind() != std::io::ErrorKind::NotFound {
                    return Err(err.to_string());
                }
            }
        }
        if conn.docker_project.as_ref() == Some(&project) {
            conn.docker_project = None;
        }
    }
    conn.terminals
        .retain(|_, terminal| terminal.project != project);
    Ok(result)
}

fn open_vscode(alias: &str, path: &str) -> Result<(), String> {
    let mut uri = tauri::Url::parse(&format!("vscode-remote://ssh-remote+{alias}/"))
        .map_err(|err| err.to_string())?;
    uri.path_segments_mut()
        .map_err(|_| "VS Code 폴더 주소를 만들 수 없습니다.")?
        .clear()
        .extend(path[1..].split('/'));
    for (variable, relative) in [
        ("LOCALAPPDATA", "Programs/Microsoft VS Code/Code.exe"),
        ("ProgramFiles", "Microsoft VS Code/Code.exe"),
        ("ProgramFiles(x86)", "Microsoft VS Code/Code.exe"),
    ] {
        let Some(base) = std::env::var_os(variable) else {
            continue;
        };
        let exe = PathBuf::from(base).join(relative);
        if exe.is_file() {
            hidden_command(&exe.to_string_lossy())
                .args(["--folder-uri", uri.as_str()])
                .spawn()
                .map_err(|err| err.to_string())?;
            return Ok(());
        }
    }
    Err("Windows에 VS Code를 설치하고 Remote - SSH 확장을 추가하세요.".into())
}

fn same_profile_target(left: &Profile, right: &Profile) -> bool {
    if !left.alias.is_empty() || !right.alias.is_empty() {
        return left.alias.eq_ignore_ascii_case(&right.alias);
    }
    left.host.eq_ignore_ascii_case(&right.host)
        && left.user == right.user
        && left.port == right.port
        && left.identity == right.identity
}

fn commit(
    state: &SshWindow,
    conn: &mut Connections,
    auth: Auth,
    mode: ConnectionMode,
    mut result: Value,
) -> Value {
    if result["state"] == "connected" {
        if mode == ConnectionMode::Test {
            let manual = auth.profile.alias.is_empty();
            if manual {
                conn.tested_manual = Some(auth.profile);
            }
            return json!({"state":"tested","manual":manual});
        }
        result["alias"] = json!(auth.profile.alias);
        if result["password_cached"].is_null() {
            result["password_cached"] = json!(
                ssh_credentials::read(&auth.credential_key).is_ok_and(|value| value.is_some())
            );
        }
        let mut profile = auth.profile;
        match state.save_connection(&mut profile) {
            Ok(profiles) => result["profiles"] = json!(profiles),
            Err(error) => {
                let message = format!("연결을 저장하지 못했습니다. {error}");
                result["message"] = json!(match result["message"].as_str() {
                    Some(previous) => format!("{previous}\n{message}"),
                    None => message,
                });
            }
        }
        result["name"] = json!(profile.name);
        result["project"] = json!(profile.project.take());
        conn.active = Some(Active {
            profile,
            handle: Arc::new(auth.handle),
            credential_key: auth.credential_key,
        });
    } else {
        let id = Uuid::new_v4();
        let deadline = Instant::now() + ANSWER_TIMEOUT;
        conn.pending = Some(PendingAuth {
            id,
            deadline,
            auth,
            mode,
        });
        result["id"] = json!(id.to_string());
        let connections = state.connections.clone();
        tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let mut conn = connections.lock().await;
            if conn
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == id)
            {
                conn.pending = None;
            }
        });
    }
    result
}
