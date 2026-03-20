import { contextBridge, ipcRenderer } from "electron";

type RpcParams = { method: string; params?: unknown };
type StreamFilter = { workspace_id?: string; session_id?: string };
type StreamEventPayload = { method: string; params: unknown };
type ContextActionPayload = { action: "copy" | "paste" | "clear-selection" };
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
  openInVscode: async (workspacePath: string) =>
    unwrapEnvelope(await ipcRenderer.invoke("wincmux:open-in-vscode", { path: workspacePath }))
});
