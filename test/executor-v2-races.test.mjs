import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ExecutionStore} from '../packages/task-store-v2/index.mjs';
import {DshAcpExecutor} from '../packages/dsh-acp-v2/index.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const input=requestKey=>({requestKey,cwd:'C:\\work',prompt:'hello'});
class ControlledTransport{
 constructor(){this.prompt=deferred();this.prompt.promise.catch(()=>{});this.entered=deferred();this.closeEntered=deferred();this.stopCalls=0;}
 async start(callbacks){this.callbacks=callbacks;return {agentCapabilities:{sessionCapabilities:{resume:{},close:{}}}};}
 async request(method,params){
  if(method==='session/new')return {sessionId:'controlled'};
  if(method==='session/prompt'){this.sessionId=params.sessionId;this.entered.resolve();return this.prompt.promise;}
  if(method==='session/close'){this.closeEntered.resolve();if(this.closeGate)await this.closeGate.promise;if(this.closeError)throw this.closeError;}
  return {};
 }
 async notify(){this.notifyEntered?.resolve();if(this.notifyGate)await this.notifyGate.promise;}
 async stop(){this.stopCalls++;if(this.stopError)throw this.stopError;this.prompt.reject(new Error('stopped'));}
 emit(text,sessionId=this.sessionId){this.callbacks.onUpdate({sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}});}
}
async function setup(t,options={},limits={}){
 const dir=mkdtempSync(path.join(tmpdir(),'fish-v2-races-')),transports=[];
 const x=new DshAcpExecutor({store:new ExecutionStore(dir,limits),transportFactory:()=>{const p=new ControlledTransport();transports.push(p);return p;},taskTimeoutMs:3000,cancelTimeoutMs:500,sessionOperationTimeoutMs:500,...options});
 await x.start();
 t.after(async()=>{for(const p of transports){p.stopError=null;p.closeError=null;p.closeGate?.resolve();p.notifyGate?.resolve();p.prompt.resolve({stopReason:'end_turn'});}await x.stop();rmSync(dir,{recursive:true,force:true});});
 return {x,transports};
}
test('next execution waits for delayed cancel send after actual end_turn and process cleanup',async t=>{
 const {x,transports}=await setup(t);const task=await x.createTask(input('cancel-old')),p=transports[0];await p.entered.promise;
 p.notifyEntered=deferred();p.notifyGate=deferred();const cancel=x.cancelExecution(task.latestExecutionId);cancel.catch(()=>{});await p.notifyEntered.promise;
 p.prompt.resolve({stopReason:'end_turn'});await x.waitForTask(task.taskId);
 assert.equal((await x.getExecution(task.latestExecutionId)).status,'completed');
 await assert.rejects(x.startExecution(task.taskId,{requestKey:'blocked',prompt:'next'}),{code:'BUSY'});
 p.notifyGate.resolve();await cancel;
 const next=await x.startExecution(task.taskId,{requestKey:'allowed',prompt:'next'});await transports[1].entered.promise;transports[1].prompt.resolve({stopReason:'end_turn'});await x.waitForTask(task.taskId);assert.notEqual(next.executionId,task.latestExecutionId);
});
test('context reconciliation waits for prior cancellation send to settle',async t=>{
 const {x,transports}=await setup(t);const task=await x.createTask(input('cancel-reconcile')),p=transports[0];await p.entered.promise;
 p.notifyEntered=deferred();p.notifyGate=deferred();const cancel=x.cancelExecution(task.latestExecutionId);cancel.catch(()=>{});await p.notifyEntered.promise;
 p.prompt.resolve({stopReason:'end_turn'});await x.waitForTask(task.taskId);
 await assert.rejects(x.reconcileTask(task.taskId,{restoreContext:true}),{code:'BUSY'});
 p.notifyGate.resolve();await cancel;
});
test('executor stop settles in-flight cancellation before closing its store',async t=>{
 const {x,transports}=await setup(t);const task=await x.createTask(input('cancel-stop')),p=transports[0];await p.entered.promise;
 p.notifyEntered=deferred();p.notifyGate=deferred();const cancel=x.cancelExecution(task.latestExecutionId);cancel.catch(()=>{});await p.notifyEntered.promise;
 p.prompt.resolve({stopReason:'end_turn'});await x.waitForTask(task.taskId);
 let stopped=false;const stopping=x.stop().then(()=>{stopped=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
 p.notifyGate.resolve();await Promise.all([cancel,stopping]);
});
test('terminal result does not release next execution before session close finishes',async t=>{
 const {x,transports}=await setup(t);const task=await x.createTask(input('close-old')),p=transports[0];await p.entered.promise;p.closeGate=deferred();p.prompt.resolve({stopReason:'end_turn'});await p.closeEntered.promise;
 assert.equal((await x.getExecution(task.latestExecutionId)).status,'completed');
 await assert.rejects(x.startExecution(task.taskId,{requestKey:'blocked',prompt:'next'}),{code:'BUSY'});
 p.closeGate.resolve();await x.waitForTask(task.taskId);assert.equal(p.stopCalls,1);
});
test('failed task close persists closed lifecycle and cleanup can be retried',async t=>{
 const {x,transports}=await setup(t);const task=await x.createTask(input('failed-close')),p=transports[0];await p.entered.promise;p.closeError=new Error('close failed');p.prompt.resolve({stopReason:'end_turn'});await x.waitForTask(task.taskId);
 const factory=x.transportFactory;x.transportFactory=()=>{const transport=factory();transport.closeError=p.closeError;return transport;};
 await assert.rejects(x.closeTask(task.taskId),/close failed/);
 assert.equal((await x.getTask(task.taskId)).lifecycle,'closed');
 await assert.rejects(x.startExecution(task.taskId,{requestKey:'blocked',prompt:'next'}),{code:'TASK_CLOSED'});
 p.closeError=null;
 await x.closeTask(task.taskId);
});
test('dispatching deferred work obeys the global execution limit',async t=>{
 const {x,transports}=await setup(t,{maxConcurrent:1});
 const first=await x.createTask({...input('queued-first'),defer:true});const second=await x.createTask({...input('queued-second'),defer:true});
 await x.dispatchQueued(first.latestExecutionId);await transports[0].entered.promise;
 await assert.rejects(x.dispatchQueued(second.latestExecutionId),{code:'BUSY'});
 assert.equal(transports.length,1);
});
test('full notification quarantine still allows durable unknown terminal diagnosis',async t=>{
 const {x,transports}=await setup(t);const task=await x.createTask(input('quarantine')),p=transports[0];await p.entered.promise;
 for(let i=0;i<32;i++)p.emit('wrong session','other');
 p.prompt.reject(new Error('runtime lost'));
 await x.waitForTask(task.taskId);
 const e=await x.getExecution(task.latestExecutionId);assert.equal(e.status,'unknown');assert.ok(e.diagnostics.length<=32);assert.equal((await x.healthCheck()).storageFault,null);
});
test('escaped quarantine payload remains inside byte-limited durable diagnostics',async t=>{
 const {x,transports}=await setup(t);const task=await x.createTask(input('escaped')),p=transports[0];await p.entered.promise;
 p.emit('\u0001'.repeat(1000),'other');p.prompt.resolve({stopReason:'end_turn'});
 await x.waitForTask(task.taskId);const e=await x.getExecution(task.latestExecutionId);assert.equal(e.status,'unknown');assert.ok(e.diagnostics.every(d=>Buffer.byteLength(JSON.stringify(d))<=1024));
});
test('failed transport stop retains ownership until explicit retry succeeds',async t=>{
 const {x,transports}=await setup(t);const task=await x.createTask(input('stop-retry')),p=transports[0];await p.entered.promise;
 p.stopError=Object.assign(new Error('process still alive'),{code:'SHUTDOWN_TIMEOUT'});p.prompt.resolve({stopReason:'end_turn'});await x.waitForTask(task.taskId);
 assert.equal((await x.healthCheck()).cleanupFailures.length,1);
 await assert.rejects(x.stop(),{code:'SHUTDOWN_TIMEOUT'});
 assert.equal((await x.healthCheck()).store.healthy,true);
 p.stopError=null;await x.stop();assert.ok(p.stopCalls>=3);
});
test('multibyte runtime error preserves a bounded durable unknown diagnosis',async t=>{
 const {x,transports}=await setup(t);const task=await x.createTask(input('multibyte-error')),p=transports[0];await p.entered.promise;
 p.prompt.reject(new Error('界'.repeat(1500)));await x.waitForTask(task.taskId);
 const e=await x.getExecution(task.latestExecutionId);assert.equal(e.status,'unknown');assert.ok(e.diagnostics.every(d=>Buffer.byteLength(JSON.stringify(d))<=1024));
});
test('output cap counts UTF-8 bytes and preserves only accepted partial chunks',async t=>{
 const {x,transports}=await setup(t,{maxOutputBytes:6});const task=await x.createTask(input('multibyte-output')),p=transports[0];await p.entered.promise;
 p.emit('界界');p.emit('x');p.prompt.resolve({stopReason:'end_turn'});await x.waitForTask(task.taskId);
 const e=await x.getExecution(task.latestExecutionId);assert.equal(e.status,'unknown');assert.equal(e.result,'界界');assert.equal(e.completionEvidence,null);assert.ok(e.diagnostics.some(d=>d.code==='OUTPUT_LIMIT'));
});
test('low-rate output batches stop spending timer events while byte flushes stay bounded',async t=>{
 const {x,transports}=await setup(t,{flushMs:1});const task=await x.createTask(input('low-rate')),p=transports[0];await p.entered.promise;
 for(let i=0;i<40;i++){p.emit('x');await new Promise(resolve=>setTimeout(resolve,3));}
 const before=(await x.getEvents(0,1000)).filter(e=>e.type==='execution.output').length;
 assert.ok(before<=32,`timer-only output commits: ${before}`);
 for(let i=0;i<70;i++)p.emit('y'.repeat(1024));
 assert.ok(Buffer.byteLength(x.operations.get(task.latestExecutionId).pending)<=65536,'pending output stays within 64 KiB after timer budget is exhausted');
 p.prompt.resolve({stopReason:'end_turn'});await x.waitForTask(task.taskId);
 const e=await x.getExecution(task.latestExecutionId);assert.equal(e.result,'x'.repeat(40)+'y'.repeat(70*1024));assert.equal(e.status,'completed');
 assert.ok((await x.getEvents(0,1000)).filter(e=>e.type==='execution.output').length<=35);
});
test('derived timer overflow rejects construction before any transport exists',()=>{
 let created=0;
 for(const options of [
  {taskTimeoutMs:2147483647,cancelTimeoutMs:1,sessionOperationTimeoutMs:1},
  {taskTimeoutMs:1,cancelTimeoutMs:100,sessionOperationTimeoutMs:2147483600},
  {taskTimeoutMs:100,cancelTimeoutMs:100,sessionOperationTimeoutMs:1073741800},
 ])assert.throws(()=>new DshAcpExecutor({store:{},transportFactory:()=>{created++;return {};},...options}),{code:'INVALID_TIMEOUT'});
 assert.equal(created,0);
});
test('high-water admission rejection preserves budget for an active execution terminal',async t=>{
 const {x,transports}=await setup(t,{}, {maxTasks:1,maxEvents:100,reserveEvents:20});
 const task=await x.createTask(input('capacity-active')),p=transports[0];await p.entered.promise;
 await assert.rejects(x.createTask(input('capacity-reject')),{code:'CAPACITY'});
 p.emit('complete answer');p.prompt.resolve({stopReason:'end_turn'});await x.waitForTask(task.taskId);
 assert.equal((await x.getExecution(task.latestExecutionId)).status,'completed');assert.equal((await x.healthCheck()).healthy,true);
});
