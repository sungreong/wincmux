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
    this.classList = { add() {} };
  }
  append(...children) { this.children.push(...children); }
  focus() {}
  remove() { this.removed = true; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  querySelectorAll() { return this.children; }
  replaceChildren() { this.children = []; }
  dispatchEvent(event) { this.listeners[event.type]?.(event); }
}

function composer(seed, provider = 'codex') {
  const window = { addEventListener() {} };
  const document = { createElement: tag => new Element(tag), documentElement: { lang:'ko' } };
  const entries = new Map();
  if (seed) entries.set('wincmux.agent-command-input.v1', JSON.stringify(seed));
  const localStorage = { getItem:key => entries.get(key) ?? null, setItem:(key,value) => entries.set(key,value) };
  const context = { window, document, localStorage, Event: class { constructor(type) { this.type = type; } } };
  for (const file of ['agent-command-input.js', 'remote-agent-composer.js']) {
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../renderer', file), 'utf8'), context);
  }
  const calls = [];
  const buttons = [];
  const button = (label, click) => {
    const element = new Element('button');
    element.label = label;
    element.click = click;
    buttons.push(element);
    return element;
  };
  return { view:window.wincmuxRemoteComposer((action, payload) => { calls.push([action,payload]); return Promise.resolve(); }, button, provider), calls, buttons, entries, commandsApi:window.wincmuxAgentCommandInput };
}

function controls(view) {
  const panel = view.panel.children.find(item => item.className === 'agent-command-tools');
  const row = panel.children.find(item => item.className === 'agent-command-row');
  return { row, mode:row.children[1], saved:row.children[2], add:row.children[3], remove:row.children[4], description:panel.children.find(item => item.className === 'agent-command-description') };
}

test('saved slash command goes directly to ready agent in command mode', async () => {
  const { view, calls, buttons, entries } = composer();
  const input = view.panel.children.find(item => item.tag === 'textarea');
  const { mode, saved, add, remove, description } = controls(view);
  input.value = '/goal';
  description.value = '내 목표 설명';
  add.dispatchEvent({ type:'click' });
  assert.equal(saved.value, '/goal');
  assert.equal(JSON.parse(entries.get('wincmux.agent-command-input.v1')).codex.items[0].description, '내 목표 설명');
  saved.dispatchEvent({ type:'change' });
  assert.equal(mode.value, 'command');
  assert.equal(description.value, '내 목표 설명');
  view.panel.children.find(item => item.className === 'agent-command-tools').dispatchEvent({ type:'change' });
  assert.equal(buttons.find(item => item.label === '후속 예약').disabled, true);
  buttons.find(item => item.label === '전송 / 대기열').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0][0], 'agent-command');
  assert.equal(calls[0][1].text, '/goal');
  assert.equal(input.value, '');
  saved.value = '/goal';
  remove.dispatchEvent({ type:'click' });
  const data = JSON.parse(entries.get('wincmux.agent-command-input.v1')).codex;
  assert.equal(data.items.length, 0);
  assert.deepEqual(data.excluded, ['/goal']);
});

test('unknown skill remains executable and legacy favorites can receive descriptions', async () => {
  const { view, calls, buttons, entries } = composer({ codex:{ mode:'message', items:['$my-skill'] } });
  const input = view.panel.children.find(item => item.tag === 'textarea');
  const { saved, add, description } = controls(view);
  saved.value = '$my-skill';
  saved.dispatchEvent({ type:'change' });
  assert.equal(input.value, '$my-skill');
  description.value = '프로젝트에서 만든 스킬';
  add.dispatchEvent({ type:'click' });
  assert.equal(JSON.parse(entries.get('wincmux.agent-command-input.v1')).codex.items[0].description, '프로젝트에서 만든 스킬');
  buttons.find(item => item.label === '전송 / 대기열').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0][0], 'agent-command');
  assert.equal(calls[0][1].text, '$my-skill');
});

test('workspace skill metadata becomes agent-specific commands without registration', async () => {
  const { view, commandsApi } = composer();
  const scan = { items:[
    { exists:true, category:'skills', providers:['claude'], relativePath:'.claude/skills/build/SKILL.md', name:'build', details:{description:'Build project'} },
    { exists:true, category:'skills', providers:['codex'], relativePath:'.agents/skills/lint/SKILL.md', name:'lint', details:{description:'Run lint'} }
  ] };
  assert.equal(commandsApi.fromAgentAssets(scan, 'claude')[0].command, '/build');
  assert.equal(commandsApi.fromAgentAssets(scan, 'codex')[0].command, '$lint');
  commandsApi.setWorkspaceLoader(async provider => ({ title:'Sample', items:commandsApi.fromAgentAssets(scan, provider) }));
  const panel = view.panel.children.find(item => item.className === 'agent-command-tools');
  const { saved } = controls(view);
  const control = panel.children.find(item => item.className === 'agent-command-row');
  const provider = control.children[0];
  provider.value = 'claude';
  provider.dispatchEvent({ type:'change' });
  await new Promise(resolve => setImmediate(resolve));
  const groups = saved.children.filter(item => item.tag === 'optgroup');
  assert.equal(groups[0].children[0].value, '/build');
});

test('slash text in message mode is marked as ordinary message', async () => {
  const { view, calls, buttons } = composer();
  const input = view.panel.children.find(item => item.tag === 'textarea');
  input.value = '/goal';
  buttons.find(item => item.label === '전송 / 대기열').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0][0], 'agent-submit');
  assert.match(calls[0][1].text, /^다음은 CLI 명령이나 스킬 실행이 아닌 일반 메시지입니다: \/goal$/);
});

test('Gemini hides agent commands and ignores a saved CLI mode', async () => {
  const { view, calls, buttons } = composer({ codex:{ mode:'command', items:[] } }, 'gemini');
  const panel = view.panel.children.find(item => item.className === 'agent-command-tools');
  assert.equal(panel.hidden, true);
  const input = view.panel.children.find(item => item.tag === 'textarea');
  input.value = '/goal';
  buttons.find(item => item.label === '전송 / 대기열').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0][0], 'agent-submit');
  assert.match(calls[0][1].text, /일반 메시지입니다: \/goal$/);
});

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
