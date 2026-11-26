"use strict";
window.wincmuxViewerFolderPicker = ({ trigger, getFolders, getKey, onChange }) => {
  const dialog = document.createElement("dialog");
  dialog.className = "viewer-folder-dialog";
  dialog.setAttribute("aria-label", "볼 폴더 선택");
  const title = document.createElement("h2");
  title.textContent = "볼 폴더 선택";
  const description = document.createElement("p");
  description.textContent = "등록한 폴더 중 하나 또는 여러 개를 선택할 수 있습니다.";
  const allLabel = document.createElement("label");
  const allRadio = document.createElement("input");
  allRadio.type = "radio";
  allRadio.name = `viewer-folder-${Math.random().toString(36).slice(2)}`;
  allRadio.value = "all";
  allLabel.append(allRadio, document.createTextNode(" 작업공간 전체"));
  const savedLabel = document.createElement("label");
  const savedRadio = document.createElement("input");
  savedRadio.type = "radio";
  savedRadio.name = allRadio.name;
  savedRadio.value = "saved";
  savedLabel.append(savedRadio, document.createTextNode(" 등록한 폴더 중 선택"));
  const folders = document.createElement("div");
  folders.className = "viewer-folder-choices";
  const error = document.createElement("div");
  error.className = "viewer-folder-error";
  error.setAttribute("role", "alert");
  const actions = document.createElement("div");
  actions.className = "viewer-folder-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "취소";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = "적용";
  actions.append(cancel, apply);
  dialog.append(title, description, allLabel, savedLabel, folders, error, actions);
  document.body.append(dialog);
  const state = () => {
    try {
      const value = JSON.parse(localStorage.getItem(`${getKey()}.scope`) || "null");
      return value && value.mode === "saved" && Array.isArray(value.paths) ? value : { mode: "all", paths: [] };
    } catch { return { mode: "all", paths: [] }; }
  };
  const activePaths = () => {
    if (state().mode !== "saved") return [];
    const available = getFolders();
    const selected = state().paths.filter(path => available.includes(path));
    return selected.length ? selected : available.slice(0, 1);
  };
  const refresh = () => {
    const available = getFolders();
    const count = activePaths().length;
    trigger.textContent = state().mode === "saved" ? `선택 폴더 ${count}/${available.length} ▾` : "전체 폴더 ▾";
    trigger.title = state().mode === "saved" ? `볼 폴더: ${activePaths().join(", ")}` : "작업공간 전체 보기 · 클릭하여 등록 폴더 선택";
    trigger.setAttribute("aria-label", trigger.title);
  };
  const updateChoices = () => {
    const enabled = savedRadio.checked;
    for (const input of folders.querySelectorAll("input")) input.disabled = !enabled;
    folders.classList.toggle("is-disabled", !enabled);
    error.textContent = "";
  };
  trigger.addEventListener("click", () => {
    const current = state();
    allRadio.checked = current.mode !== "saved";
    savedRadio.checked = current.mode === "saved";
    folders.replaceChildren();
    const available = getFolders();
    if (!available.length) folders.textContent = "등록한 폴더가 없습니다. 파일 트리에서 폴더를 등록하세요.";
    for (const path of available) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = path;
      input.checked = current.mode === "saved" ? activePaths().includes(path) : true;
      const name = document.createElement("span");
      name.textContent = path;
      name.title = path;
      label.append(input, name);
      folders.append(label);
    }
    updateChoices();
    dialog.showModal();
  });
  allRadio.addEventListener("change", updateChoices);
  savedRadio.addEventListener("change", updateChoices);
  cancel.addEventListener("click", () => dialog.close());
  apply.addEventListener("click", () => {
    const paths = [...folders.querySelectorAll("input:checked")].map(input => input.value);
    if (savedRadio.checked && !paths.length) { error.textContent = "볼 폴더를 하나 이상 선택하세요."; return; }
    localStorage.setItem(`${getKey()}.scope`, JSON.stringify({ mode: savedRadio.checked ? "saved" : "all", paths }));
    refresh();
    dialog.close();
    onChange();
  });
  dialog.addEventListener("close", () => trigger.focus());
  refresh();
  return { mode: () => state().mode, activePaths, refresh };
};
