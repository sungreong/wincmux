#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod core;
mod desktop;
mod detector;
mod layout;
mod pipe;
mod store;
mod terminal;
mod toast;

use core::{Core, Filter};
use desktop::Desktop;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, RunEvent, State};

const DEFAULT_PIPE: &str = r"\\.\pipe\wincmux-tauri-rpc";

#[tauri::command]
async fn rpc(core: State<'_, Arc<Core>>, method: String, params: Value) -> Result<Value, String> {
    let core = Arc::clone(core.inner());
    tauri::async_runtime::spawn_blocking(move || {
        core.rpc(&method, params).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn subscribe(core: State<'_, Arc<Core>>, filter: Filter, stream: Channel<Vec<Value>>) -> Value {
    let id = core.subscribe(
        filter,
        Arc::new(move |mut event| {
            if event["method"] == "session.output" {
                event["method"] = json!("session.output_ready");
                if let Some(params) = event["params"].as_object_mut() {
                    params.remove("output");
                }
            }
            stream.send(vec![event]).is_ok()
        }),
    );
    json!({"subscription_id":id})
}

#[tauri::command]
fn unsubscribe(core: State<'_, Arc<Core>>, subscription_id: String) -> Value {
    core.unsubscribe(&subscription_id);
    json!({"ok":true})
}

#[tauri::command]
async fn desktop_action(
    app: AppHandle,
    desktop: State<'_, Arc<Desktop>>,
    action: String,
    params: Value,
) -> Result<Value, String> {
    let desktop = Arc::clone(desktop.inner());
    tauri::async_runtime::spawn_blocking(move || {
        desktop
            .action(&app, &action, params)
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
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
    if !hidden_test {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
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
                None => app.path().data_dir()?.join("WinCMux-Tauri"),
            };
            let core = Core::new(&data_dir.join("wincmux.db"))
                .map_err(|err| std::io::Error::other(err.to_string()))?;
            let desktop = Desktop::new(data_dir);
            let context = Arc::clone(&desktop);
            let weak_core = Arc::downgrade(&core);
            let filter = serde_json::from_value(json!({"topics":["notify"]}))?;
            core.subscribe(filter, Arc::new(move |event| {
                let notification = event["params"]["notification"].clone();
                let _ = handle.emit("wincmux-notify", &event);
                let handle = handle.clone();
                let context = Arc::clone(&context);
                let core = weak_core.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let (delivered, suppressed) = context.notify(&handle, &notification);
                    if let Some(core) = core.upgrade() {
                        let _ = core.rpc("notify.delivery_ack",json!({
                            "notification_id":notification["id"],"delivered":delivered,"suppressed":suppressed
                        }));
                    }
                });
                true
            }));
            let pipe = std::env::var("WINCMUX_TAURI_PIPE").unwrap_or_else(|_| DEFAULT_PIPE.to_owned());
            pipe::serve(Arc::clone(&core), pipe)?;
            app.manage(core);
            app.manage(desktop);
            if !hidden_test {
                if let Some(window) = app.get_webview_window("main") {
                    window.show()?;
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| desktop::menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![rpc,subscribe,unsubscribe,desktop_action])
        .build(tauri::generate_context!())
        .expect("WinCMux Tauri startup failed");
    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            handle.state::<Arc<Core>>().close_all();
        }
    });
}
