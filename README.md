# WinCMux

Windows-first terminal workspace multiplexer for running multiple AI agent CLIs side by side.

WinCMux is built with Electron, Node.js, ConPTY, and `node-pty`. It is designed for Claude Code, OpenAI Codex, and other CLI agents that need separate working directories, persistent panes, notifications, and quick context handoff.

[Korean README](README.kr.md)

![WinCMux Screenshot](assets/view.png)

## Why

Tools like `tmux` and `cmux` are common on macOS/Linux, but Windows users need a native workflow that works well with AI CLI tools. WinCMux provides:

- multiple terminal panes per workspace
- workspace switching with preserved pane/session state
- grouped panes and visual pane move/drop
- unread notifications from assistant output
- workspace notes, git status, and session history
- agent instruction file inspection
- input asset handling for long text and images

## Quick Start

Requirements:

- Windows 11 x64
- Node.js 20+
- npm 10+

Run the app from the repository root:

```bat
.\dev.bat
```

Manual development commands:

```bash
npm install
npm run dev
```

Run packages separately:

```bash
npm --workspace @wincmux/core run dev
npm --workspace @wincmux/desktop run dev
```

## Main Workflows

More detailed reference docs:

- [Feature reference](docs/features.md)
- [Architecture and IPC notes](docs/architecture.md)
- [Roadmap](ROADMAP_NEXT.md)

### Workspaces

The left sidebar manages projects. Use the collapsible `Add workspace` form to add a folder, then switch between workspace cards. The list supports `Brief` and `Detail` display modes, and each workspace can keep its own notes.

The workspace info popup provides:

- description
- git summary
- long-file scan
- AI session history
- running PTY sessions
- Agent Assets
- Input Assets

### Panes

Panes are terminal surfaces backed by sessions.

- Split right: `Ctrl+Alt+\`
- Split down: `Ctrl+Alt+-`
- Move selected pane: `Ctrl+Alt+P`
- Hide selected pane: `Ctrl+Alt+W`
- Close selected pane: `Ctrl+Alt+Q`
- Restart selected pane: `Ctrl+Alt+R`
- Equalize splits: `Ctrl+Shift+E`

Moving a pane changes the layout tree without restarting the attached terminal session.

### Pane Groups

Each workspace starts with a `Default` group. Create more groups from the group bar, then move panes between groups from the pane group pill. `All` shows every pane in the workspace.

### Agent Assets

Agent Assets inspect workspace-scoped instruction/config files without opening Explorer.

Supported providers include Claude, Codex, Gemini, Cursor, Kiro, opencode, and shared MCP assets. Common files such as `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules`, `.claude/skills`, `.kiro`, `.gemini`, `.opencode`, and `.mcp.json` are grouped by provider.

Editable files are saved with workspace path checks and backup behavior. Tool settings, skills, subagents, and most generated folders remain read-only in the UI.

### Input Assets

Input Assets store user-provided materials under `.wincmux/input-assets` so you can send a path-based prompt instead of dumping large payloads into a terminal.

Supported inputs:

- long pasted text, detected at about `2KB` or `20` lines
- clipboard images
- imported image files

Text assets are saved under `.wincmux/input-assets/snippets/`. Image assets are saved under `.wincmux/input-assets/images/`; imported images keep their extension, and clipboard images are saved as PNG.

`Save + Insert`, `Insert`, and `Copy` use a short work prompt that points at the saved file. `Path` inserts only the file path.

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

`.wincmux/` is ignored by the repository, and each workspace input asset store creates its own `.wincmux/.gitignore` for `input-assets/`.

### Notifications

WinCMux watches assistant output and creates unread notifications when Claude/Codex responses appear complete. Notifications are grouped by workspace and mirrored to Windows toast/taskbar badge when supported.

## Repository Layout

```text
WinCMux/
├── apps/desktop/      # Electron main, preload, renderer
├── packages/core/     # JSON-RPC core, SQLite, node-pty, layout/session engine
├── bridge/            # Protocol notes and schemas
├── infra/             # Config and migrations
├── scripts/           # Development helpers
├── assets/            # Screenshots and app assets
└── legacy-dotnet/     # Old reference implementation
```

## Development Checks

Useful checks before pushing:

```bash
npm --workspace @wincmux/core run test -- --run
npm --workspace @wincmux/core run build
npm --workspace @wincmux/desktop run check:renderer
npm --workspace @wincmux/desktop run lint
npm run build
```

`check:renderer` can print line-count warnings for large renderer files. Treat syntax or build failures as blocking; line-count warnings are informational.

## Packaging

```bash
npm run package:win
```

This builds an NSIS setup wizard at:

```text
apps/desktop/dist/WinCMux-Setup-<version>.exe
```

The packaged app starts the WinCMux core process automatically. The installer includes the core runtime files and native terminal/database dependencies required by `node-pty` and `better-sqlite3`, so the desktop app can create the `\\.\pipe\wincmux-rpc` JSON-RPC pipe without a separate terminal.

Before publishing a setup file, verify the packaged runtime:

```bash
npm run lint
npm run package:win
```

Then launch `apps/desktop/dist/win-unpacked/WinCMux.exe` and confirm that workspace creation works. Core startup should also be visible in `%LOCALAPPDATA%\WinCMux\logs\core.log`.

## Runtime Paths

| Item | Default |
|---|---|
| Database | `%APPDATA%\WinCMux\wincmux.db` |
| Performance log | `%LOCALAPPDATA%\WinCMux\logs\perf.jsonl` |
| Main process log | `%LOCALAPPDATA%\WinCMux\logs\main.log` |
| Core process log | `%LOCALAPPDATA%\WinCMux\logs\core.log` |
| Named pipe | `\\.\pipe\wincmux-rpc` |

If the status bar shows `Error: connect ENOENT \\.\pipe\wincmux-rpc`, the desktop process could not connect to the core RPC pipe. Check `main.log` and `core.log` first; they record the core entrypoint, runtime command, startup output, and crash/respawn details.

## Recent Runtime Improvements

- Terminal output is flushed through xterm sequentially so large command output does not pile up overlapping writes.
- Renderer output buffering uses chunk queues instead of repeated string concat/slice, reducing copy and GC pressure during high-volume terminal output.
- Renderer pane output queues consume chunks with a head pointer instead of repeated array shifts, keeping multi-terminal bursts cheaper to drain.
- Renderer pane output draining returns single queued chunks directly when possible, avoiding per-write array allocation and joins on the common terminal output path.
- Workspace/pane tail restore now uses a linear overlap scan when deduplicating live stream output, reducing UI stalls after screen switches.
- Notification stream UI updates are coalesced into one animation-frame refresh so bursts do not repeatedly re-render sidebars and pane badges.
- Terminal output normalization skips regex replacement unless malformed escape markers are present, reducing per-chunk renderer/core detector work.
- The notification list no longer re-renders on scroll, avoiding unnecessary DOM rebuilds while terminals are active.
- Persistent stream sockets are closed when their renderer webContents is destroyed, avoiding stale stream sends after window lifecycle changes.
- Pane overflow, pane group, quick command, session picker, and hidden-pane popovers render through high-priority body-level portals, move to the active top layer when opened, and clamp both size and position to viewport bounds so compact panes and split boundaries do not clip or squeeze the UI.
- Popovers and modal overlays now use shared z-index layers so session pickers, workspace info, shortcuts, and input asset prompts stay above terminal panes and do not sit behind stale pane menus.
- Assistant prompt notifications suppress Codex/npm update logs that mention pressing enter, avoiding repeated false native toasts during CLI updates.
- Pane binding refresh indexes unread notifications and known sessions once per refresh instead of rescanning them for every pane.
- Core stream events are serialized once per emit and sent once per socket, avoiding duplicate output when subscriptions overlap.
- Renderer terminal output flushes now use a shared frame queue with a per-frame pane budget, preventing many panes from writing to xterm in the same frame.
- The renderer output flush queue prioritizes the selected pane within each frame budget so the pane under active attention is less likely to sit behind background output bursts.
- Notification target parsing is cached per notification row and reused during workspace, notification, and pane badge renders.
- Renderer notification refresh builds shared workspace/pane/session unread maps once per notification array and reuses them across workspace badges, notification grouping, and pane badges.
- Pane binding refresh now keeps a per-pane visible-state signature and skips unchanged DOM writes, session rebinds, and action layout measurement during repeated refreshes.
- Workspace switches load unread notifications without immediately rebuilding pane bindings, then fold the unread UI update into the main pane refresh when it is ready.
- Renderer IPC now skips unchanged active-context and unread-badge updates, reducing repeated preload/main round trips during pane selection, focus changes, and notification refreshes.
- Pane selection skips redundant layout focus persistence for the already-selected pane and avoids scanning notifications when cached pane/session unread counts are zero.
- Pane move hover and selection styling now update only changed cards when possible, avoiding full pane-card class churn on high-frequency pointer moves.
- Renderer performance logs are batched before IPC/file append so high-frequency input flush metrics do not add per-keystroke IPC overhead.
- Deferred live stream output collected during tail restore now uses a bounded chunk queue, avoiding repeated string concat/slice while panes reconnect or screens switch.
- Interactive terminal input now uses a token-guarded microtask flush for zero-delay key/Enter writes, reducing per-keystroke IPC start latency while preserving timer batching for paste-sized input.
- Fast interactive input perf logs are summarized per pane/session while slow, failed, or paste-sized writes still emit detailed rows, reducing hot-path log churn without losing spike visibility.
- Desktop log paths are cached after the first lookup so perf/main/core log appends avoid repeated directory resolution during active terminal use.
- Core assistant prompt detection now caches confirmed assistant context per session and reuses module-level marker checks, avoiding repeated buffer-wide context regex work on every output batch.
- Renderer `session.output` handling now routes through a direct visible-session output fast path, avoiding per-event option objects and duplicate pane lookup work on high-volume terminal streams.
- Electron main stream batching now stores merged `session.output` payloads as chunks and joins once before IPC send, avoiding repeated large-string copies during bursty terminal output.
- Renderer output enqueue avoids redundant hidden-overlay DOM writes and summarizes queue-drop perf logs during sustained output overload, reducing UI-thread churn while preserving overload visibility.
- Main-to-renderer stream events are batched over a short IPC window, and adjacent output for the same session is merged before delivery to reduce Electron IPC wake-ups under multi-terminal load.
- Renderer stream output routing now uses cached session-to-pane lookup maps, avoiding a pane scan for every output event while keeping stale cache validation.
- Cached stream output routing now uses a fast session/view check on hits and reserves DOM attached validation for lookup rebuilds, reducing per-output event DOM work.
- Renderer session refresh builds reusable running-session indexes, avoiding repeated filter/find/map scans during pane binding, group badges, hidden panes, and prompt fallback checks.
- Renderer prompt fallback detection now uses a cheap fast-path probe before ANSI stripping and prompt regex scans, so generic command output does not pay detector costs when the fallback is enabled.
- Main/core socket line parsing now advances with a cursor and slices only the remaining tail once per chunk, reducing string copies while routing JSON-RPC and stream traffic.
- Renderer fallback polling now schedules the next `session.read` only after the previous read settles, staggers panes with stable jitter, and accelerates after input so non-stream mode avoids synchronized read spikes without feeling sluggish.
- Renderer IME textarea binding now uses focus and a targeted mutation observer instead of a per-pane 800ms timer, preserving Korean composition handling while removing idle DOM polling across many terminals.
- Renderer PTY resize sync now uses a shared queue with a per-frame pane budget, so split, equalize, and window resize changes do not send resize RPC bursts for every pane at once.
- Split-pane divider dragging now batches flex updates through `requestAnimationFrame`, reducing layout churn while panes are being resized.
- Core stream fan-out indexes subscriptions by topic plus workspace/session scope, so session output is routed to matching sockets without scanning every subscription on each batch.
- Core AI resume detection now probes the current output batch before copying the recent tail buffer, avoiding tail joins for ordinary shell output while still catching split resume markers.
- Core prompt/completion detection now inspects only the tail of large output batches before ANSI normalization, preserving end-of-output prompts while avoiding full-batch scans during huge terminal bursts.
- Core drain/tail output buffers also use bounded chunk buffers, avoiding repeated string concat/slice while PTY output is still arriving.
- Core stream batches use a shorter flush delay and flush immediately for large output bursts to lower interactive latency.
- Core notification/resume detectors run on stream batches and skip generic shell output with a fast-path filter, reducing regex work across many terminals.
- Terminal input flushing is adaptive: Enter, escape/control sequences, and small interactive keystrokes flush immediately while large paste payloads still batch briefly.
- Default Windows shells start with profile/AutoRun work disabled (`pwsh`/PowerShell `-NoProfile`, `cmd.exe /d`) while custom commands remain available for users who need profile-driven setup.
- Session startup latency is recorded in the performance log so shell startup changes can be measured instead of guessed.
- Background git status refresh now backs off during recent terminal input/output and runs one workspace check at a time to avoid competing with active terminals.
- Pane fitting and resize work is coalesced with `requestAnimationFrame` to reduce repeated layout measurement while resizing panes or sidebars.
- Workspace/group switches now route stream output only to the visible pane bound to that session, and tail restore deduplicates live output that arrives during the restore window.
- Terminal fit/resize now skips detached or zero-size pane hosts, avoids duplicate PTY resize RPCs for unchanged cols/rows, and retries only after layout is measurable.
- The workspace folder picker fills an empty workspace name from the selected folder name while preserving manually typed names.
- Packaged builds now avoid bundling stale `dist/win-unpacked` output into `app.asar`.
- NSIS setup builds use the standard installer wizard (`oneClick=false`) and include the packaged core runtime resources.

## Roadmap

See [ROADMAP_NEXT.md](ROADMAP_NEXT.md).

## License

MIT
