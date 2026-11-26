(() => {
  "use strict";
  const providers = ["claude", "codex"];
  const names = { claude: "Claude Code", codex: "Codex" };
  const key = (...parts) => "wincmux.accounts.v1." + JSON.stringify(parts);
  function read(keyName, fallback) {
    const raw = localStorage.getItem(keyName);
    return raw ? JSON.parse(raw) : fallback;
  }
  function profiles(ctx, tool) {
    return read(key(ctx.scope, tool), []);
  }
  const monitoring = new Set();
  const normalizeEmail = value => typeof value === "string" ? value.trim().toLowerCase() : "";
  function updateProfile(ctx, tool, id, patch) {
    const list = profiles(ctx, tool);
    const row = list.find(item => item.id === id);
    if (row) {
      Object.assign(row, patch);
      localStorage.setItem(key(ctx.scope, tool), JSON.stringify(list));
    }
  }
  async function matchingProfile(candidates, email, tool, probe) {
    if (!email) return "";
    for (const other of candidates) {
      const actual = await probe(tool,other.id);
      if (actual.authenticated && normalizeEmail(actual.email) === email) return other.name;
    }
    return "";
  }
  async function inspect(ctx, tool, id, probe) {
    const status = await probe(tool, id);
    const email = normalizeEmail(status.email);
    const list = profiles(ctx, tool);
    const index = list.findIndex(row => row.id === id);
    if (index < 0) return;
    // Prefer an established sign-in. Registration order breaks ties for legacy or pending profiles.
    const rank = row => row.pending || row.mismatch || (row.duplicate && row.duplicate !== "환경 기본") ? 1 : 0;
    const priority = rank(list[index]);
    const candidates = list.filter((other,i) => rank(other) < priority || (rank(other) === priority && i < index));
    const duplicate = status.authenticated ? await matchingProfile(candidates,email,tool,probe) : "";
    const mismatch = status.authenticated && !!list[index].expected && email !== list[index].expected;
    updateProfile(ctx, tool, id, {duplicate, mismatch, pending: !status.authenticated && !!list[index].pending});
    return {connected:status.authenticated, blocked:duplicate || mismatch, message: duplicate
      ? email + " 계정은 ‘" + duplicate + "’에 이미 연결되어 있습니다. 해당 프로필을 사용하거나 중복 프로필을 등록 해제하세요."
      : mismatch ? "요청한 이메일과 로그인 계정을 일치시킬 수 없습니다. 프로필을 등록 해제하고 다른 계정으로 연결하세요."
      : status.authenticated ? (email ? "연결됨 · " + email : "연결됨 · 계정 이메일 확인 불가") : "로그인 필요"};
  }
  async function watchLogin(ctx, tool, id, probe) {
    const token = key(ctx.scope, tool, id);
    if (monitoring.has(token)) return;
    monitoring.add(token);
    try {
      for (let attempt = 0; attempt < 80; attempt++) {
        await new Promise(resolve => setTimeout(resolve, attempt < 3 ? 2000 : 5000));
        if (!profiles(ctx,tool).some(row => row.id === id && row.pending)) return;
        const result = await inspect(ctx, tool, id, probe);
        if (result?.blocked) {
          const notice = dialog("로그인 계정 확인",ctx);
          notice.body.append(element("p",result.message),button("확인",()=>notice.box.close()));
        }
        if (result?.connected) return;
      }
    } catch { /* The manager can retry after a disconnect. */ }
    finally { monitoring.delete(token); }
  }
  function available(row) {
    return !row.pending && !row.duplicate && !row.mismatch;
  }
  function defaults(ctx) {
    return Object.fromEntries(providers.map(tool => {
      const storage = key(ctx.scope, ctx.workspace, tool);
      const saved = localStorage.getItem(storage);
      if (saved !== null) return [tool, JSON.parse(saved)];
      const first = ctx.scope === "local" && tool === "claude" ? profiles(ctx, tool).find(available) : null;
      if (first) localStorage.setItem(storage, JSON.stringify(first.id));
      return [tool, first?.id ?? null];
    }));
  }
  function selection(ctx, overrides = {}) {
    const result = { ...defaults(ctx), ...overrides };
    for (const tool of providers) {
      if (result[tool] && !profiles(ctx, tool).some(row => row.id === result[tool] && available(row))) {
        throw new Error("도구 프로필 관리에서 계정 상태를 확인하고 워크스페이스 기본 프로필을 다시 선택하세요.");
      }
    }
    return result;
  }
  function element(tag, text) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    return node;
  }
  function button(label, action) {
    const node = element("button", label);
    node.type = "button";
    node.onclick = action;
    return node;
  }
  function dialog(title, ctx) {
    const box = element("dialog");
    box.className = "account-dialog";
    box.setAttribute("aria-label", title);
    const header = element("header");
    const close = button("×", () => box.close());
    close.setAttribute("aria-label", "닫기");
    header.append(element("strong", title), close);
    const detail = element("p", ctx.label);
    detail.className = "account-context";
    detail.title = ctx.label;
    const body = element("section");
    const error = element("p");
    error.setAttribute("role", "alert");
    box.append(header, detail, body, error);
    document.body.append(box);
    box.addEventListener("close", () => box.remove(), { once: true });
    box.showModal();
    return { box, body, error };
  }
  function chooser(ctx, tool, current) {
    const node = element("select");
    node.setAttribute("aria-label", names[tool] + " 프로필");
    node.add(new Option("환경 기본", ""));
    for (const row of profiles(ctx, tool).filter(available)) node.add(new Option(row.name, row.id));
    node.value = current ?? "";
    return node;
  }
  function workspace(ctx) {
    const { box, body } = dialog("기본 프로필", ctx);
    const fields = providers.map(tool => {
      const label = element("label", names[tool]);
      const select = chooser(ctx, tool, defaults(ctx)[tool]);
      label.append(select);
      body.append(label);
      return [tool, select];
    });
    body.append(element("p", "새로 여는 터미널부터 적용됩니다."), button("저장", () => {
      for (const [tool, select] of fields) localStorage.setItem(key(ctx.scope, ctx.workspace, tool), JSON.stringify(select.value || null));
      box.close();
    }));
  }
  function manage(ctx, auth, initial = "claude", probe) {
    const { box, body, error } = dialog("도구 프로필 관리", {label:ctx.scopeLabel || ctx.label});
    async function openLogin(tool, id, email) {
      try {
        const terminal = await auth(tool,id,"login",email);
        if (!terminal) throw new Error("로그인 터미널을 열 수 없습니다. 다시 시도하세요.");
        box.close();
        watchLogin(ctx,tool,id,probe);
        await terminal.focus?.();
      } catch (err) {
        render(tool);
        error.textContent = String(err.message ?? err);
      }
    }
    function render(tool) {
      body.replaceChildren();
      error.textContent = "";
      const tabs = element("nav");
      for (const provider of providers) {
        const tab = button(names[provider], () => render(provider));
        tab.setAttribute("aria-pressed", String(provider === tool));
        tabs.append(tab);
      }
      body.append(tabs);
      const storage = key(ctx.scope, tool);
      function edit(row, remove = false) {
        body.replaceChildren();
        const form = element("form");
        const label = element("label", remove ? "등록 해제할 프로필" : "프로필 이름");
        const input = element("input");
        input.value = row?.name ?? "";
        input.maxLength = 64;
        input.required = true;
        input.readOnly = remove;
        label.append(input);
        const submit = element("button", remove ? "등록 해제" : row ? "저장" : "등록하고 로그인");
        form.append(label);
        const emailInput = element("input");
        if (!row) {
          const emailLabel = element("label","로그인할 이메일 (선택)");
          emailInput.type = "email";
          emailInput.maxLength = 254;
          emailLabel.append(emailInput);
          form.append(emailLabel);
        }
        if (!row) form.append(element("p", "다른 계정을 연결하려면 터미널의 인증 링크를 브라우저의 시크릿 또는 InPrivate 창에서 열고, 승인 화면의 이메일을 확인하세요."));
        const refs = [];
        let replacement;
        if (remove) {
          const prefix = "wincmux.accounts.v1.";
          for (const storageKey of Object.keys(localStorage)) {
            if (!storageKey.startsWith(prefix)) continue;
            const parts = JSON.parse(storageKey.slice(prefix.length));
            if (parts.length === 3 && parts[0] === ctx.scope && parts[2] === tool && read(storageKey,null) === row.id) refs.push(storageKey);
          }
          if (refs.length) {
            const label = element("label", "기본값을 사용하는 워크스페이스 " + refs.length + "개 · 대체 프로필");
            replacement = chooser(ctx,tool,null);
            Array.from(replacement.options).find(opt=>opt.value===row.id)?.remove();
            label.append(replacement); form.append(label);
          }
          form.append(element("p", "실행 중인 작업과 인증 파일은 유지됩니다."));
        }
        form.append(button("뒤로", () => render(tool)), submit);
        form.onsubmit = async event => {
          event.preventDefault();
          if (submit.disabled) return;
          const expected = normalizeEmail(emailInput.value);
          if (!row && expected) {
            submit.disabled = true;
            try {
              const existing = await matchingProfile(profiles(ctx,tool),expected,tool,probe);
              if (existing) { error.textContent = "이 이메일은 ‘" + existing + "’에 이미 연결되어 있습니다."; return; }
              if (!form.isConnected || !box.open) return;
            } catch (err) { error.textContent = String(err.message ?? err); return; }
            finally { submit.disabled = false; }
          }
          const list = profiles(ctx, tool);
          const name = input.value.trim();
          if (row && !list.some(p => p.id === row.id)) { render(tool); return; }
          if (!remove && (!name || list.some(p => p.id !== row?.id && p.name === name))) {
            error.textContent = "비어 있지 않은 다른 이름을 입력하세요."; return;
          }
          const id = row?.id ?? crypto.randomUUID();
          const next = list.filter(p => p.id !== id);
          if (!remove && row) list.find(p => p.id === id).name = name;
          if (!row) next.push({ id, name, expected, pending:true });
          for (const ref of refs) if (read(ref,null) === id) localStorage.setItem(ref, JSON.stringify(replacement?.value || null));
          localStorage.setItem(storage, JSON.stringify(row && !remove ? list : next));
          if (!row) { submit.disabled = true; await openLogin(tool,id,expected); }
          else render(tool);
        };
        body.append(form);
        input.focus();
      }
      const environment = element("div");
      environment.className = "account-environment";
      const detail = element("p", "CLI에서 현재 사용하는 계정입니다. 같은 이메일로 프로필을 등록할 수 있습니다.");
      detail.setAttribute("aria-live","polite");
      const check = button("기본 계정 확인",async () => {
        check.disabled = true;
        try {
          const result = await probe(tool,null);
          detail.textContent = result.authenticated ? result.email || "연결됨 · 계정 이메일 확인 불가" : "로그인 필요";
        } catch (err) { detail.textContent = String(err.message ?? err); }
        finally { check.disabled = false; }
      });
      environment.append(element("strong","환경 기본 계정"),check,detail);
      body.append(environment,element("strong","WinCMux에 등록한 프로필"));
      if (!profiles(ctx,tool).length) body.append(element("p","등록한 프로필이 없습니다."));
      body.append(button("+ 프로필 추가", () => edit(null)));
      for (const row of profiles(ctx, tool)) {
        const item = element("div");
        item.className = "account-row";
        const name = element("strong", row.name);
        name.title = row.name;
        name.dataset.i18nIgnore = "";
        const status = button(row.pending ? "로그인 확인" : row.duplicate ? "중복 계정" : row.mismatch ? "계정 불일치" : "상태 확인", async () => {
          status.disabled = true;
          try {
            const result = await inspect(ctx,tool,row.id,probe);
            if (result) {
              error.textContent = result.message;
              status.textContent = result.blocked ? "계정 확인 필요" : result.connected ? "연결됨" : "로그인 필요";
            }
          }
          catch (err) { error.textContent = String(err.message ?? err); }
          finally { status.disabled = false; }
        });
        if ((row.pending || row.duplicate) && !monitoring.has(key(ctx.scope,tool,row.id))) {
          inspect(ctx,tool,row.id,probe).then(result => {
            if (result && status.isConnected) {
              status.textContent = result.blocked ? "계정 확인 필요" : result.connected ? "연결됨" : "로그인 필요";
              if (result.blocked) error.textContent = result.message;
            }
          }).catch(err => { if (status.isConnected) error.textContent = String(err.message ?? err); });
        }
        item.append(name, status,
          button("로그인", async event => {
            const login = event.currentTarget;
            login.disabled = true;
            try {
              const result = await inspect(ctx,tool,row.id,probe);
              if (!result || !login.isConnected || !box.open) return;
              if (result.connected) { error.textContent = result.message; return; }
              updateProfile(ctx,tool,row.id,{pending:true});
              await openLogin(tool,row.id,row.expected);
            } catch (err) { error.textContent = String(err.message ?? err); }
            finally { login.disabled = false; }
          }),
          button("이름 변경", () => edit(row)), button("등록 해제", () => edit(row, true)));
        body.append(item);
      }
    }
    render(initial);
  }
  function choose(ctx, tool, current, start, running = false, anchor = null, manager = null) {
    const { body, box } = dialog(names[tool] + " 프로필 선택", ctx);
    box.classList.add("account-menu");
    function run(id,replace) { box.close(); start(tool,id,replace); }
    function pick(id) {
      if (!running) { run(id,false); return; }
      box.classList.remove("account-menu"); box.removeAttribute("style");
      body.replaceChildren(element("strong",names[tool]+" · "+alias(ctx,tool,id)),
        button("새 창에서 시작",()=>run(id,false)),
        button("이 창에서 다시 시작",()=>body.replaceChildren(
          element("p","현재 작업을 종료하고 선택한 프로필로 새 대화를 시작합니다."),
          button("취소",()=>box.close()),button("종료하고 다시 시작",()=>run(id,true)))));
      body.querySelector("button").focus();
    }
    for (const row of [{id:null,name:"환경 기본"},...profiles(ctx,tool).filter(available)]) {
      const item = button((row.id === (current ?? null) ? "✓  " : "") + row.name,()=>pick(row.id));
      item.title=row.name; body.append(item);
    }
    if (manager) body.append(button("도구 프로필 관리",()=>{box.close();manager(tool);}));
    const position = () => {
      if (!box.open || !box.classList.contains("account-menu")) return;
      const rect = anchor.getBoundingClientRect();
      const w=box.offsetWidth,h=box.offsetHeight;
      box.style.left = Math.max(8,Math.min(rect.left,innerWidth-w-8))+"px";
      box.style.top = Math.max(8,rect.bottom+6+h<=innerHeight ? rect.bottom+6 : Math.min(rect.top-h-6,innerHeight-h-8))+"px";
    };
    position();
    window.addEventListener("resize",position);
    box.addEventListener("close",()=>window.removeEventListener("resize",position),{once:true});
    body.querySelector("button").focus();
  }
  function alias(ctx, tool, id) {
    return profiles(ctx, tool).find(row => row.id === id)?.name ?? (id ? "해제된 프로필" : "환경 기본");
  }
  window.wincmuxAccounts = { manage, workspace, selection, defaults, choose, alias, button };
})();
