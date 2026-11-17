#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::{json, Value};
use std::{io::Read, path::PathBuf, sync::Arc, time::Duration};
use wincmux_runtime::{
    client::Connection,
    core::{Core, Filter},
    pipe, platform,
    store::Result,
};
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let option = |key: &str| {
        args.iter()
            .position(|a| a == key)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let root = option("--data-dir")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("WINCMUX_TAURI_DATA_DIR").map(PathBuf::from))
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("WinCMux-Tauri")
        });
    let name = option("--pipe")
        .or_else(|| std::env::var("WINCMUX_TAURI_PIPE").ok())
        .unwrap_or_else(|| r"\\.\pipe\wincmux-tauri-rpc".into());
    if let Some(position) = args.iter().position(|a| a == "--agent-hook") {
        // Hooks must never delay or fail the agent that invoked them. The
        // payload may contain prompts and tool output; only named IDs leave here.
        let provider = args.get(position + 1).map(String::as_str).unwrap_or("");
        let event = args.get(position + 2).map(String::as_str).unwrap_or("");
        let sid = std::env::var("WINCMUX_HOOK_SESSION_ID").unwrap_or_default();
        let token = std::env::var("WINCMUX_HOOK_TOKEN").unwrap_or_default();
        let hook_pipe = std::env::var("WINCMUX_HOOK_PIPE").unwrap_or(name);
        if !sid.is_empty() && !token.is_empty() && matches!(provider, "codex" | "claude") {
            let mut bytes = Vec::new();
            const MAX_HOOK_INPUT: usize = 1024 * 1024;
            let read = std::io::stdin()
                .take(MAX_HOOK_INPUT as u64 + 1)
                .read_to_end(&mut bytes);
            if read.is_ok() && bytes.len() <= MAX_HOOK_INPUT {
                if let Ok(payload) = serde_json::from_slice::<Value>(&bytes) {
                    if payload["hook_event_name"].as_str() != Some(event) {
                        return Ok(());
                    }
                    let agent_id = payload["session_id"]
                        .as_str()
                        .or_else(|| payload["thread-id"].as_str());
                    let turn_id = payload["turn_id"]
                        .as_str()
                        .or_else(|| payload["turn-id"].as_str());
                    if let Ok(Ok(connection)) = tokio::time::timeout(
                        Duration::from_secs(2),
                        Connection::connect(&hook_pipe, Arc::new(|_| {})),
                    )
                    .await
                    {
                        let hook_process = platform::process_identity(std::process::id());
                        let _ = tokio::time::timeout(Duration::from_secs(2), connection.request("agent.hook", json!({
                            "session_id":sid,"token":token,"provider":provider,"event":event,
                            "agent_id":agent_id,"turn_id":turn_id,
                            "hook_pid":std::process::id(),"hook_started":hook_process.map(|p| p.started)
                        }))).await;
                    }
                }
            }
        }
        return Ok(());
    }
    let gate = root.join("update.lock");
    if args.iter().any(|a| a == "--cancel-update") {
        let _ = std::fs::remove_file(&gate);
        return Ok(());
    }
    if args.iter().any(|a| a == "--prepare-update") {
        std::fs::create_dir_all(&root)?;
        let expires = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs()
            + 60;
        std::fs::write(&gate, expires.to_string())?;
        let connection = match Connection::connect(&name, Arc::new(|_| {})).await {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                let _ = std::fs::remove_file(&gate);
                return Err(e.into());
            }
        };
        let method = if args.iter().any(|a| a == "--cancel-update") {
            "runtime.cancel_update"
        } else {
            "runtime.prepare_update"
        };
        if let Err(e) = connection.request(method, json!({})).await {
            let _ = std::fs::remove_file(&gate);
            return Err(e.into());
        }
        if method == "runtime.prepare_update" {
            for _ in 0..100 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                if !connection.alive.load(std::sync::atomic::Ordering::Acquire) {
                    return Ok(());
                }
            }
            let _ = connection.request("runtime.cancel_update", json!({})).await;
            let _ = std::fs::remove_file(&gate);
            return Err("core or UI did not stop for the installer".into());
        }
        return Ok(());
    }
    if let Ok(lease) = std::fs::read_to_string(&gate) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        if lease.trim().parse::<u64>().is_ok_and(|t| t > now) {
            return Err("installation in progress; retry after it finishes".into());
        }
        let _ = std::fs::remove_file(&gate);
    }
    std::fs::create_dir_all(&root)?;
    let _owner = platform::single_instance(&root)?;
    let _job = platform::job()?;
    platform::set_log_root(root.clone());
    platform::log("core starting");
    let core = Core::new(&root.join("wincmux.db"))?;
    core.set_hook_pipe(name.clone());
    pipe::serve(core.clone(), name)?;
    if !args.iter().any(|a| a == "--no-tray") {
        let ui = option("--ui-exe")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_exe()?.with_file_name("wincmux-tauri.exe"));
        platform::start(core.clone(), ui);
        let weak = Arc::downgrade(&core);
        core.subscribe(Filter::default(), Arc::new(move |event| {
            if event["method"] == "notify.created" {
                if let Some(core) = weak.upgrade() {
                    let n = event["params"]["notification"].clone();
                    let suppressed = core.suppress_notification(&n);
                    let delivered = if suppressed { false } else {
                        match platform::notify(&core, n.clone()) {
                            Ok(()) => true,
                            Err(error) => { platform::log(&format!("notification delivery failed: {error}")); false }
                        }
                    };
                    let _ = core.rpc("notify.delivery_ack", json!({"notification_id":n["id"],"suppressed":suppressed,"delivered":delivered}));
                }
            }
            true
        }));
    }
    while !core.should_exit() {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    platform::log("core stopping");
    platform::stop();
    core.flush();
    std::process::exit(0)
}
