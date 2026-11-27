const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-local-shell-'));
  const port = await portNumber();
  const child = spawn(path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'), ['--benchmark-hidden'], {
    windowsHide: true, stdio: 'ignore', env: {
      ...process.env,
      WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-local-shell-' + randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling`
    }
  });
  let cdp;
  try {
    cdp = await connect(port, child);
    await until(() => cdp.eval('typeof state!=="undefined" && state.bootstrapReady===true'), 'app bootstrap');
    const ws = await cdp.eval(`rpc('workspace.create',${JSON.stringify({ name: 'Korean shell test', path: temp, backend: 'custom' })})`);
    await cdp.eval(`loadWorkspaces().then(()=>switchWorkspace(${JSON.stringify(ws.workspace.id)}))`);
    const pane = await cdp.eval('state.selectedPaneId');
    const sid = await cdp.eval(`startSessionForPane(${JSON.stringify(pane)},${JSON.stringify({ cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd: temp, focusTerm: false })})`);
    const selector = `.pane-shell-composer input`;
    await until(() => cdp.eval(`Boolean(document.querySelector(${JSON.stringify(selector)})?.offsetParent)`), 'local shell input');
    assert.equal(await cdp.eval('document.getElementById("terminalComposer").hidden'), true, 'agent composer hidden for a shell');
    await cdp.eval(`(() => {
      const input=document.querySelector(${JSON.stringify(selector)});
      input.value="Write-Output 'LOCAL_SHELL_KOREAN_한글'";
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    })()`);
    assert.equal((await cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(sid)}})`)).output.includes('LOCAL_SHELL_KOREAN_한글'), false, 'IME Enter does not execute');
    await cdp.eval(`(() => {
      const input=document.querySelector(${JSON.stringify(selector)});
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    })()`);
    await until(() => cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(sid)}}).then(r=>r.output.includes('LOCAL_SHELL_KOREAN_한글'))`), 'Korean command output');
    await until(() => cdp.eval(`document.querySelector(${JSON.stringify(selector)}).value===''`), 'input cleared after send');
    const agentControls = await cdp.eval(`(() => {
      const command=document.querySelector('#terminalComposer .agent-command-tools');
      const shown=provider=>{
        state.agentStates.set(${JSON.stringify(sid)}, { session_id:${JSON.stringify(sid)}, source:'hook', hook:{active:true,provider} });
        syncLocalShellComposers();
        return command.querySelector('.agent-command-provider').textContent;
      };
      const claude=shown('claude');
      const modes=document.querySelector('#terminalComposer .agent-input-modes');
      modes.querySelector('[value=command]').click();
      command.querySelector('.agent-picker-trigger').click();
      const modal=document.querySelector('.agent-command-picker:modal');
      const search=modal.querySelector('input');
      const scoped=modal.textContent.includes('/compact') && !modal.textContent.includes('/goal');
      search.value='compact';
      search.dispatchEvent(new Event('input'));
      const hits=modal.querySelectorAll('.agent-picker-results button');
      search.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      const picked={scoped,hits:hits.length,closed:!modal.open,text:document.getElementById('terminalPromptText').value};
      const codex=shown('codex');
      const input=document.getElementById('terminalPromptText');
      const send=document.getElementById('terminalPromptSend');
      input.value='안녕';
      input.dispatchEvent(new Event('input',{bubbles:true}));
      modes.querySelector('[value=command]').click();
      send.click();
      const error=document.getElementById('terminalPromptError');
      const failed=!error.hidden;
      modes.querySelector('[value=message]').click();
      const recovered=failed && error.hidden && command.hidden && !input.readOnly && !input.disabled && input.value==='안녕'
        && document.activeElement===input && modes.getBoundingClientRect().width>0
        && modes.querySelector('[value=message]').getAttribute('aria-pressed')==='true';
      return {claude,codex,picked,recovered};
    })()`);
    assert.deepEqual(agentControls, {claude:'Claude Code',codex:'Codex',picked:{scoped:true,hits:1,closed:true,text:'/compact'},recovered:true});
    const retained = await cdp.eval(`(() => {
      const sid=${JSON.stringify(sid)};
      const snapshot={session_id:sid, revision:100, source:'pattern', state:'idle', hook:{active:false}};
      state.agentStates.delete(sid);
      applyAgentState({...snapshot,agent_process_attached:true,agent_process_provider:'codex'});
      renderAgentPaneStates();
      document.querySelector('#terminalComposer .agent-input-modes button[value=command]').click();
      document.querySelector('#terminalComposer .agent-picker-trigger').click();
      const modal=document.querySelector('.agent-command-picker:modal');
      const search=modal.querySelector('input');
      search.value='goal';
      search.dispatchEvent(new Event('input'));
      applyAgentState({...snapshot,revision:101});
      renderAgentPaneStates();
      const afterStatus=modal.matches(':modal');
      paneApi.renderPaneSurface(true);
      const afterLayout=modal.matches(':modal') && search.value==='goal';
      applyAgentState({...snapshot,revision:102,agent_process_attached:false,agent_process_provider:''});
      renderAgentPaneStates();
      return {afterStatus,afterLayout,closedOnExit:!modal.open};
    })()`);
    assert.deepEqual(retained,{afterStatus:true,afterLayout:true,closedOnExit:true});
    if (process.env.WINCMUX_COMPOSER_SCREENSHOT) {
      await cdp.eval(`state.agentStates.set(${JSON.stringify(sid)}, {source:'hook',hook:{active:true,provider:'codex'}});syncLocalShellComposers();document.querySelector('#terminalComposer .agent-input-modes button[value=command]').click();document.querySelector('#terminalComposer .agent-picker-trigger').click()`);
      const shot = await cdp.request('Page.captureScreenshot', { format:'png', fromSurface:true });
      fs.writeFileSync(process.env.WINCMUX_COMPOSER_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }
    assert.equal(await cdp.eval(`(() => {
      state.agentStates.set(${JSON.stringify(sid)}, { session_id:${JSON.stringify(sid)}, source:'none', hook:{active:false,provider:'codex'} });
      syncLocalShellComposers();
      return document.querySelector('#terminalComposer .agent-command-tools').hidden
        && document.querySelector('#terminalComposer .agent-input-modes').hidden;
    })()`), true);
    console.log('Local shell composer: IME guarded; Korean command reached PowerShell; input cleared.');
  } finally {
    if (cdp) { await cdp.eval("rpc('runtime.shutdown_all',{confirmed:true})").catch(() => {}); cdp.close(); }
    if (child.exitCode === null) child.kill();
  }
}

run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
