// Isolated WebView2/ConPTY regression: no user sessions or settings are touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-rendering-'));
  const port = await portNumber();
  const child = spawn(path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'),
    ['--benchmark-hidden'], { windowsHide: true, stdio: 'ignore', env: {
      ...process.env, WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-rendering-' + randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling`
    } });
  let cdp;
  try {
    cdp = await connect(port, child);
    await until(() => cdp.eval('typeof state!=="undefined" && state.bootstrapReady===true'), 'bootstrap');
    const ws = await cdp.eval(`rpc('workspace.create',${JSON.stringify({ name: 'Rendering regression', path: temp, backend: 'custom' })})`);
    await cdp.eval(`loadWorkspaces().then(()=>switchWorkspace(${JSON.stringify(ws.workspace.id)}))`);
    await until(() => cdp.eval('state.paneViews.size>0'), 'pane');
    // Persisted compact-header preferences must never freeze terminal geometry.
    await cdp.eval('state.paneAutoResize=false');
    let pane = await cdp.eval('[...state.paneViews.keys()][0]');
    const sid = await cdp.eval(`startSessionForPane(${JSON.stringify(pane)},${JSON.stringify({ force: true, cmd: process.execPath, args: [path.join(__dirname, 'fixture.cjs')], cwd: temp, focusTerm: false })})`);
    const write = data => cdp.eval(`rpc('session.write',${JSON.stringify({ session_id: sid, data })})`);
    await until(async () => (await cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(sid)}})`)).output.includes('FIXTURE_READY'), 'fixture');
    const inspect = () => cdp.eval(`(() => {
      const v=state.paneViews.get(${JSON.stringify(pane)}), b=v.term.buffer.active;
      return {lines:[0,1,2].map(i=>b.getLine(b.baseY+i)?.translateToString(true)),
        cursorX:b.cursorX, cols:v.term.cols, synced:v.lastSyncedCols,
        proposed:v.fitAddon.proposeDimensions()?.cols,
        busy:v.resizeInFlight||v.outputWriteInFlight||v.tauriOutput.loading,
        unicode:v.term.unicode.activeVersion, pty:v.term.options.windowsPty};
    })()`);
    const expected = ['English answer stays at left', '한글 응답도 왼쪽부터', 'Mixed 🧪 cell width'];
    const check = async () => {
      await until(async () => {
        const v = await inspect();
        return v.cols === v.synced && v.cols === v.proposed && !v.busy
          && JSON.stringify(v.lines) === JSON.stringify(expected);
      }, 'left aligned mixed output', 15000);
      const v = await inspect();
      assert.deepEqual(v.lines, expected);
      assert.equal(v.unicode, '11');
      assert.equal(v.pty.backend, 'conpty');
      assert.ok(v.pty.buildNumber > 0);
      return v;
    };
    await write('#render-on#');
    await check();
    await write('#render-off#');
    await sleep(100);
    const futureWidths = [];
    // Resize an idle shell without forcing a fit or changing the font. Only
    // output produced afterwards is assessed for the first acceptance stage.
    for (const [width, height] of [[1100,720],[1900,1100],[1280,800],[1750,1000]]) {
      await cdp.request('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await until(async () => {
        const v = await inspect();
        return v.cols === v.proposed && v.cols === v.synced && !v.busy;
      }, 'automatic idle resize');
      await sleep(100);
      await write('#width#');
      await until(async () => {
        const v = await inspect();
        return v.lines[0]?.startsWith(`NEW width=${v.cols} `)
          && v.lines[0].length === v.cols && v.lines[0].endsWith('END');
      }, 'new output uses full resized PTY width');
      futureWidths.push((await inspect()).cols);
    }
    assert.ok(futureWidths[1] > futureWidths[0], 'enlarging must increase the real shell width');
    await write('#render-on#');
    await check();
    const samples = [];
    for (const [width, height, scale] of [[1280,800,85],[1750,1000,100],[1100,720,85],[1500,900,100]]) {
      await cdp.request('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await cdp.eval(`setGlobalFontScale(${scale})`);
      samples.push(await check());
    }
    const split = await cdp.eval(`splitPaneInternal(${JSON.stringify(pane)},'horizontal',{autoStartIfMissing:false})`);
    pane = await cdp.eval(`Object.keys(state.paneSessions).find(p=>state.paneSessions[p]===${JSON.stringify(sid)})`);
    await check();
    await cdp.eval('equalizePaneSizes()');
    await check();
    await write('#render-off#');
    await sleep(100);
    await cdp.eval(`(async()=>{const v=state.paneViews.get(${JSON.stringify(pane)});v.tauriOutput.snapshotNeeded=true;v.tauriOutput.force=true;await pumpTauriOutput(v);})()`);
    await check();
    await write('#tui-on#');
    await until(() => cdp.eval(`state.paneViews.get(${JSON.stringify(pane)}).term.buffer.active.type==='alternate'`), 'alternate screen');
    await write('#render-on#');
    await check();
    await cdp.request('Emulation.setDeviceMetricsOverride', { width: 1700, height: 950, deviceScaleFactor: 1.25, mobile: false });
    await check();
    await write('#render-off#');
    await sleep(100);
    await cdp.eval(`(async()=>{const v=state.paneViews.get(${JSON.stringify(pane)});v.tauriOutput.snapshotNeeded=true;v.tauriOutput.force=true;await pumpTauriOutput(v);})()`);
    await check();
    const artifacts = path.join(root, 'artifacts', 'terminal-rendering');
    fs.mkdirSync(artifacts, { recursive: true });
    const screenshot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(artifacts, 'rendering.png'), Buffer.from(screenshot.data, 'base64'));
    const result = { unicode: '11', futureWidths, samples, split: split.second, normalAndAlternateRestored: true };
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (cdp) {
      await cdp.eval("rpc('runtime.shutdown_all',{confirmed:true})").catch(() => {});
      cdp.close();
    }
    if (child.exitCode === null) child.kill();
  }
}
run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
