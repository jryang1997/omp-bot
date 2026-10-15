// 07 号票：共享技能库加每 bot 白名单，用 omp 18.10.3 原生配置实测；同时量技能数对系统提示词的影响。
// 依赖 mock-llm.mjs 在跑。运行：node skills-lab.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const LAB = process.env.LAB ?? '/data/omp-lab';
const LOG = path.join(LAB, 'requests.jsonl');
const env = { ...process.env, HOME: path.join(LAB, 'home') };
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const root = path.join(LAB, 'skills-team');
fs.rmSync(root, { recursive: true, force: true });
execFileSync('git', ['init', '-q', root]);
write(`${root}/AGENTS.md`, '团队共识\n');
const bot = `${root}/bots/xiaozhi`;
write(`${bot}/AGENTS.md`, '小知\n');
const skill = (dir, name, desc) => write(`${dir}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nBODY-OF-${name}\n`);
const DESC = n => `Use when preparing or reviewing ${n} work for the user; covers drafting, checking sources, formatting the result and handing it back with a short summary of what changed.`;
for (let i = 1; i <= 30; i++) skill(`${root}/skills`, `lib-${String(i).padStart(2, '0')}`, DESC(`lib-${i}`));
skill(`${root}/skills`, 'same-name', 'LIBRARY copy of same-name. Use when testing which copy wins.');
skill(`${bot}/.omp/skills`, 'private-notes', 'Use when the user asks xiaozhi to keep private notes.');
skill(`${bot}/.omp/skills`, 'same-name', 'PRIVATE copy of same-name. Use when testing which copy wins.');

function run(overlay, extra = []) {
  const file = path.join(LAB, 'skills-overlay.yml');
  write(file, overlay);
  fs.writeFileSync(LOG, '');
  execFileSync('omp', ['-p', 'hi', '--model', 'mock/m1', '--no-session', '--config', file, ...extra], { cwd: bot, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
  const req = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(r => r.url.includes('chat/completions'));
  const sys = req.body.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('')).join('\n');
  const names = [...new Set([...sys.matchAll(/\b(lib-\d\d|private-notes|same-name)\b/g)].map(m => m[1]))].sort();
  return { chars: sys.length, skills: names, sameName: sys.includes('LIBRARY copy') ? 'library' : sys.includes('PRIVATE copy') ? 'private' : null, bodyLeaked: sys.includes('BODY-OF-') };
}
const base = 'disabledExtensions:\n  - context-file:user:AGENTS.md\nskills:\n  enablePiUser: false\n  enableAgentsUser: false\n  enableClaudeUser: false\n  enableCodexUser: false\n  enableOpencodeUser: false\n';
const lib = `  customDirectories:\n    - ${root}/skills\n`;
const include = list => `  includeSkills:\n${list.map(s => `    - "${s}"`).join('\n')}\n`;
const out = { ticket: '07-skill-library-allowlist', at: new Date().toISOString(), runs: {} };
out.runs.noLibraryConfigured = run(base);
out.runs.libraryAllSkills = run(base + lib);
out.runs.libraryAllowTwoPlusPrivate = run(base + lib + include(['lib-01', 'lib-02', 'private-notes']));
out.runs.libraryAllowTwoOnly = run(base + lib + include(['lib-01', 'lib-02']));
out.runs.libraryEmptyInclude = run(base + lib + '  includeSkills: []\n');
out.runs.libraryCliSkillsFilter = run(base + lib, ['--skills', 'lib-0*,private-notes']);
out.runs.noSkillsFlag = run(base + lib, ['--no-skills']);
out.runs.sameNameBoth = run(base + lib + include(['same-name']));
// 体积：0、10、30 个库技能
out.size = {
  skills0: run(base, ['--no-skills']).chars,
  skills10: run(base + lib + include(['lib-0*', 'lib-10'])).chars,
  skills30: run(base + lib + include(['lib-*'])).chars,
};
out.size.perSkillChars = Math.round((out.size.skills30 - out.size.skills0) / 30);
fs.writeFileSync(new URL('skills-proof.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 1));
process.exit(0);
