# JSON-RPC methods

## workspace.create
Params: `{ "name": string, "path": string, "backend": string }`

## workspace.list
Params: `{}`

## workspace.rename
Params: `{ "id": string, "name": string }`

## workspace.delete
Params: `{ "id": string, "confirmed_running"?: boolean }`

A workspace with no running terminals deletes immediately. If it has running terminals, the core rejects an unconfirmed request. After the user confirms, pass `confirmed_running: true`; the core closes all of that workspace's running terminals before removing its records. Files in the workspace folder are not deleted.

## workspace.pin
Params: `{ "id": string, "pinned": bool }`

## workspace.reorder
Params: `{ "id": string, "sort_order": number }`

## session.run
Params: `{ "workspace_id": string, "cmd": string, "args": string[], "cwd"?: string }`

## session.list
Params: `{ "workspace_id": string }`

## session.close
Params: `{ "session_id": string }`

## session.resize
Params: `{ "session_id": string, "cols": number, "rows": number }`

## session.write
Params: `{ "session_id": string, "data": string }`

## session.read
Params: `{ "session_id": string, "max_bytes"?: number }`

## session.tail
Params: `{ "session_id": string, "max_bytes"?: number, "after_offset"?: number }`

Reads retained UTF-8 output without advancing the polling cursor. The result includes `output`, `start_offset`, `end_offset`, and `available_end_offset`. If `start_offset` exceeds the requested offset, older output has fallen outside the retention window.

## session.stream.subscribe
Params: `{ "workspace_id"?: string, "session_id"?: string, "topics"?: ("session" | "notify")[] }`

Returns a `subscription_id`. Events arrive on the same connection, including `session.output`, `session.state_changed`, `session.exit`, and `notify.created`.

## session.stream.unsubscribe
Params: `{ "subscription_id": string }`

## notify.push
Params: `{ "workspace_id": string, "title": string, "body": string, "level": string }`

## notify.unread
Params: `{ "workspace_id"?: string }`

## notify.mark_read
Params: `{ "notification_id": string }`

## notify.clear
Params: `{ "workspace_id"?: string }`

## layout.split
Params: `{ "workspace_id": string, "pane_id": string, "direction": "horizontal"|"vertical" }`

## layout.focus
Params: `{ "workspace_id": string, "pane_id": string }`

## layout.list
Params: `{ "workspace_id": string }`

## group.list / group.create
Params: `{ "workspace_id": string }` for `group.list`; `{ "workspace_id": string, "name": string, "color"?: string }` for `group.create`. A group categorizes terminal sessions within a workspace; it is not a separate pane layout.

## session.group.list / session.group.set
Params: `{ "workspace_id": string }` for `session.group.list`; `{ "workspace_id": string, "session_id": string, "group_id": string }` for `session.group.set`. The core verifies that the session and group belong to the same workspace.

`group.create`, `session.group.set`, `layout.split`, and `pane.session.bind` emit `workspace.structure_changed` on the `session` stream topic after a successful update, allowing an open UI to reload groups, layout and bindings.

## agent.list
Params: `{}`

Returns `{ "items": [{ "session_id", "workspace_id", "state", "source", "reason", "revision", "hook" }] }` for live sessions across all workspaces. Agent state is separate from process lifecycle status. States: `working`, `blocked`, `done` (unacknowledged), `idle` (acknowledged), `unknown`, `error`. Sources include `hook`, `osc7501`, `pattern`, `scheduled`, `none`. `hook` reports actual receipt, count, provider, agent ID, last event/time and active state. Changes emit `session.agent_changed` on the `session` topic.

OSC 7501 reports take precedence over text detection for the lifetime of a terminal. Send `ESC ] 7501 ; state=working:app=my-agent ST` (without spaces), where ST is `ESC \`; BEL is also accepted. Supported state values match those above except `unknown`. Reports may span output chunks. Unsupported programs use conservative text detection: a quiet output stream becomes `unknown`, never automatic completion. The source and reason are available in the pane status tooltip.

`agent.hook_setup {}` returns the running core executable path for generating opt-in Codex/Claude hook configuration. The `--agent-hook <provider> <event>` core mode reads bounded hook JSON from stdin and sends only IDs and the event over the local pipe. `agent.hook {session_id,token,provider,event,agent_id?,turn_id?,hook_pid,hook_started}` is accepted only for the bound PTY child process. See [hook setup](../docs/agent-hooks.md).

`workspace.hooks.status {workspace_id,provider}` reports whether all WinCMux events are registered in the local workspace (`provider` is `claude` or `codex`). `workspace.hooks.ensure {workspace_id,provider}` adds missing events to `.claude/settings.local.json` or `.codex/hooks.json`, preserving other settings and hooks; repeated calls are idempotent. Remote workspaces are excluded.

`followup.list {workspace_id?,session_id?}` returns recent schedules, optionally scoped to one terminal session. `followup.schedule {session_id,prompt,delivery_mode,due_at?}` creates one bound to the current agent process. Hook-confirmed sessions use the hook; otherwise the core uses the recognized Codex/Claude/Gemini process and terminal readiness. `delivery_mode` is `when_ready`, `after_completion`, or `at_time` (Unix seconds in `due_at`). `followup.pause {id}`, `followup.resume {id}` and `followup.cancel {id}` change a pending schedule. `followup.send_now {id}` submits a pending or paused item immediately, even while the agent is busy or before its due time; its `sent` status means the input was written to the terminal, not that the agent processed it. Results and delivery changes emit `followup.changed`. Each row is claimed atomically before writing and never retried after an uncertain submission. The prompt is stored in local SQLite.

`mcp.settings.get` returns the persistent MCP enable flag, transport, server script path, and supported tool descriptions. `mcp.settings.save {enabled}` updates the flag. The bundled stdio adapter checks it on every tool call and rejects calls while disabled, except for a minimal `wincmux_status` response.
`mcp.activity.list` returns the latest 50 MCP tool calls. The adapter writes each outcome through `mcp.activity.record {tool,outcome}`; the core retains 200 entries containing timestamp, tool name, and `success`, `blocked`, or `failed`. Arguments and terminal content are not logged.

## agent.acknowledge
Params: `{ "session_id": string, "revision": number }`

Acknowledges only the specified revision of a `done` result, changing it to `idle`. Other states and newer results are preserved. Returns `{ "agent": { "state", "source", "reason", "revision" } }` (or null if the session ended). Live agent state ends with its terminal; existing notification history remains persisted.

## Background runtime (protocol 1, WinCMux 0.2.0)

`runtime.info {}` returns `version`, `protocol_version`, `instance_id`, `data_directory`, `pid`, `terminal_count`, `client_count`, `subscriber_count`, `preparing_update`, and `stopping`. Process lifecycle status and agent attention state remain separate.

`client.attach {client_id}` registers a UI on its pipe connection and returns the runtime ID plus any pending `activation`. Closing that connection removes its clients and subscriptions. `client.context {client_id,context}` reports `{app_focused,workspace_id,session_id}` for notification suppression. `client.detach {client_id}` detaches explicitly. `client.activation_ack {}` consumes the pending activation. `runtime.activate {notification_id?,notification?}` queues and emits an activation. The desktop consumes it only after renderer bootstrap.

`session.snapshot {session_id}` returns `{screen,history,rows,cols,end_offset}`. `screen` contains ANSI restoration for the normal and alternate buffers. Install `history` first, then `screen`, at the returned size, and tail from `end_offset`. Take care not to replay bytes already covered by the snapshot or send terminal device replies while rendering it. Subscribe before taking the snapshot. UI subscriptions may pass `output_mode: "ready"` to receive `session.output_ready` offsets instead of output bodies. Existing raw subscriptions are unchanged.

`session.screen_text {session_id}` returns the current visible terminal grid as `lines` plus `rows`, `cols`, `cursor_row`, `cursor_col`, and `bracketed_paste`. It does not advance the output cursor and is suitable for local MCP inspection. This is a text view of one terminal, separate from the WinCMux application window screenshot provided by the MCP adapter.

Snapshots also include `windows_pty: {backend: "conpty", buildNumber?}` for xterm's Windows resize compatibility. `session.resize {session_id,cols,rows}` returns `{ok:true,before_offset}`, the output offset captured before resizing ConPTY. Drain existing reads and parse output through that offset at the previous dimensions, then resize the viewer before reading subsequent repaint output. A client connected to an older core without this field should restore a new snapshot after resizing.

`runtime.shutdown {}` refuses live terminals. `runtime.shutdown_all {confirmed:true}` explicitly ends all terminals. Both emit `runtime.stopping`. `runtime.prepare_update {}` also refuses live terminals, reserves a 60-second preparation window, rejects new sessions/attachments, and asks attached UIs to exit. `runtime.cancel_update {}` releases that preparation. The installer helper additionally owns a temporary filesystem lease, which blocks a fresh core during file replacement.

`hidden.list {workspace_id}` returns `items`. `hidden.add {id,workspace_id,session_id,source_pane_id?,group_id?,label,hidden_at}` saves a live hidden session. `hidden.remove {workspace_id,id}` removes the hidden marker without stopping the terminal. Ended/closed sessions have their markers removed automatically.

## Local conversation discovery (0.2.3)

- `conversation.list {workspace_id,include_children?:true,refresh?:false}` returns `{items,warnings,project_path,include_children}`. Rows contain `provider,id,title,cwd,updated_at,size_bytes,source_path,archived,cwd_exists,resume_command`. Dates are Unix seconds; `size_bytes` is the transcript file size or null if metadata is unavailable. It is not a message or token count. Discovery is read-only and scoped by normalized, case-insensitive path component boundaries, with a 15-second cache; refresh bypasses it. The desktop conversation dialog stores hidden/favorite marks and layout preferences in local app storage; these do not alter the CLI transcripts or this API.
- Sources are Claude `projects/*/*.jsonl` and Codex `sessions`, `archived_sessions`, `session_index.jsonl`, plus the newest `state_*.sqlite` opened read-only. Roots respect `CLAUDE_CONFIG_DIR` / `CODEX_HOME` or the Windows user's defaults. Subagents, invalid UUIDs and unrelated projects are excluded. Bounded head/tail reads tolerate corrupt/partial JSONL. File traversal has a reported limit and ignores reparse points.
- `conversation.resolve {workspace_id,provider,id,include_children?:true}` re-scans and validates project membership, UUID and working-directory availability, returning the selected row. It does not start a process. The renderer generates `claude --resume <UUID>` or `codex resume <UUID>` itself, opens a split for occupied/dormant panes and uses the saved cwd without fallback. Original transcript ownership and retention remain with the CLI. `ai.sessions` still represents previously detected terminal resume commands, not the local conversation library.

## Persistent reminders (0.2.2)

Version 0.2.3 adds nullable `observed_at` (Unix seconds) for the first observation of an automatic quota banner. Time-only schedules use the next local occurrence relative to that timestamp; the current minute may already be due. Explicit dates are respected. Relative intervals and explicit recovery `now` use observation time, not the later processing/redraw time. Credit-purchase/usage choices mentioning `now` do not override an explicit automatic-continuation time. Schema 10 retains existing schedules and takes a `pre-v10-*.bak` backup.

- `reminder.list {}` returns `{items,settings}` across workspaces, with pending/needs-time records before history. Items include `id,workspace_id,workspace_name,session_id,provider,limit_kind,title,body,due_at,timezone,source,status`.
- `reminder.save {id?,workspace_id,session_id?,provider?,title,body?,timezone,local_time?,due_at?}` creates or updates a reminder. Supply Unix seconds in `due_at` or a `YYYY-MM-DDTHH:mm` local time interpreted in the IANA `timezone`. Times must be in the future within 366 days. Editing an automatic reminder makes it manual while retaining its deduplication key.
- `reminder.cancel {id}` cancels scheduling. `reminder.delete {id}` hides the item and keeps a deduplication tombstone so repeated terminal repaints cannot recreate the same automatic period.
- `reminder.settings.get {}` and `reminder.settings.save {auto_enabled,timezone}` read/write automatic-detection preferences. `auto_enabled` is a JSON boolean on input and an SQLite 0/1 on output.
- States are `pending`, `needs_time`, `sent`, `cancelled`, and internally `deleted`. Due time is absent when detection cannot resolve the date/time. Different sessions with unknown account identity are not merged.
- `notify.reminders_changed` invalidates reminder UI state. Due reminders create durable `notify.created` records with `kind: "reminder_due"`; quota detection uses `kind: "usage_limit"`. Notification creation and the sent transition commit in one transaction. Undelivered scheduled notifications are retried once per core lifetime after startup.
- `runtime.info` adds `reminders_supported:true` and `pending_reminders`. Pending reminders prevent idle shutdown, but explicit shutdown/update preparation still works; saved overdue reminders fire after restarting. Fully quitting does not register an OS task or wake a powered-off PC.

`runtime.disconnected` and `runtime.activation` are desktop lifecycle events. Never automatically repeat `session.run`, `session.write`, or destructive requests after an uncertain response. Compare runtime instance IDs after reconnection before reusing output offsets.

`notify.get {notification_id}` retrieves a saved notification for activation after a new core starts. The installed `wincmux://notification/<UUID>` protocol launches the desktop with `--open-notification`; only UUID paths are accepted. Notifications therefore remain actionable after the idle core has exited. Unpackaged builds use the live core callback instead.
