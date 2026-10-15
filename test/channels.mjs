// test/channels.mjs — 配对与飞书 IM 适配器的确定性测试。
//
// 全部本地运行：真实 Ledger（临时 home 的 SQLite）+ 真实 HTTP receiver + 本地假飞书端点。
// 不调用任何模型、不发真实业务消息、不碰用户 home。
// Orchestrator.startRun 由 CoreOwner 所有且需要真实 omp 进程，因此这里用真实 Ledger 之上的
// 最小团队门面（makeTeam）承载 Run；被验证的是 pairing.mjs / channels.mjs 的真实逻辑。

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";

import { Ledger } from "../src/ledger.mjs";
import { PairingError, PairingService } from "../src/pairing.mjs";
import { validateUiResponse } from "../src/orchestrator.mjs";
import {
  ChannelsError,
  FeishuBridge,
  sha256hex,
  approvalResponse,
  decryptCallback,
  identityKeyOf,
  planCommand,
  readChannelConfig,
  writeChannelConfig,
} from "../src/channels.mjs";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sha = (s) => createHash("sha256").update(s).digest("hex");

const BOTS = [
  { id: "bot_1", name: "Alice" },
  { id: "bot_2", name: "Bob" },
];

const tempHome = () => mkdtempSync(join(tmpdir(), "ompbot-channels-"));

/** 真实 Ledger + 最小团队门面（Run 走 Ledger，不调模型）。 */
function makeTeam({ ledger, bots = BOTS }) {
  const calls = [];
  let nextRun = 0;
  const team = {
    ledger,
    calls,
    listBots: () => bots,
    getBot: (id) => bots.find((b) => b.id === id) ?? null,
    resolveBot: (ref) => bots.find((b) => b.id === ref) ?? bots.find((b) => b.name === ref) ?? null,
    getRun: (id) => ledger.getRun(id),
    listRuns: () => [],
    startRun: (input) => {
      const id = `run_fixture_${++nextRun}`;
      ledger.createRun({
        id,
        kind: input.kind ?? "chat",
        botId: input.botId,
        scope: "private",
        text: input.text,
        source: input.source ?? "user",
      });
      ledger.updateRun(id, { state: "running" });
      ledger.updateRun(id, { state: "completed", reply: `echo:${input.text}` });
      calls.push({ m: "startRun", input });
      return ledger.getRun(id);
    },
    waitRun: (id) => {
      calls.push({ m: "waitRun", id });
      return ledger.getRun(id);
    },
    cancelRun: (id, reason) => {
      ledger.updateRun(id, { state: "cancelled", error: reason });
      calls.push({ m: "cancelRun", id, reason });
      return { accepted: true, run: ledger.getRun(id) };
    },
    answerUi: (id, response) => {
      const approval = ledger.get("approvals", id);
      if (!approval) {
        const err = new Error(`审批 ${id} 不存在或已过期`);
        err.status = 409;
        throw err;
      }
      // 用 core 的真实验证器（不是「什么都收」的门面），形状不对这里就会抛。
      const payload = validateUiResponse(approval, response);
      ledger.put("approvals", { ...approval, status: payload.cancelled ? "cancelled" : "answered", response: payload });
      calls.push({ m: "answerUi", id, response: payload });
      return { id, status: "answered" };
    },
    seedRun: ({ id, botId, source, text = "seeded" }) => {
      ledger.createRun({ id, kind: "chat", botId, scope: "private", text, source });
      ledger.updateRun(id, { state: "running" });
      return ledger.getRun(id);
    },
    seedApproval: ({ id, runId, botId, method = "confirm", options = null, optionDetails = null }) =>
      ledger.put("approvals", {
        id,
        runId,
        botId,
        scope: "private",
        nativeId: `n_${id}`,
        method,
        options,
        optionDetails,
        status: "pending",
      }),
  };
  return team;
}

/** 本地假飞书端点：只实现 tenant_access_token 与 im/v1/messages。 */
async function fakeFeishu(opts = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {}
      calls.push({ url: req.url, body, auth: req.headers.authorization ?? null });
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(obj));
      };
      if (req.url.startsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
        if (opts.tokenStatus && opts.tokenStatus !== 200) return send(opts.tokenStatus, { code: 10003, msg: "bad" });
        if (opts.badCredentials) return send(200, { code: 10003, msg: "app_id or app_secret invalid" });
        return send(200, { code: 0, msg: "ok", tenant_access_token: "t-fake-token", expire: 7200 });
      }
      if (req.url.startsWith("/open-apis/im/v1/messages")) {
        if (opts.throwOnSend) return req.socket.destroy();
        if (opts.sendStatus >= 500) return send(opts.sendStatus, { code: 1000, msg: "server error" });
        if (opts.sendCode && opts.sendCode !== 0) return send(200, { code: opts.sendCode, msg: "send rejected" });
        return send(200, { code: 0, msg: "ok", data: { message_id: `om_${calls.length}` } });
      }
      send(404, { code: 404, msg: "unknown" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    calls,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    },
  };
}

const baseConfig = (fake, extra = {}) => ({
  enabled: true,
  verificationToken: "vt_test",
  encryptKey: "ek_test",
  host: "127.0.0.1",
  port: 0,
  identities: [{ openId: "ou_alice", chatId: "oc_room", botIds: ["bot_1"], permissions: ["read", "run", "approve"] }],
  apiBase: fake.apiBase,
  appId: "cli_test",
  appSecret: "secret_test",
  ...extra,
});

function wsSocketFactory({ mode = "ready" } = {}) {
  const out = { mode, socket: null };
  out.factory = (params) => {
    const socket = {
      params,
      state: "idle",
      closed: null,
      dispatch: null,
      start({ eventDispatcher }) {
        socket.dispatch = (payload) => eventDispatcher.invoke(payload, { needCheck: false });
        if (mode === "ready") {
          queueMicrotask(() => {
            socket.state = "connected";
            params.onReady?.();
          });
        }
        if (mode === "error") {
          queueMicrotask(() => params.onError?.(new Error("pullConnectConfig failed: code=10003, msg=app_id or app_secret invalid")));
        }
        return Promise.resolve();
      },
      getConnectionStatus: () => ({
        state: socket.state,
        reconnectAttempts: socket.state === "reconnecting" ? 3 : 0,
      }),
      close(params) {
        socket.closed = params ?? {};
        socket.state = "idle";
      },
    };
    out.socket = socket;
    return socket;
  };
  return out;
}

const wsConfig = (extra = {}) => ({
  enabled: true,
  transport: "websocket",
  appId: "cli_0123456789abcdef",
  appSecret: "secret_test",
  verificationToken: null,
  encryptKey: null,
  identities: [{ openId: "ou_alice", chatId: "oc_room", botIds: ["bot_1"], permissions: ["read", "run", "approve"] }],
  ...extra,
});

/** 起一套临时环境并保证回收。 */
async function scenario({ config = {}, fakeOpts = {} } = {}, fn) {
  const home = tempHome();
  const ledger = new Ledger({ home });
  const team = makeTeam({ ledger });
  const fake = await fakeFeishu(fakeOpts);
  const bridge = new FeishuBridge({ orch: team, config: { ...baseConfig(fake), ...config } });
  try {
    return await fn({ home, ledger, team, fake, bridge });
  } finally {
    try {
      await bridge.close();
    } catch {}
    await fake.close();
    ledger.close();
    rmSync(home, { recursive: true, force: true });
  }
}

// ---- 飞书体/签名工具 ----

function encryptBody(encryptKey, payload) {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return JSON.stringify({ encrypt: Buffer.concat([iv, data]).toString("base64") });
}

let eventSeq = 0;

function messageEvent({ openId = "ou_alice", chatId = "oc_room", text = "hello", chatType = "p2p", eventId } = {}) {
  eventSeq += 1;
  return {
    schema: "2.0",
    header: {
      event_id: eventId ?? `ev_${eventSeq}_${randomBytes(4).toString("hex")}`,
      event_type: "im.message.receive_v1",
      token: "vt_test",
      create_time: String(Date.now()),
    },
    event: {
      sender: { sender_id: { open_id: openId }, sender_type: "user" },
      message: {
        message_id: `om_in_${eventSeq}`,
        chat_id: chatId,
        chat_type: chatType,
        message_type: "text",
        content: JSON.stringify({ text }),
      },
    },
  };
}

/** 带签名投递到真实 receiver。 */
async function postEvent(bridge, payload, { encryptKey = "ek_test", timestamp = Date.now(), nonce = "n1", tamper = false } = {}) {
  const raw = encryptBody(encryptKey, payload);
  const ts = String(timestamp);
  let signature = sha256hex({ timestamp: ts, nonce, encryptKey, rawBody: raw });
  if (tamper) signature = (signature[0] === "0" ? "1" : "0") + signature.slice(1);
  const st = bridge.status();
  const res = await fetch(`http://127.0.0.1:${st.receiver.port}${st.receiver.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lark-request-timestamp": ts,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature,
    },
    body: raw,
  });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

const outbox = (bridge, key) => bridge.orch.ledger.get("outbox", `out_feishu_${key}`);

const messages = (fake) => fake.calls.filter((c) => c.url.startsWith("/open-apis/im/v1/messages")).map((c) => ({ ...JSON.parse(c.body.content), chatId: c.body.receive_id }));

// ================= 配对 =================

function pairingSetup() {
  const home = tempHome();
  const ledger = new Ledger({ home });
  const team = makeTeam({ ledger });
  let clock = Date.now();
  const pairing = new PairingService({ orch: team, now: () => clock });
  return {
    home,
    ledger,
    team,
    pairing,
    advance: (ms) => {
      clock += ms;
    },
    cleanup: () => {
      ledger.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("配对：签发码默认 5 分钟、默认权限只有 read/run、不留明文码", () => {
  const s = pairingSetup();
  try {
    const { ticket, code } = s.pairing.create({ botIds: ["bot_1"], label: "手机" });
    assert.match(code, /^ompcode_/);
    assert.deepStrictEqual(ticket.botIds, ["bot_1"]);
    assert.deepStrictEqual(ticket.permissions, ["read", "run"]);
    assert.strictEqual(ticket.expiresAt - ticket.createdAt, 5 * 60 * 1000);
    assert.strictEqual(ticket.usedAt, null);
    const raw = s.ledger.get("devices", ticket.id);
    assert.strictEqual(JSON.stringify(raw).includes(code), false, "台账里不能出现明文配对码");
    assert.strictEqual(s.pairing.list().tickets[0].codeHash, undefined);
  } finally {
    s.cleanup();
  }
});

test("配对：redeem 成功、token 只存散列、authenticate 认设备", () => {
  const s = pairingSetup();
  try {
    const { code } = s.pairing.create({ botIds: ["bot_1", "bot_2"], label: "平板" });
    const { token, device } = s.pairing.redeem({ code, client: "127.0.0.1" });
    assert.match(token, /^ompd_/);
    assert.deepStrictEqual(device.botIds, ["bot_1", "bot_2"]);
    assert.deepStrictEqual(device.permissions, ["read", "run"]);

    const raw = JSON.stringify(s.ledger.get("devices", device.id));
    assert.strictEqual(raw.includes(token), false, "台账里不能出现明文 token");
    const stored = s.ledger.get("devices", device.id);
    assert.match(stored.tokenHash, /^[0-9a-f]{64}$/);
    assert.match(stored.salt, /^[0-9a-f]{32}$/);

    const authed = s.pairing.authenticate(token);
    assert.strictEqual(authed.id, device.id);
    assert.deepStrictEqual(authed.permissions, ["read", "run"]);
    // 篡改一个字符、长度不对、随机串都不认
    assert.strictEqual(s.pairing.authenticate(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")), null);
    assert.strictEqual(s.pairing.authenticate("ompd"), null);
    assert.strictEqual(s.pairing.authenticate("ompd_" + randomBytes(32).toString("base64url")), null);
  } finally {
    s.cleanup();
  }
});

test("配对：一次性——同码第二次兑换 410，且不产生第二个设备", () => {
  const s = pairingSetup();
  try {
    const { code } = s.pairing.create({ botIds: ["bot_1"] });
    s.pairing.redeem({ code });
    assert.throws(
      () => s.pairing.redeem({ code, client: "other" }),
      (e) => e instanceof PairingError && e.code === "PAIRING_USED" && e.status === 410,
    );
    assert.strictEqual(s.pairing.list().devices.length, 1);
  } finally {
    s.cleanup();
  }
});

test("配对：过期码 410（假时钟推进）", () => {
  const s = pairingSetup();
  try {
    const { code } = s.pairing.create({ botIds: ["bot_1"], ttlMs: 1000 });
    s.advance(60_000);
    assert.throws(
      () => s.pairing.redeem({ code }),
      (e) => e.code === "PAIRING_EXPIRED" && e.status === 410,
    );
  } finally {
    s.cleanup();
  }
});

test("配对：兑换限流 429 且给出 retryAfterMs", () => {
  const s = pairingSetup();
  try {
    for (let i = 0; i < 10; i++) {
      assert.throws(() => s.pairing.redeem({ code: `bad_${i}_${"x".repeat(20)}`, client: "1.2.3.4" }), (e) => e.code === "PAIRING_INVALID_CODE");
    }
    assert.throws(
      () => s.pairing.redeem({ code: `bad_${"y".repeat(24)}`, client: "1.2.3.4" }),
      (e) => e.code === "PAIRING_RATE_LIMITED" && e.status === 429 && e.retryAfterMs > 0,
    );
    // 另一个来源不受影响（但全局窗口仍在额度内）
    assert.throws(() => s.pairing.redeem({ code: `zz_${"z".repeat(24)}`, client: "8.8.8.8" }), (e) => e.code === "PAIRING_INVALID_CODE");
  } finally {
    s.cleanup();
  }
});

test("配对：撤销码与设备后都无法再用", () => {
  const s = pairingSetup();
  try {
    const a = s.pairing.create({ botIds: ["bot_1"] });
    s.pairing.revoke(a.ticket.id);
    assert.throws(() => s.pairing.redeem({ code: a.code, client: "c1" }), (e) => e.code === "PAIRING_REVOKED");

    const b = s.pairing.create({ botIds: ["bot_1"] });
    const { token, device } = s.pairing.redeem({ code: b.code, client: "c2" });
    assert.strictEqual(s.pairing.authenticate(token).id, device.id);
    const revoked = s.pairing.revoke(device.id);
    assert.strictEqual(revoked.revokedAt > 0, true);
    assert.strictEqual(s.pairing.authenticate(token), null);
    assert.throws(() => s.pairing.authorize(revoked, { action: "run", botId: "bot_1" }), (e) => e.code === "DEVICE_REVOKED");
    assert.throws(() => s.pairing.revoke("dev_missing"), (e) => e.status === 404);
  } finally {
    s.cleanup();
  }
});

test("配对：作用域与权限强校验，设备永远不会变成 owner/admin", () => {
  const s = pairingSetup();
  try {
    const { code } = s.pairing.create({ botIds: ["bot_1"] });
    const { device } = s.pairing.redeem({ code, client: "c" });
    assert.strictEqual(s.pairing.authorize(device, { action: "run", botId: "bot_1" }), true);
    assert.throws(() => s.pairing.authorize(device, { action: "run", botId: "bot_2" }), (e) => e.code === "DEVICE_OUT_OF_SCOPE" && e.status === 403);
    assert.throws(() => s.pairing.authorize(device, { action: "approve", botId: "bot_1" }), (e) => e.code === "DEVICE_FORBIDDEN");
    assert.throws(() => s.pairing.authorize(device, { action: "nuke" }), (e) => e.code === "DEVICE_UNKNOWN_ACTION");
    assert.throws(() => s.pairing.authorize({ permissions: ["read"] }, { action: "read" }), (e) => e.code === "DEVICE_UNAUTHORIZED");
    assert.throws(() => s.pairing.authorizeAdmin(), (e) => e.code === "DEVICE_NO_ADMIN" && e.status === 403);
  } finally {
    s.cleanup();
  }
});

test("配对：拒绝越权权限档位与未知 bot，approve 必须显式单独给", () => {
  const s = pairingSetup();
  try {
    for (const bad of [["admin"], ["owner"], ["read", "*"], []]) {
      assert.throws(
        () => s.pairing.create({ botIds: ["bot_1"], permissions: bad }),
        (e) => e.code === "PAIRING_BAD_PERMISSIONS",
      );
    }
    assert.throws(() => s.pairing.create({ botIds: ["bot_9"] }), (e) => e.code === "PAIRING_UNKNOWN_BOT");
    assert.throws(() => s.pairing.create({ botIds: [] }), (e) => e.code === "PAIRING_NO_TARGET");

    const { code } = s.pairing.create({ botIds: ["bot_1"], permissions: ["read", "run", "approve"] });
    const { device } = s.pairing.redeem({ code, client: "c" });
    assert.strictEqual(s.pairing.authorize(device, { action: "approve", botId: "bot_1" }), true);

    // 台账列表永不回显散列/盐
    const dump = JSON.stringify(s.pairing.list());
    assert.strictEqual(dump.includes("tokenHash") || dump.includes("codeHash") || dump.includes("salt"), false);
  } finally {
    s.cleanup();
  }
});

test("配对：台账缺席时不静默成功", () => {
  const pairing = new PairingService({ orch: { listBots: () => BOTS } });
  assert.throws(() => pairing.create({ botIds: ["bot_1"] }), /orch\.ledger/);
});

test("配对：run/cancel/steer/approve 必须显式带 botId，忘传就是失败而非静默放行", () => {
  const s = pairingSetup();
  try {
    const { code } = s.pairing.create({ botIds: ["bot_1"], permissions: ["read", "run", "approve"] });
    const { device } = s.pairing.redeem({ code, client: "c" });
    for (const action of ["run", "cancel", "steer", "approve"]) {
      assert.throws(
        () => s.pairing.authorize(device, { action }),
        (e) => e.code === "DEVICE_BOT_REQUIRED" && e.status === 400,
      );
      assert.strictEqual(s.pairing.authorize(device, { action, botId: "bot_1" }), true);
    }
    assert.strictEqual(s.pairing.authorize(device, { action: "read" }), true);
    assert.strictEqual(s.pairing.authorize(device, { action: "status" }), true);
    assert.throws(
      () => s.pairing.authorize(device, { action: "read", botId: "bot_2" }),
      (e) => e.code === "DEVICE_OUT_OF_SCOPE",
    );
  } finally {
    s.cleanup();
  }
});

test("配对：容量回收只清终态票，超限报错而不是静默作废有效码", () => {
  const s = pairingSetup();
  try {
    s.pairing.maxTickets = 3;
    const a = s.pairing.create({ botIds: ["bot_1"], ttlMs: 1000 });
    s.pairing.create({ botIds: ["bot_1"], ttlMs: 1000 });
    const c = s.pairing.create({ botIds: ["bot_1"], ttlMs: 60_000 });
    // 3 张都还活着 → 第 4 张明确报错（不删最旧的有效码）
    assert.throws(
      () => s.pairing.create({ botIds: ["bot_1"] }),
      (e) => e.code === "PAIRING_CAPACITY" && e.status === 409,
    );
    assert.strictEqual(s.ledger.get("devices", a.ticket.id).id, a.ticket.id, "超限时不能静默删掉有效票");

    // 未过期未使用的码仍可兑换
    const { token, device } = s.pairing.redeem({ code: c.code, client: "x" });
    assert.deepStrictEqual(device.botIds, ["bot_1"]);

    // 推进到前两枚过期；再签发时回收终态票腾出容量
    s.advance(5_000);
    const d = s.pairing.create({ botIds: ["bot_1"], ttlMs: 60_000 });
    assert.match(d.code, /^ompcode_/);
    assert.strictEqual(s.ledger.get("devices", a.ticket.id), null, "已过期票应被回收");
    const liveTickets = s.pairing.list().tickets.filter((t) => !t.usedAt && !t.revokedAt);
    assert.strictEqual(liveTickets.length, 1, "只剩新签发的那张有效票");
    // 回收票据不影响已发出的设备凭证
    assert.strictEqual(s.pairing.authenticate(token).id, device.id);
    assert.strictEqual(s.pairing.redeem({ code: d.code, client: "y" }).device.botIds[0], "bot_1");
  } finally {
    s.cleanup();
  }
});

// ================= 飞书适配器 =================

test("飞书：默认禁用，不 bind；启用但缺配置返回可执行错误", async () => {
  const disabled = new FeishuBridge({ orch: { ledger: {}, listBots: () => BOTS } });
  const st = await disabled.start();
  assert.strictEqual(st.enabled, false);
  assert.strictEqual(st.receiver.running, false);
  assert.strictEqual(st.receiver.url, null);
  assert.strictEqual(st.missing.length, 0, "禁用时不报缺失，但也不启动");

  const bad = new FeishuBridge({ orch: { ledger: {}, listBots: () => BOTS }, config: { enabled: true } });
  await assert.rejects(() => bad.start(), (e) => e instanceof ChannelsError && e.code === "FEISHU_NOT_CONFIGURED" && e.status === 503 && /verificationToken/.test(e.message) && /identities/.test(e.message));
  assert.strictEqual(bad.status().receiver.running, false);
});

test("飞书：非回环绑定必须显式允许，且不自动建隧道", () => {
  assert.throws(
    () => new FeishuBridge({ orch: { ledger: {}, listBots: () => [] }, config: { enabled: true, host: "0.0.0.0" } }),
    (e) => e.code === "FEISHU_REMOTE_BIND_REFUSED",
  );
  const ok = new FeishuBridge({
    orch: { ledger: {}, listBots: () => [] },
    config: { enabled: true, host: "0.0.0.0", allowNonLoopback: true, verificationToken: "vt", identities: [{ openId: "o", chatId: "c", botIds: ["bot_1"] }] },
  });
  assert.strictEqual(ok.status().receiver.loopbackOnly, false);
  assert.match(ok.status().receiver.remoteHint, /HTTPS 反向代理/);
});

test("飞书：加密体 AES-256-CBC 往返，错 key 明确报错", () => {
  const payload = { type: "url_verification", token: "vt", challenge: "c1" };
  const raw = encryptBody("ek_test", payload);
  assert.deepStrictEqual(decryptCallback(JSON.parse(raw), "ek_test"), payload);
  assert.throws(() => decryptCallback(JSON.parse(raw), "ek_wrong"), (e) => e.code === "FEISHU_DECRYPT_FAILED");
  assert.deepStrictEqual(decryptCallback(payload, null), payload);
  assert.strictEqual(sha256hex({ timestamp: "1", nonce: "n", encryptKey: "k", rawBody: "b" }), sha("1" + "n" + "k" + "b"));
  assert.strictEqual(identityKeyOf(messageEvent({ openId: "ou_a", chatId: "oc_b" })), "ou_a:oc_b");
});

test("飞书：指令映射的权限矩阵（纯函数）", () => {
  const identity = { key: "ou_alice:oc_room", botIds: ["bot_1"], permissions: ["read", "run", "approve"] };
  const readonly = { key: "ou_bob:oc_room", botIds: ["bot_1"], permissions: ["read"] };
  assert.deepStrictEqual(planCommand({ text: "/run Alice 做饭", identity, bots: BOTS }), {
    kind: "run",
    botId: "bot_1",
    botName: "Alice",
    text: "做饭",
  });
  assert.strictEqual(planCommand({ text: "/run Bob hi", identity, bots: BOTS }).forbidden, true, "越界 bot 直接禁止");
  assert.strictEqual(planCommand({ text: "/approve ap_1 allow", identity }).kind, "approve");
  assert.strictEqual(planCommand({ text: "/approve ap_1 allow", identity: readonly }).forbidden, true);
  assert.strictEqual(planCommand({ text: "/cancel run_1", identity: readonly }).forbidden, true);
  assert.strictEqual(planCommand({ text: "随便说点什么", identity, bots: BOTS }).kind, "run", "p2p 文本落到默认 bot");
  assert.strictEqual(planCommand({ text: "群聊闲聊", chatType: "group", identity, bots: BOTS }).kind, "ignore");
  assert.strictEqual(planCommand({ text: "/nope", identity, bots: BOTS }).kind, "error");
});

test("飞书：签名/重放/内部 token/未知身份都在入站层被拒", async () => {
  await scenario({}, async ({ bridge }) => {
    await bridge.start();
    const ev = messageEvent({ text: "hi" });

    assert.strictEqual((await postEvent(bridge, ev, { tamper: true })).status, 401);
    const stale = await postEvent(bridge, messageEvent({ text: "hi" }), { timestamp: Date.now() - 10 * 60 * 1000 });
    assert.strictEqual(stale.status, 400);
    assert.strictEqual(stale.body.code, "FEISHU_STALE_REPLAY");

    const badToken = messageEvent({ text: "hi" });
    badToken.header.token = "vt_wrong";
    assert.strictEqual((await postEvent(bridge, badToken)).status, 401);

    const unknown = await postEvent(bridge, messageEvent({ openId: "ou_stranger", text: "hi" }));
    assert.strictEqual(unknown.status, 403);
    assert.strictEqual(unknown.body.code, "FEISHU_IDENTITY_UNKNOWN");

    const challenge = await postEvent(bridge, { type: "url_verification", token: "vt_test", challenge: "chal-1" });
    assert.strictEqual(challenge.status, 200);
    assert.deepStrictEqual(challenge.body, { challenge: "chal-1" });

    await bridge.drain();
    assert.strictEqual(bridge.orch.ledger.listRuns().length, 0, "被拒的回调不能建 Run");
    assert.strictEqual(bridge.orch.ledger.list("outbox").length, 0, "被拒的回调不能回执");
  });
});

test("飞书：p2p 文本 → startRun → 官方接口回执，event_id 重投只处理一次", async () => {
  await scenario({}, async ({ bridge, fake, team }) => {
    await bridge.start();
    const ev = messageEvent({ text: "帮我看下日志", eventId: "ev_once" });
    const first = await postEvent(bridge, ev);
    assert.strictEqual(first.status, 200);
    await bridge.drain();

    const runs = bridge.orch.ledger.listRuns();
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].botId, "bot_1");
    assert.strictEqual(runs[0].source, "feishu:ou_alice:oc_room");

    const rec = outbox(bridge, `run_${runs[0].id}`);
    assert.strictEqual(rec.status, "sent");
    assert.strictEqual(rec.chatId, "oc_room");
    assert.match(fake.calls.find((c) => c.url.startsWith("/open-apis/auth")).body.app_id, /^cli_test$/);

    // 入站事件在回执前已落库，处理完成后带 runId 终态（重启诊断靠它，不靠内存）
    const inboundRows = bridge.orch.ledger.list("settings").filter((r) => r.type === "feishu_inbound");
    assert.strictEqual(inboundRows.length, 1);
    assert.strictEqual(inboundRows[0].status, "completed");
    assert.strictEqual(inboundRows[0].runId, runs[0].id);
    assert.strictEqual(inboundRows[0].identity, "ou_alice:oc_room");
    assert.strictEqual(inboundRows[0].action, "run");
    assert.strictEqual(bridge.status().inbound.events.completed, 1);

    const sendCall = fake.calls.filter((c) => c.url.startsWith("/open-apis/im/v1/messages")).at(-1);
    assert.strictEqual(sendCall.body.receive_id, "oc_room");
    assert.strictEqual(messages(fake)[0].text, `已开始 Run ${runs[0].id}（Alice）。取消：/cancel ${runs[0].id}`);
    assert.strictEqual(sendCall.auth, "Bearer t-fake-token");

    // 准入拒绝路径的证据：同 run 的 outbox 里不出现长期凭据
    assert.strictEqual(JSON.stringify(rec).includes("secret_test"), false);
    assert.strictEqual(JSON.stringify(rec).includes("t-fake-token"), false);

    // 重投同一 event_id：去重，不重复跑、不重复发
    const before = fake.calls.length;
    const dup = await postEvent(bridge, ev);
    assert.strictEqual(dup.status, 200);
    assert.match(dup.body.msg, /duplicate/);
    await bridge.drain();
    assert.strictEqual(bridge.orch.ledger.listRuns().length, 1);
    assert.strictEqual(fake.calls.length, before);
    assert.strictEqual(team.calls.filter((c) => c.m === "startRun").length, 1);
  });
});


test("飞书：群聊指令 /run /cancel /approve，审批只认发起身份", async () => {
  await scenario(
    {
      config: {
        identities: [
          { openId: "ou_alice", chatId: "oc_room", botIds: ["bot_1"], permissions: ["read", "run", "approve"] },
          { openId: "ou_carol", chatId: "oc_room", botIds: ["bot_1", "bot_2"], permissions: ["read", "run"] },
        ],
      },
    },
    async ({ bridge, fake }) => {
      await bridge.start();

      // /run 正常
      await postEvent(bridge, messageEvent({ text: "/run Alice 写周报", chatType: "group", eventId: "ev_run" }));
      await bridge.drain();
      assert.strictEqual(bridge.orch.ledger.listRuns().length, 1);

      // /run 越界 bot：拒绝且不建 Run
      const denyEv = messageEvent({ text: "/run Bob 越界", chatType: "group", eventId: "ev_run2" });
      await postEvent(bridge, denyEv);
      await bridge.drain();
      assert.strictEqual(bridge.orch.ledger.listRuns().length, 1);
      assert.match(messages(fake).at(-1).text, /未被授权操作 bot Bob/);

      // /cancel：先种一条运行中的 Run
      bridge.orch.seedRun({ id: "run_seed", botId: "bot_1", source: "feishu:ou_alice:oc_room" });
      await postEvent(bridge, messageEvent({ text: "/cancel run_seed", chatType: "group", eventId: "ev_cancel" }));
      await bridge.drain();
      assert.strictEqual(bridge.orch.ledger.getRun("run_seed").state, "cancelled");
      assert.match(outbox(bridge, "cancel_run_seed").text, /已请求取消/);

      // 审批：carol 没有 approve 权限 → 不能回答（即使同 bot 作用域）
      bridge.orch.seedApproval({ id: "ap_1", runId: "run_seed", botId: "bot_1", method: "confirm" });
      const apEv = messageEvent({ openId: "ou_carol", text: "/approve ap_1 allow", chatType: "group", eventId: "ev_ap1" });
      await postEvent(bridge, apEv);
      await bridge.drain();
      assert.match(messages(fake).at(-1).text, /审批权限/);

      // 审批：alice 有权限，但 Run 由别人发起 → 不得代答（key 带时间戳，直接扫 outbox）
      bridge.orch.seedRun({ id: "run_other", botId: "bot_1", source: "feishu:ou_carol:oc_room" });
      bridge.orch.seedApproval({
        id: "ap_2",
        runId: "run_other",
        botId: "bot_1",
        method: "select",
        options: ["Approve", "Deny"],
        optionDetails: [{ label: "Approve" }, { label: "Deny" }],
      });
      await postEvent(bridge, messageEvent({ text: "/approve ap_2 allow", chatType: "group", eventId: "ev_ap2" }));
      await bridge.drain();
      const texts = bridge.orch.ledger.list("outbox").map((r) => r.text ?? "");
      assert.strictEqual(texts.some((t) => /不能代为回答/.test(t)), true);
      assert.strictEqual(bridge.orch.calls.some((c) => c.m === "answerUi" && c.id === "ap_2"), false);

      // alice 自己发起的 Run + 合法审批 id（confirm 类）→ 回答成功，wire 形状是原生要求的 {confirmed:false}
      bridge.orch.seedRun({ id: "run_own", botId: "bot_1", source: "feishu:ou_alice:oc_room" });
      bridge.orch.seedApproval({ id: "ap_3", runId: "run_own", botId: "bot_1", method: "confirm" });
      await postEvent(bridge, messageEvent({ text: "/approve ap_3 deny", chatType: "group", eventId: "ev_ap3" }));
      await bridge.drain();
      const answered = bridge.orch.calls.find((c) => c.m === "answerUi");
      assert.deepStrictEqual(answered, { m: "answerUi", id: "ap_3", response: { confirmed: false } });
      assert.match(outbox(bridge, "approve_ap_3").text, /已拒绝审批/);
      assert.match(outbox(bridge, "approve_ap_3").text, /confirmed=false/);

      // 群聊闲聊不建 Run
      const before = bridge.orch.ledger.listRuns().length;
      await postEvent(bridge, messageEvent({ text: "今天天气不错", chatType: "group", eventId: "ev_chat" }));
      await bridge.drain();
      assert.strictEqual(bridge.orch.ledger.listRuns().length, before);
      assert.strictEqual(fake.calls.filter((c) => c.url.startsWith("/open-apis/im")).length > 0, true);
    },
  );
});

test("飞书：select/confirm 按原生 method 映射，多义或非授权一律要求网页端", async () => {
  // 纯函数层：产出的形状必须能被 core 的真实验证器接受
  const confirmRec = { method: "confirm" };
  assert.deepStrictEqual(approvalResponse(confirmRec, true), { confirmed: true });
  assert.deepStrictEqual(validateUiResponse(confirmRec, approvalResponse(confirmRec, false)), { confirmed: false });

  const selectRec = {
    method: "select",
    options: ["Approve", "Deny"],
    optionDetails: [{ label: "Approve" }, { label: "Deny" }],
  };
  const allow = approvalResponse(selectRec, true);
  assert.deepStrictEqual(allow, { value: "Approve" });
  assert.deepStrictEqual(validateUiResponse(selectRec, allow), { value: "Approve" });
  assert.deepStrictEqual(approvalResponse(selectRec, false), { value: "Deny" });
  assert.deepStrictEqual(
    approvalResponse({ method: "select", options: ["批准", "拒绝"] }, true),
    { value: "批准" },
    "中文选项按原串提交",
  );
  // 本仓库 core 的默认审批档就是 select+approve/deny 形状，这里断言的是它的真实 options 契约
  const coreLike = { method: "select", options: ["approve", "deny"], optionDetails: null };
  assert.deepStrictEqual(validateUiResponse(coreLike, approvalResponse(coreLike, true)), { value: "approve" });

  // 多义：两个批准类选项 → 批准必须拒（拒绝仍唯一，可选）
  const ambiguous = {
    method: "select",
    options: ["Approve once", "Approve always", "Deny"],
    optionDetails: [{ label: "Approve once" }, { label: "Approve always" }, { label: "Deny" }],
  };
  assert.throws(
    () => approvalResponse(ambiguous, true),
    (e) => e instanceof ChannelsError && e.code === "FEISHU_MANUAL_UI_REQUIRED" && e.status === 409 && /网页端/.test(e.message),
  );
  assert.deepStrictEqual(approvalResponse(ambiguous, false), { value: "Deny" });

  // 非授权方法（提问/输入）与未知方法：不猜，要求网页端
  assert.throws(() => approvalResponse({ method: "ask", questions: [{ question: "?" }] }, true), (e) => e.code === "FEISHU_MANUAL_UI_REQUIRED");
  assert.throws(() => approvalResponse({ method: null, options: ["Approve", "Deny"] }, true), (e) => e.code === "FEISHU_MANUAL_UI_REQUIRED");
  assert.throws(() => approvalResponse({ method: "select", options: [] }, true), (e) => e.code === "FEISHU_MANUAL_UI_REQUIRED");

  // 真实链路：/approve 走 receiver → 落库的前端形状就是原生要的
  await scenario({}, async ({ bridge }) => {
    await bridge.start();
    bridge.orch.seedRun({ id: "run_sel", botId: "bot_1", source: "feishu:ou_alice:oc_room" });
    bridge.orch.seedApproval({
      id: "ap_sel",
      runId: "run_sel",
      botId: "bot_1",
      method: "select",
      options: ["Approve", "Deny"],
      optionDetails: [{ label: "Approve" }, { label: "Deny" }],
    });
    await postEvent(bridge, messageEvent({ text: "/approve ap_sel allow", chatType: "group", eventId: "ev_sel" }));
    await bridge.drain();
    assert.deepStrictEqual(bridge.orch.calls.find((c) => c.m === "answerUi"), {
      m: "answerUi",
      id: "ap_sel",
      response: { value: "Approve" },
    });
    assert.match(outbox(bridge, "approve_ap_sel").text, /选项「Approve」/);

    bridge.orch.seedApproval({
      id: "ap_amb",
      runId: "run_sel",
      botId: "bot_1",
      method: "select",
      options: ["Approve once", "Approve always", "Deny"],
    });
    await postEvent(bridge, messageEvent({ text: "/approve ap_amb allow", chatType: "group", eventId: "ev_amb" }));
    await bridge.drain();
    assert.strictEqual(bridge.orch.calls.some((c) => c.m === "answerUi" && c.id === "ap_amb"), false);
    const manual = bridge.orch.ledger.list("outbox").map((r) => r.text ?? "").find((t) => /ap_amb/.test(t));
    assert.match(manual, /网页端回答/);
    assert.strictEqual(bridge.orch.ledger.get("approvals", "ap_amb").status, "pending", "被拒的回答不能改审批状态");
  });
});

test("飞书：入站落库失败不确认（只读账本 → 5xx，且不抛出、不 200）", async () => {
  const home = tempHome();
  const writable = new Ledger({ home });
  writable.close();
  const readonly = new Ledger({ home, readonly: true });
  const fake = await fakeFeishu();
  const bridge = new FeishuBridge({ orch: { ledger: readonly, listBots: () => BOTS }, config: baseConfig(fake) });
  try {
    await bridge.start();
    const first = await postEvent(bridge, messageEvent({ text: "hi", eventId: "ev_ro" }));
    assert.strictEqual(first.status, 503);
    assert.strictEqual(first.body.code, "FEISHU_DURABLE_WRITE_FAILED");
    assert.match(bridge.status().lastError.message, /未确认|重投/);
    // receiver 还活着：再投一次依旧明确 5xx（没被异常带走、也没假装已接收）
    const second = await postEvent(bridge, messageEvent({ text: "hi", eventId: "ev_ro2" }));
    assert.strictEqual(second.status, 503);
    assert.strictEqual(readonly.listRuns().length, 0);
  } finally {
    await bridge.close();
    await fake.close();
    readonly.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("飞书：重启后未完成的入站标 interrupted、状态可见、重投不重放", async () => {
  await scenario({}, async ({ bridge, ledger }) => {
    // 去重键是 message_id（官方文档：重投时 event_id 可能变），所以种子记录按 message_id 命名。
    const ev = messageEvent({ text: "hi", eventId: "ev_interrupted" });
    const id = `feishu_inbound_${sha(ev.event.message.message_id).slice(0, 32)}`;
    ledger.put("settings", {
      id,
      type: "feishu_inbound",
      eventId: "ev_interrupted",
      messageId: ev.event.message.message_id,
      chatId: "oc_room",
      identity: "ou_alice:oc_room",
      status: "accepted",
      action: null,
      runId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const st = await bridge.start();
    assert.strictEqual(st.inbound.interruptedOnStartup, 1);
    assert.strictEqual(st.inbound.events.interrupted, 1);
    const rec = ledger.get("settings", id);
    assert.strictEqual(rec.status, "interrupted");
    assert.match(rec.error, /不自动重放/);
    assert.match(st.inbound.delivery, /at-most-once/);

    // 同一条消息重投（换个 event_id 也一样）只会被去重，不会重放
    const again = await postEvent(bridge, { ...ev, header: { ...ev.header, event_id: "ev_interrupted_again" } });
    assert.strictEqual(again.status, 200);
    assert.match(again.body.msg, /duplicate/);
    await bridge.drain();
    assert.strictEqual(ledger.listRuns().length, 0, "interrupted 事件绝不重放");
    assert.strictEqual(bridge.status().inbound.events.accepted, 0);
  });
});

test("飞书：缺凭据 / 平台错误 / 网络中断三种出站结果都不假装成功", async () => {
  // 1) 没有 appId/appSecret：可执行错误
  await scenario({ config: { appId: "", appSecret: null, appSecretEnv: null, enabled: true, verificationToken: "vt_test" } }, async ({ bridge }) => {
    await bridge.start();
    assert.deepStrictEqual(bridge.status().outboundMissing, ["appId", "appSecret（或 appSecretEnv）"]);
    await postEvent(bridge, messageEvent({ text: "hi", eventId: "ev_nocred" }));
    await bridge.drain();
    const rec = bridge.orch.ledger.list("outbox").find((r) => r.type === "feishu_outbound");
    assert.strictEqual(rec.status, "failed");
    assert.match(rec.error, /FEISHU_CREDENTIALS_MISSING/);
    assert.match(rec.error, /appSecretEnv/);
  });

  // 2) 平台返回业务错误 → failed，不重试
  await scenario({ fakeOpts: { sendCode: 230002 } }, async ({ bridge, fake }) => {
    await bridge.start();
    await postEvent(bridge, messageEvent({ text: "hi", eventId: "ev_sendfail" }));
    await bridge.drain();
    const rec = bridge.orch.ledger.list("outbox").find((r) => r.type === "feishu_outbound");
    assert.strictEqual(rec.status, "failed");
    assert.match(rec.error, /code=230002/);
    const before = fake.calls.filter((c) => c.url.startsWith("/open-apis/im")).length;
    assert.strictEqual(before, 2);
  });

  // 3) 网络中断（无响应）→ unknown，不自动重试
  await scenario({ fakeOpts: { throwOnSend: true } }, async ({ bridge, fake }) => {
    await bridge.start();
    await postEvent(bridge, messageEvent({ text: "hi", eventId: "ev_ambiguous" }));
    await bridge.drain();
    const rec = bridge.orch.ledger.list("outbox").find((r) => r.type === "feishu_outbound");
    assert.strictEqual(rec.status, "unknown");
    assert.match(rec.error, /副作用未知/);
    assert.strictEqual(fake.calls.filter((c) => c.url.startsWith("/open-apis/im")).length, 2);
  });

  // 4) 鉴权失败 → failed，错误里不带 app_secret
  await scenario({ fakeOpts: { badCredentials: true } }, async ({ bridge }) => {
    await bridge.start();
    await postEvent(bridge, messageEvent({ text: "hi", eventId: "ev_authfail" }));
    await bridge.drain();
    const rec = bridge.orch.ledger.list("outbox").find((r) => r.type === "feishu_outbound");
    assert.strictEqual(rec.status, "failed");
    assert.match(rec.error, /FEISHU_AUTH_FAILED/);
    assert.strictEqual(rec.error.includes("secret_test"), false);
  });
});

test("飞书：receiver 生命周期真的关闭端口，test() 自检可跑本地 fixture", async () => {
  await scenario({}, async ({ bridge, fake }) => {
    const st = await bridge.start();
    assert.strictEqual(st.receiver.running, true);
    const port = st.receiver.port;
    assert.strictEqual(port > 0, true);

    const live = await bridge.test({ live: true });
    assert.strictEqual(live.checks.find((c) => c.name === "outbound-token").ok, true);
    assert.strictEqual(live.ok, true);

    await bridge.setEnabled(false);
    assert.strictEqual(bridge.status().receiver.running, false);
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}${st.receiver.path}`, { method: "POST", body: "{}" }));

    // 禁用后即使配置齐全也不接事件
    const denied = await bridge.start();
    assert.strictEqual(denied.receiver.running, false);
    assert.ok(fake.calls.length >= 1);
  });
});

test("飞书：配置只落私有文件或环境变量，状态不回显密钥", async () => {
  const home = tempHome();
  try {
    const file = writeChannelConfig(home, { enabled: true, appSecret: "s3cr3t", appSecretEnv: "FEISHU_APP_SECRET" });
    assert.strictEqual(readChannelConfig(home).appSecret, "s3cr3t");
    assert.match(file, /channels\.feishu\.json$/);

    process.env.FEISHU_TEST_SECRET = "from-env";
    const fromEnv = new FeishuBridge({
      orch: { ledger: {}, listBots: () => BOTS },
      config: { enabled: true, appId: "cli", appSecretEnv: "FEISHU_TEST_SECRET", verificationToken: "vt", identities: [{ openId: "o", chatId: "c", botIds: ["bot_1"] }] },
    });
    const st = fromEnv.status();
    assert.deepStrictEqual(st.outboundMissing, []);
    assert.strictEqual(st.outbound.secretSource, "env:FEISHU_TEST_SECRET");
    assert.strictEqual(JSON.stringify(st).includes("from-env"), false);
    assert.strictEqual(JSON.stringify(st).includes("s3cr3t"), false);
    assert.deepStrictEqual(st.configuration.identities, [{ openId: "o", chatId: "c", botIds: ["bot_1"], permissions: ["read", "run"], label: "" }]);
    assert.strictEqual(st.configuration.appSecretEnv, "FEISHU_TEST_SECRET");
    assert.strictEqual(Object.hasOwn(st.configuration, "appSecret"), false);
    assert.strictEqual(Object.hasOwn(st.configuration, "verificationToken"), false);
    assert.strictEqual(Object.hasOwn(st.configuration, "encryptKey"), false);
    delete process.env.FEISHU_TEST_SECRET;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


test("飞书：长连接收 SDK 摊平后的事件，未授权身份不建 Run、不排队、不回执", async () => {
  const ws = wsSocketFactory();
  await scenario({ config: wsConfig({ wsClientFactory: ws.factory }) }, async ({ bridge, ledger, fake }) => {
    const st = await bridge.start();
    assert.strictEqual(st.receiver.transport, "websocket");
    assert.strictEqual(st.receiver.running, true, "连上之后才报运行中");
    assert.strictEqual(st.receiver.state, "connected");
    assert.deepStrictEqual(st.missing, [], "长连接不需要 verificationToken/identities 之外的配置");
    assert.strictEqual(st.inbound.signatureMode, "sdk-long-connection");
    assert.strictEqual(st.inbound.signatureWarning, null);
    assert.strictEqual(st.inbound.verificationTokenConfigured, false, "没配 token 也照样能收事件");

    const stranger = await ws.socket.dispatch(messageEvent({ openId: "ou_stranger", text: "hi" }));
    assert.strictEqual(stranger, undefined);
    assert.strictEqual(ledger.listRuns().length, 0);
    assert.strictEqual(ledger.list("settings").filter((r) => r.type === "feishu_inbound").length, 0);
    assert.strictEqual(ledger.list("outbox").length, 0);
    assert.strictEqual(bridge.status().lastError.code, "FEISHU_IDENTITY_UNKNOWN");
    assert.strictEqual(fake.calls.filter((c) => c.url.startsWith("/open-apis/im")).length, 0);

    const ev = messageEvent({ text: "看下日志", eventId: "ev_ws_1" });
    assert.strictEqual(await ws.socket.dispatch(ev), undefined);
    await bridge.drain();
    const runs = ledger.listRuns();
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].source, "feishu:ou_alice:oc_room");
    const inbound = ledger.list("settings").find((r) => r.type === "feishu_inbound");
    assert.strictEqual(inbound.status, "completed");
    assert.strictEqual(outbox(bridge, `run_${runs[0].id}`).status, "sent");
    assert.strictEqual(fake.calls.filter((c) => c.url.startsWith("/open-apis/im")).length, 2);
  });
});

test("飞书：连上之前不算运行，断开时如实显示重连，close 释放长连接", async () => {
  const ws = wsSocketFactory();
  await scenario({ config: wsConfig({ wsClientFactory: ws.factory }) }, async ({ bridge }) => {
    assert.strictEqual(bridge.status().receiver.running, false, "启动前不假装在跑");
    assert.strictEqual(bridge.status().receiver.state, "idle");

    await bridge.start();
    assert.strictEqual(bridge.status().receiver.running, true);

    ws.socket.state = "reconnecting";
    const down = bridge.status();
    assert.strictEqual(down.receiver.running, false);
    assert.strictEqual(down.receiver.state, "reconnecting");
    assert.strictEqual(down.receiver.reconnectAttempts, 3);

    await bridge.close();
    assert.deepStrictEqual(ws.socket.closed, { force: true }, "关闭必须真正终止 socket（非强制 close 会拖着等对端）");
    const after = bridge.status();
    assert.strictEqual(after.receiver.state, "idle");
    assert.strictEqual(after.receiver.running, false);
  });
});

test("飞书：长连接鉴权失败与首连超时都如实报错并释放，不留下后台重连", async () => {
  const failed = wsSocketFactory({ mode: "error" });
  await scenario({ config: wsConfig({ wsClientFactory: failed.factory }) }, async ({ bridge }) => {
    await assert.rejects(
      () => bridge.start(),
      (e) => e instanceof ChannelsError && e.code === "FEISHU_SOCKET_FAILED" && e.status === 503,
    );
    const st = bridge.status();
    assert.strictEqual(st.receiver.running, false);
    assert.strictEqual(st.receiver.state, "idle");
    assert.deepStrictEqual(failed.socket.closed, { force: true });
    assert.match(st.lastError.message, /长连接失败/);
    assert.strictEqual(st.lastError.message.includes("secret_test"), false, "错误里不能带 app_secret");
  });

  const hang = wsSocketFactory({ mode: "hang" });
  await scenario({ config: wsConfig({ wsClientFactory: hang.factory, connectTimeoutMs: 40 }) }, async ({ bridge }) => {
    await assert.rejects(
      () => bridge.start(),
      (e) => e.code === "FEISHU_SOCKET_TIMEOUT" && e.status === 503,
    );
    assert.strictEqual(bridge.status().receiver.running, false);
    assert.deepStrictEqual(hang.socket.closed, { force: true });
  });
});

test("飞书：appId 形状不对时立刻报错（SDK 对不匹配的 appId 只会静默不连）", async () => {
  const ws = wsSocketFactory();
  await scenario({ config: wsConfig({ appId: "cli_short", wsClientFactory: ws.factory }) }, async ({ bridge }) => {
    await assert.rejects(() => bridge.start(), (e) => e.code === "FEISHU_BAD_CONFIG" && e.status === 400);
    assert.strictEqual(ws.socket, null, "连客户端都不该建出来");
  });
});

test("飞书：长连接落库失败不确认（handler 抛错让 SDK 回 500，飞书才会重投）", async () => {
  const home = tempHome();
  const writable = new Ledger({ home });
  writable.close();
  const readonly = new Ledger({ home, readonly: true });
  const ws = wsSocketFactory();
  const bridge = new FeishuBridge({
    orch: { ledger: readonly, listBots: () => BOTS },
    config: wsConfig({ wsClientFactory: ws.factory }),
  });
  try {
    await bridge.start();
    await assert.rejects(
      () => ws.socket.dispatch(messageEvent({ text: "hi", eventId: "ev_ws_ro" })),
      (e) => e.code === "FEISHU_DURABLE_WRITE_FAILED" && e.status === 503,
    );
    assert.match(bridge.status().lastError.message, /未确认/);
    assert.strictEqual(readonly.listRuns().length, 0);
  } finally {
    await bridge.close();
    readonly.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("飞书：去重看 message_id——重投换 event_id 只跑一次，event_id 相同但消息不同各自跑", async () => {
  const ws = wsSocketFactory();
  await scenario({ config: wsConfig({ wsClientFactory: ws.factory }) }, async ({ bridge, ledger, fake }) => {
    await bridge.start();
    const ev = messageEvent({ text: "重投测试", eventId: "ev_first" });
    await ws.socket.dispatch(ev);
    await ws.socket.dispatch({ ...ev, header: { ...ev.header, event_id: "ev_redelivered" } });
    await bridge.drain();
    assert.strictEqual(ledger.listRuns().length, 1);
    assert.strictEqual(ledger.list("settings").filter((r) => r.type === "feishu_inbound").length, 1);
    assert.strictEqual(fake.calls.filter((c) => c.url.startsWith("/open-apis/im")).length, 2);

    await ws.socket.dispatch(messageEvent({ text: "第一条", eventId: "ev_same" }));
    await ws.socket.dispatch(messageEvent({ text: "第二条", eventId: "ev_same" }));
    await bridge.drain();
    assert.strictEqual(ledger.listRuns().length, 3);
  });
});

test("飞书：审批通知仅发起身份可见，重复事件不重复通知，输入请求不泄露标题", async () => {
  await scenario({}, async ({ bridge, team, fake }) => {
    await bridge.start();
    team.seedRun({ id: "notify_own", botId: "bot_1", source: "feishu:ou_alice:oc_room" });
    const approval = team.seedApproval({ id: "notify_select", runId: "notify_own", botId: "bot_1", method: "select", options: ["Approve", "Deny"] });
    await bridge.notifyApproval(approval);
    await bridge.notifyApproval(approval);
    assert.deepStrictEqual(messages(fake), [{ chatId: "oc_room", text: "Run notify_own 等待审批：\n原生工具请求\n批准：/approve notify_select allow\n拒绝：/approve notify_select deny" }]);
    team.seedRun({ id: "notify_foreign", botId: "bot_1", source: "feishu:ou_other:oc_room" });
    await bridge.notifyApproval({ ...approval, id: "foreign", runId: "notify_foreign" });
    await bridge.notifyApproval({ ...approval, id: "late_orphan", runId: null });
    assert.strictEqual(messages(fake).length, 1);
    await bridge.notifyApproval({ ...approval, id: "input_secret", method: "input", title: "PRIVATE_INPUT_SECRET" });
    assert.deepStrictEqual(messages(fake).at(-1), { chatId: "oc_room", text: "Run notify_own 等待审批 input_secret。请在工作台回答。" });
  });
});

test("飞书：HTTP 关闭不会被未完成请求拖住", async () => {
  await scenario({}, async ({ bridge }) => {
    await bridge.start();
    const socket = connect({ host: "127.0.0.1", port: bridge.status().receiver.port });
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write("POST /api/channels/feishu/events HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{");
    const closed = bridge.close();
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("接收器未结束未完成请求")), 1000); })]);
    } finally {
      clearTimeout(timer);
      socket.destroy();
      await closed;
    }
    assert.strictEqual(bridge.status().receiver.running, false);
  });
});

test("飞书：旧 event_id 去重记录迁移后不重放，后续不同事件号也去重", async () => {
  const ws = wsSocketFactory();
  await scenario({ config: wsConfig({ wsClientFactory: ws.factory }) }, async ({ bridge, ledger, fake }) => {
    await bridge.start();
    const oldId = "feishu_inbound_b30c4c437b4753033225cc907017c803";
    ledger.put("settings", { id: oldId, type: "feishu_inbound", eventId: "legacy-event-6428", identity: "ou_alice:oc_room", chatId: "oc_room", status: "interrupted", runId: "old_run", createdAt: 1, updatedAt: 1 });
    const event = messageEvent({ text: "升级前已处理的任务", eventId: "legacy-event-6428" });
    await ws.socket.dispatch(event);
    await ws.socket.dispatch({ ...event, header: { ...event.header, event_id: "after-upgrade-redelivery" } });
    await bridge.drain();
    assert.deepStrictEqual(ledger.listRuns(), []);
    assert.deepStrictEqual(messages(fake), []);
    assert.strictEqual(ledger.get("settings", oldId), null);
    const migrated = ledger.list("settings").find((r) => r.type === "feishu_inbound");
    assert.strictEqual(migrated.messageId, event.event.message.message_id);
    assert.strictEqual(migrated.runId, "old_run");
    assert.strictEqual(migrated.status, "interrupted");
  });
});

test("飞书：签名时间戳按秒发送时仍验证重放窗口", async () => {
  await scenario({}, async ({ bridge, ledger }) => {
    await bridge.start();
    const fresh = await postEvent(bridge, messageEvent({ text: "秒时间戳" }), { timestamp: Math.floor(Date.now() / 1000) });
    assert.strictEqual(fresh.status, 200);
    const stale = await postEvent(bridge, messageEvent({ text: "过期秒时间戳" }), { timestamp: Math.floor(Date.now() / 1000) - 600 });
    assert.strictEqual(stale.status, 400);
    assert.strictEqual(stale.body.code, "FEISHU_STALE_REPLAY");
    await bridge.drain();
    assert.strictEqual(ledger.listRuns().length, 1);
  });
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${t.name}\n     ${e?.stack ?? e}`);
  }
}
console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);
