// smoke-gui.mjs — HTTP API 层 smoke test。零模型调用，快且确定。
// 起真实 server（随机端口 + 临时 home），走一遍 GUI 依赖的全部端点。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./src/server.mjs";

let passed = 0;
let failed = 0;
function check(name, ok, ev = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ev ? "\n      " + ev : ""}`);
}

const home = mkdtempSync(join(tmpdir(), "ompbot-gui-smoke-"));
const { url, close } = await startServer({ port: 0, host: "127.0.0.1", home });

async function api(path, opts = {}) {
  const res = await fetch(path.startsWith("http") ? path : url + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  // 静态
  const idx = await fetch(url + "/");
  const idxText = await idx.text();
  check("GET / 返回 index.html", idx.status === 200 && idxText.includes("<title>omp-bot</title>"));
  const css = await fetch(url + "/style.css");
  check("GET /style.css", css.status === 200);
  const js = await fetch(url + "/app.js");
  check("GET /app.js", js.status === 200);
  const trav = await fetch(url + "/../package.json");
  check("目录穿越被拒", trav.status === 403 || trav.status === 404, `status=${trav.status}`);

  // models
  const models = await api("/api/models");
  check("GET /api/models 返回模型目录", models.status === 200 && Array.isArray(models.data.models), `n=${models.data.models?.length}`);

  // bot CRUD
  const created = await api("/api/bots", { method: "POST", body: { name: "Calc", role: "计算", instructions: "x" } });
  check("POST /api/bots 创建", created.status === 200 && !!created.data.bot?.id, JSON.stringify(created.data.bot?.id));
  const dup = await api("/api/bots", { method: "POST", body: { name: "Calc" } });
  check("重名 409", dup.status === 409);
  const noname = await api("/api/bots", { method: "POST", body: {} });
  check("缺名字 400", noname.status === 400);

  const botId = created.data.bot.id;
  check("默认 thinking=low 注入", created.data.bot.thinking === "low");

  const patched = await api(`/api/bots/${botId}`, { method: "PATCH", body: { role: "数字官", thinking: "high" } });
  check("PATCH 更新 bot", patched.status === 200 && patched.data.bot.role === "数字官" && patched.data.bot.thinking === "high");
  check("PATCH 后 runtime 已停（下条消息按新配置重启）", !patched.data.error);

  const state1 = await api("/api/state");
  check("GET /api/state 列出 bot", state1.data.bots?.length === 1);

  // 聊天日志（没聊过 → 空数组）
  const chat0 = await api(`/api/chat/${botId}`);
  check("GET /api/chat 空历史", chat0.status === 200 && Array.isArray(chat0.data.messages) && chat0.data.messages.length === 0);
  const chatDel = await api(`/api/chat/${botId}`, { method: "DELETE" });
  check("DELETE /api/chat 清空", chatDel.status === 200);
  const chat404 = await api("/api/chat/nope");
  check("未知 bot 404", chat404.status === 404);

  // room
  const bot2 = await api("/api/bots", { method: "POST", body: { name: "Chief" } });
  const room = await api("/api/rooms", {
    method: "POST",
    body: { name: "工作组", members: [bot2.data.bot.id, botId], adminId: bot2.data.bot.id, mode: "admin" },
  });
  check("POST /api/rooms 建群", room.status === 200 && room.data.room.members.length === 2);
  const badRoom = await api("/api/rooms", { method: "POST", body: { name: "x", members: ["nope"] } });
  check("群成员不存在 400", badRoom.status === 400);
  const roomPatched = await api(`/api/rooms/${room.data.room.id}`, { method: "PATCH", body: { mode: "everyone" } });
  check("PATCH room 模式", roomPatched.status === 200 && roomPatched.data.room.mode === "everyone");
  const sayNoText = await api(`/api/rooms/${room.data.room.id}/say`, { method: "POST", body: {} });
  check("say 缺 text 400", sayNoText.status === 400);

  // usage（没跑过回合 → 空表）
  const usage = await api("/api/usage");
  check("GET /api/usage", usage.status === 200 && Array.isArray(usage.data.perRuntime));

  // SSE
  const sseRes = await fetch(url + "/api/events");
  const reader = sseRes.body.getReader();
  const first = await Promise.race([
    reader.read().then(({ value }) => new TextDecoder().decode(value)),
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 3000)),
  ]);
  reader.cancel().catch(() => {});
  check("SSE 首帧 hello", typeof first === "string" && first.includes('"type":"hello"'), JSON.stringify(first).slice(0, 60));

  // 删除
  const delBot = await api(`/api/bots/${botId}`, { method: "DELETE" });
  check("DELETE bot", delBot.status === 200);
  const delRoom = await api(`/api/rooms/${room.data.room.id}`, { method: "DELETE" });
  check("DELETE room", delRoom.status === 200);
  const state2 = await api("/api/state");
  check("删除后 state 一致", state2.data.bots.length === 1 && state2.data.rooms.length === 0);

  const unknown = await api("/api/nope");
  check("未知 API 404", unknown.status === 404);
} finally {
  await close();
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);
