const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');
async function run() {
  const root=path.resolve(__dirname,'../../..');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wincmux-reminder-ui-'));
  const port=await portNumber();
  const child=spawn(path.join(root,'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'),['--benchmark-hidden'],{windowsHide:true,stdio:'ignore',env:{
    ...process.env,WINCMUX_TAURI_DATA_DIR:path.join(temp,'data'),WINCMUX_TAURI_PIPE:'\\\\.\\pipe\\wincmux-reminder-ui-'+randomUUID(),WEBVIEW2_USER_DATA_FOLDER:path.join(temp,'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling`
  }});
  let cdp;
  try {
    cdp=await connect(port,child);
    const ready=()=>until(()=>cdp.eval('typeof state!=="undefined" && state.bootstrapReady===true && Boolean(window.wincmuxReminders)'),'reminder bootstrap');
    await ready();
    const ws=(await cdp.eval(`rpc('workspace.create',${JSON.stringify({name:'알림 검증 프로젝트',path:temp,backend:'custom'})})`)).workspace.id;
    await cdp.eval(`loadWorkspaces().then(()=>switchWorkspace(${JSON.stringify(ws)}))`);
    await until(()=>cdp.eval('state.paneViews.size>0'),'pane');
    await cdp.eval('window.wincmuxReminders.open()');
    assert.equal(await cdp.eval('document.getElementById("reminderDialog").open'),true);
    const action=async key=>{
      await cdp.eval(`document.querySelector('#reminderDialog [data-action="${key}"]').click()`);
      await until(()=>cdp.eval('document.getElementById("reminderDialog").dataset.busy!=="true"'),'dialog mutation finishes');
    };
    const all=async()=> (await cdp.eval('rpc("reminder.list",{})')).items;
    const fill=async(title)=>cdp.eval(`(()=>{
      const f=document.getElementById('reminderEditor');f.elements.title.value=${JSON.stringify(title)};
      f.elements.body.value='한글 알림 내용';f.elements.provider.value='claude';f.elements.timezone.value='Asia/Seoul';
      f.elements.due.value=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(Date.now()+180000)).replace(' ','T');
    })()`);
    const submit=async()=>{
      await cdp.eval('document.getElementById("reminderEditor").requestSubmit()');
      await until(()=>cdp.eval('document.querySelector("#reminderEditor [type=submit]").disabled===false'),'form save finishes');
    };
    await fill('직접 등록한 알림 <확인>');await submit();
    let manual=await until(async()=> (await all()).find(r=>r.title==='직접 등록한 알림 <확인>'),'manual UI registration');
    await until(()=>cdp.eval('document.querySelectorAll(".reminder-row").length===1'),'manual list');
    assert.equal(await cdp.eval('document.querySelector(".reminder-row strong").textContent'),'직접 등록한 알림 <확인>');
    assert.equal(await cdp.eval('document.querySelectorAll(".reminder-list img").length'),0);
    await fill('수정한 알림');await submit();
    await until(async()=> (await all()).some(r=>r.id===manual.id&&r.title==='수정한 알림'),'manual UI update');
    await action('new');await fill('취소할 알림');await submit();
    const cancelled=await until(async()=> (await all()).find(r=>r.title==='취소할 알림'),'cancel record');
    await until(()=>cdp.eval('document.querySelector("#reminderEditor [data-action=cancel]").disabled===false'),'cancel enabled');
    await action('cancel');
    await until(async()=> (await all()).some(r=>r.id===cancelled.id&&r.status==='cancelled'),'cancel through UI');
    await action('new');await fill('삭제할 알림');await submit();
    const deleted=await until(async()=> (await all()).find(r=>r.title==='삭제할 알림'),'delete record');
    await until(()=>cdp.eval('document.querySelector("#reminderEditor [data-action=delete]").disabled===false'),'delete enabled');
    await action('delete');await until(async()=> !(await all()).some(r=>r.id===deleted.id),'delete through UI');
    await cdp.eval(`(()=>{const c=document.getElementById('reminderAutoEnabled');c.checked=false;c.dispatchEvent(new Event('input',{bubbles:true}));})()`);await action('settings');
    await until(async()=> (await cdp.eval('rpc("reminder.settings.get",{})')).auto_enabled===0,'settings off');
    await cdp.eval(`(()=>{const c=document.getElementById('reminderAutoEnabled');c.checked=true;c.dispatchEvent(new Event('input',{bubbles:true}));})()`);await action('settings');
    await until(async()=> (await cdp.eval('rpc("reminder.settings.get",{})')).auto_enabled===1,'settings on');
    await action('close');
    const pane=await cdp.eval('[...state.paneViews.keys()][0]');
    const sid=await cdp.eval(`startSessionForPane(${JSON.stringify(pane)},${JSON.stringify({force:true,cmd:process.execPath,args:[path.join(__dirname,'fixture.cjs')],cwd:temp,focusTerm:false})})`);
    await until(async()=> (await cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(sid)}})`)).output.includes('FIXTURE_READY'),'fixture');
    await cdp.eval(`rpc('session.write',{session_id:${JSON.stringify(sid)},data:'#quota:unknown#'})`);
    const unknown=await until(async()=> (await all()).find(r=>r.session_id===sid&&r.status==='needs_time'),'unknown quota automatic reminder');
    await cdp.eval('window.wincmuxReminders.open()');
    await until(()=>cdp.eval(`Boolean(document.querySelector('.reminder-row[data-id="${unknown.id}"]'))`),'unknown row');
    await cdp.eval(`document.querySelector('.reminder-row[data-id="${unknown.id}"]').click()`);
    assert.equal(await cdp.eval('document.getElementById("reminderEditor").elements.due.value'),'');
    assert.ok(Number.isSafeInteger(unknown.observed_at));
    assert.ok((await cdp.eval('document.getElementById("reminderSource").textContent')).includes('감지 '));
    const artifacts=path.join(root,'artifacts','reminders');fs.mkdirSync(artifacts,{recursive:true});
    const capture=async name=>{const p=await cdp.request('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(artifacts,name),Buffer.from(p.data,'base64'));};
    await capture('reminder-settings.png');
    await cdp.eval('document.querySelector(\'#reminderDialog [data-minutes="30"]\').click()');await submit();
    await until(async()=> (await all()).some(r=>r.id===unknown.id&&r.status==='pending'&&r.source==='manual'),'manual time on automatic record');
    await action('close');
    const immediate=await cdp.eval(`rpc('reminder.save',${JSON.stringify({workspace_id:ws,title:'예약 시간이 되었습니다',body:'알림 배너 표시를 확인했습니다.',timezone:'Asia/Seoul',due_at:Math.floor(Date.now()/1000)+3})})`);
    await until(()=>cdp.eval('Boolean(document.querySelector(".reminder-toast:not([hidden]) strong")?.textContent.includes("예약 시간이 되었습니다"))'),'due toast');
    assert.equal((await all()).find(r=>r.id===immediate.id).status,'sent');
    await capture('reminder-toast.png');
    assert.equal(await cdp.eval('(()=>{const list=document.getElementById("notificationList");return list.scrollWidth<=list.clientWidth+1;})()'),true,'notification previews stay within the sidebar');
    await cdp.eval('window.__reminderReloadMarker=true');
    await cdp.request('Page.reload');
    await until(()=>cdp.eval('window.__reminderReloadMarker!==true && typeof state!=="undefined" && state.bootstrapReady===true && Boolean(window.wincmuxReminders)').catch(()=>false),'new document after reload');
    await cdp.eval('window.wincmuxReminders.open()');
    assert.ok((await all()).some(r=>r.id===manual.id&&r.title==='수정한 알림'));
    console.log(JSON.stringify({manualCrud:true,escapedTitle:true,settings:true,autoDetection:true,unknownTime:true,manualOverride:true,dueToast:true,reload:true,artifacts},null,2));
  }finally{
    if(cdp){await cdp.eval("rpc('runtime.shutdown_all',{confirmed:true})").catch(()=>{});cdp.close();}
    if(child.exitCode===null)child.kill();
  }
}
run().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
