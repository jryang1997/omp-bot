// 协议参考 https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/rpc.md

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const DEFAULT_FRAME_LIMIT = 1048576; // 1 MiB，协议 v1 单帧上限
const DEFAULT_REASSEMBLED_LIMIT = 67108864; // 64 MiB，v2 重组上限
const CHUNK_PAYLOAD_BYTES = 262144; // 与官方编码器一致：每片 256 KiB
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 30_000; // prompt 回执（含图片/视觉描述预处理）的超时
const DEFAULT_ABORT_GRACE_MS = 10_000; // 超时后等真实结算的窗口，过后终止进程
const DEFAULT_STOP_GRACE_MS = 3_000;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

let seq = 0;
function nextId(prefix = "req") {
  seq += 1;
  return `${prefix}_${seq}`;
}

function timeoutError(message) {
  const err = new Error(message);
  err.code = "timeout";
  return err;
}

function abortError(reason) {
  const err = new Error(reason instanceof Error ? reason.message : String(reason ?? "aborted"));
  err.name = "AbortError";
  err.code = "aborted";
  return err;
}

/** 严格 base64（与官方 RpcFrameDecoder 同判定），非法返回 null。 */
function decodeChunkData(data) {
  if (typeof data !== "string" || data.length === 0 || !BASE64_RE.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  return bytes.toString("base64") === data ? bytes : null;
}

export class RpcClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.bin] omp 可执行文件，默认 "omp"
   * @param {string[]} [opts.args] 追加的启动参数（在 --mode 之后）
   * @param {string} [opts.cwd] 子进程工作目录
   * @param {Record<string,string>} [opts.env] 环境变量：默认叠加在 process.env 上
   * @param {boolean} [opts.exactEnvironment] true 时 env 就是完整环境，不与 process.env 合并
   * @param {string|null} [opts.mode] "rpc"（默认）| "rpc-ui"；null = 不自带 --mode（接任意 stdio JSONL 子进程/测试夹具）
   * @param {boolean} [opts.debug] 打印收发帧到 stderr
   * @param {number} [opts.startupTimeoutMs] 等待 ready 的超时，默认 60s
   * @param {number} [opts.commandTimeoutMs] command() 默认超时，默认 30s
   * @param {number} [opts.admissionTimeoutMs] prompt 回执超时，默认 30s
   * @param {number} [opts.abortGraceMs] 回合超时后等真实结算的窗口，默认 10s
   * @param {number} [opts.stopGraceMs] stop() 每级关闭的等待窗口，默认 3s
   */
  constructor(opts = {}) {
    super();
    this.bin = opts.bin ?? "omp";
    this.args = opts.args ?? [];
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.exactEnvironment = opts.exactEnvironment === true;
    this.mode = opts.mode === undefined ? "rpc" : opts.mode;
    this.debug = opts.debug ?? false;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 60_000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.admissionTimeoutMs = opts.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;
    this.abortGraceMs = opts.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    this.stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;

    this.proc = null;
    this.closed = false;
    this.exitInfo = null;

    this.maxFrameBytes = DEFAULT_FRAME_LIMIT;
    this.maxReassembledBytes = DEFAULT_REASSEMBLED_LIMIT;
    this.protocolVersion = 1;

    this._starting = null;
    this._buf = null; // 未成行的字节（Buffer），避免大帧的字符串拷贝
    this._overflow = false; // 物理帧超限：丢弃字节直到下一个换行重新同步
    this._decoder = new TextDecoder("utf-8", { fatal: true });
    this._pending = new Map(); // id -> {resolve, reject, timer}
    this._pendingChunk = null; // v2 同时只允许一个重组序列
    this._badChunk = null; // {chunkId, endIndex} 已判定失败序列的剩余分片
    this._hostToolHandlers = new Map(); // toolName -> async (args, meta) => result
    this._hostCalls = new Map(); // frame.id -> {wireId, controller, cancelled, done}
    this._waiters = new Map(); // key -> {resolve, reject, timer}
    this._supportedProtocolVersions = [1];
    this._readyFrame = null;
  }

  // ---- 生命周期 ----

  /** 启动子进程并等待 ready 帧 + 协商 v2。已启动则直接返回；退出后可再次调用（重启）。 */
  async start() {
    if (this._starting) return this._starting;
    if (this.proc && !this.closed) return this;
    this._starting = this._startProcess();
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  async _startProcess() {
    this._resetForStart();
    const argv = this.mode ? ["--mode", this.mode, ...this.args] : [...this.args];
    const env = this.exactEnvironment
      ? { ...this.env }
      : this.env
        ? { ...process.env, ...this.env }
        : process.env;
    const child = spawn(this.bin, argv, {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = child;
    this.closed = false;

    // 启动失败（如 ENOENT）只发 error 帧，不写 stdout；没有管道就不可能工作，直接短路。
    if (!child.stdout || !child.stdin) {
      this.closed = true;
      throw new Error(`rpc child ${this.bin} has no stdio pipes`);
    }

    const fail = (err) => {
      this.closed = true;
      this._fail(err);
    };

    child.stdout.on("data", (d) => this._onStdout(d));
    child.stderr.on("data", (d) => {
      const text = typeof d === "string" ? d : d.toString("utf8");
      if (this.debug) process.stderr.write(`[rpc:err] ${text}`);
      this.emit("stderr", text);
    });
    child.stdin.on("error", (err) => fail(new Error(`rpc stdin write failed: ${err?.message ?? err}`)));
    child.on("error", (err) => {
      this.exitInfo = { error: err };
      fail(err);
      if (this.listenerCount("error") > 0) this.emit("error", err); // 无监听者时不要抛未捕获异常
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      this.exitInfo = { code, signal };
      this._fail(new Error(`rpc process exited (code=${code} signal=${signal})`));
      this.emit("exit", code, signal);
    });

    // 等待器必须在 spawn 后的同一 tick 注册，ready 抢跑才会被接住。
    let frame;
    try {
      frame = await this._waitForFrame("ready", this.startupTimeoutMs);
    } catch (err) {
      await this._terminate(); // 启动失败不留孤儿进程
      throw err;
    }
    if (!frame || frame.type !== "ready") {
      await this._terminate();
      throw new Error("rpc child started without a ready frame");
    }

    if (this._supportedProtocolVersions.includes(2)) {
      try {
        await this.command({ type: "negotiate_protocol", protocolVersion: 2 }, { timeoutMs: this.startupTimeoutMs });
        this.protocolVersion = 2;
      } catch (err) {
        if (this.closed) throw err;
        this.emit("negotiate_error", err); // 不静默：留在 v1，但把失败暴露出来
      }
    }
    return this;
  }

  /** 关闭 stdin，等子进程排空输出后退出；不退出则 kill。同时中止在途 host tool 调用。 */
  async stop({ graceMs = this.stopGraceMs } = {}) {
    const child = this.proc;
    this._abortHostCalls(new Error("rpc client stopped"));
    if (!child) {
      this.closed = true;
      return;
    }
    try {
      child.stdin.end();
    } catch {}
    if (await this._awaitExit(graceMs)) return;
    try {
      child.kill();
    } catch {}
    if (await this._awaitExit(graceMs)) return;
    await this._terminate(graceMs);
  }

  /** 直接终止子进程（SIGKILL），返回是否确认退出。 */
  async _terminate(graceMs = this.stopGraceMs) {
    const child = this.proc;
    if (!child || this.closed) return false;
    try {
      child.kill("SIGKILL");
    } catch {}
    if (await this._awaitExit(graceMs)) return true;
    this.closed = true;
    this._fail(new Error("rpc process did not exit after SIGKILL"));
    return false;
  }

  _awaitExit(timeoutMs) {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      this.once("exit", onExit);
    });
  }

  /** 清掉上一次运行的残留，让 start() 可以复用同一个实例。 */
  _resetForStart() {
    this._fail(new Error("rpc client restarting"));
    this.proc = null;
    this._buf = null;
    this._overflow = false;
    this._pendingChunk = null;
    this._badChunk = null;
    this._hostCalls.clear();
    this.protocolVersion = 1;
    this._supportedProtocolVersions = [1];
    this._readyFrame = null;
    this.exitInfo = null;
    this.closed = false;
    this.maxFrameBytes = DEFAULT_FRAME_LIMIT;
    this.maxReassembledBytes = DEFAULT_REASSEMBLED_LIMIT;
  }

  // ---- 命令 ----

  /**
   * 发送一条命令，返回其响应帧的 data（或整帧，若无 data 字段）。
   * 失败响应（success:false）抛错。signal 中止时只取消本地等待。
   */
  async command(cmd, { timeoutMs = this.commandTimeoutMs, id, signal } = {}) {
    if (this.closed || !this.proc) throw new Error("rpc client closed");
    if (signal?.aborted) throw abortError(signal.reason);
    const reqId = id ?? cmd.id ?? nextId(cmd.type ?? "command");
    const frame = { ...cmd, id: reqId };
    let onAbort;
    const p = new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this._pending.delete(reqId);
              reject(timeoutError(`command ${cmd.type} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      this._pending.set(reqId, { resolve, reject, timer });
      if (signal) {
        onAbort = () => {
          const entry = this._pending.get(reqId);
          if (!entry) return;
          this._pending.delete(reqId);
          clearTimeout(entry.timer);
          entry.reject(abortError(signal.reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      try {
        this._write(frame);
      } catch (err) {
        // 写失败：用真实的写错误结算这条 pending（保留原始错误），并立刻撤下条目
        const entry = this._pending.get(reqId);
        if (entry) {
          this._pending.delete(reqId);
          clearTimeout(entry.timer);
          entry.reject(err);
        }
      }
      // 无论写失败还是写成功都走这里：p 一定被 await，不会留下未结算的 promise
      const resp = await p;
      if (resp.success === false) {
        const err = new Error(resp.error ?? `command ${cmd.type} failed`);
        err.command = cmd.type;
        err.code = resp.code;
        throw err;
      }
      return resp.data !== undefined ? resp.data : resp;
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      const entry = this._pending.get(reqId);
      if (entry) {
        this._pending.delete(reqId);
        clearTimeout(entry.timer);
      }
    }
  }

  /** 需要服务端 abort 副作用（丢弃未准入的 prompt）时用：本地 signal 中止也会发原生 abort。 */
  async _commandWithAbort(frame, { id, signal, timeoutMs }) {
    if (!signal) return this.command(frame, { id, timeoutMs });
    const onAbort = () => {
      void this.abort().catch(() => {});
    };
    if (signal.aborted) {
      onAbort();
      throw abortError(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.command(frame, { id, timeoutMs, signal });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * 发一条 prompt，等 admission 回执（不等回合结束）。
   * @param {string} message
   * @param {{id?:string, images?:unknown[], streamingBehavior?:"steer"|"followUp", signal?:AbortSignal, timeoutMs?:number}} [opts]
   */
  prompt(message, opts = {}) {
    const reqId = opts.id ?? nextId("prompt");
    return this._commandWithAbort(
      { type: "prompt", message, images: opts.images, streamingBehavior: opts.streamingBehavior },
      { id: reqId, signal: opts.signal, timeoutMs: opts.timeoutMs ?? this.admissionTimeoutMs },
    );
  }

  /**
   * 发 prompt 并等它真正结束。显式 id 同时用于命令与 prompt_result 关联。
   * - 原生已本地完成（响应 data.agentInvoked === false）→ 直接返回，不留悬挂 waiter；
   * - admission 被明确拒绝（success:false / 传输错误）→ 立刻抛出并回收 waiter；
   * - admission 回执超时或 signal 中止 → 回执可能只是迟到，走同一套有界恢复（发 abort、等真实结算或回收进程）；
   * - 回合超时/signal → 同上。
   * @returns {Promise<{status:string, agentInvoked:boolean, settled:boolean, error?:unknown, frame?:unknown}>}
   */
  async promptAndWait(message, opts = {}) {
    const reqId = opts.id ?? nextId("prompt");
    const turnTimeoutMs = opts.timeoutMs ?? 300_000;
    const admissionTimeoutMs = opts.admissionTimeoutMs ?? this.admissionTimeoutMs;
    const graceMs = opts.abortGraceMs ?? this.abortGraceMs;
    const child = this.proc; // 本次票据属于哪个子进程：重启后不得误杀新进程
    const failureRef = { error: null };
    const resultP = this._waitPromptResult(reqId, 0).catch((err) => {
      // 等待器被拒（进程退出/重启/传输失败）：先接住以免未处理拒绝，裁决权在恢复路径。
      failureRef.error = err;
      return null;
    });

    let admission;
    try {
      admission = await this._commandWithAbort(
        { type: "prompt", message, images: opts.images, streamingBehavior: opts.streamingBehavior },
        { id: reqId, signal: opts.signal, timeoutMs: admissionTimeoutMs },
      );
    } catch (err) {
      if (err?.code === "timeout" || err?.code === "aborted") {
        // 回执只是迟到，prompt 可能已被准入：不能干等，也不能悄悄丢弃
        const isTimeout = err.code === "timeout";
        return this._recoverTurn(resultP, reqId, {
          isTimeout,
          timeoutMs: isTimeout ? admissionTimeoutMs : turnTimeoutMs,
          graceMs,
          signal: opts.signal,
          phase: "admission",
          child,
        });
      }
      this._dropWaiter(`prompt_result:${reqId}`);
      throw err;
    }
    if (admission?.agentInvoked === false) {
      this._dropWaiter(`prompt_result:${reqId}`); // 本地已完成：原生不会再发 prompt_result
      return { status: "completed", agentInvoked: false, settled: true, error: undefined, frame: null };
    }
    return this._awaitTurnResult(resultP, reqId, { timeoutMs: turnTimeoutMs, graceMs, signal: opts.signal, child, failureRef });
  }

  async _awaitTurnResult(resultP, reqId, { timeoutMs, graceMs, signal, child, failureRef }) {
    let timer;
    const timeoutP = new Promise((resolve) => {
      timer = setTimeout(() => resolve("__timeout__"), timeoutMs);
    });
    let onSignal;
    const signalP = signal
      ? new Promise((resolve) => {
          if (signal.aborted) return resolve("__signal__");
          onSignal = () => resolve("__signal__");
          signal.addEventListener("abort", onSignal, { once: true });
        })
      : null;
    try {
      const raced = await Promise.race([resultP, timeoutP, ...(signalP ? [signalP] : [])]);
      if (raced === null) {
        // 等待器被拒：既不是超时也不是中止，原样交给有界恢复（活着的子进程仍要回收）
        return await this._recoverTurn(resultP, reqId, {
          isTimeout: false,
          timeoutMs,
          graceMs,
          phase: "turn",
          causeErr: failureRef.error ?? new Error(`prompt ${reqId} result waiter was rejected`),
          child,
        });
      }
      if (raced !== "__timeout__" && raced !== "__signal__") return raced;
      return await this._recoverTurn(resultP, reqId, {
        isTimeout: raced === "__timeout__",
        timeoutMs,
        graceMs,
        signal,
        phase: "turn",
        child,
      });
    } finally {
      clearTimeout(timer);
      if (onSignal) signal.removeEventListener("abort", onSignal);
    }
  }

  /**
   * 超时/中止/等待器被拒后：发 abort，等一次真实结算（prompt_result(sessionSettled:true) / session_settled /
   * 进程退出 / 宽限到期后的 get_state.isSettled），仍未静止就回收进程，然后才拒绝。
   */
  async _recoverTurn(resultP, reqId, { isTimeout, timeoutMs, graceMs, signal, phase = "turn", causeErr, child }) {
    const settlement = this._settlement({ resultP, reqId, child, graceMs }); // 先挂等待器再发 abort，避免结算空窗
    // abort 只发不等回执：它的响应可能永不返回，真实结算由 settlement 判定（帧是同步写出的）
    void this.abort().catch(() => {});
    const outcome = await settlement;
    this._dropWaiter(`prompt_result:${reqId}`);
    // 自己在宽限内跑完的回合是真的完成了：给出真实结果，不要谎报超时，也不要回收
    if (outcome.result && outcome.result.status !== "aborted") return outcome.result;

    const turnDone = outcome.result !== null;
    const sessionDone = outcome.settled === true;
    // 没等到静止：拒绝之前必须真正回收（换过代的进程不属于本票据，不能误杀）
    if (!sessionDone && this.proc === child) outcome.killed = await this._terminate();

    const err = causeErr
      ? causeErr
      : isTimeout
        ? timeoutError(
            `prompt ${reqId}${phase === "admission" ? " admission" : ""} timed out after ${timeoutMs}ms; ` +
              (sessionDone
                ? `turn ended as ${outcome.status ?? "unknown"} after abort`
                : turnDone
                  ? "turn ended, session still busy after abort"
                  : "process terminated after abort grace"),
          )
        : abortError(signal?.reason);
    err.reqId = reqId;
    err.phase = phase;
    err.settled = sessionDone;
    err.turnDone = turnDone;
    err.killed = outcome.killed === true;
    err.status = outcome.status;
    err.source = outcome.source;
    throw err;
  }

  /**
   * 等一次真实结算。结算来源只有：
   * prompt_result 且 sessionSettled === true、prompt 的“本地完成”回执、session_settled 帧、进程退出，
   * 或宽限到期时真实 get_state.isSettled 为真。sessionSettled:false 只说明回合结束了、会话还忙，
   * 必须继续等；等待器被拒本身不算结算，agent_end 更不算。
   */
  _settlement({ resultP, reqId, child, graceMs }) {
    return new Promise((resolve) => {
      let done = false;
      let result = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off("session_settled", onSettled);
        this.off("exit", onExit);
        this.off("response", onAck);
        // 结算由 session_settled / 宽限到期触发时，也要把已记录回执的状态带出来
        resolve(result && value.result === undefined ? { ...value, result, status: value.status ?? result.status } : value);
      };
      const onSettled = () => finish({ settled: true, source: "session_settled" });
      const onExit = (code, signal) => finish({ settled: true, source: "exit", code, signal });
      const onAck = (frame) => {
        if (frame.id !== reqId || frame.command !== "prompt") return;
        if (frame.success !== true || frame.data?.agentInvoked !== false) return;
        finish({
          settled: true,
          source: "prompt_ack",
          status: "completed",
          result: { status: "completed", agentInvoked: false, settled: true, error: undefined, frame: null },
        });
      };
      const onGrace = () => {
        // 不能凭“没等到帧”就当成已静止：到期用真实 get_state 收口
        void this.getState({ timeoutMs: Math.max(1, Math.min(2000, graceMs)) }).then(
          (state) =>
            finish(
              state?.isSettled === true
                ? { settled: true, source: "get_state", state }
                : { settled: false, source: "grace_expired", state },
            ),
          () => finish({ settled: false, source: "grace_expired" }),
        );
      };
      const timer = setTimeout(onGrace, graceMs);
      if (this.closed || this.proc !== child) {
        // 进程已死或已换代：这张票据不可能再被唤醒
        finish({
          settled: true,
          source: this.proc !== child ? "generation_changed" : "exit",
          code: this.exitInfo?.code,
          signal: this.exitInfo?.signal,
        });
        return;
      }
      this.on("session_settled", onSettled);
      this.on("exit", onExit);
      this.on("response", onAck);
      resultP.then((mapped) => {
        if (!mapped) return; // 等待器被拒：交给调用方裁决，绝不当成结算
        result = mapped;
        if (mapped.settled === true) finish({ settled: true, source: "prompt_result", status: mapped.status });
      });
    });
  }

  /**
   * 等会话真正静止：先查真实 get_state.isSettled，再等 session_settled / 进程退出。
   * 超时抛 code="timeout" 的错误；不会把 agent_end 当成结算。
   */
  async waitForSettled(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    if (this.closed) return { settled: true, source: "exit", code: this.exitInfo?.code, signal: this.exitInfo?.signal };

    let done = false;
    let onSettled;
    let onExit;
    let timer;
    const frameP = new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("session_settled", onSettled);
        this.off("exit", onExit);
      };
      onSettled = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve({ settled: true, source: "session_settled" });
      };
      onExit = (code, signal) => {
        if (done) return;
        done = true;
        cleanup();
        resolve({ settled: true, source: "exit", code, signal });
      };
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(timeoutError(`session did not settle within ${timeoutMs}ms`));
      }, timeoutMs);
      this.on("session_settled", onSettled);
      this.on("exit", onExit);
    });
    const drop = () => {
      done = true;
      clearTimeout(timer);
      this.off("session_settled", onSettled);
      this.off("exit", onExit);
    };

    let state;
    let stateError;
    try {
      state = await this.getState({ timeoutMs: Math.max(1, deadline - Date.now()) });
    } catch (err) {
      stateError = err; // get_state 超时/失败不能当作已结算
      if (this.closed) {
        drop();
        return { settled: true, source: "exit", code: this.exitInfo?.code, signal: this.exitInfo?.signal };
      }
    }
    if (state?.isSettled === true) {
      drop();
      return { settled: true, source: "get_state", state };
    }
    const settled = await frameP;
    return { ...settled, state, stateError };
  }

  // ---- 命令封装 ----

  getLastAssistantText() {
    return this.command({ type: "get_last_assistant_text" });
  }

  getState(opts = {}) {
    return this.command({ type: "get_state" }, opts);
  }

  getSessionStats() {
    return this.command({ type: "get_session_stats" });
  }

  /** 中止当前回合。 */
  abort() {
    return this.command({ type: "abort" });
  }

  /** 中止在跑的 bash。 */
  abortBash() {
    return this.command({ type: "abort_bash" });
  }

  /** 忙时插话（会打断当前流）。 */
  steer(message, { images } = {}) {
    return this.command({ type: "steer", message, images });
  }

  /** 本轮结束后再投递的追问。 */
  followUp(message, { images } = {}) {
    return this.command({ type: "follow_up", message, images });
  }

  newSession({ parentSession } = {}) {
    return this.command({ type: "new_session", parentSession });
  }

  /** 追加式会话历史；since 为某个条目 id，返回其后的条目。 */
  getEntries({ since } = {}) {
    return this.command({ type: "get_entries", since });
  }

  /** 分页消息（严格分页，不与整份快照混用）。 */
  getMessagesPage({ cursor, limit } = {}) {
    return this.command({ type: "get_messages_page", cursor, limit });
  }

  getSubagents() {
    return this.command({ type: "get_subagents" });
  }

  cancelSubagent(id) {
    return this.command({ type: "cancel_subagent", subagentId: id });
  }

  steerSubagent(id, message) {
    return this.command({ type: "steer_subagent", subagentId: id, message });
  }

  /** 事件过滤：events=null 表示全转发，messageUpdates 默认只发 delta（去掉 partial 快照）。 */
  setEventFilter({ events = null, messageUpdates = "delta" } = {}) {
    return this.command({ type: "set_event_filter", events, messageUpdates });
  }

  setSubagentSubscription(level = "progress") {
    return this.command({ type: "set_subagent_subscription", level });
  }

  /** 打开原生 ask 对话框（默认关）。 */
  setAskDialog(enabled = true) {
    return this.command({ type: "set_ask_dialog", enabled });
  }

  /**
   * 回一条 extension UI 请求：原始帧写入，没有命令回执（旁路队列）。
   * 只发送显式给出的字段；不代替宿主做超时兜底（未答的 ask 必须由产品层 abort）。
   */
  respondExtensionUI({ id, value, confirmed, cancelled, answers } = {}) {
    if (!id) throw new Error("respondExtensionUI requires id");
    const frame = { type: "extension_ui_response", id };
    if (value !== undefined) frame.value = value;
    if (confirmed !== undefined) frame.confirmed = confirmed;
    if (cancelled !== undefined) frame.cancelled = cancelled;
    if (answers !== undefined) frame.answers = answers;
    this._write(frame);
    return frame;
  }

  fork({ entryId } = {}) {
    return this.command({ type: "fork", entryId });
  }

  branch(entryId) {
    return this.command({ type: "branch", entryId });
  }

  exportHtml(outputPath) {
    return this.command({ type: "export_html", outputPath });
  }

  setModel(provider, modelId) {
    return this.command({ type: "set_model", provider, modelId });
  }

  getAvailableModels() {
    return this.command({ type: "get_available_models" });
  }

  getLoginProviders() {
    return this.command({ type: "get_login_providers" });
  }

  login(providerId) {
    return this.command({ type: "login", providerId });
  }

  /** 注册 host 工具（覆盖式）。tools 形如 [{name,label,description,parameters,hidden?}]。 */
  setHostTools(tools) {
    return this.command({ type: "set_host_tools", tools });
  }

  /**
   * 绑定一个 host 工具的执行器。执行器返回
   * { content?: [{type:"text",text}], text?: string, isError?: boolean }。
   * 返回字符串时自动包成 text content。
   * meta: { toolCallId, toolName, requestId, signal, progress(partialResult) }
   */
  onHostTool(name, handler) {
    this._hostToolHandlers.set(name, handler);
    return this;
  }

  // ---- 内部：帧收发 ----

  _write(frame) {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("rpc stdin is not writable");
    const line = `${JSON.stringify(frame)}\n`;
    if (this.debug) process.stderr.write(`[rpc:send] ${line.slice(0, 400)}\n`);
    stdin.write(line);
  }

  _onStdout(chunk) {
    let buf = this._buf ? Buffer.concat([this._buf, chunk]) : chunk;
    this._buf = null;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) break;
      const line = buf.subarray(start, nl);
      start = nl + 1;
      if (this._overflow) {
        this._overflow = false; // 超限残行到此结束
        continue;
      }
      if (line.length === 0) continue;
      if (line.length > this.maxFrameBytes) {
        this.emit("rpc_frame_error", {
          error: `physical frame exceeds maxFrameBytes (${this.maxFrameBytes})`,
          byteLength: line.length,
        });
        continue;
      }
      this._decodeLine(line);
    }
    const rest = buf.subarray(start);
    if (rest.length > this.maxFrameBytes) {
      if (!this._overflow) {
        this._overflow = true;
        this.emit("rpc_frame_error", {
          error: `physical frame exceeds maxFrameBytes (${this.maxFrameBytes})`,
          byteLength: rest.length,
        });
      }
      return;
    }
    // 拷一份：subarray 会钉住整块 chunk，长帧期间不该留着它
    this._buf = rest.length ? Buffer.from(rest) : null;
  }

  _decodeLine(line) {
    let text;
    try {
      text = this._decoder.decode(line);
    } catch (e) {
      this.emit("parse_error", { line: "", error: e });
      return;
    }
    let frame;
    try {
      frame = JSON.parse(text);
    } catch (e) {
      if (text.trim() === "") return;
      this.emit("parse_error", { line: text, error: e });
      return;
    }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      this.emit("parse_error", { line: text, error: new Error("rpc frame must be an object") });
      return;
    }
    this._handleFrame(frame);
  }

  _handleFrame(frame) {
    if (this.debug) {
      process.stderr.write(`[rpc:recv] ${JSON.stringify(frame).slice(0, 400)}\n`);
    }
    // 每个解码后的帧都先经过这里：响应、UI、prompt、host、事件都可见。
    this.emit("frame", frame);
    const type = frame.type;

    if (type === "rpc_chunk") {
      this._pushChunk(frame);
      return;
    }

    // 非 chunk 帧插进未完成的序列 → 中断，不透传半截逻辑帧
    if (this._pendingChunk) {
      const interrupted = this._pendingChunk;
      this._pendingChunk = null;
      this.emit("rpc_frame_error", { chunkId: interrupted.chunkId, error: "chunk sequence interrupted" });
    }

    if (type === "ready") {
      this.maxFrameBytes = frame.maxFrameBytes ?? this.maxFrameBytes;
      this.maxReassembledBytes = frame.maxReassembledFrameBytes ?? this.maxReassembledBytes;
      this._supportedProtocolVersions = frame.supportedProtocolVersions ?? [1];
      this._readyFrame = frame;
      this._resolveWaiter("ready", frame);
      return;
    }

    if (type === "host_tool_call") {
      void this._serveHostTool(frame);
      return;
    }
    if (type === "host_tool_cancel") {
      this._cancelHostTool(frame);
      return;
    }

    if (type === "response") {
      const p = frame.id ? this._pending.get(frame.id) : null;
      if (p) {
        this._pending.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve(frame);
      }
      this.emit("response", frame);
      return;
    }

    if (type === "prompt_result") {
      this._resolveWaiter(`prompt_result:${frame.id}`, frame);
      this.emit("prompt_result", frame);
      return;
    }

    this.emit("event", frame);
    this.emit(type, frame);
  }

  /** 协议 v2 单序列重组：校验元数据与字节数，超限即丢弃，绝不整块复制后再检查。 */
  _pushChunk(frame) {
    const { chunkId, index, count, byteLength, data } = frame;
    const fail = (error) => {
      this.emit("rpc_frame_error", { chunkId, error });
      this._pendingChunk = null;
      this._badChunk =
        typeof chunkId === "string" && Number.isSafeInteger(count) && Number.isSafeInteger(index) && index < count - 1
          ? { chunkId, endIndex: count - 1 }
          : null;
    };

    // 已判定失败的序列：静默丢弃剩余分片，避免每个分片都再报一次
    if (this._badChunk && this._badChunk.chunkId === chunkId) {
      if (Number.isSafeInteger(index) && index >= this._badChunk.endIndex) this._badChunk = null;
      return;
    }

    // 上限至少为 2：广告的重组上限小于一片时，分块帧依然必须可被接受
    const maxCount = Math.max(2, Math.ceil(this.maxReassembledBytes / CHUNK_PAYLOAD_BYTES));
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      index < 0 ||
      count < 2 ||
      count > maxCount ||
      index >= count ||
      byteLength < this.maxFrameBytes ||
      byteLength > this.maxReassembledBytes
    ) {
      fail("invalid rpc chunk metadata");
      return;
    }

    const bytes = decodeChunkData(data);
    if (!bytes) {
      fail("invalid rpc chunk data");
      return;
    }
    if (bytes.byteLength > CHUNK_PAYLOAD_BYTES) {
      fail("rpc chunk payload exceeds the transport limit");
      return;
    }

    if (!this._pendingChunk) {
      if (index !== 0) {
        fail("rpc chunk sequence must start at index 0");
        return;
      }
      this._pendingChunk = { chunkId, count, byteLength, nextIndex: 0, parts: [], receivedBytes: 0 };
    }
    const pending = this._pendingChunk;
    if (
      pending.chunkId !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      pending.nextIndex !== index
    ) {
      fail("rpc chunk sequence mismatch");
      return;
    }

    pending.parts.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex += 1;
    if (pending.receivedBytes > pending.byteLength) {
      fail("rpc chunk sequence exceeds declared length");
      return;
    }
    if (pending.nextIndex < pending.count) return;
    if (pending.receivedBytes !== pending.byteLength) {
      fail("rpc chunk sequence length mismatch");
      return;
    }

    this._pendingChunk = null;
    let text;
    try {
      text = this._decoder.decode(Buffer.concat(pending.parts, pending.byteLength));
    } catch (e) {
      this.emit("rpc_frame_error", { chunkId, error: `bad reassembled utf8: ${e.message}` });
      return;
    }
    let assembled;
    try {
      assembled = JSON.parse(text);
    } catch (e) {
      this.emit("rpc_frame_error", { chunkId, error: `bad reassembled json: ${e.message}` });
      return;
    }
    if (assembled === null || typeof assembled !== "object" || Array.isArray(assembled)) {
      this.emit("rpc_frame_error", { chunkId, error: "reassembled frame must be an object" });
      return;
    }
    this._handleFrame(assembled);
  }

  _cancelHostTool(frame) {
    this.emit("host_tool_cancel", frame);
    const call = this._hostCalls.get(frame.targetId);
    if (!call) return;
    call.cancelled = true;
    try {
      call.controller.abort(new Error("host tool call cancelled"));
    } catch {}
  }

  async _serveHostTool(frame) {
    const handler = this._hostToolHandlers.get(frame.toolName);
    const call = { wireId: frame.id, controller: new AbortController(), cancelled: false, done: false };
    this._hostCalls.set(frame.id, call);
    const forget = () => {
      if (this._hostCalls.get(call.wireId) === call) this._hostCalls.delete(call.wireId);
    };
    const respond = (result, isError) => {
      if (call.cancelled || call.done) return false; // 取消/关闭后到达的结果直接丢弃
      call.done = true;
      forget();
      if (this.closed) return false;
      try {
        this._write({
          type: "host_tool_result",
          id: call.wireId,
          isError: isError || undefined,
          result,
        });
      } catch {
        return false; // stdin 已不可写：丢弃结果，不要从这里抛出
      }
      return true;
    };
    const progress = (partialResult) => {
      if (call.cancelled || call.done || this.closed) return false;
      try {
        this._write({
          type: "host_tool_update",
          id: call.wireId,
          partialResult: normalizeHostResult(partialResult),
        });
      } catch {
        return false;
      }
      return true;
    };
    if (!handler) {
      respond({ content: [{ type: "text", text: `no handler for host tool ${frame.toolName}` }] }, true);
      return;
    }
    try {
      const out = await handler(frame.arguments ?? {}, {
        toolCallId: frame.toolCallId,
        toolName: frame.toolName,
        requestId: frame.id,
        signal: call.controller.signal,
        progress,
      });
      respond(normalizeHostResult(out), out?.isError === true);
    } catch (e) {
      const message = e?.message ?? String(e);
      respond(
        call.controller.signal.aborted
          ? { content: [{ type: "text", text: `host tool cancelled: ${message}` }] }
          : { content: [{ type: "text", text: `host tool error: ${message}` }] },
        true,
      );
    } finally {
      if (!call.done) forget();
    }
  }

  // ---- 内部：一次性等待器 ----

  /** timeoutMs=0 表示不设超时（由调用方治理）。 */
  _waitForFrame(key, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this._waiters.delete(key);
              reject(timeoutError(`timed out waiting for ${key}`));
            }, timeoutMs)
          : null;
      this._waiters.set(key, { resolve, reject, timer });
    });
  }

  _waitPromptResult(promptId, timeoutMs) {
    return this._waitForFrame(`prompt_result:${promptId}`, timeoutMs).then((f) => ({
      status: f.status,
      agentInvoked: f.agentInvoked,
      settled: f.sessionSettled,
      error: f.error,
      frame: f,
    }));
  }

  _resolveWaiter(key, frame) {
    const w = this._waiters.get(key);
    if (!w) return;
    this._waiters.delete(key);
    clearTimeout(w.timer);
    w.resolve(frame);
  }

  /** 只回收等待器，不结算它的 promise（调用方已经给出结论）。 */
  _dropWaiter(key) {
    const w = this._waiters.get(key);
    if (!w) return;
    this._waiters.delete(key);
    clearTimeout(w.timer);
  }

  _abortHostCalls(err) {
    for (const [, call] of this._hostCalls) {
      call.cancelled = true;
      try {
        call.controller.abort(err);
      } catch {}
    }
  }

  _fail(err) {
    this._rejectAllPending(err);
    this._abortHostCalls(err);
    this._pendingChunk = null;
  }

  _rejectAllPending(err) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._waiters.clear();
  }
}

function normalizeHostResult(out) {
  if (out == null) return { content: [{ type: "text", text: "" }] };
  if (typeof out === "string") return { content: [{ type: "text", text: out }] };
  if (Array.isArray(out.content)) return { content: out.content };
  if (typeof out.text === "string") return { content: [{ type: "text", text: out.text }] };
  return { content: [{ type: "text", text: JSON.stringify(out) }] };
}

export { nextId };
