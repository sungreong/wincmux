import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { CoreEngine } from "../src/engine";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wincmux-core-"));
  return path.join(dir, "wincmux.db");
}

interface PromptDetectorStateForTest {
  buffer: string;
  input_buffer: string;
  assistant_session: boolean;
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

function promptDetectorFixture(overrides: Partial<PromptDetectorStateForTest> = {}): PromptDetectorStateForTest {
  return {
    buffer: "",
    input_buffer: "",
    assistant_session: false,
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
    completion_timer: null,
    ...overrides
  };
}

describe("core engine", () => {
  test("dispatch health.check", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-a" });
    const res = engine.dispatch({ jsonrpc: "2.0", id: 1, method: "health.check", params: {} });
    expect(res.error).toBeUndefined();
    expect((res.result as { status: string }).status).toBe("ok");
    engine.stop();
  });

  test("workspace create + list", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-b" });
    const created = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.create",
      params: { name: "alpha", path: process.cwd(), backend: "codex" }
    });
    expect(created.error).toBeUndefined();

    const listed = engine.dispatch({ jsonrpc: "2.0", id: 2, method: "workspace.list", params: {} });
    const workspaces = (listed.result as { workspaces: unknown[] }).workspaces;
    expect(workspaces.length).toBe(1);
    engine.stop();
  });

  test("layout.swap swaps sibling leaf pane positions", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-layout-swap" });
    const created = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.create",
      params: { name: "layout", path: process.cwd(), backend: "codex" }
    });
    const workspaceId = (created.result as { workspace: { id: string }; root_pane_id: string }).workspace.id;
    const rootPaneId = (created.result as { workspace: { id: string }; root_pane_id: string }).root_pane_id;
    const split = engine.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "layout.split",
      params: { workspace_id: workspaceId, pane_id: rootPaneId, direction: "horizontal" }
    });
    const [firstPaneId, secondPaneId] = (split.result as { pane_ids: [string, string] }).pane_ids;

    const swapped = engine.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "layout.swap",
      params: { workspace_id: workspaceId, first_pane_id: firstPaneId, second_pane_id: secondPaneId }
    });
    expect(swapped.error).toBeUndefined();

    const listed = engine.dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "layout.list",
      params: { workspace_id: workspaceId }
    });
    const panes = (listed.result as { panes: Array<{ pane_id: string; parent_id: string | null; split: null | { first: string; second: string } }> }).panes;
    const root = panes.find((pane) => pane.pane_id === rootPaneId);
    expect(root?.split?.first).toBe(secondPaneId);
    expect(root?.split?.second).toBe(firstPaneId);
    expect(panes.find((pane) => pane.pane_id === firstPaneId)?.parent_id).toBe(rootPaneId);
    expect(panes.find((pane) => pane.pane_id === secondPaneId)?.parent_id).toBe(rootPaneId);
    engine.stop();
  });

  test("layout.move places a leaf pane below another leaf pane", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-layout-move" });
    const created = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.create",
      params: { name: "layout-move", path: process.cwd(), backend: "codex" }
    });
    const workspaceId = (created.result as { workspace: { id: string }; root_pane_id: string }).workspace.id;
    const rootPaneId = (created.result as { workspace: { id: string }; root_pane_id: string }).root_pane_id;
    const split = engine.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "layout.split",
      params: { workspace_id: workspaceId, pane_id: rootPaneId, direction: "horizontal" }
    });
    const [sourcePaneId, targetPaneId] = (split.result as { pane_ids: [string, string] }).pane_ids;

    const moved = engine.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "layout.move",
      params: { workspace_id: workspaceId, source_pane_id: sourcePaneId, target_pane_id: targetPaneId, placement: "below" }
    });
    expect(moved.error).toBeUndefined();

    const listed = engine.dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "layout.list",
      params: { workspace_id: workspaceId }
    });
    const panes = (listed.result as { panes: Array<{ pane_id: string; parent_id: string | null; split: null | { direction: string; first: string; second: string } }> }).panes;
    const target = panes.find((pane) => pane.pane_id === targetPaneId);
    const source = panes.find((pane) => pane.pane_id === sourcePaneId);
    expect(target?.parent_id).toBe(source?.parent_id);
    const container = panes.find((pane) => pane.pane_id === target?.parent_id);
    expect(container?.parent_id).toBeNull();
    expect(container?.split).toEqual({ direction: "vertical", first: targetPaneId, second: sourcePaneId });
    engine.stop();
  });

  test("workspace creates default pane groups and unbound sessions read as Default", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-groups-a" });
    const created = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.create",
      params: { name: "groups", path: process.cwd(), backend: "codex" }
    });
    const workspaceId = (created.result as { workspace: { id: string } }).workspace.id;

    const groupsRes = engine.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "group.list",
      params: { workspace_id: workspaceId }
    });
    const groups = (groupsRes.result as { groups: Array<{ id: string; name: string }> }).groups;
    expect(groups.map((group) => group.name)).toEqual(["Default"]);

    const sessionId = randomUUID();
    const internals = engine as unknown as {
      db: {
        insertSession: (row: {
          id: string;
          workspace_id: string;
          pid: number;
          status: "running" | "exited" | "failed";
          started_at: string;
          ended_at: string | null;
          exit_code: number | null;
          spawn_cmd: string | null;
          spawn_args: string | null;
          spawn_cwd: string | null;
        }) => void;
      };
    };
    internals.db.insertSession({
      id: sessionId,
      workspace_id: workspaceId,
      pid: 1234,
      status: "running",
      started_at: new Date().toISOString(),
      ended_at: null,
      exit_code: null,
      spawn_cmd: "pwsh.exe",
      spawn_args: "[]",
      spawn_cwd: process.cwd()
    });

    const bindingsRes = engine.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "session.group.list",
      params: { workspace_id: workspaceId }
    });
    const bindings = (bindingsRes.result as { bindings: Array<{ session_id: string; group_id: string }> }).bindings;
    const defaultGroup = groups.find((group) => group.name === "Default");
    expect(bindings.find((binding) => binding.session_id === sessionId)?.group_id).toBe(defaultGroup?.id);
    engine.stop();
  });

  test("session.group.set moves sessions and group.delete falls back to Default", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-groups-b" });
    const created = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.create",
      params: { name: "groups-move", path: process.cwd(), backend: "codex" }
    });
    const workspaceId = (created.result as { workspace: { id: string } }).workspace.id;
    const groups = (engine.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "group.list",
      params: { workspace_id: workspaceId }
    }).result as { groups: Array<{ id: string; name: string }> }).groups;
    const defaultGroup = groups.find((group) => group.name === "Default")!;
    const createdGroup = engine.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "group.create",
      params: { workspace_id: workspaceId, name: "AI" }
    });
    const aiGroup = (createdGroup.result as { group: { id: string; name: string } }).group;
    const sessionId = randomUUID();
    const internals = engine as unknown as {
      db: {
        insertSession: (row: {
          id: string;
          workspace_id: string;
          pid: number;
          status: "running" | "exited" | "failed";
          started_at: string;
          ended_at: string | null;
          exit_code: number | null;
          spawn_cmd: string | null;
          spawn_args: string | null;
          spawn_cwd: string | null;
        }) => void;
      };
    };
    internals.db.insertSession({
      id: sessionId,
      workspace_id: workspaceId,
      pid: 4321,
      status: "running",
      started_at: new Date().toISOString(),
      ended_at: null,
      exit_code: null,
      spawn_cmd: "claude",
      spawn_args: "[]",
      spawn_cwd: process.cwd()
    });

    const setRes = engine.dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "session.group.set",
      params: { workspace_id: workspaceId, session_id: sessionId, group_id: aiGroup.id }
    });
    expect(setRes.error).toBeUndefined();
    let bindings = (engine.dispatch({
      jsonrpc: "2.0",
      id: 5,
      method: "session.group.list",
      params: { workspace_id: workspaceId }
    }).result as { bindings: Array<{ session_id: string; group_id: string }> }).bindings;
    expect(bindings.find((binding) => binding.session_id === sessionId)?.group_id).toBe(aiGroup.id);

    const deleteRes = engine.dispatch({
      jsonrpc: "2.0",
      id: 6,
      method: "group.delete",
      params: { group_id: aiGroup.id }
    });
    expect(deleteRes.error).toBeUndefined();
    bindings = (engine.dispatch({
      jsonrpc: "2.0",
      id: 7,
      method: "session.group.list",
      params: { workspace_id: workspaceId }
    }).result as { bindings: Array<{ session_id: string; group_id: string }> }).bindings;
    expect(bindings.find((binding) => binding.session_id === sessionId)?.group_id).toBe(defaultGroup.id);
    engine.stop();
  });

  test("ai.session.delete removes a saved resume record", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-ai-delete" });
    const created = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.create",
      params: { name: "ai-delete", path: process.cwd(), backend: "codex" }
    });
    const workspaceId = (created.result as { workspace: { id: string } }).workspace.id;
    const aiSessionId = "claude-test-resume";
    const internals = engine as unknown as {
      db: {
        upsertAiSession: (row: {
          id: string;
          workspace_id: string;
          pty_session_id: string;
          tool: string;
          resume_cmd: string;
          cwd: string | null;
          detected_at: string;
        }) => void;
      };
    };
    internals.db.upsertAiSession({
      id: aiSessionId,
      workspace_id: workspaceId,
      pty_session_id: randomUUID(),
      tool: "claude",
      resume_cmd: "claude --resume 30ae6541-c5a7-47ab-bc93-354686339f5b",
      cwd: process.cwd(),
      detected_at: new Date().toISOString()
    });

    const deleted = engine.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "ai.session.delete",
      params: { ai_session_id: aiSessionId }
    });
    expect(deleted.error).toBeUndefined();
    expect((deleted.result as { deleted: number }).deleted).toBe(1);

    const listed = engine.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "ai.sessions",
      params: { workspace_id: workspaceId }
    });
    expect((listed.result as { sessions: unknown[] }).sessions).toHaveLength(0);
    engine.stop();
  });

  test("failed AI resume output prunes the matching saved resume record", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-ai-auto-delete" });
    const created = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.create",
      params: { name: "ai-auto-delete", path: process.cwd(), backend: "codex" }
    });
    const workspaceId = (created.result as { workspace: { id: string } }).workspace.id;
    const token = "30ae6541-c5a7-47ab-bc93-354686339f5b";
    const internals = engine as unknown as {
      db: {
        upsertAiSession: (row: {
          id: string;
          workspace_id: string;
          pty_session_id: string;
          tool: string;
          resume_cmd: string;
          cwd: string | null;
          detected_at: string;
        }) => void;
      };
      maybeDeleteFailedAiResume: (input: { workspace_id: string; output_chunk: string }) => void;
    };
    internals.db.upsertAiSession({
      id: "claude-auto-delete",
      workspace_id: workspaceId,
      pty_session_id: randomUUID(),
      tool: "claude",
      resume_cmd: `claude --resume ${token}`,
      cwd: process.cwd(),
      detected_at: new Date().toISOString()
    });

    internals.maybeDeleteFailedAiResume({
      workspace_id: workspaceId,
      output_chunk: `No conversation found with session ID: ${token}`
    });

    const listed = engine.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "ai.sessions",
      params: { workspace_id: workspaceId }
    });
    expect((listed.result as { sessions: unknown[] }).sessions).toHaveLength(0);
    engine.stop();
  });

  test("named pipe rpc responds", async () => {
    const pipe = "\\\\.\\pipe\\wincmux-test-c";
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: pipe });
    await engine.start();

    const response = await new Promise<string>((resolve, reject) => {
      const client = net.createConnection(pipe);
      client.once("error", reject);
      client.on("data", (chunk) => {
        resolve(chunk.toString("utf8").trim());
        client.destroy();
      });
      client.write('{"jsonrpc":"2.0","id":1,"method":"health.check","params":{}}\n');
    });

    const parsed = JSON.parse(response) as { result?: { status: string } };
    expect(parsed.result?.status).toBe("ok");
    engine.stop();
  });

  test("notify.push dedups and delivery ack updates", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-d" });
    const created = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.create",
      params: { name: "notify", path: process.cwd(), backend: "codex" }
    });
    const workspaceId = (created.result as { workspace: { id: string } })?.workspace?.id;
    expect(workspaceId).toBeTruthy();

    const first = engine.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "notify.push",
      params: {
        workspace_id: workspaceId,
        session_id: null,
        pane_id: null,
        kind: "system",
        source_kind: "cli",
        title: "build done",
        body: "ok",
        level: "info",
        source: "test",
        dedup_key: "dedup:test"
      }
    });
    expect(first.error).toBeUndefined();
    const firstResult = first.result as { notification: { id: string }; deduped: boolean };
    expect(firstResult.deduped).toBe(false);

    const second = engine.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "notify.push",
      params: {
        workspace_id: workspaceId,
        title: "build done",
        body: "ok",
        level: "info",
        source: "test",
        dedup_key: "dedup:test"
      }
    });
    const secondResult = second.result as { notification: { id: string }; deduped: boolean };
    expect(secondResult.deduped).toBe(true);
    expect(secondResult.notification.id).toBe(firstResult.notification.id);

    const ack = engine.dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "notify.delivery_ack",
      params: {
        notification_id: firstResult.notification.id,
        delivered: true,
        suppressed: false
      }
    });
    expect((ack.result as { ok: boolean }).ok).toBe(true);

    const unread = engine.dispatch({
      jsonrpc: "2.0",
      id: 5,
      method: "notify.unread",
      params: { workspace_id: workspaceId }
    });
    const items = (unread.result as { items: Array<{ id: string; delivered_at: string | null }> }).items;
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe(firstResult.notification.id);
    expect(items[0]?.delivered_at).toBeTruthy();
    engine.stop();
  });

  test("assistant completion detector still fires when ready marker persists", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-ready-persist" });
    const created = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.create",
      params: { name: "notify-ready", path: process.cwd(), backend: "claude" }
    });
    const workspaceId = (created.result as { workspace: { id: string } }).workspace.id;
    const sessionId = randomUUID();
    const internals = engine as unknown as {
      promptDetector: Map<string, PromptDetectorStateForTest>;
      noteSessionInput: (sessionId: string, data: string) => void;
      maybeIngestPromptPattern: (input: { workspace_id: string; session_id: string; output_chunk: string }) => void;
    };
    internals.promptDetector.set(sessionId, promptDetectorFixture({ assistant_session: true }));

    internals.maybeIngestPromptPattern({
      workspace_id: workspaceId,
      session_id: sessionId,
      output_chunk: "Claude Code\n? for shortcuts\n대기 중입니다. 뭔가 도와드릴까요?"
    });
    expect((engine.dispatch({ jsonrpc: "2.0", id: 2, method: "notify.unread", params: {} }).result as { count: number }).count).toBe(0);

    internals.noteSessionInput(sessionId, "안녕\r");
    internals.maybeIngestPromptPattern({
      workspace_id: workspaceId,
      session_id: sessionId,
      output_chunk: "안녕하세요. 무엇을 도와드릴까요?"
    });
    const unread = engine.dispatch({ jsonrpc: "2.0", id: 3, method: "notify.unread", params: {} });
    const items = (unread.result as { items: Array<{ kind: string; title: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("task_done");
    expect(items[0]?.title).toBe("Assistant response completed");
    engine.stop();
  });

  test("assistant completion detector falls back to output idle when final prompt is not visible", async () => {
    vi.useFakeTimers();
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-ready-idle" });
    try {
      const created = engine.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "workspace.create",
        params: { name: "notify-idle", path: process.cwd(), backend: "codex" }
      });
      const workspaceId = (created.result as { workspace: { id: string } }).workspace.id;
      const sessionId = randomUUID();
      const internals = engine as unknown as {
        promptDetector: Map<string, PromptDetectorStateForTest>;
        maybeIngestPromptPattern: (input: { workspace_id: string; session_id: string; output_chunk: string }) => void;
      };
      internals.promptDetector.set(sessionId, promptDetectorFixture({
        assistant_session: true,
        user_input_seen_at: Date.now(),
        user_turn_id: 1,
        ready_visible: true,
        bootstrapped_ready: true
      }));

      internals.maybeIngestPromptPattern({
        workspace_id: workspaceId,
        session_id: sessionId,
        output_chunk: "Codex CLI\n분석이 끝났습니다. 필요한 변경 사항을 정리했습니다."
      });
      await vi.advanceTimersByTimeAsync(3499);
      expect((engine.dispatch({ jsonrpc: "2.0", id: 2, method: "notify.unread", params: {} }).result as { count: number }).count).toBe(0);

      await vi.advanceTimersByTimeAsync(2);
      const unread = engine.dispatch({ jsonrpc: "2.0", id: 3, method: "notify.unread", params: {} });
      const items = (unread.result as { items: Array<{ kind: string; title: string }> }).items;
      expect(items).toHaveLength(1);
      expect(items[0]?.kind).toBe("task_done");
    } finally {
      engine.stop();
      vi.useRealTimers();
    }
  });

  test("assistant completion detector can infer tool sessions from user input instead of output patterns", async () => {
    vi.useFakeTimers();
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-input-infer" });
    try {
      const created = engine.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "workspace.create",
        params: { name: "notify-input", path: process.cwd(), backend: "codex" }
      });
      const workspaceId = (created.result as { workspace: { id: string } }).workspace.id;
      const sessionId = randomUUID();
      const internals = engine as unknown as {
        promptDetector: Map<string, PromptDetectorStateForTest>;
        noteSessionInput: (sessionId: string, data: string) => void;
        maybeIngestPromptPattern: (input: { workspace_id: string; session_id: string; output_chunk: string }) => void;
      };
      internals.promptDetector.set(sessionId, promptDetectorFixture());

      internals.noteSessionInput(sessionId, "codex\r");
      internals.maybeIngestPromptPattern({
        workspace_id: workspaceId,
        session_id: sessionId,
        output_chunk: "Here is the finished result without a visible terminal prompt."
      });

      await vi.advanceTimersByTimeAsync(3501);
      const unread = engine.dispatch({ jsonrpc: "2.0", id: 2, method: "notify.unread", params: {} });
      expect((unread.result as { items: Array<{ kind: string }> }).items[0]?.kind).toBe("task_done");
    } finally {
      engine.stop();
      vi.useRealTimers();
    }
  });

  test("assistant completion detector notifies only once per user turn", async () => {
    vi.useFakeTimers();
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-turn-once" });
    try {
      const created = engine.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "workspace.create",
        params: { name: "notify-once", path: process.cwd(), backend: "codex" }
      });
      const workspaceId = (created.result as { workspace: { id: string } }).workspace.id;
      const sessionId = randomUUID();
      const internals = engine as unknown as {
        promptDetector: Map<string, PromptDetectorStateForTest>;
        noteSessionInput: (sessionId: string, data: string) => void;
        maybeIngestPromptPattern: (input: { workspace_id: string; session_id: string; output_chunk: string }) => void;
      };
      internals.promptDetector.set(sessionId, promptDetectorFixture({
        assistant_session: true,
        bootstrapped_ready: true
      }));

      internals.noteSessionInput(sessionId, "Summarize recent commits\r");
      internals.maybeIngestPromptPattern({
        workspace_id: workspaceId,
        session_id: sessionId,
        output_chunk: "Codex CLI\n요약이 끝났습니다.\n>"
      });
      internals.maybeIngestPromptPattern({
        workspace_id: workspaceId,
        session_id: sessionId,
        output_chunk: "gpt-5.4 medium · cwd\n>"
      });
      await vi.advanceTimersByTimeAsync(3501);
      let unread = engine.dispatch({ jsonrpc: "2.0", id: 2, method: "notify.unread", params: {} });
      expect((unread.result as { items: unknown[] }).items).toHaveLength(1);

      const firstItem = ((unread.result as { items: Array<{ id: string; body: string }> }).items[0]);
      const firstId = firstItem?.id;
      expect(firstId).toBeTruthy();
      expect(firstItem?.body).toContain("요약이 끝났습니다");
      engine.dispatch({ jsonrpc: "2.0", id: 3, method: "notify.mark_read", params: { notification_id: firstId } });
      internals.maybeIngestPromptPattern({
        workspace_id: workspaceId,
        session_id: sessionId,
        output_chunk: "필요하실 때 말씀해 주세요.\n>"
      });
      await vi.advanceTimersByTimeAsync(3501);
      unread = engine.dispatch({ jsonrpc: "2.0", id: 4, method: "notify.unread", params: {} });
      expect((unread.result as { items: unknown[] }).items).toHaveLength(0);
    } finally {
      engine.stop();
      vi.useRealTimers();
    }
  });

  test("session.tail is non-destructive while session.read drains", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-tail" });
    const sessionId = randomUUID();
    (engine as unknown as { appendSessionOutput: (id: string, chunk: string) => void }).appendSessionOutput(sessionId, "alpha beta gamma");

    const firstTail = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "session.tail",
      params: { session_id: sessionId, max_bytes: 10 }
    });
    expect((firstTail.result as { output: string }).output).toBe("beta gamma");

    const read = engine.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "session.read",
      params: { session_id: sessionId, max_bytes: 5 }
    });
    expect((read.result as { output: string }).output).toBe("alpha");

    const secondTail = engine.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "session.tail",
      params: { session_id: sessionId }
    });
    expect((secondTail.result as { output: string }).output).toBe("alpha beta gamma");

    const secondRead = engine.dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "session.read",
      params: { session_id: sessionId }
    });
    expect((secondRead.result as { output: string }).output).toBe(" beta gamma");
    engine.stop();
  });

  test("session.write and resize fail when PTY is detached", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-detached-write" });
    const sessionId = randomUUID();

    const write = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "session.write",
      params: { session_id: sessionId, data: "abc" }
    });
    expect(write.error?.message).toContain("PTY session not attached");

    const resize = engine.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "session.resize",
      params: { session_id: sessionId, cols: 80, rows: 24 }
    });
    expect(resize.error?.message).toContain("PTY session not attached");
    engine.stop();
  });

  test("session output stream batches chunks in order", async () => {
    const pipe = "\\\\.\\pipe\\wincmux-test-stream-batch";
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: pipe });
    await engine.start();
    const created = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.create",
      params: { name: "stream", path: process.cwd(), backend: "codex" }
    });
    const workspaceId = (created.result as { workspace: { id: string } }).workspace.id;
    const sessionId = randomUUID();

    const output = await new Promise<string>((resolve, reject) => {
      const client = net.createConnection(pipe);
      let buffer = "";
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error("timed out waiting for stream output"));
      }, 1000);
      client.once("error", reject);
      client.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) {
            const parsed = JSON.parse(line) as { id?: number; method?: string; result?: unknown; params?: { output?: string } };
            if (parsed.id === 99) {
              (engine as unknown as {
                queueSessionOutput: (id: string, workspaceId: string, chunk: string) => void;
              }).queueSessionOutput(sessionId, workspaceId, "one ");
              (engine as unknown as {
                queueSessionOutput: (id: string, workspaceId: string, chunk: string) => void;
              }).queueSessionOutput(sessionId, workspaceId, "two");
            }
            if (parsed.method === "session.output") {
              clearTimeout(timer);
              client.destroy();
              resolve(parsed.params?.output ?? "");
            }
          }
          index = buffer.indexOf("\n");
        }
      });
      client.on("connect", () => {
        client.write(JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "session.stream.subscribe",
          params: { workspace_id: workspaceId, topics: ["session"] }
        }) + "\n");
      });
    });

    expect(output).toBe("one two");
    engine.stop();
  });

  test("workspace.activate accepts active workspace for git scheduler", () => {
    const engine = new CoreEngine({ dbPath: tempDbPath(), pipeName: "\\\\.\\pipe\\wincmux-test-active" });
    const created = engine.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.create",
      params: { name: "active", path: process.cwd(), backend: "codex" }
    });
    const workspaceId = (created.result as { workspace: { id: string } }).workspace.id;
    const activated = engine.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "workspace.activate",
      params: { workspace_id: workspaceId }
    });
    expect((activated.result as { ok: boolean }).ok).toBe(true);
    engine.stop();
  });
});
