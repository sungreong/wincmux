const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-followups-ui-'));
  const agent = path.join(temp, 'codex.exe');
  fs.copyFileSync(process.execPath, agent);
  const port = await portNumber();
  const child = spawn(path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'),
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
    const sid = await cdp.eval(`startSessionForPane(${JSON.stringify(pane)},${JSON.stringify({
      force: true, cmd: agent, args: [path.join(__dirname, 'terminal-followup-fixture.cjs')], cwd: temp, focusTerm: false
    })})`);
    await until(() => cdp.eval('!document.getElementById("terminalPromptFollowup").disabled'), 'composer follow-up button');
    assert.equal(await cdp.eval(`state.paneCards.get(${JSON.stringify(pane)}).querySelector('.pane-header .pane-followup-btn')`), null);
    assert.equal(await cdp.eval('document.getElementById("terminalPromptFollowup").closest(".pane-composer")?.parentElement.dataset.paneId'), pane);
    await cdp.request('Emulation.setDeviceMetricsOverride', { width: 1178, height: 760, deviceScaleFactor: 1, mobile: false });
    const toolbarMetrics = await cdp.eval('(() => { const t=document.querySelector(".toolbar"); return {height:t.getBoundingClientRect().height,width:t.clientWidth,scrollWidth:t.scrollWidth,wrap:getComputedStyle(t).flexWrap}; })()');
    assert.equal(toolbarMetrics.wrap, 'nowrap', `toolbar stays on one row: ${JSON.stringify(toolbarMetrics)}`);
    assert.equal(toolbarMetrics.height <= 44, true, `toolbar stays compact: ${JSON.stringify(toolbarMetrics)}`);
    assert.equal(await cdp.eval('document.getElementById("terminalPromptBtn")'), null, 'toolbar has no duplicate input button');
    assert.equal(await cdp.eval('getComputedStyle(document.querySelector(".pane-composer > form")).display'), 'flex', 'input remains under the terminal');
    await cdp.eval('document.getElementById("terminalPromptExpand").click()');
    assert.equal(await cdp.eval('document.getElementById("terminalPrompt").open'), true);
    await cdp.eval('document.getElementById("terminalPromptFollowup").click()');
    const panel = `state.paneCards.get(${JSON.stringify(pane)}).querySelector('.pane-followup-panel')`;
    assert.equal(await cdp.eval(`(() => {const a=${panel}.getBoundingClientRect(), b=state.paneCards.get(${JSON.stringify(pane)}).getBoundingClientRect(); return a.bottom <= b.bottom})()`), true, 'panel stays in terminal card');
    const shot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(root, 'artifacts', 'followups-per-pane.png'), Buffer.from(shot.data, 'base64'));
    assert.equal(await cdp.eval(`${panel}.dataset.sessionId`), sid);
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
    const composer = 'document.getElementById("terminalPromptText")';
    await cdp.eval('document.getElementById("terminalPromptExpand").click()');
    await cdp.eval(`(() => { ${composer}.value='Queued first'; document.getElementById('terminalPromptForm').requestSubmit(document.getElementById('terminalPromptSend')); })()`);
    await until(() => cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}}).then(r=>r.items.some(i=>i.prompt==='Queued first'&&i.status==='pending'))`), 'first Ctrl+Enter queue item');
    await until(() => cdp.eval(`!${composer}.readOnly && !document.getElementById('terminalPromptSend').disabled`), 'composer ready for second item');
    await cdp.eval('document.getElementById("terminalPromptExpand").click()');
    await cdp.eval(`(() => { ${composer}.value='Queued second'; document.getElementById('terminalPromptForm').requestSubmit(document.getElementById('terminalPromptSend')); })()`);
    await until(() => cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}}).then(r=>r.items.some(i=>i.prompt==='Queued second'&&i.status==='pending'))`), 'second Ctrl+Enter queue item').catch(async error => { throw Error(`${error.message}; rows=${JSON.stringify(await cdp.eval(`rpc('followup.list',{session_id:${JSON.stringify(sid)}})`))}; input=${JSON.stringify(await cdp.eval(`${composer}.value`))}; error=${JSON.stringify(await cdp.eval(`document.getElementById('terminalPromptError').textContent`))}`); });
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
    await until(() => cdp.eval('document.querySelectorAll("#mcpSettingsTools li").length===13'), 'MCP tool list');
    assert.equal(await cdp.eval('document.getElementById("mcpToolbarState").textContent'), 'ON');
    await cdp.eval('rpc("mcp.activity.record",{tool:"wincmux_status",outcome:"success"})');
    await cdp.eval('document.getElementById("mcpActivityRefresh").click()');
    await until(() => cdp.eval('document.querySelector("#mcpActivityList li")?.textContent.includes("wincmux_status")'), 'MCP activity visible');
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
    console.log('Per-pane follow-up panel, session binding, both delivery modes, and hook-free scheduling UI passed.');
  } finally {
    if (cdp) { await cdp.eval("rpc('runtime.shutdown_all',{confirmed:true})").catch(() => {}); cdp.close(); }
    if (child.exitCode === null) child.kill();
  }
}

run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
