# Feature Reference

This document keeps the detailed feature inventory that used to live in the top-level README. Keep the README concise; update this file when adding, changing, or retiring user-visible behavior.

## Current UI Surface

- **Pane surface**: terminal panes can be split, hidden, restored, restarted, moved, and grouped without killing the running session.
- **Move Pane mode**: click `Move Pane` or press `Ctrl+Alt+P`, hover a target edge, then click the preview slot to place the pane above/below/left/right.
- **Pane groups**: each workspace starts with `Default`; custom groups can be created/renamed, and panes can be moved between groups from the pane group pill.
- **Workspace sidebar**: add workspaces from a collapsible form, switch projects, delete individual workspaces, show branch/dirty status in brief/detail modes, and keep per-workspace notes.
- **Workspace info panel**: editable description, git summary, long-file scan, scoped running sessions, AI session history, Agent Assets, and Input Assets.
- **Agent Assets**: inspect workspace-scoped Claude/Codex/Gemini/Cursor/Kiro/opencode files such as `CLAUDE.md`, `AGENTS.md`, `.claude/skills`, `.cursor/rules`, `.gemini`, `.kiro`, `.mcp.json`, and `.agents`.
- **Input Assets**: save long pasted text, clipboard images, and imported images under `.wincmux/input-assets`, then preview, copy, reveal, or insert path-based work prompts into the selected pane.
- **Notifications panel**: unread assistant completions grouped by workspace, with workspace mark-read and clear actions.
- **Top toolbar**: workspace/notification visibility, hidden pane drawer, equalize panes, keyboard help, font scale, and selected pane ID.

## Feature Matrix

| Feature | Status |
|---|---|
| Workspace CRUD (create / list / rename / pin / reorder) | Done |
| Workspace description field (editable in info panel) | Done |
| Workspace info popup panel (description, git, scan, sessions) | Done |
| Workspace Agent Assets inventory with provider filters and preview/editor pane | Done |
| Agent asset provider registry (Claude/Codex/Gemini/Cursor/Kiro/opencode/Shared) | Done |
| Workspace Input Assets for long paste snippets, clipboard images, imports, and path-prompt insertion | Done |
| Session run via `node-pty` (ConPTY on Windows) | Done |
| Session delete (non-running sessions) via IPC | Done |
| Redundant session history pruning (dedup sequential runs) | Done |
| Named-pipe JSON-RPC server (`\\.\pipe\wincmux-rpc`) | Done |
| SQLite-backed workspace/session/notification/layout storage | Done |
| Notification ingest (`notify.push`) + unread tracking | Done |
| Notification delivery ACK + suppression tracking | Done |
| Notification dedup via `dedup_key` + schema migration | Done |
| Assistant completion detection for Claude/Codex, including Korean ready prompts and idle fallback | Done |
| Basic pane split/focus + snapshot persistence | Done |
| Pane move/drop layout (`layout.move`) with visual preview slots | Done |
| Pane swap layout (`layout.swap`) | Done |
| Pane groups (`Default` + custom groups, per-workspace persistence) | Done |
| Pane action overflow menu (compact/tight responsive layout) | Done |
| Pane auto-resize toggle (persisted to localStorage) | Done |
| Terminal scrollback preserved across layout changes | Done |
| xterm buffer cached per workspace (scrollback survives workspace switch) | Done |
| Non-destructive terminal tail restore (`session.tail`) | Done |
| Batched session stream output to reduce renderer/IPC churn | Done |
| Korean IME input handling in xterm panes | Done |
| Workspace transition guard (prevents stale async race on switch) | Done |
| Selected-pane-first restore on workspace switch | Done |
| Orphan session cleanup on workspace switch | Done |
| Async git branch/dirty scheduler with timeouts and active-workspace priority | Done |
| Git error detail hint when .git folder not found | Done |
| Scan long files IPC (`scanLongFiles` - finds files > N lines) | Done |
| Stream topic filtering (`session` \| `notify`) | Done |
| Core auto-respawn on runtime crash + pipe ENOENT retry | Done |
| Reused named-pipe RPC client for high-frequency writes/resizes | Done |
| Notify stream auto-reconnect after pipe recovery | Done |
| Native toast delivery via Electron Notification API | Done |
| Unread badge overlay icon on Windows taskbar | Done |
| Toast click navigation to workspace/pane/session | Done |
| Notification center UI (panel, unread count, workspace mark/clear) | Done |
| PTY output streaming to renderer pane (real-time) | Done |
| Pane session restore on app restart | Done |
| AI session auto-detection (`claude --resume`, `codex resume`) | Done |
| Workspace-scoped sessions drawer: AI resume history + running PTY sessions | Done |
| Auto-prune failed AI resume records when the CLI reports missing conversation | Done |
| Clipboard paste (`Ctrl+V`) without double-input in AI CLIs | Done |
| Font size per-pane adjustment (A- / A+) | Done |
| Workspace notes panel | Done |
| Workspace add/delete UI with per-workspace delete controls | Done |
| Quick presets: Codex Only, Claude Only added (seed v3) | Done |
| Quick command panel repositions on window resize/scroll | Done |
| App icon (terminal `.ico`) applied to BrowserWindow and installer | Done |
| Notification center filter (level/workspace) + Jump-to-unread | Planned |
| Portable `.exe` smoke-test automation | In Progress |
| Embedded browser engine (WebView2 panels) | Phase 2 |
| Advanced automation event streaming / external daemon mode | Phase 2 |
| Process supervisor hardening (Job Object deep orphan guarantees) | Phase 2 |

## Pane Layout Workflow

### Split panes

- `Split Right` (`Ctrl+Alt+\`) adds a pane to the right.
- `Split Down` (`Ctrl+Alt+-`) adds a pane below.
- `Equalize` (`Ctrl+Shift+E`) resets split sizes to equal space.

### Move panes

1. Select the pane you want to move.
2. Click `Move Pane` or press `Ctrl+Alt+P`.
3. Hover another pane. A preview slot shows where the pane will land.
4. Click the target edge to place the pane `above`, `below`, `left`, or `right`.
5. Press `Esc` to cancel move mode.

This changes the layout tree only. The pane/session mapping is kept, so running terminals do not need to restart.

### Hide vs close

- `Hide Pane` (`Ctrl+Alt+W`) removes the pane from the screen but keeps the session available in `Hidden`.
- `Close Pane` (`Ctrl+Alt+Q`) closes the pane and terminates its session.
- `Close Session` closes only the terminal session attached to that pane.
- `Restart` (`Ctrl+Alt+R`) starts the pane again with a fresh session.

## Agent Assets

Agent Assets is a workspace-scoped inventory for agent configuration and instruction files. It is designed so you can check what an AI CLI will see without opening Explorer.

Provider coverage:

| Provider | Files and folders |
|---|---|
| Claude | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/skills/**`, `.claude/agents/*.md`, `.claude/commands/*.md`, `.claude/rules/*.md`, `.claude/settings*.json` |
| Codex | `AGENTS.md`, `AGENTS.override.md`, `.agents/**` |
| Gemini | `GEMINI.md`, `.gemini/settings.json`, `.gemini/**` |
| Cursor | `.cursorrules`, `.cursor/rules/*.mdc`, `.cursor/**`, `AGENTS.md` |
| Kiro | `.kiro/**`, `.kiro/steering/*.md`, `AGENTS.md` |
| opencode | `AGENTS.md`, `opencode.json`, `opencode.jsonc`, `.opencode/**` |
| Shared | `.mcp.json` |

Safe editing is intentionally limited in v1:

- Editable in-app: root instruction files such as `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, plus `.claude/rules/*.md`, `.claude/commands/*.md`, `.cursor/rules/*.mdc`, and `.kiro/steering/*.md`.
- Read-only in-app: skills, subagents, settings JSON, MCP config, and most tool-specific folders.
- Saves are workspace-confined, reject path traversal/symlink escape, validate JSON before saving, and keep one `.bak` backup.

## Input Assets

Input Assets are temporary or reusable user inputs that can be saved before sending a path prompt to a pane.

- Long paste detection triggers at about `2KB` or `20` lines.
- Clipboard images open an image preview prompt before saving.
- Text assets are stored as `.wincmux/input-assets/snippets/<id>.md`.
- Image assets are stored under `.wincmux/input-assets/images/`.
- Imported image files keep their source extension; clipboard images are saved as PNG.
- `Save + Insert`, `Insert`, and `Copy` use a short Korean prompt that includes the saved asset's absolute path.
- `Path` inserts only the saved file path.
- `.wincmux/.gitignore` is created with `input-assets/`, so these assets are private by default.

Text prompt shape:

```text
작업 문서 경로: C:\path\to\workspace\.wincmux\input-assets\snippets\<id>.md
위의 경로에 적힌 작업 문서로 작업 진행해줘
```

Image prompt shape:

```text
이미지 작업 문서 경로: C:\path\to\workspace\.wincmux\input-assets\images\<id>.png
위의 경로에 적힌 이미지 작업 문서로 작업 진행해줘
```

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Next / previous pane | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Move by direction | `Ctrl+Alt+Arrow` |
| Split right | `Ctrl+Alt+\` |
| Split down | `Ctrl+Alt+-` |
| More menu | `Ctrl+Alt+M` |
| Move selected pane | `Ctrl+Alt+P` |
| Start selected pane | `Ctrl+Alt+T` |
| Restart selected pane | `Ctrl+Alt+R` |
| Hide selected pane | `Ctrl+Alt+W` |
| Close selected pane | `Ctrl+Alt+Q` |
| Equalize pane sizes | `Ctrl+Shift+E` |
| Toggle workspaces / notifications / hidden panes | `Ctrl+B` / `Ctrl+Shift+N` / `Ctrl+Shift+H` |
