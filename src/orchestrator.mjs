// orchestrator.mjs — 团队编排器：唯一的 BotRuntime + Ledger + WorkbenchFeatures 整合点。
//
// 职责边界（不重复 OMP 引擎）：
//  - 花名册 / 群 CRUD 与展示用聊天缓存（Store 的旧职责，保持不变）。
//  - 运行生命周期：admission（scope 租约）、startRun/getRun/listRuns/waitRun、
//    cancelRun 级联、steerRun、审批记录与原生应答。真实模型/工具/会话/压缩/子代理
//    全部由 OMP 原生进程承担，这里只做投影与准入。
//  - BotRuntime 池：按 botId::scope 懒启动，策略签名（执行模式/审批档/工作区/模型/
//    思考档/技能/记忆）一变就重建进程，宽权限进程绝不承接收窄后的 Run。
//  - 团队工具注入：message_bot（同步、hop+busy 防死锁）、delegate_bot（异步子 Run）、
//    list_bots。安全性由本文件的 admission（scope/父预算/工作区/能力不扩权）保证。
//
// 状态只能由原生真实帧推动：prompt_result 只是「本次 yield」，只有 session 真正静默
// （session_settled / get_state.isSettled）才释放 scope 租约。超时与取消走同一条
// 取消路径；效果未知时标 reconciliation_required，不假装 completed。

import { MAX_ALLOWED_COMMANDS, normalizeAllowedCommands, rememberableCommand } from "./allowed-commands.mjs";
import { execFile } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { applyFact, hasFact, readFacts, normalizeFact, FACT_MAX_CHARS } from "./team-facts.mjs";
import { Store, defaultHome } from "./store.mjs";
import { Ledger } from "./ledger.mjs";
import { BotRuntime, runtimeDirs } from "./bot.mjs";
import { TeamDir, identityFields } from "./team.mjs";
import { WorkbenchFeatures } from "./features.mjs";
import { Relay } from "./relay.mjs";
import { createStuckDetector, stuckCancelReason, stuckNotice, stuckSteerText } from "./stuck.mjs";
import {
  genId,
  makeBot,
  makeExchange,
  makeRoom,
  normalizeBot,
  normalizeBudget,
  intersectBudget,
  intersectExecutionMode,
  isTerminalRunState,
  permissionOf,
  permissionModes,
  sceneTag,
  senderOf,
  validateAvatarPatch,
  avatarAttachmentId,
} from "./domain.mjs";
import {
  MAX_HOPS,
  DELIVER_TIMEOUT_MS,
  RPC_COMMAND_TIMEOUT_MS,
  RUN_STATES,
  RUN_TIMEOUT_MS,
  CANCEL_SETTLE_TIMEOUT_MS,
  POLICY_IDLE_TIMEOUT_MS,
  UI_APPROVAL_TTL_MS,
  MAX_DELEGATE_DEPTH,
  DEFAULT_TASK_CONCURRENCY,
  NATIVE_EVENT_MAX_BYTES,
  NATIVE_EVENT_TEXT_LIMIT,
  NATIVE_COMMAND_ALLOWLIST,
  UI_INTERACTIVE_METHODS,
  UI_UNANSWERABLE_METHODS,
  EXECUTION_MODES,
  APPROVAL_MODES,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_APPROVAL_MODE,
  PERMISSION_LEVELS,
} from "./constants.mjs";

/** message_bot 工具的 JSON schema。 */
const MESSAGE_BOT_SCHEMA = {
  type: "object",
  properties: {
    to: { type: "string", description: "目标 bot 的名字或 id（来自 list_bots）" },
    message: { type: "string", description: "要发给对方 bot 的消息内容" },
  },
  required: ["to", "message"],
  additionalProperties: false,
};

/** 派活验收标准：最多几条、每条多长。 */
const MAX_ACCEPTANCE_ITEMS = 10;
const MAX_ACCEPTANCE_CHARS = 300;

/** 校验并整理 delegate_bot 的 acceptance：去空白、去空行；不合规抛出原因。没给返回空数组。 */
function normalizeAcceptance(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) {
    throw new Error("acceptance 要是字符串数组，一条一个验收标准");
  }
  const list = raw.map((x) => x.trim()).filter(Boolean);
  if (list.length > MAX_ACCEPTANCE_ITEMS) throw new Error(`验收标准最多 ${MAX_ACCEPTANCE_ITEMS} 条，挑最要紧的`);
  const long = list.find((x) => x.length > MAX_ACCEPTANCE_CHARS);
  if (long) throw new Error(`每条验收标准最多 ${MAX_ACCEPTANCE_CHARS} 字，这条太长：${long.slice(0, 40)}…`);
  return list;
}

/** 验收标准的清单行。 */
const acceptanceLines = (list) => list.map((x) => `- [ ] ${x}`);

/** 派给目标 bot 的正文：交接简报，带验收标准时附在后面，让它做完逐条交代。 */
function delegationTaskText(rec) {
  const list = rec.acceptance ?? [];
  if (!list.length) return rec.message;
  return [rec.message, "", "验收标准（做完逐条说明满足没有，没满足的写清原因）：", ...acceptanceLines(list)].join("\n");
}

/** delegate_bot 工具的 JSON schema（非阻塞派活）。 */
const DELEGATE_BOT_SCHEMA = {
  type: "object",
  properties: {
    to: { type: "string", description: "目标 bot 的名字或 id（来自 list_bots）" },
    message: {
      type: "string",
      description:
        "交接简报。对方看不到你和用户的对话，只拿到这段话，要写成拿来就能干的：任务（一句话说要做什么）、背景（为什么做）、相关文件（路径和用处）、现状（做到哪、哪里不行）、试过什么（为什么放弃）、已定的决定、约束（不能动什么）。任务性质原样带过去：只调研就写明不要改文件，修就写修，重构不是重写。验收标准别写在这里，放进 acceptance。",
    },
    acceptance: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_ACCEPTANCE_ITEMS,
      description:
        "验收标准，一条一个，写做完怎样算合格，要能逐条核对（比如「周报在 work/weekly.md」「列出三条风险，每条带出处」）。对方开跑时看到，交回时原样带回给你逐条核对。",
    },
  },
  required: ["to", "message"],
  additionalProperties: false,
};

const LIST_BOTS_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

/** propose_team_fact：提议一条团队事实，等用户或主助手接受。 */
const PROPOSE_TEAM_FACT_SCHEMA = {
  type: "object",
  properties: {
    fact: { type: "string", description: "一条团队都该知道的事实，一行写完，比如「周报每周五下午五点前交」" },
    source: { type: "string", description: "这条事实从哪来，比如「私聊里用户说的」「产品群 10 月 3 日通知」" },
    replaces: { type: "string", description: "要替换的旧事实原文（照抄 team 根下 AGENTS.md 团队事实块里那一条，不含来源括注）；新增就不填" },
  },
  required: ["fact", "source"],
  additionalProperties: false,
};

/** review_team_proposals：主助手列出、接受或拒绝团队事实提议。 */
const REVIEW_TEAM_PROPOSALS_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "accept", "reject"], description: "list 列出待确认的；accept 接受；reject 拒绝" },
    id: { type: "string", description: "提议编号（accept/reject 必填，来自 list）" },
    reason: { type: "string", description: "拒绝原因（可选）" },
  },
  required: ["action"],
  additionalProperties: false,
};

/** 团队事实提议的状态：pending 等确认；accepted 已写进文件；rejected 被拒；conflict 接受时发现旧事实变了。 */
const TEAM_PROPOSAL_STATES = Object.freeze(["pending", "accepted", "rejected", "conflict"]);

/** 原生审批/提问里属于「授权」语义的方法（其余是信息输入）。 */
const AUTHORIZATION_METHODS = new Set(["select", "confirm"]);

/** 头像图片允许的附件类型。 */
const AVATAR_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** run.sideEffects 里最多留几条已落定的动作记录（在飞的一律保留）。 */
const SIDE_EFFECT_KEEP = 20;

/** 派活开跑或交回时遇到这些就继续等（目标在忙、被人工接管暂停），不算失败。 */
const DELEGATION_WAIT_CODES = new Set(["target_busy", "bot_paused"]);
/** 整棵派工树的预算里留给交回和汇总的比例：干活的成员只能用到 1 − 这个比例。 */
const TREE_RETURN_SHARE = 0.2;

const DELEGATION_RESULT_LABELS = {
  completed: "做完了",
  failed: "失败了",
  cancelled: "被取消了",
  interrupted: "因为服务重启中断了，没有自动重跑",
  reconciliation_required: "结束了，但有外部动作结果未知，需要人工核对",
  not_started: "没能开跑",
};

/** 关停时的取消（直接的或经父回合级联的）：不是用户的决定。 */
function byShutdown(run) {
  return /(^|:)shutdown$/.test(String(run?.error ?? ""));
}

/** 用户在工作台或配对设备上直接发起的私聊：这种 Run 的往来记进聊天记录。 */
function isDirectChat(run) {
  return run?.kind === "chat" && (run.source === "user" || String(run.source ?? "").startsWith("device:"));
}

/** 交回给父 bot 的那条消息：子结果、子 Run id、原任务，最后提醒验收。 */
function delegationReturnText(rec, targetName) {
  const r = rec.result ?? {};
  const label = DELEGATION_RESULT_LABELS[r.state] ?? `结束了（${r.state}）`;
  const lines = [
    `[派活交回] 你派给 ${targetName} 的活${label}。`,
    `派活号：${rec.id}`,
    `子 Run：${rec.childRunId ?? "（没有开跑）"}`,
    `原任务：${String(rec.message ?? "").slice(0, 500)}`,
  ];
  const list = rec.acceptance ?? [];
  if (list.length) lines.push("验收标准：", ...acceptanceLines(list));
  if (r.reply) lines.push(`结果：\n${String(r.reply).slice(0, 8000)}`);
  const stuck = stuckNotice(r.error);
  if (r.error && !stuck) lines.push(`原因：${String(r.error).slice(0, 1000)}`);
  if (stuck) {
    // 原样再派只会让下一个人接着打转。
    lines.push("它是因为原地打转被停下的：别把同样的活原样再派。先换办法、补上缺的信息，或者自己做；还是做不到，就如实告诉用户卡在哪、需要什么。");
    return lines.join("\n");
  }
  lines.push(
    list.length
      ? "请按上面的验收标准逐条核对：没满足的再派或自己补上；已经做完的不要重复派。"
      : "请验收：结果不对就再派或自己补上；已经做完的不要重复派。",
  );
  return lines.join("\n");
}

function httpErr(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function execFileAsync(bin, args, opts) {
  return new Promise((resolveP, rejectP) => {
    execFile(bin, args, opts, (err, stdout) => {
      if (err) return rejectP(err);
      resolveP(stdout);
    });
  });
}

function normalizeModels(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.models)) return data.models;
  return [];
}

export class Orchestrator {
  /**
   * @param {object} [opts]
   * @param {string} [opts.home] 数据根目录，默认 ~/.ompbot
   * @param {string} [opts.bin] omp 可执行文件
   * @param {boolean} [opts.debug]
   * @param {string} [opts.defaultThinking] 未显式指定时的默认思考档（默认 "low"）
   * @param {(evt:object)=>void} [opts.onEvent] 观察回调（收 Ledger 信封）
   * @param {object} [opts.features] 注入的 WorkbenchFeatures（默认构造 src/features.mjs 的实例）
   * @param {object} [opts.ledger] 注入的 Ledger（测试/工具用）
   * @param {(opts:object)=>object} [opts.runtimeFactory] 注入的 runtime 工厂（测试用假 runtime）
   * @param {number} [opts.maxConcurrency] 全局在飞运行上限（默认 DEFAULT_TASK_CONCURRENCY）
   * @param {number} [opts.uiApprovalTtlMs] 工作台 UI 请求存活时间（测试可缩短）
   * @param {number} [opts.policyIdleTimeoutMs] 策略/配置变更等待空闲的上限（测试可缩短）
   */
  constructor(opts = {}) {
    this.home = opts.home ?? defaultHome();
    this.bin = opts.bin ?? "omp";
    this.debug = opts.debug ?? false;
    this.defaultThinking = opts.defaultThinking ?? "low";
    this.onEvent = opts.onEvent ?? (() => {});
    this.closing = false;
    this.runtimeFactory = opts.runtimeFactory ?? ((o) => new BotRuntime(o));
    this.maxConcurrency =
      Number.isInteger(opts.maxConcurrency) && opts.maxConcurrency > 0
        ? opts.maxConcurrency
        : DEFAULT_TASK_CONCURRENCY;
    this.uiApprovalTtlMs =
      Number.isFinite(opts.uiApprovalTtlMs) && opts.uiApprovalTtlMs > 0
        ? opts.uiApprovalTtlMs
        : UI_APPROVAL_TTL_MS;
    this.policyIdleTimeoutMs =
      Number.isFinite(opts.policyIdleTimeoutMs) && opts.policyIdleTimeoutMs > 0
        ? opts.policyIdleTimeoutMs
        : POLICY_IDLE_TIMEOUT_MS;

    // 先拿单写者锁再读快照：抢到锁的瞬间读到的才是权威状态，避免拿到别人的旧快照。
    this.store = new Store({ home: this.home });
    this.store.acquireLock();
    try {
      this.store.load();
      this.ledger =
        opts.ledger ?? new Ledger({ home: this.home, readonly: this.store.readonly === true });
    } catch (e) {
      // 快照损坏或台账打不开都不能半启动：释放已持有的锁再抛真实错误。
      this.store.releaseLock();
      throw e;
    }

    // 团队目录：bot 的 cwd、身份块、会话都在这里。只读副本不写任何东西。
    this.team = new TeamDir({
      home: this.home,
      readonly: this.store.readonly === true,
      git: opts.teamGit,
      onEvent: (type, data) => this.emit(type, data),
    });

    /** @type {Map<string, BotRuntime>} key = `${botId}::${scope}` */
    this.runtimes = new Map();
    /** scope 租约：leaseKey → runId。startRun 里原子预留。 */
    this.leases = new Map();
    /** runId → 内存控制块 {run,leaseKey,abort,children,approvals,done,cancelled,finished} */
    this.runs = new Map();
    /** runId → Set<resolve>（waitRun） */
    this._runWaiters = new Map();
    /** approvalId → 过期定时器 */
    this._uiTimers = new Map();
    /** botId → 待完成的策略重建（updateBot 只登记，起点在 runtimeFor 前等它） */
    this._pendingRestart = new Map();
    /** 预留记账：`run:<id>` / `bot:<id>` → 在飞子 Run 的未落定额度 */
    this._reserved = new Map();
    /** 已经到过余量线、停过一次的派工树根 id（只为不重复停、不重复发事件）。 */
    this._stoppedTrees = new Set();
    /** 整棵树上的在飞预留：根 id → 第一层干活成员占着的上限之和。 */
    this._treeReserved = new Map();
    /** 后台清理任务（removeBot/shutdown 用的 fire-and-forget 也必须被追踪） */
    this._bg = new Set();
    this._modelsCache = null;

    try {
      // 特性层是必需依赖：缺模块/构造失败就初始化失败，不带着「没有附件与成果」继续跑。
      this.features =
        opts.features ??
        new WorkbenchFeatures({
          orch: this,
          bin: this.bin,
          computerBackend: opts.computerBackend ?? null,
          computerRuntimeDir: opts.computerRuntimeDir ?? null,
        });
      this._ensureTeam();
      this._recover();
    } catch (e) {
      try {
        this.ledger.close();
      } catch {}
      this.store.releaseLock();
      throw e;
    }
  }

  /** 追踪后台任务：不让 promise 变成 unhandled，也不在 shutdown 前被丢掉。 */
  _background(promise) {
    const p = Promise.resolve(promise).catch((e) => {
      this.emit("background_error", { error: e?.message ?? String(e) });
      return null;
    });
    this._bg.add(p);
    p.finally(() => this._bg.delete(p));
    return p;
  }

  /** 启动恢复：未落定 Run 标 interrupted（不自动重跑），挂起审批标 expired（进程已换）。 */
  _recover() {
    if (this.ledger.readonly) return;
    try {
      const { interrupted, reconciliationRequired } = this.ledger.reconcile();
      if (interrupted.length || reconciliationRequired.length) {
        this.emit("runs_reconciled", { interrupted, reconciliationRequired });
      }
    } catch (e) {
      this.emit("recover_error", { error: e?.message ?? String(e) });
    }
    let stale = [];
    try {
      stale = (this.ledger.list("approvals", { limit: 200 }) ?? []).filter(
        (a) => a?.status === "pending",
      );
    } catch (e) {
      this.emit("recover_error", { error: e?.message ?? String(e) });
      return;
    }
    for (const rec of stale) {
      try {
        this.ledger.put("approvals", {
          ...rec,
          status: "expired",
          expiredAt: Date.now(),
          expiredReason: "process-restarted",
        });
      } catch {}
    }
    if (stale.length) this.emit("ui_stale_cleared", { ids: stale.map((a) => a.id) });
    this._recoverDelegations();
  }

  // ---- 派活记录（delegate_bot 的工作账与交付账）----
  //
  // 一条记录管一件派出去的活：state 是执行（queued → running → returned），
  // delivery 是交回（pending → delivered | dropped）。两本账分开：活做完了不等于父 bot 收到了。
  // 只有 delegate_bot 写记录；message_bot 是同步等回复，不走这里。

  /** 重启：排队的继续排；跑到一半的子 Run 已被 reconcile 标 interrupted，交回「中断」结果，不重跑。 */
  _recoverDelegations() {
    let recs = [];
    try {
      recs = this._delegationRecords();
    } catch (e) {
      this.emit("recover_error", { error: e?.message ?? String(e) });
      return;
    }
    for (const rec of recs) {
      if (rec.state !== "running") continue;
      const child = rec.childRunId ? this.getRun(rec.childRunId) : null;
      if (child && !isTerminalRunState(child.state)) continue;
      this._returnDelegation(rec, child ?? { state: "interrupted", error: "子 Run 记录缺失" });
    }
    // 上面刚交回的也要送：按对账后的状态判断，不用循环前的旧快照。
    if (this._delegationRecords().some((r) => r.state === "queued" || (r.state === "returned" && r.delivery === "pending"))) {
      this._schedulePump();
    }
  }

  /** 全部派活记录，按创建先后（最早的在前）。 */
  _delegationRecords() {
    return (this.ledger.list("delegations", { limit: 1000 }) ?? []).slice().reverse();
  }

  listDelegations({ botId = null, limit = 100 } = {}) {
    const all = (this.ledger.list("delegations", { limit: 1000 }) ?? []).filter(
      (r) => !botId || r.fromBotId === botId || r.targetBotId === botId,
    );
    return all.slice(0, Math.max(1, Math.min(1000, limit)));
  }

  _putDelegation(rec, type) {
    const next = { ...rec, updatedAt: Date.now() };
    this.ledger.put("delegations", next);
    if (type) {
      this.emit(type, {
        delegationId: next.id,
        botId: next.targetBotId,
        fromBotId: next.fromBotId,
        runId: next.childRunId ?? undefined,
        state: next.state,
        delivery: next.delivery,
        delegation: next,
      });
    }
    return next;
  }

  /** 子 Run 落定 → 执行账记 returned，交付账记 pending（父回合被取消的除外）。 */
  _returnDelegation(rec, run) {
    let state = run?.state ?? "interrupted";
    // 关停时的取消（含经父回合级联的）不是谁的决定，重启后按中断交回。
    const shutdown = byShutdown(run);
    if (state === RUN_STATES.CANCELLED && shutdown) state = RUN_STATES.INTERRUPTED;
    const parentCancelled = !shutdown && String(run?.error ?? "").startsWith("parent-cancelled");
    return this._putDelegation(
      {
        ...rec,
        state: "returned",
        returnedAt: Date.now(),
        result: { state, reply: run?.reply ?? null, error: run?.error ?? null },
        delivery: parentCancelled ? "dropped" : "pending",
        ...(parentCancelled ? { dropReason: "parent_cancelled" } : {}),
      },
      "delegation_returned",
    );
  }

  /** 没能开跑：同样交回给父 bot（它要知道活没人做）。 */
  _returnNotStarted(rec, error, { delivery = "pending", dropReason } = {}) {
    return this._putDelegation(
      {
        ...rec,
        state: "returned",
        returnedAt: Date.now(),
        result: { state: "not_started", reply: null, error },
        delivery,
        ...(dropReason ? { dropReason } : {}),
      },
      "delegation_returned",
    );
  }

  _dropDelivery(rec, reason, error = null) {
    return this._putDelegation(
      { ...rec, delivery: "dropped", dropReason: reason, ...(error ? { dropError: error } : {}) },
      "delegation_dropped",
    );
  }

  /** 任一 Run 落定后调用：交回本条派活，再看排队和待交付能不能推进。 */
  _onRunSettled(run) {
    if (this.closing || this.ledger.readonly || !run) return;
    try {
      if (run.kind === "delegation") {
        const rec = this._delegationRecords().find((r) => r.childRunId === run.id);
        if (rec && rec.state === "running") this._returnDelegation(rec, run);
      }
    } catch (e) {
      this.emit("delegation_error", { runId: run.id, error: e?.message ?? String(e) });
    }
    this._schedulePump();
  }

  /** 父回合被取消：还在排队的活不再开跑，也不交回。 */
  _dropQueuedDelegations(parentRunId) {
    // 关停也会级联取消：那不是用户的决定，排队的活重启后继续排。
    if (this.closing || this.ledger.readonly) return;
    for (const rec of this._delegationRecords()) {
      if (rec.state === "queued" && rec.parentRunId === parentRunId) {
        this._returnNotStarted(rec, "父回合已取消", { delivery: "dropped", dropReason: "parent_cancelled" });
      }
    }
  }

  _schedulePump() {
    if (this._pumpScheduled || this.closing) return;
    this._pumpScheduled = true;
    setImmediate(() => {
      this._pumpScheduled = false;
      if (this.closing) return;
      try {
        this._pumpDelegations();
      } catch (e) {
        this.emit("delegation_error", { error: e?.message ?? String(e) });
      }
    });
  }

  /** 按创建先后推进：同一目标前面的还在排，后面的不插队。 */
  _pumpDelegations() {
    const blocked = new Set();
    for (const rec of this._delegationRecords()) {
      if (this.closing) return;
      if (rec.state === "queued") {
        if (blocked.has(rec.targetBotId)) continue;
        const r = this._tryStartDelegation(rec);
        if (r.outcome === "busy") blocked.add(rec.targetBotId);
        // 没能开跑的这一轮就交回，不等下一次推进（可能再也没有 Run 落定来触发）。
        else if (r.outcome === "failed") this._deliverDelegation(rec.id);
      } else if (rec.state === "returned" && rec.delivery === "pending") {
        this._deliverDelegation(rec.id);
      }
    }
  }

  /**
   * 开跑一条排队的活。开跑前重查准入（目标还在、同工作区、不扩权、父回合没被取消）。
   * @returns {{outcome:"started"|"busy"|"failed", child?, error?}}
   */
  _tryStartDelegation(rec, { inline = false } = {}) {
    const from = this.getBot(rec.fromBotId);
    const target = this.getBot(rec.targetBotId);
    if (!from) {
      this._returnNotStarted(rec, "派活的 bot 已删除", { delivery: "dropped", dropReason: "parent_bot_gone" });
      return { outcome: "failed", error: "派活的 bot 已删除" };
    }
    if (!target) {
      const error = `${rec.targetName ?? rec.targetBotId} 已删除，没能开跑`;
      this._returnNotStarted(rec, error);
      return { outcome: "failed", error };
    }
    const parentRun = rec.parentRunId ? this.getRun(rec.parentRunId) : null;
    if (parentRun?.state === RUN_STATES.CANCELLED && !byShutdown(parentRun)) {
      this._returnNotStarted(rec, "父回合已取消", { delivery: "dropped", dropReason: "parent_cancelled" });
      return { outcome: "failed", error: "父回合已取消" };
    }
    try {
      this._assertDelegationAllowed(from, target, parentRun);
    } catch (e) {
      this._returnNotStarted(rec, e.message);
      return { outcome: "failed", error: e.message };
    }
    let child;
    try {
      child = this.startRun(
        {
          botId: target.id,
          text: delegationTaskText(rec),
          sender: `🤖 ${from.name} (@${from.id})`,
          source: "bot",
          parentRunId: rec.parentRunId,
          depth: rec.depth,
        },
        { allowFinishedParent: true },
      );
    } catch (e) {
      // 后台开跑时撞上全局并发上限也只是等；当场派活撞上就如实拒绝（不让排队绕过上限）。
      if (DELEGATION_WAIT_CODES.has(e?.code) || (!inline && e?.code === "concurrency_limit")) {
        return { outcome: "busy", error: e.message };
      }
      const error = e?.message ?? String(e);
      this._returnNotStarted(rec, error);
      return { outcome: "failed", error };
    }
    this._putDelegation({ ...rec, state: "running", childRunId: child.id, startedAt: Date.now() });
    this.emit("delegation_accepted", {
      runId: child.id,
      parentRunId: rec.parentRunId,
      botId: target.id,
      from: from.name,
      delegationId: rec.id,
    });
    return { outcome: "started", child };
  }

  /**
   * 交回：在父 bot 的私聊里起一条新 Run，带上子结果和子 Run id，由它验收。
   * 只处理 delivery=pending 的记录，所以重复调用不会重复唤醒。
   * 交回前重查父 bot 还能不能看到目标 bot（同工作区）；看不到就 dropped，结果仍留在工作台。
   */
  _deliverDelegation(id) {
    const rec = this.ledger.get("delegations", id);
    if (!rec || rec.state !== "returned" || rec.delivery !== "pending") return { outcome: "noop" };
    const from = this.getBot(rec.fromBotId);
    if (!from) return { outcome: "dropped", rec: this._dropDelivery(rec, "parent_bot_gone") };
    const target = this.getBot(rec.targetBotId);
    // 没开跑的交回只含我们自己的说明，不带目标 bot 的内容，不必查可见性。
    if (rec.result?.state !== "not_started") {
      if (!target) return { outcome: "dropped", rec: this._dropDelivery(rec, "target_gone") };
      if ((from.workspace ?? "") !== (target.workspace ?? "")) {
        return { outcome: "dropped", rec: this._dropDelivery(rec, "visibility_revoked") };
      }
    }
    const targetName = target?.name ?? rec.targetName ?? rec.targetBotId;
    let wake;
    try {
      wake = this.startRun({
        botId: from.id,
        text: delegationReturnText(rec, targetName),
        sender: `🤖 ${targetName} (@${rec.targetBotId})`,
        source: "bot",
        depth: rec.depth,
      }, {
        // 唤醒算在派活那棵树里：用的是留下的余量，不另拿一份预算。
        returnOf: rec.id,
        treeRootId: rec.parentRunId ? this._treeRootOf(this.getRun(rec.parentRunId)) : null,
      });
    } catch (e) {
      // 父 bot 正忙（startRun 的 scope 准入拒了）：交付留在 pending，等它空了再送。
      if (DELEGATION_WAIT_CODES.has(e?.code) || e?.code === "concurrency_limit") return { outcome: "busy" };
      if (e?.code === "budget_exhausted") {
        return { outcome: "dropped", rec: this._dropDelivery(rec, "budget_exhausted", e.message) };
      }
      return { outcome: "dropped", rec: this._dropDelivery(rec, "wake_rejected", e?.message ?? String(e)) };
    }
    const next = this._putDelegation(
      { ...rec, delivery: "delivered", wakeRunId: wake.id, deliveredAt: Date.now() },
      "delegation_delivered",
    );
    return { outcome: "delivered", rec: next, wake };
  }

  // ---- 事件 ----

  /**
   * 追加到 Ledger 并广播。返回事件信封 {v,seq,at,type,...}。
   * 账本写失败时事件仍送达订阅者，但把失败显式挂在信封上，不假装已持久化。
   */
  emit(type, data = {}) {
    let env;
    try {
      env = this.ledger.appendEvent({ type, ...data });
    } catch (e) {
      env = {
        v: 1,
        seq: 0,
        at: Date.now(),
        type,
        ...data,
        persistError: e?.message ?? String(e),
      };
    }
    this.onEvent(env);
    return env;
  }

  eventsSince(seq, filters) {
    return this.ledger.eventsSince(seq, filters);
  }

  // ---- 花名册 ----

  /**
   * 新建 bot。
   * full/yolo 是明确的安全降级，必须由用户专用设置入口显式确认；模板导入绝不带授权。
   */
  addBot(input = {}) {
    const { executionMode, approvalMode } = resolvePermission(input, null);
    const id = genId("bot");
    const model = input.model ?? "";
    const bot = makeBot({
      id,
      name: input.name,
      role: input.role ?? "",
      instructions: input.instructions ?? "",
      model,
      thinking: input.thinking ?? this.defaultThinking ?? "",
      isMain: !!input.isMain,
      executionMode,
      approvalMode,
      workspace: input.workspace ?? "",
      memoryEnabled: input.memoryEnabled ?? false,
      skills: input.skills ?? null,
      budget: input.budget ?? null,
      avatar: input.avatar === undefined ? null : this._checkAvatar(input.avatar, { id, isMain: !!input.isMain }),
    });
    this.store.putBot(bot);
    this.team.writeIdentity(bot);
    this.team.commit(`身份：新建 ${bot.name}`);
    this.emit("bot_added", { bot });
    return bot;
  }

  getBot(id) {
    return this._syncIdentity(normalizeBot(this.store.getBot(id)));
  }

  /**
   * 校验接口传来的头像改动，返回合并后的头像。形状规则在 validateAvatarPatch；
   * 新换的图片还要查附件登记：必须是这个 bot 自己上传的 PNG、JPEG、GIF 或 WebP。
   * 没换图片时不再查，附件后来被删了也不挡别的改动，界面会退回吉祥物。
   */
  _checkAvatar(patch, { id, isMain = false, current = null }) {
    let avatar;
    try {
      avatar = validateAvatarPatch(patch, { id, isMain, current });
    } catch (e) {
      throw httpErr(e.status ?? 400, e.message, e.code ?? "avatar_invalid");
    }
    const attachmentId = avatarAttachmentId(avatar.url);
    if (attachmentId && avatar.url !== current?.url) {
      const rec = this.features?.attachments?.get?.(attachmentId);
      if (!rec) throw httpErr(400, "这张图片不在附件里，重新上传一次", "avatar_url_invalid");
      if (rec.botId !== id) throw httpErr(400, "这张图片是别的助手的附件，给这个助手重新上传", "avatar_url_invalid");
      if (!AVATAR_MIMES.has(rec.mime)) throw httpErr(400, "头像只支持 PNG、JPEG、GIF 和 WebP 图片", "avatar_url_invalid");
    }
    return avatar;
  }

  listBots() {
    return this.store.listBots().map((b) => this._syncIdentity(normalizeBot(b))).filter(Boolean);
  }

  // ---- 团队目录 ----

  /**
   * 建团队目录，升级后第一次启动复制旧数据；花名册里每个 bot 都要有身份块
   * （老 bot 第一次启动时补上，已有文件以文件为准）。带回旧记忆的 bot 在身份块里多一句提示。
   */
  _ensureTeam() {
    if (this.team.readonly) return;
    this.team.ensure();
    const bots = this.store.listBots().map(normalizeBot).filter(Boolean);
    const migrated = this.team.migrate(bots);
    const added = [];
    const noted = [];
    for (let bot of bots) {
      if (this.team.readIdentity(bot.id)) {
        bot = this._syncIdentity(bot);
        if (migrated?.bots?.[bot.id]?.oldMemory && this.team.writeIdentity(bot)) noted.push(bot.name);
        continue;
      }
      if (this.team.writeIdentity(bot)) added.push(bot.name);
    }
    if (added.length) this.team.commit(`身份：补上 ${added.join("、")}`);
    if (noted.length) this.team.commit(`身份：${noted.join("、")} 加上旧记忆提示`);
  }

  /**
   * 用户或 bot 在 AGENTS.md 里改了身份块，以文件为准回填花名册。
   * 只比较名字、角色、专属指令；文件没变时只多一次 stat。
   */
  _syncIdentity(bot) {
    if (!bot || this.team.readonly) return bot;
    const parsed = this.team.readIdentityIfChanged(bot.id);
    if (!parsed) return bot;
    const current = identityFields(bot);
    const patch = {};
    if (parsed.name && parsed.name !== current.name) patch.name = parsed.name;
    if (parsed.role !== current.role) patch.role = parsed.role;
    if (parsed.instructions !== current.instructions) patch.instructions = parsed.instructions;
    if (!Object.keys(patch).length) return bot;
    const next = normalizeBot({ ...bot, ...patch });
    if (!next) return bot;
    this.store.putBot(next);
    this.emit("bot_updated", { bot: next, source: "agents-file" });
    this.team.commit(`身份：${next.name} 在 AGENTS.md 里改了${identityChangeLabel(patch)}`);
    return next;
  }

  /** 团队目录状态：没有 git 时界面提示装 Git 才有改动历史。 */
  teamStatus() {
    return this.team.status();
  }

  /**
   * 装技能。target=library 进共享库，target=bot 只给这个 bot；库里和各 bot 的私有技能不许重名。
   * 从某个 bot 的面板装进共享库、而它用的是白名单时，顺手把新技能加进它的白名单。
   * 不用手动重启：技能目录进了复用签名，下一轮对话前进程自动重建。
   */
  installSkill({ botId, target, path, content } = {}) {
    const bot = botId ? this.getBot(botId) : null;
    if (botId && !bot) throw httpErr(404, `未知 Bot：${botId}`, "bot_not_found");
    const nameOf = (id) => this.getBot(id)?.name ?? id;
    const result = this.team.installSkill({
      target,
      botId,
      path,
      content,
      describe: (hit) => (hit.scope === "library" ? "共享库里" : `${nameOf(hit.botId)} 的私有技能里`),
    });
    let whitelist = bot?.skills ?? null;
    if (target === "library" && bot && Array.isArray(bot.skills) && !bot.skills.includes(result.name)) {
      whitelist = this.updateBot(bot.id, { skills: [...bot.skills, result.name] }).skills;
    }
    this.team.commit(target === "library" ? `技能：装进共享库 ${result.name}` : `技能：给 ${bot.name} 装上 ${result.name}`);
    this.emit("skills_changed", { ...result, by: botId ?? null });
    return { ...result, whitelist };
  }

  removeBot(id) {
    this.store.removeBot(id);
    for (const ctrl of [...this.runs.values()]) {
      if (ctrl.run.botId === id && !isTerminalRunState(this.getRun(ctrl.run.id)?.state ?? "")) {
        this._background(this.cancelRun(ctrl.run.id, "bot-removed"));
      }
    }
    this._stopRuntimesFor(id);
    this.emit("bot_removed", { id });
  }

  /**
   * 更新 bot 可变字段。影响进程策略的字段变了 → 重建 runtime。
   * 同步返回更新后的记录（CLI/HTTP 形状不变）；重建会等 runtime 空闲或用户显式取消，
   * 不是 fire-and-forget：新一轮开始前 runtimeFor 一定等到旧进程真的停掉。
   */
  updateBot(id, patch = {}) {
    const bot = this.getBot(id);
    if (!bot) return null;
    // 档位只经 resolvePermission 写入：旧字段和三档都归一成一种组合，升到全部放手要确认。
    patch = { ...patch, ...resolvePermission(patch, bot) };
    if (patch.budget !== undefined) normalizeBudget(patch.budget, "bot.budget");
    if (patch.allowedCommands !== undefined) {
      try {
        patch = { ...patch, allowedCommands: normalizeAllowedCommands(patch.allowedCommands) };
      } catch (e) {
        throw httpErr(400, e.message, "allowed_commands_invalid");
      }
    }
    if (patch.avatar !== undefined) {
      patch = { ...patch, avatar: this._checkAvatar(patch.avatar, { id, isMain: patch.isMain ?? bot.isMain, current: bot.avatar }) };
    }
    const next = { ...bot };
    for (const k of [
      "name", "role", "instructions", "model", "thinking", "isMain",
      "executionMode", "approvalMode", "workspace", "memoryEnabled", "skills", "budget", "computer", "avatar",
      "allowedCommands",
    ]) {
      if (patch[k] !== undefined) next[k] = patch[k];
    }
    const affectsRuntime = [
      "instructions", "model", "thinking", "role", "executionMode", "approvalMode",
      "workspace", "memoryEnabled", "skills", "budget", "computer", "allowedCommands",
    ].some((k) => JSON.stringify(patch[k]) !== JSON.stringify(bot[k]) && patch[k] !== undefined);
    const normalized = normalizeBot({ ...next, id });
    if (!normalized) throw httpErr(400, "更新后的 bot 记录不合法", "bot_invalid");
    this.store.putBot(normalized);
    const identityPatch = Object.fromEntries(
      Object.entries(identityFields(normalized)).filter(([k, v]) => v !== identityFields(bot)[k]),
    );
    if (normalized.isMain !== bot.isMain) identityPatch.isMain = true;
    if (Object.keys(identityPatch).length && this.team.writeIdentity(normalized)) {
      this.team.commit(`身份：${normalized.name} 改了${identityChangeLabel(identityPatch)}`);
    }
    this.emit("bot_updated", { bot: normalized });
    if (affectsRuntime) {
      const active = this._activeRunIdsForBot(id);
      this.emit("bot_policy_changed", {
        botId: id,
        activeRuns: active,
        pendingRestart: active.length > 0,
      });
      this._scheduleRestart(id);
    }
    return normalized;
  }

  _activeRunIdsForBot(botId) {
    return [...this.runs.values()]
      .filter((c) => c.run.botId === botId && !isTerminalRunState(this.getRun(c.run.id)?.state ?? ""))
      .map((c) => c.run.id);
  }

  /**
   * 登记策略重建：等该 bot 的 runtime 空闲（或用户取消掉活跃 Run）后停掉旧进程。
   * 新一轮的 runtimeFor 会 await 这个 promise，所以不会出现两个进程同写一个会话目录。
   */
  _scheduleRestart(botId, reason = "policy-change") {
    const prev = this._pendingRestart.get(botId) ?? Promise.resolve();
    const task = prev
      .catch(() => {})
      .then(() => this._rebuildRuntimesFor(botId, reason));
    const tracked = this._background(task);
    this._pendingRestart.set(botId, tracked);
    tracked.finally(() => {
      if (this._pendingRestart.get(botId) === tracked) this._pendingRestart.delete(botId);
    });
    return tracked;
  }

  async _rebuildRuntimesFor(botId, reason = "policy-change") {
    const keys = [...this.runtimes.keys()].filter((k) => k.startsWith(`${botId}::`));
    for (const key of keys) {
      const rt = this.runtimes.get(key);
      if (!rt) continue;
      // 等空闲或用户显式取消，且必须有界：不做空转轮询，也不无限等下去。
      const deadline = Date.now() + this.policyIdleTimeoutMs;
      while (rt.busy && !this.closing && Date.now() < deadline) {
        const budget = Math.max(200, Math.min(5_000, deadline - Date.now()));
        let settled = false;
        try {
          settled = (await rt.waitSettled({ timeoutMs: budget })).settled === true;
        } catch {
          settled = false;
        }
        if (settled) break;
        await new Promise((resolveP) => setTimeout(resolveP, 250));
      }
      if (rt.busy) {
        // 用户没取消也没停：如实报出，不偷偷杀掉进行中的回合；同时把 runtime 标成待重建，
        // 保证配置变更不会被静默丢掉（下一次空闲调用一定重建）。
        rt.staleReason = reason;
        this.emit("bot_restart_blocked", {
          botId,
          scope: rt.scope,
          error: "运行中未能空闲，策略将在本回合结束后生效",
        });
        continue;
      }
      await rt.stop();
      this.runtimes.delete(key);
      this.emit("bot_restarted", { botId, scope: rt.scope });
    }
  }

  /**
   * 公开的安全重启入口（供特性层改项目级 MCP/skills 等配置后调用）：
   * 等该 bot 的 runtime 空闲（或用户取消，有界）后真的停掉旧进程；期间 runtimeFor 会等这个屏障，
   * 不会出现两个原生进程写同一个会话目录。返回是否真的重启完成，不谎报。
   */
  async restartBotRuntimes(botId, { reason = "config-change" } = {}) {
    if (!this.getBot(botId)) throw httpErr(404, `未知 bot: ${botId}`, "bot_not_found");
    if (this.closing) throw httpErr(503, "团队正在关闭，无法重启 runtime");
    this.emit("bot_restart_requested", { botId, reason });
    await this._scheduleRestart(botId, reason);
    const remaining = [...this.runtimes.entries()]
      .filter(([k]) => k.startsWith(`${botId}::`))
      .map(([k, rt]) => ({ scope: rt.scope ?? k.split("::")[1], busy: rt.busy === true }));
    return {
      restarted: remaining.length === 0,
      blocked: remaining.length ? { scopes: remaining, reason: "busy" } : null,
    };
  }

  /**
   * 该 bot 是否有 runtime 正在跑回合（特性层写配置前应先检查，避免与活跃运行抢会话目录）。
   * 先看「已准入但还没把 rt.busy 立起来」的 Run（queued/starting/running），否则
   * startRun 已预留租约、进程还在起的过程中会被当成空闲，特性层就会在活跃 Run 上改配置。
   */
  botRuntimeBusy(botId) {
    if (this._activeRunIdsForBot(botId).length > 0) return true;
    for (const [key, rt] of this.runtimes) {
      if (key.startsWith(`${botId}::`) && rt.busy) return true;
    }
    return false;
  }

  /** 停掉某 bot 的所有 runtime（下次用到会按新策略懒启动）。 */
  _stopRuntimesFor(botId) {
    for (const [key, rt] of this.runtimes) {
      if (key.startsWith(`${botId}::`)) {
        this.runtimes.delete(key);
        this._background(rt.stop());
      }
    }
  }

  // ---- 群 ----

  createRoom({ name, members = [], adminId = null, mode = "admin" }) {
    const ids = members.map((m) => (typeof m === "string" ? m : m.id));
    const resolvedAdmin = adminId ?? ids[0] ?? null;
    const room = makeRoom({ id: genId("room"), name, members: ids, adminId: resolvedAdmin, mode });
    this.store.putRoom(room);
    this.emit("room_created", { roomId: room.id, name: room.name, members: ids });
    return room;
  }

  getRoom(id) {
    return this.store.getRoom(id);
  }

  listRooms() {
    return this.store.listRooms();
  }

  updateRoom(id, patch = {}) {
    const room = this.getRoom(id);
    if (!room) return null;
    const next = { ...room };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.mode !== undefined) next.mode = patch.mode;
    if (Array.isArray(patch.members)) next.members = [...patch.members];
    if (patch.adminId !== undefined) next.adminId = patch.adminId;
    this.store.putRoom(next);
    this.emit("room_updated", { room: next });
    return next;
  }

  removeRoom(id) {
    this.store.removeRoom(id);
    for (const ctrl of [...this.runs.values()]) {
      if (ctrl.run.roomId === id && !isTerminalRunState(this.getRun(ctrl.run.id)?.state ?? "")) {
        this._background(this.cancelRun(ctrl.run.id, "room-removed"));
      }
    }
    for (const [key, rt] of this.runtimes) {
      if (key.endsWith(`::room:${id}`)) {
        this.runtimes.delete(key);
        this._background(rt.stop());
      }
    }
    this.emit("room_removed", { id });
  }

  /** 按名字或 id 解析 bot；名字大小写不敏感，最长名优先。 */
  resolveBot(nameOrId) {
    if (!nameOrId) return null;
    const bots = this.listBots();
    const byId = bots.find((b) => b.id === nameOrId);
    if (byId) return byId;
    const q = String(nameOrId).trim().toLowerCase();
    const exact = bots.find((b) => b.name.toLowerCase() === q);
    if (exact) return exact;
    const partial = bots
      .filter((b) => b.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.length - b.name.length)[0];
    return partial ?? null;
  }

  // ---- runtime 池 ----

  /**
   * 取（或懒建）某 bot 在某 scope 的 runtime，并确保已启动。
   * 策略签名不一致 → 先等旧进程停掉再重建，宽权限进程不承接收窄后的 Run。
   * @param {string} botId
   * @param {string} scope "private" | "room:<roomId>"
   * @param {object} [o] {runId}
   */
  async runtimeFor(botId, scope = "private", o = {}) {
    if (this.closing) throw httpErr(503, "团队正在关闭，无法启动新的 Bot 会话");
    const key = `${botId}::${scope}`;
    // 策略变更遗留的重建必须先落地，避免新旧两个进程同写一个会话目录。
    const pending = this._pendingRestart.get(botId);
    if (pending) await pending;
    if (this.closing) throw httpErr(503, "团队正在关闭，无法启动新的 Bot 会话");

    const bot = this.getBot(botId);
    if (!bot) throw httpErr(404, `未知 bot: ${botId}`);
    // 群回合按成员逐个进来，接管暂停也要在这里挡住。
    this._assertNotPaused(botId, scope);

    let rt = this.runtimes.get(key);
    if (rt && (rt.staleReason || !rt.matchesPolicy(bot))) {
      if (rt.busy) {
        // 回合进行中不打断，也不假装已重载：本次沿用旧进程（租约保证不会开第二个运行），
        // 等它空闲后，下一次 runtimeFor 会因 staleReason 真正重建。
        this.emit("runtime_restart_deferred", {
          botId,
          scope,
          reason: rt.staleReason ?? "policy-signature-changed",
        });
      } else {
        const reason = rt.staleReason ?? "policy-signature-changed";
        await rt.stop();
        this.runtimes.delete(key);
        this.emit("runtime_rebuilt", { botId, scope, reason });
        rt = null;
      }
    }
    if (!rt) {
      rt = this.runtimeFactory({
        bot,
        scope,
        home: this.home,
        bin: this.bin,
        debug: this.debug,
        teamToolsFactory: (runtime) => this._buildTeamTools(bot, runtime),
      });
      this._wireRuntime(rt, botId, scope);
      this.runtimes.set(key, rt);
    }
    if (!rt.alive) await rt.start();
    if (this.closing) throw httpErr(503, "团队正在关闭，无法接收新的消息");
    if (o.runId) rt.lastRunId = o.runId;
    return rt;
  }

  _wireRuntime(rt, botId, scope) {
    rt.on?.("native_frame", (frame) => this._onNativeFrame(rt, botId, scope, frame));
    rt.on?.("ui_request", (frame) => this._onUiRequest(rt, botId, scope, frame));
    rt.on?.("native_exit", (info) => this._onRuntimeExit(rt, botId, scope, info));
    rt.on?.("capabilities", (caps) => {
      this.emit("runtime_capabilities", { botId, scope, ...caps });
    });
    rt.on?.("native_error", (info) => {
      this.emit("native_error", {
        runId: this._activeRunIdForRuntime(rt),
        botId,
        scope,
        ...info,
      });
    });
    rt.on?.("tool_surface_blocked", (info) => {
      // chat 档工具面越界：runtime 拒绝运行，这里如实上报，不能静默降级。
      this.emit("runtime_blocked", {
        runId: this._activeRunIdForRuntime(rt),
        botId,
        scope,
        ...info,
      });
    });
  }

  /** 原生帧 → 工作台事件（原样透传，另按类型挂子代理/待办/目标投影）。 */
  _onNativeFrame(rt, botId, scope, frame) {
    if (!frame || typeof frame !== "object") return;
    const projected = this._projectFrame(frame);
    if (!projected) return; // 物理分块等不投影的帧
    const runId = this._activeRunIdForRuntime(rt);
    this.emit("native_event", { runId, botId, scope, event: projected });
    this._watchStuck(runId, botId, scope, frame);
    const t = String(projected.type ?? "");
    if (/subagent|task/i.test(t)) {
      const subagentId = projected.subagentId ?? projected.subagent?.id ?? projected.targetId ?? null;
      if (subagentId && rt.activeRun) {
        const ctrl = this.runs.get(runId);
        if (ctrl) ctrl.subagentIds.add(subagentId);
      }
      this.emit("subagent_update", { runId, botId, scope, event: projected });
    } else if (/todo/i.test(t)) {
      this.emit("todos_update", { runId, botId, scope, event: projected });
    } else if (/goal/i.test(t)) {
      this.emit("goal_update", { runId, botId, scope, event: projected });
    }
  }

  /**
   * 卡住检测：同样的工具调用得到同样的结果反复出现，先插一句换策略，再犯就取消。
   * 用原始帧算指纹（投影帧可能被截断）；检测器挂在 Run 上，Run 结束就跟着丢。
   */
  _watchStuck(runId, botId, scope, frame) {
    const ctrl = runId ? this.runs.get(runId) : null;
    if (!ctrl?.stuck || ctrl.cancelling || ctrl.finished) return;
    const hit = ctrl.stuck.observe(frame);
    if (!hit) return;
    this.emit("run_stuck", { runId, botId, scope, action: hit.action, toolName: hit.toolName, count: hit.count });
    if (hit.action === "steer") {
      this._background(
        this.steerRun(runId, stuckSteerText(hit.toolName, hit.count)).catch((e) => {
          // 回合恰好结束时 steer 会 409，这不算错：下一次再重复就会被取消。
          if (e?.status !== 409) throw e;
        }),
      );
    } else {
      this._background(
        this.cancelRun(runId, stuckCancelReason(hit.toolName, hit.count)),
      );
    }
  }

  /**
   * 帧投影：只让「可重放、可公开」的帧进台账与 SSE。
   * - v2 物理分块帧（base64 大块）直接丢弃：重组后的逻辑帧才是内容，重复保存纯浪费；
   * - response 等帧里的凭据字段脱敏；
   * - 单帧超过上限时只留摘要，绝不把大块内容塞进事件表。
   */
  _projectFrame(frame) {
    if (frame.type === "rpc_chunk") return null;
    let json = "";
    try {
      json = JSON.stringify(frame);
    } catch {
      return { type: frame.type ?? null, id: frame.id ?? null, unserializable: true };
    }
    if (json.length > NATIVE_EVENT_MAX_BYTES) {
      return { type: frame.type ?? null, id: frame.id ?? null, truncated: true, bytes: json.length };
    }
    return redactFrame(frame, 0);
  }

  /** 当前回合的 Run id；没有活跃回合时返回 null（不把帧挂到已结束的 Run 上）。 */
  _activeRunIdForRuntime(rt) {
    const active = rt.activeRun?.runId;
    if (active) return active;
    const last = rt.lastRunId ?? null;
    if (!last) return null;
    const run = this.getRun(last);
    return run && !isTerminalRunState(run.state) ? last : null;
  }

  /** 原生进程退出：活跃 Run 不能假装完成，按效果未知落定。 */
  _onRuntimeExit(rt, botId, scope, info) {
    const runId = rt.activeRun?.runId ?? rt.lastRunId ?? null;
    this.emit("runtime_exit", { runId, botId, scope, code: info?.code, signal: info?.signal });
    if (!runId) return;
    const ctrl = this.runs.get(runId);
    const run = this.getRun(runId);
    if (!ctrl || !run || isTerminalRunState(run.state)) return;
    ctrl.cancelled = true;
    this._background(
      this._finishRun(runId, RUN_STATES.RECONCILIATION_REQUIRED, {
        error: `原生进程退出（code=${info?.code} signal=${info?.signal}），动作效果未知`,
        recovery: { status: "side_effect_unknown", reason: "runtime_exit", at: Date.now() },
      }),
    );
  }

  // ---- 团队事实提议 ----
  //
  // 共识层 team/AGENTS.md 只有用户和主助手改。其他成员发现团队都该知道的事，用 propose_team_fact 提议，
  // 带来源；用户在工作台或主助手用 review_team_proposals 接受后，写进文件里的团队事实块并自动提交。
  // 替换旧事实时按文件现状核对旧事实还在不在，不在就拒绝、提示重提，不覆盖别人刚改过的。
  // 被纠正掉的旧说法记在已接受的记录里（replaces），之后再提同样的旧说法当场拒绝。

  _teamAgentsPath() {
    return join(this.team.root, "AGENTS.md");
  }

  _readTeamAgents() {
    try {
      return readFileSync(this._teamAgentsPath(), "utf8");
    } catch (e) {
      if (e?.code === "ENOENT") return "";
      throw e;
    }
  }

  _writeTeamAgents(text) {
    const file = this._teamAgentsPath();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  }

  /** 当前团队事实（文件里的现状）。 */
  listTeamFacts() {
    return readFacts(this._readTeamAgents()).map(({ text, line }) => ({ text, line }));
  }

  listTeamProposals({ state = null, limit = 200 } = {}) {
    const all = this.ledger.list("team_proposals", { limit: 1000 }) ?? [];
    return all.filter((p) => !state || p.state === state).slice(0, Math.max(1, Math.min(1000, limit)));
  }

  getTeamProposal(id) {
    return this.ledger.get("team_proposals", id) ?? null;
  }

  _putTeamProposal(rec) {
    const next = { ...rec, updatedAt: Date.now() };
    this.ledger.put("team_proposals", next);
    this.emit("team_proposal", { proposalId: next.id, botId: next.botId ?? undefined, state: next.state });
    return next;
  }

  /** 被纠正掉的旧说法 → 现在的说法（沿着替换链走到文件里还在的那条）。 */
  _correctedTo(fact, agentsText) {
    const replaced = new Map();
    for (const p of this.listTeamProposals({ state: "accepted", limit: 1000 }).slice().reverse()) {
      if (p.replaces) replaced.set(normalizeFact(p.replaces), normalizeFact(p.fact));
    }
    let cur = normalizeFact(fact);
    if (!replaced.has(cur) || hasFact(agentsText, cur)) return null;
    const seen = new Set();
    while (replaced.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = replaced.get(cur);
      if (hasFact(agentsText, cur)) return cur;
    }
    return cur;
  }

  /** 按文件现状核对一条事实能不能写；能写返回 null，否则返回 {code, message}。 */
  _teamFactProblem({ fact, replaces }, agentsText, { atAccept = false } = {}) {
    if (replaces && !hasFact(agentsText, replaces)) {
      return atAccept
        ? { code: "fact_changed", message: `要替换的旧事实「${replaces}」已经被改过或删掉了，这条提议作废，请按团队事实块的最新内容重提。` }
        : { code: "fact_not_found", message: `没找到要替换的事实「${replaces}」。先读 team 根下 AGENTS.md 的团队事实块，replaces 照抄里面那一条的原文（不含来源括注）。` };
    }
    if (hasFact(agentsText, fact)) return { code: "fact_exists", message: `团队事实里已经有这条：「${fact}」。` };
    const corrected = this._correctedTo(fact, agentsText);
    if (corrected) return { code: "fact_corrected", message: `「${fact}」已经被纠正为「${corrected}」，不再写回。要改就提议替换现在那条。` };
    return null;
  }

  _cleanTeamFactInput({ fact, source, replaces }) {
    const raw = String(fact ?? "");
    if (/[\r\n]/.test(raw.trim())) throw httpErr(400, "一条事实一行写完，不要换行。", "bad_fact");
    const text = normalizeFact(raw);
    if (!text) throw httpErr(400, "事实不能为空。", "bad_fact");
    if (text.length > FACT_MAX_CHARS) throw httpErr(400, `一条事实最多 ${FACT_MAX_CHARS} 字。`, "bad_fact");
    const src = normalizeFact(source);
    if (!src) throw httpErr(400, "要写清来源：这条事实从哪来。", "bad_source");
    const old = replaces == null || String(replaces).trim() === "" ? null : normalizeFact(replaces);
    if (old && old === text) throw httpErr(400, "新旧事实一样，不用替换。", "bad_fact");
    return { fact: text, source: src, replaces: old };
  }

  _assertTeamWritable() {
    if (this.team.readonly) throw httpErr(409, "只读副本不改团队目录。", "readonly");
  }

  /** bot 提议一条团队事实。同样的提议已在等就返回那条，不重复记。 */
  proposeTeamFact(bot, input) {
    this._assertTeamWritable();
    const clean = this._cleanTeamFactInput(input ?? {});
    const problem = this._teamFactProblem(clean, this._readTeamAgents());
    if (problem) throw httpErr(409, problem.message, problem.code);
    const same = this.listTeamProposals({ state: "pending" }).find((p) => p.fact === clean.fact && (p.replaces ?? null) === clean.replaces);
    if (same) return { proposal: same, duplicate: true };
    const now = Date.now();
    const rec = this._putTeamProposal({
      id: genId("tfp"),
      botId: bot?.id ?? null,
      botName: bot?.name ?? null,
      ...clean,
      state: "pending",
      createdAt: now,
    });
    return { proposal: rec, duplicate: false };
  }

  _deciderName(by) {
    if (by?.kind === "bot") return this.getBot(by.botId)?.name ?? by.botId;
    return "用户";
  }

  _assertCanDecide(by) {
    if (by?.kind === "user") return;
    if (by?.kind === "bot" && this.getBot(by.botId)?.isMain === true) return;
    throw httpErr(403, "只有用户和主助手能确认团队事实。", "not_allowed");
  }

  /** 用户或主助手接受、拒绝一条提议。接受时按文件现状再核对一次，冲突就记 conflict 并报 409。 */
  decideTeamProposal(id, { decision, by, reason = null } = {}) {
    this._assertCanDecide(by);
    const rec = this.getTeamProposal(id);
    if (!rec) throw httpErr(404, `没有这条提议：${id}`, "not_found");
    if (rec.state !== "pending") throw httpErr(409, `这条提议已经处理过了（${rec.state}）。`, "already_decided");
    const decidedBy = by.kind === "bot" ? { kind: "bot", botId: by.botId } : { kind: "user" };
    const decided = { decidedBy, decidedAt: Date.now() };
    if (decision === "reject") {
      return this._putTeamProposal({ ...rec, ...decided, state: "rejected", reason: reason ? String(reason).slice(0, 500) : null });
    }
    if (decision !== "accept") throw httpErr(400, "decision 只能是 accept 或 reject。", "bad_decision");
    this._assertTeamWritable();
    const text = this._readTeamAgents();
    const problem = this._teamFactProblem(rec, text, { atAccept: true });
    if (problem) {
      this._putTeamProposal({ ...rec, ...decided, state: "conflict", reason: problem.message, conflictCode: problem.code });
      throw httpErr(409, problem.message, problem.code);
    }
    this._writeTeamAgents(applyFact(text, rec));
    const out = this._putTeamProposal({ ...rec, ...decided, state: "accepted", reason: null });
    this.team.commit(`团队事实：${this._deciderName(by)}接受了 ${rec.botName ?? "用户"} 的提议`);
    return out;
  }

  /** 用户（或主助手）直接加一条或纠正一条：记一条已接受的提议，冲突同样拒绝。 */
  addTeamFact({ fact, source, replaces = null, by } = {}) {
    this._assertCanDecide(by);
    this._assertTeamWritable();
    const clean = this._cleanTeamFactInput({ fact, source, replaces });
    const text = this._readTeamAgents();
    const problem = this._teamFactProblem(clean, text, { atAccept: true });
    if (problem) throw httpErr(409, problem.message, problem.code);
    this._writeTeamAgents(applyFact(text, clean));
    const now = Date.now();
    const name = this._deciderName(by);
    const rec = this._putTeamProposal({
      id: genId("tfp"),
      botId: by.kind === "bot" ? by.botId : null,
      botName: by.kind === "bot" ? name : null,
      ...clean,
      state: "accepted",
      direct: true,
      decidedBy: by.kind === "bot" ? { kind: "bot", botId: by.botId } : { kind: "user" },
      decidedAt: now,
      createdAt: now,
    });
    this.team.commit(`团队事实：${name}${clean.replaces ? "纠正了一条" : "加了一条"}`);
    return rec;
  }

  _handleProposeTeamFact(bot, args) {
    try {
      const { proposal, duplicate } = this.proposeTeamFact(this.getBot(bot.id) ?? bot, args ?? {});
      const what = proposal.replaces ? `替换「${proposal.replaces}」为「${proposal.fact}」` : `「${proposal.fact}」`;
      return {
        text: duplicate
          ? `同样的提议已经在等确认了（编号 ${proposal.id}）：${what}。`
          : `已提议${what}，等用户或主助手确认（编号 ${proposal.id}）。确认前不会写进团队共识。`,
      };
    } catch (e) {
      return { text: e?.message ?? String(e), isError: true };
    }
  }

  _handleReviewTeamProposals(bot, args = {}) {
    const by = { kind: "bot", botId: bot.id };
    try {
      this._assertCanDecide(by);
      if (args.action === "list") {
        const pending = this.listTeamProposals({ state: "pending" });
        if (!pending.length) return { text: "没有待确认的团队事实提议。" };
        return {
          text: pending
            .map((p) => `- ${p.id}：${p.replaces ? `把「${p.replaces}」改成「${p.fact}」` : `新增「${p.fact}」`}（来源：${p.source}；${p.botName ?? "用户"} 提议）`)
            .join("\n"),
        };
      }
      if (!args.id) return { text: "accept/reject 要带提议编号 id（先 list）。", isError: true };
      const out = this.decideTeamProposal(String(args.id), { decision: args.action, by, reason: args.reason ?? null });
      return { text: out.state === "accepted" ? `已接受，写进团队共识：「${out.fact}」。` : `已拒绝：「${out.fact}」。` };
    } catch (e) {
      return { text: e?.message ?? String(e), isError: true };
    }
  }

  /** 团队工具集 + Features 提供的受控宿主工具（chat 档只留后者）。 */
  _buildTeamTools(bot, runtime) {
    const tools = [];
    if (bot.executionMode !== "chat") {
      tools.push(
        {
          name: "message_bot",
          label: "Message Bot",
          description:
            "给团队里的另一个 bot 发消息，并同步拿到它的回复。用于把一个子任务委派给更合适的队友，或向队友询问信息。",
          parameters: MESSAGE_BOT_SCHEMA,
          handler: (args, meta) => this._handleMessageBot(bot, runtime, args, meta),
        },
        {
          name: "delegate_bot",
          label: "Delegate Bot",
          description:
            "把任务派给另一个 bot 后台执行，立即返回（不等待结果）。先用 list_bots 按角色挑人；简单、量大的活优先派给用便宜模型的队友。对方正忙就排队，空了自动开跑。做完后结果会作为一条新消息交回给你，由你验收。用于可以并行推进的工作。",
          parameters: DELEGATE_BOT_SCHEMA,
          handler: (args, meta) => this._handleDelegateBot(bot, runtime, args, meta),
        },
      );
    }
    if (typeof this.features.hostTools === "function") {
      tools.push(...this.features.hostTools(runtime));
    }
    // 提议不改任何东西，只聊天档也给；接受只给主助手（调用时再核对一次身份）。
    tools.push({
      name: "propose_team_fact",
      label: "Propose Team Fact",
      description:
        "提议一条团队都该知道的事实（约定、资料位置、纠正过的说法），必须写来源。用户或主助手接受后才写进 team 根下 AGENTS.md 的团队事实块。改一条已有的事实时用 replaces 照抄旧的那条。不要直接改团队 AGENTS.md。",
      parameters: PROPOSE_TEAM_FACT_SCHEMA,
      handler: (args) => this._handleProposeTeamFact(bot, args),
    });
    if (bot.isMain === true) {
      tools.push({
        name: "review_team_proposals",
        label: "Review Team Proposals",
        description:
          "主助手专用：列出成员提议的团队事实（list），接受（accept）或拒绝（reject）。接受时如果要替换的旧事实已经被改，会被拒，让提议的成员按最新内容重提。拿不准就留给用户在工作台确认。",
        parameters: REVIEW_TEAM_PROPOSALS_SCHEMA,
        handler: (args) => this._handleReviewTeamProposals(bot, args),
      });
    }
    tools.push({
      name: "list_bots",
      label: "List Bots",
      description: "列出团队里所有 bot 的名字、id、角色、模型和工作区，供你决定 message_bot/delegate_bot 的收件人。",
      parameters: LIST_BOTS_SCHEMA,
      handler: () => this._handleListBots(bot),
    });
    return tools;
  }

  async _handleListBots(self) {
    const rows = this.listBots()
      .filter((b) => b.id !== self.id)
      .map((b) => {
        const sameWorkspace = (b.workspace ?? "") === (self.workspace ?? "");
        // 不输出别的工作区的目录路径（那是私有上下文），只如实标注可否委派。
        const scopeNote = sameWorkspace ? "" : " [其他工作区：不共享上下文，不可委派]";
        // 带上模型：简单活派给便宜模型的队友，难活派给强模型的。模型名不是私有信息。
        const modelNote = b.model ? ` · 模型 ${b.model}` : "";
        return `- ${b.name} (@${b.id})${b.role ? ` — ${b.role}` : ""}${modelNote}${scopeNote}`;
      });
    return { text: rows.length ? rows.join("\n") : "（团队里没有其他 bot）" };
  }

  /**
   * 委派准入：同工作区自动；越域（拿别的合作范围的私有上下文）一律拒绝。
   * 能力不扩权：以父 Run 的 bot 为准；万一拿不到父 Run（理论上不应发生），
   * 退回发起者自身做基准 —— 缺信息时只会收紧，不会放开。
   * 绑定共享电脑是加法，发送者自己就有本机工具，所以委派不再按电脑绑定设边界。
   */
  _assertDelegationAllowed(fromBot, target, parentRun) {
    if ((fromBot.workspace ?? "") !== (target.workspace ?? "")) {
      throw httpErr(
        403,
        `跨工作区私有上下文不共享：${fromBot.name} 与 ${target.name} 不在同一工作区，拒绝委派`,
        "cross_workspace_denied",
      );
    }
    const basis = parentRun?.botId ? (this.getBot(parentRun.botId) ?? fromBot) : fromBot;
    const effective = intersectExecutionMode(basis?.executionMode, target.executionMode);
    if (effective !== target.executionMode) {
      throw httpErr(
        403,
        `子任务不得扩权：${target.name}（${target.executionMode}）强于父运行（${basis?.executionMode}），拒绝委派`,
        "capability_expansion_denied",
      );
    }
  }

  /**
   * message_bot 投递：解析目标 → 准入 → 起子 Run → 同步等终态 → 回复作为 tool result。
   * hop 深度记在 fromRuntime.deliveryDepth，向下传递时 +1。目标忙 → 明确拒绝（不阻塞）。
   */
  async _handleMessageBot(fromBot, fromRuntime, args, meta) {
    const to = (args?.to ?? "").trim();
    const message = args?.message ?? "";
    const parentRunId = fromRuntime?.activeRun?.runId ?? null;
    const parentRun = parentRunId ? this.getRun(parentRunId) : null;
    // hop 以父 Run 的累计 depth 为准（跨 Run 传递），实例态 deliveryDepth 只做兜底。
    const hop = parentRun?.depth ?? fromRuntime?.deliveryDepth ?? 0;

    if (hop >= MAX_HOPS) {
      return {
        text: `投递被拒绝：bot 间消息链已达上限 ${MAX_HOPS} 跳，请自己直接回答用户。`,
        isError: true,
      };
    }
    const target = this.resolveBot(to);
    if (!target) return { text: `找不到名为「${to}」的 bot。用 list_bots 看看有谁。`, isError: true };
    if (target.id === fromBot.id) return { text: "不能给自己发消息。", isError: true };
    try {
      this._assertDelegationAllowed(fromBot, target, parentRun);
    } catch (e) {
      return { text: e.message, isError: true };
    }

    const ex = makeExchange({
      id: genId("ex"),
      from: fromBot.id,
      to: target.id,
      requestText: message,
      scope: "private",
    });
    ex.hop = hop;

    let child;
    try {
      child = this.startRun({
        botId: target.id,
        text: message,
        sender: `🤖 ${fromBot.name} (@${fromBot.id})`,
        source: "bot",
        parentRunId,
        depth: hop + 1,
        timeoutMs: DELIVER_TIMEOUT_MS,
      });
    } catch (e) {
      ex.status = "failed";
      ex.error = e?.message ?? String(e);
      this.store.recordExchange(ex);
      this.store.flushExchanges();
      return { text: `${target.name} 当前无法接收消息：${ex.error}`, isError: true };
    }

    this.store.recordExchange(ex);
    this.emit("exchange_request", { from: fromBot.name, to: target.name, message, hop, runId: child.id });

    // 宿主工具被取消（父回合 abort）→ 立刻撤掉这个子 Run，迟到结果不当作成功。
    const onAbort = () => this._background(this.cancelRun(child.id, "host-tool-cancelled"));
    if (meta?.signal) {
      if (meta.signal.aborted) onAbort();
      else meta.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const done = await this.waitRun(child.id, { timeoutMs: DELIVER_TIMEOUT_MS + 10_000 });
      if (done.state === RUN_STATES.COMPLETED) {
        ex.status = "replied";
        ex.replyText = done.reply;
        this.store.flushExchanges();
        this.emit("exchange_reply", {
          from: fromBot.name,
          to: target.name,
          reply: done.reply,
          runId: child.id,
        });
        return { text: `${target.name} 回复：\n${done.reply || "（空回复）"}` };
      }
      ex.status = "failed";
      ex.error = done.error ?? done.state;
      this.store.flushExchanges();
      this.emit("exchange_failed", {
        from: fromBot.name,
        to: target.name,
        error: ex.error,
        runId: child.id,
      });
      return { text: `${target.name} 未能回复：${ex.error}`, isError: true };
    } catch (e) {
      ex.status = "timeout";
      ex.error = e?.message ?? String(e);
      this.store.flushExchanges();
      this.emit("exchange_failed", { from: fromBot.name, to: target.name, error: ex.error, runId: child.id });
      // 等待超时 → 子 Run 走取消路径，不留孤儿回合。
      this._background(this.cancelRun(child.id, "delivery-timeout"));
      return { text: `${target.name} 未能回复：${ex.error}`, isError: true };
    } finally {
      meta?.signal?.removeEventListener?.("abort", onAbort);
    }
  }

  /** delegate_bot：非阻塞派活，立即返回子 Run id；子 Run 在工作台收件箱可见。 */
  async _handleDelegateBot(fromBot, fromRuntime, args, meta) {
    const to = (args?.to ?? "").trim();
    const message = args?.message ?? "";
    let acceptance;
    try {
      acceptance = normalizeAcceptance(args?.acceptance);
    } catch (e) {
      return { text: `派活被拒绝：${e.message}`, isError: true };
    }
    const parentRunId = fromRuntime?.activeRun?.runId ?? null;
    const parentRun = parentRunId ? this.getRun(parentRunId) : null;
    const hop = parentRun?.depth ?? fromRuntime?.deliveryDepth ?? 0;
    if (hop >= MAX_HOPS) {
      return { text: `派活被拒绝：委派链已达上限 ${MAX_HOPS} 跳。`, isError: true };
    }
    if (meta?.signal?.aborted) return { text: "父回合已取消，派活未执行。", isError: true };
    const target = this.resolveBot(to);
    if (!target) return { text: `找不到名为「${to}」的 bot。用 list_bots 看看有谁。`, isError: true };
    if (target.id === fromBot.id) return { text: "不能给自己派活。", isError: true };
    try {
      this._assertDelegationAllowed(fromBot, target, parentRun);
    } catch (e) {
      return { text: e.message, isError: true };
    }
    const rec = this._putDelegation({
      id: genId("dlg"),
      fromBotId: fromBot.id,
      fromName: fromBot.name,
      targetBotId: target.id,
      targetName: target.name,
      message,
      ...(acceptance.length ? { acceptance } : {}),
      parentRunId,
      depth: hop + 1,
      state: "queued",
      delivery: null,
      createdAt: Date.now(),
    });
    // 同一目标前面还有排队的：不插队，直接排到后面。
    const ahead = this._delegationRecords().filter(
      (r) => r.state === "queued" && r.targetBotId === target.id && r.id !== rec.id,
    ).length;
    const r = ahead ? { outcome: "busy" } : this._tryStartDelegation(rec, { inline: true });
    if (r.outcome === "started") {
      return {
        text: `已派给 ${target.name} 后台执行：run id=${r.child.id}。做完后结果会作为一条新消息交回给你，到时再验收；不用轮询。`,
      };
    }
    if (r.outcome === "busy") {
      this.emit("delegation_queued", {
        delegationId: rec.id,
        botId: target.id,
        fromBotId: fromBot.id,
        parentRunId,
        ahead,
      });
      return {
        text: `${target.name} 正忙，已排队（前面还有 ${ahead} 件），空了按顺序自动开跑。做完后结果会作为一条新消息交回给你。派活号 ${rec.id}。`,
      };
    }
    // 当场就被拒（预算、并发上限等）：报错已经直接给了父回合，不再另行唤醒。
    const cur = this.ledger.get("delegations", rec.id);
    if (cur?.delivery === "pending") this._dropDelivery(cur, "rejected_inline");
    return { text: `${target.name} 当前无法接手：${r.error}`, isError: true };
  }

  // ---- Run：准入与驱动 ----

  /**
   * 同步建 Run 并原子预留 scope 租约；异步执行失败也持久进 run。
   * @returns {object} 刚创建的 run 记录（state=starting）
   */
  startRun(input = {}, { allowFinishedParent = false, returnOf = null, treeRootId: returnTree = null } = {}) {
    if (this.closing) throw httpErr(503, "团队正在关闭，无法启动新的运行");
    const {
      botId = null,
      roomId = null,
      text,
      attachmentIds = [],
      timeoutMs,
      budget = null,
      source = "user",
      parentRunId = null,
      depth = 0,
      taskId = null,
      images,
      sender = null,
    } = input;

    if (typeof text !== "string" || (!text.trim() && !attachmentIds.length)) {
      throw httpErr(400, "text 必填（或至少一个附件）", "text_required");
    }
    if (!botId && !roomId) throw httpErr(400, "botId 或 roomId 必填", "target_required");
    if (taskId !== null && typeof taskId !== "string") {
      throw httpErr(400, "taskId 必须是字符串", "task_invalid");
    }
    if (!Number.isInteger(depth) || depth < 0) throw httpErr(400, "depth 必须是非负整数", "depth_invalid");
    if (depth > MAX_DELEGATE_DEPTH) {
      throw httpErr(409, `委派深度超限（上限 ${MAX_DELEGATE_DEPTH}）`, "depth_exceeded");
    }
    // 预算入口校验：标量/数组/NaN/负数/未知键一律显式拒绝，绝不静默当成「无限制」。
    const requestedBudget = normalizeBudget(budget, "run.budget");
    // 派工树：子 Run 跟父 Run 同一棵；交回的唤醒没有父 Run，由派活记录带来那棵树的根。
    let treeRootId = returnTree;
    if (parentRunId) {
      const parent = this.getRun(parentRunId);
      if (parent) treeRootId = this._treeRootOf(parent);
      if (!parent) throw httpErr(404, `父 Run 不存在: ${parentRunId}`, "parent_not_found");
      // 排队的派活可能在父回合结束后才开跑：仍挂在原父 Run 下（预算、取消、工作台都按这棵树）。
      if (isTerminalRunState(parent.state) && !allowFinishedParent) {
        throw httpErr(409, `父 Run 已结束（${parent.state}），不能派生新运行`, "parent_terminal");
      }
    }

    let kind;
    let scope;
    let leaseKey;
    if (roomId) {
      const room = this.getRoom(roomId);
      if (!room) throw httpErr(404, `未知群: ${roomId}`, "room_not_found");
      kind = "room";
      scope = `room:${roomId}`;
      leaseKey = scope;
    } else {
      const bot = this.getBot(botId);
      if (!bot) throw httpErr(404, `未知 bot: ${botId}`, "bot_not_found");
      if (bot.budgetInvalid) {
        // 旧记录里的非法预算不能当成「无限制」跑，先让用户修正。
        throw httpErr(400, `bot 的预算字段非法：${bot.budgetInvalid}`, "budget_invalid");
      }
      kind = parentRunId ? "delegation" : "chat";
      scope = "private";
      leaseKey = `bot:${botId}:private`;
    }

    // 原子准入：同一 scope 只允许一条运行链。忙目标明确拒绝（不排队、不死锁）。
    // 浏览器人工接管期间，该 bot/scope 不接受新回合（标志由 Features 维护）。
    if (botId) this._assertNotPaused(botId, scope);
    const held = this.leases.get(leaseKey);
    if (held) {
      throw httpErr(409, `${leaseKey} 已有运行在跑（${held}），拒绝并发启动`, "target_busy");
    }
    const rt = this.runtimes.get(`${botId}::${scope}`);
    if (rt && rt.busy) {
      throw httpErr(409, `bot 正忙，拒绝并发启动`, "target_busy");
    }

    // 预算/并发准入必须在 spawn 之前：额度耗尽或并发满员直接拒绝，不落记录不起进程。
    const effectiveBudget = this._admitBudget({
      botId,
      parentRunId,
      requested: requestedBudget,
      depth,
      treeRootId,
      isReturn: Boolean(returnOf),
    });
    const reserveKey = this._reserveKey({ parentRunId, botId });
    const baseTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : RUN_TIMEOUT_MS;
    const timeCap = effectiveBudget?.maxTimeMs;
    const effectiveTimeout = typeof timeCap === "number" ? Math.min(baseTimeout, timeCap) : baseTimeout;
    const run = this.ledger.createRun({
      kind,
      botId,
      roomId,
      scope,
      text,
      attachmentIds,
      parentRunId,
      treeRootId,
      returnOf,
      depth,
      budget: effectiveBudget,
      source,
      taskId,
    });
    // 电脑粒度准入：同一台电脑跨 scope 只允许一个运行（不排队）。失败就落一条 failed，
    // 绝不留下「已建但永不驱动」的运行，也不假装排队。
    if (botId) {
      try {
        this.features?.computers?.acquireRunLease({ botId, scope, runId: run.id });
      } catch (e) {
        this._setRunState(run.id, RUN_STATES.FAILED, {
          error: `电脑准入失败：${e?.message ?? String(e)}`,
        });
        this.emit("run_rejected", {
          runId: run.id,
          botId,
          scope,
          code: e?.code ?? "computer_admission_denied",
          error: e?.message ?? String(e),
        });
        throw e;
      }
    }
    this.leases.set(leaseKey, run.id);
    const ctrl = {
      run,
      leaseKey,
      abort: new AbortController(),
      children: new Set(),
      approvals: new Set(),
      subagentIds: new Set(),
      stuck: createStuckDetector(),
      cancelled: false,
      cancelErrors: [],
      finished: false,
      done: null,
      runtime: null,
      timeoutMs: effectiveTimeout,
      images,
      spoken: [],
      // 发送者称呼：bot 之间传话时是「🤖 名字 (@id)」，其余按来源推断（见 senderOf）。
      sender: typeof sender === "string" && sender.trim() ? sender.trim().slice(0, 80) : null,
    };
    this.runs.set(run.id, ctrl);
    if (parentRunId) this.runs.get(parentRunId)?.children.add(run.id);
    // 预留本 Run 的额度上限：并行子 Run 因此拿不到同一份额度。
    this._reserveFor(run.id, reserveKey, effectiveBudget);
    // 第一层干活成员（父是根或交回的唤醒）另在整棵树上占一份；更深的已经在它的上限里了。
    if (treeRootId && parentRunId && !returnOf && !this._treeAllocOf(this.getRun(parentRunId), treeRootId)) {
      this._reserveTree(run.id, treeRootId, effectiveBudget);
    }

    this.emit("run_created", {
      runId: run.id,
      botId: run.botId,
      roomId: run.roomId,
      scope: run.scope,
      run,
    });
    const starting = this._setRunState(run.id, RUN_STATES.STARTING);
    // 异步执行：任何失败都落到 run 上，不留 unhandled rejection。
    ctrl.done = this._driveRun(run.id).catch(async (e) => {
      const message = e?.message ?? String(e);
      this.emit("run_driver_error", { runId: run.id, error: message });
      if (!ctrl.finished) {
        try {
          await this._finishRun(run.id, RUN_STATES.FAILED, { error: message });
        } catch (e2) {
          this._releaseLease(run.id);
          this.emit("run_finalize_error", { runId: run.id, error: e2?.message ?? String(e2) });
        }
      }
      // 关停可能已经关闭台账：ctrl.done 无人再等，晚到的读取失败也不能成为未捕获拒绝。
      try {
        return this.getRun(run.id);
      } catch {
        return null;
      }
    });
    return starting ?? this.getRun(run.id) ?? run;
  }

  /**
   * 记录「客机副作用未知」：某个客机动作无法确认终态（取消后 guest 命令是否真的结束未知）。
   * 还没落定的 Run 只登记，由 _finishRun 统一升级成 reconciliation_required（取消/超时/正常收尾
   * 都不会把它冲掉，也绝不假称 cancelled）；已经落定的 Run 只补记对账字段与事件。
   */
  /**
   * 外部动作开始前记一笔 in_flight（写进 run.sideEffects，台账 reconcile 按它判断）。
   * 键 = 工具名 + 本 Run 里第几次调用，同一 Run 里每次动作各一个。
   * 进程在动作中途没了，重启时这笔变 unknown、Run 落 reconciliation_required，不当成没做过。
   * @returns {string|null} 动作键；没有 Run 或台账只读时返回 null（不挡动作本身）
   */
  beginSideEffect(runId, { tool, kind = null } = {}) {
    if (!runId || this.ledger.readonly) return null;
    try {
      const run = this.getRun(runId);
      if (!run) return null;
      const list = Array.isArray(run.sideEffects) ? run.sideEffects : [];
      const n = list.filter((s) => s?.tool === tool).length + 1;
      const id = `${tool}#${n}`;
      const entry = { id, tool, kind, status: "in_flight", startedAt: Date.now() };
      // 只留最近的已落定记录，在飞的一条不丢：Run 记录不能随动作次数无限长。
      const kept = list.filter((s, i) => s?.status === "in_flight" || i >= list.length - SIDE_EFFECT_KEEP);
      this.ledger.updateRun(runId, { sideEffects: [...kept, entry] });
      return id;
    } catch (e) {
      this.emit("side_effect_record_error", { runId, error: e?.message ?? String(e) });
      return null;
    }
  }

  /** 动作有了确定结果（成功或明确失败）：in_flight → done。结果未知的走 noteSideEffectUnknown。 */
  endSideEffect(runId, id, { ok = true, error = null, unknown = false } = {}) {
    if (!runId || !id || this.ledger.readonly) return;
    try {
      const run = this.getRun(runId);
      if (!run || !Array.isArray(run.sideEffects)) return;
      const sideEffects = run.sideEffects.map((s) =>
        s?.id === id
          ? {
              ...s,
              status: unknown ? "unknown" : "done",
              outcome: unknown ? "unknown" : ok ? "ok" : "error",
              ...(error ? { error: String(error).slice(0, 500) } : {}),
              endedAt: Date.now(),
            }
          : s,
      );
      this.ledger.updateRun(runId, { sideEffects });
    } catch (e) {
      this.emit("side_effect_record_error", { runId, error: e?.message ?? String(e) });
    }
  }

  noteSideEffectUnknown(runId, info = {}) {
    const ctrl = runId ? this.runs.get(runId) : null;
    if (!ctrl) return false;
    const record = {
      status: "side_effect_unknown",
      reason: String(info.reason ?? "guest_effect_unknown"),
      detail: info.detail ? String(info.detail) : null,
      at: Date.now(),
    };
    ctrl.sideEffectUnknown = record;
    this.emit("run_side_effect_unknown", { runId, botId: ctrl.run.botId ?? null, scope: ctrl.run.scope, ...record });
    // 标记晚到、Run 已经落定：台账不允许重开终态（LEDGER_IMMUTABLE），
    // 只能如实补记对账字段与事件，绝不把 cancelled 改写成别的状态。
    const run = this.getRun(runId);
    if (run && isTerminalRunState(run.state)) {
      try {
        this._patchRun(runId, { guestSideEffect: record, ...(run.recovery ? {} : { recovery: record }) });
      } catch (e) {
        this.emit("run_finalize_error", { runId, error: e?.message ?? String(e) });
      }
    }
    return true;
  }

  /** 人工接管（浏览器/电脑操作）期间暂停新回合：没有这个闸门，接管入口就是谎话。 */
  _assertNotPaused(botId, scope) {
    if (typeof this.features.isPaused === "function" && this.features.isPaused(botId, scope)) {
      throw httpErr(
        409,
        `bot ${botId} 在 ${scope} 上处于人工接管暂停状态，拒绝开始新回合`,
        "bot_paused",
      );
    }
  }

  /** bot 的各类路径（团队目录模块唯一来源，与 BotRuntime 共用），供 Features 写项目级 MCP/skills。 */
  botWorkDir(botId, scope = "private") {
    return runtimeDirs(this.home, botId, scope);
  }

  // ---- 预算与并发（真实额度，不是标签）----
  // 额度 = Bot 预算 ∩ 父 Run 预算 ∩ 本次请求；可派发额度 = 额度 − 真实已花费
  // （来自 Ledger 的原生用量差值，含整棵子 Run 树），因此并行子 Run 不能重复用同一份额度。

  _limitsFor({ botId, parentRunId, requested }) {
    const bot = botId ? this.getBot(botId) : null;
    const parent = parentRunId ? this.getRun(parentRunId) : null;
    let limits = intersectBudget(bot?.budget ?? null, requested ?? null);
    limits = intersectBudget(limits, parent?.budget ?? null);
    return limits;
  }

  /** runId → 该 Run 的原生用量合计（跨模型分行相加）。 */
  _usageByRun() {
    const { perRun } = this.ledger.usage();
    const map = new Map();
    for (const r of perRun) {
      const cur = map.get(r.runId) ?? { tokens: 0, cost: 0, costKnown: true };
      cur.tokens += r.totalTokens ?? 0;
      cur.cost += r.cost ?? 0;
      if (r.costKnown !== true) cur.costKnown = false;
      map.set(r.runId, cur);
    }
    return map;
  }

  /** root 运行的整棵子树（含自身）。 */
  _subtreeRunIds(rootId) {
    const all = this.ledger.listRuns({ limit: 1000 });
    const ids = new Set([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of all) {
        if (r.parentRunId && ids.has(r.parentRunId) && !ids.has(r.id)) {
          ids.add(r.id);
          grew = true;
        }
      }
    }
    return ids;
  }

  /** 真实已花费：按父 Run 子树或按 Bot 汇总。 */
  _spent({ subtreeOf = null, botId = null }) {
    const usage = this._usageByRun();
    let tokens = 0;
    let cost = 0;
    const ids = subtreeOf
      ? [...this._subtreeRunIds(subtreeOf)]
      : this.ledger.listRuns({ ...(botId ? { botId } : {}), limit: 1000 }).map((r) => r.id);
    for (const id of ids) {
      const u = usage.get(id);
      if (!u) continue;
      tokens += u.tokens;
      cost += u.cost;
    }
    return { tokens, cost };
  }

  /**
   * 派发前准入：可派发额度 = 额度 − 已花费 − 在飞预留。任一维度耗尽/为 0 → 拒绝，不 spawn。
   * 预留按「未落定子 Run 的额度上限」记账，所以并行子 Run 不能重复使用同一份额度。
   * @returns {object|null} 子 Run 可用额度（已扣掉已花费与在飞预留）
   */
  _admitBudget({ botId, parentRunId, requested, depth, treeRootId = null, isReturn = false }) {
    const limits = this._limitsFor({ botId, parentRunId, requested });
    const budget = { ...(limits ?? {}) };
    const reserveKey = this._reserveKey({ parentRunId, botId });
    if (limits) {
      const spent =
        parentRunId || botId
          ? this._spent(parentRunId ? { subtreeOf: parentRunId } : { botId })
          : { tokens: 0, cost: 0 };
      const reserved = reserveKey ? (this._reserved.get(reserveKey) ?? { tokens: 0, cost: 0 }) : { tokens: 0, cost: 0 };
      if (limits.maxTokens !== undefined) {
        const left = limits.maxTokens - spent.tokens - reserved.tokens;
        if (left <= 0) {
          throw httpErr(
            409,
            `预算耗尽：token 额度 ${limits.maxTokens} 已用完（已花 ${spent.tokens}，在飞预留 ${reserved.tokens}）`,
            "budget_exhausted",
          );
        }
        budget.maxTokens = left;
      }
      if (limits.maxCostUsd !== undefined) {
        const left = limits.maxCostUsd - spent.cost - reserved.cost;
        if (left <= 0) {
          throw httpErr(
            409,
            `预算耗尽：费用额度 ${limits.maxCostUsd} 已用完（已花 ${spent.cost}，在飞预留 ${reserved.cost}）`,
            "budget_exhausted",
          );
        }
        budget.maxCostUsd = left;
      }
      if (limits.maxTimeMs !== undefined && !(limits.maxTimeMs > 0)) {
        throw httpErr(409, "预算耗尽：时间额度为 0", "budget_exhausted");
      }
    }
    // 整棵派工树一份预算：干活的成员只能用到余量线，交回的唤醒可以用到总额。
    const tree = treeRootId ? this._treeBudget(treeRootId) : null;
    if (tree) {
      const spent = this._treeSpent(treeRootId);
      const ceil = isReturn ? tree.total : tree.line;
      const reservedT = this._treeReserved.get(treeRootId) ?? { tokens: 0, cost: 0 };
      const alloc = !isReturn && parentRunId ? this._treeAllocOf(this.getRun(parentRunId), treeRootId) : null;
      const mine = alloc ? this.runs.get(alloc.id)?.treeReservation : null;
      for (const [key, used, unit] of [["maxTokens", spent.tokens, "token"], ["maxCostUsd", spent.cost, "费用"]]) {
        if (ceil[key] === undefined) continue;
        // 在飞的第一层干活成员各占着自己的上限；本 Run 就在其中一份下面时，那一份不算别人的。
        const field = key === "maxTokens" ? "tokens" : "cost";
        const others = isReturn ? 0 : (reservedT[field] ?? 0) - (mine?.[field] ?? 0);
        const left = ceil[key] - used - others;
        if (left <= 0) {
          throw httpErr(
            409,
            isReturn
              ? `预算耗尽：整棵派工树的${unit}额度 ${tree.total[key]} 已用完（已花 ${used}）`
              : `预算耗尽：整棵派工树已花 ${unit} ${used}，到了余量线 ${ceil[key]}（额度 ${tree.total[key]}），剩下的留给交回和汇总，不能再派新活`,
            "budget_exhausted",
          );
        }
        budget[key] = budget[key] === undefined ? left : Math.min(budget[key], left);
      }
    }
    // 全局在飞上限只约束子 Run（depth > 0），避免并行派活无界增长；用户直接发起不受限。
    if (depth > 0) {
      const active = [...this.runs.values()].filter(
        (c) => !isTerminalRunState(this.getRun(c.run.id)?.state ?? ""),
      ).length;
      if (active >= this.maxConcurrency) {
        throw httpErr(
          429,
          `并发已达上限 ${this.maxConcurrency}，拒绝继续派发子运行`,
          "concurrency_limit",
        );
      }
    }
    if (parentRunId) {
      const parentCtl = this.runs.get(parentRunId);
      if (parentCtl?.usageUnknown && this.getRun(parentRunId)?.budget) {
        throw httpErr(
          409,
          "父 Run 的原生用量读不到，预算无法核对，拒绝继续派发子运行",
          "budget_unverifiable",
        );
      }
      const cap = this.getRun(parentRunId)?.budget?.maxConcurrency;
      if (typeof cap === "number") {
        const activeChildren = [...(this.runs.get(parentRunId)?.children ?? [])].filter(
          (id) => !isTerminalRunState(this.getRun(id)?.state ?? ""),
        ).length;
        if (activeChildren >= cap) {
          throw httpErr(429, `父 Run 的子运行并发已达上限 ${cap}`, "concurrency_limit");
        }
      }
    }
    return Object.keys(budget).length ? budget : null;
  }

  /** 预留记账的归属键：子 Run 记在父 Run 上，其余记在 Bot 上。 */
  _reserveKey({ parentRunId, botId }) {
    if (parentRunId) return `run:${parentRunId}`;
    if (botId) return `bot:${botId}`;
    return null;
  }

  /** 落地预留：把本 Run 的额度上限记在父 Run/Bot 名下，供后续派发扣除。 */
  _reserveFor(runId, key, budget) {
    const ctrl = this.runs.get(runId);
    if (!key || !budget || !ctrl) return;
    const tokens = budget.maxTokens ?? 0;
    const cost = budget.maxCostUsd ?? 0;
    if (!tokens && !cost) return;
    const rec = this._reserved.get(key) ?? { tokens: 0, cost: 0 };
    rec.tokens += tokens;
    rec.cost += cost;
    this._reserved.set(key, rec);
    ctrl.reservation = { key, tokens, cost };
  }

  /** 落定时释放预留（之后它的实际用量会从 Ledger 统计里扣，不重复计）。 */
  _releaseReservation(runId) {
    const ctrl = this.runs.get(runId);
    const t = ctrl?.treeReservation;
    if (t) {
      const rec = this._treeReserved.get(t.rootId);
      if (rec) {
        rec.tokens = Math.max(0, rec.tokens - t.tokens);
        rec.cost = Math.max(0, rec.cost - t.cost);
        if (rec.tokens === 0 && rec.cost === 0) this._treeReserved.delete(t.rootId);
      }
      ctrl.treeReservation = null;
    }
    const r = ctrl?.reservation;
    if (!r) return;
    const rec = this._reserved.get(r.key);
    if (rec) {
      rec.tokens = Math.max(0, rec.tokens - r.tokens);
      rec.cost = Math.max(0, rec.cost - r.cost);
      if (rec.tokens === 0 && rec.cost === 0) this._reserved.delete(r.key);
    }
    ctrl.reservation = null;
  }

  /** 预算无法核对（原生用量读不到）：失败关闭，不报 completed。 */
  async _finishUnverifiable(runId) {
    return await this._finishRun(runId, RUN_STATES.RECONCILIATION_REQUIRED, {
      error: "无法读取原生用量统计，预算额度无法核对（按未确认处理）",
      recovery: { status: "side_effect_unknown", reason: "usage_unavailable", at: Date.now() },
    });
  }

  // ---- 整棵派工树一份预算 ----
  // 预算挂在根 Run 上（根的有效额度）。子任务、孙任务、交回的唤醒都记着同一个 treeRootId，
  // 花费按整棵树算。干活的成员只能用到余量线（总额的 80%），剩下的留给交回和汇总。
  // 用到余量线时整棵停：在飞的干活成员取消，排队的活不开跑，都照常交回。

  /** 这条 Run 所在派工树的根（自己是根就是自己）。 */
  _treeRootOf(run) {
    return run?.treeRootId ?? run?.id ?? null;
  }

  /** 根 Run 的 token/费用额度和余量线；根没有这两种额度就是 null（不限）。 */
  _treeBudget(rootId) {
    const b = rootId ? this.getRun(rootId)?.budget : null;
    if (!b || (b.maxTokens === undefined && b.maxCostUsd === undefined)) return null;
    const total = {};
    const line = {};
    if (b.maxTokens !== undefined) {
      total.maxTokens = b.maxTokens;
      line.maxTokens = Math.floor(b.maxTokens * (1 - TREE_RETURN_SHARE));
    }
    if (b.maxCostUsd !== undefined) {
      total.maxCostUsd = b.maxCostUsd;
      line.maxCostUsd = b.maxCostUsd * (1 - TREE_RETURN_SHARE);
    }
    return { total, line };
  }

  /** 整棵树的成员：记着这个根的，加上按父子链挂在根下面的（老记录没有 treeRootId）。 */
  _treeRunIds(rootId) {
    const ids = this._subtreeRunIds(rootId);
    for (const r of this.ledger.listRuns({ limit: 1000 })) if (r.treeRootId === rootId) ids.add(r.id);
    return ids;
  }

  /**
   * 沿父链往上找「第一层干活成员」：父是根或交回的唤醒的那条。
   * run 自己就是根或唤醒时返回 null（它下面新派的活就是第一层）。
   */
  _treeAllocOf(run, rootId) {
    let cur = run;
    for (let hops = 0; cur && hops <= MAX_DELEGATE_DEPTH + 1; hops++) {
      if (cur.id === rootId || cur.returnOf) return null;
      const parent = cur.parentRunId ? this.getRun(cur.parentRunId) : null;
      if (!parent || parent.id === rootId || parent.returnOf) return cur;
      cur = parent;
    }
    return null;
  }

  /** 第一层干活成员在整棵树上占一份上限：并行的兄弟不能重复用同一份。 */
  _reserveTree(runId, rootId, budget) {
    const ctrl = this.runs.get(runId);
    if (!ctrl || !budget) return;
    const tokens = budget.maxTokens ?? 0;
    const cost = budget.maxCostUsd ?? 0;
    if (!tokens && !cost) return;
    const rec = this._treeReserved.get(rootId) ?? { tokens: 0, cost: 0 };
    rec.tokens += tokens;
    rec.cost += cost;
    this._treeReserved.set(rootId, rec);
    ctrl.treeReservation = { rootId, tokens, cost };
  }

  _treeSpent(rootId) {
    const usage = this._usageByRun();
    let tokens = 0;
    let cost = 0;
    for (const id of this._treeRunIds(rootId)) {
      const u = usage.get(id);
      if (!u) continue;
      tokens += u.tokens;
      cost += u.cost;
    }
    return { tokens, cost };
  }

  /** 每个回合记完用量后看一眼：整棵树到了余量线，就停下其余干活的成员。 */
  _checkTreeLine(runId) {
    if (this.closing || this.ledger.readonly) return;
    const rootId = this._treeRootOf(this.getRun(runId));
    const tree = this._treeBudget(rootId);
    if (!tree || this._stoppedTrees.has(rootId)) return;
    const s = this._treeSpent(rootId);
    let reason = null;
    if (tree.line.maxTokens !== undefined && s.tokens >= tree.line.maxTokens) {
      reason = `整棵派工树已花 token ${s.tokens}，到了余量线 ${tree.line.maxTokens}（额度 ${tree.total.maxTokens}）`;
    } else if (tree.line.maxCostUsd !== undefined && s.cost >= tree.line.maxCostUsd) {
      reason = `整棵派工树已花费用 ${s.cost}，到了余量线 ${tree.line.maxCostUsd}（额度 ${tree.total.maxCostUsd}）`;
    }
    if (!reason) return;
    this._stoppedTrees.add(rootId);
    this._stopTreeWork(rootId, runId, `预算快用完：${reason}，停下来把剩下的留给交回和汇总`);
  }

  /**
   * 整棵停：排队的活按没开跑交回（不是父回合取消，交付照常）；在飞的干活成员按预算取消，
   * 从最深的开始，各自带着预算原因落定，交回不会被当成「父回合取消」丢掉。
   * 根和交回的唤醒不停：它们用余量收尾，超了总额由 _budgetExceeded 收场。
   */
  _stopTreeWork(rootId, currentRunId, reason) {
    const ids = this._treeRunIds(rootId);
    for (const rec of this._delegationRecords()) {
      if (rec.state === "queued" && ids.has(rec.parentRunId)) this._returnNotStarted(rec, reason);
    }
    const active = [...ids]
      .map((id) => this.getRun(id))
      .filter(
        (r) =>
          r && r.id !== currentRunId && r.id !== rootId && !r.returnOf &&
          this.runs.has(r.id) && !isTerminalRunState(r.state),
      )
      .sort((x, y) => (y.depth ?? 0) - (x.depth ?? 0));
    for (const r of active) this._background(this.cancelRun(r.id, `budget-exhausted:${reason}`));
    this.emit("work_tree_stopped", { runId: rootId, reason, stopped: active.map((r) => r.id) });
    this._schedulePump();
  }

  /** 该 Run 的额度是否已被真实用量/墙钟时间吃掉；返回原因文本或 null。 */
  _budgetExceeded(runId) {
    const run = this.getRun(runId);
    const b = run?.budget;
    if (!b) return null;
    const usage = this._usageByRun().get(runId) ?? { tokens: 0, cost: 0 };
    if (b.maxTokens !== undefined && usage.tokens > b.maxTokens) {
      return `token 用量 ${usage.tokens} 超出额度 ${b.maxTokens}`;
    }
    if (b.maxCostUsd !== undefined && usage.cost > b.maxCostUsd) {
      return `费用 ${usage.cost} 超出额度 ${b.maxCostUsd}`;
    }
    // 根和交回的唤醒负责收尾：整棵树超了总额，它们这一回合也不算做完。
    if (!run.parentRunId) {
      const rootId = this._treeRootOf(run);
      const tree = this._treeBudget(rootId);
      if (tree) {
        const s = this._treeSpent(rootId);
        if (tree.total.maxTokens !== undefined && s.tokens > tree.total.maxTokens) {
          return `整棵派工树用了 ${s.tokens} token，超出额度 ${tree.total.maxTokens}`;
        }
        if (tree.total.maxCostUsd !== undefined && s.cost > tree.total.maxCostUsd) {
          return `整棵派工树花了 ${s.cost}，超出费用额度 ${tree.total.maxCostUsd}`;
        }
      }
    }
    if (b.maxTimeMs !== undefined && Date.now() - run.createdAt > b.maxTimeMs) {
      return `墙钟时间超出额度 ${b.maxTimeMs}ms`;
    }
    return null;
  }

  /** 预算耗尽：走与取消相同的路径，未静默就标效果未知。 */
  async _finishBudgetExhausted(runId, description) {
    await this._cascadeCancel(runId, "budget-exhausted");
    const ctrl = this.runs.get(runId);
    let settled = true;
    if (ctrl?.runtime?.busy) {
      const s = await ctrl.runtime
        .waitSettled({ timeoutMs: CANCEL_SETTLE_TIMEOUT_MS })
        .catch(() => ({ settled: false }));
      settled = s.settled === true;
    }
    return await this._finishRun(
      runId,
      settled ? RUN_STATES.CANCELLED : RUN_STATES.RECONCILIATION_REQUIRED,
      {
        error: `预算耗尽：${description}`,
        ...(settled
          ? {}
          : { recovery: { status: "side_effect_unknown", reason: "budget_killed", at: Date.now() } }),
      },
    );
  }

  /** 单条 Run 的驱动：preparePrompt → 原生回合 → 成果/用量 → 终态。 */
  async _driveRun(runId) {
    const ctrl = this.runs.get(runId);
    if (!ctrl) return this.getRun(runId);
    try {
      const run = this.getRun(runId);
      if (!run) throw httpErr(404, `run ${runId} 不存在`, "run_not_found");
      const features = this.features;
      let prepared;
      try {
        prepared = await features.preparePrompt(run, { signal: ctrl.abort.signal });
      } catch (e) {
        // 电脑类失败（未就绪/接管/租约失效）保留真实 code 与状态码，其余仍按资料准备失败上报。
        const code = typeof e?.code === "string" && e.code.startsWith("computer_") ? e.code : "prepare_failed";
        const status = code === "prepare_failed" ? 400 : Number.isInteger(e?.status) ? e.status : 409;
        throw httpErr(status, `资料准备失败：${e?.message ?? String(e)}`, code);
      }
      if (ctrl.cancelled) {
        return await this._finishRun(runId, RUN_STATES.CANCELLED, { error: "启动前已取消" });
      }
      if (run.kind === "room") return await this._driveRoomRun(runId, prepared);
      const directChat = isDirectChat(run);

      if (directChat) {
        this.store.appendChat(run.botId, { role: "user", text: run.text, at: Date.now() });
        this.emit("user_to_bot", { runId, botId: run.botId, text: run.text });
      }

      const runtime = await this.runtimeFor(run.botId, run.scope, { runId });
      ctrl.runtime = runtime;
      this._setRunState(runId, RUN_STATES.RUNNING);

      const images = ctrl.images ?? prepared?.images;
      const res = await this.nativeTurn({
        runtime,
        runId,
        botId: run.botId,
        scope: run.scope,
        signal: ctrl.abort.signal,
        // 第一行标上场景和发送者；台账和聊天记录里仍是原文。
        text: `${sceneTag({ sender: ctrl.sender ?? senderOf(run.source) })}\n${prepared?.text ?? run.text}`,
        images,
        timeoutMs: ctrl.timeoutMs,
      });
      await this._collectArtifacts(runId, runtime, features);
      if (ctrl.cancelled) {
        return await this._finishRun(runId, RUN_STATES.CANCELLED, { error: ctrl.cancelReason ?? "cancelled" });
      }
      const overBudget = ctrl.budgetExceeded ?? this._budgetExceeded(runId);
      if (overBudget) return await this._finishBudgetExhausted(runId, overBudget);
      if (ctrl.usageUnknown && run.budget) return await this._finishUnverifiable(runId);

      const reply = res.text ?? "";
      if (directChat) {
        this.store.appendChat(run.botId, { role: "assistant", text: reply, at: Date.now() });
        this.emit("bot_to_user", { runId, botId: run.botId, text: reply });
      }
      return await this._finishRun(runId, RUN_STATES.COMPLETED, { reply });
    } catch (e) {
      return await this._handleRunError(runId, e);
    }
  }

  /** 群 Run：一个 room Run 管理一串串行 native 子回合，保留 PASS/@mention 语义。 */
  async _driveRoomRun(runId, prepared) {
    const ctrl = this.runs.get(runId);
    const run = this.getRun(runId);
    const room = this.getRoom(run.roomId);
    if (!room) throw httpErr(404, `未知群: ${run.roomId}`, "room_not_found");
    this._setRunState(runId, RUN_STATES.RUNNING);
    const relay = new Relay(this, room, {
      id: runId,
      signal: ctrl.abort.signal,
      shouldStop: () => Boolean(ctrl.budgetExceeded) || Boolean(this._budgetExceeded(runId)),
    });
    const spoken = await relay.post(prepared?.text ?? run.text, { userName: ctrl.userName ?? "用户" });
    ctrl.spoken = spoken;
    const features = this.features;
    const rt = this.runtimes.get(`${room.adminId}::room:${room.id}`) ?? null;
    await this._collectArtifacts(runId, rt, features);
    if (ctrl.cancelled) {
      return await this._finishRun(runId, RUN_STATES.CANCELLED, { error: ctrl.cancelReason ?? "cancelled" });
    }
    const overBudget = ctrl.budgetExceeded ?? this._budgetExceeded(runId);
    if (overBudget) return await this._finishBudgetExhausted(runId, overBudget);
    if (ctrl.usageUnknown && run.budget) return await this._finishUnverifiable(runId);
    const reply = spoken
      .filter((s) => !s.passed)
      .map((s) => `${s.name}: ${s.text}`)
      .join("\n\n");
    return await this._finishRun(runId, RUN_STATES.COMPLETED, { reply });
  }

  /**
   * 单一原生回合入口：所有 native 投递（私聊/委派/群回合）都走这里。
   * 电脑粒度租约在这一层按回合持有：群回合没有单归属 Run 的准入，只有这里能覆盖整个回合；
   * 私聊/委派 Run 已在 startRun 持有（引用计数 +1/-1，同一 Run 不会互相踢掉）。
   */
  async nativeTurn(input = {}) {
    const { botId, scope, runId } = input;
    const computers = this.features?.computers;
    const leaseHeld = Boolean(computers && botId && runId);
    if (leaseHeld) computers.acquireRunLease({ botId, scope, runId });
    try {
      return await this._nativeTurn(input);
    } finally {
      if (leaseHeld) computers.releaseRunLease(runId);
    }
  }

  async _nativeTurn({ runtime, runId, botId, scope, signal, text, images, timeoutMs, depth }) {
    // Bot 自身额度的回合前闸门：非法预算不跑；额度已被花完/预留完则拒绝开新回合。
    // 对群回合尤其重要——群成员自己入群也不能绕过该 bot 的预算。
    const bot = botId ? this.getBot(botId) : null;
    if (bot?.budgetInvalid) {
      throw httpErr(400, `bot 的预算字段非法：${bot.budgetInvalid}`, "budget_invalid");
    }
    if (bot?.budget) {
      const ctrl = runId ? this.runs.get(runId) : null;
      // 本 Run 自己就占着该 bot 的额度时不再重复扣（admission 已经算过）。
      if (ctrl?.reservation?.key !== `bot:${bot.id}`) {
        const spent = this._spent({ botId: bot.id });
        const reserved = this._reserved.get(`bot:${bot.id}`) ?? { tokens: 0, cost: 0 };
        if (
          bot.budget.maxTokens !== undefined &&
          bot.budget.maxTokens - spent.tokens - reserved.tokens <= 0
        ) {
          throw httpErr(409, `预算耗尽：${bot.name} 的 token 额度已用完`, "budget_exhausted");
        }
        if (
          bot.budget.maxCostUsd !== undefined &&
          bot.budget.maxCostUsd - spent.cost - reserved.cost <= 0
        ) {
          throw httpErr(409, `预算耗尽：${bot.name} 的费用额度已用完`, "budget_exhausted");
        }
      }
    }
    // Ledger 的语义是「本 Run 首条记录 = 基线，增量按 0 计」，所以回合前后各记一次快照，
    // 第二次的差值才是本回合真实用量（否则首条永远是 0，预算核对照不到任何花费）。
    const hasRun = Boolean(runId && this.getRun(runId));
    // 先落会话标识：Run 记录在回合进行中就能看到 sessionId/sessionFile。
    if (hasRun) this._syncSessionIdentity(runId, runtime);
    if (hasRun) {
      const baseline = await runtime.getStats().catch(() => null);
      if (baseline) {
        try {
          this.ledger.addUsage(runId, baseline);
        } catch (e) {
          this.emit("usage_error", { runId, botId, scope, error: e?.message ?? String(e) });
        }
      }
    }
    const res = await runtime.promptAndWait(text, {
      images,
      signal,
      timeoutMs,
      depth,
      runId,
    });
    if (runId && this.getRun(runId)) {
      let stats = null;
      try {
        stats = await runtime.getStats();
      } catch (e) {
        this.emit("usage_error", { runId, botId, scope, error: e?.message ?? String(e) });
      }
      const ctrl = this.runs.get(runId);
      let usage = null;
      if (stats) {
        try {
          const rec = this.ledger.addUsage(runId, stats);
          usage = addUsageDelta(this.getRun(runId)?.stats ?? null, {
            model: rec.model,
            provider: stats.provider ?? null,
            delta: rec.delta,
            at: rec.at,
          });
        } catch (e) {
          this.emit("usage_error", { runId, botId, scope, error: e?.message ?? String(e) });
        }
      } else {
        // 读不到原生用量 → 预算无法核对。带预算的 Run 必须失败关闭，不能当成「无限额度」。
        if (ctrl) ctrl.usageUnknown = true;
        this.emit("usage_unavailable", { runId, botId, scope });
      }
      this._syncSessionIdentity(runId, runtime, usage);
      // 用真实原生用量核对额度：耗尽由调用方走取消路径（群 Run 由 Relay 循环感知）。
      if (ctrl) ctrl.budgetExceeded = this._budgetExceeded(runId);
      this._checkTreeLine(runId);
    }
    return res;
  }

  _syncSessionIdentity(runId, runtime, usage = null) {
    const run = this.getRun(runId);
    if (!run) return;
    const patch = {};
    if (runtime?.sessionId && runtime.sessionId !== run.sessionId) patch.sessionId = runtime.sessionId;
    if (runtime?.sessionFile && runtime.sessionFile !== run.sessionFile) {
      patch.sessionFile = runtime.sessionFile;
    }
    // Run 记录保留本轮原生用量差值（含原生模型标识），供预算与产物页核对。
    if (usage) patch.stats = usage;
    if (Object.keys(patch).length) this._patchRun(runId, patch);
  }

  async _collectArtifacts(runId, runtime, features) {
    if (!this.getRun(runId)?.botId) {
      // 群 Run 没有单归属 Bot，成果无从归属到某个工作区：如实跳过，不报错。
      this.emit("artifact_skipped", { runId, reason: "no_bot" });
      return;
    }
    if (!runtime) {
      // 群 Run 找不到可用的成员 runtime 时不能凭空登记成果（也没有可读的 cwd/baseDir）。
      this.emit("artifact_skipped", { runId, reason: "no_runtime" });
      return;
    }
    try {
      const artifacts = (await features.collectArtifacts(this.getRun(runId), runtime)) ?? [];
      const ids = [];
      for (const a of artifacts) {
        const rec = { id: a.id ?? genId("art"), runId, ...a };
        this.ledger.put("artifacts", rec);
        ids.push(rec.id);
        this.emit("artifact_added", { runId, artifact: rec });
      }
      if (ids.length) {
        const run = this.getRun(runId);
        this._patchRun(runId, { artifactIds: [...new Set([...(run?.artifactIds ?? []), ...ids])] });
      }
    } catch (e) {
      this.emit("artifact_error", { runId, error: e?.message ?? String(e) });
    }
  }

  /** 失败落定：超时走取消路径；静默不了/进程被回收 → 效果未知，绝不假装 completed。 */
  async _handleRunError(runId, e) {
    const ctrl = this.runs.get(runId);
    const message = e?.message ?? String(e);
    const isTimeout = e?.code === "timeout" || /timeout|timed out|超时/i.test(message);
    const isAbort = e?.name === "AbortError" || e?.code === "aborted";
    if (ctrl?.cancelled || isAbort) {
      return await this._finishRun(runId, RUN_STATES.CANCELLED, {
        error: ctrl?.cancelReason && ctrl.cancelReason !== "user" ? ctrl.cancelReason : null,
      });
    }
    if (isTimeout) {
      await this._cascadeCancel(runId, "timeout");
      const settled = e?.settled === true;
      return await this._finishRun(
        runId,
        settled ? RUN_STATES.CANCELLED : RUN_STATES.RECONCILIATION_REQUIRED,
        {
          error: `回合超时：${message}`,
          ...(settled
            ? {}
            : { recovery: { status: "side_effect_unknown", reason: "timeout_killed", at: Date.now() } }),
        },
      );
    }
    return await this._finishRun(runId, RUN_STATES.FAILED, { error: message });
  }

  _setRunState(runId, state, patch = {}) {
    const run = this.getRun(runId);
    if (!run) return null;
    if (isTerminalRunState(run.state)) return run;
    const next = this.ledger.updateRun(runId, { state, ...patch });
    const ctrl = this.runs.get(runId);
    if (ctrl) ctrl.run = next;
    this.emit("run_updated", {
      runId,
      botId: next.botId,
      roomId: next.roomId,
      scope: next.scope,
      run: next,
    });
    return next;
  }

  _patchRun(runId, patch) {
    const next = this.ledger.updateRun(runId, patch);
    this.emit("run_updated", {
      runId,
      botId: next.botId,
      roomId: next.roomId,
      scope: next.scope,
      run: next,
    });
    return next;
  }

  /**
   * 落定一条 Run。未静默就先确认停止（必要时回收进程）再释放 scope 租约，
   * 保证「超时后不会立刻回到可接新回合的 idle」。
   */
  async _finishRun(runId, state, patch = {}) {
    const ctrl = this.runs.get(runId);
    const current = this.getRun(runId);
    if (!current) return null;
    if (isTerminalRunState(current.state)) {
      this._releaseReservation(runId);
      this._releaseLease(runId);
      this.features?.computers?.releaseRunLease(runId);
      this._notifyRunWaiters(runId, current);
      this._schedulePump();
      return current;
    }
    // 取消与驱动可能同时收尾：只允许第一个真正落定。
    if (ctrl?.finalizing) return this.getRun(runId);
    if (ctrl) ctrl.finalizing = true;
    if (!ctrl?.finished) {
      const rt = ctrl?.runtime;
      if (rt && rt.busy) {
        let settled = false;
        try {
          const s = await rt.waitSettled({ timeoutMs: CANCEL_SETTLE_TIMEOUT_MS });
          settled = s.settled === true;
        } catch {
          settled = false;
        }
        if (settled) {
          // prompt_result 只是 yield：确认静默后必须把运行态真的落回 idle 并清掉回合归属，
          // 否则会出现「租约已放、runtime 仍 busy」的假忙状态。
          rt.markSettled();
        } else {
          // 原生没确认静默：回收进程。回合效果未知 → 一律落对账态，
          // 既不假称 completed，也不假称 cancelled（不能撤回已发生的动作）。
          await rt.stop({ timeoutMs: 2_000 });
          if (state !== RUN_STATES.RECONCILIATION_REQUIRED) {
            patch = {
              ...patch,
              recovery: {
                status: "side_effect_unknown",
                reason: ctrl?.cancelErrors?.length ? "abort_failed" : "not_settled",
                at: Date.now(),
              },
            };
            state = RUN_STATES.RECONCILIATION_REQUIRED;
          } else if (!patch.recovery) {
            // 上层已经给了具体原因（timeout_killed / budget_killed），不要覆盖它。
            patch = {
              ...patch,
              recovery: {
                status: "side_effect_unknown",
                reason: ctrl?.cancelErrors?.length ? "abort_failed" : "not_settled",
                at: Date.now(),
              },
            };
          }
        }
      }
    }
    if (ctrl) ctrl.finished = true;
    const merged = { ...patch };
    // 卡住被停：别让用户和父助手对着一个不说话的「已取消」。那句人话当回复，私聊里也记一条。
    const notice = state === RUN_STATES.CANCELLED && !merged.reply ? stuckNotice(merged.error) : null;
    if (notice) {
      merged.reply = notice;
      if (isDirectChat(current)) {
        this.store.appendChat(current.botId, { role: "assistant", text: notice, at: Date.now() });
        this.emit("bot_to_user", { runId, botId: current.botId, text: notice });
      }
    }
    if (ctrl?.cancelErrors?.length) {
      merged.error = [merged.error, ...ctrl.cancelErrors].filter(Boolean).join("; ");
    }
    // 客机动作无法确认终态（取消没真正结束 guest 命令）：一律落对账态，
    // 绝不假称 completed/cancelled。具体原因保留在 recovery 里供人工核对。
    if (ctrl?.sideEffectUnknown && state !== RUN_STATES.RECONCILIATION_REQUIRED) {
      const guest = { ...ctrl.sideEffectUnknown };
      merged.recovery = merged.recovery ?? guest;
      merged.guestSideEffect = guest;
      merged.requestedState = state;
      state = RUN_STATES.RECONCILIATION_REQUIRED;
    }
    const next = this.ledger.updateRun(runId, { state, ...merged });
    this.emit("run_finished", {
      runId,
      botId: next.botId,
      roomId: next.roomId,
      scope: next.scope,
      run: next,
    });
    this._releaseReservation(runId);
    this._releaseLease(runId);
    this.features?.computers?.releaseRunLease(runId);
    this._notifyRunWaiters(runId, next);
    this._onRunSettled(next);
    return next;
  }

  _releaseLease(runId) {
    for (const [key, held] of this.leases) {
      if (held === runId) this.leases.delete(key);
    }
  }

  getRun(id) {
    return this.ledger.getRun(id);
  }

  listRuns(filters = {}) {
    return this.ledger.listRuns(filters);
  }

  /** 等终态 Run。超时抛 status=504，不返回未落定的假终态。 */
  waitRun(id, { timeoutMs = 0 } = {}) {
    const run = this.getRun(id);
    if (!run) return Promise.reject(httpErr(404, `run ${id} 不存在`, "run_not_found"));
    if (isTerminalRunState(run.state)) return Promise.resolve(run);
    const p = new Promise((resolveP) => {
      let set = this._runWaiters.get(id);
      if (!set) this._runWaiters.set(id, (set = new Set()));
      set.add(resolveP);
    });
    if (!timeoutMs) return p;
    const bounded = boundedWait(timeoutMs);
    const timeoutP = bounded.promise.then(() => {
      throw httpErr(504, `等待 run ${id} 终态超时（${timeoutMs}ms）`, "wait_timeout");
    });
    return Promise.race([p, timeoutP]).finally(() => bounded.cancel());
  }

  _notifyRunWaiters(runId, run) {
    const set = this._runWaiters.get(runId);
    if (!set) return;
    this._runWaiters.delete(runId);
    for (const resolveP of set) resolveP(run);
  }

  /**
   * 取消：先接受（cancelling），级联原生 abort/子代理/子 Run/挂起审批，
   * 等真实停止确认后才写 cancelled；若原生始终不确认静默（进程被回收），
   * 回合效果未知，落 reconciliation_required，绝不假称已停止或已撤回。
   */
  async cancelRun(id, reason = "user") {
    const run = this.getRun(id);
    if (!run) throw httpErr(404, `run ${id} 不存在`, "run_not_found");
    const ctrl = this.runs.get(id);
    if (!ctrl || isTerminalRunState(run.state)) return { accepted: false, run };
    if (ctrl.cancelling) {
      await ctrl.done;
      return { accepted: true, run: this.getRun(id) };
    }
    ctrl.cancelling = true;
    ctrl.cancelled = true;
    ctrl.cancelReason = reason;
    this._setRunState(id, RUN_STATES.CANCELLING);
    await this._cascadeCancel(id, reason);
    // 驱动回合可能卡在一个不再响应 abort 的等待上：有界等待，超时就由收尾逻辑回收进程落定，
    // 绝不无条件挂着等它（也绝不提前宣称已停止）。计时器保持 ref：CLI 取消不能被 exit 13 打断。
    const bounded = boundedWait(CANCEL_SETTLE_TIMEOUT_MS + 500);
    try {
      await Promise.race([ctrl.done, bounded.promise]);
    } finally {
      bounded.cancel();
    }
    if (!ctrl.finished) {
      await this._finishRun(id, RUN_STATES.CANCELLED, {
        error: reason === "user" ? null : reason,
      });
    }
    return { accepted: true, run: this.getRun(id) };
  }

  /** 取消的实际动作：挂起审批、子 Run、原生 abort、原生子代理、bash。 */
  async _cascadeCancel(runId, reason) {
    const ctrl = this.runs.get(runId);
    if (!ctrl) return;
    ctrl.cancelled = true;
    try {
      this._dropQueuedDelegations(runId);
    } catch (e) {
      this.emit("delegation_error", { runId, error: e?.message ?? String(e) });
    }
    for (const apId of [...ctrl.approvals]) {
      this._resolveApproval(apId, "cancelled");
    }
    const children = [...ctrl.children]
      .filter((cid) => !isTerminalRunState(this.getRun(cid)?.state ?? ""))
      .map((cid) => this.cancelRun(cid, `parent-cancelled:${reason}`));

    const rt = ctrl.runtime;
    if (rt) {
      ctrl.abort.abort(new Error(`run cancelled: ${reason}`));
      try {
        await rt.abort();
      } catch (e) {
        ctrl.cancelErrors.push(`原生 abort 失败：${e?.message ?? String(e)}`);
      }
      for (const sid of [...ctrl.subagentIds]) {
        try {
          await rt.cancelSubagent(sid);
        } catch (e) {
          ctrl.cancelErrors.push(`取消原生子代理 ${sid} 失败：${e?.message ?? String(e)}`);
        }
      }
      try {
        await rt.abortBash();
      } catch (e) {
        ctrl.cancelErrors.push(`中止 bash 失败：${e?.message ?? String(e)}`);
      }
    }
    await Promise.allSettled(children);
  }

  /**
   * 续跑一次被重启打断的 Run（主人点"继续"）。只认 interrupted：reconciliation_required
   * 有结果未知的外部动作，要先人工核对，不能续。派活子 Run 和群 Run 不在这里续：前者已经
   * 作为"中断"交回给派活方，由它决定；后者是群的回合。同一个 Run 只续一次，重复请求返回同一个新 Run。
   * 新 Run 在同一个常驻会话里跑，bot 看得到上次做到哪；提示里要求先核对再接着做，做完的不重做。
   */
  resumeRun(id) {
    const run = this.getRun(id);
    if (!run) throw httpErr(404, `run ${id} 不存在`, "run_not_found");
    if (run.resumedBy) {
      const again = this.getRun(run.resumedBy);
      if (again) return { run: again, resumed: false };
    }
    if (run.state !== RUN_STATES.INTERRUPTED) {
      throw httpErr(409, `只有因重启中断的 Run 能继续（当前 ${run.state}）`, "not_interrupted");
    }
    if (!run.botId || run.roomId || run.parentRunId) {
      throw httpErr(409, "群聊回合和派出去的子任务不在这里继续", "resume_unsupported");
    }
    const text =
      `[继续] 上一次这件事因为服务重启中断了（${run.id}）。先查清已经做到哪一步，做完的不要重做，` +
      `结果不确定的先核对，再接着做完。原来的要求：\n\n${run.text}`;
    const next = this.startRun({
      botId: run.botId,
      text,
      attachmentIds: Array.isArray(run.attachmentIds) ? run.attachmentIds : [],
      source: "resume",
      ...(run.taskId ? { taskId: run.taskId } : {}),
    });
    this._patchRun(run.id, { resumedBy: next.id });
    this._patchRun(next.id, { resumeOf: run.id });
    return { run: this.getRun(next.id) ?? next, resumed: true };
  }

  /** 中途指令：不创建第二并发运行。 */
  async steerRun(id, text, { behavior = "steer", images } = {}) {
    const run = this.getRun(id);
    if (!run) throw httpErr(404, `run ${id} 不存在`, "run_not_found");
    if (isTerminalRunState(run.state)) {
      throw httpErr(409, `Run 已结束（${run.state}），不能补充指令`, "run_terminal");
    }
    if (run.state === RUN_STATES.CANCELLING) {
      throw httpErr(409, "Run 正在取消，不接受新指令", "run_cancelling");
    }
    const ctrl = this.runs.get(id);
    const rt = ctrl?.runtime;
    if (!rt || !rt.busy) {
      throw httpErr(409, "Run 当前没有活跃回合，无法补充指令", "no_active_turn");
    }
    if (typeof text !== "string" || !text.trim()) throw httpErr(400, "text 必填", "text_required");
    await rt.steer(text, { behavior, images });
    this.emit("run_steered", { runId: id, botId: run.botId, scope: run.scope, behavior, text });
    return this.getRun(id);
  }

  // ---- 原生审批 / 工作台 UI 记录 ----

  _onUiRequest(rt, botId, scope, frame) {
    const method = frame?.method ?? null;
    const runId = this._activeRunIdForRuntime(rt);
    // 只有真正等用户作答的方法才进审批台账；notify/setStatus/setWidget/setTitle 等
    // 是 UI 状态更新（原生帧已按 native_event 透传），不能变成 pending 审批或 waiting_input。
    if (!UI_INTERACTIVE_METHODS.has(method)) {
      this.emit("ui_status", {
        runId,
        botId,
        scope,
        method,
        answerable: false,
        ...(UI_UNANSWERABLE_METHODS.has(method)
          ? { note: `原生 ${method} 提示需要专用认证流程，工作台不代答` }
          : {}),
        frame,
      });
      return null;
    }
    const rec = {
      id: genId("ui"),
      runId,
      botId,
      scope,
      nativeId: frame.id,
      method: frame.method ?? null,
      title: frame.title ?? null,
      message: frame.message ?? null,
      options: Array.isArray(frame.options) ? frame.options : null,
      optionDetails: frame.optionDetails ?? null,
      questions: frame.questions ?? null,
      rememberCommand: this._rememberable(botId, frame),
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + this.uiApprovalTtlMs,
      response: null,
    };
    this.ledger.put("approvals", rec);
    if (runId) {
      const run = this.getRun(runId);
      if (run && !isTerminalRunState(run.state)) {
        const ctrl = this.runs.get(runId);
        ctrl?.approvals.add(rec.id);
        this._patchRun(runId, { approvalIds: [...new Set([...(run.approvalIds ?? []), rec.id])] });
        if (run.state === RUN_STATES.RUNNING || run.state === RUN_STATES.STARTING) {
          this._setRunState(runId, RUN_STATES.WAITING_APPROVAL);
        }
      }
    }
    this.emit("ui_request", { runId, botId, scope, approval: rec });
    const notification = this.features?.notifyApproval?.(rec);
    if (notification) this._background(notification);
    const timer = setTimeout(() => {
      this._expireApproval(rec.id).catch((e) =>
        this.emit("ui_expire_error", { approvalId: rec.id, error: e?.message ?? String(e) }),
      );
    }, this.uiApprovalTtlMs);
    // TTL 定时器保持 unref：没有任何人在 await 它，服务长驻靠它，CLI 不该为它活着。
    timer.unref?.();
    this._uiTimers.set(rec.id, timer);
    return rec;
  }

  /**
   * 到期处理：不自动放行、不假装用户回答。
   * select/confirm → 回原生 cancel/deny（原生侧按拒绝继续）；
   * ask/input 等信息输入 → 取消对应 Run（未回答就不能继续）。
   */
  async _expireApproval(id) {
    const rec = this.ledger.get("approvals", id);
    if (!rec || rec.status !== "pending") {
      this._clearUiTimer(id);
      return null;
    }
    const rt = this.runtimes.get(`${rec.botId}::${rec.scope}`);
    const isAuth = AUTHORIZATION_METHODS.has(rec.method);
    let nativeError = null;
    if (rt?.alive && rec.nativeId) {
      try {
        rt.respondUi(rec.nativeId, { cancelled: true });
      } catch (e) {
        nativeError = e?.message ?? String(e);
      }
    }
    const next = {
      ...rec,
      status: "expired",
      expiredAt: Date.now(),
      expiredReason: "ttl",
      ...(nativeError ? { nativeError } : {}),
    };
    this.ledger.put("approvals", next);
    this._clearUiTimer(id);
    this.emit("ui_resolved", { runId: rec.runId, botId: rec.botId, scope: rec.scope, approval: next });
    if (rec.runId) {
      const run = this.getRun(rec.runId);
      const ctrl = this.runs.get(rec.runId);
      ctrl?.approvals.delete(id);
      if (run && !isTerminalRunState(run.state)) {
        if (isAuth) {
          // 原生已按拒绝继续，Run 回到活跃态；等待方必须显式处理，不替用户批准。
          if (run.state === RUN_STATES.WAITING_APPROVAL) this._setRunState(rec.runId, RUN_STATES.RUNNING);
          this.emit("ui_expired_denied", { runId: rec.runId, approvalId: id, nativeError });
        } else {
          await this.cancelRun(rec.runId, "approval-expired");
        }
      }
    }
    return next;
  }

  _clearUiTimer(id) {
    const t = this._uiTimers.get(id);
    if (t) clearTimeout(t);
    this._uiTimers.delete(id);
  }

  /**
   * 回原生 extension_ui_response。校验：记录 pending、目标 Run 活跃、应答与方法匹配。
   * 不做 recommended 自动作答：没有真实回答就拒绝。
   */
  async answerUi(id, response = {}) {
    const rec = this.ledger.get("approvals", id);
    if (!rec) throw httpErr(404, `审批 ${id} 不存在`, "approval_not_found");
    if (rec.status !== "pending") {
      throw httpErr(409, `审批已处于 ${rec.status}，不能再次应答`, "approval_not_pending");
    }
    if (rec.runId) {
      const run = this.getRun(rec.runId);
      if (!run || isTerminalRunState(run.state)) {
        throw httpErr(409, "目标 Run 已不活跃，拒绝应答", "run_inactive");
      }
    }
    const remember = response?.remember === true;
    if (remember && (!rec.rememberCommand || response.value !== "Approve")) {
      throw httpErr(400, "这张卡不能记成「以后都允许」：只有要我同意档里的单条简单 bash 命令可以", "remember_invalid");
    }
    const payload = validateUiResponse(rec, response);
    const rt = this.runtimes.get(`${rec.botId}::${rec.scope}`);
    if (!rt || !rt.alive) {
      throw httpErr(409, "目标运行时未启动或已停止，无法送达原生应答", "runtime_inactive");
    }
    let native;
    try {
      native = rt.respondUi(rec.nativeId, payload);
    } catch (e) {
      throw httpErr(502, `原生拒绝该应答：${e?.message ?? String(e)}`, "native_response_failed");
    }
    const next = {
      ...rec,
      status: "answered",
      answeredAt: Date.now(),
      response: payload,
    };
    this.ledger.put("approvals", next);
    this._clearUiTimer(id);
    if (remember) {
      // 写进 OMP bash.patterns：本回合结束后进程按新配置重建，以后同一条命令由 OMP 直接放行。
      const bot = this.getBot(rec.botId);
      if (bot) this.updateBot(bot.id, { allowedCommands: [...bot.allowedCommands, rec.rememberCommand] });
    }
    const ctrl = rec.runId ? this.runs.get(rec.runId) : null;
    ctrl?.approvals.delete(id);
    this.emit("ui_resolved", { runId: rec.runId, botId: rec.botId, scope: rec.scope, approval: next });
    if (rec.runId) {
      const run = this.getRun(rec.runId);
      if (run && run.state === RUN_STATES.WAITING_APPROVAL) {
        this._setRunState(rec.runId, RUN_STATES.RUNNING);
      }
    }
    return { ...next, native };
  }

  /** 要我同意档里的单条简单 bash 命令卡，返回能记住的命令；其他卡 null。 */
  _rememberable(botId, frame) {
    const bot = this.getBot(botId);
    if (!bot || frame?.method !== "select" || permissionOf(bot) !== "ask") return null;
    if (!Array.isArray(frame.options) || !frame.options.includes("Approve")) return null;
    if (bot.allowedCommands.length >= MAX_ALLOWED_COMMANDS) return null;
    return rememberableCommand(frame.title);
  }

  /** 内部：把挂起审批落成 cancelled（Run 取消、父子清理）。 */
  _resolveApproval(id, status) {
    const rec = this.ledger.get("approvals", id);
    if (!rec || rec.status !== "pending") return null;
    const ctrl = rec.runId ? this.runs.get(rec.runId) : null;
    const rt = ctrl?.runtime ?? this.runtimes.get(`${rec.botId}::${rec.scope}`);
    if (rt?.alive && rec.nativeId) {
      try {
        rt.respondUi(rec.nativeId, { cancelled: true });
      } catch (e) {
        ctrl?.cancelErrors.push(`取消原生审批失败：${e?.message ?? String(e)}`);
      }
    }
    const next = { ...rec, status, resolvedAt: Date.now() };
    this.ledger.put("approvals", next);
    this._clearUiTimer(id);
    ctrl?.approvals.delete(id);
    this.emit("ui_resolved", { runId: rec.runId, botId: rec.botId, scope: rec.scope, approval: next });
    return next;
  }

  // ---- 原生会话 / 命令 / 目录 ----

  /** 新会话：只动会话，不删旧数据；运行中拒绝，避免冲撞活跃 Run。 */
  async newSession(botId, { scope = "private" } = {}) {
    const rt = await this._runtimeForSessionCommand(botId, scope);
    const out = await rt.newSession();
    this.emit("session_new", { botId, scope, sessionId: out?.sessionId ?? rt.sessionId });
    return out;
  }

  /** 从某个会话条目 fork（原生分支能力）。 */
  async forkSession(botId, { entryId, scope = "private" } = {}) {
    const rt = await this._runtimeForSessionCommand(botId, scope);
    const out = await rt.fork(entryId ? { entryId } : {});
    this.emit("session_fork", { botId, scope, entryId: entryId ?? null, sessionId: out?.sessionId });
    return out;
  }

  /** 原生会话条目（分页投影）。 */
  async getNativeEntries(botId, { scope = "private", limit = 200 } = {}) {
    const rt = await this._runtimeForSessionCommand(botId, scope);
    const entries = await rt.entries({});
    const list = Array.isArray(entries) ? entries : (entries?.entries ?? []);
    const capped = Math.min(Math.max(1, Number(limit) || 200), 1000);
    return { entries: list.slice(-capped), sessionId: rt.sessionId, sessionFile: rt.sessionFile };
  }

  /** 导出会话为 HTML；输出目录固定在 home 内，绝不写用户指定路径。 */
  async exportSession(botId, { scope = "private" } = {}) {
    const rt = await this._runtimeForSessionCommand(botId, scope);
    if (typeof rt.rpc?.exportHtml !== "function") {
      throw httpErr(501, "当前 OMP 客户端不支持原生会话导出", "export_unavailable");
    }
    const dir = join(this.home, "exports");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${botId}-${Date.now()}.html`);
    await rt.rpc.exportHtml(path);
    const full = resolve(path);
    const root = resolve(this.home);
    if (full !== root && !full.startsWith(root + sep)) {
      throw httpErr(500, "原生导出路径不在 home 内，拒绝外泄", "export_path_denied");
    }
    return { path: full, html: await readFile(full, "utf8") };
  }

  async _runtimeForSessionCommand(botId, scope) {
    const key = `${botId}::${scope}`;
    const existing = this.runtimes.get(key);
    if (existing?.busy) {
      throw httpErr(409, "bot 正在运行，请先停止或取消当前 Run", "runtime_busy");
    }
    return this.runtimeFor(botId, scope);
  }

  /** 原生运行时状态（不为了看一眼状态而拉起进程）。 */
  async getNativeState(botId, { scope = "private" } = {}) {
    const bot = this.getBot(botId);
    const rt = this.runtimes.get(`${botId}::${scope}`);
    const verdict = rt?.toolSurface ?? null;
    // 只有 chat 档收窄；绑定共享电脑是加法，本机工具面不变，客机工具加在上面。
    const narrowed = bot?.executionMode === "chat";
    const mechanism = "--no-tools + --no-extensions + mcp.enableProjectConfig:false + disabledExtensions mcp:<name>";
    // 如实披露：三档都不是 OS 沙箱；chat 档的收窄程度以运行时工具面校验为准。
    const disclosure = {
      executionMode: bot?.executionMode ?? null,
      approvalMode: bot?.approvalMode ?? null,
      computer: bot?.computer ? { bound: true, runtime: bot.computer.runtime, kind: bot.computer.kind } : { bound: false },
      sandbox: false,
      permission: bot ? permissionOf(bot) : null,
      sandboxNote: "本机没有经过验证的 OS 沙箱；三档都不是沙箱，只是审批与工具范围差异",
      toolSurface: narrowed
        ? verdict
          ? {
              restricted: true,
              // 实际 dumpTools 的自报工具面：越界即拒绝回合（blocked 里带 violations）
              nativeVerification: verdict.verified ? "verified" : "failed",
              kind: "chat",
              reported: verdict.reported ?? null,
              allowed: verdict.allowed ?? null,
              violations: verdict.violations ?? [],
            }
          : {
              restricted: true,
              nativeVerification: "unverified",
              kind: "chat",
              mechanism,
              reported: null,
              violations: null,
            }
        : { restricted: false, nativeVerification: "n/a", reported: null, violations: null },
      ...(rt?.blocked ? { blocked: rt.blocked } : {}),
    };
    if (!rt) {
      return {
        botId,
        scope,
        started: false,
        sessionId: null,
        sessionFile: null,
        capabilities: null,
        state: null,
        ...disclosure,
      };
    }
    let state = null;
    let error = null;
    try {
      state = await rt.getNativeState();
    } catch (e) {
      error = e?.message ?? String(e);
    }
    return {
      botId,
      scope,
      started: rt.alive,
      busy: rt.busy,
      sessionId: rt.sessionId,
      sessionFile: rt.sessionFile,
      capabilities: rt.capabilities,
      state,
      ...disclosure,
      ...(error ? { error } : {}),
    };
  }

  /**
   * 内部原生受限命令：只允许会话/模型/登录/技能/记忆/电脑操作的白名单命令。
   * 不接受任意 bash/eval/raw frame；运行中一律拒绝。
   */
  async nativeCommand(botId, command, { scope = "private" } = {}) {
    const type = typeof command === "string" ? command : command?.type;
    if (!type || !NATIVE_COMMAND_ALLOWLIST.has(type)) {
      throw httpErr(403, `原生命令「${type}」不在允许集合内`, "command_not_allowed");
    }
    const rt = await this._runtimeForSessionCommand(botId, scope);
    const cmd = typeof command === "string" ? { type } : { ...command };
    const result = await rt.nativeCommand(cmd, {
      allowed: NATIVE_COMMAND_ALLOWLIST,
      timeoutMs: RPC_COMMAND_TIMEOUT_MS * 4,
    });
    this.emit("native_command", { botId, scope, command: type });
    return result;
  }

  /** 原生模型目录：优先问已启动的进程，否则用 omp models 原生目录入口。 */
  async listModels({ refresh = false } = {}) {
    if (this._modelsCache && !refresh) return this._modelsCache;
    let lastError = null;
    for (const rt of this.runtimes.values()) {
      if (!rt.alive) continue;
      try {
        const models = normalizeModels(await rt.nativeCommand({ type: "get_available_models" }));
        if (models.length) return (this._modelsCache = { models, source: "native" });
      } catch (e) {
        lastError = e;
      }
    }
    try {
      const stdout = await execFileAsync(this.bin, ["models", "--json"], {
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const models = normalizeModels(JSON.parse(stdout));
      return (this._modelsCache = { models, source: "cli" });
    } catch (e) {
      throw httpErr(
        502,
        `模型目录获取失败：${lastError?.message ?? e?.message ?? String(e)}`,
        "models_unavailable",
      );
    }
  }

  // ---- 旧入口：内部复用统一运行逻辑 ----

  /** 用户向某 bot 私聊发一条，返回 bot 回复（展示日志进 chat 缓存）。 */
  async chatWithBot(botId, text, opts = {}) {
    const { timeoutMs, images, attachmentIds, source = "user" } = opts;
    const run = this.startRun({
      botId,
      text,
      timeoutMs,
      attachmentIds: attachmentIds ?? [],
      source,
      ...(images !== undefined ? { images } : {}),
    });
    const done = await this.waitRun(run.id);
    if (done.state === RUN_STATES.COMPLETED) return done.reply ?? "";
    const status = done.state === RUN_STATES.CANCELLED ? 409 : 502;
    throw Object.assign(new Error(done.error ?? `Run 以 ${done.state} 结束`), {
      status,
      run: done,
    });
  }

  /** 读某 bot 的展示用私聊日志。 */
  getChat(botId) {
    return this.store.getChat(botId);
  }

  /** 清空某 bot 的私聊日志（仅展示层；不动 omp session）。 */
  clearChat(botId) {
    this.store.clearChat(botId);
  }

  /** 用户在群里发一条，跑完 relay，返回本次发言数组。 */
  async postToRoom(roomId, text, o = {}) {
    const room = this.getRoom(roomId);
    if (!room) throw httpErr(404, `未知群: ${roomId}`, "room_not_found");
    const run = this.startRun({ roomId, text, source: "user" });
    const ctrl = this.runs.get(run.id);
    if (ctrl) ctrl.userName = o.userName ?? "用户";
    const done = await this.waitRun(run.id);
    if (done.state === RUN_STATES.COMPLETED) return this.runs.get(run.id)?.spoken ?? [];
    const status = done.state === RUN_STATES.CANCELLED ? 409 : 502;
    throw Object.assign(new Error(done.error ?? `群运行以 ${done.state} 结束`), {
      status,
      run: done,
      spoken: this.runs.get(run.id)?.spoken ?? [],
    });
  }

  /** 停掉所有 runtime、落定活跃 Run、释放锁与账本。 */
  async shutdown() {
    this.closing = true;
    const active = [...this.runs.values()]
      .filter((c) => !isTerminalRunState(this.getRun(c.run.id)?.state ?? ""))
      .map((c) => this.cancelRun(c.run.id, "shutdown").catch(() => {}));
    await Promise.allSettled(active);
    await Promise.allSettled([...this._bg]);
    try {
      await this.features.close();
    } catch (e) {
      this.emit("features_close_error", { error: e?.message ?? String(e) });
    }
    for (const t of this._uiTimers.values()) clearTimeout(t);
    this._uiTimers.clear();
    for (const rt of this.runtimes.values()) {
      try {
        await rt.stop();
      } catch {}
    }
    this.runtimes.clear();
    this.leases.clear();
    await this.team.flush();
    // 释放资源必须走到最后一步：任何一步失败都不能让 SQLite 句柄活过 shutdown
    // （句柄没关时 Windows 清理 workbench.sqlite 会 EPERM）。失败当场经事件如实上报，不静默吞掉。
    const release = (step, fn) => {
      try {
        fn();
      } catch (e) {
        this.emit("shutdown_error", { step, error: e?.message ?? String(e) });
      }
    };
    // 只读 Store 从未接受过写入，flush 必然被只读守卫拒绝：按真实语义跳过，不是掩盖错误。
    if (!this.store.readonly) release("store.flushExchanges", () => this.store.flushExchanges());
    release("store.releaseLock", () => this.store.releaseLock());
    release("ledger.close", () => this.ledger.close());
  }
}

/** 身份改动的中文说明，写进 team 的提交信息。 */
function identityChangeLabel(patch) {
  const labels = { name: "名字", role: "角色", instructions: "专属指令", isMain: "主助手标记" };
  return Object.keys(patch).map((k) => labels[k] ?? k).join("、");
}

/**
 * 接口参数解析成三档之一，再展开成内部的执行档加审批档。
 * permission 优先；没给就用旧字段（缺的取现值或默认）按 permissionOf 归一。
 * 升到全部放手是安全降级，必须显式确认：confirmPermission，或旧接口的
 * confirmExecutionMode / confirmApprovalMode。已经是全部放手的 bot 改别的字段不用再确认。
 * 模板导入绝不带授权。
 * @param {object} input 接口参数
 * @param {object|null} current 现有 bot；新建时为 null
 * @returns {{executionMode:string, approvalMode:string}}
 */
function resolvePermission(input, current) {
  const touched = input.permission !== undefined || input.executionMode !== undefined || input.approvalMode !== undefined;
  if (current && !touched) return { executionMode: current.executionMode, approvalMode: current.approvalMode };
  let level;
  if (input.permission !== undefined) {
    if (typeof input.permission !== "string" || !Object.hasOwn(PERMISSION_LEVELS, input.permission)) {
      throw httpErr(400, `未知权限档: ${input.permission}（可选 ${Object.keys(PERMISSION_LEVELS).join(" / ")}）`, "permission_invalid");
    }
    level = input.permission;
  } else {
    const executionMode = input.executionMode ?? current?.executionMode ?? DEFAULT_EXECUTION_MODE;
    const approvalMode = input.approvalMode ?? current?.approvalMode ?? DEFAULT_APPROVAL_MODE;
    validateModeAuthority({ executionMode, approvalMode });
    level = permissionOf({ executionMode, approvalMode });
  }
  const before = current ? permissionOf(current) : null;
  const confirmed = input.confirmPermission === true || input.confirmExecutionMode === true || input.confirmApprovalMode === true;
  if (level === "full" && before !== "full" && !confirmed) {
    throw httpErr(
      400,
      "全部放手（本机完全能力，跳过审批）是安全降级：必须由用户在专用设置入口显式确认（confirmPermission=true）",
      "confirm_permission_required",
    );
  }
  return permissionModes(level);
}

/** 旧字段的形状校验。不存在的 sandbox 明确拒绝，本机没有经过验证的 OS 沙箱。 */
function validateModeAuthority({ executionMode, approvalMode }) {
  if (executionMode === "sandbox") {
    throw httpErr(
      400,
      "本机没有经过验证的 OS 沙箱，拒绝 sandbox 模式；请选择只聊天、本机改东西先问我或全部放手",
      "sandbox_unverified",
    );
  }
  if (!EXECUTION_MODES.includes(executionMode)) {
    throw httpErr(400, `未知执行模式: ${executionMode}`, "mode_invalid");
  }
  if (!APPROVAL_MODES.includes(approvalMode)) {
    throw httpErr(400, `未知审批档: ${approvalMode}`, "approval_invalid");
  }
  return true;
}

/**
 * 有界等待：计时器保持 ref —— CLI/一次性进程在等取消或等终态时不能因为事件循环里
 * 没有别的句柄而提前 exit 13；race 结束后由调用方 cancel()。
 */
function boundedWait(ms) {
  let timer = null;
  const promise = new Promise((resolveP) => {
    timer = setTimeout(() => resolveP("timeout"), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * 累加同一 Run 各回合的用量差值。cost 任一侧未知就保持 null，不把未知当 0。
 */
function addUsageDelta(prev, next) {
  if (!prev) return next;
  const p = prev.delta ?? {};
  const n = next.delta ?? {};
  const sum = (a, b) => (a ?? 0) + (b ?? 0);
  const knownCost = typeof p.cost === "number" && typeof n.cost === "number";
  return {
    model: next.model ?? prev.model ?? null,
    provider: next.provider ?? prev.provider ?? null,
    at: next.at,
    delta: {
      tokensIn: sum(p.tokensIn, n.tokensIn),
      tokensOut: sum(p.tokensOut, n.tokensOut),
      reasoning: sum(p.reasoning, n.reasoning),
      totalTokens: sum(p.totalTokens, n.totalTokens),
      cost: knownCost ? p.cost + n.cost : null,
      requests: sum(p.requests, n.requests),
      toolCalls: sum(p.toolCalls, n.toolCalls),
    },
  };
}

/**
 * 用量/统计字段白名单：名字里带 token 也必须原样透传（账本、预算和状态面都要真实数字）。
 * 实测证据：早期版本把 tokens/totalTokens/contextTokens 误标成 [redacted]。
 */
const USAGE_STAT_KEYS = new Set([
  "tokens",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "contextTokens",
  "tokenCount",
  "tokenBudget",
  "tokenLimit",
  "maxTokens",
  "tokensPerSecond",
  "contextUsage",
  "cost",
  "costKnown",
  "requests",
  "toolCalls",
  "usage",
  "stats",
  "progress",
]);

/** 只对真正的凭据类键脱敏（不再用裸 token 这种会误伤统计的模式）。 */
const SENSITIVE_KEY_RE =
  /secret|passw[o]rd|api[_-]?key|credential|authorization|cookie|refresh|access[_-]?token|auth[_-]?token|bearer|private[_-]?key/i;

function isSensitiveKey(key) {
  return !USAGE_STAT_KEYS.has(key) && SENSITIVE_KEY_RE.test(key);
}

/** native_event 投影的最大遍历深度（够到 tool_execution_update.details.progress 这类层级）。 */
const FRAME_PROJECT_DEPTH = 8;

/**
 * 帧脱敏与限幅：凭据键置 [redacted]、超长文本截断、深度上限 FRAME_PROJECT_DEPTH。
 * 依据：native_event 是产品投影，不是第二份原生日志，不能复制大块内容或凭据。
 */
function redactFrame(value, depth) {
  if (typeof value === "string") {
    return value.length > NATIVE_EVENT_TEXT_LIMIT
      ? `${value.slice(0, NATIVE_EVENT_TEXT_LIMIT)}…[truncated ${value.length} chars]`
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth > FRAME_PROJECT_DEPTH) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactFrame(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? "[redacted]" : redactFrame(v, depth + 1);
  }
  return out;
}

/** 按原生方法校验应答形状；不替用户挑 recommended/首项。 */
function validateUiResponse(rec, response) {
  const method = rec.method;
  const out = {};
  if (response?.cancelled === true) return { cancelled: true };
  if (AUTHORIZATION_METHODS.has(method)) {
    if (method === "confirm") {
      if (typeof response?.confirmed !== "boolean") {
        throw httpErr(400, "confirm 应答需要布尔 confirmed", "response_invalid");
      }
      return { confirmed: response.confirmed };
    }
    if (typeof response?.value !== "string" || !response.value) {
      throw httpErr(400, "select 应答需要非空字符串 value", "response_invalid");
    }
    const options = (rec.options ?? []).map((o) => (typeof o === "string" ? o : o?.value ?? o?.label));
    if (options.length && !options.includes(response.value)) {
      throw httpErr(400, `value「${response.value}」不在该审批的选项中`, "response_invalid");
    }
    out.value = response.value;
    return out;
  }
  // 信息输入类（ask/input/secret）：需要真实回答，不自动补默认值。
  if (typeof response?.value === "string" && response.value) out.value = response.value;
  if (Array.isArray(response?.answers) && response.answers.length) out.answers = response.answers;
  if (!out.value && !out.answers) {
    throw httpErr(400, "该提问需要 value 或非空 answers，不能自动作答", "response_invalid");
  }
  return out;
}

export { validateUiResponse, validateModeAuthority };
