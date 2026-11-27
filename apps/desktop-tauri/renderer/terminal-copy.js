"use strict";
window.wincmuxTerminalCopy = (() => {
  const tr = text => window.wincmuxI18n?.t(text) || text;
  const notices = new WeakMap();
  let closeActiveCopy;
  function notice(term, text) {
    const host = term.element;
    if (!host?.isConnected) return;
    const last = notices.get(host);
    if (last) { clearTimeout(last.timer); last.node.remove(); }
    const node = document.createElement("div");
    node.className = "terminal-copy-notice";
    node.setAttribute("role", "status");
    node.textContent = tr(text);
    host.append(node);
    const timer = setTimeout(() => { node.remove(); notices.delete(host); }, 4500);
    notices.set(host, {node, timer});
  }
  function screenText(term) {
    const buffer = term.buffer.active;
    const lines = [];
    for (let y = buffer.viewportY; y < buffer.viewportY + term.rows; y++) {
      const line = buffer.getLine(y);
      if (!line) break;
      const wraps = y + 1 < buffer.viewportY + term.rows && buffer.getLine(y + 1)?.isWrapped;
      const text = line.translateToString(!wraps);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join("\r\n");
  }
  function button(getTerm, write, selection = term => term.getSelection()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "terminal-copy-button";
    btn.textContent = "복사";
    btn.title = "선택한 글자 또는 현재 보이는 터미널 출력 복사";
    btn.addEventListener("mousedown", event => event.preventDefault());
    btn.onclick = async event => {
      event.stopPropagation();
      const term = getTerm();
      if (!term) return;
      const selected = selection(term);
      const text = selected || screenText(term);
      if (!text) return notice(term, "복사할 터미널 출력이 없습니다.");
      try {
        await write(text);
        notice(term, selected ? "선택한 글자를 복사했습니다." : "현재 보이는 터미널 출력을 복사했습니다.");
      } catch (error) { notice(term, String(error?.message ?? error)); }
    };
    return btn;
  }
  function bindDragCopy(term, write, selection = term => term.getSelection()) {
    const host = term.element;
    const screen = host.querySelector(".xterm-screen");
    const popup = document.createElement("button");
    popup.type = "button";
    popup.popover = "manual";
    popup.className = "terminal-selection-copy";
    popup.textContent = "복사";
    let selected = "";
    let drag;
    let dismiss;
    function close() {
      dismiss?.abort();
      popup.remove();
      selected = "";
      if (closeActiveCopy === close) closeActiveCopy = null;
    }
    function show(text, end) {
      closeActiveCopy?.();
      selected = text;
      closeActiveCopy = close;
      document.body.append(popup);
      popup.showPopover();
      popup.style.left = Math.max(0, Math.min(end.clientX+6, innerWidth-popup.offsetWidth))+"px";
      popup.style.top = Math.max(0, end.clientY+8+popup.offsetHeight < innerHeight
        ? end.clientY+8 : end.clientY-popup.offsetHeight-6)+"px";
      dismiss = new AbortController();
      const options = {capture:true, signal:dismiss.signal};
      document.addEventListener("pointerdown", event => {
        if (!popup.contains(event.target)) close();
      }, options);
      document.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }, options);
    }
    // Keep focus in xterm so pressing the button doesn't clear its selection.
    popup.addEventListener("mousedown", event => { event.preventDefault(); event.stopPropagation(); });
    popup.onclick = async event => {
      event.stopPropagation();
      const text = selected;
      close();
      if (!text) return;
      try { await write(text); notice(term, "선택한 글자를 복사했습니다."); }
      catch (error) { notice(term, String(error?.message ?? error)); }
    };
    function offset(event) {
      const rect = screen.getBoundingClientRect();
      const x = Math.max(0, Math.min(term.cols, Math.round((event.clientX-rect.left)*term.cols/rect.width)));
      const y = Math.max(0, Math.min(term.rows-1, Math.floor((event.clientY-rect.top)*term.rows/rect.height)));
      return (term.buffer.active.viewportY+y)*term.cols + x;
    }
    host.addEventListener("pointerdown", event => {
      if (event.target === popup || event.button !== 0 || event.pointerType === "touch") return;
      drag?.abort();
      drag = new AbortController();
      const {signal} = drag;
      const start = screen.contains(event.target) ? offset(event) : null;
      const buffer = term.buffer.active;
      const cols = term.cols;
      const up = end => {
        if (end.pointerId !== event.pointerId) return;
        drag.abort();
        if (!host.isConnected || Math.hypot(end.clientX-event.clientX,end.clientY-event.clientY)<4) return;
        if (!term.hasSelection() && term.modes.mouseTrackingMode !== "none") {
          if (start !== null && buffer === term.buffer.active && cols === term.cols && screen.contains(end.target)) {
            const finish = offset(end);
            const first = Math.min(start,finish);
            if (finish !== start) term.select(first % cols, Math.floor(first/cols), Math.abs(finish-start));
          }
          if (!term.hasSelection()) {
            notice(term, "화면 전체는 위쪽 복사 버튼, 일부는 Shift를 누르고 드래그하세요.");
            return;
          }
        }
        const snapshot = selection(term);
        // xterm can finalize the selection on mouseup or clear it on fresh output.
        setTimeout(() => {
          const text = snapshot || selection(term);
          if (host.isConnected && text) show(text, end);
        }, 0);
      };
      window.addEventListener("pointerup", up, {capture:true, signal});
      window.addEventListener("pointercancel", () => drag.abort(), {signal});
      window.addEventListener("blur", () => drag.abort(), {signal});
    }, true);
  }
  return {button, bindDragCopy};
})();
