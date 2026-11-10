const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const source = readFileSync(path.join(__dirname, "../renderer/tauri-adapter.js"), "utf8");

function adapter() {
  const invokes = [];
  const listeners = new Map();
  const channels = [];
  class Channel {
    constructor() { channels.push(this); }
  }
  const context = {
    console,
    window: { __TAURI__: {
      core: {
        Channel,
        invoke: async (method, params) => {
          invokes.push(JSON.parse(JSON.stringify({ method, params })));
          return method === "subscribe" ? { subscription_id: "sub-1" } : { ok: true };
        }
      },
      event: {
        listen: async (name, handler) => {
          listeners.set(name, handler);
          return () => listeners.delete(name);
        }
      }
    } },
    wincmuxTauriStreamEvent: (event, dispatch) => dispatch(event)
  };
  vm.runInNewContext(source, context, { filename: "tauri-adapter.js" });
  return { api: context.window.wincmux, invokes, listeners, channels };
}

test("Tauri adapter exposes the desktop methods the renderer uses", () => {
  const { api } = adapter();
  const files = ["renderer.shared.js", "renderer.panes.js", "renderer.js", "renderer.hidden.js", "renderer.quickcmd.js"];
  const used = files.flatMap((file) => {
    const renderer = readFileSync(path.join(__dirname, "../renderer", file), "utf8");
    return [...renderer.matchAll(/window\.wincmux\??\.(\w+)/g)].map((match) => match[1]);
  });
  assert.ok(new Set(used).size >= 20);
  for (const name of new Set(used)) assert.equal(typeof api[name], "function", name);
});

test("stream IDs, events and payloads use the renderer's existing shapes", async () => {
  const { api, invokes, channels, listeners } = adapter();
  const events = [];
  const unbind = api.onStreamEvent((event) => events.push(event));
  const id = await api.streamSubscribe({ workspace_id: "workspace", topics: ["session"] });
  assert.equal(id, "sub-1");
  const output = { method: "session.output", params: { output: "한글  A" } };
  const notification = { method: "notify.created", params: { notification: { id: "notice" } } };
  channels[0].onmessage([output]);
  listeners.get("wincmux-notify")({ payload: notification });
  unbind();
  channels[0].onmessage([output]);
  assert.deepEqual(events, [output, notification]);

  await api.streamUnsubscribe(id);
  assert.deepEqual(invokes.at(-1), { method: "unsubscribe", params: { subscriptionId: "sub-1" } });
  await api.inputAssetCreateText("C:/한글", { title: "제목", content: "한글  A" });
  assert.deepEqual(invokes.at(-1), {
    method: "desktop_action",
    params: { action: "input-asset-create-text", params: { path: "C:/한글", title: "제목", content: "한글  A" } }
  });
});
