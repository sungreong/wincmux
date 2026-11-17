use crate::{core::Core, store::Result, terminal::hidden_command};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    mem::size_of,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
use windows::{
    core::{w, HSTRING, PCWSTR},
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND, LPARAM, LRESULT, WPARAM,
        },
        System::{
            Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED},
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            LibraryLoader::GetModuleHandleW,
            Threading::{
                CreateMutexW, GetCurrentProcess, GetProcessTimes, OpenProcess,
                CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Shell::{
                Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY,
                NOTIFYICONDATAW,
            },
            WindowsAndMessaging::*,
        },
    },
};

static LOG_ROOT: OnceLock<PathBuf> = OnceLock::new();
#[derive(Clone)]
pub struct ProcessIdentity {
    pub parent: u32,
    pub started: u64,
    pub image: String,
}

pub fn process_identity(pid: u32) -> Option<ProcessIdentity> {
    use windows::Win32::Foundation::FILETIME;
    if pid == 0 {
        return None;
    }
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = None;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ProcessID == pid {
                    let len = entry
                        .szExeFile
                        .iter()
                        .position(|ch| *ch == 0)
                        .unwrap_or(entry.szExeFile.len());
                    found = Some((
                        entry.th32ParentProcessID,
                        String::from_utf16_lossy(&entry.szExeFile[..len]),
                    ));
                    break;
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        let (parent, image) = found?;
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        let ok =
            GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(process);
        ok.then_some(ProcessIdentity {
            parent,
            started: ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
            image,
        })
    }
}

pub fn process_descends_from(mut pid: u32, ancestor: u32) -> bool {
    let mut child_started = u64::MAX;
    for _ in 0..24 {
        let Some(identity) = process_identity(pid) else {
            return false;
        };
        if identity.started > child_started {
            return false;
        }
        if pid == ancestor {
            return true;
        }
        if identity.parent == 0 || identity.parent == pid {
            return false;
        }
        child_started = identity.started;
        pid = identity.parent;
    }
    false
}

pub fn terminal_agent_anchor(root: u32) -> Option<(u32, u64)> {
    let root_identity = process_identity(root)?;
    let root_image = root_identity.image.to_ascii_lowercase();
    if matches!(
        root_image.as_str(),
        "codex.exe" | "claude.exe" | "gemini.exe"
    ) || (root_image.starts_with("codex-") && root_image.ends_with(".exe"))
    {
        return Some((root, root_identity.started));
    }
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut native = Vec::new();
        let mut script_runners = Vec::new();
        let mut parents = HashMap::new();
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|ch| *ch == 0)
                    .unwrap_or(entry.szExeFile.len());
                let image = String::from_utf16_lossy(&entry.szExeFile[..len]).to_ascii_lowercase();
                parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if entry.th32ProcessID != root {
                    if matches!(image.as_str(), "codex.exe" | "claude.exe" | "gemini.exe")
                        || (image.starts_with("codex-") && image.ends_with(".exe"))
                    {
                        native.push(entry.th32ProcessID);
                    } else if matches!(image.as_str(), "node.exe" | "bun.exe") {
                        script_runners.push(entry.th32ProcessID);
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        let descends_in_snapshot = |mut pid: u32| -> bool {
            for _ in 0..24 {
                if pid == root {
                    return true;
                }
                let Some(parent) = parents.get(&pid).copied() else {
                    return false;
                };
                if parent == 0 || parent == pid {
                    return false;
                }
                pid = parent;
            }
            false
        };
        let anchors = |pids: Vec<u32>| -> Vec<(u32, u64)> {
            pids.into_iter()
                .filter(|pid| descends_in_snapshot(*pid))
                .filter(|pid| process_descends_from(*pid, root))
                .filter_map(|pid| process_identity(pid).map(|identity| (pid, identity.started)))
                .collect()
        };
        let native = anchors(native);
        if native.len() == 1 {
            return native.into_iter().next();
        }
        if !native.is_empty() {
            return None;
        }
        // npm-installed agents run under Node. Their MCP servers may start other
        // Node processes below them, so bind to the unique nearest runner.
        let mut nearest = anchors(script_runners)
            .into_iter()
            .filter_map(|(pid, started)| {
                let mut cursor = pid;
                let mut depth = 0;
                while cursor != root && depth < 24 {
                    cursor = *parents.get(&cursor)?;
                    depth += 1;
                }
                (cursor == root).then_some((pid, started, depth))
            })
            .collect::<Vec<_>>();
        nearest.sort_by_key(|(_, _, depth)| *depth);
        let first = nearest.first()?;
        if nearest.get(1).is_some_and(|second| second.2 == first.2) {
            return None;
        }
        Some((first.0, first.1))
    }
}
pub fn process_anchor(
    hook_pid: u32,
    hook_started: u64,
    root: u32,
    provider: &str,
) -> Option<(u32, u64)> {
    let first = process_identity(hook_pid)?;
    if first.started != hook_started || hook_pid == root {
        return None;
    }
    let mut child_started = first.started;
    let mut cursor = first.parent;
    let mut anchor = None;
    for _ in 0..24 {
        if cursor == 0 || cursor == hook_pid {
            return None;
        }
        let current = process_identity(cursor)?;
        if current.started > child_started {
            return None;
        }
        let image = current.image.to_ascii_lowercase();
        let recognized =
            image.contains(provider) || matches!(image.as_str(), "node.exe" | "bun.exe");
        if anchor.is_none() && recognized {
            anchor = Some((cursor, current.started));
        }
        if cursor == root {
            return anchor;
        }
        if current.parent == cursor {
            return None;
        }
        child_started = current.started;
        cursor = current.parent;
    }
    None
}
// RtlGetVersion reports the host build without application manifest version lies.
pub fn windows_pty() -> Value {
    #[repr(C)]
    struct Version {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(version: *mut Version) -> i32;
    }
    static BUILD: OnceLock<Option<u32>> = OnceLock::new();
    let build = BUILD.get_or_init(|| {
        let mut version = Version {
            size: size_of::<Version>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform: 0,
            service_pack: [0; 128],
        };
        (unsafe { RtlGetVersion(&mut version) } == 0).then_some(version.build)
    });
    match build {
        Some(build) => json!({"backend":"conpty","buildNumber":build}),
        None => json!({"backend":"conpty"}),
    }
}
static LOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub fn set_log_root(path: PathBuf) {
    let _ = LOG_ROOT.set(path);
}
pub fn log(message: &str) {
    use std::io::Write;
    let Some(root) = LOG_ROOT.get() else {
        return;
    };
    let _guard = LOG_LOCK.lock().unwrap();
    let path = root.join("core.log");
    if path.metadata().is_ok_and(|m| m.len() > 1024 * 1024) {
        let _ = std::fs::rename(&path, root.join("core.previous.log"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let _ = writeln!(file, "{time} {message}");
    }
}

pub const APP_ID: &str = "ai.manaflow.wincmux.tauri";
pub struct Guard(HANDLE);
impl Drop for Guard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
pub fn lock_name(root: &Path) -> Result<String> {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    root.canonicalize()?
        .to_string_lossy()
        .to_lowercase()
        .hash(&mut hash);
    Ok(format!(
        "Local\\WinCMux-Core-{}-{:x}",
        crate::pipe::current_user_sid()?,
        hash.finish()
    ))
}
pub fn single_instance(root: &Path) -> Result<Guard> {
    unsafe {
        let name = HSTRING::from(lock_name(root)?);
        let handle = CreateMutexW(None, false, PCWSTR(name.as_ptr()))?;
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let _ = CloseHandle(handle);
            return Err("core already owns this data directory".into());
        }
        Ok(Guard(handle))
    }
}
pub fn job() -> Result<Guard> {
    unsafe {
        let handle = CreateJobObjectW(None, None)?;
        let guard = Guard(handle);
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &info as *const _ as _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )?;
        AssignProcessToJobObject(handle, GetCurrentProcess())?;
        Ok(guard)
    }
}
static TRAY_WINDOW: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
static CORE: OnceLock<Arc<Core>> = OnceLock::new();
static UI: OnceLock<PathBuf> = OnceLock::new();
pub fn open_ui(core: &Arc<Core>, activation: Value) {
    core.activate(activation);
    if let Some(path) = UI.get() {
        use std::os::windows::process::CommandExt;
        let _ = hidden_command(&path.to_string_lossy())
            .creation_flags(CREATE_BREAKAWAY_FROM_JOB.0 | CREATE_NO_WINDOW.0)
            .spawn();
    }
}
pub fn start(core: Arc<Core>, ui: PathBuf) {
    let _ = CORE.set(core.clone());
    let _ = UI.set(ui);
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(PCWSTR(
            HSTRING::from(APP_ID).as_ptr(),
        ));
        let instance = GetModuleHandleW(None).unwrap_or_default();
        let class = w!("WinCMuxCoreTray");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: instance.into(),
            lpszClassName: class,
            ..Default::default()
        };
        RegisterClassW(&wc);
        let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class,
            w!("WinCMux"),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance.into()),
            None,
        ) else {
            return;
        };
        TRAY_WINDOW.store(hwnd.0 as isize, std::sync::atomic::Ordering::Release);
        let _ = SetTimer(Some(hwnd), 1, 1000, None);
        update_tray(hwnd, NIM_ADD);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        update_tray(hwnd, NIM_DELETE);
    });
}
unsafe fn update_tray(hwnd: HWND, action: windows::Win32::UI::Shell::NOTIFY_ICON_MESSAGE) {
    let mut data = NOTIFYICONDATAW {
        cbSize: size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: 1,
        uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
        uCallbackMessage: WM_APP + 1,
        hIcon: LoadIconW(None, IDI_APPLICATION).unwrap_or_default(),
        ..Default::default()
    };
    let text = if let Some(core) = CORE.get() {
        let info = core.runtime_info();
        let count = core
            .rpc("agent.list", json!({}))
            .ok()
            .and_then(|r| {
                r["items"]
                    .as_array()
                    .map(|a| a.iter().filter(|s| s["state"] == "blocked").count())
            })
            .unwrap_or(0);
        format!(
            "WinCMux · 터미널 {} · 입력 대기 {count} · 예약 {}",
            info["terminal_count"], info["pending_reminders"]
        )
    } else {
        "WinCMux".into()
    };
    for (d, s) in data.szTip.iter_mut().take(127).zip(text.encode_utf16()) {
        *d = s;
    }
    let _ = Shell_NotifyIconW(action, &data);
}
unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_CLOSE {
        update_tray(hwnd, NIM_DELETE);
        let _ = DestroyWindow(hwnd);
        PostQuitMessage(0);
        return LRESULT(0);
    }
    if msg == WM_TIMER {
        update_tray(hwnd, NIM_MODIFY);
        return LRESULT(0);
    }
    if msg == WM_APP + 1 {
        if let Some(core) = CORE.get() {
            if l.0 as u32 == WM_LBUTTONUP {
                open_ui(core, json!({}));
            }
            if l.0 as u32 == WM_RBUTTONUP || l.0 as u32 == WM_CONTEXTMENU {
                if let Ok(menu) = CreatePopupMenu() {
                    let info = core.runtime_info();
                    let label =
                        HSTRING::from(format!("실행 중인 터미널 {}개", info["terminal_count"]));
                    let _ = AppendMenuW(menu, MF_STRING, 1, w!("WinCMux 열기"));
                    let _ = AppendMenuW(menu, MF_STRING | MF_DISABLED, 2, PCWSTR(label.as_ptr()));
                    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
                    let _ = AppendMenuW(menu, MF_STRING, 3, w!("모든 작업 종료 후 완전히 종료"));
                    let mut point = windows::Win32::Foundation::POINT::default();
                    let _ = GetCursorPos(&mut point);
                    let _ = SetForegroundWindow(hwnd);
                    let choice =
                        TrackPopupMenu(menu, TPM_RETURNCMD, point.x, point.y, None, hwnd, None).0;
                    let _ = DestroyMenu(menu);
                    if choice == 1 {
                        open_ui(core, json!({}));
                    }
                    if choice == 3 {
                        let text = HSTRING::from(format!(
                            "실행 중인 터미널 {}개와 모든 하위 작업을 종료할까요?",
                            info["terminal_count"]
                        ));
                        if MessageBoxW(
                            Some(hwnd),
                            PCWSTR(text.as_ptr()),
                            w!("WinCMux 완전히 종료"),
                            MB_YESNO | MB_ICONWARNING,
                        ) == IDYES
                        {
                            let _ = core.rpc("runtime.shutdown_all", json!({"confirmed":true}));
                        }
                    }
                }
            }
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, w, l)
}
fn tag(id: &str) -> HSTRING {
    HSTRING::from(
        id.chars()
            .filter(char::is_ascii_alphanumeric)
            .take(16)
            .collect::<String>(),
    )
}
fn escape(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
pub fn stop() {
    let value = TRAY_WINDOW.load(std::sync::atomic::Ordering::Acquire);
    if value != 0 {
        unsafe {
            SendMessageW(HWND(value as *mut _), WM_CLOSE, None, None);
        }
    }
}

pub fn notify(core: &Arc<Core>, n: Value) -> Result<()> {
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let result = notify_inner(core, n);
    if initialized {
        unsafe {
            CoUninitialize();
        }
    }
    result
}
fn notify_inner(core: &Arc<Core>, n: Value) -> Result<()> {
    use windows::{
        core::IInspectable,
        Data::Xml::Dom::XmlDocument,
        Foundation::TypedEventHandler,
        UI::Notifications::{ToastNotification, ToastNotificationManager},
    };
    let protocol = UI
        .get()
        .and_then(|path| path.parent())
        .is_some_and(|root| root.join("uninstall.exe").is_file());
    let activation = if protocol {
        format!(
            " activationType=\"protocol\" launch=\"wincmux://notification/{}\"",
            escape(n["id"].as_str().unwrap_or_default())
        )
    } else {
        String::new()
    };
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(format!("<toast{activation}><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><audio silent=\"true\"/></toast>",escape(n["title"].as_str().unwrap_or("WinCMux")),escape(n["body"].as_str().unwrap_or("")))))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
    toast.SetTag(&tag(n["id"].as_str().unwrap_or("")))?;
    toast.SetGroup(&HSTRING::from("WinCMux"))?;
    let core = core.clone();
    if !protocol {
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            move |_, _| {
                open_ui(&core, json!({"notification_id":n["id"],"notification":n}));
                Ok(())
            },
        ))?;
    }
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))?.Show(&toast)?;
    Ok(())
}
