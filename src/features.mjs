// features.mjs — 工作台产品特性层：资料、成果、计划、原生能力面、文件检查点。
//
// 唯一接入点由 server 调用一次：`await orch.features.handleRequest(req,res,url,body,json,security)`，
// 返回 true 表示已应答。鉴权/Host/Origin/Content-Type 已由 ApiOwner 在调用前完成；security 带设备
// 主体、作用域与授权回调（owner 请求不传即保持原行为）。设备只走路由表里显式标注 device 的端点，
// 并按资源登记记录复核 Bot 归属；其余功能面一律 DEVICE_NO_ADMIN。
//
// CoreOwner 在任务前后调用 preparePrompt(run, {signal}) 与 collectArtifacts(run, runtime)；
// 服务启动调 features.start()，关闭调 features.close()。

import { Attachments } from "./features/attachments.mjs";
import { Artifacts } from "./features/artifacts.mjs";
import { Checkpoints } from "./features/checkpoints.mjs";
import { Routines } from "./features/routines.mjs";
import { NativeFeatures } from "./features/native.mjs";
import { Computers } from "./features/computers.mjs";
import { hostToolsFor } from "./features/hosttools.mjs";
import { clone, ferr, intArg, isFeatureError } from "./features/util.mjs";
import { deviceSafeArtifact, deviceSafeAttachment } from "./mobile.mjs";

/** 特性路由的规范化路径：去尾部斜杠，空路径回 "/"（与 handleRequest 同一套）。 */
function routePath(pathname) {
  return String(pathname ?? "").replace(/\/+$/, "") || "/";
}

/** 设备可见投影：作用域过滤 + 去宿主路径；owner 请求不会走到这里。 */
function deviceView(items, scope, project) {
  return items.filter((x) => scope?.has(x.botId)).map(project);
}

export class WorkbenchFeatures {
  /**
   * @param {{orch:object, bin?:string, computerBackend?:object|Function, computerRuntimeDir?:string}} deps
   */
  constructor({ orch, bin, computerBackend = null, computerRuntimeDir = null } = {}) {
    if (!orch) throw new Error("WorkbenchFeatures 需要 orch");
    this.orch = orch;
    this.home = orch.home;
    this.bin = bin ?? orch.bin ?? "omp";

    this.attachments = new Attachments({ orch, home: this.home });
    this.artifacts = new Artifacts({ orch, home: this.home });
    this.checkpoints = new Checkpoints({ orch, home: this.home });
    this.routines = new Routines({ orch, isPaused: (botId, scope) => this.isPaused(botId, scope) });
    this.native = new NativeFeatures({ orch, home: this.home, bin: this.bin });
    this.computers = new Computers({ orch, home: this.home, backend: computerBackend, runtimeDir: computerRuntimeDir });

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
    try {
      await this.computers.close();
    } catch (e) {
      this.orch.emit?.("computer_close_error", { error: e?.message ?? String(e) });
    }
    if (this._bridge) await this._bridge.close();
  }

  notifyApproval(approval) {
    return this._bridge?.notifyApproval(approval);
  }

  async #bridge() {
    if (!this._bridge) {
      const { FeishuBridge, readChannelConfig } = await import("./channels.mjs");
      this._bridge = new FeishuBridge({ orch: this.orch, config: readChannelConfig(this.home) ?? {} });
    }
    return this._bridge;
  }

  /**
   * 宿主受控工具集；CoreOwner 在构建 runtime 工具集时调用。
   * - 未绑定电脑：按原行为给受限档（chat）的宿主资料工具；
   * - 绑定电脑的非 chat 档：不注册任何宿主读写/抓取工具，只给固定客机工具
   *   （团队工具与 rpc-ui 审批由编排器保留）；
   * - 绑定电脑的 chat 档：仍然只有聊天 —— 没有客机工具，也保留既有受控宿主读取工具，
   *   聊天不依赖一台运行中的客机，人工接管期间也照常。
   */
  hostTools(runtime) {
    const bot = runtime?.bot;
    if (bot?.computer && bot.executionMode !== "chat") {
      return this.computers.guestTools({ bot, runtime });
    }
    return hostToolsFor(runtime, { home: this.home });
  }

  /**
   * 人工接管暂停：浏览器接管按 bot::scope；电脑接管是整台电脑，覆盖该 Bot 的所有 scope。
   * chat 档没有客机工具，电脑被人工接管不阻止它聊天。
   */
  isPaused(botId, scope = "private") {
    if (this.native.isPaused(botId, scope)) return true;
    const bot = this.orch.getBot?.(String(botId ?? ""));
    if (!bot || bot.executionMode === "chat") return false;
    return this.computers.isHumanHeld(botId);
  }

  // ---------------- 运行接入 ----------------

  /**
   * 把本次运行的资料物化进原生回合：
   * - 绑定电脑的 Bot：附件按 id 验归属后上传客机 /work/attachments/<id>-<safe-name>，
   *   文本里给客机路径（宿主机路径不交给模型）；图片仍走原生 ImageContent。
   * - 其他 Bot（原有行为不变）：图片 → 原生 prompt.images（ImageContent）；
   *   文档 → 文本块里给规范宿主绝对路径，由 OMP 原生 read 读取，原文保留。
   * 附件必须属于该 Run 的 Bot，否则拒绝（跨 Bot 与任意宿主文件都不行）。
   * @returns {Promise<{text:string, images:object[]}>}
   */
  async preparePrompt(run, { signal } = {}) {
    const viaComputer = await this.computers.preparePrompt(run, { signal });
    if (viaComputer) return viaComputer;
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
    const R = (method, pattern, handler, { raw = false, device = false } = {}) => ({ method, pattern, handler, raw, device });
    return [
      R("POST", /^\/api\/attachments$/, (c) => {
        c.authorize("run", c.body?.botId);
        return { attachment: this.attachments.create(c.body ?? {}) };
      }, { device: true }),
      R("GET", /^\/api\/attachments$/, (c) => {
        c.authorize("read", c.query.get("botId") || undefined);
        const items = this.attachments.list({ botId: c.query.get("botId") });
        return { attachments: c.device ? deviceView(items, c.deviceScope, deviceSafeAttachment) : items };
      }, { device: true }),
      R(
        "GET",
        /^\/api\/attachments\/([^/]+)\/preview$/,
        (c) => {
          const id = decodeURIComponent(c.params[0]);
          const rec = this.attachments.get(id);
          if (!rec) throw ferr(404, "attachment_not_found", `附件不存在：${id}`);
          // 归属以登记记录为准：设备只能预览作用域内 bot 的附件，读了别家的一律 403。
          c.authorize("read", rec.botId);
          this.attachments.servePreview(id, c.res, { botId: c.query.get("botId") || undefined });
        },
        { raw: true, device: true },
      ),
      R("DELETE", /^\/api\/attachments\/([^/]+)$/, (c) => {
        const ok = this.attachments.remove(decodeURIComponent(c.params[0]));
        if (!ok) throw ferr(404, "attachment_not_found", "附件不存在");
        return { removed: true };
      }),

      R("GET", /^\/api\/artifacts$/, (c) => {
        c.authorize("read", c.query.get("botId") || undefined);
        const items = this.artifacts.list({ botId: c.query.get("botId"), runId: c.query.get("runId") });
        return { artifacts: c.device ? deviceView(items, c.deviceScope, deviceSafeArtifact) : items };
      }, { device: true }),
      R("GET", /^\/api\/artifacts\/([^/]+)\/download$/, (c) => {
        const id = decodeURIComponent(c.params[0]);
        const rec = this.artifacts.get(id);
        if (!rec) throw ferr(404, "artifact_not_found", `成果不存在：${id}`);
        c.authorize("read", rec.botId);
        this.artifacts.serveDownload(id, c.res);
      }, { raw: true, device: true }),
      R("GET", /^\/api\/artifacts\/([^/]+)\/preview$/, (c) => {
        const id = decodeURIComponent(c.params[0]);
        const rec = this.artifacts.get(id);
        if (!rec) throw ferr(404, "artifact_not_found", `成果不存在：${id}`);
        c.authorize("read", rec.botId);
        this.artifacts.servePreview(id, c.res);
      }, { raw: true, device: true }),

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

      R("GET", /^\/api\/bots\/([^/]+)\/computer$/, async (c) =>
        ({ computer: await this.computers.status(decodeURIComponent(c.params[0])) }),
      ),
      R("POST", /^\/api\/bots\/([^/]+)\/computer\/bind$/, async (c) =>
        ({ computer: await this.computers.bind(decodeURIComponent(c.params[0])) }),
      ),
      R("POST", /^\/api\/bots\/([^/]+)\/computer\/start$/, async (c) =>
        ({ computer: await this.computers.start(decodeURIComponent(c.params[0])) }),
      ),
      R("POST", /^\/api\/bots\/([^/]+)\/computer\/stop$/, async (c) =>
        ({ computer: await this.computers.stop(decodeURIComponent(c.params[0])) }),
      ),
      R("POST", /^\/api\/bots\/([^/]+)\/computer\/takeover$/, async (c) =>
        ({ computer: await this.computers.takeover(decodeURIComponent(c.params[0])) }),
      ),
      R("POST", /^\/api\/bots\/([^/]+)\/computer\/release$/, async (c) =>
        ({ computer: await this.computers.release(decodeURIComponent(c.params[0]), c.body ?? {}) }),
      ),
      // 同源 PNG：已有鉴权/Host/Origin 判定在 server 完成；查看不会获得输入能力。
      R("GET", /^\/api\/bots\/([^/]+)\/computer\/screen$/, async (c) =>
        this.computers.screen(decodeURIComponent(c.params[0]), c.res),
        { raw: true },
      ),
      R("POST", /^\/api\/bots\/([^/]+)\/computer\/input$/, async (c) =>
        ({ computer: await this.computers.humanInput(decodeURIComponent(c.params[0]), c.body ?? {}) }),
      ),

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
   * server 派发前的设备预检：这个特性路径是否对设备开放。与路由表的 device 标注同源，
   * 不复制第二份放行清单；设备走到未标注的路由仍是 DEVICE_NO_ADMIN。
   */
  allowsDevice(method, rawPath) {
    let pathname;
    try {
      pathname = new URL(String(rawPath ?? "/"), "http://device.local").pathname;
    } catch {
      return false;
    }
    const p = routePath(pathname);
    if (!p.startsWith("/api/")) return false;
    const m = String(method ?? "GET").toUpperCase();
    return this.routes.some((r) => r.device && r.method === m && r.pattern.test(p));
  }

  /**
   * 产品特性端点入口。
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {URL} url 已解析的真实 URL
   * @param {any} body 已解析的 JSON 请求体（POST/PUT/PATCH 时）
   * @param {(res:object, code:number, obj:any, extra?:object)=>void} json
   * @param {{principal?:object, deviceScope?:Set<string>, authorizeDevice?:(action:string, botId?:string)=>object}} [security]
   *   设备主体与授权回调由 server 传入；owner 请求不传，行为与以前一致。
   * @returns {Promise<boolean>} 是否已应答
   */
  async handleRequest(req, res, url, body, json, security = {}) {
    const pathname = routePath(url.pathname);
    if (!pathname.startsWith("/api/")) return false;
    const method = String(req.method ?? "GET").toUpperCase();
    const device = security.principal?.kind === "device" ? security.principal.device : null;
    const deviceScope = security.deviceScope ?? (device ? new Set(device.botIds ?? []) : null);
    const authorizeDevice = typeof security.authorizeDevice === "function" ? security.authorizeDevice : () => null;
    let methodSeen = false;

    for (const route of this.routes) {
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      if (route.method !== method) {
        methodSeen = true;
        continue;
      }
      // 设备只走显式标注 device 的路由；计划/能力/电脑/检查点/通道等一律保持 DEVICE_NO_ADMIN。
      if (device && !route.device) {
        json(res, 403, { error: "设备 token 不能访问该功能面，请使用 owner 凭证", code: "DEVICE_NO_ADMIN" });
        return true;
      }
      const ctx = {
        req,
        res,
        url,
        body,
        query: url.searchParams,
        params: m.slice(1),
        scope: (url.searchParams.get("scope") || body?.scope || "private").trim() || "private",
        device,
        deviceScope,
        authorize: (action, botId) => authorizeDevice(action, botId),
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

export { Attachments, Artifacts, Checkpoints, Routines, NativeFeatures, Computers };
