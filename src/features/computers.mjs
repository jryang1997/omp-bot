// features/computers.mjs — 每个 Bot 的独立电脑：绑定、公共状态、电脑租约/代、HTTP、客机工具与文件交付。
//
// 边界（与 spec/实施合同一致）：
// - 绑定由服务端持有：bot.computer 只由本模块写；电脑 id 由 botId 派生，不接受客户端指定电脑、
//   地址、token 或宿主文件。模型工具的参数里没有 computerId/endpoint/token/localPath。
// - 客机（guest）路径允许，宿主路径只能由服务端决定：附件 id → 受控附件库真实路径；
//   成果 → 每 Run 专属 spool；写文本 → spool 中转。
// - 状态只来自真实观察：backend.status/screenshot/run 的真实结果；读不到就写 error/unknown，
//   绝不把缓存里的 running 当成事实。
// - 取消必须真正结束客机命令：backend 无法确认终态时抛 computer_effect_unknown，
//   这里把对应 Run 标成 reconciliation_required / side_effect_unknown，绝不假称 cancelled。

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { canonicalFilename, clone, ferr, humanBytes, isFeatureError } from "./util.mjs";
import { computerIdFor, genId } from "../domain.mjs";
import { COMPUTER_TOOL_NAMES } from "../constants.mjs";

export { COMPUTER_TOOL_NAMES };

/** 官方 Cua Linux 镜像的默认标识（绑定记录里的 image 字段；测试可用构造参数覆盖）。 */
export const DEFAULT_COMPUTER_IMAGE = "cua-linux";

/** 公开状态里允许出现的电脑状态（与合同一致；其余如实写 error，不发明新状态）。 */
const PUBLIC_STATES = new Set(["starting", "running", "stopping", "stopped", "error"]);

/** 共享电脑里每个 bot 是一个座席用户，`~` 是它自己的主目录。 */
const DEFAULT_GUEST_CWD = "~/work";
const ATTACHMENT_GUEST_DIR = "~/work/attachments";
/** remove 不删这几个路径本身。座席用户没有 sudo，系统目录本来就删不掉。 */
const UNREMOVABLE_GUEST_PATHS = ["/", "~", "~/work"];

const MAX_INSTALL_PACKAGES = 32;

const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
const MIN_SHELL_TIMEOUT_MS = 1_000;
const MAX_SHELL_TIMEOUT_MS = 300_000;
const MAX_SHELL_COMMAND_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 20_000;

const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
const MAX_LISTING_CHARS = 16_000;

const SCREENSHOT_TIMEOUT_MS = 30_000;
const INPUT_TIMEOUT_MS = 30_000;
const FILE_TIMEOUT_MS = 60_000;
const TAKEOVER_DRAIN_MS = 20_000;
/** 归还/停止等待在飞动作真正结束的上限：超时就拒绝转换并报告效果未知。 */
const CONTROL_DRAIN_MS = 10_000;

/** 有界等待（计时器保持 ref，race 结束后由调用方 cancel）。 */
function boundedWait(ms) {
  let timer = null;
  const promise = new Promise((resolveP) => {
    timer = setTimeout(() => resolveP("timeout"), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** 客机路径：绝对 POSIX 路径，或 `~`、`~/…`（座席用户的主目录）。 */
export function guestPath(raw, { label = "path" } = {}) {
  const s = String(raw ?? "").trim();
  if (!s) throw ferr(400, "invalid_field", `${label} 必填`);
  if (s.length > 500) throw ferr(400, "invalid_field", `${label} 超长（>500）`);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw ferr(400, "invalid_path", `${label} 含控制字符`);
  if (/^[A-Za-z]:/.test(s) || s.includes("\\")) {
    throw ferr(400, "invalid_path", `${label} 必须是客机绝对路径（宿主路径不被接受）：${s}`);
  }
  if (!s.startsWith("/") && s !== "~" && !s.startsWith("~/")) {
    throw ferr(400, "invalid_path", `${label} 必须是客机绝对路径（以 / 开头）或 ~/ 开头：${s}`);
  }
  if (s.split("/").some((seg) => seg === "..")) throw ferr(400, "invalid_path", `${label} 不能包含 ..`);
  return s.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}

/** 给 /bin/sh 用的路径：`~/rest` 写成 "$HOME"/'rest'，让座席用户自己的 shell 展开主目录。 */
export function shPath(path) {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"/${shQuote(path.slice(2))}`;
  return shQuote(path);
}

/** 单引号安全引用（客机 /bin/sh -lc 用）。 */
function shQuote(value) {
  const s = String(value ?? "");
  if (s.includes("\u0000")) throw ferr(400, "invalid_path", "路径含空字符");
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 输入动作归一化（HTTP /input 与 computer_input 共用一套校验）。 */
export function normalizeInputAction(raw = {}) {
  const action = String(raw?.action ?? "").trim();
  const num = (v, label) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw ferr(400, "invalid_field", `${label} 必须是有限数字`);
    return n;
  };
  if (action === "click") {
    return { action, x: num(raw.x, "x"), y: num(raw.y, "y"), button: raw.button === "right" ? "right" : "left" };
  }
  if (action === "move") return { action, x: num(raw.x, "x"), y: num(raw.y, "y") };
  if (action === "scroll") {
    return {
      action,
      deltaX: raw.deltaX === undefined ? 0 : num(raw.deltaX, "deltaX"),
      deltaY: num(raw.deltaY, "deltaY"),
    };
  }
  if (action === "type") {
    const text = typeof raw.text === "string" ? raw.text : "";
    if (!text) throw ferr(400, "invalid_field", "type 需要非空 text");
    if (text.length > 4_000) throw ferr(400, "invalid_field", "type 的 text 超长（>4000）");
    return { action, text };
  }
  if (action === "key") {
    const key = String(raw.key ?? "").trim();
    if (!key) throw ferr(400, "invalid_field", "key 必填");
    if (key.length > 64) throw ferr(400, "invalid_field", "key 超长");
    return { action, key };
  }
  throw ferr(400, "invalid_field", `未知输入动作：${JSON.stringify(raw?.action ?? null)}`);
}

/** 后端错误 → HTTP 语义错误；保留真实 code，绝不把未知失败说成成功。 */
const CONFLICT_CODES = new Set([
  "computer_effect_unknown",
  "computer_not_running",
  "computer_busy",
  "computer_not_created",
  "computer_guest_rpc_failed",
  "computer_transition_busy",
  "computer_reconciliation_required",
]);

/**
 * 「明确没有产生客机副作用」的失败码：只有这些才算已确认结束（可以放行归还/停止）。
 * 其余一切失败（含 computer_guest_rpc_failed、取消时断流的通用错误）都按效果未知处理：
 * 无法证明客机动作没在跑时，宁可让控制转换失败并报告，也不假装已经停住。
 */
const CONFIRMED_NO_EFFECT_CODES = new Set([
  // 服务端权威/准入类（在真正下发前就拒绝，客机没有收到任何东西）
  "computer_lease_missing",
  "computer_lease_lost",
  "computer_generation_stale",
  "computer_human_held",
  "computer_human_required",
  "computer_transition_busy",
  "computer_reconciliation_required",
  "computer_authority_missing",
  "computer_authority_invalid",
  "computer_lease_invalid",
  // 后端在产生副作用之前就失败
  "computer_invalid_argument",
  "computer_not_created",
  "computer_not_running",
  "computer_runtime_unavailable",
  "computer_start_failed",
  "computer_status_failed",
]);

function backendErr(e, fallback = {}) {
  if (isFeatureError(e)) return e;
  const code = typeof e?.code === "string" && e.code ? e.code : (fallback.code ?? "computer_backend_failed");
  const status = Number.isInteger(e?.status) && e.status >= 400 && e.status <= 599
    ? e.status
    : CONFLICT_CODES.has(code)
      ? 409
      : (fallback.status ?? 502);
  return ferr(status, code, e?.message ?? String(e), fallback.extra);
}

function truncate(text, max = MAX_OUTPUT_CHARS) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，共 ${s.length} 字符）` : s;
}

function describeAction(a) {
  return { id: a.id, kind: a.kind, runId: a.runId, startedAt: a.startedAt, outcome: a.outcome, error: a.error ?? null };
}

const SCREENSHOT_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["click", "move", "scroll", "type", "key"], description: "客机输入动作类型" },
    x: { type: "number", description: "click/move 的 X 像素坐标" },
    y: { type: "number", description: "click/move 的 Y 像素坐标" },
    button: { type: "string", enum: ["left", "right"], description: "click 的鼠标键，默认 left" },
    deltaX: { type: "number", description: "scroll 的水平滚动量，默认 0" },
    deltaY: { type: "number", description: "scroll 的垂直滚动量" },
    text: { type: "string", description: "type 要输入的文本" },
    key: { type: "string", description: "key 要按下的键名（如 Enter、ctrl+c）" },
  },
  required: ["action"],
  additionalProperties: false,
};

const SHELL_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "在客机 /bin/sh -lc 里执行的命令" },
    cwd: { type: "string", description: `客机工作目录，默认 ${DEFAULT_GUEST_CWD}` },
    timeoutMs: { type: "integer", description: `超时毫秒（默认 ${DEFAULT_SHELL_TIMEOUT_MS}，上限 ${MAX_SHELL_TIMEOUT_MS}）` },
  },
  required: ["command"],
  additionalProperties: false,
};

const FILES_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "read", "write", "remove"], description: "客机文件操作" },
    path: { type: "string", description: "客机路径：绝对路径，或 ~/ 开头（你自己的主目录）" },
    text: { type: "string", description: "write 要写入的 UTF-8 文本" },
    maxBytes: { type: "integer", description: `read 最多读取的字节数（默认 ${DEFAULT_READ_BYTES}，上限 ${MAX_READ_BYTES}）` },
  },
  required: ["action", "path"],
  additionalProperties: false,
};

const UPLOAD_SCHEMA = {
  type: "object",
  properties: {
    attachmentId: { type: "string", description: "本 Bot 附件库里已登记的附件 id" },
    path: { type: "string", description: `客机目标路径（默认 ${ATTACHMENT_GUEST_DIR}/<附件 id>-<文件名>）` },
  },
  required: ["attachmentId"],
  additionalProperties: false,
};

const INSTALL_SCHEMA = {
  type: "object",
  properties: {
    packages: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: MAX_INSTALL_PACKAGES,
      description: "要装的 Debian 包名，例如 [\"ffmpeg\", \"poppler-utils\"]",
    },
  },
  required: ["packages"],
  additionalProperties: false,
};

const PUBLISH_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "客机里要交付的文件绝对路径" },
    name: { type: "string", description: "可选显示文件名（默认取客机文件 basename）" },
  },
  required: ["path"],
  additionalProperties: false,
};

function publicMachine(spec) {
  return {
    cpus: spec.cpus,
    memoryGb: spec.memoryGb,
    diskGb: spec.diskGb,
    limits: { cpus: [...spec.limits.cpus], memoryGb: [...spec.limits.memoryGb] },
    appliesOn: "next_boot",
  };
}

/**
 * 共享目录的根（08）：用户名 workspace 是 team/workspace，bot id 是这个 bot 的 team/bots/<id>/work。
 * 不认识的用户名、已经删掉的 bot 返回 null，SFTP 服务就拒绝登录。
 */
export function seatShareRoots({ home, getBot, teamPaths, teamRoot }) {
  return (user) => {
    if (user === "workspace") return join(teamRoot(home), "workspace");
    return getBot(user) ? teamPaths(home, user).workDir : null;
  };
}

export class Computers {
  /**
   * @param {object} deps
   * @param {object} deps.orch 编排器（提供 ledger/getBot/updateBot/getRun/emit/features）
   * @param {string} deps.home 应用数据根
   * @param {object|Function} [deps.backend] 注入的 ComputerBackend 实例或工厂（测试/集成用）
   * @param {string} [deps.runtimeDir] 电脑运行时目录（默认交给 ComputerBackend 自己决定）
   * @param {string} [deps.image] 绑定记录里的镜像标识（默认官方 Cua Linux）
   */
  constructor({ orch, home, backend = null, runtimeDir = null, image = null } = {}) {
    if (!orch) throw new Error("Computers 需要 orch");
    this.orch = orch;
    this.home = home ?? orch.home;
    this.imageExplicit = typeof image === "string" && image.trim() !== "";
    this.image = this.imageExplicit ? image.trim() : DEFAULT_COMPUTER_IMAGE;
    this.runtimeDir = runtimeDir ?? null;

    this._backend = typeof backend === "function" ? backend({ home: this.home, runtimeDir: this.runtimeDir }) : backend;
    this._backendPromise = null;
    this._backendError = null;

    /** runId → {botId, computerId, scope, runId, generation, refs}：电脑粒度 agent 租约 */
    this.leases = new Map();
    /** computerId → Set<action>：在飞客机动作（接管/归还/停止要取消并等待它们） */
    this.actions = new Map();
    /** computerId → 控制状态 {generation, holder, runId, human, reconcile} */
    this.control = new Map();
    /**
     * computerId → 正在进行的控制转换（"takeover"|"release"|"stop"）。
     * 转换所有权在 await 真实状态/drain 之前同步取得：期间新的 agent 动作与人工输入一律拒绝，
     * 否则「接管快照时动作集为空 → 旧动作随后才真正下发」的窗口会把已失效的动作送进客机。
     */
    this.transitions = new Map();
    /** 重启时发现残留 agent 租约并作废的电脑（供事件/审计） */
    this.resetOnBoot = [];
    this.stateError = null;
    this._tagSeq = 0;

    this.#loadControl();
  }

  // ---------------- backend 生命周期 ----------------

  /** 已解析的 backend（未解析时为 null）；smoke/测试可直接读。 */
  get backend() {
    return this._backend ?? null;
  }

  /** 注入/替换 backend（测试与 smoke 用；生产默认是 ComputerBackend）。 */
  setBackend(backend) {
    this._backend = typeof backend === "function" ? backend({ home: this.home, runtimeDir: this.runtimeDir }) : backend;
    this._backendPromise = null;
    this._backendError = null;
    return this._backend;
  }

  /**
   * 解析并缓存 backend。默认是共享电脑的座席层 `createSharedComputer({home, runtimeDir?})`；
   * 模块或运行时资产缺失时抛 computer_runtime_unavailable（不静默退回宿主执行）。
   */
  async ensureBackend() {
    if (this._backend) return this._backend;
    if (!this._backendPromise) {
      this._backendPromise = (async () => {
        let mod;
        try {
          mod = await import("../computer-seats.mjs");
        } catch (e) {
          throw ferr(503, "computer_runtime_unavailable", `电脑运行时不可用（src/computer-seats.mjs 无法加载）：${e?.message ?? e}`);
        }
        if (typeof mod?.createSharedComputer !== "function") {
          throw ferr(503, "computer_runtime_unavailable", "电脑运行时不可用（computer-seats.mjs 没有导出 createSharedComputer）");
        }
        const { teamPaths, teamRoot } = await import("../team.mjs");
        const opts = {
          home: this.home,
          ...(this.runtimeDir ? { runtimeDir: this.runtimeDir } : {}),
          roots: seatShareRoots({ home: this.home, getBot: (id) => this.orch.getBot?.(id), teamPaths, teamRoot }),
          botIdFor: (computerId) => this.#botIdForComputer(computerId),
        };
        return mod.createSharedComputer(opts);
      })().catch((e) => {
        this._backendError = e?.message ?? String(e);
        this._backendPromise = null;
        throw e;
      });
    }
    this._backend = await this._backendPromise;
    return this._backend;
  }

  async close() {
    for (const [cid, set] of [...this.actions]) {
      for (const a of [...set]) {
        try {
          a.abort.abort(new Error("computers closing"));
        } catch {}
      }
      this.actions.delete(cid);
    }
    const backend = this._backend;
    this._backend = null;
    this._backendPromise = null;
    if (backend && typeof backend.close === "function") await backend.close();
  }

  // ---------------- 绑定与公共状态 ----------------

  computerIdFor(botId) {
    return computerIdFor(botId);
  }

  /** 座席的电脑 id 反查 bot id；不是 bot 的座席返回 null。 */
  #botIdForComputer(computerId) {
    for (const bot of this.orch.listBots?.() ?? []) {
      if (bot?.id && computerIdFor(bot.id) === computerId) return bot.id;
    }
    return null;
  }

  #requireBot(botId) {
    const id = String(botId ?? "").trim();
    if (!id) throw ferr(400, "invalid_field", "botId 必填");
    const bot = this.orch.getBot?.(id);
    if (!bot) throw ferr(404, "bot_not_found", `未知 Bot：${id}`);
    return bot;
  }

  #requireBound(bot) {
    if (!bot?.computer) {
      throw ferr(409, "computer_unbound", `Bot ${bot?.id ?? "?"} 未绑定电脑；先 POST /api/bots/<id>/computer/bind`);
    }
    return bot.computer;
  }

  #control(computerId, botId) {
    let ctrl = this.control.get(computerId);
    if (!ctrl) {
      ctrl = {
        computerId,
        botId,
        generation: 0,
        holder: null,
        runId: null,
        human: null,
        reconcile: null,
        updatedAt: Date.now(),
      };
      this.control.set(computerId, ctrl);
    }
    if (botId && !ctrl.botId) ctrl.botId = botId;
    return ctrl;
  }

  /**
   * 取得该电脑的控制转换所有权（同步、无 await）。已经在转换中就直接拒绝，
   * 避免两个控制操作（接管/归还/停止）互相穿插。
   * @returns {() => void} 释放函数（只释放自己持有的那一次）
   */
  #beginTransition(computerId, kind) {
    const current = this.transitions.get(computerId);
    if (current) {
      throw ferr(409, "computer_transition_busy", `该电脑正在执行 ${current}，拒绝并发控制操作`, { transition: current });
    }
    this.transitions.set(computerId, kind);
    return () => {
      if (this.transitions.get(computerId) === kind) this.transitions.delete(computerId);
    };
  }

  /** 该电脑正在进行的转换（没有则 null）。 */
  transitionOf(computerId) {
    return this.transitions.get(computerId) ?? null;
  }

  /**
   * 登记「客机副作用未知，必须人工核对后才能继续自动回合」。
   * 保留在控制状态里，并出现在公开状态的 error 字段；只有成功 stop（客机真的关掉）才清除。
   */
  #markReconcile(computerId, botId, { code = "computer_effect_unknown", kind = null, message } = {}) {
    const ctrl = this.#control(computerId, botId);
    const record = {
      code,
      kind,
      message: String(message ?? "客机动作未确认终止，需要人工核对"),
      at: Date.now(),
    };
    ctrl.reconcile = record;
    ctrl.updatedAt = Date.now();
    this.#persist(ctrl);
    this.orch.emit?.("computer_reconcile_required", { botId: ctrl.botId, computerId, ...record });
    return record;
  }

  #clearReconcile(computerId, botId, reason) {
    const ctrl = this.#control(computerId, botId);
    if (!ctrl.reconcile) return false;
    ctrl.lastReconcile = ctrl.reconcile;
    ctrl.reconcile = null;
    ctrl.updatedAt = Date.now();
    this.#persist(ctrl);
    this.orch.emit?.("computer_reconciled", { botId: ctrl.botId, computerId, reason, cleared: ctrl.lastReconcile });
    return true;
  }

  /** 从台账恢复控制状态；重启时残留的 agent 租约一律作废（代 +1，旧动作不可能重放）。 */
  #loadControl() {
    let rows = [];
    try {
      rows = this.orch.ledger?.list("settings", { limit: 1000 }) ?? [];
    } catch (e) {
      this.stateError = e?.message ?? String(e);
      return;
    }
    for (const rec of rows) {
      if (!rec || rec.kind !== "computer" || typeof rec.computerId !== "string" || !rec.computerId) continue;
      const ctrl = {
        computerId: rec.computerId,
        botId: typeof rec.botId === "string" ? rec.botId : null,
        generation: Number.isInteger(rec.generation) && rec.generation >= 0 ? rec.generation : 0,
        holder: rec.holder === "agent" || rec.holder === "human" ? rec.holder : null,
        runId: typeof rec.runId === "string" ? rec.runId : null,
        human: rec.human ?? null,
        reconcile: rec.reconcile && typeof rec.reconcile === "object" ? rec.reconcile : null,
        lastReconcile: rec.lastReconcile ?? null,
        updatedAt: Number.isFinite(rec.updatedAt) ? rec.updatedAt : Date.now(),
      };
      if (ctrl.holder === "agent") {
        // 内存里的租约随进程消失，但客机可能还在跑；这里不假装还持有，直接作废旧代。
        ctrl.holder = null;
        ctrl.runId = null;
        ctrl.generation += 1;
        ctrl.updatedAt = Date.now();
        this.#persist(ctrl);
        this.resetOnBoot.push(ctrl.computerId);
      }
      this.control.set(ctrl.computerId, ctrl);
    }
  }

  #persist(ctrl) {
    try {
      this.orch.ledger?.put("settings", { id: `computer_${ctrl.computerId}`, kind: "computer", ...clone(ctrl) });
      return true;
    } catch (e) {
      this.orch.emit?.("computer_state_persist_failed", { computerId: ctrl.computerId, error: e?.message ?? String(e) });
      return false;
    }
  }

  /** 共享电脑规格：存在 <home>/computers/shared-machine.json，下次开机生效。 */
  async sharedMachine() {
    const { readSharedMachine } = await import("../computer-seats.mjs");
    return publicMachine(readSharedMachine(this.home));
  }

  async setSharedMachine(body = {}) {
    const { writeSharedMachine } = await import("../computer-seats.mjs");
    try {
      return publicMachine(writeSharedMachine(this.home, { cpus: body?.cpus, memoryGb: body?.memoryGb }));
    } catch (e) {
      if (e?.code === "computer_invalid_argument") throw ferr(400, "invalid_field", e.message);
      throw e;
    }
  }

  /** 公开状态：绑定 + 真实后端观察 + 租约/代；不公开私有路径、端口、token。 */
  async status(botId) {
    const bot = this.#requireBot(botId);
    const binding = bot.computer ?? null;
    const cid = computerIdFor(bot.id);
    const ctrl = this.#control(cid, bot.id);
    const base = {
      bound: !!binding,
      id: binding ? cid : null,
      runtime: binding ? binding.runtime : null,
      kind: binding ? binding.kind : null,
      os: binding ? "linux" : null,
      state: binding ? "stopped" : "unbound",
      holder: binding ? ctrl.holder : null,
      generation: ctrl.generation,
      persistent: !!binding,
      display: null,
      error: null,
    };
    if (!binding) return base;
    let backend;
    try {
      backend = await this.ensureBackend();
    } catch (e) {
      return {
        ...base,
        state: "error",
        error: { code: e?.code ?? "computer_runtime_unavailable", message: e?.message ?? String(e) },
      };
    }
    try {
      const st = await backend.status(cid);
      const observed = st?.state;
      const display =
        st?.display && Number.isFinite(st.display.width) && Number.isFinite(st.display.height)
          ? { width: Math.trunc(st.display.width), height: Math.trunc(st.display.height) }
          : null;
      // 后端报 unbound = 这台电脑的私有记录/磁盘不存在（花名册却绑着）：如实报 error，
      // 不假装未绑定，也不假装 stopped。
      if (observed === "unbound") {
        return {
          ...base,
          state: "error",
          display,
          error: { code: "computer_not_created", message: "电脑绑定存在，但私有运行记录/磁盘不在；重新 bind 会幂等重建" },
        };
      }
      const state = PUBLIC_STATES.has(observed) ? observed : "error";
      const observedError = st?.error
        ? { code: st.error.code ?? "computer_error", message: st.error.message ?? String(st.error) }
        : PUBLIC_STATES.has(observed)
          ? null
          : { code: "computer_state_unknown", message: `后端返回了未定义状态：${JSON.stringify(observed ?? null)}` };
      return {
        ...base,
        state,
        display,
        // 座席层才有：共享电脑本身的状态，和这个座席是否就绪
        ...(st?.vm ? { vm: { state: String(st.vm.state ?? "unknown") } } : {}),
        ...(st?.seat ? { seat: { ready: st.seat.ready === true } } : {}),
        // 未核对的客机副作用优先于后端观察值：自动回合在核对前一直被拒绝。
        error: ctrl.reconcile
          ? { code: ctrl.reconcile.code ?? "computer_effect_unknown", message: ctrl.reconcile.message ?? "客机副作用未知，需要人工核对" }
          : observedError,
      };
    } catch (e) {
      const mapped = backendErr(e, { code: "computer_status_failed", status: 502 });
      return { ...base, state: "error", error: { code: mapped.code, message: mapped.message } };
    }
  }

  /**
   * 绑定记录里的镜像标识：显式注入的 label 优先；否则用后端实际使用的镜像文件 basename
   * （后端 imageFile 是 manifest 解析出的真实镜像路径），最后才退回产品默认 label。
   * 只描述「这台电脑用的哪张官方镜像」，不暴露任何宿主私有路径。
   */
  #imageLabel(backend) {
    if (this.imageExplicit) return this.image;
    const file = backend?.imageFile;
    if (typeof file === "string" && file.trim()) return basename(file);
    return this.image;
  }

  /** 绑定：创建（幂等）+ 写花名册 + 启动。缺 runtime 时显式 computer_runtime_unavailable。 */
  async bind(botId) {
    const bot = this.#requireBot(botId);
    const cid = computerIdFor(bot.id);
    let backend;
    try {
      backend = await this.ensureBackend();
    } catch (e) {
      throw ferr(503, "computer_runtime_unavailable", `电脑运行时不可用，无法绑定：${e?.message ?? e}`, { computerId: cid });
    }
    try {
      await backend.create(cid, {});
    } catch (e) {
      throw backendErr(e, { code: "computer_create_failed", status: 503 });
    }
    const binding = { runtime: "qemu", kind: "vm", image: this.#imageLabel(backend) };
    const current = bot.computer ?? null;
    if (!current || current.runtime !== binding.runtime || current.kind !== binding.kind || current.image !== binding.image) {
      this.orch.updateBot(bot.id, { computer: binding });
    }
    this.orch.emit?.("computer_bound", { botId: bot.id, computerId: cid, image: binding.image });
    return this.status(bot.id);
  }

  async start(botId) {
    const bot = this.#requireBot(botId);
    this.#requireBound(bot);
    const cid = computerIdFor(bot.id);
    const backend = await this.ensureBackend();
    try {
      await backend.start(cid);
    } catch (e) {
      throw backendErr(e, { code: "computer_start_failed", status: 503 });
    }
    this.orch.emit?.("computer_started", { botId: bot.id, computerId: cid });
    return this.status(bot.id);
  }

  /**
   * 停止：agent 租约在身时拒绝（否则会把运行中的回合留在效果未知态）。
   * 转换所有权在 await 之前同步取得；先取消并等待所有已准入的客机动作，无法确认终止就拒绝停止。
   * 人工接管中停止会结束人工控制会话并换代（旧输入永远拒绝）；成功停止后清除未核对标记
   * （客机真的关掉，未知动作不可能再继续）。
   */
  async stop(botId) {
    const bot = this.#requireBot(botId);
    this.#requireBound(bot);
    const cid = computerIdFor(bot.id);
    const endTransition = this.#beginTransition(cid, "stop");
    try {
      const ctrl = this.#control(cid, bot.id);
      if (ctrl.holder === "agent") {
        throw ferr(409, "computer_busy", `电脑正被运行中的回合占用（${ctrl.runId ?? "unknown"}），先取消该运行或等它结束`, {
          runId: ctrl.runId ?? null,
        });
      }
      const drained = await this.#drainActions(cid, { abort: true, timeoutMs: CONTROL_DRAIN_MS });
      if (drained.unknown.length || drained.timedOut.length) {
        if (drained.unknown.length) {
          this.#markReconcile(cid, bot.id, {
            kind: "stop_blocked",
            message: `停止前无法确认 ${drained.unknown.length} 个客机动作已终止`,
          });
        }
        throw ferr(
          409,
          "computer_effect_unknown",
          `无法确认客机动作已安全终止（未确认 ${drained.unknown.length} 个、超时 ${drained.timedOut.length} 个），拒绝停止`,
          { actions: { unknown: drained.unknown, timedOut: drained.timedOut } },
        );
      }
      if (ctrl.holder === "human") {
        const prev = clone(ctrl);
        ctrl.holder = null;
        ctrl.human = null;
        ctrl.runId = null;
        ctrl.generation += 1;
        ctrl.updatedAt = Date.now();
        if (!this.#persist(ctrl)) {
          Object.assign(ctrl, prev);
          throw ferr(503, "computer_state_unwritable", "电脑控制状态无法持久化，停止未生效");
        }
        this.orch.emit?.("computer_human_released", {
          botId: bot.id,
          computerId: cid,
          generation: ctrl.generation,
          reason: "computer-stop",
        });
      }
      const backend = await this.ensureBackend();
      try {
        await backend.stop(cid);
      } catch (e) {
        throw backendErr(e, { code: "computer_stop_failed", status: 503 });
      }
      this.#clearReconcile(cid, bot.id, "computer-stopped");
      this.orch.emit?.("computer_stopped", { botId: bot.id, computerId: cid });
      return this.status(bot.id);
    } finally {
      endTransition();
    }
  }

  // ---------------- 人工接管 / 归还 / 人工输入 ----------------

  isHumanHeld(botId) {
    const bot = this.orch.getBot?.(String(botId ?? ""));
    if (!bot?.computer) return false;
    const ctrl = this.control.get(computerIdFor(bot.id));
    return ctrl?.holder === "human";
  }

  generation(botId) {
    const bot = this.orch.getBot?.(String(botId ?? ""));
    if (!bot) return 0;
    return this.#control(computerIdFor(bot.id), bot.id).generation;
  }

  /**
   * 人工接管：使该电脑上所有 scope 的自动动作失效（代 +1），
   * 取消并等待现有客机动作；只要有一个无法确认终止就拒绝接管并报效果未知。
   * 转换所有权在 await 状态/drain 之前同步取得，期间新的自动动作与人工输入一律拒绝。
   */
  async takeover(botId) {
    const bot = this.#requireBot(botId);
    this.#requireBound(bot);
    const cid = computerIdFor(bot.id);
    const endTransition = this.#beginTransition(cid, "takeover");
    try {
      const ctrl = this.#control(cid, bot.id);
      if (ctrl.holder === "human") throw ferr(409, "already_taken_over", "该电脑已处于人工接管中");
      const status = await this.status(bot.id);
      if (status.state !== "running") {
        throw ferr(409, "computer_not_running", `电脑未运行（state=${status.state}），先启动再接管`, { computer: status });
      }
      const drained = await this.#drainActions(cid, { abort: true, timeoutMs: TAKEOVER_DRAIN_MS });
      if (drained.unknown.length || drained.timedOut.length) {
        throw ferr(
          409,
          "computer_effect_unknown",
          `无法确认客机动作已安全终止（未确认 ${drained.unknown.length} 个、超时 ${drained.timedOut.length} 个），拒绝接管`,
          { actions: { unknown: drained.unknown, timedOut: drained.timedOut } },
        );
      }
      const prev = clone(ctrl);
      ctrl.holder = "human";
      ctrl.runId = null;
      ctrl.human = { startedAt: Date.now() };
      ctrl.generation += 1;
      ctrl.updatedAt = Date.now();
      if (!this.#persist(ctrl)) {
        Object.assign(ctrl, prev);
        throw ferr(503, "computer_state_unwritable", "电脑控制状态无法持久化，接管未生效");
      }
      this.orch.emit?.("computer_takeover", { botId: bot.id, computerId: cid, generation: ctrl.generation, drained });
      return this.status(bot.id);
    } finally {
      endTransition();
    }
  }

  /**
   * 归还：只接受当前人工代；先取消并等待所有已准入的人工动作，无法确认终止就拒绝归还
   * （保留人工持有 + 公开 error，直到人工核对）；成功后再次换代，旧输入永远拒绝。
   */
  async release(botId, body = {}) {
    const bot = this.#requireBot(botId);
    this.#requireBound(bot);
    const cid = computerIdFor(bot.id);
    const endTransition = this.#beginTransition(cid, "release");
    try {
      const ctrl = this.#control(cid, bot.id);
      if (ctrl.holder !== "human") throw ferr(409, "not_taken_over", "该电脑当前不在人工接管中");
      const gen = Number(body?.generation);
      if (!Number.isInteger(gen) || gen !== ctrl.generation) {
        throw ferr(409, "computer_generation_stale", `归还必须带当前人工代（generation=${ctrl.generation}）`, {
          generation: ctrl.generation,
        });
      }
      const drained = await this.#drainActions(cid, { abort: true, timeoutMs: CONTROL_DRAIN_MS });
      if (drained.unknown.length || drained.timedOut.length) {
        if (drained.unknown.length) {
          this.#markReconcile(cid, bot.id, {
            kind: "release_blocked",
            message: `归还前无法确认 ${drained.unknown.length} 个客机动作已终止`,
          });
        }
        throw ferr(
          409,
          "computer_effect_unknown",
          `无法确认客机动作已安全终止（未确认 ${drained.unknown.length} 个、超时 ${drained.timedOut.length} 个），拒绝归还`,
          { actions: { unknown: drained.unknown, timedOut: drained.timedOut } },
        );
      }
      const prev = clone(ctrl);
      ctrl.holder = null;
      ctrl.runId = null;
      ctrl.human = null;
      ctrl.generation += 1;
      ctrl.updatedAt = Date.now();
      if (!this.#persist(ctrl)) {
        Object.assign(ctrl, prev);
        throw ferr(503, "computer_state_unwritable", "电脑控制状态无法持久化，归还未生效");
      }
      this.orch.emit?.("computer_release", {
        botId: bot.id,
        computerId: cid,
        generation: ctrl.generation,
        drained,
      });
      return this.status(bot.id);
    } finally {
      endTransition();
    }
  }

  /**
   * 人工输入：只有 human 持有当前代能成功；agent 期间/旧代/转换中一律 409。
   * 描述符绑定当时代，调用边界再校验一次；无法确认终态的人工输入留在公开 error 里，
   * 并阻止后续自动回合直到核对（成功 stop 客机后清除）。
   */
  async humanInput(botId, body = {}) {
    const bot = this.#requireBot(botId);
    this.#requireBound(bot);
    const cid = computerIdFor(bot.id);
    const ctrl = this.#control(cid, bot.id);
    const transition = this.transitions.get(cid);
    if (transition) {
      throw ferr(409, "computer_transition_busy", `该电脑正在执行 ${transition}，拒绝输入`, { transition });
    }
    if (ctrl.holder !== "human") {
      throw ferr(409, "computer_human_required", "该电脑不在人工接管中；自动回合期间不接受人工输入", {
        holder: ctrl.holder,
      });
    }
    const gen = Number(body?.generation);
    if (!Number.isInteger(gen) || gen !== ctrl.generation) {
      throw ferr(409, "computer_generation_stale", `输入必须带当前人工代（generation=${ctrl.generation}）`, {
        generation: ctrl.generation,
      });
    }
    const action = normalizeInputAction(body);
    const backend = await this.ensureBackend();
    const authority = { kind: "human", botId: bot.id, generation: gen, runId: null };
    try {
      await this.#withAction(
        { computerId: cid, botId: bot.id, runId: null, kind: "human_input", authority, signal: AbortSignal.timeout(INPUT_TIMEOUT_MS) },
        (signal) => backend.input(cid, action, { signal }),
      );
    } catch (e) {
      if (e?.effectUnknown) {
        this.#markReconcile(cid, bot.id, {
          kind: "human_input",
          message: `人工输入（${action.action}）未确认终止：${e?.message ?? String(e)}`,
        });
      }
      throw backendErr(e, { code: "computer_input_failed", status: 409 });
    }
    return this.status(bot.id);
  }

  /** 桌面 PNG：同源接口，已有鉴权有效；查看不会获得输入能力。 */
  async screen(botId, res) {
    const bot = this.#requireBot(botId);
    this.#requireBound(bot);
    const cid = computerIdFor(bot.id);
    const backend = await this.ensureBackend();
    let shot;
    try {
      shot = await backend.screenshot(cid, { signal: AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS) });
    } catch (e) {
      throw backendErr(e, { code: "computer_screenshot_failed", status: 409 });
    }
    const data = shot?.data;
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw ferr(502, "computer_screenshot_invalid", "截图没有返回 PNG 字节");
    }
    res.writeHead(200, {
      "Content-Type": shot.mimeType ?? "image/png",
      "Content-Length": data.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.end(data);
    return true;
  }

  // ---------------- 电脑租约（电脑×Run 粒度，覆盖整个回合与异步动作） ----------------

  /** 租约键：同一 Run 在同一台电脑上只算一个租约；不同电脑（群回合多成员）互不覆盖。 */
  #leaseKey(computerId, runId) {
    return `${computerId}::${runId}`;
  }

  #leaseFor(runId, computerId) {
    return runId && computerId ? this.leases.get(this.#leaseKey(computerId, runId)) ?? null : null;
  }

  /**
   * 取得该 Run 在这台电脑上的租约。同一台电脑跨 scope 只允许一个运行，忙就拒绝（不排队）。
   * 同一个 (电脑, runId) 重复取得只增加引用计数（回合内嵌套调用不会互相踢掉）。
   * chat 档没有客机工具，也就不需要电脑租约（绑定电脑不该让聊天依赖一台运行中的客机）。
   */
  acquireRunLease({ botId, scope = "private", runId } = {}) {
    const bot = this.#requireBot(botId);
    if (!bot.computer || bot.executionMode === "chat") return null;
    if (!runId) throw ferr(500, "computer_lease_invalid", "取得电脑租约需要 runId");
    const cid = computerIdFor(bot.id);
    const ctrl = this.#control(cid, bot.id);
    const key = this.#leaseKey(cid, runId);
    const existing = this.leases.get(key);
    if (existing) {
      if (this.transitions.has(cid) || ctrl.reconcile || ctrl.holder !== "agent" || ctrl.runId !== runId || existing.generation !== ctrl.generation) {
        throw ferr(409, "computer_lease_lost", "电脑租约已失效，拒绝继续自动回合");
      }
      existing.refs += 1;
      return existing;
    }
    const transition = this.transitions.get(cid);
    if (transition) {
      throw ferr(409, "computer_transition_busy", `该电脑正在执行 ${transition}，拒绝开始自动回合`, { transition });
    }
    if (ctrl.holder === "human") {
      throw ferr(409, "computer_human_held", `该电脑处于人工接管（generation=${ctrl.generation}），拒绝开始自动回合`);
    }
    if (ctrl.reconcile) {
      throw ferr(409, "computer_reconciliation_required", `上次客机副作用未核对，拒绝开始自动回合：${ctrl.reconcile.message}`, {
        reconcile: ctrl.reconcile,
      });
    }
    if (ctrl.holder === "agent" && ctrl.runId !== runId) {
      throw ferr(409, "computer_busy", `该电脑已有运行在跑（${ctrl.runId ?? "unknown"}），拒绝并发（跨 scope 也不排队）`, {
        runId: ctrl.runId ?? null,
      });
    }
    const lease = { botId: bot.id, computerId: cid, scope, runId, generation: ctrl.generation, refs: 1 };
    this.leases.set(key, lease);
    ctrl.holder = "agent";
    ctrl.runId = runId;
    ctrl.human = null;
    ctrl.updatedAt = Date.now();
    this.#persist(ctrl);
    this.orch.emit?.("computer_lease_acquired", { botId: bot.id, computerId: cid, runId, scope, generation: ctrl.generation });
    return lease;
  }

  /**
   * 释放该 Run 的全部电脑租约（幂等）：引用计数归零才真正让出，
   * 并停掉该 Run 残留的客机动作、清掉它的 spool。
   */
  releaseRunLease(runId) {
    const keys = runId ? [...this.leases.keys()].filter((k) => this.leases.get(k)?.runId === runId) : [];
    if (!keys.length) return false;
    let released = false;
    for (const key of keys) {
      const lease = this.leases.get(key);
      if (!lease) continue;
      lease.refs -= 1;
      if (lease.refs > 0) continue;
      this.leases.delete(key);
      released = true;
      const ctrl = this.#control(lease.computerId, lease.botId);
      if (ctrl.holder === "agent" && ctrl.runId === runId) {
        ctrl.holder = null;
        ctrl.runId = null;
        ctrl.updatedAt = Date.now();
        this.#persist(ctrl);
        this.orch.emit?.("computer_lease_released", {
          botId: lease.botId,
          computerId: lease.computerId,
          runId,
          generation: ctrl.generation,
        });
      }
      this.#cleanSpool(lease.computerId, runId);
    }
    this.#abortActionsFor(runId);
    return released;
  }

  /**
   * 权威校验（同步、绝不 await）：动作真正下发前的最后一道门。
   * - agent 动作要求本回合仍持有该电脑的当前代租约，且没有未核对的客机副作用；
   * - 人工动作要求 human 仍持有描述符里绑定的那一代；
   * - 该电脑正在做控制转换（接管/归还/停止）时，任何动作都失效。
   * 调用点必须紧邻真正的调用（中间不得有 await），否则接管落在等待里时旧动作仍会下发。
   */
  #assertAuthority({ authority, computerId }) {
    if (!authority || typeof authority !== "object") {
      throw ferr(500, "computer_authority_missing", "客机动作缺少权威描述符，拒绝执行");
    }
    const transition = this.transitions.get(computerId);
    if (transition) {
      throw ferr(409, "computer_transition_busy", `该电脑正在执行 ${transition}，动作已失效`, { transition });
    }
    const ctrl = this.#control(computerId, authority.botId ?? null);
    if (authority.kind === "agent") {
      if (ctrl.holder !== "agent" || ctrl.runId !== authority.runId) {
        throw ferr(409, "computer_lease_lost", `该电脑的租约已不在本回合（holder=${ctrl.holder ?? "none"}），动作已失效`);
      }
      const lease = this.#leaseFor(authority.runId, computerId);
      if (!lease) throw ferr(409, "computer_lease_missing", "本回合没有持有该电脑的租约，动作已失效");
      if (ctrl.generation !== authority.generation || lease.generation !== ctrl.generation) {
        throw ferr(409, "computer_generation_stale", `电脑代已变化（当前 ${ctrl.generation}，动作 ${authority.generation}），动作已失效`);
      }
      if (ctrl.reconcile) {
        throw ferr(409, "computer_reconciliation_required", `上次客机副作用未核对，自动动作拒绝：${ctrl.reconcile.message}`, {
          reconcile: ctrl.reconcile,
        });
      }
      return ctrl;
    }
    if (authority.kind === "human") {
      if (ctrl.holder !== "human") {
        throw ferr(409, "computer_human_required", "该电脑不在人工接管中，输入已失效");
      }
      if (ctrl.generation !== authority.generation) {
        throw ferr(409, "computer_generation_stale", `电脑代已变化（当前 ${ctrl.generation}，输入 ${authority.generation}），输入已失效`);
      }
      return ctrl;
    }
    throw ferr(500, "computer_authority_invalid", `未知权威类型：${JSON.stringify(authority.kind ?? null)}`);
  }

  /** 该 Run 是否仍持有该电脑的当前代租约（返回权威上下文，供动作描述符复用）。 */
  #assertAgentAction({ botId, runId }) {
    const bot = this.#requireBot(botId);
    this.#requireBound(bot);
    const cid = computerIdFor(bot.id);
    const authority = { kind: "agent", botId: bot.id, runId, generation: this.#control(cid, bot.id).generation };
    const ctrl = this.#assertAuthority({ authority, computerId: cid });
    return { computerId: cid, generation: ctrl.generation, runId, authority };
  }

  #abortActionsFor(runId) {
    for (const set of [...this.actions.values()]) {
      for (const a of [...set]) {
        if (a.runId !== runId) continue;
        try {
          a.abort.abort(new Error("run lease released"));
        } catch {}
      }
    }
  }

  // ---------------- 在飞动作登记（接管要取消并等待它们） ----------------

  /**
   * 登记并执行一个客机动作。
   * 外部 signal（运行取消 / 宿主工具取消）级联到动作；动作结果按 backend 合同判定：
   * 只有「明确没有产生客机副作用」的失败才算已确认结束，其余（含通用后端错误）一律按
   * 效果未知处理 —— 绝不把未知当已终止，否则归还/停止会带着可能仍在跑的客机动作放行。
   * 真正的下发前还有一次同步权威校验（authority），确保接管/归还/停止生效后旧动作不执行。
   */
  async #withAction(desc, fn) {
    const ac = new AbortController();
    let settle = null;
    const done = new Promise((resolveP) => {
      settle = resolveP;
    });
    const action = {
      id: genId("cact"),
      kind: desc.kind,
      computerId: desc.computerId,
      botId: desc.botId ?? null,
      runId: desc.runId ?? null,
      authority: desc.authority ?? null,
      startedAt: Date.now(),
      abort: ac,
      done,
      outcome: null,
      error: null,
    };
    let set = this.actions.get(desc.computerId);
    if (!set) this.actions.set(desc.computerId, (set = new Set()));
    set.add(action);
    const onOuterAbort = () => {
      try {
        ac.abort(desc.signal?.reason ?? new Error("aborted"));
      } catch {}
    };
    if (desc.signal) {
      if (desc.signal.aborted) onOuterAbort();
      else desc.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      // 调用边界：紧邻 fn(...) 的同步校验，中间不得有 await。
      if (desc.authority) this.#assertAuthority({ authority: desc.authority, computerId: desc.computerId });
      const out = await fn(ac.signal, action);
      action.outcome = ac.signal.aborted ? "aborted_confirmed" : "settled";
      return out;
    } catch (e) {
      action.error = e?.message ?? String(e);
      const code = typeof e?.code === "string" && e.code ? e.code : null;
      action.outcome = code && CONFIRMED_NO_EFFECT_CODES.has(code) ? "rejected" : "unknown";
      if (action.outcome === "unknown" && e && typeof e === "object") {
        try {
          e.effectUnknown = true;
        } catch {}
      }
      throw e;
    } finally {
      desc.signal?.removeEventListener?.("abort", onOuterAbort);
      set.delete(action);
      if (!set.size) this.actions.delete(desc.computerId);
      settle(action);
    }
  }

  /** 取消（可选）并等待在飞动作；返回未确认/超时的动作，供接管判定是否安全。 */
  async #drainActions(computerId, { abort = false, timeoutMs }) {
    const set = this.actions.get(computerId);
    if (!set || !set.size) return { total: 0, unknown: [], timedOut: [] };
    const list = [...set];
    if (abort) {
      for (const a of list) {
        try {
          a.abort.abort(new Error("computer control transition"));
        } catch {}
      }
    }
    const bounded = boundedWait(timeoutMs);
    try {
      await Promise.race([Promise.allSettled(list.map((a) => a.done)), bounded.promise]);
    } finally {
      bounded.cancel();
    }
    return {
      total: list.length,
      unknown: list.filter((a) => a.outcome === "unknown").map(describeAction),
      timedOut: list.filter((a) => a.outcome === null).map(describeAction),
    };
  }

  // ---------------- 资料进入客机（preparePrompt） ----------------

  /** 客机里的附件路径：由附件 id 与安全文件名决定，模型不能指定宿主路径。 */
  #attachmentGuestPath(record) {
    const safe = canonicalFilename(record.filename);
    return `${ATTACHMENT_GUEST_DIR}/${record.id}-${safe}`;
  }

  #spoolDir(computerId, runId) {
    return join(this.home, "computers", computerId, "spool", String(runId ?? "unscoped").replace(/[^A-Za-z0-9_-]/g, "_"));
  }

  #cleanSpool(computerId, runId) {
    try {
      rmSync(this.#spoolDir(computerId, runId), { recursive: true, force: true });
    } catch (e) {
      this.orch.emit?.("computer_spool_cleanup_failed", { computerId, runId, error: e?.message ?? String(e) });
    }
  }

  /**
   * 绑定电脑的非 chat Bot：附件按 id 验归属后上传到座席的 ~/work/attachments/<id>-<safe-name>，
   * 文本里给客机路径；图片仍按原生 ImageContent 交给模型。
   * 返回 null 表示「不走电脑路径」（未绑定，或 chat 档：chat 仍然只有聊天，
   * 附件继续走既有受控宿主读取，不依赖一台运行中的客机，人工接管期间也照常聊天）。
   * @returns {Promise<{text:string, images:object[]}|null>}
   */
  async preparePrompt(run, { signal } = {}) {
    if (!run?.botId) return null; // 群 Run 没有单归属 Bot：不在这里判归属，交给原有路径
    const bot = this.#requireBot(run.botId);
    if (!bot.computer || bot.executionMode === "chat") return null;
    const cid = computerIdFor(bot.id);
    const ids = Array.isArray(run?.attachmentIds) ? run.attachmentIds : [];
    let text = typeof run?.text === "string" ? run.text : "";
    const ctx = this.#assertAgentAction({ botId: bot.id, runId: run.id });
    // 绑定电脑的回合一律先确认电脑真的可用（没有附件也要，否则第一次工具调用才发现没起机）。
    await this.#ensureRunning(bot);
    if (!ids.length) return { text, images: [] };
    const backend = await this.ensureBackend();
    const attachments = this.orch.features?.attachments;
    if (!attachments) throw ferr(500, "attachments_unavailable", "附件层不可用，无法准备客机附件");
    const images = [];
    const blocks = [];
    for (const id of ids) {
      const { record, absPath, buf } = attachments.loadFor(bot.id, id);
      const dest = this.#attachmentGuestPath(record);
      try {
        await this.#withAction(
          { computerId: cid, botId: bot.id, runId: run.id, kind: "upload_attachment", authority: ctx.authority, signal },
          (s) => backend.uploadFile(cid, { localPath: absPath, path: dest }, { signal: s }),
        );
      } catch (e) {
        if (e?.effectUnknown || e?.code === "computer_effect_unknown") {
          this.#markReconcile(cid, bot.id, { kind: "upload_attachment", message: e?.message ?? String(e) });
          this.orch.noteSideEffectUnknown?.(run.id, { reason: "guest_effect_unknown", detail: `upload_attachment: ${e?.message ?? String(e)}` });
        }
        throw e;
      }
      attachments.markUsed(record.id, run.id);
      if (record.kind === "image") {
        images.push({ type: "image", mimeType: record.mime, data: buf.toString("base64") });
      } else {
        blocks.push(
          [
            `[附件 document: ${record.filename} (${record.mime}, ${humanBytes(record.size)}, sha256 ${record.hash.slice(0, 16)}…)]`,
            `已在你的电脑里：客机路径 ${dest}`,
            `这是用户提供的原始资料，只读；不要改写、不要删除，产物请写到别处。`,
          ].join("\n"),
        );
      }
    }
    if (blocks.length) text = `${blocks.join("\n\n")}\n\n${text}`;
    this.orch.emit?.("computer_attachments_uploaded", { botId: bot.id, computerId: cid, runId: run.id, count: ids.length });
    return { text, images };
  }

  /** 运行前确认电脑真的可用：能观察就读观察值，不在 running 就启动（幂等），启动不了显式失败。 */
  async #ensureRunning(bot) {
    const cid = computerIdFor(bot.id);
    const backend = await this.ensureBackend();
    let observed = null;
    try {
      observed = await backend.status(cid);
    } catch (e) {
      throw backendErr(e, { code: "computer_status_failed", status: 503 });
    }
    if (observed?.state === "running") return observed;
    try {
      const next = await backend.start(cid);
      if (next?.state !== "running") {
        throw ferr(409, "computer_not_running", `电脑未就绪（state=${next?.state ?? "unknown"}），拒绝在客机执行`);
      }
      return next;
    } catch (e) {
      throw backendErr(e, { code: "computer_start_failed", status: 503 });
    }
  }

  // ---------------- 固定客机工具 ----------------

  /**
   * 绑定电脑的 Bot 的客机工具（宿主工具；不注册任何宿主 shell/读写通道）。
   * 每个动作都要求本回合持有该电脑的当前代租约。
   */
  guestTools({ bot, runtime }) {
    if (!bot?.computer) return [];
    const cid = computerIdFor(bot.id);
    const runId = () => runtime?.activeRun?.runId ?? null;
    const signalOf = (meta) => {
      const outer = runtime?.activeRun?.abort?.signal;
      const inner = meta?.signal;
      if (outer && inner && typeof AbortSignal.any === "function") return AbortSignal.any([outer, inner]);
      return inner ?? outer ?? undefined;
    };

    return [
      {
        name: "computer_screenshot",
        label: "Computer Screenshot",
        description:
          "在 Linux 共享电脑里截取你自己的桌面（PNG，随结果直接给你看）。用来看清屏幕上现在是什么、点到了哪里；截图不会获得输入能力。",
        parameters: SCREENSHOT_SCHEMA,
        handler: (_args, meta) =>
          this.#toolCall({ bot, runId: runId(), cid, name: "computer_screenshot", signal: signalOf(meta), kind: "screenshot" }, async ({ backend, signal, authority }) => {
            const shot = await this.#withAction({ computerId: cid, botId: bot.id, runId: runId(), kind: "screenshot", authority, signal }, (s) =>
              backend.screenshot(cid, { signal: s }),
            );
            const data = Buffer.isBuffer(shot?.data) ? shot.data : Buffer.from(shot?.data ?? []);
            if (!data.length) throw ferr(502, "computer_screenshot_invalid", "截图没有返回 PNG 字节");
            const w = Number.isFinite(shot?.width) ? Math.trunc(shot.width) : null;
            const h = Number.isFinite(shot?.height) ? Math.trunc(shot.height) : null;
            return {
              content: [
                { type: "text", text: `客机桌面截图${w && h ? ` ${w}×${h}` : ""}（PNG ${humanBytes(data.length)}）` },
                { type: "image", mimeType: shot?.mimeType ?? "image/png", data: data.toString("base64") },
              ],
            };
          }),
      },
      {
        name: "computer_input",
        label: "Computer Input",
        description:
          "在 Linux 共享电脑里，在你自己的桌面上点击/移动/滚动/输入文本或按键。配合 computer_screenshot 使用；输入只作用于你自己的桌面。",
        parameters: INPUT_SCHEMA,
        handler: (args, meta) =>
          this.#toolCall({ bot, runId: runId(), cid, name: "computer_input", signal: signalOf(meta), kind: "input", mutating: true }, async ({ backend, signal, authority }) => {
            const action = normalizeInputAction(args ?? {});
            await this.#withAction({ computerId: cid, botId: bot.id, runId: runId(), kind: "input", authority, signal }, (s) =>
              backend.input(cid, action, { signal: s }),
            );
            const shown =
              action.action === "type"
                ? `type(${JSON.stringify(action.text.slice(0, 80))})`
                : action.action === "key"
                  ? `key(${action.key})`
                  : action.action === "scroll"
                    ? `scroll(${action.deltaX},${action.deltaY})`
                    : `${action.action}(${action.x},${action.y}${action.button ? `,${action.button}` : ""})`;
            return { content: [{ type: "text", text: `已在客机执行输入：${shown}` }] };
          }),
      },
      {
        name: "computer_shell",
        label: "Computer Shell",
        description:
          "在 Linux 共享电脑里你自己的座席上用 /bin/sh 执行命令，返回 stdout/stderr/退出码。默认工作目录 ~/work，~ 是你自己的主目录，别的 bot 的主目录你看不到。没有 sudo，要装系统包用 computer_install_packages。这台电脑不是运行工作台的那台机器，本机工具照常可用。",
        parameters: SHELL_SCHEMA,
        handler: (args, meta) =>
          this.#toolCall({ bot, runId: runId(), cid, name: "computer_shell", signal: signalOf(meta), kind: "shell", mutating: true }, async ({ backend, signal, generation, authority }) => {
            const command = String(args?.command ?? "");
            if (!command.trim()) throw ferr(400, "invalid_field", "command 必填");
            if (command.length > MAX_SHELL_COMMAND_CHARS) throw ferr(400, "invalid_field", `command 超长（>${MAX_SHELL_COMMAND_CHARS}）`);
            const cwd = args?.cwd === undefined ? DEFAULT_GUEST_CWD : guestPath(args.cwd, { label: "cwd" });
            const rawTimeout = Number(args?.timeoutMs);
            const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
              ? Math.min(Math.max(Math.trunc(rawTimeout), MIN_SHELL_TIMEOUT_MS), MAX_SHELL_TIMEOUT_MS)
              : DEFAULT_SHELL_TIMEOUT_MS;
            // tag 绑定 runId 与 generation：取消/接管后按 tag 精确杀客机进程组。
            this._tagSeq += 1;
            const tag = `ompbot-${String(runId() ?? "unscoped").replace(/[^A-Za-z0-9_-]/g, "_")}-g${generation}-${this._tagSeq}`;
            const out = await this.#withAction(
              { computerId: cid, botId: bot.id, runId: runId(), kind: "shell", authority, signal },
              (s) => backend.run(cid, { command, cwd, timeoutMs, tag }, { signal: s }),
            );
            const parts = [
              `客机命令结束：exit=${out?.exitCode ?? "null"}${out?.timedOut ? "（超时被杀）" : ""} cwd=${cwd}`,
              out?.stdout ? `stdout:\n${truncate(out.stdout)}` : "stdout:（空）",
              out?.stderr ? `stderr:\n${truncate(out.stderr)}` : "",
            ].filter(Boolean);
            return { content: [{ type: "text", text: parts.join("\n") }], isError: out?.timedOut === true };
          }),
      },
      {
        name: "computer_files",
        label: "Computer Files",
        description:
          "在 Linux 共享电脑里查看/读取/写入/删除文件。路径可以是绝对路径或 ~/ 开头（你自己的主目录）。宿主路径不接受。",
        parameters: FILES_SCHEMA,
        handler: (args, meta) =>
          this.#toolCall({ bot, runId: runId(), cid, name: "computer_files", signal: signalOf(meta), kind: "files", mutating: true }, async ({ backend, signal, generation, authority }) => {
            const action = String(args?.action ?? "").trim();
            const path = guestPath(args?.path, { label: "path" });
            // 每次调用一个独立 tag：并发工具调用不会因为一个被取消而互相杀掉客机命令。
            this._tagSeq += 1;
            const tag = `ompbot-files-${String(runId() ?? "unscoped").replace(/[^A-Za-z0-9_-]/g, "_")}-g${generation}-${this._tagSeq}`;
            const runGuest = (command, timeoutMs = FILE_TIMEOUT_MS) =>
              this.#withAction(
                { computerId: cid, botId: bot.id, runId: runId(), kind: `files:${action}`, authority, signal },
                (s) => backend.run(cid, { command, cwd: DEFAULT_GUEST_CWD, timeoutMs, tag }, { signal: s }),
              );

            if (action === "list") {
              const out = await runGuest(`ls -la ${shPath(path)}`, 20_000);
              if (out?.exitCode !== 0) {
                throw ferr(409, "guest_file_error", `列出客机目录失败：${truncate(out?.stderr || out?.stdout || "unknown", 2000)}`);
              }
              return { content: [{ type: "text", text: truncate(out.stdout || "（空）", MAX_LISTING_CHARS) }] };
            }
            if (action === "read") {
              const rawMax = Number(args?.maxBytes);
              const max = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(Math.trunc(rawMax), MAX_READ_BYTES) : DEFAULT_READ_BYTES;
              const script = `p=${shPath(path)}; if [ ! -e "$p" ]; then echo "missing" >&2; exit 4; fi; if [ -d "$p" ]; then echo "is_directory" >&2; exit 4; fi; wc -c <"$p"; head -c ${max} "$p"`;
              const out = await runGuest(script);
              if (out?.exitCode !== 0) {
                throw ferr(409, "guest_file_error", `读取客机文件失败：${truncate(out?.stderr || out?.stdout || "unknown", 2000)}`);
              }
              const nl = String(out.stdout ?? "").indexOf("\n");
              const size = nl > 0 ? Number(String(out.stdout).slice(0, nl).trim()) : NaN;
              const content = nl >= 0 ? String(out.stdout).slice(nl + 1) : "";
              const header = Number.isFinite(size)
                ? `客机文件 ${path}（${humanBytes(size)}）${size > max ? `，只显示前 ${humanBytes(max)}` : ""}：`
                : `客机文件 ${path}：`;
              return { content: [{ type: "text", text: `${header}\n${truncate(content, MAX_OUTPUT_CHARS)}` }] };
            }
            if (action === "write") {
              const text = typeof args?.text === "string" ? args.text : null;
              if (text === null) throw ferr(400, "invalid_field", "write 需要 text 字符串");
              if (Buffer.byteLength(text, "utf8") > MAX_WRITE_BYTES) {
                throw ferr(413, "guest_file_too_large", `写入内容超过上限 ${humanBytes(MAX_WRITE_BYTES)}`);
              }
              const spool = join(this.#spoolDir(cid, runId()), `write-${Date.now().toString(36)}.txt`);
              mkdirSync(this.#spoolDir(cid, runId()), { recursive: true });
              writeFileSync(spool, text, "utf8");
              try {
                await this.#withAction(
                  { computerId: cid, botId: bot.id, runId: runId(), kind: "files:write", authority, signal },
                  (s) => backend.uploadFile(cid, { localPath: spool, path }, { signal: s }),
                );
              } finally {
                try {
                  rmSync(spool, { force: true });
                } catch {}
              }
              return { content: [{ type: "text", text: `已写入客机文件 ${path}（${humanBytes(Buffer.byteLength(text, "utf8"))}）` }] };
            }
            if (action === "remove") {
              if (UNREMOVABLE_GUEST_PATHS.includes(path)) {
                throw ferr(400, "guest_path_readonly", `拒绝删除 ${path} 本身`);
              }
              const out = await runGuest(`rm -rf -- ${shPath(path)}`, 20_000);
              if (out?.exitCode !== 0) {
                throw ferr(409, "guest_file_error", `删除客机路径失败：${truncate(out?.stderr || out?.stdout || "unknown", 2000)}`);
              }
              return { content: [{ type: "text", text: `已删除客机路径 ${path}` }] };
            }
            throw ferr(400, "invalid_field", `未知文件操作：${JSON.stringify(args?.action ?? null)}`);
          }),
      },
      {
        name: "computer_upload_attachment",
        label: "Computer Upload Attachment",
        description:
          "在 Linux 共享电脑里放入本 Bot 附件库里已登记的附件（默认 ~/work/attachments/<附件 id>-<文件名>），之后可在客机里用文件路径访问它。只能上传属于本 Bot 的附件。",
        parameters: UPLOAD_SCHEMA,
        handler: (args, meta) =>
          this.#toolCall({ bot, runId: runId(), cid, name: "computer_upload_attachment", signal: signalOf(meta), kind: "upload_attachment", mutating: true }, async ({ backend, signal, authority }) => {
            const id = String(args?.attachmentId ?? "").trim();
            if (!id) throw ferr(400, "invalid_field", "attachmentId 必填");
            const attachments = this.orch.features?.attachments;
            if (!attachments) throw ferr(500, "attachments_unavailable", "附件层不可用");
            // 归属与哈希在这里校验：跨 Bot 附件与任意宿主路径都不可能进来。
            const { record, absPath } = attachments.loadFor(bot.id, id);
            const dest = args?.path === undefined
              ? this.#attachmentGuestPath(record)
              : guestPath(args.path, { label: "path" });
            await this.#withAction(
              { computerId: cid, botId: bot.id, runId: runId(), kind: "upload_attachment", authority, signal },
              (s) => backend.uploadFile(cid, { localPath: absPath, path: dest }, { signal: s }),
            );
            attachments.markUsed(record.id, runId());
            return {
              content: [
                {
                  type: "text",
                  text: `附件 ${record.filename}（${humanBytes(record.size)}）已上传到客机 ${dest}`,
                },
              ],
            };
          }),
      },
      {
        name: "computer_install_packages",
        label: "Computer Install Packages",
        description:
          "在 Linux 共享电脑里用 apt 装系统包（Debian 包名）。装好后所有 bot 都能用。每次都要用户批准。只在确实缺少系统程序时用，Python/Node 包请用 pip/npm 装进你自己的主目录。",
        parameters: INSTALL_SCHEMA,
        handler: (args, meta) =>
          this.#toolCall({ bot, runId: runId(), cid, name: "computer_install_packages", signal: signalOf(meta), kind: "install_packages", mutating: true }, async ({ backend, signal, authority }) => {
            if (typeof backend.installPackages !== "function") {
              throw ferr(501, "computer_install_unsupported", "这台电脑的后端不支持装系统包");
            }
            const packages = Array.isArray(args?.packages) ? args.packages : [];
            const out = await this.#withAction(
              { computerId: cid, botId: bot.id, runId: runId(), kind: "install_packages", authority, signal },
              (s) => backend.installPackages(cid, packages, { signal: s }),
            );
            const ok = out?.exitCode === 0 && out?.timedOut !== true;
            const parts = [
              `${ok ? "已装好" : "没装成"}：${(out?.packages ?? packages).join(" ")}（exit=${out?.exitCode ?? "null"}${out?.timedOut ? "，超时" : ""}）`,
              out?.stdout ? `stdout:\n${truncate(out.stdout, 6000)}` : "",
              out?.stderr ? `stderr:\n${truncate(out.stderr, 6000)}` : "",
            ].filter(Boolean);
            return { content: [{ type: "text", text: parts.join("\n") }], isError: !ok };
          }),
      },
      {
        name: "computer_publish_file",
        label: "Computer Publish File",
        description:
          "在 Linux 共享电脑里取出生成的文件交付给用户：从客机下载进本 Run 的专属 spool，再用既有不可变成果库登记，用户可在工作台预览/下载。",
        parameters: PUBLISH_SCHEMA,
        handler: (args, meta) =>
          this.#toolCall({ bot, runId: runId(), cid, name: "computer_publish_file", signal: signalOf(meta), kind: "publish", mutating: true }, async ({ backend, signal, authority }) => {
            const guest = guestPath(args?.path, { label: "path" });
            const name = args?.name === undefined ? canonicalFilename(basename(guest)) : canonicalFilename(args.name);
            const run = this.orch.getRun?.(runId());
            if (!run) throw ferr(409, "computer_run_missing", "找不到当前运行，无法登记成果");
            const spoolDir = this.#spoolDir(cid, run.id);
            mkdirSync(spoolDir, { recursive: true });
            const local = join(spoolDir, name);
            await this.#withAction(
              { computerId: cid, botId: bot.id, runId: run.id, kind: "publish_download", authority, signal },
              (s) => backend.downloadFile(cid, { path: guest, localPath: local }, { signal: s }),
            );
            const added = await this.orch.features.collectArtifacts(run, { cwd: spoolDir });
            const rec =
              (added ?? []).find((a) => a.sourcePath === local) ??
              (this.orch.features.artifacts?.list?.({ botId: bot.id, runId: run.id }) ?? []).find((a) => a.sourcePath === local) ??
              null;
            if (!rec) throw ferr(502, "computer_publish_failed", `客机文件已下载但未能登记为成果：${guest}`);
            return {
              content: [
                {
                  type: "text",
                  text: `已登记成果 ${rec.id}：${rec.name}（${humanBytes(rec.size)}，版本 ${rec.version ?? 1}）。用户可在工作台预览或下载；客机路径 ${guest}。`,
                },
              ],
            };
          }),
      },
    ];
  }

  /**
   * 工具调用外壳：租约/代校验 → 执行 → 调用后再校验代。
   * 失败一律作为工具错误返回给模型（含 computer_effect_unknown 的对账标记）。
   */
  async #toolCall({ bot, runId, cid, name, signal, kind = null, mutating = false }, body) {
    let ctx = null;
    try {
      ctx = this.#assertAgentAction({ botId: bot.id, runId });
      // 群回合等没有 preparePrompt 前置的路径也要在动作前确认电脑真的可用（能观察就观察，不在 running 就启动）。
      await this.#ensureRunning(bot);
      const backend = await this.ensureBackend();
      const out = await body({ backend, signal, generation: ctx.generation, authority: ctx.authority, ctx });
      if (mutating) {
        // 调用后复查：动作期间发生接管（代变化）→ 变更类动作结果作废，绝不当成已生效。
        const after = this.#control(cid, bot.id);
        if (after.generation !== ctx.generation) {
          throw ferr(409, "computer_generation_stale", "动作执行期间电脑已被人工接管，变更结果作废");
        }
      }
      return out;
    } catch (e) {
      if (e?.effectUnknown || e?.code === "computer_effect_unknown") {
        this.#markReconcile(cid, bot.id, { kind: "agent_action", message: `${name}${kind ? ` (${kind})` : ""}: ${e?.message ?? String(e)}` });
        this.orch.noteSideEffectUnknown?.(runId, {
          reason: "guest_effect_unknown",
          detail: `${name}${kind ? ` (${kind})` : ""}: ${e?.message ?? String(e)}`,
        });
      }
      const text = `电脑工具 ${name} 未完成：${e?.message ?? String(e)}`;
      return { content: [{ type: "text", text }], isError: true };
    }
  }
}
