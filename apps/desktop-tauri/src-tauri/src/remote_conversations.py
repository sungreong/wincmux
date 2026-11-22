"""Read CLI owned transcript metadata in the connected Linux environment."""
import json
import os
import sqlite3
import sys
import uuid
from pathlib import Path

project = os.path.normpath(sys.argv[1])
children = sys.argv[2] == "1"
home = Path.home()
claude = Path(os.environ.get("CLAUDE_CONFIG_DIR") or home / ".claude")
codex = Path(os.environ.get("CODEX_HOME") or home / ".codex")
items = {}
warnings = []
budget = 20000


def valid_id(value):
    try:
        return str(uuid.UUID(str(value))) if len(str(value)) == 36 else None
    except (ValueError, TypeError):
        return None


def inside(cwd):
    if not isinstance(cwd, str):
        return False
    cwd = os.path.normpath(cwd)
    return cwd == project or (children and cwd.startswith(project.rstrip(os.sep) + os.sep))


def short(value):
    return " ".join(str(value or "").split())[:180]


def files(root, depth):
    global budget
    if depth < 0 or root.is_symlink():
        return
    try:
        entries = os.scandir(root)
    except OSError:
        return
    with entries:
        for entry in entries:
            budget -= 1
            if budget < 0:
                return
            try:
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False) and depth:
                    if entry.name != "subagents":
                        yield from files(Path(entry.path), depth - 1)
                elif entry.is_file(follow_symlinks=False) and entry.name.endswith(".jsonl"):
                    yield Path(entry.path)
            except OSError:
                continue


def lines(path, head, tail=0):
    try:
        if path.is_symlink() or not path.is_file():
            return
        with path.open("rb") as stream:
            parts = [stream.read(head)]
            size = path.stat().st_size
            if size > head and tail:
                stream.seek(max(head, size - tail))
                parts.append(stream.read(tail))
        for part in parts:
            for raw in part.splitlines():
                try:
                    yield json.loads(raw)
                except (ValueError, UnicodeError):
                    continue
    except OSError:
        return


def row(provider, id, cwd, title, source, archived=False, updated=None):
    try:
        stat = source.stat()
        if not source.is_file() or source.is_symlink():
            return None
    except OSError:
        return None
    return dict(provider=provider, id=id, cwd=cwd, title=short(title),
                updated_at=int(updated or stat.st_mtime), size_bytes=stat.st_size,
                source_path=str(source), archived=archived, cwd_exists=Path(cwd).is_dir(),
                resume_command=("claude --resume " if provider == "claude" else "codex resume ") + id)


def user_text(message):
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return short(content)
    if isinstance(content, list):
        return short(" ".join(part.get("text", "") for part in content
                              if isinstance(part, dict) and part.get("type") == "text"))
    return ""


for source in files(claude / "projects", 1):
    id = valid_id(source.stem)
    if not id:
        continue
    cwd = title = first = ""
    rank = 0
    sidechain = False
    for value in lines(source, 512 * 1024, 192 * 1024):
        if value.get("sessionId") not in (None, id):
            continue
        cwd = cwd or value.get("cwd") or ""
        sidechain |= value.get("isSidechain") is True
        if not first and value.get("type") == "user" and not value.get("isMeta") and "toolUseResult" not in value:
            candidate = user_text(value.get("message"))
            if candidate and not candidate.startswith(("<", "# ", "Caveat:", "This session is being continued")):
                first = candidate
        for level, key in ((3, "customTitle"), (2, "aiTitle"), (1, "summary")):
            if level >= rank and value.get("type") == {3: "custom-title", 2: "ai-title", 1: "summary"}[level] and value.get(key):
                title, rank = short(value[key]), level
    if not sidechain and inside(cwd):
        result = row("claude", id, cwd, title or first or "Claude 대화 · " + id[:8], source)
        if result:
            items["claude:" + id] = result

titles = {}
for value in lines(codex / "session_index.jsonl", 8 * 1024 * 1024, 2 * 1024 * 1024):
    if valid_id(value.get("id")) and value.get("thread_name"):
        titles[value["id"]] = short(value["thread_name"])

try:
    databases = sorted((p for p in codex.glob("state_*.sqlite") if not p.is_symlink()),
                       key=lambda p: int(p.stem[6:]) if p.stem[6:].isdigit() else 0, reverse=True)
except OSError:
    databases = []
if databases:
    try:
        db = sqlite3.connect(databases[0].as_uri() + "?mode=ro", uri=True, timeout=0.4)
        try:
            names = {col[1] for col in db.execute("PRAGMA table_info(threads)")}
            if {"id", "cwd", "updated_at"} <= names:
                wanted = ["id", "cwd", "updated_at", "title", "first_user_message", "rollout_path",
                          "archived", "source", "thread_source", "name", "preview"]
                columns = ",".join('"' + name + '"' if name in names else "NULL" for name in wanted)
                for record in db.execute("SELECT " + columns + " FROM threads ORDER BY updated_at DESC LIMIT 5000"):
                    id, cwd, updated, title, first, source, archived, agent_source, thread_source, name, preview = record
                    id = valid_id(id)
                    if not id or not inside(cwd) or "subagent" in str(agent_source).lower() or "subagent" in str(thread_source).lower():
                        continue
                    source = Path(source) if source else databases[0]
                    result = row("codex", id, cwd, titles.get(id) or next((short(s) for s in (name, title, preview, first) if s), "Codex 대화 · " + id[:8]),
                                 source, bool(archived), updated / 1000 if updated and updated > 100_000_000_000 else updated)
                    if result:
                        items["codex:" + id] = result
        finally:
            db.close()
    except (OSError, sqlite3.Error, ValueError):
        warnings.append("Codex 대화 DB를 읽지 못해 대화 파일에서 조회했습니다.")

for dirname in ("sessions", "archived_sessions"):
    for source in files(codex / dirname, 4):
        for value in lines(source, 128 * 1024):
            if value.get("type") != "session_meta":
                continue
            meta = value.get("payload") or {}
            id, cwd = valid_id(meta.get("id") or meta.get("session_id")), meta.get("cwd")
            if id and inside(cwd) and "subagent" not in str(meta.get("source")).lower() and "subagent" not in str(meta.get("thread_source")).lower():
                result = row("codex", id, cwd, titles.get(id) or "Codex 대화 · " + id[:8], source, dirname == "archived_sessions")
                if result:
                    items.setdefault("codex:" + id, result)
            break

if budget < 0:
    warnings.append("조회 가능한 파일 수를 초과해 일부 대화가 생략됐습니다.")
if not (claude / "projects").is_dir():
    warnings.append("이 환경에 Claude 대화 폴더가 없습니다.")
print(json.dumps(dict(items=sorted(items.values(), key=lambda v: v["updated_at"], reverse=True)[:2000],
                      warnings=warnings, project_path=project, include_children=children), ensure_ascii=False))
