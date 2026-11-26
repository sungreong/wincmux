(() => {
  const storageKey = "wincmux.launchProfiles.v1";
  const icons = {
    claude: '<path d="M12 3v4m0 10v4M3 12h4m10 0h4M5.6 5.6l2.8 2.8m7.2 7.2 2.8 2.8M5.6 18.4l2.8-2.8m7.2-7.2 2.8-2.8"/><circle cx="12" cy="12" r="3"/>',
    codex: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16"/>',
    gemini: '<path d="M12 2c1.1 6 4 8.9 10 10-6 1.1-8.9 4-10 10C10.9 16 8 13.1 2 12c6-1.1 8.9-4 10-10Z"/>',
    powershell: '<path d="m6 7 5 5-5 5m7 0h5"/><rect x="2" y="3" width="20" height="18" rx="3"/>',
    terminal: '<path d="m5 8 4 4-4 4m7 0h7"/><rect x="2" y="3" width="20" height="18" rx="2"/>',
    folder: '<path d="M2 6h7l2 2h11v11H2z"/><path d="M2 6V4h7l2 2"/>',
    git: '<circle cx="5" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="12" r="2"/><path d="M5 7v10M5 10h8a6 6 0 0 0 6 2"/>',
    bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7Z"/>'
  };
  const iconLabels = { claude: "햇살 · Claude", codex: "코드 · Codex", gemini: "별 · Gemini", powershell: "PowerShell", terminal: "터미널", bolt: "번개" };
  const defaults = () => ({ version: 1, defaultId: "powershell", items: [
    { id: "claude", name: "Claude Code", command: "claude", icon: "claude" },
    { id: "codex", name: "Codex", command: "codex", icon: "codex" },
    { id: "gemini", name: "Gemini", command: "gemini", icon: "gemini" },
    { id: "powershell", name: "PowerShell", command: "powershell.exe", icon: "powershell" }
  ] });
  const clone = value => JSON.parse(JSON.stringify(value));
  function validate(value) {
    if (!value || !Array.isArray(value.items) || value.items.length > 40) throw new Error("실행 항목은 최대 40개까지 저장할 수 있습니다.");
    const ids = new Set();
    const items = value.items.map(item => {
      if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id)) throw new Error("실행 항목의 ID가 올바르지 않습니다.");
      ids.add(item.id);
      const name = String(item.name ?? "").trim();
      const command = String(item.command ?? "").trim();
      if (!name || name.length > 48) throw new Error("이름을 1~48자로 입력하세요.");
      if (!command || command.length > 4096 || command.includes("\0")) throw new Error(`${name}: 실행 명령어를 1~4096자로 입력하세요.`);
      return { id: item.id, name, command, icon: Object.hasOwn(icons, item.icon) ? item.icon : "terminal" };
    });
    return { version: 1, items, defaultId: items.some(item => item.id === value.defaultId) ? value.defaultId : items[0]?.id ?? null };
  }
  function load() {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw == null ? defaults() : validate(JSON.parse(raw));
    } catch (err) {
      console.warn("Could not load launch profiles", err);
      return defaults();
    }
  }
  let config = load();
  let dialog, draft, selectedId, editor, list, error, preview;
  const busyPanes = new Set();
  function iconMarkup(kind) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[kind] ?? icons.terminal}</svg>`;
  }
  function save(value) {
    const next = validate(value);
    localStorage.setItem(storageKey, JSON.stringify(next));
    config = next;
    refresh();
    return clone(config);
  }
  function refresh() {
    const maps = [state.paneViews, ...state.workspacePaneViewCache.values()];
    for (const map of maps) for (const view of map.values()) render(view);
  }
  function render(view) {
    const host = view.overlayLaunchEl;
    if (!host) return;
    host.replaceChildren();
    host.hidden = view.overlayEl.dataset.mode === "starting" || view.overlayEl.dataset.mode === "running";
    if (host.hidden) return;
    const heading = document.createElement("div");
    heading.className = "launch-section-heading";
    const label = document.createElement("span");
    label.textContent = "실행할 도구 선택";
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "launch-manage";
    settings.textContent = "목록 관리";
    settings.addEventListener("click", ev => { ev.stopPropagation(); openSettings(); });
    heading.append(label, settings);
    const grid = document.createElement("div");
    grid.className = "launch-profile-grid";
    if (!config.items.length) {
      const empty = document.createElement("p");
      empty.className = "launch-empty";
      empty.textContent = "등록된 도구가 없습니다. 목록 관리에서 추가하세요.";
      grid.append(empty);
    }
    for (const profile of config.items) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "launch-profile-card";
      card.dataset.profileId = profile.id;
      card.dataset.icon = profile.icon;
      card.disabled = busyPanes.has(view.paneId);
      card.title = `${profile.name} 실행: ${profile.command}`;
      const icon = document.createElement("span");
      icon.className = "launch-profile-icon";
      icon.innerHTML = iconMarkup(profile.icon);
      const text = document.createElement("span");
      text.className = "launch-profile-text";
      const name = document.createElement("span");
      name.className = "launch-profile-name";
      name.textContent = profile.name;
      const command = document.createElement("span");
      command.className = "launch-profile-command";
      command.textContent = profile.command;
      text.append(name, command);
      card.append(icon, text);
      if (profile.id === config.defaultId) {
        const badge = document.createElement("span");
        badge.className = "launch-default-badge";
        badge.textContent = "기본";
        card.append(badge);
      }
      card.addEventListener("click", ev => {
        ev.preventDefault(); ev.stopPropagation();
        void launch(view, profile.id).catch(err => {
          setPaneOverlay(view, "empty", "실행하지 못했습니다", String(err?.message ?? err));
          setStatus(String(err?.message ?? err), true);
        });
      });
      const pair = window.wincmuxLocalAccounts?.launchChoice(view,profile,card);
      grid.append(pair ?? card);
    }
    const history = document.createElement("button");
    history.type = "button";
    history.className = "launch-conversations";
    history.textContent = "↶ 이전 대화 불러오기 · Claude / Codex";
    history.addEventListener("click", ev => { ev.stopPropagation(); void window.wincmuxConversations.open(view.paneId); });
    const viewerHeading = document.createElement("div");
    viewerHeading.className = "launch-section-heading";
    viewerHeading.textContent = "워크스페이스 보기";
    const viewerGrid = document.createElement("div");
    viewerGrid.className = "launch-profile-grid launch-viewer-grid";
    for (const [tab, name, description, iconKind] of [
      ["files", "폴더 뷰어", "파일 트리 · 미리보기 · 파일 복사", "folder"],
      ["git", "Git", "변경 상태 · 파일별 diff", "git"]
    ]) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "launch-profile-card launch-viewer-card";
      card.dataset.viewerTab = tab;
      card.dataset.icon = iconKind;
      card.innerHTML = `<span class="launch-profile-icon">${iconMarkup(iconKind)}</span><span class="launch-profile-text"><span class="launch-profile-name"></span><span class="launch-profile-command"></span></span>`;
      card.querySelector(".launch-profile-name").textContent = name;
      card.querySelector(".launch-profile-command").textContent = description;
      card.addEventListener("click", ev => {
        ev.preventDefault(); ev.stopPropagation();
        try { window.wincmuxWorkspaceViewer.open(tab); }
        catch (err) { setStatus(String(err?.message ?? err), true); }
      });
      viewerGrid.append(card);
    }
    host.append(viewerHeading, viewerGrid, heading, grid, history);
  }
  async function launch(view, id = config.defaultId) {
    const profile = config.items.find(item => item.id === id);
    if (!profile) { openSettings(); return null; }
    if (busyPanes.has(view.paneId)) return null;
    if (state.paneViews.get(view.paneId) !== view || view.disposed) throw new Error("현재 열린 터미널을 선택하세요.");
    if (view.sessionId && state.runningSessionIds.has(view.sessionId)) throw new Error("이미 실행 중인 터미널입니다. 새 pane에서 도구를 선택하세요.");
    busyPanes.add(view.paneId);
    setPaneOverlay(view, "starting", `${profile.name} 시작 중…`, profile.command);
    try {
      if (/^(powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i.test(profile.command)) {
        return await paneHandlers.startSessionForPane(view.paneId, { force: false,
          cmd: profile.command, args: overlayShellArgs(profile.command, ""), workspaceId: state.selectedWorkspaceId, focusTerm: true });
      }
      return await startShellCommandForPane(view.paneId, profile.command, { force: false, focusTerm: true });
    } finally {
      busyPanes.delete(view.paneId);
    }
  }
  function selected() { return draft.items.find(item => item.id === selectedId); }
  function renderList() {
    list.replaceChildren();
    for (const item of draft.items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "launch-settings-row";
      row.dataset.selected = String(item.id === selectedId);
      row.dataset.icon = item.icon;
      row.setAttribute("aria-pressed", String(item.id === selectedId));
      const icon = document.createElement("span");
      icon.className = "launch-profile-icon";
      icon.innerHTML = iconMarkup(item.icon);
      const name = document.createElement("span");
      name.textContent = item.name || "새 실행 항목";
      row.append(icon, name);
      if (item.id === draft.defaultId) {
        const badge = document.createElement("span"); badge.className = "launch-default-badge"; badge.textContent = "기본"; row.append(badge);
      }
      row.addEventListener("click", () => { selectedId = item.id; renderEditor(); });
      list.append(row);
    }
    if (!draft.items.length) list.textContent = "항목 추가를 눌러 시작하세요.";
    const item = selected();
    preview.dataset.icon = item?.icon ?? "terminal";
    preview.innerHTML = iconMarkup(item?.icon);
    dialog.querySelector('[data-action="add"]').disabled = draft.items.length >= 40;
    dialog.querySelector('[data-action="up"]').disabled = !item || draft.items.indexOf(item) === 0;
    dialog.querySelector('[data-action="down"]').disabled = !item || draft.items.indexOf(item) === draft.items.length - 1;
  }
  function renderEditor() {
    const item = selected();
    editor.hidden = !item;
    if (item) {
      editor.elements.name.value = item.name;
      editor.elements.command.value = item.command;
      editor.elements.icon.value = item.icon;
      editor.elements.defaultProfile.checked = item.id === draft.defaultId;
    }
    renderList();
  }
  function createDialog() {
    dialog = document.createElement("dialog");
    dialog.className = "launch-settings-dialog";
    dialog.id = "launchSettingsDialog";
    dialog.setAttribute("aria-labelledby", "launchSettingsTitle");
    dialog.innerHTML = `<div class="launch-settings-header"><div><h2 id="launchSettingsTitle">실행 도구 설정</h2><p>빈 터미널에서 선택할 도구와 기본 명령어를 관리합니다.</p></div><button type="button" data-action="close" aria-label="설정 닫기">✕</button></div>
      <div class="launch-settings-body"><aside class="launch-settings-sidebar"><div class="launch-settings-list" aria-label="실행 도구 목록"></div><button type="button" data-action="add">＋ 항목 추가</button><div class="launch-order-actions"><button type="button" data-action="up" aria-label="위로 이동">↑</button><button type="button" data-action="down" aria-label="아래로 이동">↓</button><button type="button" data-action="reset">기본 목록 불러오기</button></div></aside>
      <form class="launch-settings-editor"><div class="launch-editor-heading"><span class="launch-profile-icon launch-icon-preview"></span><h3>실행 항목</h3></div><label>표시 이름<input name="name" maxlength="48" required autocomplete="off" placeholder="예: Claude Code" /></label><label>실행 명령어<textarea name="command" rows="4" maxlength="4096" required spellcheck="false" placeholder="예: claude --model sonnet"></textarea></label><p class="launch-field-help">선택한 워크스페이스 폴더에서 실행합니다. 인수와 여러 줄 명령도 입력할 수 있습니다.</p><label>아이콘<select name="icon"></select></label><label class="launch-default-option"><input type="checkbox" name="defaultProfile" />기본 실행 도구로 사용</label><button class="launch-delete" type="button" data-action="delete">이 항목 삭제</button></form></div>
      <p class="launch-settings-error" role="alert" hidden></p><div class="launch-settings-footer"><span>변경 사항은 저장 후 적용됩니다.</span><button type="button" data-action="cancel">취소</button><button type="button" class="launch-save" data-action="save">저장</button></div>`;
    document.body.append(dialog);
    editor = dialog.querySelector("form"); list = dialog.querySelector(".launch-settings-list");
    preview = dialog.querySelector(".launch-icon-preview"); error = dialog.querySelector(".launch-settings-error");
    for (const [value, label] of Object.entries(iconLabels)) {
      const option = document.createElement("option"); option.value = value; option.textContent = label; editor.elements.icon.append(option);
    }
    editor.addEventListener("submit", ev => ev.preventDefault());
    editor.addEventListener("input", () => {
      const item = selected(); if (!item) return;
      item.name = editor.elements.name.value; item.command = editor.elements.command.value; item.icon = editor.elements.icon.value;
      if (editor.elements.defaultProfile.checked) draft.defaultId = item.id;
      else if (draft.defaultId === item.id) {
        draft.defaultId = draft.items.find(row => row.id !== item.id)?.id ?? item.id;
        editor.elements.defaultProfile.checked = draft.defaultId === item.id;
      }
      renderList();
    });
    dialog.addEventListener("click", ev => {
      const action = ev.target.closest("[data-action]")?.dataset.action;
      if (!action) return;
      if (["close", "cancel"].includes(action)) { dialog.close(); return; }
      error.hidden = true;
      if (action === "add") {
        if (draft.items.length >= 40) return;
        const item = { id: crypto.randomUUID(), name: "", command: "", icon: "terminal" };
        draft.items.push(item); selectedId = item.id; if (!draft.defaultId) draft.defaultId = item.id;
        renderEditor(); editor.elements.name.focus();
      } else if (action === "delete") {
        const index = draft.items.findIndex(item => item.id === selectedId);
        draft.items = draft.items.filter(item => item.id !== selectedId);
        if (draft.defaultId === selectedId) draft.defaultId = draft.items[0]?.id ?? null;
        selectedId = draft.items[Math.min(index, draft.items.length - 1)]?.id; renderEditor();
      } else if (action === "reset") {
        draft = defaults(); selectedId = draft.items[0].id; renderEditor();
      } else if (action === "up" || action === "down") {
        const index = draft.items.findIndex(item => item.id === selectedId), next = index + (action === "up" ? -1 : 1);
        if (index >= 0 && next >= 0 && next < draft.items.length) [draft.items[index], draft.items[next]] = [draft.items[next], draft.items[index]];
        renderList();
      } else if (action === "save") {
        try { save(draft); dialog.close(); setStatus("실행 도구 목록을 저장했습니다."); }
        catch (err) { error.textContent = String(err?.message ?? err); error.hidden = false; }
      }
    });
  }
  function openSettings() {
    if (!dialog) createDialog();
    if (dialog.open) return;
    draft = clone(config); selectedId = draft.items[0]?.id; error.hidden = true;
    renderEditor(); dialog.showModal();
    (draft.items.length ? editor.elements.name : dialog.querySelector('[data-action="add"]')).focus();
  }
  function focusDefault(view) {
    const cards = [...(view.overlayLaunchEl?.querySelectorAll(".launch-profile-card") ?? [])];
    (cards.find(card => card.dataset.profileId === config.defaultId) ?? cards[0])?.focus();
  }
  window.wincmuxLaunchProfiles = { getAll: () => clone(config), getDefault: () => clone(config.items.find(item => item.id === config.defaultId) ?? null), save, render, launch, openSettings, focusDefault, iconMarkup };
  document.getElementById("launchSettingsBtn")?.addEventListener("click", openSettings);
})();
