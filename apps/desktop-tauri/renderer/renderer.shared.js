const STORAGE_KEYS = {
  leftWidth: "wincmux.leftWidth",
  rightWidth: "wincmux.rightWidth",
  leftCollapsed: "wincmux.leftCollapsed",
  rightCollapsed: "wincmux.rightCollapsed",
  lastWorkspacePath: "wincmux.lastWorkspacePath",
  shellCommand: "wincmux.shellCommand",
  terminalDefaultShell: "wincmux.terminal.default_shell",
  terminalUnicodeWidth: "wincmux.terminal.unicode_width",
  terminalFontDefault: "wincmux.terminal.font_default",
  useStream: "wincmux.useStream",
  splitRatios: "wincmux.splitRatios",
  paneFontSizes: "wincmux.paneFontSizes",
  paneAutoResize: "wincmux.paneAutoResize",
  quickPresets: "wincmux.quickPresets.v1",
  quickHistory: "wincmux.quickHistory.v1",
  quickPresetSeedVersion: "wincmux.quickPresets.seedVersion",
  rendererPromptFallback: "wincmux.features.rendererPromptFallback",
  selectedWorkspaceId: "wincmux.selectedWorkspaceId",
  workspaceNotes: "wincmux.workspaceNotes",
  workspaceSelectedGroups: "wincmux.workspaceSelectedGroups",
  workspacePaneGroupHints: "wincmux.workspacePaneGroupHints",
  workspaceCreateOpen: "wincmux.workspaceCreateOpen",
  workspaceListMode: "wincmux.workspaceListMode",
  workspaceSidebarOptions: "wincmux.workspaceSidebarOptions",
  workspaceFolderCollapsed: "wincmux.workspaceFolderCollapsed",
  workspaceNotesOpen: "wincmux.workspaceNotesOpen",
  globalFontScale: "wincmux.globalFontScale"
};

function parseStoredMap(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const PANE_FONT_LIMITS = {
  default: Number(localStorage.getItem(STORAGE_KEYS.terminalFontDefault) ?? 14),
  min: 6,
  max: 20,
  step: 1
};

const QUICK_ASSISTANTS = ["codex", "claude"];
const QUICK_HISTORY_LIMIT = 24;
const QUICK_PRESET_SEED_VERSION = 3;
const QUICK_LEGACY_DEFAULT_IDS = ["codex-basic", "codex-full-auto", "claude-basic", "claude-with-model"];
const QUICK_PRESET_DEFAULTS = [
  {
    assistant: "codex",
    id: "codex-only",
    label: "Codex Only",
    template: "codex "
  },
  {
    assistant: "codex",
    id: "codex-read-only",
    label: "Read-only",
    template: "codex --sandbox read-only --ask-for-approval on-request "
  },
  {
    assistant: "codex",
    id: "codex-auto-edit",
    label: "Auto Edit",
    template: "codex --sandbox workspace-write --ask-for-approval on-request "
  },
  {
    assistant: "codex",
    id: "codex-no-prompt",
    label: "No Prompt",
    template: "codex --sandbox workspace-write --ask-for-approval never "
  },
  {
    assistant: "codex",
    id: "codex-dangerous",
    label: "Dangerous",
    template: "codex --dangerously-bypass-approvals-and-sandbox "
  },
  {
    assistant: "claude",
    id: "claude-only",
    label: "Claude Only",
    template: "claude "
  },
  {
    assistant: "claude",
    id: "claude-read-only",
    label: "Read-only",
    template: "claude --permission-mode plan "
  },
  {
    assistant: "claude",
    id: "claude-auto-edit",
    label: "Auto Edit",
    template: "claude --permission-mode acceptEdits "
  },
  {
    assistant: "claude",
    id: "claude-no-prompt",
    label: "No Prompt",
    template: "claude --permission-mode dontAsk "
  },
  {
    assistant: "claude",
    id: "claude-dangerous",
    label: "Dangerous",
    template: "claude --dangerously-skip-permissions "
  }
];
const QUICK_DEFAULT_IDS = QUICK_PRESET_DEFAULTS.map((preset) => preset.id);
const QUICK_PARAM_HINTS = {
  codex: {
    "ask-for-approval": ["on-request", "on-failure", "never", "untrusted"],
    sandbox: ["danger-full-access", "workspace-write", "read-only"],
    model: ["gpt-5", "gpt-5-mini", "gpt-5-codex"],
    "permission-mode": ["on-request", "never", "untrusted"]
  },
  claude: {
    model: ["sonnet", "opus", "haiku"],
    "permission-mode": ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"],
    permission_mode: ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"],
    "allow-dangerously-skip-permissions": ["true"],
    "dangerously-skip-permissions": ["true"]
  }
};

function normalizeQuickAssistant(value) {
  return QUICK_ASSISTANTS.includes(value) ? value : "codex";
}

function quickPresetId(assistant) {
  const seed = Math.random().toString(36).slice(2, 8);
  return `${normalizeQuickAssistant(assistant)}-${Date.now().toString(36)}-${seed}`;
}

function normalizeQuickPreset(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const assistant = normalizeQuickAssistant(raw.assistant);
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const template = typeof raw.template === "string" ? raw.template.trim() : "";
  if (!label || !template) {
    return null;
  }
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : quickPresetId(assistant);
  return { assistant, id, label, template };
}

function defaultQuickPresets() {
  return QUICK_PRESET_DEFAULTS.map((item) => ({ ...item }));
}

function readQuickPresetSeedVersion() {
  const raw = localStorage.getItem(STORAGE_KEYS.quickPresetSeedVersion);
  const parsed = Number(raw);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return localStorage.getItem(STORAGE_KEYS.quickPresets) ? 1 : 0;
}

function writeQuickPresetSeedVersion(version) {
  localStorage.setItem(STORAGE_KEYS.quickPresetSeedVersion, String(version));
}

function loadQuickPresets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.quickPresets);
    if (!raw) {
      return defaultQuickPresets();
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return defaultQuickPresets();
    }

    const normalized = parsed.map((item) => normalizeQuickPreset(item)).filter(Boolean);
    if (normalized.length === 0) {
      return defaultQuickPresets();
    }
    return normalized;
  } catch {
    return defaultQuickPresets();
  }
}

function loadQuickHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.quickHistory);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        assistant: normalizeQuickAssistant(item.assistant),
        text: String(item.text ?? "").trim(),
        ts: Number.isFinite(Number(item.ts)) ? Number(item.ts) : Date.now()
      }))
      .filter((item) => item.text.length > 0);
  } catch {
    return [];
  }
}



const state = {
  workspaces: [],
  sessions: [],
  runningSessionsCache: [],
  runningSessionIds: new Set(),
  runningSessionsByWorkspace: new Map(),
  sessionsById: new Map(),
  notifications: [],
  agentStates: new Map(),
  panes: [],
  selectedWorkspaceId: localStorage.getItem(STORAGE_KEYS.selectedWorkspaceId) ?? null,
  selectedPaneId: null,
  paneSessions: {},
  sessionPaneLookup: new Map(),
  visibleSessionPaneLookup: new Map(),
  paneGroups: [],
  sessionGroupBindings: {},
  selectedGroupId: null,
  paneGroupHints: {},
  paneViews: new Map(),
  paneCards: new Map(),
  paneMeta: new Map(),
  layoutHash: "",
  leftWidth: Number(localStorage.getItem(STORAGE_KEYS.leftWidth) ?? 260),
  rightWidth: Number(localStorage.getItem(STORAGE_KEYS.rightWidth) ?? 280),
  leftCollapsed: localStorage.getItem(STORAGE_KEYS.leftCollapsed) === "1",
  rightCollapsed: localStorage.getItem(STORAGE_KEYS.rightCollapsed) === "1",
  shellCommand: localStorage.getItem(STORAGE_KEYS.terminalDefaultShell) ?? "powershell.exe",
  terminal: {
    default_shell: localStorage.getItem(STORAGE_KEYS.terminalDefaultShell) ?? "powershell.exe",
    unicode_width: localStorage.getItem(STORAGE_KEYS.terminalUnicodeWidth) ?? "unicode11"
  },
  useStream: localStorage.getItem(STORAGE_KEYS.useStream) !== "0",
  streamSubscriptionId: null,
  streamUnbind: null,
  contextUnbind: null,
  notificationOpenUnbind: null,
  streamRefreshTimer: null,
  refreshUnreadHook: null,
  notificationActionBusy: false,
  statusGate: {
    priority: 0,
    expiresAt: 0
  },
  splitRatios: parseStoredMap(STORAGE_KEYS.splitRatios),
  paneFontSizes: parseStoredMap(STORAGE_KEYS.paneFontSizes),
  paneAutoResize: localStorage.getItem(STORAGE_KEYS.paneAutoResize) !== "0",
  globalFontScale: Number(localStorage.getItem(STORAGE_KEYS.globalFontScale) ?? 100),
  workspaceNotes: parseStoredMap(STORAGE_KEYS.workspaceNotes),
  workspaceSelectedGroups: parseStoredMap(STORAGE_KEYS.workspaceSelectedGroups),
  workspacePaneGroupHints: parseStoredMap(STORAGE_KEYS.workspacePaneGroupHints),
  workspaceCreateOpen: localStorage.getItem(STORAGE_KEYS.workspaceCreateOpen) === "1",
  workspaceListMode: ["simple", "compact", "detail"].includes(localStorage.getItem(STORAGE_KEYS.workspaceListMode))
    ? localStorage.getItem(STORAGE_KEYS.workspaceListMode) : "compact",
  workspaceSidebarOptions: {
    query: "", favorites: false, running: false, unread: false, sort: "manual", pageSize: 15, page: 0,
    ...parseStoredMap(STORAGE_KEYS.workspaceSidebarOptions)
  },
  workspaceFolderCollapsed: parseStoredMap(STORAGE_KEYS.workspaceFolderCollapsed),
  workspaceNotesOpen: localStorage.getItem(STORAGE_KEYS.workspaceNotesOpen) === "1",
  hiddenPanesByWorkspace: {},
  quickPresets: loadQuickPresets(),
  quickHistory: loadQuickHistory(),
  quickCommandOpenPaneId: null,
  features: {
    rendererPromptFallback: localStorage.getItem(STORAGE_KEYS.rendererPromptFallback) === "1"
  },
  promptDetector: {
    sessions: new Map(),
    maxBufferChars: 5000,
    cooldownMs: 30000
  },
  metrics: {
    dropped_frames: 0,
    input_latency_ms: [],
    stream_queue_depth: 0
  },
  // Cache of paneViews per workspace so xterm buffers survive workspace switching
  workspacePaneViewCache: new Map(),
  // Cache of paneSessions per workspace so pane→session mappings survive workspace switching
  workspacePaneSessionCache: new Map(),
  dormantPaneSessions: {},
  paneMove: {
    sourcePaneId: null,
    targetPaneId: null,
    placement: null
  }
};
const notificationTargetCache = new WeakMap();
let notificationStatsCache = null;
if (!localStorage.getItem(STORAGE_KEYS.terminalDefaultShell)) {
  localStorage.setItem(STORAGE_KEYS.terminalDefaultShell, state.terminal.default_shell);
}
if (!localStorage.getItem(STORAGE_KEYS.terminalUnicodeWidth)) {
  localStorage.setItem(STORAGE_KEYS.terminalUnicodeWidth, state.terminal.unicode_width);
}
if (!localStorage.getItem(STORAGE_KEYS.terminalFontDefault)) {
  localStorage.setItem(STORAGE_KEYS.terminalFontDefault, String(PANE_FONT_LIMITS.default));
}
if (!localStorage.getItem(STORAGE_KEYS.quickPresets)) {
  localStorage.setItem(STORAGE_KEYS.quickPresets, JSON.stringify(state.quickPresets));
}
if (!localStorage.getItem(STORAGE_KEYS.quickHistory)) {
  localStorage.setItem(STORAGE_KEYS.quickHistory, JSON.stringify(state.quickHistory));
}
if (!localStorage.getItem(STORAGE_KEYS.quickPresetSeedVersion)) {
  localStorage.setItem(STORAGE_KEYS.quickPresetSeedVersion, String(QUICK_PRESET_SEED_VERSION));
}

const $ = (id) => document.getElementById(id);
const appGrid = $("appGrid");
const workspaceList = $("workspaceList");
const workspaceSearchInput = $("workspaceSearchInput");
const workspaceFavoriteOnly = $("workspaceFavoriteOnly");
const workspaceRunningOnly = $("workspaceRunningOnly");
const workspaceUnreadOnly = $("workspaceUnreadOnly");
const workspaceSortSelect = $("workspaceSortSelect");
const workspacePageSize = $("workspacePageSize");
const workspacePager = $("workspacePager");
const workspacePageStatus = $("workspacePageStatus");
const workspacePagePrevious = $("workspacePagePrevious");
const workspacePageNext = $("workspacePageNext");
const workspaceCurrentJump = $("workspaceCurrentJump");
let workspaceLastRenderedSelection = null;
const notificationList = $("notificationList");
const notifTitle = $("notifTitle");
const statusBar = $("statusBar");
const paneSurface = $("paneSurface");
const groupBar = $("groupBar");
const selectedPaneLabel = $("selectedPaneLabel");
const hiddenPanesBtn = $("hiddenPanesBtn");
const hiddenPanesPopover = $("hiddenPanesPopover");
const toggleWorkspaceCreateBtn = $("toggleWorkspaceCreateBtn");
const workspaceCreateFields = $("workspaceCreateFields");
const workspaceCompactBtn = $("workspaceCompactBtn");
const workspaceDetailBtn = $("workspaceDetailBtn");
const workspaceSimpleBtn = $("workspaceSimpleBtn");
const wsNameInput = $("wsNameInput");
const wsPathInput = $("wsPathInput");
const openInVscodeBtn = $("openInVscodeBtn");
const toggleWorkspacePanelBtn = $("toggleWorkspacePanelBtn");
const toggleNotificationPanelBtn = $("toggleNotificationPanelBtn");
const equalizePanesBtn = $("equalizePanesBtn");
const shortcutHelpBtn = $("shortcutHelpBtn");
const shortcutOverlay = $("shortcutOverlay");
const shortcutCloseBtn = $("shortcutCloseBtn");
const fontScaleSelect = $("fontScaleSelect");
const fontScaleResetBtn = $("fontScaleResetBtn");

function setStatus(message, isError = false, options = {}) {
  const now = Date.now();
  const nextPriority = Number.isFinite(Number(options.priority))
    ? Number(options.priority)
    : (isError ? 90 : 10);
  const holdMs = Number.isFinite(Number(options.holdMs))
    ? Math.max(0, Number(options.holdMs))
    : (isError ? 8000 : 1200);
  const gate = state.statusGate ?? { priority: 0, expiresAt: 0 };
  if (now < gate.expiresAt && nextPriority < gate.priority) {
    return;
  }

  state.statusGate = {
    priority: nextPriority,
    expiresAt: now + holdMs
  };
  const routine = !isError && String(message).match(/^Session (started|closed): /);
  statusBar.textContent = routine ? (routine[1] === "started" ? "터미널 시작됨" : "터미널 종료됨") : message;
  statusBar.title = String(message);
  statusBar.classList.toggle("error", isError);
}

async function rpc(method, params = {}) {
  return window.wincmux.rpc({ method, params });
}

let lastUnreadBadgeCount = null;

async function updateUnreadBadge(count) {
  if (typeof window.wincmux?.setUnreadBadge !== "function") {
    return;
  }
  const normalized = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
  if (lastUnreadBadgeCount === normalized) {
    return;
  }
  lastUnreadBadgeCount = normalized;
  await window.wincmux.setUnreadBadge(normalized).catch(() => {});
}

function selectedWorkspace() {
  return state.workspaces.find((w) => w.id === state.selectedWorkspaceId) ?? null;
}

function leafPanes(panes = state.panes) {
  return panes.filter((p) => !p.split);
}

function rebuildSessionIndexes() {
  state.runningSessionsCache = state.sessions.filter((s) => s.status === "running");
  state.runningSessionIds = new Set(state.runningSessionsCache.map((s) => s.id));
  state.runningSessionsByWorkspace = new Map();
  for (const session of state.runningSessionsCache) {
    const workspaceId = session.workspace_id ?? "";
    const rows = state.runningSessionsByWorkspace.get(workspaceId) ?? [];
    rows.push(session);
    state.runningSessionsByWorkspace.set(workspaceId, rows);
  }
  state.sessionsById = new Map(state.sessions.map((s) => [s.id, s]));
}

function runningSessions() {
  return state.runningSessionsCache;
}

function defaultPaneGroup() {
  return state.paneGroups.find((group) => group.name === "Default") ?? state.paneGroups[0] ?? null;
}

function aiPaneGroup() {
  return state.paneGroups.find((group) => group.name === "AI") ?? null;
}

function paneGroupById(groupId) {
  return state.paneGroups.find((group) => group.id === groupId) ?? null;
}

function groupIdForSession(sessionId) {
  if (!sessionId) {
    return null;
  }
  return state.sessionGroupBindings[sessionId] ?? defaultPaneGroup()?.id ?? null;
}

function groupForSession(sessionId) {
  return sessionId ? (paneGroupById(groupIdForSession(sessionId)) ?? defaultPaneGroup()) : null;
}

function groupForPane(paneId) {
  const sessionId = paneId ? state.paneSessions[paneId] : null;
  const hintedGroupId = paneId ? state.paneGroupHints[paneId] : null;
  return groupForSession(sessionId) ?? paneGroupById(hintedGroupId) ?? defaultPaneGroup();
}

function groupLabelForSession(sessionId) {
  return groupForSession(sessionId)?.name ?? "Default";
}

function persistWorkspaceGroupState(workspaceId = state.selectedWorkspaceId) {
  if (!workspaceId) {
    return;
  }
  state.workspacePaneGroupHints[workspaceId] = { ...(state.paneGroupHints ?? {}) };
  if (state.selectedGroupId) {
    state.workspaceSelectedGroups[workspaceId] = state.selectedGroupId;
  } else {
    delete state.workspaceSelectedGroups[workspaceId];
  }
  localStorage.setItem(STORAGE_KEYS.workspacePaneGroupHints, JSON.stringify(state.workspacePaneGroupHints));
  localStorage.setItem(STORAGE_KEYS.workspaceSelectedGroups, JSON.stringify(state.workspaceSelectedGroups));
}

function loadWorkspaceGroupState(workspaceId = state.selectedWorkspaceId) {
  if (!workspaceId) {
    state.paneGroupHints = {};
    state.selectedGroupId = null;
    return;
  }
  state.paneGroupHints = { ...(state.workspacePaneGroupHints[workspaceId] ?? {}) };
  state.selectedGroupId = state.workspaceSelectedGroups[workspaceId] ?? null;
}

function setWorkspaceSelectedGroup(groupId) {
  state.selectedGroupId = groupId ?? null;
  persistWorkspaceGroupState();
}

function setPaneGroupHint(paneId, groupId) {
  if (!paneId) {
    return;
  }
  if (groupId) {
    state.paneGroupHints[paneId] = groupId;
  } else {
    delete state.paneGroupHints[paneId];
  }
  persistWorkspaceGroupState();
}

function renderGroupBar() {
  if (!groupBar) {
    return;
  }
  groupBar.innerHTML = "";
  const ws = selectedWorkspace();
  if (!ws || state.paneGroups.length === 0) {
    groupBar.hidden = true;
    return;
  }
  groupBar.hidden = false;

  const counts = new Map(state.paneGroups.map((group) => [group.id, { panes: 0, running: 0 }]));
  for (const pane of leafPanes()) {
    const groupId = groupForPane(pane.pane_id)?.id ?? defaultPaneGroup()?.id ?? null;
    if (!groupId) {
      continue;
    }
    const current = counts.get(groupId) ?? { panes: 0, running: 0 };
    current.panes += 1;
    const sessionId = state.paneSessions[pane.pane_id] ?? null;
    const session = sessionId ? state.sessionsById.get(sessionId) : null;
    if (session?.workspace_id === ws.id && session.status === "running") {
      current.running += 1;
    }
    counts.set(groupId, current);
  }

  const allBtn = document.createElement("button");
  allBtn.className = `group-chip${!state.selectedGroupId ? " active" : ""}`;
  allBtn.type = "button";
  allBtn.setAttribute("aria-pressed", String(!state.selectedGroupId));
  allBtn.textContent = "All";
  allBtn.addEventListener("click", () => {
    setWorkspaceSelectedGroup(null);
    renderGroupBar();
    if (typeof renderPaneSurface === "function") {
      renderPaneSurface(true);
    }
    setStatus("Pane group: All");
  });
  groupBar.appendChild(allBtn);

  for (const group of state.paneGroups) {
    const btn = document.createElement("button");
    btn.className = `group-chip${state.selectedGroupId === group.id ? " active" : ""}`;
    btn.setAttribute("aria-pressed", String(state.selectedGroupId === group.id));
    btn.type = "button";
    const count = counts.get(group.id) ?? { panes: 0, running: 0 };
    btn.title = group.name === "Default"
      ? `${group.name}: ${count.panes} pane${count.panes === 1 ? "" : "s"}, ${count.running} running`
      : `${group.name}: ${count.panes} pane${count.panes === 1 ? "" : "s"}, ${count.running} running. Double-click or right-click to rename.`;
    btn.style.setProperty("--group-color", group.color ?? "#6b7c93");
    btn.textContent = `${group.name} ${count.panes}`;
    btn.addEventListener("click", () => {
      setWorkspaceSelectedGroup(group.id);
      renderGroupBar();
      if (typeof renderPaneSurface === "function") {
        renderPaneSurface(true);
      }
      setStatus(`Pane group: ${group.name}`);
    });
    if (group.name !== "Default") {
      btn.addEventListener("dblclick", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        showGroupRenameInput(group, btn);
      });
      btn.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        showGroupRenameInput(group, btn);
      });
    }
    groupBar.appendChild(btn);
  }

  if (state.selectedGroupId) {
    const terminalBtn = document.createElement("button");
    terminalBtn.className = "group-chip group-terminal-add";
    terminalBtn.type = "button";
    terminalBtn.textContent = "+ Terminal";
    terminalBtn.title = "Create a terminal in this group";
    terminalBtn.addEventListener("click", () => createTerminalInGroup(state.selectedGroupId).catch((err) => setStatus(String(err), true)));
    groupBar.appendChild(terminalBtn);
  }

  const addBtn = document.createElement("button");
  addBtn.className = "group-chip group-add";
  addBtn.type = "button";
  addBtn.textContent = "+";
  addBtn.title = "Create pane group";
  addBtn.addEventListener("click", () => {
    showGroupCreateInput(addBtn);
  });
  groupBar.appendChild(addBtn);
}

function showGroupCreateInput(anchorEl, options = {}) {
  const ws = selectedWorkspace();
  if (!ws || !groupBar) {
    return;
  }
  groupBar.querySelector(".group-create-inline")?.remove();

  const form = document.createElement("form");
  form.className = "group-create-inline";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Group name";
  input.maxLength = 32;
  input.value = options.initialValue ?? "";
  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.textContent = "Add";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  form.append(input, saveBtn, cancelBtn);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    try {
      const result = await rpc("group.create", { workspace_id: ws.id, name });
      if (result?.group) {
        state.paneGroups = [...state.paneGroups.filter((group) => group.id !== result.group.id), result.group]
          .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
        setWorkspaceSelectedGroup(result.group.id);
        renderGroupBar();
        if (typeof options.onCreated === "function") {
          await options.onCreated(result.group);
        } else {
          renderPaneSurface(true);
        }
        setStatus(`Pane group created: ${name}`);
      }
      form.remove();
    } catch (err) {
      setStatus(String(err?.message ?? err), true);
    }
  });
  cancelBtn.addEventListener("click", () => {
    form.remove();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      form.remove();
    }
    ev.stopPropagation();
  });

  anchorEl?.insertAdjacentElement?.("afterend", form);
  input.focus();
  input.select();
}

function showGroupRenameInput(group, anchorEl) {
  const ws = selectedWorkspace();
  if (!ws || !group || group.name === "Default") {
    return;
  }
  groupBar.querySelector(".group-create-inline")?.remove();

  const form = document.createElement("form");
  form.className = "group-create-inline group-rename-inline";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Group name";
  input.maxLength = 32;
  input.value = group.name;
  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.textContent = "Rename";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  form.append(input, saveBtn, cancelBtn);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    if (!name || name === group.name) {
      form.remove();
      return;
    }
    try {
      await rpc("group.rename", { group_id: group.id, name });
      state.paneGroups = state.paneGroups.map((item) =>
        item.id === group.id ? { ...item, name } : item
      );
      renderGroupBar();
      paneApi.refreshPaneBindings();
      setStatus(`Pane group renamed: ${name}`);
      form.remove();
    } catch (err) {
      setStatus(String(err?.message ?? err), true);
    }
  });
  cancelBtn.addEventListener("click", () => {
    form.remove();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      form.remove();
    }
    ev.stopPropagation();
  });

  anchorEl?.insertAdjacentElement?.("afterend", form);
  input.focus();
  input.select();
}

function terminalSelectionText(term) {
  const selected = term?.getSelection() ?? "";
  if (!/^https?:\/\//i.test(selected)) return selected;

  const parts = selected.trimEnd().split(/\r?\n/);
  if (!parts.every((part, index) => /^[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$/.test(part)
    && (index === 0 || !/^https?:\/\//i.test(part)))) return selected;

  const url = parts.join("");
  if (!URL.canParse(url)) return selected;
  if (parts.length === 1) return url;

  // Some CLI screens paint long URLs as separate rows. Only join breaks
  // where the preceding terminal row reaches the right edge.
  const range = term.getSelectionPosition();
  if (!range) return selected;
  const buffer = term.buffer.active;
  let breaks = 0;
  for (let row = range.start.y + 1; row <= range.end.y; row += 1) {
    const line = buffer.getLine(row);
    if (line?.isWrapped) continue;
    const end = row === range.end.y ? range.end.x : undefined;
    if (!line?.translateToString(true, 0, end)) break;
    if (!buffer.getLine(row - 1)?.translateToString(true, Math.max(0, term.cols - 2))) return selected;
    breaks += 1;
  }
  return breaks === parts.length - 1 ? url : selected;
}

function writeTerminalClipboard(text) {
  if (text) {
    void window.wincmux.clipboardWrite(text).catch((err) => {
      setStatus(`Clipboard write failed: ${err?.message ?? err}`, true);
    });
  }
}

function normalizeTerminalOutput(output) {
  if (!output) {
    return "";
  }

  if (!output.includes("\u001b")) {
    if (!output.includes("<-[") && !output.includes("\u2190[")) {
      return output;
    }
    return output.replace(/(?:\u2190|<-)\[/g, "\u001b[");
  }
  return output;
}

function stripAnsi(value) {
  if (!value) {
    return "";
  }

  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r/g, "");
}

function normalizePromptText(value) {
  return stripAnsi(normalizeTerminalOutput(value))
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const PROMPT_FAST_PATH_RX = /\b(?:claude|codex|gpt-\S+|sonnet|opus|waiting|awaiting|input|response|confirmation|approval|need|proceed|continue|should\s+i|would\s+you|do\s+you\s+want|run\s+shell\s+command|enter\s+to\s+confirm|esc\s+to\s+cancel|press\s+enter|hit\s+enter|yes\s*\/\s*no|select|choose|number|choice)\b|(?:진행|계속|선택|번호|입력|응답|기다리고|실행|수정|변경|허용|승인|도와드릴까요)/i;

function mightContainPromptSignal(rawChunk, existingBuffer = "") {
  if (!rawChunk && !existingBuffer) {
    return false;
  }
  const probe = `${String(existingBuffer ?? "").slice(-240)} ${String(rawChunk ?? "").slice(0, 1200)}`;
  return PROMPT_FAST_PATH_RX.test(probe);
}

function shouldSuppressPromptMarker(key, snippet, recent) {
  if (key !== "press enter") {
    return false;
  }
  const haystack = `${snippet}\n${recent}`;
  return /\b(?:updating\s+codex|please\s+restart\s+codex|update\s+ran\s+successfully|npm\s+(?:install|warn|notice|cleanup)|changed\s+\d+\s+packages?|failed\s+to\s+remove\s+some\s+directories)\b|@openai\/codex/i.test(haystack);
}

function promptSessionState(sessionId) {
  if (!sessionId) {
    return null;
  }

  let entry = state.promptDetector.sessions.get(sessionId);
  if (!entry) {
    entry = {
      buffer: "",
      last_notified_at: 0,
      last_signature: "",
      notifying: false
    };
    state.promptDetector.sessions.set(sessionId, entry);
  }
  return entry;
}

function promptSessionStateForOutput(sessionId, outputChunk) {
  if (!sessionId) {
    return null;
  }
  const existing = state.promptDetector.sessions.get(sessionId);
  if (existing) {
    return existing;
  }
  if (!mightContainPromptSignal(outputChunk, "")) {
    return null;
  }
  return promptSessionState(sessionId);
}

function clearPromptDetectorSession(sessionId) {
  if (!sessionId) {
    return;
  }
  state.promptDetector.sessions.delete(sessionId);
}

function clearPromptDetectorAll() {
  state.promptDetector.sessions.clear();
}

function cleanupPromptDetectorSessions(validSessionIds = []) {
  const keep = new Set(validSessionIds.filter(Boolean));
  for (const sessionId of state.promptDetector.sessions.keys()) {
    if (!keep.has(sessionId)) {
      state.promptDetector.sessions.delete(sessionId);
    }
  }
}

function resolveWorkspaceIdForSession(sessionId, workspaceIdHint) {
  if (workspaceIdHint) {
    return workspaceIdHint;
  }
  if (sessionId) {
    const row = state.sessionsById.get(sessionId);
    if (row?.workspace_id) {
      return row.workspace_id;
    }
  }
  return selectedWorkspace()?.id ?? null;
}

function parseNotificationSource(source) {
  const parsed = {
    kind: "unknown",
    workspaceId: null,
    paneId: null,
    sessionId: null
  };

  if (typeof source !== "string" || !source.trim()) {
    return parsed;
  }

  const parts = source.split("|");
  parsed.kind = parts[0] || "unknown";

  for (let i = 1; i < parts.length; i += 1) {
    const segment = parts[i];
    if (!segment.includes("=")) {
      continue;
    }
    const [rawKey, rawValue] = segment.split("=", 2);
    const key = rawKey.trim();
    const value = rawValue?.trim();
    if (!value) {
      continue;
    }

    if (key === "ws") {
      parsed.workspaceId = value;
      continue;
    }
    if (key === "pane") {
      parsed.paneId = value;
      continue;
    }
    if (key === "session") {
      parsed.sessionId = value;
    }
  }

  return parsed;
}

function normalizeNotificationTarget(row) {
  if (!row || typeof row !== "object") {
    return {
      kind: "unknown",
      workspaceId: null,
      paneId: null,
      sessionId: null
    };
  }

  const cached = notificationTargetCache.get(row);
  if (cached) {
    return cached;
  }

  let target;
  if (row.kind || row.session_id || row.pane_id) {
    target = {
      kind: row.kind ?? "unknown",
      workspaceId: row.workspace_id ?? null,
      paneId: row.pane_id ?? null,
      sessionId: row.session_id ?? null
    };
  } else {
    target = parseNotificationSource(row.source);
  }
  notificationTargetCache.set(row, target);
  return target;
}

function isRendererPromptFallbackEnabled() {
  return Boolean(state.features?.rendererPromptFallback);
}

function workspaceNameById(workspaceId) {
  if (!workspaceId) {
    return "workspace -";
  }
  const ws = state.workspaces.find((row) => row.id === workspaceId);
  if (ws?.name) {
    return ws.name;
  }
  return `workspace ${workspaceId.slice(0, 8)}`;
}

function extractPromptMarker(bufferText) {
  const recent = bufferText.slice(-1200);
  const checks = [
    { key: "proceed?", rx: /\bdo\s+you\s+want\s+to\s+(?:proceed|continue)\s*\?/i },
    { key: "should i?", rx: /\b(?:should\s+i|would\s+you\s+like\s+me\s+to|do\s+you\s+want\s+me\s+to)\b[^?\n]{0,120}\?/i },
    { key: "waiting for input", rx: /\b(?:waiting|awaiting)\s+(?:for\s+)?(?:your\s+)?(?:input|response|confirmation|approval)\b/i },
    { key: "need input", rx: /\bneed\s+(?:your\s+)?(?:input|response|confirmation|approval)\b/i },
    { key: "run shell command", rx: /\brun\s+shell\s+command\b/i },
    { key: "yes/no choice", rx: /(?:^|\n)\s*(?:[>]\s*)?[12][.)]\s*(?:yes|no)\b/im },
    { key: "enter to confirm", rx: /\benter\s+to\s+confirm\b/i },
    { key: "esc to cancel", rx: /\besc\s+to\s+cancel\b/i },
    { key: "y/n", rx: /\b(?:\[?\s*y\s*\/\s*n\s*\]?|yes\s*\/\s*no)\b/i },
    { key: "press enter", rx: /\b(?:press|hit)\s+enter\b/i },
    { key: "select option", rx: /\b(?:select|choose)\b[^.\n]{0,80}\b(?:option|item|number|choice)\b/i },
    { key: "select number", rx: /\b(?:enter|input|type)\b[^.\n]{0,48}\b(?:number|choice|option)\b/i },
    { key: "ko proceed?", rx: /(?:진행|계속).{0,8}(?:하시겠|할까)\S*/i },
    { key: "ko select", rx: /(?:선택|번호).{0,8}(?:입력|해\s*주세요|하세요)/i },
    { key: "ko waiting input", rx: /(?:입력을?\s*기다리고|응답을?\s*기다리고)/i },
    { key: "ko confirm", rx: /(?:실행|수정|변경|진행|계속|허용|승인).{0,16}(?:할까요|하시겠습니까|해도\s*될까요|할지)/i }
  ];

  for (const check of checks) {
    const match = recent.match(check.rx);
    if (match) {
      const line = recent
        .split("\n")
        .reverse()
        .find((row) => check.rx.test(row));
      const snippet = (line ?? match[0] ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      if (shouldSuppressPromptMarker(check.key, snippet, recent)) {
        continue;
      }
      return {
        key: check.key,
        snippet: snippet || check.key
      };
    }
  }
  return null;
}

function hasAssistantPromptContext(bufferText) {
  if (!bufferText) {
    return false;
  }
  return /\b(?:claude|codex)\b/i.test(bufferText)
    || /\b(?:gpt-\S+|sonnet|opus)\b/i.test(bufferText)
    || /(?:Claude\s+Code|Codex\s+CLI)/i.test(bufferText)
    || /\b(?:bash|shell)\s+command\b/i.test(bufferText)
    || /\bdo\s+you\s+want\s+to\s+(?:proceed|continue)\s*\?/i.test(bufferText)
    || /\b(?:enter\s+to\s+confirm|esc\s+to\s+cancel)\b/i.test(bufferText)
    || /(?:대기\s*중입니다|도와드릴까요|입력을?\s*기다리고|응답을?\s*기다리고)/i.test(bufferText);
}

function detectPromptSignal(sessionState, outputChunk) {
  if (!mightContainPromptSignal(outputChunk, sessionState.buffer)) {
    return null;
  }

  const text = normalizePromptText(outputChunk);
  if (!text) {
    return null;
  }

  sessionState.buffer = `${sessionState.buffer} ${text}`.slice(-state.promptDetector.maxBufferChars);

  if (!hasAssistantPromptContext(sessionState.buffer)) {
    return null;
  }

  const marker = extractPromptMarker(sessionState.buffer);
  if (!marker) {
    return null;
  }

  const signature = marker.snippet.toLowerCase();
  return {
    marker,
    signature
  };
}

async function refreshUnreadAfterPromptPush() {
  if (typeof state.refreshUnreadHook === "function") {
    await state.refreshUnreadHook();
    return;
  }

  const res = await rpc("notify.unread", {});
  state.notifications = res.items ?? [];
  renderNotifications();
  await updateUnreadBadge(state.notifications.length);
}

function preparePromptNotificationFromOutput(sessionId, outputChunk, workspaceIdHint = null) {
  if (!isRendererPromptFallbackEnabled()) {
    return null;
  }

  const sessionState = promptSessionStateForOutput(sessionId, outputChunk);
  if (!sessionState || sessionState.notifying) {
    return null;
  }

  const detected = detectPromptSignal(sessionState, outputChunk);
  if (!detected) {
    return null;
  }

  const now = Date.now();
  if (now - sessionState.last_notified_at < state.promptDetector.cooldownMs) {
    return null;
  }

  const workspaceId = resolveWorkspaceIdForSession(sessionId, workspaceIdHint);
  if (!workspaceId) {
    return null;
  }

  sessionState.last_notified_at = now;
  sessionState.last_signature = detected.signature;
  sessionState.notifying = true;
  return { sessionId, sessionState, detected, workspaceId };
}

async function pushPreparedPromptNotification(prepared) {
  const { sessionId, sessionState, detected, workspaceId } = prepared;

  const shortSession = sessionId ? sessionId.slice(0, 8) : "unknown";
  const title = "Assistant input requested";
  const body = `session ${shortSession}: ${detected.marker.snippet}`;
  const paneId = typeof paneForSession === "function" ? paneForSession(sessionId) : null;
  const source = "renderer-pattern-fallback";

  try {
    await rpc("notify.push", {
      workspace_id: workspaceId,
      session_id: sessionId ?? null,
      pane_id: paneId ?? null,
      kind: "assistant_prompt",
      source_kind: "pattern",
      title,
      body,
      level: "info",
      source,
      dedup_key: `${sessionId ?? "none"}|assistant_prompt|${detected.signature}`
    });
    await refreshUnreadAfterPromptPush();
    return true;
  } catch (err) {
    setStatus(`Prompt notification error: ${err?.message ?? err}`, true);
    return false;
  } finally {
    sessionState.notifying = false;
  }
}

function queuePromptNotificationFromOutput(sessionId, outputChunk, workspaceIdHint = null) {
  const prepared = preparePromptNotificationFromOutput(sessionId, outputChunk, workspaceIdHint);
  if (!prepared) {
    return false;
  }
  void pushPreparedPromptNotification(prepared);
  return true;
}

async function maybeNotifyPromptFromOutput(sessionId, outputChunk, workspaceIdHint = null) {
  const prepared = preparePromptNotificationFromOutput(sessionId, outputChunk, workspaceIdHint);
  if (!prepared) {
    return false;
  }
  return pushPreparedPromptNotification(prepared);
}

function applyPanelWidths() {
  const left = Math.max(220, Math.min(520, state.leftWidth));
  const right = Math.max(240, Math.min(520, state.rightWidth));
  appGrid.style.setProperty("--left-panel-width", `${left}px`);
  appGrid.style.setProperty("--right-panel-width", `${right}px`);
}

function setToolbarBtnLabel(btn, text) {
  if (!btn) return;
  if (btn.id === "toggleWorkspacePanelBtn") {
    text = "Workspaces";
    btn.setAttribute("aria-pressed", String(!state.leftCollapsed));
    btn.title = "Toggle workspace panel (Ctrl+B)";
    btn.setAttribute("aria-label", btn.title);
  } else if (btn.id === "toggleNotificationPanelBtn") {
    const count = state.notifications.length;
    text = count ? `Notifications ${count}` : "Notifications";
    btn.setAttribute("aria-pressed", String(!state.rightCollapsed));
    btn.title = "Toggle notifications panel (Ctrl+Shift+N)";
    btn.setAttribute("aria-label", btn.title);
    const badge = btn.querySelector(".toolbar-count");
    if (badge) { badge.textContent = count > 99 ? "99+" : String(count); badge.hidden = count === 0; }
  }
  const span = btn.querySelector(".toolbar-btn-label") ?? btn;
  span.textContent = text;
}

function applyPanelVisibility() {
  appGrid.classList.toggle("left-collapsed", state.leftCollapsed);
  appGrid.classList.toggle("right-collapsed", state.rightCollapsed);

  setToolbarBtnLabel(toggleWorkspacePanelBtn, state.leftCollapsed ? "Show Workspaces" : "Hide Workspaces");
  if (toggleNotificationPanelBtn) {
    const unread = state.notifications.length;
    setToolbarBtnLabel(toggleNotificationPanelBtn, state.rightCollapsed
      ? `Show Notifications (${unread})`
      : "Hide Notifications");
  }
}

function rememberWorkspacePath(pathText) {
  localStorage.setItem(STORAGE_KEYS.lastWorkspacePath, pathText);
}

function rememberShellCommand(cmd) {
  state.shellCommand = cmd;
  localStorage.setItem(STORAGE_KEYS.shellCommand, cmd);
  localStorage.setItem(STORAGE_KEYS.terminalDefaultShell, cmd);
  state.terminal.default_shell = cmd;
}

function paneFontStorageKey(workspaceId, paneId) {
  return `${workspaceId}:${paneId}`;
}

function clampPaneFontSize(value) {
  return Math.max(PANE_FONT_LIMITS.min, Math.min(PANE_FONT_LIMITS.max, Number(value) || PANE_FONT_LIMITS.default));
}

function currentPaneFontSize(workspaceId, paneId) {
  if (!workspaceId || !paneId) {
    return clampPaneFontSize(PANE_FONT_LIMITS.default);
  }
  return clampPaneFontSize(state.paneFontSizes[paneFontStorageKey(workspaceId, paneId)]);
}

function persistPaneFontSizes() {
  localStorage.setItem(STORAGE_KEYS.paneFontSizes, JSON.stringify(state.paneFontSizes));
}

function setPaneFontSize(workspaceId, paneId, value) {
  if (!workspaceId || !paneId) {
    return clampPaneFontSize(value);
  }
  const size = clampPaneFontSize(value);
  state.paneFontSizes[paneFontStorageKey(workspaceId, paneId)] = size;
  persistPaneFontSizes();
  return size;
}

function adjustPaneFontSize(workspaceId, paneId, delta) {
  return setPaneFontSize(workspaceId, paneId, currentPaneFontSize(workspaceId, paneId) + delta);
}

function removePaneFontSize(workspaceId, paneId) {
  if (!workspaceId || !paneId) {
    return;
  }
  delete state.paneFontSizes[paneFontStorageKey(workspaceId, paneId)];
  persistPaneFontSizes();
}

function removeWorkspacePaneFonts(workspaceId) {
  if (!workspaceId) {
    return;
  }
  const prefix = `${workspaceId}:`;
  let changed = false;
  for (const key of Object.keys(state.paneFontSizes)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    changed = true;
    delete state.paneFontSizes[key];
  }
  if (changed) {
    persistPaneFontSizes();
  }
}

function logPerf(event, payload = {}) {
  const line = {
    ts: new Date().toISOString(),
    event,
    ...payload
  };
  enqueuePerfLog(line);
}

const PERF_LOG_FLUSH_DELAY_MS = 250;
const PERF_LOG_BATCH_SIZE = 64;
const PERF_LOG_QUEUE_LIMIT = 512;
let perfLogTimer = null;
const perfLogQueue = [];

function enqueuePerfLog(line) {
  if (typeof window.wincmux?.perfLog !== "function") {
    return;
  }
  perfLogQueue.push(line);
  if (perfLogQueue.length > PERF_LOG_QUEUE_LIMIT) {
    perfLogQueue.splice(0, perfLogQueue.length - PERF_LOG_QUEUE_LIMIT);
  }
  if (perfLogQueue.length >= PERF_LOG_BATCH_SIZE) {
    flushPerfLogQueue();
    return;
  }
  if (!perfLogTimer) {
    perfLogTimer = window.setTimeout(flushPerfLogQueue, PERF_LOG_FLUSH_DELAY_MS);
  }
}

function flushPerfLogQueue() {
  if (perfLogTimer) {
    clearTimeout(perfLogTimer);
    perfLogTimer = null;
  }
  if (perfLogQueue.length === 0 || typeof window.wincmux?.perfLog !== "function") {
    return;
  }
  const batch = perfLogQueue.splice(0, perfLogQueue.length);
  window.wincmux.perfLog(batch).catch(() => {});
}

window.addEventListener("beforeunload", flushPerfLogQueue);

function initResizeHandles(onResize) {
  const leftHandle = $("leftResizeHandle");
  const rightHandle = $("rightResizeHandle");

  const bindDrag = (handle, side) => {
    handle.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const startX = ev.clientX;
      const start = side === "left" ? state.leftWidth : state.rightWidth;
      let dragRaf = null;

      const flushDragResize = () => {
        dragRaf = null;
        applyPanelWidths();
        onResize();
      };

      const scheduleDragResize = () => {
        if (dragRaf) {
          return;
        }
        dragRaf = window.requestAnimationFrame(flushDragResize);
      };

      const onMove = (e) => {
        const delta = e.clientX - startX;
        if (side === "left") {
          state.leftWidth = start + delta;
        } else {
          state.rightWidth = start - delta;
        }
        scheduleDragResize();
      };

      const onUp = () => {
        if (dragRaf) {
          cancelAnimationFrame(dragRaf);
          flushDragResize();
        }
        if (side === "left") {
          localStorage.setItem(STORAGE_KEYS.leftWidth, String(state.leftWidth));
        } else {
          localStorage.setItem(STORAGE_KEYS.rightWidth, String(state.rightWidth));
        }
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  };

  bindDrag(leftHandle, "left");
  bindDrag(rightHandle, "right");
}

function notificationStats() {
  const rows = state.notifications;
  if (notificationStatsCache?.rows === rows && notificationStatsCache.length === rows.length) {
    return notificationStatsCache.stats;
  }
  const byWorkspace = new Map();
  const paneByWorkspace = new Map();
  const sessionByWorkspace = new Map();
  const grouped = new Map();
  for (const row of state.notifications) {
    const target = normalizeNotificationTarget(row);
    const workspaceId = target.workspaceId ?? row.workspace_id ?? "unknown";
    if (!workspaceId) {
      continue;
    }
    byWorkspace.set(workspaceId, (byWorkspace.get(workspaceId) ?? 0) + 1);
    if (!grouped.has(workspaceId)) {
      grouped.set(workspaceId, []);
    }
    grouped.get(workspaceId).push({ row, target });
    if (target.paneId) {
      let paneCounts = paneByWorkspace.get(workspaceId);
      if (!paneCounts) {
        paneCounts = new Map();
        paneByWorkspace.set(workspaceId, paneCounts);
      }
      paneCounts.set(target.paneId, (paneCounts.get(target.paneId) ?? 0) + 1);
      continue;
    }
    if (target.sessionId) {
      let sessionCounts = sessionByWorkspace.get(workspaceId);
      if (!sessionCounts) {
        sessionCounts = new Map();
        sessionByWorkspace.set(workspaceId, sessionCounts);
      }
      sessionCounts.set(target.sessionId, (sessionCounts.get(target.sessionId) ?? 0) + 1);
    }
  }
  const stats = { byWorkspace, paneByWorkspace, sessionByWorkspace, grouped };
  notificationStatsCache = { rows, length: rows.length, stats };
  return stats;
}

function unreadCountsByWorkspace() {
  return notificationStats().byWorkspace;
}

function notificationCountsForWorkspacePanes(workspaceId) {
  const stats = notificationStats();
  return {
    pane: stats.paneByWorkspace.get(workspaceId) ?? new Map(),
    session: stats.sessionByWorkspace.get(workspaceId) ?? new Map()
  };
}

function groupedNotificationsByWorkspace() {
  return notificationStats().grouped;
}

function renderWorkspaceSidebarControls() {
  const createOpen = Boolean(state.workspaceCreateOpen);
  if (workspaceCreateFields) {
    workspaceCreateFields.hidden = !createOpen;
  }
  if (toggleWorkspaceCreateBtn) {
    toggleWorkspaceCreateBtn.setAttribute("aria-expanded", createOpen ? "true" : "false");
    toggleWorkspaceCreateBtn.classList.toggle("open", createOpen);
  }
  if (workspaceSimpleBtn && workspaceCompactBtn && workspaceDetailBtn) {
    for (const [button, mode] of [
      [workspaceSimpleBtn, "simple"], [workspaceCompactBtn, "compact"], [workspaceDetailBtn, "detail"]
    ]) {
      const active = state.workspaceListMode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }
  if (workspaceList) {
    workspaceList.classList.toggle("workspace-list-compact", state.workspaceListMode === "compact");
    workspaceList.classList.toggle("workspace-list-simple", state.workspaceListMode === "simple");
  }
  const options = state.workspaceSidebarOptions;
  if (workspaceSearchInput && workspaceSearchInput.value !== options.query) workspaceSearchInput.value = options.query;
  if (workspaceFavoriteOnly) workspaceFavoriteOnly.checked = options.favorites;
  if (workspaceRunningOnly) workspaceRunningOnly.checked = options.running;
  if (workspaceUnreadOnly) workspaceUnreadOnly.checked = options.unread;
  if (workspaceSortSelect) workspaceSortSelect.value = options.sort;
  if (workspacePageSize) workspacePageSize.value = String(options.pageSize);
  $("workspaceFilterMenu")?.classList.toggle("has-filter", options.favorites || options.running || options.unread || options.sort !== "manual");
}

function updateWorkspaceSidebarOptions(changes) {
  Object.assign(state.workspaceSidebarOptions, changes, { page: 0 });
  const { page, ...saved } = state.workspaceSidebarOptions;
  localStorage.setItem(STORAGE_KEYS.workspaceSidebarOptions, JSON.stringify(saved));
  renderWorkspaces();
}

function setWorkspaceCreateOpen(open) {
  state.workspaceCreateOpen = Boolean(open);
  localStorage.setItem(STORAGE_KEYS.workspaceCreateOpen, state.workspaceCreateOpen ? "1" : "0");
  renderWorkspaceSidebarControls();
  if (state.workspaceCreateOpen) {
    wsNameInput?.focus();
  }
}

function toggleWorkspaceCreate() {
  setWorkspaceCreateOpen(!state.workspaceCreateOpen);
}

function setWorkspaceListMode(mode) {
  state.workspaceListMode = ["simple", "compact", "detail"].includes(mode) ? mode : "compact";
  localStorage.setItem(STORAGE_KEYS.workspaceListMode, state.workspaceListMode);
  renderWorkspaceSidebarControls();
  renderWorkspaces();
}

const AGENT_LABELS = {
  blocked: "입력 필요", working: "작업 중", done: "완료 · 미확인",
  idle: "확인 완료", unknown: "상태 미확인", error: "오류"
};

function applyAgentState(row) {
  if (!row?.session_id) return;
  const old = state.agentStates.get(row.session_id);
  if (!old || row.revision >= old.revision) state.agentStates.set(row.session_id, row);
}

function renderAgentPaneStates() {
  for (const [paneId, meta] of state.paneMeta) {
    const row = state.agentStates.get(state.paneSessions[paneId]);
    let badge = meta.statusEl.parentElement.querySelector(".agent-status");
    const isAction = row?.state === "done";
    if (!badge || badge.tagName !== (isAction ? "BUTTON" : "SPAN")) {
      const replacement = document.createElement(isAction ? "button" : "span");
      if (isAction) {
        replacement.type = "button";
        replacement.addEventListener("click", (event) => {
          event.stopPropagation();
          void acknowledgePaneAgent(paneId).catch((err) => setStatus(String(err), true));
        });
      }
      if (badge) badge.replaceWith(replacement);
      else meta.statusEl.parentElement.appendChild(replacement);
      badge = replacement;
    }
    badge.className = `agent-status agent-${row?.state ?? "unknown"}`;
    badge.hidden = !row || row.source === "none";
    badge.textContent = row?.state === "idle" && row.reason !== "Result acknowledged"
      ? "○ 대기" : (AGENT_LABELS[row?.state] ?? AGENT_LABELS.unknown);
    const hook = row?.hook;
    const hookHealth = hook?.received
      ? ` · 훅 실제 수신 ${hook.count}회 (${hook.provider}, 최근 ${hook.last_event}${hook.active ? '' : ', 세션 종료'})`
      : ' · 훅 수신 전: 화면/OSC 추정';
    badge.title = `${row?.source ?? "none"}: ${row?.reason ?? ""}${hookHealth}${row?.state === "done" ? " · 클릭하여 확인" : ""}`;
    if (isAction) badge.disabled = false;
    badge.setAttribute("aria-label", isAction ? `${badge.textContent} · 결과 확인` : badge.textContent);
  }
  if (typeof syncLocalShellComposers === "function") syncLocalShellComposers();
}

function agentWorkspaceSummary(workspaceId) {
  const counts = {};
  for (const row of state.agentStates.values()) {
    if (row.workspace_id === workspaceId && row.source !== "none") counts[row.state] = (counts[row.state] ?? 0) + 1;
  }
  return [ ["blocked", "입력 필요"], ["done", "미확인 완료"], ["working", "작업 중"], ["error", "오류"] ]
    .filter(([key]) => counts[key]).map(([key, label]) => `${label} ${counts[key]}`).join(" · ");
}

function renderWorkspaceRow(ws, index, unreadByWorkspace, mode) {
    const unread = unreadByWorkspace.get(ws.id) ?? 0;
    const isActive = ws.id === state.selectedWorkspaceId;
    const li = document.createElement("li");
    li.className = isActive ? "active" : "";
    li.classList.toggle("ws-compact", mode === "compact");
    li.classList.toggle("ws-simple", mode === "simple");
    li.classList.toggle("ws-detail-expanded", mode === "detail" && isActive);
    li.title = ws.path;
    if (unread > 0) {
      li.classList.add("ws-has-unread");
      if (!isActive) {
        li.classList.add("ws-attention");
      }
    }

    const titleRow = document.createElement("div");
    titleRow.className = "ws-title-row";

    const indexEl = document.createElement("span");
    indexEl.className = "ws-index";
    indexEl.textContent = String(index + 1);
    titleRow.appendChild(indexEl);

    const nameEl = document.createElement("button");
    nameEl.type = "button";
    nameEl.className = "ws-title";
    nameEl.title = ws.name;
    nameEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      switchWorkspace(ws.id).catch((err) => setStatus(String(err), true));
    });
    nameEl.textContent = ws.name;

    const editBtn = document.createElement("button");
    editBtn.className = "ws-rename-btn";
    editBtn.title = "Rename workspace";
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const input = document.createElement("input");
      input.className = "ws-rename-input";
      input.value = ws.name;
      nameEl.replaceWith(input);
      editBtn.style.display = "none";
      input.focus();
      input.select();

      const commit = async () => {
        const newName = input.value.trim();
        if (newName && newName !== ws.name) {
          try {
            await rpc("workspace.rename", { id: ws.id, name: newName });
            ws.name = newName;
            setStatus(`Renamed: ${newName}`);
          } catch (err) {
            setStatus(String(err?.message ?? err), true);
          }
        }
        nameEl.textContent = ws.name;
        input.replaceWith(nameEl);
        editBtn.style.display = "";
      };

      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { input.value = ws.name; input.blur(); }
        e.stopPropagation();
      });
    });

    titleRow.appendChild(nameEl);

    const favoriteBtn = document.createElement("button");
    favoriteBtn.type = "button";
    favoriteBtn.className = "ws-favorite-btn";
    favoriteBtn.title = ws.pinned ? "Remove favorite" : "Add favorite";
    favoriteBtn.setAttribute("aria-label", favoriteBtn.title);
    favoriteBtn.setAttribute("aria-pressed", String(Boolean(ws.pinned)));
    favoriteBtn.innerHTML = `<svg aria-hidden="true" viewBox="0 0 20 20" fill="${ws.pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="m10 2 2.4 5 5.5.8-4 4 .9 5.5-4.8-2.6-4.8 2.6.9-5.5-4-4 5.5-.8z"/></svg>`;
    favoriteBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void rpc("workspace.pin", { id: ws.id, pinned: !ws.pinned })
        .then(() => loadWorkspaces()).catch((err) => setStatus(String(err), true));
    });

    const infoBtn = document.createElement("button");
    infoBtn.className = "ws-info-btn";
    infoBtn.title = "Workspace info & sessions";
    infoBtn.textContent = "ⓘ";
    infoBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (typeof openWsInfoPanel === "function") openWsInfoPanel(ws, li);
    });

    const hookBtn = document.createElement("button");
    hookBtn.type = "button";
    hookBtn.className = "ws-hook-btn";
    hookBtn.title = "이 워크스페이스에 Claude·Codex Hook 등록";
    hookBtn.setAttribute("aria-label", `${ws.name} Claude·Codex Hook 등록`);
    hookBtn.textContent = "H";
    hookBtn.addEventListener("click", async ev => {
      ev.stopPropagation();
      hookBtn.disabled = true;
      try {
        const results = await Promise.all(['claude', 'codex'].map(provider => rpc('workspace.hooks.ensure', { workspace_id: ws.id, provider })));
        setStatus(`${ws.name}: Claude·Codex Hook 등록 완료${results.some(result => result.changed) ? '' : ' (이미 등록됨)'}`);
      } catch (error) {
        setStatus(`${ws.name}: Hook 등록 실패: ${error?.message ?? error}`, true);
      } finally { hookBtn.disabled = false; }
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "ws-delete-btn";
    deleteBtn.title = "Delete this workspace";
    deleteBtn.setAttribute("aria-label", `Delete workspace ${ws.name}`);
    deleteBtn.textContent = "×";
    deleteBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (typeof globalThis.deleteWorkspaceById === "function") {
        globalThis.deleteWorkspaceById(ws.id).catch((err) => setStatus(String(err), true));
      }
    });
    const actions = document.createElement("div");
    actions.className = "ws-actions";
    actions.id = `ws-actions-${ws.id}`;
    actions.hidden = true;
    actions.append(editBtn, infoBtn, hookBtn, deleteBtn);

    const actionToggle = document.createElement("button");
    actionToggle.type = "button";
    actionToggle.className = "ws-actions-toggle";
    actionToggle.title = "Workspace actions";
    actionToggle.setAttribute("aria-label", `Workspace actions: ${ws.name}`);
    actionToggle.setAttribute("aria-controls", actions.id);
    actionToggle.setAttribute("aria-expanded", "false");
    actionToggle.textContent = "⋯";
    actionToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      actions.hidden = !actions.hidden;
      actionToggle.setAttribute("aria-expanded", String(!actions.hidden));
      li.classList.toggle("ws-actions-open", !actions.hidden);
    });

    const metaRow = document.createElement("div");
    metaRow.className = "ws-meta-row";

    if (Number(ws.running_count) > 0) {
      const running = document.createElement("span");
      running.className = "ws-running-badge";
      running.title = `${ws.running_count} running terminals`;
      running.setAttribute("aria-label", running.title);
      running.textContent = mode === "simple" ? "●" : `● ${ws.running_count}`;
      if (mode === "simple") titleRow.appendChild(running);
      else metaRow.appendChild(running);
    }

    if (unread > 0) {
      const badge = document.createElement("span");
      badge.className = "ws-unread-badge";
      badge.title = `${unread} unread notifications`;
      badge.textContent = unread > 99 ? "99+" : String(unread);
      if (mode === "simple") titleRow.appendChild(badge);
      else metaRow.appendChild(badge);
    }
    titleRow.append(favoriteBtn, actionToggle);

    const pathEl = document.createElement("button");
    pathEl.type = "button";
    pathEl.className = "muted ws-path";
    pathEl.textContent = ws.path;
    pathEl.title = `경로 복사: ${ws.path}`;
    pathEl.setAttribute("aria-label", `${ws.name} 폴더 경로 복사: ${ws.path}`);
    pathEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void window.wincmux.clipboardWrite(ws.path)
        .then(() => setStatus(`폴더 경로 복사: ${ws.path}`))
        .catch((err) => setStatus(String(err), true));
    });

    const branchEl = document.createElement("div");
    branchEl.className = "muted ws-branch";
    branchEl.textContent = `${ws.branch ?? ""} ${ws.dirty ? "(dirty)" : ""}`;
    branchEl.hidden = !ws.branch;

    metaRow.prepend(pathEl);
    li.append(titleRow, actions, metaRow, branchEl);
    if (mode === "detail" && isActive) {
      const meta = document.createElement("div");
      meta.className = "ws-detail-meta";
      const lastUsed = ws.last_active ? new Date(ws.last_active).toLocaleString(window.wincmuxI18n?.language === "ko" ? "ko-KR" : "en-US") : "—";
      meta.textContent = `${ws.running_count ?? 0} running terminals · Last used ${lastUsed}`;
      li.appendChild(meta);
    }
    const summary = document.createElement("div");
    summary.className = "ws-agent-summary";
    summary.textContent = agentWorkspaceSummary(ws.id);
    summary.hidden = !summary.textContent;
    li.appendChild(summary);
    li.addEventListener("click", () => {
      switchWorkspace(ws.id).catch((err) => setStatus(String(err), true));
    });
    li.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || actions.hidden) return;
      ev.stopPropagation();
      actions.hidden = true;
      li.classList.remove("ws-actions-open");
      actionToggle.setAttribute("aria-expanded", "false");
      actionToggle.focus();
    });
    return li;
}

function renderWorkspaceFolderHeader(entry, rows, unreadByWorkspace) {
  const collapsed = state.workspaceFolderCollapsed[entry.key] === true;
  const header = document.createElement("li");
  header.className = "ws-folder-header";
  header.classList.toggle("has-active", entry.members.some(({ workspace }) => workspace.id === state.selectedWorkspaceId));
  header.title = entry.path;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ws-folder-toggle";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", `${entry.label} 폴더, 워크스페이스 ${entry.members.length}개`);
  const chevron = document.createElement("span");
  chevron.className = "ws-folder-chevron";
  chevron.textContent = "▸";
  const title = document.createElement("span");
  title.className = "ws-folder-title";
  title.textContent = entry.label;
  const count = document.createElement("span");
  count.className = "ws-folder-count";
  count.textContent = String(entry.members.length);
  toggle.append(chevron, title, count);
  const unread = entry.members.reduce((sum, { workspace }) => sum + (unreadByWorkspace.get(workspace.id) ?? 0), 0);
  if (unread > 0) {
    const badge = document.createElement("span");
    badge.className = "ws-unread-badge";
    badge.textContent = unread > 99 ? "99+" : String(unread);
    badge.title = `${unread} unread notifications in this folder`;
    toggle.appendChild(badge);
  }
  toggle.addEventListener("click", () => {
    const next = toggle.getAttribute("aria-expanded") === "true";
    state.workspaceFolderCollapsed[entry.key] = next;
    localStorage.setItem(STORAGE_KEYS.workspaceFolderCollapsed, JSON.stringify(state.workspaceFolderCollapsed));
    toggle.setAttribute("aria-expanded", String(!next));
    for (const row of rows) row.hidden = next;
  });
  header.appendChild(toggle);
  return header;
}

function renderWorkspaces() {
  const unreadByWorkspace = unreadCountsByWorkspace();
  const mode = state.workspaceListMode;
  const options = state.workspaceSidebarOptions;
  const query = String(options.query ?? "").trim().toLocaleLowerCase();
  const filtered = state.workspaces.filter((ws) =>
    (!query || [ws.name, ws.path, ws.branch].some((value) => String(value ?? "").toLocaleLowerCase().includes(query)))
    && (!options.favorites || Boolean(ws.pinned))
    && (!options.running || Number(ws.running_count) > 0)
    && (!options.unread || (unreadByWorkspace.get(ws.id) ?? 0) > 0));
  if (options.sort === "recent") filtered.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || String(b.last_active ?? "").localeCompare(String(a.last_active ?? "")));
  if (options.sort === "name") filtered.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || a.name.localeCompare(b.name, window.wincmuxI18n?.language ?? "en", { sensitivity: "base" }));
  const pageSize = [15, 30, 50].includes(Number(options.pageSize)) ? Number(options.pageSize) : 15;
  const pages = paginateWorkspaceEntries(workspaceFolderEntries(filtered), pageSize);
  const selectedPage = pages.findIndex((entries) => entries.some((entry) => entry.type === "workspace"
    ? entry.workspace.id === state.selectedWorkspaceId
    : entry.members.some(({ workspace }) => workspace.id === state.selectedWorkspaceId)));
  if (workspaceLastRenderedSelection !== state.selectedWorkspaceId) {
    workspaceLastRenderedSelection = state.selectedWorkspaceId;
    if (selectedPage >= 0) options.page = selectedPage;
  }
  options.page = Math.max(0, Math.min(Number(options.page) || 0, Math.max(0, pages.length - 1)));
  workspaceList.innerHTML = "";
  for (const entry of pages[options.page] ?? []) {
    if (entry.type === "workspace") {
      workspaceList.appendChild(renderWorkspaceRow(entry.workspace, entry.index, unreadByWorkspace, mode));
      continue;
    }
    const collapsed = state.workspaceFolderCollapsed[entry.key] === true;
    const rows = entry.members.map(({ workspace, index }) => {
      const row = renderWorkspaceRow(workspace, index, unreadByWorkspace, mode);
      row.classList.add("ws-folder-member");
      row.hidden = collapsed;
      return row;
    });
    workspaceList.append(renderWorkspaceFolderHeader(entry, rows, unreadByWorkspace), ...rows);
  }
  if (!filtered.length) {
    const empty = document.createElement("li");
    empty.className = "ws-empty";
    empty.textContent = state.workspaces.length ? "No matching workspaces" : "No workspaces yet";
    workspaceList.appendChild(empty);
  }
  if (workspacePager) workspacePager.hidden = pages.length <= 1;
  if (workspacePageStatus) workspacePageStatus.textContent = `${options.page + 1} / ${Math.max(1, pages.length)} · ${filtered.length}`;
  if (workspacePagePrevious) workspacePagePrevious.disabled = options.page <= 0;
  if (workspacePageNext) workspacePageNext.disabled = options.page >= pages.length - 1;
  if (workspaceCurrentJump) {
    const selected = selectedWorkspace();
    const selectedFolder = (pages[options.page] ?? []).find((entry) => entry.type === "folder"
      && entry.members.some(({ workspace }) => workspace.id === state.selectedWorkspaceId));
    const selectedCollapsed = selectedFolder && state.workspaceFolderCollapsed[selectedFolder.key] === true;
    workspaceCurrentJump.hidden = !selected || (selectedPage === options.page && !selectedCollapsed);
    workspaceCurrentJump.textContent = selected ? `Current: ${selected.name}` : "";
    workspaceCurrentJump.dataset.page = String(selectedPage);
    workspaceCurrentJump.dataset.folder = selectedCollapsed ? selectedFolder.key : "";
  }
  renderWorkspaceSidebarControls();
  setToolbarBtnLabel(toggleWorkspacePanelBtn, state.leftCollapsed ? "Show Workspaces" : "Hide Workspaces");
  if (openInVscodeBtn) {
    openInVscodeBtn.disabled = !selectedWorkspace();
  }
}

function renderNotifications() {
  notificationList.innerHTML = "";
  if (state.notifications.length === 0) {
    const empty = document.createElement("li");
    empty.className = "notif-empty";
    empty.textContent = "No unread notifications";
    notificationList.appendChild(empty);
    notifTitle.textContent = "Notifications";
    setToolbarBtnLabel(toggleNotificationPanelBtn, state.rightCollapsed ? "Show Notifications (0)" : "Hide Notifications");
    return;
  }

  const grouped = groupedNotificationsByWorkspace();

  for (const [workspaceId, entries] of grouped) {
    const header = document.createElement("li");
    header.className = "notif-group";
    header.dataset.workspaceId = workspaceId;

    const label = document.createElement("div");
    label.className = "notif-group-title";
    label.textContent = `${entries[0]?.row.workspace_name || workspaceNameById(workspaceId)} (${entries.length})`;

    const markBtn = document.createElement("button");
    markBtn.className = "notif-group-mark";
    markBtn.type = "button";
    markBtn.dataset.workspaceId = workspaceId;
    markBtn.textContent = "Read all";
    markBtn.title = "Mark this workspace notifications as read";

    header.append(label, markBtn);
    notificationList.appendChild(header);

    for (const { row: n, target } of entries) {
      const li = document.createElement("li");
      li.dataset.notificationId = n.id;
      const index = target.paneId ? leafPanes().findIndex((p) => p.pane_id === target.paneId) : -1;
      const paneLabel = index >= 0 ? `Terminal ${index + 1}` : (target.sessionId ? "Terminal" : workspaceNameById(workspaceId));
      const metaText = paneLabel;
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "notif-open";
      openBtn.title = target.sessionId ? `Open terminal · ${target.sessionId}` : "Open workspace";

      const titleEl = document.createElement("span");
      titleEl.className = "notif-title";
      titleEl.textContent = n.kind === "task_done" ? "작업 완료" : n.kind === "assistant_prompt" ? "입력 필요" : n.kind === "agent_error" ? "작업 오류" : n.title;

      const metaEl = document.createElement("span");
      metaEl.className = "notif-meta muted";
      metaEl.textContent = metaText;

      const bodyEl = document.createElement("span");
      bodyEl.className = "notif-body muted";
      const internalStatus = n.source_kind === "osc7501" || /^Program reported status/.test(n.body ?? "");
      bodyEl.textContent = internalStatus ? "" : n.source_kind === "hook"
        ? n.kind === "assistant_prompt" ? "승인을 기다리고 있습니다." : n.kind === "task_done" ? "에이전트 응답이 완료됐습니다." : n.kind === "agent_error" ? "에이전트 작업이 오류로 종료됐습니다." : n.body
        : n.body;
      bodyEl.hidden = !bodyEl.textContent;

      openBtn.append(titleEl, metaEl, bodyEl);
      li.appendChild(openBtn);
      notificationList.appendChild(li);
    }
  }

  notifTitle.textContent = `Notifications · ${state.notifications.length}`;
  setToolbarBtnLabel(toggleNotificationPanelBtn, state.rightCollapsed
    ? `Show Notifications (${state.notifications.length})`
    : "Hide Notifications");
}
