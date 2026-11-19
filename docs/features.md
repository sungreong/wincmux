# Features

| Area | WinCMux capabilities |
|---|---|
| Workspaces | Create, describe, pin, reorder, and inspect Git status |
| Panes and groups | Split, resize, focus, move, swap, hide, and reattach terminals |
| Terminal | Windows ConPTY, UTF-8 output, scrollback, clipboard shortcuts, and wrapped URL copy |
| SSH and Docker | Import Windows SSH aliases or enter a host manually. Open running containers in separate tabs and view files or Git changes in the selected folder |
| Korean input | WebView2 text editor with IME composition handling and draft insertion |
| Session history | Reopen recorded commands and resume detected Codex and Claude conversations |
| Agent status | Explicit OSC 7501 reports take priority over text detection; pane badges show approval needs, work, unacknowledged results, acknowledgement, errors, and uncertainty; workspace summaries count attention and activity |
| Notifications | Detect input requests, completions, and usage limits in local, SSH, and Docker workspaces. Open the associated live pane from an alert |
| Agent assets | Inspect supported workspace configuration and edit allowlisted text instructions |
| Input assets | Save and reuse text snippets and clipboard or imported images |
| Integrations | Open the workspace in Explorer or VS Code and use the local JSON-RPC bridge |

## Terminal shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+Alt+Enter | Open the prompt editor |
| Ctrl+Enter | Submit the draft when ready or queue it while the agent is working |
| Ctrl+Alt+Q | Close the focused pane |
| Ctrl+C | Copy selected terminal text or send an interrupt without a selection |
| Ctrl+Shift+C | Copy selected terminal text |
| Ctrl+/ | Show keyboard shortcuts |

## Agent result acknowledgement

A completed result stays marked **완료 · 미확인** until you select its pane with terminal focus or click its status badge while the app has focus. Completion arriving in an already selected pane remains unacknowledged until that action. Background layout refreshes do not acknowledge results. Approval requests stay blocked until the program reports progress or the text detector observes a new submitted turn. Hover over the badge for detection source and reason. Output silence alone does not mean completion.

Programs can explicitly report status with OSC 7501; programs that do not report it continue using text detection. No changes to agent configuration are installed automatically. Live states reset with terminal processes; notifications retain their existing persistence.

## Background work (0.2.0)

Choose **Close window** from the main window's exit dialog to keep local Windows shells and hidden panes running. Open WinCMux again to reconnect. The Windows tray can reopen WinCMux or end local work after confirmation. A core with no screen, terminals, or pending reminders exits after 30 seconds. SSH and Docker terminal connections are managed by their workspace windows.

Approvals and completions still produce Windows notifications without WebView2. Clicking a notification opens its workspace and restores a hidden terminal when needed. Reconnecting does not acknowledge unread results. A disconnected screen blocks input until it reconnects; uncertain writes are not automatically repeated.

The installer and uninstaller refuse to proceed while terminals are alive. Finish the jobs and close their shells, or explicitly end all work, before updating/removing WinCMux. Sleep and network loss do not replace the runtime, but Windows restart/logoff and core crashes end its processes. Resume recorded agent conversations manually after a fresh core starts.
