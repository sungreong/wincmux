(() => {
  const key = "wincmux.terminal.webgl";
  const live = new Map();
  let enabled = localStorage.getItem(key) === "1";

  function release(entry) {
    const addon = entry.addon;
    if (!addon) return;
    entry.addon = null;
    entry.lossListener?.dispose();
    entry.lossListener = null;
    const canvas = entry.term.element?.querySelector(".xterm-screen > canvas:not([class])");
    const gl = canvas?.getContext("webgl2");
    try {
      addon.dispose();
    } finally {
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }

  function apply(entry) {
    if (!enabled) {
      release(entry);
      return;
    }
    if (entry.addon) return;
    let addon;
    try {
      addon = new window.WebglAddon.WebglAddon();
      entry.term.loadAddon(addon);
      entry.addon = addon;
      entry.lossListener = addon.onContextLoss(() => {
        if (entry.addon !== addon) return;
        release(entry);
        entry.report("WebGL 화면 연결이 끊겨 기본 렌더러로 전환했습니다.");
      });
    } catch (error) {
      try { addon?.dispose(); } catch (disposeError) { console.error(disposeError); }
      entry.report(`WebGL을 사용할 수 없어 기본 렌더러로 표시합니다: ${error?.message ?? error}`);
    }
  }

  function refreshControls() {
    const toggle = document.getElementById("terminalWebglEnabled");
    if (toggle) toggle.checked = enabled;
    const state = document.getElementById("terminalWebglState");
    if (state) state.textContent = enabled ? "켜짐" : "꺼짐";
  }

  function update(value, save) {
    enabled = Boolean(value);
    if (save) localStorage.setItem(key, enabled ? "1" : "0");
    refreshControls();
    for (const entry of live.values()) apply(entry);
  }

  function sync() {
    const saved = localStorage.getItem(key) === "1";
    if (saved !== enabled) update(saved, false);
  }

  window.addEventListener("storage", event => {
    if (event.key === key) sync();
  });
  window.addEventListener("focus", sync);

  const dialog = document.getElementById("terminalRendererDialog");
  document.getElementById("terminalRendererSettingsBtn").addEventListener("click", () => {
    sync();
    dialog.showModal();
  });
  document.getElementById("terminalRendererClose").addEventListener("click", () => dialog.close());
  document.getElementById("terminalWebglEnabled").addEventListener("change", event => update(event.target.checked, true));
  refreshControls();

  window.wincmuxTerminalRenderer = {
    isEnabled: () => enabled,
    setEnabled: value => update(value, true),
    register(term, report) {
      const entry = { term, report, addon: null, lossListener: null };
      live.set(term, entry);
      apply(entry);
    },
    unregister(term) {
      const entry = live.get(term);
      if (!entry) return;
      release(entry);
      live.delete(term);
    }
  };
})();
