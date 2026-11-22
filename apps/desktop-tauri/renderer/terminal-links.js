(() => {
  function normalizeUrl(value) {
    if (typeof value !== "string" || value.length > 8192 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error("올바른 웹 주소가 아닙니다.");
    }
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
      throw new Error("HTTP 또는 HTTPS 링크만 열 수 있습니다.");
    }
    return url.href;
  }

  const links = {
    normalizeUrl,
    open(url) {
      return window.__TAURI__.core.invoke("open_terminal_url", { url });
    },
    create(reportError) {
      let terminal;
      const activate = (_event, value) => {
        try {
          const url = normalizeUrl(value);
          void links.open(url).catch(reportError);
        } catch (error) {
          reportError(error);
        }
      };
      const hover = (_event, value) => {
        if (terminal?.element) terminal.element.title = value;
      };
      const leave = () => terminal?.element?.removeAttribute("title");
      return {
        handler: { activate, hover, leave },
        attach(term) {
          terminal = term;
          term.loadAddon(new window.WebLinksAddon.WebLinksAddon(activate, { hover, leave }));
        }
      };
    }
  };
  window.wincmuxTerminalLinks = links;
})();
