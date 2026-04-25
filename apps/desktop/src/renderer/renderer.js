const hiddenSetPaneHandlers =
  typeof globalThis.setHiddenPaneHandlers === "function"
    ? globalThis.setHiddenPaneHandlers.bind(globalThis)
    : () => {};
const hiddenBindPaneUi =
  typeof globalThis.bindHiddenPaneUi === "function"
    ? globalThis.bindHiddenPaneUi.bind(globalThis)
    : () => {};
const hiddenRefreshPanesUi =
  typeof globalThis.refreshHiddenPanesUi === "function"
    ? globalThis.refreshHiddenPanesUi.bind(globalThis)
    : () => {};
const hiddenPrunePanesForWorkspace =
  typeof globalThis.pruneHiddenPanesForWorkspace === "function"
    ? globalThis.pruneHiddenPanesForWorkspace.bind(globalThis)
    : () => [];
const hiddenClearPanesForWorkspace =
  typeof globalThis.clearHiddenPanesForWorkspace === "function"
    ? globalThis.clearHiddenPanesForWorkspace.bind(globalThis)
    : () => {};
const hiddenPushPaneItem =
  typeof globalThis.pushHiddenPaneItem === "function"
    ? globalThis.pushHiddenPaneItem.bind(globalThis)
    : () => {};
const hiddenFindPaneById =
  typeof globalThis.findHiddenPaneById === "function"
    ? globalThis.findHiddenPaneById.bind(globalThis)
    : () => null;
const hiddenRemovePaneById =
  typeof globalThis.removeHiddenPaneById === "function"
    ? globalThis.removeHiddenPaneById.bind(globalThis)
    : () => null;
const hiddenListPanesForWorkspace =
  typeof globalThis.hiddenPanesForWorkspace === "function"
    ? globalThis.hiddenPanesForWorkspace.bind(globalThis)
    : () => [];

const paneApi = {
  paneForSession: (...args) =>
    typeof globalThis.paneForSession === "function"
      ? globalThis.paneForSession(...args)
      : null,
  enqueueStreamOutput: (...args) => {
    if (typeof globalThis.enqueueStreamOutput === "function") {
      globalThis.enqueueStreamOutput(...args);
      return true;
    }
    return false;
  },
  normalizePaneSessions: () => {
    if (typeof globalThis.normalizePaneSessions === "function") {
      globalThis.normalizePaneSessions();
      return true;
    }
    return false;
  },
  refreshPaneBindings: () => {
    if (typeof globalThis.refreshPaneBindings === "function") {
      globalThis.refreshPaneBindings();
      return true;
    }
    return false;
  },
  renderPaneSurface: (force = false) => {
    if (typeof globalThis.renderPaneSurface === "function") {
      globalThis.renderPaneSurface(force);
      return true;
    }
    return false;
  },
  setPaneHandlers: (handlers) => {
    if (typeof globalThis.setPaneHandlers === "function") {
      globalThis.setPaneHandlers(handlers);
      return true;
    }
    return false;
  },
  selectPane: async (...args) => {
    if (typeof globalThis.selectPane !== "function") {
      return;
    }
    await globalThis.selectPane(...args);
  },
  selectAdjacentPane: async (...args) => {
    if (typeof globalThis.selectAdjacentPane !== "function") {
      return null;
    }
    return globalThis.selectAdjacentPane(...args);
  },
  selectPaneByDirection: async (...args) => {
    if (typeof globalThis.selectPaneByDirection !== "function") {
      return null;
    }
    return globalThis.selectPaneByDirection(...args);
  },
  fitAllPanes: () => {
    if (typeof globalThis.fitAllPanes === "function") {
      globalThis.fitAllPanes();
    }
  },
  equalizePaneSizes: () => {
    if (typeof globalThis.equalizePaneSizes === "function") {
      globalThis.equalizePaneSizes();
    }
  },
  setGlobalFontScale: (scale, opts) => {
    if (typeof globalThis.setGlobalFontScale === "function") {
      globalThis.setGlobalFontScale(scale, opts);
    }
  },
  writeToPane: (...args) => {
    if (typeof globalThis.writeToPane === "function") {
      globalThis.writeToPane(...args);
      return true;
    }
    return false;
  },
  togglePaneOverflowMenu: (...args) => {
    if (typeof globalThis.togglePaneOverflowMenu === "function") {
      return globalThis.togglePaneOverflowMenu(...args);
    }
    return false;
  },
  markPaneStarting: (...args) => {
    if (typeof globalThis.markPaneStarting === "function") {
      globalThis.markPaneStarting(...args);
      return true;
    }
    return false;
  },
  focusPaneTerm: (paneId) => {
    if (typeof globalThis.focusPaneTerm === "function") {
      globalThis.focusPaneTerm(paneId);
      return true;
    }
    state.paneViews.get(paneId)?.term?.focus?.();
    return false;
  }
};

const workspaceTransition = {
  transitionSeq: 0,
  activeTransitionSeq: 0,
  activeWorkspaceId: null,
  switchInFlight: false
};
const RENDERER_DEBUG_LOGS = localStorage.getItem("wincmux.debug.renderer") === "1";
const activeWorkspacePing = {
  workspaceId: null,
  sentAt: 0
};

function dormantPaneSession(paneId) {
  return paneId ? (state.dormantPaneSessions[paneId] ?? null) : null;
}

function clearDormantPaneSession(paneId) {
  if (!paneId) {
    return;
  }
  delete state.dormantPaneSessions[paneId];
}

function clearDormantPaneSessionsForWorkspace(workspaceId) {
  if (!workspaceId) {
    return;
  }
  const leafIds = new Set(leafPanes().map((pane) => pane.pane_id));
  for (const [paneId, row] of Object.entries(state.dormantPaneSessions)) {
    if (row?.workspace_id === workspaceId || leafIds.has(paneId)) {
      delete state.dormantPaneSessions[paneId];
    }
  }
}

function isTransitionStale(transitionSeq, workspaceId) {
  if (!transitionSeq) {
    return false;
  }
  if (transitionSeq !== workspaceTransition.activeTransitionSeq) {
    return true;
  }
  if (workspaceId && workspaceTransition.activeWorkspaceId !== workspaceId) {
    return true;
  }
  if (workspaceId && state.selectedWorkspaceId !== workspaceId) {
    return true;
  }
  return false;
}

function showShortcutHelp() {
  if (!shortcutOverlay) {
    return;
  }
  shortcutOverlay.hidden = false;
  shortcutCloseBtn?.focus();
}

function hideShortcutHelp() {
  if (!shortcutOverlay) {
    return;
  }
  shortcutOverlay.hidden = true;
  paneApi.focusPaneTerm(state.selectedPaneId);
}

function toggleShortcutHelp() {
  if (!shortcutOverlay) {
    return;
  }
  if (shortcutOverlay.hidden) {
    showShortcutHelp();
  } else {
    hideShortcutHelp();
  }
}
globalThis.toggleShortcutHelp = toggleShortcutHelp;

function selectedPaneForShortcut() {
  const paneId = state.selectedPaneId ?? leafPanes()[0]?.pane_id ?? null;
  if (!paneId) {
    setStatus("No pane selected.", true);
    return null;
  }
  return paneId;
}

function runPaneShortcut(action) {
  const paneId = selectedPaneForShortcut();
  if (!paneId) {
    return;
  }
  action(paneId).catch((err) => setStatus(String(err?.message ?? err), true));
}

function workspaceRowById(workspaceId) {
  if (!workspaceId) {
    return null;
  }
  return state.workspaces.find((row) => row.id === workspaceId) ?? null;
}

function runningSessionsForWorkspace(workspaceId) {
  return state.sessions.filter((session) => session.workspace_id === workspaceId && session.status === "running");
}

function missingRendererContracts() {
  const checks = [
    ["hidden", "setHiddenPaneHandlers", typeof globalThis.setHiddenPaneHandlers === "function"],
    ["hidden", "bindHiddenPaneUi", typeof globalThis.bindHiddenPaneUi === "function"],
    ["panes", "setPaneHandlers", typeof globalThis.setPaneHandlers === "function"],
    ["panes", "renderPaneSurface", typeof globalThis.renderPaneSurface === "function"],
    ["quickcmd", "bindQuickCommandPanel", typeof globalThis.bindQuickCommandPanel === "function"],
    ["layout", "makeSplitResizable", typeof globalThis.makeSplitResizable === "function"]
  ];
  return checks.filter(([, , ok]) => !ok).map(([module, key]) => `${module}.${key}`);
}

function assertRendererContracts() {
  const missing = missingRendererContracts();
  if (missing.length === 0) {
    return;
  }
  const preview = missing.slice(0, 3).join(", ");
  const suffix = missing.length > 3 ? ` +${missing.length - 3}` : "";
  const msg = `Renderer module degraded: ${preview}${suffix}`;
  setStatus(msg, true, { priority: 80, holdMs: 12000 });
  console.warn("[renderer] Missing module contracts:", missing);
}

function bindRuntimeErrorHooks() {
  window.addEventListener("error", (event) => {
    const message = event?.error?.message ?? event?.message ?? "unknown";
    setStatus(`Runtime error: ${message}`, true, { priority: 95, holdMs: 15000 });
    console.error("[renderer] window.error", event?.error ?? event);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event?.reason;
    const message = reason?.message ?? String(reason ?? "unknown");
    setStatus(`Promise error: ${message}`, true, { priority: 95, holdMs: 15000 });
    console.error("[renderer] unhandledrejection", reason);
  });
}
async function unsubscribeStream() {
  if (!state.streamSubscriptionId) {
    return;
  }
  const subscriptionId = state.streamSubscriptionId;
  state.streamSubscriptionId = null;
  await window.wincmux.streamUnsubscribe(subscriptionId).catch(() => {});
}
async function subscribeWorkspaceStream(workspaceId) {
  if (!state.useStream || !workspaceId) {
    return;
  }
  if (state.streamSubscriptionId) {
    await unsubscribeStream();
  }
  state.streamSubscriptionId = await window.wincmux.streamSubscribe({
    workspace_id: workspaceId,
    topics: ["session"],
  });
}
function scheduleSessionRefresh() {
  if (state.streamRefreshTimer) {
    clearTimeout(state.streamRefreshTimer);
  }
  state.streamRefreshTimer = setTimeout(async () => {
    state.streamRefreshTimer = null;
    await loadSessions();
    cleanupHiddenSessionsForWorkspace(state.selectedWorkspaceId, true);
    paneApi.normalizePaneSessions();
    paneApi.refreshPaneBindings();
    hiddenRefreshPanesUi();
  }, 80);
}
function handleStreamEvent(event) {
  if (!event?.method) {
    return;
  }
  const params = event.params ?? {};
  if (RENDERER_DEBUG_LOGS && event.method !== "session.output") {
    console.debug("[stream]", event.method, JSON.stringify(params).slice(0, 120));
  }
  if (event.method === "notify.created") {
    const row = params.notification;
    if (!row?.id) {
      return;
    }
    if (!state.notifications.some((item) => item.id === row.id)) {
      state.notifications = [row, ...state.notifications];
      renderNotifications();
      renderWorkspaces();
      paneApi.refreshPaneBindings();
      void updateUnreadBadge(state.notifications.length);
    }
    return;
  }
  if (event.method === "session.output") {
    if (isRendererPromptFallbackEnabled()) {
      void maybeNotifyPromptFromOutput(
        params.session_id,
        params.output ?? "",
        params.workspace_id ?? null,
      );
    }
    const paneId = paneApi.paneForSession(params.session_id);
    if (paneId) {
      paneApi.enqueueStreamOutput(paneId, params.output ?? "");
    }
    return;
  }
  if (
    event.method === "session.exit" ||
    event.method === "session.state_changed"
  ) {
    if (params?.session_id) {
      const status = typeof params.status === "string" ? params.status : "";
      if (event.method === "session.exit" || (status && status !== "running")) {
        clearPromptDetectorSession(params.session_id);
      }
    }
    scheduleSessionRefresh();
  }
}
function handleContextAction(event) {
  const paneId = state.selectedPaneId;
  if (!paneId) {
    return;
  }
  if (event.action === "copy") {
    const view = state.paneViews.get(paneId);
    const text = view?.term.getSelection?.() ?? "";
    if (text) {
      void window.wincmux.clipboardWrite(text);
    }
    return;
  }
  if (event.action === "paste") {
    void handlePaneClipboardPaste(paneId).catch((err) => setStatus(String(err?.message ?? err), true));
    return;
  }
  if (event.action === "clear-selection") {
    state.paneViews.get(paneId)?.term.clearSelection?.();
  }
}

function activeSessionId() {
  if (!state.selectedPaneId) {
    return null;
  }
  return state.paneSessions[state.selectedPaneId] ?? null;
}

async function syncActiveContext() {
  if (typeof window.wincmux?.updateActiveContext !== "function") {
    return;
  }
  await window.wincmux.updateActiveContext({
    workspace_id: state.selectedWorkspaceId ?? null,
    pane_id: state.selectedPaneId ?? null,
    session_id: activeSessionId(),
    app_focused: document.hasFocus()
  }).catch(() => {});
  const now = Date.now();
  if (
    state.selectedWorkspaceId &&
    (activeWorkspacePing.workspaceId !== state.selectedWorkspaceId || now - activeWorkspacePing.sentAt > 2500)
  ) {
    activeWorkspacePing.workspaceId = state.selectedWorkspaceId;
    activeWorkspacePing.sentAt = now;
    rpc("workspace.activate", { workspace_id: state.selectedWorkspaceId }).catch(() => {});
  }
}

async function dismissNativeNotifications(payload) {
  if (typeof window.wincmux?.dismissNotifications !== "function") {
    return;
  }
  await window.wincmux.dismissNotifications(payload).catch(() => {});
}

async function openNotificationById(notificationId, notificationHint = null) {
  if (!notificationId) {
    return;
  }
  const row = state.notifications.find((item) => item.id === notificationId);
  if (!row) {
    await loadUnread();
  }
  const resolved = state.notifications.find((item) => item.id === notificationId) ?? notificationHint;
  if (!resolved) {
    return;
  }

  const target = normalizeNotificationTarget(resolved);
  const workspaceId = target.workspaceId ?? resolved.workspace_id ?? null;
  if (workspaceId && workspaceId !== state.selectedWorkspaceId) {
    if (!state.workspaces.some((ws) => ws.id === workspaceId)) {
      await loadWorkspaces();
    }
    if (state.workspaces.some((ws) => ws.id === workspaceId)) {
      await switchWorkspace(workspaceId);
    }
  }

  let targetPaneId = target.paneId;
  if ((!targetPaneId || !leafPanes().some((pane) => pane.pane_id === targetPaneId)) && target.sessionId) {
    targetPaneId = paneApi.paneForSession(target.sessionId);
  }
  if (targetPaneId && leafPanes().some((pane) => pane.pane_id === targetPaneId)) {
    await paneApi.selectPane(targetPaneId, { persist: true, focusTerm: true });
  } else if (workspaceId) {
    setStatus("Notification workspace opened; pane is no longer attached");
  }
  await rpc("notify.mark_read", { notification_id: notificationId });
  await dismissNativeNotifications({ ids: [notificationId] });
  await loadUnread();
}
async function loadWorkspaces() {
  const res = await rpc("workspace.list", {});
  state.workspaces = res.workspaces ?? [];
  const rememberedWorkspaceId = localStorage.getItem(STORAGE_KEYS.selectedWorkspaceId);
  if (
    rememberedWorkspaceId &&
    state.workspaces.some((w) => w.id === rememberedWorkspaceId)
  ) {
    state.selectedWorkspaceId = rememberedWorkspaceId;
  }
  if (
    !state.selectedWorkspaceId ||
    !state.workspaces.some((w) => w.id === state.selectedWorkspaceId)
  ) {
    state.selectedWorkspaceId = state.workspaces[0]?.id ?? null;
  }
  renderWorkspaces();
}
async function loadSessions(workspaceId = state.selectedWorkspaceId, transitionSeq = null) {
  if (!workspaceId) {
    state.sessions = [];
    cleanupPromptDetectorSessions([]);
    return;
  }
  const res = await rpc("session.list", { workspace_id: workspaceId });
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return;
  }
  if (workspaceId !== state.selectedWorkspaceId) {
    return;
  }
  state.sessions = res.sessions ?? [];
  cleanupPromptDetectorSessions(
    state.sessions.filter((s) => s.status === "running").map((s) => s.id),
  );
  renderGroupBar();
}

async function loadPaneGroups(workspaceId = state.selectedWorkspaceId, transitionSeq = null) {
  if (!workspaceId) {
    state.paneGroups = [];
    state.sessionGroupBindings = {};
    state.selectedGroupId = null;
    renderGroupBar();
    return;
  }
  const [groupRes, bindingRes] = await Promise.all([
    rpc("group.list", { workspace_id: workspaceId }),
    rpc("session.group.list", { workspace_id: workspaceId }).catch(() => ({ bindings: [] }))
  ]);
  if (isTransitionStale(transitionSeq, workspaceId) || workspaceId !== state.selectedWorkspaceId) {
    return;
  }
  state.paneGroups = groupRes.groups ?? [];
  state.sessionGroupBindings = {};
  for (const binding of bindingRes.bindings ?? []) {
    if (binding?.session_id && binding?.group_id) {
      state.sessionGroupBindings[binding.session_id] = binding.group_id;
    }
  }
  if (state.selectedGroupId && !state.paneGroups.some((group) => group.id === state.selectedGroupId)) {
    state.selectedGroupId = null;
    persistWorkspaceGroupState(workspaceId);
  }
  renderGroupBar();
}

function assistantLaunchGroupId(cmd, args) {
  const text = [cmd, ...(Array.isArray(args) ? args : [])].filter(Boolean).join(" ");
  if (/\b(?:claude|codex)\b/i.test(text)) {
    return aiPaneGroup()?.id ?? null;
  }
  return null;
}

function groupIdForNewPaneSession(paneId, cmd, args, explicitGroupId = null) {
  return explicitGroupId
    ?? assistantLaunchGroupId(cmd, args)
    ?? (paneId ? state.paneGroupHints[paneId] : null)
    ?? groupForPane(paneId)?.id
    ?? state.selectedGroupId
    ?? defaultPaneGroup()?.id
    ?? null;
}

async function setSessionGroup(workspaceId, sessionId, groupId) {
  if (!workspaceId || !sessionId || !groupId) {
    return;
  }
  await rpc("session.group.set", { workspace_id: workspaceId, session_id: sessionId, group_id: groupId });
  state.sessionGroupBindings[sessionId] = groupId;
  renderGroupBar();
}
function cleanupHiddenSessionsForWorkspace(workspaceId, showStatus = false) {
  if (!workspaceId) {
    return [];
  }
  const runningIds = new Set(runningSessions().map((session) => session.id));
  const removed = hiddenPrunePanesForWorkspace(workspaceId, runningIds);
  if (showStatus && removed.length > 0) {
    setStatus(`Hidden session ended: ${removed[0].session_id.slice(0, 8)}`);
  }
  return removed;
}
async function loadPanes(workspaceId = state.selectedWorkspaceId, transitionSeq = null) {
  if (!workspaceId) {
    state.panes = [];
    return;
  }
  const res = await rpc("layout.list", { workspace_id: workspaceId });
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return;
  }
  if (workspaceId !== state.selectedWorkspaceId) {
    return;
  }
  state.panes = res.panes ?? [];
}
async function loadUnread() {
  const res = await rpc("notify.unread", {});
  state.notifications = res.items ?? [];
  renderNotifications();
  renderWorkspaces();
  paneApi.refreshPaneBindings();
  await updateUnreadBadge(state.notifications.length);
}
async function runShellSession(workspaceId, cwd) {
  const preferred = (state.terminal.default_shell || "pwsh.exe")
    .toLowerCase()
    .includes("pwsh")
    ? "pwsh.exe"
    : state.terminal.default_shell || "pwsh.exe";
  const fallback = preferred.toLowerCase().includes("pwsh")
    ? "powershell.exe"
    : "pwsh.exe";
  const argsFor = (cmd) =>
    cmd.toLowerCase().includes("powershell.exe")
      ? [
          "-NoLogo",
          "-NoExit",
          "-Command",
          "chcp.com 65001 > $null; [Console]::InputEncoding=[Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[Text.UTF8Encoding]::new()",
        ]
      : [
          "-NoLogo",
          "-NoExit",
          "-Command",
          "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); [Console]::InputEncoding=[Text.UTF8Encoding]::new(); if (Get-Variable PSStyle -ErrorAction SilentlyContinue) { $PSStyle.OutputRendering = 'Ansi' }",
        ];
  try {
    const result = await rpc("session.run", {
      workspace_id: workspaceId,
      cmd: preferred,
      args: argsFor(preferred),
      cwd,
    });
    rememberShellCommand(preferred);
    return result;
  } catch (primaryErr) {
    try {
      const fallbackResult = await rpc("session.run", {
        workspace_id: workspaceId,
        cmd: fallback,
        args: argsFor(fallback),
        cwd,
      });
      setStatus(`Shell fallback: ${preferred} -> ${fallback}`);
      return fallbackResult;
    } catch {
      throw primaryErr ?? new Error("failed to launch shell session");
    }
  }
}
async function startSessionForPane(paneId, options = {}) {
  const {
    force = false,
    silent = false,
    focusTerm = true,
    cmd = null,
    args = null,
    cwd = null,
    workspaceId = state.selectedWorkspaceId,
    transitionSeq = null,
    restoreDormant = false
  } = options;
  if (!workspaceId) {
    throw new Error("Select a workspace first.");
  }
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return null;
  }
  const ws = workspaceRowById(workspaceId);
  if (!ws) {
    throw new Error("Workspace not found.");
  }
  if (!paneId || !leafPanes().some((p) => p.pane_id === paneId)) {
    throw new Error("Pane not found.");
  }
  const existing = state.paneSessions[paneId] ?? null;
  if (existing && !force) {
    const alive = runningSessionsForWorkspace(workspaceId).some((s) => s.id === existing);
    if (alive) {
      return existing;
    }
    delete state.paneSessions[paneId];
  }
  if (existing && force) {
    await rpc("session.close", { session_id: existing }).catch(() => {});
    delete state.paneSessions[paneId];
  }
  const dormant = dormantPaneSession(paneId);
  const restoreFromDormant = !cmd && dormant?.spawn_cmd && (restoreDormant || force || !existing);
  let effectiveCmd = cmd;
  let effectiveArgs = args;
  let effectiveCwd = cwd;
  if (restoreFromDormant) {
    effectiveCmd = dormant.spawn_cmd;
    try {
      effectiveArgs = JSON.parse(dormant.spawn_args ?? "[]");
    } catch {
      effectiveArgs = [];
    }
    effectiveCwd = dormant.spawn_cwd ?? undefined;
  }
  paneApi.markPaneStarting(
    paneId,
    restoreFromDormant ? "Restoring session..." : "Starting session...",
    effectiveCmd ? String(effectiveCmd) : "Launching default shell"
  );
  let created;
  try {
    if (effectiveCmd) {
      created = await rpc("session.run", {
        workspace_id: workspaceId,
        cmd: effectiveCmd,
        args: effectiveArgs ?? [],
        cwd: effectiveCwd ?? ws.path,
      });
    } else {
      created = await runShellSession(workspaceId, ws.path);
    }
  } catch (err) {
    const message = String(err?.message ?? err);
    if (message.includes("File not found")) {
      throw new Error(`Shell start failed. Check workspace path: ${ws.path}`);
    }
    throw err;
  }
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return null;
  }
  const sid = created?.session?.session_id;
  if (!sid) {
    throw new Error("session.run returned no session_id");
  }
  clearDormantPaneSession(paneId);
  state.paneSessions[paneId] = sid;
  const newGroupId = groupIdForNewPaneSession(paneId, effectiveCmd, effectiveArgs, options.groupId ?? null);
  if (newGroupId) {
    await setSessionGroup(workspaceId, sid, newGroupId).catch(() => {});
  }
  setPaneGroupHint(paneId, null);
  rpc("pane.session.bind", {
    workspace_id: workspaceId,
    pane_id: paneId,
    session_id: sid,
  }).catch(() => {});
  await loadSessions(workspaceId, transitionSeq);
  await loadPaneGroups(workspaceId, transitionSeq);
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return sid;
  }
  paneApi.normalizePaneSessions();
  paneApi.refreshPaneBindings();
  if (!silent) {
    setStatus(`Session started: ${sid}`);
  }
  const shellCmd = (effectiveCmd ?? "pwsh.exe").toLowerCase();
  const isShell = shellCmd.includes("pwsh") || shellCmd.includes("powershell") || shellCmd.includes("cmd.exe");
  setTimeout(() => {
    state.paneViews.get(paneId)?.fitAddon?.fit?.();
    if (isShell) {
      rpc("session.write", { session_id: sid, data: "\r" }).catch(() => {});
    }
  }, 300);
  if (focusTerm) {
    window.requestAnimationFrame(() => {
      paneApi.focusPaneTerm(paneId);
    });
  }
  await syncActiveContext();
  return sid;
}
async function ensurePaneSessionReady(workspaceId, paneId, transitionSeq = null) {
  if (!workspaceId || !paneId) {
    return;
  }
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return;
  }
  if (!leafPanes().some((p) => p.pane_id === paneId)) {
    return;
  }
  const sid = state.paneSessions[paneId] ?? null;
  const alive = sid ? runningSessionsForWorkspace(workspaceId).some((s) => s.id === sid) : false;
  await paneApi.selectPane(paneId, { persist: true, focusTerm: true });
  if (!alive) {
    paneApi.refreshPaneBindings();
  }
  await syncActiveContext();
}

async function ensureAllPaneSessionsReady(workspaceId, primaryPaneId, transitionSeq = null) {
  if (!workspaceId) {
    return;
  }
  for (const pane of leafPanes()) {
    if (isTransitionStale(transitionSeq, workspaceId)) {
      return;
    }
    const paneId = pane.pane_id;
    if (!paneId || paneId === primaryPaneId) {
      continue;
    }
    const sid = state.paneSessions[paneId] ?? null;
    const alive = sid ? runningSessionsForWorkspace(workspaceId).some((s) => s.id === sid) : false;
    if (alive) {
      continue;
    }
    try {
      await startSessionForPane(paneId, { silent: true, focusTerm: false, workspaceId, transitionSeq });
    } catch (err) {
      setStatus(`Pane auto-start failed (${paneId}): ${String(err?.message ?? err)}`, true);
    }
  }
  if (!isTransitionStale(transitionSeq, workspaceId) && primaryPaneId && leafPanes().some((p) => p.pane_id === primaryPaneId)) {
    await paneApi.selectPane(primaryPaneId, { persist: false, focusTerm: true });
  }
}
async function closeSessionForPane(paneId) {
  const sid = state.paneSessions[paneId];
  if (!sid) {
    setStatus("No running session in selected pane.", true);
    return;
  }
  const groupId = groupForPane(paneId)?.id ?? null;
  if (groupId) {
    setPaneGroupHint(paneId, groupId);
  }
  await rpc("session.close", { session_id: sid });
  clearPromptDetectorSession(sid);
  delete state.paneSessions[paneId];
  await loadSessions();
  paneApi.normalizePaneSessions();
  paneApi.refreshPaneBindings();
  const fallback = state.selectedPaneId ?? leafPanes()[0]?.pane_id ?? null;
  if (fallback) {
    await paneApi.selectPane(fallback, { persist: true, focusTerm: true });
  }
  setStatus(`Session closed: ${sid.slice(0, 8)}`);
  await syncActiveContext();
}
async function tryRestorePaneSessions(workspaceId, transitionSeq = null) {
  if (!workspaceId || isTransitionStale(transitionSeq, workspaceId)) {
    return;
  }
  const res = await rpc("pane.session.bindings", { workspace_id: workspaceId }).catch(() => null);
  if (!res?.bindings?.length) return;
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return;
  }
  clearDormantPaneSessionsForWorkspace(workspaceId);
  const running = new Set(runningSessionsForWorkspace(workspaceId).map((s) => s.id));
  const currentLeafIds = new Set(leafPanes().map((p) => p.pane_id));
  for (const binding of res.bindings) {
    if (isTransitionStale(transitionSeq, workspaceId)) {
      return;
    }
    const { pane_id, session_id, spawn_cmd, spawn_args, spawn_cwd } = binding;
    if (!currentLeafIds.has(pane_id)) continue;
    if (running.has(session_id)) {
      state.paneSessions[pane_id] = session_id;
      clearDormantPaneSession(pane_id);
      continue;
    }
    if (!spawn_cmd) continue;
    if (!state.paneSessions[pane_id]) {
      state.dormantPaneSessions[pane_id] = {
        workspace_id: workspaceId,
        pane_id,
        session_id,
        spawn_cmd,
        spawn_args,
        spawn_cwd
      };
    }
  }
}
async function refreshWorkspaceState(workspaceId, options = {}, transitionSeq = null) {
  if (!workspaceId) {
    return;
  }
  const { forceLayout = false, autoSession = true } = options;
  const unreadRefresh = loadUnread().catch((err) => {
    if (!isTransitionStale(transitionSeq, workspaceId)) {
      setStatus(`Unread refresh failed: ${String(err?.message ?? err)}`, true);
    }
  });
  await Promise.all([loadSessions(workspaceId, transitionSeq), loadPanes(workspaceId, transitionSeq), loadPaneGroups(workspaceId, transitionSeq)]);
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return;
  }
  if (state.useStream) {
    await subscribeWorkspaceStream(workspaceId);
    if (isTransitionStale(transitionSeq, workspaceId)) {
      return;
    }
  }
  if (autoSession) {
    await tryRestorePaneSessions(workspaceId, transitionSeq);
    if (isTransitionStale(transitionSeq, workspaceId)) {
      return;
    }
  }
  cleanupHiddenSessionsForWorkspace(workspaceId, false);
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return;
  }
  paneApi.renderPaneSurface(forceLayout);
  paneApi.refreshPaneBindings();
  hiddenRefreshPanesUi();
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return;
  }
  paneApi.selectPane(state.selectedPaneId, { persist: false, focusTerm: false }).catch(() => {});
  await syncActiveContext();
  void unreadRefresh;
}
async function runWorkspaceTransition(workspaceId, options = {}) {
  if (!workspaceId) {
    return;
  }
  const { reason = "manual", forceLayout = true, autoSession = true } = options;
  const transitionSeq = ++workspaceTransition.transitionSeq;
  workspaceTransition.activeTransitionSeq = transitionSeq;
  workspaceTransition.activeWorkspaceId = workspaceId;
  workspaceTransition.switchInFlight = true;
  if (state.selectedWorkspaceId && state.selectedWorkspaceId !== workspaceId) {
    persistWorkspaceGroupState(state.selectedWorkspaceId);
  }
  state.selectedWorkspaceId = workspaceId;
  loadWorkspaceGroupState(workspaceId);
  localStorage.setItem(STORAGE_KEYS.selectedWorkspaceId, workspaceId);
  renderWorkspaces();
  loadNotepadForWorkspace(workspaceId);
  try {
    await refreshWorkspaceState(workspaceId, { forceLayout, autoSession }, transitionSeq);
    if (!isTransitionStale(transitionSeq, workspaceId)) {
      await syncActiveContext();
    }
  } finally {
    if (workspaceTransition.activeTransitionSeq === transitionSeq) {
      workspaceTransition.switchInFlight = false;
    }
  }
}
async function switchWorkspace(workspaceId) {
  await runWorkspaceTransition(workspaceId, { reason: "switch", forceLayout: true, autoSession: true });
}

function isNotificationForPane(row, workspaceId, paneId, sessionId) {
  const target = normalizeNotificationTarget(row);
  const targetWorkspaceId = target.workspaceId ?? row.workspace_id ?? null;
  if (!targetWorkspaceId || targetWorkspaceId !== workspaceId) {
    return false;
  }
  if (target.paneId) {
    return target.paneId === paneId;
  }
  if (sessionId && target.sessionId) {
    return target.sessionId === sessionId;
  }
  return false;
}

async function markPaneNotificationsRead(paneId) {
  const ws = selectedWorkspace();
  if (!ws || !paneId) {
    return 0;
  }
  const sessionId = state.paneSessions[paneId] ?? null;
  const rows = state.notifications.filter((row) =>
    isNotificationForPane(row, ws.id, paneId, sessionId),
  );
  if (rows.length === 0) {
    return 0;
  }
  await Promise.allSettled(
    rows.map((row) =>
      rpc("notify.mark_read", { notification_id: row.id }),
    ),
  );
  await loadUnread();
  return rows.length;
}
async function onCreateWorkspace() {
  const defaultPath =
    localStorage.getItem(STORAGE_KEYS.lastWorkspacePath) ?? "C:\\";
  const name =
    wsNameInput.value.trim() || `workspace-${Date.now().toString().slice(-6)}`;
  const pathValue = wsPathInput.value.trim() || defaultPath;
  const created = await rpc("workspace.create", {
    name,
    path: pathValue,
    backend: "codex",
  });
  rememberWorkspacePath(pathValue);
  state.selectedWorkspaceId = created?.workspace?.id ?? null;
  await loadWorkspaces();
  if (state.selectedWorkspaceId) {
    await switchWorkspace(state.selectedWorkspaceId);
  }
  wsNameInput.value = "";
  wsPathInput.value = pathValue;
  setStatus(`Workspace created: ${name}`);
}
async function deleteWorkspaceById(workspaceId) {
  const ws = state.workspaces.find((item) => item.id === workspaceId);
  if (!ws) {
    return;
  }
  const message = `Delete workspace "${ws.name}"?\n\nThis removes it from WinCMux and closes its sessions. Files on disk are not deleted.`;
  if (!window.confirm(message)) {
    return;
  }
  const wasSelected = ws.id === state.selectedWorkspaceId;
  await rpc("workspace.delete", { id: ws.id });
  removeWorkspacePaneFonts(ws.id);
  hiddenClearPanesForWorkspace(ws.id);
  delete state.workspacePaneGroupHints[ws.id];
  delete state.workspaceSelectedGroups[ws.id];
  localStorage.setItem(STORAGE_KEYS.workspacePaneGroupHints, JSON.stringify(state.workspacePaneGroupHints));
  localStorage.setItem(STORAGE_KEYS.workspaceSelectedGroups, JSON.stringify(state.workspaceSelectedGroups));
  if (wasSelected) {
    disposeAllViews();
    state.paneCards.clear();
    state.paneMeta.clear();
    state.layoutHash = "";
    state.paneSessions = {};
    state.paneGroupHints = {};
    state.panes = [];
    state.sessions = [];
    clearPromptDetectorAll();
    state.selectedPaneId = null;
    localStorage.removeItem(STORAGE_KEYS.selectedWorkspaceId);
    await unsubscribeStream();
  }
  await loadWorkspaces();
  await loadUnread();
  if (wasSelected && state.selectedWorkspaceId) {
    await switchWorkspace(state.selectedWorkspaceId);
  } else if (wasSelected) {
    paneSurface.innerHTML = "";
    notificationList.innerHTML = "";
  }
  setStatus(`Workspace deleted: ${ws.name}`);
  await syncActiveContext();
}
async function onDeleteWorkspace() {
  const ws = selectedWorkspace();
  if (!ws) {
    return;
  }
  await deleteWorkspaceById(ws.id);
}
async function onPickFolder() {
  if (typeof window.wincmux?.pickFolder !== "function") {
    setStatus("Folder picker unavailable in preload bridge.", true, { priority: 85, holdMs: 12000 });
    return;
  }
  const selected = await window.wincmux.pickFolder();
  if (!selected) {
    return;
  }
  wsPathInput.value = selected;
  rememberWorkspacePath(selected);
}
async function onOpenInVscode() {
  const ws = selectedWorkspace();
  if (!ws) {
    setStatus("Select a workspace first.", true);
    return;
  }
  const result = await window.wincmux.openInVscode(ws.path);
  setStatus(`Opened in VSCode via ${result.method}`);
}
async function onClosePane(paneId) {
  const ws = selectedWorkspace();
  if (!ws) {
    return;
  }
  if (!paneId || !leafPanes().some((p) => p.pane_id === paneId)) {
    setStatus("Pane not found.", true);
    return;
  }
  if (leafPanes().length <= 1) {
    setStatus("At least one pane must remain open.", true);
    return;
  }
  const sessionId = state.paneSessions[paneId];
  if (sessionId) {
    await rpc("session.close", { session_id: sessionId }).catch(() => {});
    delete state.paneSessions[paneId];
    await loadSessions();
  }
  clearDormantPaneSession(paneId);
  setPaneGroupHint(paneId, null);
  removePaneFontSize(ws.id, paneId);
  const res = await rpc("layout.close", {
    workspace_id: ws.id,
    pane_id: paneId,
  });
  await loadPanes();
  paneApi.normalizePaneSessions();
  paneApi.renderPaneSurface(true);
  paneApi.refreshPaneBindings();
  const nextPaneId = res?.focus_pane_id ?? leafPanes()[0]?.pane_id ?? null;
  if (nextPaneId) {
    state.selectedPaneId = nextPaneId;
    await ensurePaneSessionReady(ws.id, nextPaneId);
  }
  setStatus("Pane closed");
  await syncActiveContext();
}
async function splitPaneInternal(paneId, direction, options = {}) {
  const { newPaneSessionId = null, autoStartIfMissing = true } = options;
  const ws = selectedWorkspace();
  if (!ws) {
    return null;
  }
  if (!paneId || !leafPanes().some((p) => p.pane_id === paneId)) {
    setStatus("Pane not found.", true);
    return null;
  }
  const previousPaneId = paneId;
  const previousSession = state.paneSessions[previousPaneId] ?? null;
  const previousGroupId = groupForPane(previousPaneId)?.id ?? state.selectedGroupId ?? defaultPaneGroup()?.id ?? null;
  const inheritedFontSize = currentPaneFontSize(ws.id, previousPaneId);
  const res = await rpc("layout.split", {
    workspace_id: ws.id,
    pane_id: previousPaneId,
    direction,
  });
  const first = res?.pane_ids?.[0] ?? null;
  const second = res?.pane_ids?.[1] ?? null;
  delete state.paneSessions[previousPaneId];
  setPaneGroupHint(previousPaneId, null);
  const previousDormant = dormantPaneSession(previousPaneId);
  clearDormantPaneSession(previousPaneId);
  removePaneFontSize(ws.id, previousPaneId);
  if (previousSession && first) {
    state.paneSessions[first] = previousSession;
  }
  if (!previousSession && previousDormant && first) {
    state.dormantPaneSessions[first] = { ...previousDormant, pane_id: first };
  }
  if (first) {
    setPaneFontSize(ws.id, first, inheritedFontSize);
    if (previousGroupId) {
      setPaneGroupHint(first, previousGroupId);
    }
  }
  if (second) {
    setPaneFontSize(ws.id, second, inheritedFontSize);
    if (previousGroupId) {
      setPaneGroupHint(second, previousGroupId);
    }
  }
  if (newPaneSessionId && second) {
    state.paneSessions[second] = newPaneSessionId;
    clearDormantPaneSession(second);
  }
  state.selectedPaneId = second ?? first;
  await loadPanes();
  await loadSessions();
  paneApi.normalizePaneSessions();
  paneApi.renderPaneSurface(true);
  paneApi.refreshPaneBindings();
  hiddenRefreshPanesUi();
  if (state.selectedPaneId) {
    await paneApi.selectPane(state.selectedPaneId, { persist: true, focusTerm: true });
    if (autoStartIfMissing) {
      await ensurePaneSessionReady(ws.id, state.selectedPaneId);
    }
  }
  return { first, second };
}
async function onSplit(paneId, direction) {
  const result = await splitPaneInternal(paneId, direction, {
    autoStartIfMissing: true,
  });
  if (result) {
    setStatus(`Split applied: ${direction}`);
  }
  await syncActiveContext();
}
async function onHidePane(paneId) {
  const ws = selectedWorkspace();
  if (!ws) {
    return;
  }
  if (!paneId || !leafPanes().some((p) => p.pane_id === paneId)) {
    setStatus("Pane not found.", true);
    return;
  }
  if (leafPanes().length <= 1) {
    setStatus("At least one pane must remain open.", true);
    return;
  }
  const sessionId = state.paneSessions[paneId] ?? null;
  const groupId = groupForPane(paneId)?.id ?? null;
  if (sessionId) {
    const session = state.sessions.find((row) => row.id === sessionId);
    const label = session
      ? `pane ${paneId.slice(0, 8)} - pid ${session.pid}`
      : `pane ${paneId.slice(0, 8)}`;
    hiddenPushPaneItem({
      id: crypto.randomUUID(),
      workspace_id: ws.id,
      session_id: sessionId,
      source_pane_id: paneId,
      hidden_at: new Date().toISOString(),
      group_id: groupId,
      label,
    });
  }
  delete state.paneSessions[paneId];
  setPaneGroupHint(paneId, null);
  clearDormantPaneSession(paneId);
  removePaneFontSize(ws.id, paneId);
  const res = await rpc("layout.close", {
    workspace_id: ws.id,
    pane_id: paneId,
  });
  await loadPanes();
  await loadSessions();
  paneApi.normalizePaneSessions();
  paneApi.renderPaneSurface(true);
  paneApi.refreshPaneBindings();
  hiddenRefreshPanesUi();
  const nextPaneId = res?.focus_pane_id ?? leafPanes()[0]?.pane_id ?? null;
  if (nextPaneId) {
    state.selectedPaneId = nextPaneId;
    await ensurePaneSessionReady(ws.id, nextPaneId);
  }
  setStatus(
    sessionId ? `Pane hidden: ${sessionId.slice(0, 8)}` : "Pane hidden",
  );
  await syncActiveContext();
}

function cancelPaneMoveMode(showStatus = true) {
  if (!state.paneMove?.sourcePaneId) {
    return;
  }
  state.paneMove.sourcePaneId = null;
  state.paneMove.targetPaneId = null;
  state.paneMove.placement = null;
  paneApi.refreshPaneBindings();
  if (showStatus) {
    setStatus("Pane move cancelled");
  }
}

async function startPaneMove(paneId) {
  const ws = selectedWorkspace();
  if (!ws) {
    return;
  }
  const leaves = leafPanes();
  if (!paneId || !leaves.some((pane) => pane.pane_id === paneId)) {
    setStatus("Pane not found.", true);
    return;
  }
  const visiblePaneCount = state.paneCards?.size ?? leaves.length;
  if (visiblePaneCount < 2) {
    setStatus("Need at least two visible panes to move.", true);
    return;
  }
  state.paneMove.sourcePaneId = paneId;
  state.paneMove.targetPaneId = null;
  state.paneMove.placement = null;
  await paneApi.selectPane(paneId, { persist: true, focusTerm: false });
  paneApi.refreshPaneBindings();
  setStatus("Move pane: hover a target edge, click to drop, or press Esc to cancel");
}

async function swapPanePositions(firstPaneId, secondPaneId) {
  const ws = selectedWorkspace();
  if (!ws) {
    return;
  }
  if (!firstPaneId || !secondPaneId || firstPaneId === secondPaneId) {
    cancelPaneMoveMode();
    return;
  }
  const leaves = leafPanes();
  if (!leaves.some((pane) => pane.pane_id === firstPaneId) || !leaves.some((pane) => pane.pane_id === secondPaneId)) {
    state.paneMove.sourcePaneId = null;
    paneApi.refreshPaneBindings();
    setStatus("Pane not found.", true);
    return;
  }
  try {
    await rpc("layout.swap", {
      workspace_id: ws.id,
      first_pane_id: firstPaneId,
      second_pane_id: secondPaneId,
    });
    state.paneMove.sourcePaneId = null;
    state.selectedPaneId = firstPaneId;
    await loadPanes();
    paneApi.normalizePaneSessions();
    paneApi.renderPaneSurface(true);
    paneApi.refreshPaneBindings();
    await paneApi.selectPane(firstPaneId, { persist: true, focusTerm: true });
    hiddenRefreshPanesUi();
    setStatus(`Pane moved to ${secondPaneId.slice(0, 8)}`);
    await syncActiveContext();
  } catch (err) {
    state.paneMove.sourcePaneId = null;
    paneApi.refreshPaneBindings();
    throw err;
  }
}

async function movePaneToPlacement(sourcePaneId, targetPaneId, placement) {
  const ws = selectedWorkspace();
  if (!ws) {
    return;
  }
  if (!sourcePaneId || !targetPaneId || sourcePaneId === targetPaneId) {
    cancelPaneMoveMode();
    return;
  }
  const validPlacements = new Set(["left", "right", "above", "below"]);
  if (!validPlacements.has(placement)) {
    setStatus("Drop position not found.", true);
    return;
  }
  const leaves = leafPanes();
  if (!leaves.some((pane) => pane.pane_id === sourcePaneId) || !leaves.some((pane) => pane.pane_id === targetPaneId)) {
    state.paneMove.sourcePaneId = null;
    state.paneMove.targetPaneId = null;
    state.paneMove.placement = null;
    paneApi.refreshPaneBindings();
    setStatus("Pane not found.", true);
    return;
  }
  try {
    await rpc("layout.move", {
      workspace_id: ws.id,
      source_pane_id: sourcePaneId,
      target_pane_id: targetPaneId,
      placement,
    });
    state.paneMove.sourcePaneId = null;
    state.paneMove.targetPaneId = null;
    state.paneMove.placement = null;
    state.selectedPaneId = sourcePaneId;
    await loadPanes();
    paneApi.normalizePaneSessions();
    paneApi.renderPaneSurface(true);
    paneApi.refreshPaneBindings();
    await paneApi.selectPane(sourcePaneId, { persist: true, focusTerm: true });
    hiddenRefreshPanesUi();
    const label = placement === "below" ? "below" : placement === "above" ? "above" : placement === "left" ? "left of" : "right of";
    setStatus(`Pane moved ${label} ${targetPaneId.slice(0, 8)}`);
    await syncActiveContext();
  } catch (err) {
    state.paneMove.sourcePaneId = null;
    state.paneMove.targetPaneId = null;
    state.paneMove.placement = null;
    paneApi.refreshPaneBindings();
    throw err;
  }
}

async function onRestoreHiddenPane(hiddenId, direction) {
  const ws = selectedWorkspace();
  if (!ws) {
    return;
  }
  const hidden = hiddenFindPaneById(ws.id, hiddenId);
  if (!hidden) {
    setStatus("Hidden pane not found.", true);
    hiddenRefreshPanesUi();
    return;
  }
  const targetPaneId = leafPanes().some(
    (pane) => pane.pane_id === state.selectedPaneId,
  )
    ? state.selectedPaneId
    : (leafPanes()[0]?.pane_id ?? null);
  if (!targetPaneId) {
    setStatus("No pane available to restore into.", true);
    return;
  }
  const alive = runningSessions().some(
    (session) => session.id === hidden.session_id,
  );
  if (!alive) {
    hiddenRemovePaneById(ws.id, hidden.id);
    setStatus(`Hidden session already ended: ${hidden.session_id.slice(0, 8)}`);
    return;
  }
  hiddenRemovePaneById(ws.id, hidden.id);
  try {
    if (hidden.group_id && targetPaneId) {
      setPaneGroupHint(targetPaneId, hidden.group_id);
    }
    const result = await splitPaneInternal(targetPaneId, direction, {
      newPaneSessionId: hidden.session_id,
      autoStartIfMissing: false,
    });
    if (!result) {
      hiddenPushPaneItem(hidden);
      return;
    }
    await paneApi.selectPane(result.second ?? result.first, {
      persist: true,
      focusTerm: true,
    });
    closeHiddenPanesPopover();
    setStatus(`Hidden pane restored: ${hidden.session_id.slice(0, 8)}`);
    await syncActiveContext();
  } catch (err) {
    hiddenPushPaneItem(hidden);
    throw err;
  }
}
async function onTerminateHiddenPane(hiddenId) {
  const ws = selectedWorkspace();
  if (!ws) {
    return;
  }
  const hidden = hiddenRemovePaneById(ws.id, hiddenId);
  if (!hidden) {
    setStatus("Hidden pane not found.", true);
    return;
  }
  await rpc("session.close", { session_id: hidden.session_id }).catch(() => {});
  clearPromptDetectorSession(hidden.session_id);
  await loadSessions();
  paneApi.normalizePaneSessions();
  paneApi.refreshPaneBindings();
  hiddenRefreshPanesUi();
  closeHiddenPanesPopover();
  setStatus(`Hidden session terminated: ${hidden.session_id.slice(0, 8)}`);
  await syncActiveContext();
}
async function movePaneToGroup(paneId, groupId) {
  const ws = selectedWorkspace();
  if (!ws || !paneId || !groupId) {
    return;
  }
  if (!leafPanes().some((pane) => pane.pane_id === paneId)) {
    setStatus("Pane not found.", true);
    return;
  }
  const group = paneGroupById(groupId);
  if (!group) {
    setStatus("Pane group not found.", true);
    return;
  }
  setPaneGroupHint(paneId, groupId);
  const sessionId = state.paneSessions[paneId] ?? null;
  if (sessionId) {
    await setSessionGroup(ws.id, sessionId, groupId);
    await loadPaneGroups(ws.id);
  } else {
    renderGroupBar();
  }
  paneApi.renderPaneSurface(true);
  paneApi.refreshPaneBindings();
  setStatus(`Pane moved to ${group.name}`);
}
async function openSessionInSplit(paneId, session, direction) {
  const ws = selectedWorkspace();
  if (!ws || !session) {
    return;
  }
  const groupId = groupIdForSession(session.id) ?? groupForPane(paneId)?.id ?? defaultPaneGroup()?.id ?? null;
  if (groupId) {
    setPaneGroupHint(paneId, groupId);
  }
  const result = await splitPaneInternal(paneId, direction, {
    autoStartIfMissing: false,
    newPaneSessionId: session.status === "running" ? session.id : null
  });
  const targetPaneId = result?.second ?? result?.first ?? null;
  if (!targetPaneId) {
    return;
  }
  if (groupId) {
    setPaneGroupHint(targetPaneId, groupId);
  }
  if (session.status === "running") {
    rpc("pane.session.bind", { workspace_id: ws.id, pane_id: targetPaneId, session_id: session.id }).catch(() => {});
  } else if (session.status === "dormant") {
    state.dormantPaneSessions[targetPaneId] = {
      workspace_id: ws.id,
      pane_id: targetPaneId,
      session_id: session.id,
      spawn_cmd: session.spawn_cmd,
      spawn_args: session.spawn_args,
      spawn_cwd: session.spawn_cwd
    };
    await startSessionForPane(targetPaneId, {
      restoreDormant: true,
      silent: false,
      groupId,
      focusTerm: true
    });
  } else {
    let parsedArgs = [];
    try { parsedArgs = JSON.parse(session.spawn_args || "[]"); } catch { /* */ }
    await startSessionForPane(targetPaneId, {
      force: true,
      cmd: session.spawn_cmd,
      args: parsedArgs,
      cwd: session.spawn_cwd || undefined,
      groupId,
      focusTerm: true
    });
  }
  await paneApi.selectPane(targetPaneId, { persist: true, focusTerm: true });
  paneApi.refreshPaneBindings();
  setStatus(`Opened in ${direction === "horizontal" ? "right" : "down"} pane`);
}
async function onAdjustPaneFont(paneId, delta) {
  const ws = selectedWorkspace();
  if (!ws || !paneId) {
    return;
  }
  const nextSize = adjustPaneFontSize(ws.id, paneId, delta);
  applyPaneFontToView(paneId, nextSize);
  paneApi.refreshPaneBindings();
}
async function onInsertQuickCommand(paneId, text) {
  if (!paneId || typeof text !== "string" || !text) {
    return;
  }
  if (!leafPanes().some((p) => p.pane_id === paneId)) {
    setStatus("Pane not found.", true);
    return;
  }
  await ensurePaneSessionReady(state.selectedWorkspaceId, paneId);
  paneApi.writeToPane(paneId, text);
  setStatus("Quick command inserted");
}
async function onMarkWorkspaceRead() {
  if (state.notifications.length === 0) {
    return;
  }
  const workspaceId = state.selectedWorkspaceId;
  if (!workspaceId || !state.notifications.some((row) => row.workspace_id === workspaceId)) {
    setStatus("No unread notifications in this workspace");
    return;
  }
  await markWorkspaceNotificationsRead(workspaceId);
}
async function markWorkspaceNotificationsRead(workspaceId) {
  if (!workspaceId) {
    return;
  }
  const rows = state.notifications.filter((row) => row.workspace_id === workspaceId);
  if (rows.length === 0) {
    return;
  }
  const ids = rows.map((row) => row.id);
  const idSet = new Set(ids);
  state.notifications = state.notifications.filter((row) => !idSet.has(row.id));
  renderNotifications();
  renderWorkspaces();
  paneApi.refreshPaneBindings();
  await updateUnreadBadge(state.notifications.length);
  await Promise.allSettled(ids.map((notificationId) => rpc("notify.mark_read", { notification_id: notificationId })));
  await dismissNativeNotifications({ ids });
  await loadUnread();
  setStatus(`Workspace notifications marked read: ${rows.length}`);
}
async function onClearUnread() {
  state.notifications = [];
  renderNotifications();
  renderWorkspaces();
  paneApi.refreshPaneBindings();
  await updateUnreadBadge(0);
  await rpc("notify.clear", {});
  await dismissNativeNotifications({ all: true });
  await loadUnread();
  setStatus("Unread notifications cleared");
}
async function onNotificationClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const item = target.closest("li[data-notification-id]");
  const groupMark = target.closest("button.notif-group-mark[data-workspace-id]");
  if (groupMark) {
    const workspaceId = groupMark.dataset.workspaceId;
    state.notificationActionBusy = true;
    try {
      await markWorkspaceNotificationsRead(workspaceId);
    } catch (err) {
      setStatus(String(err?.message ?? err), true);
    } finally {
      state.notificationActionBusy = false;
    }
    return;
  }
  if (!item || state.notificationActionBusy) {
    return;
  }
  const notificationId = item.dataset.notificationId;
  if (!notificationId) {
    return;
  }
  const notification = state.notifications.find(
    (row) => row.id === notificationId,
  );
  if (!notification) {
    return;
  }
  state.notificationActionBusy = true;
  try {
    await openNotificationById(notificationId);
    await syncActiveContext();
  } catch (err) {
    setStatus(String(err?.message ?? err), true);
  } finally {
    state.notificationActionBusy = false;
  }
}
function toggleWorkspacePanel() {
  state.leftCollapsed = !state.leftCollapsed;
  localStorage.setItem(
    STORAGE_KEYS.leftCollapsed,
    state.leftCollapsed ? "1" : "0",
  );
  applyPanelVisibility();
  paneApi.fitAllPanes();
}
function toggleNotificationPanel() {
  state.rightCollapsed = !state.rightCollapsed;
  localStorage.setItem(
    STORAGE_KEYS.rightCollapsed,
    state.rightCollapsed ? "1" : "0",
  );
  applyPanelVisibility();
  paneApi.fitAllPanes();
}
// ?? Workspace Info Panel ???????????????????????????????????????
let wsDescSaveTimer = null;

const AGENT_ASSET_CATEGORY_LABELS = {
  instructions: "Instructions",
  skills: "Skills",
  rules: "Rules",
  subagents: "Subagents",
  commands: "Commands",
  settings: "Settings",
  mcp: "MCP",
};

const AGENT_ASSET_PROVIDER_DEFS = [
  { id: "all", label: "All" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini" },
  { id: "cursor", label: "Cursor" },
  { id: "kiro", label: "Kiro" },
  { id: "opencode", label: "opencode" },
  { id: "shared", label: "Shared" },
];

const AGENT_ASSET_PROVIDER_LABELS = Object.fromEntries(AGENT_ASSET_PROVIDER_DEFS.map((provider) => [provider.id, provider.label]));

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const LONG_PASTE_BYTES = 2048;
const LONG_PASTE_LINES = 20;
const INPUT_ASSET_INSERT_CHUNK = 4096;
const ASSET_MODE_KEYS = {
  agent: "wincmux.agentAssets.mode",
  input: "wincmux.inputAssets.mode"
};
let pendingInputAssetPrompt = null;

function normalizeAssetMode(mode) {
  return mode === "detail" ? "detail" : "brief";
}

function storedAssetMode(kind) {
  return normalizeAssetMode(localStorage.getItem(ASSET_MODE_KEYS[kind]));
}

function persistAssetMode(kind, mode) {
  const normalized = normalizeAssetMode(mode);
  localStorage.setItem(ASSET_MODE_KEYS[kind], normalized);
  return normalized;
}

function renderAssetModeToggle(actionName, mode) {
  const current = normalizeAssetMode(mode);
  return `<div class="asset-view-toggle" aria-label="Asset list density">
    <button data-${actionName}="asset-mode" data-mode="brief" class="${current === "brief" ? "active" : ""}">Brief</button>
    <button data-${actionName}="asset-mode" data-mode="detail" class="${current === "detail" ? "active" : ""}">Detail</button>
  </div>`;
}

function textByteLength(text) {
  return new Blob([String(text ?? "")]).size;
}

function isLongPasteText(text) {
  const value = String(text ?? "");
  return textByteLength(value) >= LONG_PASTE_BYTES || value.split(/\r?\n/).length >= LONG_PASTE_LINES;
}

function defaultInputAssetTitle(text) {
  const first = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (first) return first.slice(0, 80);
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `Snippet ${stamp}`;
}

function inputAssetFormatSize(size) {
  const bytes = Number(size ?? 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function inputAssetAbsolutePath(workspacePath, relativePath) {
  const base = String(workspacePath ?? "").trim();
  const rel = String(relativePath ?? "").trim();
  if (!rel) return base;
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("\\\\") || rel.startsWith("/")) {
    return rel;
  }
  if (!base) return rel;
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${rel.replace(/^[\\/]+/, "")}`;
}

function inputAssetReferenceText(asset, workspacePath) {
  if (!asset) return "";
  const assetPath = inputAssetAbsolutePath(workspacePath, asset.relative_path);
  const label = asset.type === "image" ? "이미지 작업 문서 경로" : "작업 문서 경로";
  const noun = asset.type === "image" ? "이미지 작업 문서" : "작업 문서";
  return `${label}: ${assetPath}\n위의 경로에 적힌 ${noun}로 작업 진행해줘`;
}

function inputAssetInsertText(asset, content, mode = "reference", workspacePath = "") {
  if (!asset) return "";
  if (mode === "reference") {
    return inputAssetReferenceText(asset, workspacePath);
  }
  if (mode === "path") {
    return inputAssetAbsolutePath(workspacePath, asset.relative_path);
  }
  if (asset.type === "image") {
    return inputAssetAbsolutePath(workspacePath, asset.relative_path);
  }
  return String(content ?? "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeTextToPaneChunked(paneId, text) {
  const value = String(text ?? "");
  if (!paneId || !value) return;
  await ensurePaneSessionReady(state.selectedWorkspaceId, paneId);
  if (value.length <= INPUT_ASSET_INSERT_CHUNK) {
    paneApi.writeToPane(paneId, value);
    return;
  }
  for (let offset = 0; offset < value.length; offset += INPUT_ASSET_INSERT_CHUNK) {
    paneApi.writeToPane(paneId, value.slice(offset, offset + INPUT_ASSET_INSERT_CHUNK));
    await delay(8);
  }
}

function showInputAssetPrompt({ paneId, text }) {
  const overlay = $("inputAssetPromptOverlay");
  const title = $("inputAssetPromptTitle");
  const meta = $("inputAssetPromptMeta");
  const titleInput = $("inputAssetPromptTitleInput");
  const preview = $("inputAssetPromptPreview");
  const imagePreview = $("inputAssetImagePreview");
  const imagePreviewImg = $("inputAssetImagePreviewImg");
  const pasteDirectBtn = $("inputAssetPasteDirectBtn");
  if (!overlay || !meta || !titleInput || !preview) {
    return false;
  }
  pendingInputAssetPrompt = { kind: "text", paneId, text };
  if (title) title.textContent = "Long paste detected";
  titleInput.value = defaultInputAssetTitle(text);
  meta.textContent = `${inputAssetFormatSize(textByteLength(text))} · ${String(text).split(/\r?\n/).length} lines`;
  preview.value = String(text).slice(0, 4000);
  preview.readOnly = true;
  preview.hidden = false;
  if (imagePreview) imagePreview.hidden = true;
  if (imagePreviewImg) imagePreviewImg.removeAttribute("src");
  if (pasteDirectBtn) pasteDirectBtn.hidden = false;
  overlay.hidden = false;
  titleInput.focus();
  titleInput.select();
  return true;
}

function showInputAssetImagePrompt({ paneId, image }) {
  const overlay = $("inputAssetPromptOverlay");
  const title = $("inputAssetPromptTitle");
  const meta = $("inputAssetPromptMeta");
  const titleInput = $("inputAssetPromptTitleInput");
  const preview = $("inputAssetPromptPreview");
  const imagePreview = $("inputAssetImagePreview");
  const imagePreviewImg = $("inputAssetImagePreviewImg");
  const pasteDirectBtn = $("inputAssetPasteDirectBtn");
  if (!overlay || !meta || !titleInput || !imagePreview || !imagePreviewImg || !image?.dataUrl) {
    return false;
  }
  pendingInputAssetPrompt = { kind: "image", paneId, image };
  if (title) title.textContent = "Image paste detected";
  const stamp = new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  titleInput.value = `Image ${stamp}`;
  meta.textContent = `${inputAssetFormatSize(image.size)} · ${image.width}×${image.height}`;
  if (preview) {
    preview.value = "";
    preview.hidden = true;
  }
  imagePreviewImg.src = image.dataUrl;
  imagePreview.hidden = false;
  if (pasteDirectBtn) pasteDirectBtn.hidden = true;
  overlay.hidden = false;
  titleInput.focus();
  titleInput.select();
  return true;
}

function closeInputAssetPrompt() {
  const overlay = $("inputAssetPromptOverlay");
  if (overlay) overlay.hidden = true;
  pendingInputAssetPrompt = null;
}

async function savePendingInputAsset(insertAfterSave = false) {
  if (!pendingInputAssetPrompt) return;
  const ws = selectedWorkspace();
  const titleInput = $("inputAssetPromptTitleInput");
  const preview = $("inputAssetPromptPreview");
  const { paneId } = pendingInputAssetPrompt;
  const content = preview && !preview.readOnly ? preview.value : pendingInputAssetPrompt.text;
  if (!ws?.path) {
    setStatus("Workspace path is required to save input assets.", true);
    return;
  }
  try {
    const source = {
      pane_id: paneId ?? null,
      session_id: paneId ? (state.paneSessions[paneId] ?? null) : null
    };
    const result = pendingInputAssetPrompt.kind === "image"
      ? await window.wincmux.inputAssetCreateImage(ws.path, {
        title: titleInput?.value || "Image asset",
        dataUrl: pendingInputAssetPrompt.image?.dataUrl ?? "",
        source
      })
      : await window.wincmux.inputAssetCreateText(ws.path, {
        title: titleInput?.value || defaultInputAssetTitle(content),
        content,
        source
      });
    closeInputAssetPrompt();
    setStatus(`Input asset saved: ${result?.asset?.title ?? "snippet"}`);
    if (insertAfterSave && paneId && result?.asset) {
      await writeTextToPaneChunked(paneId, inputAssetReferenceText(result.asset, ws.path));
    }
    const inputArea = $("wsInputAssets");
    if (inputArea && inputArea.style.display !== "none") {
      inputArea.style.display = "none";
      await loadInputAssets(ws);
    }
  } catch (err) {
    setStatus(String(err?.message ?? err), true);
  }
}

async function handlePanePasteText(paneId, text, options = {}) {
  if (!paneId || !text) return;
  if (!options.forceDirect && isLongPasteText(text) && showInputAssetPrompt({ paneId, text })) {
    return;
  }
  await writeTextToPaneChunked(paneId, text);
}

async function handlePaneClipboardPaste(paneId) {
  if (!paneId) return;
  const text = await window.wincmux.clipboardRead();
  if (text) {
    await handlePanePasteText(paneId, text);
    return;
  }
  if (typeof window.wincmux.clipboardReadImage !== "function") {
    return;
  }
  const image = await window.wincmux.clipboardReadImage();
  if (!image?.hasImage) {
    return;
  }
  if (image.tooLarge) {
    setStatus(`Clipboard image is too large: ${inputAssetFormatSize(image.size)}`, true);
    return;
  }
  showInputAssetImagePrompt({ paneId, image });
}

function renderInputAssetItem(asset, mode = "brief") {
  const brief = normalizeAssetMode(mode) === "brief";
  const icon = asset.type === "image" ? "Image" : "Text";
  const date = asset.created_at ? new Date(asset.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const actions = brief
    ? [
      ["view", "View"],
      ["insert", "Insert"],
      ["insert-path", "Path"],
      ["copy", "Copy"]
    ]
    : [
      ["view", "View"],
      ["insert", "Insert"],
      ["insert-path", "Path"],
      ["copy", "Copy"],
      ["rename", "Rename"],
      ["reveal", "Explorer"],
      ["delete", "Delete", "danger"]
    ];
  return `<div class="input-asset-item ${brief ? "input-asset-item-brief" : "input-asset-item-detail"}" data-input-asset-id="${htmlEscape(asset.id)}">
    <div class="input-asset-item-main">
      <div class="input-asset-row">
        <span class="input-asset-type">${icon}</span>
        <span class="input-asset-name" title="${htmlEscape(asset.title)}">${htmlEscape(asset.title)}</span>
        <span class="input-asset-meta input-asset-meta-inline">${htmlEscape(inputAssetFormatSize(asset.size))}</span>
      </div>
      <div class="input-asset-path" title="${htmlEscape(asset.relative_path)}">${htmlEscape(asset.relative_path)}</div>
      <div class="input-asset-preview" title="${htmlEscape(asset.preview)}">${htmlEscape(asset.preview || "-")}</div>
      <div class="input-asset-meta">${htmlEscape(inputAssetFormatSize(asset.size))}${date ? ` · ${htmlEscape(date)}` : ""}</div>
    </div>
    <div class="input-asset-actions">
      ${actions.map(([action, label, cls]) => `<button data-input-action="${action}"${cls ? ` class="${cls}"` : ""}>${label}</button>`).join("")}
    </div>
  </div>`;
}

function renderInputAssets(result, mode = storedAssetMode("input")) {
  const currentMode = normalizeAssetMode(mode);
  const assets = result?.assets ?? [];
  const textCount = assets.filter((asset) => asset.type === "text").length;
  const imageCount = assets.filter((asset) => asset.type === "image").length;
  const body = assets.length
    ? assets.map((asset) => renderInputAssetItem(asset, currentMode)).join("")
    : '<div class="input-asset-empty">No input assets yet. Long paste snippets and imported images will appear here.</div>';
  return `<div class="input-asset-toolbar">
    <div>
      <div class="input-asset-title">Input Assets</div>
      <div class="input-asset-subtitle">Saved in .wincmux/input-assets · text ${textCount} · images ${imageCount}</div>
    </div>
    <div class="input-asset-toolbar-actions">
      ${renderAssetModeToggle("input-action", currentMode)}
      <button data-input-action="new-text">New Text</button>
      <button data-input-action="import-image">Import Image</button>
      <button data-input-action="refresh">Refresh</button>
    </div>
  </div>
  <div class="input-assets-layout input-assets-${currentMode}">
    <div id="inputAssetBrowser" class="input-asset-browser">${body}</div>
    <div id="inputAssetViewer" class="input-asset-viewer">
      <div class="input-asset-viewer-empty">
        <div class="input-asset-viewer-empty-title">Select an input asset</div>
        <div>긴 텍스트는 전체 내용 확인 후 삽입하고, 이미지는 경로를 삽입합니다.</div>
      </div>
    </div>
  </div>`;
}

function currentInputAssetList() {
  const area = $("wsInputAssets");
  if (!area?.dataset.assets) return [];
  try {
    return JSON.parse(area.dataset.assets);
  } catch {
    return [];
  }
}

function findInputAsset(assetId) {
  return currentInputAssetList().find((asset) => asset.id === assetId);
}

async function loadInputAssets(ws) {
  const area = $("wsInputAssets");
  if (!area || !ws?.path) return;
  if (area.style.display !== "none" && area.dataset.wsId === ws.id) {
    area.style.display = "none";
    const panel = $("wsInfoPanel");
    if (panel) panel.classList.remove("ws-info-panel-input-assets");
    const summaryEl = $("wsSessionSummary");
    if (summaryEl) summaryEl.style.display = "";
    return;
  }
  const panel = $("wsInfoPanel");
  if (panel) {
    panel.classList.add("ws-info-panel-input-assets");
    requestAnimationFrame(() => {
      const rect = panel.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        panel.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
      }
    });
  }
  const summaryEl = $("wsSessionSummary");
  if (summaryEl) summaryEl.style.display = "none";
  const scanArea = $("wsScanArea");
  if (scanArea) scanArea.style.display = "none";
  const gitArea = $("wsGitSummary");
  if (gitArea) gitArea.style.display = "none";
  const agentArea = $("wsAgentAssets");
  if (agentArea) agentArea.style.display = "none";
  area.dataset.wsId = ws.id;
  area.style.display = "";
  area.innerHTML = '<div class="input-asset-loading">Loading input assets...</div>';
  try {
    const result = await window.wincmux.inputAssetsList(ws.path);
    area.dataset.assets = JSON.stringify(result?.assets ?? []);
    area.dataset.mode = area.dataset.mode || storedAssetMode("input");
    area.innerHTML = renderInputAssets(result, area.dataset.mode);
    area.onclick = (ev) => handleInputAssetClick(ev, ws);
    area.ondragover = (ev) => {
      ev.preventDefault();
      area.classList.add("drag-over");
    };
    area.ondragleave = () => area.classList.remove("drag-over");
    area.ondrop = async (ev) => {
      ev.preventDefault();
      area.classList.remove("drag-over");
      const file = ev.dataTransfer?.files?.[0];
      const filePath = file?.path;
      if (filePath) {
        await importInputAssetByPath(ws, filePath);
      } else {
        setStatus("Use Import Image for this file source.", true);
      }
    };
  } catch (err) {
    area.innerHTML = `<div class="input-asset-loading">Input assets unavailable: ${htmlEscape(String(err?.message ?? err))}</div>`;
  }
}

async function refreshInputAssets(ws) {
  const area = $("wsInputAssets");
  if (area) area.style.display = "none";
  await loadInputAssets(ws);
}

async function importInputAssetByPath(ws, filePath) {
  try {
    await window.wincmux.inputAssetImportFile(ws.path, { filePath, kind: "image" });
    setStatus("Image input asset imported");
    await refreshInputAssets(ws);
  } catch (err) {
    setStatus(String(err?.message ?? err), true);
  }
}

async function handleInputAssetClick(ev, ws) {
  const button = ev.target.closest("[data-input-action]");
  if (!button) return;
  const action = button.dataset.inputAction;
  if (action === "refresh") {
    await refreshInputAssets(ws);
    return;
  }
  if (action === "asset-mode") {
    const area = $("wsInputAssets");
    if (!area) return;
    area.dataset.mode = persistAssetMode("input", button.dataset.mode);
    area.innerHTML = renderInputAssets({ assets: currentInputAssetList() }, area.dataset.mode);
    return;
  }
  if (action === "new-text") {
    showInputAssetPrompt({ paneId: state.selectedPaneId, text: "" });
    const preview = $("inputAssetPromptPreview");
    if (preview) preview.readOnly = false;
    return;
  }
  if (action === "import-image") {
    try {
      const result = await window.wincmux.inputAssetPickFile(ws.path);
      if (result?.asset) {
        setStatus("Image input asset imported");
        await refreshInputAssets(ws);
      }
    } catch (err) {
      setStatus(String(err?.message ?? err), true);
    }
    return;
  }
  if (action === "save-viewer-title") {
    const viewer = $("inputAssetViewer");
    const input = viewer?.querySelector(".input-asset-title-edit");
    if (!viewer?.dataset.assetId || !input) return;
    await window.wincmux.inputAssetRename(ws.path, viewer.dataset.assetId, input.value).catch((err) => setStatus(String(err?.message ?? err), true));
    await refreshInputAssets(ws);
    return;
  }
  const itemEl = ev.target.closest("[data-input-asset-id]");
  const assetId = itemEl?.dataset.inputAssetId;
  const asset = assetId ? findInputAsset(assetId) : null;
  if (!asset) return;
  if (action === "view") {
    await openInputAssetViewer(ws, asset);
  } else if (action === "insert" || action === "insert-path") {
    const paneId = state.selectedPaneId;
    if (!paneId) {
      setStatus("Select a pane before inserting an input asset.", true);
      return;
    }
    const result = await window.wincmux.inputAssetRead(ws.path, asset.id);
    const text = inputAssetInsertText(result.asset, result.content, action === "insert-path" ? "path" : "reference", ws.path);
    await writeTextToPaneChunked(paneId, text);
    setStatus(action === "insert-path" ? "Input asset path inserted" : "Input asset work prompt inserted");
  } else if (action === "copy") {
    const result = await window.wincmux.inputAssetRead(ws.path, asset.id);
    const text = inputAssetInsertText(result.asset, result.content, "reference", ws.path);
    await window.wincmux.clipboardWrite(text).catch(() => {});
    setStatus("Input asset copied");
  } else if (action === "rename") {
    await openInputAssetViewer(ws, asset);
    const input = $("inputAssetViewer")?.querySelector(".input-asset-title-edit");
    input?.focus();
    input?.select();
  } else if (action === "reveal") {
    await window.wincmux.inputAssetReveal(ws.path, asset.id).catch((err) => setStatus(String(err?.message ?? err), true));
  } else if (action === "delete") {
    await window.wincmux.inputAssetDelete(ws.path, asset.id).catch((err) => setStatus(String(err?.message ?? err), true));
    setStatus("Input asset deleted");
    await refreshInputAssets(ws);
  }
}

async function openInputAssetViewer(ws, asset) {
  const viewer = $("inputAssetViewer");
  if (!viewer) return;
  viewer.dataset.assetId = asset.id;
  viewer.innerHTML = `<div class="input-asset-loading">Loading ${htmlEscape(asset.title)}...</div>`;
  try {
    const result = await window.wincmux.inputAssetRead(ws.path, asset.id);
    const row = result.asset;
    const preview = row.type === "image"
      ? `<div class="input-asset-image-wrap"><img src="${htmlEscape(result.data_url ?? "")}" alt="${htmlEscape(row.title)}" /></div>`
      : `<textarea class="input-asset-editor" readonly spellcheck="false">${htmlEscape(result.content ?? "")}</textarea>`;
    viewer.innerHTML = `<div class="input-asset-viewer-header">
      <div class="input-asset-viewer-title-group">
        <input class="input-asset-title-edit" value="${htmlEscape(row.title)}" />
        <div class="input-asset-viewer-meta">${htmlEscape(row.relative_path)} · ${htmlEscape(inputAssetFormatSize(row.size))}</div>
      </div>
      <div class="input-asset-viewer-actions">
        <button data-input-action="save-viewer-title">Save Title</button>
      </div>
    </div>${preview}`;
  } catch (err) {
    viewer.innerHTML = `<div class="input-asset-loading">Preview unavailable: ${htmlEscape(String(err?.message ?? err))}</div>`;
  }
}

function agentAssetDetailText(value) {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) return value.map((v) => typeof v === "object" ? JSON.stringify(v) : String(v)).join(", ");
  if (typeof value === "object") {
    return Object.entries(value).map(([k, v]) => `${k}: ${agentAssetDetailText(v)}`).join(" · ");
  }
  return String(value);
}

function agentAssetSummaryText(item) {
  const bits = [
    `[${AGENT_ASSET_CATEGORY_LABELS[item.category] ?? item.category}] ${item.relativePath}`,
    item.summary,
  ];
  if (item.lineCount != null) bits.push(`${item.lineCount} lines`);
  if (item.size) bits.push(`${item.size} bytes`);
  if (item.privateLocal) bits.push("local/private");
  if (item.large) bits.push("large preview-limited");
  if (item.invalid) bits.push(`warning: ${(item.warnings ?? []).join("; ") || "invalid"}`);
  const details = Object.entries(item.details ?? {})
    .map(([key, value]) => `${key}: ${agentAssetDetailText(value)}`)
    .filter((line) => !line.endsWith(": "));
  return bits.concat(details).join("\n");
}

function agentAssetProviders(item) {
  if (Array.isArray(item?.providers) && item.providers.length > 0) return item.providers;
  const rel = String(item?.relativePath ?? "").toLowerCase();
  if (rel === ".mcp.json") return ["shared"];
  if (rel.startsWith(".agents/") || rel.includes("agents.md")) return ["codex", "cursor", "kiro", "opencode"];
  if (rel.startsWith(".claude/") || rel.includes("claude.md")) return ["claude"];
  if (rel.startsWith(".gemini/") || rel.includes("gemini.md")) return ["gemini"];
  if (rel.startsWith(".cursor/") || rel === ".cursorrules") return ["cursor"];
  if (rel.startsWith(".kiro/")) return ["kiro"];
  if (rel.startsWith(".opencode/") || rel.startsWith("opencode.")) return ["opencode"];
  return ["shared"];
}

function filterAgentAssetsByProvider(items, providerId) {
  if (!providerId || providerId === "all") return items;
  return items.filter((item) => agentAssetProviders(item).includes(providerId));
}

function summarizeAgentAssetItems(items) {
  const summary = {};
  for (const category of Object.keys(AGENT_ASSET_CATEGORY_LABELS)) {
    const categoryItems = items.filter((item) => item.category === category);
    summary[category] = {
      count: categoryItems.filter((item) => item.exists).length,
      missing: categoryItems.filter((item) => !item.exists).length,
      invalid: categoryItems.filter((item) => item.invalid).length,
      large: categoryItems.filter((item) => item.large).length,
      local: categoryItems.filter((item) => item.privateLocal).length,
    };
  }
  return summary;
}

function renderAgentAssetProviderTabs(items, activeProvider) {
  const visibleItems = items.filter((item) => item.category !== "other");
  return AGENT_ASSET_PROVIDER_DEFS.map(({ id, label }) => {
    const scopedItems = filterAgentAssetsByProvider(visibleItems, id);
    const count = scopedItems.filter((item) => item.exists).length;
    const active = id === activeProvider ? " active" : "";
    return `<button class="agent-asset-scope-tab${active}" data-agent-action="provider-filter" data-provider="${id}">
      ${label} <span>${count}</span>
    </button>`;
  }).join("");
}

function renderAgentAssetSummaryCards(items) {
  const summary = summarizeAgentAssetItems(items);
  return Object.entries(AGENT_ASSET_CATEGORY_LABELS).map(([category, label]) => {
    const info = summary[category] ?? { count: 0, missing: 0, invalid: 0, large: 0, local: 0 };
    const warn = (info.missing || info.invalid || info.large) ? " warn" : "";
    const meta = [
      info.missing ? `missing ${info.missing}` : "",
      info.invalid ? `invalid ${info.invalid}` : "",
      info.large ? `large ${info.large}` : "",
      info.local ? `local ${info.local}` : "",
    ].filter(Boolean).join(" · ");
    return `<div class="agent-asset-card${warn}" data-agent-category="${category}">
      <div class="agent-asset-card-title">${label}</div>
      <div class="agent-asset-card-meta">${htmlEscape(meta || "ok")}</div>
      <div class="agent-asset-card-count">${info.count}</div>
    </div>`;
  }).join("");
}

function renderAgentAssetBadges(item) {
  const badges = [];
  if (!item.exists) badges.push(["missing", "Missing"]);
  if (item.invalid) badges.push(["invalid", "Invalid"]);
  if (item.large) badges.push(["large", "Large"]);
  if (item.privateLocal) badges.push(["local", "Local"]);
  badges.push([item.editable ? "editable" : "readonly", item.editable ? "Editable" : "Read only"]);
  return badges.map(([cls, text]) => `<span class="agent-asset-badge ${cls}">${text}</span>`).join("");
}

function renderAgentAssetItem(item, mode = "brief") {
  const brief = normalizeAssetMode(mode) === "brief";
  const providers = agentAssetProviders(item);
  const details = Object.entries(item.details ?? {})
    .map(([key, value]) => {
      const text = agentAssetDetailText(value);
      return text ? `<span title="${htmlEscape(text)}">${htmlEscape(key)}: ${htmlEscape(text)}</span>` : "";
    })
    .filter(Boolean)
    .join("");
  const warnings = (item.warnings ?? []).map((w) => `<div class="agent-asset-warning">${htmlEscape(w)}</div>`).join("");
  const viewLabel = item.exists ? "View" : "Create";
  const canCreate = !item.exists && item.editable;
  const canView = item.exists && !item.large;
  const actions = brief
    ? [
      [canCreate ? "create" : "view", viewLabel, canView || canCreate],
      ["insert-summary", "Insert", true],
      ["copy-path", "Path", true]
    ]
    : [
      [canCreate ? "create" : "view", viewLabel, canView || canCreate],
      ["copy-summary", "Copy Summary", true],
      ["insert-summary", "Insert", true],
      ["copy-path", "Copy Path", true],
      ["reveal", "Explorer", true]
    ];
  return `<div class="agent-asset-item ${brief ? "agent-asset-item-brief" : "agent-asset-item-detail"}${item.invalid ? " invalid" : ""}" data-path="${htmlEscape(item.relativePath)}">
    <div class="agent-asset-item-main">
      <div class="agent-asset-row">
        <span class="agent-asset-name">${htmlEscape(item.name)}</span>
        ${providers.map((provider) => `<span class="agent-asset-badge scope">${htmlEscape(AGENT_ASSET_PROVIDER_LABELS[provider] ?? provider)}</span>`).join("")}
        ${renderAgentAssetBadges(item)}
      </div>
      <div class="agent-asset-path" title="${htmlEscape(item.relativePath)}">${htmlEscape(item.relativePath)}</div>
      <div class="agent-asset-summary">${htmlEscape(item.summary)}</div>
      <div class="agent-asset-details">${details}</div>
      ${warnings}
    </div>
    <div class="agent-asset-actions">
      ${actions.map(([action, label, enabled]) => `<button data-agent-action="${action}" ${enabled ? "" : "disabled"}>${label}</button>`).join("")}
    </div>
  </div>`;
}

function renderAgentAssetList(result, activeProvider = "all", mode = storedAssetMode("agent")) {
  const currentMode = normalizeAssetMode(mode);
  const brief = currentMode === "brief";
  const visibleItems = (result.items ?? []).filter((item) => item.category !== "other");
  const scopedItems = filterAgentAssetsByProvider(visibleItems, activeProvider);
  const byCategory = {};
  for (const item of scopedItems) {
    (byCategory[item.category] ||= []).push(item);
  }
  const sections = Object.entries(AGENT_ASSET_CATEGORY_LABELS).map(([category, label]) => {
    const items = byCategory[category] ?? [];
    if (items.length === 0) {
      if (brief) return "";
      return `<section class="agent-asset-section">
        <div class="agent-asset-section-title">${label}</div>
        <div class="agent-asset-empty">No ${label.toLowerCase()} assets found.</div>
      </section>`;
    }
    return `<section class="agent-asset-section">
      <div class="agent-asset-section-title">${label} (${items.filter((i) => i.exists).length})</div>
      <div class="agent-asset-list">${items.map((item) => renderAgentAssetItem(item, currentMode)).join("")}</div>
    </section>`;
  }).join("");
  return `<div class="agent-asset-scope-tabs">${renderAgentAssetProviderTabs(visibleItems, activeProvider)}</div>
    ${brief ? "" : `<div class="agent-assets-grid">${renderAgentAssetSummaryCards(scopedItems)}</div>`}
    ${sections}`;
}

function agentAssetTemplateKind(relativePath) {
  if (/\.claude\/commands\//i.test(relativePath)) return "command";
  if (/\.claude\/rules\//i.test(relativePath) || /\.cursor\/rules\//i.test(relativePath) || /\.kiro\/steering\//i.test(relativePath)) return "rule";
  if (/GEMINI/i.test(relativePath)) return "gemini";
  if (/AGENTS/i.test(relativePath)) return "agents";
  return "claude";
}

async function loadAgentAssets(ws) {
  const area = $("wsAgentAssets");
  if (!area || !ws?.path) return;
  if (area.style.display !== "none" && area.dataset.wsId === ws.id) {
    area.style.display = "none";
    const panel = $("wsInfoPanel");
    if (panel) panel.classList.remove("ws-info-panel-agent-assets");
    const summaryEl = $("wsSessionSummary");
    if (summaryEl) summaryEl.style.display = "";
    return;
  }
  const panel = $("wsInfoPanel");
  if (panel) {
    panel.classList.remove("ws-info-panel-input-assets");
    panel.classList.add("ws-info-panel-agent-assets");
    requestAnimationFrame(() => {
      const rect = panel.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        panel.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
      }
    });
  }
  const summaryEl = $("wsSessionSummary");
  if (summaryEl) summaryEl.style.display = "none";
  const scanArea = $("wsScanArea");
  if (scanArea) scanArea.style.display = "none";
  const gitArea = $("wsGitSummary");
  if (gitArea) gitArea.style.display = "none";
  const inputArea = $("wsInputAssets");
  if (inputArea) inputArea.style.display = "none";
  area.dataset.wsId = ws.id;
  area.style.display = "";
  area.innerHTML = '<div class="agent-asset-loading">Scanning agent assets...</div>';
  try {
    const result = await window.wincmux.agentAssetsScan(ws.path);
    area.dataset.scan = JSON.stringify(result);
    area.dataset.provider = area.dataset.provider || "all";
    area.dataset.mode = area.dataset.mode || storedAssetMode("agent");
    area.innerHTML = `
      <div class="agent-asset-toolbar">
        <div>
          <div class="agent-asset-title">Agent Assets</div>
          <div class="agent-asset-subtitle">Provider registry 기반으로 Claude, Codex, Gemini, Cursor, Kiro, opencode 자산을 나눠 봅니다.</div>
        </div>
        <div class="agent-asset-toolbar-actions">
          ${renderAssetModeToggle("agent-action", area.dataset.mode)}
          <button data-agent-action="refresh">Refresh</button>
        </div>
      </div>
      <div class="agent-assets-layout agent-assets-${normalizeAssetMode(area.dataset.mode)}">
        <div id="agentAssetBrowser" class="agent-asset-browser">
          ${renderAgentAssetList(result, area.dataset.provider, area.dataset.mode)}
        </div>
        <div id="agentAssetViewer" class="agent-asset-viewer">
          <div class="agent-asset-viewer-empty">
            <div class="agent-asset-viewer-empty-title">Select an asset</div>
            <div>왼쪽에서 View를 누르면 여기에서 바로 읽거나 편집합니다.</div>
          </div>
        </div>
      </div>
    `;
    area.onclick = (ev) => handleAgentAssetClick(ev, ws);
  } catch (err) {
    area.innerHTML = `<div class="agent-asset-loading">Agent asset scan failed: ${htmlEscape(String(err?.message ?? err))}</div>`;
  }
}

function currentAgentAssetScan() {
  const area = $("wsAgentAssets");
  if (!area?.dataset.scan) return { items: [] };
  try {
    return JSON.parse(area.dataset.scan);
  } catch {
    return { items: [] };
  }
}

function findAgentAssetItem(relativePath) {
  return (currentAgentAssetScan().items ?? []).find((item) => item.relativePath === relativePath);
}

async function handleAgentAssetClick(ev, ws) {
  const button = ev.target.closest("[data-agent-action]");
  if (!button) return;
  const action = button.dataset.agentAction;
  if (action === "refresh") {
    const area = $("wsAgentAssets");
    if (area) area.style.display = "none";
    await loadAgentAssets(ws);
    return;
  }
  if (action === "asset-mode") {
    const area = $("wsAgentAssets");
    const browser = $("agentAssetBrowser");
    const layout = area?.querySelector(".agent-assets-layout");
    if (!area || !browser) return;
    area.dataset.mode = persistAssetMode("agent", button.dataset.mode);
    browser.innerHTML = renderAgentAssetList(currentAgentAssetScan(), area.dataset.provider || "all", area.dataset.mode);
    if (layout) {
      layout.classList.toggle("agent-assets-brief", area.dataset.mode === "brief");
      layout.classList.toggle("agent-assets-detail", area.dataset.mode === "detail");
    }
    const toolbar = area.querySelector(".asset-view-toggle");
    if (toolbar) {
      toolbar.outerHTML = renderAssetModeToggle("agent-action", area.dataset.mode);
    }
    return;
  }
  if (action === "provider-filter") {
    const area = $("wsAgentAssets");
    const browser = $("agentAssetBrowser");
    if (!area || !browser) return;
    area.dataset.provider = button.dataset.provider || "all";
    browser.innerHTML = renderAgentAssetList(currentAgentAssetScan(), area.dataset.provider, area.dataset.mode || storedAssetMode("agent"));
    return;
  }
  if (action === "save-asset") {
    const viewer = $("agentAssetViewer");
    const rel = viewer?.dataset.path;
    const editor = viewer?.querySelector("textarea");
    if (!rel || !editor) return;
    button.disabled = true;
    button.textContent = "Saving...";
    try {
      await window.wincmux.agentAssetWrite(ws.path, rel, editor.value);
      setStatus(`Agent asset saved: ${rel}`);
      const area = $("wsAgentAssets");
      if (area) area.style.display = "none";
      await loadAgentAssets(ws);
    } catch (err) {
      setStatus(String(err?.message ?? err), true);
      button.disabled = false;
      button.textContent = "Save";
    }
    return;
  }
  if (action === "copy-content") {
    const viewer = $("agentAssetViewer");
    const editor = viewer?.querySelector("textarea");
    if (editor) {
      await window.wincmux.clipboardWrite(editor.value).catch(() => {});
      setStatus("Agent asset content copied");
    }
    return;
  }
  if (action === "close-viewer") {
    const viewer = $("agentAssetViewer");
    if (viewer) viewer.style.display = "none";
    return;
  }

  const itemEl = ev.target.closest("[data-path]");
  const relativePath = itemEl?.dataset.path;
  const item = relativePath ? findAgentAssetItem(relativePath) : null;
  if (!item) return;

  if (action === "view") {
    await openAgentAssetViewer(ws, item);
  } else if (action === "create") {
    try {
      await window.wincmux.agentAssetCreate(ws.path, item.relativePath, agentAssetTemplateKind(item.relativePath));
      setStatus(`Agent asset created: ${item.relativePath}`);
      const area = $("wsAgentAssets");
      if (area) area.style.display = "none";
      await loadAgentAssets(ws);
      const created = findAgentAssetItem(item.relativePath);
      if (created) await openAgentAssetViewer(ws, created);
    } catch (err) {
      setStatus(String(err?.message ?? err), true);
    }
  } else if (action === "copy-summary") {
    await window.wincmux.clipboardWrite(agentAssetSummaryText(item)).catch(() => {});
    setStatus("Agent asset summary copied");
  } else if (action === "insert-summary") {
    const paneId = state.selectedPaneId;
    if (!paneId) {
      setStatus("Select a pane before inserting an asset summary.", true);
      return;
    }
    paneApi.writeToPane(paneId, agentAssetSummaryText(item));
    setStatus("Agent asset summary inserted");
  } else if (action === "copy-path") {
    await window.wincmux.clipboardWrite(item.relativePath).catch(() => {});
    setStatus("Agent asset path copied");
  } else if (action === "reveal") {
    await window.wincmux.agentAssetReveal(ws.path, item.relativePath).catch((err) => setStatus(String(err?.message ?? err), true));
  }
}

async function openAgentAssetViewer(ws, item) {
  const viewer = $("agentAssetViewer");
  if (!viewer) return;
  viewer.dataset.path = item.relativePath;
  viewer.innerHTML = `<div class="agent-asset-loading">Loading ${htmlEscape(item.relativePath)}...</div>`;
  try {
    const result = await window.wincmux.agentAssetRead(ws.path, item.relativePath);
    const content = result?.content ?? "";
    viewer.innerHTML = `<div class="agent-asset-viewer-header">
      <div>
        <div class="agent-asset-viewer-title">${htmlEscape(item.relativePath)}</div>
        <div class="agent-asset-viewer-meta">${item.editable ? "Editable" : "Read-only"} · ${content.length.toLocaleString()} chars</div>
      </div>
      <div class="agent-asset-viewer-actions">
        <button data-agent-action="copy-content">Copy</button>
        ${item.editable ? '<button data-agent-action="save-asset">Save</button>' : ""}
        <button data-agent-action="close-viewer">Close</button>
      </div>
    </div>
    <textarea class="agent-asset-editor" ${item.editable ? "" : "readonly"} spellcheck="false">${htmlEscape(content)}</textarea>`;
  } catch (err) {
    viewer.innerHTML = `<div class="agent-asset-loading">Preview unavailable: ${htmlEscape(String(err?.message ?? err))}</div>`;
  }
}

function openWsInfoPanel(ws, anchorEl) {
  const overlay = $("wsInfoOverlay");
  const panel = $("wsInfoPanel");
  const titleEl = $("wsInfoTitle");
  const descInput = $("wsDescInput");
  const summaryEl = $("wsSessionSummary");
  if (!overlay || !panel) return;

  panel.classList.remove("ws-info-panel-agent-assets", "ws-info-panel-input-assets");
  titleEl.textContent = ws.name;
  descInput.value = ws.description ?? "";
  overlay.style.display = "";

  // Quick action buttons
  const qaEl = $("wsQuickActions");
  if (qaEl) {
    qaEl.innerHTML = "";
    const actions = [
      { label: "Explorer", title: "Open in File Explorer", fn: () => window.wincmux.openInExplorer(ws.path).catch((e) => setStatus(String(e), true)) },
      { label: "VSCode",   title: "Open in VSCode",        fn: () => window.wincmux.openInVscode(ws.path).catch((e) => setStatus(String(e), true)) },
      { label: "Git",      title: "Show git log & status", fn: () => loadGitSummary(ws) },
      { label: "Agent Assets", title: "Inspect Claude/Codex workspace assets", fn: () => loadAgentAssets(ws) },
      { label: "Input Assets", title: "Manage long paste snippets and image paths", fn: () => loadInputAssets(ws) },
      { label: "+ Terminal",  title: "New PTY in selected pane", fn: () => { closeWsInfoPanel(); startSessionForPane(state.selectedPaneId, { force: true, workspaceId: ws.id }).catch((e) => setStatus(String(e), true)); } },
    ];
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.className = "ws-quick-btn";
      btn.textContent = a.label;
      btn.title = a.title;
      btn.addEventListener("click", a.fn);
      qaEl.appendChild(btn);
    }
  }

  // Position popup to the right of the anchor (workspace list item)
  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const panelW = 640;
    const margin = 6;
    let left = rect.right + margin;
    let top = rect.top;
    // If overflows right edge of viewport, flip left
    if (left + panelW > window.innerWidth - 8) {
      left = rect.left - panelW - margin;
    }
    // Clamp top so panel doesn't go off bottom (panel height is dynamic, use 80vh estimate)
    const maxTop = window.innerHeight - Math.min(720, window.innerHeight * 0.9) - 8;
    if (top > maxTop) top = maxTop;
    if (top < 8) top = 8;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  // Reset scan + git areas on open
  const scanArea = $("wsScanArea");
  if (scanArea) { scanArea.style.display = "none"; scanArea.innerHTML = ""; }
  const gitArea = $("wsGitSummary");
  if (gitArea) { gitArea.style.display = "none"; gitArea.innerHTML = ""; }
  const agentArea = $("wsAgentAssets");
  if (agentArea) { agentArea.style.display = "none"; agentArea.innerHTML = ""; agentArea.dataset.wsId = ""; agentArea.dataset.scan = ""; agentArea.dataset.provider = "all"; }
  const inputArea = $("wsInputAssets");
  if (inputArea) { inputArea.style.display = "none"; inputArea.innerHTML = ""; inputArea.dataset.wsId = ""; inputArea.dataset.assets = ""; }
  summaryEl.style.display = "";

  // Load session summary
  summaryEl.innerHTML = '<span class="ws-summary-loading">Loading...</span>';
  Promise.all([
    rpc("ai.sessions", { workspace_id: ws.id }).catch(() => ({ sessions: [] })),
    rpc("session.list", { workspace_id: ws.id }).catch(() => ({ sessions: [] }))
  ]).then(([aiRes, sessionRes]) => {
    const allAi = aiRes?.sessions ?? [];
    const claudeSessions = allAi.filter((s) => s.tool === "claude");
    const codexSessions  = allAi.filter((s) => s.tool === "codex");
    const runningPty = (sessionRes?.sessions ?? []).filter((s) => s.status === "running" && s.spawn_cmd);

    const renderAiCard = (label, sessions) => {
      const items = sessions.slice(0, 8).map((ai) => {
        const d = new Date(ai.detected_at);
        const timeStr = d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
                        d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const cwd = ai.cwd ? ai.cwd.replace(/\\/g, "/") : "";
        const resumeEsc = ai.resume_cmd.replace(/"/g, "&quot;");
        return `<div class="ws-ai-item">
          <button class="ws-ai-copy-btn" data-copy="${resumeEsc}" title="Copy to clipboard: ${resumeEsc}">
            <span class="ws-ai-resume">${ai.resume_cmd}</span>
            <span class="ws-ai-copy-icon">Copy</span>
          </button>
          <div class="ws-ai-meta-row">
            <span class="ws-ai-cwd" title="${cwd}">${cwd || "-"}</span>
            <span class="ws-ai-time">${timeStr}</span>
          </div>
        </div>`;
      }).join("");
      const more = sessions.length > 8 ? `<div class="ws-summary-more">+ ${sessions.length - 8} more</div>` : "";
      const body = sessions.length === 0 ? '<div class="ws-section-none">none</div>' : items + more;
      return `<div class="ws-section-card">
        <div class="ws-section-card-title">${label} (${sessions.length})</div>
        <div class="ws-section-card-body">${body}</div>
      </div>`;
    };

    let html = `<div class="ws-dashboard-grid">
      ${renderAiCard("Claude", claudeSessions)}
      ${renderAiCard("Codex", codexSessions)}
    </div>`;

    if (runningPty.length > 0) {
      // Build reverse map: session_id ??pane_id
      const sessionToPane = {};
      for (const [paneId, sid] of Object.entries(state.paneSessions)) {
        sessionToPane[sid] = paneId;
      }
      const leafIds = leafPanes().map((p) => p.pane_id);

      const ptyItems = runningPty.map((s) => {
        let label = s.spawn_cmd ?? "shell";
        try {
          const args = JSON.parse(s.spawn_args ?? "[]");
          const meaningful = args.filter((a) => !a.startsWith("-No") && !a.startsWith("chcp") && !a.startsWith("$Output") && !a.startsWith("[Console]"));
          if (meaningful.length > 0) label = `${s.spawn_cmd} ${meaningful.join(" ")}`.trim();
        } catch { /* */ }
        const paneId = sessionToPane[s.id] ?? null;
        const paneName = s.id.slice(0, 8);
        const startedD = new Date(s.started_at);
        const startedStr = startedD.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
                           startedD.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return `<div class="ws-summary-item">
          <span class="ws-summary-dot"></span>
          <span class="ws-summary-pane-name" title="session ${s.id}">${paneName}</span>
          <span class="ws-summary-cmd" title="${label}">${label}</span>
          <span class="ws-summary-meta-pair"><span class="ws-summary-pid">pid ${s.pid}</span><span class="ws-summary-time">${startedStr}</span></span>
          <button class="ws-pty-kill-btn" data-sid="${s.id}" data-pane-id="${paneId ?? ""}" title="Close pane &amp; kill session (pid ${s.pid})">X</button>
        </div>`;
      }).join("");
      html += `<div class="ws-summary-section">
        <div class="ws-summary-label">Running PTY (${runningPty.length})</div>
        ${ptyItems}
      </div>`;
    }

    html += `<button class="ws-scan-btn" id="wsScanBtn">Scan long files (&gt;1000 lines)</button>`;

    summaryEl.innerHTML = html;

    // Event delegation for copy + kill buttons
    summaryEl.addEventListener("click", async (ev) => {
      const copyBtn = ev.target.closest("[data-copy]");
      if (copyBtn) {
        const text = copyBtn.dataset.copy;
        await window.wincmux.clipboardWrite(text).catch(() => {});
        const icon = copyBtn.querySelector(".ws-ai-copy-icon");
        if (icon) {
          icon.textContent = "Copied";
          setTimeout(() => {
            icon.textContent = "Copy";
          }, 1200);
        }
        return;
      }
      const killBtn = ev.target.closest("[data-sid]");
      if (killBtn) {
        const sid = killBtn.dataset.sid;
        const paneId = killBtn.dataset.paneId || null;
        killBtn.textContent = "Closing...";
        killBtn.disabled = true;
        try {
          if (paneId && leafPanes().length > 1 && leafPanes().some((p) => p.pane_id === paneId)) {
            // Close the pane (which also closes the session internally)
            await onClosePane(paneId);
          } else {
            // No linked pane (or last pane) ??just kill the session
            await rpc("session.close", { session_id: sid });
          }
          // Remove item from DOM
          const item = killBtn.closest(".ws-summary-item");
          if (item) {
            item.remove();
            const section = summaryEl.querySelector(".ws-summary-section");
            if (section && section.querySelectorAll(".ws-summary-item").length === 0) {
              section.remove();
            }
          }
        } catch (err) {
          killBtn.textContent = "Re-run";
          killBtn.disabled = false;
          setStatus(String(err?.message ?? err), true);
        }
      }
    });

    const scanBtn = summaryEl.querySelector("#wsScanBtn");
    if (scanBtn) scanBtn.addEventListener("click", () => handleWsScan(ws, scanBtn));
  });

  // Description auto-save
  descInput.oninput = () => {
    clearTimeout(wsDescSaveTimer);
    wsDescSaveTimer = setTimeout(() => {
      ws.description = descInput.value;
      rpc("workspace.describe", { id: ws.id, description: descInput.value }).catch(() => {});
    }, 500);
  };
  const stopProp = (ev) => ev.stopPropagation();
  for (const type of ["keydown", "keyup", "paste", "cut", "copy"]) {
    descInput.addEventListener(type, stopProp);
  }
}

function closeWsInfoPanel() {
  const overlay = $("wsInfoOverlay");
  if (overlay) overlay.style.display = "none";
}

async function loadGitSummary(ws) {
  const gitArea = $("wsGitSummary");
  if (!gitArea || !ws?.path) return;
  const agentArea = $("wsAgentAssets");
  if (agentArea) agentArea.style.display = "none";
  const inputArea = $("wsInputAssets");
  if (inputArea) inputArea.style.display = "none";
  const panel = $("wsInfoPanel");
  if (panel) panel.classList.remove("ws-info-panel-agent-assets", "ws-info-panel-input-assets");
  const summaryEl = $("wsSessionSummary");
  if (summaryEl) summaryEl.style.display = "";

  // Toggle off if already shown
  if (gitArea.style.display !== "none" && gitArea.dataset.wsId === ws.id) {
    gitArea.style.display = "none";
    return;
  }

  gitArea.dataset.wsId = ws.id;
  gitArea.style.display = "";
  gitArea.innerHTML = '<div class="ws-git-loading">Loading git info...</div>';

  try {
    const info = await window.wincmux.gitInfo(ws.path);
    let html = "";

    if (info.branch) {
      html += `<div class="ws-git-branch">Branch: ${info.branch}</div>`;
    }

    if (info.dirty_files.length > 0) {
      html += `<div class="ws-git-section-label">Changed files (${info.dirty_files.length})</div>`;
      html += '<div class="ws-git-file-list">';
      for (const line of info.dirty_files.slice(0, 20)) {
        const status = line.slice(0, 2).trim();
        const file = line.slice(3);
        const cls = status === "M" || status === "MM" ? "ws-git-modified"
                  : status === "??" ? "ws-git-untracked"
                  : status === "D"  ? "ws-git-deleted"
                  : status === "A"  ? "ws-git-added" : "";
        html += `<div class="ws-git-file ${cls}"><span class="ws-git-status">${status || "?"}</span><span class="ws-git-path" title="${file}">${file}</span></div>`;
      }
      if (info.dirty_files.length > 20) {
        html += `<div class="ws-summary-more">+ ${info.dirty_files.length - 20} more</div>`;
      }
      html += "</div>";
    } else if (info.branch) {
      html += '<div class="ws-git-clean">Working tree clean</div>';
    }

    if (info.recent_commits.length > 0) {
      html += `<div class="ws-git-section-label">Recent commits</div>`;
      html += '<div class="ws-git-commit-list">';
      for (const line of info.recent_commits) {
        const sha = line.slice(0, 7);
        const msg = line.slice(8);
        html += `<div class="ws-git-commit"><span class="ws-git-sha">${sha}</span><span class="ws-git-msg" title="${msg}">${msg}</span></div>`;
      }
      html += "</div>";
    }

    if (!html) {
      const hint = info.debug_error ? `<div class="ws-git-error-detail">${info.debug_error}</div>` : "";
      html = `<div class="ws-git-loading">Not a git repository (.git folder not found)</div>${hint}`;
    }

    gitArea.innerHTML = html;
  } catch (err) {
    gitArea.innerHTML = `<div class="ws-git-loading">Git info unavailable</div>`;
  }
}

async function handleWsScan(ws, scanBtn) {
  const scanArea = $("wsScanArea");
  if (!scanArea || !ws?.path) return;
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning...";
  scanArea.style.display = "";
  scanArea.innerHTML = '<div class="ws-scan-empty">Scanning...</div>';
  try {
    const result = await window.wincmux.scanLongFiles(ws.path, 1000);
    const files = result?.files ?? [];
    if (files.length === 0) {
      scanArea.innerHTML = '<div class="ws-scan-empty">No files over 1000 lines found.</div>';
    } else {
      const cap = files.length === 50 ? ", capped at 50" : "";
      let html = `<div class="ws-summary-label">Long files (${files.length}${cap})</div>`;
      for (const f of files) {
        html += `<div class="ws-scan-item">
          <span class="ws-scan-path" title="${f.relativePath}">${f.relativePath}</span>
          <span class="ws-scan-count">${f.lineCount.toLocaleString()}</span>
        </div>`;
      }
      scanArea.innerHTML = html;
    }
  } catch (err) {
    scanArea.innerHTML = `<div class="ws-scan-empty">Scan failed: ${String(err?.message ?? err)}</div>`;
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = "Scan long files (>1000 lines)";
  }
}

function bindWsInfoPanel() {
  const closeBtn = $("wsInfoCloseBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeWsInfoPanel();
    });
  }
  const overlay = $("wsInfoOverlay");
  if (overlay) {
    // Click on backdrop (overlay itself, not the panel) closes it
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) closeWsInfoPanel();
    });
  }
}

globalThis.openWsInfoPanel = openWsInfoPanel;

function bindInputAssetPrompt() {
  $("inputAssetPromptCloseBtn")?.addEventListener("click", () => closeInputAssetPrompt());
  $("inputAssetPasteDirectBtn")?.addEventListener("click", () => {
    const pending = pendingInputAssetPrompt;
    closeInputAssetPrompt();
    if (pending?.paneId && pending.text) {
      writeTextToPaneChunked(pending.paneId, pending.text).catch((err) => setStatus(String(err?.message ?? err), true));
    }
  });
  $("inputAssetSaveOnlyBtn")?.addEventListener("click", () => {
    savePendingInputAsset(false).catch((err) => setStatus(String(err?.message ?? err), true));
  });
  $("inputAssetSaveInsertBtn")?.addEventListener("click", () => {
    savePendingInputAsset(true).catch((err) => setStatus(String(err?.message ?? err), true));
  });
  $("inputAssetPromptOverlay")?.addEventListener("click", (ev) => {
    if (ev.target === $("inputAssetPromptOverlay")) closeInputAssetPrompt();
  });
  for (const id of ["inputAssetPromptTitleInput", "inputAssetPromptPreview"]) {
    const el = $(id);
    if (!el) continue;
    for (const type of ["keydown", "keyup", "paste", "cut", "copy"]) {
      el.addEventListener(type, (ev) => ev.stopPropagation());
    }
  }
}

// ?? Workspace Notepad ??????????????????????????????????????????
let notepadSaveTimer = null;

function loadNotepadForWorkspace(workspaceId) {
  const el = document.getElementById("workspaceNotepad");
  if (!el) return;
  el.value = workspaceId ? (state.workspaceNotes[workspaceId] ?? "") : "";
}

function saveNotepadForWorkspace(workspaceId, text) {
  if (!workspaceId) return;
  state.workspaceNotes[workspaceId] = text;
  localStorage.setItem(STORAGE_KEYS.workspaceNotes, JSON.stringify(state.workspaceNotes));
}

function bindNotepadEvents() {
  const el = document.getElementById("workspaceNotepad");
  if (!el) return;
  el.addEventListener("input", () => {
    const wsId = state.selectedWorkspaceId;
    if (!wsId) return;
    clearTimeout(notepadSaveTimer);
    notepadSaveTimer = setTimeout(() => saveNotepadForWorkspace(wsId, el.value), 400);
  });
  // Prevent IME / key events from leaking to pane shortcuts
  const stopProp = (ev) => ev.stopPropagation();
  for (const type of ["keydown", "keyup", "paste", "cut", "copy"]) {
    el.addEventListener(type, stopProp);
  }
}

function bindEvents() {
  toggleWorkspaceCreateBtn?.addEventListener("click", () => toggleWorkspaceCreate());
  workspaceCompactBtn?.addEventListener("click", () => setWorkspaceListMode("compact"));
  workspaceDetailBtn?.addEventListener("click", () => setWorkspaceListMode("detail"));
  $("createWorkspaceBtn").addEventListener("click", () =>
    onCreateWorkspace().catch((err) => setStatus(String(err), true)),
  );
  $("deleteWorkspaceBtn")?.addEventListener("click", () =>
    onDeleteWorkspace().catch((err) => setStatus(String(err), true)),
  );
  $("pickFolderBtn").addEventListener("click", () =>
    onPickFolder().catch((err) => setStatus(String(err), true)),
  );
  $("openInVscodeBtn")?.addEventListener("click", () =>
    onOpenInVscode().catch((err) => setStatus(String(err), true)),
  );
  $("refreshUnreadBtn").addEventListener("click", () =>
    loadUnread().catch((err) => setStatus(String(err), true)),
  );
  $("markLatestReadBtn").addEventListener("click", () =>
    onMarkWorkspaceRead().catch((err) => setStatus(String(err), true)),
  );
  $("clearUnreadBtn").addEventListener("click", () =>
    onClearUnread().catch((err) => setStatus(String(err), true)),
  );
  notificationList.addEventListener("scroll", () => renderNotifications());
  notificationList.addEventListener("click", (event) =>
    onNotificationClick(event).catch((err) => setStatus(String(err), true)),
  );
  toggleWorkspacePanelBtn.addEventListener("click", () =>
    toggleWorkspacePanel(),
  );
  toggleNotificationPanelBtn.addEventListener("click", () =>
    toggleNotificationPanel(),
  );
  if (equalizePanesBtn) {
    equalizePanesBtn.addEventListener("click", () => {
      paneApi.equalizePaneSizes();
      setStatus("Pane sizes equalized");
    });
  }
  shortcutHelpBtn?.addEventListener("click", () => toggleShortcutHelp());
  shortcutCloseBtn?.addEventListener("click", () => hideShortcutHelp());
  shortcutOverlay?.addEventListener("click", (ev) => {
    if (ev.target === shortcutOverlay) {
      hideShortcutHelp();
    }
  });
  if (fontScaleSelect) {
    fontScaleSelect.addEventListener("change", () => {
      const scale = Number(fontScaleSelect.value);
      if (scale) {
        paneApi.setGlobalFontScale(scale);
      }
    });
  }
  if (fontScaleResetBtn) {
    fontScaleResetBtn.addEventListener("click", () => {
      paneApi.setGlobalFontScale(100, { resetPerPane: true });
      setStatus("Font sizes reset to default");
    });
  }
  bindWsInfoPanel();
  bindInputAssetPrompt();
  bindKeyboardShortcuts();
}

const FONT_SCALE_STEPS = [80, 85, 90, 95, 100, 110, 120];

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (ev) => {
    if (ev.isComposing || ev.key === "Process") {
      return;
    }
    const ctrl = ev.ctrlKey || ev.metaKey;
    const shift = ev.shiftKey;
    const alt = ev.altKey;

    if (ev.key === "Escape" && shortcutOverlay && !shortcutOverlay.hidden) {
      ev.preventDefault();
      hideShortcutHelp();
      return;
    }

    const inputAssetOverlay = $("inputAssetPromptOverlay");
    if (ev.key === "Escape" && inputAssetOverlay && !inputAssetOverlay.hidden) {
      ev.preventDefault();
      closeInputAssetPrompt();
      return;
    }

    if (ev.key === "Escape" && state.paneMove?.sourcePaneId) {
      ev.preventDefault();
      cancelPaneMoveMode();
      return;
    }

    if (ctrl && !alt && !shift && ev.code === "Slash") {
      ev.preventDefault();
      toggleShortcutHelp();
      return;
    }

    // Skip if focus is inside a text input / textarea (but NOT xterm canvas)
    const tag = document.activeElement?.tagName;
    const inXterm = Boolean(document.activeElement?.closest?.(".xterm"));
    if ((tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") && !inXterm) return;

    // Ctrl+Tab / Ctrl+Shift+Tab — move focus between terminal panes.
    if (ctrl && ev.key === "Tab") {
      ev.preventDefault();
      paneApi.selectAdjacentPane(shift ? -1 : 1, { focusTerm: true }).catch((err) => setStatus(String(err?.message ?? err), true));
      return;
    }

    if (ctrl && alt && !shift) {
      const arrowMap = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down"
      };
      if (arrowMap[ev.key]) {
        ev.preventDefault();
        paneApi.selectPaneByDirection(arrowMap[ev.key], { focusTerm: true }).catch((err) => setStatus(String(err?.message ?? err), true));
        return;
      }
      if (ev.code === "Backslash") {
        ev.preventDefault();
        runPaneShortcut((paneId) => onSplit(paneId, "horizontal"));
        return;
      }
      if (ev.code === "Minus" || ev.code === "NumpadSubtract") {
        ev.preventDefault();
        runPaneShortcut((paneId) => onSplit(paneId, "vertical"));
        return;
      }
      if (ev.key.toLowerCase() === "t") {
        ev.preventDefault();
        runPaneShortcut((paneId) => startSessionForPane(paneId, { focusTerm: true }));
        return;
      }
      if (ev.key.toLowerCase() === "r") {
        ev.preventDefault();
        runPaneShortcut((paneId) => startSessionForPane(paneId, { force: true, focusTerm: true }));
        return;
      }
      if (ev.key.toLowerCase() === "w") {
        ev.preventDefault();
        runPaneShortcut((paneId) => onHidePane(paneId));
        return;
      }
      if (ev.key.toLowerCase() === "q") {
        ev.preventDefault();
        runPaneShortcut((paneId) => onClosePane(paneId));
        return;
      }
      if (ev.key.toLowerCase() === "m") {
        ev.preventDefault();
        const paneId = selectedPaneForShortcut();
        if (paneId) {
          paneApi.togglePaneOverflowMenu(paneId);
        }
        return;
      }
      if (ev.key.toLowerCase() === "p") {
        ev.preventDefault();
        runPaneShortcut((paneId) => startPaneMove(paneId));
        return;
      }
    }

    // Ctrl+B — toggle Workspace panel
    if (ctrl && !shift && ev.key === "b") {
      ev.preventDefault();
      toggleWorkspacePanel();
      return;
    }

    // Ctrl+Shift+N — toggle Notifications panel
    if (ctrl && shift && ev.key === "N") {
      ev.preventDefault();
      toggleNotificationPanel();
      return;
    }

    // Ctrl+Shift+H — toggle Hidden Panes popover
    if (ctrl && shift && ev.key === "H") {
      ev.preventDefault();
      hiddenPanesBtn?.click();
      return;
    }

    // Ctrl+Shift+E — equalize panes
    if (ctrl && shift && ev.key === "E") {
      ev.preventDefault();
      paneApi.equalizePaneSizes();
      setStatus("Pane sizes equalized");
      return;
    }

    // Ctrl+= or Ctrl+Shift+= — font scale up (next step)
    if (ctrl && (ev.code === "Equal" || ev.code === "NumpadAdd")) {
      ev.preventDefault();
      const cur = state.globalFontScale;
      const next = FONT_SCALE_STEPS.find((s) => s > cur) ?? FONT_SCALE_STEPS.at(-1);
      paneApi.setGlobalFontScale(next);
      return;
    }

    // Ctrl+- or Ctrl+Shift+- — font scale down (prev step)
    if (ctrl && (ev.code === "Minus" || ev.code === "NumpadSubtract")) {
      ev.preventDefault();
      const cur = state.globalFontScale;
      const prev = [...FONT_SCALE_STEPS].reverse().find((s) => s < cur) ?? FONT_SCALE_STEPS[0];
      paneApi.setGlobalFontScale(prev);
      return;
    }

    // Ctrl+0 — font scale reset
    if (ctrl && !shift && ev.code === "Digit0") {
      ev.preventDefault();
      paneApi.setGlobalFontScale(100, { resetPerPane: true });
      setStatus("Font sizes reset to default");
      return;
    }
  });
}
async function bootstrap() {
  try {
    bindRuntimeErrorHooks();
    assertRendererContracts();
    state.refreshUnreadHook = loadUnread;
    applyPanelWidths();
    applyPanelVisibility();
    initResizeHandles(() => paneApi.fitAllPanes());
    bindEvents();
    // Restore saved font scale selection
    if (fontScaleSelect) {
      fontScaleSelect.value = String(state.globalFontScale);
    }
    bindNotepadEvents();
    loadNotepadForWorkspace(state.selectedWorkspaceId);
    const paneHandlersBound = paneApi.setPaneHandlers({
      startSessionForPane,
      closeSessionForPane,
      splitPane: (paneId, direction) => onSplit(paneId, direction),
      closePane: (paneId) => onClosePane(paneId),
      hidePane: (paneId) => onHidePane(paneId),
      adjustPaneFont: (paneId, delta) => onAdjustPaneFont(paneId, delta),
      insertQuickCommand: (paneId, text) => onInsertQuickCommand(paneId, text),
      markPaneNotificationsRead: (paneId) => markPaneNotificationsRead(paneId),
      startPaneMove: (paneId) => startPaneMove(paneId),
      swapPanePositions: (firstPaneId, secondPaneId) => swapPanePositions(firstPaneId, secondPaneId),
      movePaneToPlacement: (sourcePaneId, targetPaneId, placement) => movePaneToPlacement(sourcePaneId, targetPaneId, placement),
      movePaneToGroup: (paneId, groupId) => movePaneToGroup(paneId, groupId),
      openSessionInSplit: (paneId, session, direction) => openSessionInSplit(paneId, session, direction),
    });
    if (!paneHandlersBound) {
      setStatus("Pane module unavailable. Terminal controls are limited.", true, { priority: 85, holdMs: 12000 });
    }
    hiddenSetPaneHandlers({
      restoreHiddenPane: (hiddenId, direction) =>
        onRestoreHiddenPane(hiddenId, direction),
      terminateHiddenPane: (hiddenId) => onTerminateHiddenPane(hiddenId),
    });
    hiddenBindPaneUi();
    hiddenRefreshPanesUi();
    state.streamUnbind = window.wincmux.onStreamEvent(handleStreamEvent);
    state.contextUnbind = window.wincmux.onContextAction(handleContextAction);
    if (typeof window.wincmux?.onNotificationOpen === "function") {
      state.notificationOpenUnbind = window.wincmux.onNotificationOpen(({ notification_id, notification }) => {
        void openNotificationById(notification_id, notification).catch((err) => setStatus(String(err), true));
      });
    }
    if (typeof window.wincmux?.onCoreStatus === "function") {
      window.wincmux.onCoreStatus(({ status, error }) => {
        if (status === "respawning") {
          setStatus("Core restarting...", false);
        } else if (status === "ready") {
          setStatus("Core reconnected", false);
          if (state.selectedWorkspaceId) {
            void runWorkspaceTransition(state.selectedWorkspaceId, { reason: "core_ready", forceLayout: false, autoSession: true });
          }
        } else if (status === "dead") {
          setStatus(`Core failed: ${error ?? "unknown"}`, true);
        }
      });
    }
    const rememberedPath =
      localStorage.getItem(STORAGE_KEYS.lastWorkspacePath) ?? "C:\\";
    wsPathInput.value = rememberedPath;
    await loadWorkspaces();
    if (state.workspaces.length === 0) {
      wsNameInput.value = "workspace-1";
      await onCreateWorkspace();
    } else if (state.selectedWorkspaceId) {
      await switchWorkspace(state.selectedWorkspaceId);
    }
    window.addEventListener("resize", () => paneApi.fitAllPanes());
    window.addEventListener("focus", () => {
      void syncActiveContext();
    });
    window.addEventListener("blur", () => {
      void syncActiveContext();
    });
    await syncActiveContext();
    setStatus("Ready");
  } catch (err) {
    setStatus(`Error: ${err.message ?? err}`, true);
  }
}
window.addEventListener("beforeunload", () => {
  state.refreshUnreadHook = null;
  void updateUnreadBadge(0);
  for (const workspaceId of Object.keys(state.hiddenPanesByWorkspace)) {
    const hiddenRows = hiddenListPanesForWorkspace(workspaceId);
    for (const row of hiddenRows) {
      void rpc("session.close", { session_id: row.session_id }).catch(() => {});
    }
  }
  clearPromptDetectorAll();
  if (state.streamUnbind) {
    state.streamUnbind();
    state.streamUnbind = null;
  }
  if (state.contextUnbind) {
    state.contextUnbind();
    state.contextUnbind = null;
  }
  if (state.notificationOpenUnbind) {
    state.notificationOpenUnbind();
    state.notificationOpenUnbind = null;
  }
  if (state.streamSubscriptionId) {
    void window.wincmux
      .streamUnsubscribe(state.streamSubscriptionId)
      .catch(() => {});
    state.streamSubscriptionId = null;
  }
  disposeAllViews();
});
// Expose functions needed by renderer.panes.js (loaded before this file)
globalThis.loadSessions = loadSessions;
globalThis.handlePanePasteText = handlePanePasteText;
globalThis.handlePaneClipboardPaste = handlePaneClipboardPaste;

bootstrap();
