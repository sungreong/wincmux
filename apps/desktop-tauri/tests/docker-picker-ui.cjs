// Check numbered Docker targets in the real, isolated WebView.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-docker-picker-'));
  const port = await portNumber();
  const executable = process.env.WINCMUX_DOCKER_PICKER_TEST_EXE || path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe');
  const child = spawn(executable, ['--benchmark-hidden'], {
    windowsHide: true, stdio: 'ignore', env: {
      ...process.env,
      WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-docker-picker-' + randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`
    }
  });
  let main, cdp, ssh;
  try {
    main = await connect(port, child);
    await until(() => main.eval('typeof window.wincmuxTerminalLinks === "object"').catch(() => false), 'main page loaded');
    await main.eval('window.__TAURI__.core.invoke("open_docker_workspace")');
    cdp = await connect(port, child, target => target.url.includes('ssh-workspace.html'));
    await until(() => cdp.eval('document.readyState === "complete" && !!document.getElementById("dockerAttach")').catch(() => false), 'Docker picker loaded');
    await until(() => cdp.eval('document.getElementById("container").options.length > 2').catch(() => false), 'running Docker containers', 12000).catch(async error => { throw Error(`${error.message}; ${JSON.stringify(await cdp.eval('({options:[...document.getElementById("container").options].map(o=>o.textContent),status:document.getElementById("sshStatus").textContent,notice:document.getElementById("notice").textContent})'))}`); });
    const options = await cdp.eval(`[...document.getElementById('container').options].slice(1).map(option=>({label:option.textContent,id:option.value}))`);
    assert(options.every((option, index) => option.label.startsWith(`${index + 1}. `)));
    assert.equal(await cdp.eval('getComputedStyle(document.getElementById("container")).display'), 'none');
    assert.equal(await cdp.eval('document.getElementById("dockerAttach").hidden && !document.getElementById("dockerPicker").hidden'), true, 'Docker uses one visible picker');
    await cdp.eval(`document.getElementById('dockerPicker').dispatchEvent(new KeyboardEvent('keydown',{key:'2',bubbles:true,cancelable:true}))`);
    assert.equal(await cdp.eval('document.getElementById("container").value'), options[1].id, 'number key selects the matching container');
    assert.equal(await cdp.eval('document.getElementById("dockerPickerNumber").textContent'), '2');
    assert.equal(await cdp.eval('document.getElementById("dockerPickerName").textContent'), options[1].label.slice(3));
    await cdp.eval(`document.getElementById('dockerPicker').dispatchEvent(new KeyboardEvent('keydown',{key:'/',bubbles:true,cancelable:true}))`);
    await until(() => cdp.eval('document.getElementById("dockerDialog").open && document.querySelectorAll("#dockerList button").length > 2'), 'searchable Docker choices');
    if (process.env.WINCMUX_CAPTURE_DOCKER_PICKER === '1') {
      const screenshot = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const output = path.join(root, 'artifacts', 'docker-picker-numbered.png');
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, Buffer.from(screenshot.data, 'base64'));
    }
    const numberMatch = await cdp.eval(`(() => {const input=document.getElementById('dockerFilter');input.value='3';input.dispatchEvent(new Event('input',{bubbles:true}));return [...document.querySelectorAll('#dockerList button')].map(button=>({number:button.querySelector('.docker-choice-number')?.textContent,label:button.querySelector('.docker-choice-label')?.textContent}))})()`);
    assert.equal(numberMatch.length, 1);
    assert.equal(numberMatch[0].number, '3');
    assert(numberMatch[0].label.length > 0);
    const nameMatch = await cdp.eval(`(() => {const input=document.getElementById('dockerFilter');input.value='genai';input.dispatchEvent(new Event('input',{bubbles:true}));return [...document.querySelectorAll('#dockerList button')].map(button=>({number:button.querySelector('.docker-choice-number')?.textContent,label:button.querySelector('.docker-choice-label')?.textContent}))})()`);
    assert(nameMatch.length > 0 && nameMatch.every(row => row.label.toLowerCase().includes('genai') && /^\d+$/.test(row.number)));
    await cdp.eval(`(() => {const input=document.getElementById('dockerFilter');input.value='1';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))})()`);
    await until(() => cdp.eval('document.getElementById("container").value === ' + JSON.stringify(options[0].id)), 'Enter selects numbered Docker choice');
    assert.equal(await cdp.eval('document.getElementById("dockerPickerNumber").textContent'), '1');
    await main.eval('window.__TAURI__.core.invoke("open_ssh_workspace")');
    ssh = await connect(port, child, target => target.url.includes('ssh-workspace.html') && !target.url.includes('mode=docker'));
    await until(() => ssh.eval('document.getElementById("closeEnvironmentDialog") !== null').catch(() => false), 'SSH workspace loaded');
    const closed = await ssh.eval(`window.__TAURI__.core.invoke('ssh_workspace',{action:'close-target',params:{path:'/tmp/wincmux-close-test',container:null}})`);
    assert.equal(closed.ok, true, 'SSH folder target is accepted by the close API');
    console.log('Docker picker numbered dropdown, search, and Enter selection passed.');
  } finally {
    ssh?.close();
    cdp?.close();
    main?.close();
    child.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
