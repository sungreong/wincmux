const hiddenPaneHandlers = {
  restoreHiddenPane: async () => {},
  terminateHiddenPane: async () => {}
};

let hiddenPaneUiBound = false;

function ensureHiddenPanesPortal() {
  if (!hiddenPanesPopover || !document.body) {
    return;
  }
  if (typeof globalThis.ensurePanePortalElement === "function") {
    globalThis.ensurePanePortalElement(hiddenPanesPopover);
    return;
  }
  if (hiddenPanesPopover.parentElement !== document.body) {
    document.body.appendChild(hiddenPanesPopover);
  }
}

function clampHiddenPanesPopoverSize(width, height = 0, margin = 10) {
  if (typeof globalThis.clampPanePortalSize === "function") {
    return globalThis.clampPanePortalSize(width, height, margin);
  }
  const maxWidth = Math.max(1, window.innerWidth - margin * 2);
  const maxHeight = Math.max(1, window.innerHeight - margin * 2);
  return {
    width: Math.max(1, Math.min(Math.max(1, Number(width) || maxWidth), maxWidth)),
    height: Math.max(1, Math.min(Math.max(1, Number(height) || maxHeight), maxHeight))
  };
}

function clampHiddenPanesPopoverPosition(left, top, width, height, margin = 10) {
  if (typeof globalThis.clampPanePortalPosition === "function") {
    return globalThis.clampPanePortalPosition(left, top, width, height, margin);
  }
  const maxLeft = Math.max(margin, window.innerWidth - margin - Math.max(0, Number(width) || 0));
  const maxTop = Math.max(margin, window.innerHeight - margin - Math.max(0, Number(height) || 0));
  return {
    left: Math.max(margin, Math.min(Number(left) || margin, maxLeft)),
    top: Math.max(margin, Math.min(Number(top) || margin, maxTop))
  };
}

function positionHiddenPanesPopover() {
  if (!hiddenPanesPopover?.classList.contains("open")) {
    return;
  }
  const anchor = hiddenPanesBtn?.getBoundingClientRect?.();
  if (!anchor) {
    return;
  }
  const margin = 10;
  ensureHiddenPanesPortal();
  hiddenPanesPopover.style.width = "";
  hiddenPanesPopover.style.minWidth = "0";
  hiddenPanesPopover.style.maxWidth = `${Math.max(1, window.innerWidth - margin * 2)}px`;
  hiddenPanesPopover.style.maxHeight = `${Math.max(1, window.innerHeight - margin * 2)}px`;
  hiddenPanesPopover.style.visibility = "hidden";

  const measured = hiddenPanesPopover.getBoundingClientRect();
  const size = clampHiddenPanesPopoverSize(Math.min(measured.width || 460, 460), measured.height || 340, margin);
  hiddenPanesPopover.style.width = `${Math.round(size.width)}px`;
  const nextRect = hiddenPanesPopover.getBoundingClientRect();
  const height = Math.min(nextRect.height || size.height, size.height);

  let left = anchor.right - size.width;
  let top = anchor.bottom + 6;
  if (top + height > window.innerHeight - margin) {
    top = anchor.top - height - 6;
  }
  const position = clampHiddenPanesPopoverPosition(left, top, size.width, height, margin);
  hiddenPanesPopover.style.left = `${Math.round(position.left)}px`;
  hiddenPanesPopover.style.top = `${Math.round(position.top)}px`;
  hiddenPanesPopover.style.visibility = "";
}

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
  hiddenPanesPopover.style.left = "";
  hiddenPanesPopover.style.top = "";
  hiddenPanesPopover.style.width = "";
  hiddenPanesPopover.style.minWidth = "";
  hiddenPanesPopover.style.maxWidth = "";
  hiddenPanesPopover.style.maxHeight = "";
  hiddenPanesPopover.style.visibility = "";
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
  ensureHiddenPanesPortal();
  hiddenPanesPopover.classList.add("open");
  positionHiddenPanesPopover();
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
    empty.textContent = "No hidden terminals.";
    hiddenPanesPopover.appendChild(empty);
    return;
  }

  const rowsByGroup = new Map();
  for (const row of rows) {
    const group = paneGroupById(row.group_id) ?? groupForSession(row.session_id) ?? defaultPaneGroup();
    const key = group?.id ?? "default";
    if (!rowsByGroup.has(key)) {
      rowsByGroup.set(key, { group, rows: [] });
    }
    rowsByGroup.get(key).rows.push(row);
  }

  for (const section of rowsByGroup.values()) {
    const header = document.createElement("div");
    header.className = "hidden-pane-group-header";
    header.textContent = `${section.group?.name ?? "Default"} (${section.rows.length})`;
    hiddenPanesPopover.appendChild(header);

    for (const row of section.rows) {
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
}

function refreshHiddenPanesUi() {
  if (hiddenPanesBtn) {
    const count = hiddenPanesForWorkspace().length;
    setToolbarBtnLabel(hiddenPanesBtn, `Hidden (${count})`);
    hiddenPanesBtn.title = "Show hidden terminals (Ctrl+Shift+H)";
  }
  if (hiddenPanesPopover?.classList.contains("open")) {
    renderHiddenPanesPopover();
    positionHiddenPanesPopover();
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

  const reposition = () => positionHiddenPanesPopover();
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
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
