import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { startServer } from '../../src/server.mjs';
const home=mkdtempSync(join(tmpdir(),'ompbot-image-proof-'));
const backend=await startServer({port:0,home,bin:'C:/Users/<user>/Desktop/omp_bot/.desktop-runtime/omp.exe'});
function crc32(buf){let crc=0xffffffff;for(const byte of buf){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(type,buf){const name=Buffer.from(type);const size=Buffer.alloc(4);size.writeUInt32BE(buf.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([name,buf])));return Buffer.concat([size,name,buf,crc]);}
const width=160,height=80,raw=Buffer.alloc((width*3+1)*height);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){const offset=y*(width*3+1)+1+x*3;raw[offset]=x<width/2?255:0;raw[offset+2]=x<width/2?0:255;}
const head=Buffer.alloc(13);head.writeUInt32BE(width,0);head.writeUInt32BE(height,4);head[8]=8;head[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
async function api(path,body){const r=await fetch(backend.url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+backend.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(JSON.stringify(d));return d;}
try{
 const {bot}=await api('/api/bots',{name:'ImageNativeQA',role:'Temporary local image acceptance',model:'magpie/commandcode-plan/deepseek/deepseek-v4.1-flash',thinking:'low',instructions:'Inspect only the user supplied image; no tools or external messages. Return only the requested JSON, without prose or markdown fences.'});
 const {attachment}=await api('/api/attachments',{botId:bot.id,filename:'two-colors.png',mime:'image/png',dataBase64:png.toString('base64')});
 const {run}=await api('/api/runs',{botId:bot.id,text:'Inspect the attached image. Return exactly one JSON object with left and right equal to the dominant color of each half, using English basic color names. No tools.',attachmentIds:[attachment.id],timeoutMs:120000});
 let done;const deadline=Date.now()+150000;while(Date.now()<deadline){const current=(await api('/api/runs/'+run.id)).run;if(['completed','failed','cancelled','interrupted','reconciliation_required'].includes(current.state)){done=current;break;}await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(done,'Image turn must settle');assert.equal(done.state,'completed',done.error);
 const jsonText=done.reply.match(/\{[^{}]+\}/)?.[0];assert.ok(jsonText,'Image response must contain requested object');const colors=JSON.parse(jsonText);assert.deepEqual(colors,{left:'red',right:'blue'});
 console.log(JSON.stringify({check:'native-image-upload-and-vision',accepted:true,colors,model:done.stats?.model??null,mime:attachment.mime,inputHash:attachment.hash}));
}finally{await backend.close();rmSync(home,{recursive:true,force:true});}
