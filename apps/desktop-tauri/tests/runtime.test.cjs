const {test}=require('node:test');
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const net=require('node:net');const {spawn,spawnSync}=require('node:child_process');const {randomUUID}=require('node:crypto');const {setTimeout:sleep}=require('node:timers/promises');
const executable=process.env.WINCMUX_CORE_EXE||path.resolve(__dirname,'../src-tauri/target/release/wincmux-core.exe');
async function until(fn,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(40);}throw new Error('Timed out: '+label);}
async function connect(pipe){const socket=net.createConnection(pipe).setEncoding('utf8');await new Promise((resolve,reject)=>socket.once('connect',resolve).once('error',reject));let sequence=0,buffer='';const pending=new Map();const events=[];socket.on('error',()=>{});socket.on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\n'))>=0){const packet=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(packet.id)pending.get(packet.id)?.(packet);else events.push(packet);}});return{events,close:()=>socket.destroy(),rpc:(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout '+method));},10000);pending.set(id,p=>{clearTimeout(timer);pending.delete(id);p.error?reject(new Error(p.error.message)):resolve(p.result);});socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');})};}
test('detached runtime retains sessions, snapshots and acknowledgements; protects updates and cleans clients', {timeout:90000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wincmux-runtime-'));const pipe='\\\\.\\pipe\\wincmux-test-'+randomUUID();
 let child=spawn(executable,['--data-dir',root,'--pipe',pipe,'--no-tray'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',d=>errors+=d);let c;
 try{
  c=await until(()=>connect(pipe).catch(()=>null),'core startup '+errors);await c.rpc('client.attach',{client_id:'first'});
  const info=await c.rpc('runtime.info');assert.equal(info.version,require('../../../package.json').version);assert.equal(info.protocol_version,1);
  assert.equal(path.normalize(fs.realpathSync.native(info.data_directory)).toLowerCase(),path.normalize(fs.realpathSync.native(root)).toLowerCase(),'core reports the requested data directory');
  const ws=(await c.rpc('workspace.create',{name:'Runtime test',path:root,backend:'custom'})).workspace.id;
  const result=await c.rpc('session.run',{workspace_id:ws,cmd:process.execPath,args:[path.resolve(__dirname,'fixture.cjs')],cwd:root});const sid=result.session.session_id;
  await until(async()=>(await c.rpc('session.tail',{session_id:sid})).output.includes('FIXTURE_READY'),'fixture');
  await c.rpc('hidden.add',{id:'hidden',workspace_id:ws,session_id:sid,source_pane_id:'old',group_id:null,label:'Hidden fixture',hidden_at:new Date().toISOString()});
  await c.rpc('session.write',{session_id:sid,data:'#status:done#'});await until(async()=>(await c.rpc('agent.list')).items.some(s=>s.session_id===sid&&s.state==='done'),'done status');
  c.close();c=await connect(pipe);await c.rpc('client.attach',{client_id:'second'});
  assert.equal((await c.rpc('runtime.info')).instance_id,info.instance_id);assert.equal((await c.rpc('session.list',{workspace_id:ws})).sessions.find(s=>s.id===sid).pid,result.session.pid);
  assert.equal((await c.rpc('hidden.list',{workspace_id:ws})).items[0].session_id,sid);
  assert.equal((await c.rpc('agent.list')).items.find(s=>s.session_id===sid).state,'done');
  const snap=await c.rpc('session.snapshot',{session_id:sid});assert.ok(snap.screen.includes('FIXTURE_READY'));assert.ok(snap.end_offset>0);
  const textScreen=await c.rpc('session.screen_text',{session_id:sid});assert.ok(textScreen.lines.some(line=>line.includes('FIXTURE_READY')));assert.equal(typeof textScreen.bracketed_paste,'boolean');
  await assert.rejects(c.rpc('session.resize',{session_id:sid,cols:32767,rows:32767}),/budget/);
  await assert.rejects(c.rpc('runtime.prepare_update'),/still running/);
  await assert.rejects(c.rpc('runtime.shutdown_all'),/confirmation/);
  await c.rpc('session.write',{session_id:sid,data:'#ping:77#'});await until(async()=>(await c.rpc('session.tail',{session_id:sid})).output.includes('PONG:77:END'),'live after detach');
  await c.rpc('session.write',{session_id:sid,data:'#burst#'});
  await Promise.all([c.rpc('session.resize',{session_id:sid,cols:200,rows:120}),c.rpc('session.resize',{session_id:sid,cols:120,rows:30})]);
  await until(async()=>(await c.rpc('session.tail',{session_id:sid})).output.includes('2999|'),'resize while output is busy');
  const duplicate=spawn(executable,['--data-dir',root,'--pipe',pipe,'--no-tray'],{windowsHide:true,stdio:'ignore'});await new Promise(resolve=>duplicate.once('exit',resolve));assert.notEqual(duplicate.exitCode,0);
  const usage=()=>JSON.parse(spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${child.pid};[pscustomobject]@{privateMiB=[math]::Round($p.PrivateMemorySize64/1MB,2);handles=$p.HandleCount}|ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}).stdout);
  const resourceBefore=usage();
  const before=(await c.rpc('runtime.info')).subscriber_count;
  for(let i=0;i<50;i++){const other=await connect(pipe);await other.rpc('client.attach',{client_id:'cycle-'+i});await other.rpc('session.stream.subscribe',{});other.close();}
  await until(async()=>{const i=await c.rpc('runtime.info');return i.client_count===1&&i.subscriber_count===before;},'50 clients cleaned');
  const resourceAfter=usage();
  assert.ok(resourceAfter.handles<=resourceBefore.handles+16,'connection handles must be released');
  assert.ok(resourceAfter.privateMiB<=resourceBefore.privateMiB+8,'connection memory must remain bounded');
  fs.mkdirSync(path.resolve(__dirname,'../../../artifacts/background-core'),{recursive:true});
  fs.writeFileSync(path.resolve(__dirname,'../../../artifacts/background-core/connection-cycles.json'),JSON.stringify({cycles:50,before:resourceBefore,after:resourceAfter},null,2));
  await c.rpc('runtime.activate',{notification_id:'pending',workspace_id:ws,session_id:sid});c.close();c=await connect(pipe);const attached=await c.rpc('client.attach',{client_id:'third'});assert.equal(attached.activation.notification_id,'pending');await c.rpc('client.activation_ack');
  await c.rpc('session.close',{session_id:sid});assert.equal((await c.rpc('hidden.list',{workspace_id:ws})).items.length,0);
  await c.rpc('runtime.prepare_update');c.close();await until(()=>(child.exitCode!==null||child.signalCode!==null),'prepared core exits');
  assert.equal(child.exitCode,0);
 }finally{if(c)c.close();if(child.exitCode===null)child.kill();await sleep(100);}
});
module.exports={connect,until};

test('core crash ends owned children; fresh core reports prior sessions exited; empty core stops after 30 seconds', {timeout:60000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wincmux-runtime-'));const pipe='\\\\.\\pipe\\wincmux-test-'+randomUUID();
 const start=()=>spawn(executable,['--data-dir',root,'--pipe',pipe,'--no-tray'],{windowsHide:true,stdio:'ignore'});let child=start(),c;
 try{
  c=await until(()=>connect(pipe).catch(()=>null),'crash core');const ws=(await c.rpc('workspace.create',{name:'Crash test',path:root,backend:'custom'})).workspace.id;
  const session=(await c.rpc('session.run',{workspace_id:ws,cmd:process.execPath,args:[path.resolve(__dirname,'fixture.cjs')],cwd:root})).session;
  const denied=spawnSync(executable,['--prepare-update','--data-dir',root,'--pipe',pipe],{windowsHide:true});assert.notEqual(denied.status,0);assert.equal(fs.existsSync(path.join(root,'update.lock')),false);
  child.kill();await until(()=>(child.exitCode!==null||child.signalCode!==null),'killed core');c.close();
  await until(()=>{try{process.kill(session.pid,0);return false;}catch{return true;}},'job-owned CLI exits');
  child=start();c=await until(()=>connect(pipe).catch(()=>null),'fresh core');
  const rows=(await c.rpc('session.list',{workspace_id:ws})).sessions;assert.equal(rows.find(s=>s.id===session.session_id).status,'exited');assert.equal((await c.rpc('runtime.info')).terminal_count,0);
  c.close();const began=Date.now();await until(()=>(child.exitCode!==null||child.signalCode!==null),'30-second idle shutdown',35000);assert.ok(Date.now()-began>=28000);assert.equal(child.exitCode,0);
  const prepared=spawnSync(executable,['--prepare-update','--data-dir',root,'--pipe',pipe],{windowsHide:true});assert.equal(prepared.status,0);assert.equal(fs.existsSync(path.join(root,'update.lock')),true);
  const blocked=start();await new Promise(resolve=>blocked.once('exit',resolve));assert.notEqual(blocked.exitCode,0);
  const cancelled=spawnSync(executable,['--cancel-update','--data-dir',root,'--pipe',pipe],{windowsHide:true});assert.equal(cancelled.status,0);assert.equal(fs.existsSync(path.join(root,'update.lock')),false);
 }finally{c?.close();if(child.exitCode===null)child.kill();}
});

test('native background notification uses the core without WebView2', {timeout:90000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wincmux-native-'));const pipe='\\\\.\\pipe\\wincmux-native-'+randomUUID();
 const child=spawn(executable,['--data-dir',root,'--pipe',pipe],{windowsHide:true,stdio:'ignore'});let c;
 try{
  c=await until(()=>connect(pipe).catch(()=>null),'native core');await c.rpc('client.attach',{client_id:'notification-test'});
  const ws=(await c.rpc('workspace.create',{name:'Native test',path:root,backend:'custom'})).workspace.id;
  await sleep(300);
  const pushed=await c.rpc('notify.push',{workspace_id:ws,title:'WinCMux 백그라운드 알림 테스트',body:'독립 코어에서 Windows 알림을 확인했습니다.',level:'info'});
  const row=await until(async()=>{const items=(await c.rpc('notify.unread',{workspace_id:ws})).items;return items.find(n=>n.id===pushed.notification.id);},'saved notification');
  assert.ok(row.delivered_at,'Windows must accept the native toast: '+(fs.existsSync(path.join(root,'core.log'))?fs.readFileSync(path.join(root,'core.log'),'utf8'):''));
  if(process.env.WINCMUX_MEASURE_IDLE==='1'){
   for(let i=0;i<6;i++)await c.rpc('session.run',{workspace_id:ws,cmd:process.execPath,args:[path.resolve(__dirname,'fixture.cjs')],cwd:root});
   await c.rpc('client.detach',{client_id:'notification-test'});
   const stats=()=>JSON.parse(spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${child.pid};[pscustomobject]@{privateMiB=[math]::Round($p.PrivateMemorySize64/1MB,2);cpu=$p.CPU;handles=$p.HandleCount}|ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}).stdout);
   await sleep(1500);const before=stats(),began=Date.now();await sleep(60000);const after=stats();
   const report={terminals:6,nativeTray:true,webview:false,privateMiB:after.privateMiB,idleCpuPercent:(after.cpu-before.cpu)/((Date.now()-began)/1000)*100,handles:after.handles};
   fs.mkdirSync(path.resolve(__dirname,'../../../artifacts/background-core'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../../../artifacts/background-core/native-background.json'),JSON.stringify(report,null,2));
   assert.ok(report.privateMiB<=60);assert.ok(report.idleCpuPercent<1);
  }

  await c.rpc('runtime.shutdown_all',{confirmed:true});await until(()=>(child.exitCode!==null||child.signalCode!==null),'native core exits');
 }finally{c?.close();if(child.exitCode===null&&child.signalCode===null)child.kill();}
});
