"use strict";
(() => {
  const storageKey = "wincmux.agent-command-input.v1";
  const providers = ["claude", "codex"];
  const invocation = text => /^[/$]/.test(text.trimStart());
  const valid = text => /^[/$][^\r\n\x00-\x1f\x7f]{1,199}$/.test(text);
  const empty = () => ({ claude: { mode: "message", items: [] }, codex: { mode: "message", items: [] } });
  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      const result = empty();
      for (const provider of providers) {
        result[provider].mode = saved?.[provider]?.mode === "command" ? "command" : "message";
        result[provider].items = [...new Set((saved?.[provider]?.items || []).filter(item => typeof item === "string" && valid(item)))].slice(0, 40);
      }
      return result;
    } catch { return empty(); }
  }
  function save(data) {
    try { localStorage.setItem(storageKey, JSON.stringify(data)); }
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
    const add = control("button", "현재 명령 저장", row);
    add.type = "button";
    const remove = control("button", "선택 삭제", row);
    remove.type = "button";
    const hint = control("p", "", panel);
    hint.className = "agent-command-hint";
    const feedback = control("p", "", panel);
    feedback.className = "agent-command-feedback";
    feedback.setAttribute("role", "status");
    feedback.hidden = true;
    function refresh() {
      const data = read()[provider.value];
      mode.value = data.mode;
      saved.replaceChildren();
      const placeholder = control("option", "저장한 명령 선택…", saved);
      placeholder.value = "";
      for (const item of data.items) {
        const option = control("option", item, saved);
        option.value = item;
      }
      hint.textContent = mode.value === "command"
        ? "명령은 대기열 없이 준비된 CLI에 직접 보냅니다. /명령 또는 $스킬을 입력하세요."
        : "일반 메시지는 /명령이나 $스킬로 시작해도 CLI 명령으로 실행하지 않습니다.";
    }
    const report = text => { feedback.textContent = text; feedback.hidden = !text; };
    provider.addEventListener("change", () => { report(""); refresh(); });
    mode.addEventListener("change", () => {
      const data = read();
      data[provider.value].mode = mode.value;
      save(data);
      report(""); refresh();
    });
    saved.addEventListener("change", () => {
      if (!saved.value) return;
      const command = saved.value;
      input.value = command;
      if (mode.value !== "command") {
        mode.value = "command";
        mode.dispatchEvent(new Event("change", { bubbles: true }));
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
    add.addEventListener("click", () => {
      const text = input.value.trim();
      if (!valid(text)) return report("/명령 또는 $스킬 한 줄만 저장할 수 있습니다.");
      const data = read();
      const items = data[provider.value].items;
      if (!items.includes(text) && items.length >= 40) return report("에이전트당 명령은 40개까지 저장할 수 있습니다.");
      if (!items.includes(text)) items.push(text);
      save(data); refresh(); saved.value = text; report("명령을 저장했습니다.");
    });
    remove.addEventListener("click", () => {
      if (!saved.value) return;
      const data = read();
      data[provider.value].items = data[provider.value].items.filter(item => item !== saved.value);
      save(data); refresh(); report("명령을 삭제했습니다.");
    });
    window.addEventListener("storage", event => { if (event.key === storageKey) refresh(); });
    input.addEventListener("input", () => { if (!feedback.hidden) report(""); });
    refresh();
    return {
      panel,
      mode: () => mode.value,
      provider: () => provider.value,
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
