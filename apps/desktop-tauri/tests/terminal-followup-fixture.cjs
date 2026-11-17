process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let pending = '';
const startupClaude = process.argv.includes('--startup-claude');
const startupGemini = process.argv.includes('--startup-gemini');
if (startupGemini) {
  if (process.argv.includes('--mcp-child')) {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
    process.on('exit', () => child.kill());
    process.stdout.write(`MCP_CHILD_READY:${child.pid}\r\n`);
  }
  const composer = '\x1b[10;1H\x1b[2K>   Type your message or @path/to/file\x1b[10;3H';
  process.stdout.write('\x1b[?2004h\x1b]0;◇  Ready (fixture)\x07\x1b[2J' + composer);
  process.stdin.on('data', data => {
    pending += data;
    if (pending.includes('#exit#')) process.exit(0);
    if (pending.includes('#finish#')) {
      pending = pending.replace('#finish#', '');
      process.stdout.write('\x1b[8;1HGemini answer finished\x1b]0;◇  Ready (fixture)\x07' + composer);
    }
    if (pending.includes('#draft#')) {
      pending = pending.replace('#draft#', '');
      process.stdout.write('\x1b[10;1H\x1b[2K> Review changes\x1b[10;17H');
    }
    if (pending.includes('\x03')) {
      pending = pending.replaceAll('\x03', '');
      process.stdout.write(composer);
    }
    if (pending.includes('\x1b[200~') && pending.includes('\x1b[201~')) {
      const start = pending.indexOf('\x1b[200~') + 6;
      const end = pending.indexOf('\x1b[201~');
      process.stdout.write(`\x1b[10;1H\x1b[2K> ${pending.slice(start, end)}`);
    }
    pending = pending.replace(/\x1b\[200~|\x1b\[201~/g, '');
    const enter = pending.indexOf('\r');
    if (enter >= 0) {
      const prompt = pending.slice(0, enter);
      pending = pending.slice(enter + 1);
      process.stdout.write(`\x1b[9;1HRECEIVED:${Buffer.from(prompt).toString('base64')}\x1b]0;✦  Working… (fixture)\x07`);
    }
  });
} else {
process.stdout.write(startupClaude
  ? '\x1b[?2004h\x1b[2J\x1b[1;1HClaude Code v2.1.326\x1b[10;1H────────────────────\x1b[11;1H❯ Try "write a test for <filepath>"\x1b[12;1H────────────────────\x1b[13;1H  ▸▸ auto mode on (shift+tab to cycle)\x1b[11;3H'
  : '\x1b[?2004hCodex task running\r\n');
process.stdin.on('data', data => {
  pending += data;
  if (pending.includes('#exit#')) process.exit(0);
  if (pending.includes('#finish#')) {
    pending = pending.replace('#finish#', '');
    process.stdout.write('Task finished\r\nCogitated for 25s · done\x1b[10;1H› ');
  }
  if (pending.includes('#draft#')) {
    pending = pending.replace('#draft#', '');
    process.stdout.write('변경사항 리뷰해줘');
  }
  if (pending.includes('#clear#')) {
    pending = pending.replace('#clear#', '');
    process.stdout.write('\r\x1b[2K› ');
  }
  if (pending.includes('\x03') || pending.includes('\x13')) {
    pending = pending.replace(/[\x03\x13]/g, '');
    process.stdout.write('\r\x1b[2K› ');
  }
  if (pending.includes('\x1b[200~') && pending.includes('\x1b[201~')) {
    process.stdout.write(startupClaude
      ? `\x1b[11;1H\x1b[2K❯ ${pending.slice(pending.indexOf('\x1b[200~') + 6, pending.indexOf('\x1b[201~'))}`
      : 'ECHO_DRAFT\r\n');
  }
  pending = pending.replace(/\x1b\[200~|\x1b\[201~/g, '');
  const enter = pending.indexOf('\r');
  if (enter >= 0) {
    const prompt = pending.slice(0, enter);
    pending = pending.slice(enter + 1);
    process.stdout.write(`RECEIVED:${Buffer.from(prompt).toString('base64')}\r\n`);
  }
});
}
