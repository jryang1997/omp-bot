import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Orchestrator } from '../../src/orchestrator.mjs';
const home=mkdtempSync(join(tmpdir(),'ompbot-metadata-proof-'));
const orch=new Orchestrator({home,bin:'C:/Users/Jerry/Desktop/omp_bot/.desktop-runtime/omp.exe'});
const exec=promisify(execFile);const observations=[];
try{
 const bot=orch.addBot({name:'ModelMetadataQA',model:'magpie/commandcode-plan/deepseek/deepseek-v4.1-flash',thinking:'low',instructions:'No tools or extra prose. Reply only the exact requested token.'});
 for(let i=0;i<2;i++){const run=orch.startRun({botId:bot.id,text:'Reply exactly METADATA_NATIVE_'+i,timeoutMs:60000});const done=await orch.waitRun(run.id,{timeoutMs:90000});assert.equal(done.state,'completed',done.error);assert.match(done.reply,new RegExp('METADATA_NATIVE_'+i));const state=await orch.runtimes.get(bot.id+'::private').rpc.getState();const identity=state.model.provider+'/'+state.model.id;assert.equal(done.stats.model,identity,'Run model must match the actual resolved native model');const usage=orch.ledger.usage().perRun.find(row=>row.runId===run.id);assert.equal(usage.model,identity);assert.equal(usage.cost,done.stats.delta.cost);observations.push({check:'actual-model-and-usage',runId:run.id,model:identity,cost:usage.cost,tokens:usage.totalTokens});}
 const resources=[];const started=Date.now();
 for(let count=1;count<=12;count++){
   if(count>1)orch.addBot({name:'ResourceQA'+count,model:bot.model,thinking:'low'});
   const next=orch.listBots().find(b=>!orch.runtimes.has(b.id+'::private'));if(next)await orch.runtimeFor(next.id,'private');
   if([1,4,12].includes(count)){const pids=[...orch.runtimes.values()].map(rt=>rt.rpc.proc.pid);const ps=await exec('powershell.exe',['-NoProfile','-Command',`Get-Process -Id ${pids.join(',')} | Select-Object Id,WorkingSet64,CPU | ConvertTo-Json -Compress`],{timeout:30000,windowsHide:true});const rows=JSON.parse(ps.stdout);const list=Array.isArray(rows)?rows:[rows];resources.push({bots:count,pids:list.map(p=>p.Id),workingSetBytes:list.reduce((s,p)=>s+p.WorkingSet64,0),cumulativeCpuSeconds:list.reduce((s,p)=>s+(p.CPU??0),0),elapsedFromFirstMs:Date.now()-started});}
 }
 writeFileSync(new URL('./metadata-resource-proof.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),observations,resources,limits:'Runtime idle working set after sequential startup; includes two native text turns for the first bot; no claim of throughput speedup or peak memory.'},null,2));console.log(JSON.stringify({observations,resources}));
}finally{await orch.shutdown();rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
