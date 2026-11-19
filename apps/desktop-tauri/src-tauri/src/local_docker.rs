use crate::{
    remote_agent::{AgentSession, Launch},
    ssh_terminal::{directory_script, require_container, Input},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{io, process::Stdio, sync::Arc, time::Duration};
use tauri::ipc::Channel;
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{mpsc, oneshot},
    time::timeout,
};
use wincmux_runtime::terminal::{hidden_command, Spawned};

const DOCKER: &str = "docker.exe";
const NAMED_PIPE: &str = "npipe:////./pipe/";
const ROUTING_ENV: &[&str] = &[
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
];

pub struct DockerHost {
    endpoint: String,
}

impl DockerHost {
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub async fn discover() -> Result<Self, String> {
        let mut inspect = hidden_command(DOCKER);
        inspect.args([
            "context",
            "inspect",
            "--format",
            "{{json .Endpoints.docker.Host}}",
        ]);
        Self::from_inspect(&run(inspect, 4096).await?)
    }

    fn from_inspect(output: &[u8]) -> Result<Self, String> {
        let endpoint: String = serde_json::from_slice(output)
            .map_err(|_| "Docker 컨텍스트의 연결 주소를 확인할 수 없습니다.")?;
        let pipe = endpoint.strip_prefix(NAMED_PIPE)
            .filter(|name| !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')))
            .ok_or("현재 Docker 컨텍스트가 원격 엔진을 가리킵니다. Windows의 로컬 Docker 컨텍스트를 선택하세요.")?;
        if matches!(pipe, "." | "..") {
            return Err("로컬 Docker 파이프 주소를 확인하세요.".into());
        }
        Ok(Self { endpoint })
    }

    pub async fn containers(&self) -> Result<Vec<u8>, String> {
        let mut command = self.command();
        command.args(["ps", "--no-trunc", "--format", "{{json .}}"]);
        run(command, 512 * 1024).await
    }

    pub async fn exec(
        &self,
        path: &str,
        container: Option<&str>,
        script: &str,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        let id = require_container(container)?;
        let script = directory_script(path, script)?;
        let mut command = self.command();
        command.args(["exec", id, "sh", "-c", &script]);
        run(command, limit).await
    }

    fn command(&self) -> std::process::Command {
        let mut command = hidden_command(DOCKER);
        command
            .args(["--host", &self.endpoint])
            .env("DOCKER_CLI_HINTS", "false");
        for key in ROUTING_ENV {
            command.env_remove(key);
        }
        command
    }

    pub fn spawn_terminal(
        &self,
        container: Option<&str>,
        path: &str,
        launch: Launch,
    ) -> Result<Spawned, String> {
        let id = require_container(container)?;
        let script = launch.container_command();
        let args = [
            "--host",
            self.endpoint.as_str(),
            "exec",
            "-it",
            "--workdir",
            path,
            "-e",
            "TERM=xterm-256color",
            id,
            "sh",
            "-c",
            &script,
        ]
        .map(str::to_owned);
        Spawned::without_hooks(
            DOCKER,
            &args,
            &std::env::temp_dir(),
            ROUTING_ENV,
            &[("DOCKER_CLI_HINTS", "false")],
        )
    }
}

async fn run(command: std::process::Command, max: usize) -> Result<Vec<u8>, String> {
    let mut child = Command::from(command)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                "Docker CLI를 찾을 수 없습니다. Docker Desktop을 설치하세요.".into()
            } else {
                error.to_string()
            }
        })?;
    let mut stdout = child.stdout.take().unwrap().take((max + 1) as u64);
    let mut stderr = child.stderr.take().unwrap();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let status = timeout(Duration::from_secs(12), async {
        let stdout = async {
            if stdout.read_to_end(&mut out).await? > max {
                return Err(io::Error::other("Docker 응답 크기 제한을 초과했습니다."));
            }
            Ok(())
        };
        let stderr = async {
            let mut bytes = [0; 4096];
            loop {
                let size = stderr.read(&mut bytes).await?;
                if size == 0 {
                    break;
                }
                err.extend_from_slice(&bytes[..size.min(4096 - err.len())]);
            }
            Ok(())
        };
        let (status, (), ()) = tokio::try_join!(child.wait(), stdout, stderr)?;
        Ok::<_, io::Error>(status)
    })
    .await
    .map_err(|_| "로컬 Docker의 응답 시간이 초과되었습니다.")?
    .map_err(|error| error.to_string())?;
    if status.success() {
        return Ok(out);
    }
    let error = String::from_utf8_lossy(&err);
    let detail = error.trim();
    let lower = detail.to_ascii_lowercase();
    if lower.contains("failed to connect")
        || lower.contains("cannot connect to the docker daemon")
        || lower.contains("error during connect")
    {
        return Err(
            "로컬 Docker 엔진에 연결할 수 없습니다. Docker Desktop을 시작한 뒤 새로 고침하세요."
                .into(),
        );
    }
    if detail.is_empty() {
        return Err(format!("Docker 명령이 실패했습니다. {status}"));
    }
    Err(detail.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_a_local_windows_docker_engine() {
        let local =
            DockerHost::from_inspect(br#""npipe:////./pipe/dockerDesktopLinuxEngine""#).unwrap();
        assert_eq!(local.endpoint, "npipe:////./pipe/dockerDesktopLinuxEngine");
        for endpoint in [
            "ssh://user@server",
            "tcp://127.0.0.1:2375",
            "npipe:////server/pipe/docker_engine",
            "npipe:////./pipe/../docker_engine",
            "npipe:////./pipe/",
        ] {
            assert!(DockerHost::from_inspect(&serde_json::to_vec(endpoint).unwrap()).is_err());
        }
    }
}

pub fn stream_terminal(
    spawned: Spawned,
    mut input: mpsc::Receiver<Input>,
    stream: Channel<Value>,
    cols: u16,
    rows: u16,
    mut agent: Option<AgentSession>,
) {
    let terminal = Arc::clone(&spawned.terminal);
    let output = stream.clone();
    let managed = agent.is_some();
    let (output_tx, mut output_rx) = mpsc::channel::<String>(128);
    let (send_exit, mut exit) = oneshot::channel();
    spawned.run(
        move |data, _| {
            if managed {
                let _ = output_tx.blocking_send(data);
            } else {
                let _ = output.send(json!({"data":STANDARD.encode(data)}));
            }
        },
        move |code| {
            let _ = send_exit.send(code);
        },
    );
    tokio::spawn(async move {
        let resize = terminal.clone();
        let _ = tokio::task::spawn_blocking(move || resize.resize(cols, rows)).await;
        let mut clock = tokio::time::interval(Duration::from_millis(125));
        clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let code = loop {
            if let Some(agent) = &mut agent {
                agent.notify(&stream);
            }
            tokio::select! {
                result = &mut exit => {
                    while let Ok(data) = output_rx.try_recv() {
                        if let Some(agent) = &mut agent { agent.output(data.as_bytes()); }
                        let _ = stream.send(json!({"data":STANDARD.encode(data)}));
                    }
                    break result.ok()
                },
                Some(data) = output_rx.recv(), if managed => {
                    if let Some(agent) = &mut agent { agent.output(data.as_bytes()); }
                    let _ = stream.send(json!({"data":STANDARD.encode(data)}));
                },
                _ = clock.tick(), if managed => {
                    if let Some(data) = agent.as_mut().and_then(AgentSession::tick) {
                        let target = terminal.clone();
                        let result = tokio::task::spawn_blocking(move || target.write(&String::from_utf8_lossy(&data))).await;
                        if !matches!(result, Ok(Ok(()))) { break None; }
                    }
                },
                next = input.recv() => {
                    let Some(next) = next else { break None };
                    let next = match next {
                        Input::Agent(operation) => {
                            let Some(data) = agent.as_mut().and_then(|agent| agent.apply(operation)) else { continue };
                            Input::Data(data)
                        }
                        Input::Data(data) => {
                            if let Some(agent) = &mut agent { agent.manual(&data); }
                            Input::Data(data)
                        }
                        Input::Resize(cols, rows) => {
                            if let Some(agent) = &mut agent { agent.resize(cols as u16, rows as u16); }
                            Input::Resize(cols, rows)
                        }
                    };
                    let target = terminal.clone();
                    let result = tokio::task::spawn_blocking(move || match next {
                        Input::Data(data) => std::str::from_utf8(&data).map_err(|err| err.to_string())
                            .and_then(|text| target.write(text)),
                        Input::Resize(cols, rows) => target.resize(cols as u16, rows as u16).map(|_| ()),
                        Input::Agent(_) => unreachable!(),
                    }).await;
                    if !matches!(result, Ok(Ok(()))) { break None; }
                }
            }
        };
        drop(output_rx);
        if code.is_none() {
            let _ = tokio::task::spawn_blocking(move || terminal.close()).await;
        }
        let _ = stream.send(json!({"closed":true,"exit":code}));
    });
}
