const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
async function until(check,label,ms=15000) {
  const end=Date.now()+ms;while(Date.now()<end){const result=await check();if(result)return result;await sleep(50);}throw new Error('Timed out: '+label);
}
async function connect(pipe) {
  const socket=net.createConnection(pipe).setEncoding('utf8');
  await new Promise((resolve,reject)=>socket.once('connect',resolve).once('error',reject));
  let sequence=0,buffer='';const pending=new Map(); const events=[];
  socket.on('error',()=>{});
  socket.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\n'))>=0){const packet=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(packet.id)pending.get(packet.id)?.(packet);else events.push(packet);}});
  return {events,close:()=>socket.destroy(),rpc:(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout '+method));},10000);
    pending.set(id,packet=>{clearTimeout(timer);pending.delete(id);packet.error?reject(new Error(packet.error.message)):resolve(packet.result);});
    socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  })};
}
test('manual and detected reminders persist, deduplicate and fire without a UI or live terminal', {timeout:90000}, async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wincmux-reminder-runtime-'));
  const pipe='\\\\.\\pipe\\wincmux-reminders-'+randomUUID();
  const exe=path.resolve(__dirname,'../src-tauri/target/release/wincmux-core.exe');
  let core,client;
  const launch=async()=>{
    core=spawn(exe,['--data-dir',temp,'--pipe',pipe,'--no-tray'],{windowsHide:true,stdio:'ignore'});
    client=await until(()=>connect(pipe).catch(()=>null),'core startup');
    await client.rpc('client.attach',{client_id:'reminder-test'});
  };
  try {
    await launch();
    assert.equal((await client.rpc('runtime.info')).reminders_supported,true);
    const ws=(await client.rpc('workspace.create',{name:'Reminder integration',path:temp,backend:'custom'})).workspace.id;
    let due=Math.floor(Date.now()/1000)+8;
    const manual=await client.rpc('reminder.save',{workspace_id:ws,title:'수동 알림',body:'재실행 후에도 한 번만',provider:'custom',timezone:'Asia/Seoul',due_at:due});
    await client.rpc('reminder.save',{id:manual.id,workspace_id:ws,title:'수정된 수동 알림',body:'재실행 후에도 한 번만',provider:'custom',timezone:'Asia/Seoul',due_at:due});
    await client.rpc('runtime.shutdown_all',{confirmed:true});client.close();
    await until(()=>core.exitCode!==null,'core exits');
    await launch();
    await client.rpc('client.detach',{client_id:'reminder-test'});
    assert.equal((await client.rpc('runtime.info')).pending_reminders,1);
    await until(async()=> (await client.rpc('reminder.list')).items.find(r=>r.id===manual.id)?.status==='sent','persisted manual delivery');
    const unread=await client.rpc('notify.unread',{});
    assert.equal(unread.items.filter(n=>n.kind==='reminder_due').length,1);
    assert.equal(unread.items.find(n=>n.kind==='reminder_due').title,'수정된 수동 알림');
    await sleep(1100);
    assert.equal((await client.rpc('notify.unread',{})).items.filter(n=>n.kind==='reminder_due').length,1);
    await client.rpc('client.attach',{client_id:'reminder-test'});
    const cancelled=await client.rpc('reminder.save',{workspace_id:ws,title:'취소할 알림',timezone:'Asia/Seoul',due_at:Math.floor(Date.now()/1000)+2});
    await client.rpc('reminder.cancel',{id:cancelled.id});
    const deleted=await client.rpc('reminder.save',{workspace_id:ws,title:'삭제할 알림',timezone:'Asia/Seoul',due_at:Math.floor(Date.now()/1000)+2});
    await client.rpc('reminder.delete',{id:deleted.id});
    assert.ok(!(await client.rpc('reminder.list')).items.some(r=>r.id===deleted.id));
    const sessionIds=[];let compactSession;
    for(const provider of ['claude','codex','gemini','unknown','auto-continue']) {
      const run=await client.rpc('session.run',{workspace_id:ws,cmd:process.execPath,args:[path.resolve(__dirname,'fixture.cjs')],cwd:temp});
      const sid=run.session.session_id; sessionIds.push(sid);
      await until(async()=> (await client.rpc('session.tail',{session_id:sid})).output.includes('FIXTURE_READY'),'fixture');
      await client.rpc('session.write',{session_id:sid,data:`#quota:${provider}#`});
      await until(async()=> (await client.rpc('reminder.list')).items.some(r=>r.session_id===sid),'automatic '+provider);
      const before=(await client.rpc('reminder.list')).items.filter(r=>r.session_id===sid);
      assert.equal(before.length,1);
      if(provider==='auto-continue') {
        compactSession=sid;
        assert.equal(before[0].provider,'codex');
        assert.ok(Number.isSafeInteger(before[0].observed_at));
        const observed=before[0].observed_at,local=new Date((observed+9*3600)*1000);
        let expected=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),19,50)/1000-9*3600;
        if(expected<=observed-60)expected+=86400;
        assert.equal(before[0].due_at,expected,'compact 7:50pm is resolved using the observation date; credit now does not replace it');
        await client.rpc('session.write',{session_id:sid,data:'#quota:auto-continue#'});
        await sleep(1100);
        assert.equal((await client.rpc('reminder.list')).items.filter(r=>r.session_id===sid).length,1);
        await client.rpc('reminder.cancel',{id:before[0].id});
      } else if(provider==='unknown') {
        assert.equal(before[0].status,'needs_time');
      } else {
        assert.equal(before[0].provider,provider);
        await client.rpc('session.write',{session_id:sid,data:`#quota:${provider}#`});
        await until(async()=> (await client.rpc('notify.unread',{})).items.some(n=>n.kind==='reminder_due'&&n.session_id===sid),'detected due '+provider);
        assert.equal((await client.rpc('reminder.list')).items.filter(r=>r.session_id===sid).length,0,'expired automatic reminder is removed');
        assert.equal((await client.rpc('notify.unread',{})).items.filter(n=>n.kind==='reminder_due'&&n.session_id===sid).length,1,'repaint does not duplicate delivery');
      }
      await client.rpc('session.close',{session_id:sid});
    }
    await client.rpc('reminder.settings.save',{auto_enabled:false,timezone:'Asia/Seoul'});
    const run=await client.rpc('session.run',{workspace_id:ws,cmd:process.execPath,args:[path.resolve(__dirname,'fixture.cjs')],cwd:temp});
    await until(async()=> (await client.rpc('session.tail',{session_id:run.session.session_id})).output.includes('FIXTURE_READY'),'disabled fixture');
    await client.rpc('session.write',{session_id:run.session.session_id,data:'#quota:claude#'});
    await sleep(1500);
    assert.ok(!(await client.rpc('reminder.list')).items.some(r=>r.session_id===run.session.session_id));
    await client.rpc('session.close',{session_id:run.session.session_id});
    const final=await client.rpc('notify.unread',{});
    assert.equal(final.items.filter(n=>n.kind==='reminder_due'&&n.session_id!==compactSession).length,4);
    console.log(JSON.stringify({manualAfterRestart:true,claude:true,codex:true,gemini:true,compactClock:true,observationDate:true,creditsNowIgnored:true,unknownTime:true,dedup:true,cancel:true,delete:true,disabled:true}));
  }finally{
    if(client){await client.rpc('runtime.shutdown_all',{confirmed:true}).catch(()=>{});client.close();}
    if(core?.exitCode===null)core.kill();
  }
});
