import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ExecutionStore} from '../packages/task-store-v2/index.mjs';
import {DshAcpExecutor} from '../packages/dsh-acp-v2/index.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});promise.catch(()=>{});return {promise,resolve,reject};};
const input=requestKey=>({requestKey,cwd:'C:\\work',prompt:'hello'});
class Transport{
 constructor(server){this.server=server;this.entered=deferred();this.resumeEntered=deferred();this.abort=deferred();this.calls=[];this.stops=0;}
 async start(callbacks={}){this.callbacks=callbacks;return {agentCapabilities:{sessionCapabilities:{resume:{},close:{}}}};}
 async request(method,params){
  this.calls.push(method);
  if(method==='session/new')return {sessionId:'s'+(++this.server.sessions)};
  if(method==='session/prompt'){this.entered.resolve();if(this.server.hold)return Promise.race([this.server.hold.promise,this.abort.promise]);return {stopReason:'end_turn'};}
  if(method==='session/resume'){this.resumeEntered.resolve();if(this.server.resumeError)throw new Error('restore unavailable');if(this.server.resumeGate)await Promise.race([this.server.resumeGate.promise,this.abort.promise]);}
  return {};
 }
 async stop(){this.stops++;this.abort.reject(new Error('transport stopped'));}
 async notify(){}
}
async function setup(t,{limits={},wrapStore}={}){
 const dir=mkdtempSync(path.join(tmpdir(),'fish-recovery-v2-')),store=new ExecutionStore(dir,limits),server={sessions:0,transports:[]};
 const factory=()=>{const p=new Transport(server);server.transports.push(p);return p;};
 const x=new DshAcpExecutor({store:wrapStore?wrapStore(store):store,transportFactory:factory,taskTimeoutMs:3000,cancelTimeoutMs:100,sessionOperationTimeoutMs:200});
 await x.start();t.after(async()=>{server.resumeGate?.resolve();server.hold?.resolve({stopReason:'end_turn'});await x.stop();rmSync(dir,{recursive:true,force:true});});
 return {x,dir,store,server,factory};
}
test('failed and repeated context recovery uses fresh transports without mutating executions',async t=>{
 const {x,server}=await setup(t);const task=await x.createTask(input('original'));await x.waitForTask(task.taskId);const original=await x.getExecution(task.latestExecutionId);
 const snap=await x.store.snapshot();const binding=snap.bindings[0];x.store.commit(snap.revision,{bindings:[{...binding,availability:'unknown',recoveryRequired:true}]});
 server.resumeError=true;await assert.rejects(x.reconcileTask(task.taskId,{restoreContext:true}),/restore unavailable/);
 assert.deepEqual(await x.getExecution(task.latestExecutionId),original);assert.equal(server.transports.at(-1).stops,1);
 server.resumeError=false;
 for(let i=0;i<3;i++){await x.reconcileTask(task.taskId,{restoreContext:true});assert.deepEqual(await x.getExecution(task.latestExecutionId),original);assert.equal(server.transports.at(-1).stops,1);}
 // create + one failed remote reconcile + one successful remote reconcile; later closed bindings are local no-ops.
 assert.equal(server.transports.length,3);assert.equal(server.transports.flatMap(p=>p.calls).filter(m=>m==='session/prompt').length,1);
});
test('stop owns a context transport while resume is pending and preserves completed history',async t=>{
 const {x,server,dir,factory}=await setup(t);const task=await x.createTask(input('restore-stop'));await x.waitForTask(task.taskId);const original=await x.getExecution(task.latestExecutionId);
 const snap=await x.store.snapshot();const binding=snap.bindings[0];x.store.commit(snap.revision,{bindings:[{...binding,availability:'unknown',recoveryRequired:true}]});
 server.resumeGate=deferred();const recovery=x.reconcileTask(task.taskId,{restoreContext:true});recovery.catch(()=>{});
 await new Promise(resolve=>setImmediate(resolve));const p=server.transports.at(-1);await p.resumeEntered.promise;
 await x.stop();await assert.rejects(recovery,/transport stopped/);assert.ok(p.stops>=1);
 const y=new DshAcpExecutor({store:new ExecutionStore(dir),transportFactory:factory});await y.start();try{assert.deepEqual(await y.getExecution(task.latestExecutionId),original);}finally{await y.stop();}
});
test('terminal commit failure reports storage fault and reopens as unknown without false evidence',async t=>{
 let failTerminal=true;
 const {x,dir,factory,server}=await setup(t,{wrapStore:store=>({open:()=>store.open(),close:()=>store.close(),snapshot:()=>store.snapshot(),healthCheck:()=>store.healthCheck(),commit:(revision,changes)=>{
  if(failTerminal&&changes.executions?.some(e=>e.status==='completed'))throw Object.assign(new Error('injected disk failure before commit'),{code:'EIO'});
  return store.commit(revision,changes);
 }})});
 const task=await x.createTask(input('terminal-fault'));await assert.rejects(x.waitForTask(task.taskId),{code:'STORAGE_FAULT'});
 const e=await x.getExecution(task.latestExecutionId);assert.equal(e.status,'running');assert.equal(e.completionEvidence,null);const health=await x.healthCheck();assert.equal(health.healthy,false);assert.match(health.storageFault,/injected disk failure/);assert.ok(server.transports.every(p=>p.stops>0));
 await x.stop();failTerminal=false;const y=new DshAcpExecutor({store:new ExecutionStore(dir),transportFactory:factory});await y.start();try{const restored=await y.getExecution(task.latestExecutionId);assert.equal(restored.status,'unknown');assert.equal(restored.completionEvidence,null);assert.deepEqual((await y.getTask(task.taskId)).unresolvedExecutionIds,[task.latestExecutionId]);}finally{await y.stop();}
});
test('event high-water admission leaves reserved events for active terminal and cleanup',async t=>{
 const {x,server,store}=await setup(t,{limits:{maxEvents:24,reserveEvents:8}});server.hold=deferred();const task=await x.createTask(input('active'));await server.transports[0].entered.promise;
 const snapshot=store.snapshot();store.commit(snapshot.revision,{events:Array.from({length:13},()=>({type:'test.budget',taskId:task.taskId}))});
 await assert.rejects(x.createTask(input('rejected')),{code:'CAPACITY'});
 server.hold.resolve({stopReason:'end_turn'});await x.waitForTask(task.taskId);assert.equal((await x.getExecution(task.latestExecutionId)).status,'completed');assert.equal((await x.healthCheck()).healthy,true);assert.ok(store.snapshot().events.length<=24);
});
