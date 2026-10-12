#!/usr/bin/env node
// ompbot.mjs — omp-bot 命令行入口（零依赖）。
//
// 把「常驻 bot 团队」暴露成可交互的 CLI。数据落在 --home（默认 ~/.ompbot）。
//
// 用法：
//   ompbot.mjs demo                         # 建两个 bot，跑一次私聊委派，打印用量
//   ompbot.mjs bots add <name> [--role R] [--model M] [--instructions I] [--main]
//   ompbot.mjs bots list
//   ompbot.mjs bots rm <name|id>
//   ompbot.mjs room create <name> --members A,B [--admin A] [--mode admin|everyone]
//   ompbot.mjs room list
//   ompbot.mjs chat <bot> "<message>"        # 私聊一个 bot（跨调用续会话）
//   ompbot.mjs say <room> "<message>"        # 在群里发言，跑 relay
//   ompbot.mjs usage                         # 跨 bot 用量汇总
//   ompbot.mjs interactive <bot|room:ROOM>   # REPL 连续对话

import { createInterface } from "node:readline";
import { exec } from "node:child_process";
import { Orchestrator } from "./src/orchestrator.mjs";
import { collectUsage, renderUsageTable } from "./src/usage.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

function flag(name, dflt = undefined) {
  const i = rest.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < rest.length) return rest[i + 1];
  return dflt;
}
function hasFlag(name) {
  return rest.includes(`--${name}`);
}
function die(msg) {
  console.error(msg);
  process.exit(1);
}

const HOME = process.env.OMPBOT_HOME || flag("home");
const MODEL = process.env.OMPBOT_MODEL || flag("model") || "";
const DEBUG = process.env.OMPBOT_DEBUG === "1" || hasFlag("debug");
// 全局默认思考档（各 bot 未显式指定时用）。CLI 顶层 --thinking 也可覆盖。
const THINKING = process.env.OMPBOT_THINKING || (argv.includes("--thinking") ? flag("thinking") : undefined);

function newOrch() {
  const opts = { debug: DEBUG, onEvent: (e) => {
    if (DEBUG) console.error("·", e.type, JSON.stringify(e).slice(0, 160));
  } };
  if (HOME) opts.home = HOME;
  if (THINKING) opts.defaultThinking = THINKING;
  return new Orchestrator(opts);
}

async function main() {
  switch (cmd) {
    case "serve":
      return runServe();
    case "demo":
      return runDemo();
    case "bots":
      return runBots();
    case "room":
      return runRoom();
    case "chat":
      return runChat();
    case "say":
      return runSay();
    case "usage":
      return runUsage();
    case "interactive":
      return runInteractive();
    case "help":
    case undefined:
      return printHelp();
    default:
      die(`未知命令: ${cmd}\n\n${helpText()}`);
  }
}

function printHelp() {
  console.log(helpText());
}

function helpText() {
  return `omp-bot — 在 omp 上跑一支常驻 AI bot 团队

命令:
  serve [--port 3099]           启动 GUI（网页控制台），默认自动打开浏览器
  demo                          建两个 bot 跑一次私聊委派，打印用量
  bots add <name> [选项]        新增 bot
  bots list                     列出所有 bot
  bots rm <name|id>             删除 bot
  room create <name> --members A,B [--admin A] [--mode admin|everyone]
  room list                     列出所有群
  chat <bot> "<message>"        私聊一个 bot（跨调用续会话）
  say <room> "<message>"        在群里发言，跑 relay 回合
  usage                         跨 bot 用量汇总
  interactive <bot|room:ROOM>   REPL 连续对话

选项:
  --role R          bot 角色定位
  --instructions I  bot 专属指令
  --model M         绑定模型（默认用 omp 默认模型）
  --thinking T      思考档 off|low|medium|high|xhigh|max（默认 low，见 OMPBOT_THINKING）
  --main            标记为主 bot
  --home DIR        数据目录（默认 ~/.ompbot，或 $OMPBOT_HOME）
  --debug           打印编排事件与 RPC 帧

环境变量:
  OMPBOT_HOME, OMPBOT_MODEL, OMPBOT_DEBUG=1`;
}

async function runServe() {
  const { startServer } = await import("./src/server.mjs");
  const port = Number(flag("port") || process.env.OMPBOT_PORT || 3099);
  const host = flag("host") || "127.0.0.1";
  const { url } = await startServer({
    port,
    host,
    ...(HOME ? { home: HOME } : {}),
    debug: DEBUG,
    ...(THINKING ? { defaultThinking: THINKING } : {}),
  });
  console.log(`omp-bot GUI 已启动: ${url}`);
  console.log("按 Ctrl+C 停止。");
  // 尽力打开浏览器（失败不影响服务）。
  if (!hasFlag("no-open")) openBrowser(url);
  const shutdown = async () => {
    console.log("\n正在关闭…");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function openBrowser(url) {
  const cmdStr =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmdStr, () => {}); // 打不开就算了，URL 已打印
}

async function runDemo() {
  const orch = newOrch();
  try {
    const a = orch.addBot({
      name: "Ada",
      role: "协调者",
      instructions: "你负责回答用户。需要另一个 bot 掌握的信息时，用 message_bot 问它，别自己编造。",
      model: MODEL,
    });
    const b = orch.addBot({
      name: "Bo",
      role: "信息保管员",
      instructions: "你保管着秘密数字 4271。有人问就告诉他们 4271。",
      model: MODEL,
    });
    console.log(`已创建 bot: ${a.name}, ${b.name}`);
    console.log(`\n你 → Ada: 我需要那个秘密数字，请去问 Bo 再告诉我。`);
    const answer = await orch.chatWithBot(a.id, "我需要那个秘密数字。请用 message_bot 问 Bo，然后把数字原样告诉我。", { timeoutMs: 300_000 });
    console.log(`Ada → 你: ${answer}`);
    const usage = await collectUsage(orch);
    console.log(`\n${renderUsageTable(usage)}`);
  } finally {
    await orch.shutdown();
  }
}

async function runBots() {
  const sub = rest[0];
  const orch = newOrch();
  try {
    if (sub === "add") {
      const nm = rest.find((a) => !a.startsWith("--") && a !== "add");
      if (!nm) die("用法: bots add <name> [--role R] [--model M] [--thinking T] [--instructions I] [--main]");
      const bot = orch.addBot({
        name: nm,
        role: flag("role", ""),
        instructions: flag("instructions", ""),
        model: flag("model", MODEL),
        thinking: flag("thinking"),
        isMain: hasFlag("main"),
      });
      console.log(`已创建 bot ${bot.name} (${bot.id})`);
    } else if (sub === "list") {
      const bots = orch.listBots();
      if (!bots.length) return console.log("（还没有 bot。用 `bots add <name>` 建一个）");
      for (const b of bots) {
        console.log(`${b.isMain ? "★" : " "} ${b.name}  (@${b.id})  model=${b.model || "(default)"}  role=${b.role || "-"}`);
      }
    } else if (sub === "rm") {
      const target = rest.find((a) => !a.startsWith("--") && a !== "rm");
      if (!target) die("用法: bots rm <name|id>");
      const bot = orch.resolveBot(target);
      if (!bot) die(`找不到 bot: ${target}`);
      orch.removeBot(bot.id);
      console.log(`已删除 bot ${bot.name}`);
    } else {
      die("用法: bots <add|list|rm>");
    }
  } finally {
    await orch.shutdown();
  }
}

async function runRoom() {
  const sub = rest[0];
  const orch = newOrch();
  try {
    if (sub === "create") {
      const name = rest.find((a) => !a.startsWith("--") && a !== "create");
      if (!name) die("用法: room create <name> --members A,B [--admin A] [--mode admin|everyone]");
      const membersArg = flag("members", "");
      if (!membersArg) die("必须给 --members A,B");
      const memberNames = membersArg.split(",").map((s) => s.trim()).filter(Boolean);
      const memberIds = memberNames.map((n) => {
        const b = orch.resolveBot(n);
        if (!b) die(`找不到成员 bot: ${n}`);
        return b.id;
      });
      const adminName = flag("admin");
      const adminId = adminName ? orch.resolveBot(adminName)?.id ?? null : null;
      const room = orch.createRoom({
        name,
        members: memberIds,
        adminId,
        mode: flag("mode", "admin"),
      });
      console.log(`已创建群「${room.name}」(${room.id})  mode=${room.mode}  成员=${memberNames.join(", ")}`);
    } else if (sub === "list") {
      const rooms = orch.listRooms();
      if (!rooms.length) return console.log("（还没有群）");
      for (const r of rooms) {
        const names = r.members.map((id) => orch.getBot(id)?.name ?? id);
        const admin = orch.getBot(r.adminId)?.name ?? "-";
        console.log(`${r.name}  (${r.id})  mode=${r.mode}  admin=${admin}  成员=${names.join(", ")}`);
      }
    } else {
      die("用法: room <create|list>");
    }
  } finally {
    await orch.shutdown();
  }
}

async function runChat() {
  const botName = rest[0];
  const text = rest.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  if (!botName || !text) die('用法: chat <bot> "<message>"');
  const orch = newOrch();
  try {
    const bot = orch.resolveBot(botName);
    if (!bot) die(`找不到 bot: ${botName}`);
    const answer = await orch.chatWithBot(bot.id, text, { timeoutMs: 300_000 });
    console.log(answer);
  } finally {
    await orch.shutdown();
  }
}

async function runSay() {
  const roomName = rest[0];
  const text = rest.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  if (!roomName || !text) die('用法: say <room> "<message>"');
  const orch = newOrch();
  try {
    const room = orch.listRooms().find((r) => r.name === roomName || r.id === roomName);
    if (!room) die(`找不到群: ${roomName}`);
    orch.onEvent = (e) => {
      if (DEBUG) console.error("·", e.type, JSON.stringify(e).slice(0, 160));
      if (e.type === "room_bot_post") console.log(`  [${e.bot}] ${e.text}`);
      else if (e.type === "room_bot_pass") console.log(`  [${e.bot}] (PASS)`);
    };
    console.log(`你 → 「${room.name}」: ${text}`);
    await orch.postToRoom(room.id, text, { userName: flag("as", "用户") });
  } finally {
    await orch.shutdown();
  }
}

async function runUsage() {
  const orch = newOrch();
  try {
    // usage 需要 runtime 在跑；CLI 一次性调用下 runtime 池为空，这里提示。
    const usage = await collectUsage(orch);
    console.log(renderUsageTable(usage));
    if (!usage.perRuntime.length) {
      console.log("\n提示：用量来自当前进程内已启动的 runtime。");
      console.log("CLI 一次性命令跑完即退出，要看累积用量请用 interactive 会话，或直接查各 bot 的 session 目录。");
    }
  } finally {
    await orch.shutdown();
  }
}

async function runInteractive() {
  const target = rest[0];
  if (!target) die("用法: interactive <bot|room:ROOM>");
  const orch = newOrch();
  const isRoom = target.startsWith("room:");
  const name = isRoom ? target.slice(5) : target;

  let bot = null, room = null;
  if (isRoom) {
    room = orch.listRooms().find((r) => r.name === name || r.id === name);
    if (!room) { await orch.shutdown(); die(`找不到群: ${name}`); }
    console.log(`进入群「${room.name}」。发言会触发 relay；:quit 退出。`);
  } else {
    bot = orch.resolveBot(name);
    if (!bot) { await orch.shutdown(); die(`找不到 bot: ${name}`); }
    console.log(`与 ${bot.name} 私聊。:quit 退出，:usage 看用量。`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", async () => { await orch.shutdown(); process.exit(0); });

  const ask = () => rl.question(isRoom ? `「${room.name}」> ` : `${bot.name}> `, async (line) => {
    const text = line.trim();
    if (!text) return ask();
    if (text === ":quit" || text === ":q") { await orch.shutdown(); rl.close(); return; }
    if (text === ":usage") {
      console.log(renderUsageTable(await collectUsage(orch)));
      return ask();
    }
    try {
      if (isRoom) {
        orch.onEvent = (e) => {
          if (e.type === "room_bot_post") console.log(`  [${e.bot}] ${e.text}`);
          else if (e.type === "room_bot_pass") console.log(`  [${e.bot}] (PASS)`);
        };
        await orch.postToRoom(room.id, text, { userName: flag("as", "用户") });
      } else {
        const answer = await orch.chatWithBot(bot.id, text, { timeoutMs: 300_000 });
        console.log(`${bot.name}: ${answer}`);
      }
    } catch (e) {
      console.error("出错:", e?.message ?? e);
    }
    ask();
  });
  ask();
}

main().catch((e) => {
  // 业务错误（模型无 key、bot 找不到等）打干净一行；--debug 才显示堆栈。
  if (DEBUG) console.error(e?.stack ?? e);
  else console.error(`错误: ${e?.message ?? e}`);
  process.exit(1);
});
