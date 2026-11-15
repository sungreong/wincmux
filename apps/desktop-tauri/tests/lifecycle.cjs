const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const net=require('node:net');const {spawn,execFileSync}=require('node:child_process');const {randomUUID}=require('node:crypto');const {setTimeout:sleep}=require('node:timers/promises');
const {until,portNumber,connect,privateMemory}=require('./benchmark.cjs');
async function pipeClient(pipe){const socket=net.createConnection(pipe).setEncoding('utf8');await new Promise((resolve,reject)=>socket.once('connect',resolve).once('error',reject));let sequence=0,buffer='';const pending=new Map();socket.on('error',()=>{});socket.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){const p=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(p.id)pending.get(p.id)?.(p);}});return{close:()=>socket.destroy(),rpc:(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const t=setTimeout(()=>reject(new Error('timeout '+method)),10000);pending.set(id,p=>{pending.delete(id);clearTimeout(t);p.error?reject(new Error(p.error.message)):resolve(p.result);});socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');})};}
function usage(pid){return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${pid}; [pscustomobject]@{privateMiB=[math]::Round($p.PrivateMemorySize64/1MB,2);handles=$p.HandleCount;cpu=$p.CPU}|ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}));}
function webviewIds(pid){return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$rows=@(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'");$ids=@(${pid});do{$next=@($rows|Where-Object{$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids}|ForEach-Object ProcessId);$ids+=$next}while($next.Count -gt 0);ConvertTo-Json -Compress -InputObject @($ids|Where-Object{$_ -ne ${pid}})`],{encoding:'utf8',windowsHide:true}));}
async function run(){
 const root=path.resolve(__dirname,'../../..');const exe=path.join(root,'apps/desktop-tauri/src-tauri/target/release/wincmux-tauri.exe');const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wincmux-lifecycle-'));const pipe='\\\\.\\pipe\\wincmux-lifecycle-'+randomUUID();
 let child,cdp,client,info;
 const launch=async(activation=null)=>{const port=await portNumber();child=spawn(exe,['--benchmark-hidden',...(activation?['--open-notification',`wincmux://notification/${activation}`]:[])],{windowsHide:true,stdio:'ignore',env:{...process.env,WINCMUX_TAURI_DATA_DIR:path.join(temp,'data'),WINCMUX_TAURI_PIPE:pipe,WEBVIEW2_USER_DATA_FOLDER:path.join(temp,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows`}});cdp=await connect(port,child);await until(()=>cdp.eval("typeof state!=='undefined' && state.bootstrapReady === true && state.selectedWorkspaceId && state.paneViews.size>0"),'renderer');await sleep(700);};
 const closeUI=async(force=false)=>{const webviews=webviewIds(child.pid);if(force)child.kill();else await cdp.eval('window.__TAURI__.window.getCurrentWindow().close()').catch(()=>{});cdp.close();cdp=null;await until(()=>(child.exitCode!==null||child.signalCode!==null),'UI exits');await until(async()=>(await client.rpc('runtime.info')).client_count===0,'UI detached');await until(()=>webviews.every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),'WebView2 processes exited');await sleep(500);};
 try{
  await launch();client=await pipeClient(pipe);info=await client.rpc('runtime.info');
  const ws=(await client.rpc('workspace.create',{name:'Lifecycle',path:temp,backend:'custom'})).workspace.id;
  await cdp.eval(`loadWorkspaces().then(()=>switchWorkspace(${JSON.stringify(ws)}))`);

  await cdp.eval(`globalThis.expectedWorkspace=${JSON.stringify(ws)}`);
  await until(()=>cdp.eval(`state.selectedWorkspaceId===${JSON.stringify(ws)} && state.paneViews.size>0`),'workspace settled');
  await sleep(500);
  let first=await cdp.eval('[...state.paneViews.keys()][0]');
  await cdp.eval(`selectPane(${JSON.stringify(first)},{persist:false,focusTerm:false})`);
  const start=async(pane)=>cdp.eval(`startSessionForPane(${JSON.stringify(pane)},${JSON.stringify({force:true,cmd:process.execPath,args:[path.join(__dirname,'fixture.cjs')],cwd:temp,focusTerm:false})})`);
  const sid=await start(first);
  for(let i=1;i<6;i++){const split=await cdp.eval(`splitPaneInternal(state.selectedPaneId,'vertical',{autoStartIfMissing:false})`);await start(split.second);}
  await until(async()=>(await client.rpc('runtime.info')).terminal_count===6,'six terminals');
  first=await cdp.eval(`Object.keys(state.paneSessions).find(p=>state.paneSessions[p]===${JSON.stringify(sid)})`);
  const sessions=(await client.rpc('session.list',{workspace_id:ws})).sessions.filter(s=>s.status==='running');
  await until(async()=>(await client.rpc('session.tail',{session_id:sid})).output.includes('FIXTURE_READY'),'fixture ready');
  await client.rpc('session.write',{session_id:sid,data:'#tui-on#'});
  await until(()=>cdp.eval(`state.paneViews.get(${JSON.stringify(first)}).term.buffer.active.type==='alternate'`),'alternate screen');
  const otherPane=await cdp.eval(`[...state.paneViews.keys()].find(p=>p!==${JSON.stringify(first)})`);await cdp.eval(`onHidePane(${JSON.stringify(otherPane)})`);
  const hidden=(await client.rpc('hidden.list',{workspace_id:ws})).items;assert.equal(hidden.length,1);
  await client.rpc('session.write',{session_id:sid,data:'#status:done#'});
  await until(async()=>(await client.rpc('agent.list')).items.find(s=>s.session_id===sid)?.state==='done','unread result');
  const openMemory=privateMemory(child.pid,sessions.map(s=>s.pid),info.pid);
  await closeUI();assert.equal((await client.rpc('runtime.info')).instance_id,info.instance_id);
  await client.rpc('session.write',{session_id:sid,data:'#overflow#'});
  await until(async()=>{const t=await client.rpc('session.tail',{session_id:sid});return t.start_offset>0&&t.output.includes('ALT 한글  A');},'output retention wraps',30000);
  const background=usage(info.pid);
  if(process.env.WINCMUX_MEASURE_IDLE==='1'){const began=Date.now(),before=usage(info.pid).cpu;await sleep(60000);background.idleCpuPercent=(usage(info.pid).cpu-before)/((Date.now()-began)/1000)*100;}
  await launch();assert.equal((await client.rpc('runtime.info')).instance_id,info.instance_id);
  await until(()=>cdp.eval(`state.paneViews.size===5 && state.paneViews.get(${JSON.stringify(first)})?.term.buffer.active.type==='alternate'`),'restored screen');
  const image = await cdp.request("Page.captureScreenshot", {format:"png",fromSurface:true});
  fs.mkdirSync(path.join(root,'artifacts/background-core'),{recursive:true});
  fs.writeFileSync(path.join(root,'artifacts/background-core/restored-screen.png'),Buffer.from(image.data,'base64'));
  assert.equal((await client.rpc('hidden.list',{workspace_id:ws})).items[0].session_id,hidden[0].session_id);
  assert.equal((await client.rpc('agent.list')).items.find(s=>s.session_id===sid).state,'done');
  const current=(await client.rpc('session.list',{workspace_id:ws})).sessions;for(const s of sessions)assert.equal(current.find(r=>r.id===s.id).pid,s.pid);
  const screen=await cdp.eval(`(()=>{const t=state.paneViews.get(${JSON.stringify(first)}).term,b=t.buffer.active;return {text:Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true)).join('\\n'),paste:t.modes.bracketedPasteMode};})()`);assert.ok(screen.text.includes('ALT 한글  A'));assert.equal(screen.paste,true);
  const hiddenNotice=(await client.rpc('notify.push',{workspace_id:ws,session_id:hidden[0].session_id,title:'Hidden terminal test',body:'Open the retained terminal',level:'info'})).notification;
  await cdp.eval(`openNotificationById(${JSON.stringify(hiddenNotice.id)},${JSON.stringify(hiddenNotice)})`);
  assert.equal((await client.rpc('hidden.list',{workspace_id:ws})).items.length,0);
  assert.ok(await cdp.eval(`paneForSession(${JSON.stringify(hidden[0].session_id)})`));
  first=await cdp.eval(`Object.keys(state.paneSessions).find(p=>state.paneSessions[p]===${JSON.stringify(sid)})`);
  await client.rpc('session.write',{session_id:sid,data:'#tui-off#'});await until(()=>cdp.eval(`state.paneViews.get(${JSON.stringify(first)}).term.buffer.active.type==='normal'`),'normal screen restored');
  assert.ok(await cdp.eval(`(()=>{const b=state.paneViews.get(${JSON.stringify(first)}).term.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true)).join('\\n').includes('MAIN 한글  A');})()`));
  await closeUI(true);await launch();assert.equal((await client.rpc('runtime.info')).instance_id,info.instance_id);assert.equal((await client.rpc('runtime.info')).terminal_count,6);
  const reconnectedMemory=privateMemory(child.pid,sessions.map(s=>s.pid),info.pid);
  const endedNotice=(await client.rpc('notify.push',{workspace_id:ws,session_id:sid,title:'Ended session activation test',body:'Open a saved result after the core stops',level:'info'})).notification;
  await client.rpc('runtime.shutdown_all',{confirmed:true});
  cdp.close();cdp=null;
  await until(()=>(child.exitCode!==null||child.signalCode!==null),'UI ends with full shutdown');
  await until(()=>{try{process.kill(info.pid,0);return false;}catch{return true;}},'old core exits');
  client.close();
  await launch(endedNotice.id);client=await pipeClient(pipe);
  assert.notEqual((await client.rpc('runtime.info')).instance_id,info.instance_id);
  assert.equal((await client.rpc('runtime.info')).terminal_count,0);
  await until(async()=>(await client.rpc('notify.get',{notification_id:endedNotice.id})).notification.read_at,'activation of an ended result after fresh core');
  const report={sameCore:true,sameProcesses:true,activationAfterCoreExit:true,noAutomaticRerun:true,normalClose:true,uiCrash:true,webviewReleased:true,hiddenRestored:true,notificationRestoresHidden:true,unreadPreserved:true,wrappedOutput:true,alternateAndNormalScreens:true,bracketedPaste:true,openMemory,background,reconnectedMemory};
  fs.mkdirSync(path.join(root,'artifacts/background-core'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts/background-core/lifecycle'+(process.env.WINCMUX_RUN_INDEX?'-'+process.env.WINCMUX_RUN_INDEX:'')+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }catch(error){if(cdp)console.error(await cdp.eval("JSON.stringify({expected:globalThis.expectedWorkspace,transition:workspaceTransition,views:[...state.paneViews.keys()],ws:state.selectedWorkspaceId,pane:state.selectedPaneId,panes:state.panes,status:document.getElementById('statusBar').textContent})").catch(()=>"diagnostics unavailable"));throw error;}finally{if(client){await client.rpc('runtime.shutdown_all',{confirmed:true}).catch(()=>{});client.close();}if(cdp)cdp.close();if(child&&child.exitCode===null)child.kill();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
