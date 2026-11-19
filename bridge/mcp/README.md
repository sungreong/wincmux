# WinCMux local MCP server

This stdio MCP server controls the running WinCMux core over its local Windows named pipe. It does not open an HTTP port. Node.js is required to run the server. The server and screenshot helper are included in the Windows installer; the repository copy also runs directly.

MCP tools and window capture cover the local workspace window. Open SSH servers and Docker containers from the separate **Remote SSH** window in the desktop app.

Open **MCP** in the WinCMux toolbar to see the installed server command, supported tools, and the persistent ON/OFF switch. OFF blocks all tool calls except `wincmux_status`; that status reports only that MCP is off. Existing terminal sessions continue running. The switch controls this adapter, not other clients of the WinCMux core named pipe. The switch defaults to ON for existing MCP setups.
The same settings panel has a development folder. When `wincmux_create_workspace` is called without `path`, it creates a folder named after the workspace under this configured location, then adds it to WinCMux. The default is `WinCMux MCP Development` inside the Windows Documents folder, including when Windows redirects Documents to another location. An explicit folder path always takes precedence. `wincmux_start_terminal` accepts an exact existing workspace name or path as `workspace`; duplicate names require the full path. It always attaches the new session to a visible pane.
The toolbar shows ON/OFF, and the expanded panel lists recent tool calls with workspace name, time, and success, blocked, or failed status. Only workspace identity, tool names, and outcomes are recorded; terminal input and MCP arguments are omitted. The database retains the latest 200 records.
The same panel can copy the Codex registration command, a JSON connection description, or a prompt for an agent to register the stdio server. Stdio uses no TCP port, so there is no fixed port to reserve or dynamic port to discover.

## Connect from Codex

Run `node --version` in PowerShell to check that Node.js is on your PATH. If it is missing, install Node.js before registering the server. In the installed app, open **MCP** and copy the Codex command with the path for your installation.

From this checkout:

```powershell
codex mcp add wincmux -- node C:\app\WinCmux\bridge\mcp\server.cjs
```

After installing the updated WinCMux build, the bundled script can instead be used at `%LOCALAPPDATA%\WinCMux Tauri\mcp\server.cjs`. Restart the MCP client after adding the server. WinCMux must be running for core tools; the screenshot tool additionally needs a visible, restored WinCMux window. Set `WINCMUX_TAURI_PIPE` for an isolated test core and `WINCMUX_CAPTURE_EXE` to select a capture helper explicitly.

## Tools

| Tool | Purpose |
| --- | --- |
| `wincmux_status` | Core version and runtime state |
| `wincmux_list_workspaces` | Workspace IDs, names and paths |
| `wincmux_create_workspace` | Add an explicit existing folder or create one under the configured development folder |
| `wincmux_list_groups` | Groups and terminal assignments in a workspace |
| `wincmux_create_group` | Create a named pane group, optionally with a `#RRGGBB` color |
| `wincmux_rename_group` | Rename a group other than Default |
| `wincmux_delete_group` | Delete a group and move its running terminals to another group or Default |
| `wincmux_list_terminals` | Panes, running sessions, group assignments and agent readiness |
| `wincmux_split_pane` | Split a leaf pane; the old terminal stays in the first child |
| `wincmux_focus_pane` | Select a leaf pane |
| `wincmux_move_terminal_to_group` | Assign an existing terminal to a group |
| `wincmux_read_terminal` | Visible text grid and bounded recent terminal output |
| `wincmux_start_terminal` | Start a visible shell or Claude/Codex/Gemini by workspace ID, exact name, or path |
| `wincmux_start_group_terminal` | Open a visible terminal in a group, reusing an empty pane or splitting one |
| `wincmux_terminal_input` | Send text, optionally followed by Enter, immediately |
| `wincmux_press_key` | Enter, Escape, Tab, Ctrl+C and arrow keys |
| `wincmux_close_terminal` | End a specified terminal session |
| `wincmux_queue_followup` | Queue an agent prompt for readiness, a new completion, or a due time |
| `wincmux_send_followup_now` | Immediately submit a pending or paused follow-up to its terminal |
| `wincmux_list_followups` | Inspect pending and recent follow-up prompts |
| `wincmux_capture_window` | PNG screenshot of the WinCMux app |

To open a terminal in a group, use `wincmux_start_group_terminal` with an exact workspace name or path in `workspace` and a `group_id`. It chooses an empty pane first. If every pane is occupied, it splits an existing pane, preferring one already assigned to that group. The new terminal defaults to PowerShell; set `agent` to launch Claude, Codex, or Gemini. `wincmux_split_pane` and `wincmux_start_terminal` remain available when you want to choose the exact pane. A split of an occupied pane retains its terminal in the first child. `wincmux_move_terminal_to_group` changes a running terminal's group without restarting it. Deleting a group moves its sessions to the requested group or Default without closing them. The open app refreshes its group and pane layout after these MCP operations.

`wincmux_capture_window` defaults to an MCP image block whose `data` field is Base64 PNG. Pass `{"format":"base64"}` to receive JSON containing `mime_type`, `width`, `height`, `pid`, and a Base64 `data` string. Captures stay within the local MCP connection. Screenshots can include terminal content and workspace paths, so the MCP client must be trusted to read them.

`wincmux_terminal_input` sends immediately, even when an agent is working. Use `wincmux_queue_followup` for sequential delivery after the agent is ready. On an older installed core, `wincmux_read_terminal` returns recent raw output and `screen:null` until that core is updated. The adapter never deletes workspaces or stops existing sessions automatically; `wincmux_close_terminal` acts only on the session ID supplied by the caller.

For an opt-in end-to-end check against your signed-in provider account, run `node bridge/mcp/real-agent-smoke.cjs claude --workspace C:\app\WinCmux`, `codex --workspace C:\app\WinCmux`, or `gemini --workspace C:\app\WinCmux` from the repository root. The workspace argument selects the folder used by the test. Each command starts an isolated test core, sends three short real prompts, confirms the final reply on screen, and closes its own terminal and core. Gemini must already be authenticated in the CLI.
