CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  backend TEXT NOT NULL,
  branch TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  last_active TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  level TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  source TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_sort ON workspaces(pinned DESC, sort_order ASC);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(workspace_id, read_at, created_at DESC);

INSERT OR IGNORE INTO schema_versions(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
