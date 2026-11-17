// Opt-in live CLI test. It sends two short prompts to the user's configured
// provider account and is intentionally excluded from npm test.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

const agent = process.argv[2];
const columns = process.argv[3] === '--narrow' ? 61 : null;
const force = process.argv.includes('--force');
if (!['claude', 'codex', 'gemini'].includes(agent)) {
  console.error('Usage: node bridge/mcp/real-agent-smoke.cjs claude|codex|gemini');
  process.exit(2);
}
const pipe = '\\\\.\\pipe\\wincmux-real-mcp-' + randomUUID();
const root = fs.mkdtempSync(path.join(os.tmpdir(), `wincmux-real-mcp-${agent}-`));
process.env.WINCMUX_TAURI_PIPE = pipe;
const { callTool, coreCall } = require('./server.cjs');
const exe = path.resolve(__dirname, '../../apps/desktop-tauri/src-tauri/target/release/wincmux-core.exe');
const core = spawn(exe, ['--data-dir', root, '--pipe', pipe, '--no-tray'], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
let coreError = '';
core.stderr.on('data', chunk => { coreError += chunk.toString(); });

async function until(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await sleep(150);
  }
  throw Error(`timed out: ${label}`);
}

(async () => {
  let sid;
  let startFailure;
  try {
    await until(() => callTool('wincmux_status').catch(error => { startFailure = error.message; return null; }), 'core start', 15000);
    const workspace = await callTool('wincmux_create_workspace', { name: 'Real agent smoke', path: root });
    const started = await callTool('wincmux_start_terminal', { workspace_id: workspace.workspace.id, agent: columns ? 'powershell' : agent });
    sid = started.session_id;
    if (columns) {
      await coreCall('session.resize', { session_id: sid, cols: columns, rows: 35 });
      await callTool('wincmux_terminal_input', { session_id: sid, text: agent, enter: true });
    }
    const agentState = async () => (await coreCall('agent.list')).items.find(item => item.session_id === sid);
    const followup = async id => (await callTool('wincmux_list_followups', { session_id: sid })).items.find(item => item.id === id);
    let startupChoiceSent = false;
    await until(async () => {
      const state = await agentState();
      if (state?.terminal_ready || (state?.hook?.active && state.terminal_prompt_visible && state.terminal_prompt_empty
        && ['SessionStart', 'Stop'].includes(state.hook.last_event))) return true;
      if (!startupChoiceSent && (agent === 'codex' || agent === 'gemini')) {
        const screen = await callTool('wincmux_read_terminal', { session_id: sid, max_bytes: 800 });
        const visible = screen.screen?.lines?.join('\n') ?? '';
        const codexRestricted = agent === 'codex' && visible.includes('Folder access') && visible.includes('1. Open restricted');
        const geminiFolder = agent === 'gemini' && visible.includes('Do you trust the files in this folder?')
          && visible.includes('1. Trust folder') && visible.includes(root);
        if (codexRestricted || geminiFolder) {
          startupChoiceSent = true;
          await callTool('wincmux_press_key', { session_id: sid, key: 'enter' });
          console.log(`${agent}: selected ${codexRestricted ? 'Open restricted' : 'Trust folder'} for isolated test folder`);
        }
      }
      return false;
    }, 'real CLI startup ready', 60000);
    console.log(`${agent}: startup ready`);
    const first = await callTool('wincmux_queue_followup', {
      session_id: sid, prompt: 'Reply with exactly MCP-ONE. Do not use tools.', delivery_mode: 'when_ready'
    });
    const second = await callTool('wincmux_queue_followup', {
      session_id: sid, prompt: 'Reply with exactly MCP-TWO. Do not use tools.', delivery_mode: force ? 'after_completion' : 'when_ready'
    });
    await until(async () => (await followup(first.id))?.status === 'sent', 'first prompt sent', 15000);
    console.log(`${agent}: first prompt sent`);
    if (force) {
      const before = await agentState();
      const immediate = await callTool('wincmux_send_followup_now', { id: second.id });
      if (immediate.status !== 'sent') throw Error(`force submit failed: ${immediate.result}`);
      console.log(`${agent}: forced second prompt while state=${before.state}, ready=${before.terminal_ready}`);
    }
    await until(async () => (await followup(second.id))?.status === 'sent', 'second prompt sent after completion', 30000);
    const state = await agentState();
    if (!force && state.terminal_completed_count < 1 && !state.hook?.completed_count) throw Error('second prompt sent before a confirmed completion');
    const screen = await callTool('wincmux_read_terminal', { session_id: sid, max_bytes: 800 });
    if (!screen.screen?.lines?.some(line => /^[•●]\s*MCP-ONE\b/.test(line.trim()))) {
      if (!force) throw Error('first assistant reply was not visible on the terminal screen');
    }
    if (force) await until(async () => (await callTool('wincmux_read_terminal', { session_id: sid, max_bytes: 800 })).screen?.lines?.some(line => /^[•●]\s*MCP-TWO\b/.test(line.trim())), 'forced prompt response visible', 60000);
    console.log(`${agent}: ${force ? 'forced second prompt was answered' : 'second prompt sent after completion'}; completed=${state.terminal_completed_count}`);
  } catch (error) {
    console.error(`${agent}: ${error.message}`);
    if (startFailure) console.error('start_failure=' + startFailure);
    if (coreError) console.error('core_stderr=' + coreError.slice(-3000));
    if (core.exitCode !== null) console.error('core_exit=' + core.exitCode);
    if (sid) {
      const state = (await coreCall('agent.list').catch(() => ({ items: [] }))).items.find(item => item.session_id === sid);
      console.error('agent_state=' + JSON.stringify(state && {
        state: state.state, reason: state.reason, terminal_ready: state.terminal_ready,
        prompt_visible: state.terminal_prompt_visible, prompt_empty: state.terminal_prompt_empty,
        completed: state.terminal_completed_count, hook: state.hook, source: state.source
      }));
      const screen = await callTool('wincmux_read_terminal', { session_id: sid, max_bytes: 800 }).catch(() => null);
      const lines = screen?.screen?.lines?.map((line, row) => ({ row, line })).filter(item => item.line).slice(-12) ?? [];
      const redacted = lines.map(item => ({ ...item, line: item.line.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]').replace(/C:\\[^\s]+/gi, '[path]') }));
      console.error('screen=' + JSON.stringify(redacted));
    }
    process.exitCode = 1;
  } finally {
    if (sid) await callTool('wincmux_close_terminal', { session_id: sid }).catch(() => {});
    await coreCall('runtime.shutdown').catch(() => {});
    if (core.exitCode === null) core.kill();
  }
})();
