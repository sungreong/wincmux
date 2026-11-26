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
  const executable = process.env.WINCMUX_VIEWER_TEST_EXE || path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe');
  const child = spawn(executable, ['--benchmark-hidden'], {
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
    await cdp.eval(`document.getElementById('workspace').hidden=false;document.getElementById('setup').hidden=true;document.getElementById('workArea').hidden=false;document.getElementById('remoteViewer').hidden=false;document.getElementById('searchOptionsToggle').click();document.getElementById('searchExtensions').click()`);
    if (process.env.WINCMUX_VIEWER_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, { recursive: true });
      const modalShot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, 'extension-modal.png'), Buffer.from(modalShot.data, 'base64'));
    }
    const searchControls = await cdp.eval(`(() => {
      const modal = document.querySelector('.viewer-extension-dialog');
      const choices = modal.querySelectorAll('input[type=checkbox]');
      modal.querySelector('input[value=md]').click();
      modal.querySelector('input[value=py]').click();
      const label = modal.querySelector('input[value=md]').closest('label');
      const inputRect = label.querySelector('input').getBoundingClientRect();
      const textRect = label.getBoundingClientRect();
      const inlineChoice = inputRect.right < textRect.right && inputRect.top >= textRect.top;
      modal.querySelector('.viewer-extension-apply').click();
      return { name: !!document.getElementById('search'), content: !!document.getElementById('searchContent'), scope: !!document.getElementById('searchScope'), saved: !!document.getElementById('savedFolderMode'), choices: choices.length, summary: document.getElementById('searchExtensions').textContent, inlineChoice, modalClosed: !modal.open };
    })()`);
    assert.equal(searchControls.name && searchControls.content && searchControls.scope && searchControls.saved, true);
    assert.ok(searchControls.choices >= 3);
    assert.equal(searchControls.inlineChoice && searchControls.modalClosed, true);
    assert.ok(searchControls.summary.includes('2'));
    await cdp.eval('document.getElementById("searchOptionsToggle").click()');
    assert.equal(await cdp.eval('document.getElementById("searchForm").getBoundingClientRect().height < 115'), true, 'search toolbar stays compact');
    const folderLayout = await cdp.eval(`(() => {
      document.getElementById('workspace').hidden = false;
      document.getElementById('setup').hidden = true;
      document.getElementById('workArea').hidden = false;
      document.getElementById('saveProfile').hidden = false;
      document.getElementById('openCode').hidden = false;
      document.getElementById('directory').value = '/home/user/project/outputs/compare';
      const input = document.getElementById('directory').getBoundingClientRect();
      const browse = document.getElementById('browse').getBoundingClientRect();
      const open = document.getElementById('openTarget').getBoundingClientRect();
      const save = document.getElementById('saveProfile').getBoundingClientRect();
      const code = document.getElementById('openCode').getBoundingClientRect();
      const sidebar = document.getElementById('workspaceSidebar').getBoundingClientRect();
      const center = rect => rect.y + rect.height / 2;
      return { inputAbove: input.bottom <= browse.top, actionsAligned: Math.abs(center(browse)-center(open))<2 && Math.abs(center(open)-center(save))<2 && Math.abs(center(save)-center(code))<2, fits: code.right <= sidebar.right && input.right <= sidebar.right };
    })()`);
    if (process.env.WINCMUX_VIEWER_SCREENSHOT_DIR) {
      const screenshot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.mkdirSync(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, 'folder-actions.png'), Buffer.from(screenshot.data, 'base64'));
    }
    assert.deepEqual(folderLayout, { inputAbove: true, actionsAligned: true, fits: true });
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
      document.getElementById('copyRemotePath').hidden = false;
      document.getElementById('downloadRemoteFile').hidden = false;
      document.getElementById('previewPlaceholder').hidden = true;
      preview.hidden = false;
      for (let i = 0; i < 60; i++) {
        const row = document.createElement('button');
        row.textContent = 'file-' + i + '.sh';
        if (i === 0) row.classList.add('active');
        entries.append(row);
      }
      const parent = document.createElement('div');
      parent.className = 'viewer-tree-row';
      parent.style.setProperty('--tree-depth', 0);
      parent.innerHTML = '<button class="viewer-tree-toggle" aria-expanded="true">▾</button><button class="viewer-tree-name scope-active">📁 reports</button>';
      const nested = document.createElement('div');
      nested.className = 'viewer-tree-row';
      nested.style.setProperty('--tree-depth', 1);
      nested.innerHTML = '<span class="viewer-tree-spacer"></span><button class="viewer-tree-name">· index.html</button>';
      entries.prepend(parent, nested);
      const code = document.createElement('pre');
      code.textContent = Array.from({length: 200}, (_, i) => 'line ' + i + ' · file content').join('\\n');
      preview.append(code);
      const listRect = entries.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      const treeIndented = nested.querySelector('.viewer-tree-name').getBoundingClientRect().left > parent.querySelector('.viewer-tree-name').getBoundingClientRect().left;
      entries.scrollTop = 20;
      preview.scrollTop = 120;
      return {
        sideBySide: listRect.right <= previewRect.left && listRect.width >= 140 && previewRect.width >= 170,
        treeIndented,
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
      sideBySide: true, treeIndented: true, independentScroll: true, selected: true, placeholderHidden: true,
      listParent: 'viewer-sidebar', previewParent: 'viewer-detail'
    }, JSON.stringify(geometry));
    assert.equal(await cdp.eval('document.getElementById("remoteListTitle").textContent'), '파일 목록');
    const compactHit = await cdp.eval(`(() => {
      const preview = document.getElementById('preview');
      preview.replaceChildren();
      const row = document.createElement('button');
      row.className = 'viewer-search-hit';
      const file = document.createElement('strong');
      file.textContent = 'very/long/folder/path/to/package.json';
      file.title = file.textContent;
      const line = document.createElement('span');
      line.className = 'viewer-search-line';
      line.textContent = '42행';
      const snippet = document.createElement('span');
      snippet.className = 'viewer-search-snippet';
      snippet.textContent = 'Very long matching line '.repeat(40);
      snippet.title = snippet.textContent;
      row.append(file, line, snippet);
      preview.append(row);
      return { oneLine: row.getBoundingClientRect().height < 45, clipped: snippet.scrollWidth > snippet.clientWidth, fullText: !!snippet.title };
    })()`);
    assert.deepEqual(compactHit, { oneLine: true, clipped: true, fullText: true });
    const capture = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const artifact = process.env.WINCMUX_VIEWER_SCREENSHOT_DIR
      ? path.join(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, 'remote-controls.png')
      : path.join(root, 'artifacts', 'remote-viewer-0.2.112.png');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, Buffer.from(capture.data, 'base64'));
    const loadingState = await cdp.eval(`(() => {
      const entries = document.getElementById('entries');
      const loading = document.createElement('div');
      loading.className = 'viewer-tree-loading';
      loading.setAttribute('role', 'status');
      loading.textContent = 'compare 폴더 읽는 중…';
      entries.replaceChildren(loading);
      entries.setAttribute('aria-busy', 'true');
      const placeholder = document.getElementById('previewPlaceholder');
      document.getElementById('preview').hidden = true;
      document.getElementById('previewHeader').hidden = true;
      placeholder.hidden = false;
      placeholder.classList.add('viewer-preview-loading');
      placeholder.textContent = 'index.html 미리보기 불러오는 중…';
      return { folderVisible: loading.getBoundingClientRect().height > 0, animated: getComputedStyle(loading, '::before').animationName === 'viewer-loading-spin', previewVisible: placeholder.getBoundingClientRect().height > 0 };
    })()`);
    assert.deepEqual(loadingState, { folderVisible: true, animated: true, previewVisible: true });
    if (process.env.WINCMUX_VIEWER_SCREENSHOT_DIR) {
      const loadingShot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, 'remote-loading-state.png'), Buffer.from(loadingShot.data, 'base64'));
    }
    console.log('Docker file list and preview rendered side by side with independent scrolling.');
  } finally {
    cdp?.close();
    child.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
