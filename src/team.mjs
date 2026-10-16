// team.mjs — 团队目录：每个 bot 的 cwd、身份、会话、私有文件和共享工作区都在这里。
//
// 布局（默认 ~/.ompbot/team）：
//   team/                     git 仓库，omp 往上找 AGENTS.md 停在这里
//     AGENTS.md               团队共识（第一次创建写模板，之后 omp-bot 不再改）
//     .gitignore
//     skills/<name>/SKILL.md  共享技能库
//     workspace/              共享工作区，客机挂到 /workspace
//     .memory/                记忆库
//     bots/<id>/AGENTS.md     个人身份，omp-bot 只改身份块
//     bots/<id>/.omp/skills/  私有技能
//     bots/<id>/work/         私有文件，客机挂到 ~/work
//     bots/<id>/sessions/<scope>/  会话，scope 是 private 或 room_<群 id>
//
// omp 判断仓库根只看有没有名为 `.git` 的条目。没有 git 时手建一个空仓库骨架，
// omp 照样停在 team 根上，以后装了 git 这个骨架也是合法的空仓库。
// 运行时生成的 persona.md、isolate.yml 不进 team，放在 <home>/bots/<id>/<scope>/。
//
// 升级迁移：旧版每个 scope 一套 <home>/bots/<id>/<scope>/{work,sessions,agent}。
// 第一次启动时只复制、不删、不覆盖，做完在 team 根上留 MIGRATION_MARKER。

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ferr } from "./features/util.mjs";

export const TEAM_DIRNAME = "team";
export const IDENTITY_START = "<!-- omp-bot 身份块开始。这一段按设置表单生成，改这里会同步回表单；块外的内容 omp-bot 不碰。 -->";
export const IDENTITY_END = "<!-- omp-bot 身份块结束 -->";
const START_RE = /<!-- omp-bot 身份块开始[^>]*-->/;
const END_RE = /<!-- omp-bot 身份块结束[^>]*-->/;
const NO_ROLE = "（未设置）";

export const TEAM_GITIGNORE = [
  "# omp-bot 生成。会话、私有文件、共享工作区和记忆库不进版本历史。",
  ".memory/",
  "workspace/",
  "bots/*/sessions/",
  "bots/*/work/",
  "# 项目级 MCP 配置可能带密钥",
  "bots/*/.omp/mcp.json",
  "",
].join("\n");

export const TEAM_AGENTS_TEMPLATE = `# 团队共识

这是团队所有成员共用的规矩。每个成员自己的身份写在 \`bots/<id>/AGENTS.md\`。
只有主助手（Main Bot）和用户改这个文件。其他成员有建议，告诉主助手。

## 说话方式（默认）

- 默认用简体中文，对方用别的语言就跟着用；口吻像同事聊天。
- 先说结果、对用户的影响、他接下来要做什么，细节按需要再补。
- 把对方当普通用户，不默认他懂技术；术语只在需要时出现，第一次出现就用一句大白话解释。
- 日常对话别写成「问题 / 决策 / 检查 / 下一步」那样的工程清单；用户要技术细节时再展开。
- 回复用户时别贴日志、路径、变量名、内部工具名、Run id、协议字段，除非用户想看，或它们本身就是答案。
- 用户当场的要求和你自己 AGENTS.md 里的专属指令优先于这些默认。

## 征求同意（默认）

- 用户明确交办的常规、可逆的事，直接做完再汇报，不要每一步都回来问。
- 付款、对外发消息、对外发布、删除账号或重要数据、改账号和权限，先取得用户明确同意；用户没有回应不算同意。
- 被拒绝或被取消的操作就停下，不换工具或路径重试，也不提议用别的工具绕开，用一句大白话说清这件事没做成；用户重新明确授权前不再尝试。

## 两台机器

- 本机是用户自己的电脑。你的目录是 \`bots/<你的 id>/\`，自己的文件放它下面的 \`work/\`，大家共用的放 team 根下的 \`workspace/\`。用户选的项目目录也能读写。
- 共享电脑是一台 Linux 虚拟机，每个成员有自己的 Linux 用户和屏幕，用 computer_ 开头的工具操作。\`~/work\` 就是本机的 \`work/\`，\`/workspace\` 就是本机的 \`workspace/\`，两边改的是同一份文件。
- 要开浏览器、装软件、跑长任务，优先放在共享电脑上，不占用户的本机。

## 共享电脑规则

- 只动自己的用户和屏幕，不进别人的主目录。
- 网站登录大家共用。不点共享网站的「退出登录」，不改密码，不解绑设备。
- 不开远程调试端口，不把浏览器或服务暴露到外网。
- 装系统包每次都要用户批准，先说清楚为什么要装。
- 浏览器用完就关，省内存。

## 私聊和群聊

- 私聊里用户告诉你的事，群里不主动提。
- 群里说话前想清楚这轮有没有实质内容。
`;

/** scope 转成目录名：private 照旧，room:<id> 变 room_<id>。 */
export function safeScope(scope) {
  return String(scope ?? "private").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function teamRoot(home) {
  return join(home, TEAM_DIRNAME);
}

/**
 * 一个 bot 在某 scope 下的全部路径。别的模块不再自己拼路径。
 * - cwd：omp 进程工作目录，私聊群聊共用；项目级 .omp/ 在这里
 * - workDir：私有文件，客机挂到 ~/work
 * - sessionDir：按 scope 分开的会话
 * - baseDir：运行时生成的 persona.md、isolate.yml（不进 team）
 */
export function teamPaths(home, botId, scope = "private") {
  const root = teamRoot(home);
  const cwd = join(root, "bots", botId);
  const baseDir = join(home, "bots", botId, safeScope(scope));
  return {
    teamRoot: root,
    teamAgentsFile: join(root, "AGENTS.md"),
    cwd,
    agentsFile: join(cwd, "AGENTS.md"),
    workDir: join(cwd, "work"),
    skillsDir: join(cwd, ".omp", "skills"),
    librarySkillsDir: join(root, "skills"),
    sessionDir: join(cwd, "sessions", safeScope(scope)),
    baseDir,
    agentDir: join(baseDir, "agent"),
  };
}

/**
 * 进 runtime 复用签名的上下文摘要：两层 AGENTS.md 的内容，加上共享库和私有技能目录的清单。
 * 任何一样变了，下一轮就重启进程续上会话，新内容和新技能才进得了系统提示词。
 */
export function contextDigest(paths) {
  const h = createHash("sha256");
  for (const file of [paths.teamAgentsFile, paths.agentsFile]) {
    h.update(file).update("\0");
    try {
      h.update(readFileSync(file));
    } catch {
      h.update("-");
    }
    h.update("\0");
  }
  for (const dir of [paths.librarySkillsDir, paths.skillsDir]) {
    if (!dir) continue;
    h.update(dir).update("\0");
    for (const name of skillDirNames(dir)) {
      try {
        const st = statSync(join(dir, name, "SKILL.md"));
        h.update(`${name}:${st.mtimeMs}:${st.size}\0`);
      } catch {}
    }
  }
  return h.digest("hex").slice(0, 16);
}

// ---------------- 技能 ----------------
// omp 的发现规则：技能目录下每个子目录放一个 SKILL.md，不递归，跳过点开头的目录；
// 名字取 frontmatter 的 name，没写就用目录名。共享库走 skills.customDirectories，
// 那里的技能必须写 description，否则 omp 不加载。

/** 极简 frontmatter 读取（只取 name/description/enabled 这类单行字段，不引依赖）。 */
export function parseSkillFrontmatter(text) {
  const out = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "");
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, k, v] = kv;
    out[k] = v.replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

function skillDirNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** 列出一个技能目录里的技能。 */
export function listSkills(dir) {
  const out = [];
  for (const dirName of skillDirNames(dir)) {
    const file = join(dir, dirName, "SKILL.md");
    let text;
    try {
      text = readFileSync(file, "utf8").slice(0, 20_000);
    } catch {
      continue;
    }
    const fm = parseSkillFrontmatter(text);
    out.push({
      name: fm.name || dirName,
      dirName,
      description: fm.description ?? "",
      path: file,
      enabled: fm.enabled !== "false",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 技能名不合规的原因；合规返回 null。逗号会把 --skills 拆错，* ? [ ] { } ! 会被当成匹配符号。 */
export function skillNameProblem(name) {
  const n = String(name ?? "");
  if (!n.trim()) return "技能名不能为空";
  if (n !== n.trim()) return "技能名首尾不能有空格";
  if (n.length > 64) return "技能名最多 64 个字";
  if (n.startsWith(".")) return "技能名不能以点开头，omp 会跳过这种目录";
  if (/[\\/]/.test(n)) return "技能名里不能有 / 或 \\";
  if (/[,*?[\]{}!]/.test(n)) return "技能名里不能有逗号和 * ? [ ] { } !，omp 会把它们当成匹配符号";
  if (/[\u0000-\u001f<>:"|]/.test(n)) return "技能名里不能有 < > : \" | 和控制字符，Windows 上没法当目录名";
  return null;
}

/**
 * 白名单怎么传给 omp。null 表示库里全部技能，不传 --skills；
 * 列表时并上私有技能一起传，并完为空就 --no-skills。
 */
export function skillArgs(bot, paths) {
  if (!Array.isArray(bot?.skills)) return [];
  const names = [...new Set([...bot.skills, ...listSkills(paths.skillsDir).map((s) => s.name)])].filter(
    (n) => n && !n.includes(","),
  );
  return names.length ? ["--skills", names.join(",")] : ["--no-skills"];
}

const SKILL_COPY_LIMITS = { files: 500, bytes: 20 * 1024 * 1024 };

/** 把一个技能目录整个复制过去。符号链接不跟；超过上限就停，免得把大目录当技能装。 */
function copySkillTree(src, dest) {
  let files = 0;
  let bytes = 0;
  const plan = [];
  const walk = (from, rel) => {
    for (const ent of readdirSync(from, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) continue;
      const a = join(from, ent.name);
      const r = rel ? join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === ".git" || ent.name === "node_modules") continue;
        walk(a, r);
      } else if (ent.isFile()) {
        files += 1;
        bytes += statSync(a).size;
        if (files > SKILL_COPY_LIMITS.files || bytes > SKILL_COPY_LIMITS.bytes) {
          throw ferr(413, "skill_too_large", `技能目录太大（超过 ${SKILL_COPY_LIMITS.files} 个文件或 20MB），只装技能本身需要的文件`);
        }
        plan.push([a, join(dest, r)]);
      }
    }
  };
  walk(src, "");
  for (const [a, b] of plan) {
    mkdirSync(dirname(b), { recursive: true });
    copyFileSync(a, b, fsConstants.COPYFILE_EXCL);
  }
  return files;
}

const oneLine = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const block = (v) => String(v ?? "").replace(/\r\n?/g, "\n").trim();

/** 花名册字段在身份块里的样子：名字和角色压成一行，指令去掉首尾空白。 */
export function identityFields(bot) {
  return { name: oneLine(bot?.name), role: oneLine(bot?.role), instructions: block(bot?.instructions) };
}

/** 生成身份块（含起止注释）。 */
export function renderIdentityBlock(bot) {
  const f = identityFields(bot);
  const lines = [
    IDENTITY_START,
    "# 你的身份",
    "",
    `- 名字：${f.name}`,
    `- 角色：${f.role || NO_ROLE}`,
    `- id：${bot.id}。你的目录是 team 下的 \`bots/${bot.id}/\`，自己的文件放 \`work/\`。`,
  ];
  if (bot.isMain === true) lines.push("- 你是主助手（Main Bot）。团队共识 team 根下的 AGENTS.md 由你和用户维护。");
  for (const note of bot.identityNotes ?? []) lines.push(`- ${oneLine(note)}`);
  lines.push("", "## 专属指令", "");
  if (f.instructions) lines.push(f.instructions);
  lines.push(IDENTITY_END);
  return lines.join("\n");
}

/** 从 AGENTS.md 文本里读出身份块；没有块返回 null。 */
export function parseIdentityBlock(text) {
  const src = block(text);
  const s = START_RE.exec(src);
  if (!s) return null;
  const rest = src.slice(s.index + s[0].length);
  const e = END_RE.exec(rest);
  if (!e) return null;
  const body = rest.slice(0, e.index);
  const name = /^- 名字：(.*)$/m.exec(body)?.[1]?.trim() ?? "";
  const roleRaw = /^- 角色：(.*)$/m.exec(body)?.[1]?.trim() ?? "";
  const heading = /^## 专属指令[ \t]*$/m.exec(body);
  const instructions = heading ? block(body.slice(heading.index + heading[0].length)) : "";
  return { name, role: roleRaw === NO_ROLE ? "" : roleRaw, instructions };
}

/** 只替换身份块；没有块就把块放在最前面，原有内容原样留在后面。 */
export function replaceIdentityBlock(text, nextBlock) {
  const src = String(text ?? "");
  const s = START_RE.exec(src);
  if (s) {
    const tail = src.slice(s.index + s[0].length);
    const e = END_RE.exec(tail);
    if (e) {
      const endAt = s.index + s[0].length + e.index + e[0].length;
      return src.slice(0, s.index) + nextBlock + src.slice(endAt);
    }
  }
  return src.trim() ? `${nextBlock}\n\n${src}` : `${nextBlock}\n\n${BOT_AGENTS_TAIL}`;
}

/** 新建个人 AGENTS.md 时放在身份块后面的说明。块外属于用户和 bot。 */
export const BOT_AGENTS_TAIL = `<!-- 下面是你和用户的地方：可以记工作习惯、常用资料位置、做事偏好。omp-bot 不会改动这里。 -->
`;

export const MIGRATION_MARKER = ".omp-bot-migrated.json";
export const OLD_MEMORY_DIRNAME = "old-memory";
export const OLD_MEMORY_NOTE = "以前的记忆摘要复制到了 `work/old-memory/`，按私聊和各个群分开放。需要回想以前的事时去读。";
/** 旧 local 记忆里值得带走的文件。raw_memories.md 是未整理的原料，不带。 */
const OLD_MEMORY_FILES = new Set(["memory_summary.md", "MEMORY.md", "learned.md"]);

/**
 * 只复制不覆盖：目标已有同名文件就跳过。符号链接不跟也不复制，免得把外面的东西带进 team。
 * @returns {{copied:number, skipped:number, failed:string[]}}
 */
export function copyMissing(src, dest, { skipTop = [] } = {}) {
  const tally = { copied: 0, skipped: 0, failed: [], files: [] };
  const walk = (from, to, top) => {
    let entries;
    try {
      entries = readdirSync(from, { withFileTypes: true });
    } catch (e) {
      tally.failed.push(`${from}: ${e.code ?? e.message}`);
      return;
    }
    for (const ent of entries) {
      if (top && skipTop.includes(ent.name)) continue;
      const a = join(from, ent.name);
      const b = join(to, ent.name);
      try {
        if (ent.isSymbolicLink()) {
          tally.skipped += 1;
        } else if (ent.isDirectory()) {
          walk(a, b, false);
        } else if (ent.isFile()) {
          if (existsSync(b)) {
            tally.skipped += 1;
            continue;
          }
          mkdirSync(to, { recursive: true });
          copyFileSync(a, b, fsConstants.COPYFILE_EXCL);
          const st = statSync(a);
          utimesSync(b, st.atime, st.mtime); // 保留时间：omp --continue 按修改时间挑最近的会话
          tally.copied += 1;
          tally.files.push(b);
        }
      } catch (e) {
        tally.failed.push(`${a}: ${e.code ?? e.message}`);
      }
    }
  };
  if (existsSync(src)) walk(src, dest, true);
  return tally;
}

/**
 * 会话头记着创建时的 cwd。omp 续接时按它找 AGENTS.md，旧目录还在就会读不到 team 的两层。
 * 只改副本的会话头，指到新 cwd；保留修改时间。改了返回 true。
 */
export function rerootSessionFile(file, fromRoot, toCwd) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    let head;
    try {
      head = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (head?.type !== "session") continue;
    const cwd = typeof head.cwd === "string" ? head.cwd : "";
    if (cwd !== fromRoot && !cwd.startsWith(`${fromRoot}/`) && !cwd.startsWith(`${fromRoot}\\`)) return false;
    lines[i] = JSON.stringify({ ...head, cwd: toCwd });
    const st = statSync(file);
    writeFileSync(file, lines.join("\n"), "utf8");
    utimesSync(file, st.atime, st.mtime);
    return true;
  }
  return false;
}

const isDir = (p) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * 把一个 bot 的旧数据复制进 team。没有旧目录返回 null。
 * 私聊工作目录合到 work 根上，群聊的放 work/rooms/<scope>/；会话进 sessions/<scope>/；
 * 旧 work/.omp/skills 进私有技能目录，私聊的 work/.omp/mcp.json 进 bot 的 .omp/；
 * 旧 local 记忆摘要进 work/old-memory/<scope>/。
 */
export function migrateLegacyBot(home, botId) {
  const legacy = join(home, "bots", botId);
  if (!isDir(legacy)) return null;
  const p = teamPaths(home, botId);
  const out = { scopes: [], copied: 0, skipped: 0, failed: [], oldMemory: false };
  const add = (t) => {
    out.copied += t.copied;
    out.skipped += t.skipped;
    out.failed.push(...t.failed);
    return t.copied;
  };
  for (const ent of readdirSync(legacy, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const scope = ent.name;
    const base = join(legacy, scope);
    const oldWork = join(base, "work");
    const oldSessions = join(base, "sessions");
    const oldMemories = join(base, "agent", "memories");
    if (!isDir(oldWork) && !isDir(oldSessions) && !isDir(oldMemories)) continue;
    out.scopes.push(scope);
    const workDest = scope === "private" ? p.workDir : join(p.workDir, "rooms", scope);
    add(copyMissing(oldWork, workDest, { skipTop: [".omp"] }));
    add(copyMissing(join(oldWork, ".omp", "skills"), p.skillsDir));
    if (scope === "private") {
      const mcp = join(oldWork, ".omp", "mcp.json");
      const mcpDest = join(p.cwd, ".omp", "mcp.json");
      if (existsSync(mcp) && !lstatSync(mcp).isSymbolicLink()) {
        if (existsSync(mcpDest)) out.skipped += 1;
        else {
          mkdirSync(join(p.cwd, ".omp"), { recursive: true });
          copyFileSync(mcp, mcpDest, fsConstants.COPYFILE_EXCL);
          out.copied += 1;
        }
      }
    }
    const sessions = copyMissing(oldSessions, join(p.cwd, "sessions", scope));
    add(sessions);
    for (const file of sessions.files) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        if (rerootSessionFile(file, legacy, p.cwd)) out.rerooted = (out.rerooted ?? 0) + 1;
      } catch (e) {
        out.failed.push(`${file}: ${e.code ?? e.message}`);
      }
    }
    if (isDir(oldMemories)) {
      const memDest = join(p.workDir, OLD_MEMORY_DIRNAME, scope);
      for (const root of readdirSync(oldMemories, { withFileTypes: true })) {
        if (!root.isDirectory()) continue;
        for (const f of readdirSync(join(oldMemories, root.name), { withFileTypes: true })) {
          if (!f.isFile() || !OLD_MEMORY_FILES.has(f.name)) continue;
          const from = join(oldMemories, root.name, f.name);
          const to = join(memDest, f.name);
          try {
            if (!readFileSync(from, "utf8").trim()) continue; // 空文件不算记忆
            if (existsSync(to)) {
              out.skipped += 1;
              continue;
            }
            mkdirSync(memDest, { recursive: true });
            copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
            out.copied += 1;
            out.oldMemory = true;
          } catch (e) {
            out.failed.push(`${from}: ${e.code ?? e.message}`);
          }
        }
      }
    }
  }
  if (!out.scopes.length) return null;
  if (isDir(join(p.workDir, OLD_MEMORY_DIRNAME))) out.oldMemory = true;
  return out;
}

let gitProbe = null;
function hasGitBinary() {
  if (gitProbe === null) {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
      gitProbe = true;
    } catch {
      gitProbe = false;
    }
  }
  return gitProbe;
}

const GIT_IDENTITY = ["-c", "user.name=omp-bot", "-c", "user.email=omp-bot@localhost", "-c", "commit.gpgsign=false"];

/**
 * 团队目录。建目录、写模板、写身份块、自动提交。
 * 只读副本（别的进程持锁）不写任何东西。
 */
export class TeamDir {
  /**
   * @param {{home:string, readonly?:boolean, git?:boolean, onEvent?:(type:string, data:object)=>void}} opts
   *        git 不给时自动探测；测试可强制 false 走无 git 骨架。
   */
  constructor({ home, readonly = false, git, onEvent } = {}) {
    this.home = home;
    this.root = teamRoot(home);
    this.readonly = readonly;
    this.git = git ?? hasGitBinary();
    this.onEvent = onEvent ?? (() => {});
    this._queue = Promise.resolve();
    this._pending = [];
    this._scheduled = false;
    this._identityStat = new Map();
    this.lastError = null;
  }

  paths(botId, scope = "private") {
    return teamPaths(this.home, botId, scope);
  }

  status() {
    return { root: this.root, git: this.git, readonly: this.readonly, lastError: this.lastError };
  }

  /** 建出目录树、.gitignore、团队 AGENTS.md 模板和仓库。重复调用不覆盖已有文件。 */
  ensure() {
    if (this.readonly) return this;
    for (const d of ["skills", "workspace", ".memory", "bots"]) mkdirSync(join(this.root, d), { recursive: true });
    const created = [];
    const writeOnce = (rel, content) => {
      const file = join(this.root, rel);
      if (existsSync(file)) return;
      writeFileSync(file, content, "utf8");
      created.push(rel);
    };
    writeOnce(".gitignore", TEAM_GITIGNORE);
    writeOnce("AGENTS.md", TEAM_AGENTS_TEMPLATE);
    const gitDir = join(this.root, ".git");
    if (!existsSync(gitDir)) {
      if (this.git) this._gitInit();
      else this._gitSkeleton(gitDir);
    }
    if (created.length) this.commit(`建立团队目录：${created.join("、")}`);
    return this;
  }

  /**
   * 升级后第一次启动把旧数据复制进来。有标记就不再做；单个文件失败记进标记，不挡启动。
   * @param {{id:string, name?:string}[]} bots
   * @returns {null | {bots:Record<string, object>}} 这次做了迁移才返回报告
   */
  migrate(bots) {
    if (this.readonly) return null;
    const marker = join(this.root, MIGRATION_MARKER);
    if (existsSync(marker)) return null;
    const report = { version: 1, at: new Date().toISOString(), bots: {} };
    const names = [];
    let broken = null;
    for (const bot of bots) {
      let r;
      try {
        r = migrateLegacyBot(this.home, bot.id);
      } catch (e) {
        broken = e; // 整个 bot 读不下来：不留标记，下次启动再试；已复制的不会重复
        continue;
      }
      if (!r) continue;
      report.bots[bot.id] = r;
      if (r.copied) names.push(bot.name || bot.id);
    }
    if (names.length) this.commit(`迁移旧数据：${names.join("、")}`);
    if (broken) {
      this._fail("migrate", broken);
      return report;
    }
    writeFileSync(marker, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const failed = Object.values(report.bots).reduce((n, r) => n + r.failed.length, 0);
    if (failed) this._fail("migrate", new Error(`${failed} 个旧文件没复制成功，详情在 ${MIGRATION_MARKER}`));
    this.onEvent("team_migrated", { bots: Object.keys(report.bots), failed });
    if (!names.length) this.commit("记下旧数据已检查");
    return report;
  }

  _gitInit() {
    try {
      execFileSync("git", ["init", "-q"], { cwd: this.root, stdio: "ignore", windowsHide: true, timeout: 20_000 });
      execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: this.root, stdio: "ignore", windowsHide: true, timeout: 10_000 });
    } catch (e) {
      this._fail("git_init", e);
      if (!existsSync(join(this.root, ".git"))) this._gitSkeleton(join(this.root, ".git"));
    }
  }

  /** 空仓库骨架：HEAD、config、objects、refs。omp 只要有 `.git` 就停在这里。 */
  _gitSkeleton(gitDir) {
    for (const d of ["objects/info", "objects/pack", "refs/heads", "refs/tags"]) mkdirSync(join(gitDir, d), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n", "utf8");
    writeFileSync(join(gitDir, "description"), "omp-bot 团队目录（没有 git，装上 Git 才有改动历史）\n", "utf8");
  }

  /**
   * 排队提交 team 里的全部改动。没有 git 或只读时什么都不做。
   * 同一轮同步代码里的多次改动合成一次提交，提交信息把每一项都写上。
   */
  commit(message) {
    if (this.readonly || !this.git) return this._queue;
    this._pending.push(message);
    if (this._scheduled) return this._queue;
    this._scheduled = true;
    const run = (args) =>
      new Promise((resolve, reject) => {
        execFile("git", args, { cwd: this.root, windowsHide: true, timeout: 30_000 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        });
      });
    this._queue = this._queue
      .then(async () => {
        this._scheduled = false;
        const messages = this._pending.splice(0);
        if (!existsSync(join(this.root, ".git"))) return;
        await run(["add", "-A"]);
        const staged = await run(["diff", "--cached", "--name-only"]);
        if (!String(staged).trim()) return;
        await run([...GIT_IDENTITY, "commit", "-q", "--no-verify", "-m", messages.join("；")]);
        this.onEvent("team_committed", { messages });
      })
      .catch((e) => this._fail("git_commit", e));
    return this._queue;
  }

  /** 等排队的提交跑完（关停和测试用）。 */
  flush() {
    return this._queue;
  }

  _fail(step, e) {
    this.lastError = { step, error: e?.message ?? String(e), at: Date.now() };
    this.onEvent("team_error", this.lastError);
  }

  /** 团队里所有技能：共享库一份，每个 bot 的私有技能一份。 */
  allSkills() {
    const out = listSkills(join(this.root, "skills")).map((s) => ({ ...s, scope: "library", botId: null }));
    for (const botId of skillDirNames(join(this.root, "bots"))) {
      for (const s of listSkills(this.paths(botId).skillsDir)) out.push({ ...s, scope: "bot", botId });
    }
    return out;
  }

  /** 按名字找已装的技能（不分大小写，Windows 上目录名本来就不分）。 */
  findSkill(name) {
    const key = String(name).toLowerCase();
    return this.allSkills().find((s) => s.name.toLowerCase() === key || s.dirName.toLowerCase() === key) ?? null;
  }

  /**
   * 装一个技能。来源是本机的技能目录（或其中的 SKILL.md），或直接给 SKILL.md 文本。
   * 库里和任何 bot 的私有技能都不许重名。
   * @param {{target:"library"|"bot", botId?:string, path?:string, content?:string, describe?:(hit:object)=>string}} input
   * @returns {{name:string, target:string, botId:string|null, dir:string, files:number}}
   */
  installSkill({ target, botId = null, path, content, describe } = {}) {
    if (this.readonly) throw ferr(409, "team_readonly", "另一个 omp-bot 正在使用这份数据，这里只能看不能装");
    if (target !== "library" && target !== "bot") throw ferr(400, "skill_target_invalid", "target 只能是 library（共享库）或 bot（只给这个 bot）");
    if (target === "bot" && !botId) throw ferr(400, "skill_target_invalid", "只给一个 bot 装时要指明是哪个 bot");
    let text;
    let srcDir = null;
    if (typeof content === "string" && content.trim()) {
      text = content;
    } else if (typeof path === "string" && path.trim()) {
      const abs = resolve(path.trim());
      let st;
      try {
        st = statSync(abs);
      } catch {
        throw ferr(400, "skill_source_missing", `找不到 ${abs}`);
      }
      srcDir = st.isDirectory() ? abs : basename(abs) === "SKILL.md" ? dirname(abs) : null;
      if (!srcDir) throw ferr(400, "skill_source_invalid", "要给技能目录，或者目录里的 SKILL.md");
      try {
        text = readFileSync(join(srcDir, "SKILL.md"), "utf8");
      } catch {
        throw ferr(400, "skill_source_invalid", `${srcDir} 里没有 SKILL.md`);
      }
    } else {
      throw ferr(400, "skill_source_missing", "给一个技能目录，或者贴上 SKILL.md 的内容");
    }
    const fm = parseSkillFrontmatter(text);
    const name = fm.name || (srcDir ? basename(srcDir) : "");
    const problem = skillNameProblem(name);
    if (problem) throw ferr(400, "skill_name_invalid", fm.name || srcDir ? problem : "SKILL.md 开头的 frontmatter 要写 name");
    if (!fm.description) throw ferr(400, "skill_description_missing", "SKILL.md 开头的 frontmatter 要写 description，omp 靠它决定什么时候用这个技能");
    const hit = this.findSkill(name);
    if (hit) {
      const where = describe ? describe(hit) : hit.scope === "library" ? "共享库里" : `${hit.botId} 的私有技能里`;
      throw ferr(409, "skill_name_taken", `${where}已经有叫「${hit.name}」的技能了。库里和每个 bot 的私有技能不能重名，换个名字再装。`, { name: hit.name, scope: hit.scope, botId: hit.botId });
    }
    const dest = target === "library" ? join(this.root, "skills", name) : join(this.paths(botId).skillsDir, name);
    let files = 1;
    if (srcDir) files = copySkillTree(srcDir, dest);
    else {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "SKILL.md"), text, { encoding: "utf8", flag: "wx" });
    }
    return { name, target, botId: target === "bot" ? botId : null, dir: dest, files };
  }

  /**
   * 写个人 AGENTS.md 的身份块。块外内容原样保留；文件不存在就新建。
   * @returns {boolean} 文件是否真的变了
   */
  writeIdentity(bot) {
    if (this.readonly) return false;
    const { agentsFile, cwd } = this.paths(bot.id);
    mkdirSync(cwd, { recursive: true });
    let before = "";
    try {
      before = readFileSync(agentsFile, "utf8");
    } catch {}
    const notes = [...(bot.identityNotes ?? [])];
    if (isDir(join(cwd, "work", OLD_MEMORY_DIRNAME))) notes.push(OLD_MEMORY_NOTE);
    const next = replaceIdentityBlock(before, renderIdentityBlock({ ...bot, identityNotes: notes }));
    if (next === before) {
      this._rememberStat(bot.id, agentsFile);
      return false;
    }
    writeFileSync(agentsFile, next, "utf8");
    this._rememberStat(bot.id, agentsFile);
    return true;
  }

  /** 读身份块。没有文件或没有块返回 null。 */
  readIdentity(botId) {
    try {
      return parseIdentityBlock(readFileSync(this.paths(botId).agentsFile, "utf8"));
    } catch {
      return null;
    }
  }

  /** 文件从上次读写后变过才解析，否则返回 null。读花名册的热路径只多一次 stat。 */
  readIdentityIfChanged(botId) {
    const file = this.paths(botId).agentsFile;
    let st;
    try {
      st = statSync(file);
    } catch {
      return null;
    }
    const key = `${st.mtimeMs}:${st.size}`;
    if (this._identityStat.get(botId) === key) return null;
    this._identityStat.set(botId, key);
    return this.readIdentity(botId);
  }

  _rememberStat(botId, file) {
    try {
      const st = statSync(file);
      this._identityStat.set(botId, `${st.mtimeMs}:${st.size}`);
    } catch {}
  }
}
