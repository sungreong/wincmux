(() => {
  let dialog, list, info, error, search, provider, children, heading, fromDate, toDate, view, favoritesOnly, compact, pageSize, sortOrder, pageLabel, previous, next;
  let workspaceId = null, targetPaneId = null, items = [], generation = 0, busy = false, page = 1;
  const preferenceKey = 'wincmux.conversations.preferences.v1';
  const layoutKey = 'wincmux.conversations.compact.v1';
  const sizeKey = 'wincmux.conversations.pageSize.v1';
  const sortKey = 'wincmux.conversations.sort.v1';
  const sortOptions = ['newest', 'oldest', 'largest', 'smallest'];
  function readPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch { return {}; }
  }
  const preferences = readPreferences();
  const itemKey = item => `${item.provider}:${item.id}`;
  const marked = (item, field) => preferences[itemKey(item)]?.[field] === true;
  function setMarked(item, field, enabled) {
    const key = itemKey(item), next = { ...preferences[key], [field]: enabled };
    if (!next.favorite && !next.hidden) delete preferences[key]; else preferences[key] = next;
    localStorage.setItem(preferenceKey, JSON.stringify(preferences));
    render();
  }
  function localDay(seconds) {
    if (!Number.isFinite(seconds)) return '';
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  const timeValue = item => Number.isFinite(item.updated_at) ? item.updated_at : 0;
  const newestFirst = (a, b) => timeValue(b) - timeValue(a) || itemKey(a).localeCompare(itemKey(b));
  function compareConversations(a, b) {
    if (sortOrder.value === 'oldest') return timeValue(a) - timeValue(b) || itemKey(a).localeCompare(itemKey(b));
    if (sortOrder.value === 'largest' || sortOrder.value === 'smallest') {
      const left = Number.isFinite(a.size_bytes) ? a.size_bytes : null;
      const right = Number.isFinite(b.size_bytes) ? b.size_bytes : null;
      if (left === null) return right === null ? newestFirst(a, b) : 1;
      if (right === null) return -1;
      return (sortOrder.value === 'largest' ? right - left : left - right) || newestFirst(a, b);
    }
    return newestFirst(a, b);
  }
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    const unit = bytes < 1024 * 1024 ? 'KiB' : 'MiB';
    const value = bytes / (unit === 'KiB' ? 1024 : 1024 * 1024);
    return `${new Intl.NumberFormat(window.wincmuxI18n?.language === 'ko' ? 'ko-KR' : 'en-US', { maximumFractionDigits: 1 }).format(value)} ${unit}`;
  }
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
      && `${item.title} ${item.id} ${item.cwd}`.toLowerCase().includes(query)
      && (view.value === 'all' || marked(item, 'hidden') === (view.value === 'hidden'))
      && (!favoritesOnly.checked || marked(item, 'favorite'))
      && (!fromDate.value || localDay(item.updated_at) >= fromDate.value)
      && (!toDate.value || (localDay(item.updated_at) && localDay(item.updated_at) <= toDate.value))).sort(compareConversations);
    const size = Number(pageSize.value), pages = Math.max(1, Math.ceil(visible.length / size));
    page = Math.min(page, pages);
    const start = (page - 1) * size;
    const hiddenCount = items.filter(item => marked(item, 'hidden')).length;
    info.textContent = `${visible.length}개 대화 · 숨김 ${hiddenCount}개 · 원본은 각 도구가 보관합니다.`;
    pageLabel.textContent = `${page} / ${pages} 페이지${visible.length ? ` · ${start + 1}–${Math.min(start + size, visible.length)} / ${visible.length}` : ''}`;
    previous.disabled = page <= 1; next.disabled = page >= pages;
    dialog.classList.toggle('conversation-compact', compact.checked);
    for (const item of visible.slice(start, start + size)) {
      const row = element('article', 'conversation-row'); row.dataset.id = item.id; row.dataset.provider = item.provider;
      const icon = element('span', `conversation-icon conversation-${item.provider}`);
      icon.innerHTML = window.wincmuxLaunchProfiles.iconMarkup(item.provider);
      const detail = element('div', 'conversation-detail');
      const title = element('strong', 'conversation-title', item.title || `${names[item.provider]} 대화`);
      const locale = window.wincmuxI18n?.language === 'ko' ? 'ko-KR' : 'en-US';
      const time = Number.isFinite(item.updated_at) ? new Date(item.updated_at * 1000).toLocaleString(locale) : '';
      const bytes = formatBytes(item.size_bytes);
      const meta = element('span', 'conversation-meta', `${names[item.provider]} · ${time}${bytes ? ` · ${bytes}` : ''}${item.archived ? ` · ${window.wincmuxI18n?.t('보관됨') ?? '보관됨'}` : ''}`);
      if (bytes) meta.title = '원본 대화 파일 크기 · 메시지 수나 토큰 수가 아닙니다.';
      const cwd = element('span', 'conversation-cwd', item.cwd); cwd.title = item.cwd;
      const id = element('span', 'conversation-id', item.id); id.title = item.source_path;
      detail.append(title, meta, cwd, id);
      const actions = element('div', 'conversation-actions');
      const favorite = element('button', 'conversation-mark', marked(item, 'favorite') ? '★' : '☆');
      favorite.type = 'button'; favorite.dataset.action = 'favorite';
      favorite.setAttribute('aria-label', marked(item, 'favorite') ? '즐겨찾기 해제' : '즐겨찾기');
      favorite.setAttribute('aria-pressed', String(marked(item, 'favorite')));
      favorite.title = favorite.getAttribute('aria-label');
      favorite.addEventListener('click', () => setMarked(item, 'favorite', !marked(item, 'favorite')));
      const hide = element('button', 'conversation-mark', marked(item, 'hidden') ? '복원' : '숨기기');
      hide.type = 'button'; hide.dataset.action = 'hide';
      hide.setAttribute('aria-label', marked(item, 'hidden') ? '대화 숨김 해제' : '대화 숨기기');
      hide.title = hide.getAttribute('aria-label');
      hide.addEventListener('click', () => setMarked(item, 'hidden', !marked(item, 'hidden')));
      actions.append(favorite, hide);
      const button = element('button', 'conversation-resume', item.cwd_exists ? '이 대화 재개' : '폴더 없음');
      button.type = 'button'; button.disabled = busy || !item.cwd_exists;
      button.title = item.cwd_exists ? item.resume_command : '대화를 실행했던 원래 폴더를 복원하세요.';
      button.addEventListener('click', () => { void resume(item).catch(showError); });
      row.append(icon, detail, actions, button); list.append(row);
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
    search.value = ''; provider.value = ''; fromDate.value = ''; toDate.value = '';
    view.value = 'visible'; favoritesOnly.checked = false; page = 1; items = []; error.hidden = true;
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
      <div class="conversation-filters"><label>시작일 <input type="date" id="conversationFrom"></label><label>종료일 <input type="date" id="conversationTo"></label><select id="conversationView" aria-label="숨김 상태 필터"><option value="visible">표시 중</option><option value="hidden">숨긴 대화</option><option value="all">전체</option></select><label><input type="checkbox" id="conversationFavorites"> 즐겨찾기만</label></div>
      <div class="conversation-options"><label class="conversation-scope"><input type="checkbox" id="conversationChildren" checked> 하위 폴더 포함</label><label><input type="checkbox" id="conversationCompact"> 간결하게</label><label>정렬 <select id="conversationSort"><option value="newest">최근 수정순</option><option value="oldest">오래된순</option><option value="largest">파일 큰순</option><option value="smallest">파일 작은순</option></select></label><label>페이지당 <select id="conversationPageSize"><option value="10">10개</option><option value="20">20개</option><option value="50">50개</option></select></label></div>
      <p class="conversation-info"></p><p class="conversation-error" role="alert" hidden></p><p class="conversation-warning"></p>
      <div class="conversation-list"></div><nav class="conversation-pagination" aria-label="대화 페이지"><button type="button" data-page="previous">이전</button><span aria-live="polite"></span><button type="button" data-page="next">다음</button></nav><footer class="conversation-footer"><span>도구에서 직접 선택</span><button type="button" data-picker="claude">Claude resume</button><button type="button" data-picker="codex">Codex resume</button></footer>`;
    dialog.setAttribute('aria-labelledby', 'conversationHeading'); document.body.append(dialog);
    heading = dialog.querySelector('h2'); list = dialog.querySelector('.conversation-list'); info = dialog.querySelector('.conversation-info');
    error = dialog.querySelector('.conversation-error'); search = dialog.querySelector('input[type="search"]');
    provider = dialog.querySelector('#conversationProvider'); children = dialog.querySelector('#conversationChildren');
    fromDate = dialog.querySelector('#conversationFrom'); toDate = dialog.querySelector('#conversationTo');
    view = dialog.querySelector('#conversationView'); favoritesOnly = dialog.querySelector('#conversationFavorites');
    compact = dialog.querySelector('#conversationCompact'); pageSize = dialog.querySelector('#conversationPageSize');
    sortOrder = dialog.querySelector('#conversationSort');
    pageLabel = dialog.querySelector('.conversation-pagination span');
    previous = dialog.querySelector('[data-page="previous"]'); next = dialog.querySelector('[data-page="next"]');
    compact.checked = localStorage.getItem(layoutKey) === '1';
    pageSize.value = ['10', '20', '50'].includes(localStorage.getItem(sizeKey)) ? localStorage.getItem(sizeKey) : '10';
    sortOrder.value = sortOptions.includes(localStorage.getItem(sortKey)) ? localStorage.getItem(sortKey) : 'newest';
    const filterChanged = () => { page = 1; render(); };
    search.addEventListener('input', filterChanged);
    for (const control of [provider, fromDate, toDate, view, favoritesOnly]) control.addEventListener('change', filterChanged);
    compact.addEventListener('change', () => { localStorage.setItem(layoutKey, compact.checked ? '1' : '0'); render(); });
    pageSize.addEventListener('change', () => { localStorage.setItem(sizeKey, pageSize.value); page = 1; render(); });
    sortOrder.addEventListener('change', () => { localStorage.setItem(sortKey, sortOrder.value); page = 1; render(); list.scrollTop = 0; });
    previous.addEventListener('click', () => { page--; render(); list.scrollTop = 0; });
    next.addEventListener('click', () => { page++; render(); list.scrollTop = 0; });
    children.addEventListener('change', () => { void refresh(); });
    dialog.querySelector('[data-action="refresh"]').addEventListener('click', () => { void refresh(true); });
    dialog.querySelector('[data-action="close"]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { if (!dialog.open) generation++; });
    for (const button of dialog.querySelectorAll('[data-picker]')) button.addEventListener('click', () => { void nativePicker(button.dataset.picker).catch(showError); });
  }
  document.getElementById('conversationBtn')?.addEventListener('click', () => { void open(); });
  window.addEventListener('wincmux:languagechange', () => { if (dialog?.open) render(); });
  window.wincmuxConversations = { open, resume, refresh };
})();
