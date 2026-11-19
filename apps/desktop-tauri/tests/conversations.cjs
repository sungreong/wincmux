const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { until, portNumber, connect } = require('./benchmark.cjs');
async function run() {
  const root=path.resolve(__dirname,'../../..');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wincmux-conversation-ui-'));
  const project=path.join(temp,'project'), sub=path.join(project,'child'), other=path.join(temp,'project-other');
  const claudeRoot=path.join(temp,'claude'), codexRoot=path.join(temp,'codex'), bin=path.join(temp,'bin');
  for(const dir of [project,sub,other,bin,path.join(claudeRoot,'projects','encoded'),path.join(codexRoot,'sessions','2026','11','17')])fs.mkdirSync(dir,{recursive:true});
  const ids={claude:randomUUID(),child:randomUUID(),other:randomUUID(),codex:randomUUID(),later:randomUUID()};
  const log=(id,cwd,title)=>{
    const file=path.join(claudeRoot,'projects','encoded',id+'.jsonl');
    const body=[{type:'user',cwd,sessionId:id,message:{content:'처음 대화'}},{type:'custom-title',sessionId:id,customTitle:title}].map(v=>JSON.stringify(v)).join('\n')+'\n';
    fs.writeFileSync(file,body);return {file,body};
  };
  const original=log(ids.claude,project,'한글 대화 <img src=x onerror=alert(1)>');
  fs.utimesSync(original.file,new Date('2025-01-01T00:00:00Z'),new Date('2025-01-01T00:00:00Z'));
  log(ids.child,sub,'하위 폴더 대화');log(ids.other,other,'다른 프로젝트');
  fs.writeFileSync(path.join(codexRoot,'sessions','2026','11','17','rollout-'+ids.codex+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id:ids.codex,cwd:project,source:'cli'}})+'\n');
  fs.writeFileSync(path.join(codexRoot,'session_index.jsonl'),JSON.stringify({id:ids.codex,thread_name:'Codex 이전 대화',updated_at:new Date().toISOString()})+'\n');
  for(const name of ['claude','codex'])fs.writeFileSync(path.join(bin,name+'.cmd'),`@echo off\r\necho FAKE_${name.toUpperCase()}:%*\r\necho WORKDIR:%CD%\r\n`);
  const port=await portNumber();
  const audit=process.argv.includes('--audit-local');
  const auditProject=process.argv[process.argv.indexOf('--audit-local')+1];
  const child=spawn(path.join(root,'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe'),['--benchmark-hidden'],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{
    ...process.env,...(audit?{}:{CLAUDE_CONFIG_DIR:claudeRoot,CODEX_HOME:codexRoot,PATH:bin+path.delimiter+process.env.PATH}),
    WINCMUX_TAURI_DATA_DIR:path.join(temp,'data'),WINCMUX_TAURI_PIPE:'\\\\.\\pipe\\wincmux-conversation-ui-'+randomUUID(),WEBVIEW2_USER_DATA_FOLDER:path.join(temp,'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling`
  }});
  let cdp, appError='';
  child.stderr.on('data',chunk=>{appError+=chunk.toString();});
  try {
    try { cdp=await connect(port,child); } catch(error) { throw new Error(`${error.message}\n${appError}`); }
    await until(()=>cdp.eval('typeof state!=="undefined" && state.bootstrapReady===true && Boolean(window.wincmuxConversations)'),'conversation bootstrap');
    const ws=(await cdp.eval(`rpc('workspace.create',${JSON.stringify({name:audit?'로컬 대화 확인':'대화 이력 검증 프로젝트',path:audit?auditProject:project,backend:'custom'})})`)).workspace.id;
    await cdp.eval(`loadWorkspaces().then(()=>switchWorkspace(${JSON.stringify(ws)}))`);
    await until(()=>cdp.eval('state.paneViews.size>0'),'pane');
    const query=async params=>cdp.eval(`rpc('conversation.list',${JSON.stringify({workspace_id:ws,...params})})`);
    if(audit) {
      const result=await query({refresh:true});const counts={};for(const row of result.items)counts[row.provider]=(counts[row.provider]??0)+1;
      assert.ok(result.items.length>0,'existing project histories are discoverable');
      console.log(JSON.stringify({localReadOnlyAudit:true,counts,warnings:result.warnings}));return;
    }
    // Never resolve a real installed AI executable: bind test-only shell functions
    // to absolute fixture commands, independently of the user's PowerShell profile.
    const psQuote=value=>"'"+value.replaceAll("'","''")+"'";
    const fixtureSetup=`function global:claude { & ${psQuote(path.join(bin,'claude.cmd'))} @args }; function global:codex { & ${psQuote(path.join(bin,'codex.cmd'))} @args }; `;
    await cdp.eval(`window.__originalConversationShellArgs=overlayShellArgs; overlayShellArgs=(shell,command)=>{const args=window.__originalConversationShellArgs(shell,${JSON.stringify(fixtureSetup)}+command);args.unshift('-NoProfile');return args;}`);
    assert.equal((await query({include_children:true})).items.length,3);
    assert.equal((await query({include_children:false})).items.length,2);
    const rejected=await cdp.eval(`rpc('conversation.resolve',${JSON.stringify({workspace_id:ws,provider:'claude',id:ids.other})}).then(()=>null,e=>String(e))`);
    assert.match(rejected,/프로젝트/);
    await cdp.eval('document.querySelector(".launch-conversations").click()');
    await until(()=>cdp.eval('document.querySelectorAll(".conversation-row").length===3'),'project history list');
    assert.equal(await cdp.eval('document.querySelectorAll(".conversation-row img").length'),0);
    assert.ok((await cdp.eval('document.querySelector(".conversation-list").textContent')).includes('<img src=x'));
    await cdp.eval(`(()=>{const p=document.getElementById('conversationProvider');p.value='codex';p.dispatchEvent(new Event('change'));})()`);
    assert.equal(await cdp.eval('document.querySelectorAll(".conversation-row").length'),1);
    await cdp.eval(`(()=>{const p=document.getElementById('conversationProvider');p.value='';p.dispatchEvent(new Event('change'));const s=document.getElementById('conversationSearch');s.value='하위';s.dispatchEvent(new Event('input'));})()`);
    assert.equal(await cdp.eval('document.querySelectorAll(".conversation-row").length'),1);
    await cdp.eval(`(()=>{const s=document.getElementById('conversationSearch');s.value='';s.dispatchEvent(new Event('input'));document.getElementById('conversationChildren').click();})()`);
    await until(()=>cdp.eval('document.querySelectorAll(".conversation-row").length===2'),'exact project scope');
    log(ids.later,project,'새로 저장된 대화');
    await cdp.eval('document.querySelector(\'#conversationDialog [data-action="refresh"]\').click()');
    await until(()=>cdp.eval('document.querySelectorAll(".conversation-row").length===3'),'manual refresh');
    const sortable=(await query({include_children:false,refresh:true})).items;
    assert.ok(sortable.every(item=>Number.isFinite(item.size_bytes)),'both providers expose transcript file size');
    assert.equal(sortable.find(item=>item.id===ids.claude).size_bytes,fs.statSync(original.file).size);
    const firstRow=()=>cdp.eval('document.querySelector(".conversation-row").dataset.id');
    const chooseSort=value=>cdp.eval(`(()=>{const sort=document.getElementById('conversationSort');sort.value=${JSON.stringify(value)};sort.dispatchEvent(new Event('change'));})()`);
    await chooseSort('oldest');
    assert.equal(await firstRow(),ids.claude,'oldest conversation first');
    await chooseSort('largest');
    assert.equal(await firstRow(),sortable.toSorted((a,b)=>b.size_bytes-a.size_bytes || b.updated_at-a.updated_at)[0].id,'largest transcript first');
    await chooseSort('smallest');
    assert.equal(await firstRow(),sortable.toSorted((a,b)=>a.size_bytes-b.size_bytes || b.updated_at-a.updated_at)[0].id,'smallest transcript first');
    await chooseSort('newest');
    assert.equal(await firstRow(),sortable.toSorted((a,b)=>b.updated_at-a.updated_at)[0].id,'newest conversation first');
    const artifacts=path.join(root,'artifacts','conversations');fs.mkdirSync(artifacts,{recursive:true});
    const shot=await cdp.request('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(artifacts,'history.png'),Buffer.from(shot.data,'base64'));
    const pane=await cdp.eval('state.selectedPaneId');
    await cdp.eval(`(()=>{const b=document.querySelector('.conversation-row[data-id="${ids.claude}"] .conversation-resume');b.click();b.click();})()`);
    await until(()=>cdp.eval('document.getElementById("conversationDialog").open===false'),'resume command launch');
    const running=async()=> (await cdp.eval(`rpc('session.list',{workspace_id:${JSON.stringify(ws)}})`)).sessions.filter(s=>s.status==='running');
    await until(async()=> (await running()).length===1,'one resume on double click');
    const sid=(await running())[0].id;
    await until(async()=> (await cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(sid)}})`)).output.includes('FAKE_CLAUDE:--resume '+ids.claude),'exact Claude resume UUID');
    await until(async()=> (await cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(sid)}})`)).output.includes('WORKDIR:'+project),'saved working directory output');
    await cdp.eval('document.getElementById("conversationBtn").click()');
    await until(()=>cdp.eval(`Boolean(document.querySelector('.conversation-row[data-id="${ids.codex}"] button'))`),'reopen history');
    await cdp.eval(`document.querySelector('.conversation-row[data-id="${ids.codex}"] .conversation-resume').click()`);
    await until(async()=> (await running()).length===2,'Codex resume in new pane');
    const second=(await running()).find(s=>s.id!==sid);
    await until(async()=> (await cdp.eval(`rpc('session.tail',{session_id:${JSON.stringify(second.id)}})`)).output.includes('FAKE_CODEX:resume '+ids.codex),'exact Codex resume UUID');
    assert.ok((await running()).some(s=>s.id===sid),'original session preserved');
    assert.notEqual(await cdp.eval('state.selectedPaneId'),pane);
    await cdp.eval('document.getElementById("conversationBtn").click()');
    await until(()=>cdp.eval('document.querySelectorAll(".conversation-row").length===3'),'history controls');
    await cdp.eval(`document.querySelector('.conversation-row[data-id="${ids.codex}"] [data-action="favorite"]').click()`);
    await cdp.eval(`document.querySelector('.conversation-row[data-id="${ids.claude}"] [data-action="hide"]').click()`);
    assert.equal(await cdp.eval(`document.querySelector('.conversation-row[data-id="${ids.claude}"]')===null`),true);
    await cdp.eval(`(()=>{const f=document.getElementById('conversationFavorites');f.checked=true;f.dispatchEvent(new Event('change'));})()`);
    assert.equal(await cdp.eval('document.querySelectorAll(".conversation-row").length'),1,'favorite filter');
    assert.equal(await cdp.eval('document.querySelector(".conversation-row").dataset.provider'),'codex');
    await cdp.eval(`(()=>{const f=document.getElementById('conversationFavorites');f.checked=false;f.dispatchEvent(new Event('change'));const v=document.getElementById('conversationView');v.value='hidden';v.dispatchEvent(new Event('change'));})()`);
    assert.equal(await cdp.eval('document.querySelectorAll(".conversation-row").length'),1,'hidden list');
    await cdp.eval(`document.querySelector('.conversation-row[data-id="${ids.claude}"] [data-action="hide"]').click()`);
    assert.equal(await cdp.eval('document.querySelectorAll(".conversation-row").length'),0,'unhidden row leaves hidden list');
    await cdp.eval(`(()=>{const v=document.getElementById('conversationView');v.value='visible';v.dispatchEvent(new Event('change'));const d=document.getElementById('conversationFrom');d.value='2099-01-01';d.dispatchEvent(new Event('change'));})()`);
    assert.equal(await cdp.eval('document.querySelectorAll(".conversation-row").length'),0,'future date filter');
    await cdp.eval(`(()=>{const start=document.getElementById('conversationFrom');start.value='';start.dispatchEvent(new Event('change'));const end=document.getElementById('conversationTo');end.value='2000-01-01';end.dispatchEvent(new Event('change'));})()`);
    assert.equal(await cdp.eval('document.querySelectorAll(".conversation-row").length'),0,'end date filter');
    await cdp.eval(`(()=>{const d=document.getElementById('conversationTo');d.value='';d.dispatchEvent(new Event('change'));document.getElementById('conversationCompact').click();})()`);
    assert.equal(await cdp.eval('document.getElementById("conversationDialog").classList.contains("conversation-compact")'),true);
    for(let index=0;index<12;index++)log(randomUUID(),project,`페이지 검증 ${index}`);
    await cdp.eval('document.querySelector(\'#conversationDialog [data-action="refresh"]\').click()');
    await until(()=>cdp.eval('document.querySelector(".conversation-pagination span").textContent.includes("/ 2 페이지")'),'pagination');
    assert.equal(await cdp.eval('document.querySelectorAll(".conversation-row").length'),10,'first page size');
    await cdp.eval(`(()=>{const size=document.getElementById('conversationPageSize');size.value='20';size.dispatchEvent(new Event('change'));})()`);
    assert.equal(await cdp.eval('document.querySelectorAll(".conversation-row").length'),15,'larger page size');
    await cdp.eval(`(()=>{const size=document.getElementById('conversationPageSize');size.value='10';size.dispatchEvent(new Event('change'));})()`);
    await cdp.eval('document.querySelector(\'[data-page="next"]\').click()');
    assert.equal(await cdp.eval('document.querySelectorAll(".conversation-row").length'),5,'second page size');
    await cdp.eval('document.querySelector(\'[data-page="previous"]\').click()');
    assert.equal(await cdp.eval('document.querySelectorAll(".conversation-row").length'),10,'previous page');
    await chooseSort('oldest');
    await cdp.eval('document.querySelector(\'#conversationDialog [data-action="close"]\').click()');
    await cdp.eval('document.getElementById("conversationBtn").click()');
    await until(()=>cdp.eval('document.querySelectorAll(".conversation-row").length===10'),'reopen with saved preferences');
    assert.equal(await cdp.eval('document.getElementById("conversationCompact").checked'),true,'compact setting persists');
    assert.equal(await cdp.eval('document.getElementById("conversationSort").value'),'oldest','sort setting persists');
    await cdp.eval(`(()=>{const f=document.getElementById('conversationFavorites');f.checked=true;f.dispatchEvent(new Event('change'));})()`);
    assert.equal(await cdp.eval('document.querySelector(".conversation-row").dataset.provider'),'codex','favorite persists');
    assert.equal(fs.readFileSync(original.file,'utf8'),original.body,'original Claude transcript untouched');
    console.log(JSON.stringify({projectScope:true,childScope:true,search:true,providerFilter:true,escapedTitle:true,refresh:true,claudeResume:true,codexResume:true,exactWorkingDirectory:true,doubleClickGuard:true,liveSessionPreserved:true,hidden:true,favorite:true,dateFilter:true,timeSort:true,fileSizeSort:true,pagination:true,compact:true,originalUnchanged:true,artifacts},null,2));
  } finally {
    if(cdp){await cdp.eval("rpc('runtime.shutdown_all',{confirmed:true})").catch(()=>{});cdp.close();}
    if(child.exitCode===null)child.kill();
  }
}
run().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
