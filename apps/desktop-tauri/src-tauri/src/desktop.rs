use crate::{
    assets, core,
    store::{self, text, Result},
    terminal::hidden_command,
    toast,
};
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    AppHandle, Emitter, Manager, UserAttentionType,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

pub struct Desktop {
    pub root: PathBuf,
    context: Mutex<Value>,
    assets: Mutex<()>,
}

impl Desktop {
    pub fn new(root: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            root,
            context: Mutex::default(),
            assets: Mutex::default(),
        })
    }

    pub fn notify(&self, app: &AppHandle, notification: &Value) -> (bool, bool) {
        let context = self.context.lock().unwrap().clone();
        let in_app = app
            .get_webview_window("main")
            .is_some_and(|window| window.is_focused().unwrap_or(false));
        let suppressed = in_app
            && context["workspace_id"] == notification["workspace_id"]
            && (notification["session_id"].is_null()
                || context["session_id"] == notification["session_id"]);
        if suppressed {
            return (false, true);
        }
        if !in_app {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.request_user_attention(Some(UserAttentionType::Informational));
            }
        }
        (toast::show(app, notification.clone()).is_ok(), false)
    }

    pub fn action(&self, app: &AppHandle, action: &str, p: Value) -> Result<Value> {
        let ok = json!({"ok":true});
        match action {
            "clipboard-read" => Ok(json!(app.clipboard().read_text().unwrap_or_default())),
            "clipboard-write" => {
                app.clipboard().write_text(store::string(&p, "text")?)?;
                Ok(ok)
            }
            "clipboard-read-image" => {
                let Ok(image) = app.clipboard().read_image() else {
                    return Ok(json!({"hasImage":false}));
                };
                let mut bytes = Vec::new();
                PngEncoder::new(&mut bytes).write_image(
                    image.rgba(),
                    image.width(),
                    image.height(),
                    ExtendedColorType::Rgba8,
                )?;
                let too_large = bytes.len() as u64 > assets::IMAGE_LIMIT;
                let data = if too_large {
                    String::new()
                } else {
                    assets::image_url(&bytes, "image/png")
                };
                Ok(
                    json!({"hasImage":true,"dataUrl":data,"width":image.width(),"height":image.height(),"size":bytes.len(),"tooLarge":too_large}),
                )
            }
            "pick-folder" => {
                let Some(path) = app.dialog().file().blocking_pick_folder() else {
                    return Ok(Value::Null);
                };
                Ok(json!(path.into_path()?))
            }
            "show-context-menu" => {
                let selected = p["has_selection"] == true;
                let copy = MenuItem::with_id(app, "copy", "Copy", selected, None::<&str>)?;
                let paste = MenuItem::with_id(app, "paste", "Paste", true, None::<&str>)?;
                let clear = MenuItem::with_id(
                    app,
                    "clear-selection",
                    "Clear Selection",
                    selected,
                    None::<&str>,
                )?;
                let menu = Menu::with_items(app, &[&copy, &paste, &clear])?;
                if let Some(window) = app.get_webview_window("main") {
                    window.popup_menu(&menu)?;
                }
                Ok(ok)
            }
            "set-unread-badge" => {
                let count = p["count"].as_u64().unwrap_or_default();
                if let Some(window) = app.get_webview_window("main") {
                    window.set_overlay_icon((count > 0).then(|| badge(count)))?;
                }
                Ok(ok)
            }
            "dismiss-notifications" => {
                toast::dismiss(app, &p);
                Ok(ok)
            }
            "update-active-context" => {
                let focused = p["app_focused"] == true;
                *self.context.lock().unwrap() = p;
                if focused {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.request_user_attention(None);
                    }
                }
                Ok(ok)
            }
            "perf-log" => {
                let dir = self.root.join("logs");
                fs::create_dir_all(&dir)?;
                let path = dir.join("perf.jsonl");
                if path
                    .metadata()
                    .is_ok_and(|meta| meta.len() > 8 * 1024 * 1024)
                {
                    let _ = fs::rename(&path, dir.join("perf.previous.jsonl"));
                }
                let line = serde_json::to_string(&p["payload"])? + "\n";
                fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)?
                    .write_all(line.as_bytes())?;
                Ok(ok)
            }
            _ => {
                let path = store::path(text(&p, "path")?)?;
                match action {
                    "open-in-explorer" => assets::reveal(&path),
                    "open-in-vscode" => open_vscode(&path),
                    "git-info" => Ok(core::git_info(&path)),
                    "scan-long-files" => Ok(assets::scan_long_files(
                        &path,
                        p["minLines"].as_u64().unwrap_or(1000).max(1) as usize,
                    )),
                    "agent-assets-scan" => assets::scan_agents(&path),
                    "agent-asset-read" | "agent-asset-write" | "agent-asset-create"
                    | "agent-asset-reveal" => {
                        let _guard = self.assets.lock().unwrap();
                        assets::agent_action(action, &path, &p)
                    }
                    "input-asset-pick-file" => {
                        let Some(file) = app
                            .dialog()
                            .file()
                            .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif"])
                            .blocking_pick_file()
                        else {
                            return Ok(Value::Null);
                        };
                        let _guard = self.assets.lock().unwrap();
                        assets::input_action(
                            "input-asset-import-file",
                            &path,
                            &json!({"filePath":file.into_path()?}),
                        )
                    }
                    "input-assets-list"
                    | "input-asset-create-text"
                    | "input-asset-create-image"
                    | "input-asset-import-file"
                    | "input-asset-read"
                    | "input-asset-rename"
                    | "input-asset-delete"
                    | "input-asset-reveal" => {
                        let _guard = self.assets.lock().unwrap();
                        assets::input_action(action, &path, &p)
                    }
                    _ => Err("unsupported desktop action".into()),
                }
            }
        }
    }
}

pub fn menu_event(app: &AppHandle, id: &str) {
    if matches!(id, "copy" | "paste" | "clear-selection") {
        let _ = app.emit("wincmux-context-action", json!({"action":id}));
    }
}

fn open_vscode(path: &Path) -> Result<Value> {
    for (var, relative) in [
        ("LOCALAPPDATA", "Programs/Microsoft VS Code/Code.exe"),
        ("ProgramFiles", "Microsoft VS Code/Code.exe"),
        ("ProgramFiles(x86)", "Microsoft VS Code/Code.exe"),
    ] {
        let Some(base) = std::env::var_os(var) else {
            continue;
        };
        let exe = PathBuf::from(base).join(relative);
        if exe.is_file() {
            hidden_command(exe.to_string_lossy().as_ref())
                .arg(path)
                .spawn()?;
            return Ok(json!({"ok":true,"method":"code-cli"}));
        }
    }
    let url = tauri::Url::from_file_path(path).map_err(|_| "cannot form VS Code URL")?;
    hidden_command("explorer.exe")
        .arg(format!("vscode://file{}", url.path()))
        .spawn()?;
    Ok(json!({"ok":true,"method":"vscode-protocol"}))
}

fn badge(count: u64) -> Image<'static> {
    const DIGITS: [[u8; 5]; 10] = [
        [7, 5, 5, 5, 7],
        [2, 6, 2, 2, 7],
        [7, 1, 7, 4, 7],
        [7, 1, 7, 1, 7],
        [5, 5, 7, 1, 1],
        [7, 4, 7, 1, 7],
        [7, 4, 7, 5, 7],
        [7, 1, 1, 1, 1],
        [7, 5, 7, 5, 7],
        [7, 5, 7, 1, 7],
    ];
    let mut pixels = vec![0; 16 * 16 * 4];
    for y in 0_i32..16 {
        for x in 0_i32..16 {
            if (2 * x - 15).pow(2) + (2 * y - 15).pow(2) <= 230 {
                let index = ((y * 16 + x) * 4) as usize;
                pixels[index..index + 4].copy_from_slice(&[204, 55, 73, 255]);
            }
        }
    }
    let number = count.min(99).to_string();
    let start = (16 - (number.len() * 4 - 1)) / 2;
    for (digit, ch) in number.bytes().enumerate() {
        for (y, row) in DIGITS[(ch - b'0') as usize].iter().enumerate() {
            for x in 0..3 {
                if row & (4 >> x) != 0 {
                    let at = ((y + 5) * 16 + start + digit * 4 + x) * 4;
                    pixels[at..at + 4].copy_from_slice(&[255, 255, 255, 255]);
                }
            }
        }
    }
    Image::new_owned(pixels, 16, 16)
}
