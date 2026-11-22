const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const window = {};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../renderer/remote-terminal-clipboard.js'), 'utf8'), { window, Promise });
const handle = window.wincmuxRemoteTerminalClipboard;

function event() {
  return { type:'keydown', code:'KeyC', ctrlKey:true, altKey:false, metaKey:false, shiftKey:false,
    preventDefault() { this.prevented = true; } };
}

test('Ctrl+C copies a selected remote terminal result without sending an interrupt', async () => {
  const key = event();
  const writes = [];
  const term = { hasSelection:() => true, getSelection:() => 'selected result' };
  assert.equal(handle(key, term, text => { writes.push(text); }, error => { throw error; }), false);
  assert.equal(key.prevented, true);
  await Promise.resolve();
  assert.deepEqual(writes, ['selected result']);
});

test('Ctrl+C without a selection still reaches the remote terminal', () => {
  const key = event();
  const term = { hasSelection:() => false, getSelection:() => '' };
  assert.equal(handle(key, term, () => { throw Error('unexpected copy'); }, () => {}), true);
  assert.equal(key.prevented, undefined);
});
