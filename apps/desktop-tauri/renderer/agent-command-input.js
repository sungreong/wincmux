"use strict";
(() => {
  const storageKey = "wincmux.agent-command-input.v1";
  const providers = ["claude", "codex"];
  const invocation = text => /^[/$]/.test(text.trimStart());
  const valid = text => /^[/$][^\r\n\x00-\x1f\x7f]{1,199}$/.test(text);
  const examples = {
    claude: [
      { command: "/help", description: "Claude Code 명령 도움말 보기" },
      { command: "/compact", description: "대화 내용을 요약해 컨텍스트 확보" },
      { command: "/context", description: "현재 컨텍스트 사용량 확인" }
    ],
    codex: [
      { command: "/goal", description: "현재 대화의 목표 보기·설정·수정·일시 정지" },
      { command: "/review", description: "코드 변경 사항 검토" },
      { command: "/status", description: "현재 세션과 설정 상태 확인" }
    ]
  };
  const docs = {
    claude: "https://code.claude.com/docs/en/commands",
    codex: "https://learn.chatgpt.com/docs/developer-commands?surface=cli"
  };
  const translate = value => window.wincmuxI18n?.t(value) ?? value;
  const empty = () => ({ claude: { mode: "message", items: [], excluded: [] }, codex: { mode: "message", items: [], excluded: [] } });
  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      const result = empty();
      for (const provider of providers) {
        result[provider].mode = saved?.[provider]?.mode === "command" ? "command" : "message";
        const seen = new Set();
        result[provider].items = (Array.isArray(saved?.[provider]?.items) ? saved[provider].items : [])
          .map(item => typeof item === "string" ? { command: item, description: "" } : item)
          .filter(item => item && typeof item.command === "string" && valid(item.command)
            && !seen.has(item.command) && seen.add(item.command))
          .map(item => ({ command: item.command, description: typeof item.description === "string" ? item.description.slice(0, 1000) : "" }))
          .slice(0, 40);
        result[provider].excluded = (Array.isArray(saved?.[provider]?.excluded) ? saved[provider].excluded : [])
          .filter(command => typeof command === "string" && valid(command)).slice(0, 40);
      }
      return result;
    } catch { return empty(); }
  }
  function save(data) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(data));
      window.dispatchEvent?.(new Event("wincmux:agentcommandschange"));
    }
    catch { /* Input still works when storage is unavailable. */ }
  }
  function control(tag, label, parent) {
    const node = document.createElement(tag);
    node.textContent = label;
    parent.append(node);
    return node;
  }
  function create(input, initialProvider = "codex", fixedProvider = false) {
    const panel = document.createElement("details");
    panel.className = "agent-command-tools";
    control("summary", "명령·스킬", panel);
    const row = control("div", "", panel);
    row.className = "agent-command-row";
    const provider = control("select", "", row);
    provider.setAttribute("aria-label", "명령 대상 에이전트");
    for (const [value, label] of [["claude", "Claude Code"], ["codex", "Codex"]]) {
      const option = control("option", label, provider);
      option.value = value;
    }
    provider.hidden = fixedProvider;
    provider.value = providers.includes(initialProvider) ? initialProvider : "codex";
    const mode = control("select", "", row);
    mode.setAttribute("aria-label", "입력 처리 방식");
    for (const [value, label] of [["message", "일반 메시지"], ["command", "CLI 명령·스킬"]]) {
      const option = control("option", label, mode);
      option.value = value;
    }
    const saved = control("select", "", row);
    saved.setAttribute("aria-label", "저장한 명령");
    const add = control("button", "명령·설명 저장", row);
    add.type = "button";
    const remove = control("button", "목록에서 제외", row);
    remove.type = "button";
    const description = control("textarea", "", panel);
    description.className = "agent-command-description";
    description.rows = 2;
    description.maxLength = 1000;
    description.placeholder = "선택한 명령의 설명 또는 내 사용 메모 (선택 사항)";
    description.setAttribute("aria-label", "명령 설명");
    const reference = control("a", "공식 명령 목록 보기", panel);
    reference.className = "agent-command-reference";
    reference.target = "_blank";
    reference.rel = "noopener noreferrer";
    const source = control("p", "", panel);
    source.className = "agent-command-source";
    const hint = control("p", "", panel);
    hint.className = "agent-command-hint";
    const feedback = control("p", "", panel);
    feedback.className = "agent-command-feedback";
    feedback.setAttribute("role", "status");
    feedback.hidden = true;
    function entry(command) {
      const data = read()[provider.value];
      return data.items.find(item => item.command === command)
        || examples[provider.value].find(item => item.command === command);
    }
    function refresh(selected = "") {
      const data = read()[provider.value];
      mode.value = data.mode;
      saved.replaceChildren();
      const placeholder = control("option", "명령 선택 또는 직접 입력…", saved);
      placeholder.value = "";
      const personal = control("optgroup", "", saved);
      personal.label = translate("내 명령");
      for (const item of data.items) {
        const option = control("option", item.description ? `${item.command} · ${item.description}` : item.command, personal);
        option.value = item.command;
      }
      const builtIn = control("optgroup", "", saved);
      builtIn.label = translate("기본 참고 명령");
      for (const item of examples[provider.value]) {
        if (data.excluded.includes(item.command) || data.items.some(saved => saved.command === item.command)) continue;
        const option = control("option", `${item.command} · ${translate(item.description)}`, builtIn);
        option.value = item.command;
      }
      saved.value = selected && entry(selected) ? selected : "";
      reference.href = docs[provider.value];
      source.textContent = saved.value
        ? (data.items.some(item => item.command === saved.value) ? "내 목록 · 설명을 수정하고 다시 저장할 수 있습니다." : "기본 참고 명령 · 사용 가능 여부는 설치된 CLI에서 확인하세요.")
        : "목록은 참고용입니다. 여기에 없는 명령·스킬도 직접 입력할 수 있습니다.";
      hint.textContent = mode.value === "command"
        ? "명령은 대기열 없이 준비된 CLI에 직접 보냅니다. /명령 또는 $스킬을 입력하세요."
        : "일반 메시지는 /명령이나 $스킬로 시작해도 CLI 명령으로 실행하지 않습니다.";
    }
    const report = text => { feedback.textContent = text; feedback.hidden = !text; };
    provider.addEventListener("change", () => { report(""); description.value = ""; refresh(); });
    mode.addEventListener("change", () => {
      const data = read();
      data[provider.value].mode = mode.value;
      save(data);
      report(""); refresh(saved.value);
    });
    saved.addEventListener("change", () => {
      if (!saved.value) return;
      const command = saved.value;
      input.value = command;
      const selected = entry(command);
      description.value = selected ? (read()[provider.value].items.some(item => item.command === command)
        ? selected.description : translate(selected.description)) : "";
      if (mode.value !== "command") {
        mode.value = "command";
        mode.dispatchEvent(new Event("change", { bubbles: true }));
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      refresh(command);
    });
    add.addEventListener("click", () => {
      const text = input.value.trim();
      if (!valid(text)) return report("/명령 또는 $스킬 한 줄만 저장할 수 있습니다.");
      const data = read();
      const items = data[provider.value].items;
      const existing = items.find(item => item.command === text);
      if (!existing && items.length >= 40) return report("에이전트당 명령은 40개까지 저장할 수 있습니다.");
      if (existing) existing.description = description.value.trim();
      else items.push({ command: text, description: description.value.trim() });
      data[provider.value].excluded = data[provider.value].excluded.filter(command => command !== text);
      save(data); refresh(text); report("명령과 설명을 저장했습니다.");
    });
    remove.addEventListener("click", () => {
      if (!saved.value) return;
      const selected = saved.value;
      const data = read();
      data[provider.value].items = data[provider.value].items.filter(item => item.command !== selected);
      if (examples[provider.value].some(item => item.command === selected)
        && !data[provider.value].excluded.includes(selected)) data[provider.value].excluded.push(selected);
      save(data); description.value = ""; refresh(); report("목록에서 제외했습니다. 직접 입력은 계속 가능합니다.");
    });
    window.addEventListener("storage", event => { if (event.key === storageKey) refresh(); });
    window.addEventListener("wincmux:agentcommandschange", () => refresh(saved.value));
    window.addEventListener("wincmux:languagechange", () => refresh(saved.value));
    input.addEventListener("input", () => { if (!feedback.hidden) report(""); });
    refresh();
    return {
      panel,
      mode: () => mode.value,
      provider: () => provider.value,
      reload: () => refresh(saved.value),
      setProvider(value) { if (providers.includes(value) && provider.value !== value) { provider.value = value; refresh(); } },
      prepare(text) {
        if (mode.value === "command") {
          const command = text.trim();
          if (!valid(command)) throw Error("CLI 명령·스킬은 / 또는 $로 시작하는 한 줄이어야 합니다.");
          return command;
        }
        if (!invocation(text)) return text;
        return (document.documentElement.lang === "en" ? "Treat this as a plain message, not a CLI command or skill: "
          : "다음은 CLI 명령이나 스킬 실행이 아닌 일반 메시지입니다: ") + text;
      }
    };
  }
  window.wincmuxAgentCommandInput = { create, invocation };
})();
