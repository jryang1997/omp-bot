// test/file-share.mjs — 08 内置 SFTP 服务的行为测试。真实 sshfs 挂载见 .scratch/team-rebuild/proof/files。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import ssh2 from "ssh2";
import { FileShare, HOST_KEY_ALIAS, WORKSPACE_USER, probePort } from "../src/file-share.mjs";

const { Client, utils } = ssh2;
let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}\n      ${e?.stack ?? e}`);
    }
  });
}
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

function connect(port, username, privateKey, extra = {}) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.once("ready", () => c.sftp((err, sftp) => (err ? reject(err) : resolve({ c, sftp }))));
    c.once("error", reject);
    c.connect({ host: "127.0.0.1", port, username, privateKey, readyTimeout: 5000, ...extra });
  });
}
const call = (sftp, op, ...args) => new Promise((resolve, reject) => sftp[op](...args, (err, v) => (err ? reject(err) : resolve(v))));
const rejects = async (p, what) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error(`${what} 应该被拒绝`);
};

function setup() {
  const home = tmp("omp-share-");
  const team = join(home, "team");
  const roots = { [WORKSPACE_USER]: join(team, "workspace"), bot_a: join(team, "bots", "bot_a", "work"), bot_b: join(team, "bots", "bot_b", "work") };
  const allowed = new Set(Object.keys(roots));
  const share = new FileShare({ home, roots: (u) => (allowed.has(u) ? roots[u] : null) });
  return { home, team, roots, allowed, share };
}

test("只监听 127.0.0.1，主机钥匙和端口重启后不变", async () => {
  const { home, share } = setup();
  const { port } = await share.start();
  assert.ok(port > 0);
  assert.equal(await probePort(port, "127.0.0.1"), true);
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (lan) assert.equal(await probePort(port, lan.address), false, `${lan.address} 不该连得上`);
  const kh = share.knownHosts;
  assert.match(kh, new RegExp(`^${HOST_KEY_ALIAS} ssh-ed25519 `));
  await share.close();
  const again = new FileShare({ home, roots: () => null });
  assert.equal(again.knownHosts, kh);
  assert.equal((await again.start()).port, port);
  await again.close();
  rmSync(home, { recursive: true, force: true });
});

test("对的钥匙能读写，根目录自动建好", async () => {
  const { home, roots, share } = setup();
  const { port } = await share.start();
  const { c, sftp } = await connect(port, WORKSPACE_USER, share.credentials(WORKSPACE_USER).privateKey);
  try {
    await call(sftp, "writeFile", "/hello.txt", "你好");
    assert.equal(readFileSync(join(roots.workspace, "hello.txt"), "utf8"), "你好");
    writeFileSync(join(roots.workspace, "host.txt"), "from host");
    assert.equal(String(await call(sftp, "readFile", "host.txt")), "from host");
    await call(sftp, "mkdir", "/sub");
    const names = (await call(sftp, "readdir", "/")).map((e) => e.filename).sort();
    assert.deepEqual(names, ["hello.txt", "host.txt", "sub"]);
    assert.equal(await call(sftp, "realpath", "."), "/");
    await call(sftp, "chmod", "/hello.txt", 0o755);
    assert.equal(statSync(join(roots.workspace, "hello.txt")).mode & 0o777, 0o755);
    // 客机设不了宿主文件的 setuid、setgid 和粘滞位
    await call(sftp, "chmod", "/hello.txt", 0o7755);
    assert.equal(statSync(join(roots.workspace, "hello.txt")).mode & 0o7777, 0o755);
    // sshfs 截断文件走 SETSTAT size
    await call(sftp, "setstat", "/host.txt", { size: 4 });
    assert.equal(readFileSync(join(roots.workspace, "host.txt"), "utf8"), "from");
  } finally {
    c.end();
    await share.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("钥匙不对、用户名不认识、密码登录都被拒", async () => {
  const { home, allowed, share } = setup();
  const { port } = await share.start();
  try {
    const botKey = share.credentials("bot_a").privateKey;
    share.credentials(WORKSPACE_USER);
    await rejects(connect(port, WORKSPACE_USER, botKey), "bot 的钥匙登 workspace");
    const stranger = utils.generateKeyPairSync("ed25519").private;
    await rejects(connect(port, "bot_a", stranger), "陌生钥匙");
    await rejects(connect(port, "nobody", stranger), "不认识的用户");
    await rejects(connect(port, "bot_a", undefined, { password: "x" }), "密码");
    // 钥匙还在但 bot 已不存在（roots 返回 null）
    allowed.delete("bot_a");
    await rejects(connect(port, "bot_a", botKey), "已删除的 bot");
  } finally {
    await share.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("每个 bot 只看得到自己的 ~/work", async () => {
  const { home, roots, share } = setup();
  const { port } = await share.start();
  const a = await connect(port, "bot_a", share.credentials("bot_a").privateKey);
  const b = await connect(port, "bot_b", share.credentials("bot_b").privateKey);
  try {
    await call(a.sftp, "writeFile", "/secret.txt", "A");
    await rejects(call(b.sftp, "stat", "/secret.txt"), "b 读 a 的文件");
    assert.ok(existsSync(join(roots.bot_a, "secret.txt")));
    assert.ok(!existsSync(join(roots.bot_b, "secret.txt")));
  } finally {
    a.c.end();
    b.c.end();
    await share.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("拒绝 .. 和指出根的符号链接", async () => {
  const { home, team, roots, share } = setup();
  const { port } = await share.start();
  mkdirSync(roots.bot_a, { recursive: true });
  mkdirSync(roots.bot_b, { recursive: true });
  writeFileSync(join(roots.bot_b, "b.txt"), "B");
  writeFileSync(join(team, "outside.txt"), "outside");
  symlinkSync("/etc", join(roots.bot_a, "etc"));
  symlinkSync(join(roots.bot_b, "b.txt"), join(roots.bot_a, "to-b"));
  symlinkSync("../../../outside.txt", join(roots.bot_a, "rel-out"));
  symlinkSync("/nonexistent-omp-share", join(roots.bot_a, "dangling"));
  // 前缀相同的兄弟目录（work 和 work2）也不能算在根里
  mkdirSync(`${roots.bot_a}2`, { recursive: true });
  writeFileSync(`${roots.bot_a}2/x.txt`, "x");
  symlinkSync(`${roots.bot_a}2/x.txt`, join(roots.bot_a, "sibling"));
  const { c, sftp } = await connect(port, "bot_a", share.credentials("bot_a").privateKey);
  try {
    for (const p of ["/../b", "../bot_b/work/b.txt", "/sub/../../x"]) {
      await rejects(call(sftp, "stat", p), `stat ${p}`);
    }
    await rejects(call(sftp, "readFile", "/etc/passwd"), "经 /etc 链接读 passwd");
    await rejects(call(sftp, "readdir", "/etc"), "列 /etc");
    await rejects(call(sftp, "readFile", "/to-b"), "经链接读别的 bot");
    await rejects(call(sftp, "readFile", "/rel-out"), "相对链接出根");
    await rejects(call(sftp, "readFile", "/sibling"), "前缀相同的兄弟目录");
    await rejects(call(sftp, "writeFile", "/dangling", "x"), "经悬空链接建文件");
    assert.ok(!existsSync("/nonexistent-omp-share"));
    await rejects(call(sftp, "symlink", "/etc/passwd", "/p"), "建绝对链接");
    await rejects(call(sftp, "symlink", "../../bot_b/work/b.txt", "/q"), "建出根的相对链接");
    await rejects(call(sftp, "readlink", "/etc"), "读出根链接的目标");
    await rejects(call(sftp, "rmdir", "/"), "删根");
    await rejects(call(sftp, "rename", "/etc", "/"), "改名到根");
    // 根内的相对链接可以建也可以用
    await call(sftp, "writeFile", "/real.txt", "ok");
    await call(sftp, "symlink", "real.txt", "/link.txt");
    assert.equal(String(await call(sftp, "readFile", "/link.txt")), "ok");
    assert.equal(await call(sftp, "readlink", "/link.txt"), "real.txt");
    // 链接本身可以删，删的是链接不是目标
    await call(sftp, "unlink", "/etc");
    assert.ok(existsSync("/etc/passwd"));
  } finally {
    c.end();
    await share.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("改名覆盖已有文件，编辑器的临时文件保存能用", async () => {
  const { home, roots, share } = setup();
  const { port } = await share.start();
  const { c, sftp } = await connect(port, WORKSPACE_USER, share.credentials(WORKSPACE_USER).privateKey);
  try {
    await call(sftp, "writeFile", "/notes.md", "旧");
    await call(sftp, "writeFile", "/.notes.md.swp", "新");
    await call(sftp, "rename", "/.notes.md.swp", "/notes.md");
    assert.equal(readFileSync(join(roots.workspace, "notes.md"), "utf8"), "新");
    assert.ok(!existsSync(join(roots.workspace, ".notes.md.swp")));
  } finally {
    c.end();
    await share.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("两个连接同时追加，一行都不丢", async () => {
  const { home, roots, share } = setup();
  const { port } = await share.start();
  const key = share.credentials(WORKSPACE_USER).privateKey;
  const x = await connect(port, WORKSPACE_USER, key);
  const y = await connect(port, WORKSPACE_USER, key);
  try {
    const appendLines = async ({ sftp }, tag) => {
      // 'a' = WRITE|APPEND|CREAT，sshfs 的 >> 也是这样开
      const h = await call(sftp, "open", "/log.txt", "a");
      for (let i = 0; i < 200; i++) {
        const line = Buffer.from(`${tag}-${i}\n`);
        await call(sftp, "write", h, line, 0, line.length, 0);
      }
      await call(sftp, "close", h);
    };
    await Promise.all([appendLines(x, "x"), appendLines(y, "y")]);
    const lines = readFileSync(join(roots.workspace, "log.txt"), "utf8").trim().split("\n");
    assert.equal(lines.length, 400);
    assert.equal(new Set(lines).size, 400);
  } finally {
    x.c.end();
    y.c.end();
    await share.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("请求按顺序处理：紧跟 OPEN 发的 LSTAT 看得到刚建的文件（sshfs 建文件就这么发）", async () => {
  const { home, share } = setup();
  const { port } = await share.start();
  const { c, sftp } = await connect(port, WORKSPACE_USER, share.credentials(WORKSPACE_USER).privateKey);
  try {
    for (let i = 0; i < 20; i++) {
      const opened = call(sftp, "open", `/new-${i}.txt`, "w");
      const seen = call(sftp, "lstat", `/new-${i}.txt`);
      const [h, st] = await Promise.all([opened, seen]);
      assert.ok(st.isFile());
      await call(sftp, "close", h);
    }
  } finally {
    c.end();
    await share.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("坏掉的钥匙文件会重新生成", async () => {
  const { home, share } = setup();
  const first = share.credentials("bot_a").privateKey;
  assert.equal(share.credentials("bot_a").privateKey, first, "第二次拿到同一把");
  writeFileSync(join(home, "computers", "file-share", "clients", "bot_a"), "garbage");
  const again = share.credentials("bot_a").privateKey;
  assert.notEqual(again, first);
  assert.ok(!(utils.parseKey(again) instanceof Error));
  const { port } = await share.start();
  const { c } = await connect(port, "bot_a", again);
  c.end();
  await share.close();
  rmSync(home, { recursive: true, force: true });
});

test("OpenSSH 的 sftp 客户端：批处理读写改名，结束后通道关掉不挂住", async () => {
  let hasSftp = true;
  try {
    execFileSync("sftp", ["-V"], { stdio: "ignore" });
  } catch (e) {
    hasSftp = e?.code !== "ENOENT";
  }
  if (!hasSftp) {
    console.log("      skip: 这台机器没有 OpenSSH sftp");
    return;
  }
  const { home, roots, share } = setup();
  const { port } = await share.start();
  const key = join(home, "key");
  const kh = join(home, "known_hosts");
  writeFileSync(key, share.credentials("bot_a").privateKey, { mode: 0o600 });
  writeFileSync(kh, `${share.knownHosts}\n`);
  writeFileSync(join(home, "local.txt"), "from sftp\n");
  const batch = join(home, "batch");
  writeFileSync(batch, `put ${join(home, "local.txt")} up.txt\nrename up.txt moved.txt\nmkdir d\nls\n`);
  const args = ["-b", batch, "-i", key, "-P", String(port), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes", "-o", `HostKeyAlias=${HOST_KEY_ALIAS}`, "-o", `UserKnownHostsFile=${kh}`, "bot_a@127.0.0.1"];
  try {
    const { stdout } = await promisify(execFile)("sftp", args, { timeout: 15_000, encoding: "utf8" });
    assert.match(stdout, /moved\.txt/);
    assert.equal(readFileSync(join(roots.bot_a, "moved.txt"), "utf8"), "from sftp\n");
    assert.ok(statSync(join(roots.bot_a, "d")).isDirectory());
  } finally {
    await share.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("用户名不合法时不发钥匙", () => {
  const { home, share } = setup();
  for (const u of ["", "../x", "a/b", "a b", "x".repeat(65)]) assert.throws(() => share.credentials(u));
  rmSync(home, { recursive: true, force: true });
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
