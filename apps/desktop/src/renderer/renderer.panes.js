const paneHandlers = {
  startSessionForPane: async () => {},
  closeSessionForPane: async () => {},
  splitPane: async () => {},
  closePane: async () => {},
  hidePane: async () => {},
  adjustPaneFont: async () => {},
  insertQuickCommand: async () => {},
  markPaneNotificationsRead: async () => {}
};
const INPUT_FLUSH_DELAY_MS = 12;

function bindQuickCommandPanelSafe(paneId, quickPanel, quickBtn) {
  const binder = typeof globalThis.bindQuickCommandPanel === "function"
    ? globalThis.bindQuickCommandPanel
    : null;
  if (!binder) {
    quickBtn.disabled = true;
    quickBtn.title = "Quick command unavailable";
    quickPanel.remove();
    return;
  }

  try {
    binder(paneId, quickPanel, quickBtn);
  } catch (err) {
    quickBtn.disabled = true;
    quickBtn.title = "Quick command unavailable";
    quickPanel.classList.remove("open");
    quickPanel.innerHTML = "";
    setStatus(`Quick command disabled: ${err?.message ?? err}`, true, { priority: 70, holdMs: 6000 });
    console.error("[renderer] quickcmd bind failed:", err);
  }
}

function makeSplitResizableSafe(...args) {
  if (typeof globalThis.makeSplitResizable !== "function") {
    return;
  }
  globalThis.makeSplitResizable(...args);
}

function applyStoredSplitRatioSafe(...args) {
  if (typeof globalThis.applyStoredSplitRatio !== "function") {
    return;
  }
  globalThis.applyStoredSplitRatio(...args);
}

function setPaneHandlers(handlers = {}) {
  if (typeof handlers.startSessionForPane === "function") {
    paneHandlers.startSessionForPane = handlers.startSessionForPane;
  }
  if (typeof handlers.closeSessionForPane === "function") {
    paneHandlers.closeSessionForPane = handlers.closeSessionForPane;
  }
  if (typeof handlers.splitPane === "function") {
    paneHandlers.splitPane = handlers.splitPane;
  }
  if (typeof handlers.closePane === "function") {
    paneHandlers.closePane = handlers.closePane;
  }
  if (typeof handlers.hidePane === "function") {
    paneHandlers.hidePane = handlers.hidePane;
  }
  if (typeof handlers.adjustPaneFont === "function") {
    paneHandlers.adjustPaneFont = handlers.adjustPaneFont;
  }
  if (typeof handlers.insertQuickCommand === "function") {
    paneHandlers.insertQuickCommand = handlers.insertQuickCommand;
  }
  if (typeof handlers.markPaneNotificationsRead === "function") {
    paneHandlers.markPaneNotificationsRead = handlers.markPaneNotificationsRead;
  }
}

function paneForSession(sessionId) {
  for (const paneId of Object.keys(state.paneSessions)) {
    if (state.paneSessions[paneId] === sessionId) {
      return paneId;
    }
  }
  return null;
}
function enqueueStreamOutput(paneId, output) {
  const view = state.paneViews.get(paneId);
  if (!view || !output) {
    return;
  }

  // Mark which session produced this output (for workspace-switch reset guard)
  if (view.sessionId) {
    view.renderedSessionId = view.sessionId;
  }
  view.outputQueue += output;
  if (view.outputQueue.length > 256_000) {
    view.outputQueue = view.outputQueue.slice(-180_000);
    state.metrics.dropped_frames += 1;
    logPerf("stream.dropped", { pane_id: paneId, dropped_frames: state.metrics.dropped_frames });
  }
  state.metrics.stream_queue_depth = Math.max(state.metrics.stream_queue_depth, view.outputQueue.length);

  if (!view.flushRaf) {
    view.flushRaf = window.requestAnimationFrame(() => flushPaneOutput(paneId));
  }
}
function flushPaneOutput(paneId) {
  const view = state.paneViews.get(paneId);
  if (!view) {
    return;
  }
  view.flushRaf = null;
  if (!view.outputQueue) {
    return;
  }

  const chunk = view.outputQueue.slice(0, 16_384);
  view.outputQueue = view.outputQueue.slice(16_384);

  // If user has scrolled up, preserve viewport position after write.
  const buf = view.term.buffer.active;
  const isScrolledUp = buf.viewportY < buf.baseY;
  const savedViewportY = isScrolledUp ? buf.viewportY : null;

  view.renderedSessionId = view.sessionId;
  view.term.write(normalizeTerminalOutput(chunk), () => {
    if (savedViewportY !== null) {
      view.term.scrollToLine(savedViewportY);
    }
  });

  if (view.outputQueue.length > 0) {
    view.flushRaf = window.requestAnimationFrame(() => flushPaneOutput(paneId));
  }
}
function currentLayoutHash() {
  const stable = state.panes
    .map((p) => `${p.pane_id}:${p.parent_id ?? "root"}:${p.split ? `${p.split.direction}:${p.split.first}:${p.split.second}` : "leaf"}`)
    .sort();
  return `${state.selectedWorkspaceId ?? ""}|${stable.join("|")}`;
}

function ensureSelectedPane() {
  const leaves = leafPanes();
  const leafSet = new Set(leaves.map((p) => p.pane_id));

  if (!state.selectedPaneId || !leafSet.has(state.selectedPaneId)) {
    const focusedLeaf = leaves.find((p) => p.is_focused);
    state.selectedPaneId = focusedLeaf?.pane_id ?? leaves[0]?.pane_id ?? null;
  }

  selectedPaneLabel.textContent = `Selected Pane: ${state.selectedPaneId ? state.selectedPaneId.slice(0, 8) : "-"}`;
}

function normalizePaneSessions() {
  const leafIds = new Set(leafPanes().map((p) => p.pane_id));
  const running = new Map(runningSessions().map((s) => [s.id, s]));
  const hiddenSessions = typeof hiddenSessionIdsForWorkspace === "function"
    ? hiddenSessionIdsForWorkspace(state.selectedWorkspaceId)
    : new Set();

  for (const paneId of Object.keys(state.paneSessions)) {
    const sid = state.paneSessions[paneId];
    if (!leafIds.has(paneId) || (sid && (!running.has(sid) || hiddenSessions.has(sid)))) {
      clearPromptDetectorSession(sid);
      delete state.paneSessions[paneId];
    }
  }

  const assigned = new Set(Object.values(state.paneSessions).filter(Boolean));
  for (const pane of leafPanes()) {
    if (state.paneSessions[pane.pane_id]) {
      continue;
    }
    const free = runningSessions().find((s) => !assigned.has(s.id) && !hiddenSessions.has(s.id));
    if (free) {
      state.paneSessions[pane.pane_id] = free.id;
      assigned.add(free.id);
    }
  }

  ensureSelectedPane();
}

function applyPaneSelectionStyles() {
  for (const [paneId, card] of state.paneCards.entries()) {
    card.classList.toggle("active", paneId === state.selectedPaneId);
  }
  selectedPaneLabel.textContent = `Selected Pane: ${state.selectedPaneId ? state.selectedPaneId.slice(0, 8) : "-"}`;
}

function unreadRowsForPane(paneId, sessionId) {
  const workspaceId = selectedWorkspace()?.id ?? null;
  if (!workspaceId) {
    return [];
  }

  return state.notifications.filter((row) => {
    const target = normalizeNotificationTarget(row);
    const targetWorkspaceId = target.workspaceId ?? row.workspace_id ?? null;
    if (targetWorkspaceId !== workspaceId) {
      return false;
    }
    if (target.paneId) {
      return target.paneId === paneId;
    }
    if (sessionId && target.sessionId) {
      return target.sessionId === sessionId;
    }
    return false;
  });
}

async function selectPane(paneId, options = {}) {
  const { persist = true, focusTerm = true } = options;
  if (!paneId || !leafPanes().some((p) => p.pane_id === paneId)) {
    return;
  }

  state.selectedPaneId = paneId;
  applyPaneSelectionStyles();

  if (persist) {
    const ws = selectedWorkspace();
    if (ws) {
      await rpc("layout.focus", { workspace_id: ws.id, pane_id: paneId });
    }
  }
  await paneHandlers.markPaneNotificationsRead(paneId).catch(() => {});

  if (focusTerm) {
    window.requestAnimationFrame(() => {
      state.paneViews.get(paneId)?.term.focus();
    });
  }
}

function disposeView(view) {
  if (!view) {
    return;
  }
  if (view.poller) {
    clearInterval(view.poller);
  }
  if (view.flushTimer) {
    clearTimeout(view.flushTimer);
  }
  if (view.resizeTimer) {
    clearTimeout(view.resizeTimer);
  }
  if (view.flushRaf) {
    cancelAnimationFrame(view.flushRaf);
  }
  if (view.observer) {
    view.observer.disconnect();
  }
  if (view.imeBindTimer) {
    clearInterval(view.imeBindTimer);
    view.imeBindTimer = null;
  }
  if (view.imeTextarea) {
    if (view.onCompositionStart) {
      view.imeTextarea.removeEventListener("compositionstart", view.onCompositionStart);
    }
    if (view.onCompositionEnd) {
      view.imeTextarea.removeEventListener("compositionend", view.onCompositionEnd);
    }
    view.imeTextarea = null;
  }
  if (view.term) {
    view.term.dispose();
  }
}

function disposeAllViews() {
  for (const view of state.paneViews.values()) {
    disposeView(view);
  }
  state.paneViews.clear();
  // Also dispose cached views from other workspaces
  for (const cachedMap of state.workspacePaneViewCache.values()) {
    for (const view of cachedMap.values()) {
      disposeView(view);
    }
  }
  state.workspacePaneViewCache.clear();
  state._lastRenderedWorkspaceId = null;
}

function fitAllPanes() {
  for (const view of state.paneViews.values()) {
    try {
      updatePaneActionLayout(view.paneId);
      view.fitAddon.fit();
      schedulePaneResize(view);
    } catch {
      // ignore fit errors during layout teardown
    }
  }
}

function schedulePaneResize(view) {
  if (view.resizeTimer) {
    clearTimeout(view.resizeTimer);
  }
  view.resizeTimer = setTimeout(() => {
    syncPaneSize(view.paneId).catch(() => {});
  }, 60);
}

function applyPaneFontToView(paneId, size) {
  const view = state.paneViews.get(paneId);
  if (!view) {
    return;
  }
  const nextSize = clampPaneFontSize(size);
  if (Number(view.term.options.fontSize) === nextSize) {
    return;
  }
  view.term.options.fontSize = nextSize;
  view.fitAddon.fit();
  schedulePaneResize(view);
}

const PANE_ACTION_COMPACT_BREAKPOINT = 1080;
const PANE_ACTION_TIGHT_BREAKPOINT = 760;
let paneOverflowCloseBound = false;
let paneOverflowPositionBound = false;
let paneOverflowOpenPaneId = null;

function positionPaneOverflowMenu(paneId) {
  const meta = state.paneMeta.get(paneId);
  if (!meta?.actionsOverflowMenu || !meta?.actionsOverflowBtn) {
    return;
  }
  if (!meta.actionsOverflowMenu.classList.contains("open")) {
    return;
  }

  const anchor = meta.actionsOverflowBtn.getBoundingClientRect();
  const menu = meta.actionsOverflowMenu;
  const margin = 10;

  menu.style.maxHeight = `${Math.max(180, window.innerHeight - margin * 2)}px`;
  menu.style.visibility = "hidden";

  const rect = menu.getBoundingClientRect();
  const width = Math.min(rect.width || 220, Math.max(180, window.innerWidth - margin * 2));

  let left = anchor.right - width;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

  let top = anchor.bottom + 6;
  if (top + rect.height > window.innerHeight - margin) {
    top = Math.max(margin, anchor.top - rect.height - 6);
  }

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.width = `${Math.round(width)}px`;
  menu.style.visibility = "";
}

function closePaneOverflowMenus(exceptPaneId = null) {
  for (const [paneId, meta] of state.paneMeta.entries()) {
    if (!meta?.actionsOverflowMenu) {
      continue;
    }
    if (exceptPaneId && paneId === exceptPaneId) {
      continue;
    }
    meta.actionsOverflowMenu.classList.remove("open");
    meta.actionsOverflowMenu.style.left = "";
    meta.actionsOverflowMenu.style.top = "";
    meta.actionsOverflowMenu.style.width = "";
    meta.actionsOverflowMenu.style.visibility = "";
    meta.actionsOverflowMenu.style.maxHeight = "";
    meta.actionsOverflowBtn?.setAttribute("aria-expanded", "false");
  }
  paneOverflowOpenPaneId = exceptPaneId;
}

function updatePaneActionLayout(paneId) {
  const meta = state.paneMeta.get(paneId);
  const card = state.paneCards.get(paneId);
  if (!meta || !card || !meta.actionsPrimary || !meta.actionsOverflowMenu || !meta.actionsOverflowWrap) {
    return;
  }

  const autoEnabled = state.paneAutoResize !== false;
  const width = card.clientWidth || 0;
  let level = 0;
  if (autoEnabled && width > 0) {
    if (width <= PANE_ACTION_TIGHT_BREAKPOINT) {
      level = 2;
    } else if (width <= PANE_ACTION_COMPACT_BREAKPOINT) {
      level = 1;
    }
  }

  const allActionButtons = [
    meta.fontDownBtn,
    meta.fontUpBtn,
    meta.splitHBtn,
    meta.splitVBtn,
    meta.startBtn,
    meta.sessionPickerBtn,
    meta.closeBtn,
    meta.hidePaneBtn,
    meta.quickBtn,
    meta.closePaneBtn
  ].filter(Boolean);

  const primarySet = new Set();
  if (level === 0) {
    for (const button of allActionButtons) {
      primarySet.add(button);
    }
  } else if (level === 1) {
    [meta.startBtn, meta.sessionPickerBtn, meta.quickBtn].forEach((button) => {
      if (button) {
        primarySet.add(button);
      }
    });
  } else {
    [meta.startBtn, meta.quickBtn].forEach((button) => {
      if (button) {
        primarySet.add(button);
      }
    });
  }

  meta.actionsPrimary.innerHTML = "";
  meta.actionsOverflowMenu.innerHTML = "";

  for (const button of allActionButtons) {
    if (primarySet.has(button)) {
      meta.actionsPrimary.appendChild(button);
      continue;
    }
    meta.actionsOverflowMenu.appendChild(button);
  }

  if (meta.autoResizeBtn) {
    meta.autoResizeBtn.textContent = autoEnabled ? "Auto On" : "Auto Off";
    meta.autoResizeBtn.title = autoEnabled
      ? "Automatic compact layout is enabled"
      : "Automatic compact layout is disabled";
    if (level === 0) {
      meta.actionsPrimary.appendChild(meta.autoResizeBtn);
    } else {
      meta.actionsOverflowMenu.prepend(meta.autoResizeBtn);
    }
  }

  const hasOverflow = meta.actionsOverflowMenu.childElementCount > 0;
  meta.actionsOverflowWrap.hidden = !hasOverflow;
  if (hasOverflow) {
    meta.actionsPrimary.appendChild(meta.actionsOverflowWrap);
  } else {
    meta.actionsOverflowMenu.classList.remove("open");
    meta.actionsOverflowBtn?.setAttribute("aria-expanded", "false");
  }

  if (hasOverflow && paneOverflowOpenPaneId === paneId && meta.actionsOverflowMenu.classList.contains("open")) {
    window.requestAnimationFrame(() => positionPaneOverflowMenu(paneId));
  }

  card.classList.toggle("pane-actions-compact", level > 0);
  card.classList.toggle("pane-actions-tight", level > 1);

  const startFullLabel = meta.startBtn?.dataset?.fullLabel || meta.startBtn?.textContent || "Start";
  if (meta.startBtn) {
    if (level > 1) {
      const isRestart = /^restart$/i.test(startFullLabel.trim());
      meta.startBtn.textContent = isRestart ? "↻" : "▶";
      meta.startBtn.classList.add("pane-btn-icon");
      meta.startBtn.title = isRestart ? "Restart" : "Start";
    } else {
      meta.startBtn.textContent = startFullLabel;
      meta.startBtn.classList.remove("pane-btn-icon");
      meta.startBtn.title = "";
    }
  }
}

function setPaneAutoResizeEnabled(enabled) {
  state.paneAutoResize = Boolean(enabled);
  localStorage.setItem(STORAGE_KEYS.paneAutoResize, state.paneAutoResize ? "1" : "0");
  for (const paneId of state.paneCards.keys()) {
    updatePaneActionLayout(paneId);
  }
  fitAllPanes();
}

async function syncPaneSize(paneId) {
  const view = state.paneViews.get(paneId);
  if (!view || !view.sessionId) {
    return;
  }
  const cols = Math.max(2, view.term.cols || 120);
  const rows = Math.max(1, view.term.rows || 24);
  await rpc("session.resize", { session_id: view.sessionId, cols, rows });
}

function queuePaneInput(view, data) {
  if (!view.sessionId || !data) {
    return;
  }

  view.pendingInput += data;
  if (view.inputFlushScheduled || view.inputFlushInFlight) {
    return;
  }

  view.inputFlushScheduled = true;
  view.flushTimer = setTimeout(() => {
    view.flushTimer = null;
    view.inputFlushScheduled = false;
    void flushPaneInput(view);
  }, INPUT_FLUSH_DELAY_MS);
}

async function flushPaneInput(view) {
  if (view.inputFlushInFlight) {
    return;
  }

  if (!view.sessionId || !view.pendingInput) {
    return;
  }

  view.inputFlushInFlight = true;
  try {
    while (view.sessionId && view.pendingInput) {
      const sessionId = view.sessionId;
      const payload = view.pendingInput;
      const queued = payload.length;
      view.pendingInput = "";
      const started = performance.now();

      try {
        await rpc("session.write", { session_id: sessionId, data: payload });
        const latency = performance.now() - started;
        state.metrics.input_latency_ms.push(latency);
        if (state.metrics.input_latency_ms.length > 50) {
          state.metrics.input_latency_ms.shift();
        }
        logPerf("input.latency", {
          pane_id: view.paneId,
          session_id: sessionId,
          latency_ms: Number(latency.toFixed(2))
        });
        logPerf("input.flush", {
          pane_id: view.paneId,
          session_id: sessionId,
          queued,
          sent: queued,
          dropped: 0,
          in_flight_ms: Number(latency.toFixed(2))
        });
      } catch (err) {
        const msg = err?.message ?? String(err);
        if (msg.includes("ENOENT") || msg.includes("pipe")) {
          setStatus("Core reconnecting, retrying input...", true);
        } else {
          setStatus(`Terminal input error: ${msg}`, true);
        }
        const latency = performance.now() - started;
        logPerf("input.flush", {
          pane_id: view.paneId,
          session_id: sessionId,
          queued,
          sent: 0,
          dropped: queued,
          in_flight_ms: Number(latency.toFixed(2))
        });
      }
    }
  } finally {
    view.inputFlushInFlight = false;
    if (view.sessionId && view.pendingInput && !view.inputFlushScheduled) {
      view.inputFlushScheduled = true;
      view.flushTimer = setTimeout(() => {
        view.flushTimer = null;
        view.inputFlushScheduled = false;
        void flushPaneInput(view);
      }, INPUT_FLUSH_DELAY_MS);
    }
  }
}

function writeToPane(paneId, data) {
  const view = state.paneViews.get(paneId);
  if (!view || !data) {
    return;
  }
  queuePaneInput(view, data);
}

function bindViewToSession(view, sessionId) {
  const nextSession = sessionId ?? null;

  // If same session and polling is already running, still sync PTY size
  // (e.g. view was restored from workspace cache — size must be re-sent to server)
  if (view.sessionId === nextSession && (view.poller || state.useStream)) {
    syncPaneSize(view.paneId).catch(() => {});
    return;
  }

  const previousSession = view.sessionId;
  if (previousSession && previousSession !== nextSession) {
    clearPromptDetectorSession(previousSession);
  }

  // Stop any existing polling/timers
  if (view.poller) {
    clearInterval(view.poller);
    view.poller = null;
  }
  if (view.flushTimer) {
    clearTimeout(view.flushTimer);
    view.flushTimer = null;
  }
  view.inputFlushScheduled = false;
  view.inputFlushInFlight = false;
  if (view.flushRaf) {
    cancelAnimationFrame(view.flushRaf);
    view.flushRaf = null;
  }

  view.pendingInput = "";
  view.outputQueue = "";
  view.readBusy = false;
  view.sessionId = nextSession;

  // If the xterm buffer already contains this session's output (e.g. returning to a workspace
  // after the view was stashed in the workspace cache), skip term.reset() to preserve content.
  const sameRendered = nextSession !== null && nextSession === view.renderedSessionId;
  if (!sameRendered) {
    view.term.reset();
    view.renderedSessionId = nextSession;
  }

  if (view.sessionId) {
    if (!state.useStream) {
      startPanePolling(view);
    }
    syncPaneSize(view.paneId).catch(() => {});
  }
}

function startPanePolling(view) {
  if (!view.sessionId) {
    return;
  }

  view.poller = setInterval(async () => {
    if (!view.sessionId || view.readBusy) {
      return;
    }

    view.readBusy = true;
    try {
      const activeSessionId = view.sessionId;
      if (!activeSessionId) {
        return;
      }
      const res = await rpc("session.read", {
        session_id: activeSessionId,
        max_bytes: 16384
      });
      if (res?.output) {
        void maybeNotifyPromptFromOutput(activeSessionId, res.output, selectedWorkspace()?.id ?? null);
        const buf = view.term.buffer.active;
        const isScrolledUp = buf.viewportY < buf.baseY;
        const savedViewportY = isScrolledUp ? buf.viewportY : null;
        view.renderedSessionId = activeSessionId;
        view.term.write(normalizeTerminalOutput(res.output), () => {
          if (savedViewportY !== null) {
            view.term.scrollToLine(savedViewportY);
          }
        });
      }
    } catch (err) {
      const message = String(err?.message ?? err);
      if (message.includes("session not found")) {
        // Session ended: stop polling but keep terminal output visible (don't reset)
        clearInterval(view.poller);
        view.poller = null;
        view.sessionId = null;
        delete state.paneSessions[view.paneId];
        refreshPaneBindings();
      } else {
        setStatus(`Terminal read error: ${message}`, true);
      }
    } finally {
      view.readBusy = false;
    }
  }, 90);
}

function rebindImeTextarea(view) {
  const textarea = view.host.querySelector("textarea");
  if (!textarea || textarea === view.imeTextarea) {
    return;
  }

  if (view.imeTextarea) {
    if (view.onCompositionStart) {
      view.imeTextarea.removeEventListener("compositionstart", view.onCompositionStart);
    }
    if (view.onCompositionEnd) {
      view.imeTextarea.removeEventListener("compositionend", view.onCompositionEnd);
    }
  }

  view.onCompositionStart = () => {
    view.isComposing = true;
    logIme("compositionstart", { pane_id: view.paneId });
  };
  view.onCompositionEnd = () => {
    view.isComposing = false;
    logIme("compositionend", { pane_id: view.paneId });
  };
  textarea.addEventListener("compositionstart", view.onCompositionStart);
  textarea.addEventListener("compositionend", view.onCompositionEnd);
  view.imeTextarea = textarea;
}

function createPaneLeaf(node, hosts) {
  const paneId = node.pane_id;
  const card = document.createElement("div");
  card.className = "pane-leaf";
  card.dataset.paneId = paneId;
  const header = document.createElement("div");
  header.className = "pane-header";
  const idEl = document.createElement("span");
  idEl.className = "pane-id";
  idEl.textContent = paneId.slice(0, 8);
  const unreadBadgeEl = document.createElement("span");
  unreadBadgeEl.className = "pane-unread-badge";
  unreadBadgeEl.hidden = true;
  const idWrap = document.createElement("div");
  idWrap.className = "pane-id-wrap";
  idWrap.append(idEl, unreadBadgeEl);
  const statusEl = document.createElement("span");
  statusEl.className = "pane-session";
  statusEl.textContent = "No session";
  const actions = document.createElement("div");
  actions.className = "pane-actions";
  const actionsPrimary = document.createElement("div");
  actionsPrimary.className = "pane-actions-primary";
  const actionsOverflowWrap = document.createElement("div");
  actionsOverflowWrap.className = "pane-overflow";
  const actionsOverflowBtn = document.createElement("button");
  actionsOverflowBtn.className = "pane-btn pane-overflow-btn";
  actionsOverflowBtn.textContent = "...";
  actionsOverflowBtn.title = "More actions";
  actionsOverflowBtn.setAttribute("aria-expanded", "false");
  const actionsOverflowMenu = document.createElement("div");
  actionsOverflowMenu.className = "pane-overflow-menu";
  actionsOverflowWrap.append(actionsOverflowBtn, actionsOverflowMenu);
  actions.append(actionsPrimary);
  const makeBtn = (text, title, onClick, cls = "pane-btn") => {
    const btn = document.createElement("button");
    btn.className = cls;
    btn.textContent = text;
    if (title) {
      btn.title = title;
    }
    btn.addEventListener("click", onClick);
    return btn;
  };
  const fontDownBtn = makeBtn("A-", "Decrease font size", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.adjustPaneFont(paneId, -PANE_FONT_LIMITS.step).catch((err) => setStatus(String(err), true));
  });
  const fontUpBtn = makeBtn("A+", "Increase font size", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.adjustPaneFont(paneId, PANE_FONT_LIMITS.step).catch((err) => setStatus(String(err), true));
  });
  const splitHBtn = makeBtn("Split H", "Split horizontally", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.splitPane(paneId, "horizontal").catch((err) => setStatus(String(err), true));
  });
  const splitVBtn = makeBtn("Split V", "Split vertically", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.splitPane(paneId, "vertical").catch((err) => setStatus(String(err), true));
  });
  const startBtn = makeBtn("Start", "", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.startSessionForPane(paneId, { force: true }).catch((err) => setStatus(String(err), true));
  });
  const sessionPickerBtn = makeBtn("Sessions v", "View and attach session history", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openSessionPicker(paneId, sessionPickerBtn);
  });
  sessionPickerBtn.className = "pane-btn session-picker-btn";
  const closeBtn = makeBtn("Close", "", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.closeSessionForPane(paneId).catch((err) => setStatus(String(err), true));
  });
  const closePaneBtn = makeBtn("Close Pane", "", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.closePane(paneId).catch((err) => setStatus(String(err), true));
  }, "pane-btn pane-btn-danger");
  const hidePaneBtn = makeBtn("Hide Pane", "Hide this pane without ending session", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.hidePane(paneId).catch((err) => setStatus(String(err), true));
  });
  const quickBtn = makeBtn("", "Quick command", () => {});
  quickBtn.classList.add("quickcmd-toggle");
  quickBtn.setAttribute("aria-label", "Quick command");
  quickBtn.innerHTML = '<span class="quickcmd-icon" aria-hidden="true"></span>';
  const autoResizeBtn = makeBtn("", "Toggle automatic compact layout", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setPaneAutoResizeEnabled(!(state.paneAutoResize !== false));
    setStatus(state.paneAutoResize !== false ? "Auto resize enabled" : "Auto resize disabled");
  }, "pane-btn pane-btn-auto");
  actionsOverflowBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const isSamePaneOpen = paneOverflowOpenPaneId === paneId && actionsOverflowMenu.classList.contains("open");
    if (isSamePaneOpen) {
      closePaneOverflowMenus(null);
      actionsOverflowMenu.classList.remove("open");
      actionsOverflowBtn.setAttribute("aria-expanded", "false");
      return;
    }

    closePaneOverflowMenus(paneId);
    actionsOverflowMenu.classList.add("open");
    actionsOverflowBtn.setAttribute("aria-expanded", "true");
    paneOverflowOpenPaneId = paneId;
    positionPaneOverflowMenu(paneId);
  });
  actionsOverflowMenu.addEventListener("click", () => {
    actionsOverflowMenu.classList.remove("open");
    actionsOverflowMenu.style.left = "";
    actionsOverflowMenu.style.top = "";
    actionsOverflowMenu.style.width = "";
    actionsOverflowMenu.style.visibility = "";
    actionsOverflowMenu.style.maxHeight = "";
    paneOverflowOpenPaneId = null;
    actionsOverflowBtn.setAttribute("aria-expanded", "false");
  });

  if (!paneOverflowCloseBound) {
    paneOverflowCloseBound = true;
    document.addEventListener("pointerdown", (ev) => {
      const target = ev.target;
      if (target instanceof HTMLElement && target.closest(".pane-overflow")) {
        return;
      }
      closePaneOverflowMenus();
    });
  }
  if (!paneOverflowPositionBound) {
    paneOverflowPositionBound = true;
    const reposition = () => {
      if (paneOverflowOpenPaneId) {
        positionPaneOverflowMenu(paneOverflowOpenPaneId);
      }
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
  }
  header.append(idWrap, statusEl, actions);
  const quickPanel = document.createElement("div");
  quickPanel.className = "quickcmd-popover";
  const terminalHost = document.createElement("div");
  terminalHost.className = "pane-terminal-host";
  card.append(header, quickPanel, terminalHost);
  card.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) {
      return;
    }
    const target = ev.target;
    if (target instanceof HTMLElement && target.closest("button")) {
      return;
    }
    const isTerminalClick = target instanceof HTMLElement && Boolean(target.closest(".pane-terminal-host"));
    selectPane(paneId, { persist: true, focusTerm: false })
      .then(() => {
        if (isTerminalClick) {
          state.paneViews.get(paneId)?.term.focus();
        }
      })
      .catch((err) => setStatus(String(err), true));
  });
  hosts.push({ paneId, host: terminalHost });
  state.paneCards.set(paneId, card);
  state.paneMeta.set(paneId, {
    actionsPrimary,
    actionsOverflowWrap,
    actionsOverflowBtn,
    actionsOverflowMenu,
    statusEl,
    splitHBtn,
    splitVBtn,
    startBtn,
    sessionPickerBtn,
    closeBtn,
    closePaneBtn,
    hidePaneBtn,
    fontDownBtn,
    fontUpBtn,
    autoResizeBtn,
    quickBtn,
    quickPanel,
    unreadBadgeEl
  });
  bindQuickCommandPanelSafe(paneId, quickPanel, quickBtn);
  updatePaneActionLayout(paneId);
  return card;
}

function renderPaneNode(node, paneMap, hosts) {
  if (!node.split) {
    return createPaneLeaf(node, hosts);
  }

  const wrap = document.createElement("div");
  wrap.className = `pane-split ${node.split.direction}`;

  const first = paneMap.get(node.split.first);
  const second = paneMap.get(node.split.second);
  if (!first || !second) {
    const broken = document.createElement("div");
    broken.className = "muted";
    broken.textContent = "Invalid split state";
    wrap.appendChild(broken);
    return wrap;
  }

  const firstNode = renderPaneNode(first, paneMap, hosts);
  const secondNode = renderPaneNode(second, paneMap, hosts);
  firstNode.classList.add("pane-split-item");
  secondNode.classList.add("pane-split-item");

  const divider = document.createElement("div");
  divider.className = `pane-divider ${node.split.direction}`;

  wrap.append(firstNode, divider, secondNode);
  const splitKey = `${state.selectedWorkspaceId ?? "none"}:${node.pane_id}`;
  makeSplitResizableSafe(wrap, firstNode, secondNode, divider, node.split.direction, splitKey);
  applyStoredSplitRatioSafe(firstNode, secondNode, splitKey, node.split.direction);
  return wrap;
}

function createPaneView(paneId, host) {
  const fontSize = currentPaneFontSize(state.selectedWorkspaceId, paneId);
  const term = new window.Terminal({
    convertEol: false,
    cursorBlink: false,
    fontFamily: "Cascadia Mono, D2Coding, NanumGothicCoding, Noto Sans Mono CJK KR, Malgun Gothic, Consolas, monospace",
    fontSize,
    lineHeight: 1.2,
    scrollback: 5000,
    scrollOnUserInput: true,
    scrollSensitivity: 1,
    theme: {
      background: "#060b11",
      foreground: "#e8edf7"
    }
  });

  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  if (state.terminal.unicode_width === "unicode11" && window.Unicode11Addon?.Unicode11Addon) {
    try {
      const unicode11Addon = new window.Unicode11Addon.Unicode11Addon();
      term.loadAddon(unicode11Addon);
      if (term.unicode?.activeVersion !== undefined) {
        term.unicode.activeVersion = "11";
      }
    } catch {
      // ignore unicode addon failures
    }
  }
  term.open(host);
  fitAddon.fit();

  const view = {
    paneId,
    host,
    term,
    fitAddon,
    sessionId: null,
    renderedSessionId: null,  // tracks which session's output is actually in the xterm buffer
    poller: null,
    observer: null,
    pendingInput: "",
    flushTimer: null,
    inputFlushScheduled: false,
    inputFlushInFlight: false,
    flushRaf: null,
    outputQueue: "",
    resizeTimer: null,
    readBusy: false,
    isComposing: false,
    imeTextarea: null,
    imeBindTimer: null,
    onCompositionStart: null,
    onCompositionEnd: null,
    suppressOnData: false
  };

  term.attachCustomKeyEventHandler((ev) => {
    const key = ev.key?.toLowerCase?.() ?? "";
    if (ev.type !== "keydown") {
      return true;
    }

    if (ev.ctrlKey && !ev.shiftKey && key === "c") {
      if (term.hasSelection()) {
        const text = term.getSelection();
        if (text) {
          void window.wincmux.clipboardWrite(text);
        }
        return false;
      }
      return true;
    }

    if (ev.ctrlKey && ev.shiftKey && key === "c") {
      const text = term.getSelection();
      if (text) {
        void window.wincmux.clipboardWrite(text);
      }
      return false;
    }

    if (ev.ctrlKey && key === "v") {
      // Suppress onData immediately: xterm native paste fires before clipboardRead resolves.
      view.suppressOnData = true;
      void window.wincmux.clipboardRead().then((text) => {
        view.suppressOnData = false;
        if (text) {
          queuePaneInput(view, text);
        }
      });
      return false;
    }

    return true;
  });

  term.onData((data) => {
    // Block input if an external textarea/input has focus (e.g. notepad, session picker)
    const active = document.activeElement;
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT") && active !== view.imeTextarea) {
      return;
    }
    // Suppress duplicate onData fired by xterm's native paste path when Ctrl+V is intercepted
    if (view.suppressOnData) {
      return;
    }
    logIme("onData", { pane_id: paneId, len: data.length, composing: view.isComposing });
    queuePaneInput(view, data);
  });

  term.onBinary((data) => {
    const active = document.activeElement;
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT") && active !== view.imeTextarea) {
      return;
    }
    logIme("onBinary", { pane_id: paneId, len: data.length });
    queuePaneInput(view, data);
  });

  host.addEventListener("contextmenu", (ev) => {
    void selectPane(paneId, { persist: true, focusTerm: false }).catch(() => {});
    if (!ev.shiftKey) {
      return;
    }
    ev.preventDefault();
    void window.wincmux.showContextMenu(term.hasSelection());
  });

  rebindImeTextarea(view);
  view.imeBindTimer = setInterval(() => rebindImeTextarea(view), 800);

  const observer = new ResizeObserver(() => {
    updatePaneActionLayout(paneId);
    fitAddon.fit();
    schedulePaneResize(view);
  });
  observer.observe(host);
  view.observer = observer;

  state.paneViews.set(paneId, view);
}

function renderPaneSurface(force = false) {
  const nextHash = currentLayoutHash();
  if (!force && nextHash === state.layoutHash) {
    return;
  }

  state.layoutHash = nextHash;

  if (!state.selectedWorkspaceId) {
    paneSurface.innerHTML = "";
    state.paneCards.clear();
    state.paneMeta.clear();
    state.quickCommandOpenPaneId = null;
    disposeAllViews();
    renderPaneEmptyState("No workspace selected", "Create or select a workspace to start.");
    return;
  }

  if (state.panes.length === 0) {
    paneSurface.innerHTML = "";
    state.paneCards.clear();
    state.paneMeta.clear();
    state.quickCommandOpenPaneId = null;
    disposeAllViews();
    renderPaneEmptyState("No panes available", "Refresh workspace or create a new workspace.");
    return;
  }

  const paneMap = new Map(state.panes.map((p) => [p.pane_id, p]));
  const root = state.panes.find((p) => p.parent_id === null);

  if (!root) {
    paneSurface.innerHTML = "";
    state.paneCards.clear();
    state.paneMeta.clear();
    state.quickCommandOpenPaneId = null;
    disposeAllViews();
    renderPaneEmptyState("Invalid layout", "Root pane not found. Re-open workspace or restart the app.");
    return;
  }

  // On workspace switch: stash current workspace's views into cache, restore returning workspace's views
  const renderingWorkspaceId = state.selectedWorkspaceId;
  if (state._lastRenderedWorkspaceId !== renderingWorkspaceId) {
    // Save outgoing workspace's live views into cache (stop polling first)
    if (state._lastRenderedWorkspaceId) {
      for (const view of state.paneViews.values()) {
        if (view.poller) { clearInterval(view.poller); view.poller = null; }
        if (view.flushTimer) { clearTimeout(view.flushTimer); view.flushTimer = null; }
        if (view.flushRaf) { cancelAnimationFrame(view.flushRaf); view.flushRaf = null; }
        view.readBusy = false;
        view.outputQueue = "";
      }
      state.workspacePaneViewCache.set(state._lastRenderedWorkspaceId, new Map(state.paneViews));
      state.paneViews.clear();
    }
    // Restore incoming workspace's cached views (if any)
    const cached = state.workspacePaneViewCache.get(renderingWorkspaceId);
    if (cached) {
      for (const [paneId, view] of cached.entries()) {
        state.paneViews.set(paneId, view);
      }
    }
    state._lastRenderedWorkspaceId = renderingWorkspaceId;
  }

  // Preserve existing views so scrollback buffers survive layout changes within same workspace
  const survivingPaneIds = new Set(leafPanes().map((p) => p.pane_id));
  const preservedViews = new Map();
  for (const [paneId, view] of state.paneViews.entries()) {
    if (survivingPaneIds.has(paneId)) {
      preservedViews.set(paneId, view);
    } else {
      disposeView(view);
    }
  }
  state.paneViews.clear();
  for (const [paneId, view] of preservedViews.entries()) {
    state.paneViews.set(paneId, view);
  }

  paneSurface.innerHTML = "";
  state.paneCards.clear();
  state.paneMeta.clear();
  state.quickCommandOpenPaneId = null;

  const hosts = [];
  const rootNode = renderPaneNode(root, paneMap, hosts);
  paneSurface.appendChild(rootNode);

  for (const item of hosts) {
    const existing = state.paneViews.get(item.paneId);
    if (existing) {
      // Reuse existing xterm — append xterm's own root element into the new slot.
      // Using term.element (the .xterm div) preserves xterm's internal _element reference
      // so fitAddon.fit() measures the correct container after workspace switch.
      if (existing.term.element) {
        item.host.appendChild(existing.term.element);
      }
      existing.host = item.host;
      existing.observer?.disconnect();
      const observer = new ResizeObserver(() => {
        updatePaneActionLayout(item.paneId);
        existing.fitAddon.fit();
        schedulePaneResize(existing);
      });
      observer.observe(item.host);
      existing.observer = observer;
    } else {
      createPaneView(item.paneId, item.host);
    }
  }

  refreshPaneBindings();
  applyPaneSelectionStyles();
  // Defer fit until after browser has applied layout, so xterm gets correct dimensions
  requestAnimationFrame(() => {
    fitAllPanes();
    // Second pass after any CSS transitions settle
    setTimeout(() => fitAllPanes(), 80);
  });
}

function renderPaneEmptyState(title, description) {
  const wrap = document.createElement("div");
  wrap.className = "pane-empty-state";

  const titleEl = document.createElement("div");
  titleEl.className = "pane-empty-title";
  titleEl.textContent = title;

  const descriptionEl = document.createElement("div");
  descriptionEl.className = "pane-empty-desc";
  descriptionEl.textContent = description;

  wrap.append(titleEl, descriptionEl);
  paneSurface.appendChild(wrap);
}

function refreshPaneBindings() {
  const runningMap = new Map(runningSessions().map((s) => [s.id, s]));
  const leafCount = leafPanes().length;

  for (const pane of leafPanes()) {
    const paneId = pane.pane_id;
    let sessionId = state.paneSessions[paneId] ?? null;

    if (sessionId && !runningMap.has(sessionId)) {
      // Only clear if the session is not in the DB at all (truly gone),
      // not merely absent from runningSessions yet (could be newly starting).
      // runningSessions() reflects state.sessions which may lag behind session.run.
      // We rely on normalizePaneSessions (which also checks leafIds) for thorough cleanup.
      const knownToState = state.sessions.some((s) => s.id === sessionId);
      if (!knownToState) {
        delete state.paneSessions[paneId];
        sessionId = null;
      }
    }

    const meta = state.paneMeta.get(paneId);
    const fontSize = currentPaneFontSize(state.selectedWorkspaceId, paneId);
    const unreadCount = unreadRowsForPane(paneId, sessionId).length;
    if (meta) {
      if (sessionId) {
        const session = runningMap.get(sessionId);
        meta.statusEl.textContent = session ? `Running - pid ${session.pid}` : "Attached";
        meta.startBtn.textContent = "Restart";
        meta.startBtn.dataset.fullLabel = "Restart";
        meta.closeBtn.disabled = false;
      } else {
        meta.statusEl.textContent = "No session";
        meta.startBtn.textContent = "Start";
        meta.startBtn.dataset.fullLabel = "Start";
        meta.closeBtn.disabled = true;
      }
      meta.fontDownBtn.disabled = fontSize <= PANE_FONT_LIMITS.min;
      meta.fontUpBtn.disabled = fontSize >= PANE_FONT_LIMITS.max;
      meta.closePaneBtn.disabled = leafCount <= 1;
      meta.hidePaneBtn.disabled = leafCount <= 1;
      meta.unreadBadgeEl.hidden = unreadCount <= 0;
      meta.unreadBadgeEl.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
    }
    const card = state.paneCards.get(paneId);
    if (card) {
      card.classList.toggle("pane-has-unread", unreadCount > 0);
    }
    updatePaneActionLayout(paneId);

    const view = state.paneViews.get(paneId);
    if (view) {
      applyPaneFontToView(paneId, fontSize);
      bindViewToSession(view, sessionId);
    }
  }

  applyPaneSelectionStyles();
}

async function openSessionPicker(paneId, anchorBtn) {
  const _loadSessions = typeof globalThis.loadSessions === "function" ? globalThis.loadSessions : async () => {};

  // Close any existing dropdown
  document.querySelectorAll(".session-picker-dropdown").forEach((el) => el.remove());

  const ws = selectedWorkspace();
  if (!ws) return;

  const [histRes, aiRes] = await Promise.all([
    rpc("session.history", { workspace_id: ws.id }).catch(() => null),
    rpc("ai.sessions", { workspace_id: ws.id }).catch(() => null),
  ]);
  const aiSessions = aiRes?.sessions ?? [];

  const dropdown = document.createElement("div");
  dropdown.className = "session-picker-dropdown";

  // AI Sessions section (Claude / Codex conversation sessions)
  if (aiSessions.length > 0) {
    const aiHeader = document.createElement("div");
    aiHeader.className = "session-picker-header";
    aiHeader.textContent = "AI Sessions (Claude / Codex)";
    dropdown.appendChild(aiHeader);

    for (const ai of aiSessions) {
      const dateObj = new Date(ai.detected_at);
      const timeStr = dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

      const item = document.createElement("div");
      item.className = "session-picker-item ai-session";

      const dot = document.createElement("span");
      dot.className = "session-status-dot ai-dot";
      dot.title = ai.tool;

      const info = document.createElement("div");
      info.className = "session-item-info";

      const labelEl = document.createElement("span");
      labelEl.className = "session-label";
      labelEl.title = ai.resume_cmd;
      labelEl.textContent = ai.resume_cmd;

      const metaEl = document.createElement("span");
      metaEl.className = "session-meta";
      metaEl.textContent = `${ai.tool} - detected ${timeStr}`;

      info.append(labelEl, metaEl);

      const resumeBtn = document.createElement("button");
      resumeBtn.className = "session-attach-btn";
      resumeBtn.textContent = "Resume";
      resumeBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        dropdown.remove();
        try {
          // Run via pwsh so PATH resolution works (claude is a Node script on PATH)
          await paneHandlers.startSessionForPane(paneId, {
            force: true,
            cmd: "pwsh.exe",
            args: [
              "-NoLogo", "-NoExit",
              "-Command",
              `$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); [Console]::InputEncoding=[Text.UTF8Encoding]::new(); if (Get-Variable PSStyle -ErrorAction SilentlyContinue) { $PSStyle.OutputRendering = 'Ansi' }; ${ai.resume_cmd}`,
            ],
            cwd: ai.cwd || undefined,
          });
        } catch {
          try {
            await paneHandlers.startSessionForPane(paneId, {
              force: true,
              cmd: "powershell.exe",
              args: ["-NoLogo", "-NoExit", "-Command", ai.resume_cmd],
              cwd: ai.cwd || undefined,
            });
          } catch (err2) {
            setStatus(String(err2?.message ?? err2), true);
          }
        }
      });

      item.append(dot, info, resumeBtn);
      dropdown.appendChild(item);
    }
  }

  // PTY Sessions section
  const allSessions = histRes?.sessions ?? [];
  const namedSessions = allSessions.filter((s) => s.spawn_cmd);
  const sessionSignature = (session) => {
    let argsText = "[]";
    try {
      const parsed = JSON.parse(session.spawn_args || "[]");
      argsText = JSON.stringify(Array.isArray(parsed) ? parsed : []);
    } catch {
      argsText = String(session.spawn_args || "[]");
    }
    return `${session.spawn_cmd || ""}|${argsText}|${session.spawn_cwd || ""}`;
  };

  // De-duplicate by command signature:
  // 1) keep running rows
  // 2) for non-running, keep only latest one per signature
  // 3) if a signature has running, hide its exited rows
  const runningSignatures = new Set();
  for (const session of namedSessions) {
    if (session.status === "running") {
      runningSignatures.add(sessionSignature(session));
    }
  }
  const keptExited = new Set();
  const displaySessions = [];
  for (const session of namedSessions) {
    const signature = sessionSignature(session);
    if (session.status === "running") {
      displaySessions.push(session);
      continue;
    }
    if (runningSignatures.has(signature)) {
      continue;
    }
    if (keptExited.has(signature)) {
      continue;
    }
    keptExited.add(signature);
    displaySessions.push(session);
  }

  if (displaySessions.length > 0 || aiSessions.length === 0) {
    const ptyHeader = document.createElement("div");
    ptyHeader.className = "session-picker-header";
    ptyHeader.textContent = "PTY Sessions";
    dropdown.appendChild(ptyHeader);

    if (displaySessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "session-picker-empty";
      empty.textContent = "No named sessions yet - use the input below";
      dropdown.appendChild(empty);
    } else {
      for (const s of displaySessions) {
        let label;
        try {
          const parsedArgs = JSON.parse(s.spawn_args || "[]");
          const displayArgs = parsedArgs.filter((a) => !a.startsWith("-No") && !a.startsWith("chcp") && !a.startsWith("$Output") && !a.startsWith("[Console]"));
          label = displayArgs.length > 0
            ? `${s.spawn_cmd} ${displayArgs.join(" ")}`.trim()
            : s.spawn_cmd;
        } catch {
          label = s.spawn_cmd;
        }
        const dateObj = new Date(s.started_at);
        const timeStr = dateObj.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
                        dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const isRunning = s.status === "running";

        const item = document.createElement("div");
        item.className = `session-picker-item ${s.status}`;

        const dot = document.createElement("span");
        dot.className = "session-status-dot";
        dot.title = s.status;

        const info = document.createElement("div");
        info.className = "session-item-info";

        const labelEl = document.createElement("span");
        labelEl.className = "session-label";
        labelEl.title = label;
        labelEl.textContent = label;

        const metaEl = document.createElement("span");
        metaEl.className = "session-meta";
        metaEl.textContent = `${s.id.slice(0, 8)} · ${isRunning ? "running" : s.status} · ${timeStr}`;

        info.append(labelEl, metaEl);

        const attachBtn = document.createElement("button");
        attachBtn.className = "session-attach-btn";
        attachBtn.textContent = isRunning ? "Attach" : "Re-run";
        attachBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          dropdown.remove();
          try {
            if (isRunning) {
              const currentSid = state.paneSessions[paneId] ?? null;
              if (currentSid && currentSid !== s.id) {
                await rpc("session.close", { session_id: currentSid }).catch(() => {});
              }
              state.paneSessions[paneId] = s.id;
              rpc("pane.session.bind", { workspace_id: ws.id, pane_id: paneId, session_id: s.id }).catch(() => {});
              await _loadSessions();
              paneApi.normalizePaneSessions();
              paneApi.refreshPaneBindings();
              setStatus(`Attached: ${s.id.slice(0, 8)}`);
            } else {
              let parsedArgs = [];
              try { parsedArgs = JSON.parse(s.spawn_args || "[]"); } catch { /* */ }
              await paneHandlers.startSessionForPane(paneId, {
                force: true,
                cmd: s.spawn_cmd,
                args: parsedArgs,
                cwd: s.spawn_cwd || undefined,
              });
            }
          } catch (err) {
            setStatus(String(err?.message ?? err), true);
          }
        });

        item.append(dot, info, attachBtn);

        if (!isRunning) {
          const deleteBtn = document.createElement("button");
          deleteBtn.className = "session-delete-btn";
          deleteBtn.textContent = "✕";
          deleteBtn.title = "Delete this session record";
          deleteBtn.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            try {
              await rpc("session.delete", { session_id: s.id });
              item.remove();
            } catch (err) {
              setStatus(String(err?.message ?? err), true);
            }
          });
          item.append(deleteBtn);
        }

        dropdown.appendChild(item);
      }
    }
  }

  // New session input row
  const newRow = document.createElement("div");
  newRow.className = "session-picker-new";

  const newLabel = document.createElement("span");
  newLabel.className = "session-picker-new-label";
  newLabel.textContent = "+ New";

  const cmdInput = document.createElement("input");
  cmdInput.className = "session-cmd-input";
  cmdInput.placeholder = "claude / codex / pwsh";
  cmdInput.addEventListener("keydown", async (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      runNewSession();
    }
    ev.stopPropagation();
  });

  const runBtn = document.createElement("button");
  runBtn.className = "session-run-btn";
  runBtn.textContent = "Run";

  async function runNewSession() {
    const raw = cmdInput.value.trim();
    if (!raw) return;
    dropdown.remove();
    // If user typed a shell-like command (e.g. "claude", "codex --resume xyz"),
    // run it inside pwsh so PATH resolution works
    const psCmd = `$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); [Console]::InputEncoding=[Text.UTF8Encoding]::new(); if (Get-Variable PSStyle -ErrorAction SilentlyContinue) { $PSStyle.OutputRendering = 'Ansi' }; ${raw}`;
    try {
      await paneHandlers.startSessionForPane(paneId, {
        force: true,
        cmd: "pwsh.exe",
        args: ["-NoLogo", "-NoExit", "-Command", psCmd],
      });
    } catch {
      try {
        await paneHandlers.startSessionForPane(paneId, {
          force: true,
          cmd: "powershell.exe",
          args: ["-NoLogo", "-NoExit", "-Command", raw],
        });
      } catch (err2) {
        setStatus(String(err2?.message ?? err2), true);
      }
    }
  }

  runBtn.addEventListener("click", runNewSession);
  newRow.append(newLabel, cmdInput, runBtn);
  dropdown.appendChild(newRow);

  // Position: prefer below anchor, flip up if too low
  document.body.appendChild(dropdown);
  const rect = anchorBtn.getBoundingClientRect();
  const dropH = dropdown.offsetHeight || 300;
  const dropW = dropdown.offsetWidth || 340;
  let top = rect.bottom + 4;
  let left = rect.left;
  if (top + dropH > window.innerHeight - 10) {
    top = rect.top - dropH - 4;
  }
  if (left + dropW > window.innerWidth - 10) {
    left = window.innerWidth - dropW - 10;
  }
  dropdown.style.top = `${top}px`;
  dropdown.style.left = `${left}px`;

  // Close on outside click
  const closeHandler = (ev) => {
    if (!dropdown.contains(ev.target)) {
      dropdown.remove();
      document.removeEventListener("click", closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener("click", closeHandler, true), 0);

  cmdInput.focus();
}

globalThis.setPaneHandlers = setPaneHandlers;
globalThis.paneForSession = paneForSession;
globalThis.enqueueStreamOutput = enqueueStreamOutput;
globalThis.normalizePaneSessions = normalizePaneSessions;
globalThis.renderPaneSurface = renderPaneSurface;
globalThis.refreshPaneBindings = refreshPaneBindings;
globalThis.selectPane = selectPane;
globalThis.fitAllPanes = fitAllPanes;
globalThis.writeToPane = writeToPane;
