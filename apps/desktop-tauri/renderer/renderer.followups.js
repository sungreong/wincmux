(() => {
  const drafts = new Map();
  let setupPromise;
  const statuses = { pending: '대기', paused: '일시 정지', claimed: '전송 중', sent: '입력 제출', cancelled: '취소', failed: '전송 안 됨' };
  const localValue = date => {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const panels = () => [...document.querySelectorAll('.pane-followup-panel:not([hidden])')];
  let queueRequest = 0;
  const queue = () => document.getElementById('terminalFollowupQueue');
  const modeLabel = item => item.delivery_mode === 'after_completion' ? '작업 완료 후' : item.delivery_mode === 'when_ready' ? '입력 가능할 때' : '시각 지정';
  const forceButton = (item, refresh) => {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = '↑ 지금 보내기';
    button.title = '대기 순서를 건너뛰고 터미널에 즉시 입력합니다. 에이전트 수신은 확인되지 않을 수 있습니다.';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await rpc('followup.send_now', { id: item.id });
        if (result.status !== 'sent') throw Error(result.result ?? '즉시 전송하지 못했습니다.');
        setStatus('대기열 입력을 터미널에 즉시 제출했습니다.');
        await refresh();
      } catch (error) {
        setStatus(`즉시 전송 실패: ${error.message ?? error}`, true);
        button.disabled = false;
        await refresh();
      }
    });
    return button;
  };
  const dueLabel = item => {
    const date = new Date(Number(item.due_at) * 1000);
    if (!Number.isFinite(date.getTime())) return '시각 확인 필요';
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} 이후`;
  };
  async function refreshQueue() {
    const target = queue();
    const sessionId = target?.dataset.sessionId;
    const request = ++queueRequest;
    if (!sessionId) { if (target) { target.hidden = true; target.replaceChildren(); } return; }
    try {
      const { items = [] } = await rpc('followup.list', { session_id: sessionId });
      if (request !== queueRequest || target.dataset.sessionId !== sessionId) return;
      const active = items.filter(item => ['pending', 'paused', 'claimed'].includes(item.status)).reverse();
      const visible = active;
      target.replaceChildren();
      target.hidden = !visible.length;
      for (const item of visible) {
        const row = document.createElement('div'); row.className = 'pane-followup-queue-row';
        const status = document.createElement('strong'); status.textContent = `${statuses[item.status] ?? item.status} · ${item.delivery_mode === 'at_time' ? dueLabel(item) : modeLabel(item)}`;
        if (item.delivery_mode === 'at_time') status.title = `예약 시각: ${dueLabel(item)}`;
        const prompt = document.createElement('span'); prompt.textContent = item.prompt;
        row.append(status, prompt);
        if (item.status === 'pending' || item.status === 'paused') {
          row.append(forceButton(item, refreshQueue));
          const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = item.status === 'pending' ? '일시 정지' : '재개';
          toggle.addEventListener('click', async () => { await rpc(item.status === 'pending' ? 'followup.pause' : 'followup.resume', { id: item.id }); await refreshQueue(); });
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '취소';
          cancel.addEventListener('click', async () => { await rpc('followup.cancel', { id: item.id }); await refreshQueue(); });
          row.append(toggle, cancel);
        }
        target.append(row);
      }
    } catch (err) {
      if (request === queueRequest) { target.hidden = false; target.textContent = `예약 목록을 읽지 못했습니다: ${err.message ?? err}`; }
    }
  }
  function bindComposer(paneId, sessionId) {
    const target = queue();
    if (!target || (target.dataset.paneId === paneId && target.dataset.sessionId === sessionId)) return;
    target.dataset.paneId = paneId ?? '';
    target.dataset.sessionId = sessionId ?? '';
    void refreshQueue();
  }
  const positionPanel = panel => {
    const card = panel.parentElement;
    const composer = card?.querySelector(':scope > .pane-composer:not([hidden])');
    if (!card) return;
    const cardRect = card.getBoundingClientRect();
    const anchorTop = composer && getComputedStyle(composer).display !== 'none'
      ? composer.getBoundingClientRect().top : cardRect.bottom - 8;
    panel.style.bottom = `${Math.max(8, Math.round(cardRect.bottom - anchorTop + 8))}px`;
    panel.style.maxHeight = `${Math.max(80, Math.round(anchorTop - cardRect.top - 16))}px`;
  };
  const errorBox = panel => panel.querySelector('.followup-error');
  const showError = (panel, message) => {
    const error = errorBox(panel);
    error.textContent = String(message?.message ?? message);
    error.hidden = false;
  };
  const saveDraft = panel => {
    const form = panel.querySelector('form');
    drafts.set(panel.dataset.sessionId, {
      prompt: form.elements.prompt.value,
      mode: form.elements.delivery_mode.value,
      due: form.elements.due.value
    });
  };

  function updateMode(panel) {
    const form = panel.querySelector('form');
    const timed = form.elements.delivery_mode.value === 'at_time';
    panel.querySelector('.followup-time').hidden = !timed;
    form.elements.due.required = timed;
    panel.querySelector('.followup-hint').textContent = timed
      ? '지정 시각 이후 이 에이전트가 작업을 마치고 입력 가능한 상태이면 한 번 전송합니다.'
      : '예약한 뒤 다음 작업 완료를 감지하면 한 번 전송합니다. 이미 완료됐다면 그다음 작업 완료를 기다립니다.';
    saveDraft(panel);
  }

  async function refreshPanel(panel) {
    if (!panel.isConnected || panel.hidden) return;
    try {
      const result = await rpc('followup.list', { session_id: panel.dataset.sessionId });
      if (!panel.isConnected || panel.hidden) return;
      const list = panel.querySelector('.followup-list');
      list.replaceChildren();
      const items = result.items ?? [];
      if (!items.length) {
        const empty = document.createElement('p');
        empty.textContent = '이 터미널에 예약된 후속 입력이 없습니다.';
        list.append(empty);
      }
      for (const item of items) {
        const row = document.createElement('div'); row.className = 'followup-row';
        const title = document.createElement('strong'); title.textContent = `${statuses[item.status] ?? item.status} · ${modeLabel(item)}`;
        const detail = document.createElement('span');
        const agent = state.agentStates.get(panel.dataset.sessionId);
        const completed = item.provider === 'terminal' && Number(agent?.terminal_completed_count ?? 0) > Number(item.completion_after ?? 0);
        const waitText = completed && item.status === 'pending' ? '완료 감지됨 · 입력 가능 상태 확인 중' : '다음 완료 신호';
        detail.textContent = `${item.delivery_mode === 'at_time' ? dueLabel(item) : waitText} · ${item.prompt.slice(0, 100)}`;
        row.append(title, detail);
        if (item.result) { const resultText = document.createElement('small'); resultText.textContent = item.result; row.append(resultText); }
        if (item.status === 'pending' || item.status === 'paused') {
          row.append(forceButton(item, () => refreshPanel(panel)));
          const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = item.status === 'pending' ? '일시 정지' : '다시 시작';
          toggle.addEventListener('click', async () => {
            try { await rpc(item.status === 'pending' ? 'followup.pause' : 'followup.resume', { id: item.id }); await refreshPanel(panel); }
            catch (err) { showError(panel, err); }
          });
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '취소';
          cancel.addEventListener('click', async () => {
            try { await rpc('followup.cancel', { id: item.id }); await refreshPanel(panel); }
            catch (err) { showError(panel, err); }
          });
          row.append(toggle, cancel);
        }
        list.append(row);
      }
    } catch (err) { showError(panel, err); }
  }

  function updateTarget() {
    for (const panel of panels()) {
      const sid = panel.dataset.sessionId;
      const paneId = panel.dataset.paneId;
      const hook = state.agentStates.get(sid)?.hook;
      const bound = state.paneSessions[paneId] === sid;
      const view = state.paneViews.get(paneId);
      const ready = Boolean(bound && view?.sessionId === sid && !view.detached);
      panel.querySelector('.followup-target').textContent = !bound
        ? '이 터미널의 세션이 바뀌었습니다. 패널을 다시 열어 주세요.'
        : ready
          ? hook?.active && hook?.agent_id
            ? `${hook.provider} · 훅 연결됨 · 이 터미널 세션에 고정`
            : '훅 없이 자동 감지 · 실행 중인 Codex·Claude·Gemini와 터미널 입력 대기를 확인합니다.'
          : '실행 중인 터미널을 선택해 주세요.';
      panel.querySelector('.followup-save').disabled = !ready || panel.dataset.saving === '1';
    }
  }

  async function loadSetup(panel) {
    setupPromise ??= rpc('agent.hook_setup');
    const { core_path: corePath } = await setupPromise;
    if (!panel.isConnected) return;
    const makeHooks = (provider, events) => Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', ...(provider === 'codex'
      ? { command: `"${corePath}" --agent-hook codex ${event}` }
      : { command: corePath, args: ['--agent-hook', 'claude', event] }), timeout: 3 }] }]]));
    panel.querySelector('[data-setup="codex"]').value = JSON.stringify({ hooks: makeHooks('codex', ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd']) }, null, 2);
    panel.querySelector('[data-setup="claude"]').value = JSON.stringify({ hooks: makeHooks('claude', ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd']) }, null, 2);
  }

  function createPanel(card, paneId, sessionId) {
    const panel = document.createElement('section');
    panel.className = 'pane-followup-panel';
    panel.dataset.paneId = paneId;
    panel.dataset.sessionId = sessionId;
    panel.setAttribute('aria-label', '이 터미널의 후속 입력');
    panel.innerHTML = `<form class="followup-form"><header><h2>후속 입력 · 이 터미널</h2><button type="button" data-close aria-label="닫기">✕</button></header>
      <p class="followup-target"></p><fieldset class="followup-modes"><legend>보낼 때</legend>
        <label><input type="radio" name="delivery_mode" value="after_completion" checked> 현재 작업 완료 후</label>
        <label><input type="radio" name="delivery_mode" value="at_time"> 지정 시각 이후</label></fieldset>
      <label class="followup-time" hidden>보낼 시각<input name="due" type="datetime-local"></label>
      <label>에이전트에 보낼 내용<textarea name="prompt" rows="5" maxlength="16000" required></textarea></label>
      <p class="followup-hint"></p><p class="followup-error" role="alert" hidden></p>
      <button type="submit" class="followup-save" disabled>이 터미널에 예약</button></form>
      <section class="followup-list" aria-label="이 터미널의 예약 목록"></section>
      <details class="followup-setup"><summary>선택 사항 · Codex·Claude 훅 연결 방법</summary>
        <p>실행 중인 코어의 경로가 들어간 hooks 값을 기존 설정에 병합하세요. 설정 파일 전체를 덮어쓰지 마세요. Codex 훅은 실행 전 신뢰 승인이 필요합니다.</p>
        <label>Codex · ~/.codex/hooks.json<textarea data-setup="codex" readonly rows="9"></textarea></label><button type="button" data-copy="codex">Codex 설정 복사</button>
        <label>Claude · ~/.claude/settings.json<textarea data-setup="claude" readonly rows="9"></textarea></label><button type="button" data-copy="claude">Claude 설정 복사</button>
        <p>설정 후 새 터미널에서 에이전트를 실행하세요. 훅 수신 횟수가 표시되면 연결된 것입니다.</p>
      </details>`;
    card.append(panel);
    panel.addEventListener('pointerdown', event => event.stopPropagation());
    panel.querySelector('[data-close]').addEventListener('click', () => { saveDraft(panel); panel.hidden = true; });
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { saveDraft(panel); panel.hidden = true; } });
    const form = panel.querySelector('form');
    const draft = drafts.get(sessionId);
    form.elements.prompt.value = draft?.prompt ?? '';
    form.elements.due.value = draft?.due ?? localValue(new Date(Date.now() + 10 * 60 * 1000));
    if (draft?.mode === 'at_time') form.querySelector('[value="at_time"]').checked = true;
    form.addEventListener('input', () => saveDraft(panel));
    form.addEventListener('change', () => updateMode(panel));
    panel.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
      const field = panel.querySelector(`[data-setup="${button.dataset.copy}"]`);
      try { await navigator.clipboard.writeText(field.value); }
      catch { field.select(); document.execCommand('copy'); }
    }));
    form.addEventListener('submit', async event => {
      event.preventDefault(); errorBox(panel).hidden = true;
      if (state.paneSessions[paneId] !== sessionId) { showError(panel, '이 터미널의 세션이 바뀌었습니다. 다시 열어 주세요.'); return; }
      const deliveryMode = form.elements.delivery_mode.value;
      const params = { session_id: sessionId, prompt: form.elements.prompt.value, delivery_mode: deliveryMode };
      if (deliveryMode === 'at_time') {
        params.due_at = Math.floor(new Date(form.elements.due.value).getTime() / 1000);
        if (!Number.isFinite(params.due_at)) { showError(panel, '시각을 확인해 주세요.'); return; }
      }
      panel.dataset.saving = '1'; updateTarget();
      try {
        await rpc('followup.schedule', params);
        form.elements.prompt.value = ''; saveDraft(panel);
        panel.hidden = true;
        await refreshQueue();
      } catch (err) { showError(panel, err); }
      finally { delete panel.dataset.saving; updateTarget(); }
    });
    updateMode(panel);
    void loadSetup(panel).catch(err => { setupPromise = null; showError(panel, err); });
    return panel;
  }

  async function open(paneId) {
    const card = state.paneCards.get(paneId);
    const sessionId = state.paneSessions[paneId];
    if (!card || !sessionId) return;
    let panel = card.querySelector(':scope > .pane-followup-panel');
    if (panel?.dataset.sessionId !== sessionId) { panel?.remove(); panel = null; }
    if (!panel) panel = createPanel(card, paneId, sessionId);
    else if (!panel.hidden) { saveDraft(panel); panel.hidden = true; return; }
    panel.hidden = false;
    positionPanel(panel);
    updateTarget();
    await refreshPanel(panel);
  }

  const reposition = () => panels().forEach(positionPanel);
  window.addEventListener('resize', reposition);
  window.wincmuxFollowups = { open, bindComposer, refresh: () => Promise.all([refreshQueue(), ...panels().map(refreshPanel)]), updateTarget, reposition };
  bindComposer(state.selectedPaneId, state.paneViews.get(state.selectedPaneId)?.sessionId);
})();
