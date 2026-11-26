"use strict";
(() => {
  const { invoke, Channel } = window.__TAURI__.core;
  const el = id => document.getElementById(id);
  const previewLimitKey = "wincmux.viewer.previewLimitMb";
  const previewLimit = el("previewLimit");
  previewLimit.value = ["8", "16", "32", "64"].includes(localStorage.getItem(previewLimitKey)) ? localStorage.getItem(previewLimitKey) : "8";
  const maxPreviewBytes = () => Number(previewLimit.value) * 1024 * 1024;
  const launchButtons = { newTerminal: "shell", newClaude: "claude", newCodex: "codex", newGemini: "gemini" };
  const launchLabels = { shell: "셸", claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };
  const localDocker = new URLSearchParams(location.search).get("mode") === "docker";
  const rpc = (action, params = {}) => invoke("ssh_workspace", { action, params });
  const status = text => { el("sshStatus").textContent = text; };
  for (const node of document.querySelectorAll("[data-icon]")) {
    node.insertAdjacentHTML("afterbegin", paneIcon[node.dataset.icon]);
  }
  const alert = error => {
    el("notice").hidden = !error;
    el("notice").textContent = error ? String(error) : "";
  };
  const option = (label, value) => new Option(label, value);
  let profile;
  let selectedProfile;
  let useAlias = true;
  let challenge;
  let testingConnection = false;
  let aliasRequest = 0;
  let connected = false;
  let restoredDocker = false;
  let target;
  let browsePath;
  let browsePage = 0;
  let busy = false;
  let request = 0;
  let previewRequest = 0;
  let view = "files";
  let page = 0;
  let folder = "";
  let treeOpen = new Set();
  const collapsedSavedByTarget = new Map();
  const savedFolderKey = () => `wincmux.viewer.savedFolders.${JSON.stringify([localDocker ? "docker" : profile?.alias || profile?.host, target?.container || "", target?.path || ""])}`;
  const collapsedSaved = () => {
    const key = savedFolderKey();
    if (!collapsedSavedByTarget.has(key)) collapsedSavedByTarget.set(key, new Set());
    return collapsedSavedByTarget.get(key);
  };
  const savedFolders = () => {
    try {
      const value = JSON.parse(localStorage.getItem(savedFolderKey()) || "[]");
      return Array.isArray(value) ? value.filter(path => typeof path === "string" && path && !path.startsWith("/") && !path.split("/").some(part => part === ".." || part === ".")).slice(0, 20) : [];
    } catch { return []; }
  };
  let folderPicker;
  const savedMode = () => folderPicker.mode() === "saved";
  const saveFolders = paths => localStorage.setItem(savedFolderKey(), JSON.stringify(paths));
  let savedFeedbackTimer;
  const showSavedFolderFeedback = text => {
    const node = el("savedFolderFeedback");
    node.textContent = text;
    node.title = text;
    node.hidden = false;
    clearTimeout(savedFeedbackTimer);
    savedFeedbackTimer = setTimeout(() => { node.hidden = true; }, 4500);
  };
  let preview;
  const extensionFilter = window.wincmuxViewerExtensions(el("searchExtensions"), () => { updateSearchOptionsLabel(); if (activeEnvironment?.open && view === "files") void viewerTask(list); });
  previewLimit.addEventListener("change", () => {
    localStorage.setItem(previewLimitKey, previewLimit.value);
    if (preview?.title && preview.language !== "diff") loadPreview(preview.title);
  });
  let paneNumber = 0;
  let paneGroupNumber = 0;
  let dockerItems = [];
  let selectingDockerFolder = false;
  let activeEnvironment;
  folderPicker = window.wincmuxViewerFolderPicker({
    trigger: el("savedFolderMode"), getFolders: savedFolders, getKey: savedFolderKey,
    onChange: () => { page = 0; updateViewerScope(); void viewerTask(list); }
  });
  let movingPane = null;
  const sidebarKey = `wincmux.${localDocker ? "docker" : "ssh"}.sidebar-collapsed`;
  const compactSidebar = matchMedia("(max-width:760px)");
  function setSidebarCollapsed(collapsed, persist = true) {
    el("workspaceSidebar").hidden = collapsed;
    el("workspaceSidebarToggle").setAttribute("aria-expanded", String(!collapsed));
    el("workspaceSidebarToggle").title = collapsed ? "작업공간 사이드바 펼치기" : "작업공간 사이드바 접기";
    if (persist && !compactSidebar.matches) localStorage.setItem(sidebarKey, String(collapsed));
    requestAnimationFrame(() => activeEnvironment && refitEnvironment(activeEnvironment));
  }
  function updateWorkspaceContext() {
    const context = el("workspaceContext");
    const environment = activeEnvironment;
    context.hidden = !environment;
    if (!environment) return;
    const name = dockerItems.find(item => item.ID === environment.project.container)?.Names
      || (environment.project.container ? "Docker" : profile?.name || "SSH 서버");
    context.textContent = `${name} · ${environment.project.path}`;
    context.title = context.textContent;
  }
  el("workspaceSidebarToggle").addEventListener("click", () => setSidebarCollapsed(!el("workspaceSidebar").hidden));
  el("collapseWorkspaceSidebar").addEventListener("click", () => setSidebarCollapsed(true));
  const syncSidebarWidth = () => setSidebarCollapsed(compactSidebar.matches || localStorage.getItem(sidebarKey) === "true", false);
  compactSidebar.addEventListener("change",syncSidebarWidth);
  syncSidebarWidth();
  window.wincmuxAgentCommandInput.setWorkspaceLoader(async (provider) => {
    const environment = activeEnvironment;
    if (!environment) return { title: "", items: [] };
    const sourceId = environment.focused?.id;
    if (!sourceId) await rpc("set-target", { path: environment.project.path, container: environment.project.container });
    const result = await rpc("agent-skills", { provider, source_terminal_id: sourceId });
    return { title: environment.tab.title, items: result.items || [] };
  });
  let pendingSplit;
  let pendingEnvironmentClose;
  const lastPaths = new Map();
  const panes = new Set();
  const environments = new Map();
  const viewerPanel = {
    button: el("toggleRemoteViewer"), content: el("workArea"),
    panel: el("remoteViewer"), divider: el("remoteViewerResize")
  };

  const subscribeAlerts = window.wincmuxRemoteAlerts({ request: rpc, localDocker, focusTarget: focusAlertTarget, reportError: alert });
  window.wincmuxRemindersConfig = {
    request: rpc, subscribe: subscribeAlerts,
    context: () => ({
      workspaceId: activeEnvironment?.project.notification_workspace,
      sessionId: activeEnvironment?.focused?.id,
      workspaces: []
    }),
    reportStatus: status
  };

  function button(label, fn) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    node.addEventListener("click", fn);
    return node;
  }

  function paneAction(icon, label, run, shortcut) {
    const control = button("", run);
    control.className = "icon-control";
    control.dataset.action = icon;
    control.title = shortcut ? `${label} (${shortcut})` : label;
    control.setAttribute("aria-label", label);
    control.innerHTML = paneIcon[icon];
    return control;
  }

  function connectionFeedback(message = "", tone = "") {
    el("connectFeedback").textContent = message;
    el("connectFeedback").dataset.tone = tone;
  }

  function clearConnectionFeedback() {
    el("registerAlias").hidden = true;
    connectionFeedback();
  }

  async function guarded(work, propagate = false) {
    if (busy) {
      if (propagate) throw new Error("다른 작업이 진행 중입니다. 잠시 후 다시 시도하세요.");
      return;
    }
    busy = true;
    const disabled = ["connect", "testConnect", "editSshConfig", "refreshAliases", "registerAlias", "registerSubmit", "authSubmit", "skipPassphrase", "authCancel", "disconnect", ...Object.keys(launchButtons)].map(el);
    disabled.forEach(node => { node.disabled = true; });
    el("forget").disabled = true;
    try {
      alert(null);
      return await work();
    } catch (error) {
      if (propagate) throw error;
      if (!connected) {
        challenge = null;
        el("authFields").replaceChildren();
        el("authDialog").close();
        status("연결되지 않음");
        connectionFeedback(String(error), "error");
      } else {
        alert(error);
      }
    } finally {
      disabled.forEach(node => { node.disabled = false; });
      busy = false;
      el("forget").disabled = !selectedProfile;
    }
  }

  function showProfiles(items, selectedName = selectedProfile?.name) {
    selectedProfile = items.find(item => item.name === selectedName);
    el("emptyProfiles").hidden = items.length > 0;
    el("profiles").replaceChildren(...items.map(item => {
      const card = button(item.name, () => {
        if (!busy) fill(item);
      });
      const name = document.createElement("strong");
      name.textContent = item.name;
      card.replaceChildren(name);
      card.dataset.name = item.name;
      const endpoint = item.alias || `${item.user}@${item.host}${item.port === 22 ? "" : `:${item.port}`}`;
      for (const detail of [endpoint === item.name ? "" : endpoint, item.project?.path].filter(Boolean)) {
        const line = document.createElement("span");
        line.textContent = detail;
        line.title = detail;
        card.append(line);
      }
      const row = document.createElement("li");
      row.append(card);
      return row;
    }));
    updateProfileSelection();
  }

  function updateProfileSelection() {
    for (const card of el("profiles").querySelectorAll("button")) {
      card.setAttribute("aria-pressed", String(card.dataset.name === selectedProfile?.name));
    }
    el("forget").disabled = busy || !selectedProfile;
  }

  function fill(item) {
    selectedProfile = item;
    for (const id of ["name", "alias", "host", "user", "port", "identity"]) el(id).value = item[id] || (id === "port" ? 22 : "");
    selectMode(Boolean(item.alias));
    updateProfileSelection();
  }
  function selectMode(fromWindows) {
    useAlias = fromWindows;
    el("windowsSshMode").setAttribute("aria-pressed", String(useAlias));
    el("newSshMode").setAttribute("aria-pressed", String(!useAlias));
    el("windowsSsh").disabled = !useAlias;
    el("windowsSsh").hidden = !useAlias;
    el("manual").disabled = useAlias;
    el("manual").hidden = useAlias;
    clearConnectionFeedback();
  }

  function showAliases(aliases) {
    el("aliases").replaceChildren(...aliases.map(alias => option(alias, alias)));
    el("aliasHint").textContent = aliases.length
      ? `Windows SSH 별칭 ${aliases.length}개 · OpenSSH 설정의 사용자·포트·키를 사용합니다.`
      : "SSH 설정을 열어 별칭을 추가하거나 직접 입력으로 연결하세요.";
  }

  async function refreshAliases() {
    const request = ++aliasRequest;
    const aliases = await rpc("aliases");
    if (request === aliasRequest) showAliases(aliases);
    return aliases.length;
  }

  el("editSshConfig").addEventListener("click", () => guarded(() => rpc("open-ssh-config")));
  el("refreshAliases").addEventListener("click", () => guarded(async () => {
    const count = await refreshAliases();
    connectionFeedback(`Windows SSH 별칭 ${count}개를 불러왔습니다.`);
  }));
  window.addEventListener("focus", () => {
    if (!localDocker && !connected && !busy && !el("authDialog").open) void refreshAliases().catch(() => {});
  });
  el("windowsSshMode").addEventListener("click", () => { selectMode(true); el("alias").focus(); });
  el("newSshMode").addEventListener("click", () => { selectMode(false); el("host").focus(); });
  el("pickKey").addEventListener("click", () => guarded(async () => {
    const selected = await rpc("pick-key");
    if (selected) {
      el("identity").value = selected;
      clearConnectionFeedback();
    }
  }));
  el("connectionForm").addEventListener("input", clearConnectionFeedback);
  el("forget").addEventListener("click", () => guarded(async () => {
    if (!selectedProfile) return;
    showProfiles((await rpc("forget", { name: selectedProfile.name })).profiles);
    connectionFeedback("저장 목록에서 연결을 삭제했습니다.");
  }));

  function readProfile() {
    const alias = useAlias ? el("alias").value.trim() : "";
    const current = { name: el("name").value.trim(), alias, host: alias ? "" : el("host").value.trim(), user: alias ? "" : el("user").value.trim(), port: alias ? 22 : Number(el("port").value), identity: alias ? "" : el("identity").value.trim() };
    if (selectedProfile && ["name", "alias", "host", "user", "port", "identity"].every(key => selectedProfile[key] === current[key])) current.project = selectedProfile.project;
    return current;
  }
  async function auth(result) {
    el("authFields").replaceChildren();
    if (result.state === "tested") {
      challenge = null;
      el("authDialog").close();
      status("연결되지 않음");
      connectionFeedback("연결 테스트에 성공했습니다. 연결을 누르면 작업공간이 열립니다.", "success");
      el("registerAlias").hidden = !result.manual;
      requestAnimationFrame(() => el("connect").focus());
      return;
    }
    if (result.state === "connected") {
      challenge = null;
      el("authDialog").close();
      connected = true;
      el("setup").hidden = true;
      el("disconnect").hidden = false;
      el("workspaceSidebarToggle").hidden = false;
      el("workspace").hidden = false;
      profile.alias = result.alias || profile.alias;
      profile.name = result.name;
      if (result.profiles) {
        showProfiles(result.profiles, profile.name);
        if (selectedProfile) fill(selectedProfile);
      }
      el("openCode").hidden = !profile.alias;
      el("forgetPassword").hidden = !result.password_cached;
      el("connectionOptions").hidden = false;
      status(`${profile.alias || profile.host} · ${result.used_cached_password ? "저장된 비밀번호로 연결됨" : "SSH 연결 성공"}`);
      try {
        if (result.project?.container) await refreshContainers();
        el("container").value = result.project?.container || "";
        if (result.project?.container && !el("container").value) throw Error("저장된 컨테이너가 실행 중이지 않습니다. 현재 실행 중인 컨테이너를 선택하세요.");
        el("directory").value = result.project?.path || "";
        await openProject();
      } catch (error) {
        el("directory").focus();
        alert([error, result.message].filter(Boolean).join("\n"));
        return;
      }
      if (result.message) alert(result.message);
      return;
    }
    challenge = result;
    const host = result.state === "host_key";
    el("authTitle").textContent = host ? "SSH 서버 키 확인" : "SSH 인증";
    el("authMessage").textContent = host
      ? `${result.host}:${result.port}에 처음 연결합니다. 서버 관리자가 제공한 지문과 비교한 후 신뢰하세요.`
      : [result.message, result.instructions].filter(Boolean).join("\n");
    el("authFingerprint").hidden = !host;
    el("authFingerprint").textContent = host ? result.fingerprint : "";
    el("skipPassphrase").hidden = result.kind !== "passphrase";
    el("rememberLabel").hidden = testingConnection || result.kind !== "password";
    el("authSubmit").textContent = host ? "이 서버 신뢰" : "인증";
    for (const prompt of result.prompts || []) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      label.textContent = prompt.label;
      input.type = prompt.echo ? "text" : "password";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.maxLength = 2048;
      label.append(input);
      el("authFields").append(label);
    }
    if (!el("authDialog").open) el("authDialog").showModal();
    (el("authFields").querySelector("input") || el("authCancel")).focus();
  }
  el("connectionForm").addEventListener("submit", event => {
    event.preventDefault();
    guarded(async () => {
      profile = readProfile();
      clearConnectionFeedback();
      testingConnection = event.submitter?.id === "testConnect";
      el("rememberPassword").checked = false;
      const pending = testingConnection ? "SSH 연결 테스트 중…" : "SSH 서버에 연결 중…";
      status(pending);
      connectionFeedback(pending);
      await auth(await rpc(testingConnection ? "test-connect" : "connect", profile));
    });
  });
  el("registerAlias").addEventListener("click", () => {
    el("registerError").hidden = true;
    el("registerName").value = "";
    el("registerDialog").showModal();
  });
  el("registerCancel").addEventListener("click", () => el("registerDialog").close());
  el("registerForm").addEventListener("submit", event => {
    event.preventDefault();
    guarded(async () => {
      const alias = el("registerName").value.trim();
      try {
        const aliases = await rpc("register-alias", { alias });
        ++aliasRequest;
        showAliases(aliases);
        el("registerDialog").close();
        selectMode(true);
        el("alias").value = alias;
        connectionFeedback(`${alias} 별칭을 Windows SSH에 저장했습니다.`, "success");
        requestAnimationFrame(() => el("connect").focus());
      } catch (error) {
        el("registerError").textContent = String(error);
        el("registerError").hidden = false;
        el("registerName").focus();
      }
    });
  });
  el("authForm").addEventListener("submit", event => {
    event.preventDefault();
    guarded(async () => {
      if (!challenge) return;
      if (challenge.state === "host_key") return auth(await rpc("confirm", { id: challenge.id }));
      const fields = [...el("authFields").querySelectorAll("input")];
      const answers = fields.map(field => field.value);
      fields.forEach(field => { field.value = ""; });
      await auth(await rpc("answer", { id: challenge.id, answers, remember: !testingConnection && challenge.kind === "password" && el("rememberPassword").checked }));
    });
  });
  el("skipPassphrase").addEventListener("click", () => guarded(async () => {
    if (challenge) await auth(await rpc("answer", { id: challenge.id, answers: [] }));
  }));
  async function disconnect() {
    conversations.close();
    await rpc("disconnect");
    connected = false;
    challenge = null;
    target = null;
    lastPaths.clear();
    dockerItems = [];
    request += 1;
    el("authFields").replaceChildren();
    el("authDialog").close();
    for (const pane of panes) pane.dispose(false);
    environments.clear();
    activeEnvironment = null;
    el("panes").replaceChildren();
    el("environmentTabs").replaceChildren();
    el("environmentTabs").hidden = true;
    el("paneGroupTabs").replaceChildren();
    el("paneGroupTabs").hidden = true;
    setViewerOpen(false);
    el("workspace").hidden = true;
    el("workspaceSidebarToggle").hidden = true;
    el("workspaceContext").hidden = true;
    el("workArea").hidden = true;
    el("disconnect").hidden = true;
    el("connectionOptions").hidden = true;
    el("connectionOptions").open = false;
    el("setup").hidden = false;
    el("container").replaceChildren(option("SSH 서버", ""));
    el("directory").value = "";
    clearConnectionFeedback();
    status("연결되지 않음");
  }
  for (const id of ["authCancel", "disconnect"]) el(id).addEventListener("click", () => guarded(disconnect));
  el("authDialog").addEventListener("cancel", event => {
    event.preventDefault();
    guarded(disconnect);
  });
  el("saveProfile").addEventListener("click", () => guarded(async () => {
    const result = await rpc("save");
    profile.name = result.name;
    showProfiles(result.profiles, profile.name);
    status(`${profile.name} · 폴더 저장됨`);
  }));
  el("forgetPassword").addEventListener("click", () => guarded(async () => {
    await rpc("forget-password");
    el("connectionOptions").open = false;
    el("connectionOptions").hidden = true;
    el("disconnect").focus();
    el("forgetPassword").hidden = true;
    status("저장된 비밀번호 삭제됨");
  }));
  async function refreshContainers() {
    const select = el("container");
    const selected = select.value;
    try {
      const items = await rpc("containers");
      dockerItems = items;
      const placeholder = localDocker ? (items.length ? "컨테이너 선택" : "실행 중인 컨테이너 없음") : "SSH 서버";
      select.replaceChildren(option(placeholder, ""), ...items.map((item, index) => option(`${index + 1}. ${item.Names}`, item.ID)));
      select.value = items.some(item => item.ID === selected) ? selected : "";
      if (localDocker) {
        status(items.length ? `실행 중인 컨테이너 ${items.length}개` : "실행 중인 컨테이너 없음");
        if (!select.value) el("directory").value = "";
      } else if (!items.length) alert("실행 중인 컨테이너가 없습니다.");
    } catch (error) {
      if (localDocker) {
        select.replaceChildren(option("Docker 목록을 불러올 수 없음", ""));
        status("로컬 Docker 연결 확인 필요");
      }
      throw error;
    } finally {
      updateContainerControls();
    }
    if (localDocker && !restoredDocker && select.options.length > 1) {
      const previous = await rpc("last-project");
      restoredDocker = !previous?.container || [...select.options].some(item => item.value === previous.container);
      if (restoredDocker && previous?.container && !select.value) {
        select.value = previous.container;
        el("directory").value = previous.path;
        updateContainerControls();
      }
    }
  }
  function updateContainerControls() {
    const select = el("container");
    const hasContainer = Boolean(select.value);
    select.toggleAttribute("data-container", hasContainer);
    select.title = select.selectedOptions[0]?.textContent || "";
    if (!localDocker) return;
    const selectedIndex = dockerItems.findIndex(item => item.ID === select.value);
    const chosen = dockerItems[selectedIndex];
    el("dockerPickerNumber").hidden = !chosen;
    el("dockerPickerNumber").textContent = chosen ? String(selectedIndex + 1) : "";
    el("dockerPickerName").textContent = chosen?.Names || select.selectedOptions[0]?.textContent || "컨테이너 선택";
    el("dockerPicker").title = chosen ? `${selectedIndex + 1}. ${chosen.Names}` : "컨테이너 선택";
    for (const id of ["directory", "browse", "openTarget"]) el(id).disabled = !hasContainer;
  }
  el("container").addEventListener("change", () => {
    el("directory").value = lastPaths.get(el("container").value) || "";
    updateContainerControls();
  });
  function chooseContainer(item) {
    el("container").value = item.ID;
    el("container").dispatchEvent(new Event("change", { bubbles: true }));
  }
  let containerNumber = "";
  let containerNumberAt = 0;
  const selectContainerNumber = event => {
    if (!localDocker || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "/") {
      event.preventDefault();
      el("dockerPicker").click();
      return;
    }
    if (!/^\d$/.test(event.key)) return;
    event.preventDefault();
    const now = Date.now();
    containerNumber = now - containerNumberAt < 750 ? containerNumber + event.key : event.key;
    containerNumberAt = now;
    const item = dockerItems[Number(containerNumber) - 1];
    if (item) chooseContainer(item);
  };
  for (const id of ["container", "dockerPicker"]) el(id).addEventListener("keydown", selectContainerNumber);
  function showDockerChoices() {
    const query = el("dockerFilter").value.trim().toLowerCase();
    const number = /^#?([1-9]\d*)$/.exec(query);
    const matches = dockerItems.map((item, index) => ({ item, number: index + 1 }))
      .filter(({ item, number: index }) => number ? index === Number(number[1]) : `${item.Names} ${item.Image}`.toLowerCase().includes(query));
    const list = el("dockerList");
    list.replaceChildren(...matches.map(({ item, number: index }) => {
      const choice = button("", () => guarded(async () => {
        chooseContainer(item);
        await browse(el("directory").value || ".");
        selectingDockerFolder = true;
        el("dockerDialog").close();
      }));
      choice.className = "docker-choice";
      const number = document.createElement("span");
      number.className = "docker-choice-number";
      number.textContent = String(index);
      const label = document.createElement("span");
      label.className = "docker-choice-label";
      label.textContent = `${item.Names} · ${item.Image}`;
      choice.append(number, label);
      return choice;
    }));
    if (!matches.length) list.textContent = dockerItems.length ? "검색 결과가 없습니다." : "실행 중인 컨테이너가 없습니다.";
  }
  async function loadDockerDialog() {
    el("dockerList").textContent = "컨테이너 확인 중…";
    try {
      await refreshContainers();
      showDockerChoices();
    } catch (error) {
      el("dockerList").textContent = String(error);
    }
  }
  const openDockerChoices = () => guarded(async () => {
    el("dockerFilter").value = "";
    el("dockerDialog").showModal();
    el("dockerFilter").focus();
    await loadDockerDialog();
  });
  el("dockerAttach").addEventListener("click", openDockerChoices);
  el("dockerPicker").addEventListener("click", openDockerChoices);
  el("dockerRefresh").addEventListener("click", () => guarded(loadDockerDialog));
  el("dockerCancel").addEventListener("click", () => el("dockerDialog").close());
  el("dockerFilter").addEventListener("input", showDockerChoices);
  el("dockerFilter").addEventListener("keydown", event => {
    if (event.key !== "Enter" || !/^#?[1-9]\d*$/.test(el("dockerFilter").value.trim())) return;
    const choice = el("dockerList").querySelector("button");
    if (!choice) return;
    event.preventDefault();
    choice.click();
  });
  el("targetForm").addEventListener("submit", event => {
    event.preventDefault();
    guarded(openProject);
  });
  function createPaneGroup(environment, name = `Group ${++paneGroupNumber}`) {
    const group = { name, root: document.createElement("div"), hiddenRoot: document.createElement("div"), focused: null };
    group.root.className = "pane-group-root";
    group.hiddenRoot.className = "hidden-pane-storage";
    group.hiddenRoot.hidden = true;
    group.root.hidden = true;
    environment.groups.push(group);
    environment.root.append(group.root, group.hiddenRoot);
    switchPaneGroup(environment, group);
    return group;
  }
  function switchPaneGroup(environment, group) {
    if (!environment.groups.includes(group)) return;
    if (environment.activeGroup) environment.activeGroup.root.hidden = true;
    environment.activeGroup = group;
    group.root.hidden = environment !== activeEnvironment;
    environment.focused = group.focused && !group.focused.hidden ? group.focused : null;
    if (environment === activeEnvironment) {
      renderPaneGroups();
      updateEqualize();
      refitEnvironment(environment);
    }
  }
  function renderPaneGroups() {
    const nav = el("paneGroupTabs");
    const environment = activeEnvironment;
    nav.replaceChildren();
    nav.hidden = !environment;
    if (!environment) return;
    for (const group of environment.groups) {
      const row = document.createElement("div");
      row.className = "pane-group-tab";
      row.classList.toggle("move-target", Boolean(movingPane && movingPane.group !== group));
      const tab = button(group.name, () => {
        if (movingPane && movingPane.group !== group) { movePaneToGroup(movingPane, group); return; }
        switchPaneGroup(environment, group);
        environment.focused?.focus();
      });
      tab.setAttribute("aria-pressed", String(group === environment.activeGroup));
      tab.title = `${group.name} · ${[...panes].filter(pane => pane.group === group).length}개 터미널`;
      row.append(tab);
      if (environment.groups.length > 1) {
        const close = button("×", async () => {
          const members = [...panes].filter(pane => pane.group === group);
          if (members.length && !window.confirm(`${group.name}의 터미널 ${members.length}개를 종료하고 그룹을 삭제할까요?`)) return;
          for (const pane of members) await pane.dispose();
          group.root.remove();
          group.hiddenRoot.remove();
          environment.groups.splice(environment.groups.indexOf(group), 1);
          if (environment.activeGroup === group) switchPaneGroup(environment, environment.groups[0]);
          else renderPaneGroups();
          refreshHiddenPanes();
        });
        close.className = "group-close";
        close.title = `${group.name} 삭제`;
        close.setAttribute("aria-label", `${group.name} 삭제`);
        row.append(close);
      }
      nav.append(row);
    }
    nav.append(button("+ 그룹", () => {
      const source = movingPane;
      const group = createPaneGroup(environment);
      if (source) { movePaneToGroup(source, group); return; }
      status(`${group.name}을 만들었습니다. 이 그룹에서 터미널을 열 수 있습니다.`);
      el("newTerminal").focus();
    }));
  }
  function refreshHiddenPanes() {
    const hidden = [...panes].filter(pane => pane.environment === activeEnvironment && pane.hidden);
    el("hiddenRemotePanes").textContent = `숨김 (${hidden.length})`;
    if (!el("hiddenRemotePanesDialog").open) return;
    const list = el("hiddenRemotePanesList");
    list.replaceChildren();
    if (!hidden.length) list.textContent = "숨긴 터미널이 없습니다.";
    for (const pane of hidden) {
      const row = document.createElement("div");
      row.className = "hidden-remote-row";
      const title = document.createElement("strong");
      title.textContent = `${pane.group.name} · ${pane.node.querySelector(".pane-title strong")?.textContent ?? "터미널"}`;
      row.append(title, button("복원", () => restorePane(pane)), button("종료", () => pane.dispose().catch(alert)));
      list.append(row);
    }
  }
  function hidePane(pane) {
    if (!panes.has(pane) || pane.hidden) return;
    if (movingPane === pane) clearPaneMove();
    window.wincmuxRemoteLayout.remove(pane.node);
    pane.group.hiddenRoot.append(pane.node);
    pane.hidden = true;
    if (pane.group.focused === pane) pane.group.focused = [...panes].find(other => other.group === pane.group && !other.hidden) ?? null;
    if (pane.environment.focused === pane) pane.environment.focused = pane.group.focused;
    updateEqualize();
    refreshHiddenPanes();
    pane.environment.focused?.focus();
  }
  function restorePane(pane) {
    if (!panes.has(pane) || !pane.hidden) return;
    const group = pane.group;
    const anchor = [...panes].findLast(other => other.group === group && other !== pane && !other.hidden)?.node;
    window.wincmuxRemoteLayout.mount(group.root, pane.node, anchor, "right");
    pane.hidden = false;
    switchPaneGroup(pane.environment, group);
    pane.environment.focused = group.focused = pane;
    updateEqualize();
    refreshHiddenPanes();
    pane.fit();
    pane.focus();
  }
  el("hiddenRemotePanes").addEventListener("click", () => {
    el("hiddenRemotePanesDialog").showModal();
    refreshHiddenPanes();
  });
  el("closeHiddenRemotePanes").addEventListener("click", () => el("hiddenRemotePanesDialog").close());
  async function openProject() {
    const launch = activeEnvironment?.focused?.launch ?? "shell";
    const project = await rpc("set-target", { path: el("directory").value || ".", container: el("container").value || null });
    lastPaths.set(project.container || "", project.path);
    const key = JSON.stringify([project.container, project.path]);
    let environment = environments.get(key);
    if (!environment) {
      const root = document.createElement("div");
      root.className = "environment-panes";
      const name = dockerItems.find(item => item.ID === project.container)?.Names || (project.container ? "Docker" : "SSH 서버");
      const tab = button(`${name} · ${project.path}`, () => guarded(async () => {
        await switchEnvironment(environment);
        environment.focused?.focus();
      }));
      tab.title = `${name} · ${project.path}`;
      const controls = document.createElement("div");
      controls.className = "environment-tab";
      controls.append(tab);
      environment = { key, project, root, tab, controls, open: false, view: "files", folder: "", treeOpen: new Set(), page: 0, focused: null, groups: [], activeGroup: null };
      const close = paneAction("closePane", `${name} 작업환경 닫기`, () => requestEnvironmentClose(environment));
      close.classList.add("environment-close");
      const settings = button("⋯", () => accounts.workspace(accountContext(environment)));
      settings.title = "기본 프로필"; settings.setAttribute("aria-label", settings.title);
      controls.append(settings, close);
      environments.set(key, environment);
      el("panes").append(root);
      el("environmentTabs").append(controls);
      el("environmentTabs").hidden = false;
      createPaneGroup(environment, "Default");
    }
    environment.project = project;
    activateEnvironment(environment);
    if ([...panes].some(pane => pane.environment === environment)) return;
    try {
      await openTerminal(launch);
    } catch (error) {
      if (launch !== "shell") await openTerminal("shell");
      throw error;
    }
  }

  function requestEnvironmentClose(environment) {
    if (busy) return;
    if (!environment.root.childElementCount) {
      void guarded(() => closeEnvironment(environment));
      return;
    }
    pendingEnvironmentClose = environment;
    el("closeEnvironmentTitle").textContent = environment.project.container ? "Docker 작업환경 닫기" : "원격 폴더 닫기";
    el("closeEnvironmentTarget").textContent = environment.tab.title;
    el("closeEnvironmentWarning").textContent = environment.project.container
      ? "이 탭의 터미널과 실행 중인 작업이 종료됩니다. Docker 컨테이너는 계속 실행됩니다."
      : "이 폴더 탭의 터미널과 실행 중인 작업이 종료됩니다. SSH 연결은 유지됩니다.";
    el("closeEnvironmentDialog").showModal();
  }
  el("closeEnvironmentDialog").addEventListener("close", () => { pendingEnvironmentClose = null; });
  el("cancelCloseEnvironment").addEventListener("click", () => el("closeEnvironmentDialog").close());
  el("confirmCloseEnvironment").addEventListener("click", () => {
    const environment = pendingEnvironmentClose;
    el("closeEnvironmentDialog").close();
    if (environment) void guarded(() => closeEnvironment(environment));
  });

  async function closeEnvironment(environment) {
    const { path, container } = environment.project;
    const result = await rpc("close-target", environment.project);
    if (result.profiles) showProfiles(result.profiles);
    for (const pane of panes) {
      if (pane.environment === environment) await pane.dispose(false);
    }
    environments.delete(environment.key);
    environment.controls.remove();
    environment.root.remove();
    el("environmentTabs").hidden = !environments.size;
    const remaining = [...environments.values()];
    const targetKey = container || "";
    if (lastPaths.get(targetKey) === path) {
      const other = remaining.findLast(item => (item.project.container || "") === targetKey);
      if (other) lastPaths.set(targetKey, other.project.path);
      else lastPaths.delete(targetKey);
    }
    if (environment !== activeEnvironment) {
      activeEnvironment?.tab.focus();
      return;
    }
    activeEnvironment = null;
    target = null;
    updateWorkspaceContext();
    if (!remaining.length) setSidebarCollapsed(false);
    el("workArea").hidden = true;
    el("container").value = "";
    el("directory").value = localDocker ? "" : lastPaths.get("") || "";
    updateContainerControls();
    updateEqualize();
    renderPaneGroups();
    refreshHiddenPanes();
    await setViewerOpen(false);
    const next = localDocker ? remaining.at(-1) : remaining.findLast(item => !item.project.container);
    if (next) {
      await switchEnvironment(next);
      if (next.focused) next.focused.focus();
      else next.tab.focus();
    } else {
      el(localDocker ? "dockerPicker" : "directory").focus();
    }
  }

  async function switchEnvironment(environment) {
    if (environment === activeEnvironment) return;
    if (movingPane) clearPaneMove();
    environment.project = await rpc("set-target", environment.project);
    activateEnvironment(environment);
  }

  async function focusAlertTarget(row) {
    const pane = [...panes].find(item => item.id === row.session_id);
    const environment = pane?.environment ?? [...environments.values()].find(item => item.project.notification_workspace === row.workspace_id);
    if (!environment) {
      status(`${row.workspace_name ?? row.title} · 해당 작업공간을 다시 열어 확인하세요.`);
      return;
    }
    await switchEnvironment(environment);
    const targetPane = pane ?? environment.focused;
    if (targetPane) {
      if (targetPane.hidden) restorePane(targetPane);
      else switchPaneGroup(environment, targetPane.group);
      targetPane.node.scrollIntoView({ block:"nearest" });
      targetPane.focus();
    }
    if (row.session_id && !pane) status(`${row.title} · 원래 터미널은 닫혔습니다.`);
  }

  function activateEnvironment(environment) {
    if (activeEnvironment && activeEnvironment !== environment) conversations.close();
    if (activeEnvironment && activeEnvironment !== environment) {
      Object.assign(activeEnvironment, { view, folder, treeOpen, page });
      activeEnvironment.root.hidden = true;
      activeEnvironment.tab.setAttribute("aria-pressed", "false");
    }
    const changing = activeEnvironment !== environment;
    activeEnvironment = environment;
    target = environment.project;
    folderPicker.refresh();
    updateWorkspaceContext();
    environment.root.hidden = false;
    environment.activeGroup.root.hidden = false;
    environment.tab.setAttribute("aria-pressed", "true");
    el("container").value = target.container || "";
    el("directory").value = target.path;
    el("directory").title = target.path;
    updateContainerControls();
    el("workArea").hidden = false;
    renderPaneGroups();
    updateEqualize();
    refreshHiddenPanes();
    if (!changing) return;
    ({ view, folder, treeOpen, page } = environment);
    updateFileTabs();
    void viewerTask(() => setViewerOpen(environment.open));
  }
  async function browse(path, page = 0) {
    const result = await rpc("browse", { path, page, container: el("container").value || null });
    browsePath = result.path;
    browsePage = page;
    el("browsePath").textContent = browsePath;
    const list = el("directoryList");
    list.replaceChildren();
    const parent = browsePath.slice(0, browsePath.lastIndexOf("/")) || "/";
    if (browsePath !== "/") list.append(button("↑ 상위 폴더", () => guarded(() => browse(parent))));
    if (page) list.append(button("이전 폴더 목록", () => guarded(() => browse(browsePath, browsePage - 1))));
    for (const name of result.folders) {
      const child = `${browsePath.replace(/\/$/, "")}/${name}`;
      list.append(button(name, () => guarded(() => browse(child))));
    }
    if (result.hasMore) list.append(button("다음 폴더 목록", () => guarded(() => browse(browsePath, browsePage + 1))));
    if (!el("directoryDialog").open) el("directoryDialog").showModal();
  }
  el("browse").addEventListener("click", () => guarded(() => {
    selectingDockerFolder = false;
    return browse(el("directory").value || ".");
  }));
  el("browseCancel").addEventListener("click", () => el("directoryDialog").close());
  el("browsePick").addEventListener("click", () => {
    el("directory").value = browsePath;
    el("directory").title = browsePath;
    el("directoryDialog").close();
    el("directory").focus();
    if (selectingDockerFolder) {
      selectingDockerFolder = false;
      guarded(openProject);
    }
  });
  el("directory").addEventListener("input", () => { el("directory").title = el("directory").value; });
  el("openCode").addEventListener("click", () => guarded(async () => {
    const container = target?.container;
    await rpc("vscode");
    if (container) {
      const name = dockerItems.find(item => item.ID === container)?.Names || container;
      alert(`VS Code에서 Dev Containers: Attach to Running Container…를 실행해 ${name} 컨테이너를 선택하세요.\n컨테이너에서 ${target.path} 폴더를 여세요.`);
    }
  }));

  function showAgentInstall(guide, launch, environment, source, direction) {
    const dialog = el("agentInstallDialog");
    el("agentInstallTitle").textContent = `${launchLabels[launch]} 설치`;
    el("agentInstallTarget").textContent = `CLI 실행 파일을 찾지 못했습니다. ${environment.tab.title}에서 설치할 수 있습니다.`;
    el("agentInstallRequirements").textContent = `필요한 환경 · 인터넷 연결, ${guide.requires}`;
    const missing = el("agentInstallMissing");
    missing.hidden = guide.missing_tools.length === 0;
    missing.textContent = `먼저 설치할 도구 · ${guide.missing_tools.join(", ")}`;
    el("agentInstallCommand").textContent = guide.command;
    el("agentInstallVerify").textContent = guide.verify;
    const feedback = el("agentInstallFeedback");
    feedback.hidden = true;
    el("agentInstallCopy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(guide.command);
        feedback.textContent = "설치 명령을 복사했습니다.";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(el("agentInstallCommand"));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        feedback.textContent = "선택된 명령을 Ctrl+C로 복사하세요.";
      }
      feedback.hidden = false;
    };
    const installNow = el("agentInstallNow");
    installNow.disabled = guide.missing_tools.length > 0;
    installNow.title = installNow.disabled ? `먼저 설치할 도구: ${guide.missing_tools.join(", ")}` : "셸을 열고 설치 명령을 바로 실행합니다";
    installNow.onclick = () => {
      dialog.close();
      if (environment === activeEnvironment) {
        guarded(() => openTerminal("shell", source, direction, { tool: launch }));
      }
    };
    const reopen = tool => {
      dialog.close();
      if (environment === activeEnvironment) guarded(() => openTerminal(tool, source, direction));
    };
    el("agentInstallShell").onclick = () => reopen("shell");
    el("agentInstallRetry").onclick = () => reopen(launch);
    dialog.showModal();
  }
  el("agentInstallDismiss").addEventListener("click", () => el("agentInstallDialog").close());

  async function promptRemoteHook(launch, environment, source) {
    if (!['claude', 'codex'].includes(launch)) return 'fallback';
    const params = { provider: launch, source_terminal_id: source?.id };
    let current;
    let initialError;
    try {
      current = await rpc('hooks-status', params);
      if (current.registered) return 'registered';
    } catch (error) { initialError = error; }
    const dialog = el('remoteHookDialog');
    const controller = new AbortController();
    const { signal } = controller;
    const name = launchLabels[launch];
    const relative = launch === 'claude' ? '.claude/settings.local.json' : '.codex/hooks.json';
    el('remoteHookTitle').textContent = `${name} 훅 등록`;
    el('remoteHookHelp').textContent = `${environment.tab.title} · ${environment.project.path}에 ${name} 훅을 등록하면 승인 대기와 작업 완료를 해당 터미널에서 직접 감지합니다. 기존 설정은 유지됩니다.`;
    el('remoteHookState').textContent = current
      ? `현재 ${current.events}/${current.total}개 등록 · ${current.os} · 훅이 없으면 터미널 출력으로 상태를 감지합니다.`
      : '훅 설정을 읽지 못했습니다. 등록을 다시 시도하거나 출력 감지로 시작할 수 있습니다.';
    el('remoteHookError').hidden = true;
    el('remoteHookRegister').disabled = false;
    el('remoteHookCopy').textContent = '프롬프트 복사';
    const fail = error => {
      const reason = String(error?.message ?? error);
      el('remoteHookErrorText').textContent = reason;
      el('remoteHookPrompt').value = `WinCMux에서 ${name} 원격 훅 등록에 실패했습니다.\n작업 공간: ${environment.tab.title}\n폴더: ${environment.project.path}\n설정 파일: ${relative}\n오류: ${reason}\n원격 OS와 설정 파일 권한을 확인하고, 기존 훅을 보존하면서 WinCMux 훅을 등록해 주세요.`;
      el('remoteHookError').hidden = false;
      el('remoteHookState').textContent = '등록 실패 · 출력 감지로 시작하거나 해결 프롬프트를 복사할 수 있습니다.';
    };
    if (initialError) fail(initialError);
    el('remoteHookCopy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(el('remoteHookPrompt').value);
        el('remoteHookCopy').textContent = '복사됨';
      } catch { el('remoteHookPrompt').select(); }
    }, { signal });
    el('remoteHookRegister').addEventListener('click', async () => {
      el('remoteHookRegister').disabled = true;
      el('remoteHookState').textContent = `${name} 훅 등록 중…`;
      try {
        const result = await rpc('hooks-ensure', params);
        const verified = await rpc('hooks-status', params);
        if (!result.registered || !verified.registered) throw Error('필요한 훅 이벤트가 모두 등록되지 않았습니다.');
        status(`${name} 훅 등록 완료 (${verified.events}/${verified.total}) · 새 세션에서 수신을 확인하세요.`);
        dialog.close('registered');
      } catch (error) { fail(error); el('remoteHookRegister').disabled = false; }
    }, { signal });
    el('remoteHookWithout').addEventListener('click', () => {
      status(`${name} 훅 없이 시작 · 터미널 출력으로 상태를 감지합니다.`);
      dialog.close('fallback');
    }, { signal });
    el('remoteHookCancel').addEventListener('click', () => dialog.close('cancel'), { signal });
    dialog.returnValue = 'cancel';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => {
        controller.abort();
        resolve(['registered', 'fallback'].includes(dialog.returnValue) ? dialog.returnValue : 'cancel');
      }, { once: true });
      dialog.showModal();
      el('remoteHookRegister').focus();
    });
  }

  const accounts = window.wincmuxAccounts;
  function accountContext(environment = activeEnvironment) {
    if (!environment) throw new Error("작업 폴더를 먼저 여세요.");
    const project = environment.project;
    if (!project.account_scope) throw new Error("작업 폴더를 다시 여세요.");
    return { scope: project.account_scope, scopeLabel: localDocker ? environment.tab.title.split(" · ")[0] : (profile?.alias || (profile?.user+"@"+profile?.host)) + (project.container ? " · "+project.container.slice(0,12) : ""), workspace: project.path, label: `${localDocker ? "Docker" : profile?.alias || (profile?.user+"@"+profile?.host)} · ${environment.tab.title}` };
  }
  function manager(initial="claude") {
    el("connectionOptions").open = false;
    const env = activeEnvironment;
    accounts.manage(accountContext(env), (tool,id,action,email) => guarded(() => {
      if (env !== activeEnvironment) throw new Error("작업환경이 변경되었습니다.");
      return openTerminal("shell",null,null,null,null,false,{[tool]:id},{tool,action,email});
    },true),initial,(tool,id)=>{
      if (env !== activeEnvironment) throw new Error("작업환경이 변경되었습니다.");
      return rpc("account-status",{tool,account_profiles:{[tool]:id}});
    });
  }
  el("accountManager").onclick = () => guarded(() => manager());
  async function openTerminal(launch, source = null, direction = null, install = null, resumeId = null, resumePicker = false, overrides = {}, auth = null) {
    if (!target) return;
    const environment = source?.environment ?? activeEnvironment;
    if (!environment || (source && !panes.has(source))) return;
    const ctx = accountContext(environment);
    const selected = auth ? overrides : accounts.selection(ctx, overrides);
    const group = source?.group ?? environment.activeGroup;
    if (source?.hidden) restorePane(source);
    const project = environment.project;
    if (!install && ['claude', 'codex'].includes(launch)) {
      const choice = await promptRemoteHook(launch, environment, source);
      if (choice === 'cancel') return;
    }
    const containerName = dockerItems.find(item => item.ID === project.container)?.Names || (project.container ? "Docker" : "SSH 서버");
    const pane = document.createElement("section");
    pane.className = "pane";
    if (launch !== "shell") pane.dataset.agent = launch;
    const label = document.createElement("header");
    const heading = document.createElement("strong");
    heading.textContent = install ? `${launchLabels[install.tool]} 설치 ${++paneNumber}` : `${launchLabels[launch]}${resumeId || resumePicker ? " resume" : ""} ${++paneNumber}`;
    const installHeading = heading.textContent;
    const installStartedAt = install ? Date.now() : 0;
    let installFinished = false;
    let installBuffer = '';
    const installTimer = install ? setInterval(() => {
      if (!installFinished) heading.textContent = `${installHeading} · ${Math.floor((Date.now() - installStartedAt) / 1000)}초 경과`;
    }, 1000) : null;
    const finishInstall = code => {
      if (installFinished || !install) return;
      installFinished = true;
      clearInterval(installTimer);
      const elapsed = Math.round((Date.now() - installStartedAt) / 1000);
      if (code === 0) {
        heading.textContent = `${installHeading} · 완료`;
        status(`${launchLabels[install.tool]} 설치와 실행 확인 완료 (${elapsed}초). + ${launchLabels[install.tool]}를 눌러 시작하세요.`);
      } else {
        heading.textContent = `${installHeading} · 실패`;
        alert(`${launchLabels[install.tool]} 설치 실패 (종료 코드 ${code}, ${elapsed}초). 터미널 출력의 오류를 확인하세요.`);
      }
    };
    heading.title = `${containerName} · ${project.path}`;
    const surface = document.createElement("div");
    surface.className = "term";
    const links = window.wincmuxTerminalLinks.create(alert);
    const term = new window.Terminal({ fontFamily: "Consolas, monospace", fontSize: 14, scrollback: 5000, allowProposedApi: true, linkHandler: links.handler, theme: { background: "#10151c" } });
    const fit = new window.FitAddon.FitAddon();
    let search = null;
    let closed = false;
    let id;
    const startupInput = [];
    let composer = launch !== "shell" && window.wincmuxRemoteComposer((action, payload) => {
      if (!id || closed) return Promise.reject(Error("에이전트 터미널이 준비되지 않았습니다."));
      return rpc(action, { id, ...payload });
    }, button, launch);
    let shellComposer = null;
    let chain = Promise.resolve();
    const send = (action, data) => {
      if (closed) return;
      if (!id) {
        if (startupInput.length < 32) startupInput.push([action, data]);
        return;
      }
      chain = chain.then(() => closed ? null : rpc(action, { id, ...data })).catch(alert);
    };
    const writeShell = text => {
      if (!id || closed) return Promise.reject(Error("셸 터미널이 준비되지 않았습니다."));
      const next = chain.then(() => {
        if (closed) throw Error("셸 터미널이 종료되었습니다.");
        return rpc("terminal-input", { id, text });
      });
      chain = next.catch(() => {});
      return next;
    };
    function ensureShellComposer() {
      if (shellComposer) return;
      shellComposer = window.wincmuxRemoteShellComposer(writeShell, button);
      pane.append(shellComposer.panel);
      fitTerminal();
    }
    function fitTerminal() {
      if (closed || surface.clientWidth < 20 || surface.clientHeight < 20) return;
      const [cols, rows] = [term.cols, term.rows];
      fit.fit();
      if (cols !== term.cols || rows !== term.rows) send("terminal-resize", { cols: term.cols, rows: term.rows });
    }
    const observer = new ResizeObserver(fitTerminal);
    const record = {
      node: pane,
      environment,
      group,
      hidden: false,
      launch,
      fit: fitTerminal,
      focus: () => term.focus(),
      async dispose(remote = true) {
        if (movingPane === record) clearPaneMove();
        if (!panes.delete(record)) return;
        if (installTimer) clearInterval(installTimer);
        const refocus = remote && pane.contains(document.activeElement);
        closed = true;
        observer.disconnect();
        search?.dispose();
        window.wincmuxTerminalRenderer.unregister(term);
        term.dispose();
        if (record.hidden) pane.remove();
        else window.wincmuxRemoteLayout.remove(pane);
        if (record.group.focused === record) record.group.focused = [...panes].findLast(item => item.group === record.group && !item.hidden) ?? null;
        if (environment.focused === record) environment.focused = record.group.focused;
        updateEqualize();
        refreshHiddenPanes();
        if (environment === activeEnvironment) renderPaneGroups();
        if (refocus) {
          if (environment.focused) environment.focused.focus();
          else el("newTerminal").focus();
        }
        if (remote && id) await rpc("terminal-close", { id });
      }
    };
    const title = document.createElement("div");
    title.className = "pane-title";
    title.append(heading);
    let profileTool = launch;
    const accountBtn = accounts.button("", () => accounts.choose(ctx, profileTool, selected[profileTool], (tool, id, replace) => guarded(async () => {
      const check = await rpc("account-status",{tool,account_profiles:{...selected,[tool]:id},source_terminal_id:record.id});
      if (!check.authenticated) throw new Error("도구 프로필 관리에서 먼저 로그인하세요.");
      const next = await openTerminal(tool,record,"right",null,null,false,{...selected,[tool]:id});
      if (next && replace) await record.dispose();
    }), true,accountBtn,manager));
    accountBtn.className = "account-trigger";
    function showAccount(tool) {
      profileTool = tool;
      accountBtn.hidden = !["claude","codex"].includes(tool);
      if (!accountBtn.hidden) accountBtn.textContent = accountBtn.title = `${launchLabels[tool]} · ${accounts.alias(ctx,tool,selected[tool])} ▾`;
    }
    term.parser.registerOscHandler(776, value => {
      if (["claude","codex","shell"].includes(value) && record.launch === "shell") showAccount(value);
      return true;
    });
    showAccount(launch);
    title.append(accountBtn);
    if (composer) title.append(composer.state);
    const actions = document.createElement("div");
    actions.className = "remote-pane-actions";
    const sizeDown = paneAction("fontDown", "글자 크기 줄이기", () => resizeFont(-1), "Ctrl+-");
    const sizeUp = paneAction("fontUp", "글자 크기 늘리기", () => resizeFont(1), "Ctrl+=");
    function resizeFont(delta) {
      term.options.fontSize = Math.max(6, Math.min(20, term.options.fontSize + delta));
      sizeDown.disabled = term.options.fontSize === 6;
      sizeUp.disabled = term.options.fontSize === 20;
      fitTerminal();
    }
    const showPaneFiles = paneAction("files", "파일 보기", () => {
      environment.focused = record;
      void viewerTask(() => setViewerOpen(true));
    });
    const splitRight = paneAction("splitRight", "오른쪽 분할", () => chooseSplit(record, "right"), "Ctrl+Alt+\\");
    const splitDown = paneAction("splitDown", "아래 분할", () => chooseSplit(record, "down"), "Ctrl+Alt+-");
    const movePane = paneAction("movePane", "터미널 배치 변경 (Shift+클릭: 목록)", event => event.shiftKey ? openMoveDialog(record) : startPaneMove(record), "Ctrl+Alt+P");
    record.moveButton = movePane;
    const find = paneAction("search", "터미널 출력 검색", () => search?.open(), "Ctrl+F");
    const hide = paneAction("hidePane", "터미널 숨기기 (실행 유지)", () => hidePane(record), "Ctrl+Alt+H");
    const close = paneAction("closePane", "pane 닫기", () => record.dispose().catch(alert), "Ctrl+Alt+Q");
    close.classList.add("pane-close");
    splitRight.disabled = splitDown.disabled = true;
    actions.append(sizeDown, sizeUp, splitRight, splitDown, movePane, find, hide, showPaneFiles, close);
    label.append(title, actions);
    pane.append(label, surface);
    if (composer) pane.append(composer.panel);
    else ensureShellComposer();
    pane.addEventListener("pointermove", event => {
      if (movingPane && movingPane !== record && movingPane.group === record.group) showPaneDrop(record, paneDropDirection(pane, event.clientX, event.clientY));
    }, true);
    pane.addEventListener("pointerleave", () => { if (movingPane !== record) showPaneDrop(record, ""); });
    pane.addEventListener("pointerdown", event => {
      if (!movingPane || event.button !== 0 || event.target.closest("button")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (movingPane === record) { clearPaneMove(); status("터미널 이동을 취소했습니다."); return; }
      if (movingPane.group === record.group) movePaneToPlacement(movingPane, record, paneDropDirection(pane, event.clientX, event.clientY));
    }, true);
    pane.addEventListener("focusin", () => { environment.focused = record.group.focused = record; });
    pane.addEventListener("keydown", event => {
      if (event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph") || !["KeyQ", "KeyP", "KeyH"].includes(event.code) || !event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        if (event.code === "KeyP") startPaneMove(record);
        else if (event.code === "KeyH") hidePane(record);
        else void record.dispose().catch(alert);
      }
    }, true);
    window.wincmuxRemoteLayout.mount(group.root, pane, source?.node, direction);
    panes.add(record);
    renderPaneGroups();
    updateEqualize();
    term.loadAddon(fit);
    links.attach(term);
    term.open(surface);
    search = window.wincmuxTerminalSearch(term, surface);
    window.wincmuxTerminalRenderer.register(term, alert);
    fitTerminal();
    const stream = new Channel();
    stream.onmessage = message => {
      if (!panes.has(record)) return;
      if (message.data) {
        const raw = atob(message.data);
        term.write(Uint8Array.from(raw, character => character.charCodeAt(0)));
        if (install && !installFinished) {
          installBuffer = (installBuffer + raw).slice(-256);
          const marker = `\x1b]777;wincmux-install-result;${install.tool};`;
          const start = installBuffer.lastIndexOf(marker);
          if (start >= 0) {
            const match = /^(\d+)\x07/.exec(installBuffer.slice(start + marker.length));
            if (match) finishInstall(Number(match[1]));
          }
        }
      }
      if (message.agent && composer) composer.update(message.agent);
      if (message.error) alert(message.error);
      if (message.shell_ready && composer) {
        const refocus = composer.panel.contains(document.activeElement);
        composer.handoff();
        composer = null;
        record.launch = "shell";
        showAccount("shell");
        pane.removeAttribute("data-agent");
        heading.textContent += " · 셸";
        if (message.abandoned) status(`에이전트가 종료되어 대기 입력 ${message.abandoned}개를 취소했습니다.`);
        ensureShellComposer();
        if (refocus) shellComposer.input.focus();
        fitTerminal();
      }
      if (message.closed) {
        closed = true;
        if (install && !installFinished) finishInstall(message.exit ?? '연결 종료');
        if (composer) composer.close();
        else heading.textContent += " · 종료됨";
        shellComposer?.close();
      }
    };
    term.onData(text => send("terminal-input", { text }));
    term.attachCustomKeyEventHandler(event => {
      if (!window.wincmuxRemoteTerminalClipboard(event, term, text => invoke("desktop_action", { action:"clipboard-write", params:{ text } }), alert)) return false;
      if (event.isComposing || event.keyCode === 229) return true;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === "f") {
        if (event.type === "keydown") search.open();
        event.preventDefault();
        return false;
      }
      const direction = { Backslash:"right", Minus:"down", NumpadSubtract:"down" }[event.code];
      const delta = { Equal:1, NumpadAdd:1, Minus:-1, NumpadSubtract:-1 }[event.code];
      if (delta && event.ctrlKey && !event.altKey) {
        if (event.type === "keydown") resizeFont(delta);
        event.preventDefault();
        return false;
      }
      if (!direction || !event.ctrlKey || !event.altKey || event.shiftKey) return true;
      if (event.type === "keydown" && !event.repeat) chooseSplit(record, direction);
      event.preventDefault();
      return false;
    });
    observer.observe(surface);
    try {
      id = await invoke("ssh_pty", { params: { launch, account_profiles:selected, watch_profiles:true, profile_email:auth?.email || null, profile_login:auth ? `${auth.tool}-${auth.action}` : null, cols: term.cols, rows: term.rows, source_terminal_id: source?.id, resume_id: resumeId, resume_picker: resumePicker, install_tool: install?.tool }, stream });
      record.id = id;
      if (panes.has(record)) splitRight.disabled = splitDown.disabled = false;
      if (panes.has(record) && !closed) {
        for (const [action, data] of startupInput.splice(0)) send(action, data);
        send("terminal-resize", { cols: term.cols, rows: term.rows });
        if (install && !installFinished) status(`${launchLabels[install.tool]} 설치 중 · 터미널에 진행 상황과 경과 시간이 표시됩니다.`);
        term.focus();
      } else if (!panes.has(record)) {
        await rpc("terminal-close", { id });
      }
      return closed ? null : record;
    } catch (error) {
      await record.dispose(false);
      if (error?.code === "agent_missing" && activeEnvironment === environment) {
        showAgentInstall(error, launch, environment, source, direction);
        return;
      }
      throw error;
    }
  }
  const conversations = window.wincmuxRemoteConversations({
    context: () => activeEnvironment && ({
      identity: JSON.stringify([localDocker ? "docker" : profile?.alias || profile?.host, activeEnvironment.project.container, activeEnvironment.project.path]),
      title: activeEnvironment.tab.title
    }),
    list: include_children => rpc("conversation-list", { include_children, account_profiles:accounts.selection(accountContext()) }),
    resume: (provider, id) => {
      const source = activeEnvironment?.focused && !activeEnvironment.focused.hidden ? activeEnvironment.focused : null;
      return openTerminal(provider, source, source ? "right" : null, null, id, !id);
    }
  });
  el("remoteConversationBtn").addEventListener("click", () => conversations.open());
  for (const [id, launch] of Object.entries(launchButtons)) {
    el(id).addEventListener("click", () => guarded(() => openTerminal(launch)));
    if (["claude","codex"].includes(launch)) {
      const select = accounts.button("▾", () => guarded(() => {
        const ctx = accountContext();
        accounts.choose(ctx, launch, accounts.defaults(ctx)[launch], (tool,id) => guarded(() => openTerminal(tool,null,null,null,null,false,{[tool]:id})),false,select,manager);
      }));
      select.className="account-trigger"; select.title=launchLabels[launch]+" 프로필 선택"; select.setAttribute("aria-label",select.title);
      const pair = document.createElement("span"); pair.className="account-launch-pair"; el(id).before(pair); pair.append(el(id),select);
    }
  }

  function chooseSplit(source, direction) {
    if (!source.id || busy || el("splitLauncher").open) return;
    pendingSplit = { source, direction };
    el("splitProject").textContent = source.environment.tab.textContent;
    el("splitLauncherTitle").textContent = direction === "right" ? "오른쪽 pane에서 실행" : "아래 pane에서 실행";
    el("splitLauncher").showModal();
  }
  el("splitCancel").addEventListener("click", () => el("splitLauncher").close());
  el("splitLauncher").addEventListener("close", () => { pendingSplit = null; });
  for (const choice of el("splitLauncher").querySelectorAll("[data-split-launch]")) {
    choice.addEventListener("click", () => {
      const split = pendingSplit;
      el("splitLauncher").close();
      if (split) guarded(() => openTerminal(choice.dataset.splitLaunch, split.source, split.direction));
    });
  }
  function refitEnvironment(environment) {
    requestAnimationFrame(() => {
      for (const pane of panes) if (pane.environment === environment) pane.fit();
    });
  }
  function clearPaneMove() {
    movingPane = null;
    for (const pane of panes) pane.node.classList.remove("pane-move-source", "pane-move-target", "pane-drop-left", "pane-drop-right", "pane-drop-up", "pane-drop-down");
    renderPaneGroups();
  }
  function startPaneMove(source) {
    if (movingPane === source) { clearPaneMove(); status("터미널 이동을 취소했습니다."); return; }
    if (!panes.has(source) || source.hidden) return;
    const targets = [...panes].some(pane => pane !== source && pane.group === source.group && !pane.hidden);
    if (!targets && source.environment.groups.length < 2) return status("이동할 다른 터미널이나 그룹이 없습니다.");
    clearPaneMove();
    movingPane = source;
    source.node.classList.add("pane-move-source");
    for (const pane of panes) if (pane !== source && pane.group === source.group && !pane.hidden) pane.node.classList.add("pane-move-target");
    renderPaneGroups();
    status("터미널 이동: 대상 가장자리를 클릭하거나 왼쪽 그룹을 선택하세요. Esc로 취소할 수 있습니다.");
  }
  function paneDropDirection(node, x, y) {
    const rect = node.getBoundingClientRect();
    const edges = [["up", (y - rect.top) / Math.max(1, rect.height)], ["down", (rect.bottom - y) / Math.max(1, rect.height)],
      ["left", (x - rect.left) / Math.max(1, rect.width)], ["right", (rect.right - x) / Math.max(1, rect.width)]];
    return edges.sort((a, b) => a[1] - b[1])[0][0];
  }
  function showPaneDrop(pane, direction) {
    for (const key of ["left", "right", "up", "down"]) pane.node.classList.toggle(`pane-drop-${key}`, key === direction);
  }
  function movePaneToPlacement(source, destination, direction) {
    if (!panes.has(source) || !panes.has(destination) || source.group !== destination.group || source === destination) return;
    if (!window.wincmuxRemoteLayout.move(source.group.root, source.node, destination.node, direction)) return;
    clearPaneMove();
    refitEnvironment(source.environment);
    source.focus();
    status(`터미널을 ${destination.node.querySelector(".pane-title strong")?.textContent ?? "대상"} ${direction}에 배치했습니다.`);
  }
  function movePaneToGroup(source, group) {
    if (!panes.has(source) || source.hidden || source.group === group || !source.environment.groups.includes(group)) return;
    const previous = source.group;
    window.wincmuxRemoteLayout.remove(source.node);
    if (previous.focused === source) previous.focused = [...panes].findLast(pane => pane.group === previous && !pane.hidden && pane !== source) ?? null;
    source.group = group;
    const anchor = [...panes].findLast(pane => pane.group === group && pane !== source && !pane.hidden)?.node;
    window.wincmuxRemoteLayout.mount(group.root, source.node, anchor, "right");
    clearPaneMove();
    switchPaneGroup(source.environment, group);
    source.environment.focused = group.focused = source;
    updateEqualize();
    source.fit();
    source.focus();
    status(`${group.name}으로 터미널을 이동했습니다.`);
  }
  document.addEventListener("keydown", event => { if (event.key === "Escape" && movingPane) { event.preventDefault(); clearPaneMove(); status("터미널 이동을 취소했습니다."); } });
  function openMoveDialog(source) {
    if (!panes.has(source) || source.hidden) return;
    const targets = [...panes].filter(pane => pane.group === source.group && !pane.hidden && pane !== source);
    const otherGroups = source.environment.groups.filter(group => group !== source.group);
    if (!targets.length && !otherGroups.length) return;
    const dialog = el("moveRemotePaneDialog");
    if (dialog.open) return;
    el("moveRemotePaneSource").textContent = `이동할 터미널: ${source.node.querySelector(".pane-title strong")?.textContent ?? "터미널"}`;
    const list = el("moveRemotePaneTargets");
    list.replaceChildren();
    for (const targetPane of targets) {
      const row = document.createElement("div");
      row.className = "move-target-row";
      const name = document.createElement("strong");
      name.textContent = `기준: ${targetPane.node.querySelector(".pane-title strong")?.textContent ?? "터미널"}`;
      const actions = document.createElement("div");
      actions.className = "move-target-actions";
      for (const [direction, label] of [["left", "왼쪽"], ["right", "오른쪽"], ["up", "위"], ["down", "아래"]]) {
        actions.append(button(label, () => {
          if (!panes.has(source) || !panes.has(targetPane)) return;
          dialog.close();
          movePaneToPlacement(source, targetPane, direction);
        }));
      }
      row.append(name, actions);
      list.append(row);
    }
    for (const group of otherGroups) {
      const row = document.createElement("div");
      row.className = "move-target-row";
      const name = document.createElement("strong");
      name.textContent = `그룹: ${group.name}`;
      row.append(name, button("이 그룹으로 이동", () => {
        dialog.close();
        movePaneToGroup(source, group);
      }));
      list.append(row);
    }
    dialog.showModal();
  }
  el("cancelMoveRemotePane").addEventListener("click", () => el("moveRemotePaneDialog").close());
  function updateEqualize() {
    el("equalizeRemotePanes").hidden = !activeEnvironment?.activeGroup?.root.querySelector(".pane-split");
    for (const pane of panes) {
      pane.moveButton.disabled = pane.hidden || (![...panes].some(other => other !== pane && other.group === pane.group && !other.hidden) && pane.environment.groups.length < 2);
    }
  }
  el("equalizeRemotePanes").addEventListener("click", () => {
    if (!activeEnvironment) return;
    window.wincmuxRemoteLayout.equalize(activeEnvironment.activeGroup.root);
    refitEnvironment(activeEnvironment);
    status("터미널 크기를 균등하게 배분했습니다.");
  });

  async function setViewerOpen(open) {
    if (activeEnvironment) activeEnvironment.open = open;
    window.wincmuxViewerPanel.setOpen(viewerPanel, open);
    if (open) return list();
    request += 1;
    clearPreview();
    el("entries").replaceChildren();
  }
  async function viewerTask(work) {
    const environment = activeEnvironment;
    try {
      await work();
    } catch (error) {
      if (environment === activeEnvironment && environment?.open) alert(error);
    }
  }
  function viewerCall(action, params) {
    return rpc(action, { ...params, source_terminal_id: activeEnvironment?.focused?.id });
  }
  window.wincmuxViewerPanel.bindViewerWidth(viewerPanel.content, viewerPanel.panel, viewerPanel.divider);
  viewerPanel.button.addEventListener("click", () => {
    if (!viewerPanel.panel.hidden) void setViewerOpen(false);
    else void viewerTask(() => setViewerOpen(true));
  });
  el("closeRemoteViewer").addEventListener("click", () => {
    void setViewerOpen(false);
    viewerPanel.button.focus();
  });

  function clearPreview() {
    previewRequest += 1;
    preview = null;
    el("preview").replaceChildren();
    el("preview").hidden = true;
    el("previewHeader").hidden = true;
    el("previewPlaceholder").hidden = false;
    el("previewPlaceholder").classList.remove("viewer-preview-loading");
    el("previewPlaceholder").textContent = "왼쪽 목록에서 파일을 선택하세요.";
    el("remoteViewer").querySelector(".viewer-detail").removeAttribute("aria-busy");
    for (const entry of el("entries").querySelectorAll("button.active")) {
      entry.classList.remove("active");
      entry.removeAttribute("aria-current");
    }
  }
  function showPreviewLoading(label) {
    const placeholder = el("previewPlaceholder");
    placeholder.textContent = label;
    placeholder.classList.add("viewer-preview-loading");
    el("remoteViewer").querySelector(".viewer-detail").setAttribute("aria-busy", "true");
  }
  function finishPreviewLoading() {
    el("previewPlaceholder").classList.remove("viewer-preview-loading");
    el("remoteViewer").querySelector(".viewer-detail").removeAttribute("aria-busy");
  }
  el("closePreview").addEventListener("click", clearPreview);
  const remoteAbsolutePath = relative => `${target.path.replace(/\/$/, "")}/${relative}`;
  el("copyRemotePath").addEventListener("click", async () => {
    if (!preview?.title || !target) return;
    try {
      await invoke("desktop_action", { action: "clipboard-write", params: { text: remoteAbsolutePath(preview.title) } });
      status("절대 경로를 복사했습니다.");
    } catch (error) { alert(error); }
  });
  el("downloadRemoteFile").addEventListener("click", async () => {
    if (!preview?.title || !target) return;
    const relative = preview.title;
    const download = el("downloadRemoteFile");
    download.disabled = true;
    status("파일을 다운로드하는 중…");
    try {
      const result = await viewerCall("download", { relative });
      if (!result.cancelled) status(`다운로드 완료: ${result.path}`);
    } catch (error) { alert(error); }
    finally { download.disabled = false; }
  });
  async function showFiles() {
    view = "files";
    folder = "";
    treeOpen.clear();
    page = 0;
    updateFileTabs();
    await list();
  }
  function updateFileTabs() {
    el("fileTab").setAttribute("aria-pressed", String(view === "files"));
    el("gitTab").setAttribute("aria-pressed", String(view === "git"));
    el("remoteListTitle").textContent = view === "git" ? "Git 목록" : "파일 목록";
  }
  function updateSearchOptionsLabel() {
    const count = Number(el("searchScope").checked) + Number(el("searchIncludeExcluded").checked)
      + Number(extensionFilter.values().length > 0) + Number(Boolean(el("searchExclude").value.trim()));
    el("searchOptionsToggle").textContent = count ? `필터 ${count}` : "필터";
    el("searchOptionsToggle").classList.toggle("is-filtered", count > 0);
  }
  function updateViewerScope() {
    const location = el("location");
    location.replaceChildren();
    el("entries").setAttribute("role", view === "files" ? "tree" : "list");
    if (view === "git") location.textContent = target.path;
    else {
      const root = button(target.path, () => { folder = ""; updateViewerScope(); });
      root.title = target.path;
      location.append(root);
      let relative = "";
      for (const segment of folder.split("/").filter(Boolean)) {
        relative = relative ? `${relative}/${segment}` : segment;
        const selected = relative;
        location.append(document.createTextNode(" / "), button(segment, () => { folder = selected; updateViewerScope(); }));
      }
    }
    const scope = view === "files" && folder;
    el("searchScope").disabled = savedMode() || !scope;
    if (savedMode() || !scope) el("searchScope").checked = false;
    el("search").title = scope ? `${target.path.replace(/\/$/, "")}/${folder}` : target.path;
    const registered = savedFolders().includes(folder);
    const saveButton = el("saveCurrentFolder");
    saveButton.disabled = view !== "files" || !folder || registered || savedFolders().length >= 20;
    saveButton.textContent = registered ? "✓ 등록됨" : "등록";
    saveButton.title = registered ? `${folder} 등록됨` : "선택한 폴더 등록";
    folderPicker.refresh();
    for (const node of el("entries").querySelectorAll(".viewer-tree-name[data-scope]")) {
      node.classList.toggle("scope-active", node.dataset.scope === folder);
      node.classList.toggle("is-saved", savedFolders().includes(node.dataset.scope));
      node.setAttribute("aria-current", node.dataset.scope === folder ? "location" : "false");
    }
    updateSearchOptionsLabel();
  }
  function treeLoading(label) {
    const loading = document.createElement("div");
    loading.className = "viewer-tree-loading";
    loading.setAttribute("role", "status");
    loading.textContent = label;
    return loading;
  }
  async function renderTreeDirectory(relative, container, depth, childPage, token) {
    const loading = treeLoading(childPage ? "다음 파일 목록 불러오는 중…" : `${relative.split("/").pop() || "파일 목록"} 읽는 중…`);
    if (childPage === 0) container.replaceChildren(loading);
    else container.append(loading);
    container.setAttribute("aria-busy", "true");
    let result;
    try { result = await viewerCall("files", { page: childPage, relative, extensions: extensionFilter.values() }); }
    finally { loading.remove(); container.removeAttribute("aria-busy"); }
    if (token !== request) return;
    if (childPage === 0) container.replaceChildren();
    if (!result.items.length && childPage === 0) {
      const empty = document.createElement("div");
      empty.className = "viewer-tree-empty";
      empty.textContent = "폴더가 비어 있습니다.";
      container.append(empty);
    }
    for (const item of result.items) {
      const row = document.createElement("div");
      row.className = "viewer-tree-row";
      row.style.setProperty("--tree-depth", Math.min(depth, 12));
      let toggle = null;
      const name = button(`${item.kind === "directory" ? "📁" : "·"} ${item.name}`, () => {
        if (item.kind === "directory") {
          folder = item.relative;
          updateViewerScope();
          if (!treeOpen.has(item.relative)) void viewerTask(toggle);
        } else loadPreview(item.relative);
      });
      name.className = "viewer-tree-name";
      name.title = item.relative;
      name.setAttribute("role", "treeitem");
      name.setAttribute("aria-level", String(depth + 1));
      if (item.kind === "directory") {
        name.dataset.scope = item.relative;
        name.classList.toggle("is-saved", savedFolders().includes(item.relative));
        name.classList.toggle("scope-active", folder === item.relative);
        name.setAttribute("aria-current", folder === item.relative ? "location" : "false");
        name.setAttribute("aria-expanded", String(treeOpen.has(item.relative)));
        const children = document.createElement("div");
        children.className = "viewer-tree-children";
        children.setAttribute("role", "group");
        children.hidden = !treeOpen.has(item.relative);
        const toggleButton = button(treeOpen.has(item.relative) ? "▾" : "▸", () => viewerTask(toggle));
        toggleButton.className = "viewer-tree-toggle";
        toggleButton.title = "폴더 펼치기/접기";
        toggleButton.setAttribute("aria-label", `${item.name} 폴더 펼치기/접기`);
        toggleButton.setAttribute("aria-expanded", String(treeOpen.has(item.relative)));
        toggle = async () => {
          if (treeOpen.has(item.relative)) {
            treeOpen.delete(item.relative);
            children.replaceChildren();
            children.hidden = true;
            if (folder === item.relative || folder.startsWith(`${item.relative}/`)) {
              folder = relative;
              updateViewerScope();
            }
          } else {
            treeOpen.add(item.relative);
            children.hidden = false;
            toggleButton.disabled = true;
            toggleButton.textContent = "…";
            toggleButton.setAttribute("aria-label", `${item.name} 폴더 읽는 중`);
            try { await renderTreeDirectory(item.relative, children, depth + 1, 0, request); }
            catch (error) { showListError(children, error); }
            finally { toggleButton.disabled = false; toggleButton.setAttribute("aria-label", `${item.name} 폴더 펼치기/접기`); }
          }
          toggleButton.textContent = treeOpen.has(item.relative) ? "▾" : "▸";
          toggleButton.setAttribute("aria-expanded", String(treeOpen.has(item.relative)));
          name.setAttribute("aria-expanded", String(treeOpen.has(item.relative)));
        };
        row.append(toggleButton, name);
        container.append(row, children);
        if (treeOpen.has(item.relative)) {
          try { await renderTreeDirectory(item.relative, children, depth + 1, 0, token); }
          catch (error) { showListError(children, error); }
        }
      } else {
        const spacer = document.createElement("span");
        spacer.className = "viewer-tree-spacer";
        name.dataset.relative = item.relative;
        name.disabled = item.kind !== "file";
        row.append(spacer, name);
        container.append(row);
      }
    }
    if (relative === "") {
      el("pageNumber").textContent = String(page + 1);
      el("paging").hidden = !page && !result.hasMore;
      el("prevPage").disabled = !page;
      el("nextPage").disabled = !result.hasMore;
    } else if (result.hasMore) {
      const more = button("다음 파일 목록", () => viewerTask(async () => { more.remove(); await renderTreeDirectory(relative, container, depth, childPage + 1, request); }));
      more.className = "viewer-tree-more";
      more.style.setProperty("--tree-depth", Math.min(depth, 12));
      container.append(more);
    }
  }
  function showListError(container, error) {
    const box = document.createElement("div");
    box.className = "viewer-tree-error";
    box.setAttribute("role", "alert");
    const message = document.createElement("p");
    message.textContent = `파일 목록을 읽을 수 없습니다: ${String(error?.message ?? error)}`;
    const retry = button("파일 목록 다시 불러오기", () => viewerTask(list));
    box.append(message, retry);
    container.replaceChildren(box);
  }
  async function list() {
    if (!target || viewerPanel.panel.hidden) return;
    const token = ++request;
    clearPreview();
    el("paging").hidden = true;
    el("entries").replaceChildren();
    updateViewerScope();
    if (view === "files") {
      if (!savedMode()) {
        try { await renderTreeDirectory("", el("entries"), 0, page, token); }
        catch (error) { if (token === request) showListError(el("entries"), error); }
        return;
      }
      const paths = folderPicker.activePaths();
      if (!paths.length) { el("entries").textContent = "등록한 폴더가 없습니다. 전체 폴더에서 폴더를 선택해 등록하세요."; return; }
      for (const path of paths) {
        if (token !== request) return;
        const group = document.createElement("div");
        group.className = "viewer-tree-saved-group";
        const heading = document.createElement("div");
        heading.className = "viewer-tree-saved-heading";
        const children = document.createElement("div");
        children.setAttribute("role", "group");
        children.hidden = collapsedSaved().has(path);
        let loaded = false;
        let loading = false;
        const loadChildren = async () => {
          if (loaded || loading || token !== request) return;
          loading = true;
          toggle.disabled = true;
          toggle.textContent = `… 📁 ${path}`;
          try {
            await renderTreeDirectory(path, children, 0, 0, token);
            loaded = true;
          } catch (error) {
            if (token === request) showListError(children, error);
          } finally {
            loading = false;
            toggle.disabled = false;
            toggle.textContent = `${children.hidden ? "▸" : "▾"} 📁 ${path}`;
          }
        };
        const toggle = button("", () => {
          children.hidden = !children.hidden;
          if (children.hidden) collapsedSaved().add(path); else collapsedSaved().delete(path);
          toggle.setAttribute("aria-expanded", String(!children.hidden));
          toggle.textContent = `${children.hidden ? "▸" : "▾"} 📁 ${path}`;
          if (!children.hidden) void viewerTask(loadChildren);
        });
        toggle.className = "viewer-saved-toggle";
        toggle.textContent = `${children.hidden ? "▸" : "▾"} 📁 ${path}`;
        toggle.title = path;
        toggle.setAttribute("aria-expanded", String(!children.hidden));
        const remove = button("해제", () => {
          saveFolders(savedFolders().filter(value => value !== path));
          collapsedSaved().delete(path);
          folderPicker.refresh();
          showSavedFolderFeedback(`${path} 등록을 해제했습니다.`);
          void viewerTask(list);
        });
        remove.className = "viewer-saved-remove";
        remove.title = `${path} 등록 해제`;
        remove.setAttribute("aria-label", remove.title);
        heading.append(toggle, remove);
        group.append(heading, children);
        el("entries").append(group);
        if (!children.hidden) await loadChildren();
      }
      return;
    }
    const result = await viewerCall("git-status", { page, relative: folder });
    if (token !== request) return;
    if (!result.items.length) el("entries").append(document.createTextNode("변경된 파일이 없습니다."));
    for (const item of result.items) {
      const relative = item.relative;
        const untracked = item.status === "??";
        if (!untracked && item.status[0] !== " ") {
          const entry = button(`스테이징 ${item.status[0]}  ${relative}`, () => loadPreview(relative, { staged: true }));
          entry.dataset.relative = relative;
          el("entries").append(entry);
        }
        if (untracked || item.status[1] !== " ") {
          const entry = button(`작업 트리 ${item.status[1]}  ${relative}`, () => loadPreview(relative, { untracked }));
          entry.dataset.relative = relative;
          el("entries").append(entry);
        }
    }
    el("pageNumber").textContent = String(page + 1);
    el("paging").hidden = !page && !result.hasMore;
    el("prevPage").disabled = !page;
    el("nextPage").disabled = !result.hasMore;
  }
  el("fileTab").addEventListener("click", () => viewerTask(showFiles));
  el("gitTab").addEventListener("click", () => viewerTask(async () => {
    view = "git"; folder = ""; page = 0;
    updateFileTabs();
    await list();
  }));
  el("refreshViewer").addEventListener("click", () => viewerTask(list));
  el("saveCurrentFolder").addEventListener("click", () => {
    const paths = savedFolders();
    if (!folder || paths.includes(folder) || paths.length >= 20) return;
    saveFolders([...paths, folder]);
    folderPicker.refresh();
    updateViewerScope();
    showSavedFolderFeedback(`✓ ${folder} 등록 완료 · 등록 폴더 ${paths.length + 1}개`);
    status(`${folder} 폴더를 등록했습니다.`);
  });
  el("searchScope").addEventListener("change", () => { updateViewerScope(); updateSearchOptionsLabel(); });
  el("searchIncludeExcluded").addEventListener("change", updateSearchOptionsLabel);
  el("searchOptionsToggle").addEventListener("click", () => {
    const panel = el("searchOptionsPanel");
    panel.hidden = !panel.hidden;
    el("searchOptionsToggle").setAttribute("aria-expanded", String(!panel.hidden));
  });
  document.addEventListener("click", event => {
    if (el("searchOptionsPanel").hidden || el("searchForm").contains(event.target) || event.target.closest?.(".viewer-extension-dialog")) return;
    el("searchOptionsPanel").hidden = true;
    el("searchOptionsToggle").setAttribute("aria-expanded", "false");
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || el("searchOptionsPanel").hidden) return;
    el("searchOptionsPanel").hidden = true;
    el("searchOptionsToggle").setAttribute("aria-expanded", "false");
  });
  updateSearchOptionsLabel();
  el("prevPage").addEventListener("click", () => viewerTask(async () => { page -= 1; await list(); }));
  el("nextPage").addEventListener("click", () => viewerTask(async () => { page += 1; await list(); }));
  el("searchForm").addEventListener("submit", event => {
    event.preventDefault();
    viewerTask(async () => {
      const pattern = el("search").value.trim();
      const contentQuery = el("searchContent").value.trim();
      if ((!pattern && !contentQuery) || !target) return;
      clearPreview();
      const token = previewRequest;
      const roots = view === "files" && savedMode() ? folderPicker.activePaths() : [view === "files" && el("searchScope").checked ? folder : ""];
      const nameMode = !contentQuery;
      const items = [];
      let truncated = false;
      for (const scope of roots) {
        const result = await viewerCall(nameMode ? "search-names" : "search", { query: nameMode ? pattern : contentQuery, pattern, relative: scope, exclude: el("searchExclude").value, includeExcluded: el("searchIncludeExcluded").checked, extensions: extensionFilter.values() });
        if (token !== previewRequest) return;
        items.push(...result.items);
        truncated ||= result.truncated;
        if (items.length >= 150) { truncated = true; break; }
      }
      if (token !== previewRequest) return;
      el("previewHeader").hidden = false;
      el("preview").hidden = false;
      el("previewPlaceholder").hidden = true;
      el("previewTitle").textContent = `파일 ${nameMode ? "이름" : pattern ? "이름·내용" : "내용"} 검색 · ${view === "files" && savedMode() ? `선택 폴더 ${roots.length}개` : roots[0] || "작업공간 전체"}${truncated ? " · 일부 표시" : ""}`;
      el("markdownToggle").hidden = true;
      el("copyRemotePath").hidden = true;
      el("downloadRemoteFile").hidden = true;
      el("language").textContent = "";
      if (!items.length) el("preview").textContent = "일치하는 파일이 없습니다.";
      for (const hit of items.slice(0, 150)) {
        const row = button("", () => loadPreview(hit.relative, undefined, hit.line));
        row.className = "viewer-search-hit";
        row.title = nameMode ? hit.relative : `${hit.relative}:${hit.line} · ${hit.text}`;
        const path = document.createElement("strong");
        path.textContent = hit.relative;
        path.title = hit.relative;
        row.append(path);
        if (!nameMode) {
          const line = document.createElement("span");
          line.className = "viewer-search-line";
          line.textContent = `${hit.line}행`;
          const snippet = document.createElement("span");
          snippet.className = "viewer-search-snippet";
          snippet.title = hit.text;
          const match = hit.text.toLowerCase().indexOf(contentQuery.toLowerCase());
          if (match < 0) snippet.textContent = hit.text;
          else {
            const mark = document.createElement("mark");
            mark.textContent = hit.text.slice(match, match + contentQuery.length);
            snippet.append(document.createTextNode(hit.text.slice(0, match)), mark, document.createTextNode(hit.text.slice(match + contentQuery.length)));
          }
          row.append(line, snippet);
        }
        el("preview").append(row);
      }
    });
  });
  el("searchExclude").addEventListener("input", () => {
    const count = el("searchExclude").value.split(/[,\n]/).filter(value => value.trim()).length;
    el("searchFilterSummary").textContent = count ? `제외 필터 (${count})` : "제외 필터";
    updateSearchOptionsLabel();
  });

  function loadPreview(relative, diff, line) {
    return viewerTask(async () => {
      clearPreview();
      const token = previewRequest;
      showPreviewLoading(`${relative} 미리보기 불러오는 중…`);
      for (const entry of el("entries").querySelectorAll("button[data-relative]")) {
        const selected = entry.dataset.relative === relative;
        entry.classList.toggle("active", selected);
        if (selected) entry.setAttribute("aria-current", "true");
        else entry.removeAttribute("aria-current");
      }
      const result = await viewerCall(diff ? "git-diff" : "preview", { relative, ...diff, maxPreviewBytes: maxPreviewBytes() })
        .catch(error => ({ kind: "error", error: String(error?.message ?? error) }));
      if (token !== previewRequest) return;
      finishPreviewLoading();
      preview = { ...result, title: relative, language: diff ? "diff" : undefined, markdown: !diff && /\.mdx?$/i.test(relative), source: Boolean(line), line };
      await paintPreview();
    });
  }
  async function paintPreview() {
    const token = ++previewRequest;
    const { title, text, binary, truncated, markdown, source, language, line: selectedLine } = preview;
    el("previewHeader").hidden = false;
    el("preview").hidden = false;
    el("previewPlaceholder").hidden = true;
    el("previewTitle").textContent = truncated ? `${title} · 일부 표시` : title;
    el("copyRemotePath").hidden = false;
    el("downloadRemoteFile").hidden = false;
    el("language").textContent = "";
    el("markdownToggle").hidden = !markdown;
    el("markdownToggle").textContent = source ? "Markdown 보기" : "소스 보기";
    const area = el("preview");
    area.replaceChildren();
    if (preview.kind === "error") {
      const explanation = document.createElement("p");
      explanation.textContent = `미리보기를 열 수 없습니다: ${preview.error}`;
      area.append(explanation);
      if (language !== "diff") {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "viewer-preview-retry";
        retry.textContent = "미리보기 다시 시도";
        retry.addEventListener("click", () => loadPreview(title));
        area.append(retry);
      }
      return;
    }
    if (preview.kind === "image") { window.wincmuxViewerMedia.image(area, preview.dataUrl, title); return; }
    if (preview.kind === "pdf") { window.wincmuxViewerMedia.pdf(area, preview.dataUrl); return; }
    if (preview.kind === "html" && !binary) {
      if (truncated) area.textContent = `미리보기 크기 제한(${previewLimit.value}MB)을 넘었습니다. 위에서 한도를 높이거나 다운로드하세요.`;
      else window.wincmuxViewerMedia.html(area, text);
      return;
    }
    if (preview.kind === "large") { area.textContent = `미리보기 크기 제한(${previewLimit.value}MB)을 넘었습니다. 위에서 한도를 높이거나 다운로드하세요.`; return; }
    if (binary) {
      area.textContent = "바이너리 파일입니다.";
      return;
    }
    if (markdown && !source) {
      window.wincmuxViewerMarkdown.render(area, text);
      return;
    }
    const pre = document.createElement("pre");
    pre.textContent = text;
    area.append(pre);
    if (language === null) return;
    const painted = await window.wincmuxViewerHighlighter.highlight(text, title, language).catch(() => null);
    if (token !== previewRequest || (!painted?.lines && !selectedLine)) return;
    el("language").textContent = painted?.language || "";
    const fragment = document.createDocumentFragment();
    for (const [index, value] of text.split(/\r?\n/).entries()) {
      const line = document.createElement("code");
      window.wincmuxViewerHighlighter.paint(line, value, painted?.lines?.[index]);
      if (index + 1 === selectedLine) line.classList.add("selected-line");
      fragment.append(line);
    }
    pre.replaceChildren(fragment);
    pre.querySelector(".selected-line")?.scrollIntoView({ block: "center" });
  }
  el("markdownToggle").addEventListener("click", () => {
    if (preview) { preview.source = !preview.source; paintPreview().catch(alert); }
  });

  if (localDocker) {
    connected = true;
    el("connectionOptions").hidden = false;
    document.body.dataset.docker = "";
    document.title = "WinCMux 로컬 Docker";
    el("workspaceTitle").textContent = "로컬 Docker";
    el("container").setAttribute("aria-label", "컨테이너");
    el("directory").setAttribute("aria-label", "컨테이너 폴더");
    el("directory").placeholder = "컨테이너 폴더 경로";
    el("setup").hidden = true;
    el("saveProfile").hidden = true;
    el("dockerAttach").title = "컨테이너 검색";
    el("dockerAttach").setAttribute("aria-label", "컨테이너 검색");
    el("dockerAttach").hidden = true;
    el("workspace").hidden = false;
    el("dockerPicker").hidden = false;
    el("workspaceSidebarToggle").hidden = false;
    el("container").replaceChildren(option("목록 불러오는 중", ""));
    updateContainerControls();
    status("로컬 Docker 확인 중…");
    guarded(refreshContainers);
  } else {
    rpc("profiles").then(result => {
      showProfiles(result.profiles);
      if (!aliasRequest) showAliases(result.aliases);
      selectMode(Boolean(result.aliases.length));
    }).catch(error => connectionFeedback(String(error), "error"));
    selectMode(true);
  }
})();
