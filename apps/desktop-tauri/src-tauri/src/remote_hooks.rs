use crate::ssh_terminal::{quote, WorkspaceHost};
use serde_json::{json, Value};
use uuid::Uuid;

const EVENTS: &[(&str, &[&str])] = &[
    (
        "codex",
        &[
            "SessionStart",
            "UserPromptSubmit",
            "PermissionRequest",
            "PostToolUse",
            "Stop",
            "SessionEnd",
        ],
    ),
    (
        "claude",
        &[
            "SessionStart",
            "UserPromptSubmit",
            "PermissionRequest",
            "Notification",
            "PostToolUse",
            "Stop",
            "StopFailure",
            "SessionEnd",
        ],
    ),
];
const MARKER: &[u8] = b"\x1b]7502;";

fn events(provider: &str) -> Result<&'static [&'static str], String> {
    EVENTS
        .iter()
        .find(|(name, _)| *name == provider)
        .map(|(_, events)| *events)
        .ok_or_else(|| "Claude Code 또는 Codex를 선택하세요.".into())
}

fn relative(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude" => Ok(".claude/settings.local.json"),
        "codex" => Ok(".codex/hooks.json"),
        _ => Err("Claude Code 또는 Codex를 선택하세요.".into()),
    }
}

fn hook_command(provider: &str, event: &str) -> Value {
    // The hook subprocess inherits the PTY's controlling terminal. Its stdout stays empty
    // so the agent never receives status bytes as a tool result.
    let command = format!(
        "sh -c 'if [ -n \"$WINCMUX_HOOK_TOKEN\" ]; then printf \"\\033]7502;%s;{provider};{event}\\007\" \"$WINCMUX_HOOK_TOKEN\" > /dev/tty 2>/dev/null || :; fi'"
    );
    json!({"type":"command","command":command,"timeout":3})
}

fn owned(value: &Value, provider: &str, event: &str) -> bool {
    value["command"].as_str().is_some_and(|command| {
        command.contains("WINCMUX_HOOK_TOKEN")
            && command.contains(&format!("7502;%s;{provider};{event}"))
    })
}

fn count(value: &Value, provider: &str) -> usize {
    events(provider)
        .unwrap_or(&[])
        .iter()
        .filter(|event| {
            value["hooks"][**event].as_array().is_some_and(|groups| {
                groups.iter().any(|group| {
                    group["hooks"]
                        .as_array()
                        .is_some_and(|hooks| hooks.iter().any(|hook| owned(hook, provider, event)))
                })
            })
        })
        .count()
}

fn merge(value: &mut Value, provider: &str) -> Result<bool, String> {
    let hooks = value
        .as_object_mut()
        .ok_or("훅 설정은 JSON 객체여야 합니다.")?
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("hooks 값은 JSON 객체여야 합니다.")?;
    let mut changed = false;
    for event in events(provider)? {
        let groups = hooks
            .entry(*event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("훅 이벤트 값은 배열이어야 합니다.")?;
        if let Some(existing) = groups
            .iter_mut()
            .filter_map(|group| group["hooks"].as_array_mut())
            .flat_map(|items| items.iter_mut())
            .find(|item| owned(item, provider, event))
        {
            let desired = hook_command(provider, event);
            if *existing != desired {
                *existing = desired;
                changed = true;
            }
            continue;
        }
        groups.push(if *event == "Notification" {
            json!({"matcher":"permission_prompt","hooks":[hook_command(provider, event)]})
        } else {
            json!({"hooks":[hook_command(provider, event)]})
        });
        changed = true;
    }
    Ok(changed)
}

async fn read(
    host: &WorkspaceHost,
    path: &str,
    container: Option<&str>,
    provider: &str,
) -> Result<(String, Value), String> {
    let file = relative(provider)?;
    let folder = file.split('/').next().unwrap();
    let script = format!(
        "os=$(uname -s 2>/dev/null) || exit 1; printf 'WINCMUX_OS:%s\\n' \"$os\"; \
         [ ! -L {} ] && [ ! -L {} ] || {{ echo '훅 설정 경로가 심볼릭 링크입니다.' >&2; exit 1; }}; \
         if [ -e {} ]; then cat {}; else printf '{{}}'; fi",
        quote(folder), quote(file), quote(file), quote(file)
    );
    let bytes = host.exec(path, container, &script, 128 * 1024).await?;
    let output = std::str::from_utf8(&bytes).map_err(|_| "훅 설정이 UTF-8이 아닙니다.")?;
    let (header, json_text) = output
        .split_once('\n')
        .ok_or("원격 OS를 확인하지 못했습니다.")?;
    let os = header
        .strip_prefix("WINCMUX_OS:")
        .ok_or("원격 OS를 확인하지 못했습니다.")?;
    if !matches!(os, "Linux" | "Darwin") {
        return Err(format!(
            "현재 {os} 원격 환경은 POSIX 훅을 지원하지 않습니다."
        ));
    }
    let value: Value =
        serde_json::from_str(json_text).map_err(|error| format!("훅 설정 JSON 오류: {error}"))?;
    if !value.is_object() {
        return Err("훅 설정은 JSON 객체여야 합니다.".into());
    }
    Ok((os.into(), value))
}

pub async fn status(
    host: &WorkspaceHost,
    path: &str,
    container: Option<&str>,
    provider: &str,
) -> Result<Value, String> {
    let (os, value) = read(host, path, container, provider).await?;
    let found = count(&value, provider);
    Ok(
        json!({"provider":provider,"path":relative(provider)?,"os":os,
        "events":found,"total":events(provider)?.len(),"registered":found == events(provider)?.len()}),
    )
}

pub async fn ensure(
    host: &WorkspaceHost,
    path: &str,
    container: Option<&str>,
    provider: &str,
) -> Result<Value, String> {
    let (_, mut value) = read(host, path, container, provider).await?;
    let changed = merge(&mut value, provider)?;
    if changed {
        let file = relative(provider)?;
        let folder = file.split('/').next().unwrap();
        let temp = format!("{file}.wincmux-{}.tmp", Uuid::new_v4().simple());
        let json = serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?;
        if json.len() > 64 * 1024 {
            return Err("훅 설정이 너무 큽니다.".into());
        }
        let script = format!(
            "umask 077; [ ! -L {} ] && [ ! -L {} ] || exit 1; \
             mkdir -p {} && printf '%s' {} > {} && mv {} {}",
            quote(folder),
            quote(file),
            quote(folder),
            quote(&json),
            quote(&temp),
            quote(&temp),
            quote(file)
        );
        host.exec(path, container, &script, 1024).await?;
    }
    let mut result = status(host, path, container, provider).await?;
    result["changed"] = json!(changed);
    Ok(result)
}

pub struct HookStream {
    token: String,
    provider: String,
    pending: Vec<u8>,
}

impl HookStream {
    pub fn new(token: String, provider: String) -> Self {
        Self {
            token,
            provider,
            pending: Vec::new(),
        }
    }
    pub fn provider(&self) -> &str {
        &self.provider
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(data);
        let mut events = Vec::new();
        loop {
            let Some(start) = self
                .pending
                .windows(MARKER.len())
                .position(|part| part == MARKER)
            else {
                let keep = self.pending.len().min(MARKER.len() - 1);
                self.pending.drain(..self.pending.len() - keep);
                break;
            };
            if start > 0 {
                self.pending.drain(..start);
            }
            let Some(end) = self.pending.iter().position(|byte| *byte == 7) else {
                if self.pending.len() > 256 {
                    self.pending.clear();
                }
                break;
            };
            let payload = String::from_utf8_lossy(&self.pending[MARKER.len()..end]);
            let mut parts = payload.split(';');
            if let (Some(token), Some(provider), Some(event), None) =
                (parts.next(), parts.next(), parts.next(), parts.next())
            {
                if token == self.token
                    && provider == self.provider
                    && events_for_stream(provider).contains(&event)
                {
                    events.push(if event == "Notification" {
                        "PermissionRequest".into()
                    } else {
                        event.into()
                    });
                }
            }
            self.pending.drain(..=end);
        }
        events
    }
}

fn events_for_stream(provider: &str) -> &'static [&'static str] {
    events(provider).unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merge_preserves_other_hooks_and_is_idempotent() {
        let mut value = json!({"permissions":{"allow":["Bash(ls)"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo existing"}]}]}});
        assert!(merge(&mut value, "claude").unwrap());
        assert_eq!(value["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert!(!merge(&mut value, "claude").unwrap());
        assert_eq!(count(&value, "claude"), 8);
    }
    #[test]
    fn hook_stream_requires_token_and_provider_across_chunks() {
        let mut stream = HookStream::new("secret".into(), "codex".into());
        assert!(stream.feed(b"ordinary\x1b]7502;sec").is_empty());
        assert_eq!(stream.feed(b"ret;codex;Stop\x07"), vec!["Stop"]);
        assert!(stream
            .feed(b"\x1b]7502;wrong;codex;Stop\x07\x1b]7502;secret;claude;Stop\x07")
            .is_empty());
        assert!(stream
            .feed(b"\x1b]7502;secret;codex;Unknown\x07")
            .is_empty());
    }
}
