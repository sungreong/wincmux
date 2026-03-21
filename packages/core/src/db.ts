import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { BASE_SCHEMA_SQL, MIGRATIONS } from "./schema";
import type { AiSessionRow, NotificationRow, SessionRow, SessionStatus, WorkspaceRow } from "./types";

export class DbStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(BASE_SCHEMA_SQL);
    this.applyMigrations();
  }

  close(): void {
    this.db.close();
  }

  createWorkspace(id: string, name: string, workspacePath: string, backend: string, now: string): WorkspaceRow {
    const nextSort = this.db
      .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort FROM workspaces")
      .get() as { next_sort: number };

    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, path, backend, branch, dirty, last_active, pinned, sort_order)
         VALUES (@id, @name, @path, @backend, NULL, 0, @last_active, 0, @sort_order)`
      )
      .run({ id, name, path: workspacePath, backend, last_active: now, sort_order: nextSort.next_sort });

    return this.getWorkspace(id)!;
  }

  getWorkspace(id: string): WorkspaceRow | null {
    return (this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined) ?? null;
  }

  listWorkspaces(): WorkspaceRow[] {
    return this.db
      .prepare("SELECT * FROM workspaces ORDER BY pinned DESC, sort_order ASC, last_active DESC")
      .all() as WorkspaceRow[];
  }

  deleteWorkspace(id: string): void {
    const tx = this.db.transaction((workspaceId: string) => {
      this.db.prepare("DELETE FROM sessions WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM notifications WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM layout_snapshots WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
    });
    tx(id);
  }

  renameWorkspace(id: string, name: string, now: string): void {
    this.db.prepare("UPDATE workspaces SET name = ?, last_active = ? WHERE id = ?").run(name, now, id);
  }

  setWorkspacePin(id: string, pinned: boolean): void {
    this.db.prepare("UPDATE workspaces SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }

  reorderWorkspace(id: string, sortOrder: number): void {
    this.db.prepare("UPDATE workspaces SET sort_order = ? WHERE id = ?").run(sortOrder, id);
  }

  updateWorkspaceGit(id: string, branch: string | null, dirty: boolean): void {
    this.db.prepare("UPDATE workspaces SET branch = ?, dirty = ? WHERE id = ?").run(branch, dirty ? 1 : 0, id);
  }

  insertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, workspace_id, pid, status, started_at, ended_at, exit_code,
                               spawn_cmd, spawn_args, spawn_cwd)
         VALUES (@id, @workspace_id, @pid, @status, @started_at, @ended_at, @exit_code,
                 @spawn_cmd, @spawn_args, @spawn_cwd)`
      )
      .run(row);
  }

  updateSessionResult(id: string, status: SessionStatus, endedAt: string, exitCode: number | null): void {
    this.db.prepare("UPDATE sessions SET status = ?, ended_at = ?, exit_code = ? WHERE id = ?").run(status, endedAt, exitCode, id);
  }

  listSessions(workspaceId: string): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY started_at DESC")
      .all(workspaceId) as SessionRow[];
  }

  listAllSessions(workspaceId: string): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 50")
      .all(workspaceId) as SessionRow[];
  }

  getSession(sessionId: string): SessionRow | null {
    return (this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined) ?? null;
  }

  savePaneSessionBinding(workspaceId: string, paneId: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO pane_session_bindings (workspace_id, pane_id, session_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, pane_id) DO UPDATE SET
           session_id = excluded.session_id,
           updated_at = excluded.updated_at`
      )
      .run(workspaceId, paneId, sessionId, new Date().toISOString());
  }

  loadPaneSessionBindings(workspaceId: string): Array<{ pane_id: string; session_id: string }> {
    return this.db
      .prepare("SELECT pane_id, session_id FROM pane_session_bindings WHERE workspace_id = ?")
      .all(workspaceId) as Array<{ pane_id: string; session_id: string }>;
  }

  deletePaneSessionBinding(workspaceId: string, paneId: string): void {
    this.db.prepare("DELETE FROM pane_session_bindings WHERE workspace_id = ? AND pane_id = ?").run(workspaceId, paneId);
  }

  clearPaneSessionBindingBySession(sessionId: string): void {
    this.db.prepare("DELETE FROM pane_session_bindings WHERE session_id = ?").run(sessionId);
  }

  upsertAiSession(row: AiSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO ai_sessions (id, workspace_id, pty_session_id, tool, resume_cmd, cwd, detected_at)
         VALUES (@id, @workspace_id, @pty_session_id, @tool, @resume_cmd, @cwd, @detected_at)
         ON CONFLICT(id) DO UPDATE SET detected_at = excluded.detected_at, cwd = excluded.cwd`
      )
      .run(row);
  }

  listAiSessions(workspaceId: string): AiSessionRow[] {
    return this.db
      .prepare("SELECT * FROM ai_sessions WHERE workspace_id = ? ORDER BY detected_at DESC LIMIT 50")
      .all(workspaceId) as AiSessionRow[];
  }

  insertNotification(row: NotificationRow): void {
    this.db
      .prepare(
        `INSERT INTO notifications (
          id, workspace_id, session_id, pane_id,
          kind, source_kind, title, body, level,
          created_at, delivered_at, read_at,
          suppressed, dedup_key, signature_hash, source
        )
        VALUES (
          @id, @workspace_id, @session_id, @pane_id,
          @kind, @source_kind, @title, @body, @level,
          @created_at, @delivered_at, @read_at,
          @suppressed, @dedup_key, @signature_hash, @source
        )`
      )
      .run(row);
  }

  findRecentDuplicate(workspaceId: string, dedupKey: string, windowStartIso: string): NotificationRow | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM notifications
         WHERE workspace_id = ?
           AND dedup_key = ?
           AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(workspaceId, dedupKey, windowStartIso) as NotificationRow | undefined;
    return row ?? null;
  }

  unreadNotifications(workspaceId?: string): NotificationRow[] {
    if (workspaceId) {
      return this.db
        .prepare("SELECT * FROM notifications WHERE read_at IS NULL AND workspace_id = ? ORDER BY created_at DESC")
        .all(workspaceId) as NotificationRow[];
    }
    return this.db
      .prepare("SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC")
      .all() as NotificationRow[];
  }

  markNotificationRead(id: string, readAt: string): void {
    this.db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?").run(readAt, id);
  }

  markNotificationDelivered(id: string, deliveredAt: string): void {
    this.db.prepare("UPDATE notifications SET delivered_at = ?, suppressed = 0 WHERE id = ?").run(deliveredAt, id);
  }

  markNotificationSuppressed(id: string): void {
    this.db.prepare("UPDATE notifications SET suppressed = 1 WHERE id = ?").run(id);
  }

  clearNotifications(workspaceId?: string): void {
    if (workspaceId) {
      this.db.prepare("UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND read_at IS NULL").run(new Date().toISOString(), workspaceId);
      return;
    }
    this.db.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").run(new Date().toISOString());
  }

  saveLayoutSnapshot(workspaceId: string, payload: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO layout_snapshots (workspace_id, payload, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .run(workspaceId, payload, now);
  }

  loadLayoutSnapshot(workspaceId: string): string | null {
    const row = this.db
      .prepare("SELECT payload FROM layout_snapshots WHERE workspace_id = ?")
      .get(workspaceId) as { payload: string } | undefined;
    return row?.payload ?? null;
  }

  private currentSchemaVersion(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 1) AS version FROM schema_versions")
      .get() as { version: number };
    return row?.version ?? 1;
  }

  private applyMigrations(): void {
    const current = this.currentSchemaVersion();
    const nextVersions = Object.keys(MIGRATIONS)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);

    for (const version of nextVersions) {
      if (version <= current) {
        continue;
      }

      const statements = MIGRATIONS[version] ?? [];
      const tx = this.db.transaction(() => {
        for (const statement of statements) {
          this.execMigrationStatement(statement);
        }
        this.db.prepare("INSERT OR IGNORE INTO schema_versions(version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
      });
      tx();
    }
  }

  private execMigrationStatement(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (err) {
      const message = String((err as Error)?.message ?? err).toLowerCase();
      if (message.includes("duplicate column name")) {
        return;
      }
      if (message.includes("already exists")) {
        return;
      }
      throw err;
    }
  }
}
