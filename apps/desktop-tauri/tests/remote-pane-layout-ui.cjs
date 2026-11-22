const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-remote-layout-'));
  const port = await portNumber();
  const child = spawn(path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'), ['--benchmark-hidden'], {
    windowsHide: true, stdio: 'ignore', env: {
      ...process.env,
      WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-layout-' + randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling`
    }
  });
  let cdp;
  try {
    cdp = await connect(port, child);
    await until(() => cdp.eval('typeof window.wincmuxTerminalLinks === "object"').catch(() => false), 'main page loaded');
    const url = await cdp.eval('new URL("./ssh-workspace.html?mode=docker", location.href).href');
    await cdp.request('Page.navigate', { url });
    await until(() => cdp.eval('Boolean(window.wincmuxRemoteLayout?.move && window.wincmuxRemoteLayout?.equalize)').catch(() => false), 'remote layout loaded');
    const result = await cdp.eval(`(() => {
      const layout = window.wincmuxRemoteLayout;
      const root = document.createElement('div');
      root.style.cssText = 'display:flex;position:fixed;left:10px;top:10px;width:900px;height:500px;z-index:999';
      document.body.append(root);
      const panes = ['a','b','c'].map(id => {
        const pane = document.createElement('section');
        pane.id = id;
        pane.className = 'pane';
        return pane;
      });
      const [a,b,c] = panes;
      layout.mount(root,a);
      layout.mount(root,b,a,'down');
      layout.mount(root,c,b,'right');
      const nested = root.querySelector('.pane-split[data-direction=right]');
      nested.style.setProperty('--split-first','250px');
      nested.style.setProperty('--split-grow','0');
      const movedLeft = layout.move(root,b,c,'left');
      const left = b.parentElement.dataset.direction === 'right' && b.parentElement.firstElementChild === b && b.parentElement.lastElementChild === c;
      const movedUp = layout.move(root,a,b,'up');
      const up = a.parentElement.dataset.direction === 'down' && a.parentElement.firstElementChild === a && a.parentElement.lastElementChild === b;
      const horizontal = c.parentElement;
      horizontal.style.setProperty('--split-first','250px');
      horizontal.style.setProperty('--split-grow','0');
      const skewed = Math.abs(b.getBoundingClientRect().width - c.getBoundingClientRect().width) > 50;
      layout.equalize(root);
      const equal = [...root.querySelectorAll('.pane-split')].every(split => !split.style.getPropertyValue('--split-first') && !split.style.getPropertyValue('--split-grow'));
      const horizontalEqual = Math.abs(b.getBoundingClientRect().width - c.getBoundingClientRect().width) < 3;
      const verticalEqual = Math.abs(a.getBoundingClientRect().height - b.getBoundingClientRect().height) < 3;
      const intact = panes.every(pane => root.contains(pane)) && root.querySelectorAll('.pane').length === 3;
      layout.remove(c);
      return { movedLeft, left, movedUp, up, skewed, equal, horizontalEqual, verticalEqual, intact, remaining: root.querySelectorAll('.pane').length,
        equalizeLabel: document.getElementById('equalizeRemotePanes')?.textContent.trim(),
        moveDialog: Boolean(document.getElementById('moveRemotePaneDialog')) };
    })()`);
    assert.deepEqual(result, {
      movedLeft: true, left: true, movedUp: true, up: true, skewed: true, equal: true,
      horizontalEqual: true, verticalEqual: true, intact: true, remaining: 2,
      equalizeLabel: '균등 배분', moveDialog: true
    });
    console.log('Docker pane move, equalize, and removal passed in WebView2.');
  } finally {
    cdp?.close();
    child.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
