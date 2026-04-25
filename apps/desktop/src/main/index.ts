import path from "node:path";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
const APP_USER_MODEL_ID = "ai.manaflow.wincmux";
let coreProc: ChildProcess | null = null;
let coreExitReason: string | null = null;
let coreStderrTail = "";
let coreRuntimeHint = "";
const streamConnections = new Map<string, { socket: net.Socket; subscriptionId: string; webContents: WebContents }>();
let streamRequestSeq = 1;
let rpcRequestSeq = 1;
let unreadBadgeCount = 0;
const badgeIconCache = new Map<string, NativeImage>();
let badgeReapplyTimers: NodeJS.Timeout[] = [];
const activeNotificationToasts = new Map<string, ElectronNotification>();
let appWindowIcon: NativeImage | null = null;
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
  if (count >= 10) {
    return "9+";
  }
  return String(count);
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

  const icon = nativeImage.createFromBuffer(renderBadgePng(label));
  badgeIconCache.set(label, icon);
  return icon;
}

const DIGITS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["010", "010", "111", "010", "010"]
};

function renderBadgePng(label: string): Buffer {
  const size = 16;
  const rgba = Buffer.alloc(size * size * 4);
  const centerX = 10.7;
  const centerY = 10.7;
  const radius = 5.2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;
      const dx = x + 0.5 - centerX;
      const dy = y + 0.5 - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius) {
        rgba[idx] = 229;
        rgba[idx + 1] = 72;
        rgba[idx + 2] = 77;
        rgba[idx + 3] = 255;
      }
      if (dist >= radius - 1.2 && dist <= radius) {
        rgba[idx] = 255;
        rgba[idx + 1] = 255;
        rgba[idx + 2] = 255;
        rgba[idx + 3] = 255;
      }
    }
  }

  const text = label.length > 2 ? "9+" : label;
  const fallbackGlyph = DIGITS["0"] ?? ["111", "101", "101", "101", "111"];
  const glyphs = [...text].map((ch) => DIGITS[ch] ?? fallbackGlyph);
  const scale = 1;
  const glyphWidth = 3 * scale;
  const glyphHeight = 5 * scale;
  const totalWidth = glyphs.length * glyphWidth + Math.max(0, glyphs.length - 1) * scale;
  const startX = Math.max(1, Math.round(centerX - totalWidth / 2));
  const startY = Math.round(centerY - glyphHeight / 2);

  glyphs.forEach((glyph, glyphIndex) => {
    const glyphX = startX + glyphIndex * (glyphWidth + scale);
    for (let gy = 0; gy < glyph.length; gy += 1) {
      const row = glyph[gy] ?? "";
      for (let gx = 0; gx < row.length; gx += 1) {
        if (row[gx] !== "1") {
          continue;
        }
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const x = glyphX + gx * scale + sx;
            const y = startY + gy * scale + sy;
            if (x < 0 || x >= size || y < 0 || y >= size) {
              continue;
            }
            const idx = (y * size + x) * 4;
            rgba[idx] = 255;
            rgba[idx + 1] = 255;
            rgba[idx + 2] = 255;
            rgba[idx + 3] = 255;
          }
        }
      }
    }
  });

  return encodePng(size, size, rgba);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

let crcTable: number[] | null = null;

function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let c = index;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      return c >>> 0;
    });
  }
  const table = crcTable;
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = ((table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createTerminalAppIcon(): NativeImage | null {
  if (appWindowIcon) {
    return appWindowIcon;
  }

  const iconCandidates = [
    path.resolve(process.cwd(), "apps/desktop/assets/icon-terminal.ico"),
    path.resolve(process.cwd(), "assets/icon-terminal.ico"),
    path.resolve(__dirname, "../../assets/icon-terminal.ico"),
    path.resolve(process.resourcesPath, "assets/icon-terminal.ico"),
    path.resolve(process.cwd(), "apps/desktop/assets/icon-terminal.png"),
    path.resolve(process.cwd(), "assets/icon-terminal.png"),
    path.resolve(__dirname, "../../assets/icon-terminal.png"),
    path.resolve(process.resourcesPath, "assets/icon-terminal.png")
  ];

  for (const candidate of iconCandidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const fileIcon = nativeImage.createFromPath(candidate).resize({ width: 256, height: 256 });
    if (!fileIcon.isEmpty()) {
      appWindowIcon = fileIcon;
      return appWindowIcon;
    }
  }

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#18212f" />
      <stop offset="100%" stop-color="#0f161f" />
    </linearGradient>
    <linearGradient id="screen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a2433" />
      <stop offset="100%" stop-color="#0f141c" />
    </linearGradient>
  </defs>
  <rect x="14" y="14" width="228" height="228" rx="44" fill="url(#bg)" />
  <rect x="30" y="40" width="196" height="176" rx="24" fill="url(#screen)" stroke="#2a394d" stroke-width="3" />
  <circle cx="56" cy="62" r="6" fill="#ef4444" />
  <circle cx="78" cy="62" r="6" fill="#f59e0b" />
  <circle cx="100" cy="62" r="6" fill="#22c55e" />
  <path d="M72 120 L105 146 L72 172" fill="none" stroke="#4ade80" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" />
  <rect x="118" y="162" width="64" height="14" rx="7" fill="#4ade80" />
</svg>`.trim();

  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const fallbackIcon = nativeImage.createFromDataURL(dataUrl).resize({ width: 256, height: 256 });
  if (fallbackIcon.isEmpty()) {
    return null;
  }

  appWindowIcon = fallbackIcon;
  return appWindowIcon;
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
  if (app.isReady()) {
    app.setBadgeCount(unreadBadgeCount);
  }

  cancelBadgeReapplyTimers();
  applyUnreadBadgeToWindows();
  if (unreadBadgeCount > 0) {
    scheduleUnreadBadgeReapply();
  }
}

function applyUnreadBadgeToWindows(): void {
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

function scheduleUnreadBadgeReapply(): void {
  cancelBadgeReapplyTimers();
  if (process.platform !== "win32") {
    return;
  }
  for (const delay of [150, 750, 2000]) {
    badgeReapplyTimers.push(setTimeout(() => applyUnreadBadgeToWindows(), delay));
  }
}

function cancelBadgeReapplyTimers(): void {
  for (const timer of badgeReapplyTimers) {
    clearTimeout(timer);
  }
  badgeReapplyTimers = [];
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, "..", "preload", "index.js");
  const icon = createTerminalAppIcon();
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.on("focus", () => {
    activeContext.app_focused = true;
    win.flashFrame(false);
  });
  win.on("blur", () => {
    activeContext.app_focused = false;
  });
  win.on("show", () => applyUnreadBadge(unreadBadgeCount));
  win.webContents.once("did-finish-load", () => applyUnreadBadge(unreadBadgeCount));
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

class PipeRpcClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  async call(payload: RpcPayload): Promise<unknown> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw Object.assign(new Error("core pipe is not connected"), { code: "ENOENT" });
    }

    const requestId = rpcRequestSeq++;
    const request = {
      jsonrpc: "2.0",
      id: requestId,
      method: payload.method,
      params: payload.params ?? {}
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`RPC timeout: ${payload.method}`));
      }, 15_000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  destroy(): void {
    this.rejectAll(new Error("core pipe disconnected"));
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
    this.buffer = "";
    this.connecting = null;
  }

  private ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return Promise.resolve();
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(PIPE_NAME);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        fn();
      };

      socket.once("connect", () => {
        this.socket = socket;
        this.buffer = "";
        this.connecting = null;
        finish(resolve);
      });
      socket.once("error", (err) => {
        this.connecting = null;
        socket.destroy();
        finish(() => reject(err));
      });
      socket.on("close", () => {
        if (this.socket === socket) {
          this.socket = null;
          this.buffer = "";
        }
        this.rejectAll(new Error("core pipe disconnected"));
      });
      socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    });

    return this.connecting;
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
      index = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let response: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      response = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { message?: string } };
    } catch {
      return;
    }
    const id = Number(response.id);
    const pending = Number.isFinite(id) ? this.pending.get(id) : null;
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new Error(response.error.message ?? "RPC failed"));
      return;
    }
    pending.resolve(response.result);
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

const rpcClient = new PipeRpcClient();

function pipeCallOnce(payload: RpcPayload): Promise<unknown> {
  return rpcClient.call(payload);
}

async function pipeCall(payload: RpcPayload, attempt = 0): Promise<unknown> {
  try {
    return await pipeCallOnce(payload);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : String(err);
    if ((code === "ENOENT" || message.includes("core pipe disconnected")) && attempt < 3) {
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

async function refreshUnreadBadgeFromCore(): Promise<void> {
  const result = await pipeCall({
    method: "notify.unread",
    params: {}
  });
  const count = typeof result === "object" && result !== null && "count" in result
    ? Number((result as { count?: unknown }).count)
    : NaN;
  if (Number.isFinite(count)) {
    applyUnreadBadge(count);
  }
}

function dismissNotificationToasts(ids?: string[]): void {
  const targetIds = ids?.length ? ids : [...activeNotificationToasts.keys()];
  for (const id of targetIds) {
    const toast = activeNotificationToasts.get(id);
    if (!toast) {
      continue;
    }
    activeNotificationToasts.delete(id);
    try {
      toast.close();
    } catch {
      // Windows may have already dismissed this toast.
    }
  }
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
    toast.once("close", () => {
      activeNotificationToasts.delete(notification.id);
    });
    toast.once("failed", () => {
      activeNotificationToasts.delete(notification.id);
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
          notification_id: notification.id,
          notification
        });
      }
    });
    activeNotificationToasts.set(notification.id, toast);
    toast.show();
  }

  applyUnreadBadge(unreadBadgeCount + 1);
  void refreshUnreadBadgeFromCore().catch(() => {});

  // Flash taskbar icon when app is not focused
  if (!activeContext.app_focused) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.flashFrame(true);
      }
    }
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
  rpcClient.destroy();
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
    process.stderr.write(chunk);
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
    const crashReason = coreExitReason;
    const crashStderr = coreStderrTail;
    console.error("[core-crash] reason:", crashReason, "stderr:", crashStderr.slice(-500));
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

const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "__pycache__", ".turbo", ".cache"]);
const SCAN_CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".cs", ".java", ".cpp", ".c", ".h", ".hpp", ".rb", ".swift", ".kt", ".vue", ".svelte"]);

function countFileLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    let count = 1;
    for (let i = 0; i < content.length; i++) {
      if (content[i] === "\n") count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function walkForLongFiles(
  dir: string,
  root: string,
  minLines: number,
  results: Array<{ relativePath: string; lineCount: number }>
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SCAN_SKIP_DIRS.has(entry.name)) {
        walkForLongFiles(path.join(dir, entry.name), root, minLines, results);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SCAN_CODE_EXTS.has(ext)) {
        const fullPath = path.join(dir, entry.name);
        const lineCount = countFileLines(fullPath);
        if (lineCount >= minLines) {
          results.push({ relativePath: path.relative(root, fullPath).replace(/\\/g, "/"), lineCount });
        }
      }
    }
  }
}

function scanLongFiles(workspacePath: string, minLines: number): { files: Array<{ relativePath: string; lineCount: number }> } {
  const normalized = validateWorkspacePath(workspacePath);
  const safeMin = Math.max(1, Math.floor(Number(minLines) || 1000));
  const results: Array<{ relativePath: string; lineCount: number }> = [];
  walkForLongFiles(normalized, normalized, safeMin, results);
  results.sort((a, b) => b.lineCount - a.lineCount);
  return { files: results.slice(0, 50) };
}

const AGENT_ASSET_MAX_PREVIEW_BYTES = 256 * 1024;
const AGENT_ASSET_MAX_WRITE_BYTES = 512 * 1024;
const AGENT_ASSET_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", "out", ".next", ".turbo", ".cache"]);
const AGENT_ASSET_TEXT_EXTS = new Set([".md", ".mdc", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".txt"]);

type AgentAssetCategory = "instructions" | "skills" | "rules" | "subagents" | "commands" | "settings" | "mcp" | "other";
type AgentAssetProviderId = "claude" | "codex" | "gemini" | "cursor" | "kiro" | "opencode" | "shared";

type AgentAssetProviderDefinition = {
  id: AgentAssetProviderId;
  label: string;
  instructionFiles?: string[];
  settingsFiles?: string[];
  scanRoots?: string[];
  editableFiles?: string[];
  editablePatterns?: RegExp[];
  allowedPatterns?: RegExp[];
};

const AGENT_ASSET_PROVIDERS: AgentAssetProviderDefinition[] = [
  {
    id: "claude",
    label: "Claude",
    instructionFiles: ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"],
    settingsFiles: [".claude/settings.json", ".claude/settings.local.json"],
    scanRoots: [".claude"],
    editableFiles: ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"],
    editablePatterns: [/^\.claude\/rules\/[^/]+\.md$/i, /^\.claude\/commands\/[^/]+\.md$/i],
    allowedPatterns: [/^\.claude\/.+/i]
  },
  {
    id: "codex",
    label: "Codex",
    instructionFiles: ["AGENTS.md", "AGENTS.override.md"],
    scanRoots: [".agents"],
    editableFiles: ["AGENTS.md", "AGENTS.override.md"],
    allowedPatterns: [/^\.agents\/.+/i]
  },
  {
    id: "gemini",
    label: "Gemini",
    instructionFiles: ["GEMINI.md"],
    settingsFiles: [".gemini/settings.json"],
    scanRoots: [".gemini"],
    editableFiles: ["GEMINI.md"],
    allowedPatterns: [/^\.gemini\/.+/i]
  },
  {
    id: "cursor",
    label: "Cursor",
    instructionFiles: [".cursorrules", "AGENTS.md"],
    scanRoots: [".cursor"],
    editableFiles: [".cursorrules", "AGENTS.md"],
    editablePatterns: [/^\.cursor\/rules\/.+\.(mdc|md)$/i],
    allowedPatterns: [/^\.cursor\/.+/i]
  },
  {
    id: "kiro",
    label: "Kiro",
    instructionFiles: ["AGENTS.md"],
    scanRoots: [".kiro"],
    editableFiles: ["AGENTS.md"],
    editablePatterns: [/^\.kiro\/steering\/.+\.md$/i],
    allowedPatterns: [/^\.kiro\/.+/i]
  },
  {
    id: "opencode",
    label: "opencode",
    instructionFiles: ["AGENTS.md"],
    settingsFiles: ["opencode.json", "opencode.jsonc"],
    scanRoots: [".opencode"],
    editableFiles: ["AGENTS.md"],
    allowedPatterns: [/^\.opencode\/.+/i]
  },
  {
    id: "shared",
    label: "Shared",
    settingsFiles: [".mcp.json"],
    editableFiles: [],
    allowedPatterns: [/^\.mcp\.json$/i]
  }
];

type AgentAssetItem = {
  category: AgentAssetCategory;
  providers: AgentAssetProviderId[];
  relativePath: string;
  name: string;
  exists: boolean;
  editable: boolean;
  readOnly: boolean;
  large: boolean;
  invalid: boolean;
  privateLocal: boolean;
  size: number;
  lineCount: number | null;
  modifiedAt: string | null;
  summary: string;
  details: Record<string, unknown>;
  warnings: string[];
};

type AgentAssetsScanResult = {
  summary: Record<AgentAssetCategory, { count: number; missing: number; invalid: number; large: number; local: number }>;
  items: AgentAssetItem[];
};

function toWorkspaceRelative(filePath: string, root: string): string {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function normalizeRelativePath(relativePath: string): string {
  const raw = String(relativePath ?? "").replace(/\\/g, "/").trim();
  if (!raw || path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new Error("workspace-relative path is required");
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".")) {
    throw new Error("path traversal is not allowed");
  }
  return parts.join("/");
}

function assertInsideWorkspace(root: string, targetPath: string): void {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(targetPath);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(normalizedRoot + path.sep)) {
    throw new Error("path escapes workspace");
  }
}

function nearestExistingAncestor(targetPath: string): string {
  let current = targetPath;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("unable to resolve path ancestor");
    }
    current = parent;
  }
  return current;
}

function resolveWorkspaceAssetPath(workspacePath: string, relativePath: string, options: { forWrite?: boolean } = {}): { root: string; relative: string; fullPath: string } {
  const root = validateWorkspacePath(workspacePath);
  const relative = normalizeRelativePath(relativePath);
  if (!isAllowedAgentAssetPath(relative)) {
    throw new Error(`agent asset path is not allowed: ${relative}`);
  }
  const fullPath = path.resolve(root, relative);
  assertInsideWorkspace(root, fullPath);

  const rootReal = fs.realpathSync.native(root);
  const realTarget = fs.realpathSync.native(fs.existsSync(fullPath) ? fullPath : nearestExistingAncestor(path.dirname(fullPath)));
  assertInsideWorkspace(rootReal, realTarget);

  if (options.forWrite && !isEditableAgentAssetPath(relative)) {
    throw new Error(`agent asset is read-only in WinCMux: ${relative}`);
  }
  return { root, relative, fullPath };
}

function isAllowedAgentAssetPath(relativePath: string): boolean {
  const rel = relativePath.replace(/\\/g, "/");
  for (const provider of AGENT_ASSET_PROVIDERS) {
    if (provider.instructionFiles?.includes(rel) || provider.settingsFiles?.includes(rel)) return true;
    if (provider.allowedPatterns?.some((pattern) => pattern.test(rel))) return true;
    if (provider.editablePatterns?.some((pattern) => pattern.test(rel))) return true;
  }
  return false;
}

function isEditableAgentAssetPath(relativePath: string): boolean {
  const rel = relativePath.replace(/\\/g, "/");
  for (const provider of AGENT_ASSET_PROVIDERS) {
    if (provider.editableFiles?.includes(rel)) return true;
    if (provider.editablePatterns?.some((pattern) => pattern.test(rel))) return true;
  }
  return false;
}

function providersForAgentAssetPath(relativePath: string): AgentAssetProviderId[] {
  const rel = relativePath.replace(/\\/g, "/");
  const providers = AGENT_ASSET_PROVIDERS
    .filter((provider) =>
      provider.instructionFiles?.includes(rel) ||
      provider.settingsFiles?.includes(rel) ||
      provider.allowedPatterns?.some((pattern) => pattern.test(rel)) ||
      provider.editablePatterns?.some((pattern) => pattern.test(rel))
    )
    .map((provider) => provider.id);
  return providers.length > 0 ? providers : ["shared"];
}

function uniqueAgentAssetPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(Boolean).map((p) => p.replace(/\\/g, "/"))));
}

function readSmallText(filePath: string, maxBytes = AGENT_ASSET_MAX_PREVIEW_BYTES): string | null {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) return null;
  return fs.readFileSync(filePath, "utf8");
}

function countLinesFromContent(content: string): number {
  if (!content) return 0;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") count++;
  }
  return count;
}

function parseMarkdownFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = content.slice(3, end).trim();
  const out: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) {
      currentKey = match[1] ?? null;
      if (currentKey) {
        out[currentKey] = (match[2] ?? "").replace(/^["']|["']$/g, "").trim();
      }
    } else if (currentKey && /^\s+-\s+/.test(line)) {
      const value = line.replace(/^\s+-\s+/, "").trim();
      out[currentKey] = out[currentKey] ? `${out[currentKey]}, ${value}` : value;
    }
  }
  return out;
}

function listDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function countFilesInDir(dir: string, predicate?: (entryPath: string, entry: fs.Dirent) => boolean): number {
  let count = 0;
  for (const entry of listDirSafe(dir)) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFilesInDir(fullPath, predicate);
    } else if (entry.isFile() && (!predicate || predicate(fullPath, entry))) {
      count++;
    }
  }
  return count;
}

function makeAgentAssetItem(root: string, category: AgentAssetCategory, relativePath: string, extra: Partial<AgentAssetItem> = {}): AgentAssetItem {
  const fullPath = path.join(root, relativePath);
  const exists = fs.existsSync(fullPath);
  const stat = exists ? fs.statSync(fullPath) : null;
  const size = stat?.isFile() ? stat.size : 0;
  const large = Boolean(stat?.isFile() && size > AGENT_ASSET_MAX_PREVIEW_BYTES);
  let lineCount: number | null = null;
  let content: string | null = null;
  if (exists && stat?.isFile() && !large) {
    try {
      content = fs.readFileSync(fullPath, "utf8");
      lineCount = countLinesFromContent(content);
    } catch {
      lineCount = null;
    }
  }
  const name = extra.name ?? path.basename(relativePath);
  return {
    category,
    providers: providersForAgentAssetPath(relativePath),
    relativePath,
    name,
    exists,
    editable: isEditableAgentAssetPath(relativePath),
    readOnly: !isEditableAgentAssetPath(relativePath),
    large,
    invalid: false,
    privateLocal: /(^|\/).*(local|override).*$/i.test(relativePath),
    size,
    lineCount,
    modifiedAt: stat ? stat.mtime.toISOString() : null,
    summary: exists ? `${name}${lineCount !== null ? ` · ${lineCount} lines` : ""}` : `${name} missing`,
    details: {},
    warnings: [],
    ...extra
  };
}

function parseInstructionItem(root: string, relativePath: string): AgentAssetItem {
  const item = makeAgentAssetItem(root, "instructions", relativePath);
  if (!item.exists || item.large) return item;
  const content = readSmallText(path.join(root, relativePath));
  const imports = content ? (content.match(/^@\S+/gm) ?? []).length : 0;
  const importsAgents = relativePath.toUpperCase().includes("CLAUDE") && Boolean(content && /@\.?\/?AGENTS\.md/i.test(content));
  item.details = { imports, importsAgents };
  item.summary = `${item.name} · ${item.lineCount ?? 0} lines${imports ? ` · ${imports} imports` : ""}${importsAgents ? " · imports AGENTS.md" : ""}`;
  return item;
}

function parseSkillDir(root: string, skillDir: string): AgentAssetItem {
  const skillName = path.basename(skillDir);
  const skillMd = path.join(skillDir, "SKILL.md");
  const relative = toWorkspaceRelative(skillMd, root);
  if (!fs.existsSync(skillMd)) {
    return makeAgentAssetItem(root, "skills", relative, {
      name: skillName,
      exists: false,
      editable: false,
      readOnly: true,
      invalid: true,
      summary: `${skillName} · missing SKILL.md`,
      warnings: ["SKILL.md is missing"]
    });
  }
  const item = makeAgentAssetItem(root, "skills", relative, { name: skillName, editable: false, readOnly: true });
  if (!item.large) {
    const content = readSmallText(skillMd) ?? "";
    const fm = parseMarkdownFrontmatter(content);
    item.details = {
      frontmatterName: fm.name ?? "",
      description: fm.description ?? "",
      allowedTools: fm["allowed-tools"] ?? "",
      disableModelInvocation: fm["disable-model-invocation"] ?? "",
      scripts: countFilesInDir(path.join(skillDir, "scripts")),
      examples: countFilesInDir(path.join(skillDir, "examples")),
      templates: countFilesInDir(path.join(skillDir, "templates")),
      references: countFilesInDir(skillDir, (entryPath) => /^reference.*\.md$/i.test(path.basename(entryPath))),
      supportingFiles: Math.max(0, countFilesInDir(skillDir) - 1)
    };
    if (!fm.name && !fm.description) {
      item.warnings.push("frontmatter name/description not found");
    }
    item.summary = `${skillName}${fm.description ? ` · ${fm.description}` : ""}`;
  }
  return item;
}

function parseSettingsItem(root: string, relativePath: string): AgentAssetItem {
  const item = makeAgentAssetItem(root, "settings", relativePath, { editable: false, readOnly: true });
  if (!item.exists || item.large) return item;
  if (path.extname(relativePath).toLowerCase() === ".jsonc") {
    item.summary = `${item.name} · JSONC config`;
    item.details = { format: "jsonc" };
    return item;
  }
  try {
    const json = JSON.parse(readSmallText(path.join(root, relativePath)) ?? "{}");
    const permissions = json?.permissions ?? {};
    const hooks = json?.hooks && typeof json.hooks === "object" ? json.hooks : {};
    const hookCounts = Object.fromEntries(Object.entries(hooks).map(([key, value]) => [key, Array.isArray(value) ? value.length : 1]));
    const allowCount = Array.isArray(permissions.allow) ? permissions.allow.length : 0;
    const denyCount = Array.isArray(permissions.deny) ? permissions.deny.length : 0;
    item.details = {
      allow: allowCount,
      deny: denyCount,
      hooks: hookCounts,
      enabledPlugins: Array.isArray(json?.enabledPlugins) ? json.enabledPlugins.length : 0,
      envKeys: json?.env && typeof json.env === "object" ? Object.keys(json.env).length : 0
    };
    item.summary = `${item.name} · allow ${allowCount} · deny ${denyCount} · hooks ${Object.keys(hookCounts).length}`;
  } catch (err) {
    item.invalid = true;
    item.warnings.push(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return item;
}

function parseMcpItem(root: string): AgentAssetItem {
  const item = makeAgentAssetItem(root, "mcp", ".mcp.json", { editable: false, readOnly: true });
  if (!item.exists || item.large) return item;
  try {
    const json = JSON.parse(readSmallText(path.join(root, ".mcp.json")) ?? "{}");
    const servers = json?.mcpServers && typeof json.mcpServers === "object" ? json.mcpServers : {};
    const serverDetails = Object.entries(servers).map(([name, value]) => {
      const server = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const transport = typeof server.type === "string"
        ? server.type
        : typeof server.url === "string"
          ? "http"
          : typeof server.command === "string"
            ? "stdio"
            : "unknown";
      const env = server.env && typeof server.env === "object" ? Object.keys(server.env as Record<string, unknown>) : [];
      return { name, transport, hasCommand: Boolean(server.command), hasUrl: Boolean(server.url), envKeys: env };
    });
    item.details = {
      servers: serverDetails
    };
    item.summary = `.mcp.json · ${serverDetails.length} servers`;
  } catch (err) {
    item.invalid = true;
    item.warnings.push(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return item;
}

function parseMarkdownAsset(root: string, category: AgentAssetCategory, relativePath: string, options: { editable?: boolean } = {}): AgentAssetItem {
  const item = makeAgentAssetItem(root, category, relativePath, {
    editable: options.editable ?? isEditableAgentAssetPath(relativePath),
    readOnly: !(options.editable ?? isEditableAgentAssetPath(relativePath))
  });
  if (!item.exists || item.large) return item;
  const content = readSmallText(path.join(root, relativePath)) ?? "";
  const fm = parseMarkdownFrontmatter(content);
  item.details = { ...fm };
  item.summary = `${item.name}${fm.description ? ` · ${fm.description}` : ""}`;
  return item;
}

function walkAllowedAgentFiles(root: string, dir: string, category: AgentAssetCategory, items: AgentAssetItem[], limit = 100): void {
  if (items.length >= limit) return;
  for (const entry of listDirSafe(dir)) {
    if (AGENT_ASSET_SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relative = toWorkspaceRelative(fullPath, root);
    if (entry.isDirectory()) {
      walkAllowedAgentFiles(root, fullPath, category, items, limit);
    } else if (entry.isFile() && isAllowedAgentAssetPath(relative) && AGENT_ASSET_TEXT_EXTS.has(path.extname(entry.name).toLowerCase())) {
      items.push(makeAgentAssetItem(root, category, relative, { editable: false, readOnly: true }));
      if (items.length >= limit) return;
    }
  }
}

function pushUniqueAgentItem(items: AgentAssetItem[], item: AgentAssetItem): void {
  const existing = items.find((candidate) => candidate.relativePath === item.relativePath);
  if (existing) {
    existing.providers = Array.from(new Set([...existing.providers, ...item.providers]));
    if (existing.category === "other" && item.category !== "other") existing.category = item.category;
    return;
  }
  items.push(item);
}

function scanAgentAssets(workspacePath: string): AgentAssetsScanResult {
  const root = validateWorkspacePath(workspacePath);
  const items: AgentAssetItem[] = [];

  const instructionFiles = uniqueAgentAssetPaths(AGENT_ASSET_PROVIDERS.flatMap((provider) => provider.instructionFiles ?? []));
  const settingsFiles = uniqueAgentAssetPaths(AGENT_ASSET_PROVIDERS.flatMap((provider) => provider.settingsFiles ?? []));

  for (const rel of instructionFiles) {
    pushUniqueAgentItem(items, parseInstructionItem(root, rel));
  }
  for (const rel of settingsFiles) {
    if (rel === ".mcp.json") {
      pushUniqueAgentItem(items, parseMcpItem(root));
    } else {
      pushUniqueAgentItem(items, parseSettingsItem(root, rel));
    }
  }

  const rulesDir = path.join(root, ".claude", "rules");
  for (const entry of listDirSafe(rulesDir).filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))) {
    pushUniqueAgentItem(items, parseMarkdownAsset(root, "rules", `.claude/rules/${entry.name}`, { editable: true }));
  }

  const commandsDir = path.join(root, ".claude", "commands");
  for (const entry of listDirSafe(commandsDir).filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))) {
    const rel = `.claude/commands/${entry.name}`;
    const item = parseMarkdownAsset(root, "commands", rel, { editable: true });
    item.details = { ...item.details, slashCommand: `/${path.basename(entry.name, ".md")}` };
    pushUniqueAgentItem(items, item);
  }

  const agentsDir = path.join(root, ".claude", "agents");
  for (const entry of listDirSafe(agentsDir).filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))) {
    pushUniqueAgentItem(items, parseMarkdownAsset(root, "subagents", `.claude/agents/${entry.name}`, { editable: false }));
  }

  const skillsDir = path.join(root, ".claude", "skills");
  for (const entry of listDirSafe(skillsDir).filter((e) => e.isDirectory())) {
    pushUniqueAgentItem(items, parseSkillDir(root, path.join(skillsDir, entry.name)));
  }

  const cursorRulesDir = path.join(root, ".cursor", "rules");
  for (const entry of listDirSafe(cursorRulesDir).filter((e) => e.isFile() && /\.(mdc|md)$/i.test(e.name))) {
    pushUniqueAgentItem(items, parseMarkdownAsset(root, "rules", `.cursor/rules/${entry.name}`, { editable: true }));
  }

  const kiroSteeringDir = path.join(root, ".kiro", "steering");
  for (const entry of listDirSafe(kiroSteeringDir).filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))) {
    pushUniqueAgentItem(items, parseMarkdownAsset(root, "rules", `.kiro/steering/${entry.name}`, { editable: true }));
  }

  for (const rootRel of uniqueAgentAssetPaths(AGENT_ASSET_PROVIDERS.flatMap((provider) => provider.scanRoots ?? []))) {
    const otherItems: AgentAssetItem[] = [];
    walkAllowedAgentFiles(root, path.join(root, rootRel), "other", otherItems);
    for (const item of otherItems) {
      pushUniqueAgentItem(items, item);
    }
  }

  const categories: AgentAssetCategory[] = ["instructions", "skills", "rules", "subagents", "commands", "settings", "mcp", "other"];
  const summary = Object.fromEntries(categories.map((category) => [
    category,
    {
      count: items.filter((item) => item.category === category && item.exists).length,
      missing: items.filter((item) => item.category === category && !item.exists).length,
      invalid: items.filter((item) => item.category === category && item.invalid).length,
      large: items.filter((item) => item.category === category && item.large).length,
      local: items.filter((item) => item.category === category && item.privateLocal).length
    }
  ])) as AgentAssetsScanResult["summary"];

  items.sort((a, b) => {
    const catDiff = categories.indexOf(a.category) - categories.indexOf(b.category);
    if (catDiff !== 0) return catDiff;
    if (a.exists !== b.exists) return a.exists ? -1 : 1;
    return a.relativePath.localeCompare(b.relativePath);
  });

  return { summary, items };
}

function readAgentAsset(workspacePath: string, relativePath: string): { content: string; meta: AgentAssetItem } {
  const { root, relative, fullPath } = resolveWorkspaceAssetPath(workspacePath, relativePath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error(`agent asset not found: ${relative}`);
  }
  const meta = makeAgentAssetItem(root, "other", relative);
  if (meta.large) {
    throw new Error(`agent asset is too large to preview (${meta.size} bytes)`);
  }
  return { content: fs.readFileSync(fullPath, "utf8"), meta };
}

function writeAgentAsset(workspacePath: string, relativePath: string, content: string): { ok: true; savedAt: string } {
  const { fullPath, relative } = resolveWorkspaceAssetPath(workspacePath, relativePath, { forWrite: true });
  const text = String(content ?? "");
  if (Buffer.byteLength(text, "utf8") > AGENT_ASSET_MAX_WRITE_BYTES) {
    throw new Error("agent asset content is too large to save");
  }
  if (path.extname(relative).toLowerCase() === ".json") {
    JSON.parse(text);
  }
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  if (fs.existsSync(fullPath)) {
    fs.copyFileSync(fullPath, `${fullPath}.bak`);
  }
  const tmpPath = `${fullPath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmpPath, text, "utf8");
  fs.renameSync(tmpPath, fullPath);
  return { ok: true, savedAt: new Date().toISOString() };
}

function createAgentAsset(workspacePath: string, relativePath: string, templateKind?: string): { ok: true; content: string } {
  const { fullPath, relative } = resolveWorkspaceAssetPath(workspacePath, relativePath, { forWrite: true });
  if (fs.existsSync(fullPath)) {
    throw new Error(`agent asset already exists: ${relative}`);
  }
  const kind = String(templateKind ?? "").toLowerCase();
  const title = path.basename(relative, path.extname(relative));
  const content = kind === "command"
    ? `# /${title}\n\nDescribe what this command should do.\n\n$ARGUMENTS\n`
    : kind === "rule"
      ? `# ${title}\n\n- Add project-specific rule here.\n`
      : relative.toUpperCase().includes("GEMINI")
        ? `# GEMINI.md\n\n## Project Notes\n\n- Add guidance for Gemini CLI here.\n`
        : relative.toLowerCase().includes(".cursorrules")
          ? `# Cursor Rules\n\n- Add project-wide Cursor guidance here.\n`
      : relative.toUpperCase().includes("AGENTS")
        ? `# AGENTS.md\n\n## Project Notes\n\n- Add guidance for Codex agents here.\n`
        : `# CLAUDE.md\n\n## Project Notes\n\n- Add guidance for Claude Code here.\n`;
  writeAgentAsset(workspacePath, relative, content);
  return { ok: true, content };
}

const INPUT_ASSET_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const INPUT_ASSET_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const INPUT_ASSET_PREVIEW_CHARS = 280;
const INPUT_ASSET_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

type InputAssetType = "text" | "image";

type InputAssetRow = {
  id: string;
  type: InputAssetType;
  title: string;
  relative_path: string;
  preview: string;
  size: number;
  created_at: string;
  updated_at: string;
  source_pane_id?: string | null;
  source_session_id?: string | null;
};

type InputAssetIndex = {
  version: 1;
  assets: InputAssetRow[];
};

function inputAssetsBaseRelative(): string {
  return ".wincmux/input-assets";
}

function inputAssetsIndexRelative(): string {
  return `${inputAssetsBaseRelative()}/index.json`;
}

function resolveInputAssetPath(root: string, relativePath: string): string {
  const relative = normalizeRelativePath(relativePath);
  if (!relative.startsWith(`${inputAssetsBaseRelative()}/`) && relative !== inputAssetsIndexRelative()) {
    throw new Error(`input asset path is not allowed: ${relative}`);
  }
  const fullPath = path.resolve(root, relative);
  assertInsideWorkspace(root, fullPath);
  const rootReal = fs.realpathSync.native(root);
  const realTarget = fs.realpathSync.native(fs.existsSync(fullPath) ? fullPath : nearestExistingAncestor(path.dirname(fullPath)));
  assertInsideWorkspace(rootReal, realTarget);
  return fullPath;
}

function ensureInputAssetStore(root: string): void {
  const base = path.join(root, ".wincmux");
  const assets = path.join(base, "input-assets");
  const assertExistingSafe = (targetPath: string) => {
    if (!fs.existsSync(targetPath)) return;
    const rootReal = fs.realpathSync.native(root);
    const targetReal = fs.realpathSync.native(targetPath);
    assertInsideWorkspace(rootReal, targetReal);
  };
  assertExistingSafe(base);
  assertExistingSafe(assets);
  fs.mkdirSync(path.join(assets, "snippets"), { recursive: true });
  fs.mkdirSync(path.join(assets, "images"), { recursive: true });
  assertExistingSafe(path.join(assets, "snippets"));
  assertExistingSafe(path.join(assets, "images"));
  const gitignorePath = path.join(base, ".gitignore");
  let existing = "";
  try {
    existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  } catch {
    existing = "";
  }
  if (!/(^|\r?\n)input-assets\/?(\r?\n|$)/.test(existing)) {
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(gitignorePath, `${existing}${prefix}input-assets/\n`, "utf8");
  }
  const indexPath = path.join(assets, "index.json");
  if (!fs.existsSync(indexPath)) {
    writeInputAssetIndex(root, { version: 1, assets: [] });
  }
}

function readInputAssetIndex(root: string): InputAssetIndex {
  const indexPath = resolveInputAssetPath(root, inputAssetsIndexRelative());
  if (!fs.existsSync(indexPath)) {
    return { version: 1, assets: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Partial<InputAssetIndex>;
    const rows = Array.isArray(parsed.assets) ? parsed.assets : [];
    return {
      version: 1,
      assets: rows
        .filter((row): row is InputAssetRow => Boolean(row && typeof row.id === "string" && typeof row.relative_path === "string"))
        .map((row) => ({
          id: row.id,
          type: row.type === "image" ? "image" : "text",
          title: String(row.title || "Untitled"),
          relative_path: String(row.relative_path),
          preview: String(row.preview ?? ""),
          size: Number(row.size ?? 0),
          created_at: String(row.created_at ?? new Date().toISOString()),
          updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
          source_pane_id: row.source_pane_id ?? null,
          source_session_id: row.source_session_id ?? null
        }))
    };
  } catch (err) {
    throw new Error(`input asset index is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeInputAssetIndex(root: string, index: InputAssetIndex): void {
  const indexPath = resolveInputAssetPath(root, inputAssetsIndexRelative());
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const tmpPath = `${indexPath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, indexPath);
}

function inputAssetTitleFromText(text: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (firstLine) {
    return firstLine.slice(0, 80);
  }
  const stamp = new Date().toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
  return `Snippet ${stamp}`;
}

function inputAssetPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, INPUT_ASSET_PREVIEW_CHARS);
}

function inputAssetTitleFromImage(): string {
  const stamp = new Date().toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
  return `Image ${stamp}`;
}

function inputAssetById(root: string, assetId: string): { index: InputAssetIndex; asset: InputAssetRow; fullPath: string } {
  const index = readInputAssetIndex(root);
  const asset = index.assets.find((row) => row.id === assetId);
  if (!asset) {
    throw new Error(`input asset not found: ${assetId}`);
  }
  const fullPath = resolveInputAssetPath(root, asset.relative_path);
  return { index, asset, fullPath };
}

function listInputAssets(workspacePath: string): { assets: InputAssetRow[] } {
  const root = validateWorkspacePath(workspacePath);
  ensureInputAssetStore(root);
  const index = readInputAssetIndex(root);
  return { assets: index.assets.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)) };
}

function createTextInputAsset(
  workspacePath: string,
  payload: { title?: string; content?: string; source?: { pane_id?: string | null; session_id?: string | null } }
): { asset: InputAssetRow } {
  const root = validateWorkspacePath(workspacePath);
  ensureInputAssetStore(root);
  const content = String(payload?.content ?? "");
  if (!content.trim()) {
    throw new Error("input asset content is required");
  }
  if (Buffer.byteLength(content, "utf8") > INPUT_ASSET_MAX_TEXT_BYTES) {
    throw new Error("input asset text is too large");
  }
  const index = readInputAssetIndex(root);
  const id = randomUUID();
  const now = new Date().toISOString();
  const relativePath = `${inputAssetsBaseRelative()}/snippets/${id}.md`;
  const fullPath = resolveInputAssetPath(root, relativePath);
  fs.writeFileSync(fullPath, content, "utf8");
  const asset: InputAssetRow = {
    id,
    type: "text",
    title: String(payload?.title || inputAssetTitleFromText(content)).trim().slice(0, 120) || inputAssetTitleFromText(content),
    relative_path: relativePath,
    preview: inputAssetPreview(content),
    size: Buffer.byteLength(content, "utf8"),
    created_at: now,
    updated_at: now,
    source_pane_id: payload?.source?.pane_id ?? null,
    source_session_id: payload?.source?.session_id ?? null
  };
  index.assets.unshift(asset);
  writeInputAssetIndex(root, index);
  return { asset };
}

function createImageInputAssetFromBuffer(
  root: string,
  buffer: Buffer,
  title: string,
  source?: { pane_id?: string | null; session_id?: string | null }
): { asset: InputAssetRow } {
  if (buffer.length > INPUT_ASSET_MAX_IMAGE_BYTES) {
    throw new Error("image is too large");
  }
  const index = readInputAssetIndex(root);
  const id = randomUUID();
  const now = new Date().toISOString();
  const relativePath = `${inputAssetsBaseRelative()}/images/${id}.png`;
  const fullPath = resolveInputAssetPath(root, relativePath);
  fs.writeFileSync(fullPath, buffer);
  const asset: InputAssetRow = {
    id,
    type: "image",
    title: String(title || inputAssetTitleFromImage()).trim().slice(0, 120) || inputAssetTitleFromImage(),
    relative_path: relativePath,
    preview: relativePath,
    size: buffer.length,
    created_at: now,
    updated_at: now,
    source_pane_id: source?.pane_id ?? null,
    source_session_id: source?.session_id ?? null
  };
  index.assets.unshift(asset);
  writeInputAssetIndex(root, index);
  return { asset };
}

function importInputAssetFile(workspacePath: string, payload: { filePath?: string; kind?: string }): { asset: InputAssetRow } {
  const root = validateWorkspacePath(workspacePath);
  ensureInputAssetStore(root);
  const sourcePath = path.resolve(String(payload?.filePath ?? ""));
  if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error("image file is required");
  }
  const ext = path.extname(sourcePath).toLowerCase();
  if (!INPUT_ASSET_IMAGE_EXTS.has(ext)) {
    throw new Error("only png, jpg, jpeg, webp, and gif images are supported");
  }
  const stat = fs.statSync(sourcePath);
  if (stat.size > INPUT_ASSET_MAX_IMAGE_BYTES) {
    throw new Error("image is too large");
  }
  const index = readInputAssetIndex(root);
  const id = randomUUID();
  const now = new Date().toISOString();
  const relativePath = `${inputAssetsBaseRelative()}/images/${id}${ext}`;
  const fullPath = resolveInputAssetPath(root, relativePath);
  fs.copyFileSync(sourcePath, fullPath);
  const asset: InputAssetRow = {
    id,
    type: "image",
    title: path.basename(sourcePath).slice(0, 120),
    relative_path: relativePath,
    preview: relativePath,
    size: stat.size,
    created_at: now,
    updated_at: now,
    source_pane_id: null,
    source_session_id: null
  };
  index.assets.unshift(asset);
  writeInputAssetIndex(root, index);
  return { asset };
}

function createImageInputAsset(
  workspacePath: string,
  payload: { title?: string; dataUrl?: string; source?: { pane_id?: string | null; session_id?: string | null } }
): { asset: InputAssetRow } {
  const root = validateWorkspacePath(workspacePath);
  ensureInputAssetStore(root);
  const dataUrl = String(payload?.dataUrl ?? "");
  if (!dataUrl.startsWith("data:image/")) {
    throw new Error("image data is required");
  }
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) {
    throw new Error("image data is invalid");
  }
  return createImageInputAssetFromBuffer(root, image.toPNG(), payload?.title ?? inputAssetTitleFromImage(), payload?.source);
}

function readClipboardImage(): { hasImage: false } | { hasImage: true; dataUrl: string; width: number; height: number; size: number; tooLarge: boolean } {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return { hasImage: false };
  }
  const size = image.getSize();
  const buffer = image.toPNG();
  return {
    hasImage: true,
    dataUrl: buffer.length <= INPUT_ASSET_MAX_IMAGE_BYTES ? `data:image/png;base64,${buffer.toString("base64")}` : "",
    width: size.width,
    height: size.height,
    size: buffer.length,
    tooLarge: buffer.length > INPUT_ASSET_MAX_IMAGE_BYTES
  };
}

function mimeForImagePath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function readInputAsset(workspacePath: string, assetId: string): { asset: InputAssetRow; content?: string; data_url?: string } {
  const root = validateWorkspacePath(workspacePath);
  ensureInputAssetStore(root);
  const { asset, fullPath } = inputAssetById(root, assetId);
  if (!fs.existsSync(fullPath)) {
    throw new Error("input asset file is missing");
  }
  if (asset.type === "image") {
    const data = fs.readFileSync(fullPath);
    return { asset, data_url: `data:${mimeForImagePath(fullPath)};base64,${data.toString("base64")}` };
  }
  return { asset, content: fs.readFileSync(fullPath, "utf8") };
}

function renameInputAsset(workspacePath: string, assetId: string, title: string): { ok: true } {
  const root = validateWorkspacePath(workspacePath);
  ensureInputAssetStore(root);
  const index = readInputAssetIndex(root);
  const asset = index.assets.find((row) => row.id === assetId);
  if (!asset) throw new Error(`input asset not found: ${assetId}`);
  asset.title = String(title ?? "").trim().slice(0, 120) || asset.title;
  asset.updated_at = new Date().toISOString();
  writeInputAssetIndex(root, index);
  return { ok: true };
}

function deleteInputAsset(workspacePath: string, assetId: string): { ok: true } {
  const root = validateWorkspacePath(workspacePath);
  ensureInputAssetStore(root);
  const index = readInputAssetIndex(root);
  const asset = index.assets.find((row) => row.id === assetId);
  if (!asset) return { ok: true };
  const fullPath = resolveInputAssetPath(root, asset.relative_path);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
  index.assets = index.assets.filter((row) => row.id !== assetId);
  writeInputAssetIndex(root, index);
  return { ok: true };
}

function revealInputAsset(workspacePath: string, assetId: string): { ok: true } {
  const root = validateWorkspacePath(workspacePath);
  ensureInputAssetStore(root);
  const { fullPath } = inputAssetById(root, assetId);
  if (fs.existsSync(fullPath)) {
    shell.showItemInFolder(fullPath);
  } else {
    shell.showItemInFolder(path.dirname(fullPath));
  }
  return { ok: true };
}

async function pickInputAssetFile(workspacePath: string): Promise<{ asset: InputAssetRow } | null> {
  validateWorkspacePath(workspacePath);
  const win = BrowserWindow.getFocusedWindow();
  const options: OpenDialogOptions = {
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }]
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return importInputAssetFile(workspacePath, { filePath: result.filePaths[0], kind: "image" });
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
  ipcMain.handle("wincmux:clipboard-read-image", () => readClipboardImage());
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
  ipcMain.handle("wincmux:scan-long-files", async (_event, payload: { path: string; minLines: number }) =>
    toIpcEnvelope(() => Promise.resolve(scanLongFiles(payload?.path, payload?.minLines ?? 1000)))
  );
  ipcMain.handle("wincmux:agent-assets-scan", async (_event, payload: { path: string }) =>
    toIpcEnvelope(() => Promise.resolve(scanAgentAssets(payload?.path)))
  );
  ipcMain.handle("wincmux:agent-asset-read", async (_event, payload: { path: string; relativePath: string }) =>
    toIpcEnvelope(() => Promise.resolve(readAgentAsset(payload?.path, payload?.relativePath)))
  );
  ipcMain.handle("wincmux:agent-asset-write", async (_event, payload: { path: string; relativePath: string; content: string }) =>
    toIpcEnvelope(() => Promise.resolve(writeAgentAsset(payload?.path, payload?.relativePath, payload?.content)))
  );
  ipcMain.handle("wincmux:agent-asset-create", async (_event, payload: { path: string; relativePath: string; templateKind?: string }) =>
    toIpcEnvelope(() => Promise.resolve(createAgentAsset(payload?.path, payload?.relativePath, payload?.templateKind)))
  );
  ipcMain.handle("wincmux:agent-asset-reveal", async (_event, payload: { path: string; relativePath: string }) =>
    toIpcEnvelope(async () => {
      const { fullPath } = resolveWorkspaceAssetPath(payload?.path, payload?.relativePath);
      if (fs.existsSync(fullPath)) {
        shell.showItemInFolder(fullPath);
      } else {
        const err = await shell.openPath(path.dirname(fullPath));
        if (err) throw new Error(err);
      }
      return { ok: true };
    })
  );
  ipcMain.handle("wincmux:input-assets-list", async (_event, payload: { path: string }) =>
    toIpcEnvelope(() => Promise.resolve(listInputAssets(payload?.path)))
  );
  ipcMain.handle("wincmux:input-asset-create-text", async (_event, payload: { path: string; title?: string; content: string; source?: { pane_id?: string | null; session_id?: string | null } }) =>
    toIpcEnvelope(() => Promise.resolve(createTextInputAsset(payload?.path, payload)))
  );
  ipcMain.handle("wincmux:input-asset-create-image", async (_event, payload: { path: string; title?: string; dataUrl: string; source?: { pane_id?: string | null; session_id?: string | null } }) =>
    toIpcEnvelope(() => Promise.resolve(createImageInputAsset(payload?.path, payload)))
  );
  ipcMain.handle("wincmux:input-asset-import-file", async (_event, payload: { path: string; filePath: string; kind?: string }) =>
    toIpcEnvelope(() => Promise.resolve(importInputAssetFile(payload?.path, payload)))
  );
  ipcMain.handle("wincmux:input-asset-pick-file", async (_event, payload: { path: string }) =>
    toIpcEnvelope(() => pickInputAssetFile(payload?.path))
  );
  ipcMain.handle("wincmux:input-asset-read", async (_event, payload: { path: string; assetId: string }) =>
    toIpcEnvelope(() => Promise.resolve(readInputAsset(payload?.path, payload?.assetId)))
  );
  ipcMain.handle("wincmux:input-asset-rename", async (_event, payload: { path: string; assetId: string; title: string }) =>
    toIpcEnvelope(() => Promise.resolve(renameInputAsset(payload?.path, payload?.assetId, payload?.title)))
  );
  ipcMain.handle("wincmux:input-asset-delete", async (_event, payload: { path: string; assetId: string }) =>
    toIpcEnvelope(() => Promise.resolve(deleteInputAsset(payload?.path, payload?.assetId)))
  );
  ipcMain.handle("wincmux:input-asset-reveal", async (_event, payload: { path: string; assetId: string }) =>
    toIpcEnvelope(() => Promise.resolve(revealInputAsset(payload?.path, payload?.assetId)))
  );
  ipcMain.handle("wincmux:open-in-explorer", async (_event, payload: { path: string }) =>
    toIpcEnvelope(async () => {
      const normalized = validateWorkspacePath(payload?.path);
      const err = await shell.openPath(normalized);
      if (err) throw new Error(err);
      return { ok: true };
    })
  );
  ipcMain.handle("wincmux:git-info", async (_event, payload: { path: string }) =>
    toIpcEnvelope(async () => {
      const normalized = validateWorkspacePath(payload?.path);
      const runRaw = (args: string[]) => {
        try {
          return spawnSync("git", args, { cwd: normalized, encoding: "utf8", windowsHide: true, timeout: 4000 });
        } catch (e) {
          return { status: -1, stdout: "", stderr: String(e) };
        }
      };
      const branchOut = runRaw(["rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = branchOut.status === 0 ? (branchOut.stdout as string).trim() : null;
      const statusOut = runRaw(["status", "--short"]);
      const status = statusOut.status === 0 ? (statusOut.stdout as string).trim() : null;
      const logOut = runRaw(["log", "--oneline", "-8"]);
      const log = logOut.status === 0 ? (logOut.stdout as string).trim() : null;
      const debugError = branch === null ? ((branchOut.stderr as string) || `exit ${branchOut.status}`) : null;
      return {
        branch,
        dirty_files: status ? status.split("\n").filter(Boolean) : [],
        recent_commits: log ? log.split("\n").filter(Boolean) : [],
        debug_error: debugError
      };
    })
  );
  ipcMain.handle("wincmux:set-unread-badge", async (_event, payload: { count?: number }) => {
    applyUnreadBadge(payload?.count ?? 0);
    return { ok: true };
  });
  ipcMain.handle("wincmux:dismiss-notifications", async (_event, payload: { ids?: string[]; all?: boolean }) => {
    if (payload?.all) {
      dismissNotificationToasts();
      applyUnreadBadge(0);
    } else {
      const ids = payload?.ids?.filter((id) => typeof id === "string") ?? [];
      if (ids.length > 0) {
        dismissNotificationToasts(ids);
      }
      void refreshUnreadBadgeFromCore().catch(() => {});
    }
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
    app.setAppUserModelId(APP_USER_MODEL_ID);
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

    // Send a one-time probe notification to register the app with Windows
    // notification system so future toasts appear as banners.
    // Only shown once — tracked via a marker file in app data.
    const notifProbeMarker = path.join(
      app.getPath("userData"), "notif-probe-shown"
    );
    if (ElectronNotification.isSupported() && !fs.existsSync(notifProbeMarker)) {
      try { fs.writeFileSync(notifProbeMarker, "1"); } catch { /* */ }
      const probe = new ElectronNotification({
        title: "WinCMux",
        body: "Notifications are enabled. You'll be alerted when AI sessions complete.",
        silent: false,
        timeoutType: "default"
      });
      probe.show();
    }
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

app.on("browser-window-focus", () => {
  activeContext.app_focused = true;
});
app.on("browser-window-blur", () => {
  activeContext.app_focused = false;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  appIsQuitting = true;
  for (const timer of badgeReapplyTimers) {
    clearTimeout(timer);
  }
  badgeReapplyTimers = [];
  dismissNotificationToasts();
  for (const subscriptionId of [...streamConnections.keys()]) {
    void closeStream(subscriptionId);
  }
  void stopNotifyStream();
  rpcClient.destroy();
  if (coreProc && !coreProc.killed) {
    coreProc.kill();
  }
  coreProc = null;
});
