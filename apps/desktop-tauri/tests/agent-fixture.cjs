const { spawnSync } = require('node:child_process');
const core = process.env.WINCMUX_TEST_CORE_EXE;
const provider = process.argv.includes('--claude') ? 'claude' : 'codex';
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let pending = '';
let draft = '';
process.stdout.write('AGENT_FIXTURE_READY\r\n');
process.stdin.on('data', data => {
  pending += data;
  const hook = /#hook:(SessionStart|UserPromptSubmit|PermissionRequest|Notification|PostToolUse|Stop|StopFailure|SessionEnd)#/.exec(pending);
  if (hook) {
    pending = pending.replace(hook[0], '');
    const payload = { session_id: 'fixture-agent', turn_id: 'fixture-turn', hook_event_name: hook[1],
      prompt: 'must never reach WinCMux', tool_input: { secret: 'must never reach WinCMux' } };
    if (hook[1] === 'Notification') payload.notification_type = 'permission_prompt';
    const result = spawnSync(core, ['--agent-hook', provider, hook[1]], { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true });
    process.stdout.write(`HOOK_EXIT:${hook[1]}:${result.status}\r\n`);
    if (hook[1] === 'Stop') process.stdout.write('\x1b[10;1H\x1b[2K› \x1b[10;3H');
  }
  if (pending.includes('#paste-on#')) {
    pending = pending.replace('#paste-on#', '');
    process.stdout.write('\x1b[?2004hPASTE_MODE_ON\r\n');
  }
  if (pending.includes('#exit#')) process.exit(0);
  pending = pending.replace(/\x1b\[200~|\x1b\[201~/g, '');
  const enter = pending.indexOf('\r');
  if (enter >= 0) {
    draft += pending.slice(0, enter);
    pending = pending.slice(enter + 1);
    process.stdout.write(`RECEIVED:${Buffer.from(draft).toString('base64')}\r\n`);
    draft = '';
  }
});
