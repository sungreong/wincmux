# WinCMux

[한국어](README.kr.md) · [Windows builds](../../actions) · [Performance evaluation](docs/evaluation.md)

WinCMux is a Windows terminal workspace for Codex CLI, Claude Code, PowerShell, and other CLI tools. It uses Tauri, WebView2, xterm.js, and a Rust core built on Windows ConPTY. The installed app runs its core without Node.js.

![WinCMux Tauri 0.2.1 with two terminal panes and the bottom prompt editor](assets/view.png)

*WinCMux terminal workspace with sample terminal output.*

- Run independent terminals in split panes and organize them into workspaces and groups. Hide and reattach running panes.
- Write in the editor below the selected pane. Drafts follow each pane through selection and splitting. Press **Ctrl+Enter** or **바로 전송** to paste and submit. Use **확장** or **Ctrl+Alt+Enter** to open the larger editor.
- Select a wrapped URL and press **Ctrl+C** to copy one address. Ordinary multiline selections retain their line breaks.
- Reopen recorded sessions, resume Codex and Claude conversations, receive Windows notifications, and manage workspace instructions, text snippets, and images.

![WinCMux Korean prompt editor with a multiline draft](assets/prompt-editor.png)

**바로 전송** and **Ctrl+Enter** preserve line breaks and send a separate Enter to submit. **삽입만** only pastes the draft. With an empty editor, **터미널 제출** submits the terminal's existing input. Choose **한 줄로 삽입** followed by **터미널 제출** for sessions that require a single line.

## What's new in 0.2.1

The desktop and execution core now have independent lifetimes. **Closing the window ends the UI**, while `wincmux-core.exe` keeps shells, agents and development servers running. Reopening reconnects to the same jobs and terminal screen. Dedicated WebView2 processes are released while the UI is closed.

| Situation | Behavior |
|---|---|
| Close window, Alt+F4, or UI crash | Live terminal jobs continue |
| Reopen | Restore sessions, screens, hidden terminals and unread results |
| Approval needed or task completed | Native notifications and tray state; click to return to the task |
| No UI and no live terminals | Core exits after 30 seconds |
| **완전히 종료** (fully quit) | Confirm the live-terminal count, then end all jobs |
| Install/update/uninstall with live jobs | Stop installation/removal instead of killing jobs |

Reboot, logoff and a core crash do not preserve processes. A new core marks prior jobs exited; command or conversation resumption remains an explicit user choice.

The UI uses semantic design tokens, a 4px spacing scale and shared radii. Read-only agent states are distinct from result acknowledgement buttons. Optional guidance is folded into help and tooltips. See the [design review and component rules](docs/ui-design.md).

<details>
<summary>Compact layout — 1100×760</summary>

![WinCMux compact layout with separate status and action areas](assets/view-compact.png)

</details>

## Verify background execution

1. Run this in a WinCMux PowerShell terminal and note the initial PID:

   ```powershell
   $PID
   while ($true) {
     Get-Date -Format 'HH:mm:ss'
     Start-Sleep 2
   }
   ```

2. Close the window using X. In Task Manager → Details, verify that `wincmux-tauri.exe` exits while `wincmux-core.exe` and that PowerShell PID remain.
3. Reopen after ten seconds. Output should include the time while the UI was closed. Press `Ctrl+C`; `$PID` should still match.
4. To check UI-crash recovery, terminate **only `wincmux-tauri.exe`** and repeat.

Automated checks cover normal/forced UI exit, hidden sessions, notification navigation, normal/alternate screen restoration and update protection. The three-run comparison measured a median 10.35MiB increase in combined app/core memory with six panes. The native background core used 6.94MiB with six test terminals and 0.155% CPU over 60 idle seconds. These figures exclude the actual Codex/Claude workload. See [conditions, results and limits](docs/background-core-evaluation.md).

## Earlier Electron → Tauri migration

In two runs on the same Windows PC, the x64 installer went from **95.61 MiB** to **3.66 MiB**. With six panes, app and core private memory went from **491–504 MiB** to **391 MiB**, and selected-pane input round-trip P95 went from **16.0–16.3 ms** to **10.1–11.3 ms**. Both builds preserved Korean, repeated spaces, and all **18,000 output lines** in the test. See the [measurement setup and limits](docs/evaluation.md).

See the [background-core evaluation](docs/background-core-evaluation.md) for the three-run runtime comparison and the [0.2.1 UI review](docs/ui-design.md) for the current design changes.

## Develop on Windows

Install Node.js 20 or later, Rust with the MSVC toolchain and rustfmt, Visual Studio C++ Build Tools, and WebView2.

```powershell
npm ci
npm run dev
npm run lint
npm test
npm run package:win
npm run test:ui
npm run test:runtime
npm run test:lifecycle
```

The x64 installer is generated under `apps/desktop-tauri/src-tauri/target/release/bundle/nsis/`. The UI smoke test uses the packaged build's executable and an isolated WebView2 profile.

The database lives at `%APPDATA%\WinCMux-Tauri\wincmux.db`. To carry over a previous SQLite database, close both apps and copy it to that location. The Electron source is available at tag [v0.1.0](../../tree/v0.1.0).

[Architecture](docs/architecture.md) · [Features](docs/features.md) · [JSON-RPC bridge](bridge/README.md)

Windows background runtime: closing the window keeps live terminals running. Reopen to reconnect; use **완전히 종료** or the tray menu to end all jobs. Finish running terminals before installing or uninstalling an update. See [architecture](docs/architecture.md).

## References

See [references and their implementation scope](docs/references.md) for Herdr, Fluent 2, Tauri and terminal-state sources.
