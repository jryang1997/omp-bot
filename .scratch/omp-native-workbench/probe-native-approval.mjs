import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePersonaFiles } from '../../src/persona.mjs';
import assert from 'node:assert/strict';
const home = mkdtempSync(join(tmpdir(), 'ompbot-native-gate-'));
const { argv } = writePersonaFiles({name:'NativeGate',role:'Protocol probe',instructions:'Use exactly the tool asked for. Do not retry denied operations.',id:'gate'}, home);
const target = join(home, 'approved-output.txt');
const child = spawn('C:/Users/Jerry/Desktop/omp_bot/.desktop-runtime/omp.exe', ['--mode','rpc-ui','--approval-mode','always-ask','--tools','read,write','--model','magpie/commandcode-plan/deepseek/deepseek-v4.1-flash','--thinking','low','--session-dir',join(home,'sessions'),...argv], {cwd:home,stdio:['pipe','pipe','pipe'],windowsHide:true});
let buffer='';
const frames=[];
const pending=new Map();
let next=0;
let readyResolve;
const ready=new Promise(resolve=>{readyResolve=resolve;});
let answer='deny';
let uiSeen=0;
let deltaSeen=0;
function send(frame){child.stdin.write(JSON.stringify(frame)+'\n');}
function command(frame){const id='probe_'+(++next);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Command timeout '+frame.type));},30000);pending.set(id,{resolve,reject,timer});send({...frame,id});});}
child.stdout.setEncoding('utf8');
child.stderr.on('data',()=>{});
child.stdout.on('data',data=>{buffer+=data;let nl;while((nl=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);let f;try{f=JSON.parse(line);}catch{continue;}frames.push(f);if(f.type==='ready')readyResolve(f);if(f.type==='response'){const p=pending.get(f.id);if(p){clearTimeout(p.timer);pending.delete(f.id);if(f.success===false)p.reject(new Error(f.error));else p.resolve(f.data);}}if(f.type==='message_update')deltaSeen++;if(f.type==='extension_ui_request'&&['select','confirm'].includes(f.method)){uiSeen++;console.log(JSON.stringify({kind:'approval',method:f.method,title:f.title,options:f.options,answer}));if(f.method==='confirm')send({type:'extension_ui_response',id:f.id,confirmed:answer==='allow'});else {const selected=(f.options||[]).find(x=>answer==='allow'?/^(allow|approve)/i.test(x):/^deny/i.test(x));if(selected)send({type:'extension_ui_response',id:f.id,value:selected});else send({type:'extension_ui_response',id:f.id,cancelled:true});}}}});
async function prompt(message){const before=frames.length;const response=await command({type:'prompt',message});if(response?.agentInvoked===false)return;const id='probe_'+next;const until=Date.now()+120000;while(Date.now()<until){const done=frames.slice(before).find(f=>f.type==='prompt_result'&&f.id===id);if(done)return done;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Prompt timeout');}
try {
 await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Ready timeout')),30000))]);
 await command({type:'negotiate_protocol',protocolVersion:2});
 await command({type:'set_event_filter',events:null,messageUpdates:'delta'});
 await command({type:'set_ask_dialog',enabled:true});
 await prompt(`Call write once to create ${target.replaceAll('\\','/')} with exact content NATIVE_APPROVAL_OK. Do not retry if denied. Then report the result.`);
 assert.ok(uiSeen>0,'Native approval must produce a real UI frame');
 assert.equal(existsSync(target),false,'Denied native write must leave no file');
 console.log(JSON.stringify({kind:'deny-proof',fileExists:false,uiSeen,deltaSeen}));
 answer='allow';
 await command({type:'new_session'});
 await prompt(`Call write once to create ${target.replaceAll('\\','/')} with exact content NATIVE_APPROVAL_OK. Then report the result.`);
 assert.equal(existsSync(target),true,'Approved native write must create the file');
 console.log(JSON.stringify({kind:'allow-proof',fileExists:true,uiSeen,deltaSeen}));
} finally {child.stdin.end();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(()=>{child.kill();resolve();},3000))]);rmSync(home,{recursive:true,force:true});}
