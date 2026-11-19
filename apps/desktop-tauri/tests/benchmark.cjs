const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { setTimeout: sleep } = require("node:timers/promises");
const root = path.resolve(__dirname, "../../..");
const fixture = path.join(__dirname, "fixture.cjs");
const input = "한글  A   가가가";
const output = "응답  A   가나";

async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(30);
  }
  throw new Error("Timed out: " + label);
}

async function portNumber() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function connect(port, child) {
  const target = await until(async () => {
    if (child.exitCode !== null) throw new Error("Application exited: " + child.exitCode);
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/json/list");
      return (await response.json()).find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    } catch { return null; }
  }, "WebView debugger");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const requests = new Map();
  socket.addEventListener("message", ({ data }) => {
    const packet = JSON.parse(data);
    requests.get(packet.id)?.(packet);
  });
  async function request(method, params, timeoutMs = 20000) {
    const id = ++sequence;
    const packet = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error("CDP request timed out: " + method));
      }, timeoutMs);
      requests.set(id, (packet) => {
        clearTimeout(timer);
        requests.delete(id);
        resolve(packet);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    if (packet.error) throw new Error(packet.error.message);
    return packet.result;
  }
  return {
    close: () => socket.close(),
    request,
    async eval(expression, timeoutMs) {
      const response = await request("Runtime.evaluate", {
        expression, returnByValue: true, awaitPromise: true, userGesture: true
      }, timeoutMs);
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      }
      return response.result.value;
    }
  };
}

function privateMemory(pid, fixtureIds, corePid = null) {
  const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const script = `
    $hostProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${pid}"
    if (!$hostProcess) { throw "WinCMux benchmark process exited" }
    $rows = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='wincmux-tauri.exe' OR Name='wincmux-core.exe' OR Name='msedgewebview2.exe'" |
      Where-Object { $_.CreationDate -ge $hostProcess.CreationDate })
    $ids = @(${pid}${corePid ? "," + corePid : ""})
    do {
      $children = @($rows | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object ProcessId)
      $ids += $children
    } while ($children.Count -gt 0)
    $appIds = @($ids | Select-Object -Unique)
    $fixtureIds = @(${fixtureIds.join(",")})
    $appIds = @($appIds | Where-Object { $_ -notin $fixtureIds })
    $appBytes = (Get-Process -Id $appIds -ErrorAction SilentlyContinue | Measure-Object -Property PrivateMemorySize64 -Sum).Sum
    $cliBytes = (Get-Process -Id $fixtureIds -ErrorAction SilentlyContinue | Measure-Object -Property PrivateMemorySize64 -Sum).Sum
    [pscustomobject]@{appMiB=[math]::Round($appBytes / 1MB, 2); fixtureCliMiB=[math]::Round($cliBytes / 1MB, 2); processCount=$appIds.Count} | ConvertTo-Json -Compress
  `;
  return JSON.parse(execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true }));
}

async function pipeHealth(pipe) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe).setEncoding("utf8");
    const timer = setTimeout(() => socket.destroy(new Error("Bridge timeout")), 3000);
    socket.on("connect", () => socket.write('{"jsonrpc":"2.0","id":1,"method":"health.check"}\n'));
    socket.on("error", reject);
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      if (!buffer.includes("\n")) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(JSON.parse(buffer.split("\n")[0]).result.status);
    });
    socket.on("close", () => clearTimeout(timer));
  });
}

async function captureScreenshots(cdp, start, firstPane, firstSession, buffers, workspaceId) {
  await cdp.request("Emulation.setDeviceMetricsOverride", { width: 1440, height: 860, deviceScaleFactor: 1, mobile: false });
  await cdp.eval(`(async () => {
    await loadWorkspaces();
    if (state.leftCollapsed) toggleWorkspacePanel();
    if (!state.rightCollapsed) toggleNotificationPanel();
  })()`);
  const split = await cdp.eval(`splitPaneInternal(${JSON.stringify(firstPane)}, "horizontal", { autoStartIfMissing: false })`);
  const second = await start(split.second);
  for (const [session_id, data] of [[firstSession, "#demo:chat#"], [second, "#demo:test#"]]) {
    await cdp.eval("rpc('session.write'," + JSON.stringify({ session_id, data }) + ")");
  }
  await until(async () => {
    const output = (await buffers()).join("\n");
    return output.includes("WinCMux Terminal Demo") && output.includes("18,000 rows verified");
  }, "demo terminal output");
  await cdp.eval("rpc('session.write'," + JSON.stringify({session_id:firstSession,data:"#status:done#"}) + ")");
  await cdp.eval("rpc('session.write'," + JSON.stringify({session_id:second,data:"#status:working#"}) + ")");
  await cdp.eval(`selectPane(${JSON.stringify(split.second)}, { persist: false, focusTerm: false })`);

  const capture = async (name) => {
    await sleep(250);
    const { data } = await cdp.request("Page.captureScreenshot", { format: "png", fromSurface: true });
    const file = path.join(root, "assets", name);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  };
  await cdp.eval(`(() => {
    const editor = document.getElementById("terminalPromptText");
    editor.value = ${JSON.stringify("한글 입력과  연속 공백을 확인해 줘.\n긴 URL을 복사해도 주소가 이어지는지 테스트해 줘.")};
    editor.dispatchEvent(new Event("input"));
  })()`);
  const overview = await capture("view.png");
  const design = await cdp.eval(`(() => {
    const name=document.querySelector(".ws-title");
    const help=document.querySelector("details.terminal-prompt-help");
    const status=[...document.querySelectorAll(".agent-working")];
    return {workspaceButton:name?.tagName, titleFits:name.scrollWidth<=name.clientWidth,
      helpCollapsed:!!help&&!help.open,
      statusReadOnly:status.length>0&&status.every(el=>el.tagName!=="BUTTON"),
      filterPressed:[...document.querySelectorAll(".group-chip:not(.group-add):not(.group-terminal-add)")].every(el=>el.hasAttribute("aria-pressed"))};
  })()`);
  assert.equal(design.workspaceButton,"BUTTON");
  assert.equal(design.titleFits,true,JSON.stringify(design));
  assert.equal(design.helpCollapsed,true);
  assert.equal(design.statusReadOnly,true);
  assert.equal(design.filterPressed,true);
  await cdp.request("Emulation.setDeviceMetricsOverride", {width:1100,height:760,deviceScaleFactor:1,mobile:false});
  const compact=await capture("view-compact.png");
  assert.equal(await cdp.eval("document.documentElement.scrollWidth<=window.innerWidth"),true);
  assert.equal(await cdp.eval(`([...document.querySelectorAll(".pane-header")].every(header=>{
    const status=header.querySelector(".pane-status-wrap").getBoundingClientRect();
    const actions=header.querySelector(".pane-actions").getBoundingClientRect();
    return status.right<=actions.left;
  }))`),true,"compact pane status overlaps actions");
  await cdp.request("Emulation.setDeviceMetricsOverride", {width:1440,height:860,deviceScaleFactor:1,mobile:false});
  await cdp.eval('document.getElementById("terminalPromptExpand").click()');
  return [overview, compact, await capture("prompt-editor.png")];
}

async function benchmark(executable, screenshots) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wincmux-compare-"));
  const port = await portNumber();
  const pipe = "\\\\.\\pipe\\wincmux-compare-" + randomUUID();
  let child;
  let cdp;
  const sessions = new Set();
  const close = (sid) => cdp.eval("rpc('session.close',{session_id:" + JSON.stringify(sid) + "})");
  try {
    child = spawn(executable, ["--benchmark-hidden"], {
      windowsHide: true, stdio: "ignore",
      env: {
        ...process.env,
        LOCALAPPDATA: temp,
        WINCMUX_TAURI_DATA_DIR: path.join(temp, "tauri-data"),
        WINCMUX_TAURI_PIPE: pipe,
        WEBVIEW2_USER_DATA_FOLDER: path.join(temp, "webview2"),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows`
      }
    });
    cdp = await connect(port, child);
    if (process.env.WINCMUX_PREVIEW_SOURCE === "1") {
      const css=["design-tokens.css","styles.css"].map(name=>fs.readFileSync(path.join(root,"apps/desktop-tauri/renderer",name),"utf8")).join("\n");
      await cdp.eval(`(() => {const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);})()`);
    }
    await until(async () => {
      if (child.exitCode !== null) throw new Error("Application exited before bridge startup: " + child.exitCode);
      return pipeHealth(pipe).then((status) => status === "ok", () => false);
    }, "JSON-RPC bridge startup");
    await until(() => cdp.eval("typeof state !== 'undefined' && Boolean(window.wincmux)"), "renderer scripts");
    if (await cdp.eval("typeof window.wincmux.takeActivation === 'function'")) await until(() => cdp.eval("state.bootstrapReady === true"), "app bootstrap");
    const workspace = await cdp.eval("rpc('workspace.create'," + JSON.stringify({
      name: screenshots ? "WinCMux Demo" : "Benchmark", path: screenshots ? root : temp, backend: "codex"
    }) + ")");
    await cdp.eval("loadWorkspaces().then(()=>switchWorkspace(" + JSON.stringify(workspace.workspace.id) + "))");
    await until(() => cdp.eval("state.paneViews.size > 0"), "workspace view");
    const firstPane = await cdp.eval("state.paneViews.keys().next().value");
    await cdp.eval("selectPane(" + JSON.stringify(firstPane) + ",{persist:false,focusTerm:false})");
    const start = async (pane) => {
      const id = await cdp.eval("startSessionForPane(" + JSON.stringify(pane) + "," + JSON.stringify({
        force: true, cmd: process.execPath, args: [fixture], cwd: temp, focusTerm: false
      }) + ")");
      assert.ok(id);
      sessions.add(id);
      return id;
    };
    const buffers = () => cdp.eval(`[...state.paneViews.values()].map(v=>{
      const b=v.term.buffer.active; return Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true)).join("\\n");
    })`);
    const recent = () => cdp.eval(`[...state.paneViews.values()].map(v=>{
      const b=v.term.buffer.active; const y=b.baseY+b.cursorY; return [y-2,y-1,y].map(i=>b.getLine(i)?.translateToString(true)).join("\\n");
    })`);
    const firstSession = await start(firstPane);
    await until(async () => (await recent()).some((text) => text.includes("FIXTURE_READY")), "PTY fixture startup");
    await sleep(700);
    assert.equal(await cdp.eval(`document.getElementById("terminalComposer").parentElement.dataset.paneId===state.selectedPaneId
      && !document.getElementById("terminalComposer").hidden
      && document.getElementById("terminalPromptForm").parentElement.id==="terminalComposer"`), true);
    if (screenshots) {
      return { screenshots: await captureScreenshots(cdp, start, firstPane, firstSession, buffers, workspace.workspace.id) };
    }
    if (process.env.WINCMUX_PERF_ONLY !== "1") {
    const imeGuard = await cdp.eval(`(() => {
      document.getElementById("terminalPromptExpand").click();
      const editor=document.getElementById("terminalPromptText");
      const form=document.getElementById("terminalPromptForm");
      editor.value=${JSON.stringify(input)};
      editor.dispatchEvent(new Event("input"));
      editor.dispatchEvent(new CompositionEvent("compositionstart"));
      form.requestSubmit();
      const held=document.getElementById("terminalPrompt").open && !editor.readOnly;
      editor.dispatchEvent(new CompositionEvent("compositionend"));
      editor.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true}));
      return held;
    })()`);
    assert.equal(imeGuard, true);
    await until(async () => (await recent()).some((text) => text.includes("INPUT_OK:" + input)), "exact Korean prompt with consecutive spaces");
    const submittedInput = "SUBMIT_OK:" + Buffer.from(input).toString("base64") + ":END";
    await until(async () => (await buffers()).join("\n").includes(submittedInput), "Ctrl+Enter submits Korean input");

    const multiline = "한글  A\n\n  가가가";
    assert.equal(await cdp.eval(`terminalPromptPayload(${JSON.stringify(multiline)},true,true)`),
      "\x1b[200~" + multiline + "\x1b[201~");
    await cdp.eval("writeToPane(state.selectedPaneId,'#paste-on#')");
    await until(() => cdp.eval("state.paneViews.get(state.selectedPaneId).term.modes.bracketedPasteMode"), "bracketed paste enabled");
    for (const shortcut of [true, false]) {
      await cdp.eval(`(() => {
        if (!${shortcut}) document.getElementById("terminalPromptExpand").click();
        const editor=document.getElementById("terminalPromptText");
        editor.value=${JSON.stringify(multiline)};
        editor.dispatchEvent(new Event("input"));
        if (${shortcut}) {
          editor.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true}));
        } else {
          document.getElementById("terminalPromptInsert").click();
        }
      })()`);
      await until(() => cdp.eval('!document.getElementById("terminalPrompt").open && document.getElementById("terminalPromptText").value==="" && !document.getElementById("terminalPromptText").readOnly'), "multiline prompt inserted");
    }
    const pasteMarker = "PASTE_OK:" + Buffer.from(multiline).toString("base64");
    await until(async () => (await buffers()).join("\n").split(pasteMarker).length === 3,
      "Ctrl+Enter and default button preserve Korean, blank lines and indentation through ConPTY")
      .catch(async (error) => { throw new Error(error.message + "\n" + (await buffers()).join("\n")); });
    const submittedMultiline = "SUBMIT_OK:" + Buffer.from(multiline).toString("base64") + ":END";
    assert.equal((await buffers()).join("\n").split(submittedMultiline).length, 2, "insert-only does not submit");
    await cdp.eval('document.getElementById("terminalPromptSend").click()');
    await until(async () => (await buffers()).join("\n").split(submittedMultiline).length === 3,
      "empty editor submits the existing terminal draft without pasting it twice");
    await until(() => cdp.eval('!document.getElementById("terminalPromptText").readOnly'), "submission finished");
    await cdp.eval("writeToPane(state.selectedPaneId,'#paste-off#')");
    await until(async () => !(await cdp.eval("state.paneViews.get(state.selectedPaneId).term.modes.bracketedPasteMode")), "bracketed paste disabled");
    const unsupported = await cdp.eval(`(async () => {
      document.getElementById("terminalPromptExpand").click();
      const editor=document.getElementById("terminalPromptText");
      editor.value=${JSON.stringify(multiline)};
      editor.dispatchEvent(new Event("input"));
      document.getElementById("terminalPromptInsert").click();
      const preserved=document.getElementById("terminalPrompt").open
        && editor.value===${JSON.stringify(multiline)} && !document.getElementById("terminalPromptError").hidden;
      document.getElementById("terminalPromptSingleLine").click();
      return preserved;
    })()`);
    assert.equal(unsupported, true, "unsupported paste retains the draft and allows explicit single-line insertion");
    await until(() => cdp.eval('!document.getElementById("terminalPrompt").open'), "explicit single-line insertion");
    await until(async () => (await buffers()).join("\n").split("INPUT_OK:" + input).length === 3, "explicit single-line prompt received");
    await cdp.eval('document.getElementById("terminalPromptSend").click()');
    await until(async () => (await buffers()).join("\n").split(submittedInput).length === 3, "submit flattened prompt");
    await until(() => cdp.eval('!document.getElementById("terminalPromptText").readOnly'), "flattened submission finished");
    await cdp.eval(`(() => {
      const editor=document.getElementById("terminalPromptText");
      editor.value=${JSON.stringify(input)};
      editor.dispatchEvent(new Event("input"));
      document.getElementById("terminalPromptSend").click();
      document.getElementById("terminalPromptSend").click();
    })()`);
    await until(async () => (await buffers()).join("\n").split(submittedInput).length === 4, "send button submits once despite double click");
    await until(() => cdp.eval('!document.getElementById("terminalPromptText").readOnly'), "send button finished");

    const copied = await cdp.eval(`(async () => {
      const term=state.paneViews.get(state.selectedPaneId).term;
      const link="https://example.test/authorize?code_challenge="+"A1_b-9%2F".repeat(term.cols)+"&state=test";
      const lines=link.match(new RegExp(".{1,"+(term.cols-1)+"}", "g"));
      await new Promise(resolve=>term.write("\\r\\n"+lines.join("\\r\\n")+"\\r\\n",resolve));
      const buffer=term.buffer.active;
      const first=buffer.baseY+buffer.cursorY-lines.length;
      term.select(0,first,lines.length*term.cols+3);
      const raw=term.getSelection();
      let copied;
      const write=window.wincmux.clipboardWrite;
      window.wincmux.clipboardWrite=async text=>{ copied=text; };
      try {
        const key=new KeyboardEvent("keydown",{key:"c",ctrlKey:true,bubbles:true,cancelable:true});
        term.textarea.dispatchEvent(key);
        const native=new ClipboardEvent("copy",{clipboardData:new DataTransfer(),bubbles:true,cancelable:true});
        term.textarea.dispatchEvent(native);
        const shortcut=copied===link;
        copied=undefined;
        handleContextAction({action:"copy"});
        const context=copied===link;
        term.clearSelection();
        await new Promise(resolve=>term.write("한글  A\\r\\n  다음 줄\\r\\n",resolve));
        term.select(0,buffer.baseY+buffer.cursorY-2,term.cols+9);
        const plain=term.getSelection();
        term.textarea.dispatchEvent(new KeyboardEvent("keydown",{key:"c",ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
        const plainPreserved=plain.includes("\\n") && copied===plain;
        term.clearSelection();
        await new Promise(resolve=>term.write("https://example.test/a\\r\\nnext\\r\\n",resolve));
        term.select(0,buffer.baseY+buffer.cursorY-2,term.cols+4);
        const separate=term.getSelection();
        handleContextAction({action:"copy"});
        return { shortcut, context, native:native.clipboardData.getData("text/plain")===link,
          rawHasNewlines:raw.includes("\\n"), cancelled:key.defaultPrevented,
          plain:plainPreserved, separate:separate.includes("\\n") && copied===separate };
      } finally {
        window.wincmux.clipboardWrite=write;
        term.clearSelection();
      }
    })()`);
    assert.deepEqual(copied, { shortcut: true, context: true, native: true, rawHasNewlines: true, cancelled: true, plain: true, separate: true });
    if (process.env.WINCMUX_TEST_COPY_ONLY === "1") return { target: "tauri", copy: copied };

    const verifyAssets = await cdp.eval(`(async () => {
      const path=${JSON.stringify(temp)};
      const {asset}=await window.wincmux.inputAssetCreateText(path,{title:"메모",content:"한글  A\\n  B"});
      const read=await window.wincmux.inputAssetRead(path,asset.id);
      await window.wincmux.inputAssetDelete(path,asset.id);
      await window.wincmux.agentAssetCreate(path,"AGENTS.md","agents");
      const scan=await window.wincmux.agentAssetsScan(path);
      return read.content==="한글  A\\n  B" && scan.items.some(item=>item.relativePath==="AGENTS.md" && item.exists);
    })()`);
    assert.equal(verifyAssets, true);

    }
    async function measure(panes) {
      const start = Date.now();
      await cdp.eval("[...state.paneViews.values()].forEach(v=>writeToPane(v.paneId,'#burst#'))");
      await until(async () => (await recent()).filter((text) => text.includes("2999|" + output)).length === panes,
        "all PTYs completed output", 30000);
      const burstMs = Date.now() - start;
      for (const buffer of await buffers()) {
        const rows = buffer.split("\n").filter((line) => /^\d{4}\|/.test(line));
        assert.equal(rows.length, 3000, JSON.stringify({paneRows:rows.length,first:rows.slice(0,5),last:rows.slice(-5)}));
        for (let i = 0; i < rows.length; i++) assert.equal(rows[i], String(i).padStart(4, "0") + "|" + output);
      }
      const latency = await cdp.eval(`(async () => {
        const v=[...state.paneViews.values()][0], results=[];
        await selectPane(v.paneId,{persist:false,focusTerm:false});
        for(let i=0;i<30;i++){
          const marker="PONG:"+i+":END", start=performance.now();
          const duration=await new Promise((resolve,reject)=>{
            const timeout=setTimeout(()=>{ sub.dispose(); reject(new Error(marker)); },3000);
            const sub=v.term.onWriteParsed(()=>{
              const b=v.term.buffer.active,y=b.baseY+b.cursorY;
              if([y-1,y].some(row=>b.getLine(row)?.translateToString(true).includes(marker))){
                clearTimeout(timeout); sub.dispose(); resolve(performance.now()-start);
              }
            });
            writeToPane(v.paneId,"#ping:"+i+"#");
          });
          results.push(duration);
        }
        return results.sort((a,b)=>a-b);
      })()`, 60000);
      await sleep(2500);
      const rows = await cdp.eval("rpc('session.list',{workspace_id:state.selectedWorkspaceId})");
      const fixtureIds = rows.sessions.filter((item) => sessions.has(item.id)).map((item) => item.pid);
      const coreInfo = await cdp.eval("rpc('runtime.info',{})").catch(() => null);
      return { panes, exactOutputRows: panes * 3000, burstMs, roundTripP95Ms: Math.round(latency[28] * 10) / 10,
        ...privateMemory(child.pid, fixtureIds, coreInfo?.pid) };
    }
    const one = await measure(1);
    const firstWorkspace = await cdp.eval("state.selectedWorkspaceId");
    const other = await cdp.eval("rpc('workspace.create'," + JSON.stringify({ name: "Replay", path: temp, backend: "custom" }) + ")");
    await cdp.eval("loadWorkspaces().then(()=>switchWorkspace(" + JSON.stringify(other.workspace.id) + "))");
    await cdp.eval("rpc('session.write'," + JSON.stringify({ session_id: firstSession, data: "#ping:99#" }) + ")");
    await sleep(120);
    await cdp.eval("switchWorkspace(" + JSON.stringify(firstWorkspace) + ")");
    await until(async () => (await recent()).some((text) => text.includes("PONG:99:END")), "workspace output replay");
    await close(firstSession);
    sessions.delete(firstSession);
    for (let i = 1; i < 6; i++) {
      await cdp.eval(`(async()=>{
        const panes=[...state.paneViews.values()].map(v=>({id:v.paneId,w:v.host.clientWidth,h:v.host.clientHeight}));
        panes.sort((a,b)=>b.w*b.h-a.w*a.h);
        const v=panes[0];
        await splitPaneInternal(v.id,v.w>v.h*1.7?"horizontal":"vertical",{autoStartIfMissing:false});
      })()`);
      await sleep(100);
    }
    for (const pane of await cdp.eval("[...state.paneViews.keys()]")) await start(pane);
    await until(async () => (await recent()).filter((text) => text.includes("FIXTURE_READY")).length === 6, "six PTY fixtures");
    await sleep(700);
    const six = await measure(6);
    if (process.env.WINCMUX_PERF_ONLY === "1") return { target: "tauri", measurements: [one, six] };
    const composerChecks = await cdp.eval(`(async () => {
      const panes=[...state.paneViews.keys()];
      const editor=document.getElementById("terminalPromptText");
      const composer=document.getElementById("terminalComposer");
      for (const [index,pane] of panes.entries()) {
        await selectPane(pane,{persist:false,focusTerm:false});
        if (composer.parentElement.dataset.paneId!==pane || composer.hidden) throw new Error("Composer target mismatch");
        editor.value="초안 "+index+"\\n  한글";
        editor.dispatchEvent(new Event("input"));
      }
      for (const [index,pane] of panes.entries()) {
        await selectPane(pane,{persist:false,focusTerm:false});
        if (editor.value!=="초안 "+index+"\\n  한글") throw new Error("Pane draft lost");
      }
      document.getElementById("terminalPromptExpand").click();
      if (!document.getElementById("terminalPrompt").open || editor.value!=="초안 5\\n  한글") throw new Error("Expanded draft lost");
      await selectPane(panes[0],{persist:false,focusTerm:false});
      if (editor.value!=="초안 5\\n  한글") throw new Error("Expanded editor changed its target");
      document.getElementById("terminalPromptClose").click();
      await new Promise(resolve=>requestAnimationFrame(resolve));
      if (editor.closest("#terminalComposer")!==composer || editor.value!=="초안 0\\n  한글") throw new Error("Composer did not restore selected draft from dialog");
      await selectPane(panes[5],{persist:false,focusTerm:false});
      const split=await splitPaneInternal(state.selectedPaneId,"vertical",{autoStartIfMissing:false});
      await selectPane(split.first,{persist:false,focusTerm:false});
      if (editor.value!=="초안 5\\n  한글") throw new Error("Split lost original draft");
      await selectPane(split.second,{persist:false,focusTerm:false});
      if (editor.value!=="" || !editor.disabled) throw new Error("New pane inherited draft or permits sending without a session");
      await onClosePane(split.second);
      await selectPane(split.first,{persist:false,focusTerm:false});
      if (editor.value!=="초안 5\\n  한글") throw new Error("Closing sibling lost draft");
      await switchWorkspace(${JSON.stringify(other.workspace.id)});
      await switchWorkspace(${JSON.stringify(firstWorkspace)});
      await selectPane(split.first,{persist:false,focusTerm:false});
      if (editor.value!=="초안 5\\n  한글") throw new Error("Workspace switch lost draft");
      const host=state.paneViews.get(split.first).host;
      const bounds=host.getBoundingClientRect();
      const composerBounds=composer.getBoundingClientRect();
      if (bounds.height<=0 || (composerBounds.height>0 && composerBounds.top<bounds.bottom-1)) throw new Error("Composer overlaps terminal");
      return {panes:panes.length,sharedComposer:document.querySelectorAll("#terminalComposer").length,
        drafts:true,split:true,close:true,expanded:true,workspaces:true};
    })()`);
    assert.equal(composerChecks.sharedComposer, 1);
    const agentChecks = await (async () => {
      const sid = await cdp.eval("state.paneSessions[state.selectedPaneId]");
      const sendStatus = async (status) => {
        await cdp.eval("rpc('session.write'," + JSON.stringify({session_id:sid,data:`#status:${status}#`}) + ")");
        await until(() => cdp.eval(`state.agentStates.get(${JSON.stringify(sid)})?.state === ${JSON.stringify(status)}`), "agent status " + status);
      };
      await sendStatus("working");
      await cdp.eval("switchWorkspace(" + JSON.stringify(other.workspace.id) + ")");
      await sendStatus("blocked");
      assert.equal(await cdp.eval(`state.paneMeta.size ? [...state.paneMeta.values()].some(m=>m.statusEl.parentElement.querySelector('button.agent-blocked')) : false`), false);
      assert.ok((await cdp.eval("document.querySelector('.ws-agent-summary:not([hidden])')?.textContent")).includes("입력 필요 1"));
      await cdp.eval(`rpc('agent.acknowledge',{session_id:${JSON.stringify(sid)},revision:state.agentStates.get(${JSON.stringify(sid)}).revision})`);
      assert.equal(await cdp.eval(`state.agentStates.get(${JSON.stringify(sid)}).state`), "blocked");
      await cdp.eval("switchWorkspace(" + JSON.stringify(firstWorkspace) + ")");
      await cdp.eval(`selectPane(Object.keys(state.paneSessions).find(p=>state.paneSessions[p]===${JSON.stringify(sid)}),{persist:false,focusTerm:false})`);
      await sendStatus("done");
      const { data: statusImage } = await cdp.request("Page.captureScreenshot", { format: "png", fromSurface: true });
      fs.writeFileSync(path.join(os.tmpdir(), "wincmux-agent-status.png"), Buffer.from(statusImage, "base64"));
      const badge = await cdp.eval(`(() => { const m=state.paneMeta.get(state.selectedPaneId); const b=m.statusEl.parentElement.querySelector('.agent-status'); return {text:b.textContent,hidden:b.hidden,disabled:b.disabled}; })()`);
      assert.equal(badge.hidden, false);
      assert.equal(badge.disabled, false);
      assert.equal(await cdp.eval("state.paneMeta.get(state.selectedPaneId).statusEl.parentElement.querySelector('.agent-status').tagName"), "BUTTON");
      assert.ok(badge.text.includes("미확인"));
      const revision = await cdp.eval(`state.agentStates.get(${JSON.stringify(sid)}).revision`);
      await sendStatus("working");
      await sendStatus("done");
      await cdp.eval(`rpc('agent.acknowledge',{session_id:${JSON.stringify(sid)},revision:${revision}})`);
      assert.equal(await cdp.eval(`state.agentStates.get(${JSON.stringify(sid)}).state`), "done");
      // The test window is hidden; simulate focus only while exercising the user's badge action.
      await cdp.eval(`(() => {
        Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
        Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true});
        state.paneMeta.get(state.selectedPaneId).statusEl.parentElement.querySelector('.agent-status').click();
      })()`);
      await until(() => cdp.eval(`state.agentStates.get(${JSON.stringify(sid)}).state === 'idle'`), "badge acknowledges result");
      await cdp.eval("delete document.hidden; delete document.hasFocus");
      assert.ok((await cdp.eval("state.paneMeta.get(state.selectedPaneId).statusEl.parentElement.querySelector('.agent-status').textContent")).includes("확인 완료"));
      await cdp.eval("loadAgentStates()");
      assert.equal(await cdp.eval(`state.agentStates.get(${JSON.stringify(sid)}).state`), "idle");
      return {osc:true,workspaceSummary:true,paneBadge:true,blockedPreserved:true,staleAcknowledgement:true,snapshot:true};
    })();
    let cliVersions;
    if (process.env.WINCMUX_TEST_CLI === "1") {
      const run = await cdp.eval(`rpc('session.run',{
        workspace_id:state.selectedWorkspaceId,cmd:'powershell.exe',cwd:${JSON.stringify(temp)},
        args:['-NoProfile','-NonInteractive','-Command','codex --version; if (!$?) { exit 1 }; claude --version']
      })`);
      const id = run.session.session_id;
      sessions.add(id);
      cliVersions = await until(async () => {
        const tail = await cdp.eval("rpc('session.tail'," + JSON.stringify({ session_id: id, max_bytes: 8192 }) + ")");
        const match = tail.output.match(/(codex-cli\s+[\d.]+)[\s\S]*?([\d.]+\s+\(Claude Code\))/i);
        return match && match.slice(1);
      }, "installed Codex and Claude CLI version commands");
    }
    return { target: "tauri", exactPrompt: input, measurements: [one, six], composerChecks, agentChecks, cliVersions };
  } finally {
    if (cdp) {
      for (const sid of sessions) await close(sid).catch(() => {});
      await cdp.eval("rpc('runtime.shutdown_all',{confirmed:true})").catch(() => {});
      await cdp.eval("window.__TAURI__.window.getCurrentWindow().close()").catch(() => {});
      cdp.close();
    }
    if (child && child.exitCode === null) {
      await sleep(500);
      if (child.exitCode === null) child.kill();
    }
    await sleep(500);
    const resolved = fs.realpathSync(temp);
    const tempRoot = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() === tempRoot.toLowerCase() && path.basename(resolved).startsWith("wincmux-compare-")) {
      try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); } catch {}
    }
  }
}

module.exports = { until, portNumber, connect, privateMemory, pipeHealth };
if (require.main === module) {
const args = process.argv.slice(2);
const screenshots = args.includes("--screenshots");
const executable = args.find((arg) => arg !== "--screenshots")
  ?? path.join(root, "apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe");
if (!globalThis.WebSocket) {
  console.error("Usage: node --experimental-websocket benchmark.cjs [executable] [--screenshots]");
  process.exit(2);
}
benchmark(path.resolve(executable), screenshots).then(
  (result) => { console.log(JSON.stringify(result, null, 2)); process.exit(0); },
  (error) => { console.error(error); process.exit(1); }
);

}
