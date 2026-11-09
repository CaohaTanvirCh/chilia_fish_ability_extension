import {agent,methods,ndJsonStream,PROTOCOL_VERSION} from '@agentclientprotocol/sdk';
import {Readable,Writable} from 'node:stream';
const mode=process.argv[2];
const app=agent({name:'fixture'})
.onRequest(methods.agent.initialize,async()=>{if(mode==='slow-start') await new Promise(resolve=>setTimeout(resolve,100));return {protocolVersion:PROTOCOL_VERSION,agentCapabilities:{},authMethods:[]};})
.onRequest(methods.agent.session.new,async ctx=>{
 if(mode==='exit') process.exit(7);
 if(mode==='hang') return new Promise(()=>{});
 if(mode==='close-output') {setInterval(()=>{},1000);process.stdout.end();return new Promise(()=>{});}
 if(mode==='permission') return {sessionId:JSON.stringify(await ctx.client.request('session/request_permission',{sessionId:'fixture',toolCall:{toolCallId:'t',title:'write',status:'pending'},options:[{optionId:'yes',kind:'allow_once',name:'Allow'},{optionId:'no',kind:'reject_once',name:'Reject'}]}))};
 return {sessionId:'fixture'};
});
app.connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
