// test/features.mjs — 特性层（资料/成果/计划/原生能力面/文件检查点）行为测试。
// 零模型调用、零真实 OMP 进程：除 memory 路径探测（本机无 broker，只测拒绝路径）外全部走
// 真实 Ledger（node:sqlite）与真实文件系统，使用独立临时 home。

import assert from "node:assert";
import { existsSync, mkdirSync as fsMkdirSync, mkdtempSync, readFileSync, rmSync as fsRmSync, utimesSync as fsUtimesSync, writeFileSync as fsWriteFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.mjs";
import { WorkbenchFeatures } from "../src/features.mjs";
import { decodeBase64, sniffMime } from "../src/features/attachments.mjs";
import { computeNextRun, advancePast, isValidTimeZone, normalizeSchedule, tzParts, zonedTimeToUtc } from "../src/features/routines.mjs";
import { botPaths, parseSkillFrontmatter, validateMcpServer } from "../src/features/native.mjs";
import { DatabaseSync } from "node:sqlite";
import { canonicalFilename, isInsideRoot, lexicallyInside, sha256Hex } from "../src/features/util.mjs";
import { symlinkSync } from "node:fs";
import { readChannelConfig } from "../src/channels.mjs";

// ---------------- 测试骨架（与 test/unit.mjs 同风格） ----------------

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}
function expectError(fn, code, status) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("期望同步抛错，实际返回 Promise");
  } catch (e) {
    assert.strictEqual(e.code, code, `期望 code=${code}，实际 ${e.code}：${e.message}`);
    if (status != null) assert.strictEqual(e.status, status, `期望 status=${status}，实际 ${e.status}`);
    return e;
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`);
}
async function expectErrorAsync(fn, code, status) {
  try {
    await fn();
  } catch (e) {
    assert.strictEqual(e.code, code, `期望 code=${code}，实际 ${e.code}：${e.message}`);
    if (status != null) assert.strictEqual(e.status, status, `期望 status=${status}，实际 ${e.status}`);
    return e;
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`);
}

// ---------------- 固定装置 ----------------

const home = mkdtempSync(join(tmpdir(), "ompbot-features-"));
const ledger = new Ledger({ home });
const events = [];
const bots = [];
const startedRuns = [];
const runsById = new Map();
let nativeState = null;
let nativeCommands = { commands: [] };

/** 夹具护栏：任何测试路径都必须落在临时 home 内，避免误写用户仓库/家目录。 */
function homePath(p, label = "path") {
  if (typeof p !== "string" || !p.trim() || !lexicallyInside(home, p)) {
    throw new Error(`测试夹具越界（${label} 必须落在临时 home 内）：${JSON.stringify(p)}`);
  }
  return p;
}

// 每个写操作都强制过 homePath：包括 <work>/.git/config 这类路径。
// 夹具一旦退化（例如 Bot 空 workspace 推导出空根），测试会立刻失败而不是写进 CWD。
const writeFileSync = (p, ...rest) => fsWriteFileSync(homePath(p, "writeFileSync"), ...rest);
const mkdirSync = (p, ...rest) => fsMkdirSync(homePath(p, "mkdirSync"), ...rest);
const rmSync = (p, ...rest) => fsRmSync(homePath(p, "rmSync"), ...rest);
const utimesSync = (p, ...rest) => fsUtimesSync(homePath(p, "utimesSync"), ...rest);

function mkBot(over = {}) {
  const n = bots.length + 1;
  const bot = {
    id: over.id ?? `bot_${n}`,
    name: over.name ?? `Bot${n}`,
    role: "",
    instructions: "",
    model: "",
    thinking: "",
    isMain: false,
    executionMode: "supervised",
    approvalMode: "write",
    workspace: join(home, "ws", `bot_${n}`),
    memoryEnabled: false,
    skills: null,
    budget: null,
    createdAt: Date.now(),
    ...over,
  };
  // 夹具护栏：非空工作区必须在临时 home 内（空串是 makeBot 的真实默认值，由专门场景覆盖推导路径）。
  if (bot.workspace) bot.workspace = homePath(bot.workspace, "bot.workspace");
  bots.push(bot);
  return bot;
}

const orch = {
  home,
  bin: "omp",
  closing: false,
  ledger,
  runtimes: new Map(),
  emit: (type, data) => events.push({ type, ...data }),
  getBot: (id) => bots.find((b) => b.id === id) ?? null,
  listBots: () => bots,
  updateBot: (id, patch) => {
    const b = bots.find((x) => x.id === id);
    if (!b) return null;
    Object.assign(b, patch);
    return b;
  },
  // 与冻结契约一致：startRun 同步返回 run（不是 Promise）。记录真实返回的 run，
  // 使回执/台账里的 runId 断言对着调用方真正拿到的那条记录，而不是入参。
  startRun: (input) => {
    const run = { id: `run_${startedRuns.length + 1}`, state: "running", ...input };
    startedRuns.push(run);
    runsById.set(run.id, run);
    return run;
  },
  getRun: (id) => runsById.get(id) ?? null,
  getNativeState: async () => {
    if (!nativeState) throw new Error("原生状态不可用（夹具未设置）");
    return nativeState;
  },
  nativeCommand: async () => nativeCommands,
};

const features = new WorkbenchFeatures({ orch, bin: "omp" });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n", "latin1");

function fakeRes() {
  const out = { status: null, headers: null, body: null, ended: false };
  return {
    out,
    writeHead(code, headers) {
      out.status = code;
      out.headers = headers;
    },
    end(b) {
      out.body = b;
      out.ended = true;
    },
  };
}

function fakeJson() {
  const calls = [];
  return {
    calls,
    fn: (_res, code, obj) => calls.push({ code, obj }),
  };
}

// omp 进程的 cwd（team/bots/<id>），项目级 .omp/ 在这里。
const workOf = (botId, scope = "private") => botPaths(orch, home, botId, scope).cwd;

// ---------------- 资料：接收、规范化、归属 ----------------

test("canonicalFilename 剥掉目录、拒绝非法名", () => {
  assert.strictEqual(canonicalFilename("../../evil.png"), "evil.png");
  assert.strictEqual(canonicalFilename("C:\\tmp\\a b.csv"), "a b.csv");
  expectError(() => canonicalFilename(".."), "invalid_filename", 400);
  expectError(() => canonicalFilename("a\u0001b.txt"), "invalid_filename", 400);
  expectError(() => canonicalFilename("con.txt"), "invalid_filename", 400);
});

test("sniffMime 按魔数识别 png/pdf/zip，未知返回 null", () => {
  assert.strictEqual(sniffMime(PNG), "image/png");
  assert.strictEqual(sniffMime(PDF), "application/pdf");
  assert.strictEqual(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 9])), "application/zip");
  assert.strictEqual(sniffMime(Buffer.from("hello")), null);
});

test("decodeBase64 拒绝非规范 base64，接受 data URI", () => {
  expectError(() => decodeBase64("abc"), "invalid_base64", 400);
  expectError(() => decodeBase64(""), "invalid_base64", 400);
  const buf = decodeBase64(`data:image/png;base64,${PNG.toString("base64")}`);
  assert.strictEqual(sha256Hex(buf), sha256Hex(PNG));
});

test("创建图片附件：落盘、哈希、kind=image、文件在 Bot 私有目录内", () => {
  const bot = mkBot({ name: "资料Bot" });
  const att = features.attachments.create({
    botId: bot.id,
    filename: "../../shot.png",
    mime: "image/png",
    dataBase64: PNG.toString("base64"),
  });
  assert.strictEqual(att.filename, "shot.png");
  assert.strictEqual(att.kind, "image");
  assert.strictEqual(att.size, PNG.length);
  assert.strictEqual(att.hash, sha256Hex(PNG));
  assert.ok(existsSync(att.path), "附件文件应已落盘");
  assert.ok(isInsideRoot(join(home, "attachments", bot.id), att.path), "附件必须在 Bot 私有附件目录内");
  assert.strictEqual(homedir() && att.path.startsWith(homedir() + "\\.omp"), false, "附件不得落到用户 OMP home");
});

test("创建文档附件：kind=document；未登记的 mime 被拒", () => {
  const bot = mkBot();
  const att = features.attachments.create({
    botId: bot.id,
    filename: "data.csv",
    mime: "text/csv",
    dataBase64: Buffer.from("a,b\n1,2\n").toString("base64"),
  });
  assert.strictEqual(att.kind, "document");
  expectError(
    () => features.attachments.create({ botId: bot.id, filename: "x.bin", mime: "application/x-msdownload", dataBase64: "AAAA" }),
    "unsupported_mime",
    400,
  );
});

test("类型混淆被拒：内容与声明/扩展名不一致", () => {
  const bot = mkBot();
  expectError(
    () => features.attachments.create({ botId: bot.id, filename: "x.txt", mime: "text/plain", dataBase64: PNG.toString("base64") }),
    "mime_mismatch",
    400,
  );
  expectError(
    () => features.attachments.create({ botId: bot.id, filename: "x.txt", mime: "image/png", dataBase64: PNG.toString("base64") }),
    "filename_mime_mismatch",
    400,
  );
  expectError(
    () => features.attachments.create({ botId: bot.id, filename: "x.zip", mime: "application/zip", dataBase64: Buffer.from("not a zip").toString("base64") }),
    "mime_sniff_failed",
    400,
  );
});

test("附件必须属于真实 Bot；未知 Bot 被拒", () => {
  expectError(
    () => features.attachments.create({ botId: "bot_nope", filename: "a.png", mime: "image/png", dataBase64: PNG.toString("base64") }),
    "bot_not_found",
    404,
  );
});

test("preparePrompt：图片走原生 images，文档给出受控绝对路径，原文保留", async () => {
  const bot = mkBot();
  const img = features.attachments.create({ botId: bot.id, filename: "p.png", mime: "image/png", dataBase64: PNG.toString("base64") });
  const doc = features.attachments.create({ botId: bot.id, filename: "r.pdf", mime: "application/pdf", dataBase64: PDF.toString("base64") });
  const out = await features.preparePrompt({ id: "run_a", botId: bot.id, text: "看看这两份", attachmentIds: [img.id, doc.id] });
  assert.strictEqual(out.images.length, 1);
  assert.strictEqual(out.images[0].type, "image");
  assert.strictEqual(out.images[0].mimeType, "image/png");
  assert.strictEqual(out.images[0].data, PNG.toString("base64"));
  assert.ok(out.text.includes(doc.path), "文档提示必须给出规范绝对路径");
  assert.ok(out.text.includes("原生 read"), "文档由 OMP 原生 read 读取");
  assert.ok(out.text.endsWith("看看这两份"), "用户原文保留在提示末尾");
  assert.ok(existsSync(doc.path), "原文文件必须仍在（不改写、不删除）");
  assert.ok(features.attachments.get(img.id).runIds.includes("run_a"), "附件应记录被哪个 Run 使用");
});

test("preparePrompt：跨 Bot 附件被拒；文件丢失被拒", async () => {
  const owner = mkBot();
  const other = mkBot();
  const att = features.attachments.create({ botId: owner.id, filename: "o.png", mime: "image/png", dataBase64: PNG.toString("base64") });
  await expectErrorAsync(() => features.preparePrompt({ id: "run_b", botId: other.id, text: "偷看", attachmentIds: [att.id] }), "attachment_ownership_denied", 403);
  rmSync(att.path, { force: true });
  await expectErrorAsync(() => features.preparePrompt({ id: "run_c", botId: owner.id, text: "x", attachmentIds: [att.id] }), "attachment_missing_file", 409);
});

test("附件删除：记录与文件一并清掉", () => {
  const bot = mkBot();
  const att = features.attachments.create({ botId: bot.id, filename: "d.txt", mime: "text/plain", dataBase64: Buffer.from("bye").toString("base64") });
  assert.ok(existsSync(att.path));
  assert.strictEqual(features.attachments.remove(att.id), true);
  assert.strictEqual(features.attachments.get(att.id), null);
  assert.strictEqual(existsSync(att.path), false);
  assert.strictEqual(features.attachments.remove(att.id), false);
});

test("附件图片预览：只输出已登记图片本体，跨 Bot 与非图片被拒", () => {
  const bot = mkBot({ name: "预览Bot" });
  const other = mkBot();
  const img = features.attachments.create({ botId: bot.id, filename: "pv.png", mime: "image/png", dataBase64: PNG.toString("base64") });
  const doc = features.attachments.create({ botId: bot.id, filename: "pv.pdf", mime: "application/pdf", dataBase64: PDF.toString("base64") });

  const res = fakeRes();
  features.attachments.servePreview(img.id, res);
  assert.strictEqual(res.out.status, 200);
  assert.strictEqual(res.out.headers["Content-Type"], "image/png");
  assert.strictEqual(res.out.headers["X-Content-Type-Options"], "nosniff");
  assert.strictEqual(res.out.headers["Cache-Control"], "no-store");
  assert.strictEqual(res.out.headers["Content-Disposition"], "inline");
  assert.strictEqual(res.out.headers["Set-Cookie"], undefined, "预览不得写 cookie");
  assert.ok(res.out.body.equals(PNG), "预览必须输出原始字节");

  expectError(() => features.attachments.servePreview(doc.id, fakeRes()), "preview_unsupported", 415);
  expectError(() => features.attachments.servePreview(img.id, fakeRes(), { botId: other.id }), "attachment_ownership_denied", 403);
  expectError(() => features.attachments.servePreview("att_nope", fakeRes()), "attachment_not_found", 404);

  // 文件被替换后按登记哈希拒绝，不放行任何变更过的内容
  writeFileSync(img.path, Buffer.from("tampered"));
  expectError(() => features.attachments.servePreview(img.id, fakeRes()), "attachment_hash_mismatch", 409);
});

// ---------------- 成果：登记、版本、下载与预览 ----------------

const artBot = mkBot({ name: "开发Bot" });
const artWork = workOf(artBot.id);
/** 真实走 collectArtifacts 得到的成果；成功路径的消费测试只用真快照，不伪造记录。 */
let realReportArtifact = null;
mkdirSync(join(artWork, ".git"), { recursive: true });
writeFileSync(join(artWork, ".git", "config"), "[core]\n");
const oldFile = join(artWork, "old.txt");
writeFileSync(oldFile, "很久以前的文件");
const longAgo = (Date.now() - 3600_000) / 1000;
utimesSync(oldFile, longAgo, longAgo);

test("collectArtifacts：只登记本次新生成的文件，跳过 .git 与旧文件", async () => {
  writeFileSync(join(artWork, "report.md"), "# 报告\nv1\n");
  const run = { id: "run_art1", botId: artBot.id, scope: "private", createdAt: Date.now() - 10_000, text: "写报告" };
  const added = await features.collectArtifacts(run, { cwd: artWork });
  const names = added.map((a) => a.relPath);
  assert.deepStrictEqual(names, ["report.md"]);
  assert.strictEqual(added[0].version, 1);
  assert.strictEqual(added[0].previewType, "text");
  assert.strictEqual(added[0].mime, "text/markdown");
  assert.ok(!names.some((n) => n.startsWith(".git/")), "不得登记 .git 内容");
  assert.ok(!names.includes("old.txt"), "旧文件不属于本次产出");
  assert.ok(events.some((e) => e.type === "artifact_added"), "应发出 artifact_added 事件");
  realReportArtifact = features.artifacts.get(added[0].id);
  assert.ok(realReportArtifact?.immutable === true, "真实登记的成果必须是不可变快照");
  // 元数据必须描述快照本体（而不是登记时另一次读取源文件的结果）
  assert.strictEqual(
    realReportArtifact.hash,
    sha256Hex(readFileSync(realReportArtifact.path)),
    "hash 必须来自快照字节",
  );
  assert.strictEqual(realReportArtifact.size, readFileSync(realReportArtifact.path).length, "size 必须来自快照字节");
  assert.ok(realReportArtifact.path.startsWith(join(home, "artifacts", artBot.id)), "快照必须在产品成果根内");
});

test("collectArtifacts：同路径内容变化产生新版本", async () => {
  writeFileSync(join(artWork, "report.md"), "# 报告\nv2\n");
  const run = { id: "run_art2", botId: artBot.id, scope: "private", createdAt: Date.now() - 10_000, text: "改报告" };
  const added = await features.collectArtifacts(run, { cwd: artWork });
  const rec = added.find((a) => a.relPath === "report.md");
  assert.ok(rec, "改后的报告应登记为新版本");
  assert.strictEqual(rec.version, 2);
  assert.strictEqual(rec.runId, "run_art2");
});

test("resolveFile：真实路径不在登记根内时拒绝", () => {
  const outside = join(home, "outside.txt");
  writeFileSync(outside, "外部文件");
  ledger.put("artifacts", {
    id: "art_escape",
    runId: null,
    botId: artBot.id,
    root: artWork,
    relPath: "../outside.txt",
    path: outside,
    name: "outside.txt",
    mime: "text/plain",
    previewType: "text",
    size: 4,
    hash: sha256Hex(Buffer.from("外部文件")),
    version: 1,
    createdAt: Date.now(),
  });
  expectError(() => features.artifacts.resolveFile("art_escape"), "artifact_out_of_root", 403);
});

test("下载：attachment 头 + no-store + 无管理 cookie", () => {
  const rec = realReportArtifact;
  assert.ok(rec, "需要先通过 collectArtifacts 得到真实快照");
  const before = features.artifacts.get(rec.id).downloads ?? 0;
  const res = fakeRes();
  features.artifacts.serveDownload(rec.id, res);
  assert.strictEqual(res.out.status, 200);
  assert.strictEqual(res.out.headers["Content-Type"], "application/octet-stream");
  assert.ok(res.out.headers["Content-Disposition"].startsWith("attachment;"));
  assert.strictEqual(res.out.headers["Cache-Control"], "no-store");
  assert.strictEqual(res.out.headers["X-Content-Type-Options"], "nosniff");
  assert.strictEqual(res.out.headers["Set-Cookie"], undefined, "下载不得写管理 cookie");
  assert.strictEqual(features.artifacts.get(rec.id).downloads, before + 1);
});

test("预览 html：严格沙箱 CSP、禁脚本/连接、无 cookie", async () => {
  writeFileSync(join(artWork, "view.html"), "<html><body><script>fetch('/api/state')</script></body></html>");
  const run = { id: "run_art3", botId: artBot.id, scope: "private", createdAt: Date.now() - 10_000, text: "做页面" };
  const added = await features.collectArtifacts(run, { cwd: artWork });
  const html = added.find((a) => a.relPath === "view.html");
  assert.ok(html, "html 成果应被登记");
  assert.strictEqual(html.previewType, "html");
  const res = fakeRes();
  features.artifacts.servePreview(html.id, res);
  const csp = res.out.headers["Content-Security-Policy"];
  assert.ok(csp.startsWith("sandbox;"), "预览必须走 sandbox 指令");
  assert.ok(csp.includes("script-src 'none'"));
  assert.ok(csp.includes("connect-src 'none'"));
  assert.ok(csp.includes("form-action 'none'"));
  assert.strictEqual(res.out.headers["Set-Cookie"], undefined, "预览不得访问管理 cookie");
  assert.strictEqual(res.out.headers["Content-Disposition"], "inline");
});

test("预览二进制：明确拒绝（不给假预览）", () => {
  const binDir = join(home, "artifacts", artBot.id, "art_bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "blob.bin");
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  writeFileSync(binPath, bytes);
  const rec = {
    id: "art_bin",
    runId: null,
    botId: artBot.id,
    // 拒绝路径夹具：快照文件确实在成果根内（containment 会通过），只验证二进制不给预览。
    root: artWork,
    relPath: "blob.bin",
    sourcePath: join(artWork, "blob.bin"),
    path: binPath,
    name: "blob.bin",
    mime: "application/octet-stream",
    previewType: "binary",
    size: bytes.length,
    hash: sha256Hex(bytes),
    version: 1,
    createdAt: Date.now(),
  };
  ledger.put("artifacts", rec);
  expectError(() => features.artifacts.servePreview(rec.id, fakeRes()), "preview_unsupported", 415);
});

test("成果不可变：覆盖源文件后，旧版本绝不返回新内容；快照被改写则明确报错", async () => {
  const bot = mkBot({ name: "成果Bot" });
  const work = workOf(bot.id);
  mkdirSync(work, { recursive: true });
  const src = join(work, "report.txt");
  writeFileSync(src, "内容A");
  const run1 = { id: "run_imm1", botId: bot.id, scope: "private", createdAt: Date.now() - 10_000, text: "v1" };
  const [v1] = await features.collectArtifacts(run1, { cwd: work });
  assert.strictEqual(v1.version, 1);
  assert.strictEqual(v1.sourcePath, src);
  assert.ok(v1.path !== src, "登记时就要把内容冻结到产品成果根，而不是指向可变工作区文件");

  writeFileSync(src, "内容B");
  const run2 = { id: "run_imm2", botId: bot.id, scope: "private", createdAt: Date.now() - 10_000, text: "v2" };
  const [v2] = await features.collectArtifacts(run2, { cwd: work });
  assert.strictEqual(v2.version, 2);

  const old = features.artifacts.loadVerified(v1.id);
  assert.strictEqual(old.buf.toString("utf8"), "内容A", "旧版本必须还是旧字节");
  const res = fakeRes();
  features.artifacts.serveDownload(v1.id, res);
  assert.strictEqual(res.out.body.toString("utf8"), "内容A", "下载旧版本不得变成新内容");
  assert.strictEqual(features.artifacts.loadVerified(v2.id).buf.toString("utf8"), "内容B");

  writeFileSync(v1.path, "内容被篡改");
  expectError(() => features.artifacts.loadVerified(v1.id), "artifact_changed", 409);
  expectError(() => features.artifacts.serveDownload(v1.id, fakeRes()), "artifact_changed", 409);
});

test("无 workspace 的 Bot：推导出的工作区在 Bot 私有目录内，扫描根不得为空", async () => {
  // makeBot 的默认 workspace 就是空字符串；夹具必须模拟这个真实默认值。
  const bot = mkBot({ name: "无工作区Bot", workspace: "" });
  assert.strictEqual(bot.workspace, "");
  const paths = botPaths(orch, home, bot.id, "private");
  assert.strictEqual(
    paths.workDir,
    join(home, "team", "bots", bot.id, "work"),
    "空 workspace 必须回落到 Bot 私有 work 目录，而不是空串",
  );
  assert.notStrictEqual(paths.workDir, "");
  mkdirSync(paths.workDir, { recursive: true });

  writeFileSync(join(paths.workDir, "out.md"), "# 无工作区产出\n");
  const run = { id: "run_nows", botId: bot.id, scope: "private", createdAt: Date.now() - 10_000, text: "产出" };
  const roots = features.artifacts.scanRoots(run, { cwd: paths.workDir });
  assert.deepStrictEqual(roots, [paths.workDir.replace(/[\\/]+$/, "")], "扫描根必须是真实目录，不得出现空串");
  assert.ok(roots.every((r) => r && lexicallyInside(home, r)), "扫描根必须全部在临时 home 内");

  const added = await features.collectArtifacts(run, { cwd: paths.workDir });
  assert.deepStrictEqual(added.map((a) => a.relPath), ["out.md"], "空根曾导致成果全部丢失");
  assert.ok(features.artifacts.lastScan.scanned >= 1, "扫描摘要必须显示真的看到了文件");
  assert.ok(features.artifacts.lastScan.registered >= 1);
});

// ---------------- 文件检查点 ----------------

test("检查点：快照不含 .git，恢复保护快照之后的改动，force 才覆盖", () => {
  const bot = mkBot({ name: "检查点Bot" });
  const work = workOf(bot.id);
  mkdirSync(join(work, ".git"), { recursive: true });
  writeFileSync(join(work, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(work, "keep.txt"), "A版本");
  writeFileSync(join(work, "gone.txt"), "会被删掉再恢复");
  const cp = features.checkpoints.create({ botId: bot.id, root: work, reason: "run 前" });
  assert.ok(cp.fileCount >= 2);
  assert.ok(!Object.keys(cp.entries).some((k) => k.startsWith(".git/")), "用户 .git 不进快照、不被改动");

  // 快照后改动 keep.txt（较新），并删掉 gone.txt
  const keep = join(work, "keep.txt");
  writeFileSync(keep, "B版本（人工改的）");
  const future = (Date.now() + 5000) / 1000;
  utimesSync(keep, future, future);
  rmSync(join(work, "gone.txt"), { force: true });

  const diff = features.checkpoints.diff(bot.id, cp.id);
  assert.deepStrictEqual(diff.modified.map((m) => m.relPath), ["keep.txt"]);
  assert.deepStrictEqual(diff.deleted.map((d) => d.relPath), ["gone.txt"]);

  const guarded = features.checkpoints.restore(bot.id, cp.id);
  assert.deepStrictEqual(guarded.protected.map((p) => p.relPath), ["keep.txt"], "较新编辑必须被保护");
  assert.strictEqual(readFileSync(keep, "utf8"), "B版本（人工改的）");
  assert.deepStrictEqual(guarded.restored.map((r) => r.relPath), ["gone.txt"], "被删的文件从快照恢复");
  assert.strictEqual(readFileSync(join(work, "gone.txt"), "utf8"), "会被删掉再恢复");

  const forced = features.checkpoints.restore(bot.id, cp.id, { force: true });
  assert.deepStrictEqual(forced.restored.map((r) => r.relPath), ["keep.txt"]);
  assert.strictEqual(readFileSync(keep, "utf8"), "A版本");
  assert.ok(existsSync(join(work, ".git", "HEAD")), "用户 .git 始终保留");
});

test("检查点：保留时间戳的改动同样受保护（mtime 判据不可信）", () => {
  const bot = mkBot({ name: "时间戳Bot" });
  const work = workOf(bot.id);
  mkdirSync(work, { recursive: true });
  const keep = join(work, "keep.txt");
  writeFileSync(keep, "快照时的内容");
  const cp = features.checkpoints.create({ botId: bot.id, root: work });

  // 改内容但把 mtime 回拨到快照之前（tar -p / rsync -t / cp -p 的效果）
  writeFileSync(keep, "后来改的内容但时间戳更旧");
  const older = (cp.createdAt - 3600_000) / 1000;
  utimesSync(keep, older, older);

  const out = features.checkpoints.restore(bot.id, cp.id);
  assert.deepStrictEqual(out.protected.map((p) => p.relPath), ["keep.txt"], "内容变了就必须保护，即使时间戳更旧");
  assert.ok(out.protected[0].reason.includes("时间戳不可信"), "文案要说明 mtime 判据不可信");
  assert.strictEqual(readFileSync(keep, "utf8"), "后来改的内容但时间戳更旧", "非 force 不得覆盖更新内容");

  const forced = features.checkpoints.restore(bot.id, cp.id, { force: true });
  assert.deepStrictEqual(forced.restored.map((r) => r.relPath), ["keep.txt"]);
  assert.strictEqual(readFileSync(keep, "utf8"), "快照时的内容");
});

// ---------------- 计划：时区、间隔、错过、重叠 ----------------

test("normalizeSchedule：once 必须在将来，daily 需合法 IANA 时区，interval 有下限", () => {
  expectError(() => normalizeSchedule({ kind: "once", at: Date.now() - 1000 }), "invalid_schedule", 400);
  expectError(() => normalizeSchedule({ kind: "daily", time: "25:00", timezone: "Asia/Shanghai" }), "invalid_schedule", 400);
  expectError(() => normalizeSchedule({ kind: "daily", time: "09:00", timezone: "Nope/Zone" }), "invalid_schedule", 400);
  expectError(() => normalizeSchedule({ kind: "interval", intervalMs: 30_000 }), "invalid_schedule", 400);
  const ok = normalizeSchedule({ kind: "daily", time: "07:05", timezone: "Asia/Shanghai" });
  assert.deepStrictEqual({ kind: ok.kind, time: ok.time, timezone: ok.timezone }, { kind: "daily", time: "07:05", timezone: "Asia/Shanghai" });
  assert.strictEqual(isValidTimeZone("UTC"), true);
  assert.strictEqual(isValidTimeZone("Not/AZone"), false);
});

test("daily 计算精确到 IANA 时区（含 DST 跳变日不越界）", () => {
  const from = Date.UTC(2026, 9, 12, 0, 0, 0); // 2026-10-12T00:00Z
  const next = computeNextRun({ kind: "daily", time: "09:00", timezone: "Asia/Shanghai" }, from);
  assert.strictEqual(next, Date.UTC(2026, 9, 12, 1, 0, 0), "上海 09:00 = 01:00Z");

  const dst = computeNextRun({ kind: "daily", time: "02:30", timezone: "America/New_York" }, Date.UTC(2026, 2, 8, 6, 0, 0));
  assert.ok(dst > Date.UTC(2026, 2, 8, 6, 0, 0), "下一次必须在将来");
  assert.ok(dst < Date.UTC(2026, 2, 9, 6, 0, 0), "跳变日仍在 24h 内");

  const p = tzParts(zonedTimeToUtc(2026, 0, 15, 12, 0, "America/New_York"), "America/New_York");
  assert.deepStrictEqual({ h: p.h, mi: p.mi }, { h: 12, mi: 0 });
});

test("interval 保持相位不漂移；advancePast 跳过已错过的次数", () => {
  const anchor = Date.UTC(2026, 9, 12, 0, 0, 0);
  const sched = { kind: "interval", intervalMs: 60_000, anchor };
  assert.strictEqual(computeNextRun(sched, anchor - 1), anchor, "锚点在未来时下一次就是锚点");
  assert.strictEqual(computeNextRun(sched, anchor), anchor + 60_000, "等于锚点时必须排到下一轮，不能返回当前时刻");
  assert.strictEqual(computeNextRun(sched, anchor + 1), anchor + 60_000);
  assert.ok(computeNextRun(sched, anchor + 60_000) > anchor + 60_000, "严格晚于 from");
  assert.strictEqual(advancePast(sched, anchor, anchor + 90_000), anchor + 120_000);
  assert.strictEqual(advancePast({ kind: "once", at: anchor }, anchor, anchor + 1), null, "once 触发后不再排下一轮");
});

test("调度器：默认暂停不触发；启用后到期真正派发一次原生 Run 并推进下一轮", async () => {
  const bot = mkBot({ name: "计划Bot" });
  const before = startedRuns.length;
  const paused = features.routines.create({ botId: bot.id, text: "日报", schedule: { kind: "interval", intervalMs: 60_000 } });
  assert.strictEqual(paused.paused, true, "新建默认暂停");
  assert.strictEqual(paused.nextRunAt, null, "暂停的计划不排下一轮");
  assert.strictEqual(features.routines.timer, null, "没有任何待触发项时不挂定时器（不快速轮询）");
  await features.routines.tick();
  assert.strictEqual(startedRuns.length, before, "暂停的计划即使 tick 也不派发");

  const live = features.routines.update(paused.id, { paused: false });
  const nowAfterEnable = Date.now();
  assert.ok(live.nextRunAt > nowAfterEnable, "启用后必须排在将来");
  assert.ok(live.nextRunAt <= nowAfterEnable + 60_000, "间隔计划应在下一个间隔内");

  // 到期：把 nextRunAt 拨到该计划自己的相位起点（已到期、且在 missed 宽限内）
  const anchor = features.routines.get(paused.id).schedule.anchor;
  const rec = features.routines.get(paused.id);
  rec.nextRunAt = anchor;
  ledger.put("routines", rec);
  await features.routines.tick();
  assert.strictEqual(startedRuns.length, before + 1, "到期应真正派发一次原生运行");
  assert.strictEqual(startedRuns.at(-1).source, "routine");
  assert.strictEqual(startedRuns.at(-1).botId, bot.id);
  assert.strictEqual(startedRuns.at(-1).text, "日报");
  const after = features.routines.get(paused.id);
  assert.strictEqual(after.lastStatus, "ok");
  assert.strictEqual(after.runs, 1);
  assert.strictEqual(after.receipts[0].status, "ok");
  assert.strictEqual(after.receipts[0].runId, startedRuns.at(-1).id);
  assert.ok(after.nextRunAt > Date.now(), "触发后推进到将来");
  assert.strictEqual(after.nextRunAt, anchor + 60_000, "interval 保持相位（不漂移）");
});

test("调度器：主机休眠导致错过 → 记 missed 回执且不补跑", async () => {
  const bot = mkBot();
  const before = startedRuns.length;
  const r = features.routines.create({ botId: bot.id, text: "巡检", schedule: { kind: "interval", intervalMs: 60_000 }, paused: false });
  const rec = features.routines.get(r.id);
  rec.nextRunAt = Date.now() - 10 * 60_000;
  ledger.put("routines", rec);
  await features.routines.tick();
  const after = features.routines.get(r.id);
  assert.strictEqual(startedRuns.length, before, "错过的计划不自动补跑");
  assert.strictEqual(after.missedCount, 1);
  assert.strictEqual(after.lastStatus, "missed");
  assert.strictEqual(after.receipts[0].status, "missed");
  assert.ok(after.nextRunAt > Date.now());
  features.routines.remove(r.id);
});

test("调度器：上一轮仍活跃时按默认 skip 策略跳过并留回执", async () => {
  const bot = mkBot();
  const before = startedRuns.length;
  const r = features.routines.create({
    botId: bot.id,
    text: "长任务",
    schedule: { kind: "interval", intervalMs: 60_000 },
    paused: false,
  });
  const rec = features.routines.get(r.id);
  rec.activeRunId = "run_active";
  rec.nextRunAt = Date.now() - 1000;
  ledger.put("routines", rec);
  runsById.set("run_active", { id: "run_active", state: "running" });
  await features.routines.tick();
  assert.strictEqual(startedRuns.length, before, "重叠默认跳过，不产生无界队列");
  const after = features.routines.get(r.id);
  assert.strictEqual(after.receipts[0].status, "skipped");
  assert.strictEqual(after.receipts[0].reason, "overlap");
  features.routines.remove(r.id);
});

test("调度器：Bot 被人工接管（暂停）时计划不触发", async () => {
  const bot = mkBot();
  const live = { rpc: { env: {} }, cwd: workOf(bot.id), sessionDir: join(home, "s") };
  orch.runtimes.set(`${bot.id}::private`, live);
  nativeState = { isStreaming: false, isSettled: true, dumpTools: [{ name: "eval", description: "→ `xd://eval/browser`" }] };
  const r = features.routines.create({ botId: bot.id, text: "定时", schedule: { kind: "interval", intervalMs: 60_000 }, paused: false });
  await features.native.browserTakeover(bot.id, "private", { reason: "人工接管" });
  const out = await features.routines.fire(features.routines.get(r.id), { source: "routine" });
  assert.strictEqual(out.status, "skipped");
  assert.strictEqual(out.reason, "bot_paused");
  await features.native.browserRelease(bot.id, "private");
  features.routines.remove(r.id);
  orch.runtimes.delete(`${bot.id}::private`);
  nativeState = null;
});

test("计划校验：未登记 Bot 与空文本被拒", () => {
  expectError(() => features.routines.create({ botId: "bot_nope", text: "x", schedule: { kind: "interval", intervalMs: 60_000 } }), "bot_not_found", 404);
  const bot = mkBot();
  expectError(() => features.routines.create({ botId: bot.id, text: "   ", schedule: { kind: "interval", intervalMs: 60_000 } }), "invalid_field", 400);
});

// ---------------- 原生能力面：MCP / skills / memory / browser ----------------

test("MCP：Bot 私有项目目录写原生 .omp/mcp.json，密钥只回显存在性", async () => {
  const bot = mkBot({ name: "MCPBot" });
  const out = await features.native.putMcp(bot.id, "private", {
    mcpServers: {
      github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer SUPER_SECRET_TOKEN" } },
      fs: { type: "stdio", command: "npx", args: ["-y", "server"] },
    },
    disabledServers: ["legacy"],
  });
  const file = features.native.mcpFile(bot.id, "private");
  assert.ok(existsSync(file), "原生项目配置应写在 Bot 自己的工作目录");
  assert.ok(file.startsWith(workOf(bot.id)), "MCP 配置只在 Bot 私有项目目录，不动用户全局");
  assert.strictEqual(file, join(workOf(bot.id), ".omp", "mcp.json"), "项目级配置必须在 Bot 私有 cwd 下");
  const gh = out.servers.find((s) => s.name === "github");
  assert.strictEqual(gh.url, "https://api.githubcopilot.com/mcp/");
  assert.strictEqual(gh.hasSecrets, true);
  assert.deepStrictEqual(gh.secretKeys, ["headers.Authorization"]);
  assert.ok(!JSON.stringify(out).includes("SUPER_SECRET_TOKEN"), "接口不得回显密钥");
  assert.deepStrictEqual(out.disabledServers, ["legacy"]);
  assert.strictEqual(out.applies, "after-running-turn-ends", "夹具没有 core 重建入口时不得假称已生效");
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.strictEqual(onDisk.mcpServers.github.headers.Authorization, "Bearer SUPER_SECRET_TOKEN", "原生文件里保留真实定义供 OMP 使用");
});

test("MCP：URL 携带的凭据不回显，但真实值留在私有配置里", async () => {
  const bot = mkBot({ name: "URL秘密Bot" });
  const file = features.native.mcpFile(bot.id, "private");
  const basicUser = "user";
  const basicSecret = "BASIC" + "_PW";
  const out = await features.native.putMcp(bot.id, "private", {
    mcpServers: {
      api: { type: "http", url: "https://svc.example/mcp?token=URL_SECRET_TOKEN&mode=ro#access_token=FRAG" },
      basic: { type: "sse", url: `https://${basicUser}:${basicSecret}@svc.example/sse` },
    },
  });
  const api = out.servers.find((s) => s.name === "api");
  const basic = out.servers.find((s) => s.name === "basic");
  const rendered = JSON.stringify(out);
  assert.ok(!rendered.includes("URL_SECRET_TOKEN"), "query 里的 token 不得回显");
  assert.ok(!rendered.includes("FRAG"), "hash 里的 token 不得回显");
  assert.ok(!rendered.includes(basicSecret), "userinfo 不得回显");
  assert.strictEqual(api.url, "https://svc.example/mcp");
  assert.strictEqual(basic.url, "https://svc.example/sse");
  assert.strictEqual(api.urlRedacted, true);
  assert.strictEqual(basic.urlRedacted, true);
  assert.strictEqual(api.hasSecrets, true);
  assert.ok(api.secretKeys.includes("url.query.token"));
  assert.ok(basic.secretKeys.includes("url.userinfo"));
  assert.ok(api.urlNote.includes("已剥离"));
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(onDisk.mcpServers.api.url.includes("URL_SECRET_TOKEN"), "私有配置里保留真实 URL 供原生连接");
});

test("MCP：运行中拒绝写入（409），不改写用户原配置", async () => {
  const bot = mkBot({ name: "忙碌Bot" });
  const file = features.native.mcpFile(bot.id, "private");
  await features.native.putMcp(bot.id, "private", { mcpServers: { keep: { command: "npx" } } });
  const before = readFileSync(file, "utf8");

  // busy 探测只读已有进程（botRuntimeBusy 不会懒启动）；没有该方法时按 false 处理。
  orch.botRuntimeBusy = (id) => id === bot.id;
  await expectErrorAsync(
    () => features.native.putMcp(bot.id, "private", { mcpServers: { other: { command: "npx" } } }),
    "runtime_busy",
    409,
  );
  assert.strictEqual(readFileSync(file, "utf8"), before, "运行中不得改写配置");
  delete orch.botRuntimeBusy;
});

test("MCP：保存后走 core 安全重建并原样回报结果", async () => {
  const bot = mkBot({ name: "重建Bot" });
  const calls = [];
  orch.restartBotRuntimes = async (id, opts) => {
    calls.push({ id, opts });
    return { restarted: true, blocked: null };
  };
  const ok = await features.native.putMcp(bot.id, "private", { mcpServers: { x: { command: "npx" } } });
  assert.deepStrictEqual(calls, [{ id: bot.id, opts: { reason: "mcp-config" } }]);
  assert.strictEqual(ok.restartRequired, false);
  assert.strictEqual(ok.applies, "now");
  assert.deepStrictEqual(ok.restart, { restarted: true, blocked: null });

  orch.restartBotRuntimes = async () => ({ restarted: false, blocked: { scopes: [{ scope: "private", busy: true }], reason: "busy" } });
  const blocked = await features.native.putMcp(bot.id, "private", { mcpServers: { x: { command: "npx" } } });
  assert.strictEqual(blocked.restartRequired, true, "blocked 必须如实回报，不假成功");
  assert.strictEqual(blocked.applies, "after-running-turn-ends");
  assert.deepStrictEqual(blocked.restart.blocked, { scopes: [{ scope: "private", busy: true }], reason: "busy" });
  delete orch.restartBotRuntimes;
});

test("MCP 校验对齐原生规则：stdio 需 command，不能同时给 command+url，名称受限", () => {
  expectError(() => validateMcpServer("x", { type: "stdio" }), "invalid_mcp_server", 400);
  expectError(() => validateMcpServer("x", { command: "a", url: "https://b" }), "invalid_mcp_server", 400);
  expectError(() => validateMcpServer("bad/name", { command: "a" }), "invalid_mcp_name", 400);
  expectError(() => validateMcpServer("x", { type: "smoke" }), "invalid_mcp_server", 400);
  assert.strictEqual(validateMcpServer("ok.1", { url: "https://x/mcp" }).type, "http");
});

test("skills：私有技能总是加载，白名单只管共享库，过滤 glob 生效", async () => {
  const bot = mkBot({ name: "技能Bot" });
  const dir = join(workOf(bot.id), ".omp", "skills", "pdf-tools");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: pdf-tools\ndescription: 处理 PDF\n---\n\nbody\n");
  const status = await features.native.skillsStatus(bot.id, "private", ["/skill:pdf-tools"]);
  assert.deepStrictEqual(status.private.map((s) => s.name), ["pdf-tools"]);
  assert.strictEqual(status.private[0].selected, true);
  const nested = join(workOf(bot.id), ".omp", "skills", "group", "deep");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "SKILL.md"), "---\nname: deep\n---\n");
  assert.deepStrictEqual((await features.native.skillsStatus(bot.id, "private")).private.map((s) => s.name), ["pdf-tools"], "非一层布局不递归发现");

  const put = features.native.putSkills(bot.id, { skills: ["git-*"] });
  assert.deepStrictEqual(put.filter, ["git-*"]);
  const filtered = await features.native.skillsStatus(bot.id, "private");
  assert.deepStrictEqual(filtered.effective, ["pdf-tools"], "白名单不匹配私有技能也照样加载");
  assert.strictEqual(features.native.constructor.matchFilter(["git-*"], "git-commit"), true);
  features.native.putSkills(bot.id, { skills: null });
});

test("parseSkillFrontmatter 读 name/description", () => {
  assert.deepStrictEqual(parseSkillFrontmatter("---\nname: a\ndescription: \"b c\"\n---\nx"), { name: "a", description: "b c" });
  assert.deepStrictEqual(parseSkillFrontmatter("no frontmatter"), {});
});

test("capabilities：汇总原生模型/工具/命令，未知字段写 unknown", async () => {
  const bot = mkBot();
  const live = { rpc: { env: {} }, cwd: workOf(bot.id), sessionDir: join(home, "s") };
  orch.runtimes.set(`${bot.id}::private`, live);
  // 真实形状（.scratch/omp-native-workbench/browser-artifact-proof.json）：dumpTools 只有 AgentTool，
  // browser 是 Eval prelude，只在 eval 工具描述里广告。
  nativeState = {
    model: { provider: "magpie", id: "deepseek-v4.1-flash" },
    thinkingLevel: "low",
    sessionId: "sess_1",
    sessionFile: "C:\\tmp\\sess.jsonl",
    isSettled: true,
    isStreaming: false,
    messageCount: 3,
    dumpTools: [
      { name: "read", description: "Read files." },
      { name: "eval", description: "<namespaces>\n- `browser`: Drive real Chromium tabs. → `xd://eval/browser`\n</namespaces>" },
      { name: "write", description: "Write files." },
    ],
  };
  nativeCommands = { commands: [{ name: "/skill:pdf-tools" }, { name: "help" }] };
  const caps = await features.native.capabilities(bot.id, "private");
  assert.strictEqual(caps.native.model.id, "deepseek-v4.1-flash");
  assert.strictEqual(caps.tools.count, 3);
  assert.deepStrictEqual(caps.tools.names, ["read", "eval", "write"]);
  assert.deepStrictEqual(caps.commands, ["/skill:pdf-tools", "help"]);
  assert.strictEqual(caps.execution.sandbox, false);
  assert.ok(caps.execution.note.includes("不是 OS 沙箱"));
  assert.strictEqual(caps.mcp.native, true);
  assert.strictEqual(caps.browser.humanUrl, null);
  assert.strictEqual(caps.browser.capability.state, "available", "eval 描述广告了 browser prelude 才算可用");
  assert.strictEqual(caps.browser.capability.evidence, "eval-description");
  assert.strictEqual(caps.browser.capability.evalDescriptionHasBrowser, true);

  nativeState = null;
  const unknown = await features.native.capabilities(bot.id, "private");
  assert.strictEqual(unknown.tools, "unknown");
  assert.ok(unknown.nativeError, "读不到原生状态要如实报告错误");
  assert.strictEqual(unknown.browser.capability.state, "unknown", "读不到原生状态时能力写未知，不假装可用");
  orch.runtimes.delete(`${bot.id}::private`);
  nativeCommands = { commands: [] };
});

test("memory：mnemopi 只读状态，库在 team/.memory，只看本 bot 的 bank", () => {
  const bot = mkBot({ name: "记忆Bot" });
  const dbPath = join(home, "team", ".memory", "mnemopi.db");
  // 库还没建：不报错，计数为 0
  const cold = features.native.memoryRead(bot.id, "private");
  assert.strictEqual(cold.enabled, false);
  assert.strictEqual(cold.backend, "mnemopi");
  assert.strictEqual(cold.scoping, "global");
  assert.strictEqual(cold.bank, `bot-${bot.id}`);
  assert.strictEqual(cold.dbPath, dbPath);
  assert.strictEqual(cold.dbExists, false);
  assert.deepStrictEqual(cold.memories, []);
  assert.ok(cold.reasons[0].includes("没开"));
  assert.strictEqual(cold.embedding.model, "intfloat/multilingual-e5-large");

  // 一个库里两个 bank：只读到自己的，按时间新的在前
  fsMkdirSync(join(home, "team", ".memory"), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT, source TEXT, timestamp TEXT, session_id TEXT, superseded_by TEXT, created_at TEXT)");
  db.exec("CREATE TABLE episodic_memory (id TEXT PRIMARY KEY, content TEXT, source TEXT, timestamp TEXT, session_id TEXT, superseded_by TEXT, created_at TEXT)");
  const put = (table, id, content, at, bank, superseded = null) =>
    db.prepare(`INSERT INTO ${table} VALUES (?, ?, 'conversation', ?, ?, ?, ?)`).run(id, content, at, bank, superseded, at);
  put("working_memory", "w1", "[私聊，用户] 我的猫叫年糕", "2026-01-01T10:00:00Z", `bot-${bot.id}`);
  put("working_memory", "w2", "[群聊，产品群] 周五发版", "2026-01-02T10:00:00Z", `bot-${bot.id}`);
  put("working_memory", "w3", "旧说法", "2026-01-03T10:00:00Z", `bot-${bot.id}`, "w2");
  put("episodic_memory", "e1", "用户养猫", "2026-01-01T12:00:00Z", `bot-${bot.id}`);
  put("working_memory", "x1", "别的 bot 的秘密", "2026-01-05T10:00:00Z", "bot-someone-else");
  db.close();

  bot.memoryEnabled = true;
  const mem = features.native.memoryRead(bot.id, "private");
  assert.strictEqual(mem.enabled, true);
  assert.strictEqual(mem.available, true);
  assert.strictEqual(mem.dbExists, true);
  assert.deepStrictEqual(mem.counts, { working: 3, episodic: 1 });
  assert.deepStrictEqual(mem.memories.map((m) => m.id), ["w2", "e1", "w1"], "被替换的旧条目不列，新的在前");
  assert.strictEqual(mem.memories[1].kind, "episodic");
  assert.ok(!JSON.stringify(mem).includes("别的 bot 的秘密"), "读不到别的 bank");
  // 群聊 scope 看的是同一个 bank
  assert.deepStrictEqual(features.native.memoryRead(bot.id, "room:r1").memories.map((m) => m.id), ["w2", "e1", "w1"]);
  // 只读：没有写入、清空、探测
  assert.strictEqual(features.native.memoryWrite, undefined);
  assert.strictEqual(features.native.memoryClear, undefined);
  assert.strictEqual(features.native.verifyMemoryPath, undefined);

  // 表结构对不上：如实报错，不抛
  fsRmSync(dbPath, { force: true });
  fsWriteFileSync(dbPath, "not a database");
  const broken = features.native.memoryRead(bot.id, "private");
  assert.ok(broken.readError && broken.readError.includes("读记忆库失败"));
  fsRmSync(dbPath, { force: true });
  bot.memoryEnabled = false;
});

test("botPaths：cwd 永远是 team 里的 Bot 目录，workspace 只作独立读根", () => {
  const ws = join(home, "ws-explicit");
  mkdirSync(ws, { recursive: true });
  const bot = mkBot({ workspace: ws });
  const p = botPaths(orch, home, bot.id, "room:r1");
  assert.strictEqual(p.baseDir, join(home, "bots", bot.id, "room_r1"));
  assert.strictEqual(
    p.cwd,
    join(home, "team", "bots", bot.id),
    "workspace 是 --add-dir 的读根，绝不能当作 cwd（否则项目级 MCP 配置写到用户工作区，原生读不到）",
  );
  assert.strictEqual(p.workDir, join(p.cwd, "work"));
  assert.strictEqual(p.sessionDir, join(p.cwd, "sessions", "room_r1"));
  assert.strictEqual(p.memoryDbPath, join(home, "team", ".memory", "mnemopi.db"));
  assert.strictEqual(p.agentDir, undefined);
  assert.strictEqual(p.workspace, ws);
  mkdirSync(p.cwd, { recursive: true });
  const roots = features.artifacts.scanRoots({ botId: bot.id }, { cwd: p.cwd });
  assert.deepStrictEqual(roots, [p.cwd, ws], "扫描应包含私有 cwd 与允许的工作区两个独立根");
});

test("browser：按 eval 描述判定能力；运行中/未 settled/无 eval/chat 一律拒绝接管", async () => {
  const bot = mkBot();
  const live = { rpc: { env: {} }, cwd: workOf(bot.id), sessionDir: join(home, "s") };
  orch.runtimes.set(`${bot.id}::private`, live);
  const advertised = { name: "eval", description: "<namespaces>\n- `browser`: Drive real Chromium tabs. → `xd://eval/browser`\n</namespaces>" };

  // 运行中 → 先拒（不是 browser_tool_absent）。
  nativeState = { isStreaming: true, hasPendingAsyncWork: false, dumpTools: [advertised] };
  await expectErrorAsync(() => features.native.browserTakeover(bot.id, "private"), "bot_running", 409);

  // 读得到 eval 但描述没广告 browser → 原生 browser prelude 不可用（配置关闭或未安装）。
  nativeState = { isStreaming: false, isSettled: true, dumpTools: [{ name: "eval", description: "no browser here" }] };
  const absent = await expectErrorAsync(() => features.native.browserTakeover(bot.id, "private"), "browser_unavailable", 409);
  assert.strictEqual(absent.extra.capability.evalDescriptionHasBrowser, false);
  assert.strictEqual(features.isPaused(bot.id, "private"), false, "不可用时不得进入暂停");

  // 仍在流式/未 settled → 拒绝接管，不暂停。
  nativeState = { isStreaming: false, isSettled: false, hasPendingAsyncWork: false, dumpTools: [advertised] };
  await expectErrorAsync(() => features.native.browserTakeover(bot.id, "private"), "bot_not_settled", 409);
  assert.strictEqual(features.isPaused(bot.id, "private"), false);

  // 有排队工作 → 拒绝。
  nativeState = { isStreaming: false, isSettled: true, hasPendingAsyncWork: true, dumpTools: [advertised] };
  await expectErrorAsync(() => features.native.browserTakeover(bot.id, "private"), "bot_running", 409);

  // 正常接管：eval 描述广告 browser prelude 即视为可用。
  nativeState = { isStreaming: false, isSettled: true, hasPendingAsyncWork: false, dumpTools: [advertised] };
  const rec = await features.native.browserTakeover(bot.id, "private", { reason: "人工登录" });
  assert.strictEqual(rec.active, true);
  assert.strictEqual(rec.humanUrl, null, "不得暴露任何 URL");
  assert.strictEqual(rec.capability.evidence, "eval-description");
  assert.strictEqual(features.isPaused(bot.id, "private"), true);
  assert.strictEqual(features.native.pausedList().length, 1);
  await expectErrorAsync(() => features.native.browserTakeover(bot.id, "private"), "already_taken_over", 409);

  // 原生未 settled → 释放失败且保留暂停。
  nativeState = { isStreaming: false, isSettled: false, hasPendingAsyncWork: false, dumpTools: [advertised] };
  await expectErrorAsync(() => features.native.browserRelease(bot.id, "private"), "bot_not_settled", 409);
  assert.strictEqual(features.isPaused(bot.id, "private"), true, "未 settled 时不得解除暂停");
  nativeState = { isStreaming: true, isSettled: false, dumpTools: [advertised] };
  await expectErrorAsync(() => features.native.browserRelease(bot.id, "private"), "bot_not_settled", 409);
  assert.strictEqual(features.isPaused(bot.id, "private"), true);

  // 原生状态读不到 → 释放失败且保留暂停（不吞成假成功）。
  const savedState = nativeState;
  nativeState = null;
  await expectErrorAsync(() => features.native.browserRelease(bot.id, "private"), "native_state_unavailable", 409);
  assert.strictEqual(features.isPaused(bot.id, "private"), true);
  nativeState = savedState;

  // settled 后释放成功。
  nativeState = { isStreaming: false, isSettled: true, hasPendingAsyncWork: false, dumpTools: [advertised] };
  const done = await features.native.browserRelease(bot.id, "private");
  assert.strictEqual(done.active, false);
  assert.strictEqual(done.settledAtRelease, true);
  assert.strictEqual(features.isPaused(bot.id, "private"), false);
  await expectErrorAsync(() => features.native.browserRelease(bot.id, "private"), "not_taken_over", 409);

  const status = features.native.browserStatus(bot.id, "private");
  assert.ok(status.publicSharing.includes("不会自动开启"), "公网共享必须显式且不由本接口开启");
  assert.strictEqual(status.humanUrl, null);
  assert.ok(status.howItWorks.some((line) => line.includes("persist:true")), "必须说明 persist 防冻结");
  orch.runtimes.delete(`${bot.id}::private`);
  nativeState = null;
});

test("browser：runtime 未启动时能力未知 → 拒绝接管（不假装接管成功）", async () => {
  const bot = mkBot();
  nativeState = { isStreaming: false, isSettled: true, dumpTools: [{ name: "eval", description: "→ `xd://eval/browser`" }] };
  const err = await expectErrorAsync(() => features.native.browserTakeover(bot.id, "private"), "browser_capability_unknown", 409);
  assert.strictEqual(err.extra.capability.state, "unknown");
  assert.strictEqual(err.extra.capability.evidence, "runtime-not-running");
  assert.strictEqual(features.isPaused(bot.id, "private"), false);
  nativeState = null;
});

test("browser：chat 受控读取档（--no-tools）没有 eval，接管被拒", async () => {
  const bot = mkBot({ executionMode: "chat" });
  const live = { rpc: { env: {} }, cwd: workOf(bot.id), sessionDir: join(home, "s") };
  orch.runtimes.set(`${bot.id}::private`, live);
  nativeState = { isStreaming: false, isSettled: true, dumpTools: [] };
  const err = await expectErrorAsync(() => features.native.browserTakeover(bot.id, "private"), "browser_unavailable", 409);
  assert.strictEqual(err.extra.capability.evidence, "chat-mode");
  assert.strictEqual(features.isPaused(bot.id, "private"), false);
  orch.runtimes.delete(`${bot.id}::private`);
  nativeState = null;
});

test("browser：显式 browser.enabled=false 的生效配置如实回报", () => {
  const bot = mkBot();
  const cfg = join(workOf(bot.id), ".omp", "config.yml");
  mkdirSync(join(workOf(bot.id), ".omp"), { recursive: true });
  writeFileSync(cfg, "browser:\n  enabled: false\n  headless: false\n  idleCloseSec: 900\ntask:\n  maxConcurrency: 4\n");
  const settings = features.native.browserSettings(bot.id, "private");
  assert.strictEqual(settings.explicitEnabled, false);
  const entry = Object.values(settings.files)[0];
  assert.strictEqual(entry.enabled, false);
  assert.strictEqual(entry.headless, false);
  assert.strictEqual(entry.idleCloseSec, 900);
  assert.strictEqual(entry.freezeOnTurnEnd, null, "未写 freezeOnTurnEnd 时写 null，不猜默认值");
});

test("browser：Bot 不存在时接管被拒", async () => {
  await expectErrorAsync(() => features.native.browserTakeover("bot_nope", "private"), "bot_not_found", 404);
});

test("browser 路由：状态含真实能力，失败经 handleRequest 回 409 与具体 code", async () => {
  const bot = mkBot();
  const live = { rpc: { env: {} }, cwd: workOf(bot.id), sessionDir: join(home, "s") };
  orch.runtimes.set(`${bot.id}::private`, live);
  const adv = { name: "eval", description: "- `browser`: → `xd://eval/browser`" };

  nativeState = { isStreaming: false, isSettled: true, hasPendingAsyncWork: false, dumpTools: [adv] };
  const statusJson = fakeJson();
  await features.handleRequest(
    { method: "GET" },
    fakeRes(),
    new URL(`http://x/api/bots/${bot.id}/browser`),
    null,
    statusJson.fn,
  );
  assert.strictEqual(statusJson.calls[0].code, 200);
  assert.strictEqual(statusJson.calls[0].obj.capability.state, "available");
  assert.strictEqual(statusJson.calls[0].obj.humanUrl, null);

  nativeState = { isStreaming: false, isSettled: false, dumpTools: [adv] };
  const takeoverJson = fakeJson();
  await features.handleRequest(
    { method: "POST" },
    fakeRes(),
    new URL(`http://x/api/bots/${bot.id}/browser/takeover`),
    {},
    takeoverJson.fn,
  );
  assert.strictEqual(takeoverJson.calls[0].code, 409);
  assert.strictEqual(takeoverJson.calls[0].obj.code, "bot_not_settled");
  assert.strictEqual(features.isPaused(bot.id, "private"), false);

  nativeState = { isStreaming: false, isSettled: true, hasPendingAsyncWork: false, dumpTools: [adv] };
  const okJson = fakeJson();
  await features.handleRequest(
    { method: "POST" },
    fakeRes(),
    new URL(`http://x/api/bots/${bot.id}/browser/takeover`),
    {},
    okJson.fn,
  );
  assert.strictEqual(okJson.calls[0].code, 200);
  assert.strictEqual(okJson.calls[0].obj.takeover.active, true);

  const releaseJson = fakeJson();
  await features.handleRequest(
    { method: "POST" },
    fakeRes(),
    new URL(`http://x/api/bots/${bot.id}/browser/release`),
    {},
    releaseJson.fn,
  );
  assert.strictEqual(releaseJson.calls[0].code, 200);
  assert.strictEqual(releaseJson.calls[0].obj.takeover.settledAtRelease, true);

  orch.runtimes.delete(`${bot.id}::private`);
  nativeState = null;
});

// ---------------- 路由接入 ----------------

test("handleRequest 分发：附件、成果、计划、能力、检查点；未知路径返回 false", async () => {
  const bot = mkBot({ name: "路由Bot" });
  const res = fakeRes();
  const j = fakeJson();
  const url = new URL("http://127.0.0.1:3099/api/attachments");
  const handled = await features.handleRequest(
    { method: "POST" },
    res,
    url,
    { botId: bot.id, filename: "u.png", mime: "image/png", dataBase64: PNG.toString("base64") },
    j.fn,
  );
  assert.strictEqual(handled, true);
  assert.strictEqual(j.calls.length, 1);
  assert.strictEqual(j.calls[0].code, 200);
  assert.ok(j.calls[0].obj.attachment.id);

  // 图片附件预览必须真的可读（UI 的 <img> 走这条 raw 路由）
  const attId = j.calls[0].obj.attachment.id;
  const previewRes = fakeRes();
  const previewHandled = await features.handleRequest(
    { method: "GET" },
    previewRes,
    new URL(`http://x/api/attachments/${attId}/preview?botId=${bot.id}`),
    null,
    fakeJson().fn,
  );
  assert.strictEqual(previewHandled, true);
  assert.strictEqual(previewRes.out.status, 200);
  assert.strictEqual(previewRes.out.headers["Content-Type"], "image/png");
  assert.ok(previewRes.out.body.equals(PNG), "预览路由必须回原始图片字节");
  assert.strictEqual(previewRes.out.headers["Set-Cookie"], undefined);

  const missRes = fakeRes();
  const missJson = fakeJson();
  const miss = await features.handleRequest({ method: "GET" }, missRes, new URL("http://x/api/nope"), null, missJson.fn);
  assert.strictEqual(miss, false, "不认识的产品路径必须交回 server");
  assert.strictEqual(missJson.calls.length, 0);

  const wrongMethod = fakeJson();
  await features.handleRequest({ method: "PATCH" }, fakeRes(), new URL("http://x/api/routines"), null, wrongMethod.fn);
  assert.strictEqual(wrongMethod.calls[0].code, 405);
  assert.strictEqual(wrongMethod.calls[0].obj.code, "method_not_allowed");

  const notFound = fakeJson();
  await features.handleRequest({ method: "GET" }, fakeRes(), new URL("http://x/api/artifacts/nope/download"), null, notFound.fn);
  assert.strictEqual(notFound.calls[0].code, 404);
  assert.strictEqual(notFound.calls[0].obj.code, "artifact_not_found");

  const rec = realReportArtifact;
  assert.ok(rec, "raw 下载路由也需要真实快照记录");
  const rawRes = fakeRes();
  const rawHandled = await features.handleRequest(
    { method: "GET" },
    rawRes,
    new URL(`http://x/api/artifacts/${rec.id}/download`),
    null,
    fakeJson().fn,
  );
  assert.strictEqual(rawHandled, true);
  assert.strictEqual(rawRes.out.status, 200, "下载路由自行写响应（raw）");
  assert.ok(rawRes.out.ended);
});

// ---------------- 受限档宿主工具（--no-tools 下唯一的读取面） ----------------

test("受限档工具：只能读 Bot 自己范围内文件，越界与私网抓取被拒", async () => {
  const bot = mkBot({ name: "受限Bot" });
  const work = workOf(bot.id);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "notes.md"), "受控资料内容");
  writeFileSync(join(home, "secret-outside.txt"), "不该被读到");

  const runtime = { bot, cwd: work, scope: "private" };
  const tools = features.hostTools(runtime);
  const names = tools.map((t) => t.name);
  assert.deepStrictEqual(names, ["read_workspace_file", "list_workspace", "fetch_public_url"]);

  const read = tools.find((t) => t.name === "read_workspace_file");
  const okOut = await read.handler({ path: "notes.md" });
  assert.ok(okOut.text.includes("受控资料内容"));
  await expectErrorAsync(() => read.handler({ path: join(home, "secret-outside.txt") }), "path_not_allowed", 403);
  await expectErrorAsync(() => read.handler({ path: "missing.md" }), "file_not_found", 404);

  const list = tools.find((t) => t.name === "list_workspace");
  const listed = await list.handler({});
  assert.ok(listed.text.includes("notes.md"));

  const fetchTool = tools.find((t) => t.name === "fetch_public_url");
  await expectErrorAsync(() => fetchTool.handler({ url: "http://127.0.0.1:3099/api/state" }), "private_target", 403);
  await expectErrorAsync(() => fetchTool.handler({ url: "http://169.254.169.254/latest/meta-data/" }), "private_target", 403);
  await expectErrorAsync(() => fetchTool.handler({ url: "file:///C:/Windows/win.ini" }), "invalid_url", 400);
  await expectErrorAsync(() => fetchTool.handler({ url: "http://localhost:8080/" }), "private_target", 403);
  await expectErrorAsync(() => fetchTool.handler({ url: "http://user:pw@example.com/" }), "invalid_url", 400);
  await expectErrorAsync(() => fetchTool.handler({ url: "http://10.0.0.5/" }), "private_target", 403);
});

test("SSRF 门：每一跳都用注入解析器重新校验（重定向不能绕到私网）", async () => {
  const { parsePublicUrl, pinPublicAddress } = await import("../src/features/hosttools.mjs");
  assert.strictEqual(parsePublicUrl("https://example.com/a").hostname, "example.com");
  expectError(() => parsePublicUrl("ftp://example.com/"), "invalid_url", 400);
  expectError(() => parsePublicUrl("http://u:p@example.com/"), "invalid_url", 400);

  // 公网名字解析到私网地址（重绑定/恶意重定向的目标）必须被拒
  await expectErrorAsync(
    () => pinPublicAddress(new URL("http://evil.example/"), { lookupFn: async () => [{ address: "127.0.0.1", family: 4 }] }),
    "private_target",
    403,
  );
  await expectErrorAsync(
    () => pinPublicAddress(new URL("http://evil.example/"), { lookupFn: async () => [{ address: "169.254.169.254", family: 4 }] }),
    "private_target",
    403,
  );
  await expectErrorAsync(
    () => pinPublicAddress(new URL("http://mixed.example/"), { lookupFn: async () => [{ address: "10.0.0.9", family: 4 }, { address: "192.168.0.2", family: 4 }] }),
    "private_target",
    403,
  );
  const pinned = await pinPublicAddress(new URL("http://ok.example/"), { lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] });
  assert.deepStrictEqual(pinned, { address: "93.184.216.34", family: 4 });
  await expectErrorAsync(() => pinPublicAddress(new URL("http://none.example/"), { lookupFn: async () => [] }), "private_target", 403);
});

test("isPrivateAddress 覆盖环回/私网/链路本地/ULA", async () => {
  const { isPrivateAddress } = await import("../src/features/hosttools.mjs");
  for (const bad of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fe80::1", "fd00::1", "not-an-ip"]) {
    assert.strictEqual(isPrivateAddress(bad), true, `${bad} 应判为私网`);
  }
  assert.strictEqual(isPrivateAddress("93.184.216.34"), false);
  assert.strictEqual(isPrivateAddress("2606:4700::1111"), false);
});

test("MCP：添加服务保留其他服务秘密与启停配置，坏原件不被覆盖", async () => {
  const bot = mkBot();
  const file = features.native.mcpFile(bot.id, "private");
  await features.native.putMcp(bot.id, "private", { mcpServers: { first: { command: "node", env: { API_KEY: "PRIVATE_FIRST_KEY" } } }, disabledServers: ["first"] });
  const result = await features.native.putMcp(bot.id, "private", { mcpServers: { second: { command: "node" } } });
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.strictEqual(saved.mcpServers.first.env.API_KEY, "PRIVATE_FIRST_KEY");
  assert.ok(saved.mcpServers.second);
  assert.deepStrictEqual(saved.disabledServers, ["first"]);
  assert.strictEqual(JSON.stringify(result).includes("PRIVATE_FIRST_KEY"), false);
  writeFileSync(file, "{invalid");
  await expectErrorAsync(() => features.native.putMcp(bot.id, "private", { mcpServers: { third: { command: "node" } } }), "mcp_config_invalid", 409);
  assert.strictEqual(readFileSync(file, "utf8"), "{invalid");
});

test("browser：重启保留人工暂停，进程退出后可归还且不假称 settled", async () => {
  const bot = mkBot();
  orch.runtimes.set(`${bot.id}::private`, { rpc: { env: {} }, cwd: workOf(bot.id) });
  nativeState = { isSettled: true, isStreaming: false, dumpTools: [{ name: "eval", description: "xd://eval/browser" }] };
  await features.native.browserTakeover(bot.id);
  orch.runtimes.delete(`${bot.id}::private`);
  nativeState = null;
  features.native = new features.native.constructor({ orch, home });
  assert.strictEqual(features.isPaused(bot.id), true);
  const released = await features.native.browserRelease(bot.id);
  assert.strictEqual(released.active, false);
  assert.strictEqual(released.settledAtRelease, null);
  assert.strictEqual(features.isPaused(bot.id), false);
  const restarted = new features.native.constructor({ orch, home });
  assert.strictEqual(restarted.isPaused(bot.id), false);
});

test("飞书配置：保存和启停保留环境引用，轮换后使用新秘密且不回显", async () => {
  const key = "OMPBOT_QA_FEISHU_SECRET";
  const previous = process.env[key];
  const request = async body => {
    const json = fakeJson();
    await features.handleRequest({ method: "PUT" }, fakeRes(), new URL("http://local/api/channels/feishu"), body, json.fn);
    assert.strictEqual(json.calls[0].code, 200);
    return json.calls[0].obj;
  };
  try {
    process.env[key] = "FIRST_ENV_SECRET";
    await request({ enabled: false, appId: "cli_qa", appSecretEnv: key });
    assert.strictEqual(Object.hasOwn(readChannelConfig(home), "appSecret"), false);
    process.env[key] = "ROTATED_ENV_SECRET";
    const status = await request({ enabled: false });
    assert.strictEqual(features._bridge.config.appSecret, "ROTATED_ENV_SECRET");
    assert.strictEqual(Object.hasOwn(readChannelConfig(home), "appSecret"), false);
    assert.strictEqual(JSON.stringify(status).includes("ROTATED_ENV_SECRET"), false);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    await features._bridge?.close();
  }
});

// ---------------- 收尾与汇总 ----------------

for (const [, fn] of tests) {
  await fn();
}

// 计划列表清空后不应再挂定时器
features.routines.stop();
ledger.close();
rmSync(home, { recursive: true, force: true });
console.log(`\n${tests.length} 项行为测试通过（测试本身由主代理统一运行，本文件不自行执行）`);
