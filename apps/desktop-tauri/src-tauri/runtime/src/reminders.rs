use crate::store::{self, Result, NOW};
use chrono::{
    DateTime, Datelike, Duration as CalendarDuration, NaiveDate, NaiveDateTime, TimeZone, Utc,
};
use chrono_tz::Tz;
use regex::Regex;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::LazyLock,
    time::{Duration, Instant},
};

static PROVIDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(claude|codex|gemini)(?:\.cmd|\.exe)?\b").unwrap());
static LAUNCH_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(?:&\s+)?(claude|codex|gemini)(?:\.cmd|\.exe)?(?:\s+--[^\r\n]*)?\s*$")
        .unwrap()
});
static LIMIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*[│┃!●•✻⏺✕×⚠\u{fe0f}]*\s*(?:you['’]ve hit your[^\n]{0,100}limit|you(?: have)? (?:hit|reached|exhausted)[^\n]{0,100}(?:limit|quota)|(?:usage|rate|daily|weekly)[ -]?(?:limit|quota)[^\n]{0,50}(?:reached|exceeded|exhausted)|(?:quota(?:error)?|terminalquotaerror)[^\n]{0,80}(?:exceeded|exhausted|limit)|(?:api error[^\n]{0,30}429[^\n]{0,40}resource exhausted)|(?:사용량|요청)[^\n]{0,30}한도[^\n]{0,30}(?:도달|초과))").unwrap()
});
static RESET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:resets?|try\s*again|retry|continu(?:ing|e)\s*automatically|resum(?:ing|e|es)\s*automatically|초기화|재설정)(?:\s*(?P<mode>after|in|at|on))?\s*[:：]?\s*(?P<value>.{1,180})").unwrap()
});
static NOW_TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^now(?:\b|[·⚠])").unwrap());
static ZONE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\(([A-Za-z_]+(?:/[A-Za-z_+-]+){1,2}|[A-Z]{2,5}(?:[+-]\d{1,2}(?::\d{2})?)?)\)")
        .unwrap()
});
static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})").unwrap()
});
static CLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?P<hour>\d{1,2})(?::(?P<minute>\d{2})(?::(?P<second>\d{2}))?\s*(?P<meridiem>am|pm)?|\s*(?P<hour_meridiem>am|pm))\b").unwrap()
});
static MONTH_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b").unwrap()
});
static WEEKDAY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b").unwrap()
});
static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b\d{4}-\d{2}-\d{2}\b").unwrap());
static RELATIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\d+)\s*(weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)")
        .unwrap()
});

pub fn settings(db: &Connection) -> Result<Value> {
    store::row(
        db,
        "SELECT auto_enabled,timezone FROM reminder_settings WHERE id=1",
        [],
    )
}

fn timezone(value: &str) -> Result<Tz> {
    value
        .parse()
        .map_err(|_| format!("지원하지 않는 시간대입니다: {value}").into())
}

pub fn save_settings(db: &Connection, p: &Value) -> Result<Value> {
    let tz = store::text(p, "timezone")?;
    timezone(tz)?;
    let enabled = p["auto_enabled"]
        .as_bool()
        .ok_or("auto_enabled must be boolean")?;
    db.execute(
        "UPDATE reminder_settings SET auto_enabled=?,timezone=? WHERE id=1",
        params![enabled, tz],
    )?;
    settings(db)
}

pub fn pending_count(db: &Connection) -> usize {
    db.query_row(
        "SELECT count(*) FROM reminders WHERE status='pending'",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

pub fn list(db: &Connection) -> Result<Value> {
    Ok(
        json!({"items":store::rows(db,"SELECT r.*,w.name AS workspace_name FROM reminders r JOIN workspaces w ON w.id=r.workspace_id WHERE r.status!='deleted' ORDER BY CASE r.status WHEN 'needs_time' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,COALESCE(r.due_at,0),r.created_at DESC LIMIT 300",[])?,"settings":settings(db)?}),
    )
}

pub fn save(db: &Connection, p: &Value, now: i64) -> Result<Value> {
    let workspace = store::text(p, "workspace_id")?;
    store::workspace(db, workspace)?;
    let title = store::text(p, "title")?.trim();
    let body = p["body"].as_str().unwrap_or("");
    if title.is_empty() || title.chars().count() > 200 || body.chars().count() > 4096 {
        return Err("제목은 1~200자, 내용은 4096자 이내로 입력하세요.".into());
    }
    let provider = p["provider"].as_str().unwrap_or("custom");
    if !["claude", "codex", "gemini", "custom"].contains(&provider) {
        return Err("invalid provider".into());
    }
    let tz_name = store::text(p, "timezone")?;
    let tz = timezone(tz_name)?;
    let due = if let Some(due) = p["due_at"].as_i64() {
        due
    } else {
        let local = NaiveDateTime::parse_from_str(store::text(p, "local_time")?, "%Y-%m-%dT%H:%M")?;
        tz.from_local_datetime(&local)
            .single()
            .ok_or("모호하거나 존재하지 않는 현지 시각입니다. 다른 시각을 지정하세요.")?
            .timestamp()
    };
    if due <= now || due > now + 366 * 86400 {
        return Err("현재 이후, 1년 이내의 알림 시간을 지정하세요.".into());
    }
    let sid = p["session_id"].as_str().filter(|s| !s.is_empty());
    if let Some(sid) = sid {
        if store::row(
            db,
            "SELECT id FROM sessions WHERE id=? AND workspace_id=?",
            params![sid, workspace],
        )?
        .is_null()
        {
            return Err("알림 대상 세션이 이 워크스페이스에 없습니다.".into());
        }
    }
    let id = p["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(store::id);
    let old = store::row(db, "SELECT * FROM reminders WHERE id=?", [&id])?;
    if p["id"].as_str().is_some_and(|id| !id.is_empty()) && old.is_null() {
        return Err("알림을 찾을 수 없습니다.".into());
    }
    db.execute(&format!("INSERT INTO reminders(id,workspace_id,session_id,provider,title,body,due_at,timezone,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'manual','pending',{NOW},{NOW}) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,session_id=excluded.session_id,provider=excluded.provider,title=excluded.title,body=excluded.body,due_at=excluded.due_at,timezone=excluded.timezone,source='manual',status='pending',fired_at=NULL,notification_id=NULL,updated_at={NOW}"),params![id,workspace,sid,provider,title,body,due,tz_name])?;
    store::row(db, "SELECT * FROM reminders WHERE id=?", [id])
}

pub fn cancel(db: &Connection, id: &str) -> Result<Value> {
    if db.execute(
        &format!("UPDATE reminders SET status='cancelled',updated_at={NOW} WHERE id=?"),
        [id],
    )? == 0
    {
        return Err("알림을 찾을 수 없습니다.".into());
    }
    store::row(db, "SELECT * FROM reminders WHERE id=?", [id])
}

pub fn delete(db: &Connection, id: &str) -> Result<Value> {
    // Keep a tombstone for automatic detections so a repaint cannot recreate it.
    cancel(db, id)?;
    db.execute(
        &format!("UPDATE reminders SET status='deleted',updated_at={NOW} WHERE id=?"),
        [id],
    )?;
    Ok(json!({"ok":true}))
}

#[derive(Clone, Debug)]
pub struct QuotaNotice {
    pub provider: String,
    pub kind: String,
    pub body: String,
    pub observed_at: i64,
}

pub fn reset_time(body: &str, now: i64, default_tz: &str) -> Option<(i64, String)> {
    let reset = RESET.captures(body)?;
    let text = reset.name("value")?.as_str();
    let relative = reset
        .name("mode")
        .is_some_and(|mode| matches!(mode.as_str().to_ascii_lowercase().as_str(), "in" | "after"));
    let tz_name = ZONE
        .captures(body)
        .map(|c| c[1].to_owned())
        .unwrap_or_else(|| default_tz.into());
    let tz: Tz = tz_name.parse().ok()?;
    let now_dt = DateTime::from_timestamp(now, 0)?;
    let due = if NOW_TIME.is_match(text) && !relative {
        now
    } else if let Some(iso) = ISO.find(text) {
        DateTime::parse_from_rfc3339(iso.as_str()).ok()?.timestamp()
    } else if relative {
        let mut seconds = 0i64;
        for c in RELATIVE.captures_iter(text) {
            let matched = c.get(0)?;
            if text[..matched.start()].ends_with('.')
                || text[matched.end()..]
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_alphabetic())
            {
                return None;
            }
            let count: i64 = c[1].parse().ok()?;
            let unit = c[2].to_lowercase();
            seconds = seconds.checked_add(count.checked_mul(if unit.starts_with('w') {
                7 * 86400
            } else if unit.starts_with('d') {
                86400
            } else if unit.starts_with('h') {
                3600
            } else if unit.starts_with('m') {
                60
            } else {
                1
            })?)?;
        }
        if seconds <= 0 {
            return None;
        }
        now.checked_add(seconds)?
    } else {
        let c = CLOCK.captures(text)?;
        let mut hour: u32 = c.name("hour")?.as_str().parse().ok()?;
        let minute: u32 = c
            .name("minute")
            .map(|m| m.as_str().parse())
            .transpose()
            .ok()?
            .unwrap_or(0);
        let second: u32 = c
            .name("second")
            .map(|s| s.as_str().parse())
            .transpose()
            .ok()?
            .unwrap_or(0);
        if let Some(half) = c.name("meridiem").or_else(|| c.name("hour_meridiem")) {
            if !(1..=12).contains(&hour) {
                return None;
            }
            hour = hour % 12
                + if half.as_str().eq_ignore_ascii_case("pm") {
                    12
                } else {
                    0
                };
        }
        let calendar_date = DATE.is_match(text) || MONTH_DATE.is_match(text);
        let tomorrow = text.to_lowercase().contains("tomorrow");
        let explicit_date = calendar_date || tomorrow;
        let mut date = if let Some(d) = DATE.find(text) {
            NaiveDate::parse_from_str(d.as_str(), "%Y-%m-%d").ok()?
        } else if let Some(d) = MONTH_DATE.captures(text) {
            let month = [
                "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
            ]
            .iter()
            .position(|m| d[1].to_lowercase().starts_with(m))? as u32
                + 1;
            let year = d
                .get(3)
                .map(|m| m.as_str().parse())
                .transpose()
                .ok()?
                .unwrap_or_else(|| now_dt.with_timezone(&tz).year());
            NaiveDate::from_ymd_opt(year, month, d[2].parse().ok()?)?
        } else {
            if WEEKDAY.is_match(text) {
                return None;
            }
            now_dt.with_timezone(&tz).date_naive()
        };
        if tomorrow && !calendar_date {
            date = date.checked_add_signed(CalendarDuration::days(1))?;
        }
        let mut local = date.and_hms_opt(hour, minute, second)?;
        let mut timestamp = tz.from_local_datetime(&local).single()?.timestamp();
        // A date-free clock means its next occurrence relative to when the
        // banner appeared, not relative to a later redraw or processing tick.
        // Keep the current minute as due-now rather than pushing it out 24h.
        if !explicit_date && timestamp <= now - 60 {
            date = date.checked_add_signed(CalendarDuration::days(1))?;
            local = date.and_hms_opt(hour, minute, second)?;
            timestamp = tz.from_local_datetime(&local).single()?.timestamp();
        }
        timestamp
    };
    (due > now - 60 && due <= now + 366 * 86400).then_some((due, tz_name))
}

#[derive(Default)]
pub struct LimitDetector {
    provider: String,
    buffer: String,
    input: String,
    echoes: VecDeque<String>,
    escape: u8,
    candidate: Option<(QuotaNotice, Instant)>,
    seen: VecDeque<String>,
}
impl LimitDetector {
    pub fn new(cmd: &str, args: &[String]) -> Self {
        let all = format!("{cmd} {}", args.join(" "));
        Self {
            provider: PROVIDER
                .captures(&all)
                .map(|c| c[1].to_lowercase())
                .unwrap_or_default(),
            ..Self::default()
        }
    }
    pub fn input(&mut self, text: &str) {
        self.input.push_str(text);
        keep_tail(&mut self.input, 4096);
        if text.contains(['\r', '\n']) {
            let line = self.input.trim().to_owned();
            if let Some(c) = LAUNCH_COMMAND.captures(&line) {
                self.provider = c[1].to_lowercase();
            }
            self.echoes.push_back(line);
            while self.echoes.len() > 8 {
                self.echoes.pop_front();
            }
            self.input.clear();
            self.buffer.clear();
            self.candidate = None;
        }
    }
    pub fn output(&mut self, text: &str, now: Instant) {
        self.output_at(text, now, Utc::now().timestamp());
    }
    fn output_at(&mut self, text: &str, now: Instant, observed_at: i64) {
        for ch in text.chars() {
            match self.escape {
                1 => {
                    self.escape = match ch {
                        '[' => 2,
                        ']' => 3,
                        _ => 0,
                    };
                }
                2 => {
                    if ('@'..='~').contains(&ch) {
                        self.escape = 0;
                        if matches!(ch, 'H' | 'f' | 'A' | 'B') {
                            self.buffer.push('\n');
                        }
                    }
                }
                3 => {
                    if ch == '\x07' {
                        self.escape = 0;
                    } else if ch == '\x1b' {
                        self.escape = 4;
                    }
                }
                4 => {
                    self.escape = if ch == '\\' { 0 } else { 3 };
                }
                _ => match ch {
                    '\x1b' => self.escape = 1,
                    '\r' => self.buffer.push('\n'),
                    '\0' | '\u{200b}' | '\u{2060}' | '\u{feff}' => {}
                    _ => self.buffer.push(ch),
                },
            }
        }
        keep_tail(&mut self.buffer, 8192);
        if self.provider.is_empty() {
            if let Some(c) = PROVIDER.captures(&self.buffer) {
                self.provider = c[1].to_lowercase();
            }
        }
        if self.provider.is_empty() {
            return;
        }
        let lines: Vec<_> = self.buffer.lines().collect();
        let candidate = lines.iter().enumerate().rev().find_map(|(i, line)| {
            let body = lines[i..(i + 3).min(lines.len())]
                .join(" ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if !LIMIT.is_match(&body) || self.echoes.iter().any(|input| input.contains(line.trim()))
            {
                return None;
            }
            let lower = body.to_lowercase();
            let kind = if lower.contains("weekly") || lower.contains("week limit") {
                "weekly"
            } else if lower.contains("daily") {
                "daily"
            } else if lower.contains("5-hour") || lower.contains("5 hour") {
                "five_hour"
            } else {
                "usage"
            };
            Some(QuotaNotice {
                provider: self.provider.clone(),
                kind: kind.into(),
                body: body.chars().take(500).collect(),
                observed_at,
            })
        });
        if let Some(mut notice) = candidate {
            if let Some((previous, last_change)) = &self.candidate {
                let continuation = previous.body == notice.body
                    || (now.saturating_duration_since(*last_change) <= Duration::from_secs(5)
                        && (notice.body.starts_with(&previous.body)
                            || previous.body.starts_with(&notice.body)));
                if previous.provider == notice.provider
                    && previous.kind == notice.kind
                    && continuation
                {
                    notice.observed_at = previous.observed_at;
                }
            }
            if self
                .candidate
                .as_ref()
                .is_none_or(|(old, _)| old.body != notice.body)
            {
                self.candidate = Some((notice, now));
            }
        }
    }
    pub fn poll(&mut self, now: Instant) -> Option<QuotaNotice> {
        let (notice, at) = self.candidate.as_ref()?;
        if now.saturating_duration_since(*at) < Duration::from_millis(750) {
            return None;
        }
        let key = format!("{}|{}|{}", notice.observed_at, notice.provider, notice.body);
        if self.seen.contains(&key) {
            return None;
        }
        self.seen.push_back(key);
        while self.seen.len() > 64 {
            self.seen.pop_front();
        }
        Some(notice.clone())
    }
    pub fn retry(&mut self, notice: QuotaNotice) {
        let suffix = format!("|{}|{}", notice.provider, notice.body);
        self.seen.retain(|key| !key.ends_with(&suffix));
        self.candidate = Some((notice, Instant::now()));
    }
}
fn keep_tail(text: &mut String, max: usize) {
    if text.len() > max {
        let mut start = text.len() - max;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text.drain(..start);
    }
}

pub fn register_auto(
    db: &Connection,
    workspace: &str,
    sid: &str,
    notice: &QuotaNotice,
    _processed_at: i64,
) -> Result<Option<Value>> {
    let settings = settings(db)?;
    if settings["auto_enabled"] != 1 {
        return Ok(None);
    }
    let tz = settings["timezone"].as_str().unwrap_or("Asia/Seoul");
    let reset = reset_time(&notice.body, notice.observed_at, tz);
    let due = reset.as_ref().map(|(due, _)| *due);
    let tz_name = reset.as_ref().map(|(_, tz)| tz.as_str()).unwrap_or(tz);
    let key = format!(
        "{sid}|{}|{}|{}",
        notice.provider,
        notice.kind,
        due.map(|d| d.to_string())
            .unwrap_or_else(|| format!("unknown:{}", notice.observed_at / 86400))
    );
    if !store::row(db, "SELECT id FROM reminders WHERE dedup_key=?", [&key])?.is_null() {
        return Ok(None);
    }
    // A relative countdown can repaint with second-level rounding differences.
    if let Some(due) = due {
        if !store::row(db,"SELECT id FROM reminders WHERE session_id=? AND provider=? AND limit_kind=? AND dedup_key IS NOT NULL AND ABS(due_at-?)<=90",params![sid,notice.provider,notice.kind,due])?.is_null() {return Ok(None);}
    }
    let tx = db.unchecked_transaction()?;
    if due.is_some() {
        tx.execute(&format!("UPDATE reminders SET status='cancelled',updated_at={NOW} WHERE source='auto' AND session_id=? AND provider=? AND limit_kind=? AND status IN ('pending','needs_time')"),params![sid,notice.provider,notice.kind])?;
    }
    let id = store::id();
    let title = format!(
        "{} 사용 한도 초기화 예정",
        display_provider(&notice.provider)
    );
    tx.execute(&format!("INSERT INTO reminders(id,workspace_id,session_id,provider,limit_kind,title,body,due_at,timezone,source,status,dedup_key,observed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'auto',?,?,?,{NOW},{NOW})"),params![id,workspace,sid,notice.provider,notice.kind,title,notice.body,due,tz_name,if due.is_some(){"pending"}else{"needs_time"},key,notice.observed_at])?;
    let body = match due {
        Some(due) => format!(
            "{} · 예약 알림에 등록했습니다. {}",
            DateTime::from_timestamp(due, 0)
                .unwrap()
                .with_timezone(&timezone(tz_name)?)
                .format("%m/%d %H:%M"),
            notice.body
        ),
        None => format!(
            "초기화 시각을 확인할 수 없습니다. 예약 알림에서 시간을 지정하세요. {}",
            notice.body
        ),
    };
    let (notification, _) = store::add_notification(
        &tx,
        &json!({"workspace_id":workspace,"session_id":sid,"title":format!("{} 사용 한도 감지",display_provider(&notice.provider)),"body":body,"kind":"usage_limit","level":"info","source":"quota-detector","source_kind":"pattern","dedup_key":format!("quota:{id}")}),
    )?;
    tx.commit()?;
    Ok(Some(notification))
}
fn display_provider(provider: &str) -> &str {
    match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        "gemini" => "Gemini",
        _ => "사용자",
    }
}

pub fn fire_due(db: &Connection, now: i64) -> Result<Vec<Value>> {
    let tx = db.unchecked_transaction()?;
    let due = store::rows(
        &tx,
        "SELECT * FROM reminders WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 100",
        [now],
    )?;
    let mut notifications = Vec::new();
    for item in due {
        let id = store::text(&item, "id")?;
        let body = if item["source"] == "auto" {
            format!(
                "초기화 예정 시각이 되었습니다. 해당 도구에서 사용 가능 여부를 확인하세요.\n{}",
                item["body"].as_str().unwrap_or("")
            )
        } else {
            item["body"].as_str().unwrap_or("").to_owned()
        };
        let (notification, _) = store::add_notification(
            &tx,
            &json!({"workspace_id":item["workspace_id"],"session_id":item["session_id"],"title":item["title"],"body":body,"kind":"reminder_due","level":"info","source":"reminder","source_kind":"schedule","dedup_key":format!("reminder:{id}:{}",item["due_at"])}),
        )?;
        tx.execute(&format!("UPDATE reminders SET status='sent',fired_at={NOW},updated_at={NOW},notification_id=? WHERE id=? AND status='pending'"),params![notification["id"].as_str(),id])?;
        notifications.push(notification);
    }
    tx.commit()?;
    Ok(notifications)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn epoch(text: &str) -> i64 {
        DateTime::parse_from_rfc3339(text).unwrap().timestamp()
    }
    fn database() -> (Connection, String) {
        let db = store::open(std::path::Path::new(":memory:")).unwrap();
        let ws = store::dispatch(
            &db,
            "workspace.create",
            &json!({"name":"Reminder tests","path":std::env::temp_dir(),"backend":"custom"}),
        )
        .unwrap();
        (db, ws["workspace"]["id"].as_str().unwrap().to_owned())
    }
    #[test]
    fn reset_clocks_respect_timezones_am_pm_and_ambiguous_dates() {
        let now = epoch("2026-11-17T04:00:00Z");
        assert_eq!(
            reset_time(
                "You've hit your 5-hour limit · resets 2:50pm (Asia/Seoul)",
                now,
                "UTC"
            )
            .unwrap()
            .0,
            epoch("2026-11-17T05:50:00Z")
        );
        assert_eq!(
            reset_time("resets 3pm (Asia/Seoul)", now, "UTC").unwrap().0,
            epoch("2026-11-17T06:00:00Z")
        );
        assert_eq!(
            reset_time("resets in 1h30m", now, "UTC").unwrap().0,
            now + 5400
        );
        assert_eq!(
            reset_time("retry in 1 day 2h", now, "UTC").unwrap().0,
            now + 93600
        );
        assert!(reset_time("retry in 1.5 hours", now, "UTC").is_none());
        assert_eq!(
            reset_time("try again at Nov 18, 2026 3:30pm (Asia/Seoul)", now, "UTC")
                .unwrap()
                .0,
            epoch("2026-11-18T06:30:00Z")
        );
        assert_eq!(
            reset_time("resets Nov 20 at 5am (Asia/Seoul)", now, "UTC")
                .unwrap()
                .0,
            epoch("2026-11-19T20:00:00Z")
        );
        assert!(reset_time("resets Wed at 3pm (Asia/Seoul)", now, "UTC").is_none());
        assert!(reset_time("resets 2026-99-99 at 3pm (Asia/Seoul)", now, "UTC").is_none());
        assert_eq!(
            reset_time("resets at 14:50 (Asia/Seoul)", now, "UTC")
                .unwrap()
                .0,
            epoch("2026-11-17T05:50:00Z")
        );
        assert_eq!(
            reset_time("resets in 1h 20m", now, "Asia/Seoul").unwrap().0,
            now + 4800
        );
        assert_eq!(
            reset_time("retry after 30 seconds", now, "UTC").unwrap().0,
            now + 30
        );
        assert_eq!(
            reset_time("resets at 2026-11-18T02:00:00+09:00", now, "UTC")
                .unwrap()
                .0,
            epoch("2026-11-17T17:00:00Z")
        );
        assert_eq!(
            reset_time("resets tomorrow 12:00am (Asia/Seoul)", now, "UTC")
                .unwrap()
                .0,
            epoch("2026-11-17T15:00:00Z")
        );
        assert_eq!(
            reset_time("resets 12:00pm (Asia/Seoul)", now, "UTC")
                .unwrap()
                .0,
            epoch("2026-11-18T03:00:00Z")
        );
        assert!(reset_time("resets 25:00 (Asia/Seoul)", now, "UTC").is_none());
        assert!(reset_time("resets 14:50 (Not/AZone)", now, "UTC").is_none());
        assert!(reset_time(
            "resets 01:30 (America/New_York)",
            epoch("2026-11-01T04:00:00Z"),
            "UTC"
        )
        .is_none());
        assert!(reset_time("Quota exceeded", now, "UTC").is_none());
    }
    #[test]
    fn compact_auto_continue_uses_next_local_clock_and_ignores_credits_now() {
        let appeared = epoch("2026-11-17T15:00:00+09:00");
        assert_eq!(
            reset_time(
                "continuing automatically tomorrow Nov 18, 2026 at 3am",
                appeared,
                "Asia/Seoul"
            )
            .unwrap()
            .0,
            epoch("2026-11-18T03:00:00+09:00")
        );
        let raw="⚠Usagelimitreached·continuingautomaticallyat7:50pm·esctocancel ⚠ /usage-credits to continue now";
        assert_eq!(
            reset_time(raw, appeared, "Asia/Seoul").unwrap().0,
            epoch("2026-11-17T19:50:00+09:00")
        );
        assert_eq!(
            reset_time(raw, epoch("2026-11-17T20:00:00+09:00"), "Asia/Seoul")
                .unwrap()
                .0,
            epoch("2026-11-18T19:50:00+09:00")
        );
        for text in [
            "continuing automatically at 3:00am",
            "continuingautomaticallyat3am",
            "resetsat03:00",
        ] {
            assert_eq!(
                reset_time(text, appeared, "Asia/Seoul").unwrap().0,
                epoch("2026-11-18T03:00:00+09:00")
            );
        }
        assert_eq!(
            reset_time(
                "continuingautomaticallyat12:05am",
                epoch("2026-11-17T23:59:59+09:00"),
                "Asia/Seoul"
            )
            .unwrap()
            .0,
            epoch("2026-11-18T00:05:00+09:00")
        );
        assert_eq!(
            reset_time(
                "continuing automatically at 7:50:30pm",
                appeared,
                "Asia/Seoul"
            )
            .unwrap()
            .0,
            epoch("2026-11-17T19:50:30+09:00")
        );
        assert_eq!(
            reset_time(
                "continuing automatically now · esc to cancel",
                appeared,
                "Asia/Seoul"
            )
            .unwrap()
            .0,
            appeared
        );
        assert_eq!(
            reset_time("resets now", appeared, "Asia/Seoul").unwrap().0,
            appeared
        );
        assert!(reset_time(
            "Usage limit reached · /usage-credits to continue now",
            appeared,
            "Asia/Seoul"
        )
        .is_none());
        assert!(reset_time("continuing automatically nowhere", appeared, "Asia/Seoul").is_none());
        assert!(
            reset_time(
                "continuing automatically at 2026-11-17 03:00",
                appeared,
                "Asia/Seoul"
            )
            .is_none(),
            "an explicit past date is never silently changed"
        );
    }

    #[test]
    fn first_observation_survives_chunk_boundaries_midnight_and_late_processing() {
        let start = Instant::now();
        let appeared = epoch("2026-11-17T19:49:59+09:00");
        let mut detector = LimitDetector::new("codex", &[]);
        detector.output_at(
            "⚠️Usagelimitreached·continuingautomaticallyat",
            start,
            appeared,
        );
        detector.output_at(
            "7:50pm·esctocancel ⚠ /usage-credits to continue now",
            start + Duration::from_secs(2),
            appeared + 2,
        );
        let notice = detector.poll(start + Duration::from_secs(3)).unwrap();
        assert_eq!(notice.observed_at, appeared);
        let (db, ws) = database();
        register_auto(&db, &ws, "timing-session", &notice, appeared + 120).unwrap();
        let item = list(&db).unwrap()["items"][0].clone();
        assert_eq!(item["observed_at"], appeared);
        assert_eq!(item["due_at"], epoch("2026-11-17T19:50:00+09:00"));
        assert_eq!(
            fire_due(&db, appeared + 120).unwrap().len(),
            1,
            "late processing fires due reminders instead of pushing them to tomorrow"
        );

        let midnight = epoch("2026-11-17T23:59:59+09:00");
        let mut detector = LimitDetector::new("claude", &[]);
        detector.output_at("Usage limit reached. Retry in ", start, midnight);
        detector.output_at("5 minutes", start + Duration::from_secs(2), midnight + 2);
        let notice = detector.poll(start + Duration::from_secs(3)).unwrap();
        assert_eq!(notice.observed_at, midnight);
        assert_eq!(
            reset_time(&notice.body, notice.observed_at, "Asia/Seoul")
                .unwrap()
                .0,
            midnight + 300
        );
    }

    #[test]
    fn same_minute_is_due_now_and_paint_does_not_shift_first_observation() {
        let appeared = epoch("2026-11-17T19:50:30+09:00");
        assert_eq!(
            reset_time("continuing automatically at 7:50pm", appeared, "Asia/Seoul")
                .unwrap()
                .0,
            epoch("2026-11-17T19:50:00+09:00")
        );
        let start = Instant::now();
        let mut detector = LimitDetector::new("codex", &[]);
        let text="\r\n⚠Usagelimitreached·continuingautomaticallyat7:50pm·esctocancel ⚠ /usage-credits to continue now\r\n";
        detector.output_at(text, start, appeared);
        let notice = detector.poll(start + Duration::from_secs(1)).unwrap();
        detector.output_at(text, start + Duration::from_secs(180), appeared + 180);
        assert!(detector.poll(start + Duration::from_secs(181)).is_none());
        assert_eq!(notice.observed_at, appeared);
    }

    #[test]
    fn detector_preserves_split_ansi_messages_and_filters_echoes() {
        let start = Instant::now();
        for tool in ["claude", "codex", "gemini"] {
            let mut detector = LimitDetector::new(tool, &[]);
            let message = if tool == "gemini" {
                "\x1b[31mYou have exhausted your daily quota.\x1b[0m Retry in 20 seconds"
            } else {
                "\x1b[31mYou've hit your 5-hour limit\x1b[0m · resets 2:50pm (Asia/Seoul)"
            };
            for ch in message.chars() {
                detector.output(&ch.to_string(), start);
            }
            assert!(detector.poll(start).is_none());
            let notice = detector.poll(start + Duration::from_secs(1)).unwrap();
            assert_eq!(notice.provider, tool);
            assert!(!notice.body.contains('\x1b'));
            assert!(detector.poll(start + Duration::from_secs(2)).is_none());
        }
        let mut d = LimitDetector::new("claude", &[]);
        d.input("Explain: You've hit your 5-hour limit\r");
        d.output("You've hit your 5-hour limit", start);
        assert!(d.poll(start + Duration::from_secs(1)).is_none());
        d.output(
            "\r\nThe documentation says You've hit your 5-hour limit\r\n",
            start,
        );
        assert!(d.poll(start + Duration::from_secs(1)).is_none());
    }
    #[test]
    fn auto_registration_deduplicates_cancelled_and_sent_periods() {
        let (db, ws) = database();
        let now = epoch("2026-11-17T04:00:00Z");
        let notice = QuotaNotice {
            provider: "claude".into(),
            kind: "five_hour".into(),
            body: "You've hit your 5-hour limit · resets 2:50pm (Asia/Seoul)".into(),
            observed_at: now,
        };
        assert!(register_auto(&db, &ws, "session", &notice, now)
            .unwrap()
            .is_some());
        assert!(register_auto(&db, &ws, "session", &notice, now + 1)
            .unwrap()
            .is_none());
        let item = list(&db).unwrap()["items"][0].clone();
        cancel(&db, item["id"].as_str().unwrap()).unwrap();
        assert!(register_auto(&db, &ws, "session", &notice, now + 2)
            .unwrap()
            .is_none());
        assert!(fire_due(&db, now + 99999).unwrap().is_empty());
        delete(&db, item["id"].as_str().unwrap()).unwrap();
        assert!(list(&db).unwrap()["items"].as_array().unwrap().is_empty());
        assert!(register_auto(&db, &ws, "session", &notice, now + 3)
            .unwrap()
            .is_none());
    }
    #[test]
    fn due_delivery_is_transactional_and_survives_reopening() {
        let root = std::env::temp_dir().join(format!("wincmux-reminder-{}", store::id()));
        let path = root.join("state.db");
        let now = Utc::now().timestamp();
        let id = {
            let db = store::open(&path).unwrap();
            let ws = store::dispatch(
                &db,
                "workspace.create",
                &json!({"name":"Retained","path":std::env::temp_dir(),"backend":"custom"}),
            )
            .unwrap();
            let item=save(&db,&json!({"workspace_id":ws["workspace"]["id"],"title":"재개 알림","body":"한글","timezone":"Asia/Seoul","due_at":now+5}),now).unwrap();
            assert_eq!(pending_count(&db), 1);
            item["id"].as_str().unwrap().to_owned()
        };
        let db = store::open(&path).unwrap();
        assert!(fire_due(&db, now + 4).unwrap().is_empty());
        let sent = fire_due(&db, now + 7).unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["kind"], "reminder_due");
        assert_eq!(pending_count(&db), 0);
        assert!(fire_due(&db, now + 99).unwrap().is_empty());
        assert_eq!(
            store::row(&db, "SELECT status FROM reminders WHERE id=?", [id]).unwrap()["status"],
            "sent"
        );
    }
    #[test]
    fn unknown_times_require_input_and_disabled_detection_does_not_register() {
        let (db, ws) = database();
        let now = Utc::now().timestamp();
        let notice = QuotaNotice {
            provider: "gemini".into(),
            kind: "daily".into(),
            body: "You have exhausted your daily quota".into(),
            observed_at: now,
        };
        register_auto(&db, &ws, "session", &notice, now).unwrap();
        assert_eq!(list(&db).unwrap()["items"][0]["status"], "needs_time");
        assert_eq!(pending_count(&db), 0);
        save_settings(&db, &json!({"auto_enabled":false,"timezone":"Asia/Seoul"})).unwrap();
        assert!(register_auto(&db, &ws, "second", &notice, now)
            .unwrap()
            .is_none());
        assert!(save(
            &db,
            &json!({"workspace_id":ws,"title":"old","timezone":"Asia/Seoul","due_at":now-1}),
            now
        )
        .is_err());
    }
}
