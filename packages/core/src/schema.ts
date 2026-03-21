export const BASE_SCHEMA_SQL = `
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
  session_id TEXT,
  pane_id TEXT,
  kind TEXT NOT NULL DEFAULT 'system',
  source_kind TEXT NOT NULL DEFAULT 'cli',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  level TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0,
  dedup_key TEXT,
  signature_hash TEXT,
  source TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS layout_snapshots (
  workspace_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_sort ON workspaces(pinned DESC, sort_order ASC);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(workspace_id, read_at, created_at DESC);

INSERT OR IGNORE INTO schema_versions(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`;

export const MIGRATIONS: Record<number, string[]> = {
  2: [
    "ALTER TABLE notifications ADD COLUMN session_id TEXT",
    "ALTER TABLE notifications ADD COLUMN pane_id TEXT",
    "ALTER TABLE notifications ADD COLUMN kind TEXT NOT NULL DEFAULT 'system'",
    "ALTER TABLE notifications ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'cli'",
    "ALTER TABLE notifications ADD COLUMN delivered_at TEXT",
    "ALTER TABLE notifications ADD COLUMN suppressed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE notifications ADD COLUMN dedup_key TEXT",
    "ALTER TABLE notifications ADD COLUMN signature_hash TEXT",
    "CREATE INDEX IF NOT EXISTS idx_notifications_session ON notifications(session_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(workspace_id, dedup_key, created_at DESC)",
    "UPDATE notifications SET kind = 'assistant_prompt' WHERE source LIKE 'assistant_prompt|%'",
    "UPDATE notifications SET source_kind = 'pattern' WHERE source LIKE 'assistant_prompt|%'",
    "UPDATE notifications SET source_kind = 'cli' WHERE source_kind IS NULL OR source_kind = ''",
    "INSERT OR IGNORE INTO schema_versions(version, applied_at) VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
  ],
  3: [
    "ALTER TABLE sessions ADD COLUMN spawn_cmd TEXT",
    "ALTER TABLE sessions ADD COLUMN spawn_args TEXT",
    "ALTER TABLE sessions ADD COLUMN spawn_cwd TEXT",
    `CREATE TABLE IF NOT EXISTS pane_session_bindings (
      workspace_id TEXT NOT NULL,
      pane_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, pane_id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    )`,
    "INSERT OR IGNORE INTO schema_versions(version, applied_at) VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
  ],
  4: [
    `CREATE TABLE IF NOT EXISTS ai_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      pty_session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      resume_cmd TEXT NOT NULL,
      cwd TEXT,
      detected_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_ai_sessions_workspace ON ai_sessions(workspace_id, detected_at DESC)",
    "INSERT OR IGNORE INTO schema_versions(version, applied_at) VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
  ],
  5: [
    "ALTER TABLE ai_sessions ADD COLUMN cwd TEXT",
    "INSERT OR IGNORE INTO schema_versions(version, applied_at) VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
  ]
};
