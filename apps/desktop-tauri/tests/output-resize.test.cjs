const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const source = readFileSync(path.join(__dirname, '../renderer/tauri-output.js'), 'utf8');
const panes = readFileSync(path.join(__dirname, '../renderer/renderer.panes.js'), 'utf8');

function harness({ oldCore = false, gap = false, fail = false } = {}) {
  const events = [];
  let output = 'old 한글\r\n';
  const view = {
    paneId: 'pane', sessionId: 'session', outputQueueLength: 0,
    term: {
      cols: 80, rows: 24, options: {},
      reset() { events.push(['reset']); },
      resize(cols, rows) { this.cols = cols; this.rows = rows; events.push(['resize', cols, rows]); },
      write(text, done) {
        setTimeout(() => { events.push(['write', this.cols, text]); done(); }, 2);
      }
    }
  };
  const state = { useStream: true, paneViews: new Map([['pane', view]]) };
  const flow = view.tauriOutput = {
    session: 'session', cursor: 0, wanted: 0, force: false,
    loading: false, queued: null, waiters: [], snapshotNeeded: false
  };
  const context = {
    state, performance, setTimeout, clearTimeout,
    isPaneViewAttached: () => true, hidePaneOverlay() {}, schedulePaneFit() {},
    setStatus(message) { throw new Error(message); },
    rpc: async (method, params) => {
      if (method === 'session.resize') {
        events.push(['rpc-resize', params.cols]);
        if (fail) throw new Error('resize refused');
        const boundary = Buffer.byteLength(output);
        output += 'new English 한글\r\n';
        return oldCore ? { ok: true } : { before_offset: boundary };
      }
      if (method === 'session.snapshot') {
        events.push(['snapshot']);
        return { cols: 40, rows: 12, end_offset: Buffer.byteLength(output),
          screen: 'restored 한글', windows_pty: { backend: 'conpty', buildNumber: 26100 } };
      }
      if (method === 'session.tail') {
        const bytes = Buffer.from(output);
        const start = gap && params.after_offset === 0 ? Buffer.byteLength('old 한글\r\n') : params.after_offset;
        const end = Math.min(bytes.length, start + params.max_bytes);
        return { output: bytes.subarray(start, end).toString(), start_offset: start,
          end_offset: end, available_end_offset: bytes.length };
      }
      throw new Error(method);
    },
    enqueueStreamOutput(pane, text) {
      view.outputQueueLength = 0;
      view.outputWriteInFlight = true;
      const receipt = context.wincmuxTauriBeginOutput(view);
      view.term.write(text, () => {
        view.outputWriteInFlight = false;
        context.wincmuxTauriFinishOutput(view, receipt, true);
      });
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, view, flow, events, get end() { return Buffer.byteLength(output); } };
}

async function settled(h) {
  for (let i = 0; i < 200; i++) {
    if (h.flow.cursor === h.end && !h.flow.loading && !h.view.outputWriteInFlight) return;
    await delay(5);
  }
  assert.fail(JSON.stringify(h.events));
}

test('pre-resize bytes parse at old width and repaint bytes at new width', async () => {
  const h = harness();
  assert.equal(await h.context.wincmuxTauriResizeOutput(h.view, 40, 12), true);
  await settled(h);
  assert.deepEqual(h.events.filter(e => e[0] === 'write' || e[0] === 'resize'), [
    ['write', 80, 'old 한글\r\n'], ['resize', 40, 12], ['write', 40, 'new English 한글\r\n']
  ]);
});

test('an outstanding tail finishes before the resize boundary is requested', async () => {
  const h = harness();
  h.flow.force = true;
  const read = h.context.pumpTauriOutput(h.view);
  const resize = h.context.wincmuxTauriResizeOutput(h.view, 40, 12);
  await Promise.all([read, resize]);
  await settled(h);
  assert.ok(h.events.findIndex(e => e[0] === 'write') < h.events.findIndex(e => e[0] === 'rpc-resize'));
  assert.equal(h.flow.cursor, h.end);
});

test('older cores and truncated history recover through a snapshot', async () => {
  for (const options of [{ oldCore: true }, { gap: true }]) {
    const h = harness(options);
    await h.context.wincmuxTauriResizeOutput(h.view, 40, 12);
    await settled(h);
    assert.ok(h.events.some(e => e[0] === 'snapshot'));
    assert.equal(h.view.term.options.windowsPty.buildNumber, 26100);
    assert.equal(h.flow.resizeLimit, null);
  }
});

test('a refused resize preserves local dimensions and releases output', async () => {
  const h = harness({ fail: true });
  await assert.rejects(h.context.wincmuxTauriResizeOutput(h.view, 40, 12), /resize refused/);
  await settled(h);
  assert.equal(h.view.term.cols, 80);
  assert.equal(h.flow.resizePaused, false);
});

test('pane initialization actually activates the installed Unicode provider', () => {
  const { Terminal } = require('@xterm/xterm');
  const fitModule = { exports: {} };
  vm.runInNewContext(readFileSync(require.resolve('@xterm/addon-fit'), 'utf8'),
    { module: fitModule, exports: fitModule.exports, self: {} });
  const { FitAddon } = fitModule.exports;
  const { Unicode11Addon } = require('@xterm/addon-unicode11');
  const initialization = panes.slice(panes.indexOf('function createPaneView('), panes.indexOf('  term.open(host);'));
  const context = {
    window: { Terminal, FitAddon: { FitAddon }, Unicode11Addon: { Unicode11Addon } },
    currentPaneFontSize: () => 14, state: { selectedWorkspaceId: 'workspace', terminal: { unicode_width: 'unicode11' } },
    PANE_TERMINAL_FONT_FAMILY: 'monospace', document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#000000' }), console
  };
  vm.createContext(context);
  const term = vm.runInContext(initialization + '\nreturn term; }\ncreatePaneView("pane", {});', context);
  assert.equal(term.unicode.activeVersion, '11');
  assert.equal(term.options.windowsPty.backend, 'conpty');
  term.dispose();
});

test('disabling compact headers still synchronizes the terminal and shell dimensions', async () => {
  const view = { paneId: 'pane', sessionId: 'session', term: { cols: 80, rows: 24 },
    pendingDimensions: { cols: 150, rows: 50 }, lastSyncedCols: 80, lastSyncedRows: 24 };
  const calls = [];
  const context = {
    state: { paneAutoResize: false, useStream: true, paneViews: new Map([['pane', view]]) },
    isPaneViewAttached: () => true,
    wincmuxTauriResizeOutput: async (v, cols, rows) => {
      calls.push([cols, rows]); v.term.cols = cols; v.term.rows = rows; return true;
    },
    isDetachedInputError: () => false, schedulePaneResize() {}
  };
  vm.createContext(context);
  vm.runInContext(panes.slice(panes.indexOf('async function syncPaneSize('),
    panes.indexOf('function inputFlushDelayForData(')), context);
  await context.syncPaneSize('pane');
  assert.deepEqual(calls, [[150, 50]]);
  assert.equal(view.lastSyncedCols, 150);
  // A snapshot can reset the local grid while the host and last sync stay put.
  view.term.cols = 120;
  await context.syncPaneSize('pane');
  assert.deepEqual(calls, [[150, 50], [150, 50]]);
});

test('a queued ordinary fit retains a later forced snapshot fit', () => {
  let frame;
  const calls = [];
  const context = { window: { requestAnimationFrame(fn) { frame = fn; return 1; } },
    fitPaneView(view, options) { calls.push(options.force); } };
  vm.createContext(context);
  vm.runInContext(panes.slice(panes.indexOf('function schedulePaneFit('),
    panes.indexOf('function performFitAllPanes(')), context);
  const view = {};
  context.schedulePaneFit(view);
  context.schedulePaneFit(view, { force: true });
  frame();
  assert.deepEqual(calls, [true]);
});
