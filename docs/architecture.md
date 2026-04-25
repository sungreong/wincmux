# Architecture and IPC Notes

This document records the detailed implementation and integration notes that are too heavy for the top-level README.

## High-Level Architecture

```text
Electron Renderer (UI)
    └── IPC (contextBridge)
Electron Main Process
    ├── Named Pipe JSON-RPC client (auto-retry + core respawn on ENOENT)
    ├── Persistent stream sockets (session events / notify events)
    ├── Workspace Agent Assets scanner/editor IPC (provider registry + path safety)
    ├── Workspace Input Assets store (long paste snippets + clipboard/imported images)
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
    ├── Pane Session Binding (persist pane-session across restarts)
    └── SQLite Storage (schema v7 with auto-migration)
```

## Repository Layout

```text
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

## Runtime Paths

| Item | Default |
|---|---|
| Database | `%APPDATA%\WinCMux\wincmux.db` |
| Logs | `%LOCALAPPDATA%\WinCMux\logs` |
| Named pipe | `\\.\pipe\wincmux-rpc` |
| Workspace input assets | `<workspace>\.wincmux\input-assets\` |

## JSON-RPC Methods Used by Desktop

| Method | Purpose |
|---|---|
| `session.tail` | Restore recent terminal output without draining the polling buffer |
| `layout.swap` | Swap two leaf pane positions |
| `layout.move` | Move a leaf pane above/below/left/right of another leaf pane |
| `group.list`, `group.create`, `group.rename`, `group.delete` | Manage workspace pane groups |
| `session.group.set`, `session.group.list` | Persist session-to-group bindings |

## Desktop IPC Surface

| Channel | Purpose |
|---|---|
| `agentAssetsScan(workspacePath)` | Scan workspace agent assets by provider/category |
| `agentAssetRead(workspacePath, relativePath)` | Read a safe workspace-confined asset preview |
| `agentAssetWrite(workspacePath, relativePath, content)` | Save an editable asset with validation and `.bak` backup |
| `agentAssetCreate(workspacePath, relativePath, templateKind)` | Create a safe instruction/rule/command asset from a template |
| `agentAssetReveal(workspacePath, relativePath)` | Reveal a scanned asset in Explorer |
| `inputAssetsList(workspacePath)` | List saved long-paste snippets and imported images |
| `inputAssetCreateText(workspacePath, payload)` | Save a text snippet under `.wincmux/input-assets` |
| `inputAssetCreateImage(workspacePath, payload)` | Save a clipboard image under `.wincmux/input-assets/images` |
| `inputAssetImportFile(workspacePath, payload)` | Copy an image file into the workspace input asset store |
| `inputAssetPickFile(workspacePath)` | Pick and import an image file |
| `inputAssetRead(workspacePath, assetId)` | Read snippet content or image preview data |
| `inputAssetRename(workspacePath, assetId, title)` | Rename a saved input asset |
| `inputAssetDelete(workspacePath, assetId)` | Delete a saved input asset and index entry |
| `inputAssetReveal(workspacePath, assetId)` | Reveal a saved input asset in Explorer |
| `clipboardReadImage()` | Read the current clipboard image for paste-to-asset flow |

## Input Asset Storage Notes

- The main process validates workspace paths before reading or writing.
- Input asset paths are confined to `.wincmux/input-assets`.
- Text snippets are capped by `INPUT_ASSET_MAX_TEXT_BYTES`.
- Image assets are capped by `INPUT_ASSET_MAX_IMAGE_BYTES`.
- Supported imported image extensions: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`.
- Clipboard images are normalized to PNG via Electron `nativeImage`.
- `index.json` tracks asset metadata and is rewritten atomically via a temporary file.
- Each workspace `.wincmux/.gitignore` ignores `input-assets/`.
- The repository root `.gitignore` ignores `.wincmux/` for local test assets.

## Notification Flow Notes

- The renderer keeps unread notification state grouped by workspace.
- The main process can mirror unread state to Windows toasts and taskbar badge icons.
- Toast click events navigate back to workspace/pane/session when enough target metadata is present.
- Prompt detection handles explicit Claude/Codex ready prompts and idle fallback.

## Development Checks

Use these before merging behavioral changes:

```bash
npm --workspace @wincmux/core run test -- --run
npm --workspace @wincmux/core run build
npm --workspace @wincmux/desktop run check:renderer
npm --workspace @wincmux/desktop run lint
npm run build
```
