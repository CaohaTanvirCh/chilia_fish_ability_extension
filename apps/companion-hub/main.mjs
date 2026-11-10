import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {TextDecoder} from 'node:util';
import {AcpTransport} from '../../packages/acp-transport/index.mjs';
import {DshAcpExecutor} from '../../packages/dsh-acp-v2/index.mjs';
import {ExecutionStore} from '../../packages/task-store-v2/index.mjs';
import {createStopController} from './lifecycle.mjs';

const MAX_LINE_BYTES=1024*1024, MAX_INFLIGHT=16, MAX_OUTPUT_BYTES=4*1024*1024;
const config=JSON.parse(readFileSync(path.resolve(process.argv[2]??'config/windows.json'),'utf8'));
let executor, startup, stopping=false, outputFailed=false, finishInput;
const pending=new Set();
const shutdown=createStopController({
 onStop:()=>{stopping=true;process.stdin.pause();finishInput?.();},
 cleanup:async()=>{
  const cleanup=executor?.stop();
  try{await startup;}catch{}
  await cleanup;
 },
});
function stop(){return shutdown.stop();}
function failOutput(){
 if(outputFailed)return;
 outputFailed=true;
 process.stdout.destroy();
 process.stderr.write('Hub output consumer too slow or unavailable; shutting down\n');
 void stop().catch(error=>process.stderr.write(`${error.message}\n`));
}
function output(value){
 if(outputFailed)return;
 const line=JSON.stringify(value)+'\n';
 if(Buffer.byteLength(line)+process.stdout.writableLength>MAX_OUTPUT_BYTES){failOutput();return;}
 process.stdout.write(line);
}
function errorOutput(id,error){output({id,error:{message:error.message,code:error.code??'ERROR'}});}
process.stdout.on('error',failOutput);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void stop().catch(error=>process.stderr.write(`${error.message}\n`));});
const allowed=new Set(['initialize','start','healthCheck','createTask','getTask','listTasks','startExecution','dispatchQueued','getExecution','listExecutions','resumeTask','reconcileTask','cancelTask','cancelExecution','acknowledgeIntegrityAlerts','closeSession','closeTask','getEvents']);
function commandLine(bytes){
 let command;
 try{
  command=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!command||typeof command!=='object'||Array.isArray(command))throw new Error('Command must be an object');
  if(stopping)throw Object.assign(new Error('Hub is stopping'),{code:'STOPPING'});
  if(command.method!=='stop'&&pending.size>=MAX_INFLIGHT)throw Object.assign(new Error('Hub has 16 commands in flight'),{code:'BUSY'});
  if(command.method!=='stop'&&!allowed.has(command.method))throw new Error('Unknown method');
  if(command.args!==undefined&&!Array.isArray(command.args))throw new Error('args must be an array');
 }catch(error){errorOutput(command?.id??null,error);return;}
 const operation=(async()=>{
  try{
   if(command.method==='stop'){await stop();output({id:command.id,result:{stopped:true}});return;}
   const result=await executor[command.method](...(command.args??[]));
   output({id:command.id,result});
  }catch(error){errorOutput(command.id??null,error);}
 })();
 pending.add(operation);
 operation.finally(()=>pending.delete(operation)).catch(()=>{});
}
function readCommands(){
 // Byte accounting happens before UTF-8 decoding, including unterminated input.
 const line=Buffer.allocUnsafe(MAX_LINE_BYTES);
 let used=0;
 return new Promise(resolve=>{
  let finished=false;
  finishInput=()=>{if(finished)return;finished=true;process.stdin.off('data',onData);resolve();};
  function onData(chunk){
   for(let offset=0;offset<chunk.length&&!stopping;){
    const newline=chunk.indexOf(10,offset);
    const end=newline<0?chunk.length:newline;
    const length=end-offset;
    if(used+length>MAX_LINE_BYTES){
     errorOutput(null,Object.assign(new Error('Command exceeds 1 MiB UTF-8'),{code:'CAPACITY'}));
     void stop().catch(error=>process.stderr.write(`${error.message}\n`));
     return;
    }
    chunk.copy(line,used,offset,end);used+=length;
    if(newline<0)break;
    commandLine(line.subarray(0,used));used=0;offset=newline+1;
   }
  }
  process.stdin.on('data',onData);
  process.stdin.once('end',()=>{if(!stopping&&used)commandLine(line.subarray(0,used));finishInput();});
  process.stdin.once('error',error=>{process.stderr.write(`Hub input failed: ${error.message}\n`);finishInput();});
 });
}
async function createExecutor(context){
 if(context.executorModule){
  const module=await import(pathToFileURL(path.resolve(context.cwd,context.executorModule)).href);
  const factory=module.createExecutor??module.default;
  if(typeof factory!=='function')throw new Error('executorModule must export createExecutor');
  return factory({config:context});
 }
 return new DshAcpExecutor({
  transportFactory:()=>new AcpTransport({...context,onStderr:text=>process.stderr.write(text)}),
  store:new ExecutionStore(path.resolve(context.cwd,context.dataDirectory)),
  taskTimeoutMs:context.taskTimeoutMs,
  sessionOperationTimeoutMs:context.sessionOperationTimeoutMs??30000,
  cancelTimeoutMs:context.cancelTimeoutMs??5000,
 });
}
try{
 if(!config.enabled){output({type:'health',healthy:false,enabled:false});}
 else if(!stopping){
  executor=await createExecutor(config);
  startup=(async()=>{await executor.initialize();if(!stopping)await executor.start();})();
  await startup;
  if(!stopping){
   executor.subscribeEvents(event=>output({type:'event',event}));
   output({type:'ready',protocolVersion:2,health:await executor.healthCheck()});
   if(!stopping)await readCommands();
  }
 }
}catch(error){process.stderr.write(`${error.stack??error}\n`);process.exitCode=1;}
finally{
 // A stop requested by a command can still be in flight here. If it fails,
 // retry once after the lifecycle controller clears the rejected attempt.
 try{await stop();}catch(first){
  try{await stop();}catch(second){process.stderr.write(`${second.stack??second}\n`);process.exitCode=1;}
 }
 await Promise.allSettled([...pending]);
}
