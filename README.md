# WinCMux

**WinCMux** is a Windows-first multiplexer for running parallel AI Agent CLIs (Claude Code, OpenAI Codex, etc.) in isolated workspaces — inspired by tmux/cmux UX, built on Electron + Node.js (no .NET required).

![WinCMux Screenshot](assets/view.png)

---

## Why WinCMux?

On macOS/Linux, developers use `tmux` or `cmux` to manage multiple terminal sessions side-by-side. Windows has no native equivalent that integrates well with modern AI CLI tools. WinCMux fills that gap:

- Run **Claude Code**, **OpenAI Codex**, and other AI agents in parallel panes
- Each agent is isolated in its own **Workspace** with its own directory, branch, notes, layout, and state
- Fast workspace switching: panes render immediately, while dormant sessions restore only when selected
- Move panes visually by choosing a source pane, hovering a target edge, and dropping into the preview slot
- Notifications from all agents are collected in a unified **Notification Center** and mirrored to Windows toasts/taskbar badge
- No Docker, no WSL, no .NET — pure Windows-native (ConPTY + node-pty)

---

## Screenshot

The screenshot above shows the current workspace-oriented UI:
- **Pane surface**: terminal panes can be split, hidden, restored, restarted, moved, and grouped without killing the running session.
- **Move Pane mode**: click `Move Pane` or press `Ctrl+Alt+P`, hover a target edge, then click the preview slot to place the pane above/below/left/right.
- **Pane groups**: each workspace starts with `Default`; custom groups can be created/renamed, and panes can be moved between groups from the pane group pill.
- **Workspace sidebar**: add workspaces, switch projects, delete individual workspaces, show branch/dirty status, and keep per-workspace notes.
- **Workspace info panel**: editable description, git summary, long-file scan, scoped running sessions, AI session history, and Agent Assets inventory.
- **Agent Assets**: inspect workspace-scoped Claude/Codex/Gemini/Cursor/Kiro/opencode files such as `CLAUDE.md`, `AGENTS.md`, `.claude/skills`, `.cursor/rules`, `.gemini`, `.kiro`, `.mcp.json`, and `.agents` without opening Explorer.
- **Notifications panel**: unread assistant completions grouped by workspace, with workspace mark-read and clear actions.
- **Top toolbar**: workspace/notification visibility, hidden pane drawer, equalize panes, keyboard help, font scale, and selected pane ID.

---

## Features (MVP)

| Feature | Status |
|---|---|
| Workspace CRUD (create / list / rename / pin / reorder) | Done |
| Workspace description field (editable in info panel) | Done |
| Workspace info popup panel (description, git, scan, sessions) | Done |
| Workspace Agent Assets inventory with provider filters and preview/editor pane | Done |
| Agent asset provider registry (Claude/Codex/Gemini/Cursor/Kiro/opencode/Shared) | Done |
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
| Scan long files IPC (`scanLongFiles` — finds files > N lines) | Done |
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
| Workspace-scoped sessions drawer — AI resume history + running PTY sessions | Done |
| Auto-prune failed AI resume records when the CLI reports missing conversation | Done |
| Clipboard paste (Ctrl+V) without double-input in AI CLIs | Done |
| Font size per-pane adjustment (A- / A+) | Done |
| Workspace notes panel | Done |
| Workspace add/delete UI with per-workspace delete controls | Done |
| Quick presets: Codex Only, Claude Only added (seed v3) | Done |
| Quick command panel repositions on window resize/scroll | Done |
| App icon (terminal .ico) applied to BrowserWindow and installer | Done |
| Notification center filter (level/workspace) + Jump-to-unread | Planned |
| Portable `.exe` smoke-test automation | In Progress |
| Embedded browser engine (WebView2 panels) | Phase 2 |
| Advanced automation event streaming / external daemon mode | Phase 2 |
| Process supervisor hardening (Job Object deep orphan guarantees) | Phase 2 |

---

## Repository Layout

```
WinCMux/
├── apps/
│   └── desktop/          # Electron shell (main / preload / renderer)
├── packages/
│   └── core/             # Node core engine (SQLite + node-pty + JSON-RPC)
├── bridge/               # Protocol contracts and schemas
├── infra/                # Config templates and migration references
├── legacy-dotnet/        # Previous .NET implementation (reference only)
├── assets/               # Screenshots and static assets
└── scripts/              # Build and packaging scripts
```

---

## Prerequisites

- **Windows 11 x64** (primary target)
- **Node.js 20+**
- **npm 10+**
- Optional: build tools if `node-pty` prebuild is unavailable

---

## Quick Start

### Windows development

From Command Prompt or PowerShell:

```bat
.\dev.bat
```

`dev.bat` runs from the repository root, checks that `node` and `npm` are available, installs dependencies when `node_modules` is missing, then starts the Electron development app with the Node core auto-spawned.

Equivalent manual commands:

```bash
# Install dependencies
npm install

# Run core engine + Electron desktop in parallel
npm run dev
```

Run separately if needed:
```bash
# Core engine only
npm --workspace @wincmux/core run dev

# Electron desktop only (expects external core already running)
npm --workspace @wincmux/desktop run dev
```

---

## Pane Layout Workflow

### Split panes

- `Split Right` (`Ctrl+Alt+Backslash`) adds a pane to the right.
- `Split Down` (`Ctrl+Alt+-`) adds a pane below.
- `Equalize` (`Ctrl+Shift+E`) resets split sizes to equal space.

### Move panes

Use `Move Pane` from the pane header or press `Ctrl+Alt+P`.

1. Select the pane you want to move.
2. Click `Move Pane` or press `Ctrl+Alt+P`.
3. Hover another pane. A large preview slot shows where the pane will land.
4. Click the target edge to place the pane `above`, `below`, `left`, or `right`.
5. Press `Esc` to cancel move mode.

This changes the layout tree only. The pane/session mapping is kept, so running terminals do not need to restart.

### Hide vs close

- `Hide Pane` (`Ctrl+Alt+W`) removes the pane from the screen but keeps the session available in `Hidden`.
- `Close Pane` (`Ctrl+Alt+Q`) closes the pane and terminates its session.
- `Close Session` closes only the terminal session attached to that pane.
- `Restart` (`Ctrl+Alt+R`) starts the pane again with a fresh session.

---

## Pane Groups

Pane groups are logical session groups, not nested layout containers.

- Every workspace has a `Default` group.
- Create a custom group with the `+` button in the group bar.
- Rename custom groups by double-clicking or right-clicking the group chip.
- Move a pane to another group from the group pill in the pane header.
- Selecting a group filters the visible panes for that workspace; `All` shows everything.
- Group selection and pane group hints are saved per workspace.

---

## Agent Assets

Open a workspace card's info panel, then click `Agent Assets`.

Agent Assets is a workspace-scoped inventory for agent configuration and instruction files. It is designed so you can check what an AI CLI will see without opening Explorer.

- The panel uses provider filters: `All`, `Claude`, `Codex`, `Gemini`, `Cursor`, `Kiro`, `opencode`, and `Shared`.
- The left side shows counts, missing files, invalid files, large files, local/private files, and grouped asset lists.
- The right side is a fixed preview/editor pane, so `View` does not push the result to the bottom of a long scroll.
- `Copy Summary`, `Copy Path`, `Explorer`, and `Insert` are available for each asset.

Currently scanned locations:

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

The implementation is provider-registry based. To add a future tool, add its instruction files, settings files, scan roots, editable paths, and allowlist patterns to the Agent Asset provider definition instead of adding one-off UI conditionals.

---

## Notifications

WinCMux watches Claude/Codex terminal output and notifies when an assistant response is ready.

- Completion detection is turn-aware, so one assistant response creates one unread notification.
- The detector handles explicit ready prompts and output-idle fallback when a final prompt is not visible.
- Notification cards include workspace/session context and a short response preview when available.
- Windows toast clicks navigate back to the matching workspace and pane when possible.
- The Windows taskbar overlay shows unread count and clears when notifications are marked read.
- `Mark WS` marks unread notifications for the selected workspace.
- `Clear` clears unread notifications globally and dismisses active toasts where Electron/Windows allows it.

---

## Keyboard Shortcuts

The app also has a `Shortcuts` button in the top toolbar. Press `Ctrl+/` to open the same help panel.

| Action | Shortcut |
|---|---|
| Next / previous pane | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Move by direction | `Ctrl+Alt+Arrow` |
| Split right | `Ctrl+Alt+Backslash` |
| Split down | `Ctrl+Alt+-` |
| More menu | `Ctrl+Alt+M` |
| Move selected pane | `Ctrl+Alt+P` |
| Start selected pane | `Ctrl+Alt+T` |
| Restart selected pane | `Ctrl+Alt+R` |
| Hide selected pane | `Ctrl+Alt+W` |
| Close selected pane | `Ctrl+Alt+Q` |
| Equalize pane sizes | `Ctrl+Shift+E` |
| Toggle workspaces / notifications / hidden panes | `Ctrl+B` / `Ctrl+Shift+N` / `Ctrl+Shift+H` |

---

## Packaging

```bash
# Build portable Windows .exe
npm run package:win
```

---

## Verification

Useful checks before committing UI/core changes:

```bash
npm --workspace @wincmux/core run test -- --run
npm --workspace @wincmux/core run build
npm --workspace @wincmux/desktop run check:renderer
npm --workspace @wincmux/desktop run lint
npm run build
```

`check:renderer` may print line-count warnings for large renderer modules. Those warnings are informational; syntax/build failures still exit non-zero.

---

## Configuration

| Item | Default Path |
|---|---|
| Database | `%APPDATA%\WinCMux\wincmux.db` |
| Logs | `%LOCALAPPDATA%\WinCMux\logs` |
| Named pipe | `\\.\pipe\wincmux-rpc` |

---

## Architecture

```
Electron Renderer (UI)
    └── IPC (contextBridge)
Electron Main Process
    ├── Named Pipe JSON-RPC client (auto-retry + core respawn on ENOENT)
    ├── Persistent stream sockets (session events / notify events)
    ├── Workspace Agent Assets scanner/editor IPC (provider registry + path safety)
    └── Native Toast + Taskbar Badge (Electron Notification API)
@wincmux/core (Node.js)
    ├── Workspace Manager
    ├── Session Runner (node-pty / ConPTY)
    ├── Notification Ingest (dedup, delivery ACK, suppression, completion detection)
    ├── NotifyDetector (Claude/Codex ready prompts, Korean prompt text, idle fallback)
    ├── Layout Snapshot Engine (split, close, swap, move/drop)
    ├── Pane Groups (workspace-scoped group metadata + session bindings)
    ├── Async Git Metadata Scheduler
    ├── AI Session Detector (claude/codex resume command extraction)
    ├── Pane Session Binding (persist pane↔session across restarts)
    └── SQLite Storage (schema v7 with auto-migration)
```

Recent JSON-RPC additions used by the desktop app:

| Method | Purpose |
|---|---|
| `session.tail` | Restore recent terminal output without draining the polling buffer |
| `layout.swap` | Swap two leaf pane positions |
| `layout.move` | Move a leaf pane above/below/left/right of another leaf pane |
| `group.list`, `group.create`, `group.rename`, `group.delete` | Manage workspace pane groups |
| `session.group.set`, `session.group.list` | Persist session-to-group bindings |

Desktop IPC additions:

| Channel | Purpose |
|---|---|
| `agentAssetsScan(workspacePath)` | Scan workspace agent assets by provider/category |
| `agentAssetRead(workspacePath, relativePath)` | Read a safe workspace-confined asset preview |
| `agentAssetWrite(workspacePath, relativePath, content)` | Save an editable asset with validation and `.bak` backup |
| `agentAssetCreate(workspacePath, relativePath, templateKind)` | Create a safe instruction/rule/command asset from a template |
| `agentAssetReveal(workspacePath, relativePath)` | Reveal a scanned asset in Explorer |

---

## Roadmap

See [ROADMAP_NEXT.md](ROADMAP_NEXT.md) for the current sprint plan.

---

## License

MIT
