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
  }
};

const workspaceTransition = {
  transitionSeq: 0,
  activeTransitionSeq: 0,
  activeWorkspaceId: null,
  switchInFlight: false
};

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
  if (event.method !== "session.output") {
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
    void window.wincmux.clipboardRead().then((text) => {
      if (text) {
        paneApi.writeToPane(paneId, text);
      }
    });
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
}

async function openNotificationById(notificationId) {
  if (!notificationId) {
    return;
  }
  const row = state.notifications.find((item) => item.id === notificationId);
  if (!row) {
    await loadUnread();
  }
  const resolved = state.notifications.find((item) => item.id === notificationId);
  if (!resolved) {
    return;
  }

  await rpc("notify.mark_read", { notification_id: notificationId });
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
  }
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
    transitionSeq = null
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
  let created;
  try {
    if (cmd) {
      created = await rpc("session.run", {
        workspace_id: workspaceId,
        cmd,
        args: args ?? [],
        cwd: cwd ?? ws.path,
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
  state.paneSessions[paneId] = sid;
  rpc("pane.session.bind", {
    workspace_id: workspaceId,
    pane_id: paneId,
    session_id: sid,
  }).catch(() => {});
  await loadSessions(workspaceId, transitionSeq);
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return sid;
  }
  paneApi.normalizePaneSessions();
  paneApi.refreshPaneBindings();
  if (!silent) {
    setStatus(`Session started: ${sid}`);
  }
  const effectiveCmd = (cmd ?? "pwsh.exe").toLowerCase();
  const isShell = effectiveCmd.includes("pwsh") || effectiveCmd.includes("powershell") || effectiveCmd.includes("cmd.exe");
  setTimeout(() => {
    state.paneViews.get(paneId)?.fitAddon?.fit?.();
    if (isShell) {
      rpc("session.write", { session_id: sid, data: "\r" }).catch(() => {});
    }
  }, 300);
  if (focusTerm) {
    window.requestAnimationFrame(() => {
      state.paneViews.get(paneId)?.term.focus();
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
  if (!alive) {
    await startSessionForPane(paneId, { silent: true, workspaceId, transitionSeq });
  }
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return;
  }
  await paneApi.selectPane(paneId, { persist: true, focusTerm: true });
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
  const running = new Set(runningSessionsForWorkspace(workspaceId).map((s) => s.id));
  const currentLeafIds = new Set(leafPanes().map((p) => p.pane_id));
  const restoreWork = [];
  for (const binding of res.bindings) {
    if (isTransitionStale(transitionSeq, workspaceId)) {
      return;
    }
    const { pane_id, session_id, spawn_cmd, spawn_args, spawn_cwd } = binding;
    if (!currentLeafIds.has(pane_id)) continue;
    if (running.has(session_id)) {
      state.paneSessions[pane_id] = session_id;
      continue;
    }
    if (!spawn_cmd) continue;
    let parsedArgs = [];
    try { parsedArgs = JSON.parse(spawn_args ?? "[]"); } catch { /* */ }
    restoreWork.push(
      rpc("session.run", {
        workspace_id: workspaceId,
        cmd: spawn_cmd,
        args: parsedArgs,
        cwd: spawn_cwd ?? undefined,
      })
        .then((result) => {
          if (isTransitionStale(transitionSeq, workspaceId)) {
            return;
          }
          const newSid = result?.session?.session_id;
          if (newSid) {
            state.paneSessions[pane_id] = newSid;
            rpc("pane.session.bind", { workspace_id: workspaceId, pane_id, session_id: newSid }).catch(() => {});
          }
        })
        .catch(() => {})
    );
  }
  await Promise.all(restoreWork);
  if (isTransitionStale(transitionSeq, workspaceId)) {
    return;
  }
  await loadSessions(workspaceId, transitionSeq);
}
async function refreshWorkspaceState(workspaceId, options = {}, transitionSeq = null) {
  if (!workspaceId) {
    return;
  }
  const { forceLayout = false, autoSession = true } = options;
  await Promise.all([loadSessions(workspaceId, transitionSeq), loadPanes(workspaceId, transitionSeq), loadUnread()]);
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
  if (autoSession) {
    await ensurePaneSessionReady(workspaceId, state.selectedPaneId, transitionSeq);
    await ensureAllPaneSessionsReady(workspaceId, state.selectedPaneId, transitionSeq);
    if (isTransitionStale(transitionSeq, workspaceId)) {
      return;
    }
  }
  await syncActiveContext();
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
  state.selectedWorkspaceId = workspaceId;
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
async function onDeleteWorkspace() {
  const ws = selectedWorkspace();
  if (!ws) {
    return;
  }
  await rpc("workspace.delete", { id: ws.id });
  removeWorkspacePaneFonts(ws.id);
  hiddenClearPanesForWorkspace(ws.id);
  disposeAllViews();
  state.paneCards.clear();
  state.paneMeta.clear();
  state.layoutHash = "";
  state.paneSessions = {};
  state.panes = [];
  state.sessions = [];
  clearPromptDetectorAll();
  state.selectedPaneId = null;
  await unsubscribeStream();
  await loadWorkspaces();
  if (state.selectedWorkspaceId) {
    await switchWorkspace(state.selectedWorkspaceId);
  } else {
    paneSurface.innerHTML = "";
    notificationList.innerHTML = "";
  }
  setStatus(`Workspace deleted: ${ws.name}`);
  await syncActiveContext();
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
  const inheritedFontSize = currentPaneFontSize(ws.id, previousPaneId);
  const res = await rpc("layout.split", {
    workspace_id: ws.id,
    pane_id: previousPaneId,
    direction,
  });
  const first = res?.pane_ids?.[0] ?? null;
  const second = res?.pane_ids?.[1] ?? null;
  delete state.paneSessions[previousPaneId];
  removePaneFontSize(ws.id, previousPaneId);
  if (previousSession && first) {
    state.paneSessions[first] = previousSession;
  }
  if (first) {
    setPaneFontSize(ws.id, first, inheritedFontSize);
  }
  if (second) {
    setPaneFontSize(ws.id, second, inheritedFontSize);
  }
  if (newPaneSessionId && second) {
    state.paneSessions[second] = newPaneSessionId;
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
      label,
    });
  }
  delete state.paneSessions[paneId];
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
async function onMarkLatestRead() {
  if (state.notifications.length === 0) {
    return;
  }
  await rpc("notify.mark_read", { notification_id: state.notifications[0].id });
  await loadUnread();
}
async function onClearUnread() {
  await rpc("notify.clear", {});
  await loadUnread();
  setStatus("Unread notifications cleared");
}
async function onNotificationClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const item = target.closest("li[data-notification-id]");
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

function openWsInfoPanel(ws, anchorEl) {
  const overlay = $("wsInfoOverlay");
  const panel = $("wsInfoPanel");
  const titleEl = $("wsInfoTitle");
  const descInput = $("wsDescInput");
  const summaryEl = $("wsSessionSummary");
  if (!overlay || !panel) return;

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
  $("createWorkspaceBtn").addEventListener("click", () =>
    onCreateWorkspace().catch((err) => setStatus(String(err), true)),
  );
  $("deleteWorkspaceBtn").addEventListener("click", () =>
    onDeleteWorkspace().catch((err) => setStatus(String(err), true)),
  );
  $("pickFolderBtn").addEventListener("click", () =>
    onPickFolder().catch((err) => setStatus(String(err), true)),
  );
  $("openInVscodeBtn").addEventListener("click", () =>
    onOpenInVscode().catch((err) => setStatus(String(err), true)),
  );
  $("refreshUnreadBtn").addEventListener("click", () =>
    loadUnread().catch((err) => setStatus(String(err), true)),
  );
  $("markLatestReadBtn").addEventListener("click", () =>
    onMarkLatestRead().catch((err) => setStatus(String(err), true)),
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
  bindKeyboardShortcuts();
}

const FONT_SCALE_STEPS = [80, 85, 90, 95, 100, 110, 120];

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (ev) => {
    // Skip if focus is inside a text input / textarea (but NOT xterm canvas)
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    const ctrl = ev.ctrlKey || ev.metaKey;
    const shift = ev.shiftKey;

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
      state.notificationOpenUnbind = window.wincmux.onNotificationOpen(({ notification_id }) => {
        void openNotificationById(notification_id).catch((err) => setStatus(String(err), true));
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

bootstrap();
