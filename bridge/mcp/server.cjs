#!/usr/bin/env node
// Local MCP adapter for WinCMux's per-user named-pipe RPC. No HTTP listener.
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');

let version = '0.2.134';
try { version = require('../../package.json').version; } catch { /* Bundled resource has no package.json. */ }
const pipe = process.env.WINCMUX_TAURI_PIPE || '\\\\.\\pipe\\wincmux-tauri-rpc';
const OBJECT = { type: 'object', additionalProperties: false };
const required = (properties, names) => ({ ...OBJECT, properties, required: names });
const sid = { type: 'string', description: 'session_id returned by wincmux_list_terminals' };
const wid = { type: 'string', description: 'Workspace ID returned by wincmux_list_workspaces' };
const workspaceText = { type: 'string', description: 'Exact workspace name or folder path supplied by the user; duplicate names are rejected' };
const workspaceSelector = { workspace_id: wid, workspace: workspaceText };
const tool = (name, description, inputSchema, readOnlyHint) => ({
  name, description, inputSchema, annotations: { readOnlyHint }
});

const tools = [
  tool('wincmux_status', 'Show the running WinCMux core version and instance status.', OBJECT, true),
  tool('wincmux_list_workspaces', 'List WinCMux workspaces and their IDs and project paths.', OBJECT, true),
  tool('wincmux_create_workspace', 'Create a workspace at an explicit existing folder, or create a new folder under the configured MCP development folder when path is omitted.',
    required({ name: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 } }, ['name']), false),
  tool('wincmux_list_groups', 'List pane groups and terminal assignments in one workspace.',
    required(workspaceSelector, []), true),
  tool('wincmux_create_group', 'Create a named pane group in a workspace.',
    required({ ...workspaceSelector, name: { type: 'string', minLength: 1, maxLength: 32 }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }, ['name']), false),
  tool('wincmux_rename_group', 'Rename a non-default pane group in a workspace.',
    required({ ...workspaceSelector, group_id: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 32 } }, ['group_id', 'name']), false),
  tool('wincmux_delete_group', 'Delete a non-default pane group. Its terminals keep running and move to the selected group or Default.',
    required({ ...workspaceSelector, group_id: { type: 'string' }, move_to_group_id: { type: 'string' } }, ['group_id']), false),
  tool('wincmux_list_terminals', 'List panes and terminal sessions, including running state and agent readiness. Optionally select one workspace.',
    { ...OBJECT, properties: { workspace_id: wid, workspace: workspaceText } }, true),
  tool('wincmux_split_pane', 'Split a terminal pane horizontally or vertically. An existing terminal stays in the first child pane; use the second pane_id to start another terminal.',
    required({ ...workspaceSelector, pane_id: { type: 'string' }, direction: { type: 'string', enum: ['horizontal', 'vertical'] } }, ['pane_id', 'direction']), false),
  tool('wincmux_focus_pane', 'Select a leaf pane in a workspace.',
    required({ ...workspaceSelector, pane_id: { type: 'string' } }, ['pane_id']), false),
  tool('wincmux_move_terminal_to_group', 'Assign an existing terminal session to a pane group in the same workspace.',
    required({ ...workspaceSelector, session_id: sid, group_id: { type: 'string' } }, ['session_id', 'group_id']), false),
  tool('wincmux_read_terminal', 'Read the visible text grid of a terminal and a bounded recent raw output tail. The grid requires the updated core.',
    required({ session_id: sid, max_bytes: { type: 'integer', minimum: 1, maximum: 16000 } }, ['session_id']), true),
  tool('wincmux_start_terminal', 'Start a visible PowerShell terminal in a workspace, optionally launching Claude, Codex, or Gemini. Without pane_id, reuse an empty pane or split a pane and show the new terminal.',
    required({ workspace_id: wid, workspace: workspaceText, agent: { type: 'string', enum: ['powershell', 'claude', 'codex', 'gemini'] }, pane_id: { type: 'string' }, group_id: { type: 'string' } }, []), false),
  tool('wincmux_start_group_terminal', 'Open a visible terminal in a pane group. Reuse an empty pane or split a pane, then assign the new terminal to the requested group.',
    required({ workspace_id: wid, workspace: workspaceText, group_id: { type: 'string' }, agent: { type: 'string', enum: ['powershell', 'claude', 'codex', 'gemini'] }, direction: { type: 'string', enum: ['horizontal', 'vertical'] } }, ['group_id']), false),
  tool('wincmux_terminal_input', 'Type text directly into a running terminal. Set enter=true to press Enter in the same write. This sends immediately, including while an agent is busy; use wincmux_queue_followup to wait.',
    required({ session_id: sid, text: { type: 'string', maxLength: 16000 }, enter: { type: 'boolean' } }, ['session_id', 'text']), false),
  tool('wincmux_press_key', 'Press Enter, Escape, Tab, Ctrl+C, or an arrow in a running terminal.',
    required({ session_id: sid, key: { type: 'string', enum: ['enter', 'escape', 'tab', 'ctrl_c', 'up', 'down', 'left', 'right'] } }, ['session_id', 'key']), false),
  tool('wincmux_close_terminal', 'Close one specified terminal session. This ends its running process and any pending follow-ups.',
    required({ session_id: sid }, ['session_id']), false),
  tool('wincmux_queue_followup', 'Queue a prompt for a specific running Claude, Codex, or Gemini terminal. when_ready sends as soon as the CLI accepts input; after_completion waits for a new completed turn.',
    required({ session_id: sid, prompt: { type: 'string', minLength: 1, maxLength: 16000 }, delivery_mode: { type: 'string', enum: ['when_ready', 'after_completion', 'at_time'] }, due_at: { type: 'integer' } }, ['session_id', 'prompt']), false),
  tool('wincmux_send_followup_now', 'Submit one pending or paused follow-up to its bound terminal immediately, without waiting for readiness or scheduled time. The agent may process it later.',
    required({ id: { type: 'string', description: 'Follow-up ID from wincmux_list_followups' } }, ['id']), false),
  tool('wincmux_list_followups', 'List queued and recently sent follow-up prompts, optionally for one terminal.',
    { ...OBJECT, properties: { session_id: sid, ...workspaceSelector } }, true),
  tool('wincmux_capture_window', 'Capture the visible WinCMux application window as PNG. The image data is Base64 in MCP image.data or in the base64 JSON response. The window must be restored.',
    { ...OBJECT, properties: { format: { type: 'string', enum: ['image', 'base64'] }, pid: { type: 'integer', minimum: 1 } } }, true),
];

function string(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${name} is required`);
  return value;
}
const workspacePathKey = value => path.resolve(value).replace(/^\\\\\?\\/, '').toLocaleLowerCase();
async function resolveWorkspace(args) {
  if (!args.workspace_id && !args.workspace) throw Error('workspace_id or workspace name/path is required');
  const workspaces = (await coreCall('workspace.list')).workspaces;
  const query = String(args.workspace_id ?? args.workspace).trim().toLocaleLowerCase();
  const matches = workspaces.filter(item => args.workspace_id
    ? item.id === query
    : item.name.toLocaleLowerCase() === query || workspacePathKey(item.path) === workspacePathKey(args.workspace));
  if (!matches.length) throw Error(`workspace not found: ${args.workspace_id ?? args.workspace}`);
  if (matches.length > 1) throw Error(`workspace name is ambiguous; specify its full folder path: ${args.workspace}`);
  return matches[0];
}

function coreCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let done = false, buffer = '';
    const timer = setTimeout(() => finish(Error(`WinCMux core timed out: ${method}`)), 8000);
    function finish(error, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    }
    socket.setEncoding('utf8');
    socket.on('error', error => finish(Error(`Cannot connect to WinCMux core (${pipe}): ${error.message}`)));
    socket.on('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return finish(Error('WinCMux RPC response is too large'));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, end));
        if (message.id !== 1) return finish(Error('Unexpected WinCMux RPC response'));
        if (message.error) return finish(Error(message.error.message || 'WinCMux RPC error'));
        finish(null, message.result);
      } catch (error) { finish(error); }
    });
    socket.on('end', () => finish(Error('WinCMux core closed the connection')));
  });
}

function captureExecutable() {
  const candidates = [
    process.env.WINCMUX_CAPTURE_EXE,
    path.resolve(__dirname, '../wincmux-capture.exe'),
    path.resolve(__dirname, '../../wincmux-capture.exe'),
    path.resolve(__dirname, '../../apps/desktop-tauri/src-tauri/target/release/wincmux-capture.exe'),
    path.resolve(__dirname, '../../apps/desktop-tauri/src-tauri/target/debug/wincmux-capture.exe'),
  ];
  const executable = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!executable) throw Error('wincmux-capture.exe is missing; build the WinCMux runtime or set WINCMUX_CAPTURE_EXE');
  return executable;
}

function captureWindow(args) {
  return new Promise((resolve, reject) => {
    const command = args.pid === undefined ? [] : ['--pid', String(args.pid)];
    execFile(captureExecutable(), command, { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(Error((stderr || error.message).trim()));
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
  });
}

async function dispatchTool(name, args = {}) {
  if (!args || Array.isArray(args) || typeof args !== 'object') throw Error('arguments must be an object');
  let settings;
  try { settings = await coreCall('mcp.settings.get'); }
  catch (error) {
    if (!/method not found/i.test(error.message)) throw error;
    settings = { enabled: true, legacy_core: true };
  }
  if (!settings.enabled && name !== 'wincmux_status') throw Error('WinCMux MCP is turned off in the app settings');
  switch (name) {
    case 'wincmux_status': return settings.enabled
      ? { ...(await coreCall('runtime.info')), mcp_enabled: true, development_folder: settings.development_folder ?? null }
      : { mcp_enabled: false, transport: 'stdio' };
    case 'wincmux_list_workspaces': return coreCall('workspace.list');
    case 'wincmux_create_workspace': {
      const name = string(args.name, 'name').trim();
      let folder = args.path;
      if (folder === undefined) {
        if (!settings.development_folder) throw Error('configure the MCP development folder in the updated WinCMux app');
        if (name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name))
          throw Error('name cannot be used as a folder name');
        const root = path.resolve(settings.development_folder);
        folder = path.resolve(root, name);
        if (path.dirname(folder).toLocaleLowerCase() !== root.toLocaleLowerCase()) throw Error('folder must stay inside the MCP development folder');
        fs.mkdirSync(folder, { recursive: true });
      } else {
        folder = string(folder, 'path');
      }
      const existing = (await coreCall('workspace.list')).workspaces.find(item => workspacePathKey(item.path) === workspacePathKey(folder));
      if (existing) return { workspace: existing, reused: true };
      return coreCall('workspace.create', { name, path: folder, backend: 'custom' });
    }
    case 'wincmux_list_groups': {
      const workspace = await resolveWorkspace(args);
      const workspace_id = workspace.id;
      const [groups, assignments] = await Promise.all([
        coreCall('group.list', { workspace_id }), coreCall('session.group.list', { workspace_id })
      ]);
      return { workspace_id, workspace_name: workspace.name, groups: groups.groups, assignments: assignments.bindings };
    }
    case 'wincmux_create_group': {
      const workspace = await resolveWorkspace(args);
      const workspace_id = workspace.id;
      const name = string(args.name, 'name').trim();
      if (name.length > 32) throw Error('name must be at most 32 characters');
      if (args.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(args.color)) throw Error('color must be #RRGGBB');
      return { ...(await coreCall('group.create', { workspace_id, name, ...(args.color ? { color: args.color } : {}) })), workspace_id, workspace_name: workspace.name };
    }
    case 'wincmux_rename_group':
    case 'wincmux_delete_group': {
      const workspace = await resolveWorkspace(args);
      const workspace_id = workspace.id;
      const group_id = string(args.group_id, 'group_id');
      const groups = (await coreCall('group.list', { workspace_id })).groups;
      const group = groups.find(item => item.id === group_id);
      if (!group) throw Error('group_id not found in workspace');
      if (group.name === 'Default') throw Error('Default group cannot be modified');
      if (name === 'wincmux_rename_group') {
        const newName = string(args.name, 'name').trim();
        if (newName.length > 32) throw Error('name must be at most 32 characters');
        await coreCall('group.rename', { group_id, name: newName });
        return { ok: true, workspace_id, workspace_name: workspace.name, group_id, name: newName };
      }
      if (args.move_to_group_id !== undefined &&
          (!groups.some(item => item.id === args.move_to_group_id) || args.move_to_group_id === group_id))
        throw Error('move_to_group_id must be another group in workspace');
      const move_to_group_id = args.move_to_group_id ?? groups.find(item => item.name === 'Default')?.id;
      await coreCall('group.delete', { group_id, ...(move_to_group_id ? { move_to_group_id } : {}) });
      return { ok: true, workspace_id, workspace_name: workspace.name, group_id, move_to_group_id: move_to_group_id ?? null };
    }
    case 'wincmux_list_terminals': {
      const workspaces = (await coreCall('workspace.list')).workspaces;
      const chosen = args.workspace_id || args.workspace ? [await resolveWorkspace(args)] : workspaces;
      const agents = (await coreCall('agent.list')).items;
      const result = await Promise.all(chosen.map(async workspace => {
        const [sessions, bindings, layout, groups, groupBindings] = await Promise.all([
          coreCall('session.list', { workspace_id: workspace.id }),
          coreCall('pane.session.bindings', { workspace_id: workspace.id }),
          coreCall('layout.list', { workspace_id: workspace.id }),
          coreCall('group.list', { workspace_id: workspace.id }),
          coreCall('session.group.list', { workspace_id: workspace.id }),
        ]);
        const bySession = new Map(sessions.sessions.map(session => [session.id, session]));
        const byPane = new Map(bindings.bindings.map(binding => [binding.pane_id, binding.session_id]));
        const byAgent = new Map(agents.map(agent => [agent.session_id, agent]));
        const byGroup = new Map(groups.groups.map(group => [group.id, group.name]));
        const groupBySession = new Map(groupBindings.bindings.map(binding => [binding.session_id, binding.group_id]));
        const groupFields = session => {
          const group_id = session ? groupBySession.get(session.id) ?? null : null;
          return { group_id, group_name: byGroup.get(group_id) ?? null };
        };
        return {
          workspace_id: workspace.id, workspace_name: workspace.name,
          groups: groups.groups,
          panes: layout.panes.filter(pane => typeof pane === 'string' || !pane.split).map(pane => {
            const id = typeof pane === 'string' ? pane : pane.pane_id;
            const session = bySession.get(byPane.get(id));
            return { pane_id: id, workspace_name: workspace.name, is_focused: pane.is_focused === true,
              session_id: session?.id ?? null, status: session?.status ?? 'empty',
              command: session?.spawn_cmd ?? null, agent: session ? byAgent.get(session.id) ?? null : null,
              ...groupFields(session) };
          }),
          sessions: sessions.sessions.filter(session => session.status === 'running').map(session => ({
            session_id: session.id, workspace_name: workspace.name, command: session.spawn_cmd, cwd: session.spawn_cwd,
            agent: byAgent.get(session.id) ?? null, ...groupFields(session),
          })),
        };
      }));
      return { workspaces: result };
    }
    case 'wincmux_split_pane': {
      const workspace = await resolveWorkspace(args);
      const workspace_id = workspace.id;
      const pane_id = string(args.pane_id, 'pane_id');
      if (!['horizontal', 'vertical'].includes(args.direction)) throw Error('invalid direction');
      const layout = await coreCall('layout.list', { workspace_id });
      if (!layout.panes.some(pane => pane.pane_id === pane_id && !pane.split)) throw Error('pane_id is not a terminal pane');
      const result = await coreCall('layout.split', { workspace_id, pane_id, direction: args.direction });
      return { workspace_id, workspace_name: workspace.name, original_pane_id: pane_id, first_pane_id: result.pane_ids[0], second_pane_id: result.pane_ids[1] };
    }
    case 'wincmux_focus_pane': {
      const workspace = await resolveWorkspace(args);
      const workspace_id = workspace.id;
      const pane_id = string(args.pane_id, 'pane_id');
      const layout = await coreCall('layout.list', { workspace_id });
      if (!layout.panes.some(pane => pane.pane_id === pane_id && !pane.split)) throw Error('pane_id is not a terminal pane');
      await coreCall('layout.focus', { workspace_id, pane_id });
      return { ok: true, workspace_id, workspace_name: workspace.name, pane_id };
    }
    case 'wincmux_move_terminal_to_group': {
      const workspace = await resolveWorkspace(args);
      const workspace_id = workspace.id;
      const session_id = string(args.session_id, 'session_id');
      const group_id = string(args.group_id, 'group_id');
      await coreCall('session.group.set', { workspace_id, session_id, group_id });
      return { ok: true, workspace_id, workspace_name: workspace.name, session_id, group_id };
    }
    case 'wincmux_read_terminal': {
      const session_id = string(args.session_id, 'session_id');
      const max_bytes = args.max_bytes === undefined ? 4000 : args.max_bytes;
      if (!Number.isInteger(max_bytes) || max_bytes < 1 || max_bytes > 16000) throw Error('max_bytes must be 1..16000');
      let screen = null;
      try { screen = await coreCall('session.screen_text', { session_id }); }
      catch (error) {
        if (!/unknown|unsupported|method not found/i.test(error.message)) throw error;
      }
      const tail = await coreCall('session.tail', { session_id, max_bytes });
      return { session_id, screen, recent_output: tail.output, end_offset: tail.end_offset };
    }
    case 'wincmux_start_terminal': {
      const workspace = await resolveWorkspace(args);
      const workspace_id = workspace.id;
      const agent = args.agent ?? 'powershell';
      if (!['powershell', 'claude', 'codex', 'gemini'].includes(agent)) throw Error('invalid agent');
      if (args.pane_id === undefined) {
        const groups = await coreCall('group.list', { workspace_id });
        const group_id = args.group_id ?? groups.groups.find(group => group.name === 'Default')?.id ?? groups.groups[0]?.id;
        if (!group_id) throw Error('workspace has no pane group');
        return dispatchTool('wincmux_start_group_terminal', { workspace_id, group_id, agent });
      }
      if (args.group_id !== undefined) {
        const group_id = string(args.group_id, 'group_id');
        const groups = await coreCall('group.list', { workspace_id });
        if (!groups.groups.some(group => group.id === group_id)) throw Error('group_id not found in workspace');
      }
      if (args.pane_id !== undefined) {
        const pane_id = string(args.pane_id, 'pane_id');
        const [layout, bindings, sessions] = await Promise.all([
          coreCall('layout.list', { workspace_id }), coreCall('pane.session.bindings', { workspace_id }),
          coreCall('session.list', { workspace_id }),
        ]);
        if (!layout.panes.some(pane => pane.pane_id === pane_id && !pane.split)) throw Error('pane_id is not an empty terminal pane');
        const bound = bindings.bindings.find(item => item.pane_id === pane_id);
        if (bound && sessions.sessions.some(session => session.id === bound.session_id && session.status === 'running'))
          throw Error('pane already has a running terminal');
      }
      const hook_registration = agent === 'claude' || agent === 'codex'
        ? await coreCall('workspace.hooks.ensure', { workspace_id, provider: agent }) : null;
      const started = await coreCall('session.run', {
        workspace_id, cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd: workspace.path
      });
      const session_id = started.session.session_id;
      try {
        if (args.group_id !== undefined) {
          await coreCall('session.group.set', { workspace_id, session_id, group_id: args.group_id });
        }
        if (args.pane_id !== undefined) {
          await coreCall('pane.session.bind', { workspace_id, pane_id: args.pane_id, session_id });
        }
        if (agent !== 'powershell') {
          const command = agent === 'claude' ? `claude --session-id ${randomUUID()}` : agent;
          await coreCall('session.write', { session_id, data: `${command}\r` });
        }
      } catch (error) {
        await coreCall('session.close', { session_id }).catch(() => {});
        throw error;
      }
      return { session_id, workspace_id, workspace_name: workspace.name, pane_id: args.pane_id ?? null, group_id: args.group_id ?? null, launched: agent, hook_registration };
    }
    case 'wincmux_start_group_terminal': {
      const workspace_id = (await resolveWorkspace(args)).id;
      const group_id = string(args.group_id, 'group_id');
      const direction = args.direction ?? 'vertical';
      const agent = args.agent ?? 'powershell';
      if (!['horizontal', 'vertical'].includes(direction)) throw Error('invalid direction');
      if (!['powershell', 'claude', 'codex', 'gemini'].includes(agent)) throw Error('invalid agent');
      const listed = await dispatchTool('wincmux_list_terminals', { workspace_id });
      if (!listed.workspaces[0].groups.some(group => group.id === group_id)) throw Error('group_id not found in workspace');
      const panes = listed.workspaces[0].panes;
      const empty = panes.find(pane => pane.status !== 'running');
      let pane_id = empty?.pane_id;
      let split = null;
      if (!pane_id) {
        const source = panes.find(pane => pane.group_id === group_id) ?? panes.find(pane => pane.is_focused) ?? panes[0];
        if (!source) throw Error('workspace has no terminal pane');
        split = await dispatchTool('wincmux_split_pane', { workspace_id, pane_id: source.pane_id, direction });
        pane_id = split.second_pane_id;
      }
      try {
        const started = await dispatchTool('wincmux_start_terminal', { workspace_id, group_id, pane_id, agent });
        const focused = await coreCall('layout.focus', { workspace_id, pane_id }).then(() => true, () => false);
        return { ...started, split_from_pane_id: split?.original_pane_id ?? null, focused };
      } catch (error) {
        if (split) await coreCall('layout.close', { workspace_id, pane_id }).catch(() => {});
        throw error;
      }
    }
    case 'wincmux_terminal_input': {
      const session_id = string(args.session_id, 'session_id');
      if (typeof args.text !== 'string' || args.text.length > 16000) throw Error('text must be at most 16000 characters');
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(args.text)) throw Error('text contains a terminal control character');
      if (args.enter !== undefined && typeof args.enter !== 'boolean') throw Error('enter must be boolean');
      let data = args.text;
      let paste = false;
      if (data) {
        try { paste = (await coreCall('session.screen_text', { session_id })).bracketed_paste === true; }
        catch (error) { if (!/unknown|unsupported|method not found/i.test(error.message)) throw error; }
        if (paste) data = `\x1b[200~${data}\x1b[201~`;
        else if (data.includes('\n')) throw Error('multiline input requires bracketed paste mode');
      }
      if (args.enter === true) data += '\r';
      if (!data) throw Error('text or enter is required');
      await coreCall('session.write', { session_id, data });
      return { ok: true, session_id, entered: args.enter === true, bracketed_paste: paste };
    }
    case 'wincmux_press_key': {
      const session_id = string(args.session_id, 'session_id');
      const keys = { enter: '\r', escape: '\x1b', tab: '\t', ctrl_c: '\x03',
        up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' };
      if (!Object.hasOwn(keys, args.key)) throw Error('unsupported key');
      await coreCall('session.write', { session_id, data: keys[args.key] });
      return { ok: true, session_id, key: args.key };
    }
    case 'wincmux_close_terminal': {
      const session_id = string(args.session_id, 'session_id');
      await coreCall('session.close', { session_id });
      return { ok: true, session_id };
    }
    case 'wincmux_queue_followup': {
      const session_id = string(args.session_id, 'session_id');
      const prompt = string(args.prompt, 'prompt');
      const delivery_mode = args.delivery_mode ?? 'when_ready';
      if (!['when_ready', 'after_completion', 'at_time'].includes(delivery_mode)) throw Error('invalid delivery_mode');
      if (delivery_mode === 'at_time' && !Number.isInteger(args.due_at)) throw Error('due_at is required for at_time');
      return coreCall('followup.schedule', { session_id, prompt, delivery_mode,
        ...(delivery_mode === 'at_time' ? { due_at: args.due_at } : {}) });
    }
    case 'wincmux_send_followup_now': return coreCall('followup.send_now', { id: string(args.id, 'id') });
    case 'wincmux_list_followups': {
      const workspace = args.workspace_id || args.workspace ? await resolveWorkspace(args) : null;
      const listed = await coreCall('followup.list', {
        ...(args.session_id ? { session_id: string(args.session_id, 'session_id') } : {}),
        ...(workspace ? { workspace_id: workspace.id } : {})
      });
      return { ...listed, ...(workspace ? { workspace_id: workspace.id, workspace_name: workspace.name } : {}) };
    }
    case 'wincmux_capture_window': {
      if (args.pid !== undefined && (!Number.isInteger(args.pid) || args.pid < 1)) throw Error('pid must be a positive integer');
      if (args.format !== undefined && !['image', 'base64'].includes(args.format)) throw Error('format must be image or base64');
      const capture = await captureWindow(args);
      if (args.format === 'base64') return capture;
      return { _image: capture };
    }
    default: throw Error(`unknown MCP tool: ${name}`);
  }
}

async function callTool(name, args = {}) {
  let outcome = 'success';
  let result;
  try { result = await dispatchTool(name, args); return result; }
  catch (error) {
    outcome = /turned off/.test(error.message) ? 'blocked' : 'failed';
    throw error;
  } finally {
    if (tools.some(tool => tool.name === name)) {
      let workspace_id = result?.workspace_id ?? result?.workspace?.id ?? args?.workspace_id;
      if (!workspace_id && args?.workspace && outcome !== 'blocked') {
        workspace_id = await resolveWorkspace(args).then(workspace => workspace.id, () => null);
      }
      await coreCall('mcp.activity.record', { tool: name, outcome,
        ...(workspace_id ? { workspace_id } : {}),
        ...(args?.session_id ? { session_id: args.session_id } : {}),
        ...(name === 'wincmux_send_followup_now' && args?.id ? { followup_id: args.id } : {})
      }).catch(() => {});
    }
  }
}

function toolResult(value) {
  if (value?._image) {
    const { data, mime_type, ...metadata } = value._image;
    return { content: [{ type: 'image', data, mimeType: mime_type },
      { type: 'text', text: JSON.stringify(metadata) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
    return { error: { code: -32600, message: 'Invalid Request' } };
  if (!Object.hasOwn(message, 'id')) return null;
  switch (message.method) {
    case 'initialize': return { result: {
      protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'wincmux', version },
      instructions: 'Use list_workspaces and list_terminals to select a live session before sending input. terminal_input sends immediately; queue_followup waits for readiness.'
    } };
    case 'ping': return { result: {} };
    case 'tools/list': return { result: { tools } };
    case 'tools/call': {
      const name = message.params?.name;
      if (!tools.some(item => item.name === name)) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
      try { return { result: toolResult(await callTool(name, message.params?.arguments ?? {})) }; }
      catch (error) { return { result: { content: [{ type: 'text', text: error.message }], isError: true } }; }
    }
    default: return { error: { code: -32601, message: 'Method not found' } };
  }
}

function start() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', async line => {
    let message;
    try {
      if (Buffer.byteLength(line, 'utf8') > 1024 * 1024) throw Error('MCP request too large');
      message = JSON.parse(line);
      const response = await handle(message);
      if (response) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, ...response }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null,
        error: { code: -32700, message: error.message } }) + '\n');
    }
  });
}

if (require.main === module) start();
module.exports = { tools, callTool, handle, coreCall };
