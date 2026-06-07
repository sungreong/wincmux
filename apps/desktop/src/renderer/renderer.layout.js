function saveSplitRatios() {
  localStorage.setItem(STORAGE_KEYS.splitRatios, JSON.stringify(state.splitRatios));
}

function applyStoredSplitRatio(firstEl, secondEl, splitKey, direction) {
  const ratio = state.splitRatios[splitKey];
  if (!ratio || ratio <= 0 || ratio >= 1) {
    return;
  }

  window.requestAnimationFrame(() => {
    const firstRect = firstEl.getBoundingClientRect();
    const secondRect = secondEl.getBoundingClientRect();
    const total = direction === "horizontal"
      ? firstRect.width + secondRect.width
      : firstRect.height + secondRect.height;
    if (total <= 0) {
      return;
    }
    firstEl.style.flex = `0 0 ${Math.round(total * ratio)}px`;
    secondEl.style.flex = "1 1 0";
    fitAllPanes();
  });
}

function makeSplitResizable(splitEl, firstEl, secondEl, divider, direction, splitKey) {
  divider.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();

    const startX = ev.clientX;
    const startY = ev.clientY;
    const firstRect = firstEl.getBoundingClientRect();
    const secondRect = secondEl.getBoundingClientRect();

    const minSize = 180;
    const startFirstSize = direction === "horizontal" ? firstRect.width : firstRect.height;
    const totalSize = direction === "horizontal"
      ? firstRect.width + secondRect.width
      : firstRect.height + secondRect.height;
    let pendingFirstSize = startFirstSize;
    let dragRaf = null;

    splitEl.classList.add("resizing");

    const flushDragResize = () => {
      dragRaf = null;
      const nextFirst = pendingFirstSize;
      firstEl.style.flex = `0 0 ${nextFirst}px`;
      secondEl.style.flex = "1 1 0";
      fitAllPanes();
    };

    const scheduleDragResize = () => {
      if (dragRaf) {
        return;
      }
      dragRaf = window.requestAnimationFrame(flushDragResize);
    };

    const onMove = (moveEvent) => {
      const delta = direction === "horizontal"
        ? moveEvent.clientX - startX
        : moveEvent.clientY - startY;

      pendingFirstSize = Math.max(minSize, Math.min(totalSize - minSize, startFirstSize + delta));
      scheduleDragResize();
    };

    const onUp = () => {
      splitEl.classList.remove("resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (dragRaf) {
        window.cancelAnimationFrame(dragRaf);
        flushDragResize();
      }
      const firstRect = firstEl.getBoundingClientRect();
      const secondRect = secondEl.getBoundingClientRect();
      const total = direction === "horizontal"
        ? firstRect.width + secondRect.width
        : firstRect.height + secondRect.height;
      const ratio = total > 0 ? (direction === "horizontal" ? firstRect.width / total : firstRect.height / total) : 0.5;
      state.splitRatios[splitKey] = ratio;
      saveSplitRatios();
      fitAllPanes();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

globalThis.applyStoredSplitRatio = applyStoredSplitRatio;
globalThis.makeSplitResizable = makeSplitResizable;
