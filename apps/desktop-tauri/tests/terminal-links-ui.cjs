const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { until, portNumber, connect } = require('./benchmark.cjs');

async function run() {
  const root = path.resolve(__dirname, '../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wincmux-links-'));
  const port = await portNumber();
  const child = spawn(path.join(root, 'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'), ['--benchmark-hidden'], {
    windowsHide: true, stdio: 'ignore', env: {
      ...process.env,
      WINCMUX_TAURI_DATA_DIR: path.join(temp, 'data'),
      WINCMUX_TAURI_PIPE: '\\\\.\\pipe\\wincmux-links-' + randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER: path.join(temp, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling`
    }
  });
  let cdp;
  let server;
  try {
    cdp = await connect(port, child);
    await until(() => cdp.eval('typeof window.wincmuxTerminalLinks === "object" && typeof window.WebLinksAddon?.WebLinksAddon === "function"'), 'terminal link assets');
    const positions = await cdp.eval(`(async () => {
      window.__openedTerminalLinks = [];
      window.wincmuxTerminalLinks.open = async url => window.__openedTerminalLinks.push(url);
      const links = window.wincmuxTerminalLinks.create(error => { throw error; });
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:20px;top:20px;width:900px;height:160px;z-index:99999;background:#10151c';
      document.body.append(host);
      const term = new window.Terminal({cols:80,rows:4,fontSize:16,linkHandler:links.handler});
      links.attach(term);
      term.open(host);
      await new Promise(resolve => term.write('https://example.com/docs\\r\\n\\x1b]8;;http://localhost:9012/inside\\x1b\\\\Open docs\\x1b]8;;\\x1b\\\\', resolve));
      const screen = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      const cell = term._core._renderService.dimensions.css.cell;
      window.__linkTestTerm = term;
      return [{ x: screen.left + cell.width * 3, y: screen.top + cell.height * 0.5 },
        { x: screen.left + cell.width * 3, y: screen.top + cell.height * 1.5 }];
    })()`);
    for (const [index, point] of positions.entries()) {
      await cdp.request('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await cdp.request('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.request('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      await until(() => cdp.eval(`window.__openedTerminalLinks.length === ${index + 1}`), 'terminal link click');
    }
    assert.deepEqual(await cdp.eval('window.__openedTerminalLinks'), ['https://example.com/docs', 'http://localhost:9012/inside']);
    console.log('Plain URL and OSC 8 clicks reached the native opener in WebView2.');
    if (process.argv.includes('--native')) {
      let receive;
      const request = new Promise(resolve => { receive = resolve; });
      server = http.createServer((incoming, response) => {
        response.writeHead(204);
        response.end();
        receive(incoming.url);
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const expectedPath = '/wincmux-link-check?code=a%2Fb&state=x-y';
      const url = `http://127.0.0.1:${server.address().port}${expectedPath}`;
      await cdp.eval(`window.__TAURI__.core.invoke('open_terminal_url', {url:${JSON.stringify(url)}})`);
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Browser did not request the URL')), 15000); });
        assert.equal(await Promise.race([request, timeout]), expectedPath);
      } finally {
        clearTimeout(timer);
      }
      console.log('Windows default browser requested the URL from the local probe.');
    }
  } finally {
    cdp?.close();
    child.kill();
    server?.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
