const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.value = '';
  }
  append(...children) { this.children.push(...children); }
  remove() { this.removed = true; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  querySelectorAll() { return this.children; }
  replaceChildren() { this.children = []; }
}

function composer() {
  const window = {};
  const document = { createElement: tag => new Element(tag) };
  const source = fs.readFileSync(path.resolve(__dirname, '../renderer/remote-agent-composer.js'), 'utf8');
  vm.runInNewContext(source, { window, document });
  const calls = [];
  const buttons = [];
  const button = (label, click) => {
    const element = new Element('button');
    element.label = label;
    element.click = click;
    buttons.push(element);
    return element;
  };
  return { view:window.wincmuxRemoteComposer((action, payload) => { calls.push([action,payload]); return Promise.resolve(); }, button), calls, buttons };
}

test('agent handoff removes empty composer and blocks future submissions', () => {
  const { view, calls, buttons } = composer();
  view.handoff();
  assert.equal(view.panel.removed, true);
  assert.equal(view.state.removed, true);
  buttons.find(item => item.label === '전송 / 대기열').click();
  assert.equal(calls.length, 0);
});

test('agent handoff preserves an unsent draft for copying', () => {
  const { view } = composer();
  const input = view.panel.children.find(item => item.tag === 'textarea');
  input.value = 'unfinished question';
  view.handoff();
  assert.equal(view.panel.removed, undefined);
  assert.equal(input.readOnly, true);
  assert.equal(input.value, 'unfinished question');
  assert.match(view.panel.children.find(item => item.className === 'remote-composer-message').textContent, /초안이 전송되지/);
});

test('queued remote message has a send now action while the agent is working', () => {
  const { view, calls, buttons } = composer();
  view.update({ state:'working', queue:[{ id:7, preview:'answer now', paused:false, pasted:false }] });
  const sendNow = buttons.find(item => item.label === '↑ 지금 보내기');
  assert.ok(sendNow);
  sendNow.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'agent-send-now');
  assert.equal(calls[0][1].item, 7);
  assert.equal(sendNow.disabled, true);
});
