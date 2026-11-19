use crate::{
    local_docker::{self, DockerHost},
    remote::Remote,
    remote_agent::{AgentSession, Composer, Launch},
    ssh_auth::Handle,
    ssh_window::{SshWindow, WorkspaceWindows},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use russh::ChannelMsg;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::{ipc::Channel, State, WebviewWindow};
use tokio::{sync::mpsc, time::timeout};
use uuid::Uuid;

pub(super) enum Input {
    Data(Vec<u8>),
    Resize(u32, u32),
    Agent(Composer),
}

pub(super) enum WorkspaceHost {
    Ssh(Arc<Handle>),
    Docker(Arc<DockerHost>),
}

impl WorkspaceHost {
    pub fn same_connection(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Ssh(a), Self::Ssh(b)) => Arc::ptr_eq(a, b),
            (Self::Docker(a), Self::Docker(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }

    pub async fn exec(
        &self,
        path: &str,
        container: Option<&str>,
        script: &str,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        match self {
            Self::Ssh(handle) => run(handle, shell(path, container, script, false)?, limit).await,
            Self::Docker(host) => host.exec(path, container, script, limit).await,
        }
    }
}

pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub fn directory_script(directory: &str, script: &str) -> Result<String, String> {
    if directory.contains('\0')
        || directory.len() > 4096
        || !(directory.starts_with('/') || directory == "." || directory.is_empty())
    {
        return Err("작업공간 폴더의 절대 경로를 입력하세요.".into());
    }
    Ok(format!(
        "cd {} && {}",
        quote(if directory.is_empty() { "." } else { directory }),
        script
    ))
}

pub fn require_container(container: Option<&str>) -> Result<&str, String> {
    container
        .filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "실행 중인 Docker 컨테이너를 선택하세요.".into())
}

fn shell(
    directory: &str,
    container: Option<&str>,
    script: &str,
    interactive: bool,
) -> Result<String, String> {
    let script = directory_script(directory, script)?;
    if container.is_none() {
        return Ok(script);
    }
    let id = require_container(container)?;
    Ok(format!(
        "docker exec {}{id} sh -c {}",
        if interactive { "-it " } else { "" },
        quote(&script)
    ))
}

pub fn parse_containers(bytes: Vec<u8>) -> Result<Value, String> {
    let items: Vec<Value> = String::from_utf8_lossy(&bytes)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .map_err(|_| "Docker 컨테이너 목록을 읽을 수 없습니다.")?;
    Ok(json!(items))
}

pub(super) fn list_entries(directories_only: bool, first: usize, last: usize) -> String {
    let eligible = if directories_only {
        "[ \"$kind\" = d ] || continue; "
    } else {
        ""
    };
    format!(
        "LC_ALL=C; export LC_ALL; n=0;
        for name in * .[!.]* ..?*; do
            if [ -L \"$name\" ]; then kind=l;
            elif [ -d \"$name\" ]; then kind=d;
            elif [ -f \"$name\" ]; then kind=f;
            elif [ -e \"$name\" ]; then kind=s;
            else continue; fi;
            {eligible}n=$((n+1));
            [ \"$n\" -lt {first} ] && continue;
            printf '%s%s\\000' \"$kind\" \"$name\";
            [ \"$n\" -ge {last} ] && break;
        done; true"
    )
}

pub async fn run(handle: &Handle, command: String, max: usize) -> Result<Vec<u8>, String> {
    let task = async {
        let mut ch = handle.channel_open_session().await.map_err(error)?;
        ch.exec(true, command).await.map_err(error)?;
        let mut output = Vec::new();
        let mut stderr = Vec::new();
        let mut exit = None;
        while let Some(message) = ch.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if output.len() + data.len() > max {
                        let _ = ch.close().await;
                        return Err("원격 응답 크기 제한을 초과했습니다.".into());
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    stderr.extend(data.iter().take(4096_usize.saturating_sub(stderr.len())));
                }
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Failure => {
                    return Err("서버가 원격 명령 실행 요청을 거부했습니다.".into())
                }
                _ => {}
            }
        }
        if exit == Some(0) {
            Ok(output)
        } else if !stderr.is_empty() {
            Err(String::from_utf8_lossy(&stderr).trim().into())
        } else {
            Err(format!(
                "원격 명령이 완료되지 않았습니다. 종료 코드 {}",
                exit.map_or_else(|| "없음".into(), |n| n.to_string())
            ))
        }
    };
    timeout(Duration::from_secs(12), task)
        .await
        .map_err(|_| "원격 명령 실행 시간이 초과되었습니다.")?
}

pub async fn action(state: &SshWindow, action: &str, params: &Value) -> Result<Value, String> {
    match action {
        "containers" => {
            let WorkspaceHost::Ssh(handle) = state.host().await? else {
                return Err("SSH 서버에 연결하세요.".into());
            };
            let bytes = run(
                &handle,
                "docker ps --no-trunc --format '{{json .}}'".into(),
                512 * 1024,
            )
            .await?;
            parse_containers(bytes)
        }
        "browse" => {
            let host = state.host().await?;
            let container = params["container"].as_str();
            let path = directory(&host, params["path"].as_str().unwrap_or("."), container).await?;
            let first = params["page"].as_u64().unwrap_or_default().min(499) as usize * 150 + 1;
            let last = first + 150;
            let script = list_entries(true, first, last);
            let output = host.exec(&path, container, &script, 128 * 1024).await?;
            let folders: Vec<_> = output
                .split(|&byte| byte == 0)
                .filter_map(|entry| entry.strip_prefix(b"d"))
                .filter_map(|entry| std::str::from_utf8(entry).ok())
                .collect();
            Ok(
                json!({"path":path,"folders":folders.iter().take(150).collect::<Vec<_>>(),"hasMore":folders.len() > 150}),
            )
        }
        "terminal-input" | "terminal-resize" | "terminal-close" | "agent-submit"
        | "agent-insert" | "agent-cancel" | "agent-toggle" => {
            let id = params["id"].as_str().ok_or("원격 터미널을 지정하세요.")?;
            if action == "terminal-close" {
                state.remove_terminal(id).await;
            } else {
                let input = if action == "terminal-input" {
                    let text = params["text"].as_str().ok_or("터미널 입력을 확인하세요.")?;
                    if text.len() > 128 * 1024 {
                        return Err("터미널 입력이 너무 깁니다.".into());
                    }
                    Input::Data(text.as_bytes().to_vec())
                } else if action == "terminal-resize" {
                    Input::Resize(size(params, "cols", 80), size(params, "rows", 24))
                } else {
                    Input::Agent(Composer::parse(action, params)?)
                };
                let sender = state
                    .terminal_sender(id)
                    .await
                    .ok_or("원격 터미널이 종료되었습니다.")?;
                sender
                    .try_send(input)
                    .map_err(|_| "원격 터미널이 닫혔거나 입력이 밀려 있습니다.")?;
            }
            Ok(json!({"ok":true}))
        }
        _ => crate::ssh_viewer::action(state, action, params).await,
    }
}

pub(super) async fn directory(
    host: &WorkspaceHost,
    path: &str,
    container: Option<&str>,
) -> Result<String, String> {
    let output = host.exec(path, container, "pwd -P", 4097).await?;
    let path = std::str::from_utf8(&output)
        .map_err(|_| "UTF-8 폴더 경로를 사용하세요.")?
        .strip_suffix('\n')
        .filter(|path| path.starts_with('/'))
        .ok_or("폴더 경로를 확인하지 못했습니다.")?;
    Ok(path.into())
}

#[tauri::command]
pub async fn ssh_pty(
    window: WebviewWindow,
    windows: State<'_, WorkspaceWindows>,
    remote: State<'_, Arc<Remote>>,
    params: Value,
    stream: Channel<Value>,
) -> Result<String, String> {
    let state = windows.select(&window)?;
    let (host, project) = state.project(params["source_terminal_id"].as_str()).await?;
    let path = &project.path;
    let container = project.container.as_deref();
    let cols = size(&params, "cols", 80);
    let rows = size(&params, "rows", 24);
    let launch = Launch::parse(&params["launch"])?;
    if let Some(probe) = launch.probe(path, matches!(&host, WorkspaceHost::Ssh(_))) {
        let response = host.exec(path, container, &probe, 16 * 1024).await?;
        if !String::from_utf8_lossy(&response)
            .lines()
            .any(|line| line.trim() == "WINCMUX_AGENT_FOUND")
        {
            return Err(launch.missing().into());
        }
    }
    let mut agent = AgentSession::new(launch, cols as u16, rows as u16);
    let id = Uuid::new_v4().to_string();
    if let Some(agent) = &mut agent {
        if let Ok(context) = state.notice_project(&host, &project).await {
            agent.bind_alerts(Arc::clone(remote.inner()), context, id.clone());
        }
    }
    let (sender, mut receiver) = mpsc::channel(128);
    let handle = match &host {
        WorkspaceHost::Ssh(handle) => handle,
        WorkspaceHost::Docker(docker) => {
            state
                .add_terminal(&host, id.clone(), project.clone(), sender)
                .await?;
            let docker = docker.clone();
            let result = tokio::task::spawn_blocking(move || {
                docker.spawn_terminal(project.container.as_deref(), &project.path, launch)
            })
            .await
            .map_err(error)
            .and_then(|result| result);
            match result {
                Ok(spawned) => local_docker::stream_terminal(
                    spawned,
                    receiver,
                    stream,
                    cols as u16,
                    rows as u16,
                    agent,
                ),
                Err(err) => {
                    state.remove_terminal(&id).await;
                    return Err(err);
                }
            }
            return Ok(id);
        }
    };
    let command = shell(
        path,
        container,
        &launch.command(path, container.is_some()),
        true,
    )?;
    let mut channel = timeout(Duration::from_secs(8), handle.channel_open_session())
        .await
        .map_err(|_| "서버가 SSH 터미널 요청에 응답하지 않습니다.")?
        .map_err(error)?;
    channel
        .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(error)?;
    channel.exec(true, command).await.map_err(error)?;
    if let Err(err) = state.add_terminal(&host, id.clone(), project, sender).await {
        let _ = channel.close().await;
        return Err(err);
    }
    tokio::spawn(async move {
        let mut exit = None;
        let mut clock = tokio::time::interval(Duration::from_millis(125));
        clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            if let Some(agent) = &mut agent {
                agent.notify(&stream);
            }
            tokio::select! {
                input = receiver.recv() => {
                    let result = match input {
                        Some(Input::Data(data)) => {
                            if let Some(agent) = &mut agent { agent.manual(&data); }
                            channel.data_bytes(data).await
                        }
                        Some(Input::Resize(cols, rows)) => {
                            if let Some(agent) = &mut agent { agent.resize(cols as u16, rows as u16); }
                            channel.window_change(cols, rows, 0, 0).await
                        }
                        Some(Input::Agent(operation)) => match agent.as_mut().and_then(|agent| agent.apply(operation)) {
                            Some(data) => channel.data_bytes(data).await,
                            None => Ok(()),
                        },
                        None => { let _ = channel.close().await; break; }
                    };
                    if result.is_err() { break; }
                }
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                        if let Some(agent) = &mut agent { agent.output(&data); }
                        if stream.send(json!({"data":STANDARD.encode(data)})).is_err() {
                            let _ = channel.close().await;
                            break;
                        }
                    }
                    Some(ChannelMsg::Failure) => {
                        let _ = stream.send(json!({"error":"서버가 터미널 요청을 거부했습니다."}));
                        let _ = channel.close().await;
                        break;
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
                    None | Some(ChannelMsg::Close) => break,
                    _ => {}
                },
                _ = clock.tick(), if agent.is_some() => {
                    if let Some(data) = agent.as_mut().and_then(AgentSession::tick) {
                        if channel.data_bytes(data).await.is_err() { break; }
                    }
                },
            }
        }
        let _ = stream.send(json!({"closed":true,"exit":exit}));
    });
    Ok(id)
}

fn size(value: &Value, key: &str, default: u32) -> u32 {
    value[key].as_u64().unwrap_or(default.into()).clamp(1, 1000) as u32
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
