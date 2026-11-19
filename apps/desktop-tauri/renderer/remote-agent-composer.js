"use strict";
window.wincmuxRemoteComposer = (request, button) => {
  const panel = document.createElement("form");
  panel.className = "remote-composer";
  const input = document.createElement("textarea");
  input.rows = 1;
  input.placeholder = "메시지 입력 (Ctrl+Enter로 전송 또는 대기열 추가)";
  input.setAttribute("aria-label", "에이전트 메시지");
  const queue = document.createElement("div");
  queue.className = "remote-composer-queue";
  queue.hidden = true;
  const message = document.createElement("span");
  message.className = "remote-composer-message";
  message.setAttribute("role", "status");
  message.hidden = true;
  const state = document.createElement("span");
  state.className = "remote-agent-state";
  state.textContent = "시작 중";
  const actions = document.createElement("div");
  actions.className = "remote-composer-actions";
  const due = document.createElement("input");
  due.type = "datetime-local";
  due.setAttribute("aria-label", "후속 입력 시각");
  due.hidden = true;
  const report = error => {
    message.textContent = error;
    message.hidden = !error;
  };
  let pending = false;
  let items = [];
  async function send(action) {
    if (pending || !input.value.trim()) return;
    if (action === "agent-submit" && items.length >= 32) return report("대기 입력은 최대 32개입니다.");
    const due_at = !due.hidden && due.value ? new Date(due.value).getTime() : undefined;
    if (due_at !== undefined && (!Number.isFinite(due_at) || due_at <= Date.now())) return report("현재 이후의 예약 시각을 선택하세요.");
    pending = true;
    const text = input.value;
    try {
      await request(action, { text, due_at });
      if (input.value === text) input.value = "";
      due.value = "";
      due.hidden = true;
    } catch (error) {
      report(String(error));
    } finally {
      pending = false;
    }
  }
  const toggle = button("후속 예약", () => {
    due.hidden = !due.hidden;
    if (!due.hidden) due.focus();
  });
  const submit = button("전송 / 대기열", () => send("agent-submit"));
  const insert = button("삽입만", () => send("agent-insert"));
  actions.append(insert, toggle, due, submit);
  panel.append(queue, input, message, actions);
  panel.addEventListener("submit", event => event.preventDefault());
  input.addEventListener("keydown", event => {
    if (!event.isComposing && event.keyCode !== 229 && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send("agent-submit");
    }
  });
  return {
    panel, state,
    update(value) {
      const status = { working:"작업 중", idle:"입력 가능", done:"작업 완료", blocked:"확인 필요", error:"오류", unknown:"상태 확인 중" };
      state.textContent = status[value.state] ?? "상태 확인 중";
      if (value.source === "pattern" && value.state === "done") state.title = "터미널에서 작업 완료를 감지했습니다.";
      items = value.queue ?? [];
      queue.replaceChildren();
      queue.hidden = !items.length;
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "remote-composer-item";
        const label = document.createElement("span");
        const when = item.due_at ? ` · ${new Date(item.due_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}` : "";
        label.textContent = `${item.pasted ? "초안 확인" : item.paused ? "일시 정지" : "대기"}${when} · ${item.preview}`;
        row.append(label);
        if (!item.pasted) row.append(button(item.paused ? "재개" : "일시 정지", () => request("agent-toggle", { item:item.id }).catch(error => report(String(error)))));
        row.append(button("취소", () => request("agent-cancel", { item:item.id }).catch(error => report(String(error)))));
        queue.append(row);
      }
      report(value.message ?? "");
    },
    close() {
      for (const node of panel.querySelectorAll("input, textarea, button")) node.disabled = true;
      state.textContent = "종료됨";
    }
  };
};
