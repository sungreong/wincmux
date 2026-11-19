"use strict";
(() => {
  const { invoke, Channel } = window.__TAURI__.core;
  const el = id => document.getElementById(id);
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
  let preview;
  let paneNumber = 0;
  let dockerItems = [];
  let selectingDockerFolder = false;
  let activeEnvironment;
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

  async function guarded(work) {
    if (busy) return;
    busy = true;
    const disabled = ["connect", "testConnect", "editSshConfig", "refreshAliases", "registerAlias", "registerSubmit", "authSubmit", "skipPassphrase", "authCancel", "disconnect", "newTerminal", "newClaude", "newCodex"].map(el);
    disabled.forEach(node => { node.disabled = true; });
    el("forget").disabled = true;
    try {
      alert(null);
      await work();
    } catch (error) {
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
      el("workspace").hidden = false;
      profile.alias = result.alias || profile.alias;
      profile.name = result.name;
      if (result.profiles) {
        showProfiles(result.profiles, profile.name);
        if (selectedProfile) fill(selectedProfile);
      }
      el("openCode").hidden = !profile.alias;
      el("forgetPassword").hidden = !result.password_cached;
      el("connectionOptions").hidden = !result.password_cached;
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
    setViewerOpen(false);
    el("workspace").hidden = true;
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
      select.replaceChildren(option(placeholder, ""), ...items.map(item => option(item.Names, item.ID)));
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
    for (const id of ["directory", "browse", "openTarget"]) el(id).disabled = !hasContainer;
  }
  el("container").addEventListener("change", () => {
    el("directory").value = lastPaths.get(el("container").value) || "";
    updateContainerControls();
  });
  function showDockerChoices() {
    const query = el("dockerFilter").value.trim().toLowerCase();
    const matches = dockerItems.filter(item => `${item.Names} ${item.Image}`.toLowerCase().includes(query));
    const list = el("dockerList");
    list.replaceChildren(...matches.map(item => button(`${item.Names} · ${item.Image}`, () => guarded(async () => {
      el("container").value = item.ID;
      el("directory").value = lastPaths.get(item.ID) || "";
      updateContainerControls();
      await browse(el("directory").value || ".");
      selectingDockerFolder = true;
      el("dockerDialog").close();
    }))));
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
  el("dockerAttach").addEventListener("click", () => guarded(async () => {
    el("dockerFilter").value = "";
    el("dockerDialog").showModal();
    await loadDockerDialog();
  }));
  el("dockerRefresh").addEventListener("click", () => guarded(loadDockerDialog));
  el("dockerCancel").addEventListener("click", () => el("dockerDialog").close());
  el("dockerFilter").addEventListener("input", showDockerChoices);
  el("targetForm").addEventListener("submit", event => {
    event.preventDefault();
    guarded(openProject);
  });
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
      environment = { key, project, root, tab, controls, open: false, view: "files", folder: "", page: 0, focused: null };
      if (project.container) {
        const close = paneAction("closePane", `${name} 작업환경 닫기`, () => requestEnvironmentClose(environment));
        close.classList.add("environment-close");
        controls.append(close);
      }
      environments.set(key, environment);
      el("panes").append(root);
      el("environmentTabs").append(controls);
      el("environmentTabs").hidden = false;
    }
    environment.project = project;
    activateEnvironment(environment);
    if (environment.root.childElementCount > 0) return;
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
    el("closeEnvironmentTarget").textContent = environment.tab.title;
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
    if (lastPaths.get(container) === path) {
      const other = remaining.findLast(item => item.project.container === container);
      if (other) lastPaths.set(container, other.project.path);
      else lastPaths.delete(container);
    }
    if (environment !== activeEnvironment) {
      activeEnvironment?.tab.focus();
      return;
    }
    activeEnvironment = null;
    target = null;
    el("workArea").hidden = true;
    el("container").value = "";
    el("directory").value = localDocker ? "" : lastPaths.get("") || "";
    updateContainerControls();
    updateEqualize();
    await setViewerOpen(false);
    const next = localDocker ? remaining.at(-1) : remaining.findLast(item => !item.project.container);
    if (next) {
      await switchEnvironment(next);
      if (next.focused) next.focused.focus();
      else next.tab.focus();
    } else if (!localDocker) {
      await openProject();
    } else {
      el("container").focus();
    }
  }

  async function switchEnvironment(environment) {
    if (environment === activeEnvironment) return;
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
      targetPane.node.scrollIntoView({ block:"nearest" });
      targetPane.focus();
    }
    if (row.session_id && !pane) status(`${row.title} · 원래 터미널은 닫혔습니다.`);
  }

  function activateEnvironment(environment) {
    if (activeEnvironment && activeEnvironment !== environment) {
      Object.assign(activeEnvironment, { view, folder, page });
      activeEnvironment.root.hidden = true;
      activeEnvironment.tab.setAttribute("aria-pressed", "false");
    }
    const changing = activeEnvironment !== environment;
    activeEnvironment = environment;
    target = environment.project;
    environment.root.hidden = false;
    environment.tab.setAttribute("aria-pressed", "true");
    el("container").value = target.container || "";
    el("directory").value = target.path;
    updateContainerControls();
    el("workArea").hidden = false;
    updateEqualize();
    if (!changing) return;
    ({ view, folder, page } = environment);
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
    el("directoryDialog").close();
    el("directory").focus();
    if (selectingDockerFolder) {
      selectingDockerFolder = false;
      guarded(openProject);
    }
  });
  el("openCode").addEventListener("click", () => guarded(async () => {
    const container = target?.container;
    await rpc("vscode");
    if (container) {
      const name = dockerItems.find(item => item.ID === container)?.Names || container;
      alert(`VS Code에서 Dev Containers: Attach to Running Container…를 실행해 ${name} 컨테이너를 선택하세요.\n컨테이너에서 ${target.path} 폴더를 여세요.`);
    }
  }));

  async function openTerminal(launch, source = null, direction = null) {
    if (!target) return;
    const environment = source?.environment ?? activeEnvironment;
    if (!environment || (source && !panes.has(source))) return;
    const project = environment.project;
    const containerName = dockerItems.find(item => item.ID === project.container)?.Names || (project.container ? "Docker" : "SSH 서버");
    const pane = document.createElement("section");
    pane.className = "pane";
    if (launch !== "shell") pane.dataset.agent = launch;
    const label = document.createElement("header");
    const heading = document.createElement("strong");
    const labelText = { shell:"셸", claude:"Claude Code", codex:"Codex" }[launch];
    heading.textContent = `${labelText} ${++paneNumber}`;
    heading.title = `${containerName} · ${project.path}`;
    const surface = document.createElement("div");
    surface.className = "term";
    const term = new window.Terminal({ fontFamily: "Consolas, monospace", fontSize: 14, scrollback: 5000, theme: { background: "#10151c" } });
    const fit = new window.FitAddon.FitAddon();
    let closed = false;
    let id;
    const startupInput = [];
    const composer = launch !== "shell" && window.wincmuxRemoteComposer((action, payload) => {
      if (!id || closed) return Promise.reject(Error("에이전트 터미널이 준비되지 않았습니다."));
      return rpc(action, { id, ...payload });
    }, button);
    let chain = Promise.resolve();
    const send = (action, data) => {
      if (closed) return;
      if (!id) {
        if (startupInput.length < 32) startupInput.push([action, data]);
        return;
      }
      chain = chain.then(() => closed ? null : rpc(action, { id, ...data })).catch(alert);
    };
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
      launch,
      focus: () => term.focus(),
      async dispose(remote = true) {
        if (!panes.delete(record)) return;
        const refocus = remote && pane.contains(document.activeElement);
        closed = true;
        observer.disconnect();
        term.dispose();
        window.wincmuxRemoteLayout.remove(pane);
        if (environment.focused === record) {
          environment.focused = [...panes].reverse().find(item => item.environment === environment) ?? null;
        }
        updateEqualize();
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
    const close = paneAction("closePane", "pane 닫기", () => record.dispose().catch(alert), "Ctrl+Alt+Q");
    close.classList.add("pane-close");
    splitRight.disabled = splitDown.disabled = true;
    actions.append(sizeDown, sizeUp, splitRight, splitDown, showPaneFiles, close);
    label.append(title, actions);
    pane.append(label, surface);
    if (composer) pane.append(composer.panel);
    pane.addEventListener("focusin", () => { environment.focused = record; });
    pane.addEventListener("keydown", event => {
      if (event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph") || event.code !== "KeyQ" || !event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) void record.dispose().catch(alert);
    }, true);
    window.wincmuxRemoteLayout.mount(environment.root, pane, source?.node, direction);
    panes.add(record);
    updateEqualize();
    term.loadAddon(fit);
    term.open(surface);
    fitTerminal();
    const stream = new Channel();
    stream.onmessage = message => {
      if (!panes.has(record)) return;
      if (message.data) term.write(Uint8Array.from(atob(message.data), character => character.charCodeAt(0)));
      if (message.agent && composer) composer.update(message.agent);
      if (message.error) alert(message.error);
      if (message.closed) {
        closed = true;
        if (composer) composer.close();
        else heading.textContent += " · 종료됨";
      }
    };
    term.onData(text => send("terminal-input", { text }));
    term.attachCustomKeyEventHandler(event => {
      if (event.isComposing || event.keyCode === 229) return true;
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
      id = await invoke("ssh_pty", { params: { launch, cols: term.cols, rows: term.rows, source_terminal_id: source?.id }, stream });
      record.id = id;
      if (panes.has(record)) splitRight.disabled = splitDown.disabled = false;
      if (panes.has(record) && !closed) {
        for (const [action, data] of startupInput.splice(0)) send(action, data);
        send("terminal-resize", { cols: term.cols, rows: term.rows });
        term.focus();
      } else if (!panes.has(record)) {
        await rpc("terminal-close", { id });
      }
    } catch (error) {
      await record.dispose(false);
      throw error;
    }
  }
  for (const [id, launch] of [["newTerminal","shell"], ["newClaude","claude"], ["newCodex","codex"]]) {
    el(id).addEventListener("click", () => guarded(() => openTerminal(launch)));
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
  function updateEqualize() {
    el("equalizeRemotePanes").hidden = !activeEnvironment?.root.querySelector(".pane-split");
  }
  el("equalizeRemotePanes").addEventListener("click", () => {
    for (const split of activeEnvironment?.root.querySelectorAll(".pane-split") ?? []) {
      window.wincmuxRemoteLayout.reset(split);
    }
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
  }
  el("closePreview").addEventListener("click", clearPreview);
  async function showFiles() {
    view = "files";
    folder = "";
    page = 0;
    updateFileTabs();
    await list();
  }
  function updateFileTabs() {
    el("fileTab").setAttribute("aria-pressed", String(view === "files"));
    el("gitTab").setAttribute("aria-pressed", String(view === "git"));
  }
  async function list() {
    if (!target || viewerPanel.panel.hidden) return;
    const token = ++request;
    clearPreview();
    el("paging").hidden = true;
    el("entries").replaceChildren();
    el("location").textContent = view === "git" ? target.path : `${target.path.replace(/\/$/, "")}/${folder}`;
    const result = await viewerCall(view === "git" ? "git-status" : "files", { page, relative: folder });
    if (token !== request) return;
    if (view === "files" && folder) el("entries").append(button("↑ 상위 폴더", () => viewerTask(async () => {
      folder = folder.split("/").slice(0, -1).join("/");
      page = 0;
      await list();
    })));
    if (!result.items.length) el("entries").append(document.createTextNode(view === "git" ? "변경된 파일이 없습니다." : "폴더가 비어 있습니다."));
    for (const item of result.items) {
      const relative = item.relative;
      if (view === "git") {
        const untracked = item.status === "??";
        if (!untracked && item.status[0] !== " ") el("entries").append(button(`스테이징 ${item.status[0]}  ${relative}`, () => loadPreview(relative, { staged: true })));
        if (untracked || item.status[1] !== " ") el("entries").append(button(`작업 트리 ${item.status[1]}  ${relative}`, () => loadPreview(relative, { untracked })));
      } else if (item.kind === "directory") {
        el("entries").append(button(`▸ ${item.name}`, () => viewerTask(async () => { folder = relative; page = 0; await list(); })));
      } else {
        const entry = button(item.name, () => loadPreview(relative));
        entry.disabled = item.kind !== "file";
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
  el("prevPage").addEventListener("click", () => viewerTask(async () => { page -= 1; await list(); }));
  el("nextPage").addEventListener("click", () => viewerTask(async () => { page += 1; await list(); }));
  el("searchForm").addEventListener("submit", event => {
    event.preventDefault();
    viewerTask(async () => {
      const query = el("search").value.trim();
      if (!query || !target) return;
      clearPreview();
      const token = previewRequest;
      const result = await viewerCall("search", { query });
      if (token !== previewRequest) return;
      el("previewHeader").hidden = false;
      el("preview").hidden = false;
      el("previewTitle").textContent = result.truncated ? "파일 내용 검색 · 일부 표시" : "파일 내용 검색";
      el("markdownToggle").hidden = true;
      el("language").textContent = "";
      if (!result.items.length) el("preview").textContent = "일치하는 내용이 없습니다.";
      for (const hit of result.items) {
        el("preview").append(button(`${hit.relative}:${hit.line}  ${hit.text}`, () => loadPreview(hit.relative, undefined, hit.line)));
      }
    });
  });

  function loadPreview(relative, diff, line) {
    return viewerTask(async () => {
      clearPreview();
      const token = previewRequest;
      const result = await viewerCall(diff ? "git-diff" : "preview", { relative, ...diff });
      if (token !== previewRequest) return;
      preview = { ...result, title: relative, language: diff ? "diff" : undefined, markdown: !diff && /\.mdx?$/i.test(relative), source: Boolean(line), line };
      await paintPreview();
    });
  }
  async function paintPreview() {
    const token = ++previewRequest;
    const { title, text, binary, truncated, markdown, source, language, line: selectedLine } = preview;
    el("previewHeader").hidden = false;
    el("preview").hidden = false;
    el("previewTitle").textContent = truncated ? `${title} · 일부 표시` : title;
    el("language").textContent = "";
    el("markdownToggle").hidden = !markdown;
    el("markdownToggle").textContent = source ? "Markdown 보기" : "소스 보기";
    const area = el("preview");
    area.replaceChildren();
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
    el("workspace").hidden = false;
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
