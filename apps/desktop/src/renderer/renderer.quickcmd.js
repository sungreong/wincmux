function saveQuickPresets() {
  localStorage.setItem(STORAGE_KEYS.quickPresets, JSON.stringify(state.quickPresets));
}

function saveQuickHistory() {
  localStorage.setItem(STORAGE_KEYS.quickHistory, JSON.stringify(state.quickHistory));
}

function quickHistoryForAssistant(assistant) {
  const normalized = normalizeQuickAssistant(assistant);
  const seen = new Set();
  const rows = [];
  for (const item of state.quickHistory) {
    if (item.assistant !== normalized) {
      continue;
    }
    const signature = item.text.toLowerCase();
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    rows.push(item.text);
    if (rows.length >= 6) {
      break;
    }
  }
  return rows;
}

function addQuickHistory(assistant, text) {
  const normalized = normalizeQuickAssistant(assistant);
  const value = String(text ?? "").trim();
  if (!value) {
    return;
  }
  const lower = value.toLowerCase();
  state.quickHistory = state.quickHistory.filter((item) => !(item.assistant === normalized && item.text.toLowerCase() === lower));
  state.quickHistory.unshift({
    assistant: normalized,
    text: value,
    ts: Date.now()
  });
  if (state.quickHistory.length > QUICK_HISTORY_LIMIT) {
    state.quickHistory.length = QUICK_HISTORY_LIMIT;
  }
  saveQuickHistory();
}

function quickParamHints(assistant, paramName) {
  const normalizedAssistant = normalizeQuickAssistant(assistant);
  const key = String(paramName ?? "").trim().toLowerCase();
  const map = QUICK_PARAM_HINTS[normalizedAssistant] ?? {};
  return Array.isArray(map[key]) ? map[key] : [];
}

function quickPresetsForAssistant(assistant) {
  return state.quickPresets.filter((preset) => preset.assistant === normalizeQuickAssistant(assistant));
}

function quickPresetParams(template) {
  if (!template) {
    return [];
  }
  const names = [];
  const seen = new Set();
  const rx = /{{\s*([a-zA-Z0-9_-]+)\s*}}/g;
  let match = rx.exec(template);
  while (match) {
    const key = match[1];
    if (!seen.has(key)) {
      seen.add(key);
      names.push(key);
    }
    match = rx.exec(template);
  }
  return names;
}

function applyQuickPresetTemplate(template, values = {}) {
  return String(template ?? "").replace(/{{\s*([a-zA-Z0-9_-]+)\s*}}/g, (_whole, key) => {
    const value = values[key];
    return value == null ? "" : String(value);
  });
}

function addQuickPreset(assistant, label, template) {
  const normalized = normalizeQuickPreset({
    assistant,
    id: quickPresetId(assistant),
    label,
    template
  });
  if (!normalized) {
    throw new Error("Preset label and template are required.");
  }
  state.quickPresets.push(normalized);
  saveQuickPresets();
  return normalized;
}

function updateQuickPreset(id, patch = {}) {
  const index = state.quickPresets.findIndex((preset) => preset.id === id);
  if (index < 0) {
    throw new Error("Preset not found.");
  }
  const next = normalizeQuickPreset({ ...state.quickPresets[index], ...patch, id });
  if (!next) {
    throw new Error("Preset label and template are required.");
  }
  state.quickPresets[index] = next;
  saveQuickPresets();
  return next;
}

function removeQuickPreset(id) {
  const index = state.quickPresets.findIndex((preset) => preset.id === id);
  if (index < 0) {
    return false;
  }
  state.quickPresets.splice(index, 1);
  saveQuickPresets();
  return true;
}

function migrateQuickPresetsToSeedVersion2() {
  const currentSeed = readQuickPresetSeedVersion();
  if (currentSeed >= QUICK_PRESET_SEED_VERSION) {
    return;
  }

  const replacedIds = new Set([...QUICK_LEGACY_DEFAULT_IDS, ...QUICK_DEFAULT_IDS]);
  const preservedCustom = state.quickPresets.filter((preset) => !replacedIds.has(preset.id));
  state.quickPresets = [...preservedCustom, ...defaultQuickPresets()];
  saveQuickPresets();
  writeQuickPresetSeedVersion(QUICK_PRESET_SEED_VERSION);
}

migrateQuickPresetsToSeedVersion2();

let quickCommandGlobalCloseBound = false;

function ensureQuickCommandGlobalCloseBinding() {
  if (quickCommandGlobalCloseBound) {
    return;
  }
  quickCommandGlobalCloseBound = true;

  document.addEventListener("pointerdown", (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) {
      closeQuickCommandPanels(null);
      return;
    }
    if (target.closest(".quickcmd-popover") || target.closest(".quickcmd-toggle")) {
      return;
    }
    closeQuickCommandPanels(null);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      closeQuickCommandPanels(null);
    }
  });
}

function setQuickCommandPanelVisibility(paneId, isOpen) {
  const meta = state.paneMeta.get(paneId);
  if (!meta?.quickPanel) {
    return;
  }
  meta.quickPanel.classList.toggle("open", isOpen);
  meta.quickBtn.classList.toggle("active", isOpen);
}

function closeQuickCommandPanels(exceptPaneId = null) {
  for (const [paneId, meta] of state.paneMeta.entries()) {
    if (!meta?.quickPanel || paneId === exceptPaneId) {
      continue;
    }
    meta.quickPanel.classList.remove("open");
    meta.quickBtn?.classList.remove("active");
  }
  if (!exceptPaneId) {
    state.quickCommandOpenPaneId = null;
  }
}

function bindQuickCommandPanel(paneId, quickPanel, quickBtn) {
  ensureQuickCommandGlobalCloseBinding();
  const quickState = {
    assistant: "codex",
    presetId: null,
    values: {}
  };

  const titleBar = document.createElement("div");
  titleBar.className = "quickcmd-titlebar";

  const title = document.createElement("div");
  title.className = "quickcmd-title";
  title.textContent = "Quick Command";

  const closePanelBtn = document.createElement("button");
  closePanelBtn.className = "pane-btn";
  closePanelBtn.type = "button";
  closePanelBtn.textContent = "x";
  closePanelBtn.title = "Close";

  titleBar.append(title, closePanelBtn);

  const recentWrap = document.createElement("div");
  recentWrap.className = "quickcmd-chip-row";

  const tabs = document.createElement("div");
  tabs.className = "quickcmd-tabs";

  const codexTabBtn = document.createElement("button");
  codexTabBtn.className = "pane-btn";
  codexTabBtn.type = "button";
  codexTabBtn.textContent = "codex";

  const claudeTabBtn = document.createElement("button");
  claudeTabBtn.className = "pane-btn";
  claudeTabBtn.type = "button";
  claudeTabBtn.textContent = "claude";
  tabs.append(codexTabBtn, claudeTabBtn);

  const presetSelect = document.createElement("select");
  presetSelect.className = "quickcmd-select";

  const paramsWrap = document.createElement("div");
  paramsWrap.className = "quickcmd-params";

  const preview = document.createElement("textarea");
  preview.className = "quickcmd-preview";
  preview.rows = 2;
  preview.readOnly = true;

  const insertBtn = document.createElement("button");
  insertBtn.className = "pane-btn";
  insertBtn.type = "button";
  insertBtn.textContent = "Insert";
  insertBtn.title = "Insert to this pane only";

  const labelInput = document.createElement("input");
  labelInput.className = "quickcmd-input";
  labelInput.type = "text";
  labelInput.placeholder = "Preset label";

  const templateInput = document.createElement("textarea");
  templateInput.className = "quickcmd-template";
  templateInput.rows = 2;
  templateInput.placeholder = "Template. Example: claude --model {{model}} {{task}}";

  const manageActions = document.createElement("div");
  manageActions.className = "quickcmd-manage-actions";

  const addBtn = document.createElement("button");
  addBtn.className = "pane-btn";
  addBtn.type = "button";
  addBtn.textContent = "Add";

  const updateBtn = document.createElement("button");
  updateBtn.className = "pane-btn";
  updateBtn.type = "button";
  updateBtn.textContent = "Update";

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "pane-btn pane-btn-danger";
  deleteBtn.type = "button";
  deleteBtn.textContent = "Delete";

  manageActions.append(addBtn, updateBtn, deleteBtn);
  quickPanel.append(titleBar, recentWrap, tabs, presetSelect, paramsWrap, preview, insertBtn, labelInput, templateInput, manageActions);

  const activePreset = () => {
    const list = quickPresetsForAssistant(quickState.assistant);
    if (list.length === 0) {
      quickState.presetId = null;
      return null;
    }
    if (!quickState.presetId || !list.some((preset) => preset.id === quickState.presetId)) {
      quickState.presetId = list[0].id;
      quickState.values = {};
    }
    return list.find((preset) => preset.id === quickState.presetId) ?? null;
  };

  const buildPreviewText = (template, values) => applyQuickPresetTemplate(template, values)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  const syncPreviewOnly = () => {
    const preset = activePreset();
    preview.value = preset ? buildPreviewText(preset.template, quickState.values) : "";
  };

  const renderRecent = () => {
    recentWrap.innerHTML = "";
    const items = quickHistoryForAssistant(quickState.assistant);
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "quickcmd-empty";
      empty.textContent = "No recent commands yet";
      recentWrap.appendChild(empty);
      return;
    }

    for (const cmdText of items) {
      const chip = document.createElement("button");
      chip.className = "quickcmd-chip";
      chip.type = "button";
      chip.textContent = cmdText.slice(0, 48);
      chip.title = cmdText;
      chip.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        paneHandlers.insertQuickCommand(paneId, cmdText)
          .then(() => {
            addQuickHistory(quickState.assistant, cmdText);
            setQuickCommandPanelVisibility(paneId, false);
            state.quickCommandOpenPaneId = null;
          })
          .catch((err) => setStatus(String(err), true));
      });
      recentWrap.appendChild(chip);
    }
  };

  const render = () => {
    const list = quickPresetsForAssistant(quickState.assistant);
    const preset = activePreset();

    codexTabBtn.classList.toggle("active", quickState.assistant === "codex");
    claudeTabBtn.classList.toggle("active", quickState.assistant === "claude");

    presetSelect.innerHTML = "";
    if (list.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No presets";
      presetSelect.appendChild(option);
      presetSelect.disabled = true;
    } else {
      presetSelect.disabled = false;
      for (const item of list) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.label;
        presetSelect.appendChild(option);
      }
      presetSelect.value = quickState.presetId ?? "";
    }

    paramsWrap.innerHTML = "";
    if (preset) {
      const params = quickPresetParams(preset.template);
      for (const name of params) {
        const row = document.createElement("div");
        row.className = "quickcmd-param-row";

        const input = document.createElement("input");
        input.className = "quickcmd-input";
        input.type = "text";
        input.placeholder = name;
        input.value = quickState.values[name] ?? "";
        const hints = quickParamHints(quickState.assistant, name);
        if (hints.length > 0) {
          const listId = `quickcmd-${paneId}-${quickState.assistant}-${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
          const datalist = document.createElement("datalist");
          datalist.id = listId;
          for (const hint of hints) {
            const option = document.createElement("option");
            option.value = hint;
            datalist.appendChild(option);
          }
          input.setAttribute("list", listId);
          row.appendChild(datalist);
        }
        input.addEventListener("input", () => {
          quickState.values[name] = input.value;
          syncPreviewOnly();
        });
        row.appendChild(input);
        paramsWrap.appendChild(row);
      }
    }

    preview.value = preset ? buildPreviewText(preset.template, quickState.values) : "";
    labelInput.value = preset?.label ?? "";
    templateInput.value = preset?.template ?? "";
    insertBtn.disabled = !preset;
    updateBtn.disabled = !preset;
    deleteBtn.disabled = !preset;
    renderRecent();
  };

  codexTabBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    quickState.assistant = "codex";
    quickState.presetId = null;
    quickState.values = {};
    render();
  });

  claudeTabBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    quickState.assistant = "claude";
    quickState.presetId = null;
    quickState.values = {};
    render();
  });

  presetSelect.addEventListener("change", () => {
    quickState.presetId = presetSelect.value || null;
    quickState.values = {};
    render();
  });

  insertBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const text = preview.value;
    if (!text) {
      setStatus("Quick command is empty.", true);
      return;
    }
    paneHandlers.insertQuickCommand(paneId, text)
      .then(() => {
        addQuickHistory(quickState.assistant, text);
        setQuickCommandPanelVisibility(paneId, false);
        state.quickCommandOpenPaneId = null;
      })
      .catch((err) => setStatus(String(err), true));
  });

  addBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      const created = addQuickPreset(quickState.assistant, labelInput.value, templateInput.value);
      quickState.presetId = created.id;
      quickState.values = {};
      render();
      setStatus("Quick preset added");
    } catch (err) {
      setStatus(String(err), true);
    }
  });

  updateBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!quickState.presetId) {
      return;
    }
    try {
      updateQuickPreset(quickState.presetId, {
        assistant: quickState.assistant,
        label: labelInput.value,
        template: templateInput.value
      });
      quickState.values = {};
      render();
      setStatus("Quick preset updated");
    } catch (err) {
      setStatus(String(err), true);
    }
  });

  deleteBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!quickState.presetId) {
      return;
    }
    const removed = removeQuickPreset(quickState.presetId);
    if (!removed) {
      setStatus("Preset not found.", true);
      return;
    }
    quickState.presetId = null;
    quickState.values = {};
    render();
    setStatus("Quick preset deleted");
  });

  quickPanel.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
  });

  closePanelBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setQuickCommandPanelVisibility(paneId, false);
    state.quickCommandOpenPaneId = null;
  });

  quickBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const opening = !quickPanel.classList.contains("open");
    closeQuickCommandPanels(opening ? paneId : null);
    setQuickCommandPanelVisibility(paneId, opening);
    state.quickCommandOpenPaneId = opening ? paneId : null;
    if (opening) {
      render();
    }
  });
}

globalThis.ensureQuickCommandGlobalCloseBinding = ensureQuickCommandGlobalCloseBinding;
globalThis.closeQuickCommandPanels = closeQuickCommandPanels;
globalThis.bindQuickCommandPanel = bindQuickCommandPanel;
