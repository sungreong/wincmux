const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

test('WebGL setting switches live panes, releases contexts, and handles context loss', () => {
  const stored = new Map();
  const windowEvents = {};
  const elements = Object.fromEntries(['terminalRendererDialog', 'terminalRendererSettingsBtn', 'terminalRendererClose',
    'terminalWebglEnabled', 'terminalWebglState'].map(id => [id, {
      events: {}, addEventListener(type, listener) { this.events[type] = listener; },
      showModal() { this.open = true; }, close() { this.open = false; }
    }]));
  let disposed = 0;
  let lost = 0;
  class WebglAddon {
    onContextLoss(listener) { this.loss = listener; return { dispose() {} }; }
    dispose() { disposed++; }
  }
  const context = {
    console,
    document: { getElementById: id => elements[id] },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    window: { WebglAddon: { WebglAddon }, addEventListener(type, listener) { windowEvents[type] = listener; } }
  };
  vm.runInNewContext(readFileSync(resolve(__dirname, '../renderer/terminal-renderer.js'), 'utf8'), context);
  const manager = context.window.wincmuxTerminalRenderer;
  const reports = [];
  function terminal() {
    return {
      output: 'existing session output', addons: [],
      element: { querySelector: () => ({ getContext: () => ({ getExtension: () => ({ loseContext() { lost++; } }) }) }) },
      loadAddon(addon) { this.addons.push(addon); }
    };
  }
  const first = terminal();
  const second = terminal();
  manager.register(first, message => reports.push(message));
  manager.register(second, message => reports.push(message));
  assert.equal(first.addons.length, 0, 'default is off');

  elements.terminalRendererSettingsBtn.events.click();
  assert.equal(elements.terminalRendererDialog.open, true);
  elements.terminalWebglEnabled.events.change({ target: { checked: true } });
  assert.equal(stored.get('wincmux.terminal.webgl'), '1');
  assert.equal(first.addons.length, 1);
  assert.equal(second.addons.length, 1);
  assert.equal(first.output, 'existing session output');
  assert.equal(elements.terminalWebglState.textContent, '켜짐');

  first.addons[0].loss();
  assert.equal(disposed, 1);
  assert.match(reports[0], /기본 렌더러/);
  assert.equal(typeof second.addons[0].loss, 'function');

  stored.set('wincmux.terminal.webgl', '0');
  windowEvents.storage({ key: 'wincmux.terminal.webgl' });
  assert.equal(manager.isEnabled(), false);
  assert.equal(disposed, 2);
  assert.equal(lost, 2);
  assert.equal(elements.terminalWebglState.textContent, '꺼짐');
  manager.unregister(first);
  manager.unregister(second);
});
