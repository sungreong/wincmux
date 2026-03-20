import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { DbStore } from "./db";
import { LayoutStore } from "./layout";
import { PtyManager } from "./pty";
import type { JsonRpcRequest, JsonRpcResponse, NotificationRow, SessionRow, WorkspaceRow } from "./types";
import {
  layoutCloseSchema,
  layoutFocusSchema,
  layoutListSchema,
  layoutSplitSchema,
  notifyClearSchema,
  notifyUnreadSchema,
  notificationReadSchema,
  notifyPushSchema,
  sessionCloseSchema,
  sessionResizeSchema,
  sessionListSchema,
  sessionReadSchema,
  sessionRunSchema,
  sessionStreamSubscribeSchema,
  sessionStreamUnsubscribeSchema,
  sessionWriteSchema,
  workspaceCreateSchema,
  workspaceDeleteSchema,
  workspacePinSchema,
  workspaceRenameSchema,
  workspaceReorderSchema
} from "./validation";

export interface CoreOptions {
  dbPath: string;
  pipeName?: string;
}

const DEFAULT_PIPE = "\\\\.\\pipe\\wincmux-rpc";

interface StreamSubscription {
  id: string;
  socket: net.Socket;
  workspace_id?: string;
  session_id?: string;
}

export class CoreEngine {
  private readonly db: DbStore;
  private readonly layout = new LayoutStore();
  private readonly pty = new PtyManager();
  private readonly outputBuffers = new Map<string, string>();
  private readonly sessionWorkspace = new Map<string, string>();
  private readonly streamSubscriptions = new Map<string, StreamSubscription>();
  private readonly socketSubscriptions = new Map<net.Socket, Set<string>>();
  private readonly server: net.Server;
  private gitTimer?: NodeJS.Timeout;

  constructor(private readonly options: CoreOptions) {
    this.db = new DbStore(options.dbPath);
    this.server = net.createServer((socket) => this.handleSocket(socket));
    this.gitTimer = setInterval(() => this.refreshGitStatus(), 3000);
  }

  async start(): Promise<void> {
    const pipeName = this.options.pipeName ?? DEFAULT_PIPE;

    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(pipeName, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop(): void {
    this.gitTimer && clearInterval(this.gitTimer);
    this.pty.closeAll();
    this.outputBuffers.clear();
    this.sessionWorkspace.clear();
    this.streamSubscriptions.clear();
    this.socketSubscriptions.clear();
    this.server.close();
    this.db.close();
  }

  dispatch(raw: unknown, socket?: net.Socket): JsonRpcResponse {
    const parsed = this.parseRequest(raw);
    if ("error" in parsed) {
      return parsed.error;
    }

    const req = parsed.request;
    if (req.jsonrpc !== "2.0") {
      return this.error(req.id ?? null, -32600, "invalid jsonrpc version");
    }

    try {
      switch (req.method) {
        case "health.check":
          return this.ok(req.id, { status: "ok" });
        case "workspace.create":
          return this.ok(req.id, this.workspaceCreate(req.params));
        case "workspace.list":
          return this.ok(req.id, { workspaces: this.db.listWorkspaces() });
        case "workspace.rename":
          return this.ok(req.id, this.workspaceRename(req.params));
        case "workspace.delete":
          return this.ok(req.id, this.workspaceDelete(req.params));
        case "workspace.pin":
          return this.ok(req.id, this.workspacePin(req.params));
        case "workspace.reorder":
          return this.ok(req.id, this.workspaceReorder(req.params));
        case "session.run":
          return this.ok(req.id, this.sessionRun(req.params));
        case "session.list":
          return this.ok(req.id, this.sessionList(req.params));
        case "session.close":
          return this.ok(req.id, this.sessionClose(req.params));
        case "session.resize":
          return this.ok(req.id, this.sessionResize(req.params));
        case "session.write":
          return this.ok(req.id, this.sessionWrite(req.params));
        case "session.read":
          return this.ok(req.id, this.sessionRead(req.params));
        case "session.stream.subscribe":
          return this.ok(req.id, this.sessionStreamSubscribe(req.params, socket));
        case "session.stream.unsubscribe":
          return this.ok(req.id, this.sessionStreamUnsubscribe(req.params));
        case "notify.push":
          return this.ok(req.id, this.notifyPush(req.params));
        case "notify.unread":
          return this.ok(req.id, this.notifyUnread(req.params));
        case "notify.mark_read":
          return this.ok(req.id, this.notifyMarkRead(req.params));
        case "notify.clear":
          return this.ok(req.id, this.notifyClear(req.params));
        case "layout.split":
          return this.ok(req.id, this.layoutSplit(req.params));
        case "layout.focus":
          return this.ok(req.id, this.layoutFocus(req.params));
        case "layout.close":
          return this.ok(req.id, this.layoutClose(req.params));
        case "layout.list":
          return this.ok(req.id, this.layoutList(req.params));
        default:
          return this.error(req.id, -32601, `method not found: ${req.method}`);
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        return this.error(req.id, -32602, error.issues.map((i) => i.message).join(", "));
      }
      const msg = error instanceof Error ? error.message : String(error);
      return this.error(req.id, -32000, msg);
    }
  }

  private workspaceCreate(params: unknown): { workspace: WorkspaceRow; root_pane_id: string } {
    const p = workspaceCreateSchema.parse(params ?? {});
    const normalizedPath = path.resolve(p.path);
    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`workspace path does not exist: ${normalizedPath}`);
    }
    const stat = fs.statSync(normalizedPath);
    if (!stat.isDirectory()) {
      throw new Error(`workspace path is not a directory: ${normalizedPath}`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const workspace = this.db.createWorkspace(id, p.name, normalizedPath, p.backend, now);
    const snapshot = this.db.loadLayoutSnapshot(id);
    if (snapshot) {
      this.layout.hydrate(id, snapshot);
    }
    const root = this.layout.rootPaneId(id);
    this.persistLayout(id);
    return { workspace, root_pane_id: root };
  }

  private workspaceRename(params: unknown): { ok: true } {
    const p = workspaceRenameSchema.parse(params ?? {});
    this.db.renameWorkspace(p.id, p.name, new Date().toISOString());
    return { ok: true };
  }

  private workspaceDelete(params: unknown): { ok: true } {
    const p = workspaceDeleteSchema.parse(params ?? {});
    const sessions = this.db.listSessions(p.id);
    for (const s of sessions) {
      this.pty.close(s.id);
      this.outputBuffers.delete(s.id);
    }
    this.db.deleteWorkspace(p.id);
    return { ok: true };
  }

  private workspacePin(params: unknown): { ok: true } {
    const p = workspacePinSchema.parse(params ?? {});
    this.db.setWorkspacePin(p.id, p.pinned);
    return { ok: true };
  }

  private workspaceReorder(params: unknown): { ok: true } {
    const p = workspaceReorderSchema.parse(params ?? {});
    this.db.reorderWorkspace(p.id, p.sort_order);
    return { ok: true };
  }

  private sessionRun(params: unknown): { session: { session_id: string; pid: number; status: "running" } } {
    const p = sessionRunSchema.parse(params ?? {});
    const sessionId = randomUUID();
    const pty = this.pty.run(sessionId, {
      cmd: p.cmd,
      args: p.args,
      cwd: p.cwd ?? process.cwd()
    });

    const row: SessionRow = {
      id: sessionId,
      workspace_id: p.workspace_id,
      pid: pty.pid,
      status: "running",
      started_at: new Date().toISOString(),
      ended_at: null,
      exit_code: null
    };

    this.db.insertSession(row);
    this.sessionWorkspace.set(sessionId, p.workspace_id);
    this.outputBuffers.set(sessionId, "");
    this.emitStreamEvent("session.state_changed", {
      session_id: sessionId,
      workspace_id: p.workspace_id,
      status: "running",
      pid: pty.pid
    });
    pty.onData((chunk) => {
      const prev = this.outputBuffers.get(sessionId) ?? "";
      const next = `${prev}${chunk}`;
      this.outputBuffers.set(sessionId, next.slice(-200_000));
      this.emitStreamEvent("session.output", {
        session_id: sessionId,
        workspace_id: p.workspace_id,
        output: chunk
      });
    });
    pty.onExit(({ exitCode }) => {
      this.db.updateSessionResult(sessionId, exitCode === 0 ? "exited" : "failed", new Date().toISOString(), exitCode);
      this.pty.close(sessionId);
      this.outputBuffers.delete(sessionId);
      this.emitStreamEvent("session.exit", {
        session_id: sessionId,
        workspace_id: p.workspace_id,
        exit_code: exitCode
      });
      this.emitStreamEvent("session.state_changed", {
        session_id: sessionId,
        workspace_id: p.workspace_id,
        status: exitCode === 0 ? "exited" : "failed",
        exit_code: exitCode
      });
      this.sessionWorkspace.delete(sessionId);
    });

    return { session: { session_id: sessionId, pid: pty.pid, status: "running" } };
  }

  private sessionList(params: unknown): { sessions: SessionRow[] } {
    const p = sessionListSchema.parse(params ?? {});
    return { sessions: this.db.listSessions(p.workspace_id) };
  }

  private sessionClose(params: unknown): { ok: true } {
    const p = sessionCloseSchema.parse(params ?? {});
    const workspaceId = this.sessionWorkspace.get(p.session_id) ?? null;
    this.pty.close(p.session_id);
    this.outputBuffers.delete(p.session_id);
    this.db.updateSessionResult(p.session_id, "exited", new Date().toISOString(), 0);
    this.emitStreamEvent("session.state_changed", {
      session_id: p.session_id,
      workspace_id: workspaceId,
      status: "exited",
      exit_code: 0
    });
    this.emitStreamEvent("session.exit", {
      session_id: p.session_id,
      workspace_id: workspaceId,
      exit_code: 0
    });
    this.sessionWorkspace.delete(p.session_id);
    return { ok: true };
  }

  private sessionResize(params: unknown): { ok: true } {
    const p = sessionResizeSchema.parse(params ?? {});
    this.pty.resize(p.session_id, p.cols, p.rows);
    return { ok: true };
  }

  private sessionWrite(params: unknown): { ok: true } {
    const p = sessionWriteSchema.parse(params ?? {});
    this.pty.write(p.session_id, p.data);
    return { ok: true };
  }

  private sessionRead(params: unknown): { output: string } {
    const p = sessionReadSchema.parse(params ?? {});
    const existing = this.outputBuffers.get(p.session_id) ?? "";
    if (existing.length === 0) {
      return { output: "" };
    }

    if (!p.max_bytes || existing.length <= p.max_bytes) {
      this.outputBuffers.set(p.session_id, "");
      return { output: existing };
    }

    const chunk = existing.slice(0, p.max_bytes);
    this.outputBuffers.set(p.session_id, existing.slice(p.max_bytes));
    return { output: chunk };
  }

  private sessionStreamSubscribe(params: unknown, socket?: net.Socket): { subscription_id: string } {
    if (!socket) {
      throw new Error("stream subscription requires persistent socket");
    }
    const p = sessionStreamSubscribeSchema.parse(params ?? {});
    const subscriptionId = randomUUID();
    const subscription: StreamSubscription = {
      id: subscriptionId,
      socket,
      workspace_id: p.workspace_id,
      session_id: p.session_id
    };

    this.streamSubscriptions.set(subscriptionId, subscription);
    let socketSubs = this.socketSubscriptions.get(socket);
    if (!socketSubs) {
      socketSubs = new Set<string>();
      this.socketSubscriptions.set(socket, socketSubs);
    }
    socketSubs.add(subscriptionId);

    return { subscription_id: subscriptionId };
  }

  private sessionStreamUnsubscribe(params: unknown): { ok: true } {
    const p = sessionStreamUnsubscribeSchema.parse(params ?? {});
    this.removeSubscription(p.subscription_id);
    return { ok: true };
  }

  private notifyPush(params: unknown): { notification: NotificationRow } {
    const p = notifyPushSchema.parse(params ?? {});
    const row: NotificationRow = {
      id: randomUUID(),
      workspace_id: p.workspace_id,
      title: p.title,
      body: p.body,
      level: p.level,
      created_at: new Date().toISOString(),
      read_at: null,
      source: p.source ?? "cli"
    };
    this.db.insertNotification(row);
    return { notification: row };
  }

  private notifyUnread(params: unknown): { items: NotificationRow[]; count: number } {
    const p = notifyUnreadSchema?.parse(params ?? {}) ?? {};
    const items = this.db.unreadNotifications(p?.workspace_id);
    return { items, count: items.length };
  }

  private notifyMarkRead(params: unknown): { ok: true } {
    const p = notificationReadSchema.parse(params ?? {});
    this.db.markNotificationRead(p.notification_id, new Date().toISOString());
    return { ok: true };
  }

  private notifyClear(params: unknown): { ok: true } {
    const p = notifyClearSchema?.parse(params ?? {}) ?? {};
    this.db.clearNotifications(p?.workspace_id);
    return { ok: true };
  }

  private layoutSplit(params: unknown): { pane_ids: [string, string] } {
    const p = layoutSplitSchema.parse(params ?? {});
    this.restoreLayoutIfNeeded(p.workspace_id);
    const paneIds = this.layout.split(p.workspace_id, p.pane_id, p.direction);
    this.persistLayout(p.workspace_id);
    return { pane_ids: paneIds };
  }

  private layoutFocus(params: unknown): { ok: true } {
    const p = layoutFocusSchema.parse(params ?? {});
    this.restoreLayoutIfNeeded(p.workspace_id);
    this.layout.focus(p.workspace_id, p.pane_id);
    this.persistLayout(p.workspace_id);
    return { ok: true };
  }

  private layoutClose(params: unknown): { focus_pane_id: string } {
    const p = layoutCloseSchema.parse(params ?? {});
    this.restoreLayoutIfNeeded(p.workspace_id);
    const focusPaneId = this.layout.close(p.workspace_id, p.pane_id);
    this.persistLayout(p.workspace_id);
    return { focus_pane_id: focusPaneId };
  }

  private layoutList(params: unknown): { panes: ReturnType<LayoutStore["list"]> } {
    const p = layoutListSchema.parse(params ?? {});
    this.restoreLayoutIfNeeded(p.workspace_id);
    return { panes: this.layout.list(p.workspace_id) };
  }

  private restoreLayoutIfNeeded(workspaceId: string): void {
    const snapshot = this.db.loadLayoutSnapshot(workspaceId);
    if (snapshot) {
      this.layout.hydrate(workspaceId, snapshot);
    } else {
      this.layout.ensure(workspaceId);
    }
  }

  private persistLayout(workspaceId: string): void {
    this.db.saveLayoutSnapshot(workspaceId, this.layout.serialize(workspaceId), new Date().toISOString());
  }

  private refreshGitStatus(): void {
    const workspaces = this.db.listWorkspaces();
    for (const ws of workspaces) {
      const branch = runGit(ws.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const dirtyText = runGit(ws.path, ["status", "--porcelain"]);
      this.db.updateWorkspaceGit(ws.id, branch ?? null, Boolean(dirtyText && dirtyText.trim().length));
    }
  }

  private handleSocket(socket: net.Socket): void {
    let buffer = "";
    socket.on("close", () => {
      const subIds = this.socketSubscriptions.get(socket);
      if (!subIds) {
        return;
      }
      for (const id of subIds) {
        this.streamSubscriptions.delete(id);
      }
      this.socketSubscriptions.delete(socket);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) {
          const raw = tryParse(line);
          const response = this.dispatch(raw, socket);
          socket.write(`${JSON.stringify(response)}\n`);
        }
        index = buffer.indexOf("\n");
      }
    });
  }

  private emitStreamEvent(method: string, params: Record<string, unknown>): void {
    for (const subscription of this.streamSubscriptions.values()) {
      if (!this.matchesStreamSubscription(subscription, params)) {
        continue;
      }

      if (subscription.socket.destroyed) {
        this.removeSubscription(subscription.id);
        continue;
      }

      try {
        subscription.socket.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      } catch {
        this.removeSubscription(subscription.id);
      }
    }
  }

  private matchesStreamSubscription(subscription: StreamSubscription, params: Record<string, unknown>): boolean {
    const sessionId = typeof params.session_id === "string" ? params.session_id : undefined;
    const workspaceId = typeof params.workspace_id === "string" ? params.workspace_id : undefined;

    if (subscription.session_id) {
      return sessionId === subscription.session_id;
    }
    if (subscription.workspace_id) {
      return workspaceId === subscription.workspace_id || (sessionId ? this.sessionWorkspace.get(sessionId) === subscription.workspace_id : false);
    }
    return true;
  }

  private removeSubscription(subscriptionId: string): void {
    const subscription = this.streamSubscriptions.get(subscriptionId);
    if (!subscription) {
      return;
    }
    this.streamSubscriptions.delete(subscriptionId);
    const socketSubs = this.socketSubscriptions.get(subscription.socket);
    if (!socketSubs) {
      return;
    }
    socketSubs.delete(subscriptionId);
    if (socketSubs.size === 0) {
      this.socketSubscriptions.delete(subscription.socket);
    }
  }

  private parseRequest(raw: unknown): { request: JsonRpcRequest } | { error: JsonRpcResponse } {
    if (!raw || typeof raw !== "object") {
      return { error: this.error(null, -32700, "parse error") };
    }

    const obj = raw as Record<string, unknown>;
    const method = obj.method;
    const id = obj.id;
    const jsonrpc = obj.jsonrpc;

    if (typeof method !== "string") {
      return { error: this.error(id as string | number | null, -32600, "invalid request") };
    }

    return {
      request: {
        jsonrpc: jsonrpc === "2.0" ? "2.0" : (jsonrpc as "2.0"),
        id: typeof id === "string" || typeof id === "number" || id === null ? id : null,
        method,
        params: obj.params
      }
    };
  }

  private ok(id: string | number | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private error(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    const out = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    if (out.status !== 0) {
      return null;
    }
    return out.stdout.trim();
  } catch {
    return null;
  }
}

function tryParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
