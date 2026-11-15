# Architecture

WinCMux 0.2.0 has two independently-lived executables. `wincmux-tauri.exe` hosts WebView2, xterm.js, Korean input, clipboard and dialogs. `wincmux-core.exe` owns ConPTY, SQLite, bounded output, terminal screen state, agent detection, notifications and the native Windows tray. The core links no Tauri, WebView2 or Node runtime.

The Rust runtime package is in `apps/desktop-tauri/src-tauri/runtime`. The desktop forwards the existing `window.wincmux` commands to a persistent newline-delimited JSON-RPC named pipe. Request IDs match replies; disconnects fail pending requests without replaying writes or launches. Events use one bounded core subscription and local desktop filters. A UI verifies both protocol/version and the canonical data directory before attaching; a same-version pipe owned by another data directory is an error. Debug desktops use `%APPDATA%\WinCMux-Tauri-dev` and `wincmux-tauri-rpc-dev` by default. UI output events carry availability offsets, and the renderer pulls bounded output batches.

The core owns the only SQLite connection. A SID/data-directory mutex prevents duplicate owners. Schema 8 adds hidden-session metadata. Existing databases receive an online SQLite `pre-v8-<id>.bak` backup before migration. Attaching another UI does not reopen the database or mark live sessions exited. A new core marks the old runtime's sessions exited and offers manual restoration.

Terminal snapshots contain both buffers, cursor, colors and supported input modes, plus bounded scroll history and an atomic output offset. The vendored MIT-licensed vt100 0.18.1 extension is documented in its `WINCMUX.md`. Snapshot application blocks input and resize; later bytes resume from the snapshot offset. If retained output wraps during restoration, the client requests a fresh snapshot. Device queries are answered by the core, including without a UI.

| Resource | Limit / lifetime |
|---|---|
| Raw output | 600,000 bytes per session |
| Parsed scroll history | 256 KiB per session |
| Screen allocation | At most 32,768 cells per buffer; conservative 8 MiB state budget |
| Ended session retention | At most eight sessions; expires after 30 seconds |
| Event queue | 64 events per connection; disconnect on overflow or a three-second blocked write |
| Unused core | Stops after 30 seconds with no attached UI and no live terminal |

Closing the window ends the UI and its WebView2 profile processes. It does not close terminal sessions. The core's job object owns its children; a core crash ends those children. A UI opened from the tray starts outside that job. Reboot, logoff, core replacement and full process survival across installation are not supported.

| Item | Default |
|---|---|
| Database | `%APPDATA%\WinCMux-Tauri\wincmux.db` |
| Named pipe | `\\.\pipe\wincmux-tauri-rpc` |
| Installer reservation | `<data directory>\update.lock`, 60-second lease |
| Input assets | `<workspace>\.wincmux\input-assets\` |

Core startup checks the installation reservation. The installer's embedded helper refuses preparation while terminals run; otherwise it requests orderly UI/core shutdown before copying files. POSTINSTALL/POSTUNINSTALL release the reservation. An abandoned reservation expires after 60 seconds. The current-user pipe ACL and remote-client rejection remain enabled.

[Features](features.md) · [Bridge](../bridge/API.md) · [Evaluation](evaluation.md)

For local development, end the development core and its jobs before rebuilding its executable on Windows. Running core binaries cannot be overwritten; the build must never terminate them implicitly.

Installed notifications use a UUID-only `wincmux://notification/<id>` URI. The installer registers its command for the current user and removes only its own association on uninstall. Windows can therefore reopen the desktop after an idle core has exited; the desktop retrieves the saved notification through the new core. Unpackaged builds retain the live-process callback.
