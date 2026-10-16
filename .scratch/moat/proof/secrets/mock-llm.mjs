// 假的 OpenAI 兼容模型服务：记下每个请求体，第一轮让模型读 secret.txt，之后直接回一句话。
import { createServer } from "node:http";
export function startMockLlm({ toolPath = "secret.txt" } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: raw });
      if (!req.url.includes("chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-model", object: "model" }] }));
        return;
      }
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const msgs = body.messages ?? [];
      const sawTool = msgs.some((m) => m.role === "tool");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "mock-model" };
      if (!sawTool) {
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: toolPath }) } }] }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "读完了。" }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) })));
}
