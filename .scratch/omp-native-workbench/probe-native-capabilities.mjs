import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Orchestrator } from '../../src/orchestrator.mjs';
const home=mkdtempSync(join(tmpdir(),'ompbot-native-capabilities-'));
const events=[];
const orch=new Orchestrator({home,bin:'C:/Users/<user>/Desktop/omp_bot/.desktop-runtime/omp.exe',onEvent:e=>events.push(e)});
try{
 const bot=orch.addBot({name:'NativeCapabilityQA',model:'magpie/commandcode-plan/deepseek/deepseek-v4.1-flash',thinking:'low',approvalMode:'write',instructions:'Temporary local native QA. No external messages. Any task workers must use the same selected DeepSeek Flash model and must not use file or network tools.'});
 const rt=await orch.runtimeFor(bot.id,'private');
 const state=await rt.rpc.getState();
 const task=(state.dumpTools??[]).find(t=>t.name==='task');
 writeFileSync(new URL('./native-task-schema.json',import.meta.url),JSON.stringify({model:state.model,task},null,2));
 assert.ok(task,'Native task capability is required for subagent UI proof');
 console.log(JSON.stringify({check:'native-task-schema',model:state.model,parameters:task.parameters??task.inputSchema??null}));
}finally{await orch.shutdown();rmSync(home,{recursive:true,force:true});}
