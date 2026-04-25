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
      clipboardReadImage: () => Promise<{ hasImage: false } | { hasImage: true; dataUrl: string; width: number; height: number; size: number; tooLarge: boolean }>;
      perfLog?: (payload: unknown) => Promise<{ ok: true }>;
      showContextMenu: (hasSelection: boolean) => Promise<{ ok: true }>;
      pickFolder: () => Promise<string | null>;
      setUnreadBadge: (count: number) => Promise<{ ok: true }>;
      openInVscode: (workspacePath: string) => Promise<{ ok: true; method: "code-cli" | "vscode-protocol" }>;
      openInExplorer: (workspacePath: string) => Promise<{ ok: true }>;
      scanLongFiles: (workspacePath: string, minLines: number) => Promise<{ files: Array<{ relativePath: string; lineCount: number }> }>;
      gitInfo: (workspacePath: string) => Promise<any>;
      agentAssetsScan: (workspacePath: string) => Promise<any>;
      agentAssetRead: (workspacePath: string, relativePath: string) => Promise<any>;
      agentAssetWrite: (workspacePath: string, relativePath: string, content: string) => Promise<any>;
      agentAssetCreate: (workspacePath: string, relativePath: string, templateKind: string) => Promise<any>;
      agentAssetReveal: (workspacePath: string, relativePath: string) => Promise<{ ok: true }>;
      inputAssetsList: (workspacePath: string) => Promise<any>;
      inputAssetCreateText: (workspacePath: string, payload: { title?: string; content: string; source?: unknown }) => Promise<any>;
      inputAssetCreateImage: (workspacePath: string, payload: { title?: string; dataUrl: string; source?: unknown }) => Promise<any>;
      inputAssetImportFile: (workspacePath: string, payload: { filePath: string; kind?: string }) => Promise<any>;
      inputAssetPickFile: (workspacePath: string) => Promise<any>;
      inputAssetRead: (workspacePath: string, assetId: string) => Promise<any>;
      inputAssetRename: (workspacePath: string, assetId: string, title: string) => Promise<any>;
      inputAssetDelete: (workspacePath: string, assetId: string) => Promise<any>;
      inputAssetReveal: (workspacePath: string, assetId: string) => Promise<{ ok: true }>;
    };
  }
}
