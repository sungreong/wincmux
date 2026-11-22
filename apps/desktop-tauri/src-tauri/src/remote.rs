use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Mutex, RwLock},
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, Emitter};
use wincmux_runtime::{client::Connection, terminal::hidden_command};

type Streams = HashMap<String, (Value, Channel<Vec<Value>>)>;
pub struct Remote {
    connection: RwLock<Option<Arc<Connection>>>,
    streams: Mutex<Streams>,
    pub activation: Mutex<Option<Value>>,
    app: AppHandle,
    root: PathBuf,
    pipe: String,
    hidden: bool,
    instance: Mutex<String>,
    client_id: Mutex<String>,
}
impl Remote {
    pub async fn new(
        app: AppHandle,
        root: PathBuf,
        pipe: String,
        hidden: bool,
    ) -> Result<Arc<Self>, String> {
        let remote = Arc::new(Self {
            connection: RwLock::new(None),
            streams: Mutex::default(),
            activation: Mutex::default(),
            app,
            root,
            pipe,
            hidden,
            instance: Mutex::default(),
            client_id: Mutex::default(),
        });
        remote.connect(true).await?;
        let weak = Arc::downgrade(&remote);
        tauri::async_runtime::spawn(async move {
            let mut delay = Duration::from_millis(250);
            loop {
                tokio::time::sleep(delay).await;
                let Some(r) = weak.upgrade() else {
                    break;
                };
                if r.connected() {
                    delay = Duration::from_millis(250);
                    continue;
                }
                let _ = r
                    .app
                    .emit("wincmux-core-status", json!({"status":"respawning"}));
                match r.connect(true).await {
                    Ok(()) => delay = Duration::from_millis(250),
                    Err(e) => {
                        let _ = r
                            .app
                            .emit("wincmux-core-status", json!({"status":"dead","error":e}));
                        delay = (delay * 2).min(Duration::from_secs(5));
                    }
                }
            }
        });
        Ok(remote)
    }
    fn connected(&self) -> bool {
        self.connection
            .read()
            .unwrap()
            .as_ref()
            .is_some_and(|c| c.alive.load(Ordering::Acquire))
    }
    async fn connect(self: &Arc<Self>, start: bool) -> Result<(), String> {
        let weak = Arc::downgrade(self);
        let event: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(move |e| {
            if let Some(r) = weak.upgrade() {
                r.event(e);
            }
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut launched = false;
        let c = loop {
            match Connection::connect(&self.pipe, event.clone()).await {
                Ok(c) => break c,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && start && !launched => {
                    let current = std::env::current_exe().map_err(|e| e.to_string())?;
                    let exe = current.with_file_name("wincmux-core.exe");
                    if !exe.is_file() {
                        return Err(format!("missing background core: {}", exe.display()));
                    }
                    let mut cmd = hidden_command(&exe.to_string_lossy());
                    cmd.args([
                        "--data-dir",
                        &self.root.to_string_lossy(),
                        "--pipe",
                        &self.pipe,
                        "--ui-exe",
                        &current.to_string_lossy(),
                    ]);
                    if self.hidden {
                        cmd.arg("--no-tray");
                    }
                    cmd.spawn().map_err(|e| e.to_string())?;
                    launched = true;
                }
                Err(e)
                    if (e.kind() == std::io::ErrorKind::NotFound && launched)
                        || e.raw_os_error() == Some(231) => {}
                Err(e) => return Err(format!("cannot connect to core: {e}")),
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("core did not become ready within 10 seconds".into());
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        };
        let info = c.request("runtime.info", json!({})).await?;
        if info["protocol_version"] != 1 || info["version"] != env!("CARGO_PKG_VERSION") {
            return Err(
                "core version mismatch; finish running terminals and restart WinCMux".into(),
            );
        }
        let client_id = format!("ui-{}-{}", std::process::id(), uuid::Uuid::new_v4());
        let expected = self
            .root
            .canonicalize()
            .map_err(|e| format!("data directory mismatch: {e}"))?
            .to_string_lossy()
            .to_lowercase();
        if info["data_directory"]
            .as_str()
            .map(str::to_lowercase)
            .as_deref()
            != Some(expected.as_str())
        {
            return Err("named pipe belongs to a different WinCMux data directory; check the pipe configuration".into());
        }
        let attached = c
            .request("client.attach", json!({"client_id":client_id}))
            .await?;
        *self.client_id.lock().unwrap() = client_id;
        if attached["activation"].is_object() {
            *self.activation.lock().unwrap() = Some(attached["activation"].clone());
        }
        c.request(
            "session.stream.subscribe",
            json!({"topics":["session","notify"],"output_mode":"ready"}),
        )
        .await?;
        let old = std::mem::replace(
            &mut *self.instance.lock().unwrap(),
            info["instance_id"].as_str().unwrap_or_default().into(),
        );
        *self.connection.write().unwrap() = Some(c);
        let _=self.app.emit("wincmux-core-status",json!({"status":"ready","new_runtime":!old.is_empty()&&old!=info["instance_id"].as_str().unwrap_or_default()}));
        Ok(())
    }
    fn event(&self, event: Value) {
        match event["method"].as_str().unwrap_or("") {
            "runtime.disconnected" => {
                let _ = self.app.emit(
                    "wincmux-core-status",
                    json!({"status":"dead","error":"코어 연결 끊김"}),
                );
            }
            "runtime.stopping" => {
                self.app.exit(0);
            }
            "runtime.activation" => {
                *self.activation.lock().unwrap() = Some(event["params"].clone());
                let _ = self.app.emit("wincmux-notification-open", &event["params"]);
            }
            "notify.read_changed" => {
                if let Some(id) = event["params"]["notification_id"].as_str() {
                    crate::toast::dismiss(&self.app, &json!({"ids":[id]}));
                }
                let _ = self.app.emit("wincmux-notify", event);
            }
            "notify.created" | "notify.reminders_changed" => {
                let _ = self.app.emit("wincmux-notify", event);
            }
            _ => {
                let p = &event["params"];
                self.streams.lock().unwrap().retain(|_, (f, ch)| {
                    if f["workspace_id"]
                        .as_str()
                        .is_some_and(|id| p["workspace_id"] != id)
                        || f["session_id"]
                            .as_str()
                            .is_some_and(|id| p["session_id"] != id)
                    {
                        return true;
                    }
                    ch.send(vec![event.clone()]).is_ok()
                });
            }
        }
    }
    pub async fn open_notification(&self, id: &str) -> Result<Value, String> {
        let result = self
            .rpc("notify.get", json!({"notification_id":id}))
            .await?;
        if !result["notification"].is_object() {
            return Err("notification no longer exists".into());
        }
        self.rpc(
            "runtime.activate",
            json!({"notification_id":id,"notification":result["notification"]}),
        )
        .await
    }
    pub async fn context(&self, p: Value) -> Result<Value, String> {
        let id = self.client_id.lock().unwrap().clone();
        self.rpc("client.context", json!({"client_id":id,"context":p}))
            .await
    }
    pub async fn rpc(&self, method: &str, p: Value) -> Result<Value, String> {
        let c = self
            .connection
            .read()
            .unwrap()
            .clone()
            .ok_or("코어 연결 끊김")?;
        c.request(method, p).await
    }
    pub fn subscribe(&self, filter: Value, channel: Channel<Vec<Value>>) -> Value {
        let id = uuid::Uuid::new_v4().to_string();
        self.streams
            .lock()
            .unwrap()
            .insert(id.clone(), (filter, channel));
        json!({"subscription_id":id})
    }
    pub fn unsubscribe(&self, id: &str) {
        self.streams.lock().unwrap().remove(id);
    }
}
