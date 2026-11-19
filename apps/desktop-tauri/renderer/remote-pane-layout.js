"use strict";
(() => {
  function mount(root, pane, anchor, direction) {
    if (!anchor) {
      root.append(pane);
      return;
    }
    const split = document.createElement("div");
    split.className = "pane-split";
    split.dataset.direction = direction;
    const divider = document.createElement("div");
    divider.className = "pane-split-divider";
    divider.tabIndex = 0;
    divider.setAttribute("role", "separator");
    const right = direction === "right";
    divider.setAttribute("aria-orientation", right ? "vertical" : "horizontal");
    divider.setAttribute("aria-label", "분할 pane 크기 조절");
    anchor.replaceWith(split);
    split.append(anchor, divider, pane);

    const extent = () => right ? split.clientWidth : split.clientHeight;
    const resize = size => {
      const total = extent() - (right ? divider.offsetWidth : divider.offsetHeight);
      if (total <= 0) return;
      const min = Math.min(170, total / 2);
      const first = Math.max(min, Math.min(total - min, size));
      split.style.setProperty("--split-first", `${first}px`);
      split.style.setProperty("--split-grow", "0");
    };
    window.wincmuxViewerPanel.bindDivider(divider, event => {
      const rect = split.getBoundingClientRect();
      resize(right ? event.clientX - rect.left : event.clientY - rect.top);
    }, delta => resize((right ? anchor.clientWidth : anchor.clientHeight) + delta));
    divider.addEventListener("dblclick", () => reset(split));
  }

  function remove(pane) {
    const parent = pane.parentElement;
    if (!parent?.classList.contains("pane-split")) {
      pane.remove();
      return;
    }
    const sibling = parent.firstElementChild === pane ? parent.lastElementChild : parent.firstElementChild;
    parent.replaceWith(sibling);
  }

  function reset(split) {
    split.style.removeProperty("--split-first");
    split.style.removeProperty("--split-grow");
  }

  window.wincmuxRemoteLayout = { mount, remove, reset };
})();
