"use strict";
window.wincmuxViewerExtensions = (trigger, onChange) => {
  const names = ["md", "mdx", "txt", "py", "ipynb", "html", "htm", "css", "js", "jsx", "ts", "tsx", "json", "yaml", "yml", "toml", "xml", "csv", "sql", "rs", "go", "java", "rb", "c", "cpp", "h", "sh", "ps1", "log", "ini", "pdf", "doc", "docx", "xlsx", "pptx", "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp"];
  const key = "wincmux.viewer.extensions";
  const selected = new Set((localStorage.getItem(key) || "").split(",").filter(name => names.includes(name)));
  const dialog = document.createElement("dialog");
  dialog.className = "viewer-extension-dialog";
  dialog.setAttribute("aria-label", "확장자 선택");
  const heading = document.createElement("h2");
  heading.textContent = "표시할 확장자 선택";
  const description = document.createElement("p");
  description.textContent = "여러 확장자를 선택할 수 있습니다. 선택하지 않으면 모든 파일을 표시합니다.";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "확장자 찾기";
  search.setAttribute("aria-label", "확장자 찾기");
  const options = document.createElement("div");
  options.className = "viewer-extension-options";
  const count = document.createElement("span");
  count.className = "viewer-extension-count";
  const actions = document.createElement("div");
  actions.className = "viewer-extension-actions";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "선택 해제";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "취소";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = "적용";
  apply.className = "viewer-extension-apply";
  actions.append(count, clear, cancel, apply);
  dialog.append(heading, description, search, options, actions);
  document.body.append(dialog);
  const inputs = new Map();
  const updateCount = () => { count.textContent = `${[...inputs.values()].filter(input => input.checked).length}개 선택`; };
  for (const name of names) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = name;
    input.addEventListener("change", updateCount);
    label.append(input, document.createTextNode(` .${name}`));
    options.append(label);
    inputs.set(name, input);
  }
  const updateTrigger = () => {
    trigger.textContent = selected.size ? `확장자 · ${selected.size}개` : "확장자 · 전체";
    trigger.title = selected.size ? `선택한 확장자: ${[...selected].join(", ")}` : "모든 확장자 표시";
    trigger.setAttribute("aria-label", trigger.title);
    trigger.classList.toggle("is-filtered", selected.size > 0);
  };
  trigger.addEventListener("click", () => {
    for (const [name, input] of inputs) input.checked = selected.has(name);
    search.value = "";
    for (const label of options.children) label.hidden = false;
    updateCount();
    dialog.showModal();
    search.focus();
  });
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase().replace(/^\./, "");
    for (const label of options.children) label.hidden = !label.querySelector("input").value.includes(query);
  });
  clear.addEventListener("click", () => { for (const input of inputs.values()) input.checked = false; updateCount(); });
  cancel.addEventListener("click", () => dialog.close());
  apply.addEventListener("click", () => {
    selected.clear();
    for (const [name, input] of inputs) if (input.checked) selected.add(name);
    localStorage.setItem(key, [...selected].join(","));
    updateTrigger();
    dialog.close();
    onChange();
  });
  dialog.addEventListener("close", () => trigger.focus());
  updateTrigger();
  return { values: () => [...selected] };
};
