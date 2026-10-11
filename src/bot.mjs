// bot.mjs — BotRuntime：一个 omp RPC 子进程绑定一个会话上下文。
//
// 一个 bot 的私聊是一个 BotRuntime；它加入的每个群各是一个 BotRuntime
// （独立进程 + 独立 session-dir，天然无共享状态）。
//
// 死锁防护：turn 进行中 busy=true，且贯穿整个嵌套 message_bot 调用链
// （A 调 B 时 A 的回合没结束，A.busy 一直为真）。orchestrator 见目标 busy 即拒绝。

import { join } from "node:path";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { RpcClient } from "./rpc-client.mjs";
import { writePersonaFiles } from "./persona.mjs";
import {
  RPC_COMMAND_TIMEOUT_MS,
  RPC_STARTUP_TIMEOUT_MS,
} from "./constants.mjs";

/** BotRuntime 的运行态状态机：stopped → starting → idle ⇄ busy → stopped */
export const RUNTIME_STATE = {
  STOPPED: "stopped",
  STARTING: "starting",
  IDLE: "idle",
  BUSY: "busy",
};

export class BotRuntime {
  /**
   * @param {object} opts
   * @param {object} opts.bot 花名册记录 {id,name,role,instructions,model}
   * @param {string} opts.scope 该 runtime 的会话上下文标识，如 "private" 或 "room:<roomId>"
   * @param {string} opts.home orchestrator 数据根目录
   * @param {string} [opts.cwd] 工作区目录；默认 <home>/bots/<id>/<scope>/work
   * @param {string} [opts.bin] omp 可执行文件
   * @param {boolean} [opts.debug]
   * @param {Array<{name,label,description,parameters,handler}>} [opts.teamTools]
   *        orchestrator 注入的团队工具（message_bot 等），start 时注册为 host tools
   * @param {(text:string)=>void} [opts.onAssistantText] 每次回合结束的文本回调（供 relay 收集）
   */
  constructor(opts) {
    this.bot = opts.bot;
    this.scope = opts.scope;
    this.home = opts.home;
    this.bin = opts.bin ?? "omp";
    this.debug = opts.debug ?? false;
    this.teamToolsFactory = opts.teamToolsFactory ?? (() => []);
    this.onAssistantText = opts.onAssistantText ?? null;

    const safeScope = this.scope.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.baseDir = opts.dir ?? join(this.home, "bots", this.bot.id, safeScope);
    this.sessionDir = join(this.baseDir, "sessions");
    this.cwd = opts.cwd ?? join(this.baseDir, "work");

    this.state = RUNTIME_STATE.STOPPED;
    this.rpc = null;
    this.startedAt = 0;
    this.lastError = null;
    // 当前回合由多少跳 message_bot 触发；0 = 用户直接发起。busy 守卫保证同一
    // runtime 同时只跑一个回合，故此实例态在回合内稳定（ALS 无法跨 stdout 事件传播）。
    this.deliveryDepth = 0;
  }

  get busy() {
    return this.state === RUNTIME_STATE.BUSY;
  }

  get alive() {
    return this.state === RUNTIME_STATE.IDLE || this.state === RUNTIME_STATE.BUSY;
  }

  /** 启动子进程，注入人格与隔离 overlay，注册团队工具。 */
  async start() {
    if (this.alive || this.state === RUNTIME_STATE.STARTING) return this;
    this.state = RUNTIME_STATE.STARTING;
    try {
      mkdirSync(this.cwd, { recursive: true });
      mkdirSync(this.sessionDir, { recursive: true });
      const { argv: personaArgv } = writePersonaFiles(this.bot, this.baseDir);

      const args = [
        "--no-ui",
        "--session-dir",
        this.sessionDir,
        ...personaArgv,
      ];
      if (this.bot.model) args.push("--model", this.bot.model);
      if (this.bot.thinking) args.push("--thinking", this.bot.thinking);
      // 会话目录里已有历史会话 → 续上，实现跨重启记忆。
      if (this._hasPriorSession()) args.push("--continue");

      this.rpc = new RpcClient({
        bin: this.bin,
        cwd: this.cwd,
        args,
        debug: this.debug,
        startupTimeoutMs: RPC_STARTUP_TIMEOUT_MS,
      });

      // 进程意外退出 → 标记 stopped，记录错误。
      this.rpc.on("exit", (code, signal) => {
        if (this.state !== RUNTIME_STATE.STOPPED) {
          this.state = RUNTIME_STATE.STOPPED;
          this.lastError = `rpc exited code=${code} signal=${signal}`;
        }
      });

      await this.rpc.start();

      // 注册团队工具（message_bot 等）。工厂收到本 runtime，handler 可闭包读它的 deliveryDepth。
      const teamTools = this.teamToolsFactory(this);
      if (teamTools.length) {
        for (const t of teamTools) {
          this.rpc.onHostTool(t.name, t.handler);
        }
        await this.rpc.setHostTools(
          teamTools.map((t) => ({
            name: t.name,
            label: t.label,
            description: t.description,
            parameters: t.parameters,
          })),
        );
      }

      this.state = RUNTIME_STATE.IDLE;
      this.startedAt = Date.now();
      return this;
    } catch (e) {
      this.state = RUNTIME_STATE.STOPPED;
      this.lastError = e?.message ?? String(e);
      throw e;
    }
  }

  /**
   * 以 user 角色投递一条消息并等回合结束，返回最终助手文本。
   * busy 期间拒绝（防死锁）。depth 记录触发本回合的 message_bot 跳数。
   * @param {string} text
   * @param {object} [o]
   * @param {number} [o.timeoutMs]
   * @param {number} [o.depth] 本回合由第几跳投递触发；0 = 用户直接发起
   * @returns {Promise<{text:string,status:string}>}
   */
  async send(text, { timeoutMs = 240_000, depth = 0 } = {}) {
    if (!this.alive) await this.start();
    if (this.busy) {
      throw new Error(`bot ${this.bot.name} 正忙，无法接收新消息`);
    }
    this.state = RUNTIME_STATE.BUSY;
    this.deliveryDepth = depth;
    try {
      const res = await this.rpc.promptAndWait(text, { timeoutMs });
      let out = "";
      try {
        out = (await this.rpc.getLastAssistantText())?.text ?? "";
      } catch {}
      if (this.onAssistantText) this.onAssistantText(out);
      return { text: out, status: res.status ?? "completed" };
    } finally {
      this.deliveryDepth = 0;
      // 回合结束（成功/失败/超时）都回到 idle，除非进程已死。
      if (this.rpc && !this.rpc.closed) this.state = RUNTIME_STATE.IDLE;
      else this.state = RUNTIME_STATE.STOPPED;
    }
  }

  async stop() {
    if (this.rpc) {
      try {
        await this.rpc.stop();
      } catch {}
    }
    this.state = RUNTIME_STATE.STOPPED;
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

  /** 取本会话的用量统计（供跨 bot 汇总）。进程未起时返回 null。 */
  async getStats() {
    if (!this.alive) return null;
    try {
      return await this.rpc.getSessionStats();
    } catch {
      return null;
    }
  }
}
