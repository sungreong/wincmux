const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { connect, until } = require("./benchmark.cjs");

module.exports = async function checkDockerProfiles(main, port, app, artifacts) {
  const docker = (...args) => execFileSync("docker", args, {windowsHide:true,encoding:"utf8"}).trim();
  const id = docker("run","--pull=never","--network","none","--rm","-d","python:3.12-slim","sleep","600");
  let remote;
  try {
    const fixture = [
      "#!/bin/sh",
      'profile=$CODEX_HOME; case "$0" in */claude) profile=$CLAUDE_CONFIG_DIR;; esac',
      'case "$1:$2" in',
      'login:status|auth:status) test -f "$profile/mail" && test ! -f "$profile/test-expired" || exit 1; printf \'{"loggedIn":true,"email":"%s"}\\n\' "$(cat "$profile/mail")"; exit 0;;',
      'login:--device-auth|auth:login) email=$(cat /tmp/login-email 2>/dev/null || echo "${profile##*/}@example.org"); echo "$email" > "$profile/mail";',
      'python3 -c \'import sys,base64,json; payload=base64.urlsafe_b64encode(json.dumps({"email":sys.argv[1]}).encode()).decode();print(json.dumps({"tokens":{"id_token":"test."+payload+".fixture"}}))\' "$email" > "$profile/auth.json"; exit 0;;',
      'esac',
      'printf "%s" "$profile" > "/tmp/wincmux-received-${0##*/}"',
      'printf "PROFILE=%s\\n" "${profile##*/}"',
      'read -r answer',
    ].join("\n");
    for (const tool of ["codex","claude"]) execFileSync("docker",["exec","-i",id,"sh","-c","cat > /usr/local/bin/"+tool+" && chmod 755 /usr/local/bin/"+tool],{input:fixture,windowsHide:true});
    await main.eval('window.__TAURI__.core.invoke("open_docker_workspace")');
    remote=await connect(port,app,page=>page.url.includes("ssh-workspace.html"));
    const ev=code=>remote.eval(code);
    await until(()=>ev('Array.from(document.querySelector("#container")?.options??[]).some(o=>o.value==='+JSON.stringify(id)+')'),"test container");
    await until(()=>ev('!document.querySelector("#connect").disabled'),"container discovery complete");
    await ev('(()=>{const c=document.querySelector("#container");c.value='+JSON.stringify(id)+';c.dispatchEvent(new Event("change"));document.querySelector("#directory").value="/tmp";document.querySelector("#openTarget").click()})()');
    await until(async()=>{const state=await ev('({ready:!!document.querySelector(".pane") && !document.querySelector("#newTerminal").disabled,error:document.querySelector("#notice").textContent})');if (state.error)throw Error(state.error);return state.ready;},"Docker shell",30000);
    await ev('document.querySelector("#accountManager").click()');
    await until(()=>ev('!!document.querySelector(".account-dialog[open]")'),"server account manager");
    await ev('document.querySelector(".account-dialog nav button:last-child").click(); document.querySelector(".account-dialog section > button").click()');
    await ev('document.querySelector(".account-dialog input").value="회사 Codex";document.querySelector(".account-dialog form").requestSubmit()');
    await until(()=>ev('document.querySelectorAll(".pane").length===2 && !document.querySelector("#newTerminal").disabled'),"profile login terminal");
    await ev('document.querySelector("#accountManager").click()');
    await ev('document.querySelector(".account-dialog[open] nav button:last-child").click();document.querySelector(".account-dialog[open] section > button").click()');
    await ev('document.querySelector(".account-dialog[open] input").value="개인 Codex";document.querySelector(".account-dialog[open] form").requestSubmit()');
    await until(()=>ev('document.querySelectorAll(".pane").length===3 && !document.querySelector("#newTerminal").disabled'),"second login terminal");
    await until(()=>ev('Object.keys(localStorage).filter(k=>k.startsWith("wincmux.accounts.v1.")).every(k=>{const v=JSON.parse(localStorage.getItem(k));return !Array.isArray(v)||!v.some(row=>row.pending)})'),"login identity verified",30000);
    await ev('document.querySelector(".environment-tab button:nth-child(2)").click()');
    await until(()=>ev('document.querySelectorAll(".account-dialog[open] select").length===2'),"workspace defaults");
    const profileId=await ev('(()=>{const s=document.querySelectorAll(".account-dialog select")[1];s.selectedIndex=1;document.querySelector(".account-dialog section button").click();return s.value})()');
    assert.match(profileId,/^[a-f0-9-]{36}$/);
    await ev('document.querySelector("#newTerminal").click()');
    await until(()=>ev('document.querySelectorAll(".pane").length===4 && !document.querySelector("#newTerminal").disabled'),"profiled shell");
    await ev('(()=>{const s=[...document.querySelectorAll(".remote-shell-composer")].at(-1);s.querySelector("input").value="codex";s.querySelector("button").click()})()');
    await until(()=>ev('Array.from(document.querySelectorAll(".pane-title .account-trigger")).some(n=>!n.hidden && n.title.includes("회사 Codex"))'),"typed Codex detection",20000);
    const launchTitle=await ev('Array.from(document.querySelectorAll(".pane-title .account-trigger")).find(n=>!n.hidden).title');
    assert.match(launchTitle,/Codex/);
    await ev('document.querySelector(".pane-title .account-trigger:not([hidden])").click()');
    for (const width of [2560,1920,1440,1180,960,760,640,420,360,1920]) {
      await remote.request("Emulation.setDeviceMetricsOverride",{width,height:740,deviceScaleFactor:1,mobile:false});
      await ev("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      await until(()=>ev('!!document.querySelector(".account-menu[open]")'),"account switch menu");
      const bounds=await ev('(()=>{const b=document.querySelector(".account-menu");const r=b.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,h:innerHeight,w:innerWidth,scroll:b.scrollWidth,client:b.clientWidth}})()');

      const shot=await remote.request("Page.captureScreenshot",{format:"png"});
      fs.writeFileSync(path.join(artifacts,"docker-"+width+".png"),Buffer.from(shot.data,"base64"));
      assert.ok(bounds.left>=0 && bounds.right<=bounds.w+1 && bounds.bottom<=bounds.h+1 && bounds.scroll<=bounds.client+1,"Docker "+width+" "+JSON.stringify(bounds));
    }
    await ev('document.querySelector(".account-menu").close()');
    await ev('document.querySelector(".pane-title .account-trigger:not([hidden])").click();document.querySelector(".account-menu[open] section button:nth-child(3)").click();document.querySelector(".account-dialog[open] section button").click()');
    await until(async()=>{
      const s=await ev('({hook:document.querySelector("#remoteHookDialog").open,notice:document.querySelector("#notice").textContent,dialogs:[...document.querySelectorAll("dialog[open]")].map(d=>d.textContent.slice(0,100))})');
      if(s.notice)throw Error("Switch failed: "+s.notice);
      return s.hook;
    },"switch hook prompt");
    await ev('document.querySelector("#remoteHookWithout").click()');
    await until(()=>ev('document.querySelectorAll(".pane").length===5 && !document.querySelector("#newTerminal").disabled && Array.from(document.querySelectorAll(".pane-title .account-trigger")).some(b=>!b.hidden&&b.title.includes("개인 Codex"))'),"new personal pane");
    const home = docker("exec",id,"sh","-c",'for d in "$HOME"/.wincmux/accounts/codex/*;do basename "$d";done').split(/\s+/).find(value=>value!==profileId);
    assert.match(home,/^[0-9a-f-]{36}$/);
    await until(()=>ev('Array.from(document.querySelectorAll(".xterm-rows")).some(n=>n.textContent.includes('+JSON.stringify(home)+'))'),"personal profile environment");
    const headerCheck=await ev('(()=>{const b=[...document.querySelectorAll(".pane-title .account-trigger")].find(n=>n.title.includes("개인 Codex"));const r=b.getBoundingClientRect();const actions=b.closest("header").querySelector(".remote-pane-actions").getBoundingClientRect();return r.width>20 && (r.right<=actions.left+1 || r.bottom<=actions.top+1)})()');
    assert.ok(headerCheck,"profile button and pane actions must not overlap");
    await ev('(()=>{const b=[...document.querySelectorAll(".pane-title .account-trigger")].find(n=>n.title.includes("개인 Codex"));b.click();document.querySelector(".account-menu[open] section button:nth-child(2)").click();document.querySelector(".account-dialog[open] section button:last-child").click();document.querySelector(".account-dialog[open] section button:last-child").click()})()');
    await until(()=>ev('document.querySelector("#remoteHookDialog").open'),"same-pane restart");
    await ev('document.querySelector("#remoteHookWithout").click()');
    await until(()=>ev('document.querySelectorAll(".pane").length===5 && !document.querySelector("#newTerminal").disabled && !Array.from(document.querySelectorAll(".pane-title .account-trigger")).some(b=>!b.hidden&&b.title.includes("개인 Codex"))'),"replace only selected pane");
    docker("exec",id,"touch","/root/.wincmux/accounts/codex/"+home+"/test-expired");
    await ev('(()=>{document.querySelector(".pane-title .account-trigger:not([hidden])").click();document.querySelector(".account-menu[open] section button:nth-child(3)").click();document.querySelector(".account-dialog[open] section button:last-child").click();document.querySelector(".account-dialog[open] section button:last-child").click()})()');
    await until(()=>ev('!document.querySelector("#notice").hidden && !document.querySelector("#newTerminal").disabled'),"expired profile blocks replacement");
    assert.equal(await ev('document.querySelectorAll(".pane").length'),5);
    await ev('document.querySelector("#accountManager").click();document.querySelector(".account-dialog[open] section > button").click()');
    await ev('document.querySelector(".account-dialog[open] input").value="개인 Claude";document.querySelector(".account-dialog[open] form").requestSubmit()');
    await until(()=>ev('document.querySelectorAll(".pane").length===6 && !document.querySelector("#newTerminal").disabled'),"Claude login shell");
    await until(()=>ev('Object.keys(localStorage).filter(k=>k.startsWith("wincmux.accounts.v1.")).every(k=>{const v=JSON.parse(localStorage.getItem(k));return !Array.isArray(v)||!v.some(row=>row.pending)})'),"login identity verified",30000);
    await ev('document.querySelector("#newClaude").parentElement.querySelector(".account-trigger").click()');
    await until(()=>ev('!!document.querySelector(".account-menu[open]") && !document.querySelector("#newClaude").disabled'),"Claude profile picker");
    await ev('document.querySelector(".account-menu[open] section button:nth-child(2)").click()');
    await until(()=>ev('document.querySelector("#remoteHookDialog").open'),"Claude launch hook prompt");
    await ev('document.querySelector("#remoteHookWithout").click()');
    await until(()=>ev('Array.from(document.querySelectorAll(".pane-title .account-trigger")).some(b=>!b.hidden&&b.title.includes("개인 Claude")) && !document.querySelector("#newTerminal").disabled'),"Claude button uses its own profile");
    const claudeId=docker("exec",id,"sh","-c",'for d in "$HOME"/.wincmux/accounts/claude/*;do basename "$d";done');
    await until(()=>docker("exec",id,"sh","-c","if test -f /tmp/wincmux-received-claude; then printf yes; fi") === "yes", "Claude test CLI wrote its profile");
    assert.equal(docker("exec",id,"cat","/tmp/wincmux-received-claude"),"/root/.wincmux/accounts/claude/"+claudeId,"Claude inherits selected account");
    for (const tool of ["claude","codex"]) {
      const tab = tool === "claude" ? "first-child" : "last-child";
      const expected = (tool === "claude" ? claudeId : profileId) + "@example.org";
      const panes = await ev('document.querySelectorAll(".pane").length');
      await ev('document.querySelector("#accountManager").click();document.querySelector(".account-dialog[open] nav button:'+tab+'").click();document.querySelector(".account-dialog[open] .account-row button:nth-of-type(2)").click()');
      await until(()=>ev('document.querySelector(".account-dialog[open] [role=alert]")?.textContent.includes('+JSON.stringify(expected)+')'),tool+" already signed in");
      assert.equal(await ev('document.querySelectorAll(".pane").length'),panes);
      await ev('document.querySelector(".account-dialog[open] section > button").click(); document.querySelector(".account-dialog input").value="duplicate"; document.querySelector(".account-dialog input[type=email]").value='+JSON.stringify(expected.toUpperCase())+';document.querySelector(".account-dialog form").requestSubmit()');
      await until(()=>ev('document.querySelector(".account-dialog [role=alert]").textContent.includes("이미 연결")'),tool+" duplicate email before OAuth");
      docker("exec",id,"sh","-c","echo "+expected+" > /tmp/login-email");
      await ev('document.querySelector(".account-dialog input[type=email]").value="";document.querySelector(".account-dialog form").requestSubmit()');
      await until(()=>ev('Array.from(document.querySelectorAll(".account-dialog[open] p")).some(n=>n.textContent.includes("중복 프로필"))'),tool+" duplicate after OAuth",30000);
      await ev('document.querySelector(".account-dialog[open]").close()');
      assert.equal(await ev('document.querySelectorAll(".pane").length'),panes+1);
      await ev('document.querySelector("#accountManager").click();document.querySelector(".account-dialog[open] nav button:'+tab+'").click();document.querySelector(".account-dialog[open] section > button").click()');
      docker("exec",id,"sh","-c","echo unexpected@example.org > /tmp/login-email");
      await ev('document.querySelector(".account-dialog input").value="wrong account";document.querySelector(".account-dialog input[type=email]").value="requested@example.org";document.querySelector(".account-dialog form").requestSubmit()');
      await until(()=>ev('Array.from(document.querySelectorAll(".account-dialog[open] p")).some(n=>n.textContent.includes("일치시킬 수 없습니다"))'),tool+" wrong account after approval",30000);
      await ev('document.querySelector(".account-dialog[open]").close()');
    }
    console.log("Docker Claude and Codex launch, profile changes, failed authentication and responsive menu checks passed");
  } finally {
    if(remote)remote.close();
    docker("stop","--time","1",id);
  }
};
