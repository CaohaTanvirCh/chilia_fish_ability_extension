import {spawn} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import {client,methods,ndJsonStream,PROTOCOL_VERSION} from '@agentclientprotocol/sdk';
import {loadWindowsConfig} from './windows-config.mjs';
const config=loadWindowsConfig();
const child=spawn(config.command,config.args??[],{cwd:config.cwd,env:{...process.env,...config.env},stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
child.stderr.on('data',b=>process.stderr.write(b));
child.on('error',e=>console.error(e));
const conn=client({name:'fish-acp-probe'}).onRequest(methods.client.session.requestPermission,()=>({outcome:{outcome:'cancelled'}})).connect(ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout)));
const timer=setTimeout(()=>{console.error('Probe timed out');conn.close();child.kill();process.exitCode=1},config.startupTimeoutMs??20000);
try {console.log(JSON.stringify(await conn.agent.request(methods.agent.initialize,{protocolVersion:PROTOCOL_VERSION,clientCapabilities:{}}),null,2));}
catch(e){console.error(e);process.exitCode=1;}
finally{clearTimeout(timer);conn.close();child.stdin.end();setTimeout(()=>child.kill(),2000).unref();}
