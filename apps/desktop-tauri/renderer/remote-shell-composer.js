"use strict";
window.wincmuxRemoteShellComposer = (request, button) => {
  const panel = document.createElement("form");
  panel.className = "remote-composer remote-shell-composer";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "셸 명령 입력 (Ctrl+Enter로 실행)";
  input.setAttribute("aria-label", "셸 명령");
  const message = document.createElement("span");
  message.className = "remote-composer-message";
  message.setAttribute("role", "status");
  message.hidden = true;
  let composing = false;
  let pending = false;
  let closed = false;
  const report = error => {
    message.textContent = error;
    message.hidden = !error;
  };
  const send = async () => {
    if (composing || pending || closed) return;
    const command = input.value.replace(/\r\n?/g, "\n");
    if (!command.trim()) return;
    if (/[\x00-\x1f\x7f]/.test(command)) return report("한 줄 명령만 실행할 수 있습니다. 줄바꿈을 지운 뒤 다시 시도하세요.");
    pending = true;
    submit.disabled = true;
    report("");
    try {
      await request(`${command}\r`);
      if (input.value === command) input.value = "";
    } catch (error) {
      report(String(error));
    } finally {
      pending = false;
      submit.disabled = closed;
    }
  };
  const submit = button("실행", send);
  const actions = document.createElement("div");
  actions.className = "remote-composer-actions";
  actions.append(submit);
  panel.append(input, message, actions);
  panel.addEventListener("submit", event => event.preventDefault());
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !composing) {
      event.preventDefault();
      void send();
    }
  });
  return {
    panel, input,
    close() { closed = true; input.disabled = submit.disabled = true; }
  };
};
