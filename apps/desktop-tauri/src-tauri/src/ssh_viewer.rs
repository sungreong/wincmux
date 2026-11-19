use crate::{
    ssh_terminal::{list_entries, quote},
    ssh_window::SshWindow,
};
use serde_json::{json, Value};

const PREVIEW: usize = 256 * 1024;
const PAGE: usize = 150;

pub async fn action(state: &SshWindow, action: &str, params: &Value) -> Result<Value, String> {
    let (host, project) = state.project(params["source_terminal_id"].as_str()).await?;
    let root = &project.path;
    let container = project.container.as_deref();
    let item = params["relative"].as_str().unwrap_or("");
    if item.len() > 4096
        || item.contains('\0')
        || item.split('/').any(|path| matches!(path, "." | ".."))
        || item.starts_with('/')
    {
        return Err("원격 폴더 안의 경로를 선택하세요.".into());
    }
    let page = params["page"].as_u64().unwrap_or(0).min(500) as usize;
    let first = page * PAGE + 1;
    let last = first + PAGE;
    let safe_path = format!("base=$(pwd -P) && item=$(readlink -f -- {}) && case \"$item\" in \"$base\"|\"${{base%/}}\"/*) ;; *) exit 19;; esac && ", quote(if item.is_empty() { "." } else { item }));
    let script = match action {
        "files" => format!("{safe_path} cd \"$item\" && ( {} )", list_entries(false, first, last)),
        "preview" => format!("{safe_path} test -f \"$item\" && head -c {} -- \"$item\"", PREVIEW + 1),
        "search" => {
            let query = params["query"].as_str().unwrap_or("");
            if query.trim().is_empty() || query.len() > 300 || query.chars().any(char::is_control) {
                return Err("한 줄 검색어를 1~300자로 입력하세요.".into());
            }
            format!("find . -type d \\( -name .git -o -name node_modules -o -name .venv -o -name target \\) -prune -o -type f -size -1024k -exec grep -FIHinZ -m 6 -- {} {{}} + | cut -c1-1600 | head -n 151", quote(query))
        }
        "git-status" => format!(
            "git rev-parse --show-prefix && git -c core.quotepath=false status --porcelain=v1 -z --no-renames --untracked-files=all -- . | sed -z -n '{first},{last}p;{last}q'"
        ),
        "git-diff" => {
            if item.is_empty() { return Err("변경 파일을 선택하세요.".into()); }
            let staged = params["staged"] == true;
            let untracked = params["untracked"] == true;
            if untracked {
                format!("{safe_path} test -f \"$item\" && git --no-pager diff --no-color --no-ext-diff --no-textconv --no-index -- /dev/null \"$item\" | head -c {}", PREVIEW + 1)
            } else {
                format!("git --literal-pathspecs --no-pager diff --no-color --no-ext-diff --no-textconv {} -- {} | head -c {}", if staged { "--cached" } else { "" }, quote(item), PREVIEW + 1)
            }
        }
        _ => return Err("지원하지 않는 원격 작업입니다.".into()),
    };
    let mut bytes = host.exec(root, container, &script, PREVIEW + 4096).await?;
    match action {
        "files" => {
            let mut items = bytes
                .split(|&byte| byte == 0)
                .filter(|entry| entry.len() > 1)
                .peekable();
            let page: Vec<_> = items
                .by_ref()
                .take(PAGE)
                .filter_map(|entry| {
                    let name = std::str::from_utf8(&entry[1..]).ok()?;
                    let relative = if item.is_empty() {
                        name.into()
                    } else {
                        format!("{item}/{name}")
                    };
                    let kind = match entry[0] {
                        b'd' => "directory",
                        b'f' => "file",
                        b'l' => "link",
                        _ => "special",
                    };
                    Some(json!({"name":name,"relative":relative,"kind":kind}))
                })
                .collect();
            Ok(json!({"items":page,"hasMore":items.peek().is_some()}))
        }
        "git-status" => {
            let end = bytes
                .iter()
                .position(|&byte| byte == b'\n')
                .ok_or("Git 저장소를 읽을 수 없습니다.")?;
            let prefix = String::from_utf8_lossy(&bytes[..end]);
            let mut entries = bytes[end + 1..]
                .split(|&byte| byte == 0)
                .filter(|entry| entry.len() >= 4)
                .peekable();
            let items: Vec<_> = entries
                .by_ref()
                .take(PAGE)
                .filter_map(|entry| {
                    let path = std::str::from_utf8(&entry[3..])
                        .ok()?
                        .strip_prefix(prefix.as_ref())?;
                    Some(json!({"status":String::from_utf8_lossy(&entry[..2]),"relative":path}))
                })
                .collect();
            Ok(json!({"items":items,"hasMore":entries.peek().is_some()}))
        }
        "search" => {
            let remaining = String::from_utf8_lossy(&bytes);
            let mut items = vec![];
            let mut rows = remaining.as_ref();
            while let Some((path, result)) = rows.split_once('\0') {
                let Some((matched, rest)) = result.split_once('\n') else {
                    break;
                };
                if let Some((number, text)) = matched.split_once(':') {
                    if let (Some(relative), Ok(line)) =
                        (path.strip_prefix("./"), number.parse::<usize>())
                    {
                        items.push(json!({"relative":relative,"line":line,"text":text}));
                    }
                }
                rows = rest;
            }
            let truncated = items.len() > PAGE;
            items.truncate(PAGE);
            Ok(json!({"items":items,"truncated":truncated}))
        }
        _ => {
            let truncated = bytes.len() > PREVIEW;
            bytes.truncate(PREVIEW);
            let is_binary = bytes.contains(&0);
            Ok(
                json!({"text":if is_binary { String::new() } else { String::from_utf8_lossy(&bytes).into_owned() },"binary":is_binary,"truncated":truncated}),
            )
        }
    }
}
