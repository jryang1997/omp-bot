// features/native.mjs — 复用 OMP 原生能力的状态面：capabilities / MCP / skills / memory / browser 接管。
//
// 原则：能读原生状态就读原生状态（get_state、get_available_commands、配置文件、原生 reader），
// 不复制 skill registry、不建第二记忆后端、不发明原生没有的 API。读不到的字段如实写 unknown，
// 前置条件不满足时明确拒绝（4xx + 原因），而不是给假成功。

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { clone, ferr, humanBytes, isInsideRoot } from "./util.mjs";
import { memoryPrereqStatus } from "../memory-config.mjs";
import { buildRuntimeEnv } from "../bot.mjs";
import { COMPUTER_TOOL_NAMES } from "./computers.mjs";
import { computerIdFor, permissionOf } from "../domain.mjs";

/**
 * 记忆路径必须在 Bot 私有目录内，且链路上不能有符号链接/junction。
 * 逐级 lstat（不跟随）判定：stat/existsSync 会穿透 reparse point，Windows 上对 junction 内的路径
 * 还可能直接报 UNKNOWN，靠 existsSync 往上找「最近存在的祖先」会把 junction 整级跳过。
 */
function assertMemoryPath(root, target) {
  if (!lexicallyUnder(root, target)) throw ferr(403, "memory_out_of_bot", "记忆路径不在 Bot 私有目录内");
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
    throw ferr(403, "memory_out_of_bot", "记忆路径不在 Bot 私有目录内");
  }
  let current = root;
  for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    let st;
    try {
      st = lstatSync(current);
    } catch (e) {
      if (e?.code === "ENOENT") break; // 尾部还不存在：没有可借道的实体，后续 mkdir 会重建
      throw ferr(403, "memory_out_of_bot", `记忆路径无法安全校验（${e?.code ?? e?.message}）`);
    }
    if (st.isSymbolicLink()) throw ferr(403, "memory_out_of_bot", "记忆路径经过符号链接或超出 Bot 私有目录");
  }
}

const SERVER_NAME_RE = /^[A-Za-z0-9_.:-][A-Za-z0-9_.: -]{0,98}$/;
const SECRET_KEY_RE = /(token|secret|key|pass[\s_-]*word|authorization|cookie|credential)/i;
const MAX_MEMORY_FILE_BYTES = 64 * 1024;

/**
 * Bot 的私有路径（与 BotRuntime/runtimeDirs 同一规则）。
 * cwd 永远是 <baseDir>/work；用户选的 workspace 只用 --add-dir 加入，作为单独的允许读根返回，
 * 绝不当作 cwd（否则项目级 MCP 配置/技能发现/检查点会写到用户工作区，而原生进程读不到）。
 * @returns {{baseDir:string,workDir:string,sessionDir:string,agentDir:string,workspace:string|null}}
 */
export function botPaths(orch, home, botId, scope = "private") {
  const provided =
    typeof orch?.botWorkDir === "function" ? orch.botWorkDir(botId, scope) : typeof orch?.botPaths === "function" ? orch.botPaths(botId, scope) : null;
  if (provided?.baseDir && provided?.workDir) {
    return { agentDir: provided.agentDir ?? join(provided.baseDir, "agent"), ...provided };
  }
  const safeScope = String(scope).replace(/[^a-zA-Z0-9_-]/g, "_");
  const baseDir = join(home, "bots", botId, safeScope);
  const rt = orch?.runtimes?.get?.(`${botId}::${scope}`);
  const ws = orch?.getBot?.(botId)?.workspace;
  return {
    baseDir,
    workDir: rt?.cwd ?? join(baseDir, "work"),
    sessionDir: rt?.sessionDir ?? join(baseDir, "sessions"),
    agentDir: join(baseDir, "agent"),
    workspace: typeof ws === "string" && ws.trim() ? ws.trim() : null,
  };
}

/** 原生 memory 目录名（二进制证据：join(memoryRoot, `--${lower(projectKey)}` → `-`)). */
export function memorySlug(projectPath) {
  return `--${String(projectPath).toLowerCase().replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
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

/** 极简 frontmatter 读取（只取 name/description/enabled，不引依赖）。 */
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

export class NativeFeatures {
  /** @param {{orch:object, home:string, bin?:string}} deps */
  constructor({ orch, home, bin = "omp" }) {
    this.orch = orch;
    this.home = home;
    this.bin = bin;
    this.paused = new Map(); // `${botId}::${scope}` → takeover record
    this.memoryProbe = new Map(); // agentDir → {ok, error, at}
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
    const { workDir } = this.paths(botId, scope);
    return join(workDir, ".omp", "mcp.json");
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

  // ---------------- Skills（原生发现 + 过滤） ----------------

  /** Bot 私有项目里的原生 skill 目录（<work>/.omp/skills/<name>/SKILL.md）。 */
  localSkills(botId, scope = "private") {
    const { workDir } = this.paths(botId, scope);
    const root = join(workDir, ".omp", "skills");
    if (!existsSync(root)) return [];
    const out = [];
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const file = join(root, ent.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const fm = parseSkillFrontmatter(readText(file, 20_000) ?? "");
      out.push({
        name: fm.name || ent.name,
        description: fm.description ?? "",
        source: "bot-project",
        path: file,
        enabled: fm.enabled !== "false",
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
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

  async skillsStatus(botId, scope = "private", commands = null) {
    const bot = this.#requireBot(botId);
    const mine = this.localSkills(botId, scope);
    const filter = Array.isArray(bot.skills) ? bot.skills : null;
    const skillCommands = Array.isArray(commands)
      ? commands.filter((c) => typeof c === "string" && c.includes("skill"))
      : null;
    return {
      nativeSource: "get_available_commands + Bot 私有项目 skill 目录",
      commands: skillCommands,
      filter,
      discovered: mine.map((s) => ({ ...s, selected: NativeFeatures.matchFilter(filter, s.name) })),
      effective: mine.filter((s) => NativeFeatures.matchFilter(filter, s.name)).map((s) => s.name),
      note: "不复制 skill registry；真实装载仍由 OMP 原生 --skills / 发现流程完成。",
    };
  }

  /** 更新 Bot 的 skill 过滤（写花名册字段，由 CoreOwner 的策略签名触发 runtime 重建）。 */
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

  // ---------------- Memory（原生 local 后端，只管理 scoped 文件） ----------------

  memoryRootCandidates(botId, scope = "private") {
    const { agentDir, workDir } = this.paths(botId, scope);
    const key = memorySlug(workDir);
    const dir = join(agentDir, "memories", key);
    return [{ dir, key, source: existsSync(dir) ? "native-existing" : "derived-native-key" }];
  }

  /**
   * 无凭据模型来源的真实状态（与 CoreOwner 的 addBot/updateBot 门控同一处 helper）：
   * 私有 models.yml 里选定 provider 声明 auth: none + loopback（原生 keyless），
   * 或配置了带 token 的原生 auth broker。named profile 只换目录，不提供凭据，不算授权。
   */
  modelSource(botId, scope = "private") {
    const bot = this.#requireBot(botId);
    const { agentDir } = this.paths(botId, scope);
    const rt = this.liveRuntime(botId, scope);
    const status = memoryPrereqStatus({ model: bot.model, agentDir });
    const envAgentDir = rt?.rpc?.env?.PI_CODING_AGENT_DIR ?? null;
    const profileEnv = rt?.rpc?.env?.OMP_PROFILE ?? rt?.rpc?.env?.PI_PROFILE ?? null;
    return {
      ...status,
      runtimeAgentDir: envAgentDir,
      // 运行时若带 profile 变量，原生会把 agentDir 重定位到 profiles/<name>/agent，私有目录失效。
      runtimeProfile: profileEnv,
      runtimeIsolated: !!rt && envAgentDir === agentDir && !profileEnv,
    };
  }

  /**
   * 记忆状态。只有同时满足（私有 agentDir 在 Bot 目录内 + 选定模型在私有目录无凭据可用 +
   * runtime 已按该 env 起且没被 profile 顶掉）才 available；否则明确拒绝，绝不落到共享 agentDir。
   */
  memoryStatus(botId, scope = "private") {
    const bot = this.#requireBot(botId);
    const { agentDir, workDir } = this.paths(botId, scope);
    const isolated = isInsideRoot(join(this.home, "bots", botId), agentDir) || lexicallyUnder(join(this.home, "bots", botId), agentDir);
    const source = this.modelSource(botId, scope);
    const candidate = this.memoryRootCandidates(botId, scope)[0];
    const memoryFile = join(candidate.dir, "MEMORY.md");
    const learnedFile = join(candidate.dir, "learned.md");
    const stat = (p) => (existsSync(p) ? lstatSync(p).size : 0);

    const reasons = [];
    if (bot.memoryEnabled !== true) reasons.push("bot.memoryEnabled=false（未开启原生 local 记忆）");
    if (!isolated) reasons.push("私有 agentDir 不在 Bot 目录内");
    if (!source.ready) reasons.push(`缺少无凭据模型来源（${source.reason}）`);
    if (bot.memoryEnabled === true && !source.runtimeIsolated) {
      reasons.push(
        source.runtimeProfile
          ? `runtime 带 profile 变量（${source.runtimeProfile}），原生会把 agentDir 重定位到 profiles/<name>/agent`
          : "runtime 未以私有 PI_CODING_AGENT_DIR 启动（请在 Bot 启动前生效）",
      );
    }

    return {
      enabled: bot.memoryEnabled === true,
      available: reasons.length === 0,
      reasons,
      backend: "native-local",
      root: candidate.dir,
      rootSource: candidate.source,
      isolation: { agentDir, workDir, insideBotHome: isolated, runtimeEnvMatch: source.runtimeIsolated },
      files: {
        "MEMORY.md": { exists: existsSync(memoryFile), bytes: stat(memoryFile), path: memoryFile },
        "learned.md": { exists: existsSync(learnedFile), bytes: stat(learnedFile), path: learnedFile },
      },
      nativeClear: "disabled",
      nativeClearReason:
        "原生 /memory clear 会删除整个共享 jobs/threads/stage1 表，因此本接口不调用它；清理只截断本 Bot 私有目录里的两个文件。",
      nativePrereq: {
        ready: source.ready,
        source: source.source,
        reason: source.reason,
        model: source.model,
        provider: source.provider,
        modelId: source.modelId,
        auth: source.auth,
        endpoint: source.endpoint,
        loopback: source.loopback,
        broker: source.broker,
        providerSource: source.providerSource,
        runtimeIsolated: source.runtimeIsolated,
        files: source.files,
        enforcingGate: "addBot/updateBot 与 runtime 启动共用 memoryPrereqStatus；不满足即 memory_prereq_missing",
      },
      capabilities: this.memoryProbe.get(agentDir) ?? null,
      howTo: reasons.length
        ? [
            "给 Bot 显式选择本机 keyless 模型：<provider>/<model-id>（provider 在 models.yml 里声明 auth: none 且 baseUrl 指向 loopback）。",
            "或配置带 token 的原生 auth broker（OMP_AUTH_BROKER_URL + OMP_AUTH_BROKER_TOKEN / <configRoot>/auth-broker.token）。",
            "Bot 启动时由 runtime 写私有 models.yml 并设 PI_CODING_AGENT_DIR=<bot>/agent；本接口不会替你改全局认证。",
          ]
        : [],
    };
  }

  /** 用原生 reader 验证「我们算出来的目录」与 OMP 实际解析的是同一个（一次性、带缓存）。 */
  async verifyMemoryPath(botId, scope = "private") {
    const status = this.memoryStatus(botId, scope);
    if (!status.available) throw ferr(409, "memory_unavailable", "先启动已开启私有记忆的 Bot 再验证目录", { memory: status });
    const { agentDir, workDir } = this.paths(botId, scope);
    const cached = this.memoryProbe.get(agentDir);
    if (cached?.ok) return cached;
    const candidate = this.memoryRootCandidates(botId, scope)[0];
    const name = `.ompbot-probe-${randomUUID()}.txt`;
    const probePath = join(candidate.dir, name);
    const root = this.paths(botId, scope).baseDir;
    assertMemoryPath(root, probePath);
    mkdirSync(candidate.dir, { recursive: true });
    const marker = randomUUID();
    writeFileSync(probePath, marker, { flag: "wx" });
    const env = { ...buildRuntimeEnv(), PI_CODING_AGENT_DIR: agentDir };
    delete env.OMP_PROFILE;
    delete env.PI_PROFILE;
    let out;
    try {
      out = await new Promise(resolve => execFile(this.bin, ["read", `memory://root/${name}`], {
        cwd: workDir, env, timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })));
    } finally {
      rmSync(probePath, { force: true });
    }
    const result = { ok: out.code === 0 && out.stdout.includes(marker), at: Date.now(), source: "native-reader-memory://root", dir: candidate.dir };
    if (!result.ok) result.error = (out.stderr || out.stdout || `exit ${out.code}`).slice(0, 400).trim();
    this.memoryProbe.set(agentDir, result);
    return result;
  }

  memoryRead(botId, scope = "private") {
    const status = this.memoryStatus(botId, scope);
    if (!status.available) {
      throw ferr(409, "memory_unavailable", `原生 local 记忆不可用：${status.reasons.join("；")}`, { memory: status });
    }
    const read = (f) => {
      const p = status.files[f].path;
      assertMemoryPath(this.paths(botId, scope).baseDir, p);
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    };
    return {
      ...status,
      content: { "MEMORY.md": read("MEMORY.md"), "learned.md": read("learned.md") },
    };
  }

  memoryWrite(botId, scope, body = {}) {
    const status = this.memoryStatus(botId, scope);
    if (!status.available) {
      throw ferr(409, "memory_unavailable", `原生 local 记忆不可用：${status.reasons.join("；")}`, { memory: status });
    }
    const file = String(body.file ?? "MEMORY.md");
    if (file !== "MEMORY.md" && file !== "learned.md") {
      throw ferr(400, "invalid_field", "只管理 MEMORY.md 与 learned.md");
    }
    const content = typeof body.content === "string" ? body.content : "";
    if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_FILE_BYTES) {
      throw ferr(413, "memory_too_large", `内容超过 ${humanBytes(MAX_MEMORY_FILE_BYTES)}`);
    }
    const path = status.files[file].path;
    assertMemoryPath(this.paths(botId, scope).baseDir, path);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${randomUUID()}`;
    try {
      writeFileSync(tmp, content, { flag: "wx" });
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
    this.orch.emit?.("bot_memory_updated", { botId, scope, file, bytes: Buffer.byteLength(content, "utf8") });
    return this.memoryStatus(botId, scope);
  }

  /** 清理：只截断 Bot 私有目录里的文件；不调原生 /memory clear（它会删共享表）。 */
  memoryClear(botId, scope = "private") {
    const status = this.memoryStatus(botId, scope);
    if (!status.available) {
      throw ferr(409, "memory_unavailable", `原生 local 记忆不可用：${status.reasons.join("；")}`, { memory: status });
    }
    const backupRoot = join(this.home, "checkpoints", "memory-backups", botId);
    const cleared = [];
    for (const file of ["MEMORY.md", "learned.md"]) {
      const path = status.files[file].path;
      // 先做路径围栏再判存在：existsSync 会穿过 junction，先跳过就把逃逸路径静默当成「没有这个文件」。
      assertMemoryPath(this.paths(botId, scope).baseDir, path);
      if (!existsSync(path)) continue;
      mkdirSync(backupRoot, { recursive: true });
      const backup = join(backupRoot, `${file}.${Date.now()}.bak`);
      writeFileSync(backup, readFileSync(path));
      writeFileSync(path, "");
      cleared.push({ file, backup, at: Date.now() });
    }
    this.orch.emit?.("bot_memory_cleared", { botId, scope, cleared: cleared.map((c) => c.file) });
    return { ...this.memoryStatus(botId, scope), cleared };
  }

  // ---------------- Browser 接管（原生 browser Eval prelude，人工期间暂停 Bot） ----------------

  /** 该 Bot 生效的配置文件，按原生 settings.ts 层级：--config overlay > 项目 > 全局 agentDir。 */
  browserConfigPaths(botId, scope = "private") {
    const { workDir, agentDir, baseDir } = this.paths(botId, scope);
    return [
      { path: join(baseDir, "isolate.yml"), scope: "overlay-config" },
      { path: join(workDir, ".omp", "config.yml"), scope: "project-config" },
      { path: join(agentDir, "config.yml"), scope: "global-config" },
    ];
  }

  /**
   * 读 Bot 生效的 browser 相关设置（只读原生配置文件，不复制设置系统）。
   * 按原生层级 overlay > project > global，取最高优先级的显式 `browser.enabled`；缺失写 unknown。
   * 若 runtime 没有把 agentDir 钉到 Bot 私有目录，原生读的全局层是用户自己的 agentDir，
   * 本接口不读用户级文件，只如实标注该层未纳入判定。
   */
  browserSettings(botId, scope = "private") {
    const layers = this.browserConfigPaths(botId, scope);
    const { baseDir, agentDir } = this.paths(botId, scope);
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
    const envAgentDir = this.liveRuntime(botId, scope)?.rpc?.env?.PI_CODING_AGENT_DIR ?? null;
    const globalLayer = envAgentDir === agentDir ? "bot-private-agent-dir" : "user-agent-dir-not-read";
    return {
      files,
      explicitEnabled,
      explicitRaw,
      explicitAt,
      source: explicitSource ?? (explicitAt == null ? "unknown" : "unparsed"),
      globalLayer,
      globalLayerNote:
        globalLayer === "bot-private-agent-dir"
          ? "runtime 已把 PI_CODING_AGENT_DIR 钉到 Bot 私有 agentDir，全局层已按该目录读取。"
          : "runtime 未钉私有 agentDir，原生读的是用户自己的 agentDir（本接口不读用户级文件）；要在本 Bot 固定 browser 行为，请写 Bot 私有项目 .omp/config.yml。",
      note: "只读 Bot 私有 overlay/项目 .omp/config.yml/私有 agentDir config.yml；原生默认 browser.enabled=true。",
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
    const { workDir } = this.paths(botId, scope);
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
        `Bot 工作目录：${workDir}`,
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

/** 词法范围检查（agentDir 可能还没建，故与 realpath 版互补）。 */
function lexicallyUnder(root, target) {
  const r = String(root).replace(/[\\/]+$/, "");
  const t = String(target);
  return t === r || t.startsWith(`${r}\\`) || t.startsWith(`${r}/`);
}
