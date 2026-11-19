(() => {
  const dialog = document.getElementById('mcpSettingsDialog');
  const enabled = document.getElementById('mcpSettingsEnabled');
  const developmentFolder = document.getElementById('mcpDevelopmentFolder');
  const stateText = document.getElementById('mcpSettingsState');
  const error = document.getElementById('mcpSettingsError');
  const command = document.getElementById('mcpSettingsCommand');
  const copy = document.getElementById('mcpSettingsCopy');
  const infoCopy = document.getElementById('mcpSettingsInfoCopy');
  const promptCopy = document.getElementById('mcpSettingsPromptCopy');
  const prompt = document.getElementById('mcpAgentPrompt');
  const list = document.getElementById('mcpSettingsTools');
  const button = document.getElementById('mcpSettingsBtn');
  const toolbarState = document.getElementById('mcpToolbarState');
  const switchText = document.getElementById('mcpSwitchText');
  const activityList = document.getElementById('mcpActivityList');
  let busy = false;
  let activityBusy = false;
  let activityTimer;
  let lastSettings;
  let infoText = '';

  function showError(cause) {
    error.textContent = String(cause?.message ?? cause);
    error.hidden = false;
  }
  function render(settings) {
    lastSettings = settings;
    enabled.checked = settings.enabled === true;
    developmentFolder.value = settings.development_folder ?? '';
    stateText.textContent = enabled.checked ? '켜짐 · MCP 도구 요청을 받습니다.' : '꺼짐 · MCP 도구 요청이 차단됩니다.';
    toolbarState.textContent = switchText.textContent = enabled.checked ? 'ON' : 'OFF';
    button.dataset.enabled = String(enabled.checked);
    button.title = `MCP ${enabled.checked ? '켜짐' : '꺼짐'} · 설정과 도구 목록`;
    const path = settings.server_path;
    command.textContent = path ? `codex mcp add wincmux -- node "${path}"` : '설치된 WinCMux의 MCP 서버 경로를 확인할 수 없습니다.';
    infoText = path ? JSON.stringify({ name: 'wincmux', transport: 'stdio', command: 'node', args: [path], tools: (settings.tools ?? []).map(tool => tool.name) }, null, 2) : '';
    prompt.textContent = path ? [
      'WinCMux 로컬 MCP 서버를 현재 사용하는 에이전트의 MCP 설정에 등록해 줘.',
      '기존 MCP 서버 설정은 유지하고, 등록 후 wincmux_status로 연결을 확인해 줘.',
      '이 서버는 stdio로 실행되므로 고정 포트나 자동 배정 포트가 필요 없다.',
      '',
      'MCP 서버 정보:', infoText
    ].join('\n') : '설치된 MCP 서버 경로를 찾은 뒤 등록 프롬프트를 복사할 수 있습니다.';
    copy.disabled = infoCopy.disabled = promptCopy.disabled = !path;
    list.replaceChildren();
    for (const tool of settings.tools ?? []) {
      const item = document.createElement('li');
      const name = document.createElement('code'); name.textContent = tool.name;
      const description = document.createElement('span'); description.textContent = `${tool.label} · ${tool.description}`;
      item.append(name, description);
      list.append(item);
    }
  }
  async function refresh() {
    error.hidden = true;
    try { render(await rpc('mcp.settings.get')); }
    catch (cause) { showError(cause); }
  }
  async function refreshActivity() {
    if (activityBusy) return;
    activityBusy = true;
    try {
      const { items = [] } = await rpc('mcp.activity.list');
      activityList.replaceChildren();
      if (!items.length) {
        const empty = document.createElement('li'); empty.textContent = '아직 MCP 도구 요청이 없습니다.';
        activityList.append(empty);
      }
      for (const entry of items) {
        const row = document.createElement('li');
        const at = document.createElement('time');
        at.textContent = new Date(entry.at * 1000).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const tool = document.createElement('code'); tool.textContent = entry.tool;
        const workspace = document.createElement('span');
        workspace.className = 'mcp-activity-workspace';
        workspace.textContent = entry.workspace_name ?? '전체';
        if (entry.workspace_id) workspace.title = entry.workspace_id;
        const outcome = document.createElement('strong'); outcome.dataset.outcome = entry.outcome;
        outcome.textContent = { success: '성공', blocked: '차단', failed: '실패' }[entry.outcome] ?? entry.outcome;
        row.append(at, workspace, tool, outcome);
        activityList.append(row);
      }
    } catch (cause) { showError(cause); }
    finally { activityBusy = false; }
  }
  button.addEventListener('click', () => {
    if (dialog.open) return;
    dialog.showModal();
    void refresh();
    void refreshActivity();
    activityTimer = setInterval(() => { if (dialog.open) void refreshActivity(); }, 3000);
  });
  dialog.addEventListener('close', () => { clearInterval(activityTimer); activityTimer = null; });
  document.getElementById('mcpSettingsClose').addEventListener('click', () => dialog.close());
  document.getElementById('mcpActivityRefresh').addEventListener('click', () => void refreshActivity());
  enabled.addEventListener('change', async () => {
    if (busy) return;
    busy = true;
    enabled.disabled = true;
    error.hidden = true;
    try {
      await rpc('mcp.settings.save', { enabled: enabled.checked });
      render(await rpc('mcp.settings.get'));
    } catch (cause) {
      if (lastSettings) render(lastSettings);
      showError(cause);
    } finally {
      busy = false;
      enabled.disabled = false;
    }
  });
  document.getElementById('mcpDevelopmentBrowse').addEventListener('click', async () => {
    try {
      const selected = await window.wincmux.pickFolder();
      if (selected) developmentFolder.value = selected;
    } catch (cause) { showError(cause); }
  });
  async function saveDevelopmentFolder(value) {
    if (busy) return;
    busy = true;
    error.hidden = true;
    try {
      render(await rpc('mcp.settings.save', { development_folder: value }));
    } catch (cause) { showError(cause); }
    finally { busy = false; }
  }
  document.getElementById('mcpDevelopmentSave').addEventListener('click', () => void saveDevelopmentFolder(developmentFolder.value.trim()));
  document.getElementById('mcpDevelopmentReset').addEventListener('click', () => void saveDevelopmentFolder(''));
  async function copyText(value, button) {
    try { await window.wincmux.clipboardWrite(value); button.textContent = '복사됨'; }
    catch (cause) { showError(cause); }
  }
  copy.addEventListener('click', () => copyText(command.textContent, copy));
  infoCopy.addEventListener('click', () => copyText(infoText, infoCopy));
  promptCopy.addEventListener('click', () => copyText(prompt.textContent, promptCopy));
  window.wincmuxMcpSettings = { open: () => button.click(), refresh };
})();
