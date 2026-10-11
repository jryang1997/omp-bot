// rpc-client.mjs — 驱动一个 `omp --mode rpc` 子进程的最小 JSONL 客户端。
// 零依赖，Node ESM。负责：spawn、帧编解码、协议 v2 协商与 chunk 重组、
// 命令/响应按 id 关联、事件订阅、host tool 回调服务。

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const DEFAULT_FRAME_LIMIT = 1048576; // 1 MiB，协议 v1 单帧上限
const DEFAULT_REASSEMBLED_LIMIT = 67108864; // 64 MiB，v2 重组上限

let seq = 0;
function nextId(prefix = "req") {
  seq += 1;
  return `${prefix}_${seq}`;
}

export class RpcClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.bin] omp 可执行文件，默认 "omp"
   * @param {string[]} [opts.args] 追加的启动参数
   * @param {string} [opts.cwd] 子进程工作目录
   * @param {Record<string,string>} [opts.env] 追加环境变量
   * @param {boolean} [opts.debug] 打印收发帧到 stderr
   * @param {number} [opts.startupTimeoutMs] 等待 ready 的超时，默认 60s
   */
  constructor(opts = {}) {
    super();
    this.bin = opts.bin ?? "omp";
    this.args = opts.args ?? [];
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.debug = opts.debug ?? false;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 60_000;

    this.proc = null;
    this.closed = false;
    this.exitInfo = null;

    this.maxFrameBytes = DEFAULT_FRAME_LIMIT;
    this.maxReassembledBytes = DEFAULT_REASSEMBLED_LIMIT;
    this.protocolVersion = 1;

    this._buf = "";
    this._pending = new Map(); // id -> {resolve, reject, timer}
    this._chunks = new Map(); // chunkId -> {count, parts:Map<index,{data,byteLength}>, byteLength}
    this._hostToolHandlers = new Map(); // toolName -> async (args, meta) => result
    this._readyPromise = null;
  }

  // ---- 生命周期 ----

  /** 启动子进程并等待 ready 帧 + 协商 v2。 */
  async start() {
    const argv = ["--mode", "rpc", ...this.args];
    this.proc = spawn(this.bin, argv, {
      cwd: this.cwd,
      env: this.env ? { ...process.env, ...this.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => this._onStdout(d));
    this.proc.stderr.on("data", (d) => {
      if (this.debug) process.stderr.write(`[rpc:err] ${d}`);
      this.emit("stderr", d);
    });
    this.proc.on("error", (err) => {
      this.exitInfo = { error: err };
      this._rejectAllPending(err);
      this.emit("error", err);
    });
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      this.exitInfo = { code, signal };
      this._rejectAllPending(
        new Error(`rpc process exited (code=${code} signal=${signal})`),
      );
      this.emit("exit", code, signal);
    });

    const ready = this._waitForFrame("ready", this.startupTimeoutMs);
    // ready 帧到达后协商 v2（若被支持）。
    await ready;
    if (this._supportedProtocolVersions?.includes(2)) {
      await this.command({ type: "negotiate_protocol", protocolVersion: 2 });
      this.protocolVersion = 2;
    }
    return this;
  }

  /** 关闭 stdin，等子进程排空输出后退出。 */
  async stop() {
    if (this.closed || !this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {}
    // 给子进程排空 stdout 的机会；文档要求关闭 stdin 后仍要继续读 stdout。
    await new Promise((resolve) => {
      if (this.closed) return resolve();
      const t = setTimeout(() => {
        try {
          this.proc.kill();
        } catch {}
        resolve();
      }, 3000);
      this.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // ---- 命令 ----

  /**
   * 发送一条命令，返回其响应帧的 data（或整帧，若无 data 字段）。
   * 失败响应（success:false）抛错。
   */
  async command(cmd, { timeoutMs = 30_000, id } = {}) {
    if (this.closed) throw new Error("rpc client closed");
    const reqId = id ?? cmd.id ?? nextId(cmd.type);
    const frame = { ...cmd, id: reqId };
    const p = new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this._pending.delete(reqId);
              reject(new Error(`command ${cmd.type} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      this._pending.set(reqId, { resolve, reject, timer });
    });
    this._write(frame);
    const resp = await p;
    if (resp.success === false) {
      const err = new Error(resp.error ?? `command ${cmd.type} failed`);
      err.command = cmd.type;
      err.code = resp.code;
      throw err;
    }
    return resp.data !== undefined ? resp.data : resp;
  }

  /** 便捷封装：发一条 prompt，返回被接受的响应（不等回合结束）。 */
  prompt(message, { id, streamingBehavior } = {}) {
    return this.command({ type: "prompt", message, streamingBehavior }, { id });
  }

  /** 发 prompt 并等待其 prompt_result（回合真正结束）。返回 {status, agentInvoked, settled}。 */
  async promptAndWait(message, { id, streamingBehavior, timeoutMs = 300_000 } = {}) {
    const reqId = id ?? nextId("prompt");
    const done = this._waitPromptResult(reqId, timeoutMs);
    await this.command({ type: "prompt", message, streamingBehavior }, { id: reqId });
    return done;
  }

  getLastAssistantText() {
    return this.command({ type: "get_last_assistant_text" });
  }

  getState() {
    return this.command({ type: "get_state" });
  }

  getSessionStats() {
    return this.command({ type: "get_session_stats" });
  }

  /** 注册 host 工具（覆盖式）。tools 形如 [{name,label,description,parameters,hidden?}]。 */
  setHostTools(tools) {
    return this.command({ type: "set_host_tools", tools });
  }

  /**
   * 绑定一个 host 工具的执行器。执行器返回
   * { content?: [{type:"text",text}], text?: string, isError?: boolean }。
   * 返回字符串时自动包成 text content。
   */
  onHostTool(name, handler) {
    this._hostToolHandlers.set(name, handler);
    return this;
  }

  // ---- 内部：帧收发 ----

  _write(frame) {
    if (this.debug) process.stderr.write(`[rpc:send] ${JSON.stringify(frame).slice(0, 400)}\n`);
    this.proc.stdin.write(JSON.stringify(frame) + "\n");
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      let frame;
      try {
        frame = JSON.parse(trimmed);
      } catch (e) {
        this.emit("parse_error", { line: trimmed, error: e });
        continue;
      }
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    if (this.debug) {
      process.stderr.write(`[rpc:recv] ${JSON.stringify(frame).slice(0, 400)}\n`);
    }

    // v2 分块重组
    if (frame.type === "rpc_chunk") {
      const assembled = this._collectChunk(frame);
      if (assembled) this._handleFrame(assembled);
      return;
    }

    if (frame.type === "ready") {
      this.maxFrameBytes = frame.maxFrameBytes ?? this.maxFrameBytes;
      this.maxReassembledBytes = frame.maxReassembledFrameBytes ?? this.maxReassembledBytes;
      this._supportedProtocolVersions = frame.supportedProtocolVersions ?? [1];
      this._resolveWaiter("ready", frame);
      return;
    }

    // host tool 回调
    if (frame.type === "host_tool_call") {
      this._serveHostTool(frame);
      return;
    }
    if (frame.type === "host_tool_cancel") {
      this.emit("host_tool_cancel", frame);
      return;
    }

    // 命令响应
    if (frame.type === "response") {
      const p = frame.id ? this._pending.get(frame.id) : null;
      if (p) {
        this._pending.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve(frame);
      }
      this.emit("response", frame);
      return;
    }

    // prompt 完成
    if (frame.type === "prompt_result") {
      this._resolveWaiter(`prompt_result:${frame.id}`, frame);
      this.emit("prompt_result", frame);
      return;
    }

    // 其余一律作为事件广播
    this.emit("event", frame);
    this.emit(frame.type, frame);
  }

  _collectChunk(frame) {
    const { chunkId, index, count, byteLength, data } = frame;
    let entry = this._chunks.get(chunkId);
    if (!entry) {
      entry = { count, parts: new Map(), total: 0 };
      this._chunks.set(chunkId, entry);
    }
    entry.parts.set(index, { data, byteLength });
    if (entry.parts.size < entry.count) return null;

    // 收齐，按 index 顺序拼接
    const ordered = [];
    for (let i = 0; i < entry.count; i++) {
      const part = entry.parts.get(i);
      if (!part) {
        this._chunks.delete(chunkId);
        this.emit("rpc_frame_error", { chunkId, error: `missing chunk index ${i}` });
        return null;
      }
      ordered.push(Buffer.from(part.data, "base64"));
    }
    this._chunks.delete(chunkId);
    const buf = Buffer.concat(ordered);
    if (buf.length > this.maxReassembledBytes) {
      this.emit("rpc_frame_error", { chunkId, error: "reassembled frame exceeds limit" });
      return null;
    }
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch (e) {
      this.emit("rpc_frame_error", { chunkId, error: `bad reassembled json: ${e.message}` });
      return null;
    }
  }

  async _serveHostTool(frame) {
    const handler = this._hostToolHandlers.get(frame.toolName);
    const respond = (result, isError) => {
      this._write({
        type: "host_tool_result",
        id: frame.id,
        isError: isError || undefined,
        result,
      });
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
      });
      const result = normalizeHostResult(out);
      respond(result, out?.isError === true);
    } catch (e) {
      respond({ content: [{ type: "text", text: `host tool error: ${e?.message ?? e}` }] }, true);
    }
  }

  // ---- 内部：一次性等待器 ----

  _waiters = new Map(); // key -> {resolve, reject, timer}

  _waitForFrame(key, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(key);
        reject(new Error(`timed out waiting for ${key}`));
      }, timeoutMs);
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
