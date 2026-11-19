const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-sidebar-'));
  const first = path.join(temp, 'project-a', 'duplicate');
  const second = path.join(temp, 'project-b', 'duplicate');
  const third = path.join(temp, 'project-c', 'duplicate');
  const other = path.join(temp, 'project-b', 'different');
  for (const folder of [first, second, third, other]) fs.mkdirSync(folder, { recursive: true });
  const port = await portNumber();
  const child = spawn(path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'), ['--benchmark-hidden'], {
    windowsHide: true, stdio: 'ignore', env: {
      ...process.env,
      WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-sidebar-' + randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling`
    }
  });
  let cdp;
  try {
    cdp = await connect(port, child);
    await until(() => cdp.eval('typeof state!=="undefined" && state.bootstrapReady===true'), 'sidebar bootstrap');
    assert.equal(await cdp.eval('document.getElementById("shutdownAllBtn")'), null);
    assert.equal(await cdp.eval('document.getElementById("workspaceNotepad").hidden'), true);
    await cdp.eval('document.getElementById("workspaceNotepadToggle").click()');
    assert.equal(await cdp.eval('document.getElementById("workspaceNotepadToggle").getAttribute("aria-expanded")'), 'true');
    await cdp.eval(`(() => {const el=document.getElementById('workspaceNotepad');el.value='saved note';el.dispatchEvent(new Event('input'));})()`);
    await until(() => cdp.eval('Object.values(state.workspaceNotes).includes("saved note")'), 'note saved');
    await cdp.eval('document.getElementById("workspaceNotepadToggle").click()');
    assert.equal(await cdp.eval('document.getElementById("workspaceNotepad").hidden'), true);

    const ids = {};
    for (const [name, folder] of [['first', first], ['second', second], ['other', other]]) {
      ids[name] = (await cdp.eval(`rpc('workspace.create',${JSON.stringify({ name, path: folder, backend: 'custom' })})`)).workspace.id;
    }
    await cdp.eval('loadWorkspaces()');
    const group = () => cdp.eval('document.querySelector(".ws-folder-header .ws-folder-title")?.textContent');
    assert.equal(await group(), 'duplicate');
    assert.equal(await cdp.eval('document.querySelectorAll(".ws-folder-member").length'), 2);
    await cdp.eval('document.getElementById("toggleWorkspaceCreateBtn").click()');
    assert.equal(await cdp.eval('document.getElementById("pickFolderBtn").textContent'), '📂');
    assert.equal(await cdp.eval('document.getElementById("createWorkspaceBtn").textContent'), '➕');
    assert.equal(await cdp.eval('document.getElementById("pickFolderBtn").getAttribute("aria-label")'), '폴더 찾아보기');
    assert.equal(await cdp.eval('document.getElementById("wsPathInput").getBoundingClientRect().width > document.getElementById("wsNameInput").getBoundingClientRect().width'), true);
    assert.equal(await cdp.eval('document.querySelector(".ws-folder-member .ws-path").textContent'), first);
    assert.equal(await cdp.eval('getComputedStyle(document.querySelector(".ws-folder-member .ws-path")).whiteSpace'), 'normal');
    assert.equal(await cdp.eval('document.querySelector(".ws-folder-member .ws-path").tagName'), 'BUTTON');
    await cdp.eval('document.querySelector(".ws-folder-toggle").click()');
    assert.equal(await cdp.eval('document.querySelectorAll(".ws-folder-member[hidden]").length'), 2);
    await cdp.eval('document.getElementById("workspaceSimpleBtn").click()');
    assert.equal(await cdp.eval('state.workspaceListMode'), 'simple');
    assert.equal(await cdp.eval('document.querySelector("#workspaceList li.ws-simple .ws-path") !== null'), true);
    assert.equal(await cdp.eval('getComputedStyle(document.querySelector("#workspaceList li.ws-simple .ws-path")).display'), 'none');
    await cdp.eval('document.querySelector(".ws-folder-member .ws-info-btn").click()');
    assert.equal(await cdp.eval('document.getElementById("wsInfoPath").value'), first);
    assert.equal(await cdp.eval('document.getElementById("wsInfoCopyPath").getAttribute("aria-label")'), '폴더 경로 복사');
    await cdp.eval('document.getElementById("wsInfoCloseBtn").click()');
    const screenshot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artifacts', 'workspace-sidebar-0.2.92.png'), Buffer.from(screenshot.data, 'base64'));
    await cdp.eval('document.querySelector(".ws-folder-toggle").click()');
    assert.equal(await cdp.eval('document.querySelectorAll(".ws-folder-member[hidden]").length'), 0);
    const expanded = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(root, 'artifacts', 'workspace-sidebar-expanded-0.2.92.png'), Buffer.from(expanded.data, 'base64'));
    await cdp.eval('document.querySelector(".ws-folder-toggle").click()');

    const count = await cdp.eval('state.workspaces.length');
    const prepareDuplicate = `wsPathInput.value=${JSON.stringify(first)};wsNameInput.value='duplicate again';`;
    await cdp.eval(`(()=>{wsPathInput.value=${JSON.stringify(third)};wsNameInput.value='same folder name';document.getElementById('createWorkspaceBtn').click()})()`);
    await until(() => cdp.eval('document.getElementById("workspaceDuplicateDialog").open'), 'same-name duplicate dialog opens');
    assert.equal(await cdp.eval('document.getElementById("workspaceDuplicateNewPath").textContent'), third);
    assert.equal(await cdp.eval('document.querySelectorAll("#workspaceDuplicateExisting li").length'), 2);
    assert.match(await cdp.eval('document.getElementById("workspaceDuplicateExisting").textContent'), /project-a/);
    assert.equal(await cdp.eval('state.workspaces.length'), count);
    const duplicateScreenshot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(root, 'artifacts', 'workspace-duplicate-0.2.92.png'), Buffer.from(duplicateScreenshot.data, 'base64'));
    await cdp.eval('document.querySelector("#workspaceDuplicateDialog [value=cancel]").click()');
    await until(() => cdp.eval('!document.getElementById("workspaceDuplicateDialog").open && !document.getElementById("createWorkspaceBtn").disabled'), 'same-name duplicate canceled');
    assert.equal(await cdp.eval('state.workspaces.length'), count);
    await cdp.eval(`(()=>{${prepareDuplicate}document.getElementById('createWorkspaceBtn').click()})()`);
    await until(() => cdp.eval('document.getElementById("workspaceDuplicateDialog").open'), 'same-path duplicate dialog opens');
    assert.equal(await cdp.eval('document.getElementById("workspaceDuplicateNewPath").textContent'), first);
    assert.equal(await cdp.eval('state.workspaces.length'), count);
    await cdp.eval('document.querySelector("#workspaceDuplicateDialog [value=create]").click()');
    await until(() => cdp.eval(`state.workspaces.length === ${count + 1}`), 'confirmed duplicate created');
    assert.equal(await cdp.eval('state.workspaces.length'), count + 1);
    assert.equal(await cdp.eval('document.querySelectorAll(".ws-folder-member").length'), 3);

    await cdp.eval('window.__sidebarReloadMarker=true');
    await cdp.request('Page.reload');
    await until(() => cdp.eval('window.__sidebarReloadMarker!==true && typeof state!=="undefined" && state.bootstrapReady===true').catch(() => false), 'sidebar reload');
    assert.equal(await cdp.eval('state.workspaceListMode'), 'simple');
    assert.equal(await cdp.eval('document.getElementById("workspaceNotepad").hidden'), true);
    assert.equal(await cdp.eval('document.querySelectorAll(".ws-folder-member[hidden]").length'), 3);
    await cdp.eval(`(async()=>{window.__deletePrompt='';window.confirm=message=>{window.__deletePrompt=message;return false};await deleteWorkspaceById(${JSON.stringify(ids.other)})})()`);
    assert.equal(await cdp.eval('window.__deletePrompt'), '', 'empty workspace deletes without asking');
    assert.equal(await cdp.eval(`state.workspaces.some(workspace=>workspace.id===${JSON.stringify(ids.other)})`), false);

    const started = await cdp.eval(`rpc('session.run',${JSON.stringify({ workspace_id: ids.first, cmd: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: first })})`);
    const sessionId = started.session.session_id;
    const terminalPid = started.session.pid;
    const denied = await cdp.eval(`rpc('workspace.delete',{id:${JSON.stringify(ids.first)}}).then(()=>'',error=>String(error))`);
    assert.match(denied, /confirmation required/);
    await cdp.eval(`(async()=>{window.__deletePrompt='';window.confirm=message=>{window.__deletePrompt=message;return false};await deleteWorkspaceById(${JSON.stringify(ids.first)})})()`);
    assert.match(await cdp.eval('window.__deletePrompt'), /터미널 1개가 실행 중/);
    assert.equal((await cdp.eval(`rpc('session.list',{workspace_id:${JSON.stringify(ids.first)}})`)).sessions.find(session => session.id === sessionId).status, 'running');
    await cdp.eval(`(async()=>{window.confirm=()=>true;await deleteWorkspaceById(${JSON.stringify(ids.first)})})()`);
    assert.equal(await cdp.eval(`state.workspaces.some(workspace=>workspace.id===${JSON.stringify(ids.first)})`), false);
    await until(() => { try { process.kill(terminalPid, 0); return false; } catch { return true; } }, 'deleted workspace terminal exits');
    console.log(JSON.stringify({ notesCollapsed: true, exactFolderGrouping: true, duplicateConfirmation: true, compactIconButtons: true, visibleFolderPath: true, simpleMode: true, persisted: true, emptyWorkspaceDelete: true, runningWorkspaceConfirmation: true, terminalClosed: true }));
  } finally {
    if (cdp) { await cdp.eval("rpc('runtime.shutdown_all',{confirmed:true})").catch(() => {}); cdp.close(); }
    if (child.exitCode === null) child.kill();
  }
}

run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
