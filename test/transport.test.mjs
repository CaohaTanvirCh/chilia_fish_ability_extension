import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {AcpTransport} from '../packages/acp-transport/index.mjs';
const fixture=fileURLToPath(new URL('./fixtures/acp-agent.mjs',import.meta.url));
const make=mode=>new AcpTransport({command:process.execPath,args:[fixture,mode],timeoutMs:1500,shutdownTimeoutMs:100,killTimeoutMs:1000});
test('official SDK subprocess disconnect rejects pending request',async()=>{const t=make('exit');let disconnected=false;await t.start({onDisconnect:()=>{disconnected=true}});await assert.rejects(t.request('session/new',{cwd:process.cwd(),mcpServers:[]}));await t.stop();assert.equal(disconnected,true);assert.equal(t.healthCheck().healthy,false);});
test('request timeout and stop release child',async()=>{const t=make('hang');await t.start();const connection=t.connection;await assert.rejects(t.request('session/new',{cwd:process.cwd(),mcpServers:[]},100),/timed out/);assert.equal(connection.signal.aborted,true);assert.equal(t.child,null);await t.stop();assert.equal(t.child,null);});
test('permission requests are denied by default',async()=>{const t=make('permission');await t.start();try{const r=await t.request('session/new',{cwd:process.cwd(),mcpServers:[]});assert.equal(JSON.parse(r.sessionId).outcome.optionId,'no');}finally{await t.stop();}});
test('concurrent starts share handshake and initialization result',async()=>{const t=make('slow-start');try{const first=t.start();const second=t.start();assert.equal(first,second);const [a,b]=await Promise.all([first,second]);assert.equal(a,b);assert.equal(typeof a.protocolVersion,'number');}finally{await t.stop();}});
test('closed stdout child is reaped before replacement and cannot disconnect replacement',async()=>{const t=make('close-output');let disconnects=0;try{await t.start({onDisconnect:()=>disconnects++});const old=t.child;await assert.rejects(t.request('session/new',{cwd:process.cwd(),mcpServers:[]}));t.config.args=[fixture,'normal'];await t.start({onDisconnect:()=>disconnects++});assert.notEqual(t.child.pid,old.pid);assert.ok(old.exitCode!==null||old.signalCode!==null);assert.equal(disconnects,1);assert.equal((await t.request('session/new',{cwd:process.cwd(),mcpServers:[]})).sessionId,'fixture');assert.equal(t.healthCheck().healthy,true);}finally{await t.stop();}});
test('stop during startup leaves no owned child',async()=>{const t=make('slow-start');const starting=t.start();const stopped=t.stop();await Promise.allSettled([starting,stopped]);assert.equal(t.child,null);assert.equal(t.healthCheck().healthy,false);});
test('failed termination is bounded and preserves ownership for retry',async()=>{const t=make('normal');const child={pid:null,stdin:{end(){}},kill(){return false;}};const generation={child,exit:new Promise(()=>{}),connection:{close(){}},cleanup:null};t.config.shutdownTimeoutMs=10;t.config.killTimeoutMs=10;t.generation=generation;t.child=child;const before=Date.now();await assert.rejects(t.stop(),{code:'SHUTDOWN_TIMEOUT'});assert.ok(Date.now()-before<1000);assert.equal(t.child,child);assert.equal(generation.cleanup,null);generation.exit=Promise.resolve();await t.stop();assert.equal(t.child,null);});
test('missing executable fails startup',async()=>{const t=new AcpTransport({command:'fish-nonexistent-executable-123',startupTimeoutMs:1000});await assert.rejects(t.start());await t.stop();});
test('starts during stop reject and a later start owns a fresh child',async()=>{
 const t=make('slow-start');
 const starting=t.start();const stopped=t.stop();
 assert.equal(t.stop(),stopped);
 await assert.rejects(t.start(),{code:'STOPPING'});
 await Promise.allSettled([starting,stopped]);
 assert.equal(t.child,null);
 try{await t.start();assert.equal(t.healthCheck().healthy,true);}finally{await t.stop();}
});
test('failed stop blocks replacement until old generation cleanup succeeds',async()=>{
 const t=make('normal'),child={pid:null,stdin:{end(){}},kill(){return false;}};
 const generation={child,exit:new Promise(()=>{}),connection:{close(){}},cleanup:null};
 t.config.shutdownTimeoutMs=10;t.config.killTimeoutMs=10;t.generation=generation;t.child=child;
 await assert.rejects(t.stop(),{code:'SHUTDOWN_TIMEOUT'});
 await assert.rejects(t.start(),{code:'SHUTDOWN_TIMEOUT'});assert.equal(t.child,child);
 generation.exit=Promise.resolve();await t.stop();
 try{await t.start();assert.equal(t.healthCheck().healthy,true);}finally{await t.stop();}
});
test('request timer overflow rejects before sending including derived overrides',async()=>{
 const t=make('normal');let sends=0;
 t.generation={connection:{signal:{aborted:false},agent:{request(){sends++;return Promise.resolve();}}}};
 for(const timeout of [2147483648,2147483647+5000,Infinity,NaN,0,-1])await assert.rejects(t.request('session/new',{},timeout),TypeError);
 assert.equal(sends,0);
 for(const name of ['timeoutMs','startupTimeoutMs','shutdownTimeoutMs','killTimeoutMs'])assert.throws(()=>new AcpTransport({[name]:2147483648}),TypeError);
});
test('repeated failed starts and stops clean up before successful replacement',async()=>{
 const t=new AcpTransport({command:'fish-nonexistent-executable-123',startupTimeoutMs:100,shutdownTimeoutMs:20,killTimeoutMs:100});
 for(let i=0;i<3;i++){await assert.rejects(t.start());await t.stop();assert.equal(t.child,null);}
 t.config.command=process.execPath;t.config.args=[fixture,'normal'];t.config.startupTimeoutMs=1500;
 for(let i=0;i<3;i++){await t.start();assert.equal(t.healthCheck().healthy,true);await t.stop();assert.equal(t.child,null);}
});
