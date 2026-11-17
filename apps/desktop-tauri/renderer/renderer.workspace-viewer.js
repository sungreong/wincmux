// A small, on-demand companion pane. It creates no terminal and loads only open folders.
(() => {
  const $v = (id) => document.getElementById(id);
  const viewer = { open: false, tab: "files", workspaceId: null, selected: null, copied: null, previewText: null, generation: 0, listGeneration: 0, expandedByWorkspace: new Map(), agentCollapsedByWorkspace: new Map(), searchFolder: null };
  const expanded = () => {
    if (!viewer.expandedByWorkspace.has(viewer.workspaceId)) viewer.expandedByWorkspace.set(viewer.workspaceId, new Set());
    return viewer.expandedByWorkspace.get(viewer.workspaceId);
  };
  const collapsedAgentGroups = () => {
    if (!viewer.agentCollapsedByWorkspace.has(viewer.workspaceId)) viewer.agentCollapsedByWorkspace.set(viewer.workspaceId, new Set());
    return viewer.agentCollapsedByWorkspace.get(viewer.workspaceId);
  };
  const activeList = () => $v(viewer.tab === "git" ? "viewerGitList" : viewer.tab === "agents" ? "viewerAgentList" : "viewerTree");
  const identity = (item) => `${item?.section || viewer.tab}:${item?.relativePath ?? ""}`;
  const restoreSelection = (previous, list) => {
    if (!previous) return;
    const row = [...list.querySelectorAll(".workspace-viewer-row")].find((el) => el.viewerItem && identity(el.viewerItem) === previous);
    if (row) select(row.viewerItem);
    else { viewer.selected = null; viewer.previewText = null; updateActions(); }
  };
  const updateScope = () => {
    $v("viewerSearchScope").disabled = !viewer.searchFolder;
    if (!viewer.searchFolder) $v("viewerSearchScope").checked = false;
    $v("viewerScopeName").textContent = viewer.searchFolder ? `(${viewer.searchFolder})` : "";
  };
  const message = (text) => { $v("viewerMessage").textContent = text; };
  const workspace = () => selectedWorkspace();
  const call = (action, payload = {}) => {
    const ws = workspace();
    if (!ws) throw new Error("워크스페이스를 선택하세요.");
    return window.wincmux.viewerAction(action, ws.path, payload);
  };
  const fullPath = (rel) => rel ? `${workspace().path.replace(/[\\/]$/, "")}\\${rel.replaceAll("/", "\\")}` : workspace().path;
  const showError = (error) => message(String(error?.message ?? error));

  function renderDiff(body, value) {
    if (!value) { body.textContent = "표시할 diff가 없습니다."; return; }
    const lines = value.split("\n");
    const fragment = document.createDocumentFragment();
    const diff = document.createElement("div");
    diff.className = "workspace-viewer-diff";
    for (const line of lines.slice(0, 5000)) {
      const row = document.createElement("div");
      row.className = "workspace-viewer-diff-line";
      if (line.startsWith("+") && !line.startsWith("+++")) row.classList.add("added");
      else if (line.startsWith("-") && !line.startsWith("---")) row.classList.add("removed");
      else if (line.startsWith("@@")) row.classList.add("hunk");
      else if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(line)) row.classList.add("meta");
      const text = document.createElement("span");
      text.textContent = line || " ";
      row.append(text);
      fragment.append(row);
    }
    diff.append(fragment);
    body.append(diff);
    if (lines.length > 5000) {
      const note = document.createElement("div");
      note.className = "workspace-viewer-note";
      note.textContent = "처음 5,000줄만 표시합니다.";
      body.append(note);
    }
  }

  function updateActions() {
    const selected = viewer.selected;
    $v("viewerCopyPath").disabled = !selected;
    $v("viewerCopyContent").disabled = viewer.previewText == null;
    $v("viewerCopyFile").disabled = !selected || selected.directory;
    $v("viewerPasteFile").disabled = !viewer.copied || !selected?.directory;
    const rows = [...activeList().querySelectorAll(".workspace-viewer-row")].filter((row) => row.viewerItem && row.getClientRects().length);
    const index = rows.findIndex((row) => row.viewerItem === selected);
    $v("viewerPrevious").disabled = index <= 0;
    $v("viewerNext").disabled = index < 0 || index >= rows.length - 1;
  }

  function navigate(delta) {
    const rows = [...activeList().querySelectorAll(".workspace-viewer-row")].filter((row) => row.viewerItem && row.getClientRects().length);
    const index = rows.findIndex((row) => row.viewerItem === viewer.selected);
    const next = rows[index + delta];
    if (next) { select(next.viewerItem); next.focus(); next.scrollIntoView({ block: "nearest" }); }
  }

  function select(item) {
    ++viewer.generation;
    viewer.selected = item;
    viewer.previewText = null;
    $v("viewerPreviewTitle").textContent = item.relativePath || workspace()?.path || "";
    $v("viewerPreview").replaceChildren();
    document.querySelectorAll(".workspace-viewer-row.selected").forEach((el) => el.classList.remove("selected"));
    item.element?.classList.add("selected");
    if (viewer.tab === "files" && item.directory) { viewer.searchFolder = item.relativePath || null; updateScope(); }
    updateActions();
    if (item.directory) {
      $v("viewerPreview").textContent = "폴더를 펼쳐 파일을 선택하세요.";
      return;
    }
    const generation = viewer.generation;
    $v("viewerPreview").textContent = "읽는 중…";
    const task = viewer.tab === "git"
      ? (item.section === "untracked" ? call("viewer-preview", { relativePath: item.relativePath }) : call("viewer-git-diff", { relativePath: item.relativePath, section: item.section }))
      : viewer.tab === "agents" ? window.wincmux.agentAssetRead(workspace().path, item.relativePath).then((result) => ({ kind: "text", text: result.content ?? "" }))
      : call("viewer-preview", { relativePath: item.relativePath });
    task.then((result) => {
      if (generation !== viewer.generation || !viewer.open) return;
      const body = $v("viewerPreview");
      body.replaceChildren();
      if (result.kind === "image") {
        const image = document.createElement("img");
        image.src = result.dataUrl;
        image.alt = item.relativePath;
        body.append(image);
      } else if (result.kind === "text") {
        if (viewer.tab === "git" && item.section !== "untracked") {
          renderDiff(body, result.text);
        } else {
          const pre = document.createElement("pre");
          pre.textContent = result.text || "빈 파일";
          body.append(pre);
          if (viewer.tab === "agents" && item.editable) {
            const edit = document.createElement("button");
            edit.type = "button";
            edit.textContent = "편집";
            edit.addEventListener("click", () => {
              const editor = document.createElement("textarea");
              editor.className = "workspace-viewer-agent-editor";
              editor.value = result.text;
              const save = document.createElement("button");
              save.type = "button";
              save.textContent = "저장";
              save.addEventListener("click", async () => {
                save.disabled = true;
                try {
                  await window.wincmux.agentAssetWrite(workspace().path, item.relativePath, editor.value);
                  message("Agent 파일을 저장했습니다.");
                  select(item);
                } catch (error) { save.disabled = false; showError(error); }
              });
              body.replaceChildren(editor, save);
              editor.focus();
            });
            body.prepend(edit);
          }
        }
        viewer.previewText = result.text;
      } else {
        body.textContent = result.kind === "large" ? "미리보기 크기 제한을 넘었습니다." : "이 파일은 미리보기를 지원하지 않습니다.";
      }
      updateActions();
    }).catch((error) => { if (generation === viewer.generation) showError(error); });
  }

  function makeRow(item, depth) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-viewer-row";
    button.style.paddingLeft = `${8 + depth * 15}px`;
    button.textContent = `${item.directory ? "▸ 📁" : item.symlink ? "↗" : "·"} ${item.name}`;
    button.title = item.relativePath;
    item.element = button;
    button.viewerItem = item;
    if (!item.directory) {
      button.addEventListener("click", () => select(item));
      return button;
    }
    const wrap = document.createElement("div");
    const children = document.createElement("div");
    wrap.append(button, children);
    let isExpanded = false;
    let loaded = false;
    const toggle = async (force = false) => {
      if (!force) select(item);
      isExpanded = force ? true : !isExpanded;
      if (isExpanded) expanded().add(item.relativePath); else expanded().delete(item.relativePath);
      button.textContent = `${isExpanded ? "▾" : "▸"} 📁 ${item.name}`;
      children.hidden = !isExpanded;
      if (!isExpanded || loaded) return;
      const wsId = viewer.workspaceId;
      button.disabled = true;
      try {
        const result = await call("viewer-list", { relativePath: item.relativePath });
        if (viewer.workspaceId !== wsId) return;
        for (const child of result.items) {
          children.append(makeRow(child, depth + 1));
          if (child.directory && expanded().has(child.relativePath)) await child.expand();
        }
        if (result.truncated) {
          const note = document.createElement("div");
          note.className = "workspace-viewer-note";
          note.textContent = "처음 500개 항목만 표시합니다.";
          children.append(note);
        }
        loaded = true;
      } catch (error) {
        showError(error);
        isExpanded = false;
        children.hidden = true;
      } finally { button.disabled = false; }
    };
    item.expand = () => toggle(true);
    button.addEventListener("click", () => void toggle());
    return wrap;
  }

  async function searchFiles(pattern) {
    const tree = $v("viewerTree");
    const previous = viewer.selected && identity(viewer.selected);
    const scroll = tree.scrollTop;
    tree.textContent = "파일을 찾는 중…";
    const wsId = viewer.workspaceId;
    const listGeneration = ++viewer.listGeneration;
    try {
      const result = await call("viewer-search", {
        pattern,
        contentQuery: $v("viewerContentInput").value.trim(),
        scopePath: $v("viewerSearchScope").checked ? viewer.searchFolder : "",
        includeExcluded: $v("viewerSearchIncludeExcluded").checked
      });
      if (viewer.workspaceId !== wsId || viewer.tab !== "files" || !viewer.open || viewer.listGeneration !== listGeneration) return;
      tree.replaceChildren();
      tree.setAttribute("role", "list");
      const summary = document.createElement("div");
      summary.className = "workspace-viewer-note";
      summary.textContent = `${result.items.length}개 파일 · ${result.scanned.toLocaleString()}개 항목 확인${result.skippedLarge ? ` · 큰 파일 ${result.skippedLarge}개 제외` : ""}${result.truncated ? " · 결과 일부만 표시" : ""}`;
      tree.append(summary);
      for (const item of result.items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "workspace-viewer-row workspace-viewer-search-result";
        button.title = item.relativePath;
        const parts = item.relativePath.replaceAll("\\", "/").split("/");
        const name = document.createElement("span");
        name.className = "workspace-viewer-git-name";
        name.textContent = parts.pop();
        const directory = document.createElement("span");
        directory.className = "workspace-viewer-git-path";
        directory.textContent = parts.join("/") || ".";
        button.append(name, directory);
        if (item.line) {
          const snippet = document.createElement("span");
          snippet.className = "workspace-viewer-search-snippet";
          snippet.textContent = `${item.line}행 · ${item.snippet || ""}`;
          button.append(snippet);
        }
        button.viewerItem = { ...item, element: button };
        button.addEventListener("click", () => select(button.viewerItem));
        tree.append(button);
      }
      restoreSelection(previous, tree);
      tree.scrollTop = scroll;
      message(result.truncated ? "검색이 500개 결과, 10만 항목 또는 5초 제한에 도달했습니다." : "");
    } catch (error) {
      if (viewer.listGeneration === listGeneration) { tree.replaceChildren(); showError(error); }
    }
  }

  async function loadFiles() {
    const ws = workspace();
    if (!ws) { message("워크스페이스를 선택하세요."); return; }
    const pattern = $v("viewerSearchInput").value.trim();
    if (pattern || $v("viewerContentInput").value.trim()) { await searchFiles(pattern); return; }
    const tree = $v("viewerTree");
    const previous = viewer.selected && identity(viewer.selected);
    const scroll = tree.scrollTop;
    tree.setAttribute("role", "tree");
    tree.replaceChildren();
    tree.textContent = "폴더를 읽는 중…";
    const wsId = ws.id;
    const listGeneration = ++viewer.listGeneration;
    try {
      const result = await call("viewer-list", { relativePath: "" });
      if (viewer.workspaceId !== wsId || !viewer.open || viewer.tab !== "files" || viewer.listGeneration !== listGeneration) return;
      tree.replaceChildren();
      const root = { name: ws.name || ws.path, relativePath: "", directory: true };
      const rootRow = document.createElement("button");
      rootRow.className = "workspace-viewer-row workspace-viewer-root";
      rootRow.textContent = `▾ 📁 ${root.name}`;
      root.element = rootRow;
      rootRow.viewerItem = root;
      rootRow.addEventListener("click", () => select({ ...root, element: rootRow }));
      tree.append(rootRow);
      for (const item of result.items) {
        tree.append(makeRow(item, 1));
        if (item.directory && expanded().has(item.relativePath)) await item.expand();
      }
      restoreSelection(previous, tree);
      tree.scrollTop = scroll;
      if (result.truncated) message("루트의 처음 500개 항목만 표시합니다.");
    } catch (error) { tree.replaceChildren(); showError(error); }
  }

  async function loadGit() {
    const list = $v("viewerGitList");
    const previous = viewer.selected && identity(viewer.selected);
    const scroll = list.scrollTop;
    list.textContent = "Git 상태를 읽는 중…";
    const wsId = viewer.workspaceId;
    const listGeneration = ++viewer.listGeneration;
    try {
      const result = await call("viewer-git-status");
      if (viewer.workspaceId !== wsId || !viewer.open || viewer.tab !== "git" || viewer.listGeneration !== listGeneration) return;
      list.replaceChildren();
      const header = document.createElement("div");
      header.className = "workspace-viewer-note";
      header.textContent = `${result.branch || "(detached)"} · 변경 ${result.items.length}개${result.truncated ? " 이상" : ""}`;
      list.append(header);
      if (!result.items.length) {
        const empty = document.createElement("div");
        empty.className = "workspace-viewer-note";
        empty.textContent = "변경된 파일이 없습니다.";
        list.append(empty);
      }
      for (const section of ["staged", "unstaged", "untracked"]) {
        const sectionItems = result.items.filter((item) => item.section === section);
        const sectionHeader = document.createElement("div");
        sectionHeader.className = "workspace-viewer-section-title";
        sectionHeader.textContent = `${{ staged: "스테이징됨", unstaged: "스테이징 전", untracked: "추적되지 않음" }[section]} (${sectionItems.length})`;
        list.append(sectionHeader);
        for (const item of sectionItems) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "workspace-viewer-row workspace-viewer-git-row";
        const statusLabel = section === "untracked" ? "새 파일" : item.status.includes("D") ? "삭제" : item.status.includes("R") ? "이름 변경" : item.status.includes("A") ? "추가" : "수정";
        const status = document.createElement("span");
        status.className = `workspace-viewer-git-status ${item.status.includes("D") ? "deleted" : section === "untracked" || item.status.includes("A") ? "added" : "modified"}`;
        status.textContent = statusLabel;
        const parts = item.relativePath.replaceAll("\\", "/").split("/");
        const name = document.createElement("span");
        name.className = "workspace-viewer-git-name";
        name.textContent = parts.pop();
        const directory = document.createElement("span");
        directory.className = "workspace-viewer-git-path";
        directory.textContent = parts.join("/") || ".";
        button.append(status, name, directory);
        button.title = item.relativePath;
        button.viewerItem = { ...item, directory: false, element: button };
        button.addEventListener("click", () => select(button.viewerItem));
        list.append(button);
        }
      }
      restoreSelection(previous, list);
      list.scrollTop = scroll;
    } catch (error) { list.replaceChildren(); showError(error); }
  }

  async function loadAgents() {
    const list = $v("viewerAgentList");
    const previous = viewer.selected && identity(viewer.selected);
    const scroll = list.scrollTop;
    list.textContent = "Agent 파일을 찾는 중…";
    const wsId = viewer.workspaceId;
    const listGeneration = ++viewer.listGeneration;
    try {
      const result = await window.wincmux.agentAssetsScan(workspace().path);
      if (viewer.workspaceId !== wsId || viewer.tab !== "agents" || !viewer.open || viewer.listGeneration !== listGeneration) return;
      list.replaceChildren();
      const items = (result.items || []).filter((item) => item.exists);
      const summary = document.createElement("div");
      summary.className = "workspace-viewer-note";
      summary.textContent = `에이전트 관련 파일 ${items.length}개`;
      list.append(summary);
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "workspace-viewer-note";
        empty.textContent = "관련 파일이 없습니다.";
        list.append(empty);
      }
      const groups = new Map();
      for (const item of items) {
        const parts = item.relativePath.replaceAll("\\", "/").split("/");
        const group = parts.length > 1 ? parts[0] : "";
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(item);
      }
      const groupNames = [...groups.keys()].sort((a, b) => !a ? -1 : !b ? 1 : a.localeCompare(b));
      for (const group of groupNames) {
        const groupItems = groups.get(group).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        const section = document.createElement("section");
        section.className = "workspace-viewer-agent-group";
        const header = document.createElement("button");
        header.type = "button";
        header.className = "workspace-viewer-agent-group-toggle";
        const children = document.createElement("div");
        children.className = "workspace-viewer-agent-group-items";
        const setOpen = (open) => {
          children.hidden = !open;
          header.setAttribute("aria-expanded", String(open));
          header.textContent = `${open ? "▾" : "▸"} 📁 ${group || "워크스페이스 루트"} (${groupItems.length})`;
          if (open) collapsedAgentGroups().delete(group); else collapsedAgentGroups().add(group);
          updateActions();
        };
        header.addEventListener("click", () => setOpen(children.hidden));
        section.append(header, children);
        list.append(section);
        for (const item of groupItems) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "workspace-viewer-row workspace-viewer-search-result";
          button.title = item.relativePath;
          const name = document.createElement("span");
          name.className = "workspace-viewer-git-name";
          name.textContent = item.name;
          const path = document.createElement("span");
          path.className = "workspace-viewer-git-path";
          path.textContent = `${group ? item.relativePath.slice(group.length + 1) : item.relativePath} · ${item.category}`;
          button.append(name, path);
          button.viewerItem = { ...item, directory: false, element: button };
          button.addEventListener("click", () => select(button.viewerItem));
          children.append(button);
        }
        setOpen(!collapsedAgentGroups().has(group));
      }
      restoreSelection(previous, list);
      list.scrollTop = scroll;
    } catch (error) { if (viewer.listGeneration === listGeneration) { list.replaceChildren(); showError(error); } }
  }

  function refresh() {
    if (viewer.tab === "git") void loadGit();
    else if (viewer.tab === "agents") void loadAgents();
    else void loadFiles();
  }

  function setTab(tab) {
    viewer.tab = tab;
    viewer.selected = null;
    viewer.previewText = null;
    ++viewer.generation;
    $v("viewerFilesTab").classList.toggle("active", tab === "files");
    $v("viewerGitTab").classList.toggle("active", tab === "git");
    $v("viewerAgentsTab").classList.toggle("active", tab === "agents");
    $v("viewerTree").hidden = tab !== "files";
    $v("viewerGitList").hidden = tab !== "git";
    $v("viewerAgentList").hidden = tab !== "agents";
    $v("viewerSearchForm").hidden = tab !== "files";
    $v("viewerPreviewTitle").textContent = "파일을 선택하세요";
    $v("viewerPreview").replaceChildren();
    updateActions();
    message("");
    refresh();
  }

  function setOpen(open) {
    viewer.open = open;
    $v("workspaceContent").classList.toggle("viewer-open", open);
    $v("workspaceViewer").hidden = !open;
    $v("workspaceViewerResize").hidden = !open;
    $v("workspaceViewerBtn").setAttribute("aria-expanded", String(open));
    $v("workspaceViewerBtn").setAttribute("aria-pressed", String(open));
    if (open) {
      viewer.workspaceId = workspace()?.id ?? null;
      $v("viewerRootName").textContent = workspace()?.name ?? "";
      setTab(viewer.tab);
    } else {
      ++viewer.generation;
      $v("viewerTree").replaceChildren();
      $v("viewerGitList").replaceChildren();
      $v("viewerAgentList").replaceChildren();
      $v("viewerPreview").replaceChildren();
    }
    requestAnimationFrame(() => globalThis.fitAllPanes?.());
  }

  function init() {
    $v("workspaceViewerBtn").addEventListener("click", () => setOpen(!viewer.open));
    $v("viewerClose").addEventListener("click", () => setOpen(false));
    $v("viewerRefresh").addEventListener("click", refresh);
    $v("viewerFilesTab").addEventListener("click", () => setTab("files"));
    $v("viewerGitTab").addEventListener("click", () => setTab("git"));
    $v("viewerAgentsTab").addEventListener("click", () => setTab("agents"));
    $v("viewerPrevious").addEventListener("click", () => navigate(-1));
    $v("viewerNext").addEventListener("click", () => navigate(1));
    for (const listId of ["viewerTree", "viewerGitList", "viewerAgentList"]) {
      $v(listId).addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); navigate(event.key === "ArrowDown" ? 1 : -1); }
      });
    }
    $v("workspaceViewer").addEventListener("keydown", (event) => {
      if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault(); event.stopPropagation(); navigate(event.key === "ArrowDown" ? 1 : -1);
      }
    });
    $v("viewerSearchForm").addEventListener("submit", (event) => {
      event.preventDefault();
      if (viewer.open && viewer.tab === "files") void loadFiles();
    });
    $v("viewerSearchClear").addEventListener("click", () => {
      $v("viewerSearchInput").value = "";
      $v("viewerContentInput").value = "";
      if (viewer.open && viewer.tab === "files") void loadFiles();
      $v("viewerSearchInput").focus();
    });
    $v("viewerSearchIncludeExcluded").addEventListener("change", () => {
      if (viewer.open && viewer.tab === "files" && ($v("viewerSearchInput").value.trim() || $v("viewerContentInput").value.trim())) void loadFiles();
    });
    for (const type of ["keydown", "keyup", "paste", "cut", "copy"]) {
      for (const id of ["viewerSearchInput", "viewerContentInput"]) $v(id).addEventListener(type, (event) => event.stopPropagation());
    }
    $v("viewerCopyPath").addEventListener("click", () => window.wincmux.clipboardWrite(fullPath(viewer.selected.relativePath)).then(() => message("경로를 복사했습니다.")).catch(showError));
    $v("viewerCopyContent").addEventListener("click", () => window.wincmux.clipboardWrite(viewer.previewText).then(() => message("내용을 복사했습니다.")).catch(showError));
    $v("viewerCopyFile").addEventListener("click", () => { viewer.copied = viewer.selected.relativePath; message("대상 폴더를 선택한 뒤 '여기에 붙여넣기'를 누르세요."); updateActions(); });
    $v("viewerPasteFile").addEventListener("click", async () => {
      try {
        const result = await call("viewer-copy", { sourcePath: viewer.copied, destinationPath: viewer.selected.relativePath });
        message(`복사 완료: ${result.relativePath}`);
        if (viewer.tab === "files") await loadFiles();
      } catch (error) { showError(error); }
    });
    const splitter = $v("workspaceViewerResize");
    splitter.addEventListener("pointerdown", (event) => {
      splitter.setPointerCapture(event.pointerId);
      const move = (ev) => {
        const rect = $v("workspaceContent").getBoundingClientRect();
        const width = Math.min(Math.max(rect.right - ev.clientX, 260), Math.max(260, rect.width - 300));
        $v("workspaceContent").style.setProperty("--viewer-width", `${width}px`);
        globalThis.fitAllPanes?.();
      };
      const end = () => { splitter.removeEventListener("pointermove", move); splitter.removeEventListener("pointerup", end); };
      splitter.addEventListener("pointermove", move);
      splitter.addEventListener("pointerup", end);
    });
    const innerSplitter = $v("viewerInnerResize");
    innerSplitter.addEventListener("pointerdown", (event) => {
      innerSplitter.setPointerCapture(event.pointerId);
      const move = (ev) => {
        const rect = $v("viewerMain").getBoundingClientRect();
        const width = Math.max(140, Math.min(ev.clientX - rect.left, rect.width - 180));
        $v("viewerMain").style.setProperty("--viewer-nav-width", `${width}px`);
      };
      const end = () => { innerSplitter.removeEventListener("pointermove", move); innerSplitter.removeEventListener("pointerup", end); };
      innerSplitter.addEventListener("pointermove", move);
      innerSplitter.addEventListener("pointerup", end);
    });
  }

  function workspaceChanged() {
    viewer.workspaceId = workspace()?.id ?? null;
    viewer.copied = null;
    viewer.searchFolder = null;
    updateScope();
    ++viewer.generation;
    if (viewer.open) {
      $v("viewerRootName").textContent = workspace()?.name ?? "";
      setTab(viewer.tab);
    }
  }
  function open(tab = "files") {
    if (!workspace()) throw new Error("워크스페이스를 먼저 선택하세요.");
    if (!viewer.open) {
      viewer.tab = tab;
      setOpen(true);
    } else {
      setTab(tab);
    }
    $v(tab === "git" ? "viewerGitTab" : tab === "agents" ? "viewerAgentsTab" : "viewerFilesTab").focus();
  }
  window.wincmuxWorkspaceViewer = { init, workspaceChanged, open };
})();
