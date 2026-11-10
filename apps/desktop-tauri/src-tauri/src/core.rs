use crate::{
    detector::{missing_conversation, Conversation, Notice, Resume},
    store::{self, id, text, Result, NOW},
    terminal::{hidden_command, History, Spawned, Terminal},
};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

type Sink = Arc<dyn Fn(Value) -> bool + Send + Sync>;
type HistoryHandle = Arc<Mutex<History>>;

#[derive(Default, Deserialize)]
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
}

#[derive(Default)]
struct Sessions {
    running: HashMap<String, LiveSession>,
    recent: VecDeque<(String, HistoryHandle)>,
}

#[derive(Default)]
struct GitSchedule {
    active: Option<String>,
    due: HashMap<String, Instant>,
    terminal_activity: Option<Instant>,
}

pub struct Core {
    db: Mutex<Connection>,
    sessions: Mutex<Sessions>,
    changes: Mutex<()>,
    subscribers: Mutex<HashMap<String, (Filter, Sink)>>,
    git: Mutex<GitSchedule>,
}

impl Core {
    pub fn new(path: &Path) -> Result<Arc<Self>> {
        let core = Arc::new(Self {
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

    fn emit(&self, method: &str, params: Value) {
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
            "session.run" => self.start_session(&p),
            "session.write" => {
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
                    Arc::clone(&current.terminal)
                };
                terminal.write(input)?;
                self.git.lock().unwrap().terminal_activity = Some(Instant::now());
                Ok(ok)
            }
            "session.resize" => {
                let cols = dimension(&p, "cols")?;
                let rows = dimension(&p, "rows")?;
                self.terminal(text(&p, "session_id")?)?.resize(cols, rows)?;
                Ok(ok)
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
                                .find(|(key, _)| key == sid)
                                .map(|(_, h)| Arc::clone(h))
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
        let workspace = text(p, "workspace_id")?;
        let cmd = text(p, "cmd")?;
        let args: Vec<String> = match p.get("args") {
            Some(value) => serde_json::from_value(value.clone())?,
            None => Vec::new(),
        };
        let row = store::workspace(&self.db.lock().unwrap(), workspace)?;
        let cwd = store::path(p["cwd"].as_str().unwrap_or(text(&row, "path")?))?;
        let session_id = id();
        let spawned = Spawned::new(cmd, &args, &cwd, workspace)?;
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
            .map(|session| session.detector.output(&output));
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
            sessions
                .recent
                .push_back((sid.into(), Arc::clone(&session.terminal.history)));
            if sessions.recent.len() > 8 {
                sessions.recent.pop_front();
            }
            session
        };
        let status = if code == 0 { "exited" } else { "failed" };
        let _ = self.db.lock().unwrap().execute(
            &format!("UPDATE sessions SET status=?,exit_code=?,ended_at={NOW} WHERE id=?"),
            params![status, code, sid],
        );
        let end = session.terminal.history.lock().unwrap().end_offset();
        self.emit_exit(sid, Some(&session.terminal.workspace), status, code, end);
    }

    fn close_session(&self, sid: &str) -> Result<()> {
        let session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.recent.retain(|(key, _)| key != sid);
            sessions.running.remove(sid)
        };
        if let Some(session) = &session {
            session.terminal.close();
        }
        {
            let db = self.db.lock().unwrap();
            let tx = db.unchecked_transaction()?;
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

    fn check_idle(&self) {
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
        for (sid, workspace, notice) in notices {
            let _ = self.announce(&sid, &workspace, notice);
        }
    }

    fn announce(&self, sid: &str, workspace: &str, notice: Notice) -> Result<Value> {
        self.notify(json!({"workspace_id":workspace,"session_id":sid,"title":notice.title,"body":notice.body,
            "kind":notice.kind,"source_kind":"pattern","source":"core-pattern-detector",
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
