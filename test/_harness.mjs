// test/_harness.mjs — 编排器行为测试共用的夹具：注入的 runtime、桩 features、临时团队。
//
// Store 与 Ledger 一律用真实实现（临时 home），不 mock 持久层。不跑模型、不启 omp 进程。

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Orchestrator } from "../src/orchestrator.mjs";

export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询等待条件成立；超时抛出真实错误（不用假成功兜底）。 */
export async function waitFor(fn, { timeoutMs = 2000, label = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`等待超时：${label}`);
    await delay(5);
  }
}

/** 注入的 runtime 夹具：只实现编排器真正调用的原生面。 */
export class FakeRuntime extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.bot = opts.bot;
    this.scope = opts.scope;
    this.state = "stopped";
    this.sessionId = "sess_fixture";
    this.sessionFile = join(opts.home, "fixtures", `${opts.bot.id}.jsonl`);
    this.deliveryDepth = 0;
    this.activeRun = null;
    this.capabilities = { protocolVersion: 2, extensionUi: true, abort: true };
    this.tools = opts.teamToolsFactory(this);
    this.rpc = {
      env: {},
      exportHtml: async (p) => {
        this.exportedTo = p;
        writeFileSync(p, "<html>fixture</html>", "utf8");
      },
    };
    this.queue = [];
    this.calls = [];
    this.responses = [];
    this.abortCalls = 0;
    this.policyOk = true;
    this.stats = undefined;
    this.completedTurns = 0;
    // 会话累计 token：每个跑完的回合加 step.tokens（默认 15，和原来的 10 入 5 出一致）。
    this.tokensUsed = 0;
    this._tcSeq = 0;
    this._uiWaiters = [];
    this._abortWaiters = [];
  }

  get busy() {
    return this.state === "busy";
  }

  get alive() {
    return this.state === "idle" || this.state === "busy";
  }

  matchesPolicy() {
    return this.policyOk;
  }

  async start() {
    this.state = "idle";
    this.emit("capabilities", this.capabilities);
    return this;
  }

  async stop() {
    // 真实语义：宿主回收进程 → 在飞的回合以「进程已退出、未静默」失败收场。
    this.state = "stopped";
    const err = Object.assign(new Error("rpc process exited (killed)"), {
      settled: false,
      killed: true,
    });
    for (const w of this._abortWaiters.splice(0)) w.reject(err);
    for (const w of this._uiWaiters.splice(0)) w.reject(err);
  }

  async getStats() {
    if (this.stats === null) return null; // 显式模拟「原生用量读不到」
    if (this.stats) return this.stats;
    // 真实语义：get_session_stats 是会话累计值，每完成一个回合才会增长；
    // 编排器在回合前后各取一次快照，差值就是本回合用量。
    const turns = this.completedTurns;
    return {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      model: "fixture/provider-model",
      provider: "fixture",
      tokens: { input: this.tokensUsed - 5 * turns, output: 5 * turns, total: this.tokensUsed },
      cost: 0.001 * turns,
      userMessages: turns,
    };
  }

  async promptAndWait(text, { signal, runId, depth } = {}) {
    this.state = "busy";
    if (depth !== undefined) this.deliveryDepth = depth;
    this.activeRun = { runId: runId ?? null, abort: new AbortController() };
    this.calls.push({ text, runId });
    const step = this.queue.shift() ?? { kind: "complete", text: `echo:${text}` };
    if (signal?.aborted) {
      this.state = "idle";
      this.activeRun = null;
      throw Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted", settled: true });
    }
    try {
      const out = await this._step(step, text);
      // 只有真正跑完的回合才计入会话累计用量（被杀/超时的不计）。
      this.completedTurns += 1;
      this.tokensUsed += Number.isInteger(step.tokens) ? step.tokens : 15;
      this.state = "idle";
      return out;
    } catch (e) {
      // 真实语义：进程被回收 → stopped；其它错误（含已静默的 abort）回到 idle。
      this.state = e?.killed === true ? "stopped" : "idle";
      throw e;
    } finally {
      this.deliveryDepth = 0;
      this.activeRun = null;
    }
  }

  async _step(step, text) {
    switch (step.kind) {
      case "complete":
        return { text: step.text ?? `echo:${text}`, status: "completed", settled: true };
      case "error":
        throw Object.assign(new Error(step.message ?? "fixture error"), {
          settled: step.settled === true,
        });
      case "timeout":
        throw Object.assign(new Error("回合超时：fixture"), {
          code: "timeout",
          settled: step.settled === true,
        });
      case "hang":
        await new Promise((resolve, reject) => {
          this._abortWaiters.push({ resolve, reject });
        });
        return { text: "never", status: "completed", settled: true };
      case "gate":
        // 像 hang 一样挂住，但能由测试 release() 正常放行（模拟「忙一阵再做完」）。
        await new Promise((resolve, reject) => {
          this._abortWaiters.push({ resolve, reject, gate: true });
        });
        return { text: step.text ?? "gate-open", status: "completed", settled: true };
      case "ui": {
        this.emit("ui_request", step.frame);
        const answered = await new Promise((resolve, reject) => {
          this._uiWaiters.push({ resolve, reject });
        });
        return { text: `ui:${JSON.stringify(answered)}`, status: "completed", settled: true };
      }
      case "tool": {
        const out = await this._callTool(step.tool, step.args, step.signal);
        this.lastToolResult = out;
        return { text: out.text ?? JSON.stringify(out), status: "completed", settled: true };
      }
      case "toolx": {
        const texts = [];
        for (const call of step.calls) {
          const out = await this._callTool(call.tool, call.args, call.signal);
          texts.push(out.text ?? JSON.stringify(out));
        }
        return { text: texts.join("\n---\n"), status: "completed", settled: true };
      }
      case "frames": {
        // hang：发完帧继续挂着，像回合还在跑，测试可以在这时 steer/取消。
        // 先挂上等待再发帧：帧触发的取消要能找到这个回合。
        const hung = step.hang
          ? new Promise((resolve, reject) => {
              this._abortWaiters.push({ resolve, reject });
            })
          : null;
        for (const f of step.frames) {
          // 与真实 BotRuntime 一致：extension_ui_request 既走 native_frame 也走 ui_request。
          this.emit("native_frame", f);
          if (f?.type === "extension_ui_request") this.emit("ui_request", f);
        }
        if (hung) await hung;
        return { text: step.text ?? "frames-sent", status: "completed", settled: true };
      }
      default:
        throw new Error(`未知夹具步骤 ${step.kind}`);
    }
  }

  async _callTool(name, args, signal) {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`夹具没有工具 ${name}`);
    try {
      return await tool.handler(args, {
        toolCallId: `tc_${++this._tcSeq}`,
        toolName: name,
        requestId: this._tcSeq,
        signal,
        progress: () => {},
      });
    } catch (e) {
      // 与 RpcClient._serveHostTool 一致：handler 抛错会被传输层包成 isError 结果，
      // 不会让整个回合失败；这里照样镜像，避免夹具造出真实传输不存在的结局。
      return { text: `host tool error: ${e?.message ?? String(e)}`, isError: true };
    }
  }

  /** 宿主确认静默后落回 idle（与真实 BotRuntime 同名同语义）。 */
  markSettled() {
    this.state = "idle";
    this.deliveryDepth = 0;
    this.activeRun = null;
    return this.state;
  }

  async steer(text, { behavior } = {}) {
    this.steered = { text, behavior };
    return { ok: true };
  }

  /** 放行最早挂住的 gate 步骤；没有挂住的返回 false。 */
  release() {
    const i = this._abortWaiters.findIndex((w) => w.gate);
    if (i < 0) return false;
    const [w] = this._abortWaiters.splice(i, 1);
    w.resolve();
    return true;
  }

  async abort() {
    this.abortCalls++;
    for (const w of this._abortWaiters.splice(0)) {
      w.reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted", settled: true }));
    }
    return { ok: true };
  }

  async abortBash() {
    return null;
  }

  async cancelSubagent(id) {
    this.cancelledSubagents = [...(this.cancelledSubagents ?? []), id];
    return null;
  }

  async waitSettled() {
    // 有还没被解除的等待（回合真的在跑）就是没静默；不撒谎返回 settled。
    const pending = this._abortWaiters.length + this._uiWaiters.length;
    return { settled: pending === 0, source: "get_state" };
  }

  respondUi(nativeId, payload) {
    this.responses.push({ nativeId, payload });
    for (const w of this._uiWaiters.splice(0)) w.resolve(payload);
    return { type: "extension_ui_response", id: nativeId };
  }

  async getNativeState() {
    return { sessionId: this.sessionId, isSettled: true };
  }

  async newSession() {
    this.newSessionCalled = true;
    return { sessionId: "sess_new", sessionFile: "/x/new.jsonl" };
  }

  async fork(opts) {
    this.forkCalled = opts;
    return { sessionId: "sess_fork", sessionFile: "/x/fork.jsonl" };
  }

  async entries() {
    return { entries: [{ id: "e1", role: "user" }] };
  }

  async nativeCommand(cmd) {
    this.lastNativeCommand = cmd;
    return { models: [{ id: "fixture/model" }] };
  }

  async exportSession() {
    return { path: "/fixture" };
  }
}

/** 夹具 features：只实现编排器调用到的钩子（真实特性层由 FeaturesOwner 测）。 */
export function stubFeatures({ isPaused } = {}) {
  return {
    handleRequest: async () => false,
    start: async () => {},
    close: async () => {},
    preparePrompt: async (run) => ({ text: run.text }),
    collectArtifacts: async () => [],
    ...(isPaused ? { isPaused } : {}),
  };
}

/**
 * 每个测试独立临时 home + 真实 Store/Ledger + 注入的 runtime 夹具。
 * 传 home 时复用已有目录，用来模拟服务重启：旧编排器不关，新编排器在同一 home 上打开。
 */
export function newTeam({ uiApprovalTtlMs = 60_000, features, maxConcurrency, policyIdleTimeoutMs, home: reuseHome } = {}) {
  const home = reuseHome ?? mkdtempSync(join(tmpdir(), "ompbot-runs-"));
  const created = new Map();
  const events = [];
  let index = 0;
  const feats = features ?? stubFeatures();
  const orch = new Orchestrator({
    home,
    bin: "omp-fixture",
    uiApprovalTtlMs,
    policyIdleTimeoutMs: policyIdleTimeoutMs ?? 300,
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    features: feats,
    onEvent: (e) => events.push(e),
    runtimeFactory: (opts) => {
      index++;
      const rt = new FakeRuntime(opts);
      rt.key = `${opts.bot.id}::${opts.scope}`;
      rt.index = index;
      created.set(rt.key, rt);
      return rt;
    },
  });
  return {
    home,
    orch,
    events,
    fakes: created,
    fake: (botId, scope = "private") => created.get(`${botId}::${scope}`),
    cleanup: async () => {
      try {
        await orch.shutdown();
      } catch {}
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * 模拟进程崩溃：不走 shutdown 收尾，只放掉 home 租约、关掉台账，
 * 等同于进程死后操作系统回收文件锁和句柄。之后用 newTeam({ home }) 打开新编排器。
 */
export function crash(team) {
  team.orch.closing = true;
  try {
    team.orch.ledger.close();
  } catch {}
  team.orch.store.releaseLock();
}
