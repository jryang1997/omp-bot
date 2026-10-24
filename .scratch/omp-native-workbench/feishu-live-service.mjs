import {startServer} from '../../src/server.mjs';
import {writeFileSync} from 'node:fs';
const server=await startServer({home:'C:/Users/<user>/.ompbot',port:0,bin:'C:/Users/<user>/Desktop/omp_bot/.desktop-runtime/omp.exe'});
let bot=server.orch.listBots().find(b=>b.name==='FeishuQA');
if(!bot)bot=server.orch.addBot({name:'FeishuQA',model:'magpie/opencode-go/deepseek-v4.1-flash',thinking:'low',approvalMode:'always-ask',instructions:'专用飞书验收 Bot。只执行用户明确要求的本地测试，不发送外部消息，不访问私人资料。'});
writeFileSync(new URL('./feishu-live-service.json',import.meta.url),JSON.stringify({url:server.url,launchUrl:server.launchUrl,botId:bot.id}));
console.log('FEISHU_LOCAL_READY '+server.url);
process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{if(text.trim()==='close')void server.close().then(()=>process.exit(0));});
