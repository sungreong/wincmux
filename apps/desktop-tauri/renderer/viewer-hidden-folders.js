"use strict";
window.wincmuxHiddenFolders = ({ trigger, getKey, onChange, onError, absolutePath, writeText,
  readFile, download, copyFile, pasteFile, canPaste, notify }) => {
  const key = () => "wincmux.viewer.hiddenFolders." + getKey();
  function paths() {
    try {
      const value = JSON.parse(localStorage.getItem(key()) || "[]");
      return Array.isArray(value) ? value.filter(path => typeof path === "string" && path) : [];
    } catch { return []; }
  }
  const rules = window.wincmuxFolderRules({ key, paths, trigger: document.getElementById("viewerRules"), workspaceName: () => absolutePath(""), changed: onChange });
  function visible(search = false) {
    const active = rules.read().filter(row => search ? row.search : row.hide);
    return (path, directory = true) => {
      const parts = (path || "").split("/");
      if (!directory) parts.pop();
      return !active.some(row => row.kind === "name"
        ? parts.some(part => part.toLowerCase() === row.value.toLowerCase())
        : path === row.value || path?.startsWith(row.value + "/"));
    };
  }
  function button(label) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    return node;
  }
  const menu = document.createElement("div");
  menu.popover = "auto";
  menu.className = "viewer-hide-menu";
  menu.addEventListener("keydown", event => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const buttons = [...menu.querySelectorAll("button:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next]?.focus();
  });
  const dialog = document.createElement("dialog");
  dialog.className = "viewer-hidden-dialog";
  const heading = document.createElement("h2");
  heading.id = "hiddenFolderHeading";
  heading.textContent = "숨긴 항목 관리";
  dialog.setAttribute("aria-labelledby", heading.id);
  const filters = document.createElement("div");
  filters.className = "viewer-hidden-filters";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "번호·이름·경로 검색";
  search.setAttribute("aria-label", search.placeholder);
  const sort = document.createElement("select");
  sort.setAttribute("aria-label", "정렬 기준");
  for (const [value, label] of [["asc", "이름 오름차순"], ["desc", "이름 내림차순"], ["original", "숨긴 순서"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sort.append(option);
  }
  filters.append(search, sort);
  const list = document.createElement("div");
  list.className = "viewer-hidden-list";
  const actions = document.createElement("div");
  actions.className = "viewer-folder-actions";
  const close = button("닫기");
  const previous = button("이전 페이지");
  const next = button("다음 페이지");
  const counter = document.createElement("small");
  counter.setAttribute("role", "status");
  actions.append(previous, counter, next, close);
  dialog.append(heading, filters, list, actions);
  document.body.append(menu, dialog);
  close.onclick = () => dialog.close();
  const pageSize = 10;
  let page = 0;
  let dialogKey;
  previous.onclick = () => { page--; renderList(); };
  next.onclick = () => { page++; renderList(); };
  search.oninput = sort.onchange = () => { page = 0; renderList(); };
  search.onkeydown = event => {
    if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      list.querySelector("button")?.focus();
    }
  };
  function renderList() {
    if (dialogKey !== key()) { dialog.close(); return; }
    list.replaceChildren();
    list.scrollTop = 0;
    const currentKey = key();
    const all = paths();
    const query = search.value.trim().toLowerCase();
    const number = /^(\d+)\.?$/.exec(query);
    const entries = all.map((path, index) => ({
      path, name: path.split("/").pop(), number: index + 1
    })).filter(entry => number ? entry.number === Number(number[1]) : entry.path.toLowerCase().includes(query));
    if (sort.value !== "original") {
      const collator = new Intl.Collator(document.documentElement.lang || undefined, { numeric: true, sensitivity: "base" });
      const direction = sort.value === "desc" ? -1 : 1;
      entries.sort((a, b) => direction * (collator.compare(a.name, b.name) || collator.compare(a.path, b.path)));
    }
    const pages = Math.ceil(entries.length / pageSize);
    page = Math.max(0, Math.min(page, pages - 1));
    previous.disabled = page === 0;
    next.disabled = page + 1 >= pages;
    previous.hidden = next.hidden = pages <= 1;
    counter.textContent = pages > 1 ? `${page + 1} / ${pages} · ${entries.length}개 항목` : `${entries.length}개 항목`;
    for (const entry of entries.slice(page * pageSize, (page + 1) * pageSize)) {
      const path = entry.path;
      const row = document.createElement("div");
      const index = document.createElement("small");
      index.textContent = entry.number + ".";
      const label = document.createElement("div");
      label.setAttribute("data-i18n-ignore", "");
      const name = document.createElement("span");
      name.textContent = entry.name;
      label.title = path;
      label.append(name);
      if (entry.name !== path) {
        const parent = document.createElement("small");
        parent.textContent = path.slice(0, path.lastIndexOf("/"));
        label.append(parent);
      }
      const restore = button("다시 표시");
      restore.onclick = () => {
        if (currentKey !== key()) { dialog.close(); return; }
        localStorage.setItem(currentKey, JSON.stringify(paths().filter(value => value !== path)));
        renderList();
        (list.querySelector("button") || close).focus();
        onChange();
      };
      row.append(index, label, restore);
      list.append(row);
    }
    if (!list.childElementCount) list.textContent = all.length ? "검색 결과가 없습니다." : "숨긴 항목이 없습니다.";
  }
  trigger.onclick = () => {
    dialogKey = key();
    page = 0;
    search.value = "";
    renderList();
    dialog.showModal();
    search.focus();
  };
  function bind(node, path, directory = true) {
    const workspaceKey = key();
    function open(event) {
      event.preventDefault();
      event.stopPropagation();
      if (workspaceKey !== key()) return;
      const rect = node.getBoundingClientRect();
      const copyText = async (value, feedback) => {
        await writeText(value);
        notify(feedback);
      };
      const choices = directory
        ? [["여기에 붙여넣기", canPaste() ? () => pasteFile(path) : null]]
        : [
            ["파일 복사", () => copyFile(path)],
            ["내용 복사", async () => {
              const file = await readFile(path);
              if (workspaceKey !== key()) return;
              if (typeof file.text !== "string" || file.binary || file.truncated || !["html", "text"].includes(file.kind)) {
                throw Error(window.wincmuxI18n.t("미리보기 가능한 텍스트 파일의 전체 내용만 복사할 수 있습니다."));
              }
              await copyText(file.text, "내용을 복사했습니다.");
            }],
            ["파일 다운로드", () => download(path)]
          ];
      choices.push(["절대 경로 복사", () => copyText(absolutePath(path), "경로를 복사했습니다.")]);
      if (path) choices.push(["상대 경로 복사", () => copyText(path, "경로를 복사했습니다.")]);
      if (path) choices.push([directory ? "폴더 숨기기" : "파일 숨기기", () => {
        localStorage.setItem(workspaceKey, JSON.stringify([...new Set([...paths(), path])]));
        trigger.focus();
        onChange();
      }]);
      choices.push(["숨긴 항목 관리", () => trigger.click()]);
      menu.replaceChildren();
      for (const [label, action] of choices) {
        const choice = button(label);
        choice.disabled = !action;
        choice.onclick = async () => {
          menu.hidePopover();
          if (workspaceKey !== key() || !node.isConnected) return;
          try { await action(); } catch (error) { onError(error); }
        };
        menu.append(choice);
      }
      menu.showPopover();
      menu.style.left = Math.max(0, Math.min(event.clientX || rect.left, innerWidth - menu.offsetWidth)) + "px";
      menu.style.top = Math.max(0, Math.min(event.clientY || rect.bottom, innerHeight - menu.offsetHeight)) + "px";
      menu.querySelector("button:not(:disabled)").focus();
    }
    node.addEventListener("contextmenu", open);
    node.addEventListener("keydown", event => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) open(event);
    });
  }
  return { bind, visible, refresh: rules.refresh, searchRules: () => rules.read().filter(row => row.search).map(({kind,value}) => ({kind,value})) };
};
