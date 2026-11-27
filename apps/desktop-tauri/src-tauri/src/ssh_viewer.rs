use crate::{
    ssh_terminal::{list_entries, quote, WorkspaceHost},
    ssh_window::SshWindow,
};
use base64::Engine;
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const PREVIEW: usize = 256 * 1024;
const MEDIA_PREVIEW: usize = 8 * 1024 * 1024;
const MAX_CONFIGURED_PREVIEW: usize = 64 * 1024 * 1024;
const PAGE: usize = 150;

async fn file_exec(
    state: &SshWindow,
    host: &WorkspaceHost,
    root: &str,
    container: Option<&str>,
    script: &str,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let _permit = match host {
        WorkspaceHost::Ssh(_) => Some(state.file_gate.acquire().await.map_err(|e| e.to_string())?),
        WorkspaceHost::Docker(_) => None,
    };
    if !state.host().await?.same_connection(host) {
        return Err("작업공간 연결이 변경되었습니다. 파일 목록을 다시 불러오세요.".into());
    }
    host.exec(root, container, script, limit).await
}

pub async fn action(state: &SshWindow, action: &str, params: &Value) -> Result<Value, String> {
    let (host, project) = state.project(params["source_terminal_id"].as_str()).await?;
    let root = &project.path;
    let container = project.container.as_deref();
    let item = params["relative"].as_str().unwrap_or("");
    let media_limit = params["maxPreviewBytes"]
        .as_u64()
        .and_then(|bytes| usize::try_from(bytes).ok())
        .unwrap_or(MEDIA_PREVIEW)
        .clamp(MEDIA_PREVIEW, MAX_CONFIGURED_PREVIEW);
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
    let extensions = selected_extensions(params)?;
    let extension_case = extensions
        .iter()
        .map(|ext| {
            format!(
                "*.{}",
                ext.chars()
                    .map(|ch| format!("[{}{}]", ch.to_ascii_lowercase(), ch.to_ascii_uppercase()))
                    .collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("|");
    let extension_find = if extensions.is_empty() {
        String::new()
    } else {
        format!(
            " \\( {} \\)",
            extensions
                .iter()
                .map(|ext| format!("-iname {}", quote(&format!("*.{ext}"))))
                .collect::<Vec<_>>()
                .join(" -o ")
        )
    };
    let safe_path = format!("base=$(pwd -P) && item=$(readlink -f -- {}) && case \"$item\" in \"$base\"|\"${{base%/}}\"/*) ;; *) exit 19;; esac && ", quote(if item.is_empty() { "." } else { item }));
    let mut rule_prune = String::new();
    if matches!(action, "search" | "search-names") {
        let rules = crate::workspace_viewer::folder_rules(params)?;
        if crate::workspace_viewer::excluded_scope(item, &rules) {
            return Ok(json!({"items":[], "truncated":false}));
        }
        let literal = |s: &str| {
            quote(
                &s.replace('\\', "\\\\")
                    .replace('*', "\\*")
                    .replace('?', "\\?")
                    .replace('[', "\\["),
            )
        };
        let mut tests = Vec::new();
        for rule in rules {
            if rule.kind == "name" {
                tests.push(format!("\\( -type d -iname {} \\)", literal(&rule.value)));
            } else if let Some(path) = if item.is_empty() {
                Some(rule.value.as_str())
            } else {
                rule.value
                    .strip_prefix(item)
                    .and_then(|rest| rest.strip_prefix('/'))
            } {
                tests.push(format!("-path {}", literal(&format!("./{path}"))));
            }
        }
        if !tests.is_empty() {
            rule_prune = format!("\\( {} \\) -prune -o ", tests.join(" -o "));
        }
    }
    let script = match action {
        "copy-file" => {
            let destination = params["destination"].as_str().ok_or("대상 폴더를 선택하세요.")?;
            if item.is_empty() || item.chars().any(char::is_control) || destination.len() > 4096
                || destination.starts_with('/') || destination.chars().any(char::is_control)
                || destination.split('/').any(|part| matches!(part, "." | ".."))
            {
                return Err("원격 폴더 안의 경로를 선택하세요.".into());
            }
            let dest = quote(if destination.is_empty() { "." } else { destination });
            format!(r#"{safe_path} test -f "$item" && dest=$(readlink -f -- {dest}) && test -d "$dest" && case "$dest" in "$base"|"${{base%/}}"/*) ;; *) exit 19;; esac || exit 19
name=${{item##*/}}
tmp=$(mktemp "$dest/.wincmux-copy.XXXXXXXX") || exit 1
trap 'rm -f -- "$tmp"' EXIT
cp -p -- "$item" "$tmp" || exit 1
stem=${{name%.*}}; ext=${{name#"$stem"}}
if [ -z "$stem" ]; then stem=$name; ext=''; fi
out=$name; i=1
while ! ln -T -- "$tmp" "$dest/$out" 2>/dev/null; do
  [ -e "$dest/$out" ] || [ -L "$dest/$out" ] || exit 1
  [ "$i" -le 9999 ] || exit 1
  if [ "$i" -eq 1 ]; then out="$stem (copy)$ext"; else out="$stem (copy $i)$ext"; fi
  i=$((i+1))
done
printf '%s' "$out""#)
        }
        "agent-skills" => {
            let provider = params["provider"].as_str().ok_or("에이전트를 선택하세요.")?;
            let roots = match provider {
                "claude" => ".claude/skills .claude/commands",
                "codex" => ".agents/skills .codex/skills",
                _ => return Err("Claude Code 또는 Codex를 선택하세요.".into()),
            };
            format!("for dir in {roots}; do [ -d \"$dir\" ] || continue; find \"$dir\" -type f \\( -name SKILL.md -o -name '*.md' \\) -exec sh -c 'for file do description=$(sed -n \"2,40p\" \"$file\" | sed -n \"s/^description:[[:space:]]*//p\" | head -n 1); printf \"%s\\\\0%s\\\\0\" \"$file\" \"$description\"; done' sh {{}} +; done")
        }
        "files" => format!("{safe_path} cd \"$item\" && ( {} )", list_entries(false, first, last, if extension_case.is_empty() { None } else { Some(&extension_case) })),
        "preview" => format!("{safe_path} test -f \"$item\" && head -c {} -- \"$item\"", if media_mime(item).is_some() || is_html(item) { media_limit + 1 } else { PREVIEW + 1 }),
        "search" => {
            let query = params["query"].as_str().unwrap_or("");
            if query.trim().is_empty() || query.len() > 300 || query.chars().any(char::is_control) {
                return Err("한 줄 검색어를 1~300자로 입력하세요.".into());
            }
            let (dirs, files) = search_excludes(params["exclude"].as_str().unwrap_or(""), params["includeExcluded"] == true)?;
            let dir_checks = dirs.join(" -o ");
            let file_checks = if files.is_empty() { String::new() } else { format!(" \\( {} \\)", files.join(" -a ")) };
            let name_check = name_filter(params["pattern"].as_str().unwrap_or(""))?;
            format!("{safe_path} cd \"$item\" && find . {rule_prune}-type d \\( {dir_checks} \\) -prune -o -type f{file_checks}{extension_find}{name_check} -size -257k -exec grep -FIHinZ -m 6 -- {} {{}} + | cut -c1-1600 | head -n 151", quote(query))
        }
        "search-names" => {
            let query = params["query"].as_str().unwrap_or("").trim();
            if query.is_empty() {
                return Err("파일 이름 검색어를 1~200자로 입력하세요.".into());
            }
            let (dirs, files) = search_excludes(params["exclude"].as_str().unwrap_or(""), params["includeExcluded"] == true)?;
            let file_checks = if files.is_empty() { String::new() } else { format!(" \\( {} \\)", files.join(" -a ")) };
            let name_check = name_filter(query)?;
            format!("{safe_path} cd \"$item\" && find . {rule_prune}-type d \\( {} \\) -prune -o -type f{file_checks}{extension_find}{name_check} -print0 | head -c {}", dirs.join(" -o "), PREVIEW)
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
    let mut bytes = file_exec(
        state,
        &host,
        root,
        container,
        &script,
        if action == "preview" && (media_mime(item).is_some() || is_html(item)) {
            media_limit + 4096
        } else {
            PREVIEW + 4096
        },
    )
    .await?;
    match action {
        "copy-file" => Ok(json!({"name":String::from_utf8_lossy(&bytes)})),
        "agent-skills" => {
            let provider = params["provider"].as_str().unwrap_or("");
            let items: Vec<_> = bytes.split(|&byte| byte == 0).collect::<Vec<_>>().chunks_exact(2)
                .take(100)
                .filter_map(|pair| {
                    let path = std::str::from_utf8(pair[0]).ok()?.trim_start_matches("./");
                    let name = if provider == "claude" && path.starts_with(".claude/commands/") && path.ends_with(".md") {
                        path.rsplit('/').next()?.strip_suffix(".md")?
                    } else if path.ends_with("/SKILL.md") {
                        path.rsplit('/').nth(1)?
                    } else { return None };
                    if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') { return None; }
                    let description = String::from_utf8_lossy(pair[1]).trim().trim_matches(['"', '\'']).to_owned();
                    Some(json!({"command":format!("{}{name}", if provider == "claude" {"/"} else {"$"}),"description":description,"path":path}))
                }).collect();
            Ok(json!({"items":items,"path":root}))
        }
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
        "search" => Ok(search_results(&bytes, item)),
        "search-names" => {
            let complete_len = bytes
                .iter()
                .rposition(|&byte| byte == 0)
                .map_or(0, |index| index + 1);
            let items: Vec<_> = bytes[..complete_len].split(|&byte| byte == 0).filter_map(|entry| {
                let path = std::str::from_utf8(entry).ok()?.strip_prefix("./")?;
                Some(json!({"relative": if item.is_empty() { path.to_owned() } else { format!("{item}/{path}") }}))
            }).take(PAGE + 1).collect();
            let truncated = bytes.len() >= PREVIEW || items.len() > PAGE;
            Ok(
                json!({"items":items.into_iter().take(PAGE).collect::<Vec<_>>(),"truncated":truncated}),
            )
        }
        _ => {
            if action == "preview" {
                if let Some(mime) = media_mime(item) {
                    if bytes.len() > media_limit {
                        return Ok(json!({"kind":"large"}));
                    }
                    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                    return Ok(
                        json!({"kind":if mime == "application/pdf" {"pdf"} else {"image"},"dataUrl":format!("data:{mime};base64,{encoded}")}),
                    );
                }
            }
            let html = action == "preview" && is_html(item);
            let limit = if html { media_limit } else { PREVIEW };
            let truncated = bytes.len() > limit;
            if html && truncated {
                return Ok(json!({"kind":"large"}));
            }
            bytes.truncate(limit);
            let is_binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
            let kind = if html { "html" } else { "text" };
            Ok(
                json!({"kind":kind,"text":if is_binary { String::new() } else { String::from_utf8_lossy(&bytes).into_owned() },"binary":is_binary,"truncated":truncated}),
            )
        }
    }
}

fn is_html(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("html" | "htm")
    )
}

fn search_results(bytes: &[u8], folder: &str) -> Value {
    let remaining = String::from_utf8_lossy(bytes);
    let mut items = vec![];
    let mut rows = remaining.as_ref();
    while let Some((path, result)) = rows.split_once('\0') {
        let Some((matched, rest)) = result.split_once('\n') else {
            break;
        };
        if let Some((number, text)) = matched.split_once(':') {
            if let (Some(relative), Ok(line)) = (path.strip_prefix("./"), number.parse::<usize>()) {
                let relative = if folder.is_empty() {
                    relative.to_owned()
                } else {
                    format!("{folder}/{relative}")
                };
                items.push(json!({"relative":relative,"line":line,"text":text}));
            }
        }
        rows = rest;
    }
    let truncated = items.len() > PAGE;
    items.truncate(PAGE);
    json!({"items":items,"truncated":truncated})
}

fn selected_extensions(params: &Value) -> Result<Vec<String>, String> {
    let Some(values) = params["extensions"].as_array() else {
        return Ok(Vec::new());
    };
    if values.len() > 64 {
        return Err("확장자는 최대 64개까지 선택하세요.".into());
    }
    values
        .iter()
        .map(|value| {
            let ext = value.as_str().ok_or("올바른 확장자를 선택하세요.")?;
            if ext.is_empty()
                || ext.len() > 12
                || !ext.bytes().all(|byte| byte.is_ascii_alphanumeric())
            {
                return Err("올바른 확장자를 선택하세요.".into());
            }
            Ok(ext.to_ascii_lowercase())
        })
        .collect()
}

fn name_filter(raw: &str) -> Result<String, String> {
    let value = raw.trim().replace('\\', "/");
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.len() > 200
        || value.chars().any(char::is_control)
        || value.starts_with('/')
        || value.split('/').any(|part| matches!(part, "." | ".."))
    {
        return Err("파일 이름 또는 상대 경로 패턴을 200자 이하로 입력하세요.".into());
    }
    let pattern = if value.chars().any(|ch| matches!(ch, '*' | '?' | '[')) {
        value
    } else {
        format!("*{value}*")
    };
    if pattern.contains('/') {
        Ok(format!(" -ipath {}", quote(&format!("./{pattern}"))))
    } else {
        Ok(format!(" -iname {}", quote(&pattern)))
    }
}

fn search_excludes(
    raw: &str,
    include_excluded: bool,
) -> Result<(Vec<String>, Vec<String>), String> {
    if raw.len() > 1200 {
        return Err("제외 패턴은 1200자 이하로 입력하세요.".into());
    }
    let defaults: &[&str] = if include_excluded {
        &[]
    } else {
        crate::workspace_viewer::DEFAULT_SEARCH_EXCLUDED_DIRS
    };
    let mut dirs: Vec<_> = defaults
        .iter()
        .map(|name| format!("-iname {}", quote(name)))
        .collect();
    if dirs.is_empty() {
        dirs.push("-name '__wincmux_never__'".into());
    }
    let mut files = Vec::new();
    let mut user_count = 0;
    for entry in raw
        .split([',', '\n'])
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if user_count >= 20 || entry.len() > 120 || entry.chars().any(char::is_control) {
            return Err("제외 패턴은 최대 20개, 항목당 120자까지 입력하세요.".into());
        }
        user_count += 1;
        let folder = entry.ends_with('/') || entry.ends_with("/**");
        let pattern = if entry.ends_with("/**") {
            entry.trim_end_matches("/**")
        } else {
            entry.trim_end_matches('/')
        };
        if pattern.is_empty()
            || pattern.starts_with('/')
            || pattern.split('/').any(|part| matches!(part, "." | ".."))
        {
            return Err("현재 폴더를 기준으로 한 제외 패턴을 입력하세요.".into());
        }
        let check = if entry.ends_with("/**") || pattern.contains('/') {
            format!("-path {}", quote(&format!("./{pattern}")))
        } else {
            format!("-name {}", quote(pattern))
        };
        if folder {
            dirs.push(check);
        } else {
            files.push(format!("! {check}"));
        }
    }
    Ok((dirs, files))
}

fn media_mime(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "pdf" => Some("application/pdf"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_html, media_mime, name_filter, search_excludes, search_results, selected_extensions,
    };

    #[test]
    fn media_types_are_limited_to_viewable_formats() {
        assert_eq!(media_mime("photo.PNG"), Some("image/png"));
        assert_eq!(media_mime("report.pdf"), Some("application/pdf"));
        assert_eq!(media_mime("report.docx"), None);
    }

    #[test]
    fn search_results_keep_the_folder_scope() {
        let output = b"./index.html\02:match\n";
        assert_eq!(
            search_results(output, "outputs/compare")["items"][0]["relative"],
            "outputs/compare/index.html"
        );
        assert_eq!(
            search_results(output, "")["items"][0]["relative"],
            "index.html"
        );
        assert_eq!(search_results(output, "")["items"][0]["line"], 2);
        assert_eq!(search_results(output, "")["items"][0]["text"], "match");
    }

    #[test]
    fn name_and_extension_filters_validate_remote_search() {
        assert_eq!(name_filter("report").unwrap(), " -iname '*report*'");
        assert_eq!(name_filter("src/*.py").unwrap(), " -ipath './src/*.py'");
        assert!(name_filter("../secret").is_err());
        assert_eq!(
            selected_extensions(&serde_json::json!({"extensions":["MD","py"]})).unwrap(),
            ["md", "py"]
        );
        assert!(selected_extensions(&serde_json::json!({"extensions":["../sh"]})).is_err());
    }

    #[test]
    fn exclusion_filters_separate_folders_and_files() {
        let (folders, files) =
            search_excludes("cache/, reports/**, *.min.js, assets/*.map", false).unwrap();
        assert!(folders.iter().any(|value| value == "-name 'cache'"));
        assert!(folders.iter().any(|value| value == "-iname 'node_modules'"));
        let (included, _) = search_excludes("cache/", true).unwrap();
        assert!(!included.iter().any(|value| value.contains("node_modules")));
        assert!(included.iter().any(|value| value == "-name 'cache'"));
        assert!(folders.iter().any(|value| value == "-path './reports'"));
        assert!(files.iter().any(|value| value == "! -name '*.min.js'"));
        assert!(files
            .iter()
            .any(|value| value == "! -path './assets/*.map'"));
        assert!(search_excludes("../secret/", false).is_err());
        assert!(is_html("index.HTML"));
    }
}

pub async fn download(state: &SshWindow, params: &Value, app: &AppHandle) -> Result<Value, String> {
    let (host, project) = state.project(params["source_terminal_id"].as_str()).await?;
    let item = params["relative"].as_str().ok_or("파일을 선택하세요.")?;
    if item.is_empty()
        || item.len() > 4096
        || item.contains('\0')
        || item.starts_with('/')
        || item.split('/').any(|part| matches!(part, "." | ".."))
    {
        return Err("원격 폴더 안의 파일을 선택하세요.".into());
    }
    let name = Path::new(item)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("파일 이름을 확인하세요.")?
        .to_owned();
    let safe = format!("base=$(pwd -P) && item=$(readlink -f -- {}) && case \"$item\" in \"$base\"|\"${{base%/}}\"/*) ;; *) exit 19;; esac && test -f \"$item\" && ", quote(item));
    let container = project.container.as_deref();
    let size_output = file_exec(
        state,
        &host,
        &project.path,
        container,
        &format!("{safe}wc -c < \"$item\""),
        64,
    )
    .await?;
    let size: u64 = String::from_utf8(size_output)
        .map_err(|e| e.to_string())?
        .trim()
        .parse()
        .map_err(|_| "파일 크기를 확인할 수 없습니다.")?;
    let app = app.clone();
    let destination = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(&name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(destination) = destination else {
        return Ok(json!({"cancelled":true}));
    };
    let destination = destination.into_path().map_err(|e| e.to_string())?;
    let temporary = destination.with_extension(format!("wincmux-{}.part", uuid::Uuid::new_v4()));
    let result = async {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let mut received = 0_u64;
        for index in 0..size.div_ceil(1024 * 1024) {
            let script =
                format!("{safe}dd if=\"$item\" bs=1048576 skip={index} count=1 2>/dev/null");
            let chunk = file_exec(
                state,
                &host,
                &project.path,
                container,
                &script,
                1024 * 1024 + 4096,
            )
            .await?;
            if chunk.is_empty() {
                return Err("파일 전송 중 원본이 변경되었습니다.".into());
            }
            output.write_all(&chunk).map_err(|e| e.to_string())?;
            received += chunk.len() as u64;
        }
        if received != size {
            return Err("파일 전송 중 원본 크기가 변경되었습니다.".into());
        }
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        fs::copy(&temporary, &destination).map_err(|e| e.to_string())?;
        Ok::<_, String>(json!({"path":destination,"size":size}))
    }
    .await;
    let _ = fs::remove_file(&temporary);
    result
}
