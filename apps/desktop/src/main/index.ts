import path from "node:path";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, shell, nativeImage, Notification as ElectronNotification, type NativeImage, type OpenDialogOptions, type WebContents } from "electron";

type RpcPayload = {
  method: string;
  params?: unknown;
};

type StreamFilter = {
  workspace_id?: string;
  session_id?: string;
  topics?: Array<"session" | "notify">;
};

type NotificationRecord = {
  id: string;
  workspace_id: string;
  session_id?: string | null;
  pane_id?: string | null;
  title: string;
  body?: string;
  level?: string;
};

type StreamEvent = {
  jsonrpc?: "2.0";
  method?: string;
  params?: unknown;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type IpcEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: string };

const PIPE_NAME = "\\\\.\\pipe\\wincmux-rpc";
let coreProc: ChildProcess | null = null;
let coreExitReason: string | null = null;
let coreStderrTail = "";
let coreRuntimeHint = "";
const streamConnections = new Map<string, { socket: net.Socket; subscriptionId: string; webContents: WebContents }>();
let streamRequestSeq = 1;
let unreadBadgeCount = 0;
const badgeIconCache = new Map<string, NativeImage>();
let notifyStreamSocket: net.Socket | null = null;
let notifyStreamSubscriptionId: string | null = null;
let appIsQuitting = false;
let coreRespawnPromise: Promise<void> | null = null;
let activeContext: {
  workspace_id: string | null;
  pane_id: string | null;
  session_id: string | null;
  app_focused: boolean;
} = {
  workspace_id: null,
  pane_id: null,
  session_id: null,
  app_focused: false
};

function perfLogPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const dir = path.join(localAppData, "WinCMux", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "perf.jsonl");
}

function appendPerfLog(payload: unknown): void {
  const line = `${JSON.stringify(payload)}\n`;
  fs.appendFile(perfLogPath(), line, () => {});
}

function normalizeUnreadCount(input: unknown): number {
  const num = Number(input);
  if (!Number.isFinite(num) || num <= 0) {
    return 0;
  }
  return Math.floor(num);
}

function badgeLabel(count: number): string {
  if (count >= 100) {
    return "99+";
  }
  return String(count);
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function overlayIconForCount(count: number): NativeImage | null {
  if (count <= 0) {
    return null;
  }

  const label = badgeLabel(count);
  const cached = badgeIconCache.get(label);
  if (cached) {
    return cached;
  }

  const text = escapeSvgText(label);
  const fontSize = label.length >= 3 ? 12 : 15;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
  <circle cx="16" cy="16" r="15" fill="#d94848" />
  <text x="16" y="21" text-anchor="middle" fill="#ffffff" font-family="Segoe UI, Arial, sans-serif" font-size="${fontSize}" font-weight="700">${text}</text>
</svg>`.trim();

  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const icon = nativeImage.createFromDataURL(dataUrl).resize({ width: 16, height: 16 });
  badgeIconCache.set(label, icon);
  return icon;
}

function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function applyUnreadBadge(count: number): void {
  unreadBadgeCount = normalizeUnreadCount(count);

  if (process.platform !== "win32") {
    return;
  }

  const description = unreadBadgeCount > 0 ? `${unreadBadgeCount} unread notifications` : "No unread notifications";
  const icon = overlayIconForCount(unreadBadgeCount);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue;
    }
    win.setOverlayIcon(icon, description);
  }
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, "..", "preload", "index.js");
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.on("focus", () => {
    activeContext.app_focused = true;
  });
  win.on("blur", () => {
    activeContext.app_focused = false;
  });
  applyUnreadBadge(unreadBadgeCount);
}

function toIpcEnvelope<T>(fn: () => Promise<T>): Promise<IpcEnvelope<T>> {
  return fn()
    .then((result) => ({ ok: true as const, result }))
    .catch((err) => ({
      ok: false as const,
      error: String(err instanceof Error ? err.message : err)
    }));
}

function pipeCallOnce(payload: RpcPayload): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(PIPE_NAME);
    let buffer = "";

    client.once("error", reject);

    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) {
        return;
      }
      const line = buffer.split("\n")[0]?.trim() ?? "";
      client.end();
      if (!line) {
        reject(new Error("empty response"));
        return;
      }
      const response = JSON.parse(line) as { result?: unknown; error?: { message: string } };
      if (response.error) {
        reject(new Error(response.error.message));
        return;
      }
      resolve(response.result);
    });

    client.on("connect", () => {
      const request = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: payload.method,
        params: payload.params ?? {}
      };
      client.write(`${JSON.stringify(request)}\n`);
    });
  });
}

async function pipeCall(payload: RpcPayload, attempt = 0): Promise<unknown> {
  try {
    return await pipeCallOnce(payload);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && attempt < 3) {
      await respawnCore().catch(() => {});
      await new Promise<void>((r) => setTimeout(r, 150 * (attempt + 1)));
      return pipeCall(payload, attempt + 1);
    }
    throw err;
  }
}

function createPersistentStream(webContents: WebContents, filter: StreamFilter): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PIPE_NAME);
    let buffer = "";
    const requestId = streamRequestSeq++;
    let resolved = false;

    socket.once("error", (err) => {
      if (!resolved) {
        reject(err);
      }
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) {
          const parsed = JSON.parse(line) as StreamEvent;
          if (parsed.id === requestId) {
            if (parsed.error) {
              reject(new Error(parsed.error.message ?? "stream subscribe failed"));
              socket.destroy();
              return;
            }
            const subscriptionId = (parsed.result as { subscription_id?: string } | undefined)?.subscription_id;
            if (!subscriptionId) {
              reject(new Error("missing subscription_id"));
              socket.destroy();
              return;
            }

            resolved = true;
            streamConnections.set(subscriptionId, { socket, subscriptionId, webContents });
            resolve(subscriptionId);
            continue;
          }

          if (parsed.method && !parsed.id) {
            webContents.send("wincmux:stream-event", {
              method: parsed.method,
              params: parsed.params ?? {}
            });
          }
        }
        index = buffer.indexOf("\n");
      }
    });

    socket.on("close", () => {
      for (const [subscriptionId, conn] of streamConnections.entries()) {
        if (conn.socket === socket) {
          streamConnections.delete(subscriptionId);
        }
      }
    });

    socket.on("connect", () => {
      const request = {
        jsonrpc: "2.0",
        id: requestId,
        method: "session.stream.subscribe",
        params: filter
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });
  });
}

async function closeStream(subscriptionId: string): Promise<void> {
  const conn = streamConnections.get(subscriptionId);
  if (!conn) {
    return;
  }

  const requestId = streamRequestSeq++;
  const request = {
    jsonrpc: "2.0",
    id: requestId,
    method: "session.stream.unsubscribe",
    params: { subscription_id: subscriptionId }
  };
  conn.socket.write(`${JSON.stringify(request)}\n`);
  conn.socket.end();
  streamConnections.delete(subscriptionId);
}

function shouldSuppressNativeToast(notification: NotificationRecord): boolean {
  if (!activeContext.app_focused) {
    return false;
  }
  if (!notification.session_id) {
    return false;
  }
  return activeContext.session_id === notification.session_id;
}

async function ackNotificationDelivery(notificationId: string, delivered: boolean, suppressed: boolean): Promise<void> {
  await pipeCall({
    method: "notify.delivery_ack",
    params: {
      notification_id: notificationId,
      delivered,
      suppressed
    }
  }).catch(() => {});
}

async function handleNotifyCreated(notification: NotificationRecord): Promise<void> {
  if (!notification?.id) {
    return;
  }

  const suppressed = shouldSuppressNativeToast(notification);
  if (suppressed) {
    await ackNotificationDelivery(notification.id, false, true);
  } else if (ElectronNotification.isSupported()) {
    const toast = new ElectronNotification({
      title: notification.title,
      body: notification.body ?? "",
      silent: false,
      timeoutType: "default"
    });
    toast.on("show", () => {
      void ackNotificationDelivery(notification.id, true, false);
    });
    toast.on("click", () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) {
          continue;
        }
        if (win.isMinimized()) {
          win.restore();
        }
        win.show();
        win.focus();
        win.webContents.send("wincmux:notification-open", {
          notification_id: notification.id
        });
      }
    });
    toast.show();
  }

  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue;
    }
    win.webContents.send("wincmux:stream-event", {
      method: "notify.created",
      params: { notification }
    });
  }
}

async function startNotifyStream(): Promise<void> {
  if (notifyStreamSocket && !notifyStreamSocket.destroyed) {
    return;
  }

  await stopNotifyStream();
  const socket = net.createConnection(PIPE_NAME);
  notifyStreamSocket = socket;
  let buffer = "";
  const requestId = streamRequestSeq++;

  socket.once("error", () => {
    // close event always fires after error — reconnect is handled there
  });

  socket.on("close", () => {
    notifyStreamSocket = null;
    notifyStreamSubscriptionId = null;
    if (!appIsQuitting) {
      setTimeout(() => { void startNotifyStream().catch(() => {}); }, 2000);
    }
  });

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        let parsed: StreamEvent;
        try {
          parsed = JSON.parse(line) as StreamEvent;
        } catch {
          index = buffer.indexOf("\n");
          continue;
        }
        if (parsed.id === requestId) {
          if (parsed.error) {
            socket.destroy();
            return;
          }
          const subscriptionId = (parsed.result as { subscription_id?: string } | undefined)?.subscription_id;
          notifyStreamSubscriptionId = subscriptionId ?? null;
          continue;
        }
        if (parsed.method === "notify.created" && !parsed.id) {
          const notification = (parsed.params as { notification?: NotificationRecord } | undefined)?.notification;
          if (notification) {
            void handleNotifyCreated(notification);
          }
        }
      }
      index = buffer.indexOf("\n");
    }
  });

  socket.on("connect", () => {
    socket.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "session.stream.subscribe",
      params: { topics: ["notify"] }
    })}\n`);
  });
}

async function stopNotifyStream(): Promise<void> {
  if (!notifyStreamSocket) {
    return;
  }
  if (notifyStreamSubscriptionId) {
    const requestId = streamRequestSeq++;
    notifyStreamSocket.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "session.stream.unsubscribe",
      params: { subscription_id: notifyStreamSubscriptionId }
    })}\n`);
  }
  notifyStreamSubscriptionId = null;
  notifyStreamSocket.end();
  notifyStreamSocket.destroy();
  notifyStreamSocket = null;
}

function resolveCoreEntrypoint(): string | null {
  const candidates = [
    path.resolve(__dirname, "../../../../packages/core/dist/index.js"),
    path.resolve(process.cwd(), "packages/core/dist/index.js"),
    path.resolve(process.resourcesPath, "packages/core/dist/index.js")
  ];

  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function waitForPipeReady(timeoutMs = 20000): Promise<void> {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    const tryConnect = () => {
      const socket = net.createConnection(PIPE_NAME);
      socket.setTimeout(1500);
      socket.once("connect", () => {
        socket.end();
        finish(resolve);
      });
      socket.once("timeout", () => {
        socket.destroy();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          const bits = [coreRuntimeHint ? `runtime=${coreRuntimeHint}` : null, coreExitReason, coreStderrTail ? `stderr=${coreStderrTail}` : null].filter(Boolean);
          const suffix = bits.length > 0 ? ` (${bits.join("; ")})` : "";
          finish(() => reject(new Error(`Core pipe did not become ready in time${suffix}`)));
          return;
        }
        setTimeout(tryConnect, 120);
      });
    };

    tryConnect();
  });
}

async function ensureCoreReady(): Promise<void> {
  if (process.env.WINCMUX_SPAWN_CORE !== "1") {
    return;
  }

  const entry = resolveCoreEntrypoint();
  if (!entry) {
    throw new Error("Unable to locate core dist/index.js");
  }

  const primaryRuntime = resolveCoreRuntime();
  startCoreProcess(entry, primaryRuntime);

  try {
    await waitForPipeReady();
  } catch (err) {
    const spawnFailed = (coreExitReason ?? "").includes("spawn error");
    if (!spawnFailed) {
      throw err;
    }

    const fallbackRuntime = resolveFallbackCoreRuntime();
    if (fallbackRuntime.command === primaryRuntime.command) {
      throw err;
    }

    startCoreProcess(entry, fallbackRuntime);
    await waitForPipeReady();
  }
}

function resolveCoreRuntime(): { command: string; env: NodeJS.ProcessEnv } {
  const custom = process.env.WINCMUX_CORE_NODE?.trim();
  if (custom) {
    return { command: custom, env: { ...process.env } };
  }

  const npmNode = process.env.npm_node_execpath?.trim();
  if (npmNode && fs.existsSync(npmNode)) {
    return { command: npmNode, env: { ...process.env } };
  }

  const nodeCommand = process.platform === "win32" ? "node.exe" : "node";
  return { command: nodeCommand, env: { ...process.env } };
}

function resolveFallbackCoreRuntime(): { command: string; env: NodeJS.ProcessEnv } {
  return { command: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
}

function startCoreProcess(entry: string, runtime: { command: string; env: NodeJS.ProcessEnv }): void {
  if (coreProc && !coreProc.killed) {
    coreProc.kill();
  }

  coreRuntimeHint = runtime.command;
  coreProc = spawn(runtime.command, [entry], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: runtime.env
  });
  coreExitReason = null;
  coreStderrTail = "";
  coreProc.stderr?.setEncoding("utf8");
  coreProc.stderr?.on("data", (chunk: string) => {
    coreStderrTail = `${coreStderrTail}${chunk}`.slice(-4000).replace(/\s+/g, " ").trim();
  });
  coreProc.once("exit", (code, signal) => {
    coreExitReason = `core exited code=${code ?? "null"} signal=${signal ?? "null"}`;
    if (process.env.WINCMUX_SPAWN_CORE === "1" && !appIsQuitting) {
      setTimeout(() => { void respawnCore().catch(() => {}); }, 500);
    }
  });
  coreProc.once("error", (err) => {
    coreExitReason = `core spawn error: ${err.message}`;
  });
}

function respawnCore(): Promise<void> {
  if (process.env.WINCMUX_SPAWN_CORE !== "1") {
    return Promise.resolve();
  }

  if (coreRespawnPromise) {
    return coreRespawnPromise;
  }

  coreRespawnPromise = (async () => {
    broadcastToAllWindows("wincmux:core-status", { status: "respawning" });
    try {
      const entry = resolveCoreEntrypoint();
      if (!entry) {
        throw new Error("Unable to locate core dist/index.js for respawn");
      }
      startCoreProcess(entry, resolveCoreRuntime());
      await waitForPipeReady(10_000);
      void startNotifyStream().catch(() => {});
      broadcastToAllWindows("wincmux:core-status", { status: "ready" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcastToAllWindows("wincmux:core-status", { status: "dead", error: message });
      throw err;
    } finally {
      coreRespawnPromise = null;
    }
  })();

  return coreRespawnPromise;
}

function validateWorkspacePath(workspacePath: string): string {
  if (!workspacePath || typeof workspacePath !== "string") {
    throw new Error("workspace path is required");
  }

  const normalized = path.resolve(workspacePath);
  if (!fs.existsSync(normalized)) {
    throw new Error(`workspace path does not exist: ${normalized}`);
  }

  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) {
    throw new Error(`workspace path is not a directory: ${normalized}`);
  }

  return normalized;
}

function openViaCodeCli(workspacePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("code", [workspacePath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });

    let settled = false;
    const finish = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      resolve();
    };

    child.once("error", (err) => {
      finish(new Error(`code CLI failed: ${err.message}`));
    });
    child.once("exit", (code) => {
      if (code && code !== 0) {
        finish(new Error(`code CLI exited with code ${code}`));
        return;
      }
      finish();
    });
    child.once("spawn", () => {
      child.unref();
      setTimeout(() => finish(), 120);
    });
  });
}

async function openWorkspaceInVscode(workspacePath: string): Promise<{ ok: true; method: "code-cli" | "vscode-protocol" }> {
  const normalized = validateWorkspacePath(workspacePath);

  try {
    await openViaCodeCli(normalized);
    return { ok: true, method: "code-cli" };
  } catch (cliError) {
    try {
      const fileUrl = pathToFileURL(normalized);
      const vscodeUrl = `vscode://file${fileUrl.pathname}`;
      await shell.openExternal(vscodeUrl);
      return { ok: true, method: "vscode-protocol" };
    } catch (protocolError) {
      const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
      const protocolMessage = protocolError instanceof Error ? protocolError.message : String(protocolError);
      throw new Error(`Unable to open VSCode. code CLI: ${cliMessage}; protocol: ${protocolMessage}`);
    }
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle("wincmux:rpc", async (_event, payload: RpcPayload) => toIpcEnvelope(() => pipeCall(payload)));
  ipcMain.handle("wincmux:stream-subscribe", async (event, payload: StreamFilter) =>
    toIpcEnvelope(() => createPersistentStream(event.sender, payload ?? {}))
  );
  ipcMain.handle("wincmux:stream-unsubscribe", async (_event, payload: { subscription_id: string }) => {
    if (!payload?.subscription_id) {
      return { ok: true };
    }
    await closeStream(payload.subscription_id);
    return { ok: true };
  });
  ipcMain.handle("wincmux:clipboard-read", () => clipboard.readText());
  ipcMain.handle("wincmux:clipboard-write", (_event, payload: { text: string }) => {
    clipboard.writeText(payload?.text ?? "");
    return { ok: true };
  });
  ipcMain.handle("wincmux:perf-log", (_event, payload: unknown) => {
    appendPerfLog(payload);
    return { ok: true };
  });
  ipcMain.handle("wincmux:show-context-menu", async (_event, payload: { has_selection: boolean }) => {
    const template = [
      {
        label: "Copy",
        enabled: Boolean(payload?.has_selection),
        click: () => BrowserWindow.getFocusedWindow()?.webContents.send("wincmux:context-action", { action: "copy" })
      },
      {
        label: "Paste",
        click: () => BrowserWindow.getFocusedWindow()?.webContents.send("wincmux:context-action", { action: "paste" })
      },
      {
        label: "Clear Selection",
        enabled: Boolean(payload?.has_selection),
        click: () => BrowserWindow.getFocusedWindow()?.webContents.send("wincmux:context-action", { action: "clear-selection" })
      }
    ];
    const menu = Menu.buildFromTemplate(template);
    menu.popup();
    return { ok: true };
  });
  ipcMain.handle("wincmux:pick-folder", async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });
  ipcMain.handle("wincmux:open-in-vscode", async (_event, payload: { path: string }) =>
    toIpcEnvelope(() => openWorkspaceInVscode(payload?.path))
  );
  ipcMain.handle("wincmux:set-unread-badge", async (_event, payload: { count?: number }) => {
    applyUnreadBadge(payload?.count ?? 0);
    return { ok: true };
  });
  ipcMain.handle("wincmux:update-active-context", async (_event, payload: {
    workspace_id?: string | null;
    pane_id?: string | null;
    session_id?: string | null;
    app_focused?: boolean;
  }) => {
    activeContext = {
      workspace_id: payload?.workspace_id ?? null,
      pane_id: payload?.pane_id ?? null,
      session_id: payload?.session_id ?? null,
      app_focused: Boolean(payload?.app_focused)
    };
    return { ok: true };
  });
}

app.whenReady()
  .then(async () => {
    app.setAppUserModelId("wincmux.dev");
    try {
      await ensureCoreReady();
    } catch (err) {
      console.error("[WinCMux] Core startup failed:", err);
      dialog.showErrorBox(
        "WinCMux Core Startup Failed",
        String(err instanceof Error ? err.message : err)
      );
    }

    registerIpcHandlers();
    await startNotifyStream().catch((err) => {
      console.error("[WinCMux] Notify stream startup failed:", err);
    });
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  })
  .catch((err) => {
    console.error("[WinCMux] App startup failed:", err);
  });

process.on("unhandledRejection", (reason) => {
  console.error("[WinCMux] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[WinCMux] Uncaught exception:", err);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  appIsQuitting = true;
  for (const subscriptionId of [...streamConnections.keys()]) {
    void closeStream(subscriptionId);
  }
  void stopNotifyStream();
  if (coreProc && !coreProc.killed) {
    coreProc.kill();
  }
  coreProc = null;
});
