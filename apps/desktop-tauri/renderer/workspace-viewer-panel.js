"use strict";
(() => {
  function bindDivider(handle, move, step) {
    let active;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || active !== undefined) return;
      active = event.pointerId;
      handle.setPointerCapture(active);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", event => {
      if (event.pointerId === active) move(event);
    });
    handle.addEventListener("lostpointercapture", event => {
      if (event.pointerId === active) active = undefined;
    });
    if (step) {
      handle.addEventListener("keydown", event => {
        const delta = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
        if (!delta) return;
        event.preventDefault();
        step(delta * 24);
      });
    }
  }

  function setOpen({ button, content, panel, divider }, open) {
    content.classList.toggle("viewer-open", open);
    panel.hidden = !open;
    divider.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-pressed", String(open));
  }

  function bindViewerWidth(content, panel, divider, refit) {
    const resize = width => {
      const max = Math.max(260, content.clientWidth - 300);
      content.style.setProperty("--viewer-width", `${Math.round(Math.min(Math.max(width, 260), max))}px`);
      refit?.();
    };
    bindDivider(divider, event => resize(content.getBoundingClientRect().right - event.clientX),
      delta => resize(panel.getBoundingClientRect().width - delta));
  }

  window.wincmuxViewerPanel = { setOpen, bindDivider, bindViewerWidth };
})();
