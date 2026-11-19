use crate::store::{self, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub fn list(
    db: &Connection,
    workspace: Option<&str>,
    session: Option<&str>,
    queue_only: bool,
) -> Result<Value> {
    let items = store::rows(
        db,
        "SELECT * FROM agent_followups
         WHERE (?1 IS NULL OR workspace_id=?1) AND (?2 IS NULL OR session_id=?2)
         AND (?3=0 OR status IN ('pending','paused','claimed','failed'))
         ORDER BY created_at DESC,rowid DESC LIMIT 100",
        params![workspace, session, queue_only],
    )?;
    Ok(json!({"items":items}))
}

pub fn schedule(
    db: &Connection,
    session_id: &str,
    workspace_id: &str,
    provider: &str,
    agent_id: &str,
    anchor: (u32, u64),
    prompt: &str,
    due_at: i64,
    now: i64,
    delivery_mode: &str,
    completion_after: u64,
) -> Result<Value> {
    if !matches!(delivery_mode, "at_time" | "after_completion" | "when_ready") {
        return Err("invalid follow-up delivery mode".into());
    }
    if prompt.trim().is_empty()
        || prompt.len() > 16_000
        || prompt
            .chars()
            .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
        || matches!(prompt.trim_start().chars().next(), Some('!' | '/'))
    {
        return Err("follow-up prompt must be plain text, cannot start with ! or /, and must be at most 16000 bytes".into());
    }
    if due_at < now || due_at > now + 366 * 24 * 3600 {
        return Err("follow-up time is out of range".into());
    }
    let id = store::id();
    db.execute("INSERT INTO agent_followups(id,workspace_id,session_id,provider,agent_id,anchor_pid,anchor_started,prompt,due_at,status,created_at,updated_at,delivery_mode,completion_after) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)",
        params![id,workspace_id,session_id,provider,agent_id,anchor.0,anchor.1 as i64,prompt,due_at,now,now,delivery_mode,completion_after as i64])?;
    Ok(json!({"id":id,"status":"pending"}))
}

pub fn cancel(db: &Connection, id: &str, now: i64) -> Result<Value> {
    let changed = db.execute("UPDATE agent_followups SET status='cancelled',updated_at=? WHERE id=? AND status IN ('pending','paused')", params![now,id])?;
    if changed == 0 {
        return Err("follow-up cannot be cancelled".into());
    }
    prune_completed(db, Some(id));
    status_result(db, id, "cancelled")
}

pub fn dismiss_failed(db: &Connection, id: &str) -> Result<Value> {
    let row = by_id(db, id)?;
    if db.execute(
        "DELETE FROM agent_followups WHERE id=? AND status='failed'",
        [id],
    )? == 0
    {
        return Err("only failed follow-ups can be dismissed".into());
    }
    Ok(row)
}

pub(crate) fn prune_completed(db: &Connection, keep: Option<&str>) {
    if let Err(err) = db.execute(
        "DELETE FROM agent_followups WHERE status IN ('sent','cancelled')
                AND (?1 IS NULL OR id!=?1)
                AND id NOT IN (SELECT id FROM agent_followups WHERE status IN ('sent','cancelled')
                               ORDER BY updated_at DESC,rowid DESC LIMIT 100)",
        [keep],
    ) {
        crate::platform::log(&format!("completed follow-up cleanup failed: {err}"));
    }
}
pub fn pause(db: &Connection, id: &str, now: i64) -> Result<Value> {
    change_status(db, id, "paused", "pending", now)
}

pub fn resume(db: &Connection, id: &str, now: i64) -> Result<Value> {
    change_status(db, id, "pending", "paused", now)
}

fn change_status(db: &Connection, id: &str, next: &str, previous: &str, now: i64) -> Result<Value> {
    let changed = db.execute(
        "UPDATE agent_followups SET status=?,updated_at=? WHERE id=? AND status=?",
        params![next, now, id, previous],
    )?;
    if changed == 0 {
        return Err(format!("follow-up is not {previous}").into());
    }
    status_result(db, id, next)
}

fn status_result(db: &Connection, id: &str, next: &str) -> Result<Value> {
    let mut rows = store::rows(
        db,
        "SELECT workspace_id,session_id FROM agent_followups WHERE id=?",
        [id],
    )?;
    let row = rows.pop().ok_or("follow-up disappeared")?;
    Ok(
        json!({"ok":true,"id":id,"status":next,"workspace_id":row["workspace_id"],"session_id":row["session_id"]}),
    )
}

pub fn due(db: &Connection, now: i64) -> Result<Vec<Value>> {
    store::rows(db, "SELECT * FROM agent_followups WHERE status='pending' AND due_at<=? ORDER BY rowid LIMIT 20", [now])
}

pub fn pending_by_id(db: &Connection, id: &str) -> Result<Value> {
    store::rows(
        db,
        "SELECT * FROM agent_followups WHERE id=? AND status IN ('pending','paused')",
        [id],
    )?
    .pop()
    .ok_or_else(|| "follow-up is not pending".into())
}

pub fn by_id(db: &Connection, id: &str) -> Result<Value> {
    store::rows(
        db,
        "SELECT id,status,result,workspace_id,session_id FROM agent_followups WHERE id=?",
        [id],
    )?
    .pop()
    .ok_or_else(|| "follow-up disappeared".into())
}

pub fn claim_now(db: &Connection, id: &str, now: i64) -> Result<bool> {
    Ok(db.execute("UPDATE agent_followups SET status='claimed',claim_at=?,updated_at=? WHERE id=? AND status IN ('pending','paused')", params![now,now,id])? == 1)
}

pub fn pending_terminal(db: &Connection) -> Result<Vec<Value>> {
    store::rows(db, "SELECT id,workspace_id,session_id,anchor_pid,anchor_started FROM agent_followups WHERE provider='terminal' AND status IN ('pending','paused') LIMIT 100", [])
}

pub fn fail_pending(db: &Connection, id: &str, reason: &str, now: i64) -> Result<bool> {
    Ok(db.execute("UPDATE agent_followups SET status='failed',result=?,updated_at=? WHERE id=? AND status IN ('pending','paused')", params![reason,now,id])? == 1)
}

pub fn claim(db: &Connection, id: &str, now: i64) -> Result<bool> {
    Ok(db.execute("UPDATE agent_followups SET status='claimed',claim_at=?,updated_at=? WHERE id=? AND status='pending' AND due_at<=?", params![now,now,id,now])? == 1)
}

pub fn finish(db: &Connection, id: &str, sent: bool, result: &str, now: i64) -> Result<()> {
    db.execute(
        "UPDATE agent_followups SET status=?,result=?,updated_at=? WHERE id=? AND status='claimed'",
        params![if sent { "sent" } else { "failed" }, result, now, id],
    )?;
    if sent {
        prune_completed(db, Some(id));
    }
    Ok(())
}

pub fn fail_session(db: &Connection, sid: &str, now: i64) -> Result<()> {
    db.execute("UPDATE agent_followups SET status='failed',result='target session ended',updated_at=? WHERE session_id=? AND status IN ('pending','paused')", params![now,sid])?;
    Ok(())
}

pub fn fail_agent(db: &Connection, sid: &str, now: i64) -> Result<()> {
    db.execute("UPDATE agent_followups SET status='failed',result='target agent process exited',updated_at=? WHERE session_id=? AND status IN ('pending','paused')", params![now,sid])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_followups_leave_the_queue_and_history_is_bounded() -> Result<()> {
        let db = store::open(std::path::Path::new(":memory:"))?;
        for now in 1..=105 {
            let row = schedule(
                &db,
                "s",
                "w",
                "terminal",
                "a",
                (1, 1),
                "prompt",
                now,
                now,
                "when_ready",
                0,
            )?;
            let id = row["id"].as_str().unwrap();
            assert!(claim(&db, id, now)?);
            finish(&db, id, true, "submitted", now)?;
        }
        assert!(list(&db, None, Some("s"), true)?["items"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM agent_followups", [], |row| row
                .get::<_, u64>(0))?,
            100
        );
        let row = schedule(
            &db,
            "s",
            "w",
            "terminal",
            "a",
            (1, 1),
            "recoverable",
            106,
            106,
            "when_ready",
            0,
        )?;
        let id = row["id"].as_str().unwrap();
        assert!(claim(&db, id, 106)?);
        finish(&db, id, false, "draft still present", 106)?;
        assert_eq!(list(&db, None, Some("s"), true)?["items"][0]["id"], id);
        assert_eq!(dismiss_failed(&db, id)?["status"], "failed");
        assert!(list(&db, None, Some("s"), true)?["items"]
            .as_array()
            .unwrap()
            .is_empty());
        Ok(())
    }

    #[test]
    fn restart_never_replays_claimed_or_orphaned_followups() -> Result<()> {
        let root = std::env::temp_dir().join(format!("wincmux-followups-{}", store::id()));
        std::fs::create_dir_all(&root)?;
        let path = root.join("test.db");
        {
            let db = store::open(&path)?;
            assert!(schedule(
                &db,
                "one",
                "workspace",
                "codex",
                "agent",
                (42, 1),
                "unsafe\rsubmit",
                10,
                9,
                "at_time",
                0
            )
            .is_err());
            assert!(schedule(
                &db,
                "one",
                "workspace",
                "codex",
                "agent",
                (42, 1),
                "!danger",
                10,
                9,
                "at_time",
                0
            )
            .is_err());
            assert!(schedule(
                &db,
                "one",
                "workspace",
                "codex",
                "agent",
                (42, 1),
                " /command",
                10,
                9,
                "at_time",
                0
            )
            .is_err());
            let claimed = schedule(
                &db,
                "one",
                "workspace",
                "codex",
                "agent",
                (42, 1),
                "claimed",
                10,
                9,
                "at_time",
                0,
            )?;
            let paused = schedule(
                &db,
                "two",
                "workspace",
                "claude",
                "agent",
                (43, 1),
                "paused",
                10,
                9,
                "at_time",
                0,
            )?;
            assert!(claim(&db, claimed["id"].as_str().unwrap(), 10)?);
            pause(&db, paused["id"].as_str().unwrap(), 10)?;
        }
        let db = store::open(&path)?;
        let items = list(&db, None, None, false)?["items"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item["status"] == "failed"));
        assert!(items
            .iter()
            .any(|item| item["result"] == "delivery interrupted before confirmation"));
        assert!(items
            .iter()
            .any(|item| item["result"] == "target session ended when core restarted"));
        drop(db);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
}
