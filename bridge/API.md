# JSON-RPC methods

## workspace.create
Params: `{ "name": string, "path": string, "backend": string }`

## workspace.list
Params: `{}`

## workspace.rename
Params: `{ "id": string, "name": string }`

## workspace.delete
Params: `{ "id": string }`

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

## agent.list
Params: `{}`

Returns `{ "items": [{ "session_id", "workspace_id", "state", "source", "reason", "revision" }] }` for live sessions across all workspaces. Agent state is separate from process lifecycle status. States: `working`, `blocked`, `done` (unacknowledged), `idle` (acknowledged), `unknown`, `error`. Sources: `osc7501`, `pattern`, `none`. Changes emit `session.agent_changed` on the `session` topic.

OSC 7501 reports take precedence over text detection for the lifetime of a terminal. Send `ESC ] 7501 ; state=working:app=my-agent ST` (without spaces), where ST is `ESC \`; BEL is also accepted. Supported state values match those above except `unknown`. Reports may span output chunks. Unsupported programs use conservative text detection: a quiet output stream becomes `unknown`, never automatic completion. The source and reason are available in the pane status tooltip.

## agent.acknowledge
Params: `{ "session_id": string, "revision": number }`

Acknowledges only the specified revision of a `done` result, changing it to `idle`. Other states and newer results are preserved. Returns `{ "agent": { "state", "source", "reason", "revision" } }` (or null if the session ended). Live agent state ends with its terminal; existing notification history remains persisted.

## Background runtime (protocol 1, WinCMux 0.2.0)

`runtime.info {}` returns `version`, `protocol_version`, `instance_id`, `data_directory`, `pid`, `terminal_count`, `client_count`, `subscriber_count`, `preparing_update`, and `stopping`. Process lifecycle status and agent attention state remain separate.

`client.attach {client_id}` registers a UI on its pipe connection and returns the runtime ID plus any pending `activation`. Closing that connection removes its clients and subscriptions. `client.context {client_id,context}` reports `{app_focused,workspace_id,session_id}` for notification suppression. `client.detach {client_id}` detaches explicitly. `client.activation_ack {}` consumes the pending activation. `runtime.activate {notification_id?,notification?}` queues and emits an activation. The desktop consumes it only after renderer bootstrap.

`session.snapshot {session_id}` returns `{screen,history,rows,cols,end_offset}`. `screen` contains ANSI restoration for the normal and alternate buffers. Install `history` first, then `screen`, at the returned size, and tail from `end_offset`. Take care not to replay bytes already covered by the snapshot or send terminal device replies while rendering it. Subscribe before taking the snapshot. UI subscriptions may pass `output_mode: "ready"` to receive `session.output_ready` offsets instead of output bodies. Existing raw subscriptions are unchanged.

`runtime.shutdown {}` refuses live terminals. `runtime.shutdown_all {confirmed:true}` explicitly ends all terminals. Both emit `runtime.stopping`. `runtime.prepare_update {}` also refuses live terminals, reserves a 60-second preparation window, rejects new sessions/attachments, and asks attached UIs to exit. `runtime.cancel_update {}` releases that preparation. The installer helper additionally owns a temporary filesystem lease, which blocks a fresh core during file replacement.

`hidden.list {workspace_id}` returns `items`. `hidden.add {id,workspace_id,session_id,source_pane_id?,group_id?,label,hidden_at}` saves a live hidden session. `hidden.remove {workspace_id,id}` removes the hidden marker without stopping the terminal. Ended/closed sessions have their markers removed automatically.

`runtime.disconnected` and `runtime.activation` are desktop lifecycle events. Never automatically repeat `session.run`, `session.write`, or destructive requests after an uncertain response. Compare runtime instance IDs after reconnection before reusing output offsets.

`notify.get {notification_id}` retrieves a saved notification for activation after a new core starts. The installed `wincmux://notification/<UUID>` protocol launches the desktop with `--open-notification`; only UUID paths are accepted. Notifications therefore remain actionable after the idle core has exited. Unpackaged builds use the live core callback instead.
