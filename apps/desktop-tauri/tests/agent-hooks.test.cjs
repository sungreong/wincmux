const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

const exe = path.resolve(__dirname, '../src-tauri/target/release/wincmux-core.exe');
async function until(fn, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(60); }
  throw Error(`timed out: ${label}`);
}
async function connect(pipe) {
  const socket = net.createConnection(pipe).setEncoding('utf8');
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  let sequence = 0, buffer = '';
  const pending = new Map();
  socket.on('error', () => {});
  socket.on('data', data => {
    buffer += data;
    let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const packet = JSON.parse(buffer.slice(0, pos)); buffer = buffer.slice(pos + 1);
      if (packet.id && pending.has(packet.id)) { pending.get(packet.id)(packet); pending.delete(packet.id); }
    }
  });
  return { close: () => socket.destroy(), rpc: (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`RPC timeout: ${method}`)); }, 10000);
    pending.set(id, packet => { clearTimeout(timer); packet.error ? reject(Error(packet.error.message)) : resolve(packet.result); });
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  }) };
}

test('hook receipt is process-bound and follow-up submits once only after hook-confirmed completion', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-agent-'));
  const pipe = '\\\\.\\pipe\\wincmux-agent-' + randomUUID();
  const core = spawn(exe, ['--data-dir', root, '--pipe', pipe, '--no-tray'], {
    windowsHide: true, stdio: ['ignore','pipe','pipe'], env: { ...process.env, WINCMUX_TEST_CORE_EXE: exe }
  });
  let errors = '';
  let lastConnectError = '';
  core.stderr.on('data', data => { errors += data; });
  let client;
  try {
    client = await until(() => connect(pipe).catch(err => { lastConnectError = String(err); return null; }), 'core').catch(err => {
      throw Error(`${err.message}; pipe=${JSON.stringify(pipe)}; connect=${lastConnectError}; exit=${core.exitCode}; stderr=${errors}; log=${fs.existsSync(path.join(root,'core.log')) ? fs.readFileSync(path.join(root,'core.log'),'utf8') : 'none'}`);
    });
    const ws = (await client.rpc('workspace.create', { name: 'Agent fixture', path: root, backend: 'custom' })).workspace.id;
    const shell = await client.rpc('session.run', { workspace_id: ws, cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd: root });
    const sid = shell.session.session_id;
    const fixture = path.resolve(__dirname, 'agent-fixture.cjs').replaceAll("'", "''");
    const node = process.execPath.replaceAll("'", "''");
    await client.rpc('session.write', { session_id: sid, data: `& '${node}' '${fixture}'\r` });
    const tail = async () => (await client.rpc('session.tail', { session_id: sid })).output;
    await until(async () => (await tail()).includes('AGENT_FIXTURE_READY'), 'fixture');
    const signal = async event => {
      const marker = `HOOK_EXIT:${event}:0`;
      const before = (await tail()).split(marker).length - 1;
      await client.rpc('session.write', { session_id: sid, data: `#hook:${event}#` });
      await until(async () => (await tail()).split(marker).length - 1 > before, event);
    };
    const state = async () => (await client.rpc('agent.list')).items.find(item => item.session_id === sid);
    assert.equal((await state()).hook.received, false);
    await assert.rejects(client.rpc('agent.hook', { session_id: sid, token: 'wrong', provider: 'codex', event: 'Stop', hook_pid: process.pid, hook_started: 0 }), /invalid session binding/);
    await signal('SessionStart');
    await signal('UserPromptSubmit');
    assert.equal((await state()).state, 'working');
    assert.equal((await state()).source, 'hook');
    assert.equal((await state()).hook.provider, 'codex');
    assert.ok(!JSON.stringify(await state()).includes('must never reach WinCMux'));
    await client.rpc('session.write', { session_id: sid, data: '#paste-on#' });
    await until(async () => (await tail()).includes('PASTE_MODE_ON'), 'paste mode');
    const due = Math.floor(Date.now() / 1000) + 1;
    await assert.rejects(client.rpc('followup.schedule', { session_id: sid, prompt: '!echo unsafe', due_at: due }), /cannot start with/);
    const first = await client.rpc('followup.schedule', { session_id: sid, prompt: 'Follow up once', delivery_mode: 'after_completion' });
    const second = await client.rpc('followup.schedule', { session_id: sid, prompt: 'Second follow-up', due_at: due });
    assert.equal((await client.rpc('followup.list', { session_id: sid })).items.length, 2);
    await signal('PermissionRequest');
    await sleep(2300);
    let rows = (await client.rpc('followup.list')).items;
    assert.equal(rows.find(row => row.id === first.id).status, 'pending');
    assert.equal((await state()).state, 'blocked');
    await signal('Stop');
    await until(async () => (await client.rpc('followup.list')).items.find(row => row.id === first.id)?.status === 'sent', 'first delivery', 8000).catch(async err => {
      throw Error(`${err.message}; rows=${JSON.stringify((await client.rpc('followup.list')).items)}; state=${JSON.stringify(await state())}; tail=${JSON.stringify(await tail())}; log=${fs.readFileSync(path.join(root,'core.log'),'utf8')}`);
    });
    await until(async () => (await tail()).includes(`RECEIVED:${Buffer.from('Follow up once').toString('base64')}`), 'submitted prompt');
    rows = (await client.rpc('followup.list')).items;
    assert.equal(rows.find(row => row.id === second.id).status, 'pending');
    await signal('Stop');
    await sleep(2200);
    assert.equal((await client.rpc('followup.list')).items.find(row => row.id === second.id).status, 'pending');
    await signal('UserPromptSubmit');
    await signal('Stop');
    await until(async () => (await client.rpc('followup.list')).items.find(row => row.id === second.id)?.status === 'sent', 'timed delivery');
    await signal('UserPromptSubmit');
    await signal('Stop');
    const third = await client.rpc('followup.schedule', { session_id: sid, prompt: 'Wait for another completion', delivery_mode: 'after_completion' });
    await signal('Stop');
    await sleep(2200);
    assert.equal((await client.rpc('followup.list')).items.find(row => row.id === third.id).status, 'pending');
    await client.rpc('followup.pause', { id: third.id });
    assert.equal((await client.rpc('followup.list')).items.find(row => row.id === third.id).status, 'paused');
    await client.rpc('followup.resume', { id: third.id });
    await client.rpc('followup.cancel', { id: third.id });
    assert.equal((await client.rpc('followup.list')).items.find(row => row.id === third.id).status, 'cancelled');
    assert.equal((await state()).state, 'done');
    assert.equal((await tail()).split('RECEIVED:').length - 1, 2);
    const fourth = await client.rpc('followup.schedule', { session_id: sid, prompt: 'Never submit after exit', due_at: Math.floor(Date.now()/1000)+60 });
    await signal('SessionEnd');
    assert.equal((await client.rpc('followup.list')).items.find(row => row.id === fourth.id).status, 'failed');
    assert.equal((await state()).hook.active, false);
    await signal('SessionStart');
    const fifth = await client.rpc('followup.schedule', { session_id: sid, prompt: 'Never submit after process exit', due_at: Math.floor(Date.now()/1000)+60 });
    await client.rpc('session.write', { session_id: sid, data: '#exit#' });
    await until(async () => (await client.rpc('followup.list')).items.find(row => row.id === fifth.id)?.status === 'failed', 'agent process exit');
    assert.equal((await state()).hook.active, false);
    await client.rpc('session.close', { session_id: sid });
    assert.equal((await client.rpc('followup.list')).items.find(row => row.id === fourth.id).status, 'failed');
    await client.rpc('runtime.shutdown');
  } finally {
    client?.close();
    if (core.exitCode === null) core.kill();
  }
});

test('a fresh Claude composer sends a queued prompt before any completion', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-claude-start-'));
  const pipe = '\\\\.\\pipe\\wincmux-claude-start-' + randomUUID();
  const agent = path.join(root, 'claude.exe');
  fs.copyFileSync(process.execPath, agent);
  const core = spawn(exe, ['--data-dir', root, '--pipe', pipe, '--no-tray'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let client;
  try {
    client = await until(() => connect(pipe).catch(() => null), 'core');
    const ws = (await client.rpc('workspace.create', { name: 'Claude startup', path: root, backend: 'custom' })).workspace.id;
    const sid = (await client.rpc('session.run', { workspace_id: ws, cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd: root })).session.session_id;
    const script = path.resolve(__dirname, 'terminal-followup-fixture.cjs').replaceAll("'", "''");
    await client.rpc('session.write', { session_id: sid, data: `& '${agent.replaceAll("'", "''")}' '${script}' --startup-claude\r` });
    const tail = async () => (await client.rpc('session.tail', { session_id: sid })).output;
    await until(async () => (await tail()).includes('Claude Code v2.1.326'), 'Claude initial screen');
    const row = await client.rpc('followup.schedule', { session_id: sid, prompt: 'Hello on startup', delivery_mode: 'when_ready' });
    const status = async () => (await client.rpc('followup.list', { session_id: sid })).items.find(item => item.id === row.id)?.status;
    await until(async () => (await status()) === 'sent', 'first prompt sent without Stop', 12000).catch(async error => {
      throw Error(`${error.message}; status=${await status()}; agent=${JSON.stringify(await client.rpc('agent.list'))}; tail=${JSON.stringify(await tail())}`);
    });
    await until(async () => (await tail()).includes(`RECEIVED:${Buffer.from('Hello on startup').toString('base64')}`), 'Claude received first prompt');
    await client.rpc('session.close', { session_id: sid });
    await client.rpc('runtime.shutdown');
  } finally {
    client?.close();
    if (core.exitCode === null) core.kill();
  }
});

for (const launch of ['native', 'npm-wrapper']) {
  test(`Gemini ${launch} queues at startup and sends the next prompt after Ready`, { timeout: 45000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `wincmux-gemini-${launch}-`));
    const pipe = '\\\\.\\pipe\\wincmux-gemini-' + randomUUID();
    const fixture = path.resolve(__dirname, 'terminal-followup-fixture.cjs').replaceAll("'", "''");
    const node = process.execPath.replaceAll("'", "''");
    const agent = path.join(root, 'gemini.exe');
    let launchCommand;
    if (launch === 'native') {
      fs.copyFileSync(process.execPath, agent);
      launchCommand = `& '${agent.replaceAll("'", "''")}' '${fixture}' --startup-gemini\r`;
    } else {
      const wrapper = path.join(root, 'gemini.ps1');
      fs.writeFileSync(wrapper, `& '${node}' '${fixture}' --startup-gemini --mcp-child\n`);
      launchCommand = `& '${wrapper.replaceAll("'", "''")}'\r`;
    }
    const core = spawn(exe, ['--data-dir', root, '--pipe', pipe, '--no-tray'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let client;
    try {
      client = await until(() => connect(pipe).catch(() => null), 'core');
      const ws = (await client.rpc('workspace.create', { name: 'Gemini fixture', path: root, backend: 'custom' })).workspace.id;
      const sid = (await client.rpc('session.run', { workspace_id: ws, cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd: root })).session.session_id;
      await client.rpc('session.write', { session_id: sid, data: launchCommand });
      const tail = async () => (await client.rpc('session.tail', { session_id: sid })).output;
      const state = async () => (await client.rpc('agent.list')).items.find(item => item.session_id === sid);
      const status = async id => (await client.rpc('followup.list', { session_id: sid })).items.find(item => item.id === id)?.status;
      await until(async () => (await tail()).includes('Type your message or @path/to/file'), 'Gemini composer');
      if (launch === 'npm-wrapper') await until(async () => (await tail()).includes('MCP_CHILD_READY'), 'nested MCP process');
      const first = await client.rpc('followup.schedule', { session_id: sid, prompt: 'Gemini first', delivery_mode: 'when_ready' });
      await until(async () => (await status(first.id)) === 'sent', 'Gemini startup delivery', 12000).catch(async error => {
        throw Error(`${error.message}; state=${JSON.stringify(await state())}; tail=${JSON.stringify(await tail())}`);
      });
      await until(async () => (await tail()).includes(`RECEIVED:${Buffer.from('Gemini first').toString('base64')}`), 'first Gemini prompt');
      const second = await client.rpc('followup.schedule', { session_id: sid, prompt: 'Gemini second', delivery_mode: 'after_completion' });
      await sleep(2200);
      assert.equal(await status(second.id), 'pending', 'Working title must hold the next prompt');
      await client.rpc('session.write', { session_id: sid, data: '#finish##draft#' });
      await until(async () => (await state()).terminal_completed_count > 0, 'Gemini Ready transition');
      await until(async () => (await status(second.id)) === 'sent', 'Gemini sends after completion', 12000).catch(async error => {
        throw Error(`${error.message}; state=${JSON.stringify(await state())}; tail=${JSON.stringify(await tail())}`);
      });
      await until(async () => (await tail()).includes(`RECEIVED:${Buffer.from('Gemini second').toString('base64')}`), 'second Gemini prompt');
      await client.rpc('session.close', { session_id: sid });
      await client.rpc('runtime.shutdown');
    } finally {
      client?.close();
      if (core.exitCode === null) core.kill();
    }
  });
}

test('a running Codex terminal accepts a follow-up without hook setup and submits after readiness', { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-terminal-followup-'));
  const pipe = '\\\\.\\pipe\\wincmux-terminal-followup-' + randomUUID();
  const agent = path.join(root, 'codex.exe');
  fs.copyFileSync(process.execPath, agent);
  const core = spawn(exe, ['--data-dir', root, '--pipe', pipe, '--no-tray'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let client;
  let stderr = '';
  core.stderr.on('data', chunk => { stderr += chunk; });
  try {
    client = await until(() => connect(pipe).catch(() => null), 'core');
    const ws = (await client.rpc('workspace.create', { name: 'No-hook follow-up', path: root, backend: 'custom' })).workspace.id;
    const sid = (await client.rpc('session.run', { workspace_id: ws, cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd: root })).session.session_id;
    const script = path.resolve(__dirname, 'terminal-followup-fixture.cjs').replaceAll("'", "''");
    await client.rpc('session.write', { session_id: sid, data: `& '${agent.replaceAll("'", "''")}' '${script}'\r` });
    const tail = async () => (await client.rpc('session.tail', { session_id: sid })).output;
    await until(async () => (await tail()).includes('Codex task running'), 'agent started');
    const state = async () => (await client.rpc('agent.list')).items.find(item => item.session_id === sid);
    assert.equal((await state()).hook.received, false);
    const followup = await client.rpc('followup.schedule', { session_id: sid, prompt: 'No hook needed', delivery_mode: 'after_completion' }).catch(error => { throw Error(`native schedule: ${error}; log=${fs.readFileSync(path.join(root, 'core.log'), 'utf8')}`); });
    const row = async () => (await client.rpc('followup.list', { session_id: sid })).items.find(item => item.id === followup.id);
    assert.equal((await row()).provider, 'terminal');
    await sleep(2200);
    assert.equal((await row()).status, 'pending', 'working task must not receive the prompt');
    await client.rpc('session.write', { session_id: sid, data: '#finish#' });
    await until(async () => (await state()).terminal_completed_count > 0, 'redrawn Codex completion');
    await client.rpc('session.write', { session_id: sid, data: '#draft#' });
    await until(async () => (await state()).terminal_prompt_visible && !(await state()).terminal_prompt_empty, 'CLI draft visible');
    await until(async () => (await row()).status === 'sent', 'follow-up clears Codex draft and submits', 10000).catch(async error => {
      throw Error(`${error.message}; row=${JSON.stringify(await row())}; state=${JSON.stringify(await state())}; tail=${JSON.stringify(await tail())}; stderr=${stderr}; log=${fs.readFileSync(path.join(root, 'core.log'), 'utf8')}`);
    });
    await until(async () => (await tail()).includes(`RECEIVED:${Buffer.from('No hook needed').toString('base64')}`), 'prompt submitted');
    await client.rpc('session.write', { session_id: sid, data: '#finish#' });
    await until(async () => (await state()).terminal_ready === true, 'agent ready for immediate delivery', 10000);
    const immediate = await client.rpc('followup.schedule', { session_id: sid, prompt: 'Send while idle', delivery_mode: 'when_ready' });
    await until(async () => (await client.rpc('followup.list', { session_id: sid })).items.find(item => item.id === immediate.id)?.status === 'sent', 'idle agent immediate submission', 10000);
    await until(async () => (await tail()).includes(`RECEIVED:${Buffer.from('Send while idle').toString('base64')}`), 'immediate prompt submitted');
    const future = await client.rpc('followup.schedule', { session_id: sid, prompt: 'Do not send after exit', due_at: Math.floor(Date.now()/1000)+60 }).catch(error => { throw Error(`future schedule: ${error}; log=${fs.readFileSync(path.join(root, 'core.log'), 'utf8')}`); });
    await client.rpc('session.write', { session_id: sid, data: '#exit#' });
    await until(async () => (await client.rpc('followup.list', { session_id: sid })).items.find(item => item.id === future.id)?.status === 'failed', 'agent exit cancels future delivery');
    await client.rpc('session.close', { session_id: sid });
    const nodeSession = (await client.rpc('session.run', { workspace_id: ws, cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd: root })).session.session_id;
    await client.rpc('session.write', { session_id: nodeSession, data: `& '${process.execPath.replaceAll("'", "''")}' '${script}'\r` });
    const nodeTail = async () => (await client.rpc('session.tail', { session_id: nodeSession })).output;
    await until(async () => (await nodeTail()).includes('Codex task running'), 'Node-launched agent started');
    const nodeFollowup = await client.rpc('followup.schedule', { session_id: nodeSession, prompt: 'Node agent follow-up', delivery_mode: 'after_completion' }).catch(error => { throw Error(`node schedule: ${error}; log=${fs.readFileSync(path.join(root, 'core.log'), 'utf8')}`); });
    await client.rpc('session.write', { session_id: nodeSession, data: '#finish#' });
    await until(async () => (await client.rpc('followup.list', { session_id: nodeSession })).items.find(item => item.id === nodeFollowup.id)?.status === 'sent', 'Node-launched agent follow-up', 10000).catch(async error => {
      throw Error(`${error.message}; row=${JSON.stringify((await client.rpc('followup.list', { session_id: nodeSession })).items.find(item => item.id === nodeFollowup.id))}; state=${JSON.stringify((await client.rpc('agent.list')).items.find(item => item.session_id === nodeSession))}; tail=${JSON.stringify(await nodeTail())}; log=${fs.readFileSync(path.join(root, 'core.log'), 'utf8')}`);
    });
    await until(async () => (await nodeTail()).includes(`RECEIVED:${Buffer.from('Node agent follow-up').toString('base64')}`), 'Node agent prompt submitted');
    await client.rpc('session.close', { session_id: nodeSession });
    await client.rpc('runtime.shutdown');
  } finally {
    client?.close();
    if (core.exitCode === null) core.kill();
  }
});
