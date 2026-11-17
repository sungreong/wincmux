const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

test('MCP stdio exposes workspace, terminal, input, follow-up, and capture tools', { timeout: 15000 }, async () => {
  const pipe = '\\\\.\\pipe\\wincmux-mcp-test-' + randomUUID();
  const writes = [];
  const activity = [];
  let enabled = true;
  const core = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      if (request.method === 'session.write') writes.push(request.params.data);
      if (request.method === 'mcp.activity.record') activity.push(request.params);
      const answers = {
        'mcp.settings.get': { enabled },
        'mcp.activity.record': { ok: true },
        'runtime.info': { version: '0.2.6', terminal_count: 1 },
        'workspace.list': { workspaces: [{ id: 'w1', name: 'Project', path: 'C:\\project' }] },
        'session.list': { sessions: [{ id: 's1', status: 'running', spawn_cmd: 'gemini', spawn_cwd: 'C:\\project' }] },
        'pane.session.bindings': { bindings: [{ pane_id: 'p1', session_id: 's1' }] },
        'layout.list': { panes: [{ pane_id: 'p1', split: null, is_focused: true }] },
        'agent.list': { items: [{ session_id: 's1', state: 'idle', terminal_ready: true }] },
        'session.screen_text': { lines: ['> ready'], rows: 24, cols: 80, bracketed_paste: true },
        'session.tail': { output: 'recent', end_offset: 6 },
        'session.write': { ok: true },
        'followup.schedule': { id: 'f1', status: 'pending' },
        'followup.send_now': { id: 'f1', status: 'sent' },
        'followup.list': { items: [{ id: 'f1', status: 'pending' }] },
      };
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: answers[request.method] }) + '\n');
    });
  });
  await new Promise(resolve => core.listen(pipe, resolve));
  const child = spawn(process.execPath, [path.resolve(__dirname, 'server.cjs')], {
    env: { ...process.env, WINCMUX_TAURI_PIPE: pipe }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = '', nextId = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    let at;
    while ((at = output.indexOf('\n')) >= 0) {
      const response = JSON.parse(output.slice(0, at));
      output = output.slice(at + 1);
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(Error(`timed out: ${method}`)), 5000);
    pending.set(id, response => { clearTimeout(timer); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const response = await request('tools/call', { name, arguments: args });
    if (response.result?.isError) throw Error(response.result.content[0].text);
    return response.result.structuredContent;
  };
  try {
    const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-11-25');
    const list = await request('tools/list');
    assert.ok(list.result.tools.some(tool => tool.name === 'wincmux_capture_window'));
    assert.deepEqual(list.result.tools.map(tool => tool.name), require('./tools.json').map(tool => tool.name));
    assert.equal((await call('wincmux_list_workspaces')).workspaces[0].name, 'Project');
    const terminals = await call('wincmux_list_terminals', { workspace_id: 'w1' });
    assert.equal(terminals.workspaces[0].panes[0].session_id, 's1');
    assert.equal((await call('wincmux_read_terminal', { session_id: 's1' })).screen.lines[0], '> ready');
    await call('wincmux_terminal_input', { session_id: 's1', text: 'Hello', enter: true });
    await call('wincmux_press_key', { session_id: 's1', key: 'enter' });
    assert.deepEqual(writes, ['\x1b[200~Hello\x1b[201~\r', '\r']);
    assert.equal((await call('wincmux_queue_followup', { session_id: 's1', prompt: 'Next' })).id, 'f1');
    assert.equal((await call('wincmux_list_followups', { session_id: 's1' })).items[0].status, 'pending');
    assert.equal((await call('wincmux_send_followup_now', { id: 'f1' })).status, 'sent');
    const invalid = await request('tools/call', { name: 'wincmux_terminal_input', arguments: { session_id: 's1', text: 'bad\x1b' } });
    assert.equal(invalid.result.isError, true);
    assert.equal(writes.length, 2);
    enabled = false;
    assert.equal((await call('wincmux_status')).mcp_enabled, false);
    const blocked = await request('tools/call', { name: 'wincmux_read_terminal', arguments: { session_id: 's1' } });
    assert.equal(blocked.result.isError, true);
    assert.match(blocked.result.content[0].text, /turned off/);
    assert.equal(writes.length, 2);
    assert.ok(activity.some(item => item.tool === 'wincmux_read_terminal' && item.outcome === 'blocked'));
  } finally {
    child.kill();
    await new Promise(resolve => core.close(resolve));
  }
});
