use base64::Engine;
use glob::{MatchOptions, Pattern};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use wincmux_runtime::{store::Result, terminal::hidden_command};

const MAX_ENTRIES: usize = 500;
const GIT_PAGE_SIZE: usize = 100;
const MAX_TEXT: u64 = 512 * 1024;
const MAX_IMAGE: u64 = 8 * 1024 * 1024;
const MAX_SEARCH_VISITS: usize = 100_000;
const MAX_SEARCH_RESULTS: usize = 500;
const MAX_CONTENT_FILE: u64 = 256 * 1024;
const MAX_CONTENT_TOTAL: u64 = 20 * 1024 * 1024;

fn inside(root: &Path, relative: &str) -> Result<PathBuf> {
    safe_relative(relative)?;
    let full = root.join(relative).canonicalize()?;
    if !full.starts_with(root.canonicalize()?) {
        return Err("path must stay inside the workspace".into());
    }
    Ok(full)
}

fn safe_relative(relative: &str) -> Result<()> {
    let rel = Path::new(relative);
    if rel
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("path must stay inside the workspace".into());
    }
    Ok(())
}

fn relative<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p[key]
        .as_str()
        .ok_or_else(|| format!("missing {key}").into())
}

fn list(root: &Path, p: &Value) -> Result<Value> {
    let canonical_root = root.canonicalize()?;
    let dir = inside(root, relative(p, "relativePath")?)?;
    if !dir.is_dir() {
        return Err("not a folder".into());
    }
    let mut entries = fs::read_dir(dir)?
        .take(MAX_ENTRIES + 1)
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by(|a, b| {
        let ad = a.file_type().is_ok_and(|t| t.is_dir());
        let bd = b.file_type().is_ok_and(|t| t.is_dir());
        bd.cmp(&ad).then_with(|| {
            a.file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&b.file_name().to_string_lossy().to_lowercase())
        })
    });
    let truncated = entries.len() > MAX_ENTRIES;
    let items: Vec<Value> = entries.into_iter().take(MAX_ENTRIES).map(|entry| {
        let ty = entry.file_type().ok();
        let path = entry.path();
        json!({
            "name": entry.file_name().to_string_lossy(),
            "relativePath": path.strip_prefix(&canonical_root).unwrap_or(&path).to_string_lossy().replace('\\', "/"),
            "directory": ty.as_ref().is_some_and(|t| t.is_dir()),
            "symlink": ty.as_ref().is_some_and(|t| t.is_symlink())
        })
    }).collect();
    Ok(json!({"items": items, "truncated": truncated}))
}

fn search(root: &Path, p: &Value) -> Result<Value> {
    let raw_pattern = p["pattern"].as_str().unwrap_or("").trim();
    let content_query = p["contentQuery"].as_str().unwrap_or("").trim();
    if raw_pattern.len() > 200
        || content_query.len() > 120
        || (raw_pattern.is_empty() && content_query.is_empty())
    {
        return Err("enter a file pattern or text to search (up to 200/120 characters)".into());
    }
    let input = if raw_pattern.is_empty() {
        "*".to_owned()
    } else {
        raw_pattern.replace('\\', "/")
    };
    let has_path = input.contains('/');
    let pattern = if input.chars().any(|ch| matches!(ch, '*' | '?' | '[')) {
        Pattern::new(&input)?
    } else {
        Pattern::new(&format!("*{input}*"))?
    };
    let options = MatchOptions {
        case_sensitive: false,
        require_literal_separator: has_path,
        require_literal_leading_dot: false,
    };
    let include_excluded = p["includeExcluded"] == true;
    let canonical_root = root.canonicalize()?;
    let scope_path = p["scopePath"].as_str().unwrap_or("");
    let scope = inside(root, scope_path)?;
    if !scope.is_dir() {
        return Err("search scope is not a folder".into());
    }
    let mut stack = vec![scope.clone()];
    let mut visited = 0;
    let mut content_bytes = 0;
    let mut skipped_large = 0;
    let mut items = Vec::new();
    let mut truncated = false;
    let started = Instant::now();
    while let Some(directory) = stack.pop() {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for result in entries {
            if visited >= MAX_SEARCH_VISITS || started.elapsed() >= Duration::from_secs(5) {
                truncated = true;
                break;
            }
            visited += 1;
            let entry = match result {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let ty = match entry.file_type() {
                Ok(ty) => ty,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if ty.is_dir() {
                if !include_excluded
                    && [
                        ".git",
                        "node_modules",
                        "target",
                        ".venv",
                        "venv",
                        "dist",
                        "build",
                    ]
                    .contains(&name.to_ascii_lowercase().as_str())
                {
                    continue;
                }
                stack.push(entry.path());
            } else if ty.is_file() {
                let path = entry.path();
                let relative_path = path
                    .strip_prefix(&canonical_root)?
                    .to_string_lossy()
                    .replace('\\', "/");
                let scoped_path = path
                    .strip_prefix(&scope)?
                    .to_string_lossy()
                    .replace('\\', "/");
                let candidate = if has_path {
                    scoped_path.as_str()
                } else {
                    name.as_str()
                };
                if pattern.matches_with(candidate, options) {
                    let mut match_line = None;
                    let mut snippet = None;
                    if !content_query.is_empty() {
                        let size = match entry.metadata() {
                            Ok(meta) => meta.len(),
                            Err(_) => continue,
                        };
                        if size > MAX_CONTENT_FILE {
                            skipped_large += 1;
                            continue;
                        }
                        if content_bytes + size > MAX_CONTENT_TOTAL {
                            truncated = true;
                            break;
                        }
                        content_bytes += size;
                        let mut bytes = Vec::new();
                        if fs::File::open(&path)
                            .and_then(|file| {
                                file.take(MAX_CONTENT_FILE + 1).read_to_end(&mut bytes)
                            })
                            .is_err()
                            || bytes.contains(&0)
                        {
                            continue;
                        }
                        let Ok(text) = String::from_utf8(bytes) else {
                            continue;
                        };
                        let needle = content_query.to_lowercase();
                        if let Some((index, line)) = text
                            .lines()
                            .enumerate()
                            .find(|(_, line)| line.to_lowercase().contains(&needle))
                        {
                            match_line = Some(index + 1);
                            snippet = Some(line.trim().chars().take(180).collect::<String>());
                        } else {
                            continue;
                        }
                    }
                    items.push(json!({"name":name,"relativePath":relative_path,"directory":false,"line":match_line,"snippet":snippet}));
                    if items.len() >= MAX_SEARCH_RESULTS {
                        truncated = true;
                        break;
                    }
                }
            }
        }
        if truncated {
            break;
        }
    }
    items.sort_by(|a, b| a["relativePath"].as_str().cmp(&b["relativePath"].as_str()));
    Ok(json!({"items":items,"scanned":visited,"truncated":truncated,"skippedLarge":skipped_large}))
}

fn preview(root: &Path, p: &Value) -> Result<Value> {
    let file = inside(root, relative(p, "relativePath")?)?;
    if !file.is_file() {
        return Err("not a file".into());
    }
    let size = file.metadata()?.len();
    let ext = file
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    };
    if let Some(mime) = mime {
        if size > MAX_IMAGE {
            return Ok(json!({"kind":"large", "size":size}));
        }
        let bytes = fs::read(file)?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(
            json!({"kind":"image", "size":size, "dataUrl":format!("data:{mime};base64,{encoded}")}),
        );
    }
    if size > MAX_TEXT {
        return Ok(json!({"kind":"large", "size":size}));
    }
    let mut bytes = Vec::new();
    fs::File::open(file)?
        .take(MAX_TEXT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.contains(&0) {
        return Ok(json!({"kind":"binary", "size":size}));
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(json!({"kind":"text", "size":size, "text":text})),
        Err(_) => Ok(json!({"kind":"binary", "size":size})),
    }
}

fn copy(root: &Path, p: &Value) -> Result<Value> {
    let source = inside(root, relative(p, "sourcePath")?)?;
    let destination_dir = inside(root, relative(p, "destinationPath")?)?;
    if !source.is_file() || !destination_dir.is_dir() {
        return Err("select a file and a target folder".into());
    }
    let filename = source
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("invalid file name")?;
    let stem = source
        .file_stem()
        .and_then(|v| v.to_str())
        .ok_or("invalid file name")?;
    let extension = source
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| format!(".{v}"))
        .unwrap_or_default();
    let mut target = destination_dir.join(filename);
    if target.exists() {
        for index in 1..=9999 {
            let suffix = if index == 1 {
                " (copy)".to_owned()
            } else {
                format!(" (copy {index})")
            };
            target = destination_dir.join(format!("{stem}{suffix}{extension}"));
            if !target.exists() {
                break;
            }
        }
    }
    if target.exists() {
        return Err("no available copy name".into());
    }
    // create_new prevents replacing an existing file if another process creates it meanwhile.
    let mut input = fs::File::open(source)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)?;
    if let Err(error) = std::io::copy(&mut input, &mut output) {
        drop(output);
        let _ = fs::remove_file(&target);
        return Err(error.into());
    }
    Ok(
        json!({"relativePath":target.strip_prefix(root.canonicalize()?)?.to_string_lossy().replace('\\', "/")}),
    )
}

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output> {
    let output = hidden_command("git")
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr)
            .trim()
            .to_owned()
            .into());
    }
    Ok(output)
}

fn git_status(root: &Path, p: &Value) -> Result<Value> {
    let page = p["page"].as_u64().unwrap_or(0);
    if page > 999 {
        return Err("Git status page is out of range".into());
    }
    let offset = page as usize * GIT_PAGE_SIZE;
    let mut child = hidden_command("git")
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut output = BufReader::new(child.stdout.take().ok_or("missing Git output")?);
    let mut items = Vec::new();
    let mut field = Vec::new();
    let mut seen = 0;
    let mut has_more = false;
    loop {
        field.clear();
        if output.read_until(0, &mut field)? == 0 {
            break;
        }
        field.pop();
        if field.len() < 4 {
            continue;
        }
        let status = String::from_utf8_lossy(&field[..2]).to_string();
        let path = String::from_utf8_lossy(&field[3..]).to_string();
        if status.contains('R') || status.contains('C') {
            let mut original_path = Vec::new();
            output.read_until(0, &mut original_path)?;
        }
        let mut record = Vec::with_capacity(2);
        if status == "??" {
            record.push(json!({"status":"?", "section":"untracked", "relativePath":path}));
        } else {
            let chars: Vec<char> = status.chars().collect();
            if chars[0] != ' ' {
                record.push(
                    json!({"status":chars[0].to_string(), "section":"staged", "relativePath":path}),
                );
            }
            if chars[1] != ' ' {
                record.push(json!({"status":chars[1].to_string(), "section":"unstaged", "relativePath":path}));
            }
        }
        for item in record {
            if seen >= offset + GIT_PAGE_SIZE {
                has_more = true;
                break;
            }
            if seen >= offset {
                items.push(item);
            }
            seen += 1;
        }
        if has_more {
            break;
        }
    }
    drop(output);
    if has_more {
        let _ = child.kill();
    }
    if !child.wait()?.success() && !has_more {
        return Err("Git status failed".into());
    }
    let branch = git(root, &["branch", "--show-current"])
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .unwrap_or_default();
    Ok(json!({"branch":branch, "items":items, "page":page, "hasMore":has_more}))
}

fn git_diff(root: &Path, p: &Value) -> Result<Value> {
    let rel = relative(p, "relativePath")?;
    safe_relative(rel)?;
    if root.join(rel).exists() {
        inside(root, rel)?;
    }
    let section = p["section"].as_str().unwrap_or("unstaged");
    if !matches!(section, "staged" | "unstaged") {
        return Err("invalid Git diff section".into());
    }
    {
        let mut command = hidden_command("git");
        command
            .arg("--literal-pathspecs")
            .arg("-C")
            .arg(root)
            .arg("diff");
        if section == "staged" {
            command.arg("--cached");
        }
        let mut child = command
            .args(["--no-ext-diff", "--", rel])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .ok_or("missing Git output")?
            .take(MAX_TEXT + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_TEXT as usize {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(json!({"kind":"large"}));
        }
        if child.wait()?.success() {
            return Ok(json!({"kind":"text", "text":String::from_utf8_lossy(&bytes)}));
        }
    }
    Err("Git diff failed".into())
}

pub fn action(name: &str, root: &Path, p: &Value) -> Result<Value> {
    match name {
        "viewer-list" => list(root, p),
        "viewer-search" => search(root, p),
        "viewer-preview" => preview(root, p),
        "viewer-copy" => copy(root, p),
        "viewer-git-status" => git_status(root, p),
        "viewer-git-diff" => git_diff(root, p),
        _ => Err("unsupported viewer action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_status_pages_large_change_lists() -> Result<()> {
        let root = std::env::temp_dir().join(format!("wincmux-git-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root)?;
        git(&root, &["init", "--quiet"])?;
        for index in 0..MAX_ENTRIES {
            fs::write(root.join(format!("file-{index:04}.txt")), "")?;
        }
        let first = git_status(&root, &json!({"page":0}))?;
        assert_eq!(first["items"].as_array().unwrap().len(), GIT_PAGE_SIZE);
        assert_eq!(first["hasMore"], true);
        assert_eq!(first["items"][0]["relativePath"], "file-0000.txt");
        let last = git_status(&root, &json!({"page":4}))?;
        assert_eq!(last["items"].as_array().unwrap().len(), GIT_PAGE_SIZE);
        assert_eq!(last["hasMore"], false);

        fs::write(root.join("file-extra.txt"), "")?;
        let large = git_status(&root, &json!({"page":4}))?;
        assert_eq!(large["hasMore"], true);
        let next = git_status(&root, &json!({"page":5}))?;
        assert_eq!(next["items"].as_array().unwrap().len(), 1);
        assert_eq!(next["items"][0]["relativePath"], "file-extra.txt");
        assert_eq!(next["hasMore"], false);
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn rejects_parent_and_absolute_paths() {
        let root = std::env::temp_dir();
        assert!(inside(&root, "../outside").is_err());
        assert!(inside(&root, "C:/Windows").is_err());
        assert!(inside(&root, "/outside").is_err());
    }

    #[test]
    fn copies_to_a_new_name_without_replacing_the_original() -> Result<()> {
        let root =
            std::env::temp_dir().join(format!("wincmux-viewer-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root)?;
        fs::write(root.join("a.txt"), "first")?;
        let result = copy(&root, &json!({"sourcePath":"a.txt", "destinationPath":""}))?;
        assert_eq!(result["relativePath"], "a (copy).txt");
        assert_eq!(fs::read_to_string(root.join("a.txt"))?, "first");
        assert_eq!(fs::read_to_string(root.join("a (copy).txt"))?, "first");
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn searches_nested_paths_and_skips_generated_folders_by_default() -> Result<()> {
        let root =
            std::env::temp_dir().join(format!("wincmux-search-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("src"))?;
        fs::create_dir_all(root.join("target"))?;
        fs::write(root.join("src/test_alpha.py"), "alpha")?;
        fs::write(root.join("src/other.txt"), "other")?;
        fs::write(root.join("target/test_hidden.py"), "hidden")?;
        let found = search(&root, &json!({"pattern":"**/test_*.py"}))?;
        assert_eq!(found["items"].as_array().unwrap().len(), 1);
        assert_eq!(found["items"][0]["relativePath"], "src/test_alpha.py");
        let all = search(
            &root,
            &json!({"pattern":"test_*.py", "includeExcluded":true}),
        )?;
        assert_eq!(all["items"].as_array().unwrap().len(), 2);
        let scoped = search(&root, &json!({"scopePath":"src", "contentQuery":"alpha"}))?;
        assert_eq!(scoped["items"].as_array().unwrap().len(), 1);
        assert_eq!(scoped["items"][0]["line"], 1);
        assert_eq!(scoped["items"][0]["relativePath"], "src/test_alpha.py");
        assert!(search(&root, &json!({"scopePath":"../", "contentQuery":"alpha"})).is_err());
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
