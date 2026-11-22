const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-renderer-'));
  const port = await portNumber();
  const child = spawn(path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'), ['--benchmark-hidden'], {
    windowsHide: true, stdio: 'ignore', env: {
      ...process.env,
      WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-renderer-' + randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling`
    }
  });
  let cdp;
  try {
    cdp = await connect(port, child);
    await until(() => cdp.eval('typeof window.wincmuxTerminalRenderer?.register === "function"').catch(() => false), 'renderer loaded');
    assert.equal(await cdp.eval('window.wincmuxTerminalRenderer.isEnabled()'), false);
    const result = await cdp.eval(`(async () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:20px;top:20px;width:800px;height:120px;z-index:9999;background:#10151c';
      document.body.append(host);
      const term = new window.Terminal({cols:70,rows:3,allowProposedApi:true});
      term.open(host);
      await new Promise(resolve => term.write('Existing session output', resolve));
      const errors = [];
      window.wincmuxTerminalRenderer.register(term, error => errors.push(String(error)));
      document.getElementById('terminalRendererSettingsBtn').click();
      document.getElementById('terminalWebglEnabled').click();
      const enabled = window.wincmuxTerminalRenderer.isEnabled();
      const active = Boolean(term.element.querySelector('.xterm-screen > canvas:not([class])'));
      const before = term.buffer.active.getLine(0).translateToString(true);
      document.getElementById('terminalWebglEnabled').click();
      const off = !window.wincmuxTerminalRenderer.isEnabled();
      const released = !term.element.querySelector('.xterm-screen > canvas:not([class])');
      const after = term.buffer.active.getLine(0).translateToString(true);
      const search = window.wincmuxTerminalSearch(term, host);
      search.open();
      const input = search.panel.querySelector('input[type=search]');
      input.value = 'SESSION';
      input.dispatchEvent(new Event('input', {bubbles:true}));
      const insensitive = search.panel.querySelector('.terminal-search-count').textContent;
      const caseSensitive = search.panel.querySelector('input[type=checkbox]');
      caseSensitive.checked = true;
      caseSensitive.dispatchEvent(new Event('change', {bubbles:true}));
      const sensitive = search.panel.querySelector('.terminal-search-count').textContent;
      search.close();
      const searchClosed = search.panel.hidden;
      search.dispose();
      window.wincmuxTerminalRenderer.unregister(term);
      term.dispose();
      return { enabled, active, errors, before, off, released, after, insensitive, sensitive, searchClosed, saved: localStorage.getItem('wincmux.terminal.webgl') };
    })()`);
    assert.equal(result.enabled, true);
    assert.equal(result.before, 'Existing session output');
    assert.equal(result.off, true);
    assert.equal(result.released, true);
    assert.equal(result.after, result.before);
    assert.equal(result.insensitive, '1/1');
    assert.equal(result.sensitive, '0/0');
    assert.equal(result.searchClosed, true);
    assert.equal(result.saved, '0');
    assert.ok(result.active || result.errors.length, 'WebGL should render or visibly fall back');

    const remoteUrl = await cdp.eval('new URL("./ssh-workspace.html?mode=docker", location.href).href');
    await cdp.request('Page.navigate', { url: remoteUrl });
    await until(() => cdp.eval('typeof window.wincmuxTerminalRenderer?.register === "function"').catch(() => false), 'Docker renderer loaded');
    assert.equal(await cdp.eval('window.wincmuxTerminalRenderer.isEnabled()'), false);
    assert.equal(await cdp.eval('document.getElementById("terminalWebglEnabled").checked'), false);
    console.log(`WebGL switch passed in WebView2 (${result.active ? 'accelerated' : 'fallback'}); output survived and Docker setting persisted.`);
  } finally {
    cdp?.close();
    child.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
