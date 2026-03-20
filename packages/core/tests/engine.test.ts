import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, expect, test } from "vitest";
import { CoreEngine } from "../src/engine";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wincmux-core-"));
  return path.join(dir, "wincmux.db");
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
});
