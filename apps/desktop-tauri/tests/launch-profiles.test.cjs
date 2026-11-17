const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = readFileSync(path.join(__dirname, '../renderer/renderer.launchers.js'), 'utf8');

function harness(store = new Map(), run = async () => 'new-session') {
  const calls = [];
  const view = { paneId: 'pane', sessionId: null };
  const context = {
    window: {}, console, crypto,
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    document: { getElementById: () => null },
    state: { paneViews: new Map([['pane', view]]), workspacePaneViewCache: new Map(), runningSessionIds: new Set(), selectedWorkspaceId: 'workspace' },
    setPaneOverlay() {},
    startShellCommandForPane: async (...args) => { calls.push(args); return run(); },
    paneHandlers: { startSessionForPane: async (...args) => { calls.push(args); return run(); } },
    overlayShellArgs: shell => ['-NoExit', '-Command', 'UTF8 setup for ' + shell]
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { api: context.window.wincmuxLaunchProfiles, store, view, context, calls };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('first launch supplies four tools with editable plain commands', () => {
  const h = harness();
  assert.deepEqual(plain(h.api.getAll()).items.map(p => p.command), ['claude', 'codex', 'gemini', 'powershell.exe']);
  assert.equal(h.api.getDefault().id, 'powershell');
  assert.equal(h.store.size, 0, 'opening does not overwrite stored preferences');
});

test('create, update, reorder and delete survive reloading the profile store', () => {
  const h = harness();
  let next = h.api.getAll();
  next.items.unshift({ id: 'custom', name: '프로젝트 셸', command: 'Write-Output "한글  A"', icon: 'bolt' });
  next.defaultId = 'custom';
  h.api.save(next);
  let loaded = harness(h.store).api;
  assert.equal(loaded.getDefault().command, 'Write-Output "한글  A"');
  next = loaded.getAll();
  next.items[0].name = '새 이름';
  next.items[0].command = 'claude --model sonnet';
  next.items = next.items.filter(p => p.id !== 'gemini');
  loaded.save(next);
  loaded = harness(h.store).api;
  assert.equal(loaded.getAll().items.length, 4);
  assert.equal(loaded.getDefault().name, '새 이름');
  assert.equal(loaded.getDefault().command, 'claude --model sonnet');
  const copy = loaded.getAll(); copy.items.length = 0;
  assert.equal(loaded.getAll().items.length, 4, 'reading does not expose mutable settings');
});

test('removing every tool remains empty after reload; removed defaults fall back', () => {
  const h = harness();
  const next = h.api.getAll(); next.items = next.items.filter(p => p.id !== next.defaultId);
  h.api.save(next);
  assert.equal(h.api.getDefault().id, 'claude');
  h.api.save({ items: [], defaultId: null });
  assert.equal(harness(h.store).api.getAll().items.length, 0);
});

test('invalid edits and storage failures preserve the previous configuration', () => {
  const h = harness();
  const before = plain(h.api.getAll());
  for (const edit of [
    next => { next.items[0].command = ' '; },
    next => { next.items[0].name = ''; },
    next => { next.items.push(next.items[0]); }
  ]) {
    const next = h.api.getAll(); edit(next);
    assert.throws(() => h.api.save(next));
    assert.deepEqual(plain(h.api.getAll()), before);
  }
  h.context.localStorage.setItem = () => { throw new Error('quota exceeded'); };
  const next = h.api.getAll(); next.items[0].name = 'changed';
  assert.throws(() => h.api.save(next), /quota/);
  assert.deepEqual(plain(h.api.getAll()), before);
});

test('profile execution forwards the saved command exactly and ignores double clicks', async () => {
  let complete;
  const h = harness(new Map(), () => new Promise(resolve => { complete = resolve; }));
  const next = h.api.getAll();
  next.items[0].command = 'claude --model sonnet\n# 한글';
  h.api.save(next);
  const first = h.api.launch(h.view, 'claude');
  assert.equal(await h.api.launch(h.view, 'claude'), null);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1], next.items[0].command);
  assert.equal(h.calls[0][2].force, false);
  complete('session'); await first;
});

test('PowerShell starts directly, and a live pane cannot be replaced by a launcher', async () => {
  const h = harness();
  await h.api.launch(h.view, 'powershell');
  assert.equal(h.calls[0][1].cmd, 'powershell.exe');
  assert.equal(h.calls[0][1].workspaceId, 'workspace');
  h.view.sessionId = 'live'; h.context.state.runningSessionIds.add('live');
  await assert.rejects(h.api.launch(h.view, 'codex'), /이미 실행/);
  assert.equal(h.calls.length, 1);
});
