// Official SDK simulated ACP subprocess. Not a DSH runtime.
import {agent,methods,ndJsonStream,PROTOCOL_VERSION} from '@agentclientprotocol/sdk';
import {Readable,Writable} from 'node:stream';
const mode=process.argv[2]??'silent';let resolvePrompt;
const update=text=>connection.client.notify(methods.client.session.update,{sessionId:'fixture-v2',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}});
const app=agent({name:'simulated-acp-v2'})
.onRequest(methods.agent.initialize,()=>({protocolVersion:PROTOCOL_VERSION,agentCapabilities:{sessionCapabilities:{resume:{},close:{}}},authMethods:[]}))
.onRequest(methods.agent.session.new,()=>({sessionId:'fixture-v2'}))
.onRequest(methods.agent.session.resume,()=>({}))
.onRequest(methods.agent.session.close,()=>({}))
.onNotification(methods.agent.session.cancel,()=>{if(mode!=='ignore-cancel')resolvePrompt?.({stopReason:'cancelled'})})
.onRequest(methods.agent.session.prompt,async()=>{
 if(mode==='exit')process.exit(7);
 if(mode==='disconnect'){setInterval(()=>{},1000);process.stdout.end();return new Promise(()=>{});}
 if(mode==='ignore-cancel')return new Promise(r=>resolvePrompt=r);
 if(mode==='late'){setTimeout(()=>{void update('late')},30);return {stopReason:'end_turn'};}
 await new Promise(r=>setTimeout(r,150));
 await update('first');await update('second');return {stopReason:'end_turn'};
});
const connection=app.connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
