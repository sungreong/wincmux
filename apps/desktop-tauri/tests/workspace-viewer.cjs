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
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# test agent instructions\n');
  fs.mkdirSync(path.join(project, '.agents', 'skills', 'team'), { recursive: true });
  fs.mkdirSync(path.join(project, '.codex', 'skills', 'review'), { recursive: true });
  fs.writeFileSync(path.join(project, '.agents', 'skills', 'team', 'SKILL.md'), '# team skill\n');
  fs.writeFileSync(path.join(project, '.codex', 'skills', 'review', 'SKILL.md'), '# review skill\n');
  fs.writeFileSync(path.join(project, 'target', 'test_hidden.py'), 'excluded result\n');
  fs.writeFileSync(path.join(project, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9bMZsAAAAASUVORK5CYII=', 'base64'));
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
    await until(() => cdp.eval('!!document.querySelector(".launch-viewer-card[data-viewer-tab=files]")'), 'viewer launcher');
    assert.equal(await cdp.eval('document.querySelector(".launch-viewer-card[data-viewer-tab=files]").getBoundingClientRect().top < document.querySelector(".pane-terminal-overlay").getBoundingClientRect().bottom'), true);
    const beforeSessions = await cdp.eval('Object.keys(state.paneSessions).length');
    await cdp.eval('document.querySelector(".launch-viewer-card[data-viewer-tab=files]").click()');
    assert.equal(await cdp.eval('document.getElementById("workspaceViewer").hidden'), false);
    assert.equal(await cdp.eval('Object.keys(state.paneSessions).length'), beforeSessions);
    assert.equal(await cdp.eval('document.getElementById("viewerTree").getBoundingClientRect().right < document.querySelector(".workspace-viewer-preview").getBoundingClientRect().left'), true);
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="note.txt"]')`), 'file tree');
    console.log('viewer test: file tree');
    await cdp.eval(`document.querySelector('#viewerTree button[title="note.txt"]').click()`);
    await until(() => cdp.eval('document.getElementById("viewerPreview").textContent.includes("after")'), 'text preview');
    await cdp.eval(`(async()=>{window.wincmux.clipboardWrite=async text=>{window.__viewerCopiedText=text};document.getElementById('viewerCopyPath').click()})()`);
    assert.equal((await cdp.eval('window.__viewerCopiedText')).endsWith('\\note.txt'), true);
    await cdp.eval('document.getElementById("viewerCopyContent").click()');
    assert.equal(await cdp.eval('window.__viewerCopiedText'), 'after\n');
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
    await cdp.eval(`document.querySelector('#viewerTree button[title="src"]').click()`);
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="src/test_alpha.py"]')`), 'expanded folder');
    await cdp.eval('document.getElementById("viewerRefresh").click()');
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="src/test_alpha.py"]')`), 'expanded folder after refresh');
    await cdp.eval(`(()=>{document.getElementById('viewerSearchScope').checked=true;document.getElementById('viewerContentInput').value='search result';document.getElementById('viewerSearchForm').requestSubmit()})()`);
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="src/test_alpha.py"]')`), 'scoped content search');
    console.log('viewer test: content search');
    assert.equal(await cdp.eval(`!!document.querySelector('#viewerTree button[title="src/test_beta.py"]')`), false);
    assert.equal(await cdp.eval('document.querySelector("#viewerTree .workspace-viewer-search-snippet")?.textContent.includes("1행")'), true);
    await cdp.eval('document.getElementById("viewerSearchClear").click()');
    await until(() => cdp.eval(`!!document.querySelector('#viewerTree button[title="note.txt"]')`), 'tree after content search');
    await cdp.eval(`document.querySelector('#viewerTree button[title="note.txt"]').click()`);
    await cdp.eval('document.getElementById("viewerCopyFile").click(); document.querySelector(".workspace-viewer-root").click(); document.getElementById("viewerPasteFile").click()');
    await until(() => fs.existsSync(path.join(project, 'note (copy).txt')), 'file copy');
    assert.equal(fs.readFileSync(path.join(project, 'note.txt'), 'utf8'), 'after\n');
    await cdp.eval(`document.querySelector('#viewerTree button[title="pixel.png"]').click()`);
    await until(() => cdp.eval('document.querySelector("#viewerPreview img")?.src.startsWith("data:image/png;base64,")'), 'image preview');
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
    await cdp.eval('openWsInfoPanel(selectedWorkspace(), document.getElementById("workspaceViewerBtn"))');
    const quickActions = await cdp.eval('[...document.querySelectorAll("#wsQuickActions button")].map(button=>button.textContent)');
    for (const action of ['Files', 'Explorer', 'VSCode', 'Git', 'Git diff', 'Agent Assets', 'Input Assets', '+ Terminal']) {
      assert.ok(quickActions.includes(action), `${action} action is available`);
    }
    const clickQuick = (label) => cdp.eval(`([...document.querySelectorAll('#wsQuickActions button')].find(button=>button.textContent===${JSON.stringify(label)})).click()`);
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
    assert.ok(agentGroups.some(([label, file]) => label.includes('.codex') && file === '.codex/skills/review/SKILL.md'));
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
    await cdp.eval('openWsInfoPanel(selectedWorkspace(), document.getElementById("workspaceViewerBtn"))');
    await clickQuick('Input Assets');
    await until(() => cdp.eval('!!document.getElementById("wsInputAssets").dataset.assets'), 'input assets');
    await clickQuick('Files');
    await until(() => cdp.eval('document.getElementById("wsInfoOverlay").style.display==="none" && !document.getElementById("viewerSearchForm").hidden'), 'Files quick action');
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
    assert.equal(await cdp.eval('Object.keys(state.paneSessions).length'), 0);
    await cdp.eval(`runWorkspaceTransition(${JSON.stringify(ws.workspace.id)},{reason:'test',forceLayout:true,autoSession:false})`);
    await cdp.eval('openWsInfoPanel(selectedWorkspace(), document.getElementById("workspaceViewerBtn"))');
    const sessionsBeforeTerminal = await cdp.eval('Object.keys(state.paneSessions).length');
    await clickQuick('+ Terminal');
    await until(() => cdp.eval(`Object.keys(state.paneSessions).length > ${sessionsBeforeTerminal}`), 'Terminal quick action');
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
