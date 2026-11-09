import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const main=fileURLToPath(new URL('../apps/companion-hub/main.mjs',import.meta.url));
const fixture=fileURLToPath(new URL('./fixtures/acp-agent.mjs',import.meta.url));
function run(config,commands=''){
 const dir=mkdtempSync(path.join(tmpdir(),'fish-hub-'));const file=path.join(dir,'config.json');writeFileSync(file,JSON.stringify({cwd:dir,dataDirectory:'data',enabled:true,...config}));
 const child=spawn(process.execPath,[main,file],{stdio:['pipe','pipe','pipe']});let out='',err='',sent=false;child.stdin.on('error',()=>{});child.stdout.on('data',b=>{out+=b;if(out.includes('"type":"ready"')&&!sent){sent=true;child.stdin.end(commands)}});child.stderr.on('data',b=>err+=b);
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Hub timeout '+err))},8000);child.on('close',code=>{clearTimeout(timer);resolve({code,out,err,dir})})});
}
test('hub rejects a flood above 16 in-flight commands with BUSY',async()=>{
 const commands=Array.from({length:80},(_,id)=>JSON.stringify({id,method:'healthCheck'})+'\n').join('');
 const r=await run({},commands);assert.equal(r.code,0,r.err);
 const rows=r.out.trim().split('\n').map(JSON.parse).filter(x=>x.id!==undefined);
 assert.equal(rows.length,80);assert.ok(rows.some(x=>x.error?.code==='BUSY'));assert.ok(rows.some(x=>x.result));
});
test('hub bounds unterminated multibyte UTF-8 input by bytes',async()=>{
 const r=await run({},Buffer.from('界'.repeat(350000)));assert.equal(r.code,0,r.err);
 const rows=r.out.trim().split('\n').map(JSON.parse);assert.ok(rows.some(x=>x.error?.code==='CAPACITY'));
 assert.equal(existsSync(path.join(r.dir,'data','store-v2.lock')),false);
});
test('hub rejects oversized terminated lines before JSON parsing',async()=>{
 const r=await run({},Buffer.from('x'.repeat(1024*1024+1)+'\n'));assert.equal(r.code,0,r.err);
 const rows=r.out.trim().split('\n').map(JSON.parse);assert.ok(rows.some(x=>x.error?.code==='CAPACITY'));
});
test('hub rejects malformed UTF-8 and remains available for the next command',async()=>{
 const commands=Buffer.concat([Buffer.from([0xff,10]),Buffer.from('{"id":"valid","method":"listTasks"}\n')]);
 const r=await run({},commands);assert.equal(r.code,0,r.err);
 const rows=r.out.trim().split('\n').map(JSON.parse);assert.ok(rows.some(x=>x.error));assert.deepEqual(rows.find(x=>x.id==='valid').result,[]);
});
test('hub accepts UTF-8 command within byte bound and exposes event cursor reads',async()=>{
 const r=await run({},JSON.stringify({id:'界',method:'getEvents',args:[0]})+'\n');assert.equal(r.code,0,r.err);
 const rows=r.out.trim().split('\n').map(JSON.parse);assert.deepEqual(rows.find(x=>x.id==='界').result,[]);
});
test('hub disabled does not create storage or runtime',async()=>{const r=await run({enabled:false});assert.equal(r.code,0);assert.equal(JSON.parse(r.out).enabled,false);assert.equal(existsSync(path.join(r.dir,'data')),false)});
test('hub constructor failure does not leak store lock',async()=>{const r=await run({taskTimeoutMs:0});assert.equal(r.code,1);assert.equal(existsSync(path.join(r.dir,'data','store-v2.lock')),false)});
test('hub without tasks initializes store without spawning ACP',async()=>{const r=await run({command:'fish-invalid-binary'},'{"id":"tasks","method":"listTasks"}\n');assert.equal(r.code,0,r.err);const rows=r.out.trim().split('\n').map(JSON.parse);assert.ok(rows.some(x=>x.type==='ready'));assert.deepEqual(rows.find(x=>x.id==='tasks').result,[])});
test('hub health and stop use JSON stdout and clean shutdown',async()=>{const r=await run({command:process.execPath,args:[fixture,'normal']},'{"id":"h","method":"healthCheck","args":[]}\n{"id":"s","method":"stop","args":[]}\n');assert.equal(r.code,0,r.err);const rows=r.out.trim().split('\n').map(JSON.parse);assert.ok(rows.some(x=>x.id==='h'&&x.result.healthy));assert.ok(rows.some(x=>x.id==='s'&&x.result.stopped));assert.equal(existsSync(path.join(r.dir,'data','store-v2.lock')),false)});
