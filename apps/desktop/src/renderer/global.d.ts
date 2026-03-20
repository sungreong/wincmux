export {};

declare global {
  interface Window {
    Terminal?: any;
    FitAddon?: { FitAddon: new () => any };
    Unicode11Addon?: { Unicode11Addon: new () => any };
    wincmux: {
      rpc: (payload: { method: string; params?: unknown }) => Promise<any>;
      streamSubscribe: (payload: { workspace_id?: string; session_id?: string }) => Promise<string>;
      streamUnsubscribe: (subscriptionId: string) => Promise<{ ok: true }>;
      onStreamEvent: (handler: (payload: { method: string; params: any }) => void) => () => void;
      onContextAction: (handler: (payload: { action: "copy" | "paste" | "clear-selection" }) => void) => () => void;
      clipboardRead: () => Promise<string>;
      clipboardWrite: (text: string) => Promise<{ ok: true }>;
      perfLog?: (payload: unknown) => Promise<{ ok: true }>;
      showContextMenu: (hasSelection: boolean) => Promise<{ ok: true }>;
      pickFolder: () => Promise<string | null>;
      setUnreadBadge: (count: number) => Promise<{ ok: true }>;
      openInVscode: (workspacePath: string) => Promise<{ ok: true; method: "code-cli" | "vscode-protocol" }>;
    };
  }
}
