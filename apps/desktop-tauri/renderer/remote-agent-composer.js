"use strict";
window.wincmuxRemoteComposer = (request, button, provider = "codex") => {
  const panel = document.createElement("form");
  panel.className = "remote-composer";
  const input = document.createElement("textarea");
  input.rows = 1;
  input.placeholder = "메시지 입력 (Ctrl+Enter로 전송 또는 대기열 추가)";
  input.setAttribute("aria-label", "에이전트 메시지");
  const commands = window.wincmuxAgentCommandInput.create(input, provider, true);
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
  let handedOff = false;
  let items = [];
  async function send(action) {
    if (handedOff || pending || !input.value.trim()) return;
    const commandMode = commands.mode() === "command";
    if (commandMode && action !== "agent-submit") return;
    if (!commandMode && action === "agent-submit" && items.length >= 32) return report("대기 입력은 최대 32개입니다.");
    const due_at = !commandMode && !due.hidden && due.value ? new Date(due.value).getTime() : undefined;
    if (due_at !== undefined && (!Number.isFinite(due_at) || due_at <= Date.now())) return report("현재 이후의 예약 시각을 선택하세요.");
    const draft = input.value;
    try {
      const text = commands.prepare(draft);
      pending = true;
      await request(commandMode ? "agent-command" : action, { text, due_at });
      if (input.value === draft) input.value = "";
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
  const syncMode = () => {
    const commandMode = commands.mode() === "command";
    submit.textContent = commandMode ? "CLI 명령 실행" : "전송 / 대기열";
    insert.disabled = toggle.disabled = commandMode;
    if (commandMode) due.hidden = true;
  };
  commands.panel.addEventListener("change", syncMode);
  syncMode();
  actions.append(insert, toggle, due, submit);
  panel.append(queue, input, commands.panel, message, actions);
  panel.addEventListener("submit", event => event.preventDefault());
  input.addEventListener("keydown", event => {
    if (!event.isComposing && event.keyCode !== 229 && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send("agent-submit");
    }
  });
  return {
    panel, state,
    handoff() {
      handedOff = true;
      state.remove();
      queue.remove();
      actions.remove();
      commands.panel.remove();
      if (input.value.trim()) {
        input.readOnly = true;
        input.setAttribute("aria-label", "종료된 에이전트의 미전송 초안");
        report("에이전트가 종료되어 초안이 전송되지 않았습니다. 필요하면 복사해 사용하세요.");
      } else {
        panel.remove();
      }
    },
    update(value) {
      const status = { working:"작업 중", idle:"입력 가능", done:"작업 완료", blocked:"확인 필요", error:"오류", unknown:"상태 확인 중" };
      state.textContent = status[value.state] ?? "상태 확인 중";
      state.title = value.hook?.received
        ? `${value.hook.provider === 'claude' ? 'Claude Code' : 'Codex'} 훅 수신 · ${value.hook.count}회 · 최근 ${value.hook.last_event}`
        : value.source === "pattern" && value.state === "done" ? "터미널에서 작업 완료를 감지했습니다." : "훅 수신 전 · 터미널 출력으로 상태를 감지합니다.";
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
        if (!item.pasted) {
          const sendNow = button("↑ 지금 보내기", () => {
            sendNow.disabled = true;
            request("agent-send-now", { item:item.id }).catch(error => { report(String(error)); sendNow.disabled = false; });
          });
          sendNow.title = "대기 순서를 건너뛰고 터미널에 즉시 입력합니다. 에이전트 수신은 확인되지 않을 수 있습니다.";
          row.append(sendNow, button(item.paused ? "재개" : "일시 정지", () => request("agent-toggle", { item:item.id }).catch(error => report(String(error)))));
        }
        row.append(button("취소", () => request("agent-cancel", { item:item.id }).catch(error => report(String(error)))));
        queue.append(row);
      }
      report(value.message ?? "");
    },
    close() {
      for (const node of panel.querySelectorAll("input, textarea, button, select")) node.disabled = true;
      state.textContent = "종료됨";
    }
  };
};
