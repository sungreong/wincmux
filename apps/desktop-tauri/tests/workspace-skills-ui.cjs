const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-skills-'));
  const container = `wincmux-skill-test-${randomUUID().slice(0, 8)}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding:'utf8' });
  let child, main, page;
  try {
    docker(['run', '--rm', '-d', '--name', container, 'python:3.12-slim', 'sleep', '180']);
    docker(['exec', container, 'sh', '-c', 'mkdir -p /tmp/wincmux-skill-project/.claude/skills/format /tmp/wincmux-skill-project/.agents/skills/lint']);
    docker(['exec', '-i', container, 'sh', '-c', 'cat > /tmp/wincmux-skill-project/.claude/skills/format/SKILL.md'], '---\nname: format\ndescription: Format source files\n---\n');
    docker(['exec', '-i', container, 'sh', '-c', 'cat > /tmp/wincmux-skill-project/.agents/skills/lint/SKILL.md'], '---\nname: lint\ndescription: Check lint rules\n---\n');
    const port = await portNumber();
    child = spawn(path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'), ['--benchmark-hidden'], {
      windowsHide:true, stdio:'ignore', env:{ ...process.env,
        WINCMUX_TAURI_DATA_DIR:path.join(temp,'data'),
        WINCMUX_TAURI_PIPE:'\\\\.\\pipe\\wincmux-skills-' + randomUUID(),
        WEBVIEW2_USER_DATA_FOLDER:path.join(temp,'webview'),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`
      }
    });
    main = await connect(port, child);
    await until(() => main.eval('typeof state!=="undefined" && state.bootstrapReady===true'), 'main app');
    await main.eval('window.__TAURI__.core.invoke("open_docker_workspace")');
    page = await connect(port, child, target => target.url.includes('ssh-workspace.html'));
    await until(() => page.eval(`[...document.getElementById('container').options].some(option=>option.textContent.includes('${container}'))`).catch(() => false), 'test container');
    await page.eval(`(() => { const select=document.getElementById('container'); select.value=[...select.options].find(option=>option.textContent.includes('${container}')).value; select.dispatchEvent(new Event('change',{bubbles:true})); document.getElementById('directory').value='/tmp/wincmux-skill-project'; document.getElementById('openTarget').click(); })()`);
    await until(() => page.eval('!document.getElementById("workArea").hidden').catch(() => false), 'Docker workspace');
    const sidebar = await page.eval(`(() => {
      const area=document.getElementById('workArea').getBoundingClientRect();
      const side=document.getElementById('workspaceSidebar').getBoundingClientRect();
      const context=document.getElementById('workspaceContext');
      return { beside:Math.abs(area.top-side.top)<4, context:context.textContent, sideWidth:side.width };
    })()`);
    assert.equal(sidebar.beside && sidebar.context.includes('/tmp/wincmux-skill-project') && sidebar.sideWidth > 200, true);
    const capture = async name => {
      if (process.env.WINCMUX_CAPTURE_REMOTE_LAYOUT !== '1') return;
      const screenshot = await page.request('Page.captureScreenshot', { format:'png', fromSurface:true });
      const folder = path.join(root, 'artifacts');
      fs.mkdirSync(folder, { recursive:true });
      fs.writeFileSync(path.join(folder, name), Buffer.from(screenshot.data, 'base64'));
    };
    await capture('docker-sidebar-expanded-0.2.138.png');
    const expandedWidth = await page.eval(`document.getElementById('workArea').getBoundingClientRect().width`);
    await page.eval(`document.getElementById('workspaceSidebarToggle').click()`);
    assert.equal(await page.eval(`document.getElementById('workspaceSidebar').hidden`), true);
    assert.equal(await page.eval(`document.getElementById('workArea').getBoundingClientRect().width > ${expandedWidth}`), true);
    await capture('docker-sidebar-collapsed-0.2.138.png');
    await page.eval(`document.getElementById('workspaceSidebarToggle').click()`);
    await page.request('Emulation.setDeviceMetricsOverride', { width:700, height:740, deviceScaleFactor:1, mobile:false });
    assert.equal(await page.eval(`(() => {
      const side=document.getElementById('workspaceSidebar');
      return getComputedStyle(side).position==='absolute' && document.getElementById('workArea').getBoundingClientRect().width>650;
    })()`), true, 'narrow window keeps the terminal width while the sidebar overlays it');
    await page.request('Emulation.clearDeviceMetricsOverride');
    const codex = await page.eval(`window.__TAURI__.core.invoke('ssh_workspace',{action:'agent-skills',params:{provider:'codex'}})`);
    const claude = await page.eval(`window.__TAURI__.core.invoke('ssh_workspace',{action:'agent-skills',params:{provider:'claude'}})`);
    assert.equal(codex.items.find(item => item.command === '$lint')?.description, 'Check lint rules');
    assert.equal(claude.items.find(item => item.command === '/format')?.description, 'Format source files');
    await page.eval(`document.getElementById('terminalRendererSettingsBtn').click(); document.getElementById('agentCommandManagerBtn').click()`);
    await until(() => page.eval(`[...document.querySelectorAll('.agent-command-manager option')].some(option=>option.value==='$lint')`).catch(() => false), 'Codex skill option');
    assert.deepEqual(await page.eval(`(() => {
      const dialog=document.querySelector('.agent-command-manager');
      const select=dialog.querySelectorAll('.agent-command-row select')[2];
      select.value='$lint'; select.dispatchEvent(new Event('change',{bubbles:true}));
      return {input:dialog.querySelector('label textarea').value,mode:dialog.querySelectorAll('.agent-command-row select')[1].value};
    })()`), { input:'$lint', mode:'command' });
    await page.eval(`(() => { const provider=document.querySelector('.agent-command-manager .agent-command-row select'); provider.value='claude'; provider.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await until(() => page.eval(`[...document.querySelectorAll('.agent-command-manager option')].some(option=>option.value==='/format')`).catch(() => false), 'Claude skill option');
    assert.equal(await page.eval(`(() => {
      const dialog=document.querySelector('.agent-command-manager');
      const select=dialog.querySelectorAll('.agent-command-row select')[2];
      select.value='/format'; select.dispatchEvent(new Event('change',{bubbles:true}));
      return dialog.querySelector('label textarea').value;
    })()`), '/format');
    await page.eval(`document.querySelector('.agent-command-manager').close(); document.getElementById('newTerminal').click()`);
    await until(() => page.eval(`document.querySelectorAll('.pane-group-root:not([hidden]) .pane').length===2`), 'second Docker terminal');
    assert.equal(await page.eval(`(() => {
      const panes=[...document.querySelectorAll('.pane-group-root:not([hidden]) .pane')];
      panes[0].querySelector('[data-action=movePane]').click();
      if (!panes[0].classList.contains('pane-move-source')) return false;
      const rect=panes[1].getBoundingClientRect();
      panes[1].dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:rect.left+rect.width/2,clientY:rect.top+3}));
      if (!panes[1].classList.contains('pane-drop-up')) return false;
      panes[1].dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:rect.left+rect.width/2,clientY:rect.top+3}));
      return document.querySelector('.pane-split[data-direction=down]')!==null && !document.querySelector('.pane-move-source');
    })()`), true, 'remote pane moves by clicking a target edge');
    assert.equal(await page.eval(`(() => {
      const source=document.querySelector('.pane-group-root:not([hidden]) .pane');
      source.querySelector('[data-action=movePane]').click();
      document.querySelector('#paneGroupTabs > button:last-child').click();
      return document.querySelectorAll('#paneGroupTabs .pane-group-tab').length===2
        && document.querySelector('.pane-group-root:not([hidden])').contains(source)
        && !document.querySelector('.pane-move-source');
    })()`), true, 'remote pane moves into a new group');
    console.log('Docker workspace skill discovery and per-agent UI passed.');
  } finally {
    page?.close(); main?.close();
    if (child?.pid) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio:'ignore' }); } catch {} }
    try { docker(['rm', '-f', container]); } catch {}
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
