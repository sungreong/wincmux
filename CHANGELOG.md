# Changelog

[README](README.md) · [GitHub Releases](https://github.com/sungreong/wincmux/releases)

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
