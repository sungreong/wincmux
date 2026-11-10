use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use windows::{
    core::{IInspectable, HSTRING, PCWSTR},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID,
    UI::Notifications::{ToastNotification, ToastNotificationManager},
};

const GROUP: &str = "WinCMux";

pub fn identify(app: &AppHandle) {
    let id = HSTRING::from(&app.config().identifier);
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(id.as_ptr())) };
}

fn tag(id: &str) -> HSTRING {
    HSTRING::from(
        id.chars()
            .filter(char::is_ascii_alphanumeric)
            .take(16)
            .collect::<String>(),
    )
}

fn escape(text: &str) -> String {
    text.chars()
        .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\r' | '\t'))
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn show(app: &AppHandle, notification: Value) -> windows::core::Result<()> {
    let id = HSTRING::from(&app.config().identifier);
    let title = escape(notification["title"].as_str().unwrap_or("WinCMux"));
    let body = escape(notification["body"].as_str().unwrap_or(""));
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{title}</text><text>{body}</text></binding></visual><audio silent=\"true\"/></toast>"
    )))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
    toast.SetTag(&tag(notification["id"].as_str().unwrap_or("")))?;
    toast.SetGroup(&HSTRING::from(GROUP))?;
    let app = app.clone();
    let _ = toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
        move |_, _| {
            let handle = app.clone();
            let notification = notification.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = handle.emit(
                    "wincmux-notification-open",
                    json!({"notification_id":notification["id"],"notification":notification}),
                );
            });
            Ok(())
        },
    ))?;
    ToastNotificationManager::CreateToastNotifierWithId(&id)?.Show(&toast)
}

pub fn dismiss(app: &AppHandle, params: &Value) {
    let Ok(history) = ToastNotificationManager::History() else {
        return;
    };
    let id = HSTRING::from(&app.config().identifier);
    let group = HSTRING::from(GROUP);
    if params["all"] == true {
        let _ = history.RemoveGroupWithId(&group, &id);
    } else if let Some(ids) = params["ids"].as_array() {
        for notification in ids.iter().filter_map(Value::as_str) {
            let _ = history.RemoveGroupedTagWithId(&tag(notification), &group, &id);
        }
    }
}
