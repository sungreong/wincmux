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
}

export interface SessionRow {
  id: string;
  workspace_id: string;
  pid: number;
  status: SessionStatus;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
}

export interface NotificationRow {
  id: string;
  workspace_id: string;
  title: string;
  body: string;
  level: string;
  created_at: string;
  read_at: string | null;
  source: string;
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
