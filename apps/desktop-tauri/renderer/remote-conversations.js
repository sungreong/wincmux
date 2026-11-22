"use strict";
window.wincmuxRemoteConversations = ({ context, list, resume }) => {
  const dialog = document.getElementById("remoteConversationDialog");
  const get = name => dialog.querySelector(`[data-conversation="${name}"]`);
  const search = get("search"), provider = get("provider"), from = get("from"), to = get("to");
  const visibility = get("visibility"), favorites = get("favorites"), children = get("children");
  const compact = get("compact"), sort = get("sort"), pageSize = get("size");
  const rows = get("rows"), info = get("info"), warning = get("warning"), error = get("error"), pageLabel = get("page");
  const previous = get("previous"), next = get("next");
  const key = "wincmux.remote.conversations.preferences.v1";
  let marks;
  try { marks = JSON.parse(localStorage.getItem(key) || "{}"); } catch { marks = {}; }
  if (!marks || typeof marks !== "object" || Array.isArray(marks)) marks = {};
  let items = [], current, page = 1, generation = 0, busy = false;
  const itemKey = item => `${current?.identity}:${item.provider}:${item.id}`;
  const mark = (item, field) => marks[itemKey(item)]?.[field] === true;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const day = seconds => {
    const date = new Date(seconds * 1000);
    if (!Number.isFinite(seconds) || Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const bytes = value => !Number.isFinite(value) ? "" : value < 1024 ? `${value} B` : `${new Intl.NumberFormat(window.wincmuxI18n?.language === "ko" ? "ko-KR" : "en-US", { maximumFractionDigits: 1 }).format(value / (value < 1048576 ? 1024 : 1048576))} ${value < 1048576 ? "KiB" : "MiB"}`;
  const order = (a, b) => {
    if (sort.value === "oldest") return a.updated_at - b.updated_at;
    if (sort.value === "largest") return (b.size_bytes ?? -1) - (a.size_bytes ?? -1);
    if (sort.value === "smallest") return (a.size_bytes ?? Infinity) - (b.size_bytes ?? Infinity);
    return b.updated_at - a.updated_at;
  };
  const report = failure => { error.textContent = String(failure?.message ?? failure); error.hidden = false; };
  const sameContext = () => {
    if (context()?.identity !== current?.identity) throw Error("작업환경이 변경되었습니다. 해당 폴더에서 대화 이력을 다시 여세요.");
  };
  function render() {
    rows.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const visible = items.filter(item => (!provider.value || provider.value === item.provider)
      && `${item.title} ${item.id} ${item.cwd}`.toLowerCase().includes(query)
      && (visibility.value === "all" || mark(item, "hidden") === (visibility.value === "hidden"))
      && (!favorites.checked || mark(item, "favorite"))
      && (!from.value || day(item.updated_at) >= from.value)
      && (!to.value || (day(item.updated_at) && day(item.updated_at) <= to.value))).sort(order);
    const size = Number(pageSize.value), pages = Math.max(1, Math.ceil(visible.length / size));
    page = Math.min(page, pages);
    const start = (page - 1) * size;
    info.textContent = `${visible.length}개 대화 · 숨김 ${items.filter(item => mark(item, "hidden")).length}개 · 원본은 각 도구가 보관합니다.`;
    pageLabel.textContent = `${page} / ${pages} 페이지${visible.length ? ` · ${start + 1}–${Math.min(start + size, visible.length)} / ${visible.length}` : ""}`;
    previous.disabled = page <= 1; next.disabled = page >= pages;
    dialog.classList.toggle("conversation-compact", compact.checked);
    for (const item of visible.slice(start, start + size)) {
      const row = element("article", "conversation-row");
      row.dataset.id = item.id;
      const icon = element("span", `conversation-icon conversation-${item.provider}`);
      icon.textContent = item.provider === "claude" ? "☀" : "⌘";
      const details = element("div", "conversation-detail");
      const title = element("strong", "conversation-title", item.title);
      const locale = window.wincmuxI18n?.language === "ko" ? "ko-KR" : "en-US";
      const meta = element("span", "conversation-meta", `${item.provider === "claude" ? "Claude Code" : "Codex"} · ${new Date(item.updated_at * 1000).toLocaleString(locale)} · ${bytes(item.size_bytes)}${item.archived ? ` · ${window.wincmuxI18n?.t("보관됨") ?? "보관됨"}` : ""}`);
      const cwd = element("span", "conversation-cwd", item.cwd); cwd.title = item.cwd;
      const id = element("span", "conversation-id", item.id);
      details.append(title, meta, cwd, id);
      const actions = element("div", "conversation-actions");
      for (const [field, label] of [["favorite", mark(item, "favorite") ? "★" : "☆"], ["hidden", mark(item, "hidden") ? "복원" : "숨기기"]]) {
        const control = element("button", "conversation-mark", label);
        control.type = "button";
        control.dataset.action = field;
        control.setAttribute("aria-label", field === "favorite" ? "즐겨찾기" : "대화 숨기기 또는 복원");
        control.setAttribute("aria-pressed", String(mark(item, field)));
        control.addEventListener("click", () => {
          marks[itemKey(item)] = { ...marks[itemKey(item)], [field]: !mark(item, field) };
          localStorage.setItem(key, JSON.stringify(marks));
          render();
        });
        actions.append(control);
      }
      const open = element("button", "conversation-resume", item.cwd_exists ? "이 대화 재개" : "폴더 없음");
      open.type = "button"; open.disabled = busy || !item.cwd_exists;
      open.title = item.cwd_exists ? item.resume_command : "대화를 실행한 폴더를 복원하세요.";
      open.addEventListener("click", () => { void launch(item.provider, item.id); });
      row.append(icon, details, actions, open); rows.append(row);
    }
    if (!visible.length) rows.append(element("p", "conversation-empty", items.length ? "검색 조건에 맞는 대화가 없습니다." : "이 작업환경에 저장된 Claude·Codex 대화를 찾지 못했습니다. 하위 폴더 포함을 확인하세요."));
  }
  async function refresh() {
    const sequence = ++generation;
    error.hidden = true;
    rows.replaceChildren(element("p", "conversation-empty", "대화 이력을 조회하고 있습니다…"));
    try {
      sameContext();
      const result = await list(children.checked);
      if (sequence !== generation || !dialog.open) return;
      sameContext();
      items = result.items ?? [];
      warning.textContent = (result.warnings ?? []).join(" ");
      render();
    } catch (failure) {
      if (sequence === generation) { items = []; render(); report(failure); }
    }
  }
  async function launch(providerName, id = null) {
    if (busy) return;
    try {
      sameContext(); busy = true; render();
      await resume(providerName, id);
      sameContext(); dialog.close();
    } catch (failure) { report(failure); }
    finally { busy = false; render(); }
  }
  function open() {
    current = context();
    if (!current) return;
    get("heading").textContent = `${current.title} · 이전 대화 불러오기`;
    search.value = provider.value = from.value = to.value = "";
    visibility.value = "visible"; favorites.checked = false;
    page = 1; items = []; error.hidden = true; warning.textContent = "";
    if (!dialog.open) dialog.showModal();
    search.focus(); void refresh();
  }
  for (const control of [search, provider, from, to, visibility, favorites]) control.addEventListener(control === search ? "input" : "change", () => { page = 1; render(); });
  children.addEventListener("change", () => { void refresh(); });
  compact.checked = localStorage.getItem("wincmux.conversations.compact.v1") === "1";
  pageSize.value = ["10", "20", "50"].includes(localStorage.getItem("wincmux.conversations.pageSize.v1")) ? localStorage.getItem("wincmux.conversations.pageSize.v1") : "10";
  sort.value = ["newest", "oldest", "largest", "smallest"].includes(localStorage.getItem("wincmux.conversations.sort.v1")) ? localStorage.getItem("wincmux.conversations.sort.v1") : "newest";
  compact.addEventListener("change", () => { localStorage.setItem("wincmux.conversations.compact.v1", compact.checked ? "1" : "0"); render(); });
  pageSize.addEventListener("change", () => { localStorage.setItem("wincmux.conversations.pageSize.v1", pageSize.value); page = 1; render(); });
  sort.addEventListener("change", () => { localStorage.setItem("wincmux.conversations.sort.v1", sort.value); page = 1; render(); });
  previous.addEventListener("click", () => { page--; render(); rows.scrollTop = 0; });
  next.addEventListener("click", () => { page++; render(); rows.scrollTop = 0; });
  get("refresh").addEventListener("click", () => { void refresh(); });
  get("close").addEventListener("click", () => dialog.close());
  get("claude-picker").addEventListener("click", () => { void launch("claude"); });
  get("codex-picker").addEventListener("click", () => { void launch("codex"); });
  dialog.addEventListener("close", () => { generation++; });
  window.addEventListener("wincmux:languagechange", () => { if (dialog.open) render(); });
  return { open, close: () => dialog.open && dialog.close() };
};
