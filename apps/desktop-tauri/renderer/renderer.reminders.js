(() => {
  let dialog, form, list, error, options, active = null, loaded = [], refreshTimer;
  let refreshChain=Promise.resolve();
  let settingsDirty=false;
  let busy=false;
  function setBusy(value) {
    busy=value;dialog.dataset.busy=String(value);dialog.setAttribute('aria-busy',String(value));
    dialog.querySelector('.reminder-body').inert=value;
    dialog.querySelector('.reminder-settings').inert=value;
  }
  const names = { claude: "Claude", codex: "Codex", gemini: "Gemini", custom: "사용자" };
  const statuses = { pending: "예약됨", needs_time: "시간 지정 필요", sent: "알림 보냄", cancelled: "취소됨" };
  const localTime = (seconds, timezone) => new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date(seconds * 1000)).replace(' ', 'T');
  function showError(err) { error.textContent = String(err?.message ?? err); error.hidden = false; }
  function fillWorkspaces(value = state.selectedWorkspaceId) {
    form.elements.workspace.replaceChildren();
    for (const workspace of state.workspaces) {
      const option = document.createElement('option'); option.value = workspace.id; option.textContent = workspace.name;
      form.elements.workspace.append(option);
    }
    form.elements.workspace.value = value ?? '';
  }
  function fillEditor(item = null) {
    active = item;
    error.hidden = true;
    form.reset(); fillWorkspaces(item?.workspace_id);
    form.elements.title.value = item?.title ?? '';
    form.elements.body.value = item?.body ?? '';
    form.elements.provider.value = item?.provider ?? 'custom';
    form.elements.timezone.value = item?.timezone ?? options.timezone;
    form.elements.due.value = item?.due_at ? localTime(item.due_at, form.elements.timezone.value)
      : item?.status === 'needs_time' ? '' : localTime(Date.now()/1000 + 1800, form.elements.timezone.value);
    const session = item?.session_id ?? state.paneSessions[state.selectedPaneId];
    form.elements.attach.checked = Boolean(session);
    form.elements.attach.disabled = !session;
    form.querySelector('[data-action="cancel"]').disabled = !item || !['pending','needs_time'].includes(item.status);
    form.querySelector('[data-action="delete"]').disabled = !item;
    form.querySelector('[type="submit"]').textContent = item ? '변경하여 예약' : '알림 등록';
    dialog.querySelector('#reminderEditorTitle').textContent = item ? '예약 상세' : '새 알림 등록';
    dialog.querySelector('#reminderSource').textContent = item
      ? `${item.source === 'auto' ? '한도 문구에서 자동 등록' : '직접 등록'} · ${statuses[item.status]}${item.observed_at ? ` · 감지 ${localTime(item.observed_at,item.timezone).replace('T',' ')}` : ''}` : '시간이 되면 Windows 알림과 앱 알림으로 알려드립니다.';
    renderList();
  }
  function renderList() {
    if (!list) return;
    list.replaceChildren();
    const history = dialog.querySelector('#reminderShowHistory').checked;
    const items = history ? loaded : loaded.filter(item => ['pending','needs_time'].includes(item.status));
    for (const item of items) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'reminder-row';
      row.dataset.id = item.id; row.dataset.status = item.status; row.dataset.selected = String(active?.id === item.id);
      const top = document.createElement('span'); top.className = 'reminder-row-top';
      const title = document.createElement('strong'); title.textContent = item.title;
      const badge = document.createElement('span'); badge.className = 'reminder-status'; badge.textContent = statuses[item.status];
      top.append(title,badge);
      const meta = document.createElement('span'); meta.className = 'reminder-row-meta';
      meta.textContent = `${names[item.provider]} · ${item.workspace_name} · ${item.source === 'auto' ? '자동' : '직접 등록'}`;
      const due = document.createElement('span'); due.className = 'reminder-row-due';
      due.textContent = item.due_at ? `${localTime(item.due_at,item.timezone).replace('T',' ')} · ${item.timezone}` : '초기화 시각을 직접 지정하세요.';
      row.append(top,meta,due); row.addEventListener('click',()=>fillEditor(item)); list.append(row);
    }
    if (!items.length) { const empty=document.createElement('p');empty.className='reminder-empty';empty.textContent='예약된 알림이 없습니다. 직접 등록하거나 한도 문구 자동 감지를 켜세요.';list.append(empty); }
  }
  function refresh() {
    refreshChain=refreshChain.catch(()=>{}).then(loadReminders);
    return refreshChain;
  }
  async function loadReminders() {
    try {
      const result = await rpc('reminder.list',{});
      loaded = result.items; options = result.settings;
      const count = loaded.filter(item=>['pending','needs_time'].includes(item.status)).length;
      document.getElementById('reminderCount').textContent = count ? ` ${count}` : '';
      if (dialog?.open) {
        if(!settingsDirty) {
          dialog.querySelector('#reminderAutoEnabled').checked = Boolean(options.auto_enabled);
          dialog.querySelector('#reminderDefaultTimezone').value = options.timezone;
        }
        renderList();
      }
    } catch (err) {
      if (dialog?.open) showError(/method not found/.test(String(err)) ? '실행 중인 코어가 예약 알림을 지원하지 않습니다. 작업 종료 후 완전히 종료하고 새 버전으로 실행하세요.' : err);
    }
  }
  function createDialog() {
    dialog=document.createElement('dialog'); dialog.id='reminderDialog'; dialog.className='reminder-dialog';
    dialog.setAttribute('aria-labelledby','reminderTitle');
    dialog.innerHTML=`<header class="reminder-header"><div><h2 id="reminderTitle">예약 알림</h2><p>직접 시간을 정하거나 Claude·Codex·Gemini의 한도 문구에서 자동으로 등록합니다.</p></div><button type="button" data-action="close" aria-label="예약 알림 닫기">✕</button></header>
      <div class="reminder-settings"><label><input id="reminderAutoEnabled" type="checkbox" />한도 문구 자동 등록</label><label>기본 시간대<input id="reminderDefaultTimezone" list="reminderTimezones" aria-label="자동 감지 기본 시간대" /></label><small>문구에 시간대가 없을 때 사용합니다.</small><button type="button" data-action="settings">설정 적용</button></div>
      <div class="reminder-body"><section class="reminder-list-panel"><div class="reminder-list-actions"><button type="button" data-action="new">＋ 새 알림</button><label><input id="reminderShowHistory" type="checkbox" />지난 알림 포함</label></div><div class="reminder-list" aria-label="예약 알림 목록"></div></section>
      <form id="reminderEditor" class="reminder-editor"><h3 id="reminderEditorTitle">새 알림 등록</h3><p id="reminderSource"></p><label>제목<input name="title" maxlength="200" required placeholder="예: Claude 다시 확인하기" /></label><div class="reminder-fields"><label>도구<select name="provider"><option value="custom">사용자 지정</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="gemini">Gemini</option></select></label><label>워크스페이스<select name="workspace" required></select></label></div><label>알림 시각<input name="due" type="datetime-local" required /></label><div class="reminder-quick-times"><button type="button" data-minutes="10">10분 후</button><button type="button" data-minutes="30">30분 후</button><button type="button" data-minutes="60">1시간 후</button></div><label>시간대<input name="timezone" list="reminderTimezones" required placeholder="Asia/Seoul" /></label><label>내용 / 감지한 원문<textarea name="body" rows="3" maxlength="4096"></textarea></label><label class="reminder-attach"><input name="attach" type="checkbox" />이 알림의 터미널에 연결</label><p class="reminder-error" role="alert" hidden></p><div class="reminder-editor-actions"><button type="button" data-action="delete">삭제</button><button type="button" data-action="cancel">예약 취소</button><button type="submit" class="reminder-save">알림 등록</button></div></form></div>
      <footer class="reminder-footer">창을 닫아도 예약은 유지됩니다. PC 종료·앱 완전 종료 중 지난 알림은 다시 실행할 때 표시합니다. 한도 초기화 알림은 실제 사용 가능 여부를 보장하지 않습니다.</footer><datalist id="reminderTimezones"><option value="Asia/Seoul"></option><option value="UTC"></option><option value="Asia/Tokyo"></option><option value="America/New_York"></option><option value="America/Los_Angeles"></option><option value="Europe/London"></option></datalist>`;
    document.body.append(dialog); form=dialog.querySelector('form'); list=dialog.querySelector('.reminder-list'); error=dialog.querySelector('.reminder-error');
    for(const id of ['reminderAutoEnabled','reminderDefaultTimezone'])dialog.querySelector('#'+id).addEventListener('input',()=>{settingsDirty=true;});
    dialog.querySelector('#reminderShowHistory').addEventListener('change',renderList);
    dialog.addEventListener('click',async ev=>{
      const button=ev.target.closest('button'); if (!button) return;
      const action=button.dataset.action;
      if (action==='close') {dialog.close();return;}
      if(busy)return;
      if (button.dataset.minutes) {
        try {form.elements.due.value=localTime(Date.now()/1000+Number(button.dataset.minutes)*60,form.elements.timezone.value);} catch(err){showError(err);}
        return;
      }
      if (action==='new') {fillEditor();form.elements.title.focus();return;}
      if (action==='settings') {
        error.hidden=true;
        setBusy(true);
        button.disabled=true;
        try { await rpc('reminder.settings.save',{auto_enabled:dialog.querySelector('#reminderAutoEnabled').checked,timezone:dialog.querySelector('#reminderDefaultTimezone').value.trim()}); settingsDirty=false; await refresh(); setStatus('알림 감지 설정을 저장했습니다.'); }
        catch(err){showError(err);} finally{button.disabled=false;setBusy(false);}
      }
      if (['cancel','delete'].includes(action) && active) {
        setBusy(true);
        button.disabled=true;
        try { await rpc(`reminder.${action}`,{id:active.id}); await refresh(); fillEditor(); }
        catch(err){showError(err);} finally{if(active)button.disabled=false;setBusy(false);}
      }
    });
    form.addEventListener('submit',async ev=>{
      ev.preventDefault();error.hidden=true;
      const button=form.querySelector('[type="submit"]'); if(button.disabled||busy)return;
      setBusy(true);
      button.disabled=true;
      try {
        const ws=form.elements.workspace.value;
        const sid=active ? active.workspace_id===ws ? active.session_id : null : ws===state.selectedWorkspaceId ? state.paneSessions[state.selectedPaneId] : null;
        const saved=await rpc('reminder.save',{id:active?.id,workspace_id:ws,session_id:form.elements.attach.checked ? sid : null,provider:form.elements.provider.value,title:form.elements.title.value.trim(),body:form.elements.body.value,local_time:form.elements.due.value,timezone:form.elements.timezone.value.trim()});
        await refresh(); fillEditor(saved); setStatus('알림을 예약했습니다.');
      }catch(err){showError(err);}finally{button.disabled=false;setBusy(false);}
    });
  }
  async function open() {
    if(busy)return;
    if(!dialog)createDialog();
    if(dialog.open)return;
    options ??= {timezone:'Asia/Seoul',auto_enabled:1};
    settingsDirty=false; error.hidden=true; dialog.showModal(); await refresh();
    const message=!error.hidden ? error.textContent : null;
    fillEditor(); if(message)showError(message);
    form.elements.title.focus();
  }
  function scheduleRefresh() { clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>void refresh(),150); }
  let toast, toastTimer;
  function showToast(notification) {
    if(!toast) {
      toast=document.createElement('div');toast.className='reminder-toast';toast.setAttribute('role','status');
      const title=document.createElement('strong'),body=document.createElement('p'),actions=document.createElement('div');
      const show=document.createElement('button');show.textContent='예약 보기';show.addEventListener('click',()=>{toast.hidden=true;void open();});
      const close=document.createElement('button');close.textContent='닫기';close.addEventListener('click',()=>{toast.hidden=true;});
      actions.append(show,close);toast.append(title,body,actions);document.body.append(toast);
    }
    toast.querySelector('strong').textContent=notification.title;
    toast.querySelector('p').textContent=notification.body;
    toast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast.hidden=true;},15000);
  }
  window.wincmux.onStreamEvent(event=>{
    if(event.method==='notify.reminders_changed')scheduleRefresh();
    if(event.method==='notify.created' && ['reminder_due','usage_limit'].includes(event.params?.notification?.kind)) { showToast(event.params.notification);scheduleRefresh(); }
  });
  document.getElementById('reminderBtn')?.addEventListener('click',()=>void open());
  document.getElementById('reminderPanelBtn')?.addEventListener('click',()=>void open());
  window.addEventListener('DOMContentLoaded',scheduleRefresh);
  window.wincmuxReminders={open,refresh};
})();
