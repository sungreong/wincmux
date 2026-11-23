// Exercise workspace hook registration and PTY delivery in an isolated Docker container.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

const container = process.env.WINCMUX_HOOK_TEST_CONTAINER;
if (!container) throw Error('WINCMUX_HOOK_TEST_CONTAINER is required');
const docker = (args, input) => execFileSync('docker', ['exec', ...args], { input, encoding:'utf8' });

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-remote-hooks-'));
  const port = await portNumber();
  const executable = process.env.WINCMUX_HOOK_TEST_EXE || path.join(root, 'apps/desktop-tauri/src-tauri/target/debug/wincmux-tauri.exe');
  docker([container, 'sh', '-c', 'mkdir -p /tmp/wincmux-project/.claude /tmp/wincmux-home/.local/bin']);
  docker(['-i', container, 'sh', '-c', 'cat > /tmp/wincmux-project/.claude/settings.local.json'], JSON.stringify({
    permissions:{allow:['Bash(ls)']}, hooks:{Stop:[{hooks:[{type:'command',command:'echo existing'}]}]}
  }));
  const mock = `#!/bin/sh
python3 - <<'PY'
import json, os, subprocess, time
with open('.claude/settings.local.json', encoding='utf-8') as source:
    hooks = json.load(source)['hooks']
for event in ('SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop'):
    subprocess.run(hooks[event][-1]['hooks'][-1]['command'], shell=True, check=True)
    time.sleep(.35)
time.sleep(5)
PY
`;
  docker(['-i', container, 'sh', '-c', 'cat > /tmp/wincmux-home/.local/bin/claude && chmod +x /tmp/wincmux-home/.local/bin/claude'], mock);
  const child = spawn(executable, ['--benchmark-hidden'], { windowsHide:true, stdio:'ignore', env:{
    ...process.env, WINCMUX_TAURI_DATA_DIR:path.join(temp,'data'),
    WINCMUX_TAURI_PIPE:'\\\\.\\pipe\\wincmux-remote-hooks-' + randomUUID(),
    WEBVIEW2_USER_DATA_FOLDER:path.join(temp,'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`
  }});
  let main, page;
  try {
    main = await connect(port, child);
    await until(() => main.eval('typeof window.wincmuxTerminalLinks === "object"').catch(() => false), 'main page').catch(async error => {
      throw Error(`${error}; page=${JSON.stringify(await main.eval('({url:location.href,ready:document.readyState,title:document.title,body:document.body?.textContent?.slice(0,160),links:typeof window.wincmuxTerminalLinks})').catch(e => String(e)))}`);
    });
    await main.eval('window.__TAURI__.core.invoke("open_docker_workspace")');
    page = await connect(port, child, target => target.url.includes('ssh-workspace.html'));
    await until(() => page.eval('document.readyState === "complete" && !!document.getElementById("container")').catch(() => false), 'Docker page');
    await until(() => page.eval(`!![...document.getElementById('container').options].find(o => o.value === '${container}')`).catch(() => false), 'test container in picker');
    await page.eval(`(() => {const choice=document.getElementById('container'); choice.value='${container}'; choice.dispatchEvent(new Event('change',{bubbles:true})); document.getElementById('directory').value='/tmp/wincmux-project'; document.getElementById('targetForm').requestSubmit();})()`);
    await until(() => page.eval(`document.getElementById('environmentTabs').textContent.includes('/tmp/wincmux-project')`), 'Docker project opened');
    await until(() => page.eval(`!document.getElementById('newClaude').disabled && document.querySelectorAll('.pane').length > 0`), 'Docker shell ready');
    const before = await page.eval(`window.__TAURI__.core.invoke('ssh_workspace',{action:'hooks-status',params:{provider:'claude'}})`);
    assert.equal(before.os, 'Linux');
    assert.equal(before.registered, false);
    await page.eval(`document.getElementById('newClaude').click()`);
    await until(() => page.eval('document.getElementById("remoteHookDialog").open'), 'hook registration alert');
    await page.eval(`document.getElementById('remoteHookRegister').click()`);
    await until(() => page.eval('!document.getElementById("remoteHookDialog").open'), 'hook registration completed');
    const after = await page.eval(`window.__TAURI__.core.invoke('ssh_workspace',{action:'hooks-status',params:{provider:'claude'}})`);
    assert.equal(after.registered, true);
    assert.equal(after.events, 8);
    const repeated = await page.eval(`window.__TAURI__.core.invoke('ssh_workspace',{action:'hooks-ensure',params:{provider:'claude'}})`);
    assert.equal(repeated.changed, false);
    const settings = JSON.parse(docker([container,'cat','/tmp/wincmux-project/.claude/settings.local.json']));
    assert.deepEqual(settings.permissions.allow, ['Bash(ls)']);
    assert.equal(settings.hooks.Stop.length, 2);
    await until(() => page.eval(`[...document.querySelectorAll('.remote-agent-state')].some(e => e.title.includes('훅 수신') && e.textContent === '작업 완료')`).catch(() => false), 'received hook and task completion', 12000);
    const codex = await page.eval(`window.__TAURI__.core.invoke('ssh_workspace',{action:'hooks-ensure',params:{provider:'codex'}})`);
    assert.equal(codex.registered, true);
    assert.equal(codex.total, 6);
    docker([container, 'rm', '/tmp/wincmux-home/.local/bin/claude']);
    const fakeCurl = `#!/bin/sh
sleep 2
cat <<'INSTALL'
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/claude" <<'MOCK'
#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Claude mock 1'; exit 0; fi
exit 0
MOCK
chmod +x "$HOME/.local/bin/claude"
INSTALL
`;
    docker(['-i', container, 'sh', '-c', 'cat > /tmp/wincmux-home/.local/bin/curl && chmod +x /tmp/wincmux-home/.local/bin/curl'], fakeCurl);
    docker([container, 'sh', '-c', 'cp /tmp/wincmux-home/.local/bin/curl /usr/local/bin/curl']);
    await page.eval(`document.getElementById('newClaude').click()`);
    await until(() => page.eval('document.getElementById("agentInstallDialog").open'), 'missing Claude installer dialog');
    assert.equal(await page.eval('document.getElementById("agentInstallNow").disabled'), false, 'mock installer dependencies are available');
    await page.eval(`document.getElementById('agentInstallNow').click()`);
    await until(() => page.eval(`[...document.querySelectorAll('.pane-title strong')].some(e => e.textContent.includes('Claude Code 설치') && e.textContent.includes('초 경과'))`), 'installer elapsed time').catch(async error => {
      throw Error(`${error}; UI=${JSON.stringify(await page.eval(`({headings:[...document.querySelectorAll('.pane-title strong')].map(e=>e.textContent),status:document.getElementById('sshStatus').textContent,notice:document.getElementById('notice').textContent,dialog:document.getElementById('agentInstallDialog').open})`))}`);
    });
    await until(() => page.eval(`[...document.querySelectorAll('.pane-title strong')].some(e => e.textContent.includes('Claude Code 설치') && e.textContent.includes('완료'))`), 'installer completion', 20000);
    assert.match(docker([container, '/tmp/wincmux-home/.local/bin/claude', '--version']), /Claude mock 1/);
    docker([container, 'sh', '-c', 'mv /tmp/wincmux-project/.claude/settings.local.json /tmp/wincmux-project/.claude/settings.backup.json && ln -s settings.backup.json /tmp/wincmux-project/.claude/settings.local.json']);
    await page.eval(`document.getElementById('newClaude').click()`);
    await until(() => page.eval('document.getElementById("remoteHookDialog").open && !document.getElementById("remoteHookError").hidden'), 'hook registration error alert');
    assert.match(await page.eval('document.getElementById("remoteHookPrompt").value'), /settings\.local\.json/);
    await page.eval(`document.getElementById('remoteHookCancel').click()`);
    console.log('Docker hooks, registration error alert, and Claude install progress/completion passed.');
  } finally {
    page?.close(); main?.close(); child.kill();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
