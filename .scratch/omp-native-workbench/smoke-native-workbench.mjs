import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server.mjs';
const runCli = promisify(execFile);
const home=mkdtempSync(join(tmpdir(),'ompbot-real-workbench-'));
const server=await startServer({port:0,home,bin:'C:/Users/<user>/Desktop/omp_bot/.desktop-runtime/omp.exe'});
const observed=[];
let eventReader;
async function api(path,{method='GET',body}={}){
 const response=await fetch(server.url+path,{method,headers:{Authorization:'Bearer '+server.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json();
 if(!response.ok)throw Object.assign(new Error(JSON.stringify(data)),{status:response.status});
 return data;
}
async function until(predicate,timeoutMs=120000){const start=Date.now();while(Date.now()-start<timeoutMs){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Condition timed out');}
async function done(id){return until(async()=>{const {run}=await api('/api/runs/'+id);return ['completed','failed','cancelled','interrupted','reconciliation_required'].includes(run.state)?run:null;});}
async function requestApproval(runId){return until(async()=>{const {approvals}=await api('/api/approvals');return approvals.find(a=>a.runId===runId&&a.status==='pending');});}
function selected(approval,allow){assert.equal(approval.method,'select');const option=approval.options.find(x=>allow?/^(Approve|Allow)/i.test(x):/^Deny/i.test(x));assert.ok(option,'Native matching option required');return option;}
async function submit(botId,text){const {run}=await api('/api/runs',{method:'POST',body:{botId,text,timeoutMs:120000}});assert.ok(run.id);return run;}
try{
 const stream=await fetch(server.url+'/api/events',{headers:{Authorization:'Bearer '+server.token}});
 assert.equal(stream.status,200);
 eventReader=stream.body.getReader();
 void (async()=>{let pending='';try{for(;;){const {value,done}=await eventReader.read();if(done)break;pending+=new TextDecoder().decode(value);let end;while((end=pending.indexOf('\n\n'))>=0){const item=pending.slice(0,end);pending=pending.slice(end+2);const line=item.split('\n').find(x=>x.startsWith('data: '));if(line)observed.push(JSON.parse(line.slice(6)));}}}catch{}})();
 const {bot}=await api('/api/bots',{method:'POST',body:{name:'NativeRealProof',role:'Temporary authorized QA bot',model:'magpie/commandcode-plan/deepseek/deepseek-v4.1-flash',thinking:'low',approvalMode:'always-ask',instructions:'Use only requested tools and paths. A denied operation must not be retried. No network or external messages.'}});
 const first=await submit(bot.id,'Reply with exactly these three separate lines and no tools: ALPHA_NATIVE\nBETA_NATIVE\nGAMMA_NATIVE');
 const result=await done(first.id);
 assert.equal(result.state,'completed',result.error);
 assert.match(result.reply,/ALPHA_NATIVE/);
 assert.match(result.reply,/BETA_NATIVE/);
 assert.match(result.reply,/GAMMA_NATIVE/);
 const deltas=observed.filter(e=>e.runId===first.id&&e.type==='native_event'&&e.event?.type==='message_update');
 assert.ok(deltas.some(e=>e.event.assistantMessageEvent?.type==='text_delta'),'Actual native text_delta must be delivered through SSE');
 console.log(JSON.stringify({check:'native-stream',state:result.state,deltaCount:deltas.length}));
 const output=join(home,'bots',bot.id,'private','work','native-proof.txt');
 const denied=await submit(bot.id,`Use write once to create ${output.replaceAll('\\','/')} with exact content WORKBENCH_PERMISSION_71931. Do not retry if denied.`);
 const deniedApproval=await requestApproval(denied.id);
 await api('/api/approvals/'+deniedApproval.id+'/respond',{method:'POST',body:{value:selected(deniedApproval,false)}});
 await done(denied.id);
 assert.equal(existsSync(output),false,'Denied native action cannot create its output');
 console.log(JSON.stringify({check:'native-denial',outputExists:false}));
 await api('/api/bots/'+bot.id+'/session/new',{method:'POST',body:{}});
 const approved=await submit(bot.id,`Use write once to create ${output.replaceAll('\\','/')} with exact content WORKBENCH_PERMISSION_71931.`);
 const approvedApproval=await requestApproval(approved.id);
 await api('/api/approvals/'+approvedApproval.id+'/respond',{method:'POST',body:{value:selected(approvedApproval,true)}});
 const written=await done(approved.id);
 assert.equal(written.state,'completed',written.error);
 assert.equal(readFileSync(output,'utf8'),'WORKBENCH_PERMISSION_71931');
 console.log(JSON.stringify({check:'native-approval',content:'WORKBENCH_PERMISSION_71931'}));
 await api('/api/bots/'+bot.id+'/session/new',{method:'POST',body:{}});
 const toolCode = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(home,'native-tool-started.txt'))},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(join(home,'native-tool-finished.txt'))},'UNEXPECTED_FINISH'),60000)`;
 const cancelling=await submit(bot.id,`Use bash once to run exactly this command: node -e ${JSON.stringify(toolCode)}. Wait until the tool is finished.`);
 const toolApproval=await requestApproval(cancelling.id);
 await api('/api/approvals/'+toolApproval.id+'/respond',{method:'POST',body:{value:selected(toolApproval,true)}});
 await until(()=>observed.find(e=>e.runId===cancelling.id&&e.type==='native_event'&&e.event?.type==='tool_execution_start'));
 await until(()=>existsSync(join(home,'native-tool-started.txt')));
 const toolPid=Number(readFileSync(join(home,'native-tool-started.txt'),'utf8'));
 const stopAt=Date.now();
 const cliStop = await runCli(process.execPath,['ompbot.mjs','runs','stop',cancelling.id,'--home',home,'--json'],{cwd:'C:/Users/<user>/Desktop/omp_bot',timeout:30000,windowsHide:true});
 const verdict=JSON.parse(cliStop.stdout);
 assert.equal(verdict.accepted,true,'CLI must reach the live owning backend');
 const cancelled=await done(cancelling.id);
 assert.equal(cancelled.state,'cancelled',cancelled.error);
 let toolAlive=true;try{process.kill(toolPid,0);}catch{toolAlive=false;}
 assert.equal(toolAlive,false,'The actual busy child process must be gone after native cancellation');
 assert.equal(existsSync(join(home,'native-tool-finished.txt')),false,'Cancelled native tool must not reach its delayed effect');
 console.log(JSON.stringify({check:'native-tool-cancel',state:cancelled.state,confirmedAfterMs:Date.now()-stopAt}));
 const after=await submit(bot.id,'No tools. Reply exactly POST_CANCEL_READY.');
 const settled=await done(after.id);
 assert.equal(settled.state,'completed',settled.error);
 assert.match(settled.reply,/POST_CANCEL_READY/);
 console.log(JSON.stringify({check:'scope-reusable-after-confirmed-cancel',state:settled.state}));
 const stored=await api('/api/runs');
 assert.ok(stored.runs.some(x=>x.id===first.id&&x.state==='completed'));
 const history=await api('/api/events/history?since=0');
 assert.ok(history.events.some(e=>e.runId===first.id&&e.type==='run_finished'));
 assert.equal(new Set(history.events.map(e=>e.seq)).size,history.events.length);
 console.log(JSON.stringify({check:'durable-run-history',runs:stored.runs.length,lastSeq:history.lastSeq}));
}finally{if(eventReader)await eventReader.cancel().catch(()=>{});await server.close();rmSync(home,{recursive:true,force:true});}
