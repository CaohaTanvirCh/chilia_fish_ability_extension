import {readFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {AcpTransport} from '../packages/acp-transport/index.mjs';
const config=JSON.parse(readFileSync(new URL('../config/windows.json',import.meta.url),'utf8'));
mkdirSync(new URL('../logs/',import.meta.url),{recursive:true});
const log=(type,data)=>{const line=JSON.stringify({time:new Date().toISOString(),type,data});console.log(line);appendFileSync(new URL('../logs/probe-session.jsonl',import.meta.url),line+'\n');};
const transport=new AcpTransport({...config,onStderr:data=>log('stderr',data)});
let session;
try{
 log('initialize',await transport.start({onUpdate:data=>log('update',data),onPermission:data=>log('permission-denied',{sessionId:data.sessionId}),onDisconnect:error=>log('disconnect',error.message)}));
 session=await transport.request('session/new',{cwd:config.cwd,mcpServers:[]});log('new',session);
 log('prompt',await transport.request('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'仅回复 FISH_ACP_OK，不要调用工具。'}]},60000));
 log('close',await transport.request('session/close',{sessionId:session.sessionId}));
 log('list',await transport.request('session/list',{cwd:config.cwd}));
}catch(error){log('error',{message:error.message,code:error.code});process.exitCode=1;}
finally{await transport.stop();}
