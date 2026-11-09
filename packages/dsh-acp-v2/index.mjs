import {randomUUID,createHash} from 'node:crypto';
import {normalizeWorkspace} from '../windows-paths/index.mjs';
const now=()=>new Date().toISOString();
const fault=(code,message)=>Object.assign(new Error(message),{code});
const active=new Set(['queued','running']);
const uncertain=new Set(['unknown','interrupted']);
function text(s,name){if(typeof s!=='string'||!s.trim())throw fault('INVALID_INPUT',`${name} must be nonempty`);}
function duration(n){if(!Number.isSafeInteger(n)||n<=0||n>2147483647)throw fault('INVALID_TIMEOUT','Duration must fit a positive Node timer');return n;}
function bounded(p,ms){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('TIMEOUT','Operation deadline exceeded')),ms)})]).finally(()=>clearTimeout(timer));}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const diagnostics=items=>items.slice(-32).map(item=>Buffer.byteLength(JSON.stringify(item))<=1024?item:{code:item.code??'DIAGNOSTIC',message:Buffer.from(item.message??item.detail??'').subarray(0,600).toString('utf8')});

/** v2 executor: one official ACP connection per attempt; durable state through public Store only. */
export class DshAcpExecutor {
 constructor({transportFactory,store,taskTimeoutMs=300000,sessionOperationTimeoutMs=30000,cancelTimeoutMs=5000,maxOutputBytes=1048576,flushBytes=65536,flushMs=250,maxConcurrent=8,runtimeId='windows-acp',hooks={}}){
  if(typeof transportFactory!=='function'||!store)throw new TypeError('transportFactory and store required');
  [taskTimeoutMs,sessionOperationTimeoutMs,cancelTimeoutMs,flushMs].forEach(duration);
  [taskTimeoutMs+cancelTimeoutMs,cancelTimeoutMs+sessionOperationTimeoutMs,taskTimeoutMs+2*sessionOperationTimeoutMs+cancelTimeoutMs].forEach(duration);
  Object.assign(this,{transportFactory,store,taskTimeoutMs,sessionOperationTimeoutMs,cancelTimeoutMs,maxOutputBytes,flushBytes,flushMs,maxConcurrent,runtimeId,hooks});
  this.operations=new Map();this.contextTransports=new Set();this.cancelGates=new Map();this.cancellations=new Set();this.gates=new Map();this.listeners=new Set();this.initialized=false;this.stopping=false;this.storageFault=null;this.sequence=0;
 }
 async initialize(){if(this.initialized)return;if(this.stopping)throw fault('STOPPED','Executor stopped');this.store.open();this.initialized=true;this.sequence=this.store.snapshot().sequence;}
 async start(){await this.initialize();if(this.stopping||this.storageFault)throw fault('UNAVAILABLE','Executor unavailable');}
 state(){return this.store.snapshot();}
 task(id){const t=this.state().tasks.find(t=>t.taskId===id);if(!t)throw fault('TASK_NOT_FOUND',id);return t;}
 execution(id){const e=this.state().executions.find(e=>e.executionId===id);if(!e)throw fault('EXECUTION_NOT_FOUND',id);return e;}
 binding(id){return this.state().bindings.find(b=>b.bindingId===id);}
 project(task,executions){
  const es=executions.filter(e=>e.taskId===task.taskId),latest=es.find(e=>e.executionId===task.latestExecutionId),a=es.find(e=>active.has(e.status));
  const unresolved=es.filter(e=>uncertain.has(e.status)).map(e=>e.executionId);
  return {...task,activeExecutionId:a?.executionId??null,unresolvedExecutionIds:unresolved,duplicateExecutionRisk:unresolved.length>0||es.some(e=>e.duplicateExecutionRisk),status:unresolved.length||task.integrityAlerts?.length?'unknown':a?.status??latest?.status??'queued',result:latest?.result??'',sessionId:latest?.bindingId?this.binding(latest.bindingId)?.sessionId??null:null,updatedAt:now(),revision:(task.revision??0)+1};
 }
 commit(changes){
  if(this.storageFault)throw fault('STORAGE_FAULT',this.storageFault.message);
  try{const before=this.state();const after=this.store.commit(before.revision,changes);for(const e of after.events.filter(e=>e.sequence>this.sequence)){this.sequence=e.sequence;for(const f of this.listeners){try{f(e)}catch{}}}return after;}
  catch(error){if(!['REVISION_CONFLICT','CAPACITY','INVALID_TRANSITION','VALIDATION_ERROR','STORE_CAPACITY'].includes(error.code)){this.storageFault=error;for(const op of this.operations.values()){op.reject(error);void op.transport?.stop().catch(()=>{});}}throw error;}
 }
 changeExecution(id,patch,type='execution.updated',extra={}){
  const before=this.state(),old=this.execution(id),e={...old,...patch,updatedAt:now()};const all=before.executions.map(x=>x.executionId===id?e:x);const t=this.project(this.task(e.taskId),all);
  this.commit({...extra,executions:[e],tasks:[t],events:[{type,taskId:e.taskId,executionId:id,data:{status:e.status,submission:e.submission,resultBytes:Buffer.byteLength(e.result??'')}}]});return e;
 }
 async gate(id,fn){const prior=this.gates.get(id)??Promise.resolve();const run=prior.catch(()=>{}).then(fn);this.gates.set(id,run);try{return await run}finally{if(this.gates.get(id)===run)this.gates.delete(id)}}
 async createTask(input){
  await this.start();text(input.requestKey,'requestKey');text(input.prompt,'prompt');const cwd=normalizeWorkspace(input.cwd);const inputHash=hash({kind:'create',cwd,prompt:input.prompt,taskId:input.taskId??null});
  const previous=this.state().requests.find(r=>r.key===input.requestKey);if(previous){if(previous.inputHash!==inputHash)throw fault('IDEMPOTENCY_CONFLICT','requestKey reused with different input');return this.task(previous.taskId);}
  if(this.operations.size>=this.maxConcurrent)throw fault('BUSY','Execution concurrency limit');
  const taskId=input.taskId??randomUUID();if(this.state().tasks.some(t=>t.taskId===taskId))throw fault('TASK_EXISTS',taskId);
  const e=this.newExecution(taskId,input.prompt,input.requestKey),t={taskId,cwd,objective:input.prompt,lifecycle:'open',status:'queued',latestExecutionId:e.executionId,activeExecutionId:e.executionId,unresolvedExecutionIds:[],duplicateExecutionRisk:false,integrityAlerts:[],createdAt:now(),updatedAt:now(),revision:1,result:'',sessionId:null};
  this.commit({admission:true,tasks:[t],executions:[e],requests:[{key:input.requestKey,inputHash,taskId,executionId:e.executionId}],events:[{type:'task.created',taskId,executionId:e.executionId}]});
  this.hooks.afterCreate?.(e);
  if(input.defer!==true)this.launch(e.executionId);
  return this.task(taskId);
 }
 newExecution(taskId,prompt,requestKey){return {executionId:randomUUID(),taskId,prompt,requestKey,status:'queued',submission:'not_started',bindingId:null,result:'',resultIntegrity:'partial',completionEvidence:null,cancel:{requestedAt:null,sentAt:null,confirmedAt:null},diagnostics:[],createdAt:now(),updatedAt:now(),duplicateExecutionRisk:false};}
 async startExecution(taskId,input){await this.start();return this.gate(taskId,async()=>{
  text(input.requestKey,'requestKey');text(input.prompt,'prompt');const inputHash=hash({kind:'execute',taskId,prompt:input.prompt,acknowledgeUnknownExecutionIds:input.acknowledgeUnknownExecutionIds??[]});
  const previous=this.state().requests.find(r=>r.key===input.requestKey);if(previous){if(previous.inputHash!==inputHash)throw fault('IDEMPOTENCY_CONFLICT','requestKey conflict');return this.execution(previous.executionId);}
  const t=this.task(taskId);if(t.lifecycle!=='open')throw fault('TASK_CLOSED','Task closed');if(this.cancelGates.has(taskId)||this.gatesClosing?.has(taskId)||[...this.operations.values()].some(o=>o.taskId===taskId))throw fault('BUSY','Previous execution/cleanup/cancellation not settled');
  if(this.operations.size>=this.maxConcurrent)throw fault('BUSY','Execution concurrency limit');
  const unknown=t.unresolvedExecutionIds??[];if(unknown.some(id=>!input.acknowledgeUnknownExecutionIds?.includes(id)))throw fault('UNKNOWN_EXECUTION','Explicitly acknowledge every unresolved execution; old Session will not be reused');
  if(t.integrityAlerts?.length)throw fault('INTEGRITY_ALERT','Task has unresolved notification integrity alerts');
  const latest=t.latestExecutionId?this.execution(t.latestExecutionId):null;
  if(latest&&active.has(latest.status))throw fault('QUEUED_EXECUTION','Use dispatchQueued for the existing unsent execution');
  const e=this.newExecution(taskId,input.prompt,input.requestKey);e.duplicateExecutionRisk=unknown.length>0;
  if(!unknown.length&&latest?.bindingId){const b=this.binding(latest.bindingId);if(b?.availability!=='closed')throw fault('SESSION_UNSETTLED','Previous Session cleanup not confirmed');e.bindingId=latest.bindingId;}
  const next=this.project({...t,latestExecutionId:e.executionId},[...this.state().executions,e]);
  this.commit({admission:true,tasks:[next],executions:[e],requests:[{key:input.requestKey,inputHash,taskId,executionId:e.executionId}],events:[{type:'execution.created',taskId,executionId:e.executionId}]});this.launch(e.executionId);return e;
 });}
 async dispatchQueued(executionId){await this.start();const e=this.execution(executionId);return this.gate(e.taskId,()=>{if(this.operations.size>=this.maxConcurrent)throw fault('BUSY','Execution concurrency limit');if(e.status!=='queued'||e.submission!=='not_started')throw fault('NOT_QUEUED','Not safely unsent');if(this.task(e.taskId).lifecycle!=='open')throw fault('TASK_CLOSED','Closed');if([...this.operations.values()].some(o=>o.taskId===e.taskId))throw fault('BUSY','Task busy');this.launch(executionId);return e;});}
 launch(executionId){
  const e=this.execution(executionId);const op={executionId,taskId:e.taskId,transport:this.transportFactory(),phase:'setup',pending:'',bytes:0,quarantine:[],generation:randomUUID(),cancelPromise:null};
  op.abort=new Promise((_,reject)=>op.reject=reject);op.abort.catch(()=>{});op.request=(m,p,ms)=>Promise.race([op.transport.request(m,p,ms),op.abort]);this.operations.set(executionId,op);
  op.flushCount=0;
  op.done=this.run(op).catch(error=>{this.storageFault??=error;}).finally(()=>{clearTimeout(op.flushTimer);clearTimeout(op.deadlineTimer);if(!op.cleanupFailed)this.operations.delete(executionId);});
 }
 flush(op){clearTimeout(op.flushTimer);op.flushTimer=null;if(!op.pending)return;const e=this.execution(op.executionId),pending=op.pending;this.changeExecution(e.executionId,{result:e.result+pending,resultIntegrity:op.bad?'uncertain':e.resultIntegrity},'execution.output');op.pending='';op.flushCount++;}
 quarantine(op,reason,params){if(op.quarantine.length>=32)return;op.quarantine.push({code:reason,time:now(),detail:Buffer.from(JSON.stringify(params)).subarray(0,700).toString('utf8')});op.bad=true;
  if(op.committed&&!this.storageFault){const t=this.task(op.taskId);if(!t.integrityAlerts.some(a=>a.executionId===op.executionId))this.commit({tasks:[{...t,status:'unknown',integrityAlerts:[...t.integrityAlerts,{executionId:op.executionId,code:reason}],updatedAt:now()}],events:[{type:'notification.quarantined',taskId:op.taskId,executionId:op.executionId,data:{reason}}]});}
 }
 receive(op,params){
  const u=params.update;
  if(op.phase!=='prompt'||params.sessionId!==op.sessionId){this.quarantine(op,'UNASSOCIATED_NOTIFICATION',params);return;}
  if(u?.sessionUpdate!=='agent_message_chunk'||u.content?.type!=='text')return;
  const value=u.content.text,bytes=Buffer.byteLength(value);if(op.bytes+bytes>this.maxOutputBytes){this.quarantine(op,'OUTPUT_LIMIT',{bytes});op.reject(fault('OUTPUT_LIMIT','Execution output limit'));return;}
  op.bytes+=bytes;op.pending+=value;
  if(Buffer.byteLength(op.pending)>=this.flushBytes)this.flush(op);else if(op.flushCount<32&&!op.flushTimer)op.flushTimer=setTimeout(()=>{try{this.flush(op)}catch(e){op.reject(e)}},this.flushMs);
 }
 async run(op){
  let e=this.execution(op.executionId),binding=e.bindingId?this.binding(e.bindingId):null;
  try{
   const init=await op.transport.start({onUpdate:p=>this.receive(op,p),onDisconnect:error=>op.reject(error),onPermission:()=>({outcome:{outcome:'cancelled'}})});
   if(this.stopping)throw fault('STOPPED','Stopping');
   if(binding){if(binding.runtimeId!==this.runtimeId)throw fault('RUNTIME_MISMATCH','Session belongs to another runtime');if(!init.agentCapabilities?.sessionCapabilities?.resume)throw fault('UNSUPPORTED','ACP resume unavailable');await op.request('session/resume',{sessionId:binding.sessionId,cwd:binding.cwd,mcpServers:[]},this.sessionOperationTimeoutMs);}
   else{const created=await op.request('session/new',{cwd:this.task(e.taskId).cwd,mcpServers:[]},this.sessionOperationTimeoutMs);text(created.sessionId,'ACP sessionId');binding={bindingId:randomUUID(),taskId:e.taskId,sessionId:created.sessionId,cwd:this.task(e.taskId).cwd,runtimeId:this.runtimeId,generation:op.generation,availability:'active'};}
   op.sessionId=binding.sessionId;binding={...binding,availability:'active',generation:op.generation};
   e=this.changeExecution(e.executionId,{bindingId:binding.bindingId},'session.bound',{bindings:[binding]});
   if(this.stopping)throw fault('STOPPED','Stopping');
   if(op.cancelRequested){this.changeExecution(e.executionId,{status:'cancelled',completionEvidence:{stopReason:'local_not_submitted',observedAt:now()},cancel:{...this.execution(e.executionId).cancel,confirmedAt:now()}},'execution.cancelled');return;}
   e=this.changeExecution(e.executionId,{status:'running',submission:'dispatch_intent',startedAt:now(),deadlineAt:new Date(Date.now()+this.taskTimeoutMs).toISOString()},'execution.dispatch_intent');
   this.hooks.beforePrompt?.(e);op.phase='prompt';
   const responsePromise=op.request('session/prompt',{sessionId:op.sessionId,prompt:[{type:'text',text:e.prompt}]},this.taskTimeoutMs+this.cancelTimeoutMs);
   op.deadlineTimer=setTimeout(()=>{void this.cancelExecution(e.executionId).catch(()=>{});},this.taskTimeoutMs);
   const response=await responsePromise;op.phase='settling';clearTimeout(op.deadlineTimer);
   // All callbacks already entered before this continuation are synchronous enqueues. Flush before evidence transaction.
   this.flush(op);this.hooks.beforeTerminalCommit?.({execution:this.execution(e.executionId),response});
   e=this.execution(e.executionId);const status=op.bad?'unknown':response.stopReason==='end_turn'?'completed':response.stopReason==='cancelled'?'cancelled':'failed';
   const evidence=['completed','cancelled'].includes(status)?{stopReason:response.stopReason,sessionId:op.sessionId,generation:op.generation,executionId:e.executionId,observedAt:now()}:null;
   this.changeExecution(e.executionId,{status,submission:'response_observed',resultIntegrity:status==='completed'?'observed_complete':op.bad?'uncertain':e.resultIntegrity,completionEvidence:evidence,cancel:{...e.cancel,confirmedAt:status==='cancelled'?now():e.cancel.confirmedAt},diagnostics:diagnostics([...e.diagnostics,...op.quarantine]),finishedAt:now()},'execution.settled');op.committed=true;
   this.hooks.afterTerminalCommit?.(this.execution(e.executionId));
  }catch(error){
   op.phase='settling';clearTimeout(op.deadlineTimer);
   if(!this.storageFault){try{this.flush(op);e=this.execution(op.executionId);if(active.has(e.status))this.changeExecution(e.executionId,{status:e.submission==='not_started'?'failed':'unknown',resultIntegrity:'uncertain',diagnostics:diagnostics([...e.diagnostics,...op.quarantine,{code:error.code??'EXECUTION_UNCERTAIN',message:String(error.message),time:now()}])},'execution.interrupted');}catch(writeError){this.storageFault??=writeError;}}
  }finally{
   op.phase='closed';clearTimeout(op.flushTimer);
   let closed=false;
   try{if(op.sessionId)await op.transport.request('session/close',{sessionId:op.sessionId},this.sessionOperationTimeoutMs);closed=true;}catch{}
   try{await op.transport.stop();op.cleanupFailed=false;}catch(error){op.cleanupFailed=true;op.cleanupError=error;}
   if(binding&&!this.storageFault){try{const current=this.binding(binding.bindingId);this.commit({bindings:[{...current,availability:closed&&!op.cleanupFailed?'closed':'unknown'}],events:[{type:'session.cleanup',taskId:op.taskId,executionId:op.executionId,data:{closed:closed&&!op.cleanupFailed}}]});}catch(error){this.storageFault??=error;}}
  }
 }
 async cancelExecution(executionId){
  await this.initialize();const e=this.execution(executionId),op=this.operations.get(executionId);
  if(!op){if(e.status==='queued'&&e.submission==='not_started'){this.changeExecution(executionId,{status:'cancelled',cancel:{...e.cancel,requestedAt:now(),confirmedAt:now()},completionEvidence:{stopReason:'local_not_submitted',observedAt:now()}},'execution.cancelled');}return this.execution(executionId);}
  if(op.cancelPromise)return op.cancelPromise;
  this.cancelGates.set(e.taskId,executionId);
  op.cancelPromise=(async()=>{
   op.cancelRequested=true;let current=this.execution(executionId);if(!current.cancel.requestedAt)this.changeExecution(executionId,{cancel:{...current.cancel,requestedAt:now()}},'execution.cancel_requested');
   try{
    if(op.phase==='prompt'){await bounded(op.transport.notify('session/cancel',{sessionId:op.sessionId}),this.cancelTimeoutMs);current=this.execution(executionId);this.changeExecution(executionId,{cancel:{...current.cancel,sentAt:now()}},'execution.cancel_sent');}
    await bounded(op.done,this.cancelTimeoutMs+this.sessionOperationTimeoutMs);
   }catch(error){op.reject(fault('CANCEL_UNCONFIRMED','Cancellation not confirmed'));try{await op.transport.stop()}catch{};await bounded(op.done,this.sessionOperationTimeoutMs).catch(()=>{});}
   return this.execution(executionId);
  })().finally(()=>{this.cancellations.delete(op.cancelPromise);if(this.cancelGates.get(e.taskId)===executionId)this.cancelGates.delete(e.taskId)});this.cancellations.add(op.cancelPromise);return op.cancelPromise;
 }
 async cancelTask(taskId){await this.initialize();const t=this.task(taskId);if(t.activeExecutionId)await this.cancelExecution(t.activeExecutionId);return this.task(taskId);}
 async resumeTask(taskId,options={}){if(options.prompt!==undefined)throw fault('MIGRATION_REQUIRED','Use startExecution for new prompt');return this.reconcileTask(taskId,{...options,restoreContext:true});}
 async reconcileTask(taskId,options={}){await this.start();return this.gate(taskId,async()=>{
  const t=this.task(taskId);if(this.cancelGates.has(taskId)||[...this.operations.values()].some(o=>o.taskId===taskId))throw fault('BUSY','Execution/cleanup/cancel active');
  if(!options.restoreContext)return t;
  const latest=t.latestExecutionId?this.execution(t.latestExecutionId):null,b=latest?.bindingId?this.binding(latest.bindingId):null;if(!b)return t;
  if(t.unresolvedExecutionIds.length)throw fault('UNKNOWN_EXECUTION','Context restore cannot confirm old result or safely reuse unknown Session');
  if(b.runtimeId!==this.runtimeId)throw fault('RUNTIME_MISMATCH','Session runtime differs');
  const transport=this.transportFactory();this.contextTransports.add(transport);let available=false;
  try{const init=await transport.start();if(!init.agentCapabilities?.sessionCapabilities?.resume)throw fault('UNSUPPORTED','resume unavailable');await transport.request('session/resume',{sessionId:b.sessionId,cwd:b.cwd,mcpServers:[]},this.sessionOperationTimeoutMs);await transport.request('session/close',{sessionId:b.sessionId},this.sessionOperationTimeoutMs);available=true;}
  finally{await transport.stop();this.contextTransports.delete(transport);}
  if(available&&b.availability!=='closed')this.commit({bindings:[{...b,availability:'closed'}],events:[{type:'session.reconciled',taskId,data:{available:true}}]});return this.task(taskId);
 });}
 async closeSession(taskId){await this.initialize();return this.gate(taskId,async()=>{await this.cancelTask(taskId);const ops=[...this.operations.values()].filter(o=>o.taskId===taskId);await Promise.all(ops.map(o=>o.done));if(ops.some(o=>o.cleanupFailed))throw fault('CLEANUP_FAILED','Session process cleanup not confirmed');const t=this.task(taskId),e=t.latestExecutionId?this.execution(t.latestExecutionId):null,b=e?.bindingId?this.binding(e.bindingId):null;if(b&&b.availability!=='closed'){
 if(b.runtimeId!==this.runtimeId)throw fault('RUNTIME_MISMATCH','Session runtime differs');
 const transport=this.transportFactory();this.contextTransports.add(transport);let closed=false;
 try{await transport.start();await transport.request('session/resume',{sessionId:b.sessionId,cwd:b.cwd,mcpServers:[]},this.sessionOperationTimeoutMs);await transport.request('session/close',{sessionId:b.sessionId},this.sessionOperationTimeoutMs);closed=true;}finally{await transport.stop();this.contextTransports.delete(transport);}
 if(closed)this.commit({bindings:[{...b,availability:'closed'}],events:[{type:'session.closed',taskId,data:{confirmed:true}}]});
 }return this.task(taskId);});}
 async closeTask(taskId){await this.initialize();this.gatesClosing??=new Set();this.gatesClosing.add(taskId);const t=this.task(taskId);if(t.lifecycle!=='closed')this.commit({tasks:[{...t,lifecycle:'closed',updatedAt:now()}],events:[{type:'task.close_requested',taskId}]});try{await this.closeSession(taskId);return this.task(taskId);}finally{this.gatesClosing.delete(taskId)}}
 async getTask(id){await this.initialize();return this.state().tasks.find(t=>t.taskId===id)??null;}
 async listTasks(){await this.initialize();return this.state().tasks;}
 async getExecution(id){await this.initialize();return this.state().executions.find(e=>e.executionId===id)??null;}
 async listExecutions(taskId){await this.initialize();return this.state().executions.filter(e=>!taskId||e.taskId===taskId);}
 async getEvents(afterSequence=0,limit=100){await this.initialize();if(!Number.isSafeInteger(afterSequence)||afterSequence<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw fault('INVALID_INPUT','Invalid event cursor/limit');return this.state().events.filter(e=>e.sequence>afterSequence).slice(0,limit);}
 subscribeEvents(listener,{afterSequence}={}){if(afterSequence!==undefined)for(const e of this.state().events.filter(e=>e.sequence>afterSequence))listener(e);this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 async waitForTask(taskId,ms=this.taskTimeoutMs+2*this.sessionOperationTimeoutMs+this.cancelTimeoutMs){const ops=[...this.operations.values()].filter(o=>o.taskId===taskId);await bounded(Promise.all(ops.map(o=>o.done)),duration(ms));if(this.storageFault)throw fault('STORAGE_FAULT',this.storageFault.message);return this.task(taskId);}
 async healthCheck(){return {healthy:this.initialized&&!this.stopping&&!this.storageFault,store:this.store.healthCheck(),storageFault:this.storageFault?.message??null,activeExecutions:this.operations.size,cleanupFailures:[...this.operations.values()].filter(o=>o.cleanupFailed).map(o=>o.executionId)};}
 async stop(){
  this.stopping=true;if(this.stopPromise)return this.stopPromise;
  const run=(async()=>{const ops=[...this.operations.values()];for(const op of ops)op.reject(fault('STOPPED','Executor stopped'));const results=await Promise.allSettled([...ops.map(o=>o.transport),...this.contextTransports].map(t=>t.stop()));await Promise.allSettled(ops.map(o=>o.done));await Promise.allSettled([...this.cancellations]);const failed=results.some(r=>r.status==='rejected');if(failed){for(const op of ops)if(op.cleanupFailed)await op.transport.stop();}for(const transport of this.contextTransports)await transport.stop();await Promise.allSettled([...this.gates.values()]);this.contextTransports.clear();this.operations.clear();this.store.close();this.initialized=false;})();
  this.stopPromise=run;try{return await run}catch(e){this.stopPromise=null;throw e;}
 }
}
