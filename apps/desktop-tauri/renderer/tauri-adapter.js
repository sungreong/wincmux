(() => {
  const { core: { invoke, Channel }, event: { listen } } = window.__TAURI__;
  const streamHandlers = new Set();
  const subscriptions = new Map();
  const native = (action, params = {}) => invoke("desktop_action", { action, params });
  const withPath = (action) => (path, payload = {}) => native(action, { path, ...payload });
  const withRelativePath = (action) => (path, relativePath, content) =>
    native(action, { path, relativePath, content });
  const withAsset = (action) => (path, assetId, title) =>
    native(action, { path, assetId, title });
  const dispatch = (event) => {
    for (const handler of streamHandlers) handler(event);
  };
  function subscribeEvent(name, handler) {
    let active = true;
    const pending = listen(name, (event) => {
      if (active) handler(event.payload);
    });
    return () => {
      active = false;
      void pending.then((unlisten) => unlisten()).catch(console.error);
    };
  }
  subscribeEvent("wincmux-notify", dispatch);

  window.wincmux = {
    rpc: ({ method, params = {} }) => invoke("rpc", { method, params }),
    async streamSubscribe(filter) {
      const stream = new Channel();
      stream.onmessage = (events) => {
        for (const event of events) globalThis.wincmuxTauriStreamEvent(event, dispatch);
      };
      const result = await invoke("subscribe", { filter, stream });
      subscriptions.set(result.subscription_id, stream);
      return result.subscription_id;
    },
    async streamUnsubscribe(subscriptionId) {
      await invoke("unsubscribe", { subscriptionId });
      subscriptions.delete(subscriptionId);
    },
    onStreamEvent(handler) {
      streamHandlers.add(handler);
      return () => streamHandlers.delete(handler);
    },
    onContextAction: (handler) => subscribeEvent("wincmux-context-action", handler),
    onNotificationOpen: (handler) => subscribeEvent("wincmux-notification-open", handler),
    onCoreStatus: (handler) => subscribeEvent("wincmux-core-status", handler),
    clipboardRead: () => native("clipboard-read"),
    clipboardWrite: (text) => native("clipboard-write", { text }),
    clipboardReadImage: () => native("clipboard-read-image"),
    perfLog: (payload) => native("perf-log", { payload }),
    showContextMenu: (has_selection) => native("show-context-menu", { has_selection }),
    pickFolder: () => native("pick-folder"),
    setUnreadBadge: (count) => native("set-unread-badge", { count }),
    dismissNotifications: (payload) => native("dismiss-notifications", payload),
    updateActiveContext: (payload) => native("update-active-context", payload),
    openInVscode: withPath("open-in-vscode"),
    scanLongFiles: (path, minLines) => native("scan-long-files", { path, minLines }),
    agentAssetsScan: withPath("agent-assets-scan"),
    agentAssetRead: withRelativePath("agent-asset-read"),
    agentAssetWrite: withRelativePath("agent-asset-write"),
    agentAssetCreate: (path, relativePath, templateKind) =>
      native("agent-asset-create", { path, relativePath, templateKind }),
    agentAssetReveal: withRelativePath("agent-asset-reveal"),
    inputAssetsList: withPath("input-assets-list"),
    inputAssetCreateText: withPath("input-asset-create-text"),
    inputAssetCreateImage: withPath("input-asset-create-image"),
    inputAssetImportFile: withPath("input-asset-import-file"),
    inputAssetPickFile: withPath("input-asset-pick-file"),
    inputAssetRead: withAsset("input-asset-read"),
    inputAssetRename: withAsset("input-asset-rename"),
    inputAssetDelete: withAsset("input-asset-delete"),
    inputAssetReveal: withAsset("input-asset-reveal"),
    openInExplorer: withPath("open-in-explorer"),
    gitInfo: withPath("git-info")
  };
})();
