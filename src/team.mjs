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

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    sessionDir: join(cwd, "sessions", safeScope(scope)),
    baseDir,
    agentDir: join(baseDir, "agent"),
  };
}

/** 两层 AGENTS.md 的内容摘要，进 runtime 复用签名：文件一变，下一轮就重启进程续上会话。 */
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
  return h.digest("hex").slice(0, 16);
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
    const next = replaceIdentityBlock(before, renderIdentityBlock(bot));
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
