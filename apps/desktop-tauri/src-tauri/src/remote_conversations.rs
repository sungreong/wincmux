use crate::{
    ssh_terminal::{quote, WorkspaceHost},
    ssh_window::SshWindow,
};
use serde_json::Value;
use uuid::Uuid;

const SCANNER: &str = include_str!("remote_conversations.py");

pub async fn list(state: &SshWindow, children: bool, prefix: &str) -> Result<Value, String> {
    let (host, project) = state.project(None).await?;
    scan(
        &host,
        &project.path,
        project.container.as_deref(),
        children,
        prefix,
    )
    .await
}

async fn scan(
    host: &WorkspaceHost,
    path: &str,
    container: Option<&str>,
    children: bool,
    prefix: &str,
) -> Result<Value, String> {
    let script = format!("{prefix}_wincmux_python=$(command -v python3 || command -v python) || {{ printf '%s\\n' '대화 이력을 조회하려면 이 환경에 Python 3가 필요합니다.' >&2; exit 127; }}; \"$_wincmux_python\" -c {} {} {}", quote(SCANNER), quote(path), if children { "1" } else { "0" });
    let bytes = host.exec(path, container, &script, 4 * 1024 * 1024).await?;
    serde_json::from_slice(&bytes).map_err(|_| "대화 목록 응답을 읽지 못했습니다.".into())
}

pub async fn resolve(
    state: &SshWindow,
    prefix: &str,
    provider: &str,
    id: &str,
) -> Result<String, String> {
    let id = Uuid::parse_str(id)
        .map_err(|_| "대화 ID를 확인하세요.")?
        .hyphenated()
        .to_string();
    if !matches!(provider, "claude" | "codex") {
        return Err("Claude 또는 Codex 대화를 선택하세요.".into());
    }
    let (host, project) = state.project(None).await?;
    let result = scan(
        &host,
        &project.path,
        project.container.as_deref(),
        true,
        prefix,
    )
    .await?;
    let item = result["items"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["provider"] == provider && item["id"] == id)
        })
        .ok_or("이 작업환경에서 대화를 찾지 못했습니다. 새로고침 후 다시 선택하세요.")?;
    if item["cwd_exists"] != true {
        return Err("대화를 실행했던 원래 폴더가 없습니다.".into());
    }
    item["cwd"]
        .as_str()
        .map(str::to_owned)
        .ok_or("대화 폴더를 확인할 수 없습니다.".into())
}
