// 08 号票：mnemopi 记忆能否按 bot 目录自然分库，不改 PI_CODING_AGENT_DIR。
// 依赖 mock-llm.mjs 在跑。llmMode none + noEmbeddings，记忆按原文全文检索，结果可复现。运行：node memory-lab.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const LAB = process.env.LAB ?? '/data/omp-lab';
const ROOT = path.join(LAB, 'memlab');
const HOME = path.join(ROOT, 'home');
const LOG = path.join(LAB, 'requests.jsonl');
const env = { ...process.env, HOME };
delete env.PI_CODING_AGENT_DIR;
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

fs.rmSync(ROOT, { recursive: true, force: true });
write(path.join(HOME, '.omp/agent/models.yml'), fs.readFileSync(path.join(LAB, 'home/.omp/agent/models.yml'), 'utf8'));
const TEAM = path.join(ROOT, 'team');
for (const b of ['a', 'b']) write(`${TEAM}/bots/${b}/AGENTS.md`, `bot ${b}\n`);
execFileSync('git', ['init', '-q', TEAM]);
const USERPROJ = path.join(ROOT, 'user-project');
write(`${USERPROJ}/README.md`, 'x\n');
execFileSync('git', ['init', '-q', USERPROJ]);

const base = 'memory:\n  backend: mnemopi\nmnemopi:\n  llmMode: none\n  noEmbeddings: true\n  retainEveryNTurns: 1\n';
const cfg = (name, extra) => { const p = path.join(ROOT, `${name}.yml`); write(p, base + extra); return p; };
const C = {
  perProject: cfg('per-project', '  scoping: per-project\n'),
  tagged: cfg('tagged', '  scoping: per-project-tagged\n'),
  userGlobal: cfg('user-global', '  scoping: global\n'),
  teamGlobal: cfg('team-global', '  scoping: global\n  bank: team\n'),
  teamTagged: cfg('team-tagged', '  scoping: per-project-tagged\n  bank: team\n'),
};
const omp = (cwd, prompt, config) => new Promise((resolve, reject) => {
  const p = spawn('omp', ['-p', prompt, '--model', 'mock/m1', '--config', config], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  p.on('close', code => code === 0 ? resolve() : reject(new Error(`omp exit ${code}: ${err.slice(-500)}`)));
});
const MARKS = ['BOTA1', 'BOTA2', 'BOTB1', 'USERG1', 'TEAMG1', 'PRIVA1', 'STA1', 'STA2', 'STB1', 'CNMARK1'];
async function recall(cwd, config, q = 'pineapple') {
  fs.writeFileSync(LOG, '');
  await omp(cwd, q, config);
  const txt = fs.readFileSync(LOG, 'utf8');
  return MARKS.filter(m => txt.includes(m));
}
const banks = () => fs.readdirSync(path.join(HOME, '.omp/agent/memories/mnemopi/banks')).sort();
const out = { ticket: '08-memory-per-bot', omp: execFileSync('omp', ['--version'], { env }).toString().trim(), at: new Date().toISOString(), note: 'team 是 git 仓库，bot cwd = team/bots/<名>，HOME 下只有 models.yml，没有设置 PI_CODING_AGENT_DIR', steps: {} };

// 1 同一 bot 两个会话并发写（模拟私聊和群聊同时进行），另一 bot 写一条
await Promise.all([
  omp(`${TEAM}/bots/a`, 'pineapple fact from private chat BOTA1', C.perProject),
  omp(`${TEAM}/bots/a`, 'pineapple fact from group chat BOTA2', C.perProject),
  omp(`${TEAM}/bots/b`, 'pineapple fact BOTB1', C.perProject),
]);
out.steps.banksAfterBotWrites = banks();
out.steps.perProject_botA_recalls = await recall(`${TEAM}/bots/a`, C.perProject);
out.steps.perProject_botB_recalls = await recall(`${TEAM}/bots/b`, C.perProject);

// 2 用户在自己的项目里用全局库写一条，bot 用不同 scoping 召回
await omp(USERPROJ, 'pineapple user global note USERG1', C.userGlobal);
out.steps.banksAfterUserGlobal = banks();
out.steps.perProject_botA_afterUserGlobal = await recall(`${TEAM}/bots/a`, C.perProject);
out.steps.tagged_botA_afterUserGlobal = await recall(`${TEAM}/bots/a`, C.tagged);

// 3 团队库：bank: team 的全局库写一条共识，bot 用 bank: team + per-project-tagged 召回
await omp(TEAM, 'pineapple team consensus TEAMG1', C.teamGlobal);
out.steps.banksAfterTeamGlobal = banks();
out.steps.teamTagged_botA = await recall(`${TEAM}/bots/a`, C.teamTagged);
out.steps.teamTagged_botB = await recall(`${TEAM}/bots/b`, C.teamTagged);

// 4 dbPath 指到 bot 自己目录
const dbp = path.join(TEAM, 'bots/a/.memory/mnemopi.db');
const C_db = cfg('dbpath', `  scoping: per-project\n  dbPath: ${dbp}\n`);
await omp(`${TEAM}/bots/a`, 'pineapple private db PRIVA1', C_db);
const listFiles = d => fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String).sort() : null;
out.steps.dbPath_filesInBotDir = listFiles(path.join(TEAM, 'bots/a/.memory'));
out.steps.dbPath_botA_recalls = await recall(`${TEAM}/bots/a`, C_db);
out.steps.banksAfterDbPath = banks();

// 5 会话文件落在哪
out.steps.sessionsDirs = listFiles(path.join(HOME, '.omp/agent/sessions'))?.filter(f => !f.includes('/')) ?? null;

// 6 用 bot id 当库名，不依赖路径。scoping global + bank bot-<id>，所有 bot 共用 team/.memory 下一个 SQLite 文件
const C_id = id => cfg(`id-${id}`, `  scoping: global\n  bank: bot-${id}\n  dbPath: ${path.join(TEAM, '.memory/mnemopi.db')}\n`);
await Promise.all([
  omp(`${TEAM}/bots/a`, 'pineapple stable id STA1', C_id('a')),
  omp(`${TEAM}/bots/a`, 'pineapple stable id STA2', C_id('a')),
  omp(`${TEAM}/bots/b`, 'pineapple stable id STB1', C_id('b')),
]);
out.steps.stableId_filesInTeamMemory = listFiles(path.join(TEAM, '.memory'));
out.steps.stableId_botA_recalls = await recall(`${TEAM}/bots/a`, C_id('a'));
out.steps.stableId_botB_recalls = await recall(`${TEAM}/bots/b`, C_id('b'));
// 把 team 目录整体搬走，同一个 bank 名照样召回；按路径分库的 per-project 则找不回
const MOVED = path.join(ROOT, 'team-moved');
fs.renameSync(TEAM, MOVED);
const C_idMoved = cfg('id-a-moved', `  scoping: global\n  bank: bot-a\n  dbPath: ${path.join(MOVED, '.memory/mnemopi.db')}\n`);
out.steps.afterMove_stableId_botA_recalls = await recall(`${MOVED}/bots/a`, C_idMoved);
out.steps.afterMove_perProject_botA_recalls = await recall(`${MOVED}/bots/a`, C.perProject);
fs.renameSync(MOVED, TEAM);

// 7 中文。noEmbeddings 时只有全文检索，问句要和原话有连续重合才召回
fs.mkdirSync(`${TEAM}/bots/c`, { recursive: true });
await omp(`${TEAM}/bots/c`, '我最喜欢菠萝味的冰淇淋 CNMARK1', C.perProject);
out.steps.cjkFullTextOnly = {};
for (const q of ['冰淇淋', '菠萝味的冰淇淋', '我喜欢什么口味的冰淇淋', '我爱吃什么']) out.steps.cjkFullTextOnly[q] = (await recall(`${TEAM}/bots/c`, C.perProject, q)).includes('CNMARK1');

out.sourceFacts = {
  file: 'node_modules/@oh-my-pi/pi-coding-agent/src/mnemopi/config.ts',
  projectBank: 'per-project 库名 = [bank-]<cwd 末段>-<Bun.hash(绝对 cwd)>，只看 cwd，不看 git 根',
  legacyRescue: '同一 banks 目录下，行里记录的 cwd 全等于当前 cwd 的旧库也会被召回；路径变了就不匹配',
  globalScope: 'scoping global 时库名就是 bank 配置值，召回只读这一个库',
  autolearn: 'src/autolearn/managed-skills.ts 写死在 <agentDir>/managed-skills，src/discovery/builtin.ts 无条件发现它。不改 PI_CODING_AGENT_DIR 时 bot 学到的技能会进用户自己的 omp',
  memoryRole: 'src/mnemopi/backend.ts 的 llmMode smol 按 memory 角色选模型，persona.mjs 现有的 memoryModelRoles 已经钉住它',
  embeddingsNotVerified: 'multilingual-e5-small 在一次性 -p 进程里每次启动都记录 resuming interrupted embedding rebuild，进程退出前没建完，中文语义召回未测出',
};
fs.writeFileSync(new URL('./memory-proof.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
