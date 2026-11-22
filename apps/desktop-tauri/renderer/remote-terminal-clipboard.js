"use strict";
window.wincmuxRemoteTerminalClipboard = (event, term, write, report) => {
  if (event.type !== "keydown" || event.isComposing || event.keyCode === 229 ||
      !event.ctrlKey || event.altKey || event.metaKey ||
      !(event.code === "KeyC" || event.key?.toLowerCase() === "c") ||
      !(event.shiftKey || term.hasSelection())) return true;
  event.preventDefault();
  const selected = term.getSelection();
  if (selected) Promise.resolve().then(() => write(selected)).catch(report);
  return false;
};
