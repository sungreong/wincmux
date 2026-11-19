"use strict";
window.wincmuxRemoteAlerts = ({ request, localDocker, focusTarget, reportError }) => {
  const el = id => document.getElementById(id);
  const { core, event } = window.__TAURI__;
  const prefix = `remote:${localDocker ? "docker" : "ssh"}:`;
  const dialog = el("workspaceAlertDialog");
  const toggle = el("workspaceAlerts");
  const listeners = new Set();
  let items = [];
  let generation = 0;
  let timer;

  function dismiss(ids) {
    if (ids.length) void core.invoke("desktop_action", { action:"dismiss-notifications", params:{ ids } }).catch(() => {});
  }

  async function openNotice(row) {
    dialog.close();
    try {
      await focusTarget(row);
      await request("alert-read", { notification_id: row.id });
      dismiss([row.id]);
    } catch (error) {
      reportError(error);
    } finally {
      schedule();
    }
  }

  function render() {
    const list = el("workspaceAlertList");
    list.replaceChildren();
    el("clearWorkspaceAlerts").disabled = !items.length;
    if (!items.length) {
      const empty = document.createElement("p");
      empty.textContent = "읽지 않은 알림이 없습니다.";
      list.append(empty);
    }
    for (const item of items) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "workspace-alert-row";
      const title = document.createElement("strong");
      title.textContent = { task_done:"작업 완료", assistant_prompt:"입력 필요" }[item.kind] ?? item.title;
      const meta = document.createElement("small");
      meta.textContent = [item.workspace_name, new Date(item.created_at).toLocaleString()].filter(Boolean).join(" · ");
      card.append(title, meta);
      if (item.body && item.source_kind !== "osc7501") {
        const body = document.createElement("span");
        body.textContent = item.body;
        card.append(body);
      }
      card.addEventListener("click", () => void openNotice(item));
      list.append(card);
    }
  }

  async function refresh() {
    const requestId = ++generation;
    const result = await request("alert-list");
    if (requestId !== generation) return;
    items = result.items;
    el("workspaceAlertCount").textContent = items.length > 99 ? "99+" : String(items.length);
    el("workspaceAlertCount").hidden = !items.length;
    toggle.setAttribute("aria-label", items.length ? `읽지 않은 알림 ${items.length}개` : "알림");
    if (dialog.open) render();
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh().catch(error => { if (dialog.open) reportError(error); }), 80);
  }

  async function takeAlert() {
    const row = await request("take-alert");
    if (row?.id) await openNotice(row);
  }

  toggle.addEventListener("click", () => {
    dialog.showModal();
    render();
    void refresh().catch(reportError);
  });
  el("closeWorkspaceAlerts").addEventListener("click", () => dialog.close());
  el("clearWorkspaceAlerts").addEventListener("click", async () => {
    const ids = items.map(item => item.id);
    el("clearWorkspaceAlerts").disabled = true;
    try {
      await request("alert-clear");
      dismiss(ids);
      await refresh();
    } catch (error) {
      reportError(error);
      el("clearWorkspaceAlerts").disabled = !items.length;
    }
  });
  void event.listen("wincmux-notify", ({ payload }) => {
    if (payload.method === "notify.created" && !payload.params?.notification?.workspace_id?.startsWith(prefix)) return;
    for (const notify of listeners) notify(payload);
    if (payload.method === "notify.created" || payload.method === "notify.read_changed") schedule();
  }).catch(reportError);
  void event.listen("wincmux-remote-alert", () => void takeAlert().catch(reportError))
    .then(takeAlert).catch(reportError);
  window.addEventListener("focus", schedule);
  schedule();
  return handler => listeners.add(handler);
};
