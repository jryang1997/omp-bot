// 06 号票：bot 以 team/bots/<名> 为 cwd 启动时，omp 18.10.3 实际读到哪些 AGENTS.md。
// 依赖 mock-llm.mjs 在跑，HOME 指向带 mock 提供方的隔离目录。运行：node context-lab.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const LAB = process.env.LAB ?? '/data/omp-lab';
const LOG = path.join(LAB, 'requests.jsonl');
const env = { ...process.env, HOME: path.join(LAB, 'home') };
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const git = dir => execFileSync('git', ['init', '-q', dir]);

function systemPrompt(cwd, extra = []) {
  fs.writeFileSync(LOG, '');
  execFileSync('omp', ['-p', 'hi', '--model', 'mock/m1', '--no-session', ...extra], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
  const req = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(r => r.url.includes('chat/completions'));
  const sys = req.body.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('')).join('\n');
  return sys;
}
const MARKERS = ['USER-LEVEL-AGENTS-MARKER', 'ABOVE-MARKER', 'OUTER-REPO-MARKER', 'TEAM-MARKER', 'BOT-MARKER', 'WORKSPACE-MARKER'];
const found = sys => MARKERS.filter(m => sys.includes(m));

const out = { ticket: '06-agents-md-boundary', omp: execFileSync('omp', ['--version'], { env }).toString().trim(), at: new Date().toISOString(), layouts: {} };
fs.rmSync(path.join(LAB, 'layouts'), { recursive: true, force: true });

// A team 是 git 仓库，外面一层有 AGENTS.md
{
  const root = path.join(LAB, 'layouts/A');
  write(`${root}/AGENTS.md`, 'ABOVE-MARKER\n');
  git(`${root}/team`);
  write(`${root}/team/AGENTS.md`, 'TEAM-MARKER\n');
  write(`${root}/team/bots/xiaozhi/AGENTS.md`, 'BOT-MARKER\n');
  out.layouts.A_teamIsGitRepo = found(systemPrompt(`${root}/team/bots/xiaozhi`));
}
// B team 不是 git 仓库，外面一层有 AGENTS.md
{
  const root = path.join(LAB, 'layouts/B');
  write(`${root}/AGENTS.md`, 'ABOVE-MARKER\n');
  write(`${root}/team/AGENTS.md`, 'TEAM-MARKER\n');
  write(`${root}/team/bots/xiaozhi/AGENTS.md`, 'BOT-MARKER\n');
  out.layouts.B_teamNotGit = found(systemPrompt(`${root}/team/bots/xiaozhi`));
}
// C team 不是 git 仓库，但套在一个外层 git 仓库里
{
  const root = path.join(LAB, 'layouts/C');
  git(root);
  write(`${root}/AGENTS.md`, 'OUTER-REPO-MARKER\n');
  write(`${root}/team/AGENTS.md`, 'TEAM-MARKER\n');
  write(`${root}/team/bots/xiaozhi/AGENTS.md`, 'BOT-MARKER\n');
  out.layouts.C_insideOuterRepo = found(systemPrompt(`${root}/team/bots/xiaozhi`));
}
// D team 是 git 仓库，又套在外层 git 仓库里
{
  const root = path.join(LAB, 'layouts/D');
  git(root);
  write(`${root}/AGENTS.md`, 'OUTER-REPO-MARKER\n');
  git(`${root}/team`);
  write(`${root}/team/AGENTS.md`, 'TEAM-MARKER\n');
  write(`${root}/team/bots/xiaozhi/AGENTS.md`, 'BOT-MARKER\n');
  out.layouts.D_nestedRepo = found(systemPrompt(`${root}/team/bots/xiaozhi`));
}
// E 布局 A，再加 --add-dir 指向一个带 AGENTS.md 的用户项目
{
  const root = path.join(LAB, 'layouts/A');
  write(path.join(LAB, 'layouts/E-project/AGENTS.md'), 'WORKSPACE-MARKER\n');
  git(path.join(LAB, 'layouts/E-project'));
  out.layouts.E_teamRepoPlusAddDir = found(systemPrompt(`${root}/team/bots/xiaozhi`, ['--add-dir', path.join(LAB, 'layouts/E-project')]));
}
// F 布局 A，加上 omp-bot 现在的 overlay（逐文件关掉用户级和项目级 AGENTS.md）
{
  const root = path.join(LAB, 'layouts/A');
  const overlay = path.join(LAB, 'layouts/isolate-current.yml');
  write(overlay, 'disabledExtensions:\n  - context-file:user:AGENTS.md\n  - context-file:project:AGENTS.md\n');
  out.layouts.F_teamRepoWithCurrentOverlay = found(systemPrompt(`${root}/team/bots/xiaozhi`, ['--config', overlay]));
}
// G 布局 A，只关用户级 AGENTS.md
{
  const root = path.join(LAB, 'layouts/A');
  const overlay = path.join(LAB, 'layouts/isolate-user-only.yml');
  write(overlay, 'disabledExtensions:\n  - context-file:user:AGENTS.md\n');
  out.layouts.G_teamRepoUserOnlyDisabled = found(systemPrompt(`${root}/team/bots/xiaozhi`, ['--config', overlay]));
}
fs.writeFileSync(new URL('context-proof.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 1));
process.exit(0);
