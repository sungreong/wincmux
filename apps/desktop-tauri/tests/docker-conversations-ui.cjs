const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function connectTarget(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const packet = JSON.parse(data);
    pending.get(packet.id)?.(packet);
  });
  return {
    close: () => socket.close(),
    eval(expression) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout')); }, 25000);
        pending.set(id, packet => {
          clearTimeout(timer); pending.delete(id);
          if (packet.error || packet.result?.exceptionDetails) reject(Error(packet.error?.message || packet.result.exceptionDetails.text));
          else resolve(packet.result.result.value);
        });
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
      });
    }
  };
}

async function run() {
  const container = process.env.WINCMUX_TEST_CONTAINER_ID;
  if (!container) throw Error('Set WINCMUX_TEST_CONTAINER_ID to a running container with /app conversations.');
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-docker-conversations-'));
  const port = await portNumber();
  const child = spawn(path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'), ['--benchmark-hidden'], {
    windowsHide: true, stdio: 'ignore', env: {
      ...process.env, WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-docker-conversations-' + randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling`
    }
  });
  let main, remote;
  try {
    main = await connect(port, child);
    await until(() => main.eval('typeof state!=="undefined" && state.bootstrapReady===true'), 'main app');
    await main.eval('window.__TAURI__.core.invoke("open_docker_workspace")');
    const page = await until(async () => {
      const result = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      return result.find(p => p.type === 'page' && p.url.includes('ssh-workspace.html') && p.webSocketDebuggerUrl);
    }, 'Docker window');
    remote = await connectTarget(page.webSocketDebuggerUrl);
    await until(() => remote.eval('document.readyState==="complete" && !!window.wincmuxRemoteConversations'), 'Docker UI');
    await until(() => remote.eval(`[...document.querySelector('#container').options].some(o=>o.value.startsWith(${JSON.stringify(container)}))`), 'container list');
    await remote.eval(`(() => {
      const select=document.getElementById('container');
      select.value=[...select.options].find(o=>o.value.startsWith(${JSON.stringify(container)})).value;
      select.dispatchEvent(new Event('change',{bubbles:true}));
      document.getElementById('directory').value='/app';
      document.getElementById('openTarget').click();
    })()`);
    await until(() => remote.eval('!document.getElementById("workArea").hidden'), 'Docker project');
    await remote.eval('document.getElementById("remoteConversationBtn").click()');
    await until(() => remote.eval('document.querySelectorAll("#remoteConversationDialog .conversation-row").length >= 1'), 'conversation rows');
    const result = await remote.eval(`(() => ({
      open: document.getElementById('remoteConversationDialog').open,
      count: document.querySelectorAll('#remoteConversationDialog .conversation-row').length,
      provider: document.querySelector('#remoteConversationDialog .conversation-row')?.dataset.id ? 'present' : 'missing',
      resume: !!document.querySelector('#remoteConversationDialog .conversation-resume:not(:disabled)')
    }))()`);
    assert.equal(result.open, true);
    assert.ok(result.count > 0);
    assert.equal(result.provider, 'present');
    assert.equal(result.resume, true);
    const sendNowRoute = await remote.eval(`window.__TAURI__.core.invoke('ssh_workspace', {
      action:'agent-send-now', params:{ id:'00000000-0000-0000-0000-000000000000', item:1 }
    }).then(()=> 'unexpected success', error => String(error))`);
    assert.match(sendNowRoute, /원격 터미널이 종료되었습니다/, 'Docker routes send-now to the terminal handler');
    await remote.eval(`document.querySelector('#remoteConversationDialog [data-conversation=close]').click()`);
    await until(() => remote.eval('document.querySelectorAll(".pane-group-root .pane").length === 1'), 'default pane');
    await remote.eval(`document.querySelector('#paneGroupTabs button:last-child').click()`);
    assert.equal(await remote.eval('document.querySelectorAll(".pane-group-root").length'), 2);
    assert.equal(await remote.eval('document.querySelectorAll("#paneGroupTabs button[aria-pressed=true]").length'), 1);
    await remote.eval(`document.getElementById('newTerminal').click()`);
    await until(() => remote.eval('document.querySelectorAll(".pane-group-root .pane").length === 2'), 'second group terminal');
    const grouped = await remote.eval(`(() => {
      document.querySelector('#paneGroupTabs button[aria-pressed]').click();
      return { active:document.querySelector('#paneGroupTabs button[aria-pressed]')?.getAttribute('aria-pressed'), visible:document.querySelector('.pane-group-root:not([hidden])')?.querySelectorAll('.pane').length };
    })()`);
    assert.deepEqual(grouped, { active:'true', visible:1 });
    await remote.eval(`document.querySelector('.pane-group-root:not([hidden]) [data-action=hidePane]').click()`);
    assert.equal(await remote.eval('document.getElementById("hiddenRemotePanes").textContent'), '숨김 (1)');
    assert.equal(await remote.eval('document.querySelectorAll(".hidden-pane-storage .pane").length'), 1);
    await remote.eval(`document.getElementById('hiddenRemotePanes').click()`);
    await remote.eval(`document.querySelector('#hiddenRemotePanesList button').click()`);
    await remote.eval(`document.getElementById('closeHiddenRemotePanes').click()`);
    assert.equal(await remote.eval('document.querySelectorAll(".hidden-pane-storage .pane").length'), 0);
    assert.equal(await remote.eval('document.querySelectorAll(".pane-group-root:not([hidden]) .pane").length'), 1);
    await remote.eval(`(() => {
      const panel=document.querySelector('.pane-group-root:not([hidden]) .remote-shell-composer');
      panel.querySelector('input').value='printf WINCMUX_GROUP_ALIVE';
      panel.querySelector('button').click();
    })()`);
    await until(() => remote.eval('document.querySelector(".pane-group-root:not([hidden]) .xterm-rows")?.textContent.includes("WINCMUX_GROUP_ALIVE")'), 'restored shell responds');
    await remote.eval(`document.querySelector('.pane-group-root:not([hidden]) [data-action=search]').click()`);
    await remote.eval(`(() => {
      const input=document.querySelector('.pane-group-root:not([hidden]) .terminal-search input[type=search]');
      input.value='WINCMUX_GROUP_ALIVE';
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await until(() => remote.eval('/^[1-9][0-9]*[/][1-9][0-9]*$/.test(document.querySelector(".pane-group-root:not([hidden]) .terminal-search-count")?.textContent)'), 'Docker search result');
    await remote.eval(`document.querySelector('.pane-group-root:not([hidden]) .terminal-search [data-search=previous]').click()`);
    assert.equal(await remote.eval('document.querySelector(".pane-group-root:not([hidden]) .terminal-search").hidden'), false);
    await remote.eval(`document.querySelector('.pane-group-root:not([hidden]) .terminal-search [data-search=close]').click()`);
    assert.equal(await remote.eval('document.querySelector(".pane-group-root:not([hidden]) .terminal-search").hidden'), true);
    await until(() => remote.eval('!document.querySelector(".pane-group-root:not([hidden]) [data-action=splitRight]").disabled && !document.getElementById("newTerminal").disabled'), 'split ready');
    await remote.eval(`document.querySelector('.pane-group-root:not([hidden]) [data-action=splitRight]').click()`);
    assert.equal(await remote.eval('document.getElementById("splitLauncher").open'), true);
    await remote.eval(`document.querySelector('[data-split-launch=shell]').click()`);
    await until(() => remote.eval('document.querySelectorAll(".pane-group-root:not([hidden]) .pane").length === 2'), 'split shell');
    assert.equal(await remote.eval('document.querySelectorAll(".pane-group-root:not([hidden]) .pane-split").length'), 1);
    await remote.eval(`document.querySelector('.pane-group-root:not([hidden]) [data-action=movePane]').click()`);
    assert.equal(await remote.eval('document.getElementById("moveRemotePaneDialog").open'), true);
    await remote.eval(`document.querySelector('#moveRemotePaneTargets .move-target-row:last-child button').click()`);
    assert.equal(await remote.eval('document.querySelectorAll(".pane-group-root:not([hidden]) .pane").length'), 2);
    await main.eval(`(() => { const select=document.querySelector('[data-ui-language]'); select.value='en'; select.dispatchEvent(new Event('change')); })()`);
    await until(() => remote.eval('document.querySelector("[data-ui-language]").value === "en" && document.getElementById("workspaceTitle").textContent === "Local Docker"'), 'English language synchronized');
    assert.equal(await main.eval('document.querySelector(".panel-left h2").textContent'), 'Workspaces');
    await remote.eval('document.getElementById("remoteConversationBtn").click()');
    const englishConversation = await remote.eval(`(() => {
      const dialog=document.getElementById('remoteConversationDialog');
      return { open:dialog.open, untranslated:[...new Set([...dialog.querySelectorAll('*')].filter(el=>!el.children.length && !el.closest('.conversation-title,.conversation-cwd,.conversation-id,pre,code') && /[가-힣]/.test(el.textContent)).map(el=>el.textContent.trim()).filter(Boolean))], attributes:[...new Set([...dialog.querySelectorAll('[title],[aria-label],[placeholder]')].filter(el=>!el.closest('.conversation-title,.conversation-cwd,.conversation-id')).flatMap(el=>['title','aria-label','placeholder'].map(name=>el.getAttribute(name)).filter(value=>value && /[가-힣]/.test(value))))] };
    })()`);
    console.log('English Docker conversation audit:', JSON.stringify(englishConversation));
    assert.equal(englishConversation.open, true);
    assert.deepEqual(englishConversation.untranslated, []);
    assert.deepEqual(englishConversation.attributes, []);
    await remote.eval('document.querySelector("#remoteConversationDialog [data-conversation=close]").click()');
    await remote.eval(`(() => { const select=document.querySelector('[data-ui-language]'); select.value='ko'; select.dispatchEvent(new Event('change')); })()`);
    await until(() => main.eval('document.querySelector("[data-ui-language]").value === "ko" && document.querySelector(".panel-left h2").textContent === "워크스페이스"'), 'Korean language synchronized');
    console.log(`Docker conversation dialog displayed ${result.count} resumable rows.`);
  } finally {
    if (remote) { await remote.eval('document.querySelectorAll(".pane-close").forEach(b=>b.click())').catch(() => {}); remote.close(); }
    main?.close();
    if (child.exitCode === null) child.kill();
  }
}

run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
