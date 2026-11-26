const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { until, portNumber, connect } = require("./benchmark.cjs");

async function run() {
  const root = path.resolve(__dirname,"../../..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),"wincmux-accounts-"));
  const artifacts = path.join(root,"artifacts","account-profiles");
  fs.mkdirSync(artifacts,{recursive:true});
  const port = await portNumber();
  const fixtureDir = path.join(temp,"bin");
  fs.mkdirSync(fixtureDir);
  fs.writeFileSync(path.join(fixtureDir,"claude.cmd"),'@echo off\r\nif "%1"=="" if exist "%CLAUDE_CONFIG_DIR%\\qa-user.txt" (node "%~dp0qa-claude.cjs" & exit /b 0)\r\nif "%2"=="status" (echo {"loggedIn":true,"email":"local@example.org"} & exit /b 0)\r\nexit /b 1\r\n');
  fs.writeFileSync(path.join(fixtureDir,"qa-claude.cjs"),`
    const fs = require("node:fs"), path = require("node:path");
    const dir = process.env.CLAUDE_CONFIG_DIR;
    const config = JSON.parse(fs.readFileSync(path.join(dir,".claude.json")));
    if (!config.hasCompletedOnboarding) throw Error("Interactive onboarding required");
    console.log(config.oauthAccount.emailAddress);
    if (process.env.WINCMUX_QA_CLAUDE_EXE) {
      const output = require("node:child_process").execFileSync(process.env.WINCMUX_QA_CLAUDE_EXE,["auth","status","--json"],{
        env:{...process.env,HTTP_PROXY:"http://127.0.0.1:1",HTTPS_PROXY:"http://127.0.0.1:1",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1"}, timeout:20000
      });
      const status = JSON.parse(output);
      if (status.loggedIn && status.storedClaudeAiLogin) console.log("IDENTITY_"+status.email);
    }
  `);
  fs.writeFileSync(path.join(fixtureDir,"codex.cmd"),'@echo off\r\nif "%2"=="--device-auth" (echo LOGIN_TERMINAL_READY & exit /b 0)\r\nif exist "%CODEX_HOME%\\auth.json" exit /b 0\r\nexit /b 1\r\n');
  const child = spawn(path.join(root,"apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe"),["--benchmark-hidden"],{
    windowsHide:true,stdio:"ignore",env:{...process.env, Path:fixtureDir+";"+process.env.Path, ANTHROPIC_API_KEY:"fixture-only",OPENAI_API_KEY:"fixture-only",
      WINCMUX_TAURI_DATA_DIR:path.join(temp,"data"),WINCMUX_TAURI_PIPE:"\\\\.\\pipe\\wincmux-accounts-"+randomUUID(),
      WEBVIEW2_USER_DATA_FOLDER:path.join(temp,"webview"),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:"--remote-debugging-port="+port+" --remote-debugging-address=127.0.0.1 --disable-background-timer-throttling"}
  });
  let cdp;
  try {
    cdp=await connect(port,child);
    const ev=code=>cdp.eval(code);
    await until(()=>ev('typeof state!=="undefined" && state.bootstrapReady && !!window.wincmuxAccounts'),"app");
    if (process.argv.includes("--docker")) {
      await require("./account-docker-ui.cjs")(cdp,port,child,artifacts);
      return;
    }
    const ws=(await ev("rpc('workspace.create',"+JSON.stringify({name:"결제 서비스",path:temp,backend:"custom"})+")")).workspace.id;
    await ev("loadWorkspaces().then(()=>switchWorkspace("+JSON.stringify(ws)+"))");
    await until(()=>ev('document.querySelectorAll(".account-launch-pair").length>=2'),"launch buttons");
    const ids={claude:randomUUID(),codex:randomUUID()};
    const probe = (tool,id) => ev("rpc('account.status',"+JSON.stringify({tool,account_profiles:{[tool]:id}})+")");
    assert.deepEqual(await probe("claude",ids.claude),{authenticated:true,email:"local@example.org"});
    assert.equal((await probe("codex",ids.codex)).authenticated,false);
    const claim = Buffer.from(JSON.stringify({email:"local@example.org"})).toString("base64url");
    fs.writeFileSync(path.join(temp,"data","accounts","codex",ids.codex,"auth.json"),JSON.stringify({tokens:{id_token:"test."+claim+".fixture"}}));
    assert.deepEqual(await probe("codex",ids.codex),{authenticated:true,email:"local@example.org"});
    await ev("window.qaCtx="+JSON.stringify({scope:"local",workspace:ws,label:"결제 서비스"})+";window.qaIds="+JSON.stringify(ids));
    await ev(`for(const tool of ["claude","codex"]){const key=parts=>"wincmux.accounts.v1."+JSON.stringify(parts);localStorage.setItem(key(["local",tool]),JSON.stringify([{id:qaIds[tool],name:"개인 프로젝트 전용 프로필".repeat(4),duplicate:tool==="claude"?"환경 기본":""}]));localStorage.setItem(key(["local",qaCtx.workspace,tool]),JSON.stringify(qaIds[tool]));} localStorage.setItem("wincmux.ui.language","ko");`);
    await ev('document.getElementById("localAccountManager").click()');
    await until(()=>ev('!!document.querySelector(".account-dialog[open] .account-row")'),"manager");
    await until(()=>ev('wincmuxLocalAccounts.selection(qaCtx.workspace).claude===qaIds.claude').catch(()=>false),"restore existing Claude profile even when default has same email");
    const sizes=[[2560,1440],[1920,1080],[1440,900],[1180,740],[960,640],[900,640],[760,580],[640,640],[420,640],[360,620]];
    async function resize(width,height) {
      await cdp.request("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      await ev("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    }
    async function measure(label,width,height) {
      await resize(width,height);
      const errors=await ev(`(()=>{const box=document.querySelector(".account-dialog[open]"); const r=box.getBoundingClientRect();const nodes=[...box.querySelectorAll("button,select,input")].filter(n=>n.offsetWidth);const rects=nodes.map(n=>n.getBoundingClientRect());return [r.left<0||r.right>innerWidth+1||r.top<0||r.bottom>innerHeight+1,box.scrollWidth>box.clientWidth+1,rects.some((a,i)=>rects.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1))]})()`);

      const shot=await cdp.request("Page.captureScreenshot",{format:"png",fromSurface:true});
      fs.writeFileSync(path.join(artifacts,label+"-"+width+".png"),Buffer.from(shot.data,"base64"));
      assert.deepEqual(errors,[false,false,false],label+" "+width+" "+JSON.stringify(errors));
    }
    for(const [w,h] of sizes) await measure("manager",w,h);
    await ev('document.querySelector(".account-dialog section > button").click()');
    for (const width of [360,420,760,1440,2560]) await measure("registration",width,740);
    await ev('document.querySelector(".account-dialog").close();wincmuxAccounts.choose(qaCtx,"codex",qaIds.codex,()=>{},true,document.querySelector(".account-launch-pair .account-trigger"))');
    await measure("switch",420,640);
    await ev('document.querySelector(".account-dialog section button:last-child").click()');
    await ev('document.querySelector(".account-dialog section button:last-child").click()');
    await measure("confirm",420,640);
    await ev('document.querySelector(".account-dialog").close();wincmuxAccounts.workspace(qaCtx)');
    await measure("defaults",420,640);
    await ev('document.querySelector(".account-dialog").close()');
    for (const [w,h] of sizes) {
      await resize(w,h);
      const geometry = await ev(`(()=>{const rect=n=>n.getBoundingClientRect();const main=rect(document.querySelector(".panel-center"));const manager=rect(document.querySelector("#localAccountManager"));
        const pair=[...document.querySelectorAll(".account-launch-pair")].every(n=>{const [a,b]=[...n.children].map(rect);return a.right<=b.left+1 && b.width>=30 && b.right<=main.right+1});
        return {pane:main.width,manager:manager.width>=30&&manager.left>=0&&manager.right<=innerWidth+1,pair,scroll:document.documentElement.scrollWidth-innerWidth}})()`);
      const fits = geometry.manager && geometry.pair && geometry.pane>=240 && geometry.scroll<=1;
      if (!fits || [360,420,1920,2560].includes(w)) {
        const shot=await cdp.request("Page.captureScreenshot",{format:"png"});
        fs.writeFileSync(path.join(artifacts,"local-"+w+".png"),Buffer.from(shot.data,"base64"));
      }
      assert.ok(fits,w+" main layout "+JSON.stringify(geometry));
    }
    await ev('toggleWorkspacePanel()');
    assert.ok(await ev('!document.querySelector("#appGrid").classList.contains("left-collapsed")'),"compact workspace drawer opens");
    await ev('toggleNotificationPanel()');
    assert.ok(await ev('document.querySelector("#appGrid").classList.contains("left-collapsed") && !document.querySelector("#appGrid").classList.contains("right-collapsed")'),"compact drawers do not overlap");
    await resize(1920,1080);
    assert.ok(await ev('!document.querySelector("#appGrid").classList.contains("left-collapsed") && !document.querySelector("#appGrid").classList.contains("right-collapsed")'),"wide layout restores panels");
    const check = "if ((Split-Path -Leaf $env:CLAUDE_CONFIG_DIR) -eq '"+ids.claude+"' -and (Split-Path -Leaf $env:CODEX_HOME) -eq '"+ids.codex+"' -and !$env:ANTHROPIC_API_KEY -and !$env:OPENAI_API_KEY) {Write-Output 'PROFILE_PAIR_OK'} else {Write-Output 'PROFILE_PAIR_FAIL'}; Start-Sleep 4";
    assert.deepEqual(await ev("wincmuxLocalAccounts.selection(qaCtx.workspace)"),ids);
    const sid=await ev(`startSessionForPane(state.selectedPaneId,{cmd:"powershell.exe",args:["-NoProfile","-Command",${JSON.stringify(check)}]})`);
    await until(async()=>{const out=(await ev("rpc('session.tail',{session_id:"+JSON.stringify(sid)+"})")).output;return out.includes("PROFILE_PAIR_OK")},"both profiles inherited");
    const openManager = async () => {
      await ev('document.getElementById("localAccountManager").click()');
      await until(()=>ev('!!document.querySelector(".account-dialog[open] nav")'),"profile manager");
      await ev('document.querySelector(".account-dialog[open] nav button:last-child").click()');
    };
    await openManager();
    await ev('document.querySelector(".account-dialog section > button").click();document.querySelector(".account-dialog input").value="Retry sign-in";document.querySelector(".account-dialog form").requestSubmit()');
    async function waitForLogin(previous) {
      await until(async()=>{
        const detail=await ev('document.querySelector(".account-dialog[open] [role=alert]")?.textContent');
        if(detail) throw Error(detail);
        return await ev('!document.querySelector(".account-dialog[open]")');
      },"sign-in terminal opened");
      let session, marker = false, visible = false;
      await until(async()=>{
        session=await ev('state.paneSessions[state.selectedPaneId]');
        if (!session || session===previous) return false;
        const output=await ev("rpc('session.tail',{session_id:"+JSON.stringify(session)+"})");
        marker = output.output.includes("LOGIN_TERMINAL_READY");
        visible = await ev('state.paneCards.get(state.selectedPaneId)?.getBoundingClientRect().width > 0');
        return marker && visible;
      },"visible Codex device login terminal",30000).catch(err=>{throw Error(err.message+" session="+!!session+" fresh="+(session!==previous)+" marker="+marker+" visible="+visible)});
      return session;
    }
    const first=await waitForLogin(sid);
    await ev("rpc('session.close',{session_id:"+JSON.stringify(first)+"})");
    await openManager();
    await ev('[...document.querySelectorAll(".account-row")].find(row=>row.querySelector("strong").textContent==="Retry sign-in").querySelector("button:nth-of-type(2)").click()');
    await waitForLogin(first);
    await ev('localStorage.removeItem("wincmux.accounts.v1."+JSON.stringify(["local","claude"]));document.getElementById("localAccountManager").click()');
    await until(()=>ev('!!document.querySelector(".account-environment")'),"default account is separate");
    await ev('document.querySelector(".account-environment button").click()');
    await until(()=>ev('document.querySelector(".account-environment p").textContent==="local@example.org"'),"default CLI email");
    assert.equal(await ev('document.querySelectorAll(".account-row").length'),0);
    await ev('document.querySelector(".account-dialog section > button").click();document.querySelector(".account-dialog input").value="My first profile";document.querySelector(".account-dialog input[type=email]").value="local@example.org";document.querySelector(".account-dialog form").requestSubmit()');
    await until(()=>ev('!document.querySelector(".account-dialog[open]")'),"first named profile accepted");
    await until(()=>ev('JSON.parse(localStorage.getItem("wincmux.accounts.v1."+JSON.stringify(["local","claude"]))).some(row=>row.name==="My first profile" && !row.pending && !row.duplicate && !row.mismatch)'),"profile matching local account is available",30000);
    const firstClaude = await ev('JSON.parse(localStorage.getItem("wincmux.accounts.v1."+JSON.stringify(["local","claude"])))[0].id');
    const secondClaude = randomUUID();
    for (const [id,email] of [[firstClaude,"account-a@example.invalid"],[secondClaude,"account-b@example.invalid"]]) {
      const dir=path.join(temp,"data","accounts","claude",id);
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,".claude.json"),JSON.stringify({projects:{fixture:{hasTrustDialogAccepted:false}},oauthAccount:{accountUuid:randomUUID(),organizationUuid:randomUUID(),emailAddress:email}}));
      fs.writeFileSync(path.join(dir,".credentials.json"),JSON.stringify({claudeAiOauth:{accessToken:"fixture-only",refreshToken:"fixture-only",expiresAt:Date.now()+86400000,scopes:["user:inference","user:profile"]}}));
      fs.writeFileSync(path.join(dir,"qa-user.txt"),email);
    }
    const key=parts=>"wincmux.accounts.v1."+JSON.stringify(parts);
    const listKey=JSON.stringify(key(["local","claude"]));
    const defaultKey=JSON.stringify(key(["local",ws,"claude"]));
    await ev('localStorage.removeItem('+defaultKey+'); const rows=JSON.parse(localStorage.getItem('+listKey+'));rows.push({id:'+JSON.stringify(secondClaude)+',name:"Account B"});localStorage.setItem('+listKey+',JSON.stringify(rows))');
    assert.equal(await ev('wincmuxLocalAccounts.selection(qaCtx.workspace).claude'),firstClaude);
    for (const [id,email] of [[firstClaude,"account-a@example.invalid"],[secondClaude,"account-b@example.invalid"],[firstClaude,"account-a@example.invalid"]]) {
      await ev('localStorage.setItem('+defaultKey+','+JSON.stringify(JSON.stringify(id))+')');
      const split=await ev('splitPaneInternal(state.selectedPaneId,"horizontal",{autoStartIfMissing:false})');
      const session=await ev('startShellCommandForPane('+JSON.stringify(split.second)+',"claude",{silent:true})');
      const tail=()=>ev("rpc('session.tail',{session_id:"+JSON.stringify(session)+"})");
      await until(async()=>(await tail()).output.includes(email),"reused Claude profile "+email,30000);
      if (process.env.WINCMUX_QA_CLAUDE_EXE) {
        await until(async()=>(await tail()).output.includes("IDENTITY_"+email),"installed CLI reads "+email,30000);
      }
    }
    for (const id of [firstClaude,secondClaude]) {
      const config=JSON.parse(fs.readFileSync(path.join(temp,"data","accounts","claude",id,".claude.json")));
      assert.equal(config.hasCompletedOnboarding,true);
      assert.equal(config.projects.fixture.hasTrustDialogAccepted,false);
    }
    await ev('localStorage.setItem('+defaultKey+',"null")');
    assert.equal(await ev('wincmuxLocalAccounts.selection(qaCtx.workspace).claude'),null);
    console.log("Passed profile inheritance and desktop-to-narrow WebView layout checks:",artifacts);
  } finally {
    if(cdp){await cdp.eval("rpc('runtime.shutdown_all',{confirmed:true})").catch(()=>{});cdp.close();}
    if(child.exitCode===null)child.kill();
  }
}
run().then(()=>process.exit(0),err=>{console.error(err);process.exit(1)});
