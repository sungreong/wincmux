(() => {
  const accounts = window.wincmuxAccounts;
  const controls = new WeakMap();
  function context(id = state.selectedWorkspaceId) {
    const ws = workspaceRowById(id);
    if (!ws) throw new Error("워크스페이스를 선택하세요.");
    return {scope:"local", scopeLabel:"로컬 Windows 사용자", workspace:id, label:ws.name + " · " + ws.path};
  }
  const report = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(err => setStatus(String(err.message ?? err), true));
  async function launch(ctx, paneId, command, selected, replace) {
    if (ctx.workspace !== state.selectedWorkspaceId || !state.paneViews.has(paneId)) throw new Error("작업환경이 변경되었습니다.");
    const view = state.paneViews.get(paneId);
    if (!replace && (view.sessionId || state.paneSessions[paneId] || dormantPaneSession(paneId))) {
      const split = await splitPaneInternal(paneId,"horizontal",{autoStartIfMissing:false});
      if (!split?.second) throw new Error("새 터미널을 만들지 못했습니다.");
      paneId = split.second;
    }
    const accountAuth = command.startsWith("claude auth login") || command === "codex login --device-auth";
    const sid = await startShellCommandForPane(paneId,command,{workspaceId:ctx.workspace,force:replace,accountAuth,accountProfiles:selected,focusTerm:true});
    if (!accountAuth || !sid) return sid;
    return {focus: async () => {
      if (state.selectedWorkspaceId !== ctx.workspace) return;
      const group = groupForPane(paneId)?.id;
      if (state.selectedGroupId && group && state.selectedGroupId !== group) {
        setWorkspaceSelectedGroup(group);
        renderGroupBar();
        paneApi.renderPaneSurface(true);
        paneApi.refreshPaneBindings();
      }
      await paneApi.selectPane(paneId,{persist:true,focusTerm:true});
      state.paneCards.get(paneId)?.scrollIntoView({block:"nearest",inline:"nearest"});
    }};
  }
  function manager(initial="claude") {
    const ctx = context();
    accounts.manage(ctx, (tool,id,action,email) => {
      const cmd = tool === "codex" ? (action === "login" ? "codex login --device-auth" : "codex login status") :
        (action === "login" ? "claude auth login" : "claude auth status");
      const hint = tool === "claude" && /^[a-z0-9_.+@-]+$/i.test(email || "") ? " --email " + email : "";
      return launch(ctx,state.selectedPaneId,cmd + hint,{[tool]:id},false);
    },initial,(tool,id)=>rpc("account.status",{tool,account_profiles:{[tool]:id}}));
  }
  document.getElementById("localAccountManager").onclick = report(() => manager());

  function attach(parent,paneId) {
    const btn = accounts.button("",report(() => {
      const view = state.paneViews.get(paneId);
      const tool = btn.dataset.provider;
      if (!view?.sessionId || !tool) return;
      const sid = view.sessionId;
      const ctx = context();
      const current = JSON.parse(localStorage.getItem("wincmux.accounts.session."+sid) || "{}");
      accounts.choose(ctx,tool,current[tool],report(async (provider,id,replace) => {
        if (view.sessionId !== sid) throw new Error("터미널이 변경되었습니다.");
        const selected = accounts.selection(ctx,{...current,[provider]:id});
        const status = await rpc("account.status",{tool:provider,account_profiles:selected});
        if (!status.authenticated) throw new Error("도구 프로필 관리에서 먼저 로그인하세요.");
        if (view.sessionId !== sid) throw new Error("터미널이 변경되었습니다.");
        return launch(ctx,paneId,provider,selected,replace);
      }),true,btn,manager);
    }));
    btn.className = "account-trigger"; btn.hidden = true;
    parent.append(btn); controls.set(parent,btn);
  }
  function sync(view,tool) {
    const parent = state.paneCards.get(view.paneId)?.querySelector(".pane-id-wrap");
    if (!parent) return;
    const btn = controls.get(parent);
    if (!btn) return;
    btn.hidden = !tool || !view.sessionId;
    btn.dataset.provider = tool || "";
    if (!btn.hidden) {
      const current = JSON.parse(localStorage.getItem("wincmux.accounts.session."+view.sessionId) || "{}");
      const text = tool + " · " + accounts.alias(context(),tool,current[tool]) + " ▾";
      if (btn.textContent !== text) btn.title = btn.textContent = text;
    }
  }
  function launchChoice(view,profile,card) {
    const tool = workspaceHookProvider(profile.command);
    if (!tool) return null;
    const pair = document.createElement("div");
    pair.className = "account-launch-pair";
    const btn = accounts.button("▾",report(() => {
      const ctx = context();
      accounts.choose(ctx,tool,accounts.defaults(ctx)[tool],report((provider,id) =>
        launch(ctx,view.paneId,profile.command,accounts.selection(ctx,{[provider]:id}),false)),false,btn,manager);
    }));
    btn.className = "account-trigger"; btn.title = profile.name + " 프로필 선택";
    btn.setAttribute("aria-label",btn.title);
    pair.append(card,btn); return pair;
  }
  window.wincmuxLocalAccounts = {attach,sync,launchChoice,workspace:id=>accounts.workspace(context(id)),selection:id=>accounts.selection(context(id))};
})();
