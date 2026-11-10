# Architecture

The desktop app lives in `apps/desktop-tauri`. Tauri serves the local xterm.js renderer in WebView2 and exposes the `window.wincmux` adapter for desktop commands and events.

| Layer | Responsibility |
|---|---|
| WebView2 and xterm.js | Pane layout, scrollback, input, Korean prompt editor, and selection/copy |
| Tauri IPC | Desktop commands, clipboard, dialogs, Windows notifications, and output availability events |
| Rust and ConPTY | Session lifecycle, UTF-8 stream decoding, terminal history, and prompt and resume detection |
| SQLite | Workspaces, layouts, pane bindings, groups, sessions, and notifications |
| Windows named pipe | Local JSON-RPC access for external clients |

The renderer reads output in bounded batches and advances its byte position after xterm parses each batch. Reopened panes can continue from the saved position. If a pane falls outside its session's 600,000-byte retention window, it displays a gap notice.

The Rust core uses a dedicated ConPTY reader and answers the startup cursor query even if a pane has yet to attach. The local JSON-RPC pipe accepts the current Windows user and SYSTEM.

| Item | Default |
|---|---|
| SQLite database | `%APPDATA%\WinCMux-Tauri\wincmux.db` |
| Performance logs | `%APPDATA%\WinCMux-Tauri\logs` |
| External pipe | `\\.\pipe\wincmux-tauri-rpc` |
| Input assets | `<workspace>\.wincmux\input-assets\` |

The database retains the existing schema through version 7. Copy a previous database with both apps closed. WebView2 stores its UI preferences separately.

[Features](features.md) · [Bridge](../bridge/README.md) · [Evaluation](evaluation.md)
