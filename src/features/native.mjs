// features/native.mjs — 复用 OMP 原生能力的状态面：capabilities / MCP / skills / memory / browser 接管。
//
// 原则：能读原生状态就读原生状态（get_state、get_available_commands、配置文件、原生 reader），
// 不复制 skill registry、不建第二记忆后端、不发明原生没有的 API。读不到的字段如实写 unknown，
// 前置条件不满足时明确拒绝（4xx + 原因），而不是给假成功。

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clone, ferr } from "./util.mjs";
import { COMPUTER_TOOL_NAMES } from "./computers.mjs";
import { computerIdFor, permissionOf } from "../domain.mjs";
import { listSkills, memoryBank, parseSkillFrontmatter, teamPaths } from "../team.mjs";
import { MEMORY_EMBEDDING_VARIANT } from "../persona.mjs";
import { DatabaseSync } from "node:sqlite";

const SERVER_NAME_RE = /^[A-Za-z0-9_.:-][A-Za-z0-9_.: -]{0,98}$/;
const SECRET_KEY_RE = /(token|secret|key|pass[\s_-]*word|authorization|cookie|credential)/i;
const MEMORY_LIST_LIMIT = 50;
const MEMORY_CONTENT_CLIP = 2000;
const EMBEDDING_MODELS = { multilingual: "intfloat/multilingual-e5-large", en: "BAAI/bge-base-en-v1.5" };

/**
 * Bot 的路径（与 BotRuntime/runtimeDirs 同一来源：团队目录模块）。
 * cwd 是 team/bots/<id>，项目级 .omp/（MCP、技能、配置）在这里；workDir 是它下面的 work/。
 * 用户选的 workspace 只用 --add-dir 加入，作为单独的允许读根返回，绝不当作 cwd
 * （否则项目级 MCP 配置/技能发现/检查点会写到用户工作区，而原生进程读不到）。
 * @returns {{cwd:string,baseDir:string,workDir:string,sessionDir:string,memoryDbPath:string,workspace:string|null}}
 */
export function botPaths(orch, home, botId, scope = "private") {
  const provided =
    typeof orch?.botWorkDir === "function" ? orch.botWorkDir(botId, scope) : typeof orch?.botPaths === "function" ? orch.botPaths(botId, scope) : null;
  const ws = orch?.getBot?.(botId)?.workspace;
  const workspace = typeof ws === "string" && ws.trim() ? ws.trim() : null;
  if (provided?.baseDir && provided?.cwd) return { workspace, ...provided };
  const rt = orch?.runtimes?.get?.(`${botId}::${scope}`);
  const paths = teamPaths(home, botId, scope);
  return {
    ...paths,
    cwd: rt?.cwd ?? paths.cwd,
    sessionDir: rt?.sessionDir ?? paths.sessionDir,
    workspace,
  };
}

function readText(path, max = 200_000) {
  try {
    const s = readFileSync(path, "utf8");
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return null;
  }
}

/**
 * 原生 get_state 兼容层：真实编排器的 getNativeState 返回包装对象（原生状态在内层 state 字段，
 * 读失败时 state=null + error），测试夹具可能直接返回原生状态本身。
 */
function nativeStateOf(native) {
  if (!native || typeof native !== "object") return null;
  const isWrapper = "started" in native || "busy" in native; // 编排器包装层的字段
  if (isWrapper) return native.state && typeof native.state === "object" ? native.state : null;
  return native;
}

/** 取 YAML 顶层 `browser:` 块的正文；没有该块返回 null。 */
// ponytail: 只认原生 config-cli/setByPath 写出的块状 YAML，不支持 `browser: {enabled: false}` 行内流式写法。
function browserConfigBlock(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^browser\s*:\s*(#.*)?$/.test(line));
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() && !/^\s/.test(line)) break; // 下一个顶层键
    body.push(line);
  }
  return body.join("\n");
}

/** `browser:` 块的直接子键（同缩进一层）；嵌套子块里的同名键不算。 */
function browserConfigEntries(block) {
  const out = new Map();
  let indent = null;
  for (const line of String(block ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([ \t]+)([A-Za-z][\w-]*)\s*:\s*(.*?)\s*(#.*)?$/.exec(line);
    if (!m) continue;
    if (indent === null) indent = m[1];
    if (m[1] !== indent) continue;
    out.set(m[2], m[3]);
  }
  return out;
}

const asBool = (raw) => {
  const v = String(raw ?? "").replace(/^["']|["']$/g, "").trim();
  return v === "true" ? true : v === "false" ? false : null;
};
const asNum = (raw) => (/^\d+$/.test(String(raw ?? "").trim()) ? Number(String(raw).trim()) : null);

/** eval 描述里广告 browser prelude 的两种真实写法（xd://eval/browser 文档指针 / 命名空间列表行）。 */
const EVAL_BROWSER_ADVERTISED = /xd:\/\/eval\/browser|^-\s*`browser`\s*:/m;

/** 回显用 URL：剥掉 userinfo/query/hash（它们常带 token），并报告是否曾携带秘密。 */
export function redactUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { url: null, hadSecret: false, secretKeys: [] };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { url: null, hadSecret: true, secretKeys: ["url.unparsable"] };
  }
  const secretKeys = [];
  if (u.username || u.password) secretKeys.push("url.userinfo");
  for (const k of u.searchParams.keys()) if (SECRET_KEY_RE.test(k)) secretKeys.push(`url.query.${k}`);
  if (u.hash && SECRET_KEY_RE.test(u.hash)) secretKeys.push("url.hash");
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  return { url: u.toString(), hadSecret: secretKeys.length > 0, secretKeys };
}

function redactServer(name, cfg) {
  const secretKeys = [];
  for (const bag of ["env", "headers"]) {
    const m = cfg?.[bag];
    if (m && typeof m === "object") {
      for (const k of Object.keys(m)) if (SECRET_KEY_RE.test(k)) secretKeys.push(`${bag}.${k}`);
    }
  }
  const urlInfo = redactUrl(cfg?.url);
  secretKeys.push(...urlInfo.secretKeys);
  return {
    name,
    type: cfg.type ?? (cfg.url ? "http" : "stdio"),
    enabled: cfg.enabled !== false,
    command: cfg.command ?? null,
    url: urlInfo.url,
    urlRedacted: urlInfo.hadSecret,
    urlNote: urlInfo.hadSecret ? "URL 携带凭据（userinfo/query/hash），回显已剥离；真实值只在 Bot 私有配置里。" : null,
    args: Array.isArray(cfg.args) ? cfg.args.length : 0,
    hasSecrets: secretKeys.length > 0,
    secretKeys,
    timeout: cfg.timeout ?? null,
    instructions: cfg.instructions !== false,
  };
}

/** 原生 mcp.json 的校验规则（与 OMP config.ts validateServerConfig 对齐）。 */
export function validateMcpServer(name, cfg) {
  if (!SERVER_NAME_RE.test(String(name ?? ""))) {
    throw ferr(400, "invalid_mcp_name", `MCP 名称不合法：${JSON.stringify(name)}`);
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw ferr(400, "invalid_mcp_server", `${name} 的定义必须是对象`);
  }
  const type = cfg.type ?? (cfg.url ? "http" : "stdio");
  if (!["stdio", "http", "sse"].includes(type)) {
    throw ferr(400, "invalid_mcp_server", `${name} 的 type 非法：${cfg.type}`);
  }
  if (cfg.command && cfg.url) throw ferr(400, "invalid_mcp_server", `${name} 不能同时有 command 与 url`);
  if (type === "stdio" && !cfg.command) throw ferr(400, "invalid_mcp_server", `${name} 的 stdio 需要 command`);
  if ((type === "http" || type === "sse") && !cfg.url) {
    throw ferr(400, "invalid_mcp_server", `${name} 的 ${type} 需要 url`);
  }
  return { ...cfg, type };
}

/** frontmatter 读取放在团队目录模块里，这里转出去给老调用方用。 */
export { parseSkillFrontmatter };

export class NativeFeatures {
  /** @param {{orch:object, home:string, bin?:string}} deps */
  constructor({ orch, home, bin = "omp" }) {
    this.orch = orch;
    this.home = home;
    this.bin = bin;
    this.paused = new Map(); // `${botId}::${scope}` → takeover record
    const rooms = orch.listRooms?.() ?? [];
    for (const bot of orch.listBots?.() ?? []) {
      const scopes = ["private", ...rooms.filter((room) => room.members.includes(bot.id)).map((room) => `room:${room.id}`)];
      for (const scope of scopes) {
        const id = `takeover_${bot.id}_${scope}`.replace(/[^A-Za-z0-9_:]/g, "_");
        const record = orch.ledger?.get("settings", id);
        if (record?.kind === "browser-takeover" && record.active === true) this.paused.set(`${bot.id}::${scope}`, record);
      }
    }
  }

  paths(botId, scope = "private") {
    return botPaths(this.orch, this.home, botId, scope);
  }

  #requireBot(botId) {
    const bot = this.orch.getBot?.(String(botId ?? ""));
    if (!bot) throw ferr(404, "bot_not_found", `未知 Bot：${botId}`);
    return bot;
  }

  /**
   * 只看已在池中的 runtime；与 orch.runtimeFor 不同，绝不懒启动进程（探测状态不能有副作用）。
   */
  liveRuntime(botId, scope) {
    return this.orch.runtimes?.get?.(`${botId}::${scope}`) ?? null;
  }

  /** 原生 get_state（兼容编排器包装层与夹具直接返回原生状态两种形状），失败如实带回 error。 */
  async #readNative(botId, scope) {
    try {
      const raw = await this.orch.getNativeState(botId, { scope });
      const wrapperError = typeof raw?.error === "string" && raw.error ? raw.error : null;
      return { state: nativeStateOf(raw), error: wrapperError };
    } catch (e) {
      return { state: null, error: e?.message ?? String(e) };
    }
  }

  // ---------------- 能力总览 ----------------

  async capabilities(botId, scope = "private") {
    const bot = this.#requireBot(botId);
    const { state: native, error: nativeError } = await this.#readNative(botId, scope);
    const tools = Array.isArray(native?.dumpTools) ? native.dumpTools.map((t) => t?.name).filter(Boolean) : null;

    let commands = null;
    let commandsError = null;
    try {
      const r = await this.orch.nativeCommand(botId, "get_available_commands", { scope });
      const list = Array.isArray(r?.commands) ? r.commands : Array.isArray(r) ? r : null;
      commands = list ? list.map((c) => (typeof c === "string" ? c : (c?.name ?? String(c)))).filter(Boolean) : null;
    } catch (e) {
      commandsError = e?.message ?? String(e);
    }

    return {
      botId,
      scope,
      native: native
        ? {
            model: native.model ?? null,
            thinkingLevel: native.thinkingLevel ?? null,
            sessionId: native.sessionId ?? null,
            sessionFile: native.sessionFile ?? null,
            isSettled: native.isSettled ?? null,
            isStreaming: native.isStreaming ?? null,
            messageCount: native.messageCount ?? null,
            contextUsage: native.contextUsage ?? null,
          }
        : null,
      nativeError,
      commands,
      commandsError,
      tools: tools ? { count: tools.length, names: tools } : "unknown",
      execution: {
        permission: permissionOf(bot),
        mode: bot.executionMode,
        approvalMode: bot.approvalMode,
        sandbox: false,
        note: "三档都不是 OS 沙箱：先问我走 OMP 原生审批，全部放手跳过审批；本机没有已核实的 Windows 沙箱实现。",
      },
      // 电脑披露：绑定共享电脑是加法，本机工具、扩展、技能和 MCP 都在，客机工具加在上面；
      // chat 档没有客机工具，保留既有受控宿主读取工具。真实工具面看 tools.names（原生 dumpTools）。
      computer: bot.computer
        ? {
            bound: true,
            id: computerIdFor(bot.id),
            runtime: bot.computer.runtime,
            kind: bot.computer.kind,
            executionMode: bot.executionMode,
            hostToolsBlocked: false,
            guestTools: bot.executionMode === "chat" ? [] : [...COMPUTER_TOOL_NAMES],
            note:
              bot.executionMode === "chat"
                ? "只聊天档绑定电脑只提供桌面（人工接管/截图），聊天仍只有聊天：没有客机工具，也不依赖运行中的客机。"
                : "本机和共享电脑两套工具都在。本机工具按权限档审批；共享电脑里的工具不弹审批，装系统包除外。",
          }
        : { bound: false, id: null, hostToolsBlocked: false, guestTools: [] },
      mcp: this.mcpStatus(botId, scope),
      skills: await this.skillsStatus(botId, scope, commands),
      memory: this.memoryStatus(botId, scope),
      browser: {
        ...this.browserStatus(botId, scope),
        capability: await this.browserCapability(botId, scope, {
          rt: this.liveRuntime(botId, scope),
          state: native,
          error: nativeError,
        }),
      },
      auth: { reused: "native", loginProviders: "native（走 OMP login/凭据存储，本接口不回显任何凭据）" },
    };
  }

  // ---------------- MCP（Bot 私有项目配置） ----------------

  mcpFile(botId, scope = "private") {
    const { cwd } = this.paths(botId, scope);
    return join(cwd, ".omp", "mcp.json");
  }

  mcpStatus(botId, scope = "private") {
    const path = this.mcpFile(botId, scope);
    const exists = existsSync(path);
    let doc = null;
    let error = null;
    if (exists) {
      try {
        doc = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        error = `${path} 不是合法 JSON：${e?.message ?? e}`;
      }
    }
    const servers = doc?.mcpServers && typeof doc.mcpServers === "object"
      ? Object.entries(doc.mcpServers).map(([n, c]) => redactServer(n, c))
      : [];
    return {
      native: true,
      scope: "bot-project",
      path,
      exists,
      error,
      servers,
      disabledServers: Array.isArray(doc?.disabledServers) ? doc.disabledServers : [],
      enabledServers: Array.isArray(doc?.enabledServers) ? doc.enabledServers : [],
      secretsReturned: false,
      note: "原生格式 .omp/mcp.json；真实工具调用由 OMP 原生 MCP 运行时处理，本接口不回显密钥。",
    };
  }

  /**
   * 写入 Bot 私有 .omp/mcp.json 并走 core 的安全重建。
   * 运行中拒绝写入（409 runtime_busy），保留用户提交的原配置与进行中的回合；
   * 空闲时写入后真正 await 重建，并原样回报 blocked 结果（不假称已生效）。
   */
  async putMcp(botId, scope, body = {}) {
    this.#requireBot(botId);
    // 只探测已在池中的 runtime；绝不调用 runtimeFor（那会懒启动一个进程）。
    const busy = typeof this.orch.botRuntimeBusy === "function" ? this.orch.botRuntimeBusy(botId) === true : false;
    if (busy) {
      throw ferr(409, "runtime_busy", "该 Bot 正在运行，配置未写入；等这一轮结束后再保存", { busy: true });
    }
    const path = this.mcpFile(botId, scope);
    const incoming = body?.mcpServers && typeof body.mcpServers === "object" ? body.mcpServers : null;
    if (!incoming) throw ferr(400, "invalid_field", "body 需要 mcpServers 对象");
    let doc = { $schema: "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json", mcpServers: {} };
    if (existsSync(path)) {
      try { doc = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw ferr(409, "mcp_config_invalid", "已有 MCP 配置无法解析，保留原件并拒绝覆盖"); }
    }
    const servers = { ...(doc.mcpServers || {}) };
    for (const [name, cfg] of Object.entries(incoming)) servers[name] = validateMcpServer(name, cfg);
    doc.mcpServers = servers;
    if (Array.isArray(body.disabledServers)) doc.disabledServers = body.disabledServers.map(String);
    if (Array.isArray(body.enabledServers)) doc.enabledServers = body.enabledServers.map(String);

    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2));
    renameSync(tmp, path);

    // 不自己发 bot_restart_requested：restartBotRuntimes 内部已经发过同一动作的事件。
    let restart = { restarted: false, blocked: null, unsupported: true };
    if (typeof this.orch.restartBotRuntimes === "function") {
      restart = await this.orch.restartBotRuntimes(botId, { reason: "mcp-config" });
    }
    const restarted = restart?.restarted === true;
    this.orch.emit?.("bot_mcp_updated", { botId, scope, names: Object.keys(servers), restarted, blocked: restart?.blocked ?? null });
    return {
      ...this.mcpStatus(botId, scope),
      restartRequired: !restarted,
      restart,
      applies: restarted ? "now" : "after-running-turn-ends",
    };
  }

  // ---------------- Skills（共享库 + 私有技能 + 每 bot 白名单） ----------------

  /** Bot 的私有技能（team/bots/<id>/.omp/skills/<name>/SKILL.md），总是加载。 */
  localSkills(botId, scope = "private") {
    const { skillsDir } = this.paths(botId, scope);
    return listSkills(skillsDir).map((s) => ({ ...s, source: "bot-project" }));
  }

  /** 共享库（team/skills/<name>/SKILL.md），按 bot.skills 白名单加载。 */
  librarySkills() {
    return listSkills(join(teamPaths(this.home, "_").teamRoot, "skills")).map((s) => ({ ...s, source: "team-library" }));
  }

  /** 原生过滤 glob（与 --skills 的语义一致；这里只做匹配展示，不复制注册表）。 */
  static matchFilter(globs, name) {
    if (!Array.isArray(globs) || globs.length === 0) return true;
    return globs.some((g) => {
      const pattern = String(g).trim();
      if (!pattern) return false;
      const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
      return rx.test(name);
    });
  }

  /**
   * 技能状态。filter 为 null 表示库里全部；为列表时只加载列表里的库技能。私有技能总是加载。
   * 共享库里没写 description 的技能 omp 不加载，这里如实标出来。
   */
  async skillsStatus(botId, scope = "private", commands = null) {
    const bot = this.#requireBot(botId);
    const mine = this.localSkills(botId, scope).map((s) => ({ ...s, selected: true, loadable: true, always: true }));
    const filter = Array.isArray(bot.skills) ? bot.skills : null;
    const library = this.librarySkills().map((s) => {
      const selected = filter === null || (filter.length > 0 && NativeFeatures.matchFilter(filter, s.name));
      return { ...s, selected, loadable: Boolean(s.description) };
    });
    const skillCommands = Array.isArray(commands)
      ? commands.filter((c) => typeof c === "string" && c.includes("skill"))
      : null;
    const effective = [...library.filter((s) => s.selected && s.loadable), ...mine].map((s) => s.name);
    return {
      nativeSource: "team/skills 共享库 + Bot 私有 .omp/skills + get_available_commands",
      commands: skillCommands,
      filter,
      library,
      private: mine,
      discovered: [...library, ...mine],
      effective: [...new Set(effective)].sort((a, b) => a.localeCompare(b)),
      libraryDir: join(teamPaths(this.home, botId).teamRoot, "skills"),
      privateDir: this.paths(botId, scope).skillsDir,
      note: "共享库按白名单加载，私有技能总是加载；真实装载由 OMP 原生 skills.customDirectories 与 --skills 完成。",
    };
  }

  /** 更新 Bot 的库技能白名单（写花名册字段，由 CoreOwner 的策略签名触发 runtime 重建）。 */
  putSkills(botId, body = {}) {
    this.#requireBot(botId);
    const raw = body?.skills;
    if (raw !== null && raw !== undefined && !Array.isArray(raw)) {
      throw ferr(400, "invalid_field", "skills 必须是字符串数组或 null");
    }
    const next = raw === null || raw === undefined ? null : raw.map((s) => String(s).trim()).filter(Boolean);
    const updated = this.orch.updateBot(botId, { skills: next });
    return { botId: updated?.id ?? botId, filter: updated?.skills ?? next, restartRequired: true };
  }

  /** 装技能：target=library 进共享库，target=bot 只给这个 bot。重名直接拒绝。 */
  installSkill(botId, body = {}) {
    this.#requireBot(botId);
    if (typeof this.orch.installSkill !== "function") throw ferr(501, "skill_install_unavailable", "当前编排器不支持装技能");
    return this.orch.installSkill({ ...body, botId });
  }

  // ---------------- 记忆（mnemopi，每个 bot 一个 bank，只读） ----------------

  /**
   * 记忆状态。库是 team/.memory/mnemopi.db，所有 bot 一个文件，按 bank（bot-<id>）分。
   * 这里只读：写入、遗忘都由 bot 自己在会话里做，omp-bot 不和 omp 进程抢着写同一个库。
   */
  memoryStatus(botId, scope = "private") {
    const bot = this.#requireBot(botId);
    const { memoryDbPath } = this.paths(botId, scope);
    const dbPath = memoryDbPath ?? teamPaths(this.home, botId, scope).memoryDbPath;
    const bank = memoryBank(botId);
    const enabled = bot.memoryEnabled === true;
    const read = readMemoryBank(dbPath, bank, 0);
    return {
      enabled,
      available: enabled,
      reasons: enabled ? [] : ["记忆没开。在设置里打开，bot 下次启动生效。"],
      backend: "mnemopi",
      scoping: "global",
      bank,
      dbPath,
      dbExists: read.exists,
      dbBytes: read.bytes,
      counts: read.counts,
      readError: read.error,
      embedding: { variant: MEMORY_EMBEDDING_VARIANT, model: EMBEDDING_MODELS[MEMORY_EMBEDDING_VARIANT] ?? null },
      modelRoles: bot.model ? { default: bot.model, smol: bot.model, memory: bot.model } : null,
      note: "私聊和群聊共用这一个记忆库。要它忘掉某件事，直接跟它说。",
    };
  }

  /** 状态加最近的记忆条目（新的在前）。没开记忆也能看库里留下的内容。 */
  memoryRead(botId, scope = "private") {
    const status = this.memoryStatus(botId, scope);
    const read = readMemoryBank(status.dbPath, status.bank, MEMORY_LIST_LIMIT);
    return { ...status, memories: read.memories, readError: read.error ?? status.readError };
  }

  // ---------------- Browser 接管（原生 browser Eval prelude，人工期间暂停 Bot） ----------------

  /** 该 Bot 生效的配置文件，按原生 settings.ts 层级：--config overlay > 项目。全局层是用户自己的 agentDir，这里不读。 */
  browserConfigPaths(botId, scope = "private") {
    const { cwd, baseDir } = this.paths(botId, scope);
    return [
      { path: join(baseDir, "isolate.yml"), scope: "overlay-config" },
      { path: join(cwd, ".omp", "config.yml"), scope: "project-config" },
    ];
  }

  /**
   * 读 Bot 生效的 browser 相关设置（只读原生配置文件，不复制设置系统）。
   * 按原生层级 overlay > project > global，取最高优先级的显式 `browser.enabled`；缺失写 unknown。
   * 全局层是用户自己的 agentDir，本接口不读用户级文件，只如实标注该层未纳入判定。
   */
  browserSettings(botId, scope = "private") {
    const layers = this.browserConfigPaths(botId, scope);
    const { baseDir } = this.paths(botId, scope);
    const files = {};
    let explicitAt = null;
    let explicitRaw = null;
    let explicitEnabled = null;
    let explicitSource = null;
    for (const layer of layers) {
      const block = browserConfigBlock(readText(layer.path, 40_000));
      if (block == null) continue;
      const entries = browserConfigEntries(block);
      files[pathKey(layer.path, baseDir)] = {
        scope: layer.scope,
        enabled: asBool(entries.get("enabled")),
        headless: asBool(entries.get("headless")),
        freezeOnTurnEnd: asBool(entries.get("freezeOnTurnEnd")),
        idleCloseSec: asNum(entries.get("idleCloseSec")),
      };
      if (explicitAt == null && entries.has("enabled")) {
        explicitAt = layer.path;
        explicitRaw = entries.get("enabled");
        explicitEnabled = asBool(explicitRaw);
        explicitSource = layer.scope;
      }
    }
    const globalLayer = "user-agent-dir-not-read";
    return {
      files,
      explicitEnabled,
      explicitRaw,
      explicitAt,
      source: explicitSource ?? (explicitAt == null ? "unknown" : "unparsed"),
      globalLayer,
      globalLayerNote:
        "全局层是用户自己的 agentDir（本接口不读用户级文件）；要在本 Bot 固定 browser 行为，请写 Bot 项目 .omp/config.yml。",
      note: "只读 Bot 的 overlay 和项目 .omp/config.yml；原生默认 browser.enabled=true。",
    };
  }

  /**
   * 原生 browser 能力探测（get_state 的 eval 工具描述是唯一实际的运行时证据）：
   * - eval 描述广告 `xd://eval/browser` → available；
   * - 读得到 eval 但描述没广告 → unavailable（配置 browser.enabled=false 或未装 prelude）；
   * - chat 档（--no-tools）没有 eval 工具 → unavailable；
   * - 读不到原生状态 → unknown，绝不假装可用。
   * @param {{rt:object|null,state:object|null,error:string|null}} [probe] 复用同一次原生读取，避免 TOCTOU
   * @returns {Promise<{state:'available'|'unavailable'|'unknown',evidence:string,reason:string,evalDescriptionHasBrowser:boolean|null,explicitEnabled:boolean|null}>}
   */
  async browserCapability(botId, scope = "private", probe = null) {
    const bot = this.#requireBot(botId);
    const explicitEnabled = this.browserSettings(botId, scope).explicitEnabled;
    const { rt, state, error } = probe ?? (await this.#browserNativeState(botId, scope));
    const evalTool = Array.isArray(state?.dumpTools) ? state.dumpTools.find((t) => t?.name === "eval") : null;
    const evalDescriptionHasBrowser = typeof evalTool?.description === "string" ? EVAL_BROWSER_ADVERTISED.test(evalTool.description) : null;
    const base = { evalDescriptionHasBrowser, explicitEnabled, executionMode: bot.executionMode ?? null, nativeError: error };
    // chat 档没有 eval 是启动参数决定的静态事实，优先于任何运行时读取。
    if (bot.executionMode === "chat") {
      return {
        state: "unavailable",
        evidence: "chat-mode",
        reason: "chat 受控读取档用 --no-tools 启动，会话里没有 eval 工具，也就没有 browser prelude",
        ...base,
      };
    }
    // 没有运行中的 runtime 时，任何「读到的状态」都不是活会话，不能据此放行。
    if (!rt) {
      return {
        state: "unknown",
        evidence: "runtime-not-running",
        reason: "Bot 的 runtime 未启动，读不到活会话的 get_state；无法证明 browser 可用，先启动一个回合再接管",
        ...base,
      };
    }
    if (evalDescriptionHasBrowser === true) {
      return { state: "available", evidence: "eval-description", reason: "get_state 的 eval 工具描述广告了 `browser` prelude（xd://eval/browser）", ...base };
    }
    if (evalDescriptionHasBrowser === false) {
      return {
        state: "unavailable",
        evidence: "eval-description-absent",
        reason: explicitEnabled === false
          ? "配置显式 browser.enabled=false，eval 描述未广告 browser prelude"
          : "eval 描述未广告 browser prelude（原生 browser.enabled 默认 true；请核对 Bot 生效配置）",
        ...base,
      };
    }
    if (!state) {
      return {
        state: "unknown",
        evidence: error ? "native-state-error" : "native-state-empty",
        reason: error
          ? `读不到原生 get_state，无法证明 browser 可用：${error}`
          : "原生 get_state 为空（runtime 未真正启动或已停止），无法证明 browser 可用",
        ...base,
      };
    }
    if (!evalTool) {
      return {
        state: "unavailable",
        evidence: "eval-tool-absent",
        reason: "该会话的工具清单里没有 eval（--no-tools 或 eval 被禁用），browser prelude 只随 eval 存在",
        ...base,
      };
    }
    return {
      state: "unknown",
      evidence: "eval-description-missing",
      reason: "原生返回的 eval 工具没有描述文本，无法判定是否广告了 browser prelude",
      ...base,
    };
  }

  /** 一次原生状态读取（get_state 本身不拉进程，rt 只用于证据判定）。 */
  async #browserNativeState(botId, scope) {
    const rt = this.liveRuntime(botId, scope);
    const { state, error } = await this.#readNative(botId, scope);
    return { rt, state, error };
  }

  browserStatus(botId, scope = "private") {
    const { cwd } = this.paths(botId, scope);
    const key = `${botId}::${scope}`;
    const takeover = this.paused.get(key) ?? null;
    const rt = this.liveRuntime(botId, scope);
    return {
      native: "OMP browser Eval prelude（Chromium/CDP/relay；是 Eval 能力不是 AgentTool，也没有人工接管的原生 RPC 命令）",
      runtimeRunning: !!rt,
      paused: !!takeover,
      takeover: takeover ? clone(takeover) : null,
      pausedByState: this.isPaused(botId, scope),
      settings: this.browserSettings(botId, scope),
      computerPrelude: "OMP computer prelude 的 control.acquire 是「代理获得桌面控制权」，不是给人接管用，因此这里不用它。",
      humanUrl: null,
      publicSharing: "未实现：需要跨机/公网访问时必须由用户显式使用 OMP 原生 collab/share，本接口不会自动开启也不会暴露 URL。",
      howItWorks: [
        "前置：先让该 Bot 跑一个回合执行 eval `browser.open({name,headed:true,persist:true,url})` 打开可见窗口——headed 才看得见，persist 才不会被原生 settle 冻结；本接口不会替你开浏览器。",
        "接管 = 先要求该 Bot 当前空闲且原生 isSettled，随后暂停它的新回合；用户在 OMP 打开的可见窗口里自行操作。",
        "归还 = 复查原生 isSettled 与流状态，通过才解除暂停；原生未就绪时保留暂停并如实回报错误。",
        "本接口不向浏览器注入任何输入，也不新增浏览器引擎；窗口与标签页由原生 browser prelude 管理。",
        `Bot 工作目录：${cwd}`,
      ],
    };
  }

  /** 人类接管：暂停 Bot（不再受理新回合）。 */
  async browserTakeover(botId, scope = "private", body = {}) {
    this.#requireBot(botId);
    const key = `${botId}::${scope}`;
    // 一次原生读取同时用于能力判定与 settled 闸门，避免两次 get_state 之间的 TOCTOU。
    const probe = await this.#browserNativeState(botId, scope);
    const capability = await this.browserCapability(botId, scope, probe);
    if (capability.state !== "available") {
      const message =
        capability.state === "unavailable"
          ? `该 Bot 的原生 browser prelude 不可用（${capability.reason}），无法接管`
          : `无法确认该 Bot 的原生 browser prelude 可用（${capability.reason}），不接管`;
      throw ferr(409, capability.state === "unavailable" ? "browser_unavailable" : "browser_capability_unknown", message, { capability });
    }
    const { rt, state } = probe;
    if (rt) {
      if (state?.isStreaming === true || state?.hasPendingAsyncWork === true) {
        throw ferr(409, "bot_running", "Bot 正在运行，先停止/等它结束再接管");
      }
      if (state?.isSettled !== true) {
        throw ferr(409, "bot_not_settled", `原生会话未 settled（isSettled=${JSON.stringify(state?.isSettled ?? null)}），先等它稳定再接管`);
      }
    }
    if (this.orch.botRuntimeBusy?.(botId)) {
      throw ferr(409, "bot_running", "Bot 已接收运行，先停止/等它结束再接管");
    }
    if (this.paused.has(key)) throw ferr(409, "already_taken_over", "该 Bot 已处于人工接管中");
    const record = {
      id: `takeover_${botId}_${scope}`.replace(/[^A-Za-z0-9_:]/g, "_"),
      botId,
      scope,
      active: true,
      reason: String(body.reason ?? "").slice(0, 300),
      startedAt: Date.now(),
      endedAt: null,
      pausedRunTurns: true,
      capability: { state: capability.state, evidence: capability.evidence },
      nativeState: state ? { isSettled: state.isSettled, model: state.model ?? null } : null,
      humanUrl: null,
    };
    this.paused.set(key, record);
    if (this.orch.ledger) this.orch.ledger.put("settings", { id: record.id, kind: "browser-takeover", ...record });
    this.orch.emit?.("browser_takeover", { takeover: clone(record) });
    return clone(record);
  }

  /**
   * 归还：只有原生侧确实 settled 且没有在跑/排队的工作才解除暂停。
   * 读不到原生状态、仍在流式或未 settled 时保留暂停并抛错（不假称已归还）。
   */
  async browserRelease(botId, scope = "private") {
    const key = `${botId}::${scope}`;
    const record = this.paused.get(key);
    if (!record) throw ferr(409, "not_taken_over", "该 Bot 当前不在人工接管中");
    const { rt, state, error } = await this.#browserNativeState(botId, scope);
    if (rt && !state) {
      throw ferr(409, "native_state_unavailable", error ? `读不到原生状态，无法确认可安全归还：${error}` : "原生状态为空，无法确认可安全归还，保留人工接管", {
        takeover: clone(record),
      });
    }
    if (rt && (state.isStreaming === true || state.hasPendingAsyncWork === true || state.isSettled !== true)) {
      throw ferr(409, "bot_not_settled", "原生会话未 settled 或仍有工作，保留人工接管，等它稳定后再释放", {
        takeover: clone(record),
        nativeState: { isSettled: state.isSettled ?? null, isStreaming: state.isStreaming ?? null, hasPendingAsyncWork: state.hasPendingAsyncWork ?? null },
      });
    }
    const done = { ...record, active: false, endedAt: Date.now(), settledAtRelease: rt ? true : null, releaseReason: rt ? "native-settled" : "runtime-not-running", releasedAt: Date.now() };
    this.paused.delete(key);
    if (this.orch.ledger) this.orch.ledger.put("settings", { id: record.id, kind: "browser-takeover", ...done });
    this.orch.emit?.("browser_released", { takeover: clone(done) });
    return clone(done);
  }

  isPaused(botId, scope = "private") {
    return this.paused.has(`${botId}::${scope}`);
  }

  pausedList() {
    return [...this.paused.values()].map(clone);
  }
}

function pathKey(p, baseDir) {
  return p.startsWith(baseDir) ? p.slice(baseDir.length + 1) : p;
}

/**
 * 只读打开 mnemopi 库，数这个 bank 的条目，按需取最近几条。
 * 库还没建（记忆没开过、还没存过）不算错；表结构对不上或读失败如实写 error。
 * mnemopi 的 session_id 就是 bank 名，omp 写入时 scope 是 bank，所以按 session_id 过滤就只看到本 bot。
 */
function readMemoryBank(dbPath, bank, limit) {
  const out = { exists: false, bytes: 0, counts: { working: 0, episodic: 0 }, memories: [], error: null };
  try {
    out.bytes = lstatSync(dbPath).size;
    out.exists = true;
  } catch {
    return out;
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const rows = [];
    for (const [table, kind] of [["working_memory", "working"], ["episodic_memory", "episodic"]]) {
      if (!tables.has(table)) continue;
      out.counts[kind] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(bank)?.n ?? 0);
      if (limit > 0) {
        const list = db
          .prepare(
            `SELECT id, content, source, timestamp, created_at FROM ${table} WHERE session_id = ? AND superseded_by IS NULL ` +
              "ORDER BY COALESCE(timestamp, created_at) DESC LIMIT ?",
          )
          .all(bank, limit);
        for (const r of list) {
          const content = String(r.content ?? "");
          rows.push({
            id: String(r.id),
            kind,
            source: r.source ?? null,
            at: r.timestamp ?? r.created_at ?? null,
            content: content.length > MEMORY_CONTENT_CLIP ? `${content.slice(0, MEMORY_CONTENT_CLIP)}…` : content,
          });
        }
      }
    }
    rows.sort((x, y) => String(y.at ?? "").localeCompare(String(x.at ?? "")));
    out.memories = rows.slice(0, limit);
  } catch (e) {
    out.error = `读记忆库失败：${e?.message ?? String(e)}`;
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return out;
}
