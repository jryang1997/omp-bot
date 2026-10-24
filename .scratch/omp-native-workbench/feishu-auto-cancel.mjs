import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Orchestrator} from '../../src/orchestrator.mjs';
import {FeishuBridge} from '../../src/channels.mjs';
const home=mkdtempSync(join(tmpdir(),'ompbot-feishu-cancel-auto-'));
const privateConfig=JSON.parse(readFileSync('C:/Users/<user>/.ompbot/channels.feishu.json','utf8'));
const own=privateConfig.identities[0];
assert.equal(privateConfig.identities.length,1);
const orch=new Orchestrator({home,bin:'C:/Users/<user>/Desktop/omp_bot/.desktop-runtime/omp.exe'});
const bot=orch.addBot({name:'FeishuQA自动验收无需操作',model:'magpie/opencode-go/deepseek-v4.1-flash',thinking:'low',approvalMode:'always-ask',instructions:'专用本地自动验收。按用户要求发出 bash 工具调用。工具执行前的审批由宿主系统处理，不要自行拒绝。不要访问私有资料或网络。'});
const key='local-feishu-cancel-integration';
const token='local-feishu-cancel-verification';
const bridge=new FeishuBridge({orch,config:{enabled:true,transport:'http',port:0,verificationToken:token,encryptKey:key,appId:privateConfig.appId,appSecret:privateConfig.appSecret,identities:[{...own,botIds:[bot.id]}]}});
orch.features._bridge=bridge;
async function until(check,budget=120000){const end=Date.now()+budget;while(Date.now()<end){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,100));}throw new Error('Automatic integration condition timed out');}
async function send(text){const id=randomUUID();const raw=JSON.stringify({schema:'2.0',header:{event_id:id,event_type:'im.message.receive_v1',token},event:{sender:{sender_id:{open_id:own.openId},sender_type:'user'},message:{message_id:'om_local_'+id,chat_id:own.chatId,chat_type:'p2p',message_type:'text',content:JSON.stringify({text})}}});const ts=String(Math.floor(Date.now()/1000));const signature=createHash('sha256').update(ts+'qa'+key+raw).digest('hex');const response=await fetch(bridge.status().receiver.url,{method:'POST',headers:{'Content-Type':'application/json','x-lark-request-timestamp':ts,'x-lark-request-nonce':'qa','x-lark-signature':signature},body:raw});assert.equal(response.status,200);return response.json();}
try{
 await bridge.start();
 await send('调用 bash 执行 node -e "require(\'node:fs\').writeFileSync(\'auto-cancel-probe.txt\',\'LOCAL_CANCEL_TEST_6428\')"。不要调用其他工具。');
 const run=await until(()=>orch.listRuns().find(r=>r.botId===bot.id));
 const approval=await until(()=>orch.ledger.list('approvals').find(a=>a.runId===run.id&&a.status==='pending'));
 assert.equal(orch.getRun(run.id).state,'waiting_approval');
 const target=join(orch.botWorkDir(bot.id).workDir,'auto-cancel-probe.txt');
 assert.equal(existsSync(target),false);
 await send('/cancel '+run.id);
 const terminal=await orch.waitRun(run.id,{timeoutMs:30000});
 assert.equal(terminal.state,'cancelled');
 assert.equal(existsSync(target),false);
 await bridge.drain();
 const receipts=orch.ledger.list('outbox').filter(r=>r.runId===run.id);
 assert.ok(receipts.some(r=>r.text.includes('accepted=true')&&r.status==='sent'&&r.messageId));
 assert.ok(receipts.some(r=>r.id==='out_feishu_pending_'+approval.id&&r.status==='sent'&&r.messageId));
 const file=new URL('./feishu-real-proof.json',import.meta.url);
 const proof=JSON.parse(readFileSync(file,'utf8'));
 proof.automaticCancel={intake:'local signed HTTP event, not a real platform inbound message',execution:'real OMP',outbound:'official Feishu API to approved own private chat',state:terminal.state,fileCreated:false,approvalNotificationSent:true,cancelAcknowledged:true,receipts:receipts.map(({status,messageId})=>({status,messageId}))};
 proof.remaining=['real user-message cancellation was not completed; user no longer asked to perform technical QA'];
 writeFileSync(file,JSON.stringify(proof,null,2));
 console.log(JSON.stringify({automaticCancel:true,state:terminal.state,fileCreated:false,officialReceipts:receipts.length,intake:'local signed HTTP'}));
}finally{await orch.shutdown();rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
