use serde_json::Value;
use tauri::AppHandle;
use windows::{
    core::{HSTRING, PCWSTR},
    Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID,
    UI::Notifications::ToastNotificationManager,
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
