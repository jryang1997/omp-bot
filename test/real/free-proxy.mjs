// test/real/free-proxy.mjs — 真模型测试用的本地代理：只放行免费模型，密钥只留在这里。
// 白名单外的模型一律 403，所以 OMP 或子任务就算换了模型也花不到钱。
// OpenCode Go 要求客户端自报 User-Agent，并带每会话稳定的 x-opencode-session。
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FREE_MODELS = ["longcat-2.5-preview-free", "beam-free"];
const UPSTREAM = "https://opencode.ai/zen/go/v1";

export async function startFreeProxy({ keyFile = join(homedir(), ".secrets", "opencode.key"), allow = FREE_MODELS } = {}) {
  const key = readFileSync(keyFile, "utf8").trim();
  const session = randomUUID();
  const log = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let model = null;
    try { model = JSON.parse(raw.toString("utf8")).model ?? null; } catch {}
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions") || !allow.includes(model)) {
      log.push({ at: Date.now(), model, blocked: true, url: req.url });
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `free-proxy: 只放行 ${allow.join(", ")}，拒绝 ${model ?? req.url}` } }));
    }
    const entry = { at: Date.now(), model, blocked: false, status: 0, body: raw.toString("utf8") }; // 留着请求体：测试要查密钥有没有进模型
    log.push(entry);
    try {
      const up = await fetch(UPSTREAM + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "user-agent": "omp-bot-test/0.1", "x-opencode-session": session },
        body: raw,
      });
      entry.status = up.status;
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
      if (!up.body) return res.end();
      for await (const c of up.body) res.write(c);
      res.end();
    } catch (e) {
      entry.status = 502;
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `free-proxy: 上游出错 ${e.message}` } }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, log, close: () => new Promise((r) => server.close(r)) };
}

export function freeModelsYml(port, models = FREE_MODELS) {
  return [
    "providers:",
    "  free:",
    `    baseUrl: http://127.0.0.1:${port}/v1`,
    "    apiKey: held-by-free-proxy",
    "    api: openai-completions",
    "    models:",
    ...models.flatMap((id) => [
      `      - id: ${id}`,
      `        name: ${id}`,
      "        reasoning: true",
      "        input: [text]",
      "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
      "        contextWindow: 128000",
      "        maxTokens: 8192",
    ]),
    "",
  ].join("\n");
}
