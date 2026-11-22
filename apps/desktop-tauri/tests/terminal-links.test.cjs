const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

test('plain URLs and OSC 8 links use the same native opener', async () => {
  const opened = [];
  const errors = [];
  let plainTextActivate;
  class WebLinksAddon {
    constructor(activate) { plainTextActivate = activate; }
  }
  const context = {
    URL,
    window: {
      WebLinksAddon: { WebLinksAddon },
      __TAURI__: { core: { invoke: async (command, args) => opened.push([command, args.url]) } }
    }
  };
  vm.runInNewContext(readFileSync(resolve(__dirname, '../renderer/terminal-links.js'), 'utf8'), context);
  const links = context.window.wincmuxTerminalLinks.create(error => errors.push(String(error)));
  let addon;
  links.attach({ loadAddon(value) { addon = value; } });
  assert.ok(addon instanceof WebLinksAddon);

  plainTextActivate({}, 'http://localhost:9012/path');
  links.handler.activate({}, 'https://example.com/docs');
  await new Promise(setImmediate);
  assert.deepEqual(opened, [
    ['open_terminal_url', 'http://localhost:9012/path'],
    ['open_terminal_url', 'https://example.com/docs']
  ]);
  assert.deepEqual(errors, []);

  links.handler.activate({}, 'file:///C:/secret');
  plainTextActivate({}, 'javascript:alert(1)');
  await new Promise(setImmediate);
  assert.equal(opened.length, 2);
  assert.equal(errors.length, 2);
});
