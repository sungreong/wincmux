use crate::store::Result;
use serde_json::{json, Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

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

fn events(provider: &str) -> Result<&'static [&'static str]> {
    EVENTS
        .iter()
        .find(|(name, _)| *name == provider)
        .map(|(_, events)| *events)
        .ok_or_else(|| "unsupported hook provider".into())
}

fn relative(provider: &str) -> Result<&'static str> {
    match provider {
        "codex" => Ok(".codex/hooks.json"),
        "claude" => Ok(".claude/settings.local.json"),
        _ => Err("unsupported hook provider".into()),
    }
}

fn target(root: &Path, provider: &str) -> Result<PathBuf> {
    let root = root.canonicalize()?;
    let path = root.join(relative(provider)?);
    for ancestor in [path.parent().ok_or("invalid hook path")?, path.as_path()] {
        if fs::symlink_metadata(ancestor).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("hook configuration is a link".into());
        }
    }
    Ok(path)
}

fn read(path: &Path) -> Result<Value> {
    if !path.exists() {
        return Ok(json!({}));
    }
    if fs::metadata(path)?.len() > 1024 * 1024 {
        return Err("hook configuration is too large".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(path)?)?;
    if !value.is_object() {
        return Err("hook configuration must be a JSON object".into());
    }
    Ok(value)
}

fn command(core: &Path, provider: &str, event: &str) -> Value {
    if provider == "codex" {
        let quoted = core.to_string_lossy().replace('\'', "''");
        json!({"type":"command","command":format!("& '{quoted}' --agent-hook {provider} {event}"),"timeout":3})
    } else {
        json!({"type":"command","command":core.to_string_lossy(),"args":["--agent-hook",provider,event],"timeout":3})
    }
}

fn owned(value: &Value, provider: &str, event: &str) -> bool {
    let core = value["command"].as_str().is_some_and(|command| {
        Path::new(command.trim_matches('"'))
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("wincmux-core.exe"))
            || command
                .to_ascii_lowercase()
                .contains("wincmux-core.exe\" --agent-hook")
            || command
                .to_ascii_lowercase()
                .contains("wincmux-core.exe' --agent-hook")
    });
    if !core {
        return false;
    }
    let args = value["args"].as_array();
    if args.is_some_and(|a| {
        a.len() == 3 && a[0] == "--agent-hook" && a[1] == provider && a[2] == event
    }) {
        return true;
    }
    value["command"]
        .as_str()
        .is_some_and(|s| s.ends_with(&format!("--agent-hook {provider} {event}")))
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
                        .is_some_and(|handlers| handlers.iter().any(|h| owned(h, provider, event)))
                })
            })
        })
        .count()
}

pub fn status(root: &Path, provider: &str) -> Result<Value> {
    let path = target(root, provider)?;
    let value = read(&path)?;
    let found = count(&value, provider);
    Ok(
        json!({"provider":provider,"path":path,"registered":found == events(provider)?.len(),"events":found,"total":events(provider)?.len()}),
    )
}

pub fn ensure(root: &Path, provider: &str, core: &Path) -> Result<Value> {
    let path = target(root, provider)?;
    let mut value = read(&path)?;
    let mut changed = false;
    let object = value.as_object_mut().ok_or("invalid hook configuration")?;
    let hooks = object
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or("hooks must be a JSON object")?;
    for event in events(provider)? {
        let groups = hooks
            .entry(*event)
            .or_insert_with(|| Value::Array(vec![]))
            .as_array_mut()
            .ok_or("hook event must be an array")?;
        if let Some(existing) = groups
            .iter_mut()
            .filter_map(|group| group["hooks"].as_array_mut())
            .flat_map(|handlers| handlers.iter_mut())
            .find(|handler| owned(handler, provider, event))
        {
            let desired = command(core, provider, event);
            if *existing != desired {
                *existing = desired;
                changed = true;
            }
            continue;
        }
        groups.push(if event == &"Notification" {
            json!({"matcher":"permission_prompt","hooks":[command(core, provider, event)]})
        } else {
            json!({"hooks":[command(core, provider, event)]})
        });
        changed = true;
    }
    if changed {
        fs::create_dir_all(path.parent().ok_or("invalid hook path")?)?;
        fs::write(&path, serde_json::to_vec_pretty(&value)?)?;
    }
    let mut result = status(root, provider)?;
    result["changed"] = json!(changed);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merges_without_replacing_other_hooks_and_is_idempotent() -> Result<()> {
        let root = std::env::temp_dir().join(format!("wincmux-hook-config-{}", crate::store::id()));
        fs::create_dir_all(root.join(".claude"))?;
        let path = root.join(".claude/settings.local.json");
        fs::write(
            &path,
            r#"{"permissions":{"allow":["Bash(ls)"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo existing"}]}]}}"#,
        )?;
        let core = Path::new(r"C:\Program Files\WinCMux\wincmux-core.exe");
        assert_eq!(ensure(&root, "claude", core)?["changed"], true);
        assert_eq!(ensure(&root, "claude", core)?["changed"], false);
        let value = read(&path)?;
        assert_eq!(value["permissions"]["allow"][0], "Bash(ls)");
        assert_eq!(value["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(status(&root, "claude")?["registered"], true);
        assert_eq!(ensure(&root, "codex", core)?["registered"], true);
        let codex_path = root.join(".codex/hooks.json");
        let codex = read(&codex_path)?;
        assert_eq!(
            codex["hooks"]["Stop"][0]["hooks"][0]["command"],
            "& 'C:\\Program Files\\WinCMux\\wincmux-core.exe' --agent-hook codex Stop"
        );
        assert_eq!(ensure(&root, "codex", core)?["changed"], false);
        let mut legacy = read(&codex_path)?;
        legacy["hooks"]["Stop"][0]["hooks"][0]["command"] =
            json!(r#""C:\Program Files\WinCMux\wincmux-core.exe" --agent-hook codex Stop"#);
        fs::write(&codex_path, serde_json::to_vec_pretty(&legacy)?)?;
        assert_eq!(ensure(&root, "codex", core)?["changed"], true);
        assert_eq!(count(&read(&codex_path)?, "codex"), 6);
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
