// bot.mjs — BotRuntime：一个 omp RPC 子进程绑定一个会话上下文。
//
// 一个 bot 的私聊是一个 BotRuntime；它加入的每个群各是一个 BotRuntime
// （独立进程 + 独立 session-dir，天然无共享状态）。
//
// 本类只做三件事，不重复 OMP 的引擎：
// 1) 按 bot 策略拼原生启动参数（模式/审批档/工作区/技能/记忆），
// 2) 唯一的 RpcClient 持有者：真实帧 → 真实状态，
// 3) 原生命令的薄封装（prompt/abort/steer/settle/new_session/fork/UI 应答）。
//
// 状态机 stopped → starting → idle ⇄ busy → stopping → stopped。
// busy 只由 native prompt_result + 真实静默（session_settled / get_state.isSettled）
// 一起解除；prompt_result 本身只是「本次 yield」，不足以说明模型停了。
//
// 死锁防护：turn 进行中 busy=true，且贯穿整个嵌套 message_bot 调用链
// （A 调 B 时 A 的回合没结束，A.busy 一直为真）。编排器见目标 busy 即拒绝。

import { dirname, join, isAbsolute, resolve } from "node:path";
import { mkdirSync, readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import { RpcClient } from "./rpc-client.mjs";
import { writePersonaFiles } from "./persona.mjs";
import { policySignature } from "./domain.mjs";
import { contextDigest, memoryBank, skillArgs, teamPaths } from "./team.mjs";
import {
  RPC_STARTUP_TIMEOUT_MS,
  RPC_COMMAND_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  CANCEL_SETTLE_TIMEOUT_MS,
} from "./constants.mjs";

/** BotRuntime 的运行态状态机：stopped → starting → idle ⇄ busy → stopping → stopped */
export const RUNTIME_STATE = {
  STOPPED: "stopped",
  STARTING: "starting",
  IDLE: "idle",
  BUSY: "busy",
  STOPPING: "stopping",
};

// ---- 子进程环境：只放行模型路由/证书/代理确实需要的变量 ----
// 用户全局认证不被改写；AskHuman/飞书等共享后端变量、以及其余无关密钥不进 bot 进程。

const ENV_PASSTHROUGH = [
  "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "OS",
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "APPDATA",
  "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS",
  "USERNAME", "USER", "USERDOMAIN", "COMPUTERNAME", "SESSIONNAME", "SHELL",
  "LANG", "LC_ALL", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_TLS_REJECT_UNAUTHORIZED",
  "OMPBOT_HOME",
];

/** 模型/提供商凭据与路由：按前缀放行（认证本身留在用户配置里，这里只是转发）。 */
const ENV_PREFIX_ALLOW = [
  "ANTHROPIC_", "OPENAI_", "AZURE_", "GEMINI_", "GOOGLE_", "VERTEX_", "DEEPSEEK_",
  "OPENROUTER_", "GROQ_", "MISTRAL_", "XAI_", "MOONSHOT_", "QWEN_", "DASHSCOPE_",
  "SILICONFLOW_", "ZHIPU_", "TOGETHER_", "FIREWORKS_", "AWS_", "COPILOT_", "GITHUB_",
  "MAGPIE_", "PI_", "OMP_",
];

/** 明确排除：与本次运行无关的共享后端/业务凭据。 */
const ENV_DENY = /LARK|FEISHU|ASKHUMAN|OMPBOT_TOKEN|NODE_OPTIONS|npm_config_/i;

/** 从 process.env 里挑出最小可用环境（exactEnvironment=true 时它就是全部）。 */
export function buildRuntimeEnv() {
  const env = {};
  for (const k of ENV_PASSTHROUGH) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || ENV_DENY.test(k)) continue;
    if (ENV_PREFIX_ALLOW.some((p) => k.startsWith(p))) env[k] = v;
  }
  return env;
}

/**
 * 一个 bot 在某 scope 下的目录规则（BotRuntime 与编排器共用一份，来源是团队目录模块）。
 * @param {string} home
 * @param {string} botId
 * @param {string} scope
 */
export function runtimeDirs(home, botId, scope) {
  return teamPaths(home, botId, scope);
}

/** 用户当前 profile 的 agent 目录（默认 ~/.omp/agent，可被 PI_CODING_AGENT_DIR 重定位）。 */
function userAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
}

/** chat 档允许出现在原生工具面里的额外工具（--no-tools 不会移除的原生交互工具）。 */
const CHAT_ALLOWED_EXTRA_TOOLS = new Set(["ask"]);

/**
 * 从原生 get_state 的 model 字段取出规范模型标识。
 * 实测形状有两类：字符串（"commandcode-plan/deepseek/deepseek-v4.1-flash"，通常不带 provider）
 * 与对象 {id, provider}（provider 如 "magpie"）；provider 也可能与 model 同级。
 * 规范串统一成 `<provider>/<id>`，provider 已在 id 里则不重复加；取不到就返回 null，
 * 绝不用配置里的 Bot.model 冒充原生真值。
 * @returns {{model:string, provider:string|null}|null}
 */
export function canonicalNativeModel(state) {
  const raw = state?.model;
  let id = null;
  let provider = null;
  if (typeof raw === "string" && raw) {
    id = raw;
  } else if (raw && typeof raw === "object") {
    id = typeof raw.id === "string" && raw.id ? raw.id : typeof raw.model === "string" && raw.model ? raw.model : null;
    provider = typeof raw.provider === "string" && raw.provider ? raw.provider : null;
  }
  if (!provider && typeof state?.provider === "string" && state.provider) provider = state.provider;
  if (!id) return null;
  const model = provider && !id.startsWith(`${provider}/`) ? `${provider}/${id}` : id;
  return { model, provider: provider ?? null };
}

/**
 * 复用 get_state 的新鲜期：同一回合内的基线/收尾统计共用一次调用；
 * 模型切换只在 runtime 空闲时被接受，所以这里不需要每回合重新解析。
 */
const NATIVE_STATE_FRESH_MS = 5_000;

/**
 * chat 档的工具面判定：原生自报的工具名里，除受控宿主工具与原生交互工具（ask）之外，
 * 任何名字都算越界。实测证据：本版本忽略 SDK 选项，chat 会话里模型真的调用了项目 MCP 工具，
 * 所以这里用「原生自报工具面」而不是配置声明来判定，越界即拒绝运行。
 * @param {string[]|null} reported 原生自报的工具名
 * @param {string[]} allowedHostTools 本 runtime 注册的宿主工具名
 */
export function evaluateToolSurface(reported, allowedHostTools) {
  const allowed = new Set([...(allowedHostTools ?? []), ...CHAT_ALLOWED_EXTRA_TOOLS]);
  const names = Array.isArray(reported) ? reported : null;
  if (names === null) {
    return { verified: false, reported: null, allowed: [...allowed], violations: [] };
  }
  const violations = names.filter((n) => !allowed.has(n));
  return { verified: violations.length === 0, reported: names, allowed: [...allowed], violations };
}

/** 校验工作区：必须是已存在的真实目录（用户显式选择），不是凭空路径。 */
function assertWorkspace(workspace) {
  if (!workspace) return null;
  if (typeof workspace !== "string" || !isAbsolute(workspace)) {
    throw new Error(`工作区必须是绝对路径（用户显式选择的目录）: ${workspace}`);
  }
  const p = resolve(workspace);
  if (!existsSync(p) || !statSync(p).isDirectory()) {
    throw new Error(`工作区目录不存在: ${p}`);
  }
  return p;
}

export class BotRuntime extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.bot 花名册记录 {id,name,role,instructions,model,executionMode,approvalMode,workspace,...}
   * @param {string} opts.scope 该 runtime 的会话上下文标识，如 "private" 或 "room:<roomId>"
   * @param {string} opts.home orchestrator 数据根目录
   * @param {string} [opts.cwd] 工作区目录；默认 <home>/bots/<id>/<scope>/work
   * @param {string} [opts.bin] omp 可执行文件
   * @param {boolean} [opts.debug]
   * @param {Array<{name,label,description,parameters,handler}>} [opts.teamTools]
   *        orchestrator 注入的团队工具（message_bot / delegate_bot / list_bots）
   * @param {(text:string)=>void} [opts.onAssistantText] 每次回合结束的文本回调（供 relay 收集）
   */
  constructor(opts) {
    super();
    this.bot = opts.bot;
    this.scope = opts.scope;
    this.home = opts.home;
    this.bin = opts.bin ?? "omp";
    this.debug = opts.debug ?? false;
    this.teamToolsFactory = opts.teamToolsFactory ?? (() => []);
    this.onAssistantText = opts.onAssistantText ?? null;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? RPC_COMMAND_TIMEOUT_MS;

    // cwd 是 team/bots/<id>（私聊群聊共用），会话按 scope 分开；persona/overlay 等生成文件不进 team。
    this.dirs = runtimeDirs(this.home, this.bot.id, this.scope);
    this.baseDir = opts.dir ?? this.dirs.baseDir;
    this.sessionDir = opts.dir ? join(this.baseDir, "sessions") : this.dirs.sessionDir;
    this.cwd = opts.cwd ?? this.dirs.cwd;
    this.workDir = opts.cwd ? join(opts.cwd, "work") : this.dirs.workDir;
    this.skillsDir = join(this.cwd, ".omp", "skills");
    // 工作区是用户显式选的目录，通过 --add-dir 加入；bot 自己的 cwd 保持不变，
    // 这样身份、session 和原生项目配置都留在 bot 自己的目录里。
    this.workspace = assertWorkspace(this.bot.workspace ?? "");

    this.state = RUNTIME_STATE.STOPPED;
    this.rpc = null;
    this.startedAt = 0;
    this.lastError = null;
    this.sessionId = null;
    this.sessionFile = null;
    this.capabilities = null;
    this.policySignature = this._signature();
    // 当前回合由多少跳 message_bot 触发；0 = 用户直接发起。busy 守卫保证同一
    // runtime 同时只跑一个回合，故此实例态在回合内稳定（ALS 无法跨 stdout 事件传播）。
    this.deliveryDepth = 0;
    /** 当前回合的归属（orchestrator 设置）：{runId, abort:AbortController} */
    this.activeRun = null;
  }

  get busy() {
    return this.state === RUNTIME_STATE.BUSY;
  }

  get alive() {
    return this.state === RUNTIME_STATE.IDLE || this.state === RUNTIME_STATE.BUSY;
  }

  /**
   * 收窄档只有 chat（受控读取）：用 --no-tools/--no-extensions 关掉原生本机工具与扩展来源。
   * 绑定共享电脑是加法，本机工具、扩展、技能和 MCP 都保留，客机工具加在上面。
   */
  get narrowedTools() {
    return this.bot.executionMode === "chat";
  }

  /** 两层 AGENTS.md 和两处技能目录的摘要：变了签名就变，下一轮重启进程续上会话，新内容进系统提示词。 */
  _contextDigest() {
    return contextDigest({
      teamAgentsFile: this.dirs.teamAgentsFile,
      agentsFile: join(this.cwd, "AGENTS.md"),
      librarySkillsDir: this.dirs.librarySkillsDir,
      skillsDir: this.skillsDir,
    });
  }

  _signature() {
    return policySignature(this.bot, { cwd: this.cwd, scope: this.scope, contextDigest: this._contextDigest() });
  }

  /** 策略是否仍与当前 runtime 进程一致（不一致必须重建，不许宽进程收窄复用）。 */
  matchesPolicy(bot) {
    const next = policySignature(bot, { cwd: this.cwd, scope: this.scope, contextDigest: this._contextDigest() });
    return next === this.policySignature;
  }

  /**
   * 子进程环境：最小放行集。不再改 PI_CODING_AGENT_DIR，模型、凭据和用户 MCP 都走用户自己的 omp 配置；
   * 记忆库位置由 overlay 的 mnemopi.dbPath 指到 team/.memory。
   */
  buildEnv() {
    return buildRuntimeEnv();
  }

  /** 拼原生启动参数。收窄档（chat）用 --no-tools + --no-extensions 收窄工具来源。 */
  _buildArgs() {
    const { argv: personaArgv } = writePersonaFiles(this.bot, this.baseDir, {
      extraDisabledExtensions: this._narrowedDisabledExtensions(),
      librarySkillsDir: this.dirs.librarySkillsDir,
      memory: { dbPath: this.dirs.memoryDbPath, bank: memoryBank(this.bot.id) },
    });
    const mode = this.bot.executionMode === "chat" ? "rpc" : "rpc-ui";
    const args = ["--session-dir", this.sessionDir, ...personaArgv];
    if (mode === "rpc") args.push("--no-ui");
    if (this.bot.model) args.push("--model", this.bot.model);
    if (this.bot.thinking) args.push("--thinking", this.bot.thinking);
    if (this.workspace) args.push("--add-dir", this.workspace);
    if (this.narrowedTools) {
      // --no-tools：内置工具名表为空；--no-extensions：关闭扩展发现（真实 CLI 开关）。
      args.push("--no-tools", "--no-extensions");
    }
    // 白名单：null 不传（库里全部 + 私有）；列表并上私有技能传 --skills，并完为空传 --no-skills。
    args.push(...skillArgs(this.bot, { skillsDir: this.skillsDir }));
    if (mode === "rpc-ui") args.push("--approval-mode", this.bot.approvalMode ?? "write");
    const maxTimeMs = this.bot.budget?.maxTimeMs;
    if (typeof maxTimeMs === "number" && maxTimeMs > 0) {
      args.push("--max-time", String(Math.ceil(maxTimeMs / 1000)));
    }
    // 会话目录里已有历史会话 → 续上，实现跨重启记忆。
    if (this._hasPriorSession()) args.push("--continue");
    return { mode, args };
  }

  /** 启动子进程，注入人格与隔离 overlay，注册团队工具，记录原生能力。 */
  async start() {
    if (this.alive || this.state === RUNTIME_STATE.STARTING) return this;
    this.state = RUNTIME_STATE.STARTING;
    try {
      mkdirSync(this.cwd, { recursive: true });
      mkdirSync(this.workDir, { recursive: true });
      mkdirSync(this.sessionDir, { recursive: true });
      this.env = this.buildEnv();
      if (this.bot.memoryEnabled === true) mkdirSync(dirname(this.dirs.memoryDbPath), { recursive: true });
      const { mode, args } = this._buildArgs();
      this.policySignature = this._signature();

      this.rpc = new RpcClient({
        bin: this.bin,
        cwd: this.cwd,
        args,
        mode,
        exactEnvironment: true,
        env: this.env,
        debug: this.debug,
        startupTimeoutMs: RPC_STARTUP_TIMEOUT_MS,
      });

      // 每帧原样上行：编排器据此产出 native_event / 审批 / 子代理投影。
      this.rpc.on("frame", (frame) => {
        if (frame?.type === "extension_ui_request") this.emit("ui_request", frame);
        this.emit("native_frame", frame);
      });
      // 进程意外退出 → 标记 stopped，记录错误。
      this.rpc.on("exit", (code, signal) => {
        if (this.state !== RUNTIME_STATE.STOPPED) {
          this.state = RUNTIME_STATE.STOPPED;
          this.lastError = `rpc exited code=${code} signal=${signal}`;
        }
        this.emit("native_exit", { code, signal });
      });

      await this.rpc.start();
      await this._probeCapabilities();

      // 注册团队工具（message_bot / delegate_bot 等）。工厂收到本 runtime，
      // handler 可闭包读它的 deliveryDepth，并接收 meta.signal 做级联取消。
      const teamTools = this.teamToolsFactory(this);
      this.hostToolNames = teamTools.map((t) => t.name);
      if (teamTools.length) {
        for (const t of teamTools) this.rpc.onHostTool(t.name, t.handler);
        await this.rpc.setHostTools(
          teamTools.map((t) => ({
            name: t.name,
            label: t.label,
            description: t.description,
            parameters: t.parameters,
          })),
        );
      }
      if (this.narrowedTools) await this._verifyNarrowedToolSurface();

      this.state = RUNTIME_STATE.IDLE;
      this.startedAt = Date.now();
      return this;
    } catch (e) {
      this.state = RUNTIME_STATE.STOPPED;
      this.lastError = e?.message ?? String(e);
      await this._reap();
      throw e;
    }
  }

  /** 启动能力探测：缺哪项原生能力就记下来，调用时给出真实错误而不是静默降级。 */
  async _probeCapabilities() {
    const caps = {
      protocolVersion: this.rpc.protocolVersion ?? 1,
      // 未在本机实测打包版本的 images 编码/大小/模型支持，这里如实写未知，不假装可用。
      promptImages: null,
      extensionUi: typeof this.rpc.respondExtensionUI === "function",
      abort: typeof this.rpc.abort === "function",
      cancelSubagent: typeof this.rpc.cancelSubagent === "function",
      steer: typeof this.rpc.steer === "function",
      followUp: typeof this.rpc.followUp === "function",
      fork: typeof this.rpc.fork === "function",
      waitForSettled: typeof this.rpc.waitForSettled === "function",
      getSubagents: typeof this.rpc.getSubagents === "function",
    };
    try {
      const st = await this.rpc.getState();
      this.nativeState = st;
      this._nativeStateAt = Date.now();
      caps.isSettled = st?.isSettled;
      const modelMeta = canonicalNativeModel(st);
      caps.model = modelMeta?.model ?? null;
      caps.modelProvider = modelMeta?.provider ?? null;
      this.sessionId = st?.sessionId ?? this.sessionId;
      this.sessionFile = st?.sessionFile ?? this.sessionFile;
      // 记录原生自报的工具面（只留名字），供真实探针核对 chat/supervised 的边界；
      // 字段名随版本变化，取不到就写 null，不猜、不假装已验证。
      const reported = st?.dumpTools ?? st?.tools ?? st?.toolNames ?? null;
      caps.reportedToolSurface = Array.isArray(reported)
        ? reported.map((t) => (typeof t === "string" ? t : (t?.name ?? String(t)))).slice(0, 200)
        : null;
    } catch (e) {
      caps.stateError = e?.message ?? String(e);
    }
    this.capabilities = caps;
    this.emit("capabilities", caps);
    return caps;
  }

  _require(name, method) {
    if (typeof this.rpc?.[method] !== "function") {
      throw Object.assign(
        new Error(`当前 OMP 客户端缺少原生能力 ${name}（${method}），该操作不可用`),
        { status: 501, capability: name },
      );
    }
  }

  /**
   * 收窄档：把用户级 MCP 服务器按扩展 id（`mcp:<name>`）逐个关掉。
   * 原生只有按名字的 disabledServers/disabledExtensions，没有通配，也没有关掉用户级 MCP 的开关，
   * 所以这里读取（只读，不改）用户 agentDir 下的 mcp.json 服务器名，逐个列进 overlay。
   * 读取失败不假装成功：由运行时工具面校验兜底。
   * 项目级 MCP 由 persona overlay 的 mcp.enableProjectConfig:false 关闭（只在 chat 档）。
   */
  _narrowedDisabledExtensions() {
    if (!this.narrowedTools) return [];
    try {
      const file = join(userAgentDir(), "mcp.json");
      if (!existsSync(file)) return [];
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      const names = Object.keys(cfg?.mcpServers ?? {});
      return names.map((n) => `mcp:${n}`);
    } catch (e) {
      this.emit("native_error", { where: "read_user_mcp", error: e?.message ?? String(e) });
      return [];
    }
  }

  /**
   * chat 档的运行时校验（失败关闭）：
   * 注册完宿主工具后核对原生自报的工具面（实际 dumpTools），出现受控宿主工具之外的任何工具
   * 就把 runtime 标为不可用并拒绝运行回合，绝不因为「配置里写了收窄」就宣称安全。
   * 允许集合 = 本 runtime 注册的宿主工具 ∪ {ask}。chat 档没有客机工具。
   */
  async _verifyNarrowedToolSurface() {
    const kind = "chat";
    let reported = null;
    let error = null;
    try {
      const st = await this.rpc.getState();
      const raw = st?.dumpTools ?? st?.tools ?? st?.toolNames ?? null;
      reported = Array.isArray(raw)
        ? raw.map((t) => (typeof t === "string" ? t : (t?.name ?? String(t))))
        : null;
    } catch (e) {
      error = e?.message ?? String(e);
    }
    const verdict = evaluateToolSurface(reported, this.hostToolNames ?? []);
    this.toolSurface = { kind, ...verdict, ...(error ? { error } : {}) };
    this.capabilities = { ...(this.capabilities ?? {}), chatToolSurface: this.toolSurface };
    this.emit("capabilities", this.capabilities);
    if (!verdict.verified) {
      const label = "chat 档";
      this.blocked = {
        reason: reported === null ? "tool_surface_unverified" : "unsafe_tool_surface",
        kind,
        detail:
          reported === null
            ? `无法读取原生工具面${error ? `：${error}` : ""}，${label}按未验证处理`
            : `${label}出现未受控工具：${verdict.violations.join(", ")}`,
        tools: verdict.violations,
      };
      this.emit("tool_surface_blocked", this.blocked);
    }
    return this.toolSurface;
  }

  /** 清掉回合归属（供宿主在确认静默后调用，避免迟迟挂着旧的 runId）。 */
  _clearTurn() {
    this.deliveryDepth = 0;
    this.activeRun = null;
  }

  /**
   * 宿主侧确认原生真的静默后落回 idle。
   * 用途：prompt_result 只是 yield，若当时 settled=false 会把运行态留在 busy，
   * 之后 waitSettled 确认静默时必须显式转回 idle 并清掉回合归属，否则会出现
   * 「租约已放但 busy 仍为真」的假忙状态。
   */
  markSettled() {
    if (this.rpc && !this.rpc.closed) this.state = RUNTIME_STATE.IDLE;
    else this.state = RUNTIME_STATE.STOPPED;
    this._clearTurn();
    return this.state;
  }

  /**
   * 投递一条消息并等回合真正结束（native prompt_result + 真实静默）。
   * busy 期间拒绝（防死锁）。depth 记录触发本回合的 message_bot 跳数。
   * @returns {Promise<{text:string,status:string,settled:boolean}>}
   */
  async promptAndWait(text, { images, signal, timeoutMs = RUN_TIMEOUT_MS, admissionTimeoutMs, depth, runId } = {}) {
    if (this.blocked) {
      throw Object.assign(new Error(`bot ${this.bot.name} 拒绝运行：${this.blocked.detail}`), {
        status: 409,
        code: this.blocked.reason,
      });
    }
    if (!this.alive) await this.start();
    if (this.busy) {
      throw Object.assign(new Error(`bot ${this.bot.name} 正忙，无法接收新消息`), { status: 409 });
    }
    this.state = RUNTIME_STATE.BUSY;
    if (depth !== undefined) this.deliveryDepth = depth;
    this.activeRun = { runId: runId ?? null, abort: new AbortController() };
    // 外部 signal（父 Run 取消）级联到本回合。
    const onOuterAbort = () => this.activeRun?.abort.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) this.activeRun.abort.abort(signal.reason);
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }

    let res;
    try {
      res = await this.rpc.promptAndWait(text, {
        images,
        signal: this.activeRun.abort.signal,
        timeoutMs,
        admissionTimeoutMs,
      });
    } catch (e) {
      // 超时/取消的路径由 RpcClient 负责真正确认停止后再 reject，这里如实上报，
      // 并区分三种真实结局：已静默（idle）、进程已回收（stopped）、仍在跑（busy）。
      const settledFromError = e?.settled === true;
      const reaped = e?.killed === true || this.rpc?.closed === true;
      this.state = settledFromError
        ? RUNTIME_STATE.IDLE
        : reaped
          ? RUNTIME_STATE.STOPPED
          : RUNTIME_STATE.BUSY;
      if (this.state !== RUNTIME_STATE.BUSY) this._clearTurn();
      throw e;
    } finally {
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    }

    // prompt_result 只是 yield；不静默就不算停：只有确认静默才放开 scope 租约。
    let settled = res.settled === true;
    if (!settled && typeof this.rpc.waitForSettled === "function") {
      try {
        const s = await this.rpc.waitForSettled(CANCEL_SETTLE_TIMEOUT_MS);
        settled = s.settled === true;
      } catch {
        settled = false;
      }
    }

    let out = "";
    try {
      out = (await this.rpc.getLastAssistantText())?.text ?? "";
    } catch (e) {
      // 读最终文本失败必须可见：否则调用方会把「读不到」当成「回了空」。
      this.emit("native_error", {
        where: "get_last_assistant_text",
        error: e?.message ?? String(e),
      });
    }
    if (this.onAssistantText) this.onAssistantText(out);

    if (this.rpc && !this.rpc.closed) {
      this.state = settled ? RUNTIME_STATE.IDLE : RUNTIME_STATE.BUSY;
    } else {
      this.state = RUNTIME_STATE.STOPPED;
    }
    if (settled || this.state === RUNTIME_STATE.STOPPED) this._clearTurn();

    if (res.status === "error") {
      const msg = res.error?.message ?? res.error ?? "回合以错误结束";
      const err = new Error(`bot ${this.bot.name} 回合失败: ${msg}`);
      err.status = "error";
      err.settled = settled;
      err.nativeStatus = res.status;
      throw err;
    }
    return { text: out, status: res.status ?? "completed", settled, frame: res.frame ?? null };
  }

  /** 中途指令。behavior='steer' 改方向，'follow_up' 排到回合之后。 */
  async steer(text, { behavior = "steer", images } = {}) {
    if (behavior === "follow_up") {
      this._require("follow_up", "followUp");
      return this.rpc.followUp(text, { images });
    }
    this._require("steer", "steer");
    return this.rpc.steer(text, { images });
  }

  /** 原生中止。返回不代表已停止：调用方要等 waitSettled 才能宣称停住。 */
  async abort() {
    this._require("abort", "abort");
    return this.rpc.abort();
  }

  async abortBash() {
    if (typeof this.rpc?.abortBash === "function") return this.rpc.abortBash();
    return null;
  }

  async cancelSubagent(id) {
    if (typeof this.rpc?.cancelSubagent === "function") return this.rpc.cancelSubagent(id);
    return null;
  }

  /** 等真实静默；超时抛错（RpcClient 不把 agent_end 当静默）。 */
  async waitSettled({ timeoutMs = CANCEL_SETTLE_TIMEOUT_MS } = {}) {
    if (!this.rpc || this.rpc.closed) return { settled: true, source: "exit" };
    if (typeof this.rpc.waitForSettled !== "function") {
      // 老客户端没有这个方法：用 get_state 自行判定，拿不到就如实报未确认。
      try {
        const st = await this.rpc.getState();
        return { settled: st?.isSettled === true, source: "get_state", state: st };
      } catch (e) {
        return { settled: false, source: "unknown", stateError: e?.message ?? String(e) };
      }
    }
    return this.rpc.waitForSettled(timeoutMs);
  }

  /** 原生命令白名单校验后的调用（具体白名单由编排器给定）。 */
  async nativeCommand(command, { allowed, timeoutMs = this.commandTimeoutMs } = {}) {
    if (!this.rpc || this.rpc.closed) {
      throw Object.assign(new Error("bot 运行时未启动，无法执行原生命令"), { status: 503 });
    }
    if (this.busy) {
      throw Object.assign(new Error("运行中不接受原生会话命令，请先停止或取消当前 Run"), { status: 409 });
    }
    if (allowed && !allowed.has(command.type)) {
      throw Object.assign(
        new Error(`原生命令「${command.type}」不在允许集合内`),
        { status: 403 },
      );
    }
    return this.rpc.command(command, { timeoutMs });
  }

  async getNativeState() {
    if (!this.rpc || this.rpc.closed) return null;
    const st = await this.rpc.getState();
    this.nativeState = st;
    this._nativeStateAt = Date.now();
    return st;
  }

  async newSession(opts = {}) {
    this._require("new_session", "newSession");
    const out = await this.rpc.newSession(opts);
    const id = await this._refreshSessionIdentity();
    return { ...(out ?? {}), ...id };
  }

  async fork({ entryId } = {}) {
    this._require("fork", "fork");
    const out = await this.rpc.fork({ entryId });
    const id = await this._refreshSessionIdentity();
    return { ...(out ?? {}), ...id };
  }

  async branch(entryId) {
    this._require("branch", "branch");
    const out = await this.rpc.branch(entryId);
    const id = await this._refreshSessionIdentity();
    return { ...(out ?? {}), ...id };
  }

  async entries({ since } = {}) {
    this._require("session_entries", "getEntries");
    return this.rpc.getEntries({ since });
  }

  async subagents() {
    if (typeof this.rpc?.getSubagents !== "function") return null;
    return this.rpc.getSubagents();
  }

  async _refreshSessionIdentity() {
    try {
      const st = await this.rpc.getState();
      this.nativeState = st;
      this._nativeStateAt = Date.now();
      if (st?.sessionId) this.sessionId = st.sessionId;
      if (st?.sessionFile) this.sessionFile = st.sessionFile;
    } catch (e) {
      this.emit("native_error", { where: "get_state", error: e?.message ?? String(e) });
    }
    return { sessionId: this.sessionId, sessionFile: this.sessionFile };
  }

  /** 把工作台审批记录的原生应答回给 omp（原生再做一次方法级校验）。 */
  respondUi(nativeId, response) {
    this._require("extension_ui_response", "respondExtensionUI");
    if (!nativeId) throw new Error("respondUi 需要原生 request id");
    return this.rpc.respondExtensionUI({ id: nativeId, ...response });
  }

  async getStats() {
    if (!this.alive) return null;
    let stats = null;
    try {
      stats = await this.rpc.getSessionStats();
    } catch (e) {
      // 用量读不到会让预算核对失去依据，必须显式上报而不是静默当 0。
      this.emit("native_error", { where: "get_session_stats", error: e?.message ?? String(e) });
      return null;
    }
    if (!stats) return null;
    // get_session_stats 自己不带模型：补上原生 get_state 里的实际解析模型。
    // 绝不用 Bot.model 这种配置值冒充真值；取不到就保持 null。
    const meta = await this._nativeModelMeta();
    return { ...stats, ...meta };
  }

  /**
   * 原生实际解析到的模型标识（get_state 的 model 字段）。
   * 复用最近一次 get_state（同一回合内基线/收尾两次统计共用），超过新鲜期就真调一次。
   */
  async _nativeModelMeta() {
    const stale = !this.nativeState || Date.now() - this._nativeStateAt > NATIVE_STATE_FRESH_MS;
    let st = this.nativeState;
    if (stale) {
      try {
        st = await this.rpc.getState();
        this.nativeState = st;
        this._nativeStateAt = Date.now();
      } catch (e) {
        this.emit("native_error", { where: "get_state:model", error: e?.message ?? String(e) });
        return {};
      }
    }
    const meta = canonicalNativeModel(st);
    return meta ? { model: meta.model, provider: meta.provider } : {};
  }

  /** 停进程：先关 stdin，超时则回收，绝不留半死进程占着会话目录。 */
  async stop({ timeoutMs = 5_000 } = {}) {
    if (!this.rpc) {
      this.state = RUNTIME_STATE.STOPPED;
      return;
    }
    this.state = RUNTIME_STATE.STOPPING;
    const rpc = this.rpc;
    try {
      const done = await Promise.race([
        rpc.stop().then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
      if (!done) await this._reap();
    } catch (e) {
      this.emit("native_error", { where: "stop", error: e?.message ?? String(e) });
      await this._reap();
    }
    this.state = RUNTIME_STATE.STOPPED;
    this.activeRun = null;
  }

  async _reap() {
    try {
      if (this.rpc?.proc && !this.rpc.closed) this.rpc.proc.kill();
    } catch {
      // 进程已退出（ESRCH）等竞态：这里就是预期结果，无需上报。
    }
  }

  /** 会话目录里是否已有 .jsonl 会话文件（决定是否 --continue）。 */
  _hasPriorSession() {
    try {
      if (!existsSync(this.sessionDir)) return false;
      return readdirSync(this.sessionDir).some((f) => f.endsWith(".jsonl"));
    } catch {
      return false;
    }
  }
}
