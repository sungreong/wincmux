use crate::{
    store::{id, text, Result},
    terminal::hidden_command,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    time::SystemTime,
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const BASE: &str = ".wincmux/input-assets";
const INDEX: &str = ".wincmux/input-assets/index.json";
const TEXT_LIMIT: u64 = 2 * 1024 * 1024;
pub const IMAGE_LIMIT: u64 = 20 * 1024 * 1024;
const PREVIEW_LIMIT: u64 = 256 * 1024;
const AGENT_WRITE_LIMIT: u64 = 512 * 1024;
const INSTRUCTIONS: &[&str] = &[
    "CLAUDE.md",
    ".claude/CLAUDE.md",
    "CLAUDE.local.md",
    "AGENTS.md",
    "AGENTS.override.md",
    "GEMINI.md",
    ".cursorrules",
];
const SETTINGS: &[&str] = &[
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".gemini/settings.json",
    "opencode.json",
    "opencode.jsonc",
    ".mcp.json",
];
const PROVIDERS: &[(&str, &str)] = &[
    (".claude/", "claude"),
    (".agents/", "codex"),
    (".gemini/", "gemini"),
    (".cursor/", "cursor"),
    (".kiro/", "kiro"),
    (".opencode/", "opencode"),
];
const CATEGORIES: &[&str] = &[
    "instructions",
    "skills",
    "rules",
    "subagents",
    "commands",
    "settings",
    "mcp",
    "other",
];

fn timestamp(time: SystemTime) -> String {
    OffsetDateTime::from(time)
        .format(&Rfc3339)
        .unwrap_or_default()
}

pub fn checked_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let relative = relative.replace('\\', "/");
    if relative.is_empty()
        || relative.contains(':')
        || relative
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.ends_with(['.', ' ']))
        || Path::new(&relative)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("invalid workspace-relative path".into());
    }
    let target = root.join(relative);
    let mut ancestor = target.as_path();
    while !ancestor.exists() {
        // A broken link still represents a filesystem object and must not be followed on create.
        if fs::symlink_metadata(ancestor).is_ok() {
            return Err("unresolved workspace link".into());
        }
        ancestor = ancestor.parent().ok_or("path has no existing ancestor")?;
    }
    if !ancestor.canonicalize()?.starts_with(root.canonicalize()?) {
        return Err("path escapes workspace".into());
    }
    Ok(target)
}

fn bounded_read(path: &Path, max: u64) -> Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err("expected a file".into());
    }
    let mut data = Vec::new();
    file.take(max + 1).read_to_end(&mut data)?;
    if data.len() as u64 > max {
        return Err("file is too large".into());
    }
    Ok(data)
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", id()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

fn providers(relative: &str) -> Vec<&'static str> {
    match relative {
        "AGENTS.md" => vec!["codex", "cursor", "kiro", "opencode"],
        "AGENTS.override.md" => vec!["codex"],
        "CLAUDE.md" | "CLAUDE.local.md" => vec!["claude"],
        "GEMINI.md" => vec!["gemini"],
        ".cursorrules" => vec!["cursor"],
        "opencode.json" | "opencode.jsonc" => vec!["opencode"],
        ".mcp.json" => vec!["shared"],
        _ => PROVIDERS
            .iter()
            .filter_map(|(prefix, name)| relative.starts_with(prefix).then_some(*name))
            .collect(),
    }
}

fn editable(relative: &str) -> bool {
    INSTRUCTIONS.contains(&relative)
        || [".claude/rules/", ".claude/commands/"]
            .iter()
            .any(|prefix| {
                relative
                    .strip_prefix(prefix)
                    .is_some_and(|name| !name.contains('/') && name.to_lowercase().ends_with(".md"))
            })
        || (relative.starts_with(".cursor/rules/")
            && matches!(ext(Path::new(relative)).as_str(), "md" | "mdc"))
        || (relative.starts_with(".kiro/steering/") && ext(Path::new(relative)) == "md")
}

fn category(relative: &str) -> &'static str {
    if INSTRUCTIONS.contains(&relative) {
        return "instructions";
    }
    if relative == ".mcp.json" {
        return "mcp";
    }
    if SETTINGS.contains(&relative) {
        return "settings";
    }
    if relative.ends_with("/SKILL.md") && relative.contains("/skills/") {
        return "skills";
    }
    if relative.starts_with(".claude/agents/") && relative.ends_with(".md") {
        return "subagents";
    }
    if relative.starts_with(".claude/commands/") && editable(relative) {
        return "commands";
    }
    if editable(relative) {
        return "rules";
    }
    "other"
}

fn ext(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn frontmatter(text: &str) -> Value {
    let mut lines = text.lines();
    let mut result = Map::new();
    if lines.next() == Some("---") {
        for line in lines.take_while(|line| line.trim() != "---") {
            if let Some((key, value)) = line.split_once(':') {
                if !key.is_empty()
                    && key
                        .bytes()
                        .all(|ch| ch.is_ascii_alphanumeric() || b"_-".contains(&ch))
                {
                    result.insert(key.into(), json!(value.trim().trim_matches(['"', '\''])));
                }
            }
        }
    }
    json!(result)
}

fn agent_item(root: &Path, relative: &str) -> Result<Value> {
    let path = checked_path(root, relative)?;
    let category = category(relative);
    let metadata = fs::metadata(&path).ok().filter(|data| data.is_file());
    let size = metadata.as_ref().map_or(0, fs::Metadata::len);
    let exists = metadata.is_some();
    let large = size > PREVIEW_LIMIT;
    let content = if exists && !large {
        bounded_read(&path, PREVIEW_LIMIT)
            .ok()
            .map(|data| String::from_utf8_lossy(&data).into_owned())
    } else {
        None
    };
    let lines = content.as_ref().map(|body| {
        if body.is_empty() {
            0
        } else {
            body.bytes().filter(|ch| *ch == b'\n').count() + 1
        }
    });
    let base_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(relative);
    let name = if category == "skills" {
        path.parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .unwrap_or(base_name)
    } else {
        base_name
    };
    let writable = editable(relative);
    let mut details = json!({});
    let mut warnings = Vec::new();
    let mut summary = match lines {
        Some(lines) => format!("{name} · {lines} lines"),
        None if exists => name.to_owned(),
        None => format!("{name} missing"),
    };
    if let Some(body) = &content {
        match category {
            "settings" | "mcp" if ext(&path) != "jsonc" => {
                match serde_json::from_str::<Value>(body) {
                    Ok(data) if category == "mcp" => {
                        let servers: Vec<_> = data["mcpServers"].as_object().into_iter().flatten().map(|(name, server)| {
                        let transport = server["type"].as_str().unwrap_or_else(|| if server["url"].is_string() {"http"} else if server["command"].is_string() {"stdio"} else {"unknown"});
                        json!({"name":name,"transport":transport,"hasCommand":server["command"].is_string(),"hasUrl":server["url"].is_string(),
                            "envKeys":server["env"].as_object().map(|keys|keys.keys().collect::<Vec<_>>()).unwrap_or_default()})
                    }).collect();
                        summary = format!("{name} · {} servers", servers.len());
                        details = json!({"servers":servers});
                    }
                    Ok(data) => {
                        let hooks: BTreeMap<_, _> = data["hooks"]
                            .as_object()
                            .into_iter()
                            .flatten()
                            .map(|(key, value)| (key, value.as_array().map_or(1, Vec::len)))
                            .collect();
                        let allow = data["permissions"]["allow"].as_array().map_or(0, Vec::len);
                        let deny = data["permissions"]["deny"].as_array().map_or(0, Vec::len);
                        summary = format!(
                            "{name} · allow {allow} · deny {deny} · hooks {}",
                            hooks.len()
                        );
                        details = json!({"allow":allow,"deny":deny,"hooks":hooks,
                        "envKeys":data["env"].as_object().map_or(0,Map::len),"enabledPlugins":data["enabledPlugins"].as_array().map_or(0,Vec::len)});
                    }
                    Err(err) => warnings.push(format!("invalid JSON: {err}")),
                }
            }
            "settings" => {
                details = json!({"format":"jsonc"});
                summary = format!("{name} · JSONC config");
            }
            "instructions" => {
                let imports = body.lines().filter(|line| line.starts_with('@')).count();
                let imports_agents = relative.to_ascii_lowercase().contains("claude")
                    && body.lines().any(|line| {
                        line.starts_with('@') && line.to_ascii_lowercase().contains("agents.md")
                    });
                details = json!({"imports":imports,"importsAgents":imports_agents});
            }
            "skills" | "rules" | "subagents" | "commands" => {
                details = frontmatter(body);
                if category == "commands" {
                    details["slashCommand"] = json!(format!("/{}", name.trim_end_matches(".md")));
                }
                if let Some(description) = details["description"].as_str() {
                    summary = format!("{name} · {description}");
                }
            }
            _ => {}
        }
    } else if category == "skills" && !exists {
        warnings.push("SKILL.md is missing".into());
    }
    let lower = relative.to_ascii_lowercase();
    Ok(
        json!({"category":category,"providers":providers(relative),"relativePath":relative,"name":name,
        "exists":exists,"editable":writable,"readOnly":!writable,"large":large,"invalid":!warnings.is_empty(),
        "privateLocal":lower.contains("local")||lower.contains("override"),"size":size,"lineCount":lines,
        "modifiedAt":metadata.and_then(|data|data.modified().ok()).map(timestamp),
        "summary":summary,"details":details,"warnings":warnings}),
    )
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn walk(root: &Path, dir: &Path, depth: usize, callback: &mut impl FnMut(PathBuf, bool)) {
    if depth > 24 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if matches!(
                name.as_str(),
                ".git"
                    | "node_modules"
                    | "dist"
                    | "build"
                    | "target"
                    | "coverage"
                    | "out"
                    | ".next"
                    | ".turbo"
                    | ".cache"
                    | "__pycache__"
            ) {
                continue;
            }
            if checked_path(root, &relative(root, &path)).is_ok() {
                callback(path.clone(), true);
                walk(root, &path, depth + 1, callback);
            }
        } else if kind.is_file() {
            callback(path, false);
        }
    }
}

pub fn scan_agents(root: &Path) -> Result<Value> {
    let mut candidates: BTreeMap<String, ()> = INSTRUCTIONS
        .iter()
        .chain(SETTINGS)
        .map(|path| ((*path).into(), ()))
        .collect();
    for (folder, _) in PROVIDERS {
        let folder = folder.trim_end_matches('/');
        let dir = checked_path(root, folder)?;
        let mut others = 0;
        walk(root, &dir, 0, &mut |path, is_dir| {
            let relative = relative(root, &path);
            if is_dir {
                if relative.split('/').count() == 3 && relative.contains("/skills/") {
                    candidates.insert(format!("{relative}/SKILL.md"), ());
                }
            } else if category(&relative) != "other"
                || (others < 100
                    && matches!(
                        ext(&path).as_str(),
                        "md" | "mdc" | "json" | "jsonc" | "yaml" | "yml" | "toml" | "txt"
                    ))
            {
                others += usize::from(category(&relative) == "other");
                candidates.insert(relative, ());
            }
        });
    }
    let mut items: Vec<_> = candidates
        .keys()
        .filter_map(|relative| agent_item(root, relative).ok())
        .collect();
    items.sort_by_key(|item| {
        (
            CATEGORIES
                .iter()
                .position(|category| item["category"] == *category),
            item["exists"] != true,
            item["relativePath"].as_str().unwrap_or("").to_owned(),
        )
    });
    let summary: Map<_,_> = CATEGORIES.iter().map(|category| {
        let items: Vec<_> = items.iter().filter(|item|item["category"] == *category).collect();
        let count = |key:&str| items.iter().filter(|item|item[key] == true).count();
        (category.to_string(),json!({"count":count("exists"),"missing":items.len()-count("exists"),"invalid":count("invalid"),"large":count("large"),"local":count("privateLocal")}))
    }).collect();
    Ok(json!({"items":items,"summary":summary}))
}

pub fn agent_action(action: &str, root: &Path, params: &Value) -> Result<Value> {
    let relative = text(params, "relativePath")?.replace('\\', "/");
    if providers(&relative).is_empty() {
        return Err("agent asset path is not allowed".into());
    }
    let target = checked_path(root, &relative)?;
    if action == "agent-asset-read" {
        let bytes = bounded_read(&target, PREVIEW_LIMIT)?;
        return Ok(
            json!({"content":String::from_utf8_lossy(&bytes),"meta":agent_item(root,&relative)?}),
        );
    }
    if action == "agent-asset-reveal" {
        return reveal(&target);
    }
    if !editable(&relative) {
        return Err("agent asset is read-only".into());
    }
    if action == "agent-asset-create" {
        let name = target
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Instructions");
        let content = match params["templateKind"].as_str().unwrap_or("") {
            "rule" => {
                format!("---\ndescription: \"Describe when this rule applies\"\n---\n\n# {name}\n")
            }
            "command" => format!("---\ndescription: \"Describe this command\"\n---\n\n# {name}\n"),
            _ => format!("# {name}\n\n"),
        };
        fs::create_dir_all(target.parent().ok_or("missing asset parent")?)?;
        let target = checked_path(root, &relative)?;
        fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(target)?
            .write_all(content.as_bytes())?;
        return Ok(json!({"ok":true,"content":content}));
    }
    let content = params["content"].as_str().ok_or("content is required")?;
    if content.len() as u64 > AGENT_WRITE_LIMIT {
        return Err("agent asset text is too large".into());
    }
    if target.is_file() {
        let backup = checked_path(root, &format!("{relative}.bak"))?;
        atomic_write(&backup, &bounded_read(&target, AGENT_WRITE_LIMIT)?)?;
    }
    atomic_write(&target, content.as_bytes())?;
    Ok(json!({"ok":true,"savedAt":timestamp(SystemTime::now())}))
}

fn input_path(root: &Path, name: &str) -> Result<PathBuf> {
    if !name.starts_with(&format!("{BASE}/")) {
        return Err("invalid input asset path".into());
    }
    checked_path(root, name)
}

fn load_inputs(root: &Path) -> Result<Vec<Value>> {
    let snippets = input_path(root, &format!("{BASE}/snippets"))?;
    let images = input_path(root, &format!("{BASE}/images"))?;
    fs::create_dir_all(snippets)?;
    fs::create_dir_all(images)?;
    let ignore = checked_path(root, ".wincmux/.gitignore")?;
    let contents = fs::read_to_string(&ignore).unwrap_or_default();
    if !contents
        .lines()
        .any(|line| line == "input-assets/" || line == "input-assets")
    {
        atomic_write(
            &ignore,
            format!(
                "{}{}input-assets/\n",
                contents,
                if contents.is_empty() || contents.ends_with('\n') {
                    ""
                } else {
                    "\n"
                }
            )
            .as_bytes(),
        )?;
    }
    let index = input_path(root, INDEX)?;
    if !index.exists() {
        return Ok(Vec::new());
    }
    let data: Value = serde_json::from_slice(&bounded_read(&index, 16 * 1024 * 1024)?)?;
    Ok(data["assets"]
        .as_array()
        .cloned()
        .ok_or("input asset index is invalid")?)
}

fn save_inputs(root: &Path, assets: &[Value]) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(&json!({"version":1,"assets":assets}))?;
    atomic_write(&input_path(root, INDEX)?, &bytes)
}

fn mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

pub fn image_url(data: &[u8], mime: &str) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(data))
}

fn new_asset(root: &Path, assets: &mut Vec<Value>, args: &Value, action: &str) -> Result<Value> {
    let (kind, extension, data, fallback) = match action {
        "input-asset-create-text" => {
            let content = text(args, "content")?;
            if content.trim().is_empty() {
                return Err("input asset content is required".into());
            }
            if content.len() as u64 > TEXT_LIMIT {
                return Err("input asset text is too large".into());
            }
            (
                "text",
                "md".into(),
                content.as_bytes().to_vec(),
                content
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .unwrap_or("Untitled")
                    .into(),
            )
        }
        "input-asset-create-image" => {
            let (head, body) = text(args, "dataUrl")?
                .split_once(',')
                .ok_or("image data is required")?;
            let media = head
                .strip_prefix("data:")
                .and_then(|value| value.strip_suffix(";base64"))
                .ok_or("invalid image data URL")?;
            let extension = ["png", "jpeg", "gif", "webp"]
                .into_iter()
                .find(|ext| mime(ext) == Some(media))
                .ok_or("unsupported image")?;
            if body.len() > (IMAGE_LIMIT as usize * 4 / 3 + 8) {
                return Err("image is too large".into());
            }
            let data = STANDARD.decode(body)?;
            image::guess_format(&data)?;
            ("image", extension.into(), data, "Image".into())
        }
        "input-asset-import-file" => {
            let path = Path::new(text(args, "filePath")?);
            let extension = ext(path);
            mime(&extension).ok_or("only png, jpg, jpeg, webp, and gif images are supported")?;
            let data = bounded_read(path, IMAGE_LIMIT)?;
            image::guess_format(&data)?;
            (
                "image",
                extension,
                data,
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            )
        }
        _ => return Err("unknown input asset action".into()),
    };
    if kind == "image" && data.len() as u64 > IMAGE_LIMIT {
        return Err("image is too large".into());
    }
    let id = id();
    let folder = if kind == "text" { "snippets" } else { "images" };
    let relative = format!("{BASE}/{folder}/{id}.{extension}");
    let path = input_path(root, &relative)?;
    let title: String = args["title"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&fallback)
        .chars()
        .take(120)
        .collect();
    let preview = if kind == "text" {
        String::from_utf8_lossy(&data)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(280)
            .collect()
    } else {
        relative.clone()
    };
    let now = timestamp(SystemTime::now());
    let asset = json!({"id":id,"type":kind,"title":title,"relative_path":relative,"preview":preview,"size":data.len(),
        "created_at":now,"updated_at":now,"source_pane_id":args["source"]["pane_id"],"source_session_id":args["source"]["session_id"]});
    atomic_write(&path, &data)?;
    assets.insert(0, asset.clone());
    if let Err(err) = save_inputs(root, assets) {
        let _ = fs::remove_file(path);
        return Err(err);
    }
    Ok(json!({"asset":asset}))
}

pub fn input_action(action: &str, root: &Path, params: &Value) -> Result<Value> {
    let mut assets = load_inputs(root)?;
    match action {
        "input-assets-list" => {
            assets.sort_by(|a, b| b["created_at"].as_str().cmp(&a["created_at"].as_str()));
            Ok(json!({"assets":assets}))
        }
        "input-asset-create-text" | "input-asset-create-image" | "input-asset-import-file" => {
            new_asset(root, &mut assets, params, action)
        }
        _ => {
            let id = text(params, "assetId")?;
            let pos = assets.iter().position(|asset| asset["id"] == id);
            if action == "input-asset-delete" && pos.is_none() {
                return Ok(json!({"ok":true}));
            }
            let pos = pos.ok_or("input asset not found")?;
            let asset = &assets[pos];
            let path = input_path(root, text(asset, "relative_path")?)?;
            match action {
                "input-asset-read" if asset["type"] == "image" => Ok(
                    json!({"asset":asset,"data_url":image_url(&bounded_read(&path,IMAGE_LIMIT)?,mime(&ext(&path)).unwrap_or("image/png"))}),
                ),
                "input-asset-read" => Ok(
                    json!({"asset":asset,"content":String::from_utf8_lossy(&bounded_read(&path,TEXT_LIMIT)?)}),
                ),
                "input-asset-rename" => {
                    if let Some(title) = params["title"]
                        .as_str()
                        .map(str::trim)
                        .filter(|title| !title.is_empty())
                    {
                        assets[pos]["title"] = json!(title.chars().take(120).collect::<String>());
                        assets[pos]["updated_at"] = json!(timestamp(SystemTime::now()));
                        save_inputs(root, &assets)?;
                    }
                    Ok(json!({"ok":true}))
                }
                "input-asset-delete" => {
                    let staged = path.with_extension(format!("deleted-{}", crate::store::id()));
                    let existed = path.is_file();
                    if existed {
                        fs::rename(&path, &staged)?;
                    }
                    assets.remove(pos);
                    if let Err(err) = save_inputs(root, &assets) {
                        if existed {
                            let _ = fs::rename(&staged, &path);
                        }
                        return Err(err);
                    }
                    if existed {
                        fs::remove_file(staged)?;
                    }
                    Ok(json!({"ok":true}))
                }
                "input-asset-reveal" => reveal(&path),
                _ => Err("unknown input asset action".into()),
            }
        }
    }
}

pub fn reveal(path: &Path) -> Result<Value> {
    let mut explorer = hidden_command("explorer.exe");
    if path.is_file() {
        explorer.arg(format!("/select,{}", path.display()));
    } else {
        explorer.arg(if path.is_dir() {
            path
        } else {
            path.parent().ok_or("missing parent folder")?
        });
    }
    explorer.spawn()?;
    Ok(json!({"ok":true}))
}

pub fn scan_long_files(root: &Path, min: usize) -> Value {
    let mut files = Vec::new();
    walk(root, root, 0, &mut |path, is_dir| {
        if is_dir
            || !matches!(
                ext(&path).as_str(),
                "ts" | "tsx"
                    | "js"
                    | "jsx"
                    | "py"
                    | "go"
                    | "rs"
                    | "cs"
                    | "java"
                    | "cpp"
                    | "c"
                    | "h"
                    | "hpp"
                    | "rb"
                    | "swift"
                    | "kt"
                    | "vue"
                    | "svelte"
            )
        {
            return;
        }
        let Ok(file) = fs::File::open(&path) else {
            return;
        };
        let mut reader = BufReader::new(file);
        let mut line = Vec::new();
        let mut count = 1;
        loop {
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(_) => {
                    count += usize::from(line.last() == Some(&b'\n'));
                    line.clear();
                }
                Err(_) => return,
            }
        }
        if count >= min {
            files.push((count, relative(root, &path)));
        }
    });
    files.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    json!({"files":files.into_iter().take(50).map(|(line_count,path)|json!({"relativePath":path,"lineCount":line_count})).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_asset_lifecycle_preserves_text_and_denies_traversal() -> Result<()> {
        let root = std::env::temp_dir().join(format!("wincmux-assets-{}", id()));
        fs::create_dir(&root)?;
        let result = (|| -> Result<()> {
            let original = "한글  두 칸\n\n   들여쓰기";
            let asset = input_action(
                "input-asset-create-text",
                &root,
                &json!({"content":original}),
            )?;
            let id = &asset["asset"]["id"];
            let read = input_action("input-asset-read", &root, &json!({"assetId":id}))?;
            assert_eq!(read["content"], original);
            input_action(
                "input-asset-rename",
                &root,
                &json!({"assetId":id,"title":"새 제목"}),
            )?;
            assert_eq!(
                input_action("input-assets-list", &root, &json!({}))?["assets"][0]["title"],
                "새 제목"
            );
            assert!(checked_path(&root, ".claude/../AGENTS.md").is_err());
            assert!(checked_path(&root, "AGENTS.md:alternate").is_err());
            assert!(agent_action(
                "agent-asset-write",
                &root,
                &json!({"relativePath":".mcp.json","content":"{}"})
            )
            .is_err());
            input_action("input-asset-delete", &root, &json!({"assetId":id}))?;
            assert_eq!(
                input_action("input-assets-list", &root, &json!({}))?["assets"],
                json!([])
            );
            Ok(())
        })();
        // The test uses a fresh directory under the process temp root.
        let _ = fs::remove_dir_all(&root);
        result
    }
}
