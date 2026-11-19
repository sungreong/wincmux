// A small, on-demand companion pane. It creates no terminal and loads only open folders.
(() => {
  const $v = (id) => document.getElementById(id);
  const viewer = { open: false, tab: "files", workspaceId: null, selected: null, copied: null, previewText: null, markdownText: null, markdownSource: false, generation: 0, listGeneration: 0, highlightGeneration: 0, gitPage: 0, codeLines: [], findMatches: [], findIndex: -1, expandedByWorkspace: new Map(), agentCollapsedByWorkspace: new Map(), searchFolder: null, focusFolder: "" };
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
    const scope = viewer.focusFolder || viewer.searchFolder;
    $v("viewerSearchScope").disabled = !scope;
    if (!scope) $v("viewerSearchScope").checked = false;
    $v("viewerScopeName").textContent = scope ? `(${scope})` : "";
    $v("viewerScopeName").title = scope || "";
  };
  const updateFolderBar = () => {
    $v("viewerFolderBar").hidden = viewer.tab !== "files";
    $v("viewerFolderPath").textContent = viewer.focusFolder || "워크스페이스 전체";
    $v("viewerFolderPath").title = $v("viewerFolderPath").textContent;
    $v("viewerFocusFolder").disabled = viewer.tab !== "files" || !viewer.selected?.directory || viewer.selected.relativePath === viewer.focusFolder;
    $v("viewerParentFolder").disabled = !viewer.focusFolder;
    $v("viewerWorkspaceRoot").disabled = !viewer.focusFolder;
  };
  const focusFolder = (path) => {
    viewer.focusFolder = path;
    viewer.selected = null;
    viewer.previewText = null;
    viewer.markdownText = null;
    viewer.searchFolder = path || null;
    $v("viewerSearchScope").checked = Boolean(path);
    $v("viewerPreviewTitle").textContent = "파일을 선택하세요";
    $v("viewerPreview").replaceChildren();
    $v("viewerFindBar").hidden = true;
    updateScope();
    updateActions();
    if (viewer.open && viewer.tab === "files") void loadFiles();
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

  const paintCode = (code, text, tokens, active) => window.wincmuxViewerHighlighter.paint(code, text, tokens, active);

  function showFindMatch() {
    const { findMatches, findIndex } = viewer;
    $v("viewerFindCount").textContent = findMatches.length ? `${findIndex + 1}/${findMatches.length}` : "0/0";
    const match = findMatches[findIndex];
    if (!match) return;
    const { code, text, tokens, start, length, row } = match;
    paintCode(code, text, tokens, { start, length });
    row.scrollIntoView({ block: "center", inline: "nearest" });
  }

  function findInPreview(preferredLine) {
    const previous = viewer.findMatches[viewer.findIndex];
    if (previous) paintCode(previous.code, previous.text, previous.tokens);
    viewer.findMatches = [];
    viewer.findIndex = -1;
    const needle = $v("viewerFindInput").value.toLocaleLowerCase();
    if (!needle) { $v("viewerFindCount").textContent = "0/0"; return; }
    for (const { row, code, text, line, tokens } of viewer.codeLines) {
      const lower = text.toLocaleLowerCase();
      let from = 0;
      while (from < lower.length) {
        const start = lower.indexOf(needle, from);
        if (start < 0) break;
        viewer.findMatches.push({ row, code, text, line, tokens, start, length: needle.length });
        from = start + Math.max(needle.length, 1);
        if (viewer.findMatches.length >= 10000) break;
      }
      if (viewer.findMatches.length >= 10000) break;
    }
    if (viewer.findMatches.length) {
      viewer.findIndex = Math.max(0, viewer.findMatches.findIndex((match) => match.line >= (preferredLine || 1)));
    }
    showFindMatch();
  }

  function moveFind(delta) {
    const previous = viewer.findMatches[viewer.findIndex];
    if (previous) paintCode(previous.code, previous.text, previous.tokens);
    if (!viewer.findMatches.length) return;
    viewer.findIndex = (viewer.findIndex + delta + viewer.findMatches.length) % viewer.findMatches.length;
    showFindMatch();
  }

  function highlightCode(value, path, entries) {
    const request = ++viewer.highlightGeneration;
    const source = value.replace(/\r\n?/g, "\n").split("\n").slice(0, entries.length).join("\n");
    window.wincmuxViewerHighlighter.highlight(source, path, $v("viewerLanguageSelect").value || null).then(({ language, lines }) => {
      if (request !== viewer.highlightGeneration || viewer.codeLines !== entries) return;
      $v("viewerLanguageSelect").options[0].textContent = `언어 자동 · ${language || "일반 텍스트"}`;
      $v("viewerLanguageSelect").title = language ? `자동 감지: ${language} · 내장 강조` : "자동 감지: 일반 텍스트";
      for (const [index, entry] of entries.entries()) {
        entry.tokens = lines?.[index] || null;
        const current = viewer.findMatches[viewer.findIndex];
        const active = current?.code === entry.code ? { start: current.start, length: current.length } : undefined;
        paintCode(entry.code, entry.text, entry.tokens, active);
      }
      const tokensByCode = new Map(entries.map((entry) => [entry.code, entry.tokens]));
      viewer.findMatches.forEach((match) => { match.tokens = tokensByCode.get(match.code); });
    }).catch((error) => {
      if (request !== viewer.highlightGeneration) return;
      $v("viewerLanguageSelect").options[0].textContent = "언어 자동 · 강조 불가";
      $v("viewerLanguageSelect").title = `내장 언어 강조를 불러오지 못했습니다: ${String(error?.message ?? error)}`;
      message("언어 강조 모듈을 불러오지 못했습니다. 앱을 업데이트하거나 다시 설치하세요.");
    });
  }

  function renderCode(body, value, line, preserveFind = false) {
    const codeView = document.createElement("div");
    codeView.className = "workspace-viewer-code";
    viewer.codeLines = [];
    const fragment = document.createDocumentFragment();
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    const entries = viewer.codeLines;
    const path = viewer.selected?.relativePath;
    for (const [index, text] of lines.slice(0, 5000).entries()) {
      const row = document.createElement("div");
      row.className = "workspace-viewer-code-line";
      if (line === index + 1) row.classList.add("target");
      const number = document.createElement("span");
      number.className = "workspace-viewer-line-number";
      number.textContent = String(index + 1);
      const code = document.createElement("span");
      code.className = "workspace-viewer-code-text";
      paintCode(code, text);
      row.append(number, code);
      fragment.append(row);
      entries.push({ row, code, text, line: index + 1, tokens: null });
    }
    codeView.append(fragment);
    body.append(codeView);
    if (lines.length > 5000) {
      const note = document.createElement("div");
      note.className = "workspace-viewer-note";
      note.textContent = "처음 5,000줄만 표시합니다.";
      body.append(note);
    }
    $v("viewerFindBar").hidden = false;
    $v("viewerLanguageSelect").hidden = false;
    $v("viewerLanguageSearchBtn").hidden = false;
    if (!preserveFind) $v("viewerFindInput").value = viewer.tab === "files" && line ? $v("viewerContentInput").value.trim() : "";
    findInPreview(line);
    if (line && !viewer.findMatches.length) viewer.codeLines[line - 1]?.row.scrollIntoView({ block: "center" });
    highlightCode(value, path, entries);
  }

  function addAgentEditor(body, item, content) {
    if (viewer.tab !== "agents" || !item?.editable) return;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "편집";
    edit.addEventListener("click", () => {
      const editor = document.createElement("textarea");
      editor.className = "workspace-viewer-agent-editor";
      editor.value = content;
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
      $v("viewerMarkdownToggle").hidden = true;
      body.replaceChildren(editor, save);
      editor.focus();
    });
    body.prepend(edit);
  }

  function showMarkdownPreview(source) {
    const body = $v("viewerPreview");
    body.replaceChildren();
    viewer.markdownSource = source;
    $v("viewerMarkdownToggle").textContent = source ? "문서 보기" : "원문 보기";
    if (source) renderCode(body, viewer.markdownText, viewer.selected?.line, true);
    else {
      viewer.codeLines = [];
      $v("viewerLanguageSelect").hidden = true;
      $v("viewerLanguageSearchBtn").hidden = true;
      $v("viewerLanguageSearch").hidden = true;
      viewer.findMatches = [];
      viewer.findIndex = -1;
      $v("viewerFindCount").textContent = "0/0";
      $v("viewerFindBar").hidden = false;
      window.wincmuxViewerMarkdown.render(body, viewer.markdownText);
    }
    addAgentEditor(body, viewer.selected, viewer.markdownText);
  }

  function updateActions() {
    const selected = viewer.selected;
    updateFolderBar();
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
    viewer.markdownText = null;
    $v("viewerLanguageSelect").value = "";
    $v("viewerLanguageSelect").options[0].textContent = "언어 자동 · 확인 중";
    $v("viewerLanguageSelect").hidden = true;
    $v("viewerLanguageSearchBtn").hidden = true;
    $v("viewerLanguageSearch").hidden = true;
    viewer.codeLines = [];
    viewer.findMatches = [];
    viewer.findIndex = -1;
    $v("viewerFindBar").hidden = true;
    $v("viewerMarkdownToggle").hidden = true;
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
        } else if (/\.mdx?$/i.test(item.relativePath)) {
          viewer.markdownText = result.text;
          $v("viewerMarkdownToggle").hidden = false;
          showMarkdownPreview(false);
        } else {
          renderCode(body, result.text, item.line);
        }
        if (viewer.markdownText === null) addAgentEditor(body, item, result.text);
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
        scopePath: $v("viewerSearchScope").checked ? (viewer.focusFolder || viewer.searchFolder) : "",
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
      const folder = viewer.focusFolder;
      const result = await call("viewer-list", { relativePath: folder });
      if (viewer.workspaceId !== wsId || !viewer.open || viewer.tab !== "files" || viewer.listGeneration !== listGeneration) return;
      tree.replaceChildren();
      const root = { name: folder ? folder.split("/").pop() : ws.name || ws.path, relativePath: folder, directory: true };
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
    $v("viewerGitPrevPage").disabled = true;
    $v("viewerGitNextPage").disabled = true;
    const wsId = viewer.workspaceId;
    const listGeneration = ++viewer.listGeneration;
    try {
      const page = viewer.gitPage;
      const result = await call("viewer-git-status", { page });
      if (viewer.workspaceId !== wsId || !viewer.open || viewer.tab !== "git" || viewer.listGeneration !== listGeneration) return;
      list.replaceChildren();
      const header = document.createElement("div");
      header.className = "workspace-viewer-note";
      header.textContent = `${result.branch || "(detached)"} · ${page + 1}페이지 · ${result.items.length}개 표시${result.hasMore ? " · 다음 페이지 있음" : ""}`;
      list.append(header);
      $v("viewerGitPageLabel").textContent = `${page + 1}페이지`;
      $v("viewerGitPrevPage").disabled = page === 0;
      $v("viewerGitNextPage").disabled = !result.hasMore;
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
    } catch (error) { if (viewer.listGeneration === listGeneration) { list.replaceChildren(); showError(error); } }
  }

  function changeGitPage(delta) {
    viewer.gitPage = Math.max(0, Math.min(999, viewer.gitPage + delta));
    viewer.selected = null;
    viewer.previewText = null;
    viewer.markdownText = null;
    ++viewer.generation;
    $v("viewerPreviewTitle").textContent = "파일을 선택하세요";
    $v("viewerPreview").replaceChildren();
    $v("viewerFindBar").hidden = true;
    $v("viewerMarkdownToggle").hidden = true;
    $v("viewerLanguageSelect").hidden = true;
    $v("viewerLanguageSearchBtn").hidden = true;
    $v("viewerLanguageSearch").hidden = true;
    updateActions();
    void loadGit();
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
    viewer.markdownText = null;
    ++viewer.generation;
    $v("viewerFilesTab").classList.toggle("active", tab === "files");
    $v("viewerGitTab").classList.toggle("active", tab === "git");
    $v("viewerAgentsTab").classList.toggle("active", tab === "agents");
    $v("viewerTree").hidden = tab !== "files";
    $v("viewerGitList").hidden = tab !== "git";
    $v("viewerAgentList").hidden = tab !== "agents";
    $v("viewerGitPager").hidden = tab !== "git";
    $v("viewerSearchForm").hidden = tab !== "files";
    updateFolderBar();
    $v("viewerPreviewTitle").textContent = "파일을 선택하세요";
    $v("viewerPreview").replaceChildren();
    $v("viewerFindBar").hidden = true;
    $v("viewerMarkdownToggle").hidden = true;
    $v("viewerLanguageSelect").hidden = true;
    $v("viewerLanguageSearchBtn").hidden = true;
    $v("viewerLanguageSearch").hidden = true;
    updateActions();
    message("");
    refresh();
  }

  function setOpen(open) {
    viewer.open = open;
    window.wincmuxViewerPanel.setOpen({
      button: $v("workspaceViewerBtn"), content: $v("workspaceContent"),
      panel: $v("workspaceViewer"), divider: $v("workspaceViewerResize")
    }, open);
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
    for (const language of window.wincmuxHighlightLanguages || []) {
      const option = document.createElement("option");
      option.value = language;
      option.textContent = language;
      $v("viewerLanguageSelect").append(option);
      $v("viewerLanguageOptions").append(option.cloneNode(true));
    }
    $v("viewerLanguageSelect").addEventListener("change", () => {
      if (viewer.previewText !== null && viewer.codeLines.length) highlightCode(viewer.previewText, viewer.selected?.relativePath, viewer.codeLines);
    });
    const languageSearch = $v("viewerLanguageSearch");
    const commitLanguageSearch = () => {
      const query = languageSearch.value.trim().toLowerCase();
      const language = query && (window.wincmuxHighlightLanguages || []).find((name) => name.toLowerCase() === query)
        || (query && (window.wincmuxHighlightLanguages || []).find((name) => name.toLowerCase().startsWith(query)));
      if (query && !language) { languageSearch.setCustomValidity("일치하는 언어가 없습니다."); languageSearch.reportValidity(); return; }
      languageSearch.setCustomValidity("");
      $v("viewerLanguageSelect").value = language || "";
      $v("viewerLanguageSelect").dispatchEvent(new Event("change"));
      languageSearch.hidden = true;
      $v("viewerLanguageSelect").focus();
    };
    $v("viewerLanguageSearchBtn").addEventListener("click", () => {
      languageSearch.hidden = !languageSearch.hidden;
      if (!languageSearch.hidden) { languageSearch.value = ""; languageSearch.focus(); }
    });
    languageSearch.addEventListener("change", () => { if (languageSearch.value.trim()) commitLanguageSearch(); });
    languageSearch.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); commitLanguageSearch(); }
      if (event.key === "Escape") { languageSearch.hidden = true; $v("viewerLanguageSearchBtn").focus(); }
    });
    $v("workspaceViewerBtn").addEventListener("click", () => setOpen(!viewer.open));
    $v("viewerClose").addEventListener("click", () => setOpen(false));
    $v("viewerRefresh").addEventListener("click", refresh);
    $v("viewerFocusFolder").addEventListener("click", () => {
      if (viewer.selected?.directory) focusFolder(viewer.selected.relativePath);
    });
    $v("viewerParentFolder").addEventListener("click", () => {
      if (viewer.focusFolder) focusFolder(viewer.focusFolder.split("/").slice(0, -1).join("/"));
    });
    $v("viewerWorkspaceRoot").addEventListener("click", () => focusFolder(""));
    $v("viewerFilesTab").addEventListener("click", () => setTab("files"));
    $v("viewerGitTab").addEventListener("click", () => setTab("git"));
    $v("viewerAgentsTab").addEventListener("click", () => setTab("agents"));
    $v("viewerPrevious").addEventListener("click", () => navigate(-1));
    $v("viewerNext").addEventListener("click", () => navigate(1));
    $v("viewerGitPrevPage").addEventListener("click", () => changeGitPage(-1));
    $v("viewerGitNextPage").addEventListener("click", () => changeGitPage(1));
    $v("viewerFindInput").addEventListener("input", () => {
      if (viewer.markdownText !== null && !viewer.markdownSource) showMarkdownPreview(true);
      else findInPreview();
    });
    $v("viewerMarkdownToggle").addEventListener("click", () => showMarkdownPreview(!viewer.markdownSource));
    $v("viewerFindInput").addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); moveFind(event.shiftKey ? -1 : 1); }
    });
    $v("viewerFindPrevious").addEventListener("click", () => moveFind(-1));
    $v("viewerFindNext").addEventListener("click", () => moveFind(1));
    for (const listId of ["viewerTree", "viewerGitList", "viewerAgentList"]) {
      $v(listId).addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); navigate(event.key === "ArrowDown" ? 1 : -1); }
      });
    }
    $v("workspaceViewer").addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && !$v("viewerFindBar").hidden) {
        event.preventDefault(); event.stopPropagation(); $v("viewerFindInput").focus(); $v("viewerFindInput").select();
      }
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
      for (const id of ["viewerSearchInput", "viewerContentInput", "viewerFindInput", "viewerLanguageSearch"]) $v(id).addEventListener(type, (event) => event.stopPropagation());
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
    window.wincmuxViewerPanel.bindViewerWidth($v("workspaceContent"), $v("workspaceViewer"), $v("workspaceViewerResize"), () => globalThis.fitAllPanes?.());
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
    viewer.focusFolder = "";
    viewer.gitPage = 0;
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
