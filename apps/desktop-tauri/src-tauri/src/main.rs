#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod desktop;
mod remote;
mod toast;
use desktop::Desktop;
use remote::Remote;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use wincmux_runtime::{core, store, terminal};

const DEFAULT_PIPE: &str = r"\\.\pipe\wincmux-tauri-rpc";

#[tauri::command]
async fn rpc(
    remote: State<'_, Arc<Remote>>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    remote.rpc(&method, params).await
}
#[tauri::command]
fn subscribe(remote: State<'_, Arc<Remote>>, filter: Value, stream: Channel<Vec<Value>>) -> Value {
    remote.subscribe(filter, stream)
}
#[tauri::command]
fn unsubscribe(remote: State<'_, Arc<Remote>>, subscription_id: String) -> Value {
    remote.unsubscribe(&subscription_id);
    json!({"ok":true})
}
#[tauri::command]
async fn take_activation(remote: State<'_, Arc<Remote>>) -> Result<Value, String> {
    let activation = remote.activation.lock().unwrap().take();
    if activation.is_some() {
        remote.rpc("client.activation_ack", json!({})).await?;
    }
    Ok(activation.unwrap_or(Value::Null))
}

#[tauri::command]
async fn desktop_action(
    app: AppHandle,
    desktop: State<'_, Arc<Desktop>>,
    remote: State<'_, Arc<Remote>>,
    action: String,
    params: Value,
) -> Result<Value, String> {
    if action == "update-active-context" {
        remote.context(params).await?;
        return Ok(json!({"ok":true}));
    }
    let desktop = Arc::clone(desktop.inner());
    tauri::async_runtime::spawn_blocking(move || {
        desktop
            .action(&app, &action, params)
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

fn notification_argument(args: &[String]) -> Option<String> {
    let index = args.iter().position(|a| a == "--open-notification")?;
    let uri = args
        .get(index + 1)?
        .strip_prefix("wincmux://notification/")?
        .trim_end_matches('/');
    uuid::Uuid::parse_str(uri).ok().map(|id| id.to_string())
}

fn main() {
    let hidden_test = [
        "WINCMUX_TAURI_DATA_DIR",
        "WINCMUX_TAURI_PIPE",
        "WEBVIEW2_USER_DATA_FOLDER",
    ]
    .into_iter()
    .all(|key| std::env::var_os(key).is_some())
        && std::env::args_os().any(|arg| arg == "--benchmark-hidden");
    let mut builder = tauri::Builder::default();
    if !hidden_test && !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(id) = notification_argument(&args) {
                if let Some(remote) = app.try_state::<Arc<Remote>>() {
                    let remote = Arc::clone(remote.inner());
                    tauri::async_runtime::spawn(async move {
                        let _ = remote.open_notification(&id).await;
                    });
                }
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            toast::identify(&handle);
            let data_dir = match std::env::var_os("WINCMUX_TAURI_DATA_DIR") {
                Some(path) => PathBuf::from(path),
                None => app.path().data_dir()?.join(if cfg!(debug_assertions) {
                    "WinCMux-Tauri-dev"
                } else {
                    "WinCMux-Tauri"
                }),
            };
            let desktop = Desktop::new(data_dir.clone());
            let pipe = std::env::var("WINCMUX_TAURI_PIPE").unwrap_or_else(|_| {
                if cfg!(debug_assertions) {
                    r"\\.\pipe\wincmux-tauri-rpc-dev".to_owned()
                } else {
                    DEFAULT_PIPE.to_owned()
                }
            });
            let remote = match tauri::async_runtime::block_on(Remote::new(
                handle,
                data_dir,
                pipe,
                hidden_test,
            )) {
                Ok(remote) => remote,
                Err(error) => {
                    if !hidden_test {
                        app.dialog()
                            .message(&error)
                            .title("WinCMux 시작 오류")
                            .blocking_show();
                    }
                    return Err(std::io::Error::other(error).into());
                }
            };
            if let Some(id) = notification_argument(&std::env::args().collect::<Vec<_>>()) {
                let _ = tauri::async_runtime::block_on(remote.open_notification(&id));
            }
            app.manage(remote);
            app.manage(desktop);
            if !hidden_test {
                if let Some(window) = app.get_webview_window("main") {
                    window.show()?;
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| desktop::menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            rpc,
            subscribe,
            unsubscribe,
            desktop_action,
            take_activation
        ])
        .build(tauri::generate_context!())
        .expect("WinCMux Tauri startup failed");
    app.run(|_, _| {});
}

#[cfg(test)]
mod activation_tests {
    use super::*;
    #[test]
    fn notification_uri_only_accepts_a_notification_uuid() {
        let id = "30ae6541-c5a7-47ab-bc93-354686339f5b";
        assert_eq!(
            notification_argument(&[
                "--open-notification".into(),
                format!("wincmux://notification/{id}")
            ]),
            Some(id.into())
        );
        assert!(
            notification_argument(&["--open-notification".into(), "file:///cmd.exe".into()])
                .is_none()
        );
        assert!(notification_argument(&[
            "--open-notification".into(),
            "wincmux://notification/../../cmd.exe".into()
        ])
        .is_none());
    }
}
