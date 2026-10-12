// server.mjs — 常驻 HTTP 服务：GUI 的后端。
// 零依赖（node:http）。127.0.0.1 本地监听（与 crayonlu/omp-bot 的 dashboard 同思路），
// 静态文件 + JSON API + SSE 实时事件流。
//
// 常驻进程同时解决了 CLI 每条命令重启 runtime 的慢：bot 进程在两次消息之间活着。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { Orchestrator } from "./orchestrator.mjs";
import { collectUsage } from "./usage.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

/** 跑 `omp models --json` 拿模型目录（GUI 下拉框用），结果缓存。 */
let modelsCache = null;
function fetchModels(bin) {
  if (modelsCache) return Promise.resolve(modelsCache);
  return new Promise((resolve) => {
    execFile(bin, ["models", "--json"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ models: [], error: err.message });
      try {
        modelsCache = JSON.parse(stdout);
        resolve(modelsCache);
      } catch (e) {
        resolve({ models: [], error: e.message });
      }
    });
  });
}

export async function startServer({ port = 3099, host = "127.0.0.1", home, bin = "omp", debug = false, defaultThinking = "low" } = {}) {
  const orch = new Orchestrator({
    ...(home ? { home } : {}),
    bin,
    debug,
    defaultThinking,
    onEvent: () => {},
  });

  // SSE 客户端
  const sseClients = new Set();
  orch.onEvent = (evt) => {
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch {}
    }
  };

  const json = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
        if (data.length > 4 * 1024 * 1024) {
          reject(new Error("body too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("bad json body")); }
      });
      req.on("error", reject);
    });

  async function serveStatic(req, res, pathname) {
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    const full = normalize(join(WEB_DIR, rel));
    // 防目录穿越：解析后必须仍在 WEB_DIR 内
    if (!full.startsWith(WEB_DIR + sep) && full !== WEB_DIR) {
      res.writeHead(403); return res.end("forbidden");
    }
    if (!existsSync(full)) {
      res.writeHead(404); return res.end("not found");
    }
    const ext = full.slice(full.lastIndexOf("."));
    const buf = await readFile(full);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Content-Length": buf.length });
    res.end(buf);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    try {
      // ---- SSE ----
      if (path === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      // ---- API ----
      if (path === "/api/state" && req.method === "GET") {
        return json(res, 200, { bots: orch.listBots(), rooms: orch.listRooms() });
      }

      if (path === "/api/models" && req.method === "GET") {
        return json(res, 200, await fetchModels(bin));
      }

      if (path === "/api/usage" && req.method === "GET") {
        const u = await collectUsage(orch);
        return json(res, 200, { perRuntime: u.perRuntime, totals: u.totals });
      }

      if (path === "/api/bots" && req.method === "POST") {
        const b = await readBody(req);
        if (!b.name) return json(res, 400, { error: "name 必填" });
        if (orch.listBots().some((x) => x.name === b.name)) {
          return json(res, 409, { error: `名字「${b.name}」已被占用` });
        }
        const bot = orch.addBot({
          name: b.name,
          role: b.role ?? "",
          instructions: b.instructions ?? "",
          model: b.model ?? "",
          thinking: b.thinking,
          isMain: !!b.isMain,
        });
        return json(res, 200, { bot });
      }

      let m = path.match(/^\/api\/bots\/([^/]+)$/);
      if (m && req.method === "PATCH") {
        const patch = await readBody(req);
        const bot = orch.updateBot(m[1], patch);
        if (!bot) return json(res, 404, { error: "bot 不存在" });
        return json(res, 200, { bot });
      }
      if (m && req.method === "DELETE") {
        orch.removeBot(m[1]);
        return json(res, 200, { ok: true });
      }

      m = path.match(/^\/api\/chat\/([^/]+)$/);
      if (m && req.method === "GET") {
        if (!orch.getBot(m[1])) return json(res, 404, { error: "bot 不存在" });
        return json(res, 200, { messages: orch.getChat(m[1]) });
      }
      if (m && req.method === "DELETE") {
        if (!orch.getBot(m[1])) return json(res, 404, { error: "bot 不存在" });
        orch.clearChat(m[1]);
        return json(res, 200, { ok: true });
      }
      if (m && req.method === "POST") {
        const { text, timeoutMs } = await readBody(req);
        if (!text) return json(res, 400, { error: "text 必填" });
        const rt = orch.runtimes.get(`${m[1]}::private`);
        if (rt?.busy) return json(res, 409, { error: "该 bot 正忙（在处理上一条），稍后再发" });
        try {
          const reply = await orch.chatWithBot(m[1], text, { timeoutMs: timeoutMs ?? 600_000 });
          return json(res, 200, { reply });
        } catch (e) {
          return json(res, 502, { error: e?.message ?? String(e) });
        }
      }

      if (path === "/api/rooms" && req.method === "POST") {
        const b = await readBody(req);
        if (!b.name || !Array.isArray(b.members) || !b.members.length) {
          return json(res, 400, { error: "name 和非空 members 必填" });
        }
        for (const id of b.members) {
          if (!orch.getBot(id)) return json(res, 400, { error: `成员不存在: ${id}` });
        }
        const room = orch.createRoom({ name: b.name, members: b.members, adminId: b.adminId ?? null, mode: b.mode ?? "admin" });
        return json(res, 200, { room });
      }

      m = path.match(/^\/api\/rooms\/([^/]+)$/);
      if (m && req.method === "PATCH") {
        const patch = await readBody(req);
        if (Array.isArray(patch.members)) {
          for (const id of patch.members) {
            if (!orch.getBot(id)) return json(res, 400, { error: `成员不存在: ${id}` });
          }
        }
        const room = orch.updateRoom(m[1], patch);
        if (!room) return json(res, 404, { error: "room 不存在" });
        return json(res, 200, { room });
      }
      if (m && req.method === "DELETE") {
        orch.removeRoom(m[1]);
        return json(res, 200, { ok: true });
      }

      m = path.match(/^\/api\/rooms\/([^/]+)\/say$/);
      if (m && req.method === "POST") {
        const { text, userName } = await readBody(req);
        if (!text) return json(res, 400, { error: "text 必填" });
        try {
          const spoken = await orch.postToRoom(m[1], text, { userName: userName ?? "用户" });
          return json(res, 200, { spoken });
        } catch (e) {
          return json(res, 502, { error: e?.message ?? String(e) });
        }
      }

      if (path.startsWith("/api/")) {
        return json(res, 404, { error: "unknown api" });
      }

      // ---- 静态 ----
      return await serveStatic(req, res, path);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e?.message ?? String(e) });
      else res.end();
      if (debug) console.error(e);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  // port:0 时取系统分配的实际端口
  const realPort = server.address()?.port ?? port;
  return {
    server,
    orch,
    url: `http://${host}:${realPort}`,
    async close() {
      for (const res of sseClients) { try { res.end(); } catch {} }
      sseClients.clear();
      server.close();
      await orch.shutdown();
    },
  };
}
