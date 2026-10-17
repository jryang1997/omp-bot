// test/real/mock-llm.mjs — 脚本化的 OpenAI 兼容模型，零 token，给真 omp 做确定性测试。
// 用户消息里写 [[tool:NAME {json}]]，按顺序一个个发工具调用；都回来后回一句文本。
// 中途插进来的 steer/提醒不打断脚本：总是按最后一条带脚本的用户消息计数。
// [[sleep:ms]] 让回复延迟（测中断）。所有请求留在 requests 里供断言。
import { createServer } from "node:http";

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : "");
const SCRIPT = /\[\[(tool|sleep):/;

/** 按括号配对切 JSON，参数里可以再嵌一段 [[tool:...]]（给子任务的脚本）。 */
function toolSteps(text) {
  const steps = [];
  const head = /\[\[tool:([\w.-]+)\s+\{/g;
  let m;
  while ((m = head.exec(text))) {
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let str = false;
    let end = -1;
    for (let i = start; i < text.length && end < 0; i++) {
      const c = text[i];
      if (str) { if (c === "\\") i++; else if (c === '"') str = false; }
      else if (c === '"') str = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) end = i;
    }
    if (end < 0 || !text.startsWith("]]", end + 1)) continue;
    steps.push({ name: m[1], args: text.slice(start, end + 1) });
    head.lastIndex = end + 3;
  }
  return steps;
}

function plan(messages) {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && SCRIPT.test(textOf(messages[i].content))) { at = i; break; }
  if (at < 0) for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { at = i; break; }
  const user = at >= 0 ? textOf(messages[at].content) : "";
  const steps = toolSteps(user);
  const sleep = Number(/\[\[sleep:(\d+)\]\]/.exec(user)?.[1] || 0);
  const after = messages.slice(at + 1);
  const done = after.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls)).reduce((n, m) => n + m.tool_calls.length, 0);
  if (done < steps.length) return { tool: steps[done], idx: done, sleep };
  const lastTool = [...after].reverse().find((m) => m.role === "tool");
  return { text: steps.length ? `完成。最后结果：${textOf(lastTool?.content).slice(0, 300)}` : "收到。", sleep };
}

export function startMockLlm() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "scripted", object: "model" }] }));
      }
      let j = {};
      try { j = JSON.parse(body); } catch {}
      const messages = j.messages || [];
      const p = plan(messages);
      requests.push({ tools: (j.tools || []).map((t) => t.function?.name), toolDefs: j.tools || [], messages, plan: p });
      if (p.sleep) await new Promise((r) => setTimeout(r, p.sleep));
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: "c1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "scripted" };
      const send = (choice) => res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
      if (p.tool) {
        send({ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}_${p.idx}`, type: "function", function: { name: p.tool.name, arguments: p.tool.args } }] } });
        send({ index: 0, delta: {}, finish_reason: "tool_calls" });
      } else {
        send({ index: 0, delta: { role: "assistant", content: p.text } });
        send({ index: 0, delta: {}, finish_reason: "stop" });
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) }));
  });
}

/** 给 omp 的 models.yml：provider mock，模型 mock/scripted。 */
export function mockModelsYml(port) {
  return [
    "providers:",
    "  mock:",
    `    baseUrl: http://127.0.0.1:${port}/v1`,
    "    apiKey: mock-literal-key",
    "    api: openai-completions",
    "    models:",
    "      - id: scripted",
    "        name: Scripted Mock",
    "        reasoning: false",
    "        input: [text]",
    "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
    "        contextWindow: 128000",
    "        maxTokens: 4096",
    "",
  ].join("\n");
}
