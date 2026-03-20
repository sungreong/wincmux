import { contextBridge, ipcRenderer } from "electron";

type RpcParams = { method: string; params?: unknown };
type StreamFilter = { workspace_id?: string; session_id?: string; topics?: Array<"session" | "notify"> };
type StreamEventPayload = { method: string; params: unknown };
type ContextActionPayload = { action: "copy" | "paste" | "clear-selection" };
type ActiveContextPayload = {
  workspace_id?: string | null;
  pane_id?: string | null;
  session_id?: string | null;
  app_focused?: boolean;
};
type NotificationOpenPayload = { notification_id: string };
type CoreStatusPayload = { status: string; error?: string };
type IpcEnvelope<T> = { ok: true; result: T } | { ok: false; error: string };

function unwrapEnvelope<T>(value: IpcEnvelope<T>): T {
  if (!value.ok) {
    throw new Error(value.error || "ipc request failed");
  }
  return value.result;
}

contextBridge.exposeInMainWorld("wincmux", {
  rpc: async (payload: RpcParams) => unwrapEnvelope(await ipcRenderer.invoke("wincmux:rpc", payload)),
  streamSubscribe: async (payload: StreamFilter) => unwrapEnvelope(await ipcRenderer.invoke("wincmux:stream-subscribe", payload)),
  streamUnsubscribe: (subscriptionId: string) => ipcRenderer.invoke("wincmux:stream-unsubscribe", { subscription_id: subscriptionId }),
  onStreamEvent: (handler: (payload: StreamEventPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: StreamEventPayload) => handler(payload);
    ipcRenderer.on("wincmux:stream-event", listener);
    return () => ipcRenderer.removeListener("wincmux:stream-event", listener);
  },
  onContextAction: (handler: (payload: ContextActionPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ContextActionPayload) => handler(payload);
    ipcRenderer.on("wincmux:context-action", listener);
    return () => ipcRenderer.removeListener("wincmux:context-action", listener);
  },
  clipboardRead: () => ipcRenderer.invoke("wincmux:clipboard-read"),
  clipboardWrite: (text: string) => ipcRenderer.invoke("wincmux:clipboard-write", { text }),
  perfLog: (payload: unknown) => ipcRenderer.invoke("wincmux:perf-log", payload),
  showContextMenu: (hasSelection: boolean) => ipcRenderer.invoke("wincmux:show-context-menu", { has_selection: hasSelection }),
  pickFolder: () => ipcRenderer.invoke("wincmux:pick-folder"),
  setUnreadBadge: (count: number) => ipcRenderer.invoke("wincmux:set-unread-badge", { count }),
  updateActiveContext: (payload: ActiveContextPayload) => ipcRenderer.invoke("wincmux:update-active-context", payload),
  onNotificationOpen: (handler: (payload: NotificationOpenPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: NotificationOpenPayload) => handler(payload);
    ipcRenderer.on("wincmux:notification-open", listener);
    return () => ipcRenderer.removeListener("wincmux:notification-open", listener);
  },
  openInVscode: async (workspacePath: string) =>
    unwrapEnvelope(await ipcRenderer.invoke("wincmux:open-in-vscode", { path: workspacePath })),
  onCoreStatus: (handler: (payload: CoreStatusPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CoreStatusPayload) => handler(payload);
    ipcRenderer.on("wincmux:core-status", listener);
    return () => ipcRenderer.removeListener("wincmux:core-status", listener);
  }
});
