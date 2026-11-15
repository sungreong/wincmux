# Features

| Area | WinCMux capabilities |
|---|---|
| Workspaces | Create, describe, pin, reorder, and inspect Git status |
| Panes and groups | Split, resize, focus, move, swap, hide, and reattach terminals |
| Terminal | Windows ConPTY, UTF-8 output, scrollback, clipboard shortcuts, and wrapped URL copy |
| Korean input | WebView2 text editor with IME composition handling and draft insertion |
| Session history | Reopen recorded commands and resume detected Codex and Claude conversations |
| Agent status | Explicit OSC 7501 reports take priority over text detection; pane badges show approval needs, work, unacknowledged results, acknowledgement, errors, and uncertainty; workspace summaries count attention and activity |
| Notifications | Detect prompts and completions, display Windows notifications and a taskbar indicator, and open the associated session |
| Agent assets | Inspect supported workspace configuration and edit allowlisted text instructions |
| Input assets | Save and reuse text snippets and clipboard or imported images |
| Integrations | Open the workspace in Explorer or VS Code and use the local JSON-RPC bridge |

## Terminal shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+Alt+Enter | Open the prompt editor |
| Ctrl+Enter | Paste and submit the editor draft, or submit existing terminal input when the editor is empty |
| Ctrl+C | Copy selected terminal text or send an interrupt without a selection |
| Ctrl+Shift+C | Copy selected terminal text |
| Ctrl+/ | Show keyboard shortcuts |

## Agent result acknowledgement

A completed result stays marked **완료 · 미확인** until you select its pane with terminal focus or click its status badge while the app has focus. Completion arriving in an already selected pane remains unacknowledged until that action. Background layout refreshes do not acknowledge results. Approval requests stay blocked until the program reports progress or the text detector observes a new submitted turn. Hover over the badge for detection source and reason. Output silence alone does not mean completion.

Programs can explicitly report status with OSC 7501; programs that do not report it continue using text detection. No changes to agent configuration are installed automatically. Live states reset with terminal processes; notifications retain their existing persistence.

## Background work (0.2.0)

Close the window or press Alt+F4 to exit the screen app while retaining every live terminal, including plain shells and hidden panes. Open WinCMux again to reconnect. The Windows tray shows live terminals and requests for input; it can reopen WinCMux or end all work after confirmation. The toolbar also has **완전히 종료**. A core with no screen and no terminals exits after 30 seconds.

Approvals and completions still produce Windows notifications without WebView2. Clicking a notification opens its workspace and restores a hidden terminal when needed. Reconnecting does not acknowledge unread results. A disconnected screen blocks input until it reconnects; uncertain writes are not automatically repeated.

The installer and uninstaller refuse to proceed while terminals are alive. Finish the jobs and close their shells, or explicitly end all work, before updating/removing WinCMux. Sleep and network loss do not replace the runtime, but Windows restart/logoff and core crashes end its processes. Resume recorded agent conversations manually after a fresh core starts.
