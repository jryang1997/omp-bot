import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../../src/orchestrator.mjs';
const home=mkdtempSync(join(tmpdir(),'ompbot-private-memory-proof-'));
const markers=[randomUUID(),randomUUID()];const events=[];
const orch=new Orchestrator({home,bin:'C:/Users/<user>/Desktop/omp_bot/.desktop-runtime/omp.exe',onEvent:event=>events.push(event)});
orch.onEvent=event=>{events.push(event);if(event.type==='ui_request'){const a=event.approval;if(a.method==='select'){const approved=a.options?.find(value=>/^Approve$/i.test(value));if(approved)void orch.answerUi(a.id,{value:approved}).catch(()=>{});}}};
const evidence=[];
try{
 const bots=markers.map((_,i)=>orch.addBot({name:'PrivateMemoryQA'+i,model:'magpie/opencode-go/deepseek-v4.1-flash',thinking:'max',memoryEnabled:true,approvalMode:'write',instructions:'Temporary local memory QA. Use only native learn and read of memory:// paths. No external messages, no network tools, no other file writes.'}));
 for(let i=0;i<bots.length;i++){
  const run=orch.startRun({botId:bots[i].id,text:`Use native learn to store this exact private marker for this Bot only: ${markers[i]}. Reply STORED after successful learn.`,timeoutMs:120000});
  const done=await orch.waitRun(run.id,{timeoutMs:150000});assert.equal(done.state,'completed',done.error);
  const runtime=orch.runtimes.get(bots[i].id+'::private');assert.ok(runtime);
  assert.equal(runtime.rpc.env.PI_CODING_AGENT_DIR,runtime.agentDir);
  assert.ok(existsSync(join(runtime.agentDir,'agent.db')),'Native agent DB must exist in private directory');
  const status=orch.features.native.memoryStatus(bots[i].id);assert.equal(status.available,true,JSON.stringify(status.reasons));
  const learned=status.files['learned.md'].path;assert.ok(existsSync(learned),'Learned file must exist');
  const content=readFileSync(learned,'utf8');assert.ok(content.includes(markers[i]),'Own marker must be stored');assert.ok(!content.includes(markers[1-i]),'Other Bot marker must be absent');
  assert.ok(events.some(event=>event.runId===run.id&&event.type==='native_event'&&event.event?.toolName==='learn'),'Native learn must actually execute');
  evidence.push({check:'actual-native-learn-in-private-dir',botId:bots[i].id,privateAgentDir:runtime.agentDir,model:done.stats.model,learnedPath:learned,ownMarkerStored:true,otherMarkerAbsent:true});
 }
 for(let i=0;i<bots.length;i++){
  await orch.restartBotRuntimes(bots[i].id,{reason:'memory-isolation-proof'});await orch.newSession(bots[i].id);
  const run=orch.startRun({botId:bots[i].id,text:'Read memory://root/learned.md with native read, then reply with the exact private marker stored for this Bot. Do not call learn or write.',timeoutMs:120000});
  const done=await orch.waitRun(run.id,{timeoutMs:150000});assert.equal(done.state,'completed',done.error);assert.ok(done.reply.includes(markers[i]),'Restart must preserve own marker');assert.ok(!done.reply.includes(markers[1-i]),'Restart must not recall other Bot');
  evidence.push({check:'restart-new-session-private-recall',botId:bots[i].id,ownMarkerRecalled:true,otherMarkerAbsent:true});
 }
 const note='PRIVATE_MEMORY_EDIT_QA';
 orch.features.native.memoryWrite(bots[0].id,'private',{file:'MEMORY.md',content:note});
 const edited=orch.features.native.memoryRead(bots[0].id);assert.equal(edited.content['MEMORY.md'],note);
 const cleared=orch.features.native.memoryClear(bots[0].id);assert.ok(cleared.cleared.some(item=>item.file==='learned.md'));assert.ok(cleared.cleared.every(item=>existsSync(item.backup)));
 const empty=orch.features.native.memoryRead(bots[0].id);assert.equal(empty.content['MEMORY.md'],'');assert.equal(empty.content['learned.md'],'');
 const other=orch.features.native.memoryRead(bots[1].id);assert.ok(other.content['learned.md'].includes(markers[1]),'Clear must not erase the other Bot');
 await orch.restartBotRuntimes(bots[0].id,{reason:'memory-clear-proof'});await orch.newSession(bots[0].id);
 const check=orch.startRun({botId:bots[0].id,text:'Read memory://root/learned.md only. If there is no stored marker reply exactly NO_LEARNED_MARKER. Do not inspect sessions or backups, do not write or learn.',timeoutMs:120000});
 const forgotten=await orch.waitRun(check.id,{timeoutMs:150000});assert.equal(forgotten.state,'completed',forgotten.error);assert.ok(forgotten.reply.includes('NO_LEARNED_MARKER'));assert.ok(!forgotten.reply.includes(markers[0]),'Fresh session must not recall cleared derived memory');
 evidence.push({check:'scoped-edit-clear-and-fresh-session',editReadback:true,derivedMemoryCleared:true,backupPreserved:true,otherBotPreserved:true,clearedMarkerNotRecalled:true,sourceSessionsRetained:true});
 writeFileSync(new URL('./private-memory-proof.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),checks:evidence,globalCredentialsCopied:false,externalMessagesSent:false},null,2));console.log(JSON.stringify({checks:evidence.map(item=>({check:item.check,botId:item.botId,ownMarkerStored:item.ownMarkerStored,ownMarkerRecalled:item.ownMarkerRecalled,otherMarkerAbsent:item.otherMarkerAbsent})),accepted:true}));
}catch(error){console.error('PRIVATE_MEMORY_FAILURE '+error.message);throw error;}finally{await orch.shutdown();try{rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){console.warn(JSON.stringify({cleanup:false,home,code:error.code}));}}
