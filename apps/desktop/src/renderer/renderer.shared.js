const STORAGE_KEYS = {
  leftWidth: "wincmux.leftWidth",
  rightWidth: "wincmux.rightWidth",
  leftCollapsed: "wincmux.leftCollapsed",
  rightCollapsed: "wincmux.rightCollapsed",
  lastWorkspacePath: "wincmux.lastWorkspacePath",
  shellCommand: "wincmux.shellCommand",
  terminalDefaultShell: "wincmux.terminal.default_shell",
  terminalImeDebug: "wincmux.terminal.ime_debug",
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
  notifications: [],
  panes: [],
  selectedWorkspaceId: localStorage.getItem(STORAGE_KEYS.selectedWorkspaceId) ?? null,
  selectedPaneId: null,
  paneSessions: {},
  paneGroups: [],
  sessionGroupBindings: {},
  selectedGroupId: null,
  paneGroupHints: {},
  paneViews: new Map(),
  paneCards: new Map(),
  paneMeta: new Map(),
  layoutHash: "",
  leftWidth: Number(localStorage.getItem(STORAGE_KEYS.leftWidth) ?? 260),
  rightWidth: Number(localStorage.getItem(STORAGE_KEYS.rightWidth) ?? 300),
  leftCollapsed: localStorage.getItem(STORAGE_KEYS.leftCollapsed) === "1",
  rightCollapsed: localStorage.getItem(STORAGE_KEYS.rightCollapsed) === "1",
  shellCommand: localStorage.getItem(STORAGE_KEYS.terminalDefaultShell) ?? "powershell.exe",
  terminal: {
    default_shell: localStorage.getItem(STORAGE_KEYS.terminalDefaultShell) ?? "powershell.exe",
    ime_debug: localStorage.getItem(STORAGE_KEYS.terminalImeDebug) === "1",
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
  dormantPaneSessions: {}
};
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
const notificationList = $("notificationList");
const notifTitle = $("notifTitle");
const statusBar = $("statusBar");
const paneSurface = $("paneSurface");
const groupBar = $("groupBar");
const selectedPaneLabel = $("selectedPaneLabel");
const hiddenPanesBtn = $("hiddenPanesBtn");
const hiddenPanesPopover = $("hiddenPanesPopover");
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
  statusBar.textContent = message;
  statusBar.classList.toggle("error", isError);
}

async function rpc(method, params = {}) {
  return window.wincmux.rpc({ method, params });
}

async function updateUnreadBadge(count) {
  if (typeof window.wincmux?.setUnreadBadge !== "function") {
    return;
  }
  const normalized = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
  await window.wincmux.setUnreadBadge(normalized).catch(() => {});
}

function selectedWorkspace() {
  return state.workspaces.find((w) => w.id === state.selectedWorkspaceId) ?? null;
}

function leafPanes(panes = state.panes) {
  return panes.filter((p) => !p.split);
}

function runningSessions() {
  return state.sessions.filter((s) => s.status === "running");
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
    const session = sessionId ? state.sessions.find((row) => row.id === sessionId) : null;
    if (session?.workspace_id === ws.id && session.status === "running") {
      current.running += 1;
    }
    counts.set(groupId, current);
  }

  const allBtn = document.createElement("button");
  allBtn.className = `group-chip${!state.selectedGroupId ? " active" : ""}`;
  allBtn.type = "button";
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
    btn.type = "button";
    const count = counts.get(group.id) ?? { panes: 0, running: 0 };
    btn.title = `${group.name}: ${count.panes} pane${count.panes === 1 ? "" : "s"}, ${count.running} running`;
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
    groupBar.appendChild(btn);
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

function normalizeTerminalOutput(output) {
  if (!output) {
    return "";
  }

  if (!output.includes("\u001b")) {
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
    const row = state.sessions.find((s) => s.id === sessionId);
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
  if (!row) {
    return {
      kind: "unknown",
      workspaceId: null,
      paneId: null,
      sessionId: null
    };
  }

  if (row.kind || row.session_id || row.pane_id) {
    return {
      kind: row.kind ?? "unknown",
      workspaceId: row.workspace_id ?? null,
      paneId: row.pane_id ?? null,
      sessionId: row.session_id ?? null
    };
  }

  return parseNotificationSource(row.source);
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

async function maybeNotifyPromptFromOutput(sessionId, outputChunk, workspaceIdHint = null) {
  if (!isRendererPromptFallbackEnabled()) {
    return false;
  }

  const sessionState = promptSessionState(sessionId);
  if (!sessionState || sessionState.notifying) {
    return false;
  }

  const detected = detectPromptSignal(sessionState, outputChunk);
  if (!detected) {
    return false;
  }

  const now = Date.now();
  if (now - sessionState.last_notified_at < state.promptDetector.cooldownMs) {
    return false;
  }

  const workspaceId = resolveWorkspaceIdForSession(sessionId, workspaceIdHint);
  if (!workspaceId) {
    return false;
  }

  sessionState.last_notified_at = now;
  sessionState.last_signature = detected.signature;
  sessionState.notifying = true;

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

function applyPanelWidths() {
  const left = Math.max(220, Math.min(520, state.leftWidth));
  const right = Math.max(240, Math.min(520, state.rightWidth));
  appGrid.style.setProperty("--left-panel-width", `${left}px`);
  appGrid.style.setProperty("--right-panel-width", `${right}px`);
}

function setToolbarBtnLabel(btn, text) {
  if (!btn) return;
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
  window.wincmux.perfLog?.(line).catch(() => {});
}

function logIme(event, payload = {}) {
  if (!state.terminal.ime_debug) {
    return;
  }
  logPerf(`ime.${event}`, payload);
}

function initResizeHandles(onResize) {
  const leftHandle = $("leftResizeHandle");
  const rightHandle = $("rightResizeHandle");

  const bindDrag = (handle, side) => {
    handle.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const startX = ev.clientX;
      const start = side === "left" ? state.leftWidth : state.rightWidth;

      const onMove = (e) => {
        const delta = e.clientX - startX;
        if (side === "left") {
          state.leftWidth = start + delta;
          localStorage.setItem(STORAGE_KEYS.leftWidth, String(state.leftWidth));
        } else {
          state.rightWidth = start - delta;
          localStorage.setItem(STORAGE_KEYS.rightWidth, String(state.rightWidth));
        }
        applyPanelWidths();
        onResize();
      };

      const onUp = () => {
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

function unreadCountsByWorkspace() {
  const counts = new Map();
  for (const row of state.notifications) {
    const target = normalizeNotificationTarget(row);
    const workspaceId = target.workspaceId ?? row.workspace_id ?? null;
    if (!workspaceId) {
      continue;
    }
    counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
  }
  return counts;
}

function renderWorkspaces() {
  const unreadByWorkspace = unreadCountsByWorkspace();
  workspaceList.innerHTML = "";
  for (const ws of state.workspaces) {
    const unread = unreadByWorkspace.get(ws.id) ?? 0;
    const isActive = ws.id === state.selectedWorkspaceId;
    const li = document.createElement("li");
    li.className = isActive ? "active" : "";
    if (unread > 0) {
      li.classList.add("ws-has-unread");
      if (!isActive) {
        li.classList.add("ws-attention");
      }
    }

    const titleRow = document.createElement("div");
    titleRow.className = "ws-title-row";

    const nameEl = document.createElement("div");
    nameEl.className = "ws-title";
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
    titleRow.appendChild(editBtn);

    const infoBtn = document.createElement("button");
    infoBtn.className = "ws-info-btn";
    infoBtn.title = "Workspace info & sessions";
    infoBtn.textContent = "⋯";
    infoBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (typeof openWsInfoPanel === "function") openWsInfoPanel(ws, li);
    });
    titleRow.appendChild(infoBtn);

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
    titleRow.appendChild(deleteBtn);

    if (unread > 0) {
      const badge = document.createElement("span");
      badge.className = "ws-unread-badge";
      badge.title = `${unread} unread notifications`;
      badge.textContent = unread > 99 ? "99+" : String(unread);
      titleRow.appendChild(badge);
    }

    const pathEl = document.createElement("div");
    pathEl.className = "muted ws-path";
    pathEl.textContent = ws.path;

    const branchEl = document.createElement("div");
    branchEl.className = "muted";
    branchEl.textContent = `${ws.branch ?? "-"} ${ws.dirty ? "(dirty)" : ""}`;

    li.append(titleRow, pathEl, branchEl);
    li.addEventListener("click", () => {
      switchWorkspace(ws.id).catch((err) => setStatus(String(err), true));
    });
    workspaceList.appendChild(li);
  }
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
    notifTitle.textContent = "Notifications (0 unread)";
    setToolbarBtnLabel(toggleNotificationPanelBtn, state.rightCollapsed ? "Show Notifications (0)" : "Hide Notifications");
    return;
  }

  const grouped = new Map();
  for (const n of state.notifications) {
    const target = normalizeNotificationTarget(n);
    const workspaceId = target.workspaceId ?? n.workspace_id ?? "unknown";
    if (!grouped.has(workspaceId)) {
      grouped.set(workspaceId, []);
    }
    grouped.get(workspaceId).push(n);
  }

  for (const [workspaceId, rows] of grouped) {
    const header = document.createElement("li");
    header.className = "notif-group";
    header.dataset.workspaceId = workspaceId;

    const label = document.createElement("div");
    label.className = "notif-group-title";
    label.textContent = `${workspaceNameById(workspaceId)} (${rows.length})`;

    const markBtn = document.createElement("button");
    markBtn.className = "notif-group-mark";
    markBtn.type = "button";
    markBtn.dataset.workspaceId = workspaceId;
    markBtn.textContent = "Mark";
    markBtn.title = "Mark this workspace notifications as read";

    header.append(label, markBtn);
    notificationList.appendChild(header);

    for (const n of rows) {
      const li = document.createElement("li");
      li.dataset.notificationId = n.id;
      const target = normalizeNotificationTarget(n);
      const paneLabel = target.paneId
        ? `pane ${target.paneId.slice(0, 8)}`
        : (target.sessionId ? `session ${target.sessionId.slice(0, 8)}` : "pane -");
      const metaText = `${paneLabel} | ${n.level}`;

      const titleEl = document.createElement("div");
      titleEl.className = "notif-title";
      titleEl.textContent = n.title;

      const metaEl = document.createElement("div");
      metaEl.className = "notif-meta muted";
      metaEl.textContent = metaText;

      const bodyEl = document.createElement("div");
      bodyEl.className = "notif-body muted";
      bodyEl.textContent = n.body;

      li.append(titleEl, metaEl, bodyEl);
      notificationList.appendChild(li);
    }
  }

  notifTitle.textContent = `Notifications (${state.notifications.length} unread)`;
  setToolbarBtnLabel(toggleNotificationPanelBtn, state.rightCollapsed
    ? `Show Notifications (${state.notifications.length})`
    : "Hide Notifications");
}
