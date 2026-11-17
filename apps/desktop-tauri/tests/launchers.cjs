const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-launchers-'));
  const port = await portNumber();
  const child = spawn(path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'), ['--benchmark-hidden'], {
    windowsHide: true, stdio: 'ignore', env: {
      ...process.env, WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-launchers-' + randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling`
    }
  });
  let cdp;
  try {
    cdp = await connect(port, child);
    const ready = () => until(() => cdp.eval('typeof state!=="undefined" && state.bootstrapReady===true && Boolean(window.wincmuxLaunchProfiles)'), 'launcher bootstrap');
    await ready();
    const ws = await cdp.eval(`rpc('workspace.create',${JSON.stringify({ name: 'Launcher preview', path: temp, backend: 'custom' })})`);
    await cdp.eval(`loadWorkspaces().then(()=>switchWorkspace(${JSON.stringify(ws.workspace.id)}))`);
    await until(() => cdp.eval('state.paneViews.size>0 && document.querySelectorAll(".launch-profile-card").length===4'), 'default launch cards');
    const get = () => cdp.eval('window.wincmuxLaunchProfiles.getAll()');
    assert.deepEqual((await get()).items.map(p => p.command), ['claude', 'codex', 'gemini', 'powershell.exe']);
    const artifacts = path.join(root, 'artifacts', 'launch-profiles');
    fs.mkdirSync(artifacts, { recursive: true });
    const capture = async name => {
      const result = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(artifacts, name), Buffer.from(result.data, 'base64'));
    };
    await capture('empty-pane.png');
    await cdp.eval('document.getElementById("launchSettingsBtn").click()');
    assert.equal(await cdp.eval('document.getElementById("launchSettingsDialog").open'), true);
    const action = name => cdp.eval(`document.querySelector('#launchSettingsDialog [data-action="${name}"]').click()`);
    const fill = async (name, command, icon = 'terminal') => cdp.eval(`(() => {
      const f=document.querySelector('#launchSettingsDialog form');
      f.elements.name.value=${JSON.stringify(name)}; f.elements.command.value=${JSON.stringify(command)};
      f.elements.icon.value=${JSON.stringify(icon)};
      f.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await action('add'); await action('save');
    assert.equal(await cdp.eval('document.querySelector(".launch-settings-error").hidden'), false);
    assert.equal((await get()).items.length, 4, 'invalid add is not persisted');
    const command = "Write-Output 'LAUNCH_PROFILE_OK 한글'; Write-Output (Get-Location).Path";
    await fill('프로젝트 셸', command, 'bolt');
    await cdp.eval(`(() => {const c=document.querySelector('#launchSettingsDialog [name="defaultProfile"]');c.checked=true;c.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await action('save');
    let config = await get();
    const custom = config.items.find(p => p.name === '프로젝트 셸');
    assert.ok(custom); assert.equal(config.defaultId, custom.id);
    assert.equal(await cdp.eval('document.querySelectorAll(".launch-profile-card").length'), 5);
    await cdp.eval('window.wincmuxLaunchProfiles.openSettings()');
    await cdp.eval(`([...document.querySelectorAll('.launch-settings-row')].find(b=>b.textContent.includes('프로젝트 셸'))).click()`);
    await fill('나의 프로젝트 셸', command, 'powershell');
    await action('up'); await capture('settings.png'); await action('save');
    config = await get();
    assert.equal(config.items[3].id, custom.id);
    assert.equal(config.items[3].icon, 'powershell');
    await cdp.eval('window.wincmuxLaunchProfiles.openSettings()');
    await cdp.eval(`([...document.querySelectorAll('.launch-settings-row')].find(b=>b.textContent.includes('Gemini'))).click()`);
    await action('delete'); await action('cancel');
    assert.equal((await get()).items.length, 5, 'cancel retains the removed item');
    await cdp.eval('window.wincmuxLaunchProfiles.openSettings()');
    await cdp.eval(`([...document.querySelectorAll('.launch-settings-row')].find(b=>b.textContent.includes('Gemini'))).click()`);
    await action('delete'); await action('save');
    assert.ok(!(await get()).items.some(p => p.id === 'gemini'));
    const saved = await get();
    await cdp.eval('window.__launcherReloadMarker=true');
    await cdp.request('Page.reload');
    await until(()=>cdp.eval('window.__launcherReloadMarker!==true && typeof state!=="undefined" && state.bootstrapReady===true && Boolean(window.wincmuxLaunchProfiles)').catch(()=>false),'new launcher document after reload');
    await until(() => cdp.eval('document.querySelectorAll(".launch-profile-card").length===4'), 'cards after reload');
    assert.deepEqual(await get(), saved);
    await cdp.eval(`startSessionForPane(state.selectedPaneId)`);
    assert.equal(await cdp.eval('document.activeElement.dataset.profileId'), custom.id, 'start selects the configured default');
    await cdp.eval(`(() => {const b=[...document.querySelectorAll('.launch-profile-card')].find(b=>b.dataset.profileId===${JSON.stringify(custom.id)});b.click();b.click();})()`);
    const sessions = async () => (await cdp.eval(`rpc('session.list',{workspace_id:${JSON.stringify(ws.workspace.id)}})`)).sessions;
    await until(async () => (await sessions()).filter(s => s.status === 'running').length === 1, 'one launched shell');
    const sid = (await sessions()).find(s => s.status === 'running').id;
    await until(async () => {
      const tail = await cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(sid)}})`);
      return tail.output.includes('LAUNCH_PROFILE_OK 한글') && tail.output.includes(temp);
    }, 'saved Unicode command and project working directory');
    await cdp.eval('window.wincmuxLaunchProfiles.openSettings()');
    await fill('Claude Custom', 'claude --model sonnet', 'claude'); await action('save');
    assert.equal((await sessions()).find(s => s.status === 'running').id, sid, 'settings never restart a live shell');
    console.log(JSON.stringify({ defaultCards: 4, create: true, update: true, delete: true, cancel: true, reordered: true, reload: true, defaultSelection: true, exactCommand: true, workingDirectory: true, doubleClickGuard: true, liveSessionPreserved: true, artifacts }, null, 2));
  } finally {
    if (cdp) { await cdp.eval("rpc('runtime.shutdown_all',{confirmed:true})").catch(() => {}); cdp.close(); }
    if (child.exitCode === null) child.kill();
  }
}
run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
