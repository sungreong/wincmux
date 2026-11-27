"use strict";
window.wincmuxFolderRules = ({key, paths, trigger, workspaceName, changed}) => {
  const defaults = [".git","node_modules","target",".venv","venv","dist","build",".next",".nuxt",".turbo",".parcel-cache",".cache",".gradle","__pycache__",".pytest_cache",".mypy_cache",".ruff_cache","coverage"];
  function read() {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(key() + ".rules") || "[]"); } catch {}
    const rules = new Map(defaults.map(value => ["name/" + value, {kind:"name", value, search:true, hide:false}]));
    const hidden = new Set(paths());
    for (const row of Array.isArray(saved) ? saved : []) {
      if (!row || !["name","path"].includes(row.kind) || typeof row.value !== "string") continue;
      rules.set(row.kind + "/" + row.value, {...row, hide: row.kind === "path" ? hidden.has(row.value) : row.hide});
    }
    for (const value of hidden) {
      if (!rules.has("path/" + value)) rules.set("path/" + value, {kind:"path", value, search:true, hide:true});
    }
    return [...rules.values()];
  }
  const tr = text => window.wincmuxI18n?.t(text) || text;
  trigger.classList.add("viewer-rules-trigger");
  trigger.innerHTML = `<span class="rule-trigger-title">폴더 제외·숨김 설정</span>
    <span class="rule-trigger-counts"><span>검색 제외 <b></b></span><span>목록 숨김 <b></b></span></span>`;
  const [searchCount, hiddenCount] = trigger.querySelectorAll("b");
  function refresh() {
    const rows = read();
    searchCount.textContent = rows.filter(row => row.search).length;
    hiddenCount.textContent = rows.filter(row => row.hide).length;
  }
  const dialog = document.createElement("dialog");
  dialog.className = "viewer-hidden-dialog viewer-rule-dialog";
  dialog.setAttribute("aria-label", "폴더 제외·숨김 설정");
  dialog.innerHTML = `<h2>폴더 제외·숨김 설정</h2><p data-workspace data-i18n-ignore></p>
    <input type="search" placeholder="번호·이름·경로 검색" aria-label="번호·이름·경로 검색">
    <div class="rule-bulk"><button type="button" data-bulk>검색 제외 항목을 목록에서도 숨기기</button><button type="button" data-reset>기본값 복원</button></div>
    <div class="rule-scroll"><table><thead><tr><th>이름 또는 경로</th><th><label><input type="checkbox" data-all="search"> 검색 제외</label></th><th><label><input type="checkbox" data-all="hide"> 목록 숨김</label></th></tr></thead><tbody></tbody></table></div>
    <form><select aria-label="규칙 종류"><option value="name">폴더 이름</option><option value="path">특정 경로</option></select><input required placeholder="이름 또는 경로" aria-label="이름 또는 경로"><button>추가</button></form>
    <div class="viewer-folder-actions"><button type="button" data-cancel>취소</button><button type="button" data-apply>적용</button></div>`;
  document.body.append(dialog);
  const find = selector => dialog.querySelector(selector);
  const filter = find('[type=search]');
  let draft, openedKey;
  function render() {
    const body = find("tbody");
    body.replaceChildren();
    const q = filter.value.trim().toLowerCase();
    for (const box of dialog.querySelectorAll("[data-all]")) {
      const flag = box.dataset.all;
      box.checked = draft.every(r=>r[flag]);
      box.indeterminate = !box.checked && draft.some(r=>r[flag]);
      box.onchange = () => { for (const row of draft) row[flag] = box.checked; render(); };
    }
    draft.forEach((row,i) => {
      if (/^\d+\.?$/.test(q) ? Number.parseInt(q,10)!==i+1 : !row.value.toLowerCase().includes(q)) return;
      const line = body.insertRow();
      const title = line.insertCell();
      title.setAttribute("data-i18n-ignore","");
      title.textContent = (i+1) + ". " + row.value;
      const kind = document.createElement("small");
      kind.textContent = tr(row.kind === "name" ? "폴더 이름" : "특정 경로");
      title.append(kind);
      for (const flag of ["search","hide"]) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = row[flag];
        box.setAttribute("aria-label", row.value + " · " + tr(flag === "search" ? "검색 제외" : "목록 숨김"));
        box.onchange = () => {
          row[flag] = box.checked;
          const all = find('[data-all="' + flag + '"]');
          all.checked = draft.every(r=>r[flag]);
          all.indeterminate = !all.checked && draft.some(r=>r[flag]);
        };
        line.insertCell().append(box);
      }
    });
    if (!body.rows.length) body.insertRow().insertCell().textContent = tr("검색 결과가 없습니다.");
  }
  trigger.onclick = () => {
    openedKey = key(); draft = read(); filter.value = ""; find("form").reset();
    find("[data-workspace]").textContent = workspaceName();
    render(); dialog.showModal(); filter.focus();
  };
  filter.oninput = render;
  find("[data-bulk]").onclick = () => { for (const row of draft) if (row.search) row.hide = true; render(); };
  find("[data-reset]").onclick = () => { draft = defaults.map(value=>({kind:"name",value,search:true,hide:false})); render(); };
  find("form").onsubmit = event => {
    event.preventDefault();
    const field = find("form input");
    const value = field.value.trim().replaceAll("\\","/");
    const kind = find("select").value;
    if (!value || value.length > 512 || value.split("/").some(part=>!part || part==="." || part==="..") || (kind==="name" && value.includes("/"))) {
      field.setCustomValidity(tr("워크스페이스 안의 이름 또는 상대 경로를 입력하세요.")); field.reportValidity(); return;
    }
    if (!draft.some(row=>row.kind===kind && row.value===value)) draft.push({kind,value,search:false,hide:true});
    filter.value = value; field.value = ""; render();
  };
  find("form input").oninput = event => event.target.setCustomValidity("");
  find("[data-cancel]").onclick = () => dialog.close();
  find("[data-apply]").onclick = () => {
    if (openedKey === key()) {
      localStorage.setItem(key()+".rules",JSON.stringify(draft.filter(r=>r.search || r.hide || defaults.includes(r.value))));
      localStorage.setItem(key(),JSON.stringify(draft.filter(r=>r.kind==="path" && r.hide).map(r=>r.value)));
      refresh(); dialog.close(); changed();
    } else dialog.close();
  };
  return { refresh, read };
};
