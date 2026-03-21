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

  // 사용자가 스크롤을 올려서 보고 있는 중이면 write 후 위치 유지
  const buf = view.term.buffer.active;
  const isScrolledUp = buf.viewportY < buf.baseY;
  const savedViewportY = isScrolledUp ? buf.viewportY : null;

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
  return stable.join("|");
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
}

function fitAllPanes() {
  for (const view of state.paneViews.values()) {
    try {
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
  if (!view.sessionId) {
    return;
  }

  view.pendingInput += data;
  if (view.flushTimer) {
    return;
  }

  view.flushTimer = setTimeout(() => {
    flushPaneInput(view).catch((err) => {
      const msg = err?.message ?? String(err);
      if (msg.includes("ENOENT") || msg.includes("pipe")) {
        setStatus("Core reconnecting, retrying input...", true);
      } else {
        setStatus(`Terminal input error: ${msg}`, true);
      }
    });
  }, 12);
}

async function flushPaneInput(view) {
  view.flushTimer = null;
  if (!view.sessionId || !view.pendingInput) {
    return;
  }

  const payload = view.pendingInput;
  const started = performance.now();
  await rpc("session.write", { session_id: view.sessionId, data: payload });
  view.pendingInput = view.pendingInput.slice(payload.length);
  const latency = performance.now() - started;
  state.metrics.input_latency_ms.push(latency);
  if (state.metrics.input_latency_ms.length > 50) {
    state.metrics.input_latency_ms.shift();
  }
  logPerf("input.latency", { pane_id: view.paneId, session_id: view.sessionId, latency_ms: Number(latency.toFixed(2)) });

  if (view.pendingInput) {
    view.flushTimer = setTimeout(() => {
      flushPaneInput(view).catch((err) => {
        const msg = err?.message ?? String(err);
        if (msg.includes("ENOENT") || msg.includes("pipe")) {
          setStatus("Core reconnecting, retrying input...", true);
        } else {
          setStatus(`Terminal input error: ${msg}`, true);
        }
      });
    }, 12);
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
  if (view.sessionId === nextSession) {
    return;
  }
  const previousSession = view.sessionId;
  if (previousSession && previousSession !== nextSession) {
    clearPromptDetectorSession(previousSession);
  }

  if (view.poller) {
    clearInterval(view.poller);
    view.poller = null;
  }
  if (view.flushTimer) {
    clearTimeout(view.flushTimer);
    view.flushTimer = null;
  }
  if (view.flushRaf) {
    cancelAnimationFrame(view.flushRaf);
    view.flushRaf = null;
  }

  view.pendingInput = "";
  view.outputQueue = "";
  view.readBusy = false;
  view.sessionId = nextSession;
  view.term.reset();

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
        view.term.write(normalizeTerminalOutput(res.output), () => {
          if (savedViewportY !== null) {
            view.term.scrollToLine(savedViewportY);
          }
        });
      }
    } catch (err) {
      const message = String(err?.message ?? err);
      if (message.includes("session not found")) {
        delete state.paneSessions[view.paneId];
        bindViewToSession(view, null);
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

  actions.append(fontDownBtn, fontUpBtn, splitHBtn, splitVBtn, startBtn, closeBtn, hidePaneBtn, quickBtn, closePaneBtn);
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
    statusEl,
    splitHBtn,
    splitVBtn,
    startBtn,
    closeBtn,
    closePaneBtn,
    hidePaneBtn,
    fontDownBtn,
    fontUpBtn,
    quickBtn,
    quickPanel,
    unreadBadgeEl
  });
  bindQuickCommandPanelSafe(paneId, quickPanel, quickBtn);

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
    poller: null,
    observer: null,
    pendingInput: "",
    flushTimer: null,
    flushRaf: null,
    outputQueue: "",
    resizeTimer: null,
    readBusy: false,
    isComposing: false,
    imeTextarea: null,
    imeBindTimer: null,
    onCompositionStart: null,
    onCompositionEnd: null
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

    if (ev.ctrlKey && ev.shiftKey && key === "v") {
      void window.wincmux.clipboardRead().then((text) => {
        if (text) {
          queuePaneInput(view, text);
        }
      });
      return false;
    }

    return true;
  });

  term.onData((data) => {
    logIme("onData", { pane_id: paneId, len: data.length, composing: view.isComposing });
    queuePaneInput(view, data);
  });

  term.onBinary((data) => {
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
  paneSurface.innerHTML = "";
  state.paneCards.clear();
  state.paneMeta.clear();
  state.quickCommandOpenPaneId = null;
  disposeAllViews();

  if (!state.selectedWorkspaceId) {
    renderPaneEmptyState("No workspace selected", "Create or select a workspace to start.");
    return;
  }

  if (state.panes.length === 0) {
    renderPaneEmptyState("No panes available", "Refresh workspace or create a new workspace.");
    return;
  }

  const paneMap = new Map(state.panes.map((p) => [p.pane_id, p]));
  const root = state.panes.find((p) => p.parent_id === null);

  if (!root) {
    renderPaneEmptyState("Invalid layout", "Root pane not found. Re-open workspace or restart the app.");
    return;
  }

  const hosts = [];
  const rootNode = renderPaneNode(root, paneMap, hosts);
  paneSurface.appendChild(rootNode);

  for (const item of hosts) {
    createPaneView(item.paneId, item.host);
  }

  refreshPaneBindings();
  applyPaneSelectionStyles();
  fitAllPanes();
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
      delete state.paneSessions[paneId];
      sessionId = null;
    }

    const meta = state.paneMeta.get(paneId);
    const fontSize = currentPaneFontSize(state.selectedWorkspaceId, paneId);
    const unreadCount = unreadRowsForPane(paneId, sessionId).length;
    if (meta) {
      if (sessionId) {
        const session = runningMap.get(sessionId);
        meta.statusEl.textContent = session ? `Running - pid ${session.pid}` : "Attached";
        meta.startBtn.textContent = "Restart";
        meta.closeBtn.disabled = false;
      } else {
        meta.statusEl.textContent = "No session";
        meta.startBtn.textContent = "Start";
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

    const view = state.paneViews.get(paneId);
    if (view) {
      applyPaneFontToView(paneId, fontSize);
      bindViewToSession(view, sessionId);
    }
  }

  applyPaneSelectionStyles();
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
