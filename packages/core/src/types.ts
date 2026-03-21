export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export type SessionStatus = "running" | "exited" | "failed";
export type NotificationLevel = "info" | "success" | "warning" | "error";
export type NotificationKind = "assistant_prompt" | "task_done" | "task_error" | "system";
export type NotificationSourceKind = "hook" | "osc" | "pattern" | "cli" | "system";
export type StreamTopic = "session" | "notify";

export interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  backend: string;
  branch: string | null;
  dirty: number;
  last_active: string;
  pinned: number;
  sort_order: number;
  description: string | null;
}

export interface SessionRow {
  id: string;
  workspace_id: string;
  pid: number;
  status: SessionStatus;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  spawn_cmd: string | null;
  spawn_args: string | null;
  spawn_cwd: string | null;
}

export interface NotificationRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  pane_id: string | null;
  kind: NotificationKind;
  source_kind: NotificationSourceKind;
  title: string;
  body: string;
  level: NotificationLevel;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  suppressed: number;
  dedup_key: string | null;
  signature_hash: string | null;
  source: string;
}

export interface AiSessionRow {
  id: string;
  workspace_id: string;
  pty_session_id: string;
  tool: string;
  resume_cmd: string;
  cwd: string | null;
  detected_at: string;
}

export interface PaneNode {
  pane_id: string;
  parent_id: string | null;
  split: {
    direction: "horizontal" | "vertical";
    first: string;
    second: string;
  } | null;
  is_focused: boolean;
}
