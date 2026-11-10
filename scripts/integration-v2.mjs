import {mkdirSync,appendFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {AcpTransport} from '../packages/acp-transport/index.mjs';
import {ExecutionStore} from '../packages/task-store-v2/index.mjs';
import {DshAcpExecutor} from '../packages/dsh-acp-v2/index.mjs';
import {loadWindowsConfig} from './windows-config.mjs';
const config=loadWindowsConfig();
const run=new Date().toISOString().replace(/[:.]/g,'-'),dir=path.join(config.cwd,'var','real-v2',run),logPath=path.join(config.cwd,'logs',`real-v2-${run}.jsonl`);mkdirSync(path.dirname(logPath),{recursive:true});
const log=(type,data)=>{const line=JSON.stringify({time:new Date().toISOString(),kind:'real-dsh',type,data});console.log(line);appendFileSync(logPath,line+'\n')};
const transports=[];const factory=()=>{const x=new AcpTransport({...config,onStderr:s=>log('stderr',s)});transports.push(x);return x;};
const make=()=>new DshAcpExecutor({store:new ExecutionStore(dir),transportFactory:factory,taskTimeoutMs:60000,sessionOperationTimeoutMs:30000,cancelTimeoutMs:10000});
let x=make();
async function waitDispatchIntent(id){const deadline=Date.now()+30000;while(Date.now()<deadline){const e=await x.getExecution(id);if(e.status==='running')return;if(!['queued'].includes(e.status))throw new Error('Did not run: '+JSON.stringify(e));await new Promise(r=>setTimeout(r,20))}throw new Error('dispatch intent deadline')}
try{
 await x.start();x.subscribeEvents(e=>log('event',e));log('environment',{runtime:'installed Windows DSH CLI 0.2.2-rc.1',sdk:'1.4.0',cwd:config.cwd});
 const t=await x.createTask({cwd:config.cwd,prompt:'请记住口令 FISH_V2_CONTEXT_83。只回复 FISH_V2_OK，不调用工具。',requestKey:'initial'});await x.waitForTask(t.taskId);let e=await x.getExecution(t.latestExecutionId);log('initial',e);assert.equal(e.status,'completed');assert.match(e.result,/FISH_V2_OK/);assert.ok(e.completionEvidence);const sid=(await x.getTask(t.taskId)).sessionId;
 const probe=factory();await probe.start();let cursor;const sessions=[];do{const page=await probe.request('session/list',{cwd:config.cwd,...cursor?{cursor}:{}});sessions.push(...page.sessions);cursor=page.nextCursor}while(cursor);await probe.stop();assert.ok(sessions.some(s=>s.sessionId===sid));log('list-confirmed',{sessionId:sid});
 await x.stop();x=make();await x.start();x.subscribeEvents(e=>log('event',e));await x.resumeTask(t.taskId);
 const continued=await x.startExecution(t.taskId,{requestKey:'continuation',prompt:'之前保存的口令是什么？只回复口令，不调用工具。'});await x.waitForTask(t.taskId);e=await x.getExecution(continued.executionId);assert.equal(e.status,'completed');assert.match(e.result,/FISH_V2_CONTEXT_83/);assert.equal((await x.getTask(t.taskId)).sessionId,sid);log('restored',e);
 const parallel=await Promise.all(['ONE','TWO'].map(s=>x.createTask({cwd:config.cwd,prompt:`只回复 PARALLEL_${s}，不调用工具。`,requestKey:'parallel-'+s})));await Promise.all(parallel.map(t=>x.waitForTask(t.taskId)));for(const task of parallel){const result=await x.getExecution(task.latestExecutionId);assert.equal(result.status,'completed');assert.match(result.result,/PARALLEL_/)}log('parallel',{executions:parallel.map(t=>t.latestExecutionId)});
 const cancel=await x.createTask({cwd:config.cwd,prompt:'详细解释1到1000每个整数的质因数分解，不调用工具。',requestKey:'cancel'});await waitDispatchIntent(cancel.latestExecutionId);await x.cancelExecution(cancel.latestExecutionId);e=await x.getExecution(cancel.latestExecutionId);assert.ok(['completed','cancelled'].includes(e.status));if(e.status==='cancelled')assert.ok(e.cancel.confirmedAt);log('cancel-race-actual-terminal',e);
 const death=await x.createTask({cwd:config.cwd,prompt:'详细推导1到1000每个整数的质因数分解，不调用工具。',requestKey:'runtime-death'});await waitDispatchIntent(death.latestExecutionId);const runtime=x.operations.get(death.latestExecutionId).transport;const pid=runtime.child.pid;runtime.child.kill();await x.waitForTask(death.taskId);e=await x.getExecution(death.latestExecutionId);assert.equal(e.status,'unknown');assert.equal(e.completionEvidence,null);log('runtime-kill-after-dispatch-intent',{pid,execution:e,note:'local dispatch intent, not proof the DSH prompt was executing'});
 await x.stop();x=make();await x.start();assert.equal((await x.getTask(death.taskId)).status,'unknown');assert.equal((await x.getExecution(continued.executionId)).status,'completed');log('PASS',{checks:['create','atomic receipt','list','new-process restore same Session/context','parallel Sessions','cancel actual terminal','real Runtime killed after durable dispatch intent (remote execution not proven)','restart unknown not resent'],logPath});
}catch(error){log('FAIL',{message:error.message,stack:error.stack});process.exitCode=1;}finally{await x.stop();for(const t of transports)await t.stop();}
