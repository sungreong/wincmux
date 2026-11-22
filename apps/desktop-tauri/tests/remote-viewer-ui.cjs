const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-viewer-'));
  const port = await portNumber();
  const child = spawn(path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'), ['--benchmark-hidden'], {
    windowsHide: true, stdio: 'ignore', env: {
      ...process.env,
      WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-viewer-' + randomUUID(),
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
    await until(() => cdp.eval('document.readyState === "complete" && getComputedStyle(document.querySelector(".viewer-columns")).display === "flex"').catch(() => false), 'Docker file viewer styles loaded');
    await cdp.request('Emulation.setDeviceMetricsOverride', { width: 1180, height: 740, deviceScaleFactor: 1, mobile: false });
    const result = await cdp.eval(`(() => {
      document.getElementById('workspace').hidden = false;
      document.getElementById('setup').hidden = true;
      document.getElementById('workArea').hidden = false;
      document.getElementById('remoteViewer').hidden = false;
      const entries = document.getElementById('entries');
      const preview = document.getElementById('preview');
      document.getElementById('location').textContent = '/app';
      document.getElementById('previewTitle').textContent = 'entrypoint.sh';
      document.getElementById('previewHeader').hidden = false;
      document.getElementById('previewPlaceholder').hidden = true;
      preview.hidden = false;
      for (let i = 0; i < 60; i++) {
        const row = document.createElement('button');
        row.textContent = 'file-' + i + '.sh';
        if (i === 0) row.classList.add('active');
        entries.append(row);
      }
      const code = document.createElement('pre');
      code.textContent = Array.from({length: 200}, (_, i) => 'line ' + i + ' · file content').join('\\n');
      preview.append(code);
      const listRect = entries.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      entries.scrollTop = 80;
      preview.scrollTop = 120;
      return {
        sideBySide: listRect.right <= previewRect.left && listRect.width >= 140 && previewRect.width >= 170,
        independentScroll: entries.scrollTop > 0 && preview.scrollTop > 0,
        selected: getComputedStyle(entries.firstElementChild).backgroundColor !== 'rgba(0, 0, 0, 0)',
        placeholderHidden: document.getElementById('previewPlaceholder').hidden,
        listParent: entries.parentElement.className,
        previewParent: preview.parentElement.className,
        geometry: { list: [listRect.x, listRect.y, listRect.width, listRect.height, entries.scrollHeight],
          preview: [previewRect.x, previewRect.y, previewRect.width, previewRect.height, preview.scrollHeight],
          workArea: document.getElementById('workArea').getBoundingClientRect().width }
      };
    })()`);
    const geometry = result.geometry;
    delete result.geometry;
    assert.deepEqual(result, {
      sideBySide: true, independentScroll: true, selected: true, placeholderHidden: true,
      listParent: 'viewer-sidebar', previewParent: 'viewer-detail'
    }, JSON.stringify(geometry));
    const capture = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const artifact = path.join(root, 'artifacts', 'remote-viewer-0.2.112.png');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, Buffer.from(capture.data, 'base64'));
    console.log('Docker file list and preview rendered side by side with independent scrolling.');
  } finally {
    cdp?.close();
    child.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
