const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function connectPage(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const packet = JSON.parse(data);
    if (packet.method === 'Runtime.exceptionThrown') console.error('WebView exception:', packet.params.exceptionDetails.text, packet.params.exceptionDetails.exception?.description);
    if (packet.method === 'Runtime.consoleAPICalled') console.log('WebView console:', packet.params.args.map(arg => arg.value).join(' '));
    pending.get(packet.id)?.(packet);
  });
  socket.send(JSON.stringify({ id: 0, method: 'Runtime.enable' }));
  return {
    close: () => socket.close(),
    eval(expression) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout')); }, 15000);
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
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-i18n-'));
  const port = await portNumber();
  const child = spawn(process.env.WINCMUX_I18N_TEST_EXE || path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'), ['--benchmark-hidden'], {
    windowsHide: true, stdio: 'ignore', env: {
      ...process.env, WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-i18n-' + randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling`
    }
  });
  let main, remote;
  try {
    main = await connect(port, child);
    await until(() => main.eval('typeof window.wincmuxTerminalRenderer?.register === "function"'), 'main language UI');
    assert.equal(await main.eval('document.querySelectorAll("[data-ui-language]").length'), 1);
    assert.equal(await main.eval('Boolean(document.querySelector("#terminalRendererDialog [data-ui-language]"))'), true);
    const toolbar = await main.eval(`(() => {
      const bar=document.querySelector('.panel-center > .toolbar');
      bar.style.width='320px';
      const groups=[...bar.querySelectorAll(':scope > .toolbar-group')];
      const buttons=groups.flatMap(group=>[...group.querySelectorAll(':scope > button')]);
      const sideIds=['toggleWorkspaceCreateBtn','workspaceSimpleBtn','workspaceCompactBtn','workspaceDetailBtn','pickFolderBtn','createWorkspaceBtn'];
      const result={rows:new Set(groups.map(group=>Math.round(group.getBoundingClientRect().top))).size,scrolls:bar.scrollWidth>bar.clientWidth,allIcons:buttons.every(button=>{const icon=button.querySelector('svg');return Boolean(icon && icon.getBoundingClientRect().width>=16 && icon.getBoundingClientRect().height>=16);}),allNamed:buttons.every(button=>Boolean(button.title && button.getAttribute('aria-label'))),labelsHidden:buttons.every(button=>{const label=button.querySelector('.toolbar-btn-label');return !label || getComputedStyle(label).clipPath==='inset(50%)';}),sidebarIcons:sideIds.every(id=>{const button=document.getElementById(id);return Boolean(button.querySelector('svg') && button.title && button.getAttribute('aria-label') && !button.textContent.trim());}),fontInSettings:Boolean(document.querySelector('#terminalRendererDialog #fontScaleSelect'))};
      bar.style.width='';
      return result;
    })()`);
    assert.deepEqual(toolbar, {rows:1,scrolls:true,allIcons:true,allNamed:true,labelsHidden:true,sidebarIcons:true,fontInSettings:true});
    const notificationLayout = await main.eval(`(() => {
      const group=document.querySelector('.toolbar-notifications');
      if (!group) return {missing:true,groups:[...document.querySelectorAll('.panel-center > .toolbar .toolbar-group')].map(node=>node.className),url:location.href};
      const buttons=[...group.querySelectorAll(':scope > button')];
      const count=document.getElementById('notificationToolbarCount');
      count.textContent='5'; count.hidden=false;
      const rects=buttons.map(button=>button.getBoundingClientRect());
      const badge=count.getBoundingClientRect();
      const bell=buttons[0].querySelector('svg').getBoundingClientRect();
      const container=group.getBoundingClientRect();
      const result={compactSpacing:Math.abs((rects[1].left-rects[0].right)-2)<1&&Math.abs((rects[2].left-rects[1].right)-2)<1&&rects[1].width===32&&rects[2].width===32,
        aligned:rects.every(rect=>Math.abs(rect.y-rects[0].y)<1),
        badgeInside:badge.left>=rects[0].left&&badge.right<=rects[0].right&&badge.top>=container.top&&badge.bottom<=container.bottom,
        badgeBesideBell:badge.left>=bell.right&&Math.abs((badge.top+badge.bottom)/2-(bell.top+bell.bottom)/2)<2};
      return result;
    })()`);
    assert.deepEqual(notificationLayout, {compactSpacing:true,aligned:true,badgeInside:true,badgeBesideBell:true});
    if (process.env.WINCMUX_CAPTURE_TOOLBAR === '1') {
      await main.eval(`(() => { const count=document.getElementById('notificationToolbarCount'); count.hidden=true; count.textContent=''; const badge=document.createElement('span'); badge.className='toolbar-count'; badge.textContent='5'; badge.id='notificationBadgeScreenshot'; document.getElementById('toggleNotificationPanelBtn').append(badge); })()`);
      await main.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const screenshot = await main.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const output = path.join(root, 'artifacts', 'toolbar-notifications.png');
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, Buffer.from(screenshot.data, 'base64'));
      await main.eval('document.getElementById("notificationBadgeScreenshot").remove()');
    }
    await main.eval(`(() => { const count=document.getElementById('notificationToolbarCount'); count.hidden=true; count.textContent=''; })()`);
    assert.equal(await main.eval(`(() => {const badge=document.getElementById('reminderCount');badge.textContent='12';const button=document.getElementById('reminderBtn').getBoundingClientRect();const count=badge.getBoundingClientRect();badge.textContent='';return button.width>=44&&count.left>=button.left&&count.right<=button.right})()`), true, 'local reminder count stays inside its button');
    await until(() => main.eval('typeof state !== "undefined" && state.bootstrapReady === true'), 'toolbar ready');
    const fontScale = await main.eval(`(() => { const select=document.getElementById('fontScaleSelect'); select.value='110'; select.dispatchEvent(new Event('change')); const changed=state.globalFontScale; select.value='100'; select.dispatchEvent(new Event('change')); return [changed,state.globalFontScale]; })()`);
    assert.deepEqual(fontScale, [110, 100]);
    await main.eval(`(() => {
      const term=document.createElement('div'); term.className='xterm'; term.id='i18n-terminal-fixture'; term.textContent='워크스페이스'; document.body.append(term);
      const dynamic=document.createElement('div'); dynamic.id='i18n-dynamic-fixture'; dynamic.textContent='Hidden (7)'; document.body.append(dynamic);
      window.wincmuxI18n.setLanguage('ko');
    })()`);
    await until(() => main.eval('document.querySelector(".panel-left h2").textContent === "워크스페이스" && document.getElementById("i18n-dynamic-fixture").textContent === "숨김 (7)"'), 'Korean main UI');
    assert.equal(await main.eval('document.getElementById("terminalRendererTitle").textContent'), '터미널 화면 설정');
    assert.equal(await main.eval('document.getElementById("shortcutTitle").textContent'), '키보드 조작');
    await main.eval(`(() => { const select=document.querySelector('#terminalRendererDialog [data-ui-language]'); select.value='en'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await until(() => main.eval('document.querySelector(".panel-left h2").textContent === "Workspaces" && document.getElementById("i18n-dynamic-fixture").textContent === "Hidden (7)"'), 'English main UI');
    const sidebarTranslation = await main.eval(`(() => {
      const menu=document.getElementById('workspaceFilterMenu'); menu.open=true;
      const text=menu.textContent;
      const search=document.getElementById('workspaceSearchInput').placeholder;
      const labels=[...menu.querySelectorAll('[title],[aria-label]')].flatMap(el=>[el.title,el.getAttribute('aria-label')]);
      menu.open=false;
      return {search,english:text.includes('Favorites only')&&text.includes('Recently used'),korean:/[가-힣]/.test(text+labels.join(''))};
    })()`);
    assert.deepEqual(sidebarTranslation, {search:'Search workspaces',english:true,korean:false});
    if (process.env.WINCMUX_CAPTURE_TOOLBAR === '1') {
      const screenshot = await main.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const output = path.join(root, 'artifacts', 'toolbar-0.2.122.png');
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, Buffer.from(screenshot.data, 'base64'));
    }
    const confirmKorean = '"demo" 워크스페이스에서 터미널 2개가 실행 중입니다.\n\n정말 삭제할까요? 삭제하면 이 터미널과 하위 작업도 종료됩니다. 폴더의 파일은 삭제되지 않습니다.';
    assert.equal(await main.eval(`window.wincmuxI18n.t(${JSON.stringify(confirmKorean)})`), '2 terminals are running in workspace "demo".\n\nDelete it anyway? This also ends those terminals and their child tasks. Files in the folder will remain.');
    assert.equal(await main.eval('document.getElementById("i18n-terminal-fixture").textContent'), '워크스페이스');
    assert.equal(await main.eval('localStorage.getItem("wincmux.ui.language")'), 'en');
    await main.eval('window.__TAURI__.core.invoke("open_docker_workspace")');
    const page = await until(async () => {
      const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      return tabs.find(tab => tab.type === 'page' && tab.url.includes('ssh-workspace.html') && tab.webSocketDebuggerUrl);
    }, 'Docker language UI');
    remote = await connectPage(page.webSocketDebuggerUrl);
    await until(() => remote.eval('window.wincmuxI18n?.language === "en" && document.getElementById("workspaceTitle")?.textContent === "Local Docker"').catch(() => false), 'English Docker UI');
    assert.equal(await remote.eval('Boolean(document.querySelector("#terminalRendererDialog [data-ui-language]"))'), true);
    assert.equal(await remote.eval(`(() => {const badge=document.getElementById('workspaceAlertCount');badge.textContent='7';badge.hidden=false;const button=document.getElementById('workspaceAlerts').getBoundingClientRect();const count=badge.getBoundingClientRect();badge.hidden=true;badge.textContent='';return button.width>=44&&count.left>=button.left&&count.right<=button.right})()`), true, 'remote alert count stays inside its button');
    assert.equal(await remote.eval(`['terminalRendererSettingsBtn','disconnect','equalizeRemotePanes'].every(id => { const button=document.getElementById(id); return Boolean(button.querySelector('svg') && button.title && button.getAttribute('aria-label') && !button.textContent.trim()); })`), true);
    await remote.eval(`(() => { const select=document.querySelector('#terminalRendererDialog [data-ui-language]'); select.value='ko'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await until(() => main.eval('window.wincmuxI18n.language === "ko" && document.querySelector(".panel-left h2").textContent === "워크스페이스"'), 'cross-window Korean sync');
    await remote.eval(`window.wincmuxI18n.setLanguage('en')`);
    await until(() => main.eval('window.wincmuxI18n.language === "en" && document.querySelector(".panel-left h2").textContent === "Workspaces"'), 'cross-window English sync');
    const audit = await Promise.all([main, remote].map(tab => tab.eval(`(() => [...new Set([...document.querySelectorAll('body *')].filter(el => !el.children.length && !el.closest('.xterm,pre,code') && /[가-힣]/.test(el.textContent)).map(el => el.textContent.trim()).filter(Boolean))].slice(0,40))()`)));
    console.log('English UI audit:', JSON.stringify(audit));
    assert.deepEqual(audit, [[], []]);
    const attributeAudit = await Promise.all([main, remote].map(tab => tab.eval(`(() => [...new Set([...document.querySelectorAll('[title], [aria-label], [placeholder]')].filter(el => !el.closest('.xterm,pre,code')).flatMap(el => ['title','aria-label','placeholder'].map(name => el.getAttribute(name)).filter(value => value && /[가-힣]/.test(value))))])()`)));
    console.log('English attribute audit:', JSON.stringify(attributeAudit));
    assert.deepEqual(attributeAudit, [[], []]);
    for (const id of ['terminalRendererSettingsBtn', 'shortcutHelpBtn', 'conversationBtn', 'launchSettingsBtn', 'reminderBtn', 'mcpSettingsBtn']) {
      const menu = await main.eval(`(async () => {
        document.getElementById('${id}').click();
        await new Promise(resolve => setTimeout(resolve, 250));
        const panel = [...document.querySelectorAll('dialog[open], #shortcutOverlay:not([hidden])')].at(-1);
        const result = { open: Boolean(panel), untranslated: panel ? [...new Set([...panel.querySelectorAll('*')].filter(el => !el.children.length && !el.closest('pre,code') && /[가-힣]/.test(el.textContent)).map(el => el.textContent.trim()).filter(Boolean))] : [], attributes: panel ? [...new Set([...panel.querySelectorAll('[title], [aria-label], [placeholder]')].flatMap(el => ['title','aria-label','placeholder'].map(name => el.getAttribute(name)).filter(value => value && /[가-힣]/.test(value))))] : [] };
        if (panel?.tagName === 'DIALOG') panel.close();
        else if (panel) document.getElementById('shortcutCloseBtn')?.click();
        return result;
      })()`);
      console.log('English menu audit:', id, JSON.stringify(menu));
      assert.equal(menu.open, true, id);
      assert.deepEqual(menu.untranslated, [], id);
      assert.deepEqual(menu.attributes, [], id);
    }
    const hiddenMenu = await main.eval(`(() => {
      document.getElementById('hiddenPanesBtn').click();
      const panel=document.getElementById('hiddenPanesPopover');
      const result={open:panel.classList.contains('open'),untranslated:[...new Set([...panel.querySelectorAll('*')].filter(el=>!el.children.length && /[가-힣]/.test(el.textContent)).map(el=>el.textContent.trim()))]};
      document.getElementById('hiddenPanesBtn').click();
      return result;
    })()`);
    console.log('English hidden-pane audit:', JSON.stringify(hiddenMenu));
    assert.equal(hiddenMenu.open, true);
    assert.deepEqual(hiddenMenu.untranslated, []);
    console.log('Korean/English switching, persistence, live text, and cross-window sync passed.');
  } finally {
    remote?.close();
    main?.close();
    if (child.exitCode === null) child.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
