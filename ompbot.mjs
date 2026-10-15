#!/usr/bin/env node
// ompbot.mjs — omp-bot 命令行入口（零依赖）。
//
// 把「常驻 bot 团队」暴露成可交互的 CLI。数据落在 --home（默认 ~/.ompbot）。
// 所有命令直接跑本机 Orchestrator：台账、Run、审批和 OMP 原生会话都由核心负责，
// CLI 只是入口，不另开 HTTP 模型引擎，也不自己存凭据。
//
// 用法：见 `node ompbot.mjs help`。

import { createInterface } from "node:readline";
import { exec, execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { Orchestrator } from "./src/orchestrator.mjs";
import { TERMINAL_RUN_STATES } from "./src/constants.mjs";
import { normalizeBudget, permissionOf } from "./src/domain.mjs";
import { readServerDescriptor, serverDescriptorPath, startServer } from "./src/server.mjs";
import { collectUsage, renderUsageTable } from "./src/usage.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

const MIN_OMP = [18, 10, 0];
const MIN_NODE_MAJOR = 24;

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

/** 新命令用严格解析：--name value、--name=value、布尔 --json。 */
function parseArgs(args) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      flags[arg.slice(2)] = args[++i];
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { positionals, flags };
}
/** 打印 JSON 并返回 true（调用方据此提前 return，不再打印人类可读行）。 */
function jsonOut(value, asJson) {
  if (!asJson) return false;
  console.log(JSON.stringify(value, null, 2));
  return true;
}
function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
  return Number.isFinite(n) && n > 0 ? Math.round(n * scale) : null;
}

const HOME = process.env.OMPBOT_HOME || flag("home");
const MODEL = process.env.OMPBOT_MODEL || flag("model") || "";
const DEBUG = process.env.OMPBOT_DEBUG === "1" || hasFlag("debug");
// 全局默认思考档（各 bot 未显式指定时用）。CLI 顶层 --thinking 也可覆盖。
const THINKING = process.env.OMPBOT_THINKING || (argv.includes("--thinking") ? flag("thinking") : undefined);
const PKG = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return m ? m.slice(1, 4).map(Number) : null;
}
function atLeast(found, minimum) {
  for (let i = 0; i < minimum.length; i++) {
    if ((found[i] ?? 0) !== minimum[i]) return (found[i] ?? 0) > minimum[i];
  }
  return true;
}

/** 找本机原生 omp（用于版本与兼容检查，不碰凭据）。 */
function resolveOmp() {
  const executable = process.platform === "win32" ? "omp.exe" : "omp";
  const candidates = (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(isAbsolute)
    .map((dir) => join(resolve(dir), executable));
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "omp", executable));
  }
  if (process.env.OMP_BIN) candidates.unshift(process.env.OMP_BIN);
  return candidates.find(existsSync) ?? null;
}

/** 本机兼容底线：台账用 node:sqlite（Node >= 24），协议按 OMP 18.10 冻结。 */
async function checkRuntime() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!(major >= MIN_NODE_MAJOR)) {
    die(`需要 Node ${MIN_NODE_MAJOR} 或更新版本（当前 ${process.versions.node}）：工作台台账使用内置 node:sqlite。`);
  }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    if (typeof DatabaseSync !== "function") throw new Error("DatabaseSync 缺失");
  } catch (error) {
    die(`当前运行时缺少可用的 node:sqlite，工作台无法保存台账：${error.message}`);
  }
  const bin = resolveOmp();
  if (!bin) {
    die("找不到 omp。请先安装 oh-my-pi，把 omp.exe 加入 PATH，或设置 OMP_BIN 指向它。");
  }
  let version;
  try {
    version = parseVersion(execFileSync(bin, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 }));
  } catch (error) {
    die(`无法运行 ${bin} --version：${error.message}`);
  }
  if (!version || !atLeast(version, MIN_OMP)) {
    die(`${bin} 版本为 ${version ? version.join(".") : "未知"}，低于要求的 OMP ${MIN_OMP.join(".")}。请先升级 OMP（omp update）。`);
  }
  return { bin, version: version.join(".") };
}

async function newOrch() {
  const omp = await checkRuntime();
  const opts = { bin: omp.bin, debug: DEBUG, onEvent: (e) => {
    if (DEBUG) console.error("·", e.type, JSON.stringify(e).slice(0, 160));
  } };
  if (HOME) opts.home = HOME;
  if (THINKING) opts.defaultThinking = THINKING;
  return new Orchestrator(opts);
}

/** 只读进程既没有锁也没有要落盘的状态：只读时不要调 shutdown（它会尝试写盘并报错）。 */
async function closeOrch(orch) {
  if (orch.store?.readonly) return;
  await orch.shutdown();
}

// ---------------------------------------------------------------------------
// 与正在运行的 serve/GUI 对接。同一 home 只能有一个写者：另一个进程持锁时，CLI 不启第二个
// 引擎（它没有那些运行的内存控制块，取消只会得到 accepted:false），而是把需要活跃运行时的
// 操作发给那个进程的本机 HTTP API。凭证来自显式 --url/OMPBOT_TOKEN，或服务写在 home 里的
// runtime.json。任何一步不可用都如实拒绝，绝不打印「已停止」这类没发生的事。
// ---------------------------------------------------------------------------

function homeDir(flags = {}) {
  return resolve(
    flags.home ?? HOME ?? process.env.OMPBOT_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".ompbot"),
  );
}

function isLoopback(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function httpTarget(base, token) {
  const root = String(base).replace(/\/+$/, "");
  return {
    base: root,
    async call(method, path, body) {
      const response = await fetch(`${root}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (!response.ok) {
        const error = new Error(data?.error ?? data?.message ?? `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return data;
    },
  };
}

/** 找正在运行的服务：--url/OMPBOT_URL 优先，其次用 server 自己导出的读取器看 home 里的 runtime.json。 */
async function liveTarget(flags = {}) {
  const url = typeof flags.url === "string" ? flags.url : process.env.OMPBOT_URL;
  const token = typeof flags.token === "string" ? flags.token : process.env.OMPBOT_TOKEN;
  if (url) {
    if (!token) die("给了 --url/OMPBOT_URL 就必须同时给 OMPBOT_TOKEN（或 --token）：CLI 不会自己猜网关凭证。");
    if (!isLoopback(url)) die(`--url 只接受本机回环地址（当前 ${url}）；远端/隧道模式不在这一版范围内。`);
    return httpTarget(url, token);
  }
  let descriptor = null;
  try {
    // 读取器已经校验：文件可解析、url/token 是字符串、pid 活着、且 state.lock 的 pid 与它一致。
    descriptor = await readServerDescriptor(homeDir(flags));
  } catch {
    descriptor = null;
  }
  if (!descriptor?.url || !descriptor?.token || !isLoopback(descriptor.url)) return null;
  return httpTarget(descriptor.url, descriptor.token);
}

/** 本地只读时，写入类操作要明确拒绝，而不是抛底层 SQLite 错误。 */
function requireWritable(orch, what) {
  if (!orch.store?.readonly) return;
  die(
    `数据目录正由另一个进程使用（本进程只读），不能${what}。\n` +
      "把命令发给正在运行的那个进程：加 --url http://127.0.0.1:PORT 与 OMPBOT_TOKEN=<token>；或直接在它的界面里操作。",
  );
}

async function liveFind(live, kind, name) {
  const state = await live.call("GET", "/api/state");
  const list = (kind === "bot" ? state?.bots : state?.rooms) ?? [];
  const hit = list.find((x) => x?.id === name || x?.name === name);
  if (!hit) die(`找不到${kind === "bot" ? " bot" : "群"}: ${name}`);
  return hit;
}

async function liveFindRun(live, id) {
  const direct = await live.call("GET", `/api/runs/${encodeURIComponent(id)}`).catch((error) => {
    if (error.status === 404) return null;
    throw error;
  });
  if (direct?.run) return direct.run;
  const { runs } = await live.call("GET", "/api/runs?limit=500");
  const hit = (runs ?? []).find((run) => run.id === id || run.id.startsWith(id));
  if (!hit) die(`找不到运行: ${id}`);
  return hit;
}

/** 停止结果的唯一出口：只有真的 cancelled 才说停止，其余状态如实说明且非零退出。 */
function reportStop(runId, result, asJson) {
  const run = result?.run ?? null;
  const accepted = result?.accepted === true;
  if (asJson) console.log(JSON.stringify(result ?? { accepted: false }, null, 2));
  if (accepted && run?.state === "cancelled") {
    if (!asJson) console.log(`已停止: ${runId} → cancelled`);
    return undefined;
  }
  if (accepted && run?.state === "cancelling") {
    if (!asJson) console.log(`已受理取消，仍在停止中: ${runId} → cancelling`);
    return undefined;
  }
  if (accepted) {
    // 被接受但没有确认停止：状态未知，不能当成已经停下。
    die(
      `取消被接受，但状态未确认: ${runId} → ${run?.state ?? "未知"}。\n` +
        "不要当成已停止；稍后用 `runs get` 确认终态。",
    );
  }
  if (run && TERMINAL_RUN_STATES.has(run.state)) {
    if (!asJson) console.log(`运行已结束（${run.state}），无需停止: ${runId}`);
    return undefined;
  }
  die(
    `无法停止 ${runId}：本进程没有它的运行时（运行时属于正在持有数据目录的那个进程，或它已经不存在），只改台账不是停止。\n` +
      "把命令发给那个进程：--url http://127.0.0.1:PORT 且 OMPBOT_TOKEN=<token>；或在它的界面上停止。",
  );
  return undefined;
}

function printRuns(orch, runs) {
  if (!runs.length) return console.log("（没有匹配的运行）");
  for (const run of runs) {
    const who = orch ? orch.getBot(run.botId)?.name : null;
    console.log(
      `${run.id}  ${String(run.state).padEnd(22)} ${who ?? run.botId ?? "-"}  ${run.kind}  ${String(run.updatedAt ?? "").replace("T", " ").slice(0, 19)}  ${(run.text ?? "").slice(0, 60)}`,
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 审批：原生 extension UI 需要真实的人回答。交互式用终端回答，一次性命令默认失败关闭，
// 只有显式 --approve/--answers 才代为答复；凭据类请求永远不在 CLI 处理。
// ---------------------------------------------------------------------------

function normalizeOptions(approval) {
  return (approval.options ?? []).map((option) =>
    typeof option === "string"
      ? { label: option, value: option }
      : { label: option?.label ?? option?.value ?? String(option), value: option?.value ?? option?.label });
}

function describeApproval(approval) {
  const options = normalizeOptions(approval);
  return [
    `[需要审批] ${approval.title ?? approval.method ?? "原生请求"}`,
    approval.message ?? "",
    ...options.map((option, i) => `  ${i + 1}) ${option.label}`),
    ...(approval.questions ?? []).map((q, i) => `  ?${i + 1} ${q.question ?? q}`),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function approvalPolicy(orch, flags) {
  const approve = flags.approve === true ? "yes" : flags.approve;
  let answers;
  if (typeof flags.answers === "string") {
    try {
      answers = JSON.parse(flags.answers);
    } catch (error) {
      die(`--answers 不是合法 JSON: ${error.message}`);
    }
    if (!Array.isArray(answers) || !answers.length) die(`--answers 需要非空 JSON 数组，例如 --answers '["用 TypeScript"]'`);
  }
  const rl = flags.rl ?? null;
  return {
    interactive: Boolean(flags.interactive),
    approve,
    answers,
    rl,
    orch,
  };
}

async function answerFromOneShot(policy, approval) {
  const method = approval.method;
  if (policy.answers !== undefined && !["select", "confirm"].includes(method)) {
    await policy.orch.answerUi(approval.id, { answers: policy.answers });
    return true;
  }
  if (policy.approve === undefined) return false;
  if (method === "select") {
    const wanted = String(policy.approve).trim().toLowerCase();
    const hit = normalizeOptions(approval).find(
      (option) => String(option.label).toLowerCase() === wanted || String(option.value).toLowerCase() === wanted,
    );
    if (!hit) throw new Error(`--approve 的值必须是该请求的选项之一（${normalizeOptions(approval).map((o) => o.label).join(" / ")}）`);
    await policy.orch.answerUi(approval.id, { value: hit.value });
    return true;
  }
  if (method === "confirm") {
    const wanted = String(policy.approve).trim().toLowerCase();
    if (!["yes", "no", "allow", "deny", "true", "false"].includes(wanted)) {
      throw new Error("--approve 对确认框只接受 yes/no");
    }
    await policy.orch.answerUi(approval.id, { confirmed: ["yes", "allow", "true"].includes(wanted) });
    return true;
  }
  return false;
}

async function answerFromTerminal(policy, approval) {
  const rl = policy.rl;
  const options = normalizeOptions(approval);
  const ask = (question) => new Promise((resolveAnswer) => rl.question(question, resolveAnswer));
  console.log(`\n${describeApproval(approval)}`);
  if (approval.method === "select") {
    const line = (await ask("选择序号（回车=取消这次运行）: ")).trim();
    if (!line) await policy.orch.answerUi(approval.id, { cancelled: true });
    else if (/^\d+$/.test(line) && options[Number(line) - 1]) await policy.orch.answerUi(approval.id, { value: options[Number(line) - 1].value });
    else {
      const hit = options.find((option) => String(option.label).toLowerCase() === line.toLowerCase());
      if (!hit) throw new Error(`没有这个选项: ${line}`);
      await policy.orch.answerUi(approval.id, { value: hit.value });
    }
    return true;
  }
  if (approval.method === "confirm") {
    const line = (await ask("允许？(y/n，回车=取消这次运行) ")).trim().toLowerCase();
    if (!line) await policy.orch.answerUi(approval.id, { cancelled: true });
    else await policy.orch.answerUi(approval.id, { confirmed: line.startsWith("y") });
    return true;
  }
  return false;
}

/** 失败关闭：不替你回答，也不让原生请求悬着。有活跃 Run 就停它，否则回原生 cancel。 */
async function failClosed(policy, approval, reason, note) {
  console.error(note);
  if (approval.runId) await policy.orch.cancelRun(approval.runId, reason);
  else await policy.orch.answerUi(approval.id, { cancelled: true });
}

async function handleApproval(policy, approval) {
  if (!approval?.id) return;
  try {
    if (approval.method === "secret") {
      await failClosed(
        policy,
        approval,
        "cli-secret-not-supported",
        `\n[需要凭据] ${approval.title ?? ""}\nCLI 不代填任何密钥。请在 GUI 里完成，或在终端运行 \`omp login\`，然后重试。已停止这次运行。`,
      );
      return;
    }
    if (policy.interactive && (await answerFromTerminal(policy, approval))) return;
    if (await answerFromOneShot(policy, approval)) return;
    await failClosed(
      policy,
      approval,
      "cli-headless-approval",
      `${describeApproval(approval)}\n\n非交互命令不能凭空代表你回答，已按失败关闭处理并停止这次运行。\n` +
        (["select", "confirm"].includes(approval.method)
          ? "要显式放行，用 --approve <选项>；要交互回答，用 interactive 或 GUI。"
          : "这类提问（ask/input/secret）请在 GUI 里回答；CLI 只代答非空 --answers。"),
    );
  } catch (error) {
    console.error("审批回执失败:", error?.message ?? error);
    try {
      if (approval.runId) await policy.orch.cancelRun(approval.runId, "cli-approval-error");
    } catch {}
  }
}

/** 把 UI 请求接到给定策略上；extra 用于叠加别的打印（事件日志始终保留）。 */
function wireApprovals(orch, policy, extra) {
  orch.onEvent = (event) => {
    if (DEBUG) console.error("·", event?.type, JSON.stringify(event).slice(0, 160));
    try {
      extra?.(event);
    } catch (error) {
      if (DEBUG) console.error("事件处理失败", error);
    }
    if (event?.type === "ui_request") void handleApproval(policy, event.approval ?? event);
  };
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
    case "runs":
      return runRuns();
    case "approvals":
      return runApprovals();
    case "approval":
      // 同一条路径的别名（文档里两种写法都出现过）。
      return runApprovals();
    case "session":
      return runSession();
    case "routines":
      return runRoutines();
    case "settings":
      return runSettings();
    case "template":
      return runTemplate();
    case "backup":
      return runBackup();
    case "version":
      return runVersion();
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
  return `omp-bot — 在 omp 上跑一支常驻 AI bot 团队（${PKG.version}）

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
  interactive <bot|room:ROOM>   REPL 连续对话
  usage                         跨 bot 用量汇总
  runs list [--bot B] [--room R] [--state S] [--limit N] [--json]
  runs get <runId> [--json]
  runs stop <runId> [--json]    取消运行（等真实停止，级联子任务；不是本进程的会拒绝）
  runs steer <runId> "<text>" [--behavior steer|follow_up] [--images a,b]
  approvals list [--all] [--json]              （approval 是同一别名；默认只看待处理）
  approvals respond <id> [--value V | --confirm | --deny | --cancel | --answers '[\u2026]']
  session new <bot> [--scope private|room:ID]
  routines list [--json]
  routines add <name> --bot B --text T (--once <ISO> | --daily HH:MM --tz IANA | --every 30m) [--overlap skip|queue] [--timeout 10m] [--start]
  routines pause|resume|rm|get|run <id>
  settings show <bot> [--json]
  settings set <bot> [--permission chat|ask|full] [--confirm-permission]
                     [--budget TOKENS|none] [--max-cost-usd N] [--max-time-ms N] [--max-concurrency N]
                     [--memory on|off] [--skills a,b] [--workspace DIR]
                     [--model M] [--thinking T]
                     chat 只聊天；ask 本机改东西先问我；full 全部放手（要加 --confirm-permission）。
                     旧的 --execution-mode / --approval-mode 仍接受，按同一规则归到三档。
  template export <file>        导出团队模板（不含密钥/聊天/审批/记忆）
  template import <file> [--dry-run]
  backup [--out DIR]            复制数据目录（先停服务，落盘后拷贝）
  version [--json]              应用、OMP、Node 版本与本机兼容检查

选项:
  --role R          bot 角色定位
  --instructions I  bot 专属指令
  --model M         绑定模型（默认用 omp 默认模型）
  --thinking T      思考档 off|low|medium|high|xhigh|max（默认 low，见 OMPBOT_THINKING）
  --main            标记为主 bot
  --home DIR        数据目录（默认 ~/.ompbot，或 $OMPBOT_HOME）
  --debug           打印编排事件与 RPC 帧
  --json            以 JSON 输出（runs/approvals/routines/settings/version/template）
  --url URL         把控制命令发给正在运行的服务（只接受 http://127.0.0.1:PORT，需配 --token/OMPBOT_TOKEN）
  --token T         该服务的进程 token（等同 OMPBOT_TOKEN；不会打印、不会落盘）

settings set 的预算：--budget 只接受非负整数 token 额度（写成 maxTokens），--max-cost-usd/--max-time-ms/
--max-concurrency 合并写入，--budget none 清空全部额度；预算以对象存，标量会被核心拒绝。

同一个数据目录只有一个写者。serve/GUI 正在跑时，CLI 的 runs/approvals/session/routines/settings/
template 会发给那个进程（地址与凭证来自它写在数据目录里的 runtime.json，或显式 --url/--token）；
chat/say/demo/interactive 需要独占一个引擎，仍在本进程运行。拿不到活跃进程时，停止/审批这类
命令会如实拒绝，绝不会假装成功。

审批:
  交互式命令遇到原生审批（权限档为 ask 时会出现）会在终端问你。
  一次性命令（chat/say/demo）默认失败关闭：不替你回答，直接停止该运行。
  显式放行用 --approve <选项>（select）或 --approve yes|no（confirm），提问用 --answers '<json>'。
  凭据类请求（secret）永远不在 CLI 处理：请用 GUI 或在终端跑 \`omp login\`。

环境变量:
  OMPBOT_HOME, OMPBOT_MODEL, OMPBOT_DEBUG=1, OMP_BIN, OMPBOT_THINKING`;
}

async function runServe() {
  const omp = await checkRuntime();
  const port = Number(flag("port") || process.env.OMPBOT_PORT || 3099);
  const host = flag("host") || "127.0.0.1";
  const backend = await startServer({
    port,
    host,
    bin: omp.bin,
    ...(HOME ? { home: HOME } : {}),
    debug: DEBUG,
    ...(THINKING ? { defaultThinking: THINKING } : {}),
  });
  console.log(`omp-bot GUI 已启动: ${backend.url}`);
  console.log("按 Ctrl+C 停止（会先停掉正在跑的回合）。");
  // 尽力打开浏览器（失败不影响服务）。用 launchUrl 让浏览器拿到本机 session。
  if (!hasFlag("no-open")) openBrowser(backend.launchUrl ?? backend.url);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("\n正在关闭…");
    try {
      await backend.close();
    } catch (error) {
      console.error("关闭失败:", error?.message ?? error);
      process.exit(1);
    }
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
  const orch = await newOrch();
  try {
    const policy = approvalPolicy(orch, { approve: flag("approve"), answers: flag("answers") });
    wireApprovals(orch, policy, () => {});
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
    await closeOrch(orch);
  }
}

async function runBots() {
  const sub = rest[0];
  const orch = await newOrch();
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
    await closeOrch(orch);
  }
}

async function runRoom() {
  const sub = rest[0];
  const orch = await newOrch();
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
    await closeOrch(orch);
  }
}

function roomTickPrinter() {
  return (e) => {
    if (e.type === "room_bot_post") console.log(`  [${e.bot}] ${e.text}`);
    else if (e.type === "room_bot_pass") console.log(`  [${e.bot}] (PASS)`);
  };
}

async function runChat() {
  const { positionals, flags } = parseArgs(rest);
  const botName = positionals[0];
  const text = positionals.slice(1).join(" ");
  if (!botName || !text) die('用法: chat <bot> "<message>" [--approve <选项>] [--answers \'["…"]\']');
  const orch = await newOrch();
  try {
    const bot = orch.resolveBot(botName);
    if (!bot) die(`找不到 bot: ${botName}`);
    wireApprovals(orch, approvalPolicy(orch, flags), null);
    const answer = await orch.chatWithBot(bot.id, text, { timeoutMs: 300_000 });
    console.log(answer);
  } finally {
    await closeOrch(orch);
  }
}

async function runSay() {
  const { positionals, flags } = parseArgs(rest);
  const roomName = positionals[0];
  const text = positionals.slice(1).join(" ");
  if (!roomName || !text) die('用法: say <room> "<message>" [--as 名字] [--approve <选项>]');
  const orch = await newOrch();
  try {
    const room = orch.listRooms().find((r) => r.name === roomName || r.id === roomName);
    if (!room) die(`找不到群: ${roomName}`);
    wireApprovals(orch, approvalPolicy(orch, flags), roomTickPrinter());
    console.log(`你 → 「${room.name}」: ${text}`);
    await orch.postToRoom(room.id, text, { userName: typeof flags.as === "string" ? flags.as : "用户" });
  } finally {
    await closeOrch(orch);
  }
}

async function runUsage() {
  const orch = await newOrch();
  try {
    const usage = await collectUsage(orch);
    console.log(renderUsageTable(usage));
    const ledgerUsage = await Promise.resolve(orch.ledger?.usage?.());
    if (ledgerUsage?.totals) console.log(`\n台账累计: ${JSON.stringify(ledgerUsage.totals)}`);
    if (!usage.perRuntime.length) {
      console.log("\n提示：这里只统计当前进程内启动过的 runtime。跨重启的每 Run 累计看 `runs list`，或上面的台账累计。");
    }
  } finally {
    await closeOrch(orch);
  }
}

async function runRuns() {
  const { positionals, flags } = parseArgs(rest);
  const sub = positionals[0];
  const live = await liveTarget(flags);
  if (live) return runsLive(live, positionals, flags);
  const orch = await newOrch();
  try {
    if (sub === "list") {
      const filters = { limit: Number(flags.limit ?? 50) };
      if (flags.bot) {
        const bot = orch.resolveBot(String(flags.bot));
        if (!bot) die(`找不到 bot: ${flags.bot}`);
        filters.botId = bot.id;
      }
      if (flags.room) {
        const room = orch.listRooms().find((r) => r.name === flags.room || r.id === flags.room);
        if (!room) die(`找不到群: ${flags.room}`);
        filters.roomId = room.id;
      }
      if (flags.state) filters.state = String(flags.state);
      const runs = orch.listRuns(filters);
      if (jsonOut(runs, flags.json)) return;
      return printRuns(orch, runs);
    }
    if (sub === "get") {
      const id = positionals[1];
      if (!id) die("用法: runs get <runId> [--json]");
      const run = orch.getRun(id) ?? orch.listRuns({ limit: 1000 }).find((r) => r.id.startsWith(id));
      if (!run) die(`找不到运行: ${id}`);
      if (jsonOut(run, flags.json)) return;
      console.log(JSON.stringify(run, null, 2));
      return undefined;
    }
    if (sub === "stop" || sub === "cancel") {
      const id = positionals[1];
      if (!id) die("用法: runs stop <runId>");
      const run = orch.getRun(id) ?? orch.listRuns({ limit: 1000 }).find((r) => r.id.startsWith(id));
      if (!run) die(`找不到运行: ${id}`);
      const result = await orch.cancelRun(run.id, "cli-user");
      return reportStop(run.id, result, flags.json);
    }
    if (sub === "steer") {
      const id = positionals[1];
      const text = positionals.slice(2).join(" ");
      if (!id || !text) die('用法: runs steer <runId> "<text>" [--behavior steer|follow_up] [--images a.png,b.png]');
      const run = orch.getRun(id) ?? orch.listRuns({ limit: 1000 }).find((r) => r.id.startsWith(id));
      if (!run) die(`找不到运行: ${id}`);
      if (orch.store.readonly) {
        die(
          `这个运行的运行时在正在持有数据目录的那个进程里，本进程不能给它补话。\n` +
            "加 --url http://127.0.0.1:PORT 与 OMPBOT_TOKEN=<token> 把命令发给它。",
        );
      }
      const images = typeof flags.images === "string" ? flags.images.split(",").map((p) => p.trim()).filter(Boolean) : [];
      const result = await orch.steerRun(run.id, text, { behavior: String(flags.behavior ?? "steer"), ...(images.length ? { images } : {}) });
      console.log(JSON.stringify(result, null, 2));
      return undefined;
    }
    die("用法: runs <list|get|stop|steer>");
  } finally {
    await closeOrch(orch);
  }
}

/** 运行控制属于活跃进程：另一个进程持锁时，这里只把命令转发给它的本机 API。 */
async function runsLive(live, positionals, flags) {
  const sub = positionals[0];
  if (sub === "list") {
    const query = new URLSearchParams();
    if (flags.bot) query.set("botId", (await liveFind(live, "bot", String(flags.bot))).id);
    if (flags.room) query.set("roomId", (await liveFind(live, "room", String(flags.room))).id);
    if (flags.state) query.set("state", String(flags.state));
    query.set("limit", String(flags.limit ?? 100));
    const { runs } = await live.call("GET", `/api/runs?${query}`);
    if (jsonOut(runs, flags.json)) return undefined;
    return printRuns(null, runs ?? []);
  }
  if (sub === "get") {
    const id = positionals[1];
    if (!id) die("用法: runs get <runId> [--json]");
    const run = await liveFindRun(live, id);
    if (jsonOut(run, flags.json)) return undefined;
    console.log(JSON.stringify(run, null, 2));
    return undefined;
  }
  if (sub === "stop" || sub === "cancel") {
    const id = positionals[1];
    if (!id) die("用法: runs stop <runId>");
    const run = await liveFindRun(live, id);
    const result = await live.call("POST", `/api/runs/${encodeURIComponent(run.id)}/cancel`, { reason: "cli-user" });
    return reportStop(run.id, result, flags.json);
  }
  if (sub === "steer") {
    const id = positionals[1];
    const text = positionals.slice(2).join(" ");
    if (!id || !text) die('用法: runs steer <runId> "<text>" [--behavior steer|follow_up] [--images a.png,b.png]');
    const images = typeof flags.images === "string" ? flags.images.split(",").map((p) => p.trim()).filter(Boolean) : [];
    const result = await live.call("POST", `/api/runs/${encodeURIComponent(id)}/steer`, {
      text,
      behavior: String(flags.behavior ?? "steer"),
      ...(images.length ? { images } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return undefined;
  }
  return die("用法: runs <list|get|stop|steer>");
}

/** 显式回答：绝不替用户猜推荐项。 */
function approvalResponse(flags) {
  const response = {};
  if (typeof flags.value === "string") response.value = flags.value;
  if (flags.confirm) response.confirmed = true;
  if (flags.deny) response.confirmed = false;
  if (flags.cancel) response.cancelled = true;
  if (typeof flags.answers === "string") {
    let parsed;
    try {
      parsed = JSON.parse(flags.answers);
    } catch (error) {
      die(`--answers 不是合法 JSON: ${error.message}`);
    }
    if (!Array.isArray(parsed) || !parsed.length) die(`--answers 需要非空 JSON 数组，例如 --answers '["用 TypeScript"]'`);
    response.answers = parsed;
  }
  if (!Object.keys(response).length) {
    die("必须显式给出回答：--value V、--confirm、--deny、--cancel 或 --answers '[\"…\"]'（不会替你猜推荐项）。");
  }
  return response;
}

function printApprovals(orch, approvals) {
  if (!approvals.length) return console.log("（没有匹配的审批）");
  for (const a of approvals) {
    const who = orch ? orch.getBot(a.botId)?.name : null;
    console.log(
      `${a.id}  ${String(a.status).padEnd(9)} ${a.method ?? "?"}  ${who ?? a.botId ?? "-"}  ${(a.title ?? a.message ?? "").slice(0, 60)}`,
    );
  }
  return undefined;
}

async function runApprovals() {
  const { positionals, flags } = parseArgs(rest);
  const sub = positionals[0];
  const live = await liveTarget(flags);
  // 默认只看待处理；--all 才看全部状态（本地与转发路径一致）。
  const statuses = flags.all ? ["pending", "answered", "cancelled", "expired"] : ["pending"];
  if (live) {
    if (sub === "list") {
      const approvals = [];
      for (const status of statuses) {
        const out = await live.call("GET", `/api/approvals?status=${status}`);
        approvals.push(...(out?.approvals ?? []));
      }
      if (jsonOut(approvals, flags.json)) return undefined;
      return printApprovals(null, approvals);
    }
    if (sub === "respond") {
      const id = positionals[1];
      if (!id) die("用法: approvals respond <id> [--value V | --confirm | --deny | --cancel | --answers '[\"…\"]']");
      const result = await live.call("POST", `/api/approvals/${encodeURIComponent(id)}/respond`, approvalResponse(flags));
      console.log(JSON.stringify(result ?? { ok: true }, null, 2));
      return undefined;
    }
    return die("用法: approvals <list|respond>");
  }
  const orch = await newOrch();
  try {
    const ledger = orch.ledger;
    if (!ledger?.list) die("当前核心没有暴露台账审批列表（需要 LedgerOwner 的集成）。");
    if (sub === "list") {
      const approvals = (ledger.list("approvals", { limit: Number(flags.limit ?? 200) }) ?? []).filter((a) =>
        statuses.includes(a?.status),
      );
      if (jsonOut(approvals, flags.json)) return undefined;
      return printApprovals(orch, approvals);
    }
    if (sub === "respond") {
      const id = positionals[1];
      if (!id) die("用法: approvals respond <id> [--value V | --confirm | --deny | --cancel | --answers '[\"…\"]']");
      requireWritable(orch, "回答审批");
      const result = await orch.answerUi(id, approvalResponse(flags));
      console.log(JSON.stringify(result ?? { ok: true }, null, 2));
      return undefined;
    }
    die("用法: approvals <list|respond>");
  } finally {
    await closeOrch(orch);
  }
}

async function runSession() {
  const { positionals, flags } = parseArgs(rest);
  const sub = positionals[0];
  const live = await liveTarget(flags);
  if (sub !== "new") die("用法: session <new>");
  const name = positionals[1];
  if (!name) die("用法: session new <bot> [--scope private|room:ID]");
  const scope = String(flags.scope ?? "private");
  if (live) {
    const bot = await liveFind(live, "bot", name);
    const result = await live.call("POST", `/api/bots/${encodeURIComponent(bot.id)}/session/new`, { scope });
    console.log(JSON.stringify(result ?? { botId: bot.id, scope }, null, 2));
    return undefined;
  }
  const orch = await newOrch();
  try {
    const bot = orch.resolveBot(name);
    if (!bot) die(`找不到 bot: ${name}`);
    requireWritable(orch, "开新会话");
    const result = await orch.newSession(bot.id, { scope });
    console.log(JSON.stringify(result ?? { botId: bot.id, scope }, null, 2));
    return undefined;
  } finally {
    await closeOrch(orch);
  }
}

/** 计划模块由 FeaturesOwner 所有：CLI 只调它的真实 API，不自己写记录、不另建调度。 */
function routinesApi(orch) {
  const api = orch.features?.routines;
  if (!api?.list || !api?.create || !api?.update || !api?.remove || !api?.run) {
    die("当前核心没有接入计划模块（需要 features.routines：list/get/create/update/remove/run）。");
  }
  return api;
}

function routineSchedule(flags) {
  if (typeof flags.once === "string") {
    const at = Number(flags.once) || Date.parse(flags.once);
    if (!Number.isFinite(at)) die("--once 需要 ISO 时间或 epoch 毫秒");
    return { kind: "once", at };
  }
  if (typeof flags.daily === "string") {
    if (typeof flags.tz !== "string") die("--daily 需要 --tz <IANA 时区>，例如 Asia/Shanghai");
    return { kind: "daily", time: flags.daily, timezone: flags.tz };
  }
  if (typeof flags.every === "string") {
    const intervalMs = parseDuration(flags.every);
    if (!intervalMs || intervalMs < 60_000) die("--every 至少 60s，例如 --every 30m");
    return { kind: "interval", intervalMs };
  }
  return die("必须指定 --once <ISO>、--daily HH:MM --tz IANA 或 --every 30m 之一");
}

function printRoutines(orch, routines) {
  if (!routines.length) return console.log("（还没有计划）");
  for (const r of routines) {
    const bot = orch ? orch.getBot(r.botId)?.name : null;
    const when = r.paused ? "已暂停" : r.nextRunAt ? new Date(r.nextRunAt).toISOString().replace("T", " ").slice(0, 19) : "未排期";
    console.log(`${r.id}  ${r.name}  ${bot ?? r.botId}  ${r.schedule?.kind ?? "?"}  ${when}  上次=${r.lastStatus ?? "-"}`);
  }
  return undefined;
}

async function runRoutines() {
  const { positionals, flags } = parseArgs(rest);
  const sub = positionals[0];
  const live = await liveTarget(flags);
  if (live) return routinesLive(live, positionals, flags);
  const orch = await newOrch();
  try {
    if (sub === "list") {
      const routines = routinesApi(orch).list();
      if (jsonOut(routines, flags.json)) return;
      return printRoutines(orch, routines);
    }
    if (sub === "add") {
      const name = positionals[1];
      if (!name) die("用法: routines add <name> --bot B --text T (--once <ISO> | --daily HH:MM --tz IANA | --every 30m)");
      const bot = orch.resolveBot(String(flags.bot ?? ""));
      if (!bot) die(`找不到 bot: ${flags.bot ?? "(未指定)"}`);
      if (typeof flags.text !== "string") die("必须给 --text T");
      requireWritable(orch, "新建计划");
      const routine = routinesApi(orch).create({
        name,
        botId: bot.id,
        text: flags.text,
        schedule: routineSchedule(flags),
        // 新调度默认关闭：要它自己跑起来得再显式 --start 或 routines resume。
        paused: !flags.start,
        ...(typeof flags.overlap === "string" ? { overlap: flags.overlap } : {}),
        ...(typeof flags.timeout === "string" ? { timeoutMs: parseDuration(flags.timeout) ?? 600_000 } : {}),
      });
      console.log(`已创建计划 ${routine.id}（${routine.name}）${routine.paused ? "，当前暂停；routines resume 后按计划执行" : "，已启用"}`);
      if (jsonOut(routine, flags.json)) return;
      return undefined;
    }
    if (["pause", "resume", "rm", "get", "run"].includes(sub)) {
      const id = positionals[1];
      if (!id) die(`用法: routines ${sub} <id>`);
      const api = routinesApi(orch);
      const find = () => api.list().find((r) => r.id === id || r.id.startsWith(id));
      if (sub === "get") {
        const routine = find();
        if (!routine) die(`找不到计划: ${id}`);
        console.log(JSON.stringify(routine, null, 2));
        return undefined;
      }
      requireWritable(orch, sub === "run" ? "手动触发计划" : "修改计划");
      if (sub === "run") {
        const result = await api.run(id);
        console.log(`计划 ${id} 手动触发: ${result?.status ?? "?"}${result?.run?.id ? ` (run ${result.run.id})` : ""}${result?.error ? ` ${result.error}` : ""}`);
        return undefined;
      }
      if (sub === "rm") {
        const ok = api.remove(id);
        console.log(ok ? `已删除计划 ${id}` : `没有这个计划: ${id}`);
        return undefined;
      }
      const routine = api.update(id, { paused: sub === "pause" });
      console.log(`计划 ${routine?.id ?? id} ${routine?.paused ? "已暂停" : "已恢复"}，下次执行 ${routine?.nextRunAt ? new Date(routine.nextRunAt).toISOString() : "未排期"}`);
      return undefined;
    }
    die("用法: routines <list|add|get|pause|resume|rm|run>");
  } finally {
    await closeOrch(orch);
  }
}

/** 计划的启动与调度在活跃进程里，CLI 只转发。 */
async function routinesLive(live, positionals, flags) {
  const sub = positionals[0];
  if (sub === "list") {
    const { routines } = await live.call("GET", "/api/routines");
    if (jsonOut(routines, flags.json)) return undefined;
    return printRoutines(null, routines ?? []);
  }
  if (sub === "add") {
    const name = positionals[1];
    if (!name) die("用法: routines add <name> --bot B --text T (--once <ISO> | --daily HH:MM --tz IANA | --every 30m)");
    const bot = await liveFind(live, "bot", String(flags.bot ?? ""));
    if (typeof flags.text !== "string") die("必须给 --text T");
    const { routine } = await live.call("POST", "/api/routines", {
      name,
      botId: bot.id,
      text: flags.text,
      schedule: routineSchedule(flags),
      paused: !flags.start,
      ...(typeof flags.overlap === "string" ? { overlap: flags.overlap } : {}),
      ...(typeof flags.timeout === "string" ? { timeoutMs: parseDuration(flags.timeout) ?? 600_000 } : {}),
    });
    console.log(`已创建计划 ${routine?.id}（${routine?.name}）${routine?.paused ? "，当前暂停；routines resume 后按计划执行" : "，已启用"}`);
    if (jsonOut(routine, flags.json)) return undefined;
    return undefined;
  }
  if (!["pause", "resume", "rm", "get", "run"].includes(sub)) die("用法: routines <list|add|get|pause|resume|rm|run>");
  const id = positionals[1];
  if (!id) die(`用法: routines ${sub} <id>`);
  const { routines } = await live.call("GET", "/api/routines");
  const routine = (routines ?? []).find((r) => r.id === id || r.id.startsWith(id));
  if (!routine) die(`找不到计划: ${id}`);
  if (sub === "get") {
    console.log(JSON.stringify(routine, null, 2));
    return undefined;
  }
  if (sub === "run") {
    const result = await live.call("POST", `/api/routines/${encodeURIComponent(routine.id)}/run`, {});
    console.log(`计划 ${routine.id} 手动触发: ${result?.status ?? "?"}${result?.run?.id ? ` (run ${result.run.id})` : ""}${result?.error ? ` ${result.error}` : ""}`);
    return undefined;
  }
  if (sub === "rm") {
    await live.call("DELETE", `/api/routines/${encodeURIComponent(routine.id)}`);
    console.log(`已删除计划 ${routine.id}`);
    return undefined;
  }
  const { routine: updated } = await live.call("PATCH", `/api/routines/${encodeURIComponent(routine.id)}`, { paused: sub === "pause" });
  console.log(`计划 ${updated?.id ?? routine.id} ${updated?.paused ? "已暂停" : "已恢复"}，下次执行 ${updated?.nextRunAt ? new Date(updated.nextRunAt).toISOString() : "未排期"}`);
  return undefined;
}

const PERMISSIONS = ["chat", "ask", "full"];
const EXECUTION_MODES = ["supervised", "chat", "full"];
const APPROVAL_MODES = ["always-ask", "write", "yolo"];

function showSettings(bot) {
  return {
    id: bot.id,
    name: bot.name,
    model: bot.model || "",
    thinking: bot.thinking ?? null,
    permission: permissionOf(bot),
    memoryEnabled: bot.memoryEnabled ?? false,
    skills: bot.skills ?? null,
    workspace: bot.workspace ?? null,
    budget: bot.budget ?? null,
    // 旧记录里出现过非法预算形状：核心不会把它当成「无限制」，这里如实显示出来。
    ...(bot.budgetInvalid ? { budgetInvalid: bot.budgetInvalid } : {}),
  };
}

function settingsPatch(flags, currentBudget = null) {
  const patch = {};
  const budgetPatch = {};
  const warn = [];
  const confirmed = !!(flags["confirm-permission"] || flags["confirm-execution-mode"] || flags["confirm-approval-mode"]);
  if (typeof flags.permission === "string") {
    const level = flags.permission;
    if (!PERMISSIONS.includes(level)) die(`--permission 只能是 ${PERMISSIONS.join("|")}`);
    if (level === "full" && !confirmed) {
      die("full 全部放手：本机完全能力（不是沙箱）且跳过审批，需要用户显式加 --confirm-permission 才设置（对应 API 的 confirmPermission）。");
    }
    patch.permission = level;
  }
  // 旧标志照收，核心按同一规则归到三档（chat 归只聊天，yolo 归全部放手，其余归先问我）。
  if (typeof flags["execution-mode"] === "string") {
    const mode = flags["execution-mode"];
    if (!EXECUTION_MODES.includes(mode)) die(`--execution-mode 只能是 ${EXECUTION_MODES.join("|")}`);
    patch.executionMode = mode;
  }
  if (typeof flags["approval-mode"] === "string") {
    const mode = flags["approval-mode"];
    if (!APPROVAL_MODES.includes(mode)) die(`--approval-mode 只能是 ${APPROVAL_MODES.join("|")}`);
    if (mode === "yolo" && !confirmed) {
      die("yolo 归到全部放手，需要用户显式加 --confirm-permission 才设置（对应 API 的 confirmPermission）。");
    }
    patch.approvalMode = mode;
  }
  if (patch.permission === "full" || patch.approvalMode === "yolo") {
    warn.push("全部放手：可访问整个本机账户，不再逐次审批。共享电脑里装系统包仍会问。");
  }
  // 确认字段与 HTTP API 同名，核心会再校验一次。
  if (confirmed) patch.confirmPermission = true;
  // 预算按核心的契约存对象（maxTokens/maxCostUsd/maxTimeMs/maxConcurrency），标量会被核心明确拒绝。
  if (typeof flags.budget === "string") {
    if (flags.budget === "none") {
      for (const k of ["max-cost-usd", "max-time-ms", "max-concurrency"]) {
        if (flags[k] !== undefined) die("--budget none 是清除全部预算，不能同时给 --max-* 限制项");
      }
      patch.budget = null;
    } else {
      const tokens = Number(flags.budget);
      if (!Number.isInteger(tokens) || tokens < 0) die("--budget 需要非负整数 token 额度（或 none 清除全部预算）");
      budgetPatch.maxTokens = tokens;
    }
  }
  if (typeof flags["max-cost-usd"] === "string") budgetPatch.maxCostUsd = Number(flags["max-cost-usd"]);
  if (typeof flags["max-time-ms"] === "string") budgetPatch.maxTimeMs = Number(flags["max-time-ms"]);
  if (typeof flags["max-concurrency"] === "string") budgetPatch.maxConcurrency = Number(flags["max-concurrency"]);
  if (Object.keys(budgetPatch).length) {
    try {
      // 增量写入：只给某一项时不丢掉其它已有的额度（--budget none 才是清空全部）。
      const merged = { ...(currentBudget && typeof currentBudget === "object" ? currentBudget : {}), ...budgetPatch };
      patch.budget = normalizeBudget(merged, "预算");
    } catch (error) {
      die(error?.message ?? String(error));
    }
  }
  if (typeof flags.memory === "string") {
    if (!["on", "off"].includes(flags.memory)) die("--memory 只能是 on|off");
    patch.memoryEnabled = flags.memory === "on";
  }
  if (typeof flags.skills === "string") patch.skills = flags.skills ? flags.skills.split(",").map((s) => s.trim()).filter(Boolean) : null;
  if (typeof flags.workspace === "string") patch.workspace = flags.workspace;
  if (typeof flags.model === "string") patch.model = flags.model;
  if (typeof flags.thinking === "string") patch.thinking = flags.thinking;
  return { patch, warn };
}

function printSettings(bot, asJson) {
  const view = showSettings(bot);
  if (jsonOut(view, asJson)) return undefined;
  for (const [k, v] of Object.entries(view)) console.log(`${k}: ${v === null ? "(未设置)" : JSON.stringify(v)}`);
  return undefined;
}

async function runSettings() {
  const { positionals, flags } = parseArgs(rest);
  const sub = positionals[0];
  const name = positionals[1];
  if (!name) die("用法: settings <show|set> <bot> [选项]");
  if (sub !== "show" && sub !== "set") die("用法: settings <show|set> <bot> [选项]");
  const live = await liveTarget(flags);
  if (live) {
    const bot = await liveFind(live, "bot", name);
    if (sub === "show") return printSettings(bot, flags.json);
    const { patch, warn } = settingsPatch(flags, bot.budget);
    if (!Object.keys(patch).length) die("没有任何要修改的字段；见 help 的 settings 选项。");
    const { bot: updated } = await live.call("PATCH", `/api/bots/${encodeURIComponent(bot.id)}`, patch);
    for (const line of warn) console.error(`注意: ${line}`);
    console.log(JSON.stringify(showSettings(updated ?? bot), null, 2));
    console.log("策略类字段会在目标进程重建 runtime 后生效。");
    return undefined;
  }
  const orch = await newOrch();
  try {
    const bot = orch.resolveBot(name);
    if (!bot) die(`找不到 bot: ${name}`);
    if (sub === "show") return printSettings(bot, flags.json);
    const { patch, warn } = settingsPatch(flags, bot.budget);
    if (!Object.keys(patch).length) die("没有任何要修改的字段；见 help 的 settings 选项。");
    requireWritable(orch, "修改设置");
    const updated = await orch.updateBot(bot.id, patch);
    for (const line of warn) console.error(`注意: ${line}`);
    console.log(JSON.stringify(showSettings(updated ?? bot), null, 2));
    console.log("策略类字段（permission/workspace/skills）会在下一条消息重建 runtime 后生效。");
    return undefined;
  } finally {
    await closeOrch(orch);
  }
}

function httpAdmin(live) {
  return {
    listBots: async () => (await live.call("GET", "/api/bots")).bots ?? [],
    addBot: async (input) => (await live.call("POST", "/api/bots", input)).bot,
    listRooms: async () => (await live.call("GET", "/api/rooms")).rooms ?? [],
    createRoom: async (input) => (await live.call("POST", "/api/rooms", input)).room,
    listRoutines: async () => (await live.call("GET", "/api/routines")).routines ?? [],
    createRoutine: async (input) => (await live.call("POST", "/api/routines", input)).routine,
  };
}

function localAdmin(orch) {
  return {
    listBots: async () => orch.listBots(),
    addBot: async (input) => orch.addBot(input),
    listRooms: async () => orch.listRooms(),
    createRoom: async (input) => orch.createRoom(input),
    listRoutines: async () => (orch.features?.routines?.list ? orch.features.routines.list() : []),
    createRoutine: async (input) => {
      const api = orch.features?.routines;
      if (!api?.create) throw new Error("核心没有接入 features.routines");
      return api.create(input);
    },
  };
}

async function templateView(admin) {
  const bots = await admin.listBots();
  const rooms = await admin.listRooms();
  const routines = await admin.listRoutines();
  const name = (id) => bots.find((b) => b.id === id)?.name ?? id;
  return {
    v: 1,
    kind: "ompbot-team-template",
    app: "omp-bot",
    appVersion: PKG.version,
    exportedAt: new Date().toISOString(),
    // 白名单：只带身份与任务描述。不含密钥、聊天、审批、授权、运行状态、记忆内容，
    // 也不带 executionMode/approvalMode/预算/技能过滤——授权字段一律不能随模板走。
    bots: bots.map((b) => ({
      name: b.name,
      role: b.role ?? "",
      instructions: b.instructions ?? "",
      model: b.model ?? "",
      thinking: b.thinking ?? null,
      isMain: Boolean(b.isMain),
    })),
    rooms: rooms.map((r) => ({
      name: r.name,
      mode: r.mode,
      adminName: r.adminId ? name(r.adminId) : null,
      members: r.members.map(name),
    })),
    routines: routines.map((r) => ({
      name: r.name,
      botName: name(r.botId),
      text: r.text,
      schedule: r.schedule,
      overlap: r.overlap ?? "skip",
      timeoutMs: r.timeoutMs ?? 600_000,
      paused: true,
    })),
  };
}

/** 模板导出走活跃进程的最新状态；导入需要写权限，优先转发给持锁进程。 */
async function runTemplate() {
  const { positionals, flags } = parseArgs(rest);
  const sub = positionals[0];
  const file = positionals[1];
  if (!file) die("用法: template <export|import> <file> [--dry-run]");
  if (sub !== "export" && sub !== "import") die("用法: template <export|import> <file> [--dry-run]");
  const live = await liveTarget(flags);
  if (live) {
    const admin = httpAdmin(live);
    if (sub === "export") {
      const view = await templateView(admin);
      await writeFile(resolve(file), `${JSON.stringify(view, null, 2)}\n`, "utf8");
      console.log(`已导出 ${view.bots.length} 个 bot、${view.rooms.length} 个群、${view.routines.length} 个计划（全部暂停）到 ${resolve(file)}（读自正在运行的进程）`);
      console.log("模板不含密钥、聊天记录、审批、授权与记忆内容。");
      return undefined;
    }
    return importTemplate(admin, file, flags, true);
  }
  const orch = await newOrch();
  try {
    const admin = localAdmin(orch);
    if (sub === "export") {
      const view = await templateView(admin);
      await writeFile(resolve(file), `${JSON.stringify(view, null, 2)}\n`, "utf8");
      console.log(`已导出 ${view.bots.length} 个 bot、${view.rooms.length} 个群、${view.routines.length} 个计划（全部暂停）到 ${resolve(file)}`);
      console.log("模板不含密钥、聊天记录、审批、授权与记忆内容。");
      return undefined;
    }
    requireWritable(orch, "导入团队模板");
    return await importTemplate(admin, file, flags, false);
  } finally {
    await closeOrch(orch);
  }
}

async function importTemplate(admin, file, flags, viaHttp) {
  let tpl;
  try {
    tpl = JSON.parse(await readFile(resolve(file), "utf8"));
  } catch (error) {
    die(`模板读取失败: ${error.message}`);
  }
  if (tpl?.kind !== "ompbot-team-template" || tpl.v !== 1) die("不是 omp-bot v1 团队模板（kind=ompbot-team-template, v=1）。");

  const dryRun = Boolean(flags["dry-run"]);
  const botsByName = new Map((await admin.listBots()).map((b) => [b.name, b]));
  const roomsByName = new Map((await admin.listRooms()).map((r) => [r.name, r]));
  const created = [];
  const skipped = [];

  for (const entry of tpl.bots ?? []) {
    if (typeof entry?.name !== "string" || !entry.name) { skipped.push("(无名 bot)"); continue; }
    if (botsByName.has(entry.name)) { skipped.push(`bot ${entry.name} 已存在`); continue; }
    if (dryRun) { created.push(`bot ${entry.name}`); continue; }
    const bot = await admin.addBot({
      name: entry.name,
      role: entry.role ?? "",
      instructions: entry.instructions ?? "",
      model: entry.model ?? "",
      thinking: entry.thinking ?? undefined,
      // 导入不加授权：executionMode/approvalMode/预算/记忆/技能过滤一律走本机默认。
      isMain: Boolean(entry.isMain) && ![...botsByName.values()].some((b) => b.isMain),
    });
    botsByName.set(bot.name, bot);
    created.push(`bot ${bot.name}`);
  }

  for (const entry of tpl.rooms ?? []) {
    if (typeof entry?.name !== "string" || !entry.name) continue;
    if (roomsByName.has(entry.name)) { skipped.push(`群 ${entry.name} 已存在`); continue; }
    const memberIds = (entry.members ?? []).map((n) => botsByName.get(n)?.id).filter(Boolean);
    const missing = (entry.members ?? []).filter((n) => !botsByName.has(n));
    if (!memberIds.length) { skipped.push(`群 ${entry.name} 没有可用成员`); continue; }
    if (missing.length) skipped.push(`群 ${entry.name} 缺成员: ${missing.join(", ")}`);
    if (dryRun) { created.push(`群 ${entry.name}`); continue; }
    const room = await admin.createRoom({
      name: entry.name,
      members: memberIds,
      adminId: entry.adminName ? botsByName.get(entry.adminName)?.id ?? null : null,
      mode: entry.mode ?? "admin",
    });
    roomsByName.set(room.name, room);
    created.push(`群 ${room.name}`);
  }

  for (const entry of tpl.routines ?? []) {
    const bot = botsByName.get(entry?.botName);
    if (!bot) { skipped.push(`计划 ${entry?.name ?? "?"} 缺 bot`); continue; }
    if (dryRun) { created.push(`计划 ${entry.name}（暂停）`); continue; }
    try {
      // 导入的计划一律暂停，并且不会回填错过的执行。
      const routine = await admin.createRoutine({
        name: entry.name,
        botId: bot.id,
        text: entry.text,
        schedule: entry.schedule,
        overlap: entry.overlap ?? "skip",
        timeoutMs: entry.timeoutMs ?? 600_000,
        paused: true,
      });
      created.push(`计划 ${routine?.name ?? entry.name}（暂停）`);
    } catch (error) {
      skipped.push(`计划 ${entry?.name ?? "?"} 未导入: ${error?.message ?? error}`);
    }
  }

  console.log(dryRun ? "预演（没有写入任何数据）：" : viaHttp ? "导入完成（写入正在运行的进程）：" : "导入完成：");
  for (const line of created) console.log(`  + ${line}`);
  for (const line of skipped) console.log(`  - ${line}`);
  console.log("导入的计划默认暂停；确认内容和权限档后再手动恢复。");
  console.log("模板不含授权：新 bot 的权限档、记忆、技能过滤与预算都保持本机默认（本机改东西先问我 / 关）。");
  return undefined;
}

async function runBackup() {
  const { flags } = parseArgs(rest);
  const orch = await newOrch();
  const home = orch.home ?? orch.store?.home;
  if (!home) { await closeOrch(orch); die("无法确定数据目录。"); }
  // 另一个进程还在写同一个 SQLite：复制出来的库可能不一致，宁可拒绝也不给假备份。
  if (orch.store?.readonly) {
    await closeOrch(orch);
    die(
      `数据目录正由另一个进程使用（${home}），这时复制出来的台账可能不一致。\n` +
        "请先停止那个 serve/GUI 进程再运行 backup，或用它界面里的备份入口。",
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = resolve(typeof flags.out === "string" ? flags.out : join(home, "..", `ompbot-backup-${stamp}`));
  // 先真正停下并落盘（SQLite 关闭后才安全复制），再拷贝整个数据目录。
  await closeOrch(orch);
  try {
    await mkdir(out, { recursive: true });
    await cp(home, out, {
      recursive: true,
      filter: (src) => !/\.(lock|tmp)$/.test(src) && !/-wal$|-shm$/.test(src),
    });
    const manifest = {
      v: 1,
      kind: "ompbot-backup",
      app: "omp-bot",
      appVersion: PKG.version,
      createdAt: new Date().toISOString(),
      source: home,
      note: "复制自停止服务后的数据目录；不含任何密钥（密钥一直在 OMP 自己的存储里）。",
    };
    await writeFile(join(out, "BACKUP.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`已备份到 ${out}`);
    console.log("恢复方式：把内容复制回一个新的 --home 目录，再用同版本或更新的 omp-bot 打开。");
    return undefined;
  } catch (error) {
    return die(`备份失败: ${error?.message ?? error}`);
  }
}

async function runVersion() {
  const { flags } = parseArgs(rest);
  const major = Number(process.versions.node.split(".")[0]);
  const nodeOk = major >= MIN_NODE_MAJOR;
  let sqlite = "可用";
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("select 1");
    db.close();
  } catch (error) {
    sqlite = `不可用 (${error.message})`;
  }
  const bin = resolveOmp();
  let omp = { bin, version: null, ok: false, error: null };
  if (bin) {
    try {
      const version = parseVersion(execFileSync(bin, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 }));
      omp = { bin, version: version ? version.join(".") : "未知", ok: Boolean(version && atLeast(version, MIN_OMP)), error: null };
    } catch (error) {
      omp = { bin, version: null, ok: false, error: error.message };
    }
  } else {
    omp.error = "PATH 里找不到 omp";
  }
  const home = HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".ompbot");
  const live = await liveTarget(flags);
  const report = {
    app: { name: PKG.name, version: PKG.version, mode: "cli" },
    node: { version: process.versions.node, required: `>=${MIN_NODE_MAJOR}`, ok: nodeOk },
    sqlite,
    omp: { ...omp, required: `>=${MIN_OMP.join(".")}` },
    home,
    stateFile: join(home, "state.json"),
    ledgerFile: join(home, "workbench.sqlite"),
    discoveryFile: serverDescriptorPath(home),
    liveBackend: live ? { url: live.base, via: typeof flags.url === "string" || process.env.OMPBOT_URL ? "explicit" : "runtime.json" } : null,
    hasState: existsSync(join(home, "state.json")),
    update: {
      native: "OMP 自身用 `omp update` 升级（原生命令）。",
      app: "omp-bot 没有发布源，不做自动更新：拉取源码后重新 `npm run package:win` 或重装本包。",
    },
  };
  if (jsonOut(report, flags.json)) return;
  console.log(`omp-bot ${PKG.version} (CLI)`);
  console.log(`Node ${process.versions.node} (需要 >= ${MIN_NODE_MAJOR}): ${nodeOk ? "OK" : "过旧"}`);
  console.log(`node:sqlite: ${sqlite}`);
  console.log(`OMP: ${omp.version ?? "未知"} @ ${omp.bin ?? "(未找到)"} (需要 >= ${MIN_OMP.join(".")})${omp.ok ? "" : " ← 不满足"}`);
  if (omp.error) console.log(`  ${omp.error}`);
  console.log(`数据目录: ${home}`);
  console.log(
    report.liveBackend
      ? `活跃服务: ${report.liveBackend.url}（runs/approvals/routines/settings 会发给它，来源 ${report.liveBackend.via}）`
      : "活跃服务: 无（控制命令在本进程执行；另一个进程持锁时会拒绝写操作）",
  );
  console.log(report.update.native);
  console.log(report.update.app);
  return undefined;
}

async function runInteractive() {
  const target = rest[0];
  if (!target) die("用法: interactive <bot|room:ROOM>");
  const orch = await newOrch();
  const isRoom = target.startsWith("room:");
  const name = isRoom ? target.slice(5) : target;

  let bot = null, room = null;
  if (isRoom) {
    room = orch.listRooms().find((r) => r.name === name || r.id === name);
    if (!room) { await closeOrch(orch); die(`找不到群: ${name}`); }
    console.log(`进入群「${room.name}」。发言会触发 relay；审批会在终端问你；:quit 退出。`);
  } else {
    bot = orch.resolveBot(name);
    if (!bot) { await closeOrch(orch); die(`找不到 bot: ${name}`); }
    console.log(`与 ${bot.name} 私聊。审批会在终端问你；:quit 退出，:usage 看用量，:runs 看运行。`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", async () => { await closeOrch(orch); process.exit(0); });

  // 交互式：原生审批在这里用真实回答，绝不用 recommended 冒充用户输入。
  wireApprovals(orch, approvalPolicy(orch, { interactive: true, rl }), (e) => {
    if (isRoom) roomTickPrinter()(e);
    else if (e.type === "native_event" && DEBUG) console.error("·", JSON.stringify(e).slice(0, 160));
  });

  const ask = () => rl.question(isRoom ? `「${room.name}」> ` : `${bot.name}> `, async (line) => {
    const text = line.trim();
    if (!text) return ask();
    if (text === ":quit" || text === ":q") { await closeOrch(orch); rl.close(); return; }
    if (text === ":usage") {
      console.log(renderUsageTable(await collectUsage(orch)));
      return ask();
    }
    if (text === ":runs") {
      const runs = orch.listRuns({ limit: 10 });
      for (const run of runs) console.log(`  ${run.id}  ${run.state}  ${(run.text ?? "").slice(0, 50)}`);
      return ask();
    }
    try {
      if (isRoom) {
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
