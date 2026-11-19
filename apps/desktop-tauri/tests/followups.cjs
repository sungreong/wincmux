const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function testRealCodex(cdp, pane, temp) {
  const composer = 'document.getElementById("terminalPromptText")';
  const realSid = await cdp.eval(`startSessionForPane(${JSON.stringify(pane)},${JSON.stringify({
    force: true, cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd: temp, focusTerm: false
  })})`);
  const realCall = (method, params = {}) => cdp.eval(`rpc(${JSON.stringify(method)},${JSON.stringify({ session_id: realSid, ...params })})`);
  const realState = async () => (await realCall('agent.list')).items.find(item => item.session_id === realSid);
  const screen = async () => (await realCall('session.screen_text')).lines;
  await until(() => cdp.eval(`!document.getElementById('terminalPromptSend').disabled && document.getElementById('terminalFollowupQueue').dataset.sessionId === ${JSON.stringify(realSid)}`), 'UI bound to the live Codex pane');
  await realCall('session.resize', { cols: 61, rows: 35 });
  await realCall('session.write', { data: 'codex\r' });
  let folderAccessAttempts = 0;
  let retryFolderAccessAt = 0;
  await until(async () => {
    if ((await realState())?.terminal_ready) return true;
    const visible = (await screen()).join('\n');
    if (folderAccessAttempts < 3 && Date.now() >= retryFolderAccessAt
      && visible.includes('Folder access') && visible.includes('› 1. Open restricted')) {
      folderAccessAttempts += 1;
      retryFolderAccessAt = Date.now() + 1500;
      await realCall('session.write', { data: '\r' });
    }
    return false;
  }, 'real Codex ready in UI', 60000).catch(async error => {
    throw Error(`${error.message}; detector=${JSON.stringify(await realState())}; screen=${JSON.stringify((await screen()).filter(Boolean).slice(-8))}`);
  });
  const first = 'Reply with exactly UI-ONE. Do not use tools.';
  const second = 'Reply with exactly UI-TWO. Do not use tools.';
  await cdp.eval(`(() => {
    const editor = ${composer};
    editor.value=${JSON.stringify(first)};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('terminalPromptSend').click();
  })()`);
  await until(async () => (await realState())?.state === 'working', 'real Codex working after UI button', 15000).catch(async error => {
    const editor = await cdp.eval(`({ draft: ${composer}.value, error: document.getElementById('terminalPromptError').textContent })`);
    const queue = (await realCall('followup.list')).items.map(({ status, result }) => ({ status, result }));
    const visible = (await screen()).filter(line => /UI-(ONE|TWO)|Reconnect|request failed|Working/.test(line));
    throw Error(`${error.message}; editor=${JSON.stringify(editor)}; queue=${JSON.stringify(queue)}; screen=${JSON.stringify(visible)}; detector=${JSON.stringify(await realState())}`);
  });
  await cdp.eval(`(() => {
    const editor = ${composer};
    editor.value = ${JSON.stringify(second)};
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  })()`);
  const secondRow = async () => (await realCall('followup.list')).items.find(item => item.prompt === second);
  await until(async () => (await secondRow())?.status === 'pending', 'real Codex second UI input queued', 12000);
  await until(async () => (await screen()).some(line => /^\s*• UI-ONE\s*$/.test(line)), 'real Codex first reply from UI', 45000);
  await until(async () => (await screen()).some(line => /^\s*• UI-TWO\s*$/.test(line)), 'real Codex queued reply from UI', 45000);
  assert.equal((await secondRow()).status, 'sent');
  console.log('Real Codex: UI send button and Ctrl+Enter queue both returned replies.');
}

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-followups-ui-'));
  const agent = path.join(temp, 'codex.exe');
  fs.copyFileSync(process.execPath, agent);
  const port = await portNumber();
  const executable = process.env.WINCMUX_FOLLOWUP_TEST_EXE
    || path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe');
  const child = spawn(executable,
    ['--benchmark-hidden'], { windowsHide: true, stdio: 'ignore', env: {
      ...process.env,
      WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-followups-ui-' + randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`
    } });
  let cdp;
  try {
    cdp = await connect(port, child);
    await until(() => cdp.eval('typeof state!=="undefined" && state.bootstrapReady===true && Boolean(window.wincmuxFollowups)'), 'bootstrap');
    const ws = await cdp.eval(`rpc('workspace.create',${JSON.stringify({ name: 'Follow-up UI', path: temp, backend: 'custom' })})`);
    await cdp.eval(`loadWorkspaces().then(()=>switchWorkspace(${JSON.stringify(ws.workspace.id)}))`);
    await until(() => cdp.eval('state.paneViews.size>0'), 'pane');
    assert.equal(await cdp.eval('document.getElementById("followupBtn")'), null, 'no global follow-up control');
    const pane = await cdp.eval('[...state.paneViews.keys()][0]');
    if (process.argv.includes('--real-codex')) {
      await testRealCodex(cdp, pane, temp);
      return;
    }
    const sid = await cdp.eval(`startSessionForPane(${JSON.stringify(pane)},${JSON.stringify({
      force: true, cmd: agent, args: [path.join(__dirname, 'terminal-followup-fixture.cjs')], cwd: temp, focusTerm: false
    })})`);
    assert.equal(await cdp.eval(`rpc('agent.list',{include_process_presence:true}).then(r=>r.items.find(i=>i.session_id===${JSON.stringify(sid)})?.agent_process_attached)`), true, 'agent process is detected before choosing send mode');
    await until(() => cdp.eval('!document.getElementById("terminalPromptFollowup").disabled'), 'composer follow-up button');
    assert.equal(await cdp.eval(`state.paneCards.get(${JSON.stringify(pane)}).querySelector('.pane-header .pane-followup-btn')`), null);
    assert.equal(await cdp.eval('document.getElementById("terminalPromptFollowup").closest(".pane-composer")?.parentElement.dataset.paneId'), pane);
    await cdp.request('Emulation.setDeviceMetricsOverride', { width: 1178, height: 760, deviceScaleFactor: 1, mobile: false });
    const toolbarMetrics = await cdp.eval('(() => { const t=document.querySelector(".toolbar"); return {height:t.getBoundingClientRect().height,width:t.clientWidth,scrollWidth:t.scrollWidth,wrap:getComputedStyle(t).flexWrap}; })()');
    assert(toolbarMetrics.scrollWidth <= toolbarMetrics.width + 1, `toolbar stays within the viewport: ${JSON.stringify(toolbarMetrics)}`);
    assert.equal(await cdp.eval('document.getElementById("terminalPromptBtn")'), null, 'toolbar has no duplicate input button');
    assert.equal(await cdp.eval('getComputedStyle(document.querySelector(".pane-composer > form")).display'), 'flex', 'input remains under the terminal');
    await cdp.eval('document.getElementById("terminalPromptExpand").click()');
    assert.equal(await cdp.eval('document.getElementById("terminalPrompt").open'), true);
    await cdp.eval('document.getElementById("terminalPromptFollowup").click()');
    const panel = `state.paneCards.get(${JSON.stringify(pane)}).querySelector('.pane-followup-panel')`;
    assert.equal(await cdp.eval(`(() => {const a=${panel}.getBoundingClientRect(), b=state.paneCards.get(${JSON.stringify(pane)}).getBoundingClientRect(); return a.bottom <= b.bottom})()`), true, 'panel stays in terminal card');
    const shot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(root, 'artifacts', 'followups-per-pane.png'), Buffer.from(shot.data, 'base64'));
    const panelState = await cdp.eval(`(() => ({current:${panel}?.dataset.sessionId, count:document.querySelectorAll('.pane-followup-panel').length, pane:state.selectedPaneId, session:state.paneSessions[${JSON.stringify(pane)}], attached:state.paneCards.get(${JSON.stringify(pane)})?.isConnected}))()`);
    assert.equal(panelState.current, sid, JSON.stringify(panelState));
    assert.equal(await cdp.eval(`${panel}.querySelector('input[name="delivery_mode"]:checked').value`), 'after_completion');
    assert.equal(await cdp.eval(`${panel}.querySelector('.followup-time').hidden`), true);
    assert.equal(await cdp.eval(`${panel}.querySelector('.followup-save').disabled`), false, 'no hook setup is required');
    await cdp.eval(`(() => { const p=${panel}; p.querySelector('[name="prompt"]').value='UI no-hook reservation'; p.querySelector('form').requestSubmit(); })()`);
    await until(() => cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}}).then(r=>r.items.length===1 && r.items[0].status==='pending')`), 'UI reservation without hook');
    await until(() => cdp.eval(`${panel}.hidden && document.querySelector('#terminalFollowupQueue:not([hidden]) .pane-followup-queue-row')?.textContent.includes('UI no-hook reservation')`), 'inline queue after panel closes');
    assert.equal(await cdp.eval('document.getElementById("terminalFollowupQueue").getBoundingClientRect().height <= 62'), true, 'queue strip has a bounded height');
    await cdp.eval(`rpc('session.write',{session_id:${JSON.stringify(sid)},data:'#finish#'})`);
    await until(() => cdp.eval(`state.agentStates.get(${JSON.stringify(sid)})?.terminal_completed_count > 0`), 'rendered completion').catch(async error => {
      throw Error(`${error.message}; agent=${JSON.stringify(await cdp.eval(`rpc('agent.list')`))}; tail=${JSON.stringify(await cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(sid)}})`))}; ui=${JSON.stringify(await cdp.eval(`state.agentStates.get(${JSON.stringify(sid)})`))}`);
    });
    await cdp.eval(`rpc('session.write',{session_id:${JSON.stringify(sid)},data:'#draft#'})`);
    await until(() => cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}}).then(r=>r.items[0]?.status==='sent')`), 'UI follow-up submitted', 12000);
    await cdp.eval(`rpc('session.write',{session_id:${JSON.stringify(sid)},data:'#finish#'})`);
    await until(() => cdp.eval(`state.agentStates.get(${JSON.stringify(sid)})?.terminal_prompt_visible===true`), 'composer prompt visible after completion');
    const composer = 'document.getElementById("terminalPromptText")';
    await cdp.eval('document.getElementById("terminalPromptExpand").click()');
    await cdp.eval(`(() => { ${composer}.value='Direct composer send'; document.getElementById('terminalPromptForm').requestSubmit(document.getElementById('terminalPromptSend')); })()`);
    await until(() => cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(sid)}}).then(r=>r.output.includes(${JSON.stringify('RECEIVED:' + Buffer.from('Direct composer send').toString('base64'))}))`), 'composer input reached terminal').catch(async error => {
      throw Error(`${error.message}; input=${JSON.stringify(await cdp.eval(`${composer}.value`))}; message=${JSON.stringify(await cdp.eval('document.getElementById("terminalPromptError").textContent'))}; tail=${JSON.stringify(await cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(sid)}}).then(r=>r.output.slice(-500))`))}`);
    });
    await until(() => cdp.eval(`state.agentStates.get(${JSON.stringify(sid)})?.state==='working'`), 'agent working after direct composer send');
    const queuedByComposer = ['Composer waits first', 'Composer waits second'];
    for (const prompt of queuedByComposer) {
      await cdp.eval(`(() => { ${composer}.value=${JSON.stringify(prompt)}; document.getElementById('terminalPromptForm').requestSubmit(document.getElementById('terminalPromptSend')); })()`);
      await until(() => cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}}).then(r=>r.items.some(i=>i.prompt===${JSON.stringify(prompt)}&&i.status==='pending'))`), 'composer queues while agent works');
      await until(() => cdp.eval('!document.getElementById("terminalPromptText").readOnly'), 'composer ready for next queued input');
    }
    assert.equal(await cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(sid)}}).then(r=>r.output.includes(${JSON.stringify('RECEIVED:' + Buffer.from(queuedByComposer[0]).toString('base64'))}))`), false, 'composer does not submit over running work');
    await cdp.eval(`rpc('session.write',{session_id:${JSON.stringify(sid)},data:'#finish#'})`);
    await until(() => cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}}).then(r=>r.items.find(i=>i.prompt===${JSON.stringify(queuedByComposer[0])})?.status==='sent')`), 'first composer entry after completion', 12000);
    assert.equal(await cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}}).then(r=>r.items.find(i=>i.prompt===${JSON.stringify(queuedByComposer[1])})?.status)`), 'pending', 'second composer entry waits its turn');
    await cdp.eval(`rpc('session.write',{session_id:${JSON.stringify(sid)},data:'#finish#'})`);
    await until(() => cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}}).then(r=>r.items.find(i=>i.prompt===${JSON.stringify(queuedByComposer[1])})?.status==='sent')`), 'second composer entry after completion', 12000);
    await cdp.eval(`rpc('followup.schedule',{session_id:${JSON.stringify(sid)},prompt:'Queued first',delivery_mode:'after_completion'})`);
    await cdp.eval(`rpc('followup.schedule',{session_id:${JSON.stringify(sid)},prompt:'Queued second',delivery_mode:'after_completion'})`);
    await cdp.eval(`rpc('session.write',{session_id:${JSON.stringify(sid)},data:'#finish#'})`);
    await until(() => cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}}).then(r=>r.items.some(i=>i.prompt==='Queued first'&&i.status==='sent'))`), 'first queued submission', 12000);
    assert.equal(await cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}}).then(r=>r.items.find(i=>i.prompt==='Queued second')?.status)`), 'pending', 'second item waits for the next completion');
    await cdp.eval(`rpc('session.write',{session_id:${JSON.stringify(sid)},data:'#finish#'})`);
    await until(() => cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}}).then(r=>r.items.some(i=>i.prompt==='Queued second'&&i.status==='sent'))`), 'second queued submission', 12000);
    await cdp.eval(`window.wincmuxFollowups.open(${JSON.stringify(pane)})`);
    await cdp.eval(`(() => { const p=${panel}; const input=p.querySelector('input[value="at_time"]'); input.checked=true; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    assert.equal(await cdp.eval(`${panel}.querySelector('.followup-time').hidden`), false);
    assert.equal(await cdp.eval(`${panel}.querySelector('input[name="due"]').required`), true);
    const due = await cdp.eval(`${panel}.querySelector('input[name="due"]').value`);
    await cdp.eval(`(() => { const p=${panel}; p.querySelector('[name="prompt"]').value='Timed UI reservation'; p.querySelector('form').requestSubmit(); })()`);
    await until(() => cdp.eval(`document.querySelector('#terminalFollowupQueue .pane-followup-queue-row strong')?.textContent.includes(${JSON.stringify(due.replace('T', ' ') + ' 이후')})`), 'scheduled time visible in inline queue');
    assert.equal(await cdp.eval(`${panel}.hidden`), true, 'saving closes the panel');
    await cdp.eval('document.querySelector("#terminalFollowupQueue .pane-followup-queue-row button").click()');
    await until(() => cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}}).then(r=>r.items.find(i=>i.prompt==='Timed UI reservation')?.status==='sent')`), 'timed follow-up sent now');
    await until(() => cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(sid)}}).then(r=>r.output.includes(${JSON.stringify('RECEIVED:' + Buffer.from('Timed UI reservation').toString('base64'))}))`), 'forced follow-up input reached terminal');
    await cdp.eval('document.getElementById("mcpSettingsBtn").click()');
    await until(() => cdp.eval('document.querySelectorAll("#mcpSettingsTools li").length>=13'), 'MCP tool list');
    assert.equal(path.basename(await cdp.eval('document.getElementById("mcpDevelopmentFolder").value')), 'WinCMux MCP Development');
    assert.match(await cdp.eval('document.getElementById("mcpNodeRequirement").textContent'), /Node\.js.*node --version/);
    await cdp.eval(`(()=>{document.getElementById('mcpDevelopmentFolder').value=${JSON.stringify(root)};document.getElementById('mcpDevelopmentSave').click()})()`);
    await until(() => cdp.eval(`rpc('mcp.settings.get').then(r=>r.development_folder===${JSON.stringify(root)})`), 'MCP development folder saved');
    assert.equal(await cdp.eval('document.getElementById("mcpToolbarState").textContent'), 'ON');
    await cdp.eval(`rpc("mcp.activity.record",{tool:"wincmux_status",outcome:"success",workspace_id:${JSON.stringify(ws.workspace.id)}})`);
    await cdp.eval('document.getElementById("mcpActivityRefresh").click()');
    await until(() => cdp.eval('document.querySelector("#mcpActivityList li")?.textContent.includes("Follow-up UI")'), 'MCP activity workspace visible');
    const mcpShot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(root, 'artifacts', 'mcp-settings-preview.png'), Buffer.from(mcpShot.data, 'base64'));
    assert.equal(await cdp.eval('document.getElementById("mcpSettingsPromptCopy").disabled'), false);
    assert.equal(await cdp.eval('document.getElementById("mcpAgentPrompt").textContent.includes("stdio")'), true);
    await cdp.eval('document.getElementById("mcpSettingsInfoCopy").click()');
    await until(() => cdp.eval('window.wincmux.clipboardRead().then(text=>text.includes("\\\"transport\\\": \\\"stdio\\\""))'), 'MCP connection info copied');
    await cdp.eval('document.getElementById("mcpSettingsPromptCopy").click()');
    await until(() => cdp.eval('window.wincmux.clipboardRead().then(text=>text.includes("MCP 서버 정보"))'), 'MCP registration prompt copied');
    await cdp.eval('(() => { const input=document.getElementById("mcpSettingsEnabled"); input.checked=false; input.dispatchEvent(new Event("change")); })()');
    await until(() => cdp.eval('rpc("mcp.settings.get").then(r=>r.enabled===false)'), 'MCP disabled');
    await until(() => cdp.eval('!document.getElementById("mcpSettingsEnabled").disabled'), 'MCP switch ready');
    await cdp.eval('(() => { const input=document.getElementById("mcpSettingsEnabled"); input.checked=true; input.dispatchEvent(new Event("change")); })()');
    await until(() => cdp.eval('rpc("mcp.settings.get").then(r=>r.enabled===true)'), 'MCP enabled');
    await cdp.eval('document.getElementById("mcpSettingsClose").click()');
    const nestedSid = await cdp.eval(`startSessionForPane(${JSON.stringify(pane)},${JSON.stringify({
      force: true, cmd: process.execPath, args: [path.join(__dirname, 'terminal-followup-wrapper.cjs'), agent, path.join(__dirname, 'terminal-followup-fixture.cjs')], cwd: temp, focusTerm: false
    })})`);
    await until(() => cdp.eval(`rpc('agent.list',{include_process_presence:true}).then(r=>r.items.find(i=>i.session_id===${JSON.stringify(nestedSid)})?.agent_process_attached===true)`), 'nested Codex process detected');
    await cdp.eval(`rpc('followup.schedule',{session_id:${JSON.stringify(nestedSid)},prompt:'Nested Codex queue',delivery_mode:'when_ready'})`);
    await cdp.eval(`rpc('session.write',{session_id:${JSON.stringify(nestedSid)},data:'#finish#'})`);
    await until(() => cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(nestedSid)}}).then(r=>r.items.find(i=>i.prompt==='Nested Codex queue')?.status==='sent')`), 'nested Codex queue delivered', 12000);
    const claude = path.join(temp, 'claude.exe');
    fs.copyFileSync(process.execPath, claude);
    const claudeSid = await cdp.eval(`startSessionForPane(${JSON.stringify(pane)},${JSON.stringify({
      force: true, cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd: temp, focusTerm: false
    })})`);
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const launch = `& ${quote(claude)} ${quote(path.join(__dirname, 'terminal-followup-fixture.cjs'))} --startup-claude --defer-startup\r`;
    const claudeCall = (method, params = {}) => cdp.eval(`rpc(${JSON.stringify(method)},${JSON.stringify({ session_id: claudeSid, ...params })})`);
    const claudeState = async () => (await claudeCall('agent.list')).items.find(item => item.session_id === claudeSid);
    const claudeOutput = async () => (await claudeCall('session.tail')).output;
    await claudeCall('session.write', { data: launch });
    await until(async () => (await claudeOutput()).includes('Claude fixture loading'), 'Claude launched inside PowerShell');
    assert.equal((await claudeState()).state, 'working', 'launch looks busy before the first prompt appears');
    const reserved = await claudeCall('followup.schedule', { prompt: 'Explicit reservation', delivery_mode: 'after_completion' });
    const firstClaudePrompt = '안녕 Claude';
    await cdp.eval(`(() => {
      const editor = ${composer};
      editor.value = ${JSON.stringify(firstClaudePrompt)};
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    })()`);
    const firstRow = async () => (await claudeCall('followup.list')).items.find(item => item.prompt === firstClaudePrompt);
    await until(async () => (await firstRow())?.status === 'pending', 'first Claude input waits for startup');
    await claudeCall('session.write', { data: '#startup#' });
    await until(async () => (await claudeOutput()).includes('RECEIVED:' + Buffer.from(firstClaudePrompt).toString('base64')),
      'first Claude input reaches the CLI without a prior completion', 8000).catch(async error => {
      throw Error(`${error.message}; mode=${(await firstRow())?.delivery_mode}; detector=${JSON.stringify(await claudeState())}`);
    });
    await until(async () => (await firstRow())?.status === 'sent', 'first Claude input recorded as sent');
    assert.equal((await claudeState()).terminal_completed_count, 0, 'no completed turn was needed for the first input');
    assert.equal((await claudeCall('followup.list')).items.find(item => item.id === reserved.id)?.status,
      'pending', 'explicit completion reservation keeps waiting');
    const codexSid = await cdp.eval(`startSessionForPane(${JSON.stringify(pane)},${JSON.stringify({
      force: true, cmd: agent, args: [path.join(__dirname, 'terminal-followup-fixture.cjs'), '--osc-codex', '--no-shortcut-footer'], cwd: temp, focusTerm: false
    })})`);
    const codexCall = (method, params = {}) => cdp.eval(`rpc(${JSON.stringify(method)},${JSON.stringify({ session_id: codexSid, ...params })})`);
    const codexReceipt = async prompt => (await codexCall('session.tail')).output.includes('RECEIVED:' + Buffer.from(prompt).toString('base64'));
    await until(async () => (await codexCall('agent.list')).items.some(item => item.session_id === codexSid && item.terminal_ready), 'Codex prompt ready');
    await cdp.eval(`(() => { ${composer}.value='Codex UI first'; document.getElementById('terminalPromptSend').click(); })()`);
    await until(() => codexReceipt('Codex UI first'), 'Codex UI button submits to ready terminal');
    await until(() => cdp.eval('!document.getElementById("terminalPromptText").readOnly'), 'Codex composer available');
    await cdp.eval(`(() => {
      const editor = ${composer};
      editor.value = 'Codex UI second';
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    })()`);
    await until(async () => (await codexCall('followup.list')).items.some(item => item.prompt === 'Codex UI second' && item.status === 'pending'), 'Codex UI Ctrl+Enter queues while working');
    assert.equal(await codexReceipt('Codex UI second'), false);
    await codexCall('session.write', { data: '#finish#' });
    await until(() => codexReceipt('Codex UI second'), 'Codex UI queued input reaches CLI after idle');
    await until(() => cdp.eval('document.getElementById("terminalFollowupQueue").hidden'), 'completed item is removed from the visible queue');
    assert(!(await codexCall('followup.list', { queue_only:true })).items.length);
    await codexCall('session.write', { data:'#finish#' });
    await codexCall('session.write', { data:'#draft#' });
    await until(async () => (await codexCall('agent.list')).items.some(item => item.session_id === codexSid && item.terminal_prompt_visible && !item.terminal_prompt_empty), 'genuine Codex draft remains');
    const dismissible = await codexCall('followup.schedule', { prompt:'Recoverable draft failure', delivery_mode:'when_ready' });
    assert.equal((await codexCall('followup.send_now', {id:dismissible.id})).status, 'failed');
    await until(() => cdp.eval(`document.getElementById('terminalFollowupQueue').textContent.includes('Recoverable draft failure')`), 'failed item is recoverable');
    await cdp.eval(`[...document.querySelectorAll('#terminalFollowupQueue button')].find(button=>button.textContent==='지우기').click()`);
    await until(async () => !(await codexCall('followup.list', {queue_only:true})).items.length, 'failed item dismissed explicitly');
    console.log('Per-pane follow-up panel, session binding, both delivery modes, and hook-free scheduling UI passed.');
  } finally {
    if (cdp) { await cdp.eval("rpc('runtime.shutdown_all',{confirmed:true})").catch(() => {}); cdp.close(); }
    if (child.exitCode === null) child.kill();
  }
}

run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
