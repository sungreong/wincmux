use serde_json::Value;
use std::{fs, io::Write, path::PathBuf};

const TOOLS: [(&str, &str); 2] = [("claude", "CLAUDE_CONFIG_DIR"), ("codex", "CODEX_HOME")];

// A named account uses the CLI login stored in its own directory.
pub fn inherited_tokens(key: &str) -> &'static [&'static str] {
    match key {
        "CLAUDE_CONFIG_DIR" => &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ],
        "CODEX_HOME" => &[
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "CODEX_IDENTITY_TOKEN_FILE",
        ],
        _ => &[],
    }
}

fn entries(value: &Value) -> Result<Vec<(&'static str, &'static str, uuid::Uuid)>, String> {
    if !value.is_null() && !value.is_object() {
        return Err("Invalid account profile selection".into());
    }
    let mut profiles = Vec::new();
    for (tool, key) in TOOLS {
        if let Some(value) = value.get(tool) {
            if !value.is_null() {
                let id = uuid::Uuid::parse_str(value.as_str().unwrap_or(""))
                    .map_err(|_| "Invalid profile ID")?;
                profiles.push((tool, key, id));
            }
        }
    }
    Ok(profiles)
}

pub fn local(value: &Value) -> Result<Vec<(&'static str, PathBuf)>, String> {
    let mut env = Vec::new();
    for (tool, key, id) in entries(value)? {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .ok_or("Missing home directory")?;
        let base = std::env::var_os("WINCMUX_TAURI_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(home).join(".wincmux"));
        let dir = base.join("accounts").join(tool).join(id.to_string());
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        if tool == "codex" {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(dir.join("config.toml"))
            {
                Ok(mut f) => f
                    .write_all(b"cli_auth_credentials_store = \"file\"\n")
                    .map_err(|e| e.to_string())?,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(e) => return Err(e.to_string()),
            }
        }
        env.push((key, dir));
    }
    Ok(env)
}

// Claude's auth login can finish OAuth without recording completion of the
// interactive first-run wizard. Repair only that field in WinCMux-owned profiles.
pub fn prepare_claude_session(dir: &std::path::Path) -> std::io::Result<()> {
    use std::io::ErrorKind;
    static UPDATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    if !dir.join(".credentials.json").is_file() {
        return Ok(());
    }
    let _guard = UPDATE.lock().unwrap_or_else(|err| err.into_inner());
    let config = dir.join(".claude.json");
    let original = match fs::read(&config) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    let mut state: Value = serde_json::from_slice(&original)?;
    if !state["oauthAccount"].is_object() || state["hasCompletedOnboarding"] == true {
        return Ok(());
    }
    state["hasCompletedOnboarding"] = Value::Bool(true);
    let temp = dir.join(format!(".onboarding-{}.tmp", uuid::Uuid::new_v4()));
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    let result = (|| {
        serde_json::to_writer_pretty(&mut output, &state)?;
        output.sync_all()?;
        drop(output);
        if fs::read(&config)? != original {
            return Err(std::io::Error::new(
                ErrorKind::WouldBlock,
                "Claude 설정을 갱신 중입니다. 다시 실행하세요.",
            ));
        }
        fs::rename(&temp, &config)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

pub fn shell_prefix(value: &Value) -> Result<String, String> {
    let mut script = String::new();
    for (tool, key, id) in entries(value)? {
        script.push_str(&format!("unset {}; ", inherited_tokens(key).join(" ")));
        script.push_str(&format!("export {key}=\"$HOME/.wincmux/accounts/{tool}/{id}\"; (umask 077; mkdir -p \"${key}\") || exit 1; "));
        if tool == "codex" {
            script.push_str(r#"(umask 077; set -C; test -e "$CODEX_HOME/config.toml" || printf '%s\n' 'cli_auth_credentials_store = "file"' > "$CODEX_HOME/config.toml") || test -f "$CODEX_HOME/config.toml" || exit 1; "#);
        }
    }
    Ok(script)
}
