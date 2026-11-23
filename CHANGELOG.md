# Changelog

[README](README.md) · [GitHub Releases](https://github.com/sungreong/wincmux/releases)

## 0.2.134 — Agent commands and skills

- Run Claude Code and Codex CLI commands such as `/goal` directly from the local, SSH, or Docker composer when the agent prompt is empty and ready. Commands bypass the follow-up queue.
- Save, select, and remove custom commands per agent. Plain-message mode prevents leading `/` or `$` text from executing as a command.

## 0.2.133 — Docker and SSH workspace hooks

- Register Claude Code and Codex hooks in Linux and macOS Docker or SSH workspace folders after an on-launch prompt. Preserve existing settings and avoid duplicate handlers.
- Bind remote hook signals to the active terminal with a per-session token, feeding working, approval, and completion states into notifications. Continue using terminal output detection until hooks arrive.
- Run remote agent installation as a shell startup command and show elapsed time and the final exit result, including for slow Docker installs.

## 0.2.132 — Shared Docker and remote workspace controls

### Release summary since 0.2.105

- Check workspace hooks for Claude Code and Codex and offer registration on launch. Fall back to terminal output detection when hooks are absent, and show a copyable troubleshooting prompt on registration failure.
- Expand SSH and Docker agent launch, conversation history, shell input, and pane controls. Expose relevant configuration files in the local and remote file viewers.
- Search Docker containers by number, name, or image and select them by number key or Enter. Align SSH folder closing and local and remote notification controls.
- Add language switching, terminal output search and link opening, optional WebGL rendering, and shared UI rules in `UI-GUIDE.md`.

- Separate container numbers and names in the Docker picker and search results while keeping their keyboard selection in sync.
- Add the existing close-tab flow to SSH folders, leaving the SSH connection open after the last folder closes.
- Size local and remote notification controls for counts and document shared UI rules in `UI-GUIDE.md`.

## 0.2.131 — Faster Docker container selection

- Number containers consistently in the dropdown and search dialog. Select by number key, open search with `/`, or enter a number and press Enter.
- Keep name and image search and match the compact spacing used by remote workspace controls.

## 0.2.130 — Compact notification controls

- Keep only the bell button wide enough for its count, restoring standard widths for reminder and conversation buttons.

## 0.2.129 — Notification count placement

- Place the notification count beside the bell and give the notification, reminder, and conversation controls equal widths.

## 0.2.128 — Notification toolbar alignment

- Align notification, reminder, and conversation buttons in equal cells and keep the notification count inside its button.
- Complete English translations for the agent hook registration prompt.

## 0.2.127 — Hook registration on agent launch

- Check workspace hooks before launching Claude Code or Codex and ask whether to register them.
- Use terminal output detection when registration is skipped; show an error and copyable troubleshooting prompt if registration fails.
- Remove excess space between agent settings and the file list in the viewer.

## 0.2.126 — Workspace agent hooks and settings

- Register Claude Code and Codex hooks per local workspace, connecting working, approval, and completion states to notifications and queued input.
- Browse each workspace's Codex and Claude settings, hooks, and instruction files in dedicated file viewer tabs, with hook status and registration controls.
- Register hooks before launching agents through MCP and fix Codex hook commands on Windows.

## 0.2.125 — Favorite star alignment

- Keep the favorite star in a fixed position to the right of each workspace name, using filled and outlined states as the toggle.
- Remove the duplicate star before the name and from the expanded action row. The ellipsis row now contains rename, information, and delete.

## 0.2.124 — Workspace row layout

- Move workspace actions into an expandable row opened by the ellipsis button, keeping names clear at narrow sidebar widths.
- Place the running indicator beside the path and check title, unread badge, and action spacing at 220, 260, and 320 px.

## 0.2.123 — Workspace navigation

- Search workspace names, paths, and branches; filter by favorites, running terminals, and unread notifications; sort by default order, recent use, or name.
- Refine single-line, summary, and detail views. Detail view expands the selected workspace's path, running count, and last-used time.
- Page through 15/30/50 workspaces while keeping same-name folder groups together, with a shortcut back to the current workspace.

## 0.2.122 — Single-row icon toolbar

- Replace mixed text and character buttons with consistent SVG icons, grouped on one toolbar row. Tooltips and accessible names identify each action.
- Move the main terminal font scale control into Display settings. Use icon buttons for Display settings and disconnect in SSH and Docker windows.

## 0.2.121 — Korean and English interface

- Add a persistent Korean/English selector in **Display settings** in the main, Docker, and SSH windows, synchronized across open windows.
- Translate fixed interface labels and common pane, session, and conversation controls through a shared catalog. Terminal output, file contents, commands, and user data remain untouched.

## 0.2.120 — Terminal output search

- Search each local Windows, Docker, and SSH pane's scrollback using the toolbar button or Ctrl+F in the terminal. Enter and Shift+Enter move through matches.
- Show match counts and a case sensitivity option. Esc closes search without sending input to the running process.

## 0.2.119 — Docker and SSH pane groups

- Add and switch pane groups within each workspace while keeping terminals running in other groups.
- Hide and restore live panes, move panes between groups, and use split, placement, and equalize within a group.

## 0.2.118 — Docker queued input delivery

- Route **Send now** from the local Docker window to its terminal handler instead of rejecting the action.
- Keep a completed Claude turn ready when ordinary answer text asks a question, so queued followups can proceed.

## 0.2.117 — Docker and SSH conversation history

- Docker and SSH workspaces list Claude Code and Codex conversations stored in that environment, with project scope, search, date and provider filters, sorting, pagination, compact view, favorites, and hiding.
- Resume a selected conversation in a new terminal at its original folder, or open the CLI's own resume picker. Transcript files remain read-only. Remote history lookup requires Python 3 in that environment.

## 0.2.116 — Korean input for local, Docker, and SSH shells

- Plain Docker and SSH shell panes now include a command input that supports Korean composition. Ctrl+Enter or the Run button sends a single line without treating an IME confirmation as execution.
- Agent panes that return to a shell gain the same input. Failed commands remain in the field for correction.
- Local shell panes now have the same per-pane input, so Korean commands can be entered and run with Ctrl+Enter or Run.

## 0.2.115 — Installed CLI paths and immediate remote followups

- Docker and SSH shells and agent processes now include `~/.local/bin` in `PATH`, so freshly installed Codex can be called by name. The install command also updates the current shell's `PATH` before checking the version.
- Remote Claude Code, Codex, and Gemini queues now offer **Send now** for a selected pending message, ahead of its queue order or scheduled time.
- A queued message pasted into the visible agent composer now submits even if the agent's inferred state changes between paste and Enter.
- In Docker and SSH terminals, Ctrl+C copies a selection; with no selection, it keeps its interrupt behavior.

## 0.2.114 — Codex login in remote terminals

- Docker and SSH Codex panes check existing credentials and use device code login when needed, avoiding an unreachable browser callback on the container's localhost.
- If device code login fails, the pane returns to a shell with guidance to enable it in account settings.

## 0.2.113 — Return to shell after remote agent exits

- Docker and SSH panes now stay interactive after Claude Code, Codex, or Gemini exits, switching the same terminal pane to a shell.
- Pending agent followups are canceled instead of running as shell commands. An unsent draft remains available for copying.

## 0.2.112 — Side-by-side remote file viewer

- SSH and local Docker file viewers now keep the file or Git list in a left sidebar and show selected content beside it. Search results use the same preview area, and the selected file stays highlighted in the list.

## 0.2.111 — Docker shell filename completion

- New local and SSH-hosted Docker shell panes now start Bash when the container has it, enabling Tab filename completion. Containers without Bash still open their available `sh` shell.

## 0.2.110 — Optional WebGL terminal rendering

- Added a WebGL switch in Terminal display settings for local, SSH, and Docker terminals. It defaults to off, applies to open panes without restarting sessions, and persists across app windows.
- When WebGL is unavailable or its context is lost, affected panes return to the built-in renderer. Disabling WebGL releases the active GPU context.

## 0.2.109 — Open terminal links in browser and arrange remote panes

- Terminal URLs now use the Windows Shell `open` action, which dispatches HTTP and HTTPS links to the default browser instead of opening File Explorer.
- SSH and local Docker panes can be moved to the left, right, above, or below another pane. The visible Equalize control resets all split sizes and refits their terminals.

## 0.2.108 — Open terminal links

- Click HTTP and HTTPS URLs in local, SSH, and Docker terminals to open them in the Windows default browser. Both plain text links and OSC 8 terminal hyperlinks are supported.

## 0.2.107 — Run agent installers in SSH and Docker

- The install guide opens a shell pane and runs the Claude Code, Codex, or Gemini CLI installer, then checks its version. Claude download failures propagate through the pipeline; missing prerequisites disable the action.
- Dimmed Claude Code and Codex prompt suggestions no longer count as typed drafts and block queued submissions.

## 0.2.106 — Agent installation in SSH and Docker

- Added Gemini CLI to the workspace toolbar and split launchers in SSH and Docker.
- When Claude Code, Codex, or Gemini CLI is missing, WinCMux shows the official install command and reports missing prerequisites. Copy the command, open a shell in the selected environment, and retry the launcher after installing.

## 0.2.105 — Remote pane height and Docker detach

- SSH and local Docker terminal output scrolls within the pane, keeping its header and composer in view when the window shrinks.
- Close the focused remote pane with `Ctrl+Alt+Q`. Closing a Docker tab ends its attached terminals and leaves the container running.
- Submitted and cancelled prompts leave the visible queue immediately. Composer placeholders are recognized even when the terminal footer changes.
- Folder navigation and search use separate rows in narrow file viewers.

For the full set of changes since the previous public release, see [the 0.2.105 release notes](docs/releases/0.2.105.md).

## 0.2.104 — SSH and Docker toolbar and alerts

- The connected toolbar takes less space and reuses local pane controls.
- SSH and local Docker workspaces report Claude Code and Codex completions, input requests, and usage limits.
- Remote workspaces use the same reminder editor and scheduler. An alert can take you to its pane when the session is still open.

## 0.2.103 — SSH and Docker environments and pane splits

- SSH setup has separate Connect and Test connection actions. Successful connections appear in the saved list.
- Open Windows SSH config in VS Code and register a tested manual connection as an SSH alias.
- SSH hosts and Docker project folders open in separate tabs. A new environment starts a fresh session with the selected tool.
- Split panes right or down and resize them in both SSH and local Docker workspaces.
- Open or collapse the file viewer independently of the terminal.

## 0.2.102 — Remote workspace and toolbar

- Added Claude Code and Codex launchers, terminal state, queued input, and scheduled follow-ups to SSH and Docker workspaces.
- Open a Docker container and select its project folder while keeping the SSH host panes open.
- The file list fills the viewer when the preview is closed. Toolbar groups wrap to fit the window.

## 0.2.101 — MCP setup guidance

The MCP connection dialog explains how to check for Node.js. The default development folder follows the current Windows Documents location, including redirected folders.

## 0.2.100 — Codex queue submission

Queued Codex prompts still receive Enter when the composer redraws the pasted text. If Codex stops accepting input before submission, WinCMux leaves the draft in the terminal and asks the user to check it before retrying.

## 0.2.99 — First input no longer waits for a completed turn

Messages submitted while the agent is starting wait for the prompt to become ready. Messages added during work continue to send one at a time as the agent becomes ready. Follow-ups explicitly scheduled after completion still wait for a completion signal.

## 0.2.98 — nested Codex process detection

Queued input now recognizes the nearest Codex process when the CLI has child Codex helper processes. Previously the presence of multiple Codex processes incorrectly produced “no running Codex, Claude, or Gemini process was found” and left the composer blocked. The queue remains bound to one parent agent process and still rejects equally near, ambiguous agents.

## 0.2.97 — ordered agent input

The pane composer checks the live agent state, attached process, and existing queue before submission. During active work it queues new input and sends one item after each completion; an idle agent receives input immediately. If scheduling fails, the draft remains in the composer. The explicit terminal submit button still sends the terminal's own input.

## 0.2.96 — Delivery and MCP workspace improvements

Codex and Claude composer readiness is detected more reliably, and a failed direct send keeps the draft. Follow-up history shows sent and failed items and can restore their text. The file viewer can focus on one folder and return to its parent or the workspace root. MCP accepts an exact workspace name or path for terminal and group operations and attaches new terminals to visible panes. The default development folder is under Documents and can be changed in MCP settings. Workspaces created through MCP refresh the open app, and recent MCP activity shows workspace names.

## 0.2.95 — MCP group control

The local MCP server can rename and delete pane groups, focus a pane, and open a visible terminal directly in a chosen group. It reuses an empty pane or splits an occupied one. Group and focus changes made through MCP refresh the open app. A group deletion moves its running terminals to another group or Default.

## 0.2.94 — viewer, groups, and reminders

The workspace viewer pages large Git change lists, searches file contents, and previews Markdown. Code previews show the detected language and offer language and in-file search. Bundled syntax highlighting also handles Windows line endings. New terminals ask which tool to run; panes created or split inside a group stay there. Duplicate usage-limit reminders are consolidated and completed automatic reminders leave the list. [Download the Windows x64 installer](https://github.com/sungreong/wincmux/releases/tag/v0.2.94).

## 0.2.92 — visible duplicate confirmation

Creating a workspace with an existing path or folder name now opens an in-app dialog listing the existing workspaces and paths. Cancel leaves the list unchanged; only **Create anyway** proceeds.

## 0.2.91 — duplicate confirmation and folder paths

The creation form places icon-only folder picker and create buttons beside the name, leaving a full-width path field below. Creating a workspace with an existing path or matching final folder name now shows the existing paths and asks for confirmation. In detailed view, folder paths wrap and can be clicked to copy. The workspace `⋯` menu shows and copies the full path in every list mode.

## 0.2.90 — workspace deletion confirmation

Deleting a workspace with running terminals shows their count and asks for confirmation. Confirming closes those terminals and child processes before removing the workspace. A workspace with no running terminals is removed immediately. Project files on disk remain intact.

## 0.2.89 — cleaner sidebar

The redundant **Fully quit** toolbar button is gone. Use the window X or Alt+F4 to choose **Fully quit**, **Close window**, or **Cancel**. Notes start collapsed and remember their open state. Workspaces are grouped only when their final folder names match exactly (ignoring Windows path case); each group can be collapsed. Creating a workspace for an already registered path asks for confirmation. The list offers one-line, summary, and detailed views.

## 0.2.88 — Windows tray icon

The background core now displays the WinCMux icon instead of the generic Windows icon. The icon file includes dedicated 16–48px sizes for clearer display in the system tray and at different display scaling levels.

## 0.2.87 — MCP group and pane control

The MCP server can now list and create groups, split a pane, start Claude or Codex in a specific pane and group, and move an existing terminal between groups. An open app refreshes after MCP layout and group changes. See the [MCP tool guide](bridge/mcp/README.md).

## 0.2.86 — window close choices

Closing the main window with X now offers **Fully quit**, **Close window**, and **Cancel**. Fully quit ends terminal processes through the existing core shutdown RPC; closing only the window leaves the background core and sessions running.

## 0.2.85 — conversation sorting

Sort Claude and Codex conversations by newest or oldest update time, or by largest or smallest transcript file. File size is read from each original transcript without scanning its contents and is not a message or token count. The selected sort order is saved locally.

## 0.2.84 — conversation library controls

In **이전 대화 불러오기**, hide or favorite Claude Code and Codex conversations without changing their transcripts. View hidden conversations to restore them, filter by date or favorites, browse pages of 10/20/50, and switch to compact rows. Display preferences are saved locally in the app.

## 0.2.83: Workspace viewer

Added the file, Git, and agent viewer beside the terminal. See the [current viewer guide](README.md#workspace-viewer).

## 0.2.6

Follow-ups can now be scheduled without configuring Codex or Claude hooks. WinCMux checks the running agent process and terminal readiness before a one-time submission. Pending reservations fail if the agent process exits. Hook signals remain available for stronger completion detection.

A fresh Claude or Codex composer can accept its first queued prompt before any task has completed. The initial ready state ends when the first task is submitted.

Codex redraws are checked against the rendered terminal screen as well as the raw output. A typed CLI draft no longer blocks delivery. WinCMux clears or stashes it before submitting the queued prompt, and the queue stays visible above the editor after the scheduling panel closes.

## 0.2.5

The **Schedule follow-up** button now sits beside each terminal's message input. Its panel opens above that input and stays bound to the same terminal session.

## 0.2.4

Each terminal pane now has its own follow-up panel and session-scoped list. Choose **after the current task completes** or **after a specified time**; both modes require a verified idle agent before a one-time submission. Schema 12 backs up the prior database to `pre-v12-*.bak`. See [hook setup and delivery conditions](docs/agent-hooks.md).

## 0.2.3

**대화 이력** and **이전 대화 불러오기** discover project conversations directly from Claude's local JSONL files and Codex's rollout files, title index and read-only thread database. Search titles/IDs, filter by provider, include subdirectories and refresh. Resume a selected ID in its saved working directory; occupied or dormant panes are preserved by opening a split. Native Claude/Codex resume pickers are also available. Discovery respects `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, does not rewrite/copy/delete transcripts, and does not collect other accounts or WSL histories. CLI-owned retention still applies; deleted or unsaved conversations cannot be recovered.

Recognizes compact quota banners such as `Usagelimitreached·continuingautomaticallyat7:50pm`. Date-free clocks resolve to their next local occurrence using the banner's first observation, with the current minute treated as due. Explicit dates remain explicit. The first observation is saved as `observed_at`, keeping relative intervals and recovery `now` stable across delayed processing, repaints and midnight. `/usage-credits to continue now` is a separate option, not a replacement for the reset time. Schema 10 preserves saved schedules and backs up existing databases to `pre-v10-*.bak`.

## 0.2.2

Choose Claude Code, Codex, Gemini or PowerShell from an empty pane. **실행 설정** manages saved names, commands, icons, ordering and the default selection across workspaces.

**예약 알림** creates, edits, cancels and deletes persistent reminders. Recognized Claude/Codex/Gemini quota banners register reminders when they include an unambiguous reset time or retry interval. Repeated output is deduplicated within the same session, provider, limit kind and reset period; unknown accounts in different sessions are not merged. Ambiguous times require manual entry. The default timezone is configurable (initially `Asia/Seoul`). Windows and in-app alerts announce the scheduled time, without claiming the provider has restored access.

Pending reminders keep the core alive after the UI and all terminals close. Overdue reminders fire after sleep/resume or the next app startup following full shutdown. Schema 9 is backed up to `pre-v9-*.bak` before migration. Includes the terminal resizing and Unicode-width corrections.

## 0.2.1: Background core

Separated the window from the execution core so terminal jobs continue after closing the window and reconnect on reopening.
