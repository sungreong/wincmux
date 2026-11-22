const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

test('remote scanner scopes Claude and Codex metadata to the selected project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-remote-conversations-'));
  const project = path.join(root, 'project');
  const child = path.join(project, 'child');
  const claude = path.join(root, '.claude');
  const codex = path.join(root, '.codex');
  const claudeFiles = path.join(claude, 'projects', 'project');
  const codexFiles = path.join(codex, 'sessions', '2026', '11', '20');
  for (const dir of [child, claudeFiles, codexFiles]) fs.mkdirSync(dir, { recursive: true });
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const write = (file, record) => fs.writeFileSync(file, JSON.stringify(record) + '\n');
  write(path.join(claudeFiles, `${ids[0]}.jsonl`), { sessionId: ids[0], type: 'user', cwd: project, message: { content: '한글 Claude 제목' } });
  write(path.join(claudeFiles, `${ids[1]}.jsonl`), { sessionId: ids[1], type: 'user', cwd: child, message: { content: '하위 폴더' } });
  write(path.join(codexFiles, `${ids[2]}.jsonl`), { type: 'session_meta', payload: { id: ids[2], cwd: project, source: 'cli' } });
  write(path.join(codex, 'session_index.jsonl'), { id: ids[2], thread_name: 'Codex saved title' });
  const scanner = path.resolve(__dirname, '../src-tauri/src/remote_conversations.py');
  const run = children => {
    const result = spawnSync('python', ['-B', scanner, project, children ? '1' : '0'], {
      encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex }
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).items;
  };
  try {
    const exact = run(false);
    assert.equal(exact.length, 2);
    assert.equal(exact.find(row => row.provider === 'claude').title, '한글 Claude 제목');
    assert.equal(exact.find(row => row.provider === 'codex').title, 'Codex saved title');
    assert.ok(exact.every(row => row.cwd_exists && row.size_bytes > 0));
    assert.equal(run(true).length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
