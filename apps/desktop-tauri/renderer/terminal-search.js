"use strict";
window.wincmuxTerminalSearch = (term, host) => {
  const addon = new window.SearchAddon.SearchAddon();
  term.loadAddon(addon);
  const panel = document.createElement("div");
  panel.className = "terminal-search";
  panel.hidden = true;
  panel.innerHTML = '<input type="search" aria-label="터미널 출력 검색" placeholder="터미널 출력 검색"><span class="terminal-search-count" role="status">0/0</span><button type="button" data-search="previous" title="이전 결과 (Shift+Enter)" aria-label="이전 결과">↑</button><button type="button" data-search="next" title="다음 결과 (Enter)" aria-label="다음 결과">↓</button><label title="대소문자 구분"><input type="checkbox" aria-label="대소문자 구분">Aa</label><button type="button" data-search="close" title="검색 닫기 (Esc)" aria-label="검색 닫기">×</button>';
  host.append(panel);
  const input = panel.querySelector('input[type="search"]');
  const caseSensitive = panel.querySelector('input[type="checkbox"]');
  const count = panel.querySelector(".terminal-search-count");
  const options = () => ({
    caseSensitive: caseSensitive.checked,
    decorations: {
      matchBackground: "#765a22",
      matchBorder: "#c79537",
      matchOverviewRuler: "#c79537",
      activeMatchBackground: "#b57a29",
      activeMatchBorder: "#ffe29a",
      activeMatchColorOverviewRuler: "#ffe29a"
    }
  });
  const results = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
    count.textContent = resultCount ? `${resultIndex < 0 ? "?" : resultIndex + 1}/${resultCount}` : "0/0";
  });
  function search(backward = false, incremental = false) {
    const query = input.value;
    if (!query) {
      addon.clearDecorations();
      count.textContent = "0/0";
      return;
    }
    const settings = { ...options(), incremental };
    if (backward) addon.findPrevious(query, settings);
    else addon.findNext(query, settings);
  }
  input.addEventListener("input", () => search(false, true));
  caseSensitive.addEventListener("change", () => search());
  panel.querySelector('[data-search="previous"]').addEventListener("click", () => search(true));
  panel.querySelector('[data-search="next"]').addEventListener("click", () => search());
  panel.querySelector('[data-search="close"]').addEventListener("click", close);
  panel.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      search(event.shiftKey);
    }
  });
  function open() {
    panel.hidden = false;
    const selected = term.getSelection().trim();
    if (selected && selected.length <= 200 && !selected.includes("\n")) input.value = selected;
    if (input.value) search();
    input.focus();
    input.select();
  }
  function close() {
    panel.hidden = true;
    addon.clearDecorations();
    term.focus();
  }
  return { open, close, panel, dispose() { results.dispose(); panel.remove(); } };
};
