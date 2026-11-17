(() => {
  let dialog, list, info, error, search, provider, children, heading;
  let workspaceId = null, targetPaneId = null, items = [], generation = 0, busy = false;
  const names = { claude: 'Claude Code', codex: 'Codex' };
  const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const element = (tag, className, text) => {
    const el = document.createElement(tag); if (className) el.className = className;
    if (text != null) el.textContent = text; return el;
  };
  function showError(err) { error.textContent = String(err?.message ?? err); error.hidden = false; }
  function sameWorkspace(id) {
    if (state.selectedWorkspaceId !== id) throw new Error('프로젝트가 변경되었습니다. 해당 프로젝트에서 대화 이력을 다시 여세요.');
  }
  async function destination(pane, wsId) {
    sameWorkspace(wsId);
    let nextPane = state.paneViews.has(pane) ? pane : state.selectedPaneId;
    const view = state.paneViews.get(nextPane);
    if (!view) throw new Error('대화를 열 터미널이 없습니다.');
    if (state.paneSessions[nextPane] || view.sessionId || view.overlayEl?.dataset.mode === 'starting' || dormantPaneSession(nextPane)) {
      const split = await splitPaneInternal(nextPane, 'horizontal', { autoStartIfMissing: false });
      sameWorkspace(wsId);
      if (!split?.second) throw new Error('새 터미널을 만들지 못했습니다.');
      nextPane = split.second;
    }
    return nextPane;
  }
  async function resume(item, context = {}) {
    if (busy) return null;
    const wsId = context.workspaceId ?? workspaceId;
    const pane = context.paneId ?? targetPaneId;
    if (!idPattern.test(item.id) || !Object.hasOwn(names, item.provider)) throw new Error('대화 ID가 올바르지 않습니다.');
    sameWorkspace(wsId); busy = true;
    if (dialog) { dialog.dataset.busy = 'true'; render(); }
    try {
      const resolved = await rpc('conversation.resolve', { workspace_id: wsId, provider: item.provider, id: item.id,
        include_children: context.includeChildren ?? children?.checked ?? true });
      sameWorkspace(wsId);
      if (resolved.id !== item.id || resolved.provider !== item.provider || !resolved.cwd_exists) throw new Error('대화 정보를 다시 확인하세요.');
      const nextPane = await destination(pane, wsId);
      const command = item.provider === 'claude' ? `claude --resume ${item.id}` : `codex resume ${item.id}`;
      const session = await startShellCommandForPane(nextPane, command, { cwd: resolved.cwd, strictCwd: true,
        workspaceId: wsId, force: false, focusTerm: true });
      if (!session) throw new Error('대화를 시작하지 못했습니다. 터미널을 다시 선택하세요.');
      dialog?.close(); setStatus(`${names[item.provider]} 대화 재개 명령을 실행했습니다.`);
      return session;
    } finally {
      busy = false;
      if (dialog) { dialog.dataset.busy = 'false'; render(); }
    }
  }
  function render() {
    if (!list) return;
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const visible = items.filter(item => (!provider.value || item.provider === provider.value)
      && `${item.title} ${item.id} ${item.cwd}`.toLowerCase().includes(query));
    info.textContent = `${visible.length}개 대화 · 원본은 각 도구가 보관합니다. 실행 중인 터미널이 있으면 새 터미널에서 재개합니다.`;
    for (const item of visible) {
      const row = element('article', 'conversation-row'); row.dataset.id = item.id; row.dataset.provider = item.provider;
      const icon = element('span', `conversation-icon conversation-${item.provider}`);
      icon.innerHTML = window.wincmuxLaunchProfiles.iconMarkup(item.provider);
      const detail = element('div', 'conversation-detail');
      const title = element('strong', 'conversation-title', item.title || `${names[item.provider]} 대화`);
      const time = Number.isFinite(item.updated_at) ? new Date(item.updated_at * 1000).toLocaleString() : '';
      const meta = element('span', 'conversation-meta', `${names[item.provider]} · ${time}${item.archived ? ' · 보관됨' : ''}`);
      const cwd = element('span', 'conversation-cwd', item.cwd); cwd.title = item.cwd;
      const id = element('span', 'conversation-id', item.id); id.title = item.source_path;
      detail.append(title, meta, cwd, id);
      const button = element('button', 'conversation-resume', item.cwd_exists ? '이 대화 재개' : '폴더 없음');
      button.type = 'button'; button.disabled = busy || !item.cwd_exists;
      button.title = item.cwd_exists ? item.resume_command : '대화를 실행했던 원래 폴더를 복원하세요.';
      button.addEventListener('click', () => { void resume(item).catch(showError); });
      row.append(icon, detail, button); list.append(row);
    }
    if (!visible.length) list.append(element('p', 'conversation-empty', items.length
      ? '검색 조건에 맞는 대화가 없습니다.'
      : '이 프로젝트의 저장된 Claude·Codex 대화를 찾지 못했습니다. 하위 폴더 포함을 확인하거나 아래 resume 선택기를 이용하세요. WSL·다른 Windows 계정·다른 설정 폴더의 이력은 별도로 보관됩니다.'));
    dialog.querySelector('[data-action="refresh"]').disabled = busy; children.disabled = busy;
    for (const button of dialog.querySelectorAll('[data-picker]')) button.disabled = busy;
  }
  async function refresh(force = false) {
    const sequence = ++generation, wsId = workspaceId;
    error.hidden = true; list.replaceChildren(element('p', 'conversation-empty', '프로젝트 대화 이력을 조회하고 있습니다…'));
    try {
      const result = await rpc('conversation.list', { workspace_id: wsId, include_children: children.checked, refresh: force });
      if (sequence !== generation || workspaceId !== wsId || !dialog.open) return;
      sameWorkspace(wsId); items = result.items ?? [];
      dialog.querySelector('.conversation-warning').textContent = (result.warnings ?? []).join(' '); render();
    } catch (err) { if (sequence === generation) { items = []; render(); showError(err); } }
  }
  async function open(paneId = state.selectedPaneId) {
    const ws = selectedWorkspace();
    if (!ws) { setStatus('프로젝트를 먼저 선택하세요.', true); return; }
    if (busy) return;
    ensureDialog(); workspaceId = ws.id; targetPaneId = paneId;
    heading.textContent = `${ws.name} · 이전 대화 불러오기`;
    search.value = ''; provider.value = ''; items = []; error.hidden = true;
    if (!dialog.open) dialog.showModal(); search.focus(); await refresh();
  }
  async function nativePicker(kind) {
    if (busy) return;
    const wsId = workspaceId; sameWorkspace(wsId); busy = true; render();
    try {
      const pane = await destination(targetPaneId, wsId);
      sameWorkspace(wsId);
      const sid = await startShellCommandForPane(pane, kind === 'claude' ? 'claude --resume' : 'codex resume', {
        force: false, workspaceId: wsId, cwd: selectedWorkspace().path, strictCwd: true, focusTerm: true });
      if (!sid) throw new Error('대화 선택기를 시작하지 못했습니다.');
      dialog.close();
    } finally { busy = false; render(); }
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = element('dialog', 'conversation-dialog'); dialog.id = 'conversationDialog';
    // Only constant markup. Local transcript metadata always uses textContent.
    dialog.innerHTML = `<header class="conversation-header"><h2 id="conversationHeading"></h2><button type="button" data-action="close" aria-label="닫기">×</button></header>
      <div class="conversation-controls"><input type="search" id="conversationSearch" aria-label="대화 검색" placeholder="제목 · 대화 ID · 폴더 검색"><select id="conversationProvider" aria-label="도구 필터"><option value="">모든 도구</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select><button type="button" data-action="refresh">새로고침</button></div>
      <label class="conversation-scope"><input type="checkbox" id="conversationChildren" checked> 이 프로젝트의 하위 폴더 포함</label>
      <p class="conversation-info"></p><p class="conversation-error" role="alert" hidden></p><p class="conversation-warning"></p>
      <div class="conversation-list"></div><footer class="conversation-footer"><span>도구에서 직접 선택</span><button type="button" data-picker="claude">Claude resume</button><button type="button" data-picker="codex">Codex resume</button></footer>`;
    dialog.setAttribute('aria-labelledby', 'conversationHeading'); document.body.append(dialog);
    heading = dialog.querySelector('h2'); list = dialog.querySelector('.conversation-list'); info = dialog.querySelector('.conversation-info');
    error = dialog.querySelector('.conversation-error'); search = dialog.querySelector('input[type="search"]');
    provider = dialog.querySelector('select'); children = dialog.querySelector('input[type="checkbox"]');
    search.addEventListener('input', render); provider.addEventListener('change', render);
    children.addEventListener('change', () => { void refresh(); });
    dialog.querySelector('[data-action="refresh"]').addEventListener('click', () => { void refresh(true); });
    dialog.querySelector('[data-action="close"]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { generation++; });
    for (const button of dialog.querySelectorAll('[data-picker]')) button.addEventListener('click', () => { void nativePicker(button.dataset.picker).catch(showError); });
  }
  document.getElementById('conversationBtn')?.addEventListener('click', () => { void open(); });
  window.wincmuxConversations = { open, resume, refresh };
})();
