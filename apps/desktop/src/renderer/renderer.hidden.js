const hiddenPaneHandlers = {
  restoreHiddenPane: async () => {},
  terminateHiddenPane: async () => {}
};

let hiddenPaneUiBound = false;

function hiddenPanesForWorkspace(workspaceId = state.selectedWorkspaceId) {
  if (!workspaceId) {
    return [];
  }
  return state.hiddenPanesByWorkspace[workspaceId] ?? [];
}

function hiddenSessionIdsForWorkspace(workspaceId = state.selectedWorkspaceId) {
  return new Set(hiddenPanesForWorkspace(workspaceId).map((item) => item.session_id));
}

function pushHiddenPaneItem(item) {
  if (!item?.workspace_id || !item?.session_id) {
    return;
  }
  const workspaceId = item.workspace_id;
  const rows = hiddenPanesForWorkspace(workspaceId).filter((row) => row.session_id !== item.session_id);
  rows.unshift(item);
  state.hiddenPanesByWorkspace[workspaceId] = rows;
  refreshHiddenPanesUi();
}

function removeHiddenPaneById(workspaceId, hiddenId) {
  if (!workspaceId || !hiddenId) {
    return null;
  }
  const rows = hiddenPanesForWorkspace(workspaceId);
  const index = rows.findIndex((row) => row.id === hiddenId);
  if (index < 0) {
    return null;
  }
  const [removed] = rows.splice(index, 1);
  state.hiddenPanesByWorkspace[workspaceId] = rows;
  refreshHiddenPanesUi();
  return removed;
}

function removeHiddenPaneBySessionId(workspaceId, sessionId) {
  if (!workspaceId || !sessionId) {
    return null;
  }
  const rows = hiddenPanesForWorkspace(workspaceId);
  const index = rows.findIndex((row) => row.session_id === sessionId);
  if (index < 0) {
    return null;
  }
  const [removed] = rows.splice(index, 1);
  state.hiddenPanesByWorkspace[workspaceId] = rows;
  refreshHiddenPanesUi();
  return removed;
}

function findHiddenPaneById(workspaceId, hiddenId) {
  if (!workspaceId || !hiddenId) {
    return null;
  }
  return hiddenPanesForWorkspace(workspaceId).find((row) => row.id === hiddenId) ?? null;
}

function clearHiddenPanesForWorkspace(workspaceId) {
  if (!workspaceId) {
    return;
  }
  delete state.hiddenPanesByWorkspace[workspaceId];
  refreshHiddenPanesUi();
}

function pruneHiddenPanesForWorkspace(workspaceId, runningSessionIds = new Set()) {
  if (!workspaceId) {
    return [];
  }
  const rows = hiddenPanesForWorkspace(workspaceId);
  const kept = [];
  const removed = [];
  for (const row of rows) {
    if (runningSessionIds.has(row.session_id)) {
      kept.push(row);
      continue;
    }
    removed.push(row);
  }
  state.hiddenPanesByWorkspace[workspaceId] = kept;
  if (removed.length > 0) {
    refreshHiddenPanesUi();
  }
  return removed;
}

function setHiddenPaneHandlers(handlers = {}) {
  if (typeof handlers.restoreHiddenPane === "function") {
    hiddenPaneHandlers.restoreHiddenPane = handlers.restoreHiddenPane;
  }
  if (typeof handlers.terminateHiddenPane === "function") {
    hiddenPaneHandlers.terminateHiddenPane = handlers.terminateHiddenPane;
  }
}

function closeHiddenPanesPopover() {
  if (!hiddenPanesPopover) {
    return;
  }
  hiddenPanesPopover.classList.remove("open");
}

function toggleHiddenPanesPopover(force) {
  if (!hiddenPanesPopover) {
    return;
  }
  const shouldOpen = typeof force === "boolean" ? force : !hiddenPanesPopover.classList.contains("open");
  if (!shouldOpen) {
    closeHiddenPanesPopover();
    return;
  }
  renderHiddenPanesPopover();
  hiddenPanesPopover.classList.add("open");
}

function renderHiddenPanesPopover() {
  if (!hiddenPanesPopover) {
    return;
  }
  hiddenPanesPopover.innerHTML = "";

  const workspaceId = state.selectedWorkspaceId;
  if (!workspaceId) {
    const empty = document.createElement("div");
    empty.className = "hidden-pane-empty";
    empty.textContent = "Select a workspace first.";
    hiddenPanesPopover.appendChild(empty);
    return;
  }

  const rows = hiddenPanesForWorkspace(workspaceId);
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hidden-pane-empty";
    empty.textContent = "No hidden panes.";
    hiddenPanesPopover.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "hidden-pane-item";

    const title = document.createElement("div");
    title.className = "hidden-pane-title";
    title.textContent = row.label || `pane ${String(row.source_pane_id ?? "").slice(0, 8)}`;

    const meta = document.createElement("div");
    meta.className = "hidden-pane-meta";
    meta.textContent = `session ${String(row.session_id).slice(0, 8)}`;

    const actions = document.createElement("div");
    actions.className = "hidden-pane-actions";

    const restoreH = document.createElement("button");
    restoreH.className = "pane-btn";
    restoreH.type = "button";
    restoreH.textContent = "Restore H";
    restoreH.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hiddenPaneHandlers.restoreHiddenPane(row.id, "horizontal").catch((err) => setStatus(String(err), true));
    });

    const restoreV = document.createElement("button");
    restoreV.className = "pane-btn";
    restoreV.type = "button";
    restoreV.textContent = "Restore V";
    restoreV.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hiddenPaneHandlers.restoreHiddenPane(row.id, "vertical").catch((err) => setStatus(String(err), true));
    });

    const terminate = document.createElement("button");
    terminate.className = "pane-btn pane-btn-danger";
    terminate.type = "button";
    terminate.textContent = "Terminate";
    terminate.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hiddenPaneHandlers.terminateHiddenPane(row.id).catch((err) => setStatus(String(err), true));
    });

    actions.append(restoreH, restoreV, terminate);
    item.append(title, meta, actions);
    hiddenPanesPopover.appendChild(item);
  }
}

function refreshHiddenPanesUi() {
  if (hiddenPanesBtn) {
    setToolbarBtnLabel(hiddenPanesBtn, `Hidden Panes (${hiddenPanesForWorkspace().length})`);
  }
  if (hiddenPanesPopover?.classList.contains("open")) {
    renderHiddenPanesPopover();
  }
}

function bindHiddenPaneUi() {
  if (hiddenPaneUiBound) {
    return;
  }
  hiddenPaneUiBound = true;

  if (hiddenPanesBtn) {
    hiddenPanesBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleHiddenPanesPopover();
    });
  }

  document.addEventListener("pointerdown", (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) {
      closeHiddenPanesPopover();
      return;
    }
    if (target.closest("#hiddenPanesPopover") || target.closest("#hiddenPanesBtn")) {
      return;
    }
    closeHiddenPanesPopover();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      closeHiddenPanesPopover();
    }
  });
}

globalThis.setHiddenPaneHandlers = setHiddenPaneHandlers;
globalThis.bindHiddenPaneUi = bindHiddenPaneUi;
globalThis.refreshHiddenPanesUi = refreshHiddenPanesUi;
globalThis.pruneHiddenPanesForWorkspace = pruneHiddenPanesForWorkspace;
globalThis.clearHiddenPanesForWorkspace = clearHiddenPanesForWorkspace;
globalThis.pushHiddenPaneItem = pushHiddenPaneItem;
globalThis.findHiddenPaneById = findHiddenPaneById;
globalThis.removeHiddenPaneById = removeHiddenPaneById;
globalThis.hiddenPanesForWorkspace = hiddenPanesForWorkspace;
globalThis.hiddenSessionIdsForWorkspace = hiddenSessionIdsForWorkspace;
globalThis.closeHiddenPanesPopover = closeHiddenPanesPopover;
