const paneHandlers = {
  startSessionForPane: async () => {},
  closeSessionForPane: async () => {},
  splitPane: async () => {},
  closePane: async () => {},
  hidePane: async () => {},
  adjustPaneFont: async () => {},
  insertQuickCommand: async () => {},
  markPaneNotificationsRead: async () => {},
  startPaneMove: async () => {},
  swapPanePositions: async () => {},
  movePaneToPlacement: async () => {},
  movePaneToGroup: async () => {},
  openSessionInSplit: async () => {}
};
const INPUT_FLUSH_DELAY_MS = 12;
const INPUT_RETRY_DELAY_MS = 120;
const IME_COMMIT_WAIT_MS = 80;
const IME_DUPLICATE_WINDOW_MS = 220;
const PANE_DEBUG_LOGS = localStorage.getItem("wincmux.debug.panes") === "1";

function paneDebug(...args) {
  if (PANE_DEBUG_LOGS) {
    console.debug(...args);
  }
}

function paneWarn(...args) {
  if (PANE_DEBUG_LOGS) {
    console.warn(...args);
  }
}

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

const paneIcon = {
  fontDown: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 15l4.5-10 4.5 10"/><path d="M5.5 11h6"/><path d="M14.5 13h3"/></svg>`,
  fontUp: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 15l4.5-10 4.5 10"/><path d="M5.5 11h6"/><path d="M16 10v6"/><path d="M13 13h6"/></svg>`,
  splitRight: `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M10 4v12"/><path d="M13.5 10h2.5"/><path d="M14.75 8.75v2.5"/></svg>`,
  splitDown: `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 10h14"/><path d="M8.75 13h2.5"/><path d="M10 11.75v2.5"/></svg>`,
  start: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5.5v9l7-4.5-7-4.5z" fill="currentColor" stroke="none"/></svg>`,
  restart: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 9.5a5.5 5.5 0 1 1-1.7-4"/><path d="M14 2.5v3.5h3.5"/></svg>`,
  restore: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 11a5 5 0 1 0 1.4-4.2"/><path d="M3.5 7h3.8v-3.8"/></svg>`,
  sessions: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5.5h10"/><path d="M5 10h10"/><path d="M5 14.5h6"/><circle cx="3" cy="5.5" r=".7" fill="currentColor" stroke="none"/><circle cx="3" cy="10" r=".7" fill="currentColor" stroke="none"/><circle cx="3" cy="14.5" r=".7" fill="currentColor" stroke="none"/></svg>`,
  closeSession: `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="5" width="12" height="10" rx="2"/><path d="M8 8.5l4 3"/><path d="M12 8.5l-4 3"/></svg>`,
  closePane: `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="2"/><path d="M7.5 7.5l5 5"/><path d="M12.5 7.5l-5 5"/></svg>`,
  hidePane: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 10s2.8-4.5 7.5-4.5 7.5 4.5 7.5 4.5-2.8 4.5-7.5 4.5S2.5 10 2.5 10z"/><path d="M3.5 3.5l13 13"/></svg>`,
  movePane: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v14"/><path d="M7.5 5.5L10 3l2.5 2.5"/><path d="M7.5 14.5L10 17l2.5-2.5"/><path d="M3 10h14"/><path d="M5.5 7.5L3 10l2.5 2.5"/><path d="M14.5 7.5L17 10l-2.5 2.5"/></svg>`,
  quick: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 2.5l-6 8h5l-1 7 6-8h-5l1-7z" fill="currentColor" stroke="none"/><circle cx="15.5" cy="4.5" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  auto: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5h10v10H5z"/><path d="M8 3h4"/><path d="M8 17h4"/><path d="M3 8v4"/><path d="M17 8v4"/></svg>`,
  group: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4.5h8l2.5 2.5v8.5h-13v-11z"/><path d="M6 4.5v3h10.5"/><path d="M7 11h6"/><path d="M7 14h4"/></svg>`,
  more: `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none"/></svg>`
};

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
  if (typeof handlers.startPaneMove === "function") {
    paneHandlers.startPaneMove = handlers.startPaneMove;
  }
  if (typeof handlers.swapPanePositions === "function") {
    paneHandlers.swapPanePositions = handlers.swapPanePositions;
  }
  if (typeof handlers.movePaneToPlacement === "function") {
    paneHandlers.movePaneToPlacement = handlers.movePaneToPlacement;
  }
  if (typeof handlers.movePaneToGroup === "function") {
    paneHandlers.movePaneToGroup = handlers.movePaneToGroup;
  }
  if (typeof handlers.openSessionInSplit === "function") {
    paneHandlers.openSessionInSplit = handlers.openSessionInSplit;
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

function openPaneGroupMenu(paneId, anchorBtn) {
  document.querySelectorAll(".pane-group-menu").forEach((el) => el.remove());
  const ws = selectedWorkspace();
  if (!ws || !state.paneGroups.length) {
    setStatus("No pane groups available.", true);
    return;
  }

  const menu = document.createElement("div");
  menu.className = "pane-group-menu";

  const title = document.createElement("div");
  title.className = "pane-group-menu-title";
  title.textContent = "Move this terminal";
  menu.appendChild(title);

  const hint = document.createElement("div");
  hint.className = "pane-group-menu-hint";
  hint.textContent = "Pick a group, or create one below.";
  menu.appendChild(hint);

  const currentGroup = typeof groupForPane === "function" ? groupForPane(paneId) : null;
  for (const group of state.paneGroups) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pane-group-menu-item";
    btn.style.setProperty("--group-color", group.color ?? "#6b7c93");
    btn.textContent = group.name;
    btn.dataset.active = currentGroup?.id === group.id ? "1" : "0";
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      menu.remove();
      try {
        await paneHandlers.movePaneToGroup(paneId, group.id);
      } catch (err) {
        setStatus(String(err?.message ?? err), true);
      }
    });
    menu.appendChild(btn);
  }

  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "pane-group-menu-item pane-group-menu-new";
  newBtn.textContent = "+ New group...";
  newBtn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    menu.remove();
    if (typeof showGroupCreateInput === "function") {
      showGroupCreateInput(groupBar?.querySelector(".group-add"), {
        onCreated: (group) => paneHandlers.movePaneToGroup(paneId, group.id)
      });
      return;
    }
    setStatus("Group creator unavailable.", true);
  });
  menu.appendChild(newBtn);

  document.body.appendChild(menu);
  const rect = anchorBtn.getBoundingClientRect();
  const menuW = menu.offsetWidth || 180;
  const menuH = menu.offsetHeight || 220;
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + menuW > window.innerWidth - 10) {
    left = window.innerWidth - menuW - 10;
  }
  if (top + menuH > window.innerHeight - 10) {
    top = rect.top - menuH - 4;
  }
  menu.style.left = `${Math.max(10, left)}px`;
  menu.style.top = `${Math.max(10, top)}px`;

  const closeHandler = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("click", closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener("click", closeHandler, true), 0);
}

function ensurePaneOverlay(view) {
  if (!view.overlayEl) {
    const overlay = document.createElement("div");
    overlay.className = "pane-terminal-overlay";

    const title = document.createElement("div");
    title.className = "pane-terminal-overlay-title";

    const detail = document.createElement("div");
    detail.className = "pane-terminal-overlay-detail";

    const action = document.createElement("button");
    action.className = "pane-terminal-overlay-action";
    action.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const mode = overlay.dataset.mode ?? "empty";
      setPaneOverlay(view, "starting", "Starting session...", "Launching terminal process");
      paneHandlers.startSessionForPane(view.paneId, {
        force: mode !== "dormant" && Boolean(view.sessionId),
        restoreDormant: mode === "dormant",
        focusTerm: true
      }).catch((err) => {
        const canRestore = mode === "dormant";
        if (mode === "running" || mode === "detached") {
          const title = mode === "detached" ? "Session detached" : "Session running";
          setPaneOverlay(view, mode, title, String(err?.message ?? err), "Restart");
        } else {
          setPaneOverlay(view, mode, canRestore ? "Restore available" : "No session running", String(err?.message ?? err), canRestore ? "Restore" : "Start");
        }
        setStatus(String(err?.message ?? err), true);
      });
    });

    overlay.append(title, detail, action);
    view.overlayEl = overlay;
    view.overlayTitleEl = title;
    view.overlayDetailEl = detail;
    view.overlayActionEl = action;
  }

  if (view.overlayEl.parentElement !== view.host) {
    view.host.appendChild(view.overlayEl);
  }
}

function setPaneOverlay(view, mode, title, detail = "", actionLabel = "") {
  if (!view) {
    return;
  }
  ensurePaneOverlay(view);
  view.overlayEl.dataset.mode = mode;
  view.overlayTitleEl.textContent = title;
  view.overlayDetailEl.textContent = detail;
  view.overlayDetailEl.hidden = !detail;
  view.overlayActionEl.textContent = actionLabel;
  view.overlayActionEl.hidden = !actionLabel;
  view.overlayEl.hidden = false;
}

function hidePaneOverlay(view) {
  if (view?.overlayEl) {
    view.overlayEl.hidden = true;
  }
}

function markPaneStarting(paneId, title = "Starting session...", detail = "Launching terminal process") {
  const view = state.paneViews.get(paneId);
  if (!view) {
    return;
  }
  setPaneOverlay(view, "starting", title, detail);
}

function markPaneDetached(view, detail = "Terminal process is no longer attached") {
  if (!view) {
    return;
  }
  view.detached = true;
  setPaneOverlay(view, "detached", "Session detached", detail, "Restart");
  const meta = state.paneMeta.get(view.paneId);
  if (meta) {
    meta.statusEl.textContent = "Detached";
    meta.statusEl.title = detail;
    meta.startBtn.dataset.fullLabel = "Restart";
    meta.closeBtn.disabled = false;
  }
}

function focusPaneView(view) {
  if (!view) {
    return;
  }
  rebindImeTextarea(view);
  view.term.focus();
  window.requestAnimationFrame(() => {
    rebindImeTextarea(view);
  });
}

function focusPaneTerm(paneId) {
  focusPaneView(state.paneViews.get(paneId));
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
  view.hasOutput = true;
  hidePaneOverlay(view);
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

  paneDebug("[normalize] running sessions:", [...running.keys()].map(s => s.slice(0,8)));
  paneDebug("[normalize] paneSessions before:", Object.entries(state.paneSessions).map(([p,s]) => `${p.slice(0,8)}→${s?.slice(0,8)}`));

  for (const paneId of Object.keys(state.paneSessions)) {
    const sid = state.paneSessions[paneId];
    // Only clean up entries belonging to the CURRENT workspace's panes.
    // paneIds not in leafIds belong to other workspaces — preserve them for workspace-switch cache.
    if (!leafIds.has(paneId)) continue;
    if (sid && (!running.has(sid) || hiddenSessions.has(sid))) {
      paneWarn("[normalize] DELETING pane session:", paneId.slice(0,8), "->", sid?.slice(0,8), "reason: running=", running.has(sid), "hidden=", hiddenSessions.has(sid));
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
  const moveSourcePaneId = state.paneMove?.sourcePaneId ?? null;
  const moveTargetPaneId = state.paneMove?.targetPaneId ?? null;
  const placement = state.paneMove?.placement ?? null;
  for (const [paneId, card] of state.paneCards.entries()) {
    card.classList.toggle("active", paneId === state.selectedPaneId);
    card.classList.toggle("pane-move-source", paneId === moveSourcePaneId);
    card.classList.toggle("pane-move-target", Boolean(moveSourcePaneId) && paneId !== moveSourcePaneId);
    card.classList.toggle("pane-drop-active", paneId === moveTargetPaneId);
    for (const key of ["left", "right", "above", "below"]) {
      card.classList.toggle(`pane-drop-${key}`, paneId === moveTargetPaneId && placement === key);
    }
  }
  selectedPaneLabel.textContent = `Selected Pane: ${state.selectedPaneId ? state.selectedPaneId.slice(0, 8) : "-"}`;
}

function paneDropPlacement(card, clientX, clientY) {
  const rect = card.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  const y = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
  const dx = Math.abs(x - 0.5);
  const dy = Math.abs(y - 0.5);
  if (dy >= dx) {
    return y < 0.5 ? "above" : "below";
  }
  return x < 0.5 ? "left" : "right";
}

function setPaneMoveTarget(paneId, placement) {
  state.paneMove.targetPaneId = paneId;
  state.paneMove.placement = placement;
  applyPaneSelectionStyles();
}

function clearPaneMoveTarget(paneId = null) {
  if (paneId && state.paneMove.targetPaneId !== paneId) {
    return;
  }
  state.paneMove.targetPaneId = null;
  state.paneMove.placement = null;
  applyPaneSelectionStyles();
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
      focusPaneView(state.paneViews.get(paneId));
    });
  }
}

function orderedLeafPaneIds() {
  return leafPanes().map((pane) => pane.pane_id).filter(Boolean);
}

async function selectAdjacentPane(delta = 1, options = {}) {
  const paneIds = orderedLeafPaneIds();
  if (paneIds.length === 0) {
    return null;
  }
  const currentIndex = state.selectedPaneId ? paneIds.indexOf(state.selectedPaneId) : -1;
  const startIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (startIndex + delta + paneIds.length) % paneIds.length;
  const nextPaneId = paneIds[nextIndex];
  await selectPane(nextPaneId, {
    persist: true,
    focusTerm: options.focusTerm !== false
  });
  setStatus(`Selected pane: ${nextPaneId.slice(0, 8)}`);
  return nextPaneId;
}

async function selectPaneByDirection(direction, options = {}) {
  const currentPaneId = state.selectedPaneId;
  const currentCard = currentPaneId ? state.paneCards.get(currentPaneId) : null;
  if (!currentCard) {
    return selectAdjacentPane(direction === "left" || direction === "up" ? -1 : 1, options);
  }

  const currentRect = currentCard.getBoundingClientRect();
  const currentCenter = {
    x: currentRect.left + currentRect.width / 2,
    y: currentRect.top + currentRect.height / 2
  };
  let best = null;
  for (const [paneId, card] of state.paneCards.entries()) {
    if (paneId === currentPaneId) {
      continue;
    }
    const rect = card.getBoundingClientRect();
    const center = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
    const dx = center.x - currentCenter.x;
    const dy = center.y - currentCenter.y;
    const isCandidate =
      (direction === "left" && dx < -4)
      || (direction === "right" && dx > 4)
      || (direction === "up" && dy < -4)
      || (direction === "down" && dy > 4);
    if (!isCandidate) {
      continue;
    }
    const primary = direction === "left" || direction === "right" ? Math.abs(dx) : Math.abs(dy);
    const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = primary + secondary * 0.45;
    if (!best || score < best.score) {
      best = { paneId, score };
    }
  }

  if (!best) {
    return null;
  }
  await selectPane(best.paneId, {
    persist: true,
    focusTerm: options.focusTerm !== false
  });
  setStatus(`Selected pane: ${best.paneId.slice(0, 8)}`);
  return best.paneId;
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
  if (view.compositionFlushTimer) {
    clearTimeout(view.compositionFlushTimer);
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
    if (view.onCompositionUpdate) {
      view.imeTextarea.removeEventListener("compositionupdate", view.onCompositionUpdate);
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
  state.workspacePaneSessionCache.clear();
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

function countLeaves(node, paneMap) {
  if (!node.split) {
    return 1;
  }
  const first = paneMap.get(node.split.first);
  const second = paneMap.get(node.split.second);
  return (first ? countLeaves(first, paneMap) : 1) + (second ? countLeaves(second, paneMap) : 1);
}

function applyEqualFlex(node, paneMap, el) {
  if (!node.split) {
    return;
  }
  const firstChild = paneMap.get(node.split.first);
  const secondChild = paneMap.get(node.split.second);
  const firstLeaves = firstChild ? countLeaves(firstChild, paneMap) : 1;
  const secondLeaves = secondChild ? countLeaves(secondChild, paneMap) : 1;

  // Children of this split are the first and second .pane-split-item elements
  const items = Array.from(el.children).filter((c) => c.classList.contains("pane-split-item"));
  if (items.length === 2) {
    items[0].style.flex = `${firstLeaves} 1 0`;
    items[1].style.flex = `${secondLeaves} 1 0`;
  }

  // Recurse into sub-splits
  if (firstChild?.split && items[0]) {
    applyEqualFlex(firstChild, paneMap, items[0]);
  }
  if (secondChild?.split && items[1]) {
    applyEqualFlex(secondChild, paneMap, items[1]);
  }
}

function equalizePaneSizes() {
  if (!state.panes || state.panes.length === 0) {
    return;
  }
  // Reset stored ratios
  state.splitRatios = {};
  saveSplitRatios();

  const paneMap = new Map(state.panes.map((p) => [p.pane_id, p]));
  const root = state.panes.find((p) => p.parent_id === null);
  if (!root) {
    return;
  }
  const rootEl = paneSurface.firstElementChild;
  if (!rootEl) {
    return;
  }
  applyEqualFlex(root, paneMap, rootEl);

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      fitAllPanes();
    });
  });
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

function togglePaneOverflowMenu(paneId, forceOpen = null) {
  const meta = state.paneMeta.get(paneId);
  if (!meta?.actionsOverflowMenu || !meta?.actionsOverflowBtn) {
    return false;
  }
  const isOpen = paneOverflowOpenPaneId === paneId && meta.actionsOverflowMenu.classList.contains("open");
  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !isOpen;
  if (!shouldOpen) {
    closePaneOverflowMenus(null);
    meta.actionsOverflowMenu.classList.remove("open");
    meta.actionsOverflowBtn.setAttribute("aria-expanded", "false");
    return true;
  }

  closePaneOverflowMenus(paneId);
  meta.actionsOverflowMenu.classList.add("open");
  meta.actionsOverflowBtn.setAttribute("aria-expanded", "true");
  paneOverflowOpenPaneId = paneId;
  positionPaneOverflowMenu(paneId);
  return true;
}

function cancelPaneMoveMode() {
  state.paneMove.sourcePaneId = null;
  state.paneMove.targetPaneId = null;
  state.paneMove.placement = null;
  applyPaneSelectionStyles();
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
  if (width <= 0) {
    level = 2;
  } else {
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
    meta.movePaneBtn,
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
    [meta.startBtn, meta.movePaneBtn, meta.sessionPickerBtn, meta.quickBtn].forEach((button) => {
      if (button) {
        primarySet.add(button);
      }
    });
  } else {
    [meta.startBtn, meta.movePaneBtn, meta.quickBtn].forEach((button) => {
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
    const autoLabel = autoEnabled ? "Auto On" : "Auto Off";
    const shortcut = meta.autoResizeBtn.dataset.shortcut ?? "";
    meta.autoResizeBtn.innerHTML = `<span class="pane-btn-icon-svg" aria-hidden="true">${paneIcon.auto}</span><span class="pane-btn-label">${autoLabel}</span>${shortcut ? `<span class="pane-btn-shortcut">${shortcut}</span>` : ""}`;
    meta.autoResizeBtn.dataset.hasIcon = "1";
    meta.autoResizeBtn.classList.toggle("active", autoEnabled);
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

  const startFullLabel = meta.startBtn?.dataset?.fullLabel || "Start";
  if (meta.startBtn) {
    const isRestart = /^restart$/i.test(startFullLabel.trim());
    const isRestore = /^restore$/i.test(startFullLabel.trim());
    if (level > 1) {
      const iconSvg = isRestart ? paneIcon.restart : (isRestore ? paneIcon.restore : paneIcon.start);
      meta.startBtn.innerHTML = `<span class="pane-btn-icon-svg" aria-hidden="true">${iconSvg}</span>`;
      meta.startBtn.classList.add("pane-btn-icon");
      meta.startBtn.title = startFullLabel;
      meta.startBtn.dataset.hasIcon = "1";
    } else {
      const iconSvg = isRestart ? paneIcon.restart : (isRestore ? paneIcon.restore : paneIcon.start);
      const shortcut = meta.startBtn.dataset.shortcut ?? "";
      meta.startBtn.innerHTML = `<span class="pane-btn-icon-svg" aria-hidden="true">${iconSvg}</span><span class="pane-btn-label">${startFullLabel}</span>${shortcut ? `<span class="pane-btn-shortcut">${shortcut}</span>` : ""}`;
      meta.startBtn.dataset.hasIcon = "1";
      meta.startBtn.classList.remove("pane-btn-icon");
      meta.startBtn.title = startFullLabel;
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

function setGlobalFontScale(scale, { resetPerPane = false } = {}) {
  const clamped = Math.max(70, Math.min(150, Number(scale) || 100));
  state.globalFontScale = clamped;
  localStorage.setItem(STORAGE_KEYS.globalFontScale, String(clamped));

  if (resetPerPane) {
    state.paneFontSizes = {};
    persistPaneFontSizes();
  }

  // Apply: default × scale% for all panes, ignoring per-pane stored delta
  const targetSize = clampPaneFontSize(Math.round(PANE_FONT_LIMITS.default * clamped / 100));
  for (const [paneId, view] of state.paneViews.entries()) {
    // Update stored size so per-pane Font+/- works relative to scaled base
    if (state.selectedWorkspaceId) {
      setPaneFontSize(state.selectedWorkspaceId, paneId, targetSize);
    }
    if (Number(view.term.options.fontSize) !== targetSize) {
      view.term.options.fontSize = targetSize;
      view.fitAddon.fit();
      schedulePaneResize(view);
    }
  }

  // Sync select element
  const sel = document.getElementById("fontScaleSelect");
  if (sel) {
    sel.value = String(clamped);
  }
}

async function syncPaneSize(paneId) {
  const view = state.paneViews.get(paneId);
  if (!view || !view.sessionId) {
    return;
  }
  const cols = Math.max(2, view.term.cols || 120);
  const rows = Math.max(1, view.term.rows || 24);
  try {
    await rpc("session.resize", { session_id: view.sessionId, cols, rows });
  } catch (err) {
    if (isDetachedInputError(err)) {
      markPaneDetached(view, "Restart this pane to attach a new terminal");
      return;
    }
    throw err;
  }
}

function queuePaneInput(view, data) {
  if (!view.sessionId || !data) {
    return;
  }

  view.pendingInput += data;
  paneDebug("[input] queued", {
    pane: view.paneId?.slice(0, 8),
    session: view.sessionId?.slice(0, 8),
    bytes: data.length,
    pending: view.pendingInput.length
  });
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

function isReconnectableInputError(err) {
  const msg = String(err?.message ?? err).toLowerCase();
  return msg.includes("enoent") || msg.includes("pipe") || msg.includes("core pipe disconnected");
}

function isDetachedInputError(err) {
  return String(err?.message ?? err).toLowerCase().includes("pty session not attached");
}

async function writePaneInput(sessionId, payload) {
  try {
    await rpc("session.write", { session_id: sessionId, data: payload });
    return;
  } catch (err) {
    if (!isReconnectableInputError(err)) {
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, INPUT_RETRY_DELAY_MS));
    await rpc("session.write", { session_id: sessionId, data: payload });
  }
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
        await writePaneInput(sessionId, payload);
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
        paneDebug("[input] write ok", {
          pane: view.paneId?.slice(0, 8),
          session: sessionId.slice(0, 8),
          bytes: queued,
          latency: Number(latency.toFixed(2))
        });
      } catch (err) {
        const msg = err?.message ?? String(err);
        const reconnectable = isReconnectableInputError(err);
        const detached = isDetachedInputError(err);
        if (reconnectable) {
          setStatus("Terminal input failed after reconnect retry.", true);
        } else if (detached) {
          markPaneDetached(view, "Restart this pane to attach a new terminal");
          setStatus("Terminal detached. Restart the pane to continue input.", true);
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
        paneDebug("[input] write failed", {
          pane: view.paneId?.slice(0, 8),
          session: sessionId.slice(0, 8),
          bytes: queued,
          message: msg
        });
        break;
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

function flushCompositionPending(view) {
  if (!view?.compositionPendingData) {
    return;
  }
  if (view.compositionFlushTimer) {
    clearTimeout(view.compositionFlushTimer);
    view.compositionFlushTimer = null;
  }
  const pending = view.compositionPendingData;
  view.compositionPendingData = "";
  view.compositionLastFlushData = pending;
  view.compositionLastFlushAt = Date.now();
  queuePaneInput(view, pending);
}

function clearCompositionPending(view) {
  if (!view) {
    return;
  }
  if (view.compositionFlushTimer) {
    clearTimeout(view.compositionFlushTimer);
    view.compositionFlushTimer = null;
  }
  view.compositionPendingData = "";
}

function shouldSuppressDuplicateCompositionData(view, data) {
  if (!view || !data) {
    return false;
  }
  const now = Date.now();

  if (view.compositionPendingData && view.compositionEndedAt && now - view.compositionEndedAt <= IME_DUPLICATE_WINDOW_MS) {
    clearCompositionPending(view);
    return false;
  }

  if (
    view.compositionLastFlushData === data
    && view.compositionLastFlushAt
    && now - view.compositionLastFlushAt <= IME_DUPLICATE_WINDOW_MS
  ) {
    view.compositionLastFlushData = "";
    view.compositionLastFlushAt = 0;
    logIme("composition.duplicate-suppressed", { pane_id: view.paneId, len: data.length });
    return true;
  }

  return false;
}

function bindViewToSession(view, sessionId) {
  const nextSession = sessionId ?? null;

  // If same session and already bound, just sync PTY size
  if (view.sessionId === nextSession && view._boundToStream) {
    return;
  }

  paneWarn("[bindView] REBIND pane:", view.paneId?.slice(0,8),
    "prevSession:", view.sessionId?.slice(0,8),
    "nextSession:", nextSession?.slice(0,8),
    "_boundToStream:", view._boundToStream,
    "sameId:", view.sessionId === nextSession,
    "stack:", new Error().stack?.split("\n")[2]?.trim()
  );

  const previousSession = view.sessionId;
  if (previousSession !== nextSession) {
    view.detached = false;
  }
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
    view.hasOutput = false;
  }

  if (view.sessionId) {
    if (sameRendered && view.hasOutput) {
      hidePaneOverlay(view);
    } else if (view.detached) {
      setPaneOverlay(view, "detached", "Session detached", "Restart this pane to attach a new terminal", "Restart");
    } else {
      setPaneOverlay(view, "running", "Session running", "No output yet", "Restart");
    }
    if (!sameRendered) {
      restoreSessionTail(view, view.sessionId);
    }
    if (!state.useStream) {
      startPanePolling(view);
    }
    view._boundToStream = state.useStream;
    syncPaneSize(view.paneId).catch(() => {});
  } else {
    view._boundToStream = false;
    const dormant = state.dormantPaneSessions[view.paneId] ?? null;
    if (dormant?.spawn_cmd) {
      setPaneOverlay(view, "dormant", "Restore available", dormant.spawn_cmd, "Restore");
    } else {
      setPaneOverlay(view, "empty", "No session running", "Start a terminal in this pane", "Start");
    }
  }
}

function restoreSessionTail(view, sessionId) {
  const restoreId = sessionId;
  rpc("session.tail", { session_id: restoreId, max_bytes: 65536 })
    .then((res) => {
      if (res?.output && view.sessionId === restoreId && view.renderedSessionId === restoreId) {
        view.hasOutput = true;
        hidePaneOverlay(view);
        view.term.write(normalizeTerminalOutput(res.output));
      }
    })
    .catch(() => {});
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
        view.hasOutput = true;
        hidePaneOverlay(view);
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
    if (view.onCompositionUpdate) {
      view.imeTextarea.removeEventListener("compositionupdate", view.onCompositionUpdate);
    }
  }

  view.onCompositionStart = () => {
    // Korean IMEs often end one syllable and immediately start the next one.
    // Flush the previous committed syllable before resetting this composition cycle.
    flushCompositionPending(view);
    view.isComposing = true;
    view.compositionPendingData = "";
    view.compositionEndedAt = 0;
    view.compositionLastFlushData = "";
    view.compositionLastFlushAt = 0;
    logIme("compositionstart", { pane_id: view.paneId });
  };
  view.onCompositionUpdate = (ev) => {
    logIme("compositionupdate", {
      pane_id: view.paneId,
      len: String(ev?.data ?? "").length
    });
  };
  view.onCompositionEnd = () => {
    view.isComposing = false;
    view.compositionEndedAt = Date.now();
    logIme("compositionend", { pane_id: view.paneId });
    view.compositionFlushTimer = window.setTimeout(() => {
      view.compositionFlushTimer = null;
      flushCompositionPending(view);
    }, IME_COMMIT_WAIT_MS);
  };
  textarea.addEventListener("compositionstart", view.onCompositionStart);
  textarea.addEventListener("compositionupdate", view.onCompositionUpdate);
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
  const groupBadgeEl = document.createElement("button");
  groupBadgeEl.type = "button";
  groupBadgeEl.className = "pane-group-badge";
  groupBadgeEl.hidden = true;
  groupBadgeEl.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openPaneGroupMenu(paneId, groupBadgeEl);
  });
  const idWrap = document.createElement("div");
  idWrap.className = "pane-id-wrap";
  idWrap.append(idEl, groupBadgeEl, unreadBadgeEl);
  const statusEl = document.createElement("span");
  statusEl.className = "pane-session";
  statusEl.textContent = "No session";
  const statusWrap = document.createElement("div");
  statusWrap.className = "pane-status-wrap";
  statusWrap.append(statusEl);
  const actions = document.createElement("div");
  actions.className = "pane-actions";
  const actionsPrimary = document.createElement("div");
  actionsPrimary.className = "pane-actions-primary";
  const actionsOverflowWrap = document.createElement("div");
  actionsOverflowWrap.className = "pane-overflow";
  const actionsOverflowBtn = document.createElement("button");
  actionsOverflowBtn.className = "pane-btn pane-overflow-btn";
  actionsOverflowBtn.innerHTML = `<span class="pane-btn-icon-svg" aria-hidden="true">${paneIcon.more}</span>`;
  actionsOverflowBtn.dataset.hasIcon = "1";
  actionsOverflowBtn.title = "More actions (Ctrl+Alt+M)";
  actionsOverflowBtn.setAttribute("aria-label", "More actions (Ctrl+Alt+M)");
  actionsOverflowBtn.setAttribute("aria-expanded", "false");
  const actionsOverflowMenu = document.createElement("div");
  actionsOverflowMenu.className = "pane-overflow-menu";
  actionsOverflowWrap.append(actionsOverflowBtn, actionsOverflowMenu);
  actions.append(actionsPrimary);
  const makeBtn = (text, title, onClick, cls = "pane-btn", iconHtml = "", shortcut = "") => {
    const btn = document.createElement("button");
    btn.className = cls;
    if (iconHtml) {
      btn.innerHTML = `<span class="pane-btn-icon-svg" aria-hidden="true">${iconHtml}</span><span class="pane-btn-label">${text}</span>${shortcut ? `<span class="pane-btn-shortcut">${shortcut}</span>` : ""}`;
      btn.dataset.hasIcon = "1";
    } else {
      btn.textContent = text;
    }
    if (shortcut) {
      btn.dataset.shortcut = shortcut;
    }
    btn.title = title || text;
    btn.addEventListener("click", onClick);
    return btn;
  };
  const fontDownBtn = makeBtn("Font -", "Decrease font size", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.adjustPaneFont(paneId, -PANE_FONT_LIMITS.step).catch((err) => setStatus(String(err), true));
  }, "pane-btn", paneIcon.fontDown, "Ctrl+-");
  const fontUpBtn = makeBtn("Font +", "Increase font size", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.adjustPaneFont(paneId, PANE_FONT_LIMITS.step).catch((err) => setStatus(String(err), true));
  }, "pane-btn", paneIcon.fontUp, "Ctrl+=");
  const splitHBtn = makeBtn("Split Right", "Split horizontally (add column)", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.splitPane(paneId, "horizontal").catch((err) => setStatus(String(err), true));
  }, "pane-btn", paneIcon.splitRight, "Ctrl+Alt+\\");
  const splitVBtn = makeBtn("Split Down", "Split vertically (add row)", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.splitPane(paneId, "vertical").catch((err) => setStatus(String(err), true));
  }, "pane-btn", paneIcon.splitDown, "Ctrl+Alt+-");
  const startBtn = makeBtn("Start", "Start session", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.startSessionForPane(paneId, { force: true }).catch((err) => setStatus(String(err), true));
  }, "pane-btn pane-btn-primary", paneIcon.start, "Ctrl+Alt+T");
  startBtn.dataset.fullLabel = "Start";
  const sessionPickerBtn = makeBtn("Sessions", "Manage running, dormant, and previous sessions", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openSessionPicker(paneId, sessionPickerBtn);
  }, "pane-btn", paneIcon.sessions, "Menu");
  sessionPickerBtn.className = "pane-btn session-picker-btn";
  const closeBtn = makeBtn("Close Session", "Close terminal session", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.closeSessionForPane(paneId).catch((err) => setStatus(String(err), true));
  }, "pane-btn", paneIcon.closeSession, "Ctrl+Alt+R");
  const movePaneBtn = makeBtn("Move Pane", "Move this pane to another position", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    closePaneOverflowMenus(null);
    paneHandlers.startPaneMove(paneId).catch((err) => setStatus(String(err), true));
  }, "pane-btn", paneIcon.movePane, "Ctrl+Alt+P");
  const closePaneBtn = makeBtn("Close Pane", "Close pane", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.closePane(paneId).catch((err) => setStatus(String(err), true));
  }, "pane-btn pane-btn-danger", paneIcon.closePane, "Ctrl+Alt+Q");
  const hidePaneBtn = makeBtn("Hide Pane", "Hide this pane without ending session", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    paneHandlers.hidePane(paneId).catch((err) => setStatus(String(err), true));
  }, "pane-btn", paneIcon.hidePane, "Ctrl+Alt+W");
  const quickBtn = makeBtn("", "Quick command", () => {});
  quickBtn.classList.add("quickcmd-toggle");
  quickBtn.setAttribute("aria-label", "Quick command");
  quickBtn.innerHTML = `<span class="pane-btn-icon-svg" aria-hidden="true">${paneIcon.quick}</span>`;
  quickBtn.dataset.hasIcon = "1";
  const autoResizeBtn = makeBtn("", "Toggle automatic compact layout", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setPaneAutoResizeEnabled(!(state.paneAutoResize !== false));
    setStatus(state.paneAutoResize !== false ? "Auto resize enabled" : "Auto resize disabled");
  }, "pane-btn pane-btn-auto", paneIcon.auto);
  actionsOverflowBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    togglePaneOverflowMenu(paneId);
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
  header.append(idWrap, statusWrap, actions);
  const quickPanel = document.createElement("div");
  quickPanel.className = "quickcmd-popover";
  const terminalHost = document.createElement("div");
  terminalHost.className = "pane-terminal-host";
  card.append(header, quickPanel, terminalHost);
  card.addEventListener("pointermove", (ev) => {
    const sourcePaneId = state.paneMove?.sourcePaneId ?? null;
    if (!sourcePaneId || sourcePaneId === paneId) {
      return;
    }
    setPaneMoveTarget(paneId, paneDropPlacement(card, ev.clientX, ev.clientY));
  });
  card.addEventListener("pointerleave", () => {
    clearPaneMoveTarget(paneId);
  });
  card.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) {
      return;
    }
    const target = ev.target;
    if (target instanceof HTMLElement && target.closest("button")) {
      return;
    }
    if (state.paneMove.sourcePaneId) {
      ev.preventDefault();
      ev.stopPropagation();
      if (state.paneMove.sourcePaneId === paneId) {
        cancelPaneMoveMode();
        setStatus("Pane move cancelled");
        return;
      }
      const placement = paneDropPlacement(card, ev.clientX, ev.clientY);
      setPaneMoveTarget(paneId, placement);
      paneHandlers.movePaneToPlacement(state.paneMove.sourcePaneId, paneId, placement)
        .catch((err) => setStatus(String(err), true));
      return;
    }
    const isTerminalClick = target instanceof HTMLElement && Boolean(target.closest(".pane-terminal-host"));
    selectPane(paneId, { persist: true, focusTerm: false })
      .then(() => {
        if (isTerminalClick) {
          focusPaneTerm(paneId);
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
    groupBadgeEl,
    splitHBtn,
    splitVBtn,
    startBtn,
    sessionPickerBtn,
    closeBtn,
    movePaneBtn,
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
    if (state.selectedGroupId) {
      const group = typeof groupForPane === "function" ? groupForPane(node.pane_id) : null;
      if (group?.id !== state.selectedGroupId) {
        return null;
      }
    }
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
  if (!firstNode && !secondNode) {
    return null;
  }
  if (!firstNode) {
    return secondNode;
  }
  if (!secondNode) {
    return firstNode;
  }
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
    hasOutput: false,
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
    detached: false,
    isComposing: false,
    compositionPendingData: "",
    compositionFlushTimer: null,
    compositionEndedAt: 0,
    compositionLastFlushData: "",
    compositionLastFlushAt: 0,
    imeTextarea: null,
    imeBindTimer: null,
    onCompositionStart: null,
    onCompositionUpdate: null,
    onCompositionEnd: null,
    suppressOnData: false,
    overlayEl: null,
    overlayTitleEl: null,
    overlayDetailEl: null,
    overlayActionEl: null
  };
  ensurePaneOverlay(view);
  setPaneOverlay(view, "empty", "No session running", "Start a terminal in this pane", "Start");

  term.attachCustomKeyEventHandler((ev) => {
    const key = ev.key?.toLowerCase?.() ?? "";
    if (ev.type !== "keydown") {
      return true;
    }
    if (ev.isComposing || key === "process" || view.isComposing) {
      return true;
    }

    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Tab") {
      ev.preventDefault();
      void selectAdjacentPane(ev.shiftKey ? -1 : 1, { focusTerm: true }).catch((err) => setStatus(String(err?.message ?? err), true));
      return false;
    }

    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && !ev.altKey && !ev.shiftKey && ev.code === "Slash") {
      ev.preventDefault();
      globalThis.toggleShortcutHelp?.();
      return false;
    }

    if (ctrl && ev.altKey && !ev.shiftKey) {
      const arrowMap = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down"
      };
      if (arrowMap[ev.key]) {
        ev.preventDefault();
        void selectPaneByDirection(arrowMap[ev.key], { focusTerm: true }).catch((err) => setStatus(String(err?.message ?? err), true));
        return false;
      }
      if (ev.code === "Backslash") {
        ev.preventDefault();
        paneHandlers.splitPane(paneId, "horizontal").catch((err) => setStatus(String(err), true));
        return false;
      }
      if (ev.code === "Minus" || ev.code === "NumpadSubtract") {
        ev.preventDefault();
        paneHandlers.splitPane(paneId, "vertical").catch((err) => setStatus(String(err), true));
        return false;
      }
      if (key === "t") {
        ev.preventDefault();
        paneHandlers.startSessionForPane(paneId, { focusTerm: true }).catch((err) => setStatus(String(err), true));
        return false;
      }
      if (key === "r") {
        ev.preventDefault();
        paneHandlers.startSessionForPane(paneId, { force: true, focusTerm: true }).catch((err) => setStatus(String(err), true));
        return false;
      }
      if (key === "w") {
        ev.preventDefault();
        paneHandlers.hidePane(paneId).catch((err) => setStatus(String(err), true));
        return false;
      }
      if (key === "q") {
        ev.preventDefault();
        paneHandlers.closePane(paneId).catch((err) => setStatus(String(err), true));
        return false;
      }
      if (key === "m") {
        ev.preventDefault();
        togglePaneOverflowMenu(paneId);
        return false;
      }
      if (key === "p") {
        ev.preventDefault();
        paneHandlers.startPaneMove(paneId).catch((err) => setStatus(String(err), true));
        return false;
      }
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
    paneDebug("[input] onData", {
      pane: paneId.slice(0, 8),
      len: data.length,
      active: document.activeElement?.tagName ?? null,
      hostActive: view.host.contains(document.activeElement)
    });
    // Suppress duplicate onData fired by xterm's native paste path when Ctrl+V is intercepted
    if (view.suppressOnData) {
      return;
    }
    if (view.isComposing) {
      view.compositionPendingData += data;
      logIme("onData.composing", { pane_id: paneId, len: data.length });
      return;
    }
    if (shouldSuppressDuplicateCompositionData(view, data)) {
      return;
    }
    logIme("onData", { pane_id: paneId, len: data.length, composing: view.isComposing });
    queuePaneInput(view, data);
  });

  term.onBinary((data) => {
    paneDebug("[input] onBinary", {
      pane: paneId.slice(0, 8),
      len: data.length,
      active: document.activeElement?.tagName ?? null,
      hostActive: view.host.contains(document.activeElement)
    });
    if (view.isComposing) {
      view.compositionPendingData += data;
      logIme("onBinary.composing", { pane_id: paneId, len: data.length });
      return;
    }
    if (shouldSuppressDuplicateCompositionData(view, data)) {
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

  // On workspace switch: stash current workspace's views+sessions into cache, restore returning workspace's
  const renderingWorkspaceId = state.selectedWorkspaceId;
  if (state._lastRenderedWorkspaceId !== renderingWorkspaceId) {
    // Save outgoing workspace's live views and session mappings into cache (stop polling first)
    if (state._lastRenderedWorkspaceId) {
      for (const view of state.paneViews.values()) {
        if (view.poller) { clearInterval(view.poller); view.poller = null; }
        if (view.flushTimer) { clearTimeout(view.flushTimer); view.flushTimer = null; }
        if (view.flushRaf) { cancelAnimationFrame(view.flushRaf); view.flushRaf = null; }
        view.readBusy = false;
        view.outputQueue = "";
        view.inputFlushScheduled = false;
        view.inputFlushInFlight = false;
        view.pendingInput = "";
        view._boundToStream = false; // force rebind on restore
      }
      state.workspacePaneViewCache.set(state._lastRenderedWorkspaceId, new Map(state.paneViews));
      state.workspacePaneSessionCache.set(state._lastRenderedWorkspaceId, { ...state.paneSessions });
      state.paneViews.clear();
    }
    // Restore incoming workspace's cached views and session mappings (if any)
    const cachedViews = state.workspacePaneViewCache.get(renderingWorkspaceId);
    if (cachedViews) {
      for (const [paneId, view] of cachedViews.entries()) {
        state.paneViews.set(paneId, view);
      }
    }
    const cachedSessions = state.workspacePaneSessionCache.get(renderingWorkspaceId);
    if (cachedSessions) {
      // Merge cached session mappings back — but don't overwrite entries that
      // tryRestorePaneSessions already assigned from the authoritative backend response.
      for (const [paneId, sessionId] of Object.entries(cachedSessions)) {
        if (!state.paneSessions[paneId]) {
          state.paneSessions[paneId] = sessionId;
        }
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
  if (!rootNode) {
    const group = paneGroupById(state.selectedGroupId);
    renderPaneEmptyState("No panes in this group", `${group?.name ?? "Selected"} has no panes. Choose All or move a terminal into this group.`);
    return;
  }
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
      ensurePaneOverlay(existing);
      rebindImeTextarea(existing);
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
  paneDebug("[refreshBindings] called, running sessions:", [...runningMap.keys()].map(s=>s.slice(0,8)), "paneSessions:", Object.entries(state.paneSessions).map(([p,s])=>`${p.slice(0,8)}->${s?.slice(0,8)}`));

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
    const dormant = state.dormantPaneSessions[paneId] ?? null;
    if (meta) {
      if (sessionId) {
        const session = runningMap.get(sessionId);
        meta.statusEl.textContent = session ? `Running - pid ${session.pid}` : "Attached";
        meta.statusEl.title = "";
        meta.startBtn.dataset.fullLabel = "Restart";
        meta.closeBtn.disabled = false;
      } else if (dormant?.spawn_cmd) {
        meta.statusEl.textContent = `Dormant - ${dormant.spawn_cmd}`;
        meta.statusEl.title = "Restore available";
        meta.startBtn.dataset.fullLabel = "Restore";
        meta.closeBtn.disabled = true;
      } else {
        meta.statusEl.textContent = "No session";
        meta.statusEl.title = "";
        meta.startBtn.dataset.fullLabel = "Start";
        meta.closeBtn.disabled = true;
      }
      meta.fontDownBtn.disabled = fontSize <= PANE_FONT_LIMITS.min;
      meta.fontUpBtn.disabled = fontSize >= PANE_FONT_LIMITS.max;
      meta.closePaneBtn.disabled = leafCount <= 1;
      meta.hidePaneBtn.disabled = leafCount <= 1;
      meta.unreadBadgeEl.hidden = unreadCount <= 0;
      meta.unreadBadgeEl.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
      const group = typeof groupForPane === "function" ? groupForPane(paneId) : null;
      if (meta.groupBadgeEl) {
        meta.groupBadgeEl.hidden = !group;
        meta.groupBadgeEl.textContent = group ? `${group.name} ▾` : "";
        meta.groupBadgeEl.title = group ? `Move this terminal from ${group.name} to another group` : "Move this terminal to a group";
        meta.groupBadgeEl.setAttribute("aria-label", meta.groupBadgeEl.title);
        meta.groupBadgeEl.style.setProperty("--group-color", group?.color ?? "#6b7c93");
      }
    }
    const card = state.paneCards.get(paneId);
    if (card) {
      card.classList.toggle("pane-has-unread", unreadCount > 0);
      card.classList.toggle("pane-dormant", !sessionId && Boolean(dormant));
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

  const workspaceRows = [ws];
  const sessionResults = await Promise.all(workspaceRows.map((row) =>
    Promise.all([
      rpc("session.history", { workspace_id: row.id }).catch(() => null),
      rpc("ai.sessions", { workspace_id: row.id }).catch(() => null)
    ]).then(([histRes, aiRes]) => ({ workspace: row, histRes, aiRes }))
  ));
  const aiSessions = sessionResults.flatMap((result) =>
    (result.aiRes?.sessions ?? []).map((session) => ({
      ...session,
      workspace_name: result.workspace.name,
      workspace_path: result.workspace.path
    }))
  );

  const dropdown = document.createElement("div");
  dropdown.className = "session-picker-dropdown";

  const titleBar = document.createElement("div");
  titleBar.className = "session-picker-titlebar";
  const titleText = document.createElement("div");
  titleText.className = "session-picker-title";
  titleText.textContent = `${ws.name} Sessions`;
  const subtitleText = document.createElement("div");
  subtitleText.className = "session-picker-subtitle";
  subtitleText.textContent = "Manage running, dormant, and previous sessions for this workspace.";
  titleBar.append(titleText, subtitleText);
  dropdown.appendChild(titleBar);

  const tools = document.createElement("div");
  tools.className = "session-picker-tools";
  const searchInput = document.createElement("input");
  searchInput.className = "session-picker-search";
  searchInput.placeholder = "Search command or session id";
  const filterSelect = document.createElement("select");
  filterSelect.className = "session-picker-filter";
  for (const [value, label] of [["all", "All"], ["running", "Running"], ["dormant", "Dormant"], ["history", "History"], ["ai", "AI Resume"]]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    filterSelect.appendChild(opt);
  }
  tools.append(searchInput, filterSelect);
  dropdown.appendChild(tools);

  const appendSectionHeader = (title, detail = "") => {
    const header = document.createElement("div");
    header.className = "session-picker-header";
    const titleEl = document.createElement("span");
    titleEl.textContent = title;
    header.appendChild(titleEl);
    if (detail) {
      const detailEl = document.createElement("span");
      detailEl.className = "session-picker-header-detail";
      detailEl.textContent = detail;
      header.appendChild(detailEl);
    }
    dropdown.appendChild(header);
  };

  const commandBaseName = (cmd = "") => String(cmd).split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const cleanShellCommand = (value = "") => {
    let text = String(value).trim();
    text = text.replace(/^\$OutputEncoding=\[Console\]::OutputEncoding=\[TextUTF8Encoding\]::new\(\);\s*/i, "");
    text = text.replace(/^\$OutputEncoding=\[Console\]::OutputEncoding=\[Text\.UTF8Encoding\]::new\(\);\s*/i, "");
    text = text.replace(/^\[Console\]::InputEncoding=\[Text\.UTF8Encoding\]::new\(\);\s*/i, "");
    text = text.replace(/^if \(Get-Variable PSStyle[\s\S]*?\};\s*/i, "");
    text = text.replace(/^chcp\s+65001\s*>\s*\$null\s*;?\s*/i, "");
    return text || value;
  };
  const sessionLabel = (session) => {
    const cmd = commandBaseName(session.spawn_cmd);
    let parsedArgs = [];
    try {
      const parsed = JSON.parse(session.spawn_args || "[]");
      parsedArgs = Array.isArray(parsed) ? parsed : [];
    } catch {
      parsedArgs = [];
    }
    const commandIndex = parsedArgs.findIndex((arg) => String(arg).toLowerCase() === "-command");
    if ((cmd === "pwsh.exe" || cmd === "powershell.exe" || cmd === "pwsh" || cmd === "powershell") && commandIndex >= 0) {
      return cleanShellCommand(parsedArgs.slice(commandIndex + 1).join(" "));
    }
    const displayArgs = parsedArgs.filter((arg) => {
      const value = String(arg);
      return !value.startsWith("-No") && !value.startsWith("chcp") && !value.startsWith("$Output") && !value.startsWith("[Console]");
    });
    return displayArgs.length > 0
      ? `${session.spawn_cmd} ${displayArgs.join(" ")}`.trim()
      : session.spawn_cmd;
  };

  // AI Sessions section (Claude / Codex conversation sessions)
  if (aiSessions.length > 0) {
    appendSectionHeader("AI Resume", `${aiSessions.length} saved command${aiSessions.length === 1 ? "" : "s"} in this workspace`);

    for (const ai of aiSessions) {
      const dateObj = new Date(ai.detected_at);
      const timeStr = dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

      const item = document.createElement("div");
      item.className = "session-picker-item ai-session";
      item.dataset.status = "ai";
      item.dataset.search = `${ai.workspace_name ?? ""} ${ai.tool ?? ""} ${ai.resume_cmd ?? ""}`.toLowerCase();

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
        metaEl.textContent = `${ai.workspace_name ?? "workspace"} - ${ai.tool} - detected ${timeStr}`;

      info.append(labelEl, metaEl);

      const resumeBtn = document.createElement("button");
      resumeBtn.className = "session-attach-btn";
      resumeBtn.textContent = "Resume";
      resumeBtn.dataset.action = "resume";
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

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "session-delete-btn";
      deleteBtn.textContent = "×";
      deleteBtn.title = "Delete this resume record";
      deleteBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        try {
          await rpc("ai.session.delete", { ai_session_id: ai.id });
          item.remove();
          setStatus("AI resume record deleted");
        } catch (err) {
          setStatus(String(err?.message ?? err), true);
        }
      });

      item.append(dot, info, resumeBtn, deleteBtn);
      dropdown.appendChild(item);
    }
  }

  // Terminal sessions section
  const dormantRows = Object.values(state.dormantPaneSessions)
    .filter((row) => row?.workspace_id === ws.id && row.spawn_cmd)
    .map((row) => ({
      id: row.session_id,
      workspace_id: row.workspace_id,
      workspace_name: ws.name,
      pane_id: row.pane_id,
      status: "dormant",
      started_at: new Date().toISOString(),
      spawn_cmd: row.spawn_cmd,
      spawn_args: row.spawn_args,
      spawn_cwd: row.spawn_cwd
    }));
  const allSessions = sessionResults.flatMap((result) =>
    (result.histRes?.sessions ?? []).map((session) => ({
      ...session,
      workspace_id: result.workspace.id,
      workspace_name: result.workspace.name
    }))
  );
  const namedSessions = [...dormantRows, ...allSessions].filter((s) => s.spawn_cmd);
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
    const currentWorkspaceSessions = displaySessions.filter((s) => (s.workspace_id ?? ws.id) === ws.id);
    const groupsForPicker = state.paneGroups.length > 0 ? state.paneGroups : [{ id: "default", name: "Default", color: "#6b7c93" }];
    const sessionGroups = groupsForPicker
      .map((paneGroup) => ({
        group: paneGroup,
        rows: currentWorkspaceSessions
          .filter((s) => {
            const groupId = typeof groupIdForSession === "function"
              ? groupIdForSession(s.id)
              : null;
            return (groupId ?? groupsForPicker[0]?.id) === paneGroup.id;
          })
          .sort((a, b) => {
            const order = { running: 0, dormant: 1 };
            const left = order[a.status] ?? 2;
            const right = order[b.status] ?? 2;
            if (left !== right) return left - right;
            return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
          })
      }))
      .filter((group) => group.rows.length > 0);

    if (sessionGroups.length === 0) {
      const empty = document.createElement("div");
      empty.className = "session-picker-empty";
      empty.textContent = "No reusable sessions yet. Run a command below to create one.";
      dropdown.appendChild(empty);
    } else {
      const attachSessionHere = async (s) => {
        const isRunning = s.status === "running";
        const isDormant = s.status === "dormant";
        if (isDormant) {
          await paneHandlers.startSessionForPane(paneId, {
            restoreDormant: true,
            silent: false,
            groupId: typeof groupIdForSession === "function" ? groupIdForSession(s.id) : undefined
          });
          return;
        }
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
          return;
        }
        let parsedArgs = [];
        try { parsedArgs = JSON.parse(s.spawn_args || "[]"); } catch { /* */ }
        await paneHandlers.startSessionForPane(paneId, {
          force: true,
          cmd: s.spawn_cmd,
          args: parsedArgs,
          cwd: s.spawn_cwd || undefined,
          groupId: typeof groupIdForSession === "function" ? groupIdForSession(s.id) : undefined
        });
      };

      const openSessionSide = async (s, direction) => {
        await paneHandlers.openSessionInSplit(paneId, s, direction);
      };

      for (const group of sessionGroups) {
        appendSectionHeader(group.group.name, `${group.rows.length} session${group.rows.length === 1 ? "" : "s"}`);
        for (const s of group.rows) {
          const label = sessionLabel(s);
          const dateObj = new Date(s.started_at);
          const timeStr = dateObj.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
                          dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const isRunning = s.status === "running";
          const isDormant = s.status === "dormant";
          const isCurrentWorkspace = (s.workspace_id ?? ws.id) === ws.id;

          const item = document.createElement("div");
          item.className = `session-picker-item ${s.status}`;
          item.dataset.status = isRunning ? "running" : (isDormant ? "dormant" : "history");
          item.dataset.search = `${group.group.name ?? ""} ${s.workspace_name ?? ""} ${label ?? ""} ${s.id ?? ""}`.toLowerCase();

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
          attachBtn.textContent = isCurrentWorkspace ? (isDormant ? "Restore" : (isRunning ? "Attach" : "Re-run")) : "Jump";
          attachBtn.dataset.action = attachBtn.textContent.toLowerCase();
          attachBtn.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            dropdown.remove();
            try {
              if (!isCurrentWorkspace) {
                await switchWorkspace(s.workspace_id);
                setStatus(`Jumped to ${s.workspace_name ?? "workspace"}`);
                return;
              }
              await attachSessionHere(s);
            } catch (err) {
              setStatus(String(err?.message ?? err), true);
            }
          });

          item.append(dot, info, attachBtn);

          if (isCurrentWorkspace) {
            const rightBtn = document.createElement("button");
            rightBtn.className = "session-attach-btn session-side-btn";
            rightBtn.textContent = "Right";
            rightBtn.title = "Open right";
            rightBtn.dataset.action = "open-right";
            rightBtn.addEventListener("click", async (ev) => {
              ev.stopPropagation();
              dropdown.remove();
              try {
                await openSessionSide(s, "horizontal");
              } catch (err) {
                setStatus(String(err?.message ?? err), true);
              }
            });
            const downBtn = document.createElement("button");
            downBtn.className = "session-attach-btn session-side-btn";
            downBtn.textContent = "Down";
            downBtn.title = "Open down";
            downBtn.dataset.action = "open-down";
            downBtn.addEventListener("click", async (ev) => {
              ev.stopPropagation();
              dropdown.remove();
              try {
                await openSessionSide(s, "vertical");
              } catch (err) {
                setStatus(String(err?.message ?? err), true);
              }
            });
            item.append(rightBtn, downBtn);
          }

          if (!isRunning && !isDormant) {
            const deleteBtn = document.createElement("button");
            deleteBtn.className = "session-delete-btn";
            deleteBtn.textContent = "x";
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

  const applySessionFilter = () => {
    const query = searchInput.value.trim().toLowerCase();
    const status = filterSelect.value;
    for (const item of dropdown.querySelectorAll(".session-picker-item")) {
      const matchesQuery = !query || (item.dataset.search ?? "").includes(query);
      const itemStatus = item.dataset.status ?? "all";
      const matchesStatus = status === "all" || itemStatus === status;
      item.hidden = !(matchesQuery && matchesStatus);
    }
  };
  searchInput.addEventListener("input", applySessionFilter);
  filterSelect.addEventListener("change", applySessionFilter);

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
globalThis.selectAdjacentPane = selectAdjacentPane;
globalThis.selectPaneByDirection = selectPaneByDirection;
globalThis.togglePaneOverflowMenu = togglePaneOverflowMenu;
globalThis.focusPaneTerm = focusPaneTerm;
globalThis.fitAllPanes = fitAllPanes;
globalThis.equalizePaneSizes = equalizePaneSizes;
globalThis.setGlobalFontScale = setGlobalFontScale;
globalThis.writeToPane = writeToPane;
globalThis.markPaneStarting = markPaneStarting;
