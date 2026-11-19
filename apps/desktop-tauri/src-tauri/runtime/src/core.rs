use crate::{
    detector::{missing_conversation, Conversation, Notice, Resume},
    followups,
    reminders::{self, LimitDetector},
    store::{self, id, text, Result, NOW},
    terminal::{hidden_command, History, Spawned, Terminal},
};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

type Sink = Arc<dyn Fn(Value) -> bool + Send + Sync>;
type HistoryHandle = Arc<Mutex<History>>;

#[derive(Default, Deserialize, serde::Serialize, Clone)]
pub struct Filter {
    workspace_id: Option<String>,
    session_id: Option<String>,
    topics: Option<Vec<String>>,
}

impl Filter {
    fn accepts(&self, method: &str, params: &Value) -> bool {
        let topic = if method.starts_with("notify.") {
            "notify"
        } else {
            "session"
        };
        self.workspace_id
            .as_deref()
            .is_none_or(|id| params["workspace_id"] == id)
            && self
                .session_id
                .as_deref()
                .is_none_or(|id| params["session_id"] == id)
            && self
                .topics
                .as_ref()
                .is_none_or(|topics| topics.iter().any(|item| item == topic))
    }
}

struct LiveSession {
    terminal: Arc<Terminal>,
    detector: Conversation,
    quota: LimitDetector,
    hook_token: String,
    hook_anchor: Option<(u32, u64)>,
}

#[derive(Default)]
struct Sessions {
    running: HashMap<String, LiveSession>,
    recent: VecDeque<(String, HistoryHandle, Instant)>,
}

#[derive(Default)]
struct GitSchedule {
    active: Option<String>,
    due: HashMap<String, Instant>,
    terminal_activity: Option<Instant>,
}

#[derive(Default)]
struct Runtime {
    clients: HashMap<String, Value>,
    idle_since: Option<Instant>,
    prepare_until: Option<Instant>,
    stopping: bool,
    stop_at: Option<Instant>,
    activation: Option<Value>,
}

pub struct Core {
    reminder_delivery_seen: Mutex<HashSet<String>>,
    runtime: Mutex<Runtime>,
    instance: String,
    hook_pipe: Mutex<String>,
    followup_tick: Mutex<Option<Instant>>,
    data_directory: String,
    db: Mutex<Connection>,
    sessions: Mutex<Sessions>,
    changes: Mutex<()>,
    subscribers: Mutex<HashMap<String, (Filter, Sink)>>,
    git: Mutex<GitSchedule>,
}

impl Core {
    pub fn new(path: &Path) -> Result<Arc<Self>> {
        let core = Arc::new(Self {
            reminder_delivery_seen: Mutex::default(),
            runtime: Mutex::default(),
            instance: id(),
            hook_pipe: Mutex::new(r"\\.\pipe\wincmux-tauri-rpc".into()),
            followup_tick: Mutex::new(None),
            data_directory: path
                .parent()
                .and_then(|p| p.canonicalize().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            db: Mutex::new(store::open(path)?),
            sessions: Mutex::default(),
            changes: Mutex::default(),
            subscribers: Mutex::default(),
            git: Mutex::default(),
        });
        let weak = Arc::downgrade(&core);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(500));
            let Some(core) = weak.upgrade() else { break };
            core.check_idle();
        });
        let weak = Arc::downgrade(&core);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(3));
            let Some(core) = weak.upgrade() else { break };
            let _ = core.refresh_git();
        });
        Ok(core)
    }

    pub fn flush(&self) {
        let _ = self
            .db
            .lock()
            .unwrap()
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    pub fn set_hook_pipe(&self, name: String) {
        *self.hook_pipe.lock().unwrap() = name;
    }
    pub fn runtime_info(&self) -> Value {
        let terminals = self.sessions.lock().unwrap().running.len();
        let pending_reminders = reminders::pending_count(&self.db.lock().unwrap());
        let runtime = self.runtime.lock().unwrap();
        json!({"version":env!("CARGO_PKG_VERSION"),"protocol_version":1,"instance_id":self.instance,"data_directory":self.data_directory,"pid":std::process::id(),"terminal_count":terminals,"pending_reminders":pending_reminders,"reminders_supported":true,"client_count":runtime.clients.len(),"preparing_update":runtime.prepare_until.is_some(),"stopping":runtime.stopping,"subscriber_count":self.subscribers.lock().unwrap().len()})
    }
    pub fn detach_client(&self, id: &str) {
        self.runtime.lock().unwrap().clients.remove(id);
    }
    pub fn suppress_notification(&self, n: &Value) -> bool {
        if n["kind"] == "reminder_due" {
            return false;
        }
        self.runtime.lock().unwrap().clients.values().any(|c| {
            c["app_focused"] == true
                && c["workspace_id"] == n["workspace_id"]
                && (n["session_id"].is_null() || c["session_id"] == n["session_id"])
        })
    }
    pub fn activate(&self, activation: Value) {
        self.runtime.lock().unwrap().activation = Some(activation.clone());
        self.emit("runtime.activation", activation);
    }
    pub fn should_exit(&self) -> bool {
        let empty = self.sessions.lock().unwrap().running.is_empty();
        let pending = reminders::pending_count(&self.db.lock().unwrap()) > 0;
        let mut r = self.runtime.lock().unwrap();
        if r.prepare_until.is_some_and(|t| t <= Instant::now()) {
            r.prepare_until = None;
        }
        if r.stopping {
            return r.stop_at.is_some_and(|time| time <= Instant::now());
        }
        if empty && r.clients.is_empty() {
            if r.prepare_until.is_some() {
                return r.stop_at.is_some_and(|time| time <= Instant::now());
            }
            if pending {
                r.idle_since = None;
                return false;
            }
            return r.idle_since.get_or_insert_with(Instant::now).elapsed()
                >= Duration::from_secs(30);
        }
        r.idle_since = None;
        false
    }

    pub fn subscribe(&self, filter: Filter, sink: Sink) -> String {
        let subscription = id();
        self.subscribers
            .lock()
            .unwrap()
            .insert(subscription.clone(), (filter, sink));
        subscription
    }

    pub fn unsubscribe(&self, id: &str) {
        self.subscribers.lock().unwrap().remove(id);
    }

    pub fn emit(&self, method: &str, params: Value) {
        let listeners: Vec<_> = self
            .subscribers
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, (filter, _))| filter.accepts(method, &params))
            .map(|(id, (_, sink))| (id.clone(), Arc::clone(sink)))
            .collect();
        let event = json!({"jsonrpc":"2.0","method":method,"params":params});
        for (id, send) in listeners {
            if !send(event.clone()) {
                self.unsubscribe(&id);
            }
        }
    }

    pub fn rpc(self: &Arc<Self>, method: &str, p: Value) -> Result<Value> {
        let ok = json!({"ok":true});
        match method {
            "runtime.info" => Ok(self.runtime_info()),
            "mcp.settings.get" => {
                let enabled = self.db.lock().unwrap().query_row(
                    "SELECT enabled FROM mcp_settings WHERE id=1",
                    [],
                    |row| row.get::<_, bool>(0),
                )?;
                let tools: Value =
                    serde_json::from_str(include_str!("../../../../../bridge/mcp/tools.json"))?;
                let server_path = std::env::current_exe()?
                    .parent()
                    .map(|dir| dir.join("mcp/server.cjs"))
                    .filter(|path| path.is_file())
                    .or_else(|| {
                        let development = Path::new(env!("CARGO_MANIFEST_DIR"))
                            .join("../../../../bridge/mcp/server.cjs");
                        std::fs::canonicalize(development).ok()
                    })
                    .map(|path| path.to_string_lossy().into_owned());
                Ok(
                    json!({"enabled":enabled,"transport":"stdio","tools":tools,"server_path":server_path}),
                )
            }
            "mcp.settings.save" => {
                let enabled = p["enabled"].as_bool().ok_or("enabled must be a boolean")?;
                self.db
                    .lock()
                    .unwrap()
                    .execute("UPDATE mcp_settings SET enabled=?1 WHERE id=1", [enabled])?;
                self.emit("mcp.settings.changed", json!({"enabled":enabled}));
                Ok(json!({"enabled":enabled}))
            }
            "mcp.activity.list" => {
                let items = store::rows(
                    &self.db.lock().unwrap(),
                    "SELECT at,tool,outcome FROM mcp_activity ORDER BY id DESC LIMIT 50",
                    [],
                )?;
                Ok(json!({"items":items}))
            }
            "mcp.activity.record" => {
                let tool = text(&p, "tool")?;
                let outcome = text(&p, "outcome")?;
                let supported: Value =
                    serde_json::from_str(include_str!("../../../../../bridge/mcp/tools.json"))?;
                if !supported
                    .as_array()
                    .is_some_and(|tools| tools.iter().any(|item| item["name"] == tool))
                    || !matches!(outcome, "success" | "blocked" | "failed")
                {
                    return Err("invalid MCP activity".into());
                }
                let db = self.db.lock().unwrap();
                db.execute(
                    "INSERT INTO mcp_activity(at,tool,outcome) VALUES(?1,?2,?3)",
                    params![chrono::Utc::now().timestamp(), tool, outcome],
                )?;
                db.execute("DELETE FROM mcp_activity WHERE id NOT IN (SELECT id FROM mcp_activity ORDER BY id DESC LIMIT 200)", [])?;
                Ok(ok)
            }
            "client.attach" => {
                let client = text(&p, "client_id")?;
                let mut runtime = self.runtime.lock().unwrap();
                if runtime.prepare_until.is_some() || runtime.stopping {
                    return Err("runtime is preparing to stop".into());
                }
                runtime.clients.insert(client.into(), json!({}));
                runtime.idle_since = None;
                Ok(json!({"runtime":self.instance,"activation":runtime.activation.clone()}))
            }
            "client.context" => {
                let mut runtime = self.runtime.lock().unwrap();
                let context = runtime
                    .clients
                    .get_mut(text(&p, "client_id")?)
                    .ok_or("client is not attached")?;
                *context = p["context"].clone();
                Ok(ok)
            }
            "client.detach" => {
                self.detach_client(text(&p, "client_id")?);
                Ok(ok)
            }
            "client.activation_ack" => {
                self.runtime.lock().unwrap().activation = None;
                Ok(ok)
            }
            "runtime.cancel_update" => {
                self.runtime.lock().unwrap().prepare_until = None;
                Ok(ok)
            }
            "runtime.prepare_update" | "runtime.shutdown" | "runtime.shutdown_all" => {
                let _change = self.changes.lock().unwrap();
                let count = self.sessions.lock().unwrap().running.len();
                if method != "runtime.shutdown_all" && count != 0 {
                    return Err(format!("{count} terminals are still running; finish them before updating or removing WinCMux").into());
                }
                if method == "runtime.shutdown_all" && p["confirmed"] != true {
                    return Err("explicit confirmation is required".into());
                }
                {
                    let mut runtime = self.runtime.lock().unwrap();
                    runtime.prepare_until = Some(Instant::now() + Duration::from_secs(60));
                    runtime.stopping = method != "runtime.prepare_update";
                }
                if method == "runtime.shutdown_all" {
                    self.close_all();
                }
                // Do not exit while close_all is still terminating children. Leave
                // a short response-drain window after publishing the shutdown event.
                self.runtime.lock().unwrap().stop_at =
                    Some(Instant::now() + Duration::from_millis(500));
                self.emit("runtime.stopping", json!({"reason":method}));
                Ok(ok)
            }
            "session.snapshot" => {
                let terminal = self.terminal(text(&p, "session_id")?)?;
                let mut snapshot = terminal.history.lock().unwrap().snapshot();
                snapshot["windows_pty"] = crate::platform::windows_pty();
                Ok(snapshot)
            }
            "session.screen_text" => {
                let terminal = self.terminal(text(&p, "session_id")?)?;
                let snapshot = terminal.history.lock().unwrap().text_snapshot();
                Ok(snapshot)
            }
            "runtime.activate" => {
                self.activate(p);
                Ok(ok)
            }

            "agent.list" => {
                let sessions = self.sessions.lock().unwrap();
                let items: Vec<_> = sessions
                    .running
                    .iter()
                    .map(|(sid, live)| {
                        let mut state = live.detector.snapshot();
                        state["session_id"] = json!(sid);
                        state["workspace_id"] = json!(live.terminal.workspace);
                        state
                    })
                    .collect();
                Ok(json!({"items":items}))
            }
            "agent.acknowledge" => {
                let sid = text(&p, "session_id")?;
                let revision = p["revision"].as_u64().ok_or("revision is required")?;
                {
                    let mut sessions = self.sessions.lock().unwrap();
                    let live = sessions
                        .running
                        .get_mut(sid)
                        .ok_or("PTY session not attached")?;
                    live.detector.acknowledge(revision);
                }
                self.publish_agent(sid);
                let sessions = self.sessions.lock().unwrap();
                let agent = sessions
                    .running
                    .get(sid)
                    .map(|live| live.detector.snapshot());
                Ok(json!({"agent":agent}))
            }
            "agent.hook_setup" => {
                Ok(json!({"core_path":std::env::current_exe()?.to_string_lossy()}))
            }
            "agent.hook" => {
                let sid = text(&p, "session_id")?;
                let token = text(&p, "token")?;
                let provider = text(&p, "provider")?;
                let event = text(&p, "event")?;
                let agent_id = p["agent_id"].as_str().filter(|s| s.len() <= 128);
                let turn_id = p["turn_id"].as_str().filter(|s| s.len() <= 128);
                let hook_pid = p["hook_pid"]
                    .as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or("missing hook process")?;
                let hook_started = p["hook_started"]
                    .as_u64()
                    .ok_or("missing hook process start")?;
                let (workspace, notice) = {
                    let mut sessions = self.sessions.lock().unwrap();
                    let live = sessions
                        .running
                        .get_mut(sid)
                        .ok_or("PTY session not attached")?;
                    if live.hook_token != token {
                        return Err("invalid session binding".into());
                    }
                    let anchor = crate::platform::process_anchor(
                        hook_pid,
                        hook_started,
                        live.terminal.pid,
                        provider,
                    )
                    .ok_or("hook process does not belong to this terminal")?;
                    if let Some(old) = live.hook_anchor {
                        if old != anchor
                            && crate::platform::process_identity(old.0)
                                .is_some_and(|p| p.started == old.1)
                        {
                            return Err("another agent process owns this terminal".into());
                        }
                        if old != anchor {
                            live.detector.hook_process_gone();
                        }
                    }
                    let workspace = live.terminal.workspace.clone();
                    let notice = live.detector.hook(provider, event, agent_id, turn_id)?;
                    live.hook_anchor = (event != "SessionEnd").then_some(anchor);
                    (workspace, notice)
                };
                self.publish_agent(sid);
                if event == "SessionEnd" {
                    followups::fail_agent(
                        &self.db.lock().unwrap(),
                        sid,
                        chrono::Utc::now().timestamp(),
                    )?;
                    self.emit(
                        "followup.changed",
                        json!({"workspace_id":workspace,"session_id":sid}),
                    );
                }
                if let Some(notice) = notice {
                    let _ = self.announce(sid, &workspace, notice);
                }
                Ok(json!({"ok":true}))
            }
            "followup.list" => followups::list(
                &self.db.lock().unwrap(),
                p["workspace_id"].as_str(),
                p["session_id"].as_str(),
            ),
            "followup.schedule" => {
                let _change = self.changes.lock().unwrap();
                let sid = text(&p, "session_id")?;
                let delivery_mode = p["delivery_mode"].as_str().unwrap_or("at_time");
                if !matches!(delivery_mode, "at_time" | "after_completion" | "when_ready") {
                    return Err("invalid follow-up delivery mode".into());
                }
                let now = chrono::Utc::now().timestamp();
                let due_at = if delivery_mode == "at_time" {
                    p["due_at"].as_i64().ok_or("due_at is required")?
                } else {
                    now
                };
                let prompt = text(&p, "prompt")?;
                let mut sessions = self.sessions.lock().unwrap();
                let live = sessions
                    .running
                    .get_mut(sid)
                    .ok_or("PTY session not attached")?;
                let (provider, agent_id, anchor, completion_after) = if let Some((
                    provider,
                    agent_id,
                )) =
                    live.detector.hook_binding()
                {
                    (
                        provider.to_owned(),
                        agent_id.to_owned(),
                        live.hook_anchor
                            .ok_or("agent process identity is unavailable")?,
                        live.detector.hook_completed_count(),
                    )
                } else {
                    (
                            "terminal".to_owned(),
                            "local-agent".to_owned(),
                            crate::platform::terminal_agent_anchor(live.terminal.pid).ok_or(
                                "no running Codex, Claude, or Gemini process was found in this terminal",
                            )?,
                            live.detector.terminal_completed_count(),
                        )
                };
                if crate::platform::process_identity(anchor.0)
                    .is_none_or(|identity| identity.started != anchor.1)
                    || !crate::platform::process_descends_from(anchor.0, live.terminal.pid)
                {
                    return Err("agent process is no longer attached to this terminal".into());
                }
                live.detector.recognize_agent_process();
                let result = followups::schedule(
                    &self.db.lock().unwrap(),
                    sid,
                    &live.terminal.workspace,
                    &provider,
                    &agent_id,
                    anchor,
                    prompt,
                    due_at,
                    now,
                    delivery_mode,
                    completion_after,
                )?;
                self.emit("followup.changed", json!({"workspace_id":live.terminal.workspace,"session_id":sid,"id":result["id"]}));
                Ok(result)
            }
            "followup.cancel" | "followup.pause" | "followup.resume" => {
                let id = text(&p, "id")?;
                let now = chrono::Utc::now().timestamp();
                let result = {
                    let db = self.db.lock().unwrap();
                    match method {
                        "followup.cancel" => followups::cancel(&db, id, now),
                        "followup.pause" => followups::pause(&db, id, now),
                        _ => followups::resume(&db, id, now),
                    }?
                };
                self.emit("followup.changed", result.clone());
                Ok(result)
            }
            "followup.send_now" => {
                let id = text(&p, "id")?;
                let now = chrono::Utc::now().timestamp();
                let row = followups::pending_by_id(&self.db.lock().unwrap(), id)?;
                self.deliver_followup(&row, now, true)?;
                Ok(followups::by_id(&self.db.lock().unwrap(), id)?)
            }
            "session.run" => self.start_session(&p),
            "session.write" => {
                let _change = self.changes.lock().unwrap();
                let session = text(&p, "session_id")?;
                let input = store::string(&p, "data")?;
                if input.len() > 8 * 1024 * 1024 {
                    return Err("terminal input is too large".into());
                }
                let terminal = {
                    let mut sessions = self.sessions.lock().unwrap();
                    let current = sessions
                        .running
                        .get_mut(session)
                        .ok_or("PTY session not attached")?;
                    current.detector.input(input);
                    current.quota.input(input);
                    Arc::clone(&current.terminal)
                };
                terminal.write(input)?;
                self.publish_agent(session);
                self.git.lock().unwrap().terminal_activity = Some(Instant::now());
                Ok(ok)
            }
            "session.resize" => {
                let cols = dimension(&p, "cols")?;
                let rows = dimension(&p, "rows")?;
                let before_offset = self.terminal(text(&p, "session_id")?)?.resize(cols, rows)?;
                Ok(json!({"ok":true,"before_offset":before_offset}))
            }
            "session.read" | "session.tail" => {
                let sid = text(&p, "session_id")?;
                let limit = p["max_bytes"].as_u64().unwrap_or(600_000).clamp(1, 600_000) as usize;
                let after = p["after_offset"].as_u64().map(|n| n as usize);
                let history = {
                    let sessions = self.sessions.lock().unwrap();
                    sessions
                        .running
                        .get(sid)
                        .map(|session| Arc::clone(&session.terminal.history))
                        .or_else(|| {
                            sessions
                                .recent
                                .iter()
                                .find(|(key, _, _)| key == sid)
                                .map(|(_, h, _)| Arc::clone(h))
                        })
                };
                let (output, end, available) = if let Some(history) = history {
                    let mut history = history.lock().unwrap();
                    let (output, end) = if method == "session.read" {
                        history.read(limit)
                    } else {
                        history.tail(limit, after)
                    };
                    (output, end, history.end_offset())
                } else {
                    (String::new(), 0, 0)
                };
                Ok(
                    json!({"start_offset":end-output.len(),"output":output,"end_offset":end,"available_end_offset":available}),
                )
            }
            "session.close" => {
                let _change = self.changes.lock().unwrap();
                self.close_session(text(&p, "session_id")?)?;
                Ok(ok)
            }
            "workspace.delete" => {
                let _change = self.changes.lock().unwrap();
                let workspace = text(&p, "id")?;
                let ids: Vec<_> = self
                    .sessions
                    .lock()
                    .unwrap()
                    .running
                    .iter()
                    .filter(|(_, session)| session.terminal.workspace == workspace)
                    .map(|(id, _)| id.clone())
                    .collect();
                if !ids.is_empty() && p["confirmed_running"] != true {
                    return Err(format!(
                        "workspace has {} running terminals; confirmation required",
                        ids.len()
                    )
                    .into());
                }
                for id in ids {
                    self.close_session(&id)?;
                }
                self.git.lock().unwrap().due.remove(workspace);
                store::dispatch(&self.db.lock().unwrap(), method, &p)
            }
            "workspace.activate" => {
                let ws = text(&p, "workspace_id")?.to_owned();
                {
                    let db = self.db.lock().unwrap();
                    db.execute(
                        &format!("UPDATE workspaces SET last_active={NOW} WHERE id=?"),
                        [&ws],
                    )?;
                }
                let mut git = self.git.lock().unwrap();
                git.due.remove(&ws);
                git.active = Some(ws);
                Ok(ok)
            }
            "notify.push" => self.notify(p),
            "conversation.list" | "conversation.resolve" => {
                let workspace = {
                    let db = self.db.lock().unwrap();
                    store::workspace(&db, text(&p, "workspace_id")?)?
                };
                let project = text(&workspace, "path")?;
                let children = p["include_children"].as_bool().unwrap_or(true);
                if method == "conversation.resolve" {
                    crate::conversations::resolve(
                        project,
                        children,
                        text(&p, "provider")?,
                        text(&p, "id")?,
                    )
                } else {
                    Ok(crate::conversations::list(
                        project,
                        children,
                        p["refresh"].as_bool().unwrap_or(false),
                    ))
                }
            }
            "reminder.list" => reminders::list(&self.db.lock().unwrap()),
            "reminder.settings.get" => reminders::settings(&self.db.lock().unwrap()),
            "reminder.save" | "reminder.cancel" | "reminder.delete" | "reminder.settings.save" => {
                let result = {
                    let db = self.db.lock().unwrap();
                    match method {
                        "reminder.save" => reminders::save(&db, &p, chrono::Utc::now().timestamp()),
                        "reminder.cancel" => reminders::cancel(&db, text(&p, "id")?),
                        "reminder.delete" => reminders::delete(&db, text(&p, "id")?),
                        _ => reminders::save_settings(&db, &p),
                    }
                }?;
                self.emit("notify.reminders_changed", json!({}));
                Ok(result)
            }
            "group.create" | "session.group.set" | "layout.split" | "pane.session.bind" => {
                let workspace_id = text(&p, "workspace_id")?.to_owned();
                let result = store::dispatch(&self.db.lock().unwrap(), method, &p)?;
                self.emit(
                    "workspace.structure_changed",
                    json!({"workspace_id":workspace_id,"change":method,"pane_id":p["pane_id"],"pane_ids":result["pane_ids"]}),
                );
                Ok(result)
            }
            _ => store::dispatch(&self.db.lock().unwrap(), method, &p),
        }
    }

    fn terminal(&self, id: &str) -> Result<Arc<Terminal>> {
        self.sessions
            .lock()
            .unwrap()
            .running
            .get(id)
            .map(|item| Arc::clone(&item.terminal))
            .ok_or_else(|| format!("PTY session not attached: {id}").into())
    }

    fn start_session(self: &Arc<Self>, p: &Value) -> Result<Value> {
        let _change = self.changes.lock().unwrap();
        {
            let r = self.runtime.lock().unwrap();
            if r.stopping || r.prepare_until.is_some() {
                return Err("runtime is preparing to stop".into());
            }
        }
        let workspace = text(p, "workspace_id")?;
        let cmd = text(p, "cmd")?;
        let args: Vec<String> = match p.get("args") {
            Some(value) => serde_json::from_value(value.clone())?,
            None => Vec::new(),
        };
        let row = store::workspace(&self.db.lock().unwrap(), workspace)?;
        let cwd = store::path(p["cwd"].as_str().unwrap_or(text(&row, "path")?))?;
        let session_id = id();
        let hook_token = id();
        let hook_pipe = self.hook_pipe.lock().unwrap().clone();
        let spawned = Spawned::new(
            cmd,
            &args,
            &cwd,
            workspace,
            &session_id,
            &hook_token,
            &hook_pipe,
        )?;
        let pid = spawned.terminal.pid;
        let inserted = self.db.lock().unwrap().execute(
            &format!("INSERT INTO sessions(id,workspace_id,pid,status,started_at,spawn_cmd,spawn_args,spawn_cwd)
                      VALUES(?,?,?,'running',{NOW},?,?,?)"),
            params![session_id,workspace,pid,cmd,serde_json::to_string(&args)?,cwd.to_string_lossy()],
        );
        if let Err(error) = inserted {
            spawned.terminal.close();
            return Err(error.into());
        }
        self.sessions.lock().unwrap().running.insert(
            session_id.clone(),
            LiveSession {
                terminal: Arc::clone(&spawned.terminal),
                detector: Conversation::new(cmd, &args),
                quota: LimitDetector::new(cmd, &args),
                hook_token,
                hook_anchor: None,
            },
        );
        self.emit(
            "session.state_changed",
            json!({"session_id":session_id,"workspace_id":workspace,"pid":pid,"status":"running"}),
        );
        let output_core = Arc::downgrade(self);
        let output_id = session_id.clone();
        let ws = workspace.to_owned();
        let exit_core = Arc::downgrade(self);
        let exit_id = session_id.clone();
        spawned.run(
            move |output, end| {
                if let Some(core) = output_core.upgrade() {
                    core.handle_output(&output_id, &ws, output, end);
                }
            },
            move |code| {
                if let Some(core) = exit_core.upgrade() {
                    core.handle_exit(&exit_id, code);
                }
            },
        );
        Ok(json!({"session":{"session_id":session_id,"pid":pid,"status":"running"}}))
    }

    fn handle_output(&self, sid: &str, workspace: &str, output: String, end: usize) {
        self.git.lock().unwrap().terminal_activity = Some(Instant::now());
        self.emit(
            "session.output",
            json!({"session_id":sid,"workspace_id":workspace,"output":output,"end_offset":end}),
        );
        let result = self
            .sessions
            .lock()
            .unwrap()
            .running
            .get_mut(sid)
            .map(|session| {
                session.quota.output(&output, Instant::now());
                let (notice, resume) = session.detector.output(&output);
                let prompt = session.terminal.history.lock().unwrap().prompt_state();
                let screen_notice = session.detector.observe_screen(prompt);
                (notice.or(screen_notice), resume)
            });
        self.publish_agent(sid);
        if let Some((notice, resume)) = result {
            if let Some(resume) = resume {
                let _ = self.record_resume(sid, workspace, resume);
            }
            if let Some(notice) = notice {
                let _ = self.announce(sid, workspace, notice);
            }
        }
        if let Some(token) = missing_conversation(&output) {
            let deleted = self
                .db
                .lock()
                .unwrap()
                .execute(
                    "DELETE FROM ai_sessions WHERE workspace_id=? AND resume_cmd LIKE ?",
                    params![workspace, format!("%{token}%")],
                )
                .ok()
                .filter(|count| *count > 0);
            if let Some(deleted) = deleted {
                self.emit(
                    "ai.session.deleted",
                    json!({"workspace_id":workspace,"token":token,"deleted":deleted}),
                );
            }
        }
    }

    fn refresh_git(&self) -> Result<()> {
        if self.runtime.lock().unwrap().clients.is_empty() {
            return Ok(());
        }
        let now = Instant::now();
        let active = {
            let git = self.git.lock().unwrap();
            if git.terminal_activity.is_some_and(|time| {
                now.saturating_duration_since(time) < Duration::from_millis(1500)
            }) {
                return Ok(());
            }
            git.active.clone()
        };
        let candidates = store::rows(
            &self.db.lock().unwrap(),
            "SELECT id,path FROM workspaces ORDER BY (id=?1) DESC,pinned DESC,sort_order",
            [active.as_deref()],
        )?;
        let candidate = {
            let mut git = self.git.lock().unwrap();
            let item = candidates.into_iter().find(|row| {
                row["id"]
                    .as_str()
                    .is_some_and(|id| git.due.get(id).is_none_or(|due| *due <= now))
            });
            if let Some(item) = &item {
                let id = text(item, "id")?;
                let secs = if active.as_deref() == Some(id) { 8 } else { 45 };
                git.due.insert(id.into(), now + Duration::from_secs(secs));
            }
            item
        };
        let Some(candidate) = candidate else {
            return Ok(());
        };
        let path = Path::new(text(&candidate, "path")?);
        let branch = hidden_command("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(path)
            .output()
            .ok()
            .filter(|result| result.status.success())
            .map(|result| String::from_utf8_lossy(&result.stdout).trim().to_owned());
        let dirty = branch.is_some()
            && hidden_command("git")
                .args(["status", "--porcelain", "-uno"])
                .current_dir(path)
                .output()
                .is_ok_and(|result| result.status.success() && !result.stdout.is_empty());
        self.db.lock().unwrap().execute(
            "UPDATE workspaces SET branch=?,dirty=? WHERE id=?",
            params![branch, dirty, text(&candidate, "id")?],
        )?;
        Ok(())
    }

    fn handle_exit(&self, sid: &str, code: u32) {
        let session = {
            let mut sessions = self.sessions.lock().unwrap();
            let Some(session) = sessions.running.remove(sid) else {
                return;
            };
            sessions.recent.push_back((
                sid.into(),
                Arc::clone(&session.terminal.history),
                Instant::now(),
            ));
            if sessions.recent.len() > 8 {
                sessions.recent.pop_front();
            }
            session
        };
        let _ = self
            .db
            .lock()
            .unwrap()
            .execute("DELETE FROM hidden_sessions WHERE session_id=?", [sid]);
        let status = if code == 0 { "exited" } else { "failed" };
        let _ = self.db.lock().unwrap().execute(
            &format!("UPDATE sessions SET status=?,exit_code=?,ended_at={NOW} WHERE id=?"),
            params![status, code, sid],
        );
        let _ = followups::fail_session(
            &self.db.lock().unwrap(),
            sid,
            chrono::Utc::now().timestamp(),
        );
        let end = session.terminal.history.lock().unwrap().end_offset();
        self.emit_exit(sid, Some(&session.terminal.workspace), status, code, end);
    }

    fn close_session(&self, sid: &str) -> Result<()> {
        let session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.recent.retain(|(key, _, _)| key != sid);
            sessions.running.remove(sid)
        };
        if let Some(session) = &session {
            session.terminal.close();
        }
        {
            let db = self.db.lock().unwrap();
            let tx = db.unchecked_transaction()?;
            tx.execute("DELETE FROM hidden_sessions WHERE session_id=?", [sid])?;
            tx.execute(
                &format!(
                    "UPDATE sessions SET status='exited',exit_code=0,ended_at={NOW} WHERE id=?"
                ),
                [sid],
            )?;
            tx.execute(
                "DELETE FROM pane_session_bindings WHERE session_id=?",
                [sid],
            )?;
            tx.commit()?;
        }
        followups::fail_session(
            &self.db.lock().unwrap(),
            sid,
            chrono::Utc::now().timestamp(),
        )?;
        self.emit_exit(
            sid,
            session
                .as_ref()
                .map(|session| session.terminal.workspace.as_str()),
            "exited",
            0,
            0,
        );
        Ok(())
    }

    fn emit_exit(&self, sid: &str, workspace: Option<&str>, status: &str, code: u32, end: usize) {
        self.emit(
            "session.state_changed",
            json!({"session_id":sid,"workspace_id":workspace,"status":status,"exit_code":code,"end_offset":end}),
        );
        self.emit(
            "session.exit",
            json!({"session_id":sid,"workspace_id":workspace,"exit_code":code,"end_offset":end}),
        );
        self.emit(
            "followup.changed",
            json!({"workspace_id":workspace,"session_id":sid}),
        );
    }

    fn record_resume(&self, sid: &str, workspace: &str, marker: Resume) -> Result<()> {
        let db = self.db.lock().unwrap();
        let existing = store::row(
            &db,
            "SELECT id FROM ai_sessions WHERE workspace_id=? AND resume_cmd=?",
            params![workspace, marker.cmd],
        )?;
        let id = existing["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(id);
        db.execute(
            &format!("INSERT INTO ai_sessions(id,workspace_id,pty_session_id,tool,resume_cmd,cwd,detected_at)
                VALUES(?,?,?,?,?,(SELECT spawn_cwd FROM sessions WHERE id=?),{NOW})
                ON CONFLICT(id) DO UPDATE SET detected_at=excluded.detected_at,cwd=excluded.cwd"),
            params![id,workspace,sid,marker.tool,marker.cmd,sid],
        )?;
        Ok(())
    }

    fn publish_agent(&self, sid: &str) {
        let update = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.running.get_mut(sid).and_then(|live| {
                live.detector.take_update().map(|mut state| {
                    state["session_id"] = json!(sid);
                    state["workspace_id"] = json!(live.terminal.workspace);
                    state
                })
            })
        };
        if let Some(update) = update {
            self.emit("session.agent_changed", update);
        }
    }

    fn check_idle(&self) {
        self.tick_reminders();
        self.tick_followups();
        self.sessions
            .lock()
            .unwrap()
            .recent
            .retain(|(_, _, time)| time.elapsed() < Duration::from_secs(30));
        let notices: Vec<_> = self
            .sessions
            .lock()
            .unwrap()
            .running
            .iter_mut()
            .filter_map(|(sid, session)| {
                session
                    .detector
                    .idle()
                    .map(|notice| (sid.clone(), session.terminal.workspace.clone(), notice))
            })
            .collect();
        let ids: Vec<_> = self
            .sessions
            .lock()
            .unwrap()
            .running
            .keys()
            .cloned()
            .collect();
        for sid in ids {
            self.publish_agent(&sid);
        }
        for (sid, workspace, notice) in notices {
            let _ = self.announce(&sid, &workspace, notice);
        }
    }

    fn tick_followups(&self) {
        {
            let mut last = self.followup_tick.lock().unwrap();
            if last.is_some_and(|at| at.elapsed() < Duration::from_secs(2)) {
                return;
            }
            *last = Some(Instant::now());
        }
        let now = chrono::Utc::now().timestamp();
        let exited: Vec<_> = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions
                .running
                .iter_mut()
                .filter_map(|(sid, live)| {
                    let anchor = live.hook_anchor?;
                    if crate::platform::process_identity(anchor.0)
                        .is_some_and(|p| p.started == anchor.1)
                        && crate::platform::process_descends_from(anchor.0, live.terminal.pid)
                    {
                        return None;
                    }
                    live.hook_anchor = None;
                    live.detector.hook_process_gone();
                    Some((sid.clone(), live.terminal.workspace.clone()))
                })
                .collect()
        };
        for (sid, workspace) in exited {
            if let Err(err) = followups::fail_agent(&self.db.lock().unwrap(), &sid, now) {
                crate::platform::log(&format!("follow-up agent exit failed: {err}"));
            }
            self.publish_agent(&sid);
            self.emit(
                "followup.changed",
                json!({"workspace_id":workspace,"session_id":sid}),
            );
        }
        let pending_terminal =
            followups::pending_terminal(&self.db.lock().unwrap()).unwrap_or_default();
        for row in pending_terminal {
            let Some(sid) = row["session_id"].as_str() else {
                continue;
            };
            let Some(pid) = row["anchor_pid"].as_u64().map(|n| n as u32) else {
                continue;
            };
            let Some(started) = row["anchor_started"].as_u64() else {
                continue;
            };
            let root = self
                .sessions
                .lock()
                .unwrap()
                .running
                .get(sid)
                .map(|live| live.terminal.pid);
            let alive = root.is_some_and(|root| {
                crate::platform::process_identity(pid).is_some_and(|p| p.started == started)
                    && crate::platform::process_descends_from(pid, root)
            });
            if !alive
                && followups::fail_pending(
                    &self.db.lock().unwrap(),
                    row["id"].as_str().unwrap_or(""),
                    "target agent process exited",
                    now,
                )
                .unwrap_or(false)
            {
                self.emit(
                    "followup.changed",
                    json!({"workspace_id":row["workspace_id"],"session_id":sid,"id":row["id"]}),
                );
            }
        }
        let due = match followups::due(&self.db.lock().unwrap(), now) {
            Ok(rows) => rows,
            Err(err) => {
                crate::platform::log(&format!("follow-up query failed: {err}"));
                return;
            }
        };
        for row in due {
            if let Err(err) = self.deliver_followup(&row, now, false) {
                crate::platform::log(&format!("follow-up delivery failed: {err}"));
            }
        }
    }

    fn deliver_followup(&self, row: &Value, now: i64, force: bool) -> Result<()> {
        let id = text(row, "id")?;
        let sid = text(row, "session_id")?;
        let provider = text(row, "provider")?;
        let agent_id = text(row, "agent_id")?;
        let anchor = (
            row["anchor_pid"].as_u64().ok_or("invalid anchor PID")? as u32,
            row["anchor_started"]
                .as_u64()
                .ok_or("invalid anchor start")?,
        );
        let delivery_mode = text(row, "delivery_mode")?;
        let terminal_mode = provider == "terminal";
        let completion_after = row["completion_after"]
            .as_u64()
            .ok_or("invalid completion boundary")?;
        let _change = self.changes.lock().unwrap();
        let mut sessions = self.sessions.lock().unwrap();
        let Some(live) = sessions.running.get_mut(sid) else {
            self.fail_followup(
                id,
                row["workspace_id"].as_str(),
                "target session ended",
                now,
            )?;
            return Ok(());
        };
        let bound = if terminal_mode {
            crate::platform::terminal_agent_anchor(live.terminal.pid) == Some(anchor)
                && !live.detector.snapshot()["hook"]["active"]
                    .as_bool()
                    .unwrap_or(false)
        } else {
            live.hook_anchor == Some(anchor)
                && live.detector.hook_binding() == Some((provider, agent_id))
        };
        if !bound {
            self.fail_followup(
                id,
                row["workspace_id"].as_str(),
                "target agent changed",
                now,
            )?;
            return Ok(());
        }
        let root_pid = live.terminal.pid;
        let alive = || {
            crate::platform::process_identity(anchor.0).is_some_and(|p| p.started == anchor.1)
                && crate::platform::process_descends_from(anchor.0, root_pid)
        };
        if !alive() {
            self.fail_followup(
                id,
                row["workspace_id"].as_str(),
                "target agent process exited",
                now,
            )?;
            return Ok(());
        }
        let ready = if terminal_mode {
            live.detector.terminal_ready()
        } else {
            live.detector.hook_ready(provider, agent_id)
        };
        if !force && !ready {
            return Ok(());
        }
        if !force
            && delivery_mode == "after_completion"
            && (if terminal_mode {
                live.detector.terminal_completed_count()
            } else {
                live.detector.hook_completed_count()
            }) <= completion_after
        {
            return Ok(());
        }
        if !live.terminal.history.lock().unwrap().bracketed_paste() {
            self.fail_followup(
                id,
                row["workspace_id"].as_str(),
                "agent did not enable bracketed paste",
                now,
            )?;
            return Ok(());
        }
        let claimed = if force {
            followups::claim_now(&self.db.lock().unwrap(), id, now)?
        } else {
            followups::claim(&self.db.lock().unwrap(), id, now)?
        };
        if !claimed {
            return Ok(());
        }
        let prompt = text(row, "prompt")?;
        let terminal = Arc::clone(&live.terminal);
        let prompt_state = terminal.history.lock().unwrap().prompt_state();
        let has_draft = terminal_mode && prompt_state.visible && !prompt_state.empty;
        let clear_key = if has_draft {
            let image = crate::platform::process_identity(anchor.0)
                .map(|identity| identity.image.to_ascii_lowercase())
                .unwrap_or_default();
            Some(if image == "claude.exe" {
                "\x13"
            } else {
                "\x03"
            })
        } else {
            None
        };
        drop(sessions);
        let cleared = if let Some(key) = clear_key {
            if let Err(err) = terminal.write(key) {
                Err(format!("draft clear failed: {err}"))
            } else {
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    if !alive() {
                        break Err("agent exited while clearing draft".to_owned());
                    }
                    if terminal.history.lock().unwrap().prompt_state().empty {
                        break Ok(());
                    }
                    if Instant::now() >= deadline {
                        break Err("agent did not clear or stash its draft".to_owned());
                    }
                    thread::sleep(Duration::from_millis(30));
                }
            }
        } else {
            Ok(())
        };
        let outcome = if let Err(err) = cleared {
            Err(err)
        } else if !alive()
            || (terminal_mode
                && (!force || has_draft)
                && !terminal.history.lock().unwrap().prompt_state().empty)
        {
            Err("agent prompt was not empty before paste".into())
        } else if let Err(err) = terminal.write(&format!("\x1b[200~{prompt}\x1b[201~")) {
            Err(format!("paste failed: {err}"))
        } else {
            std::thread::sleep(Duration::from_millis(70));
            let mut sessions = self.sessions.lock().unwrap();
            let valid = alive()
                && sessions.running.get(sid).is_some_and(|live| {
                    Arc::ptr_eq(&live.terminal, &terminal)
                        && (if terminal_mode {
                            crate::platform::terminal_agent_anchor(live.terminal.pid)
                                == Some(anchor)
                                && (force || live.detector.terminal_submit_state())
                        } else {
                            live.hook_anchor == Some(anchor)
                                && (force || live.detector.hook_submit_state(provider, agent_id))
                        })
                        && (force
                            || delivery_mode != "after_completion"
                            || (if terminal_mode {
                                live.detector.terminal_completed_count()
                            } else {
                                live.detector.hook_completed_count()
                            }) > completion_after)
                        && live.terminal.history.lock().unwrap().bracketed_paste()
                });
            if !valid {
                if alive() {
                    let _ = terminal.write("\x03");
                }
                Err("agent changed before submit; pasted draft interrupted".into())
            } else {
                let result = terminal
                    .write("\r")
                    .map_err(|err| format!("submit uncertain: {err}"));
                if result.is_ok() {
                    if let Some(live) = sessions.running.get_mut(sid) {
                        if terminal_mode {
                            live.detector.scheduled_terminal_input();
                        } else {
                            live.detector.scheduled_input();
                        }
                    }
                }
                result
            }
        };
        let result = outcome
            .as_ref()
            .err()
            .map(String::as_str)
            .unwrap_or(if terminal_mode {
                if force {
                    "submitted immediately by user; agent acceptance is unconfirmed"
                } else {
                    "submitted after terminal readiness"
                }
            } else {
                "submitted; awaiting agent hook"
            });
        followups::finish(
            &self.db.lock().unwrap(),
            id,
            outcome.is_ok(),
            result,
            chrono::Utc::now().timestamp(),
        )?;
        self.publish_agent(sid);
        self.emit(
            "followup.changed",
            json!({"workspace_id":row["workspace_id"],"session_id":sid,"id":id}),
        );
        Ok(())
    }

    fn fail_followup(
        &self,
        id: &str,
        workspace: Option<&str>,
        reason: &str,
        now: i64,
    ) -> Result<()> {
        let db = self.db.lock().unwrap();
        if followups::claim(&db, id, now)? {
            followups::finish(&db, id, false, reason, now)?;
            self.emit(
                "followup.changed",
                json!({"workspace_id":workspace,"id":id}),
            );
        }
        Ok(())
    }

    fn tick_reminders(&self) {
        let candidates: Vec<_> = self
            .sessions
            .lock()
            .unwrap()
            .running
            .iter_mut()
            .filter_map(|(sid, live)| {
                live.quota
                    .poll(Instant::now())
                    .map(|notice| (sid.clone(), live.terminal.workspace.clone(), notice))
            })
            .collect();
        for (sid, workspace, notice) in candidates {
            let result = {
                let db = self.db.lock().unwrap();
                reminders::register_auto(
                    &db,
                    &workspace,
                    &sid,
                    &notice,
                    chrono::Utc::now().timestamp(),
                )
            };
            match result {
                Ok(Some(notification)) => {
                    self.emit("notify.created",json!({"workspace_id":notification["workspace_id"],"session_id":notification["session_id"],"notification":notification}));
                    self.emit("notify.reminders_changed", json!({}));
                }
                Ok(None) => {}
                Err(err) => {
                    crate::platform::log(&format!("quota reminder error: {err}"));
                    if let Some(live) = self.sessions.lock().unwrap().running.get_mut(&sid) {
                        live.quota.retry(notice);
                    }
                }
            }
        }
        let (pending_delivery, changed) = {
            let db = self.db.lock().unwrap();
            match reminders::fire_due(&db, chrono::Utc::now().timestamp()) {
                Ok(mut due) => {
                    let changed = !due.is_empty();
                    due.extend(store::rows(&db,"SELECT * FROM notifications WHERE kind='reminder_due' AND delivered_at IS NULL AND suppressed=0 ORDER BY created_at DESC LIMIT 300",[]).unwrap_or_default());
                    (due, changed)
                }
                Err(err) => {
                    crate::platform::log(&format!("reminder scheduler error: {err}"));
                    (Vec::new(), false)
                }
            }
        };
        if changed {
            self.emit("notify.reminders_changed", json!({}));
        }
        for notification in pending_delivery {
            let Some(id) = notification["id"].as_str() else {
                continue;
            };
            if self
                .reminder_delivery_seen
                .lock()
                .unwrap()
                .insert(id.to_owned())
            {
                self.emit("notify.created",json!({"workspace_id":notification["workspace_id"],"session_id":notification["session_id"],"notification":notification}));
            }
        }
    }

    fn announce(&self, sid: &str, workspace: &str, notice: Notice) -> Result<Value> {
        self.notify(json!({"workspace_id":workspace,"session_id":sid,"title":notice.title,"body":notice.body,
            "kind":notice.kind,"source_kind":notice.source,"source":format!("core-{}",notice.source),
            "level":if notice.kind == "task_done" {"success"} else {"info"},
            "dedup_key":format!("{sid}|{}|{}",notice.kind,notice.key)}))
    }

    fn notify(&self, params: Value) -> Result<Value> {
        let (notification, deduped) = store::add_notification(&self.db.lock().unwrap(), &params)?;
        if !deduped {
            self.emit("notify.created",json!({"notification":notification,"workspace_id":notification["workspace_id"],"session_id":notification["session_id"]}));
        }
        Ok(json!({"notification":notification,"deduped":deduped}))
    }

    pub fn close_all(&self) {
        let ids: Vec<_> = self
            .sessions
            .lock()
            .unwrap()
            .running
            .keys()
            .cloned()
            .collect();
        for sid in ids {
            let _ = self.close_session(&sid);
        }
    }
}

fn dimension(p: &Value, key: &str) -> Result<u16> {
    let n = p[key]
        .as_u64()
        .filter(|n| (1..=32767).contains(n))
        .ok_or("invalid PTY dimensions")?;
    Ok(n as u16)
}

pub fn git_info(path: &Path) -> Value {
    let run = |args: &[&str]| hidden_command("git").args(args).current_dir(path).output();
    let branch = run(&["rev-parse", "--abbrev-ref", "HEAD"]);
    let branch_text = branch
        .as_ref()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned());
    if branch_text.is_none() {
        let error = match branch {
            Ok(out) => String::from_utf8_lossy(&out.stderr).trim().to_owned(),
            Err(err) => err.to_string(),
        };
        return json!({"branch":null,"dirty_files":[],"recent_commits":[],"debug_error":error});
    }
    let lines = |args: &[&str]| {
        run(args)
            .ok()
            .filter(|out| out.status.success())
            .map(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    json!({"branch":branch_text,"dirty_files":lines(&["status","--short"]),"recent_commits":lines(&["log","--oneline","-8"]),"debug_error":null})
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn workspace_delete_confirms_live_sessions_and_closes_them() -> Result<()> {
        let core = Core::new(Path::new(":memory:"))?;
        let cwd = std::env::temp_dir();
        let empty = core.rpc(
            "workspace.create",
            json!({"name":"Empty","path":cwd,"backend":"custom"}),
        )?;
        let empty_id = text(&empty["workspace"], "id")?;
        core.rpc("workspace.delete", json!({"id":empty_id}))?;
        assert!(!core.rpc("workspace.list", json!({}))?["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|workspace| workspace["id"] == empty_id));

        let active = core.rpc(
            "workspace.create",
            json!({"name":"Active","path":cwd,"backend":"custom"}),
        )?;
        let active_id = text(&active["workspace"], "id")?;
        let started = core.rpc(
            "session.run",
            json!({"workspace_id":active_id,"cmd":"powershell.exe","args":["-NoProfile","-Command","Start-Sleep -Seconds 30"],"cwd":cwd}),
        )?;
        let sid = text(&started["session"], "session_id")?;
        assert!(core
            .rpc("workspace.delete", json!({"id":active_id}))
            .unwrap_err()
            .to_string()
            .contains("confirmation required"));
        assert!(core.sessions.lock().unwrap().running.contains_key(sid));
        core.rpc(
            "workspace.delete",
            json!({"id":active_id,"confirmed_running":true}),
        )?;
        assert!(!core.sessions.lock().unwrap().running.contains_key(sid));
        assert_eq!(core.runtime_info()["terminal_count"], 0);
        Ok(())
    }

    #[test]
    fn pending_reminder_keeps_an_empty_core_alive_and_due_alert_is_not_suppressed() -> Result<()> {
        let core = Core::new(Path::new(":memory:"))?;
        let ws = core.rpc(
            "workspace.create",
            json!({"name":"Alarm","path":std::env::temp_dir(),"backend":"custom"}),
        )?;
        core.runtime.lock().unwrap().idle_since = Some(Instant::now() - Duration::from_secs(31));
        assert!(core.should_exit());
        core.rpc("reminder.save",json!({"workspace_id":ws["workspace"]["id"],"title":"Alarm","timezone":"Asia/Seoul","due_at":chrono::Utc::now().timestamp()+3600}))?;
        assert!(!core.should_exit());
        core.rpc("client.attach", json!({"client_id":"ui"}))?;
        core.rpc("client.context",json!({"client_id":"ui","context":{"app_focused":true,"workspace_id":ws["workspace"]["id"]}}))?;
        assert!(!core.suppress_notification(
            &json!({"kind":"reminder_due","workspace_id":ws["workspace"]["id"]})
        ));
        core.rpc("client.detach", json!({"client_id":"ui"}))?;
        core.rpc("runtime.prepare_update", json!({}))?;
        core.runtime.lock().unwrap().stop_at = Some(Instant::now());
        assert!(
            core.should_exit(),
            "pending reminders do not block an explicit installer shutdown"
        );
        Ok(())
    }

    #[test]
    fn lifecycle_guards_prevent_start_during_updates_and_clear_stale_focus() -> Result<()> {
        let core = Core::new(Path::new(":memory:"))?;
        core.rpc("client.attach", json!({"client_id":"ui"}))?;
        core.rpc("client.context",json!({"client_id":"ui","context":{"app_focused":true,"workspace_id":"ws","session_id":"s"}}))?;
        let notification = json!({"workspace_id":"ws","session_id":"s"});
        assert!(core.suppress_notification(&notification));
        core.detach_client("ui");
        assert!(!core.suppress_notification(&notification));
        core.rpc("runtime.prepare_update", json!({}))?;
        assert!(core
            .rpc("session.run", json!({}))
            .unwrap_err()
            .to_string()
            .contains("preparing"));
        core.rpc("runtime.cancel_update", json!({}))?;
        assert!(!core.should_exit());
        core.runtime.lock().unwrap().idle_since = Some(Instant::now() - Duration::from_secs(31));
        assert!(core.should_exit());
        Ok(())
    }

    #[test]
    fn conpty_round_trips_korean_spaces_and_reports_natural_exit() -> Result<()> {
        let core = Core::new(Path::new(":memory:"))?;
        let cwd = std::env::current_dir()?;
        let ws = core.rpc(
            "workspace.create",
            json!({"name":"Test","path":cwd,"backend":"custom"}),
        )?;
        let workspace = &ws["workspace"]["id"];
        let (sender, receiver) = mpsc::channel();
        core.subscribe(
            Filter::default(),
            Arc::new(move |event| sender.send(event).is_ok()),
        );
        // Windows PowerShell's ReadLine can decode cooked console input using the
        // system code page. ReadKey reads Unicode console key events directly.
        let echo_script = concat!(
            "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ",
            "$line=[Text.StringBuilder]::new(); [Console]::WriteLine('RUST_READY'); ",
            "while (($key=[Console]::ReadKey($true)).Key -ne [ConsoleKey]::Enter) { ",
            "[void]$line.Append($key.KeyChar) }; [Console]::WriteLine('RUST_ECHO:'+$line)"
        );
        let result = core.rpc(
            "session.run",
            json!({
                "workspace_id":workspace,"cmd":"powershell.exe","cwd":cwd,
                "args":["-NoProfile","-NonInteractive","-Command",echo_script]
            }),
        )?;
        let sid = &result["session"]["session_id"];
        let mut output = String::new();
        let result = (|| -> Result<()> {
            while !output.contains("RUST_READY") {
                let event = receiver
                    .recv_timeout(Duration::from_secs(10))
                    .map_err(|err| {
                        format!("waiting for ConPTY startup: {err}, output={output:?}")
                    })?;
                if let Some(text) = event["params"]["output"].as_str() {
                    output.push_str(text);
                }
            }
            core.rpc(
                "session.resize",
                json!({"session_id":sid,"cols":92,"rows":26}),
            )?;
            core.rpc(
                "session.write",
                json!({"session_id":sid,"data":"한글  A   가가가\r"}),
            )?;
            loop {
                let event = receiver
                    .recv_timeout(Duration::from_secs(10))
                    .map_err(|err| format!("waiting for ConPTY exit: {err}, output={output:?}"))?;
                if let Some(text) = event["params"]["output"].as_str() {
                    output.push_str(text);
                }
                if event["method"] == "session.exit" {
                    assert_eq!(event["params"]["exit_code"], 0);
                    break;
                }
            }
            assert!(output.contains("RUST_ECHO:한글  A   가가가"), "{output:?}");
            let tail = core.rpc(
                "session.tail",
                json!({"session_id":sid,"after_offset":0,"max_bytes":8192}),
            )?;
            assert_eq!(tail["output"], output);
            Ok(())
        })();
        core.close_all();
        result
    }
}
