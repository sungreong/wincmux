// Isolated WebView smoke test for the folder and Git companion pane.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function run() {
  const repo = path.resolve(__dirname, '../../..');
  if (process.env.WINCMUX_VIEWER_SCREENSHOT_DIR) fs.mkdirSync(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-viewer-'));
  const project = path.join(temp, 'project');
  fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { windowsHide: true });
  git('init');
  git('config', 'user.email', 'viewer@example.invalid');
  git('config', 'user.name', 'Viewer Test');
  fs.writeFileSync(path.join(project, 'note.txt'), 'before\n');
  git('add', 'note.txt');
  git('commit', '-m', 'Initial');
  fs.writeFileSync(path.join(project, 'both.txt'), 'original\n');
  git('add', 'both.txt');
  git('commit', '-m', 'Add dual change fixture');
  fs.writeFileSync(path.join(project, 'note.txt'), 'after\n');
  fs.writeFileSync(path.join(project, 'both.txt'), 'staged\n');
  git('add', 'both.txt');
  fs.writeFileSync(path.join(project, 'both.txt'), 'unstaged\n');
  fs.mkdirSync(path.join(project, 'src'));
  fs.mkdirSync(path.join(project, 'target'));
  fs.writeFileSync(path.join(project, 'src', 'test_alpha.py'), 'search result\n');
  fs.writeFileSync(path.join(project, 'src', 'test_beta.py'), 'different text\n');
  fs.writeFileSync(path.join(project, 'src', 'syntax.py'), 'import os\r\nfrom pathlib import Path\r\n# comment\r\nvalue = "hello"\r\n');
  fs.writeFileSync(path.join(project, 'src', 'syntax.js'), 'import { readFile } from "node:fs";\nconst count = 42; // comment\n');
  fs.writeFileSync(path.join(project, 'src', 'syntax.ps1'), '$name = "hello"\nWrite-Host $name\n');
  fs.writeFileSync(path.join(project, 'src', 'mystery.txt'), 'import os\n');
  fs.writeFileSync(path.join(project, 'guide.md'), '# Guide\n\n- Item\n\n```python\nprint("hi")\n```\n\n<script>alert("x")</script>\n');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# test agent instructions\n');
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# test Claude instructions\n');
  fs.mkdirSync(path.join(project, '.agents', 'skills', 'team'), { recursive: true });
  fs.mkdirSync(path.join(project, '.codex', 'skills', 'review'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.codex', 'config.toml'), 'model = "test-model"\n');
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), '{"permissions":{"allow":[]}}\n');
  fs.writeFileSync(path.join(project, '.agents', 'skills', 'team', 'SKILL.md'), '# team skill\n');
  fs.writeFileSync(path.join(project, '.codex', 'skills', 'review', 'SKILL.md'), '# review skill\n');
  fs.writeFileSync(path.join(project, 'target', 'test_hidden.py'), 'excluded result\n');
  fs.writeFileSync(path.join(project, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9bMZsAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(project, 'page.html'), '<h1>HTML preview</h1><script>parent.__htmlExecuted=true</script>');
  fs.writeFileSync(path.join(project, 'large-page.html'), '<h1>Large HTML preview</h1>' + ' '.repeat(8 * 1024 * 1024));
  const pdfContent = 'BT /F1 24 Tf 20 100 Td (PDF preview) Tj ET';
  const pdfObjects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(pdfContent)} >>\nstream\n${pdfContent}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  pdfObjects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  fs.writeFileSync(path.join(project, 'document.pdf'), pdf);
  const port = await portNumber();
  const executable = process.env.WINCMUX_VIEWER_TEST_EXE || path.join(repo, 'apps/desktop-tauri/src-tauri/target/debug/wincmux-tauri.exe');
  const child = spawn(executable,
    ['--benchmark-hidden'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-viewer-' + randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`
    } });
  let cdp;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const capture = async (name) => {
    if (!process.env.WINCMUX_VIEWER_SCREENSHOT_DIR) return;
    await cdp.eval(`(()=>{const toggle=document.getElementById('toggleNotificationPanelBtn');if(getComputedStyle(document.querySelector('.panel-right')).display!=='none')toggle.click();document.getElementById('workspaceContent').style.setProperty('--viewer-width','62%');document.querySelectorAll('.ws-path').forEach(node=>{if(node.textContent.includes('wincmux-viewer-'))node.textContent='C:/demo/project'})})()`);
    await sleep(200);
    const screenshot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, name), Buffer.from(screenshot.data, 'base64'));
  };
  try {
    try { cdp = await connect(port, child); }
    catch (error) { throw new Error(`${error.message}\n${stderr}`); }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { await until(() => cdp.eval('typeof state!=="undefined" && state.bootstrapReady===true', 5000), 'bootstrap'); break; }
      catch (error) {
        if (attempt === 2 || !String(error).includes('CDP request timed out')) throw error;
        cdp.close();
        try { cdp = await connect(port, child); }
        catch (reconnectError) { throw new Error(`${reconnectError.message}\n${stderr}`); }
      }
    }
    console.log('viewer test: bootstrap');
    const ws = await cdp.eval(`rpc('workspace.create',${JSON.stringify({ name: 'Viewer test', path: project, backend: 'custom' })})`);
    await cdp.eval(`loadWorkspaces().then(()=>switchWorkspace(${JSON.stringify(ws.workspace.id)}))`);
    await cdp.eval(`(()=>{window.__originalStart=paneHandlers.startSessionForPane;window.__launchCalls=[];paneHandlers.startSessionForPane=async (...args)=>{window.__launchCalls.push(args);return 'test-session'};window.__hookChoice=startShellCommandForPane(state.selectedPaneId,'claude',{force:false})})()`);
    await until(() => cdp.eval('document.getElementById("workspaceHookDialog").open'), 'Claude hook choice');
    await capture('installed-claude-hook-choice.png');
    assert.equal(await cdp.eval('document.getElementById("workspaceHookTitle").textContent'), 'Claude Code 훅 등록');
    await cdp.eval('document.getElementById("workspaceHookWithout").click()');
    assert.equal(await cdp.eval('window.__hookChoice'), 'test-session');
    assert.equal(await cdp.eval('window.__launchCalls.length'), 1, 'Claude launch continues without hooks');
    await cdp.eval('paneHandlers.startSessionForPane=window.__originalStart');
    assert.equal(fs.existsSync(path.join(project, '.claude', 'settings.local.json')), false, 'skipping Claude hooks leaves settings untouched');
    fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), '{broken json');
    await cdp.eval(`(()=>{window.__originalStart=paneHandlers.startSessionForPane;window.__launchCalls=[];paneHandlers.startSessionForPane=async (...args)=>{window.__launchCalls.push(args);return 'test-session'};window.__hookChoice=startShellCommandForPane(state.selectedPaneId,'codex',{force:false})})()`);
    await until(() => cdp.eval('document.getElementById("workspaceHookDialog").open'), 'Codex hook choice');
    await cdp.eval('document.getElementById("workspaceHookRegister").click()');
    await until(() => cdp.eval('!document.getElementById("workspaceHookError").hidden'), 'Codex hook registration error');
    await capture('installed-codex-hook-error.png');
    assert.equal(await cdp.eval('document.getElementById("workspaceHookPrompt").value.includes("\\n워크스페이스:")'), true, 'failure prompt has readable lines');
    assert.equal(await cdp.eval('document.getElementById("workspaceHookPrompt").value.includes("hooks.json")'), true);
    await cdp.eval(`(()=>{window.__hookCopied=null;window.wincmux.clipboardWrite=async text=>{window.__hookCopied=text};document.getElementById('workspaceHookCopy').click()})()`);
    await until(() => cdp.eval('window.__hookCopied?.includes("hooks.json")'), 'copyable hook error prompt');
    fs.unlinkSync(path.join(project, '.codex', 'hooks.json'));
    await cdp.eval('document.getElementById("workspaceHookRegister").click()');
    assert.equal(await cdp.eval('window.__hookChoice'), 'test-session');
    assert.equal(await cdp.eval('window.__launchCalls.length'), 1, 'Codex launch continues after hook registration');
    await cdp.eval('paneHandlers.startSessionForPane=window.__originalStart');
    assert.equal(fs.existsSync(path.join(project, '.codex', 'hooks.json')), true, 'Codex hook registration writes settings');
    assert.equal(await cdp.eval('document.getElementById("statusBar").textContent.includes("Hook 등록 완료")'), true, 'successful registration is reported');
    const externalPath = path.join(temp, 'external-workspace');
    fs.mkdirSync(externalPath);
    const external = await cdp.eval(`rpc('workspace.create',${JSON.stringify({ name: 'MCP-created workspace', path: externalPath, backend: 'custom' })})`);
    await until(() => cdp.eval(`state.workspaces.some(item => item.id === ${JSON.stringify(external.workspace.id)})`), 'external workspace appears in sidebar state');
    await cdp.eval(`rpc('workspace.delete',${JSON.stringify({ id: external.workspace.id })})`);
    await until(() => cdp.eval(`!state.workspaces.some(item => item.id === ${JSON.stringify(external.workspace.id)})`), 'external workspace removal appears in sidebar state');
    await until(() => cdp.eval('!!document.querySelector(".launch-viewer-card[data-viewer-tab=files]")'), 'viewer launcher');
    assert.equal(await cdp.eval('document.querySelector(".launch-viewer-card[data-viewer-tab=files]").getBoundingClientRect().top < document.querySelector(".pane-terminal-overlay").getBoundingClientRect().bottom'), true);
    const beforeSessions = await cdp.eval('Object.keys(state.paneSessions).length');
    await cdp.eval('document.querySelector(".launch-viewer-card[data-viewer-tab=files]").click()');
    assert.equal(await cdp.eval('document.getElementById("workspaceViewer").hidden'), false);
    assert.equal(await cdp.eval('Object.keys(state.paneSessions).length'), beforeSessions);
    assert.equal(await cdp.eval('document.getElementById("viewerTree").getBoundingClientRect().right < document.querySelector(".workspace-viewer-preview").getBoundingClientRect().left'), true);
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="note.txt"]')`), 'file tree');
    assert.equal(await cdp.eval('document.getElementById("viewerListTitle").textContent'), '파일 목록');
    assert(await cdp.eval(`(() => {
      const sidebar=document.querySelector('.workspace-viewer-sidebar');
      const main=document.getElementById('viewerMain');
      main.style.setProperty('--viewer-nav-width','140px');
      try {
        const bounds=sidebar.getBoundingClientRect();
        const folder=document.getElementById('viewerFolderBar');
        const search=document.getElementById('viewerSearchForm').getBoundingClientRect();
        const tree=document.getElementById('viewerTree').getBoundingClientRect();
        return folder.getBoundingClientRect().bottom <= search.top && search.bottom <= tree.top && tree.height > 30
          && [...folder.querySelectorAll('button')].every(button=>button.getBoundingClientRect().right <= bounds.right);
      } finally { main.style.removeProperty('--viewer-nav-width'); }
    })()`), 'folder commands, search, and tree stay in separate rows at narrow widths');
    console.log('viewer test: file tree');
    const previewLoading = await cdp.eval(`(()=>{window.__viewerOriginalAction=window.wincmux.viewerAction;window.wincmux.viewerAction=async(...args)=>{if(args[0]==='viewer-preview')await new Promise(resolve=>setTimeout(resolve,900));return window.__viewerOriginalAction(...args)};document.querySelector('#viewerTree button[title="note.txt"]').click();return !!document.querySelector('#viewerPreview .viewer-preview-loading')&&document.getElementById('viewerPreview').getAttribute('aria-busy')==='true'})()`);
    assert.equal(previewLoading, true, 'file click immediately shows preview loading');
    if (process.env.WINCMUX_VIEWER_SCREENSHOT_DIR) {
      const shot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, 'local-preview-loading.png'), Buffer.from(shot.data, 'base64'));
    }
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("after")'), 'text preview');
    await cdp.eval('window.wincmux.viewerAction=window.__viewerOriginalAction');
    assert.equal(await cdp.eval('document.querySelector("#viewerPreview .workspace-viewer-line-number")?.textContent'), '1');
    await cdp.eval(`(()=>{const input=document.getElementById('viewerFindInput');input.value='after';input.dispatchEvent(new Event('input'))})()`);
    assert.equal(await cdp.eval('document.getElementById("viewerFindCount").textContent'), '1/1');
    assert.equal(await cdp.eval('document.querySelector("#viewerPreview mark")?.textContent'), 'after');
    await cdp.eval(`(async()=>{window.wincmux.clipboardWrite=async text=>{window.__viewerCopiedText=text};document.getElementById('viewerCopyPath').click()})()`);
    assert.equal((await cdp.eval('window.__viewerCopiedText')).endsWith('\\note.txt'), true);
    await cdp.eval('document.getElementById("viewerCopyContent").click()');
    assert.equal(await cdp.eval('window.__viewerCopiedText'), 'after\n');
    await cdp.eval(`document.querySelector('#viewerTree button[title="guide.md"]').click()`);
    await until(() => cdp.eval('document.querySelector("#viewerPreview .workspace-viewer-markdown h1")?.textContent === "Guide"'), 'Markdown document view');
    assert.equal(await cdp.eval('document.querySelector("#viewerPreview .workspace-viewer-markdown li")?.textContent'), 'Item');
    assert.equal(await cdp.eval('document.querySelector("#viewerPreview .workspace-viewer-markdown script")'), null);
    await cdp.eval(`(()=>{const input=document.getElementById('viewerFindInput');input.value='Guide';input.dispatchEvent(new Event('input'))})()`);
    await until(() => cdp.eval('document.querySelector("#viewerPreview mark")?.textContent === "Guide"'), 'Markdown source search');
    await cdp.eval('document.getElementById("viewerMarkdownToggle").click()');
    await until(() => cdp.eval('document.querySelector("#viewerPreview .workspace-viewer-markdown h1")?.textContent === "Guide"'), 'Markdown document restored');
    await cdp.eval('document.getElementById("viewerMarkdownToggle").click()');
    await until(() => cdp.eval('document.querySelector("#viewerPreview .workspace-viewer-code-line")?.textContent.includes("# Guide")'), 'Markdown source view');
    await cdp.eval(`(()=>{const input=document.getElementById('viewerSearchInput');input.value='**/test_*.py';document.getElementById('viewerSearchForm').requestSubmit()})()`);
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="src/test_alpha.py"]')`), 'pattern search');
    console.log('viewer test: pattern search');
    assert.equal(await cdp.eval(`!!document.querySelector('#viewerTree button[title="target/test_hidden.py"]')`), false);
    await cdp.eval(`document.querySelector('#viewerTree button[title="src/test_alpha.py"]').click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("search result")'), 'search result preview');
    await capture('search-0.2.83.png');
    if (process.env.WINCMUX_VIEWER_SCREENSHOT_DIR) {
      const screenshot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, 'search-viewer.png'), Buffer.from(screenshot.data, 'base64'));
    }
    await cdp.eval(`(()=>{const check=document.getElementById('viewerSearchIncludeExcluded');check.checked=true;check.dispatchEvent(new Event('change'))})()`);
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="target/test_hidden.py"]')`), 'include excluded folders');
    await cdp.eval('document.getElementById("viewerSearchClear").click()');
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="note.txt"]')`), 'tree after clear');
    const folderLoading = await cdp.eval(`(()=>{window.__viewerOriginalAction=window.wincmux.viewerAction;window.wincmux.viewerAction=async(...args)=>{if(args[0]==='viewer-list')await new Promise(resolve=>setTimeout(resolve,900));return window.__viewerOriginalAction(...args)};document.querySelector('#viewerTree button[title="src"]').click();return !!document.querySelector('#viewerTree .viewer-tree-loading')&&!!document.querySelector('#viewerTree [aria-busy=true]')})()`);
    assert.equal(folderLoading, true, 'folder expansion immediately shows loading');
    if (process.env.WINCMUX_VIEWER_SCREENSHOT_DIR) {
      const shot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, 'local-folder-loading.png'), Buffer.from(shot.data, 'base64'));
    }
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="src/test_alpha.py"]')`), 'expanded folder');
    await cdp.eval('window.wincmux.viewerAction=window.__viewerOriginalAction');
    await cdp.eval('document.getElementById("viewerFocusFolder").click()');
    await until(() => cdp.eval('document.getElementById("viewerFolderPath").textContent === "src" && !document.querySelector(\'#viewerTree button[title="note.txt"]\')'), 'focused folder only');
    assert.equal(await cdp.eval('document.getElementById("viewerSearchScope").checked'), true);
    await cdp.eval('document.getElementById("viewerParentFolder").click()');
    await until(() => cdp.eval('document.getElementById("viewerFolderPath").textContent === "워크스페이스 전체" && !!document.querySelector(\'#viewerTree button[title="note.txt"]\')'), 'return to workspace');
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="src/test_alpha.py"]')`), 'expanded folder restored');
    await cdp.eval(`document.querySelector('#viewerTree button[title="src/syntax.py"]').click()`);
    await until(() => cdp.eval('document.querySelector("#viewerPreview .hljs-keyword")?.textContent === "import"'), 'Python syntax highlighting');
    assert.equal(await cdp.eval('document.getElementById("viewerLanguageSelect").options[0].textContent'), '언어 자동 · python');
    await cdp.eval(`(()=>{document.getElementById('viewerLanguageSearchBtn').click();const input=document.getElementById('viewerLanguageSearch');input.value='py';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`);
    assert.equal(await cdp.eval('document.getElementById("viewerLanguageSelect").value'), 'python');
    assert.equal(await cdp.eval('document.querySelector("#viewerPreview .hljs-comment")?.textContent'), '# comment');
    await cdp.eval(`document.querySelector('#viewerTree button[title="src/syntax.js"]').click()`);
    await until(() => cdp.eval('document.querySelector("#viewerPreview .hljs-keyword")?.textContent === "import"'), 'JavaScript syntax highlighting');
    assert.equal(await cdp.eval('document.querySelector("#viewerPreview .hljs-string")?.textContent'), '"node:fs"');
    assert.equal(await cdp.eval('document.querySelector("#viewerPreview .hljs-number")?.textContent'), '42');
    await cdp.eval(`document.querySelector('#viewerTree button[title="src/syntax.ps1"]').click()`);
    await until(() => cdp.eval('!!window.hljs?.getLanguage("powershell") && !!document.querySelector("#viewerPreview .workspace-viewer-code-text .hljs-variable")'), 'on-demand PowerShell grammar');
    await cdp.eval(`document.querySelector('#viewerTree button[title="src/mystery.txt"]').click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("import os")'), 'unknown language source');
    await cdp.eval(`(()=>{const select=document.getElementById('viewerLanguageSelect');select.value='python';select.dispatchEvent(new Event('change'))})()`);
    await until(() => cdp.eval('document.querySelector("#viewerPreview .hljs-keyword")?.textContent === "import"'), 'manual language selection');
    await cdp.eval('document.getElementById("viewerRefresh").click()');
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="src/test_alpha.py"]')`), 'expanded folder after refresh');
    await cdp.eval(`(()=>{document.getElementById('viewerSearchScope').checked=true;document.getElementById('viewerContentInput').value='search result';document.getElementById('viewerSearchForm').requestSubmit()})()`);
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="src/test_alpha.py"]')`), 'scoped content search');
    console.log('viewer test: content search');
    await cdp.eval(`document.querySelector('#viewerTree button[title="src/test_alpha.py"]').click()`);
    await until(() => cdp.eval('document.querySelector("#viewerPreview mark")?.textContent === "search result"'), 'content match in preview');
    assert.equal(await cdp.eval('document.querySelector("#viewerPreview .workspace-viewer-code-line.target .workspace-viewer-line-number")?.textContent'), '1');
    assert.equal(await cdp.eval(`!!document.querySelector('#viewerTree button[title="src/test_beta.py"]')`), false);
    assert.equal(await cdp.eval('document.querySelector("#viewerTree .workspace-viewer-search-snippet")?.textContent.includes("1행")'), true);
    assert.equal(await cdp.eval('document.querySelector("#viewerTree .workspace-viewer-search-result").getBoundingClientRect().height < 36'), true, 'search result fits one row');
    await cdp.eval('document.getElementById("viewerSearchClear").click()');
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="note.txt"]')`), 'tree after content search');
    await cdp.eval(`document.querySelector('#viewerTree button[title="src"]').click()`);
    await cdp.eval('document.getElementById("viewerSaveFolder").click()');
    assert.equal(await cdp.eval('document.getElementById("viewerSaveFolder").textContent.includes("등록됨")'), true);
    assert.equal(await cdp.eval('document.getElementById("viewerSavedFolderFeedback").textContent.includes("등록 완료")'), true);
    await capture('saved-folder-feedback.png');
    await cdp.eval(`document.querySelector('#viewerTree button[title="target"]').click();document.getElementById('viewerSaveFolder').click()`);
    await cdp.eval('document.getElementById("viewerSavedFolderMode").click()');
    await capture('folder-picker-modal.png');
    await cdp.eval(`(()=>{const dialog=document.querySelector('.viewer-folder-dialog');dialog.querySelector('input[value=saved]').click();dialog.querySelector('input[type=checkbox][value=target]').click();dialog.querySelector('.viewer-folder-actions button:last-child').click()})()`);
    await until(() => cdp.eval('document.querySelector("#viewerTree .workspace-viewer-saved-heading")?.textContent.includes("src")'), 'saved folder view');
    assert.equal(await cdp.eval('document.getElementById("viewerSavedFolderMode").textContent.includes("1/2")'), true);
    assert.equal(await cdp.eval('document.querySelectorAll("#viewerTree .workspace-viewer-saved-heading").length'), 1);
    assert.equal(await cdp.eval(`!!document.querySelector('#viewerTree button[title="note.txt"]')`), false);
    await cdp.eval('document.getElementById("viewerSearchInput").value="test_*.py";document.getElementById("viewerSearchForm").requestSubmit()');
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="src/test_alpha.py"]')`), 'search one selected folder');
    assert.equal(await cdp.eval(`!!document.querySelector('#viewerTree button[title="target/test_hidden.py"]')`), false);
    await cdp.eval('document.getElementById("viewerSearchClear").click()');
    await cdp.eval(`(()=>{document.getElementById('viewerSavedFolderMode').click();const dialog=document.querySelector('.viewer-folder-dialog');dialog.querySelector('input[type=checkbox][value=target]').click();dialog.querySelector('.viewer-folder-actions button:last-child').click()})()`);
    await until(() => cdp.eval('document.querySelectorAll("#viewerTree .workspace-viewer-saved-heading").length === 2'), 'multiple saved folders');
    await capture('saved-folder-groups.png');
    assert.equal(await cdp.eval(`(() => { const heading=document.querySelector('#viewerTree .workspace-viewer-saved-heading'); const toggle=heading.querySelector('.viewer-saved-toggle'); const remove=heading.querySelector('.viewer-saved-remove'); return toggle.textContent.includes('src') && remove.textContent==='해제' && Math.abs(toggle.getBoundingClientRect().top-remove.getBoundingClientRect().top)<3 && remove.getBoundingClientRect().right<=heading.getBoundingClientRect().right; })()`), true, 'saved folder controls share heading row');
    await cdp.eval(`document.querySelector('#viewerTree .workspace-viewer-saved-heading .viewer-saved-toggle').click()`);
    assert.equal(await cdp.eval(`document.querySelector('#viewerTree .workspace-viewer-saved-group .workspace-viewer-saved-children').hidden`), true, 'saved folder children collapse');
    await capture('saved-folder-collapsed.png');
    assert.equal(await cdp.eval(`document.querySelectorAll('#viewerTree .workspace-viewer-saved-heading').length`), 2, 'other saved group remains');
    await cdp.eval(`document.querySelector('#viewerTree .workspace-viewer-saved-heading .viewer-saved-toggle').click()`);
    assert.equal(await cdp.eval(`document.querySelector('#viewerTree .workspace-viewer-saved-group .workspace-viewer-saved-children').hidden`), false, 'saved folder children expand');
    await cdp.eval('document.getElementById("viewerSearchInput").value="test_*.py";document.getElementById("viewerSearchForm").requestSubmit()');
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="target/test_hidden.py"]')`), 'search multiple selected folders');
    await cdp.eval('document.getElementById("viewerSearchClear").click()');
    await cdp.eval(`(()=>{document.getElementById('viewerSavedFolderMode').click();const dialog=document.querySelector('.viewer-folder-dialog');dialog.querySelector('input[value=all]').click();dialog.querySelector('.viewer-folder-actions button:last-child').click()})()`);
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="note.txt"]')`), 'all folders view');
    await cdp.eval('document.getElementById("viewerSearchOptionsToggle").click();document.getElementById("viewerSearchExtensions").click()');
    await capture('local-extension-modal.png');
    await cdp.eval('document.querySelector(".viewer-extension-dialog input[value=md]").click();document.querySelector(".viewer-extension-dialog .viewer-extension-apply").click()');
    await until(() => cdp.eval(`!document.querySelector('#viewerTree button[title="note.txt"]')`), 'extension filtered tree');
    await cdp.eval('document.getElementById("viewerSearchExtensions").click();document.querySelector(".viewer-extension-dialog input[value=md]").click();document.querySelector(".viewer-extension-dialog .viewer-extension-apply").click()');
    await cdp.eval('document.getElementById("viewerSearchOptionsToggle").click()');
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="note.txt"]')`), 'extension filter cleared');
    await cdp.eval(`document.querySelector('#viewerTree button[title="note.txt"]').click()`);
    await cdp.eval('document.getElementById("viewerCopyFile").click(); document.querySelector(".workspace-viewer-root").click(); document.getElementById("viewerPasteFile").click()');
    await until(() => fs.existsSync(path.join(project, 'note (copy).txt')), 'file copy');
    assert.equal(fs.readFileSync(path.join(project, 'note.txt'), 'utf8'), 'after\n');
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="pixel.png"]')`), 'file tree after copy');
    await cdp.eval(`document.querySelector('#viewerTree button[title="pixel.png"]').click()`);
    await until(() => cdp.eval('document.querySelector("#viewerPreview img")?.src.startsWith("data:image/png;base64,")'), 'image preview');
    await cdp.eval(`document.querySelector('#viewerTree button[title="page.html"]').click()`);
    await until(() => cdp.eval('document.querySelector("#viewerPreview iframe")?.srcdoc.includes("HTML preview")'), 'HTML preview');
    await capture('html-viewer.png');
    await cdp.eval(`document.querySelector('#viewerTree button[title="large-page.html"]').click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("8MB")'), 'large HTML limit');
    await cdp.eval('document.getElementById("viewerPreviewLimit").value="16";document.getElementById("viewerPreviewLimit").dispatchEvent(new Event("change"))');
    await until(() => cdp.eval('document.querySelector("#viewerPreview iframe")?.srcdoc.includes("Large HTML preview")'), 'expanded HTML preview');
    await capture('large-html-viewer.png');
    assert.equal(await cdp.eval('document.querySelector("#viewerPreview iframe").getAttribute("sandbox")'), '');
    assert.equal(await cdp.eval('window.__htmlExecuted === true'), false);
    assert.equal(await cdp.eval('document.getElementById("viewerDownload").disabled'), false);
    await cdp.eval(`(async()=>{window.__originalViewerAction=window.wincmux.viewerAction;window.wincmux.viewerAction=async(action,path,payload)=>action==='viewer-download'?{path:'saved.html'}:window.__originalViewerAction(action,path,payload);document.getElementById('viewerDownload').click()})()`);
    await until(() => cdp.eval('document.getElementById("viewerMessage").textContent.includes("saved.html")'), 'download action');
    await cdp.eval('window.wincmux.viewerAction=window.__originalViewerAction');
    await cdp.eval(`document.querySelector('#viewerTree button[title="document.pdf"]').click()`);
    await until(() => cdp.eval('document.querySelector("#viewerPreview iframe")?.src.startsWith("blob:")'), 'PDF preview');
    await sleep(500);
    await capture('pdf-viewer.png');
    if (process.env.WINCMUX_VIEWER_MEDIA_ONLY) return;
    if (process.env.WINCMUX_VIEWER_SCREENSHOT_DIR) {
      const screenshot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, 'folder-viewer.png'), Buffer.from(screenshot.data, 'base64'));
    }
    await cdp.eval('document.querySelector(".launch-viewer-card[data-viewer-tab=git]").click()');
    await until(() => cdp.eval(`!!document.querySelector('#viewerGitList button[title="note.txt"]')`), 'Git status');
    console.log('viewer test: git status');
    await cdp.eval(`document.querySelector('#viewerGitList button[title="note.txt"]').click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("+after")'), 'Git diff');
    assert.equal(await cdp.eval('!!document.querySelector("#viewerPreview .workspace-viewer-diff-line.added")'), true);
    assert.equal(await cdp.eval('!!document.querySelector("#viewerPreview .workspace-viewer-diff-line.removed")'), true);
    assert.equal(await cdp.eval(`document.querySelectorAll('#viewerGitList button[title="both.txt"]').length`), 2);
    await cdp.eval(`document.querySelector('#viewerGitList button[title="both.txt"]').click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("+staged")'), 'staged diff');
    await cdp.eval(`document.querySelectorAll('#viewerGitList button[title="both.txt"]')[1].click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("+unstaged")'), 'unstaged diff');
    await capture('git-0.2.83.png');
    console.log('viewer test: git diffs');
    await cdp.eval('document.getElementById("viewerRefresh").click()');
    await until(() => cdp.eval(`document.querySelectorAll('#viewerGitList button[title="both.txt"]')[1]?.classList.contains('selected')`), 'Git selection after refresh');
    await cdp.eval('document.getElementById("viewerPrevious").click()');
    assert.equal(await cdp.eval('document.querySelectorAll("#viewerGitList button.selected").length'), 1);
    await cdp.eval(`document.getElementById('viewerGitList').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
    await until(() => cdp.eval(`document.querySelectorAll('#viewerGitList button[title="both.txt"]')[1]?.classList.contains('selected')`), 'keyboard Git navigation');
    for (let index = 0; index < 101; index += 1) fs.writeFileSync(path.join(project, `zz-page-${String(index).padStart(3, '0')}.txt`), '');
    await cdp.eval('document.getElementById("viewerRefresh").click()');
    await until(() => cdp.eval('!document.getElementById("viewerGitNextPage").disabled'), 'next Git page');
    await cdp.eval('document.getElementById("viewerGitNextPage").click()');
    await until(() => cdp.eval('document.getElementById("viewerGitPageLabel").textContent === "2페이지" && !!document.querySelector("#viewerGitList button[title^=zz-page-]")'), 'second Git page');
    await cdp.eval('document.getElementById("viewerGitPrevPage").click()');
    await until(() => cdp.eval('document.getElementById("viewerGitPageLabel").textContent === "1페이지"'), 'first Git page');
    await cdp.eval('openWsInfoPanel(selectedWorkspace(), document.getElementById("workspaceViewerBtn"))');
    const quickActions = await cdp.eval('[...document.querySelectorAll("#wsQuickActions button")].map(button=>button.textContent)');
    const filesAction = quickActions.includes('파일') ? '파일' : 'Files';
    for (const action of ['Files', 'Explorer', 'VSCode', 'Git', 'Git diff', 'Agent Assets', 'Input Assets', '+ Terminal']) {
      assert.ok(quickActions.includes(action === 'Files' ? filesAction : action), `${action} action is available`);
    }
    const clickQuick = (label) => cdp.eval(`([...document.querySelectorAll('#wsQuickActions button')].find(button=>button.textContent===${JSON.stringify(label === 'Files' ? filesAction : label)})).click()`);
    await cdp.eval('window.__externalCalls=[];window.wincmux.openInExplorer=async path=>window.__externalCalls.push(["Explorer",path]);window.wincmux.openInVscode=async path=>window.__externalCalls.push(["VSCode",path])');
    await clickQuick('Explorer');
    await clickQuick('VSCode');
    assert.equal(await cdp.eval('window.__externalCalls.length'), 2);
    await clickQuick('Git');
    await until(() => cdp.eval('document.getElementById("wsGitSummary").textContent.includes("Branch:")'), 'workspace Git summary');
    await until(() => cdp.eval('!!document.getElementById("wsScanBtn")'), 'long-file scan action');
    await cdp.eval('document.getElementById("wsScanBtn").click()');
    await until(() => cdp.eval('document.getElementById("wsScanArea").textContent.includes("No files over")'), 'long-file scan');
    await clickQuick('Agent Assets');
    await until(() => cdp.eval(`document.getElementById('viewerAgentsTab').classList.contains('active') && !!document.querySelector('#viewerAgentList button[title="AGENTS.md"]')`), 'agent files tab');
    console.log('viewer test: agent files');
    assert.equal(await cdp.eval('document.getElementById("wsAgentAssets").style.display'), 'none');
    const agentGroups = await cdp.eval(`[...document.querySelectorAll('#viewerAgentList .workspace-viewer-agent-group')].map(section=>[section.querySelector('.workspace-viewer-agent-group-toggle').textContent,section.querySelector('.workspace-viewer-row')?.title])`);
    assert.ok(agentGroups.some(([label, file]) => label.includes('.agents') && file === '.agents/skills/team/SKILL.md'));
    assert.ok(agentGroups.some(([label]) => label.includes('.codex')));
    assert.equal(await cdp.eval(`!!document.querySelector('#viewerAgentList button[title=".codex/skills/review/SKILL.md"]')`), true);
    await cdp.eval(`(()=>{const group=[...document.querySelectorAll('#viewerAgentList .workspace-viewer-agent-group')].find(section=>section.querySelector('.workspace-viewer-agent-group-toggle').textContent.includes('.agents'));group.querySelector('.workspace-viewer-agent-group-toggle').click()})()`);
    assert.equal(await cdp.eval(`document.querySelector('#viewerAgentList button[title=".agents/skills/team/SKILL.md"]').parentElement.hidden`), true);
    await cdp.eval(`(()=>{const group=[...document.querySelectorAll('#viewerAgentList .workspace-viewer-agent-group')].find(section=>section.querySelector('.workspace-viewer-agent-group-toggle').textContent.includes('.agents'));group.querySelector('.workspace-viewer-agent-group-toggle').click()})()`);
    await cdp.eval(`document.querySelector('#viewerAgentList button[title=".codex/skills/review/SKILL.md"]').click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("review skill")'), 'grouped agent file preview');
    await capture('agent-0.2.83.png');
    await cdp.eval(`document.querySelector('#viewerAgentList button[title="AGENTS.md"]').click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("test agent instructions")'), 'agent file preview');
    await cdp.eval(`document.querySelector('#viewerPreview button').click();document.querySelector('#viewerPreview textarea').value='# updated instructions\\n';document.querySelectorAll('#viewerPreview button')[0].click()`);
    await until(() => fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8').includes('updated instructions'), 'agent file edit');
    await cdp.eval('document.getElementById("viewerCodexTab").click()');
    await until(() => cdp.eval(`document.getElementById('viewerAgentHookStatus').textContent.includes('Codex 훅') && !!document.querySelector('#viewerAgentList button[title=".codex/config.toml"]')`), 'Codex settings tab');
    await capture('installed-codex-viewer.png');
    assert.equal(await cdp.eval(`(()=>{const tabs=document.querySelector('.workspace-viewer-tabs').getBoundingClientRect();const setup=document.getElementById('viewerAgentSetup').getBoundingClientRect();const main=document.getElementById('viewerMain').getBoundingClientRect();return Math.abs(tabs.bottom-setup.top)<3&&Math.abs(setup.bottom-main.top)<3&&main.height>200})()`), true, 'agent settings sit directly above the file list');
    assert.equal(await cdp.eval(`!!document.querySelector('#viewerAgentList button[title="CLAUDE.md"]')`), false);
    await cdp.eval(`document.querySelector('#viewerAgentList button[title=".codex/config.toml"]').click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("test-model")'), 'Codex config preview');
    await cdp.eval('document.getElementById("viewerAgentHookRegister").click()');
    await until(() => fs.existsSync(path.join(project, '.codex', 'hooks.json')), 'Codex hook registration');
    await until(() => cdp.eval(`document.getElementById('viewerAgentHookStatus').textContent.includes('등록됨') && !!document.querySelector('#viewerAgentList button[title=".codex/hooks.json"]')`), 'Codex hook status and file');
    await cdp.eval(`document.querySelector('#viewerAgentList button[title=".codex/hooks.json"]').click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("UserPromptSubmit")'), 'Codex hook preview');
    await cdp.eval('document.getElementById("viewerClaudeTab").click()');
    await until(() => cdp.eval(`document.getElementById('viewerAgentHookStatus').textContent.includes('Claude 훅') && !!document.querySelector('#viewerAgentList button[title=".claude/settings.json"]')`), 'Claude settings tab');
    await capture('installed-claude-viewer.png');
    assert.equal(await cdp.eval(`!!document.querySelector('#viewerAgentList button[title="AGENTS.md"]')`), false);
    await cdp.eval(`document.querySelector('#viewerAgentList button[title=".claude/settings.json"]').click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("permissions")'), 'Claude settings preview');
    await cdp.eval('document.getElementById("viewerAgentHookRegister").click()');
    await until(() => fs.existsSync(path.join(project, '.claude', 'settings.local.json')), 'Claude hook registration');
    await until(() => cdp.eval(`document.getElementById('viewerAgentHookStatus').textContent.includes('등록됨') && !!document.querySelector('#viewerAgentList button[title=".claude/settings.local.json"]')`), 'Claude hook status and file');
    await cdp.eval(`document.querySelector('#viewerAgentList button[title=".claude/settings.local.json"]').click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("PermissionRequest")'), 'Claude hook preview');
    await cdp.eval('openWsInfoPanel(selectedWorkspace(), document.getElementById("workspaceViewerBtn"))');
    await clickQuick('Input Assets');
    await until(() => cdp.eval('!!document.getElementById("wsInputAssets").dataset.assets'), 'input assets');
    await clickQuick('Files');
    await until(() => cdp.eval('document.getElementById("wsInfoOverlay").style.display==="none" && !document.getElementById("viewerSearchForm").hidden'), 'Files quick action');
    assert.equal(await cdp.eval(`(()=>{const tabs=document.querySelector('.workspace-viewer-tabs').getBoundingClientRect();const main=document.getElementById('viewerMain').getBoundingClientRect();return Math.abs(tabs.bottom-main.top)<3&&main.height>200})()`), true, 'file list starts directly below the tabs');
    await cdp.eval('openWsInfoPanel(selectedWorkspace(), document.getElementById("workspaceViewerBtn"))');
    await clickQuick('Git diff');
    await until(() => cdp.eval('document.getElementById("wsInfoOverlay").style.display==="none" && document.getElementById("viewerGitTab").classList.contains("active")'), 'Git diff quick action');
    assert.equal(await cdp.eval('Object.keys(state.paneSessions).length'), beforeSessions);
    const otherProject = path.join(temp, 'other-project');
    fs.mkdirSync(otherProject);
    const other = await cdp.eval(`rpc('workspace.create',${JSON.stringify({ name: 'Other viewer test', path: otherProject, backend: 'custom' })})`);
    await cdp.eval('loadWorkspaces()');
    await cdp.eval(`openWsInfoPanel(state.workspaces.find(ws=>ws.id===${JSON.stringify(other.workspace.id)}),document.getElementById('workspaceViewerBtn'))`);
    await clickQuick('Git diff');
    await until(() => cdp.eval(`state.selectedWorkspaceId===${JSON.stringify(other.workspace.id)}`), 'cross-workspace Git viewer');
    await cdp.eval('window.wincmuxWorkspaceViewer.open("codex")');
    await until(() => cdp.eval('document.getElementById("viewerAgentHookStatus").textContent.includes("0/6")'), 'other workspace Codex hook status');
    assert.equal(await cdp.eval(`!!document.querySelector('#viewerAgentList button[title=".codex/config.toml"]')`), false);
    assert.equal(await cdp.eval('Object.keys(state.paneSessions).length'), 0);
    await cdp.eval(`runWorkspaceTransition(${JSON.stringify(ws.workspace.id)},{reason:'test',forceLayout:true,autoSession:false})`);
    await cdp.eval('openWsInfoPanel(selectedWorkspace(), document.getElementById("workspaceViewerBtn"))');
    const sessionsBeforeTerminal = await cdp.eval('Object.keys(state.paneSessions).length');
    const panesBeforeTerminal = await cdp.eval('leafPanes().length');
    await clickQuick('+ Terminal');
    await until(() => cdp.eval(`leafPanes().length > ${panesBeforeTerminal} && !state.paneSessions[state.selectedPaneId] && state.paneViews.get(state.selectedPaneId)?.overlayEl.dataset.mode === 'empty'`), 'Terminal quick action opens chooser');
    assert.equal(await cdp.eval('Object.keys(state.paneSessions).length'), sessionsBeforeTerminal);
    await cdp.eval('document.querySelector(".group-add").click()');
    await cdp.eval(`(()=>{const form=document.querySelector('.group-create-inline');form.querySelector('input').value='Custom';form.requestSubmit()})()`);
    await until(() => cdp.eval('state.paneGroups.find(group=>group.id===state.selectedGroupId)?.name === "Custom" && !!document.querySelector(".pane-empty-create")'), 'new group is empty');
    await cdp.eval('document.querySelector(".pane-empty-create").click()');
    await until(() => cdp.eval('groupForPane(state.selectedPaneId)?.name === "Custom" && !state.paneSessions[state.selectedPaneId] && !!document.querySelector(".pane-leaf")'), 'terminal created in group');
    const customPane = await cdp.eval('state.selectedPaneId');
    assert.equal(await cdp.eval(`groupIdForNewPaneSession(${JSON.stringify(customPane)},'claude',[]) === state.selectedGroupId`), true);
    await cdp.eval(`onSplit(${JSON.stringify(customPane)},'horizontal')`);
    await until(() => cdp.eval('leafPanes().length >= 3 && groupForPane(state.selectedPaneId)?.name === "Custom" && !state.paneSessions[state.selectedPaneId]'), 'split stays in group').catch(async error => { throw Error(`${error.message}; ${JSON.stringify(await cdp.eval('({leaves:leafPanes().length,selected:state.selectedPaneId,group:groupForPane(state.selectedPaneId)?.name,sessions:Object.keys(state.paneSessions),status:statusBar.title})'))}`); });
    assert.equal(await cdp.eval('document.querySelectorAll(".pane-leaf").length'), 2);
    assert.equal(await cdp.eval(`(async()=>{const paneId=state.selectedPaneId;state.dormantPaneSessions[paneId]={workspace_id:state.selectedWorkspaceId,pane_id:paneId,session_id:'old-claude',spawn_cmd:'claude',spawn_args:'[]',spawn_cwd:selectedWorkspace().path};await startSessionForPane(paneId,{force:true});const view=state.paneViews.get(paneId);return !state.paneSessions[paneId] && view.overlayEl.dataset.mode==='empty' && !!view.overlayLaunchEl.querySelector('.launch-profile-card[data-profile-id="powershell"]')})()`), true, 'new terminal does not restore saved Claude');
    if (process.env.WINCMUX_VIEWER_SCREENSHOT_DIR) {
      const screenshot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(process.env.WINCMUX_VIEWER_SCREENSHOT_DIR, 'git-viewer.png'), Buffer.from(screenshot.data, 'base64'));
    }
    console.log('Workspace viewer smoke test passed.');
  } finally {
    if (cdp) {
      await cdp.eval("rpc('runtime.shutdown_all',{confirmed:true})", 2000).catch(() => {});
      cdp.close();
    }
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) {
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    await sleep(300);
    if (path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); break; }
        catch (error) {
          if (attempt === 7) console.warn('Temporary test files are still in use:', error.message);
          else await sleep(500);
        }
      }
    }
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
