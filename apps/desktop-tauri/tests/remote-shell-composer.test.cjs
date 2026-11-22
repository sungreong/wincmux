const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

class Element {
  constructor(tag) { this.tag = tag; this.listeners = {}; this.children = []; this.value = ''; }
  append(...items) { this.children.push(...items); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}

function createShell(request) {
  const window = {};
  const document = { createElement: tag => new Element(tag) };
  const source = fs.readFileSync(path.resolve(__dirname, '../renderer/remote-shell-composer.js'), 'utf8');
  vm.runInNewContext(source, { window, document, Promise });
  let submit;
  const view = window.wincmuxRemoteShellComposer(request, (_label, callback) => {
    submit = new Element('button');
    submit.click = callback;
    return submit;
  });
  return { view, submit };
}

test('Korean composition stays in the shell input until the user submits', async () => {
  const calls = [];
  const { view, submit } = createShell(text => { calls.push(text); return Promise.resolve(); });
  view.input.value = '한글 명령';
  view.input.listeners.compositionstart();
  const key = { key:'Enter', ctrlKey:true, metaKey:false, altKey:false, shiftKey:false, preventDefault() { this.prevented = true; } };
  view.input.listeners.keydown(key);
  assert.equal(key.prevented, undefined);
  assert.equal(calls.length, 0);
  view.input.listeners.compositionend();
  await submit.click();
  assert.equal(calls[0], '한글 명령\r');
  assert.equal(view.input.value, '');
});

test('shell input keeps multiline and failed commands for correction', async () => {
  const calls = [];
  const { view, submit } = createShell(text => { calls.push(text); return Promise.reject(Error('disconnected')); });
  view.input.value = 'echo 하나\necho 둘';
  await submit.click();
  assert.equal(calls.length, 0);
  assert.equal(view.input.value, 'echo 하나\necho 둘');
  view.input.value = 'echo 하나';
  await submit.click();
  assert.equal(calls.length, 1);
  assert.equal(view.input.value, 'echo 하나');
});
