use crate::layout::Layout;
use rusqlite::{params, types::ValueRef, Connection, OptionalExtension, Params};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

#[derive(Deserialize)]
struct Schema {
    base: String,
    migrations: BTreeMap<u32, Vec<String>>,
}

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let existed = path.is_file();
    let mut db = Connection::open(path)?;
    db.busy_timeout(Duration::from_secs(3))?;
    db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    let schema: Schema = serde_json::from_str(include_str!("../schema.json"))?;
    db.execute_batch(&schema.base)?;
    let current: u32 =
        db.query_row("SELECT MAX(version) FROM schema_versions", [], |r| r.get(0))?;
    if current > 17 {
        return Err(format!("unsupported database schema version: {current}").into());
    }
    if current < 17 && existed && path.to_string_lossy() != ":memory:" {
        let backup = path.with_extension(format!("pre-v17-{}.bak", id()));
        db.backup(rusqlite::DatabaseName::Main, &backup, None)?;
    }
    for (version, statements) in schema.migrations {
        if version <= current {
            continue;
        }
        let tx = db.transaction()?;
        for statement in statements {
            if let Err(err) = tx.execute_batch(&statement) {
                if !err.to_string().contains("duplicate column name") {
                    return Err(err.into());
                }
            }
        }
        tx.commit()?;
    }
    db.execute("UPDATE agent_followups SET status='failed',result='delivery interrupted before confirmation',updated_at=strftime('%s','now') WHERE status='claimed'", [])?;
    db.execute("UPDATE agent_followups SET status='failed',result='target session ended when core restarted',updated_at=strftime('%s','now') WHERE status IN ('pending','paused')", [])?;
    crate::followups::prune_completed(&db, None);
    db.execute(
        &format!("UPDATE sessions SET status='exited', ended_at={NOW} WHERE status='running'"),
        [],
    )?;
    db.execute("DELETE FROM hidden_sessions WHERE session_id IN (SELECT id FROM sessions WHERE status!='running')", [])?;
    Ok(db)
}

pub fn id() -> String {
    Uuid::new_v4().to_string()
}

pub fn path(value: &str) -> Result<PathBuf> {
    if value.trim().is_empty() {
        return Err("workspace path is required".into());
    }
    let path = std::path::absolute(value)?;
    if !path.is_dir() {
        return Err(format!("workspace path is not a directory: {}", path.display()).into());
    }
    Ok(path)
}

pub fn text<'a>(params: &'a Value, name: &str) -> Result<&'a str> {
    params[name]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing or invalid {name}").into())
}

pub fn string<'a>(params: &'a Value, name: &str) -> Result<&'a str> {
    params[name]
        .as_str()
        .ok_or_else(|| format!("missing or invalid {name}").into())
}

pub fn rows(db: &Connection, sql: &str, params: impl Params) -> Result<Vec<Value>> {
    let mut statement = db.prepare_cached(sql)?;
    let names: Vec<_> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let result = statement.query_map(params, |row| {
        let mut object = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => json!(value),
                ValueRef::Real(value) => json!(value),
                ValueRef::Text(value) => json!(String::from_utf8_lossy(value)),
                ValueRef::Blob(_) => Value::Null,
            };
            object.insert(name.clone(), value);
        }
        Ok(Value::Object(object))
    })?;
    Ok(result.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn row(db: &Connection, sql: &str, params: impl Params) -> Result<Value> {
    Ok(rows(db, sql, params)?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}

pub fn workspace(db: &Connection, id: &str) -> Result<Value> {
    let workspace = row(db, "SELECT * FROM workspaces WHERE id=?", [id])?;
    if workspace.is_null() {
        return Err("workspace not found".into());
    }
    Ok(workspace)
}

pub fn prune_history(db: &Connection, workspace: &str) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    let duplicates = rows(
        &tx,
        "WITH ranked AS (
           SELECT id,status,ROW_NUMBER() OVER (
             PARTITION BY spawn_cmd,COALESCE(spawn_args,'[]'),COALESCE(spawn_cwd,'')
             ORDER BY (status='running') DESC,started_at DESC,id DESC
           ) AS position
           FROM sessions WHERE workspace_id=? AND spawn_cmd IS NOT NULL
         ) SELECT id FROM ranked WHERE status!='running' AND position>1",
        [workspace],
    )?;
    for row in duplicates {
        let id = text(&row, "id")?;
        tx.execute("DELETE FROM hidden_sessions WHERE session_id=?", [id])?;
        tx.execute("DELETE FROM pane_session_bindings WHERE session_id=?", [id])?;
        tx.execute(
            "DELETE FROM session_group_bindings WHERE session_id=?",
            [id],
        )?;
        tx.execute(
            "DELETE FROM sessions WHERE id=? AND status!='running'",
            [id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn load_layout(db: &Connection, workspace_id: &str) -> Result<Layout> {
    let payload: Option<String> = db
        .query_row(
            "SELECT payload FROM layout_snapshots WHERE workspace_id=?",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()?;
    match payload {
        Some(payload) => Ok(serde_json::from_str(&payload)?),
        None => {
            let layout = Layout::default();
            save_layout(db, workspace_id, &layout)?;
            Ok(layout)
        }
    }
}

fn save_layout(db: &Connection, workspace: &str, layout: &Layout) -> Result<()> {
    db.execute(
        &format!("INSERT INTO layout_snapshots(workspace_id,payload,updated_at) VALUES(?,?,{NOW})
                  ON CONFLICT(workspace_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at"),
        params![workspace, serde_json::to_string(layout)?],
    )?;
    Ok(())
}

fn default_group(db: &Connection, workspace: &str) -> Result<String> {
    db.execute(
        &format!(
            "INSERT OR IGNORE INTO pane_groups(id,workspace_id,name,color,sort_order,created_at)
                  VALUES(?,?,'Default','#6b7c93',0,{NOW})"
        ),
        params![id(), workspace],
    )?;
    Ok(db.query_row(
        "SELECT id FROM pane_groups WHERE workspace_id=? AND name='Default'",
        [workspace],
        |row| row.get(0),
    )?)
}

pub fn dispatch(db: &Connection, method: &str, p: &Value) -> Result<Value> {
    let ok = json!({"ok": true});
    match method {
        "hidden.list" => Ok(
            json!({"items":rows(db,"SELECT * FROM hidden_sessions WHERE workspace_id=? ORDER BY sort_order,hidden_at DESC",[text(p,"workspace_id")?])?}),
        ),
        "hidden.add" => {
            db.execute("INSERT INTO hidden_sessions(id,workspace_id,session_id,source_pane_id,group_id,label,hidden_at) SELECT ?,workspace_id,id,?,?,?,? FROM sessions WHERE id=? AND workspace_id=? AND status='running' ON CONFLICT(session_id) DO UPDATE SET label=excluded.label,group_id=excluded.group_id",params![text(p,"id")?,p["source_pane_id"].as_str(),p["group_id"].as_str(),text(p,"label")?,text(p,"hidden_at")?,text(p,"session_id")?,text(p,"workspace_id")?])?;
            Ok(ok)
        }
        "hidden.remove" => {
            db.execute(
                "DELETE FROM hidden_sessions WHERE id=? AND workspace_id=?",
                params![text(p, "id")?, text(p, "workspace_id")?],
            )?;
            Ok(ok)
        }
        "health.check" => Ok(json!({"status":"ok"})),
        "workspace.list" => Ok(
            json!({"workspaces":rows(db,"SELECT w.*, (SELECT COUNT(*) FROM sessions s WHERE s.workspace_id=w.id AND s.status='running') AS running_count FROM workspaces w WHERE w.id NOT LIKE 'remote:%' ORDER BY w.pinned DESC, w.sort_order, w.last_active DESC",[])?}),
        ),
        "remote_project.register" => {
            let id = text(p, "id")?;
            let backend = text(p, "backend")?;
            let path = text(p, "path")?;
            if !matches!(backend, "ssh" | "docker")
                || !id.starts_with(&format!("remote:{backend}:"))
                || !path.starts_with('/')
            {
                return Err("invalid remote notification project".into());
            }
            db.execute(&format!("INSERT INTO workspaces(id,name,path,backend,last_active) VALUES(?,?,?,?,{NOW}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,last_active=excluded.last_active"),
                params![id, text(p,"name")?, path, backend])?;
            Ok(ok)
        }
        "workspace.create" => {
            let tx = db.unchecked_transaction()?;
            let id = id();
            let path = path(text(p, "path")?)?;
            tx.execute(
                &format!("INSERT INTO workspaces(id,name,path,backend,last_active,sort_order)
                         VALUES(?,?,?,?,{NOW},(SELECT COALESCE(MAX(sort_order),0)+1 FROM workspaces))"),
                params![id, text(p,"name")?, path.to_string_lossy(), p["backend"].as_str().unwrap_or("custom")],
            )?;
            default_group(&tx, &id)?;
            let layout = load_layout(&tx, &id)?;
            let row = workspace(&tx, &id)?;
            tx.commit()?;
            Ok(json!({"workspace":row,"root_pane_id":layout.root_pane_id}))
        }
        "workspace.rename" => {
            db.execute(
                &format!("UPDATE workspaces SET name=?,last_active={NOW} WHERE id=?"),
                params![text(p, "name")?, text(p, "id")?],
            )?;
            Ok(ok)
        }
        "workspace.describe" => {
            db.execute(
                "UPDATE workspaces SET description=? WHERE id=?",
                params![string(p, "description")?, text(p, "id")?],
            )?;
            Ok(ok)
        }
        "workspace.pin" => {
            db.execute(
                "UPDATE workspaces SET pinned=? WHERE id=?",
                params![
                    p["pinned"].as_bool().ok_or("invalid pinned")?,
                    text(p, "id")?
                ],
            )?;
            Ok(ok)
        }
        "workspace.reorder" => {
            db.execute(
                "UPDATE workspaces SET sort_order=? WHERE id=?",
                params![
                    p["sort_order"].as_i64().ok_or("invalid sort_order")?,
                    text(p, "id")?
                ],
            )?;
            Ok(ok)
        }
        "workspace.delete" => {
            let id = text(p, "id")?;
            let tx = db.unchecked_transaction()?;
            for table in [
                "hidden_sessions",
                "pane_session_bindings",
                "session_group_bindings",
                "pane_groups",
                "ai_sessions",
                "sessions",
                "notifications",
                "layout_snapshots",
            ] {
                tx.execute(&format!("DELETE FROM {table} WHERE workspace_id=?"), [id])?;
            }
            tx.execute("DELETE FROM workspaces WHERE id=?", [id])?;
            tx.commit()?;
            Ok(ok)
        }
        "group.list" | "group.create" => {
            let workspace = text(p, "workspace_id")?;
            default_group(db, workspace)?;
            if method == "group.list" {
                return Ok(
                    json!({"groups":rows(db,"SELECT * FROM pane_groups WHERE workspace_id=? ORDER BY sort_order,created_at",[workspace])?}),
                );
            }
            let name = text(p, "name")?;
            db.execute(
                &format!("INSERT OR IGNORE INTO pane_groups(id,workspace_id,name,color,sort_order,created_at)
                         VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM pane_groups WHERE workspace_id=?),{NOW})"),
                params![id(),workspace,name,p["color"].as_str(),workspace],
            )?;
            Ok(
                json!({"group":row(db,"SELECT * FROM pane_groups WHERE workspace_id=? AND name=?",params![workspace,name])?}),
            )
        }
        "group.rename" | "group.delete" => {
            let group_id = text(p, "group_id")?;
            let group = row(db, "SELECT * FROM pane_groups WHERE id=?", [group_id])?;
            if group.is_null() {
                return Ok(ok);
            }
            if group["name"] == "Default" {
                return Err("Default group cannot be modified".into());
            }
            if method == "group.rename" {
                db.execute(
                    "UPDATE pane_groups SET name=? WHERE id=?",
                    params![text(p, "name")?, group_id],
                )?;
            } else {
                let workspace = text(&group, "workspace_id")?;
                let tx = db.unchecked_transaction()?;
                let requested = p["move_to_group_id"]
                    .as_str()
                    .filter(|value| *value != group_id);
                let valid = if let Some(id) = requested {
                    tx.query_row(
                        "SELECT id FROM pane_groups WHERE id=? AND workspace_id=?",
                        params![id, workspace],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?
                } else {
                    None
                };
                let target = match valid {
                    Some(id) => id,
                    None => default_group(&tx, workspace)?,
                };
                tx.execute(&format!("UPDATE session_group_bindings SET group_id=?,updated_at={NOW} WHERE group_id=?"),params![target,group_id])?;
                tx.execute("DELETE FROM pane_groups WHERE id=?", [group_id])?;
                tx.commit()?;
            }
            Ok(ok)
        }
        "session.group.set" => {
            let ws = text(p, "workspace_id")?;
            let sid = text(p, "session_id")?;
            let gid = text(p, "group_id")?;
            let count: i64 = db.query_row("SELECT count(*) FROM sessions s JOIN pane_groups g ON s.workspace_id=g.workspace_id WHERE s.workspace_id=? AND s.id=? AND g.id=?",params![ws,sid,gid], |r| r.get(0))?;
            if count != 1 {
                return Err("session or group not found in workspace".into());
            }
            db.execute(
                &format!("INSERT INTO session_group_bindings(workspace_id,session_id,group_id,updated_at)
                          VALUES(?,?,?,{NOW}) ON CONFLICT(workspace_id,session_id)
                          DO UPDATE SET group_id=excluded.group_id,updated_at=excluded.updated_at"),
                params![ws,sid,gid],
            )?;
            Ok(ok)
        }
        "session.group.list" => {
            let ws = text(p, "workspace_id")?;
            let group = default_group(db, ws)?;
            Ok(
                json!({"bindings":rows(db,"SELECT s.workspace_id,s.id AS session_id,COALESCE(b.group_id,?) AS group_id,
                COALESCE(b.updated_at,s.started_at) AS updated_at FROM sessions s LEFT JOIN session_group_bindings b
                ON b.workspace_id=s.workspace_id AND b.session_id=s.id WHERE s.workspace_id=? ORDER BY s.started_at DESC",params![group,ws])?}),
            )
        }
        "session.list" | "session.history" => {
            let ws = text(p, "workspace_id")?;
            let sql = if method == "session.list" {
                "SELECT * FROM sessions WHERE workspace_id=? ORDER BY started_at DESC"
            } else {
                prune_history(db, ws)?;
                "SELECT id,status,spawn_cmd,spawn_args,spawn_cwd,started_at FROM sessions WHERE workspace_id=? ORDER BY started_at DESC LIMIT 50"
            };
            Ok(json!({"sessions":rows(db,sql,[ws])?}))
        }
        "session.delete" => {
            let sid = text(p, "session_id")?;
            let tx = db.unchecked_transaction()?;
            if tx.execute(
                "DELETE FROM sessions WHERE id=? AND status!='running'",
                [sid],
            )? > 0
            {
                tx.execute(
                    "DELETE FROM session_group_bindings WHERE session_id=?",
                    [sid],
                )?;
                tx.execute(
                    "DELETE FROM pane_session_bindings WHERE session_id=?",
                    [sid],
                )?;
            }
            tx.commit()?;
            Ok(ok)
        }
        "pane.session.bind" => {
            db.execute(
                &format!("INSERT INTO pane_session_bindings(workspace_id,pane_id,session_id,updated_at)
                          SELECT ?,?,id,{NOW} FROM sessions WHERE workspace_id=? AND id=?
                          ON CONFLICT(workspace_id,pane_id) DO UPDATE SET session_id=excluded.session_id,updated_at=excluded.updated_at"),
                params![text(p,"workspace_id")?,text(p,"pane_id")?,text(p,"workspace_id")?,text(p,"session_id")?],
            )?;
            Ok(ok)
        }
        "pane.session.bindings" => Ok(
            json!({"bindings":rows(db,"SELECT b.pane_id,b.session_id,s.spawn_cmd,s.spawn_args,s.spawn_cwd
                FROM pane_session_bindings b LEFT JOIN sessions s ON s.id=b.session_id WHERE b.workspace_id=?",[text(p,"workspace_id")?])?}),
        ),
        "ai.sessions" => Ok(
            json!({"sessions":rows(db,"SELECT * FROM ai_sessions WHERE workspace_id=? ORDER BY detected_at DESC LIMIT 50",[text(p,"workspace_id")?])?}),
        ),
        "ai.session.delete" => Ok(
            json!({"ok":true,"deleted":db.execute("DELETE FROM ai_sessions WHERE id=?",[text(p,"ai_session_id")?])?}),
        ),
        "notify.get" => Ok(json!({"notification":notification(db,text(p,"notification_id")?)?})),
        "notify.unread" => {
            let items = rows(db,"SELECT n.*, w.name AS workspace_name, w.path AS workspace_path FROM notifications n JOIN workspaces w ON w.id=n.workspace_id WHERE n.read_at IS NULL AND (?1 IS NULL OR n.workspace_id=?1) AND (?2 IS NULL OR (w.id LIKE 'remote:%' AND w.backend=?2)) ORDER BY n.created_at DESC",params![p["workspace_id"].as_str(),p["remote_backend"].as_str()])?;
            Ok(json!({"count":items.len(),"items":items}))
        }
        "notify.mark_read" => {
            db.execute(
                &format!("UPDATE notifications SET read_at={NOW} WHERE id=?"),
                [text(p, "notification_id")?],
            )?;
            Ok(ok)
        }
        "notify.clear" => {
            db.execute(&format!("UPDATE notifications SET read_at={NOW} WHERE read_at IS NULL AND (?1 IS NULL OR workspace_id=?1) AND (?2 IS NULL OR workspace_id IN (SELECT id FROM workspaces WHERE id LIKE 'remote:%' AND backend=?2))"),params![p["workspace_id"].as_str(),p["remote_backend"].as_str()])?;
            Ok(ok)
        }
        "notify.delivery_ack" => {
            let id = text(p, "notification_id")?;
            if p["delivered"] == true {
                db.execute(
                    &format!("UPDATE notifications SET delivered_at={NOW},suppressed=0 WHERE id=?"),
                    [id],
                )?;
            }
            if p["suppressed"] == true {
                db.execute("UPDATE notifications SET suppressed=1 WHERE id=?", [id])?;
            }
            Ok(ok)
        }
        method if method.starts_with("layout.") => {
            let ws = text(p, "workspace_id")?;
            let mut layout = load_layout(db, ws)?;
            let tx = db.unchecked_transaction()?;
            let result = match method {
                "layout.list" => return Ok(json!({"panes":layout.panes().collect::<Vec<_>>()})),
                "layout.split" => {
                    let old = text(p, "pane_id")?;
                    let panes = layout.split(old, text(p, "direction")?)?;
                    tx.execute("UPDATE pane_session_bindings SET pane_id=? WHERE workspace_id=? AND pane_id=?",params![panes[0],ws,old])?;
                    tx.execute(
                        "UPDATE notifications SET pane_id=? WHERE workspace_id=? AND pane_id=?",
                        params![panes[0], ws, old],
                    )?;
                    json!({"pane_ids":panes})
                }
                "layout.close" => {
                    let pane = text(p, "pane_id")?;
                    let focus = layout.close(pane)?;
                    tx.execute(
                        "DELETE FROM pane_session_bindings WHERE workspace_id=? AND pane_id=?",
                        params![ws, pane],
                    )?;
                    json!({"focus_pane_id":focus})
                }
                "layout.focus" => {
                    layout.focus(text(p, "pane_id")?)?;
                    ok
                }
                "layout.swap" => {
                    layout.swap(text(p, "first_pane_id")?, text(p, "second_pane_id")?)?;
                    ok
                }
                "layout.move" => {
                    layout.move_pane(
                        text(p, "source_pane_id")?,
                        text(p, "target_pane_id")?,
                        text(p, "placement")?,
                    )?;
                    ok
                }
                _ => return Err(format!("method not found: {method}").into()),
            };
            save_layout(&tx, ws, &layout)?;
            tx.commit()?;
            Ok(result)
        }
        _ => Err(format!("method not found: {method}").into()),
    }
}

fn notification(db: &Connection, id: &str) -> Result<Value> {
    row(db, "SELECT n.*,w.name AS workspace_name,w.path AS workspace_path FROM notifications n JOIN workspaces w ON w.id=n.workspace_id WHERE n.id=?", [id])
}

pub fn add_notification(db: &Connection, p: &Value) -> Result<(Value, bool)> {
    let ws = text(p, "workspace_id")?;
    let title = text(p, "title")?;
    let body = p["body"].as_str().unwrap_or_default();
    let kind = p["kind"].as_str().unwrap_or("system");
    let sid = p["session_id"].as_str();
    let dedup = p["dedup_key"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!("{ws}|{}|{kind}|{title}|{body}", sid.unwrap_or_default()).to_lowercase()
        });
    let dedup: String = dedup.chars().take(200).collect();
    let duplicate = row(db, "SELECT * FROM notifications WHERE workspace_id=? AND dedup_key=?
        AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds') ORDER BY created_at DESC LIMIT 1",
        params![ws,dedup])?;
    if !duplicate.is_null() {
        return Ok((duplicate, true));
    }
    let id = id();
    db.execute(
        &format!("INSERT INTO notifications(id,workspace_id,session_id,pane_id,kind,source_kind,title,body,level,created_at,dedup_key,signature_hash,source)
                  VALUES(?,?,?,?,?,?,?,?,?,{NOW},?,?,?)"),
        params![id,ws,sid,p["pane_id"].as_str(),kind,p["source_kind"].as_str().unwrap_or("cli"),title,body,p["level"].as_str().unwrap_or("info"),dedup,dedup,p["source"].as_str().unwrap_or("cli")],
    )?;
    Ok((notification(db, &id)?, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_moves_session_binding_to_the_new_leaf_atomically() -> Result<()> {
        let db = open(Path::new(":memory:"))?;
        let created = dispatch(
            &db,
            "workspace.create",
            &json!({"name":"Binding","path":std::env::current_dir()?,"backend":"custom"}),
        )?;
        let ws = text(&created["workspace"], "id")?;
        let pane = text(&created, "root_pane_id")?;
        db.execute("INSERT INTO sessions(id,workspace_id,pid,status,started_at) VALUES('s',?,1,'running','now')",[ws])?;
        dispatch(
            &db,
            "pane.session.bind",
            &json!({"workspace_id":ws,"pane_id":pane,"session_id":"s"}),
        )?;
        let split = dispatch(
            &db,
            "layout.split",
            &json!({"workspace_id":ws,"pane_id":pane,"direction":"horizontal"}),
        )?;
        let bindings = dispatch(&db, "pane.session.bindings", &json!({"workspace_id":ws}))?;
        assert_eq!(bindings["bindings"][0]["pane_id"], split["pane_ids"][0]);
        assert_eq!(bindings["bindings"][0]["session_id"], "s");
        Ok(())
    }

    #[test]
    fn schema_twelve_backs_up_existing_database_before_migration() -> Result<()> {
        let root = std::env::temp_dir().join(format!("wincmux-schema-{}", id()));
        std::fs::create_dir_all(&root)?;
        let path = root.join("wincmux.db");
        let reminder_id;
        {
            let db = open(&path)?;
            let ws = dispatch(
                &db,
                "workspace.create",
                &json!({"name":"Retained reminders","path":std::env::temp_dir(),"backend":"custom"}),
            )?;
            let reminder = crate::reminders::save(
                &db,
                &json!({"workspace_id":ws["workspace"]["id"],"title":"Keep this schedule","timezone":"Asia/Seoul","due_at":chrono::Utc::now().timestamp()+3600}),
                chrono::Utc::now().timestamp(),
            )?;
            reminder_id = reminder["id"].as_str().unwrap().to_owned();
            db.execute_batch(
                "DELETE FROM schema_versions WHERE version=17; DELETE FROM schema_versions WHERE version=16; DELETE FROM schema_versions WHERE version=15; DROP TABLE mcp_activity; DELETE FROM schema_versions WHERE version=14; DROP TABLE mcp_settings; DELETE FROM schema_versions WHERE version=13; DELETE FROM schema_versions WHERE version=12; DROP INDEX idx_agent_followups_due; DROP TABLE agent_followups; DELETE FROM schema_versions WHERE version=11; DROP INDEX idx_notifications_scheduled_delivery; ALTER TABLE reminders DROP COLUMN observed_at; DELETE FROM schema_versions WHERE version=10;",
            )?;
        }
        let db = open(&path)?;
        let retained = row(
            &db,
            "SELECT status,observed_at FROM reminders WHERE id=?",
            [reminder_id],
        )?;
        assert_eq!(retained["status"], "pending");
        assert!(retained["observed_at"].is_null());
        assert_eq!(
            db.query_row("SELECT MAX(version) FROM schema_versions", [], |r| r
                .get::<_, u32>(0))?,
            17
        );
        assert!(std::fs::read_dir(&root)?
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains("pre-v17")));
        Ok(())
    }

    #[test]
    fn schema_twelve_preserves_followups_from_schema_eleven() -> Result<()> {
        let root = std::env::temp_dir().join(format!("wincmux-followup-upgrade-{}", id()));
        std::fs::create_dir_all(&root)?;
        let path = root.join("wincmux.db");
        {
            let db = open(&path)?;
            db.execute("INSERT INTO agent_followups(id,workspace_id,session_id,provider,agent_id,anchor_pid,anchor_started,prompt,due_at,status,created_at,updated_at) VALUES('old','ws','session','codex','agent',1,1,'Retained prompt',1,'pending',1,1)", [])?;
            db.execute_batch("ALTER TABLE agent_followups DROP COLUMN completion_after; ALTER TABLE agent_followups DROP COLUMN delivery_mode; DELETE FROM schema_versions WHERE version=17; DELETE FROM schema_versions WHERE version=16; DELETE FROM schema_versions WHERE version=15; DROP TABLE mcp_activity; DELETE FROM schema_versions WHERE version=14; DROP TABLE mcp_settings; DELETE FROM schema_versions WHERE version=13; DELETE FROM schema_versions WHERE version=12;")?;
        }
        let db = open(&path)?;
        let row = row(&db, "SELECT prompt,status,delivery_mode,completion_after FROM agent_followups WHERE id='old'", [])?;
        assert_eq!(row["prompt"], "Retained prompt");
        assert_eq!(row["status"], "failed");
        assert_eq!(row["delivery_mode"], "at_time");
        assert_eq!(row["completion_after"], 0);
        drop(db);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn mcp_off_setting_survives_database_reopen() -> Result<()> {
        let root = std::env::temp_dir().join(format!("wincmux-mcp-settings-{}", id()));
        std::fs::create_dir_all(&root)?;
        let path = root.join("wincmux.db");
        {
            let db = open(&path)?;
            db.execute("UPDATE mcp_settings SET enabled=0 WHERE id=1", [])?;
            db.execute(
                "UPDATE mcp_settings SET development_folder=?1 WHERE id=1",
                [root.to_string_lossy().as_ref()],
            )?;
        }
        let db = open(&path)?;
        let enabled: bool =
            db.query_row("SELECT enabled FROM mcp_settings WHERE id=1", [], |row| {
                row.get(0)
            })?;
        assert!(!enabled);
        let folder: String = db.query_row(
            "SELECT development_folder FROM mcp_settings WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(folder, root.to_string_lossy());
        drop(db);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn workspace_layout_and_notifications_use_the_existing_schema() -> Result<()> {
        let db = open(Path::new(":memory:"))?;
        let created = dispatch(
            &db,
            "workspace.create",
            &json!({"name":"한글 작업","path":std::env::current_dir()?,"backend":"codex"}),
        )?;
        let ws = &created["workspace"]["id"];
        let split = dispatch(
            &db,
            "layout.split",
            &json!({"workspace_id":ws,"pane_id":created["root_pane_id"],"direction":"horizontal"}),
        )?;
        assert_eq!(split["pane_ids"].as_array().unwrap().len(), 2);
        let list = dispatch(&db, "layout.list", &json!({"workspace_id":ws}))?;
        assert_eq!(list["panes"].as_array().unwrap().len(), 3);
        let notification = json!({"workspace_id":ws,"title":"완료","body":"한글 응답"});
        assert!(!add_notification(&db, &notification)?.1);
        assert!(add_notification(&db, &notification)?.1);
        assert_eq!(
            dispatch(&db, "notify.unread", &json!({"workspace_id":ws}))?["count"],
            1
        );
        Ok(())
    }
}
