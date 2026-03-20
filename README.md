# WinCMux

**WinCMux** is a Windows-first multiplexer for running parallel AI Agent CLIs (Claude Code, OpenAI Codex, etc.) in isolated workspaces — inspired by tmux/cmux UX, built on Electron + Node.js (no .NET required).

![WinCMux Screenshot](assets/view.png)

---

## Why WinCMux?

On macOS/Linux, developers use `tmux` or `cmux` to manage multiple terminal sessions side-by-side. Windows has no native equivalent that integrates well with modern AI CLI tools. WinCMux fills that gap:

- Run **Claude Code**, **OpenAI Codex**, and other AI agents in parallel panes
- Each agent is isolated in its own **Workspace** with its own directory, branch, and state
- Notifications from all agents are collected in a unified **Notification Center**
- No Docker, no WSL, no .NET — pure Windows-native (ConPTY + node-pty)

---

## Screenshot

The screenshot above shows two active workspaces:
- **Left pane**: Claude Code (Sonnet 3.6) running in `C:\Users\leesu\Downloads`
- **Right pane**: OpenAI Codex (gpt-3.5-codex) running in the same directory
- **Toolbar**: Split H / Split V / Restart / Close / Hide Pane controls per pane
- **Notification panel** (right): Unread count, Refresh / Mark Latest / Clear buttons
- **Status bar** (bottom): Active pane holder ID

---

## Features (MVP)

| Feature | Status |
|---|---|
| Workspace CRUD (create / list / rename / pin / reorder) | Done |
| Session run via `node-pty` (ConPTY on Windows) | Done |
| Named-pipe JSON-RPC server (`\\.\pipe\wincmux-rpc`) | Done |
| SQLite-backed workspace/session/notification/layout storage | Done |
| Notification ingest (`notify.push`) + unread tracking | Done |
| Notification delivery ACK + suppression tracking | Done |
| Notification dedup via `dedup_key` + schema migration (v2) | Done |
| Pattern-based terminal output detection (NotifyDetector) | Done |
| Basic pane split/focus + snapshot persistence | Done |
| Git branch/dirty-flag polling (3s interval) | Done |
| Stream topic filtering (`session` \| `notify`) | Done |
| Core auto-respawn on runtime crash + pipe ENOENT retry | Done |
| Notify stream auto-reconnect after pipe recovery | Done |
| Native toast delivery via Electron Notification API | Done |
| Unread badge overlay icon on taskbar | Done |
| Notification center UI (panel, unread count, mark/clear) | Done |
| PTY output streaming to renderer pane (real-time) | In Progress |
| Workspace rename/pin/reorder UI controls | In Progress |
| Notification center filter (level/workspace) + Jump-to-unread | In Progress |
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

## Packaging

```bash
# Build portable Windows .exe
npm run package:win
```

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
    └── Native Toast + Taskbar Badge (Electron Notification API)
@wincmux/core (Node.js)
    ├── Workspace Manager
    ├── Session Runner (node-pty / ConPTY)
    ├── Notification Ingest (dedup, delivery ACK, suppression)
    ├── NotifyDetector (pattern-based terminal output detection)
    ├── Layout Snapshot Engine
    ├── Git Metadata Poller
    └── SQLite Storage (schema v2 with auto-migration)
```

---

## Roadmap

See [ROADMAP_NEXT.md](ROADMAP_NEXT.md) for the current sprint plan.

---

## License

MIT
