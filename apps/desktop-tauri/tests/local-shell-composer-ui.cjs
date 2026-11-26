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
        return {visible:!command.hidden,provider:command.querySelector('.agent-command-row select').value};
      };
      const claude=shown('claude');
      const codex=shown('codex');
      state.agentStates.set(${JSON.stringify(sid)}, { session_id:${JSON.stringify(sid)}, source:'none', hook:{active:false,provider:'codex'} });
      syncLocalShellComposers();
      return {shellHidden:command.hidden,claude,codex};
    })()`);
    assert.deepEqual(agentControls, {shellHidden:true,claude:{visible:true,provider:'claude'},codex:{visible:true,provider:'codex'}});
    console.log('Local shell composer: IME guarded; Korean command reached PowerShell; input cleared.');
  } finally {
    if (cdp) { await cdp.eval("rpc('runtime.shutdown_all',{confirmed:true})").catch(() => {}); cdp.close(); }
    if (child.exitCode === null) child.kill();
  }
}

run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
