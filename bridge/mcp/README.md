# WinCMux local MCP server

This stdio MCP server controls the running WinCMux core over its local Windows named pipe. It does not open an HTTP port. Node.js is required to run the server. The server and screenshot helper are included in the Windows installer; the repository copy also runs directly.

Open **MCP** in the WinCMux toolbar to see the installed server command, supported tools, and the persistent ON/OFF switch. OFF blocks all tool calls except `wincmux_status`; that status reports only that MCP is off. Existing terminal sessions continue running. The switch controls this adapter, not other clients of the WinCMux core named pipe. The switch defaults to ON for existing MCP setups.
The toolbar shows ON/OFF, and the expanded panel lists recent tool calls with time and success, blocked, or failed status. Only tool names and outcomes are recorded; terminal input and MCP arguments are omitted. The database retains the latest 200 records.
The same panel can copy the Codex registration command, a JSON connection description, or a prompt for an agent to register the stdio server. Stdio uses no TCP port, so there is no fixed port to reserve or dynamic port to discover.

## Connect from Codex

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
| `wincmux_create_workspace` | Add an existing local folder |
| `wincmux_list_terminals` | Panes, running sessions and agent readiness |
| `wincmux_read_terminal` | Visible text grid and bounded recent terminal output |
| `wincmux_start_terminal` | Start a shell or Claude/Codex/Gemini, optionally in an empty pane |
| `wincmux_terminal_input` | Send text, optionally followed by Enter, immediately |
| `wincmux_press_key` | Enter, Escape, Tab, Ctrl+C and arrow keys |
| `wincmux_close_terminal` | End a specified terminal session |
| `wincmux_queue_followup` | Queue an agent prompt for readiness, a new completion, or a due time |
| `wincmux_send_followup_now` | Immediately submit a pending or paused follow-up to its terminal |
| `wincmux_list_followups` | Inspect pending and recent follow-up prompts |
| `wincmux_capture_window` | PNG screenshot of the WinCMux app |

`wincmux_capture_window` defaults to an MCP image block whose `data` field is Base64 PNG. Pass `{"format":"base64"}` to receive JSON containing `mime_type`, `width`, `height`, `pid`, and a Base64 `data` string. Captures stay within the local MCP connection. Screenshots can include terminal content and workspace paths, so the MCP client must be trusted to read them.

`wincmux_terminal_input` sends immediately, even when an agent is working. Use `wincmux_queue_followup` for sequential delivery after the agent is ready. On an older installed core, `wincmux_read_terminal` returns recent raw output and `screen:null` until that core is updated. The adapter never deletes workspaces or stops existing sessions automatically; `wincmux_close_terminal` acts only on the session ID supplied by the caller.

For an opt-in end-to-end check against your signed-in provider account, run `node bridge/mcp/real-agent-smoke.cjs claude`, `codex`, or `gemini` from the repository root. Each command creates an isolated temporary workspace and sends two short real prompts. Gemini must already be authenticated in the CLI. The test closes only its own terminal and core.
