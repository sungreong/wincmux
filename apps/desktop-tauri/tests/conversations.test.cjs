const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../renderer/renderer.conversations.js'),'utf8');
const id = '12345678-1234-1234-1234-123456789abc';
function harness({ live=false, delayed=false }={}) {
  let complete;
  const calls=[];
  const context={ window:{addEventListener:()=>{}},document:{getElementById:()=>null},
    state:{selectedWorkspaceId:'ws',selectedPaneId:'pane',paneViews:new Map([['pane',{sessionId:live?'existing':null}]]),paneSessions:live?{pane:'existing'}:{}},
    dormantPaneSession:()=>null, setStatus:()=>{},
    splitPaneInternal:async(...args)=>{calls.push(['split',...args]);return {first:'kept',second:'new'};},
    rpc:async(method,params)=>{calls.push(['rpc',method,params]);if(delayed)await new Promise(r=>{complete=r;});return {id,provider:'claude',cwd:'C:/project',cwd_exists:true,resume_command:'UNTRUSTED; never run'};},
    startShellCommandForPane:async(...args)=>{calls.push(['start',...args]);return 'started';}
  };
  vm.createContext(context);vm.runInContext(source,context);
  return {api:context.window.wincmuxConversations,context,calls,complete:()=>complete()};
}
const selection={workspaceId:'ws',paneId:'pane',includeChildren:true};
test('resume validates membership, generates command from UUID and preserves a live pane',async()=>{
  const h=harness({live:true});
  assert.equal(await h.api.resume({provider:'claude',id},selection),'started');
  const start=h.calls.find(c=>c[0]==='start');assert.equal(start[1],'new');assert.equal(start[2],`claude --resume ${id}`);
  assert.equal(start[3].force,false);assert.equal(start[3].strictCwd,true);assert.equal(start[3].cwd,'C:/project');
  assert.equal(h.context.state.paneSessions.pane,'existing');assert.ok(h.calls.some(c=>c[0]==='split'));
});
test('double click cannot launch twice and changing workspace aborts pending resume',async()=>{
  const h=harness({delayed:true});const first=h.api.resume({provider:'claude',id},selection);
  assert.equal(await h.api.resume({provider:'claude',id},selection),null);
  h.context.state.selectedWorkspaceId='other';h.complete();await assert.rejects(first,/프로젝트가 변경/);
  assert.equal(h.calls.filter(c=>c[0]==='start').length,0);
});
test('rejects injected identifiers and tool names before any RPC or shell command',async()=>{
  const h=harness();
  await assert.rejects(h.api.resume({provider:'claude',id:id+';whoami'},selection),/ID/);
  await assert.rejects(h.api.resume({provider:'powershell',id},selection),/ID/);
  assert.equal(h.calls.length,0);
});
