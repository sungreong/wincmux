const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

test('MCP tools inspect and submit to an isolated real WinCMux PTY', { timeout: 30000 }, async () => {
  const pipe = '\\\\.\\pipe\\wincmux-mcp-live-' + randomUUID();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-mcp-live-'));
  process.env.WINCMUX_TAURI_PIPE = pipe;
  const { callTool, coreCall } = require('./server.cjs');
  const exe = path.resolve(__dirname, '../../apps/desktop-tauri/src-tauri/target/release/wincmux-core.exe');
  const child = spawn(exe, ['--data-dir', root, '--pipe', pipe, '--no-tray'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let sid;
  let stream;
  const events = [];
  async function until(fn, label, ms = 12000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const result = await fn();
      if (result) return result;
      await sleep(60);
    }
    throw Error(`timed out: ${label}`);
  }
  try {
    await until(() => callTool('wincmux_status').catch(() => null), 'core startup');
    stream = net.createConnection(pipe);
    await once(stream, 'connect');
    stream.setEncoding('utf8');
    let streamBuffer = '';
    stream.on('data', chunk => {
      streamBuffer += chunk;
      let end;
      while ((end = streamBuffer.indexOf('\n')) >= 0) {
        events.push(JSON.parse(streamBuffer.slice(0, end)));
        streamBuffer = streamBuffer.slice(end + 1);
      }
    });
    stream.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'session.stream.subscribe',
      params: { topics: ['session'] } }) + '\n');
    await until(() => events.some(event => event.id === 99), 'stream subscription');
    const ws = (await callTool('wincmux_create_workspace', { name: 'MCP test', path: root })).workspace.id;
    const initialPane = (await callTool('wincmux_list_terminals', { workspace_id: ws })).workspaces[0].panes[0].pane_id;
    const group = (await callTool('wincmux_create_group', { workspace_id: ws, name: 'Test agents' })).group;
    await until(() => events.some(event => event.method === 'workspace.structure_changed' && event.params.change === 'group.create' && event.params.workspace_id === ws), 'group refresh event');
    assert.equal((await callTool('wincmux_list_groups', { workspace_id: ws })).groups.some(item => item.id === group.id), true);
    const panes = await callTool('wincmux_split_pane', { workspace_id: ws, pane_id: initialPane, direction: 'vertical' });
    await until(() => events.some(event => event.method === 'workspace.structure_changed' && event.params.change === 'layout.split' && event.params.pane_ids?.[1] === panes.second_pane_id), 'pane refresh event');
    await assert.rejects(callTool('wincmux_start_terminal', { workspace_id: ws, pane_id: panes.second_pane_id, group_id: 'missing' }), /group_id not found/);
    const groupedShell = await callTool('wincmux_start_terminal', { workspace_id: ws, pane_id: panes.second_pane_id, group_id: group.id });
    const groupedList = (await callTool('wincmux_list_terminals', { workspace_id: ws })).workspaces[0];
    assert.equal(groupedList.panes.find(pane => pane.pane_id === panes.second_pane_id).session_id, groupedShell.session_id);
    assert.equal(groupedList.panes.find(pane => pane.pane_id === panes.second_pane_id).group_name, 'Test agents');
    await assert.rejects(callTool('wincmux_start_terminal', { workspace_id: ws, pane_id: panes.second_pane_id }), /already has a running terminal/);
    const defaultGroup = (await callTool('wincmux_list_groups', { workspace_id: ws })).groups.find(item => item.name === 'Default');
    await callTool('wincmux_move_terminal_to_group', { workspace_id: ws, session_id: groupedShell.session_id, group_id: defaultGroup.id });
    assert.equal((await callTool('wincmux_list_terminals', { workspace_id: ws })).workspaces[0].panes.find(pane => pane.pane_id === panes.second_pane_id).group_id, defaultGroup.id);
    await callTool('wincmux_close_terminal', { session_id: groupedShell.session_id });
    const shell = await callTool('wincmux_start_terminal', { workspace_id: ws });
    assert.ok(shell.session_id);
    await callTool('wincmux_close_terminal', { session_id: shell.session_id });
    const source = `process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
let pending='';process.stdout.write('\\x1b[?2004hREADY\\r\\n> ');
process.stdin.on('data',data=>{pending+=data;const at=pending.indexOf('\\r');if(at<0)return;
const value=pending.slice(0,at).replace(/\\x1b\\[200~|\\x1b\\[201~/g,'');pending=pending.slice(at+1);
process.stdout.write('\\r\\nRECEIVED:'+value+'\\r\\n> ');});`;
    sid = (await coreCall('session.run', { workspace_id: ws, cmd: process.execPath, args: ['-e', source], cwd: root })).session.session_id;
    await until(async () => (await callTool('wincmux_read_terminal', { session_id: sid })).screen?.lines.some(line => line.includes('READY')), 'screen text');
    const terminals = await callTool('wincmux_list_terminals', { workspace_id: ws });
    assert.ok(terminals.workspaces[0].sessions.some(session => session.session_id === sid));
    await coreCall('mcp.settings.save', { enabled: false });
    assert.equal((await callTool('wincmux_status')).mcp_enabled, false);
    await assert.rejects(callTool('wincmux_read_terminal', { session_id: sid }), /turned off/);
    await coreCall('mcp.settings.save', { enabled: true });
    await callTool('wincmux_terminal_input', { session_id: sid, text: 'Hello MCP', enter: true });
    await until(async () => (await callTool('wincmux_read_terminal', { session_id: sid })).screen?.lines.some(line => line.includes('RECEIVED:Hello MCP')), 'terminal input');
    await callTool('wincmux_press_key', { session_id: sid, key: 'enter' });
    assert.equal((await callTool('wincmux_read_terminal', { session_id: sid })).screen.bracketed_paste, true);
    const activity = (await coreCall('mcp.activity.list')).items;
    assert.ok(activity.some(item => item.tool === 'wincmux_read_terminal' && item.outcome === 'blocked'));
    assert.ok(activity.some(item => item.tool === 'wincmux_terminal_input' && item.outcome === 'success'));
  } finally {
    stream?.destroy();
    if (sid) await callTool('wincmux_close_terminal', { session_id: sid }).catch(() => {});
    await coreCall('runtime.shutdown').catch(() => {});
    if (child.exitCode === null) child.kill();
  }
});
