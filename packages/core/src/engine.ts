import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { DbStore } from "./db";
import { LayoutStore } from "./layout";
import {
  computeCompletionDedupKey,
  computePromptDedupKey,
  extractAiResumeMarker,
  extractAssistantResponsePreview,
  extractAssistantReadyMarker,
  extractPromptMarker,
  hasAssistantPromptContext,
  hasAssistantResponseActivity,
  normalizePromptText
} from "./notify-detector";
import { PtyManager } from "./pty";
import type { AiSessionRow, JsonRpcRequest, JsonRpcResponse, NotificationRow, SessionRow, StreamTopic, WorkspaceRow } from "./types";
import {
  aiSessionDeleteSchema,
  groupCreateSchema,
  groupDeleteSchema,
  groupRenameSchema,
  layoutCloseSchema,
  layoutFocusSchema,
  layoutListSchema,
  layoutMoveSchema,
  layoutSplitSchema,
  layoutSwapSchema,
  notifyClearSchema,
  notifyDeliveryAckSchema,
  notifyUnreadSchema,
  notificationReadSchema,
  notifyPushSchema,
  paneSessionBindSchema,
  sessionCloseSchema,
  sessionDeleteSchema,
  sessionGroupSetSchema,
  sessionResizeSchema,
  sessionListSchema,
  sessionReadSchema,
  sessionRunSchema,
  sessionTailSchema,
  sessionStreamSubscribeSchema,
  sessionStreamUnsubscribeSchema,
  sessionWriteSchema,
  workspaceCreateSchema,
  workspaceDeleteSchema,
  workspaceDescribeSchema,
  workspaceIdSchema,
  workspacePinSchema,
  workspaceRenameSchema,
  workspaceReorderSchema
} from "./validation";

export interface CoreOptions {
  dbPath: string;
  pipeName?: string;
}

const DEFAULT_PIPE = "\\\\.\\pipe\\wincmux-rpc";
const SESSION_OUTPUT_BATCH_DELAY_MS = 8;
const SESSION_OUTPUT_BATCH_MAX_CHARS = 32_768;
const SESSION_OUTPUT_BUFFER_KEEP_CHARS = 200_000;
const GIT_STATUS_TIMER_INTERVAL_MS = 3_000;
const GIT_STATUS_ACTIVE_INTERVAL_MS = 8_000;
const GIT_STATUS_INACTIVE_INTERVAL_MS = 45_000;
const GIT_STATUS_MAX_IN_FLIGHT = 1;
const GIT_STATUS_TERMINAL_IDLE_MS = 1_500;
const AI_RESUME_OUTPUT_PROBE = /\b(?:claude|codex|resume|session|conversation|found)\b|[0-9a-f]{8}-[0-9a-f-]{8,}/i;
const PROMPT_OUTPUT_PROBE = /\b(?:claude|codex|gpt-\S+|sonnet|opus|run\s+shell\s+command|do\s+you\s+want|should\s+i|waiting|awaiting|need\s+(?:your\s+)?(?:input|response|confirmation|approval)|enter\s+to\s+confirm|esc\s+to\s+cancel|yes\s*\/\s*no|ready\s+to\s+help|how\s+can\s+i\s+help|what\s+would\s+you\s+like)\b|(?:대기\s*중입니다|도와드릴까요|입력을?\s*기다리고|응답을?\s*기다리고|실행|수정|변경|진행|계속|허용|승인)/i;
const ASSISTANT_COMMAND_INPUT_PROBE = /\b(?:claude|codex)\b/i;
const PROMPT_OUTPUT_INSPECT_CHARS = 8_192;

function consumeSocketLines(buffer: string, chunk: Buffer, onLine: (line: string) => false | void): string {
  const next = buffer + chunk.toString("utf8");
  let start = 0;
  let index = next.indexOf("\n", start);
  while (index >= 0) {
    const line = next.slice(start, index).trim();
    start = index + 1;
    if (line.length > 0 && onLine(line) === false) {
      return "";
    }
    index = next.indexOf("\n", start);
  }
  return start > 0 ? next.slice(start) : next;
}

function promptOutputSlice(outputChunk: string): string {
  return outputChunk.length > PROMPT_OUTPUT_INSPECT_CHARS
    ? outputChunk.slice(-PROMPT_OUTPUT_INSPECT_CHARS)
    : outputChunk;
}

interface StreamSubscription {
  id: string;
  socket: net.Socket;
  workspace_id?: string;
  session_id?: string;
  topics: StreamTopic[];
}

interface SessionOutputBatch {
  workspace_id: string;
  chunks: string[];
  length: number;
  timer: NodeJS.Timeout;
}

interface GitStatusResult {
  branch: string | null;
  dirty: boolean;
}

interface PromptDetectorState {
  buffer: string;
  input_buffer: string;
  assistant_session: boolean;
  assistant_context_seen: boolean;
  last_notified_at: number;
  last_signature: string;
  response_active: boolean;
  response_turn_id: number;
  last_completion_notified_at: number;
  last_output_at: number;
  user_input_seen_at: number;
  user_turn_id: number;
  notified_turn_id: number;
  ready_visible: boolean;
  bootstrapped_ready: boolean;
  completion_timer: NodeJS.Timeout | null;
}

class SessionTextBuffer {
  private chunks: string[] = [];
  private headIndex = 0;
  private lengthValue = 0;

  constructor(private readonly keepChars: number) {}

  get length(): number {
    return this.lengthValue;
  }

  append(chunk: string): void {
    if (!chunk) {
      return;
    }
    this.chunks.push(chunk);
    this.lengthValue += chunk.length;
    if (this.lengthValue > this.keepChars) {
      this.dropStart(this.lengthValue - this.keepChars);
    }
  }

  clear(): void {
    this.chunks = [];
    this.headIndex = 0;
    this.lengthValue = 0;
  }

  drain(maxChars?: number): string {
    if (this.lengthValue === 0) {
      return "";
    }
    if (!maxChars || this.lengthValue <= maxChars) {
      const output = this.snapshot();
      this.clear();
      return output;
    }
    return this.takeStart(maxChars);
  }

  tail(maxChars?: number): string {
    if (this.lengthValue === 0) {
      return "";
    }
    if (!maxChars || this.lengthValue <= maxChars) {
      return this.snapshot();
    }
    const parts: string[] = [];
    let remaining = maxChars;
    for (let index = this.chunks.length - 1; index >= this.headIndex && remaining > 0; index -= 1) {
      const chunk = this.chunks[index] ?? "";
      if (chunk.length <= remaining) {
        parts.push(chunk);
        remaining -= chunk.length;
      } else {
        parts.push(chunk.slice(-remaining));
        remaining = 0;
      }
    }
    return parts.reverse().join("");
  }

  snapshot(): string {
    const chunkCount = this.chunks.length - this.headIndex;
    if (chunkCount <= 0) {
      return "";
    }
    if (chunkCount === 1) {
      return this.chunks[this.headIndex] ?? "";
    }
    return this.chunks.slice(this.headIndex).join("");
  }

  private takeStart(maxChars: number): string {
    const parts: string[] = [];
    let remaining = maxChars;
    while (remaining > 0 && this.headIndex < this.chunks.length) {
      const first = this.chunks[this.headIndex] ?? "";
      if (first.length <= remaining) {
        parts.push(first);
        this.headIndex += 1;
        this.lengthValue -= first.length;
        remaining -= first.length;
        continue;
      }
      parts.push(first.slice(0, remaining));
      this.chunks[this.headIndex] = first.slice(remaining);
      this.lengthValue -= remaining;
      remaining = 0;
    }
    this.compactConsumed();
    return parts.join("");
  }

  private dropStart(charsToDrop: number): void {
    let remaining = charsToDrop;
    while (remaining > 0 && this.headIndex < this.chunks.length) {
      const first = this.chunks[this.headIndex] ?? "";
      if (first.length <= remaining) {
        this.headIndex += 1;
        this.lengthValue -= first.length;
        remaining -= first.length;
        continue;
      }
      this.chunks[this.headIndex] = first.slice(remaining);
      this.lengthValue -= remaining;
      remaining = 0;
    }
    this.compactConsumed();
  }

  private compactConsumed(): void {
    if (this.headIndex === 0) {
      return;
    }
    if (this.headIndex >= this.chunks.length) {
      this.chunks = [];
      this.headIndex = 0;
      return;
    }
    if (this.headIndex >= 64 && this.headIndex * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.headIndex);
      this.headIndex = 0;
    }
  }
}

export class CoreEngine {
  private readonly db: DbStore;
  private readonly layout = new LayoutStore();
  private readonly pty = new PtyManager();
  private readonly drainBuffers = new Map<string, SessionTextBuffer>();
  private readonly tailBuffers = new Map<string, SessionTextBuffer>();
  private readonly sessionWorkspace = new Map<string, string>();
  private readonly streamSubscriptions = new Map<string, StreamSubscription>();
  private readonly socketSubscriptions = new Map<net.Socket, Set<string>>();
  private readonly streamGlobalSubscriptions = new Map<StreamTopic, Set<string>>();
  private readonly streamWorkspaceSubscriptions = new Map<StreamTopic, Map<string, Set<string>>>();
  private readonly streamSessionSubscriptions = new Map<StreamTopic, Map<string, Set<string>>>();
  private readonly sessionOutputBatches = new Map<string, SessionOutputBatch>();
  private readonly gitNextDue = new Map<string, number>();
  // Tracks resume_cmd strings already recorded per PTY session to avoid per-chunk re-upserts
  private readonly seenAiResumeCmds = new Map<string, Set<string>>();
  private readonly promptDetector = new Map<string, PromptDetectorState>();
  private readonly server: net.Server;
  private gitTimer?: NodeJS.Timeout;
  private gitInFlight = 0;
  private activeWorkspaceId: string | null = null;
  private lastTerminalActivityAt = 0;
  private stopped = false;

  constructor(private readonly options: CoreOptions) {
    this.db = new DbStore(options.dbPath);
    this.server = net.createServer((socket) => this.handleSocket(socket));
    this.gitTimer = setInterval(() => { void this.refreshGitStatus(); }, GIT_STATUS_TIMER_INTERVAL_MS);
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
    this.stopped = true;
    this.gitTimer && clearInterval(this.gitTimer);
    for (const batch of this.sessionOutputBatches.values()) {
      clearTimeout(batch.timer);
    }
    for (const detectorState of this.promptDetector.values()) {
      if (detectorState.completion_timer) {
        clearTimeout(detectorState.completion_timer);
      }
    }
    this.pty.closeAll();
    this.drainBuffers.clear();
    this.tailBuffers.clear();
    this.sessionWorkspace.clear();
    this.promptDetector.clear();
    this.streamSubscriptions.clear();
    this.socketSubscriptions.clear();
    this.streamGlobalSubscriptions.clear();
    this.streamWorkspaceSubscriptions.clear();
    this.streamSessionSubscriptions.clear();
    this.sessionOutputBatches.clear();
    this.gitNextDue.clear();
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
        case "workspace.describe":
          return this.ok(req.id, this.workspaceDescribe(req.params));
        case "workspace.delete":
          return this.ok(req.id, this.workspaceDelete(req.params));
        case "workspace.pin":
          return this.ok(req.id, this.workspacePin(req.params));
        case "workspace.reorder":
          return this.ok(req.id, this.workspaceReorder(req.params));
        case "workspace.activate":
          return this.ok(req.id, this.workspaceActivate(req.params));
        case "group.list":
          return this.ok(req.id, this.groupList(req.params));
        case "group.create":
          return this.ok(req.id, this.groupCreate(req.params));
        case "group.rename":
          return this.ok(req.id, this.groupRename(req.params));
        case "group.delete":
          return this.ok(req.id, this.groupDelete(req.params));
        case "session.run":
          return this.ok(req.id, this.sessionRun(req.params));
        case "session.list":
          return this.ok(req.id, this.sessionList(req.params));
        case "session.close":
          return this.ok(req.id, this.sessionClose(req.params));
        case "session.delete":
          return this.ok(req.id, this.sessionDelete(req.params));
        case "session.group.set":
          return this.ok(req.id, this.sessionGroupSet(req.params));
        case "session.group.list":
          return this.ok(req.id, this.sessionGroupList(req.params));
        case "session.resize":
          return this.ok(req.id, this.sessionResize(req.params));
        case "session.write":
          return this.ok(req.id, this.sessionWrite(req.params));
        case "session.read":
          return this.ok(req.id, this.sessionRead(req.params));
        case "session.tail":
          return this.ok(req.id, this.sessionTail(req.params));
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
        case "notify.delivery_ack":
          return this.ok(req.id, this.notifyDeliveryAck(req.params));
        case "layout.split":
          return this.ok(req.id, this.layoutSplit(req.params));
        case "layout.focus":
          return this.ok(req.id, this.layoutFocus(req.params));
        case "layout.close":
          return this.ok(req.id, this.layoutClose(req.params));
        case "layout.swap":
          return this.ok(req.id, this.layoutSwap(req.params));
        case "layout.move":
          return this.ok(req.id, this.layoutMove(req.params));
        case "layout.list":
          return this.ok(req.id, this.layoutList(req.params));
        case "pane.session.bind":
          return this.ok(req.id, this.paneSessionBind(req.params));
        case "pane.session.bindings":
          return this.ok(req.id, this.paneSessionBindings(req.params));
        case "session.history":
          return this.ok(req.id, this.sessionHistory(req.params));
        case "ai.sessions":
          return this.ok(req.id, this.aiSessions(req.params));
        case "ai.session.delete":
          return this.ok(req.id, this.aiSessionDelete(req.params));
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
    this.db.ensureDefaultPaneGroups(id);
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

  private workspaceDescribe(params: unknown): { ok: true } {
    const p = workspaceDescribeSchema.parse(params ?? {});
    this.db.updateWorkspaceDescription(p.id, p.description);
    return { ok: true };
  }

  private workspaceDelete(params: unknown): { ok: true } {
    const p = workspaceDeleteSchema.parse(params ?? {});
    const sessions = this.db.listSessions(p.id);
    for (const s of sessions) {
      this.flushSessionOutputBatch(s.id);
      this.pty.close(s.id);
      this.drainBuffers.delete(s.id);
      this.tailBuffers.delete(s.id);
      this.clearPromptDetector(s.id);
      this.clearSessionOutputBatch(s.id);
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

  private workspaceActivate(params: unknown): { ok: true } {
    const p = workspaceIdSchema.parse(params ?? {});
    this.activeWorkspaceId = p.workspace_id;
    this.gitNextDue.set(p.workspace_id, 0);
    void this.refreshGitStatus();
    return { ok: true };
  }

  private groupList(params: unknown): { groups: ReturnType<DbStore["listPaneGroups"]> } {
    const p = workspaceIdSchema.parse(params ?? {});
    return { groups: this.db.ensureDefaultPaneGroups(p.workspace_id) };
  }

  private groupCreate(params: unknown): { group: ReturnType<DbStore["createPaneGroup"]> } {
    const p = groupCreateSchema.parse(params ?? {});
    return { group: this.db.createPaneGroup(p.workspace_id, p.name, p.color ?? null) };
  }

  private groupRename(params: unknown): { ok: true } {
    const p = groupRenameSchema.parse(params ?? {});
    this.db.renamePaneGroup(p.group_id, p.name);
    return { ok: true };
  }

  private groupDelete(params: unknown): { ok: true } {
    const p = groupDeleteSchema.parse(params ?? {});
    this.db.deletePaneGroup(p.group_id, p.move_to_group_id ?? null);
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
      exit_code: null,
      spawn_cmd: p.cmd,
      spawn_args: JSON.stringify(p.args ?? []),
      spawn_cwd: p.cwd ?? null
    };

    this.db.insertSession(row);
    this.db.pruneRedundantSessionHistory(p.workspace_id);
    this.sessionWorkspace.set(sessionId, p.workspace_id);
    this.drainBuffers.set(sessionId, new SessionTextBuffer(SESSION_OUTPUT_BUFFER_KEEP_CHARS));
    this.tailBuffers.set(sessionId, new SessionTextBuffer(SESSION_OUTPUT_BUFFER_KEEP_CHARS));
    const assistantSession = isAssistantCommand(p.cmd, p.args ?? []);
    this.promptDetector.set(sessionId, {
      buffer: "",
      input_buffer: "",
      assistant_session: assistantSession,
      assistant_context_seen: assistantSession,
      last_notified_at: 0,
      last_signature: "",
      response_active: false,
      response_turn_id: 0,
      last_completion_notified_at: 0,
      last_output_at: 0,
      user_input_seen_at: 0,
      user_turn_id: 0,
      notified_turn_id: 0,
      ready_visible: false,
      bootstrapped_ready: false,
      completion_timer: null
    });
    this.emitStreamEvent("session.state_changed", {
      session_id: sessionId,
      workspace_id: p.workspace_id,
      status: "running",
      pid: pty.pid
    });
    pty.onData((chunk) => {
      this.noteTerminalActivity();
      this.appendSessionOutput(sessionId, chunk);
      this.queueSessionOutput(sessionId, p.workspace_id, chunk);
    });
    pty.onExit(({ exitCode }) => {
      this.db.updateSessionResult(sessionId, exitCode === 0 ? "exited" : "failed", new Date().toISOString(), exitCode);
      this.db.pruneRedundantSessionHistory(p.workspace_id);
      // Scan the full output buffer before deleting — catches resume markers split across chunks
      const finalBuffer = this.tailBuffers.get(sessionId)?.tail(3_000) ?? "";
      if (finalBuffer.length >= 20) {
        this.maybeRecordAiResume({
          workspace_id: p.workspace_id,
          session_id: sessionId,
          output_chunk: finalBuffer
        });
      }
      this.flushSessionOutputBatch(sessionId);
      // Process has already exited — remove from map without re-killing
      this.pty.remove(sessionId);
      this.drainBuffers.delete(sessionId);
      this.clearPromptDetector(sessionId);
      this.seenAiResumeCmds.delete(sessionId);
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
    this.flushSessionOutputBatch(p.session_id);
    this.pty.close(p.session_id);
    this.drainBuffers.delete(p.session_id);
    this.tailBuffers.delete(p.session_id);
    this.clearPromptDetector(p.session_id);
    this.seenAiResumeCmds.delete(p.session_id);
    this.db.updateSessionResult(p.session_id, "exited", new Date().toISOString(), 0);
    this.db.clearPaneSessionBindingBySession(p.session_id);
    if (workspaceId) {
      this.db.pruneRedundantSessionHistory(workspaceId);
    }
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

  private sessionDelete(params: unknown): { ok: true } {
    const p = sessionDeleteSchema.parse(params ?? {});
    this.db.deleteSession(p.session_id);
    return { ok: true };
  }

  private sessionGroupSet(params: unknown): { ok: true } {
    const p = sessionGroupSetSchema.parse(params ?? {});
    this.db.setSessionGroup(p.workspace_id, p.session_id, p.group_id);
    return { ok: true };
  }

  private sessionGroupList(params: unknown): { bindings: ReturnType<DbStore["listSessionGroupBindings"]> } {
    const p = workspaceIdSchema.parse(params ?? {});
    this.db.ensureDefaultPaneGroups(p.workspace_id);
    return { bindings: this.db.listSessionGroupBindings(p.workspace_id) };
  }

  private sessionResize(params: unknown): { ok: true } {
    const p = sessionResizeSchema.parse(params ?? {});
    this.pty.resize(p.session_id, p.cols, p.rows);
    return { ok: true };
  }

  private sessionWrite(params: unknown): { ok: true } {
    const p = sessionWriteSchema.parse(params ?? {});
    this.noteTerminalActivity();
    this.noteSessionInput(p.session_id, p.data);
    this.pty.write(p.session_id, p.data);
    return { ok: true };
  }

  private sessionRead(params: unknown): { output: string } {
    const p = sessionReadSchema.parse(params ?? {});
    const buffer = this.drainBuffers.get(p.session_id);
    if (!buffer || buffer.length === 0) {
      return { output: "" };
    }

    return { output: buffer.drain(p.max_bytes) };
  }

  private sessionTail(params: unknown): { output: string } {
    const p = sessionTailSchema.parse(params ?? {});
    return { output: this.tailBuffers.get(p.session_id)?.tail(p.max_bytes) ?? "" };
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
      session_id: p.session_id,
      topics: p.topics
    };

    this.streamSubscriptions.set(subscriptionId, subscription);
    this.addSubscriptionIndex(subscription);
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

  private notifyPush(params: unknown): { notification: NotificationRow; deduped: boolean } {
    const p = notifyPushSchema.parse(params ?? {});
    const now = new Date().toISOString();
    const dedupKey = (
      p.dedup_key ??
      [p.workspace_id, p.session_id ?? "", p.kind, p.title, p.body].join("|").toLowerCase()
    ).slice(0, 200);
    const windowStart = new Date(Date.now() - 30_000).toISOString();
    const duplicate = this.db.findRecentDuplicate(p.workspace_id, dedupKey, windowStart);
    if (duplicate) {
      return { notification: duplicate, deduped: true };
    }

    const row: NotificationRow = {
      id: randomUUID(),
      workspace_id: p.workspace_id,
      session_id: p.session_id ?? null,
      pane_id: p.pane_id ?? null,
      kind: p.kind,
      source_kind: p.source_kind,
      title: p.title,
      body: p.body,
      level: p.level,
      created_at: now,
      delivered_at: null,
      read_at: null,
      suppressed: 0,
      dedup_key: dedupKey,
      signature_hash: dedupKey,
      source: p.source ?? "cli"
    };
    this.db.insertNotification(row);
    this.emitStreamEvent("notify.created", {
      workspace_id: row.workspace_id,
      session_id: row.session_id ?? undefined,
      notification: row
    });
    return { notification: row, deduped: false };
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

  private notifyDeliveryAck(params: unknown): { ok: true } {
    const p = notifyDeliveryAckSchema.parse(params ?? {});
    if (p.delivered) {
      this.db.markNotificationDelivered(p.notification_id, new Date().toISOString());
    }
    if (p.suppressed) {
      this.db.markNotificationSuppressed(p.notification_id);
    }
    return { ok: true };
  }

  private maybeRecordAiResume(input: {
    workspace_id: string;
    session_id: string;
    output_chunk: string;
  }): void {
    // Skip short chunks — resume patterns are always >50 chars
    if (input.output_chunk.length < 20) return;
    if (!AI_RESUME_OUTPUT_PROBE.test(input.output_chunk)) return;
    const marker = extractAiResumeMarker(input.output_chunk);
    if (!marker) return;
    // Dedup: same resume_cmd already recorded for this session
    const seenForSession = this.seenAiResumeCmds.get(input.session_id) ?? new Set<string>();
    if (seenForSession.has(marker.resume_cmd)) return;
    seenForSession.add(marker.resume_cmd);
    this.seenAiResumeCmds.set(input.session_id, seenForSession);
    // Use SHA-based stable ID derived from resume_cmd for consistent upsert key
    const id = Buffer.from(marker.resume_cmd).toString("base64url").slice(0, 32).replace(/[^a-z0-9]/gi, "x");
    const sessionRow = this.db.getSession(input.session_id);
    const row: AiSessionRow = {
      id,
      workspace_id: input.workspace_id,
      pty_session_id: input.session_id,
      tool: marker.tool,
      resume_cmd: marker.resume_cmd,
      cwd: sessionRow?.spawn_cwd ?? null,
      detected_at: new Date().toISOString()
    };
    process.stderr.write(`[wincmux] AI resume detected: ${marker.resume_cmd}\n`);
    try {
      this.db.upsertAiSession(row);
      process.stderr.write(`[wincmux] AI resume saved OK\n`);
    } catch (err) {
      process.stderr.write(`[wincmux] upsertAiSession error: ${err}\n`);
    }
  }

  private shouldInspectPromptOutput(detectorState: PromptDetectorState, outputChunk: string): boolean {
    if (
      detectorState.assistant_session
      || detectorState.response_active
      || detectorState.ready_visible
      || detectorState.user_turn_id > detectorState.notified_turn_id
      || detectorState.assistant_context_seen
    ) {
      return true;
    }
    return PROMPT_OUTPUT_PROBE.test(outputChunk);
  }

  private maybeIngestPromptPattern(input: {
    workspace_id: string;
    session_id: string;
    output_chunk: string;
  }): void {
    const detectorState = this.promptDetector.get(input.session_id);
    if (!detectorState) {
      return;
    }
    const inspectedOutput = promptOutputSlice(input.output_chunk);
    if (!this.shouldInspectPromptOutput(detectorState, inspectedOutput)) {
      return;
    }

    const text = normalizePromptText(inspectedOutput);
    if (!text) {
      return;
    }

    const nowMs = Date.now();
    detectorState.buffer = `${detectorState.buffer} ${text}`.slice(-5000);
    detectorState.last_output_at = nowMs;
    if (!detectorState.assistant_context_seen && hasAssistantPromptContext(detectorState.buffer)) {
      detectorState.assistant_context_seen = true;
    }
    const hasAssistantContext = detectorState.assistant_session || detectorState.assistant_context_seen;
    if (!hasAssistantContext) {
      return;
    }
    const outputLooksLikeResponse = hasAssistantResponseActivity(text)
      || (
        detectorState.assistant_session
        && detectorState.user_turn_id > detectorState.notified_turn_id
        && text.length >= 16
      );
    if (outputLooksLikeResponse && detectorState.user_turn_id > detectorState.notified_turn_id) {
      detectorState.response_active = true;
      detectorState.response_turn_id = detectorState.user_turn_id;
      this.scheduleAssistantCompletionIdleCheck({
        workspace_id: input.workspace_id,
        session_id: input.session_id,
        observed_at: nowMs
      });
    }

    const marker = extractPromptMarker(detectorState.buffer);
    if (marker) {
      const signature = marker.snippet.toLowerCase();
      if (nowMs - detectorState.last_notified_at >= 30_000 || detectorState.last_signature !== signature) {
        detectorState.last_notified_at = nowMs;
        detectorState.last_signature = signature;
        const shortSession = input.session_id.slice(0, 8);
        this.notifyPush({
          workspace_id: input.workspace_id,
          session_id: input.session_id,
          pane_id: null,
          kind: "assistant_prompt",
          source_kind: "pattern",
          title: "Assistant input requested",
          body: `session ${shortSession}: ${marker.snippet}`,
          level: "info",
          source: "core-pattern-detector",
          dedup_key: computePromptDedupKey(input.session_id, marker.snippet)
        });
      }
    }

    const readyMarker = extractAssistantReadyMarker(detectorState.buffer);
    if (!readyMarker) {
      detectorState.ready_visible = false;
      return;
    }
    detectorState.ready_visible = true;
    if (!detectorState.bootstrapped_ready) {
      detectorState.bootstrapped_ready = true;
      detectorState.response_active = false;
      return;
    }
    if (!detectorState.response_active) {
      return;
    }
    this.notifyAssistantCompletion({
      workspace_id: input.workspace_id,
      session_id: input.session_id,
      ready_marker: readyMarker
    });
  }

  private scheduleAssistantCompletionIdleCheck(input: {
    workspace_id: string;
    session_id: string;
    observed_at: number;
  }): void {
    const detectorState = this.promptDetector.get(input.session_id);
    if (!detectorState) {
      return;
    }
    if (detectorState.completion_timer) {
      clearTimeout(detectorState.completion_timer);
    }
    detectorState.completion_timer = setTimeout(() => {
      this.maybeNotifyAssistantIdleCompletion(input);
    }, 3500);
  }

  private maybeNotifyAssistantIdleCompletion(input: {
    workspace_id: string;
    session_id: string;
    observed_at: number;
  }): void {
    const detectorState = this.promptDetector.get(input.session_id);
    if (!detectorState) {
      return;
    }
    detectorState.completion_timer = null;
    if (!detectorState.response_active || detectorState.last_output_at !== input.observed_at) {
      return;
    }
    if (!detectorState.assistant_session && !detectorState.assistant_context_seen) {
      return;
    }
    if (!detectorState.bootstrapped_ready
      && !extractAssistantReadyMarker(detectorState.buffer)
      && !(detectorState.assistant_session && detectorState.user_input_seen_at > 0)) {
      return;
    }
    if (extractPromptMarker(detectorState.buffer)) {
      return;
    }
    this.notifyAssistantCompletion({
      workspace_id: input.workspace_id,
      session_id: input.session_id,
      ready_marker: extractAssistantReadyMarker(detectorState.buffer) ?? "idle_quiet"
    });
  }

  private notifyAssistantCompletion(input: {
    workspace_id: string;
    session_id: string;
    ready_marker: string;
  }): void {
    const detectorState = this.promptDetector.get(input.session_id);
    if (!detectorState?.response_active) {
      return;
    }
    const turnId = detectorState.response_turn_id || detectorState.user_turn_id;
    if (turnId <= 0 || turnId <= detectorState.notified_turn_id) {
      detectorState.response_active = false;
      return;
    }
    const nowMs = Date.now();
    if (nowMs - detectorState.last_completion_notified_at < 1500) {
      return;
    }
    detectorState.last_completion_notified_at = nowMs;
    detectorState.notified_turn_id = turnId;
    detectorState.response_active = false;
    detectorState.response_turn_id = 0;
    if (detectorState.completion_timer) {
      clearTimeout(detectorState.completion_timer);
      detectorState.completion_timer = null;
    }
    const shortSession = input.session_id.slice(0, 8);
    const preview = extractAssistantResponsePreview(detectorState.buffer);
    this.notifyPush({
      workspace_id: input.workspace_id,
      session_id: input.session_id,
      pane_id: null,
      kind: "task_done",
      source_kind: "pattern",
      title: "Assistant response completed",
      body: preview ?? `session ${shortSession}: response is ready`,
      level: "success",
      source: "core-pattern-detector",
      dedup_key: computeCompletionDedupKey(input.session_id, `turn:${turnId}`)
    });
  }

  private noteSessionInput(sessionId: string, data: string): void {
    const detectorState = this.promptDetector.get(sessionId);
    if (!detectorState) {
      return;
    }
    const normalizedInput = data
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\r\n|\r|\n/g, "\n")
      .replace(/[^\S\n]+/g, " ");
    detectorState.input_buffer = `${detectorState.input_buffer}${normalizedInput}`.slice(-800);
    if (ASSISTANT_COMMAND_INPUT_PROBE.test(detectorState.input_buffer)) {
      detectorState.assistant_session = true;
      detectorState.assistant_context_seen = true;
    }
    if (/\r|\n/.test(data)) {
      detectorState.user_turn_id += 1;
      detectorState.user_input_seen_at = Date.now();
      detectorState.response_active = false;
      detectorState.response_turn_id = 0;
      detectorState.ready_visible = false;
    }
  }

  private paneSessionBind(params: unknown): { ok: true } {
    const p = paneSessionBindSchema.parse(params);
    this.db.savePaneSessionBinding(p.workspace_id, p.pane_id, p.session_id);
    return { ok: true };
  }

  private paneSessionBindings(params: unknown): { bindings: Array<{ pane_id: string; session_id: string; spawn_cmd: string | null; spawn_args: string | null; spawn_cwd: string | null }> } {
    const p = workspaceIdSchema.parse(params);
    const bindings = this.db.loadPaneSessionBindings(p.workspace_id);
    return {
      bindings: bindings.map((b) => {
        const session = this.db.getSession(b.session_id);
        return {
          pane_id: b.pane_id,
          session_id: b.session_id,
          spawn_cmd: session?.spawn_cmd ?? null,
          spawn_args: session?.spawn_args ?? null,
          spawn_cwd: session?.spawn_cwd ?? null
        };
      })
    };
  }

  private sessionHistory(params: unknown): { sessions: Array<{ id: string; status: string; spawn_cmd: string | null; spawn_args: string | null; spawn_cwd: string | null; started_at: string }> } {
    const p = workspaceIdSchema.parse(params);
    this.db.pruneRedundantSessionHistory(p.workspace_id);
    const rows = this.db.listAllSessions(p.workspace_id);
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        status: r.status,
        spawn_cmd: r.spawn_cmd ?? null,
        spawn_args: r.spawn_args ?? null,
        spawn_cwd: r.spawn_cwd ?? null,
        started_at: r.started_at
      }))
    };
  }

  private aiSessions(params: unknown): { sessions: AiSessionRow[] } {
    const p = workspaceIdSchema.parse(params);
    return { sessions: this.db.listAiSessions(p.workspace_id) };
  }

  private aiSessionDelete(params: unknown): { ok: true; deleted: number } {
    const p = aiSessionDeleteSchema.parse(params ?? {});
    return { ok: true, deleted: this.db.deleteAiSession(p.ai_session_id) };
  }

  private maybeDeleteFailedAiResume(input: { workspace_id: string; output_chunk: string }): void {
    const text = input.output_chunk;
    if (!AI_RESUME_OUTPUT_PROBE.test(text) || !/conversation\s+found|conversation\s+.*not\s+found|no\s+conversation/i.test(text)) {
      return;
    }
    const match = text.match(/session\s+ID:\s*([0-9a-f][0-9a-f-]{7,})/i)
      ?? text.match(/\b([0-9a-f]{8}-[0-9a-f-]{13,})\b/i);
    const token = match?.[1];
    if (!token) {
      return;
    }
    const deleted = this.db.deleteAiSessionByResumeToken(input.workspace_id, token);
    if (deleted > 0) {
      this.emitStreamEvent("ai.session.deleted", {
        workspace_id: input.workspace_id,
        token,
        deleted
      });
    }
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

  private layoutSwap(params: unknown): { ok: true } {
    const p = layoutSwapSchema.parse(params ?? {});
    this.restoreLayoutIfNeeded(p.workspace_id);
    this.layout.swap(p.workspace_id, p.first_pane_id, p.second_pane_id);
    this.persistLayout(p.workspace_id);
    return { ok: true };
  }

  private layoutMove(params: unknown): { ok: true } {
    const p = layoutMoveSchema.parse(params ?? {});
    this.restoreLayoutIfNeeded(p.workspace_id);
    this.layout.move(p.workspace_id, p.source_pane_id, p.target_pane_id, p.placement);
    this.persistLayout(p.workspace_id);
    return { ok: true };
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

  private noteTerminalActivity(): void {
    this.lastTerminalActivityAt = Date.now();
  }

  private hasRecentTerminalActivity(now = Date.now()): boolean {
    return now - this.lastTerminalActivityAt < GIT_STATUS_TERMINAL_IDLE_MS;
  }

  private async refreshGitStatus(): Promise<void> {
    if (this.stopped || this.gitInFlight > 0) {
      return;
    }
    const now = Date.now();
    if (this.hasRecentTerminalActivity(now)) {
      return;
    }
    const workspaces = this.db.listWorkspaces().sort((a, b) => {
      if (a.id === this.activeWorkspaceId) return -1;
      if (b.id === this.activeWorkspaceId) return 1;
      return 0;
    });
    for (const ws of workspaces) {
      const nextDue = this.gitNextDue.get(ws.id) ?? 0;
      if (nextDue > now) {
        continue;
      }
      if (this.gitInFlight >= GIT_STATUS_MAX_IN_FLIGHT) {
        break;
      }
      this.gitInFlight += 1;
      this.gitNextDue.set(ws.id, now + (ws.id === this.activeWorkspaceId ? GIT_STATUS_ACTIVE_INTERVAL_MS : GIT_STATUS_INACTIVE_INTERVAL_MS));
      void readGitStatus(ws.path)
        .then((status) => {
          if (this.stopped) {
            return;
          }
          this.db.updateWorkspaceGit(ws.id, status.branch, status.dirty);
        })
        .catch(() => {
          if (this.stopped) {
            return;
          }
          this.db.updateWorkspaceGit(ws.id, null, false);
        })
        .finally(() => {
          this.gitInFlight = Math.max(0, this.gitInFlight - 1);
        });
    }
  }

  private appendSessionOutput(sessionId: string, chunk: string): void {
    let drain = this.drainBuffers.get(sessionId);
    if (!drain) {
      drain = new SessionTextBuffer(SESSION_OUTPUT_BUFFER_KEEP_CHARS);
      this.drainBuffers.set(sessionId, drain);
    }
    let tail = this.tailBuffers.get(sessionId);
    if (!tail) {
      tail = new SessionTextBuffer(SESSION_OUTPUT_BUFFER_KEEP_CHARS);
      this.tailBuffers.set(sessionId, tail);
    }
    drain.append(chunk);
    tail.append(chunk);
  }

  private queueSessionOutput(sessionId: string, workspaceId: string, chunk: string): void {
    const existing = this.sessionOutputBatches.get(sessionId);
    if (existing) {
      existing.chunks.push(chunk);
      existing.length += chunk.length;
      if (existing.length >= SESSION_OUTPUT_BATCH_MAX_CHARS) {
        this.flushSessionOutputBatch(sessionId);
      }
      return;
    }
    const timer = setTimeout(() => this.flushSessionOutputBatch(sessionId), SESSION_OUTPUT_BATCH_DELAY_MS);
    this.sessionOutputBatches.set(sessionId, {
      workspace_id: workspaceId,
      chunks: [chunk],
      length: chunk.length,
      timer
    });
    if (chunk.length >= SESSION_OUTPUT_BATCH_MAX_CHARS) {
      this.flushSessionOutputBatch(sessionId);
    }
  }

  private processSessionOutputPatterns(sessionId: string, workspaceId: string, output: string): void {
    if (!output) {
      return;
    }
    this.maybeIngestPromptPattern({
      workspace_id: workspaceId,
      session_id: sessionId,
      output_chunk: output
    });
    if (AI_RESUME_OUTPUT_PROBE.test(output)) {
      this.maybeDeleteFailedAiResume({
        workspace_id: workspaceId,
        output_chunk: output
      });
      // Scan recent tail, not only this batch, so resume markers split across
      // multiple PTY chunks are still detected when the current batch has a resume clue.
      const recentBuffer = this.tailBuffers.get(sessionId)?.tail(2_000) ?? output;
      this.maybeRecordAiResume({
        workspace_id: workspaceId,
        session_id: sessionId,
        output_chunk: recentBuffer
      });
    }
  }

  private flushSessionOutputBatch(sessionId: string): void {
    const batch = this.sessionOutputBatches.get(sessionId);
    if (!batch) {
      return;
    }
    clearTimeout(batch.timer);
    this.sessionOutputBatches.delete(sessionId);
    const output = batch.chunks.join("");
    if (!output) {
      return;
    }
    this.processSessionOutputPatterns(sessionId, batch.workspace_id, output);
    this.emitStreamEvent("session.output", {
      session_id: sessionId,
      workspace_id: batch.workspace_id,
      output
    });
  }

  private clearSessionOutputBatch(sessionId: string): void {
    const batch = this.sessionOutputBatches.get(sessionId);
    if (!batch) {
      return;
    }
    clearTimeout(batch.timer);
    this.sessionOutputBatches.delete(sessionId);
  }

  private clearPromptDetector(sessionId: string): void {
    const detectorState = this.promptDetector.get(sessionId);
    if (detectorState?.completion_timer) {
      clearTimeout(detectorState.completion_timer);
    }
    this.promptDetector.delete(sessionId);
  }

  private handleSocket(socket: net.Socket): void {
    let buffer = "";
    socket.on("close", () => {
      const subIds = this.socketSubscriptions.get(socket);
      if (!subIds) {
        return;
      }
      for (const id of [...subIds]) {
        this.removeSubscription(id);
      }
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = consumeSocketLines(buffer, chunk, (line) => {
        const raw = tryParse(line);
        const response = this.dispatch(raw, socket);
        socket.write(`${JSON.stringify(response)}\n`);
      });
    });
  }

  private emitStreamEvent(method: string, params: Record<string, unknown>): void {
    const topic = this.eventTopic(method);
    const sentSockets = new Set<net.Socket>();
    let line: string | null = null;
    for (const subscriptionId of this.collectStreamSubscriptionIds(topic, params)) {
      const subscription = this.streamSubscriptions.get(subscriptionId);
      if (!subscription) {
        continue;
      }
      if (!this.matchesStreamSubscription(subscription, params)) {
        continue;
      }

      const socket = subscription.socket;
      if (socket.destroyed || !socket.writable || socket.writableEnded) {
        this.removeSubscription(subscription.id);
        continue;
      }
      if (sentSockets.has(socket)) {
        continue;
      }

      try {
        line ??= `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
        socket.write(line);
        sentSockets.add(socket);
      } catch {
        this.removeSubscription(subscription.id);
      }
    }
  }

  private eventTopic(method: string): StreamTopic {
    if (method.startsWith("notify.")) {
      return "notify";
    }
    return "session";
  }

  private collectStreamSubscriptionIds(topic: StreamTopic, params: Record<string, unknown>): Set<string> {
    const ids = new Set<string>();
    const addIds = (set?: Set<string>): void => {
      if (!set) {
        return;
      }
      for (const id of set) {
        ids.add(id);
      }
    };
    const sessionId = typeof params.session_id === "string" ? params.session_id : undefined;
    const workspaceId = typeof params.workspace_id === "string" ? params.workspace_id : undefined;
    const effectiveWorkspaceId = workspaceId ?? (sessionId ? this.sessionWorkspace.get(sessionId) : undefined);

    addIds(this.streamGlobalSubscriptions.get(topic));
    if (effectiveWorkspaceId) {
      addIds(this.streamWorkspaceSubscriptions.get(topic)?.get(effectiveWorkspaceId));
    }
    if (sessionId) {
      addIds(this.streamSessionSubscriptions.get(topic)?.get(sessionId));
    }

    return ids;
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
    this.removeSubscriptionIndex(subscription);
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

  private addSubscriptionIndex(subscription: StreamSubscription): void {
    for (const topic of subscription.topics) {
      if (subscription.session_id) {
        this.addNestedSubscriptionIndex(this.streamSessionSubscriptions, topic, subscription.session_id, subscription.id);
      } else if (subscription.workspace_id) {
        this.addNestedSubscriptionIndex(this.streamWorkspaceSubscriptions, topic, subscription.workspace_id, subscription.id);
      } else {
        this.getSubscriptionSet(this.streamGlobalSubscriptions, topic).add(subscription.id);
      }
    }
  }

  private removeSubscriptionIndex(subscription: StreamSubscription): void {
    for (const topic of subscription.topics) {
      if (subscription.session_id) {
        this.removeNestedSubscriptionIndex(this.streamSessionSubscriptions, topic, subscription.session_id, subscription.id);
      } else if (subscription.workspace_id) {
        this.removeNestedSubscriptionIndex(this.streamWorkspaceSubscriptions, topic, subscription.workspace_id, subscription.id);
      } else {
        this.removeSubscriptionSetId(this.streamGlobalSubscriptions, topic, subscription.id);
      }
    }
  }

  private getSubscriptionSet(index: Map<StreamTopic, Set<string>>, topic: StreamTopic): Set<string> {
    let set = index.get(topic);
    if (!set) {
      set = new Set<string>();
      index.set(topic, set);
    }
    return set;
  }

  private addNestedSubscriptionIndex(index: Map<StreamTopic, Map<string, Set<string>>>, topic: StreamTopic, key: string, id: string): void {
    let topicIndex = index.get(topic);
    if (!topicIndex) {
      topicIndex = new Map<string, Set<string>>();
      index.set(topic, topicIndex);
    }
    let set = topicIndex.get(key);
    if (!set) {
      set = new Set<string>();
      topicIndex.set(key, set);
    }
    set.add(id);
  }

  private removeNestedSubscriptionIndex(index: Map<StreamTopic, Map<string, Set<string>>>, topic: StreamTopic, key: string, id: string): void {
    const topicIndex = index.get(topic);
    const set = topicIndex?.get(key);
    if (!topicIndex || !set) {
      return;
    }
    set.delete(id);
    if (set.size === 0) {
      topicIndex.delete(key);
    }
    if (topicIndex.size === 0) {
      index.delete(topic);
    }
  }

  private removeSubscriptionSetId(index: Map<StreamTopic, Set<string>>, topic: StreamTopic, id: string): void {
    const set = index.get(topic);
    if (!set) {
      return;
    }
    set.delete(id);
    if (set.size === 0) {
      index.delete(topic);
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

async function readGitStatus(cwd: string): Promise<GitStatusResult> {
  const [branch, dirtyText] = await Promise.all([
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(cwd, ["status", "--porcelain"])
  ]);
  return {
    branch,
    dirty: Boolean(dirtyText && dirtyText.trim().length)
  };
}

function runGit(cwd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve(null);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-20_000);
    });
    child.once("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? stdout.trim() : null);
    });
  });
}

function isAssistantCommand(cmd: string, args: string[]): boolean {
  const commandText = [cmd, ...args].join(" ");
  return /\b(?:claude|codex)\b/i.test(commandText);
}

function tryParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
