# JSON-RPC Methods (MVP)

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
