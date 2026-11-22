#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod desktop;
mod local_docker;
mod remote;
mod remote_agent;
mod remote_conversations;
mod ssh_auth;
mod ssh_config;
mod ssh_credentials;
mod ssh_terminal;
mod ssh_viewer;
mod ssh_window;
mod toast;
mod workspace_viewer;
use desktop::Desktop;
use remote::Remote;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{ipc::Channel, AppHandle, Manager, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use wincmux_runtime::{core, store, terminal};

const DEFAULT_PIPE: &str = r"\\.\pipe\wincmux-tauri-rpc";
static CLOSE_PROMPT_OPEN: AtomicBool = AtomicBool::new(false);
const FULL_EXIT_LABEL: &str = "완전히 종료";
const CLOSE_WINDOW_LABEL: &str = "창만 닫기";

#[derive(Debug, PartialEq, Eq)]
enum CloseChoice {
    FullExit,
    CloseWindow,
    Cancel,
}

fn close_choice(result: MessageDialogResult) -> CloseChoice {
    match result {
        MessageDialogResult::Yes => CloseChoice::FullExit,
        MessageDialogResult::No => CloseChoice::CloseWindow,
        MessageDialogResult::Custom(label) if label == FULL_EXIT_LABEL => CloseChoice::FullExit,
        MessageDialogResult::Custom(label) if label == CLOSE_WINDOW_LABEL => {
            CloseChoice::CloseWindow
        }
        _ => CloseChoice::Cancel,
    }
}

fn prompt_close(window: &tauri::Window) {
    if CLOSE_PROMPT_OPEN.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = window.app_handle().clone();
    app.dialog()
        .message("완전히 종료하면 실행 중인 모든 터미널과 하위 작업이 종료됩니다. 창만 닫으면 작업은 백그라운드에서 계속 실행됩니다.")
        .title("WinCMux 종료")
        .parent(window)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            FULL_EXIT_LABEL.into(), CLOSE_WINDOW_LABEL.into(), "취소".into(),
        ))
        .show_with_result(move |result| match close_choice(result) {
            CloseChoice::CloseWindow => {
                CLOSE_PROMPT_OPEN.store(false, Ordering::Release);
                app.exit(0);
            }
            CloseChoice::FullExit => {
                let remote = app.try_state::<Arc<Remote>>().map(|state| Arc::clone(state.inner()));
                let Some(remote) = remote else {
                    CLOSE_PROMPT_OPEN.store(false, Ordering::Release);
                    return;
                };
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = remote.rpc("runtime.shutdown_all", json!({"confirmed":true})).await {
                        CLOSE_PROMPT_OPEN.store(false, Ordering::Release);
                        app.dialog().message(error).title("완전히 종료하지 못했습니다").show(|_| {});
                    } else {
                        app.exit(0);
                    }
                });
            }
            CloseChoice::Cancel => CLOSE_PROMPT_OPEN.store(false, Ordering::Release),
        });
}

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

fn validated_terminal_url(value: &str) -> Result<String, String> {
    if value.len() > 8192 || value.trim() != value || value.chars().any(char::is_control) {
        return Err("올바른 웹 주소가 아닙니다.".into());
    }
    let url = tauri::Url::parse(value).map_err(|_| "올바른 웹 주소가 아닙니다.")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("HTTP 또는 HTTPS 링크만 열 수 있습니다.".into());
    }
    Ok(url.to_string())
}

#[tauri::command]
fn open_terminal_url(url: String) -> Result<(), String> {
    let url = validated_terminal_url(&url)?;
    use windows::{
        core::{w, PCWSTR},
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };
    let wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    let code = result.0 as isize;
    if code <= 32 {
        return Err(format!(
            "기본 브라우저로 링크를 열지 못했습니다 (Windows 오류 {code})."
        ));
    }
    Ok(())
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
    if action == "open-remote-alert" {
        let id = params["notification_id"]
            .as_str()
            .ok_or("알림을 선택하세요.")?;
        ssh_window::open_remote_alert(app, &remote, id).await?;
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
            app.manage(ssh_window::WorkspaceWindows::new(data_dir.clone()));
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
        .on_window_event(move |window, event| {
            if !hidden_test && window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    prompt_close(window);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            rpc,
            subscribe,
            unsubscribe,
            desktop_action,
            take_activation,
            open_terminal_url,
            ssh_window::open_ssh_workspace,
            ssh_window::open_docker_workspace,
            ssh_window::ssh_workspace,
            ssh_terminal::ssh_pty
        ])
        .build(tauri::generate_context!())
        .expect("WinCMux Tauri startup failed");
    app.run(|_, _| {});
}

#[cfg(test)]
mod activation_tests {
    use super::*;
    #[test]
    fn terminal_links_allow_web_urls_only() {
        assert_eq!(
            validated_terminal_url("http://localhost:9012/path?x=1").unwrap(),
            "http://localhost:9012/path?x=1"
        );
        assert_eq!(
            validated_terminal_url("https://example.com/docs").unwrap(),
            "https://example.com/docs"
        );
        for value in [
            "file:///C:/secret",
            "javascript:alert(1)",
            "ftp://example.com",
            "https://",
            " https://example.com",
            "https://example.com\n",
        ] {
            assert!(validated_terminal_url(value).is_err(), "{value}");
        }
    }
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

    #[test]
    fn window_close_choice_distinguishes_full_exit_close_and_cancel() {
        assert_eq!(
            close_choice(MessageDialogResult::Custom(FULL_EXIT_LABEL.into())),
            CloseChoice::FullExit
        );
        assert_eq!(
            close_choice(MessageDialogResult::Custom(CLOSE_WINDOW_LABEL.into())),
            CloseChoice::CloseWindow
        );
        assert_eq!(
            close_choice(MessageDialogResult::Custom("취소".into())),
            CloseChoice::Cancel
        );
        assert_eq!(
            close_choice(MessageDialogResult::Cancel),
            CloseChoice::Cancel
        );
    }
}
