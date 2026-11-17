//! Read-only discovery of CLI-owned conversations. Never import or rewrite transcripts.
use crate::store::Result;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct Roots {
    pub claude: PathBuf,
    pub codex: PathBuf,
}
impl Roots {
    pub fn local() -> Self {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_default();
        Self {
            claude: std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".claude")),
            codex: std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex")),
        }
    }
}

fn normalized(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("//?/")
        .trim_end_matches('/')
        .to_lowercase()
}
fn matches_project(cwd: &str, project: &str, children: bool) -> bool {
    let cwd = normalized(cwd);
    let project = normalized(project);
    !project.is_empty() && (cwd == project || (children && cwd.starts_with(&(project + "/"))))
}
fn uuid(value: &str) -> Option<String> {
    // CLI resume accepts identifiers only, never execute a command read from a log.
    if value.len() != 36 {
        return None;
    }
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|v| v.hyphenated().to_string())
}
fn short(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(180)
        .collect()
}
fn modified(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_secs() as i64)
        .unwrap_or(0)
}
fn linked(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                m.file_attributes() & 0x400 != 0
            }
            #[cfg(not(windows))]
            {
                m.file_type().is_symlink()
            }
        })
        .unwrap_or(true)
}
fn chunks(path: &Path, head: u64, tail: u64) -> std::io::Result<Vec<Vec<u8>>> {
    if linked(path) {
        return Ok(Vec::new());
    }
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut first = Vec::new();
    (&mut file).take(head).read_to_end(&mut first)?;
    let mut parts = vec![first];
    if size > head && tail > 0 {
        file.seek(SeekFrom::Start(head.max(size.saturating_sub(tail))))?;
        let mut last = Vec::new();
        file.take(tail).read_to_end(&mut last)?;
        parts.push(last);
    }
    Ok(parts)
}
fn visit(
    root: &Path,
    depth: usize,
    files: &mut Vec<PathBuf>,
    budget: &mut usize,
    limited: &mut bool,
) {
    if linked(root) {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            *limited = true;
            break;
        }
        *budget -= 1;
        let path = entry.path();
        if linked(&path) {
            continue;
        }
        if path.is_dir()
            && depth > 0
            && path.file_name().and_then(|v| v.to_str()) != Some("subagents")
        {
            visit(&path, depth - 1, files, budget, limited);
        } else if path.extension().and_then(|v| v.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}
fn row(
    provider: &str,
    id: &str,
    cwd: &str,
    title: &str,
    updated: i64,
    source: &Path,
    archived: bool,
) -> Value {
    json!({"provider":provider,"id":id,"cwd":cwd,"title":short(title),"updated_at":updated,
        "source_path":source.to_string_lossy(),"archived":archived,"cwd_exists":Path::new(cwd).is_dir(),
        "resume_command":if provider=="claude" {format!("claude --resume {id}")} else {format!("codex resume {id}")}})
}
fn user_text(message: &Value) -> String {
    if let Some(s) = message["content"].as_str() {
        return short(s);
    }
    message["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .map(|s| short(&s))
        .unwrap_or_default()
}
fn human_title(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('<')
        && !s.starts_with("# ")
        && !s.starts_with("Caveat:")
        && !s.starts_with("This session is being continued")
}
fn claude_file(path: &Path, project: &str, children: bool) -> Option<Value> {
    let id = uuid(path.file_stem()?.to_str()?)?;
    let parts = chunks(path, 512 * 1024, 192 * 1024).ok()?;
    let mut cwd = String::new();
    let mut first = String::new();
    let mut title = String::new();
    let mut title_rank = 0;
    let mut sidechain = false;
    for part in parts {
        for line in part.split(|c| *c == b'\n') {
            let Ok(v) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            if v["sessionId"].as_str().is_some_and(|value| value != id) {
                continue;
            }
            if cwd.is_empty() {
                if let Some(s) = v["cwd"].as_str() {
                    cwd = s.to_owned();
                }
            }
            sidechain |= v["isSidechain"] == true;
            if first.is_empty()
                && v["type"] == "user"
                && v["isMeta"] != true
                && v.get("toolUseResult").is_none()
            {
                let s = user_text(&v["message"]);
                if human_title(&s) {
                    first = s;
                }
            }
            let (rank, label) = match v["type"].as_str() {
                Some("custom-title") => (3, v["customTitle"].as_str()),
                Some("ai-title") => (2, v["aiTitle"].as_str()),
                Some("summary") => (1, v["summary"].as_str()),
                _ => (0, None),
            };
            if rank >= title_rank {
                if let Some(s) = label.filter(|s| !s.is_empty()) {
                    title = short(s);
                    title_rank = rank;
                }
            }
        }
    }
    if sidechain || !matches_project(&cwd, project, children) {
        return None;
    }
    if title.is_empty() {
        title = first;
    }
    if title.is_empty() {
        title = format!("Claude 대화 · {}", &id[..8]);
    }
    Some(row(
        "claude",
        &id,
        &cwd,
        &title,
        modified(path),
        path,
        false,
    ))
}
fn subagent(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.contains_key("subagent"))
        || value
            .as_str()
            .is_some_and(|s| s.to_lowercase().contains("subagent"))
}
fn codex_file(
    path: &Path,
    project: &str,
    children: bool,
    titles: &HashMap<String, String>,
) -> Option<Value> {
    for part in chunks(path, 128 * 1024, 0).ok()? {
        for line in part.split(|c| *c == b'\n') {
            let Ok(v) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            if v["type"] != "session_meta" {
                continue;
            }
            let meta = &v["payload"];
            let id = uuid(
                meta["id"]
                    .as_str()
                    .or_else(|| meta["session_id"].as_str())?,
            )?;
            let cwd = meta["cwd"].as_str()?;
            if subagent(&meta["source"])
                || subagent(&meta["thread_source"])
                || !matches_project(cwd, project, children)
            {
                return None;
            }
            let title = titles
                .get(&id)
                .cloned()
                .unwrap_or_else(|| format!("Codex 대화 · {}", &id[..8]));
            return Some(row("codex", &id, cwd, &title, modified(path), path, false));
        }
    }
    None
}
fn codex_database(
    path: &Path,
    project: &str,
    children: bool,
) -> std::result::Result<Vec<Value>, rusqlite::Error> {
    // READ_ONLY honors WAL snapshots without taking ownership of Codex's database.
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(Duration::from_millis(400))?;
    let columns: HashSet<String> = db
        .prepare("PRAGMA table_info(threads)")?
        .query_map([], |r| r.get(1))?
        .collect::<std::result::Result<_, _>>()?;
    if !["id", "cwd", "updated_at"]
        .iter()
        .all(|c| columns.contains(*c))
    {
        return Ok(Vec::new());
    }
    let names = [
        "id",
        "cwd",
        "updated_at",
        "title",
        "first_user_message",
        "rollout_path",
        "archived",
        "source",
        "thread_source",
        "name",
        "preview",
    ];
    let select = names
        .iter()
        .map(|c| {
            if columns.contains(*c) {
                format!("\"{c}\"")
            } else {
                "NULL".to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    let mut statement = db.prepare(&format!(
        "SELECT {select} FROM threads ORDER BY updated_at DESC"
    ))?;
    let mut rows = statement.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let id: String = r.get(0)?;
        let Some(id) = uuid(&id) else {
            continue;
        };
        let cwd: String = r.get(1)?;
        if !matches_project(&cwd, project, children) {
            continue;
        }
        let source: String = r.get::<_, Option<String>>(7)?.unwrap_or_default();
        let thread_source: String = r.get::<_, Option<String>>(8)?.unwrap_or_default();
        if subagent(&Value::String(source)) || subagent(&Value::String(thread_source)) {
            continue;
        }
        let title = [9, 3, 10, 4]
            .into_iter()
            .filter_map(|i| r.get::<_, Option<String>>(i).ok().flatten())
            .find(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("Codex 대화 · {}", &id[..8]));
        let updated: i64 = r.get(2)?;
        let source_path = r
            .get::<_, Option<String>>(5)?
            .map(PathBuf::from)
            .unwrap_or_else(|| path.to_owned());
        // Metadata can outlive a deleted transcript; never offer such a row as resumable.
        if !source_path.is_file() {
            continue;
        }
        out.push(row(
            "codex",
            &id,
            &cwd,
            &title,
            if updated > 100_000_000_000 {
                updated / 1000
            } else {
                updated
            },
            &source_path,
            r.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
        ));
    }
    Ok(out)
}

pub fn scan(roots: &Roots, project: &str, children: bool) -> Value {
    let mut items = HashMap::<String, Value>::new();
    let mut warnings = Vec::<String>::new();
    let mut limited = false;
    let mut files = Vec::new();
    let mut budget = 20000;
    let claude_root = roots.claude.join("projects");
    visit(&claude_root, 1, &mut files, &mut budget, &mut limited);
    for path in files {
        if let Some(v) = claude_file(&path, project, children) {
            items.insert(format!("claude:{}", v["id"].as_str().unwrap()), v);
        }
    }
    let mut titles = HashMap::new();
    if let Ok(parts) = chunks(
        &roots.codex.join("session_index.jsonl"),
        8 * 1024 * 1024,
        2 * 1024 * 1024,
    ) {
        for part in parts {
            for line in part.split(|c| *c == b'\n') {
                if let Ok(v) = serde_json::from_slice::<Value>(line) {
                    if let (Some(id), Some(title)) = (v["id"].as_str(), v["thread_name"].as_str()) {
                        titles.insert(id.to_owned(), short(title));
                    }
                }
            }
        }
    }
    // Prefer the newest schema when several Codex database versions remain after upgrades.
    let mut databases = fs::read_dir(&roots.codex)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|v| v.to_str())
                .is_some_and(|s| s.starts_with("state_") && s.ends_with(".sqlite"))
        })
        .filter(|p| !linked(p))
        .collect::<Vec<_>>();
    databases.sort_by_key(|p| {
        std::cmp::Reverse(
            p.file_stem()
                .and_then(|v| v.to_str())
                .and_then(|s| s.strip_prefix("state_"))
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0),
        )
    });
    if let Some(path) = databases.first() {
        match codex_database(path, project, children) {
            Ok(rows) => {
                for mut v in rows {
                    if let Some(title) = titles.get(v["id"].as_str().unwrap()) {
                        v["title"] = json!(title);
                    }
                    items.insert(format!("codex:{}", v["id"].as_str().unwrap()), v);
                }
            }
            Err(_) => {
                warnings.push("Codex 대화 DB를 읽지 못해 로컬 대화 파일에서 조회했습니다.".into())
            }
        }
    }
    for directory in ["sessions", "archived_sessions"] {
        let mut files = Vec::new();
        visit(
            &roots.codex.join(directory),
            4,
            &mut files,
            &mut budget,
            &mut limited,
        );
        for path in files {
            if let Some(mut v) = codex_file(&path, project, children, &titles) {
                v["archived"] = json!(directory == "archived_sessions");
                items
                    .entry(format!("codex:{}", v["id"].as_str().unwrap()))
                    .or_insert(v);
            }
        }
    }
    if limited {
        warnings.push(
            "조회 가능한 파일 수를 초과했습니다. 일부 이전 대화가 생략될 수 있습니다.".into(),
        );
    }
    if !claude_root.is_dir() {
        warnings.push("Claude 로컬 대화 폴더가 없습니다. 다른 Windows 계정이나 WSL에서 실행한 이력은 여기에 나타나지 않습니다.".into());
    }
    let mut items = items.into_values().collect::<Vec<_>>();
    items.sort_by_key(|v| std::cmp::Reverse(v["updated_at"].as_i64().unwrap_or(0)));
    json!({"items":items,"warnings":warnings,"project_path":project,"include_children":children})
}

type Cache = HashMap<String, (Instant, Value)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
pub fn list(project: &str, children: bool, refresh: bool) -> Value {
    let roots = Roots::local();
    let key = format!("{project}|{children}|{:?}|{:?}", roots.claude, roots.codex);
    let cache = CACHE.get_or_init(Mutex::default);
    if !refresh {
        if let Some((at, value)) = cache.lock().unwrap().get(&key) {
            if at.elapsed() < Duration::from_secs(15) {
                return value.clone();
            }
        }
    }
    let value = scan(&roots, project, children);
    let mut cache = cache.lock().unwrap();
    cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
    cache.insert(key, (Instant::now(), value.clone()));
    value
}
pub fn resolve(project: &str, children: bool, provider: &str, id: &str) -> Result<Value> {
    let id = uuid(id).ok_or("Invalid conversation identifier")?;
    let result = list(project, children, true);
    let found = result["items"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|v| v["id"] == id && v["provider"] == provider)
        })
        .ok_or("프로젝트에서 대화를 찾을 수 없습니다. 새로고침 후 다시 선택하세요.")?;
    if found["cwd_exists"] != true {
        return Err("대화를 실행했던 폴더가 없습니다. 원래 프로젝트 폴더를 복원하세요.".into());
    }
    Ok(found.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Roots, String) {
        let base =
            std::env::temp_dir().join(format!("wincmux-conversations-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(base.join("project/child")).unwrap();
        let roots = Roots {
            claude: base.join("claude"),
            codex: base.join("codex"),
        };
        fs::create_dir_all(roots.claude.join("projects/project")).unwrap();
        fs::create_dir_all(roots.codex.join("sessions/2026/11/17")).unwrap();
        let project = base.join("project").to_string_lossy().to_string();
        (base, roots, project)
    }
    #[test]
    fn path_scope_has_component_boundaries_and_windows_case() {
        assert!(matches_project("C:\\Project\\Child", "c:/project", true));
        assert!(!matches_project("C:\\Project-copy", "c:/project", true));
        assert!(!matches_project("C:\\Project\\Child", "c:/project", false));
        assert!(matches_project("\\\\?\\C:\\Project\\", "c:/project", false));
        assert!(uuid("12345678-1234-1234-1234-123456789abc; whoami").is_none());
    }
    #[test]
    fn scans_claude_and_codex_read_only_with_titles_dedup_scope_and_corruption() {
        let (base, roots, project) = fixture();
        let cid = uuid::Uuid::new_v4().to_string();
        let xid = uuid::Uuid::new_v4().to_string();
        let claude = roots.claude.join(format!("projects/project/{cid}.jsonl"));
        let content = format!(
            "broken\n{}\n{}\n{{partial",
            json!({"type":"user","sessionId":cid,"cwd":project,"message":{"content":[{"type":"text","text":"한글 첫 대화"}]}}),
            json!({"type":"ai-title","sessionId":cid,"aiTitle":"제목 <img>"})
        );
        fs::write(&claude, &content).unwrap();
        let codex = roots
            .codex
            .join(format!("sessions/2026/11/17/rollout-{xid}.jsonl"));
        fs::write(
            &codex,
            format!(
                "{}\n",
                json!({"type":"session_meta","payload":{"id":xid,"cwd":project,"source":"cli"}})
            ),
        )
        .unwrap();
        fs::write(
            roots.codex.join("session_index.jsonl"),
            format!("{}\n", json!({"id":xid,"thread_name":"Codex 제목"})),
        )
        .unwrap();
        let dbpath = roots.codex.join("state_5.sqlite");
        {
            let db = Connection::open(&dbpath).unwrap();
            db.execute_batch("CREATE TABLE threads(id TEXT,cwd TEXT,updated_at INTEGER,title TEXT,rollout_path TEXT,source TEXT)").unwrap();
            db.execute(
                "INSERT INTO threads VALUES(?,?,123,'DB title',?,'cli')",
                rusqlite::params![xid, project, codex.to_string_lossy()],
            )
            .unwrap();
        }
        let before = fs::read(&dbpath).unwrap();
        let result = scan(&roots, &project, false);
        let rows = result["items"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|v| v["title"] == "제목 <img>"));
        assert!(rows.iter().any(|v| v["title"] == "Codex 제목"));
        assert_eq!(fs::read(&claude).unwrap(), content.as_bytes());
        assert_eq!(fs::read(&dbpath).unwrap(), before);
        assert!(rows.iter().all(|v| v["cwd_exists"] == true));
        let sub = roots.codex.join("sessions/2026/11/17/sub.jsonl");
        fs::write(&sub,format!("{}\n",json!({"type":"session_meta","payload":{"id":uuid::Uuid::new_v4().to_string(),"cwd":project,"source":{"subagent":{}}}}))).unwrap();
        let child = roots
            .claude
            .join(format!("projects/project/{}.jsonl", uuid::Uuid::new_v4()));
        fs::write(&child,format!("{}\n",json!({"type":"user","cwd":format!("{project}/child"),"message":{"content":"child"}}))).unwrap();
        assert_eq!(
            scan(&roots, &project, false)["items"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            scan(&roots, &project, true)["items"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            scan(&roots, &format!("{project}-other"), true)["items"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn bounded_tail_recovers_title_and_metadata_after_large_rows() {
        let (base, roots, project) = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        let path = roots.claude.join(format!("projects/project/{id}.jsonl"));
        let content = format!(
            "{}\n{}\n{}\n",
            json!({"type":"user","cwd":project,"message":{"content":"first"}}),
            "x".repeat(800000),
            json!({"type":"custom-title","customTitle":"사용자 제목"})
        );
        fs::write(path, content).unwrap();
        assert_eq!(
            scan(&roots, &project, false)["items"][0]["title"],
            "사용자 제목"
        );
        fs::remove_dir_all(base).unwrap();
    }
}
