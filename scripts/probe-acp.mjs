import {spawn} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import {client,methods,ndJsonStream,PROTOCOL_VERSION} from '@agentclientprotocol/sdk';
const base='C:\\path\\to\\DeepSeek Harness';
const child=spawn(`${base}\\DeepSeek Harness.exe`,['--expose-internals',`${base}\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js`,'--profile','acp'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe'],windowsHide:true});
child.stderr.on('data',b=>process.stderr.write(b));
child.on('error',e=>console.error(e));
const conn=client({name:'fish-acp-probe'}).onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'cancelled'}})).connect(ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout)));
const timer=setTimeout(()=>{console.error('Probe timed out');conn.close();child.kill();process.exitCode=1},20000);
try {console.log(JSON.stringify(await conn.agent.request(methods.agent.initialize,{protocolVersion:PROTOCOL_VERSION,clientCapabilities:{}}),null,2));}
catch(e){console.error(e);process.exitCode=1;}
finally{clearTimeout(timer);conn.close();child.stdin.end();setTimeout(()=>child.kill(),2000).unref();}
