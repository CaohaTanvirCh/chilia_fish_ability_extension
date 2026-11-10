import {mkdirSync,appendFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {AcpTransport} from '../packages/acp-transport/index.mjs';
import {DshAcpExecutor} from '../packages/dsh-acp/index.mjs';
import {TaskStore} from '../packages/task-store/index.mjs';
import {loadWindowsConfig} from './windows-config.mjs';
const config=loadWindowsConfig();
const run=new Date().toISOString().replace(/[:.]/g,'-');
const directory=path.join(config.cwd,'var','integration',run);
mkdirSync(path.join(config.cwd,'logs'),{recursive:true});
const logPath=path.join(config.cwd,'logs',`integration-${run}.jsonl`);
const log=(type,data)=>{const line=JSON.stringify({time:new Date().toISOString(),type,data});console.log(line);appendFileSync(logPath,line+'\n');};
const make=()=>{const transport=new AcpTransport({...config,onStderr:text=>log('stderr',text)});const executor=new DshAcpExecutor({transport,store:new TaskStore(directory),taskTimeoutMs:60000,cancelTimeoutMs:15000});return {transport,executor};};
let {transport,executor}=make();
try{
 await executor.initialize();executor.subscribeEvents(event=>log('event',event));await executor.start();log('health',await executor.healthCheck());
 const task=await executor.createTask({cwd:config.cwd,prompt:'请记住本会话验证口令 FISH_RECOVERY_73。仅回复 FISH_ACP_OK，不调用工具。'});
 const finished=await executor.waitForTask(task.taskId);assert.equal(finished.status,'completed');assert.match(finished.result,/FISH_ACP_OK/);log('completed',finished);
 await executor.closeTask(task.taskId);
 const listed=await transport.request('session/list',{cwd:config.cwd});assert.ok(listed.sessions.some(s=>s.sessionId===finished.sessionId));log('listed',listed);
 await executor.stop();log('runtime-stopped',{taskId:task.taskId});
 ({transport,executor}=make());await executor.initialize();executor.subscribeEvents(event=>log('event',event));await executor.start();
 await executor.resumeTask(task.taskId,{prompt:'上一轮我让你记住的验证口令是什么？只回复口令，不调用工具。'});
 const restored=await executor.waitForTask(task.taskId);assert.equal(restored.sessionId,finished.sessionId);assert.equal(restored.status,'completed');assert.match(restored.result,/FISH_RECOVERY_73/);log('restored',restored);
 let resolveRunning;const running=new Promise(resolve=>{resolveRunning=resolve;});
 const unsub=executor.subscribeEvents(event=>{if(event.payload.status==='running') resolveRunning(event.taskId);});
 const cancellation=await executor.createTask({cwd:config.cwd,prompt:'请详细推导并解释从1到1000每个整数的质因数分解，不调用工具。'});
 await running;unsub();const cancelled=await executor.cancelTask(cancellation.taskId);assert.equal(cancelled.status,'cancelled');log('cancelled',cancelled);
 await executor.closeTask(cancellation.taskId);await executor.closeTask(task.taskId);
 log('PASS',{checks:['create','prompt','output','close','list','runtime restart','resume same session with context','cancel active prompt'],logPath});
}catch(error){log('FAIL',{message:error.message,stack:error.stack});process.exitCode=1;}
finally{await executor.stop();}
