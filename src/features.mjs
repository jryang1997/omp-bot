// features.mjs — 工作台产品特性层：资料、成果、计划、原生能力面、文件检查点。
//
// 唯一接入点由 server 调用一次：`await orch.features.handleRequest(req,res,url,body,json)`，
// 返回 true 表示已应答。鉴权/Host/Origin/Content-Type 已由 ApiOwner 在调用前完成，本层不重复，
// 也不绕过 server 的安全判断。
//
// CoreOwner 在任务前后调用 preparePrompt(run) 与 collectArtifacts(run, runtime)；
// 服务启动调 features.start()，关闭调 features.close()。

import { Attachments } from "./features/attachments.mjs";
import { Artifacts } from "./features/artifacts.mjs";
import { Checkpoints } from "./features/checkpoints.mjs";
import { Routines } from "./features/routines.mjs";
import { NativeFeatures } from "./features/native.mjs";
import { hostToolsFor } from "./features/hosttools.mjs";
import { clone, ferr, intArg, isFeatureError } from "./features/util.mjs";

export class WorkbenchFeatures {
  /**
   * @param {{orch:object, bin?:string}} deps
   */
  constructor({ orch, bin } = {}) {
    if (!orch) throw new Error("WorkbenchFeatures 需要 orch");
    this.orch = orch;
    this.home = orch.home;
    this.bin = bin ?? orch.bin ?? "omp";

    this.attachments = new Attachments({ orch, home: this.home });
    this.artifacts = new Artifacts({ orch, home: this.home });
    this.checkpoints = new Checkpoints({ orch, home: this.home });
    this.routines = new Routines({ orch, isPaused: (botId, scope) => this.native.isPaused(botId, scope) });
    this.native = new NativeFeatures({ orch, home: this.home, bin: this.bin });

    /** 飞书桥（DeviceChannelOwner 的所有权）：只做懒加载与单接收器生命周期。 */
    this._bridge = null;
    this.channelsStartError = null;

    this.routes = this.#buildRoutes();
  }

  // ---------------- 生命周期 ----------------

  async start() {
    this.routines.start();
    try {
      await (await this.#bridge()).start();
      this.channelsStartError = null;
    } catch (e) {
      // 配置缺失是可执行的错误，不能吞掉；留给 GET /api/channels/feishu 如实回报。
      this.channelsStartError = { code: e?.code ?? "channels_start_failed", message: e?.message ?? String(e) };
      this.orch.emit?.("channels_start_failed", { error: this.channelsStartError });
    }
  }

  async close() {
    this.routines.stop();
    if (this._bridge) await this._bridge.close();
  }

  async #bridge() {
    if (!this._bridge) {
      const { FeishuBridge, readChannelConfig } = await import("./channels.mjs");
      this._bridge = new FeishuBridge({ orch: this.orch, config: readChannelConfig(this.home) ?? {} });
    }
    return this._bridge;
  }

  /** 受限档（--no-tools）的宿主受控资料工具；CoreOwner 在构建 runtime 工具集时调用。 */
  hostTools(runtime) {
    return hostToolsFor(runtime, { home: this.home });
  }

  isPaused(botId, scope = "private") {
    return this.native.isPaused(botId, scope);
  }

  // ---------------- 运行接入 ----------------

  /**
   * 把本次运行的资料物化进原生回合：
   * - 图片 → 原生 prompt.images（ImageContent）
   * - 文档 → 文本块里给规范绝对路径，由 OMP 原生 read 读取，原文保留
   * 附件必须属于该 Run 的 Bot，否则拒绝（跨 Bot 与任意宿主文件都不行）。
   * @returns {Promise<{text:string, images:object[]}>}
   */
  async preparePrompt(run) {
    const ids = Array.isArray(run?.attachmentIds) ? run.attachmentIds : [];
    let text = typeof run?.text === "string" ? run.text : "";
    if (ids.length === 0) return { text, images: [] };
    if (!run?.botId) throw ferr(400, "invalid_field", "run.botId 必填，无法归属附件");

    const images = [];
    const blocks = [];
    for (const id of ids) {
      const { record, buf } = this.attachments.loadFor(run.botId, id);
      if (record.kind === "image") {
        images.push({ type: "image", mimeType: record.mime, data: buf.toString("base64") });
      } else {
        blocks.push(this.attachments.documentBlock(record));
      }
      this.attachments.markUsed(record.id, run.id);
    }
    if (blocks.length) text = `${blocks.join("\n\n")}\n\n${text}`;
    return { text, images };
  }

  /**
   * 运行结束后登记本次新生成的用户产出（只扫 Bot 自己的工作目录/显式工作区）。
   * @returns {Promise<object[]>}
   */
  async collectArtifacts(run, runtime) {
    const added = this.artifacts.collect(run, runtime);
    for (const a of added) this.orch.emit?.("artifact_added", { artifact: clone(a) });
    return added;
  }

  // ---------------- 路由 ----------------

  #buildRoutes() {
    const R = (method, pattern, handler, { raw = false } = {}) => ({ method, pattern, handler, raw });
    return [
      R("POST", /^\/api\/attachments$/, (c) => ({ attachment: this.attachments.create(c.body ?? {}) })),
      R("GET", /^\/api\/attachments$/, (c) => ({ attachments: this.attachments.list({ botId: c.query.get("botId") }) })),
      R(
        "GET",
        /^\/api\/attachments\/([^/]+)\/preview$/,
        (c) => this.attachments.servePreview(decodeURIComponent(c.params[0]), c.res, { botId: c.query.get("botId") || undefined }),
        { raw: true },
      ),
      R("DELETE", /^\/api\/attachments\/([^/]+)$/, (c) => {
        const ok = this.attachments.remove(decodeURIComponent(c.params[0]));
        if (!ok) throw ferr(404, "attachment_not_found", "附件不存在");
        return { removed: true };
      }),

      R("GET", /^\/api\/artifacts$/, (c) => ({
        artifacts: this.artifacts.list({ botId: c.query.get("botId"), runId: c.query.get("runId") }),
      })),
      R("GET", /^\/api\/artifacts\/([^/]+)\/download$/, (c) => this.artifacts.serveDownload(decodeURIComponent(c.params[0]), c.res), { raw: true }),
      R("GET", /^\/api\/artifacts\/([^/]+)\/preview$/, (c) => this.artifacts.servePreview(decodeURIComponent(c.params[0]), c.res), { raw: true }),

      R("GET", /^\/api\/routines$/, () => ({ routines: this.routines.list() })),
      R("POST", /^\/api\/routines$/, (c) => ({ routine: this.routines.create(c.body ?? {}) })),
      R("PATCH", /^\/api\/routines\/([^/]+)$/, (c) => ({ routine: this.routines.update(decodeURIComponent(c.params[0]), c.body ?? {}) })),
      R("DELETE", /^\/api\/routines\/([^/]+)$/, (c) => {
        const ok = this.routines.remove(decodeURIComponent(c.params[0]));
        if (!ok) throw ferr(404, "routine_not_found", "计划不存在");
        return { removed: true };
      }),
      R("POST", /^\/api\/routines\/([^/]+)\/run$/, async (c) => {
        const out = await this.routines.run(decodeURIComponent(c.params[0]));
        return out;
      }),

      R("GET", /^\/api\/bots\/([^/]+)\/native\/capabilities$/, async (c) =>
        this.native.capabilities(decodeURIComponent(c.params[0]), c.scope),
      ),
      R("GET", /^\/api\/bots\/([^/]+)\/mcp$/, (c) => this.native.mcpStatus(decodeURIComponent(c.params[0]), c.scope)),
      R("PUT", /^\/api\/bots\/([^/]+)\/mcp$/, async (c) =>
        this.native.putMcp(decodeURIComponent(c.params[0]), c.scope, c.body ?? {}),
      ),
      R("GET", /^\/api\/bots\/([^/]+)\/skills$/, async (c) =>
        this.native.skillsStatus(decodeURIComponent(c.params[0]), c.scope),
      ),
      R("PUT", /^\/api\/bots\/([^/]+)\/skills$/, async (c) => {
        const botId = decodeURIComponent(c.params[0]);
        const applied = this.native.putSkills(botId, c.body ?? {});
        // 返回与 GET 同一形状（含新过滤下的生效集合），避免 UI 两条路径两套结构。
        return { ...(await this.native.skillsStatus(botId, c.scope)), restartRequired: applied.restartRequired };
      }),
      R("GET", /^\/api\/bots\/([^/]+)\/memory$/, (c) => this.native.memoryRead(decodeURIComponent(c.params[0]), c.scope)),
      R("PUT", /^\/api\/bots\/([^/]+)\/memory$/, (c) => {
        const botId = decodeURIComponent(c.params[0]);
        this.native.memoryWrite(botId, c.scope, c.body ?? {});
        return this.native.memoryRead(botId, c.scope);
      }),
      R("POST", /^\/api\/bots\/([^/]+)\/memory\/clear$/, (c) => {
        const botId = decodeURIComponent(c.params[0]);
        const cleared = this.native.memoryClear(botId, c.scope);
        return { ...this.native.memoryRead(botId, c.scope), cleared: cleared.cleared };
      }),
      R("GET", /^\/api\/bots\/([^/]+)\/memory\/probe$/, async (c) => ({
        probe: await this.native.verifyMemoryPath(decodeURIComponent(c.params[0]), c.scope),
      })),
      R("POST", /^\/api\/bots\/([^/]+)\/browser\/takeover$/, async (c) =>
        ({ takeover: await this.native.browserTakeover(decodeURIComponent(c.params[0]), c.scope, c.body ?? {}) }),
      ),
      R("POST", /^\/api\/bots\/([^/]+)\/browser\/release$/, async (c) =>
        ({ takeover: await this.native.browserRelease(decodeURIComponent(c.params[0]), c.scope) }),
      ),
      R("GET", /^\/api\/bots\/([^/]+)\/browser$/, async (c) => {
        const botId = decodeURIComponent(c.params[0]);
        // 状态面同时给真实能力判定（eval 描述证据），UI 与 CLI 拿到的都是同一份事实。
        return { ...this.native.browserStatus(botId, c.scope), capability: await this.native.browserCapability(botId, c.scope) };
      }),

      // ---- 飞书桥（DeviceChannelOwner 的服务；这里只懒加载并挂载路由，单接收器生命周期）----
      R("GET", /^\/api\/channels\/feishu$/, async () => ({
        ...(await this.#bridge()).status(),
        startError: this.channelsStartError,
      })),
      R("PUT", /^\/api\/channels\/feishu$/, async (c) => {
        // 归一化交给 channels 自己的实现（enabled 必须是字面 true 才 bind；字符串 'true' 归为关闭）。
        const { readChannelConfig, writeChannelConfig, normalizeChannelConfig, FeishuBridge } = await import("./channels.mjs");
        const next = { ...(readChannelConfig(this.home) ?? {}), ...(c.body ?? {}) };
        normalizeChannelConfig(next);
        writeChannelConfig(this.home, next);
        const previous = this._bridge;
        this._bridge = new FeishuBridge({ orch: this.orch, config: readChannelConfig(this.home) ?? {} });
        if (previous) await previous.close();
        this.channelsStartError = null;
        try {
          await this._bridge.start();
        } catch (e) {
          this.channelsStartError = { code: e?.code ?? "channels_start_failed", message: e?.message ?? String(e) };
        }
        return { ...this._bridge.status(), startError: this.channelsStartError };
      }),
      R("POST", /^\/api\/channels\/feishu\/test$/, async (c) => (await this.#bridge()).test({ live: c.body?.live === true })),

      R("GET", /^\/api\/checkpoints$/, (c) => ({ checkpoints: this.checkpoints.list({ botId: c.query.get("botId") }) })),
      R("POST", /^\/api\/checkpoints$/, (c) => ({ checkpoint: this.#checkpointCreate(c.body ?? {}) })),
      R("GET", /^\/api\/checkpoints\/([^/]+)\/diff$/, (c) =>
        this.checkpoints.diff(c.query.get("botId"), decodeURIComponent(c.params[0])),
      ),
      R("POST", /^\/api\/checkpoints\/([^/]+)\/restore$/, (c) => ({
        result: this.checkpoints.restore(c.query.get("botId") || c.body?.botId, decodeURIComponent(c.params[0]), {
          force: c.body?.force === true,
        }),
      })),
      R("DELETE", /^\/api\/checkpoints\/([^/]+)$/, (c) => {
        const ok = this.checkpoints.remove(c.query.get("botId") || c.body?.botId, decodeURIComponent(c.params[0]));
        if (!ok) throw ferr(404, "checkpoint_not_found", "检查点不存在");
        return { removed: true };
      }),
      R("GET", /^\/api\/checkpoints\/([^/]+)$/, (c) => {
        const m = this.checkpoints.get(c.query.get("botId"), decodeURIComponent(c.params[0]));
        if (!m) throw ferr(404, "checkpoint_not_found", "检查点不存在");
        return { checkpoint: m };
      }),
    ];
  }

  /** 检查点根目录默认取 Bot 的工作目录（runtime 活着时用它的真实 cwd）。 */
  #checkpointCreate(body) {
    const botId = String(body.botId ?? "").trim();
    if (!botId) throw ferr(400, "invalid_field", "botId 必填");
    const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : "private";
    const paths = this.native.paths(botId, scope);
    const root = typeof body.root === "string" && body.root.trim() ? body.root.trim() : paths.workDir;
    return this.checkpoints.create({ botId, scope, root, reason: body.reason });
  }

  /**
   * 产品特性端点入口。
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {URL} url 已解析的真实 URL
   * @param {any} body 已解析的 JSON 请求体（POST/PUT/PATCH 时）
   * @param {(res:object, code:number, obj:any, extra?:object)=>void} json
   * @returns {Promise<boolean>} 是否已应答
   */
  async handleRequest(req, res, url, body, json) {
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    if (!pathname.startsWith("/api/")) return false;
    const method = String(req.method ?? "GET").toUpperCase();
    let methodSeen = false;

    for (const route of this.routes) {
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      if (route.method !== method) {
        methodSeen = true;
        continue;
      }
      const ctx = {
        req,
        res,
        url,
        body,
        query: url.searchParams,
        params: m.slice(1),
        scope: (url.searchParams.get("scope") || body?.scope || "private").trim() || "private",
      };
      try {
        const out = await route.handler(ctx);
        if (route.raw) return true; // 处理器已自行写响应（下载/预览）
        json(res, 200, out);
        return true;
      } catch (e) {
        if (isFeatureError(e)) {
          json(res, intArg(e.status, { dflt: 400, min: 400, max: 599 }), {
            error: e.message,
            code: e.code,
            ...(e.retryAfterMs != null ? { retryAfterMs: e.retryAfterMs } : {}),
            ...(e.extra ?? {}),
          });
          return true;
        }
        throw e;
      }
    }

    if (methodSeen) {
      json(res, 405, { error: `不允许的方法 ${method}`, code: "method_not_allowed" });
      return true;
    }
    return false;
  }
}

export { Attachments, Artifacts, Checkpoints, Routines, NativeFeatures };
