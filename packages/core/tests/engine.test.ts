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
});
