// test/seats.mjs — 07 共享电脑座席层的行为测试。共享虚拟机用替身，客机行为见 .scratch/team-rebuild/proof/seats。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overlayCreateArgs, qemuArgs } from "../src/computer-backend.mjs";
import {
  BOT_SEAT_COUNT, CHROMIUM_HOOK, GUEST_FILES, LOGIN_SEAT_ID, LOGIN_SYNC_SCRIPT, SEAT_GUEST_PORTS, SEAT_SCRIPT, SeatBackend, SeatShare,
  expandHome, readSharedMachine, seatUser, sharedMachineSpec, validatePackages, writeSharedMachine,
} from "../src/computer-seats.mjs";
import { guestPath, seatShareRoots, shPath } from "../src/features/computers.mjs";
import { FileShare, WORKSPACE_USER, probePort } from "../src/file-share.mjs";
import { teamPaths, teamRoot } from "../src/team.mjs";
import { startServer } from "../src/server.mjs";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const q = (s) => `'${s}'`;

/** 共享虚拟机替身：按 SeatBackend 发的管理命令模拟客机里的 omp-seat。 */
class FakeVm {
  state = "stopped";
  creates = [];
  stops = 0;
  files = new Map();
  uploads = [];
  seats = new Map();
  commands = [];
  envs = [];
  failUp = null;
  createDelay = 30;

  async status() {
    return { state: this.state, error: this.state === "error" ? { code: "computer_start_failed", message: "boom" } : null };
  }
  async create({ machine } = {}) {
    this.creates.push(machine);
    this.state = "starting";
    await sleep(this.createDelay);
    this.state = "running";
    return await this.status();
  }
  async stop() {
    this.stops += 1;
    this.state = "stopped";
    this.seats.clear();
    this.files.clear();
    return await this.status();
  }
  management() {
    return {
      run: async (opts) => this.#run(opts),
      uploadFile: async ({ localPath, path }) => {
        this.uploads.push(path);
        this.files.set(path, readFileSync(localPath));
      },
    };
  }
  events = [];
  failSeatRun = null;
  #run({ command, env = null }) {
    this.commands.push(command);
    this.events.push(`mgmt ${command}`);
    this.envs.push(env);
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    let m;
    if ((m = /^sha256sum '([^']+)' 2>\/dev\/null/.exec(command))) {
      return ok(this.files.has(m[1]) ? `${sha(this.files.get(m[1]))}\n` : "");
    }
    if ((m = /^set -e; chown root:root '([^']+)'; chmod (\d+) '[^']+'; mv -f '[^']+' '([^']+)'/.exec(command))) {
      this.files.set(m[3], this.files.get(m[1]));
      this.files.delete(m[1]);
      return ok(`${sha(this.files.get(m[3]))}\n`);
    }
    if (/^mkdir -p '[^']+'$/.test(command)) return ok();
    if (command.startsWith("exec /usr/bin/python3 /usr/local/lib/omp-bot/omp-login-sync publish ")) {
      this.publishes = (this.publishes ?? 0) + 1;
      if (this.failPublish) return { exitCode: 2, stdout: "", stderr: this.failPublish };
      return ok("published\n");
    }
    const script = `exec ${SEAT_SCRIPT} `;
    if (!command.startsWith(script)) return { exitCode: 127, stdout: "", stderr: `unexpected ${command}` };
    if (!this.files.has(SEAT_SCRIPT)) return { exitCode: 127, stdout: "", stderr: "omp-seat missing" };
    const [sub, ...rest] = command.slice(script.length).split(" ");
    if (sub === "up") {
      const [user, display, port] = rest;
      if (this.failUp) return { exitCode: 3, stdout: "", stderr: this.failUp(env) };
      this.seats.set(user, { display: Number(display), port: Number(port), token: env?.OMP_SEAT_TOKEN });
      return ok(`user=${user}\nexists=1\nhome=/home/${user}\nxvfb=1\nspacesd=1\nready=1\n`);
    }
    if (sub === "down") {
      this.seats.delete(rest[0]);
      return ok(`user=${rest[0]}\nready=0\n`);
    }
    if (sub === "count") return ok(`${this.seats.size}\n`);
    if (sub === "install-packages") return ok(`installed ${rest.join(" ")}\n`);
    return { exitCode: 2, stdout: "", stderr: `unknown ${sub}` };
  }
  seatDesk(port, token) {
    const vm = this;
    const seat = () => [...vm.seats.values()].find((s) => s.port === port && s.token === token);
    const need = () => {
      if (!seat()) throw new Error(`seat ${port} not up or wrong token`);
      return seat();
    };
    return {
      runs: [],
      async client() { return need(); },
      reset() {},
      async screenshot() { need(); return { width: 1280, height: 800, mimeType: "image/png", data: Buffer.from(String(port)) }; },
      async input() { need(); },
      async run(opts) {
        need();
        this.runs.push(opts);
        vm.events.push(`seat ${port} ${opts.command}`);
        const failed = vm.failSeatRun?.(opts);
        if (failed) return { exitCode: 1, stdout: "", stderr: failed };
        return { exitCode: 0, stdout: `${port} ${opts.cwd}`, stderr: "" };
      },
      async uploadFile(t) { need(); vm.uploads.push(t.path); return { path: t.path }; },
      async downloadFile(t) { need(); return { path: t.path }; },
    };
  }
  async seatHealthy(port) {
    return this.state === "running" && [...this.seats.values()].some((s) => s.port === port);
  }
}

function seated(home, vm, machine = null) {
  return new SeatBackend({ home, vm, machine });
}

// ---------------- 规格 ----------------
test("07 默认规格 4 vCPU、8 GiB、64 GiB，vCPU 上限是宿主核数减 2", () => {
  const big = sharedMachineSpec({}, { hostCpus: 16 });
  assert.deepEqual([big.cpus, big.memoryGb, big.diskGb], [4, 8, 64]);
  assert.deepEqual(big.limits, { cpus: [2, 8], memoryGb: [4, 16] });
  assert.deepEqual(sharedMachineSpec({}, { hostCpus: 6 }).limits.cpus, [2, 4]);
  // 宿主只有 4 核：上限按下限 2 算，默认值也被夹到 2
  const small = sharedMachineSpec({}, { hostCpus: 4 });
  assert.equal(small.cpus, 2);
  assert.deepEqual(small.limits.cpus, [2, 2]);
  assert.equal(sharedMachineSpec({ cpus: 8, memoryGb: 16 }, { hostCpus: 32 }).cpus, 8);
  for (const bad of [{ cpus: 1 }, { cpus: 9 }, { memoryGb: 3 }, { memoryGb: 17 }, { cpus: 2.5 }, { cpus: "x" }]) {
    assert.throws(() => sharedMachineSpec(bad, { hostCpus: 32 }), (e) => e.code === "computer_invalid_argument", JSON.stringify(bad));
  }
});

test("07 规格存进 shared-machine.json，坏文件或超出宿主范围退回默认", () => {
  const home = tmp("ompbot-seat-spec-");
  try {
    assert.equal(readSharedMachine(home, { hostCpus: 16 }).saved, false);
    writeSharedMachine(home, { cpus: 6, memoryGb: 12 }, { hostCpus: 16 });
    const back = readSharedMachine(home, { hostCpus: 16 });
    assert.deepEqual([back.cpus, back.memoryGb, back.saved], [6, 12, true]);
    // 换到核数更少的宿主：保存的 6 超出上限，退回默认
    assert.deepEqual([readSharedMachine(home, { hostCpus: 6 }).cpus, readSharedMachine(home, { hostCpus: 6 }).saved], [4, false]);
    writeFileSync(join(home, "computers", "shared-machine.json"), "{坏");
    assert.equal(readSharedMachine(home, { hostCpus: 16 }).cpus, 4);
    assert.throws(() => writeSharedMachine(home, { cpus: 99 }, { hostCpus: 16 }), (e) => e.code === "computer_invalid_argument");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("07 虚拟机启动参数含规格和 17 个座席端口转发，磁盘按 64 GiB 建", () => {
  const forwards = SEAT_GUEST_PORTS.map((guest, i) => ({ guest, host: 40000 + i }));
  assert.equal(SEAT_GUEST_PORTS.length, BOT_SEAT_COUNT + 1);
  assert.deepEqual([SEAT_GUEST_PORTS[0], SEAT_GUEST_PORTS.at(-1)], [3300, 3316]);
  const args = qemuArgs({
    name: "omp-shared", cpus: 4, memoryMb: 8192, disk: "/d.qcow2", seed: "/s.img",
    ports: { spacesd: 39999, forwards }, qmp: { raw: "q" }, pidFile: "/p",
  });
  assert.equal(args[args.indexOf("-smp") + 1], "4");
  assert.equal(args[args.indexOf("-m") + 1], "8192");
  const net = args[args.indexOf("-netdev") + 1];
  assert.match(net, /hostfwd=tcp:127\.0\.0\.1:39999-:\d+/);
  for (const { guest, host } of forwards) assert.ok(net.includes(`hostfwd=tcp:127.0.0.1:${host}-:${guest}`), `${guest}`);
  assert.equal(net.match(/hostfwd=/g).length, 18);
  assert.doesNotMatch(net, /0\.0\.0\.0/);
  const disk = overlayCreateArgs({ backing: "/b", format: "qcow2", virtualSize: 20 * 2 ** 30, overlay: "/o", sizeBytes: 64 * 2 ** 30 });
  assert.equal(disk.at(-1), String(64 * 2 ** 30));
  // 不比底层镜像小
  assert.equal(overlayCreateArgs({ backing: "/b", format: "qcow2", virtualSize: 80 * 2 ** 30, overlay: "/o", sizeBytes: 64 * 2 ** 30 }).at(-1), String(80 * 2 ** 30));
  assert.equal(overlayCreateArgs({ backing: "/b", format: "qcow2", overlay: "/o" }).at(-1), "/o");
});

// ---------------- 座席生命周期 ----------------
test("07 座席层：状态、创建、启动、停止，最后一个座席停掉才关虚拟机", async () => {
  const home = tmp("ompbot-seat-life-");
  try {
    const vm = new FakeVm();
    // 规格每次开机前按本机核数校验，这里用任何宿主都合法的 2 vCPU
    const seats = seated(home, vm, { cpus: 2, memoryGb: 8 });
    let st = await seats.status("pc_a");
    assert.equal(st.state, "stopped");
    assert.deepEqual([st.vm.state, st.seat.ready], ["stopped", false]);

    st = await seats.create("pc_a");
    assert.equal(st.state, "running");
    assert.deepEqual([st.vm.state, st.seat.ready, st.seat.user], ["running", true, seatUser("pc_a")]);
    assert.equal(vm.creates.length, 1);
    assert.deepEqual(vm.creates[0], { cpus: 2, memoryMb: 8192, diskGb: 64, forwards: [...SEAT_GUEST_PORTS] });

    st = await seats.start("pc_b");
    assert.equal(st.state, "running");
    assert.equal(vm.creates.length, 1, "第二个座席不再开机");
    const a = vm.seats.get(seatUser("pc_a"));
    const b = vm.seats.get(seatUser("pc_b"));
    assert.deepEqual([a.port, a.display, b.port, b.display], [3300, 20, 3301, 21]);
    assert.notEqual(a.token, b.token);

    st = await seats.stop("pc_a");
    assert.equal(st.state, "stopped");
    assert.equal(st.vm.state, "running", "还有一个座席，共享电脑不关");
    assert.equal(vm.stops, 0);
    assert.equal((await seats.status("pc_b")).state, "running");

    st = await seats.stop("pc_b");
    assert.equal(vm.stops, 1, "最后一个座席停掉后关机");
    assert.deepEqual([st.state, st.vm.state], ["stopped", "stopped"]);
    // 停一个从没起过的座席不报错
    assert.equal((await seats.stop("pc_never")).state, "stopped");

    // 再开：同一座席、同一端口和令牌，客机脚本重新核对
    const uploadsBefore = vm.uploads.length;
    st = await seats.start("pc_a");
    assert.equal(st.state, "running");
    assert.equal(vm.creates.length, 2);
    assert.equal(vm.seats.get(seatUser("pc_a")).token, a.token);
    assert.equal(vm.uploads.length, uploadsBefore + GUEST_FILES.length, "开机后补装了全部客机文件");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("07 生命周期排队：两个座席同时启动只开一次机，停和启动不互相踩", async () => {
  const home = tmp("ompbot-seat-queue-");
  try {
    const vm = new FakeVm();
    vm.createDelay = 80;
    const seats = seated(home, vm);
    const both = Promise.all([seats.start("pc_a"), seats.start("pc_b")]);
    await sleep(20);
    assert.equal((await seats.status("pc_a")).state, "starting");
    assert.equal((await seats.status("pc_b")).state, "starting");
    const [a, b] = await both;
    assert.deepEqual([a.state, b.state, vm.creates.length], ["running", "running", 1]);
    // 停 a 和 起 c 同时发：count 时 c 已经在或还没进队，都不会把 c 所在的机器关掉
    const [, c] = await Promise.all([seats.stop("pc_a"), seats.start("pc_c")]);
    assert.equal(c.state, "running");
    assert.equal(vm.stops, 0);
    await seats.stop("pc_b");
    await seats.stop("pc_c");
    assert.equal(vm.stops, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("07 令牌只经 env 传给管理通道，seats.json 是 0600，错误里不带令牌", async () => {
  const home = tmp("ompbot-seat-token-");
  try {
    const vm = new FakeVm();
    const seats = seated(home, vm);
    await seats.start("pc_a");
    const file = join(home, "computers", "seats.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(file, "utf8")).seats.pc_a;
    assert.match(saved.token, /^[0-9a-f]{48}$/);
    assert.ok(vm.commands.every((c) => !c.includes(saved.token)), "令牌不进命令行");
    const upEnv = vm.envs[vm.commands.findIndex((c) => c.includes(" up "))];
    assert.equal(upEnv.OMP_SEAT_TOKEN, saved.token);

    vm.failUp = (env) => `spacesd refused token ${env.OMP_SEAT_TOKEN}`;
    await seats.stop("pc_a");
    await assert.rejects(seats.start("pc_a"), (e) => {
      assert.equal(e.code, "computer_start_failed");
      assert.ok(!e.message.includes(saved.token), e.message);
      assert.match(e.message, /\[redacted\]|redacted/i);
      return true;
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("07 客机脚本：哈希一致就不重装，不一致经管理通道补装（09 起含登录脚本和浏览器钩子）", async () => {
  const home = tmp("ompbot-seat-files-");
  try {
    assert.deepEqual(GUEST_FILES.map((f) => [f.guest, f.mode]), [
      [SEAT_SCRIPT, "0755"],
      [LOGIN_SYNC_SCRIPT, "0755"],
      [CHROMIUM_HOOK, "0644"],
    ]);
    const vm = new FakeVm();
    for (const f of GUEST_FILES) vm.files.set(f.guest, readFileSync(new URL(`../${f.local}`, import.meta.url)));
    const local = vm.files.get(SEAT_SCRIPT);
    vm.state = "running";
    const seats = seated(home, vm);
    await seats.start("pc_a");
    assert.equal(vm.uploads.length, 0, "镜像里已经是同一份脚本");
    // 旧镜像：旧的座席脚本，没有登录脚本和钩子
    const home2 = tmp("ompbot-seat-files2-");
    const vm2 = new FakeVm();
    vm2.files.set(SEAT_SCRIPT, Buffer.from("#!/bin/sh\necho old\n"));
    vm2.state = "running";
    await seated(home2, vm2).start("pc_a");
    assert.deepEqual(vm2.uploads, GUEST_FILES.map((f) => `${f.guest}.new`));
    assert.ok(vm2.commands.includes("mkdir -p '/etc/chromium.d'"), "钩子目录先建好");
    for (const f of GUEST_FILES) assert.ok(vm2.files.has(f.guest), f.guest);
    assert.equal(sha(vm2.files.get(SEAT_SCRIPT)), sha(local));
    assert.ok(readFileSync(join(home2, "computers", "guest-files", "omp-seat")).equals(local), "先落成普通文件再上传");
    rmSync(home2, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("07 16 个 bot 座席用满后拒绝，登录座席固定 omp-login、端口 3316、屏幕 :36", async () => {
  const home = tmp("ompbot-seat-full-");
  try {
    const vm = new FakeVm();
    vm.createDelay = 0;
    const seats = seated(home, vm);
    for (let i = 0; i < BOT_SEAT_COUNT; i += 1) await seats.start(`pc_${i}`);
    await assert.rejects(seats.start("pc_extra"), (e) => e.code === "computer_start_failed" && /16/.test(e.message));
    const login = await seats.start(LOGIN_SEAT_ID);
    assert.equal(login.state, "running");
    assert.deepEqual(vm.seats.get("omp-login"), { ...vm.seats.get("omp-login"), port: 3316, display: 36 });
    assert.equal(new Set([...vm.seats.keys()]).size, BOT_SEAT_COUNT + 1, "用户名互不相同");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("07 ~ 路径解析到座席用户主目录，命令默认在 ~/work", async () => {
  const home = tmp("ompbot-seat-home-");
  try {
    const vm = new FakeVm();
    const seats = seated(home, vm);
    await seats.start("pc_a");
    const user = seatUser("pc_a");
    const out = await seats.run("pc_a", { command: "pwd" });
    assert.equal(out.stdout, `3300 /home/${user}/work`);
    assert.equal((await seats.run("pc_a", { command: "pwd", cwd: "~" })).stdout, `3300 /home/${user}`);
    assert.equal((await seats.run("pc_a", { command: "pwd", cwd: "/opt" })).stdout, "3300 /opt");
    await seats.uploadFile("pc_a", { localPath: "/x", path: "~/work/attachments/a.txt" });
    assert.equal(vm.uploads.at(-1), `/home/${user}/work/attachments/a.txt`);
    assert.equal(expandHome("~", "/home/u"), "/home/u");
    assert.equal(expandHome("~x/y", "/home/u"), "~x/y");
    // 截图走自己的座席
    assert.equal((await seats.screenshot("pc_a")).data.toString(), "3300");
    await assert.rejects(seats.run("pc_nobody", { command: "true" }), (e) => e.code === "computer_not_created");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("07 功能层路径：接受 ~，shell 里展开成 \"$HOME\"，不再限制写入目录", () => {
  assert.equal(guestPath("~/work/a b"), "~/work/a b");
  assert.equal(guestPath("~"), "~");
  assert.equal(guestPath("~/"), "~");
  assert.equal(guestPath("/etc/hosts"), "/etc/hosts");
  for (const bad of ["work/a", "~other/a", "C:\\x", "~/../x", "../x"]) {
    assert.throws(() => guestPath(bad), (e) => e.code === "invalid_path", bad);
  }
  assert.equal(shPath("~"), '"$HOME"');
  assert.equal(shPath("~/a b/it's"), `"$HOME"/'a b/it'\\''s'`);
  assert.equal(shPath("/tmp/x"), "'/tmp/x'");
});

test("07 装系统包：包名校验，经管理通道以 root 跑 omp-seat install-packages", async () => {
  assert.deepEqual(validatePackages(["curl", "libreoffice-writer", "g++", "curl", " python3.12 "]), ["curl", "libreoffice-writer", "g++", "python3.12"]);
  for (const bad of [[], ["-oops"], ["Bad_Name"], ["a"], ["x;rm -rf /"], [""], [42], Array.from({ length: 33 }, (_, i) => `p${i}x`)]) {
    assert.throws(() => validatePackages(bad), (e) => e.code === "computer_invalid_argument", JSON.stringify(bad));
  }
  const home = tmp("ompbot-seat-apt-");
  try {
    const vm = new FakeVm();
    const seats = seated(home, vm);
    await seats.start("pc_a");
    const out = await seats.installPackages("pc_a", ["ffmpeg", "poppler-utils"]);
    assert.equal(out.exitCode, 0);
    assert.equal(vm.commands.at(-1), `exec ${SEAT_SCRIPT} install-packages ${q("ffmpeg")} ${q("poppler-utils")}`);
    const before = vm.commands.length;
    await assert.rejects(seats.installPackages("pc_a", ["ok", "--force-yes"]), (e) => e.code === "computer_invalid_argument");
    assert.equal(vm.commands.length, before, "坏包名不碰客机");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("07 共享电脑出错时座席状态如实报 error", async () => {
  const home = tmp("ompbot-seat-err-");
  try {
    const vm = new FakeVm();
    vm.state = "error";
    const st = await seated(home, vm).status("pc_a");
    assert.equal(st.state, "error");
    assert.equal(st.vm.state, "error");
    assert.equal(st.error.message, "boom");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("07 规格接口：GET 给默认值和范围，PUT 保存、越界 400", async () => {
  const home = tmp("ompbot-seat-http-");
  mkdirSync(home, { recursive: true });
  const server = await startServer({ home, port: 0, computerBackend: { status: async () => ({ state: "stopped" }) }, bin: join(home, "no-model-binary") });
  try {
    const call = async (method, body) => {
      const res = await fetch(`${server.url}/api/computer/shared-machine`, {
        method,
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, data: await res.json() };
    };
    let r = await call("GET");
    assert.equal(r.status, 200);
    assert.equal(r.data.machine.diskGb, 64);
    assert.equal(r.data.machine.appliesOn, "next_boot");
    assert.deepEqual(r.data.machine.limits.memoryGb, [4, 16]);
    r = await call("PUT", { cpus: 2, memoryGb: 6 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.machine.cpus, r.data.machine.memoryGb], [2, 6]);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "computers", "shared-machine.json"), "utf8")), { cpus: 2, memoryGb: 6 });
    r = await call("PUT", { memoryGb: 64 });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "invalid_field");
    r = await call("GET");
    assert.equal(r.data.machine.memoryGb, 6, "越界的请求不改已保存的值");
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------- 08 共享目录 ----------------
test("08 座席起来时共享目录的端口和钥匙只经 env 传进客机，每个 bot 一把，登录座席不挂", async () => {
  const home = tmp("ompbot-seat-share-");
  const vm = new FakeVm();
  vm.shareHost = "127.0.0.1";
  const bots = { pc_a: "bot_a", pc_b: "bot_b" };
  const fileShare = new FileShare({ home, roots: (u) => (u === WORKSPACE_USER || Object.values(bots).includes(u) ? join(home, "share", u) : null) });
  const share = new SeatShare({ fileShare, botIdFor: (cid) => bots[cid] ?? null });
  const seats = new SeatBackend({ home, vm, share });
  try {
    await seats.start("pc_a");
    await seats.start("pc_b");
    await seats.start(LOGIN_SEAT_ID);
    const ups = vm.envs.filter((e) => e?.OMP_SEAT_TOKEN);
    assert.equal(ups.length, 3);
    const [a, b, login] = ups;
    const port = fileShare.port;
    assert.ok(port > 0, "第一个座席起来时服务就在跑");
    const b64 = (s) => Buffer.from(s).toString("base64");
    assert.equal(a.OMP_SHARE_HOST, "127.0.0.1");
    assert.equal(a.OMP_SHARE_PORT, String(port));
    assert.equal(a.OMP_SHARE_KNOWN_HOSTS, fileShare.knownHosts);
    assert.equal(a.OMP_SHARE_USER, "bot_a");
    assert.equal(b.OMP_SHARE_USER, "bot_b");
    assert.equal(a.OMP_SHARE_KEY, b64(fileShare.credentials("bot_a").privateKey));
    assert.notEqual(a.OMP_SHARE_KEY, b.OMP_SHARE_KEY, "每个 bot 一把钥匙");
    assert.equal(a.OMP_SHARE_WORKSPACE_KEY, b.OMP_SHARE_WORKSPACE_KEY);
    assert.notEqual(a.OMP_SHARE_WORKSPACE_KEY, a.OMP_SHARE_KEY);
    assert.equal(Object.keys(login).filter((k) => k.startsWith("OMP_SHARE_")).length, 0, "登录座席不挂共享目录");
    // 钥匙不进命令行，不进 seats.json
    for (const cmd of vm.commands) assert.ok(!cmd.includes(a.OMP_SHARE_KEY) && !cmd.includes("PRIVATE KEY"));
    const saved = readFileSync(join(home, "computers", "seats.json"), "utf8");
    assert.ok(!saved.includes(a.OMP_SHARE_KEY) && !saved.includes("PRIVATE KEY"));
    // 客机报错时错误信息里不带钥匙
    await seats.stop("pc_a");
    vm.failUp = (env) => `sshfs failed key=${env.OMP_SHARE_KEY} ws=${env.OMP_SHARE_WORKSPACE_KEY}`;
    const err = await seats.start("pc_a").then(() => null, (e) => e);
    assert.ok(err, "up 失败要抛出");
    assert.ok(!err.message.includes(a.OMP_SHARE_KEY) && !err.message.includes(a.OMP_SHARE_WORKSPACE_KEY), err.message);
    vm.failUp = null;
  } finally {
    await seats.close();
  }
  assert.equal(fileShare.port, null);
  rmSync(home, { recursive: true, force: true });
});

test("08 共享电脑开着时服务自动起来（omp-bot 重启后客机 sshfs 才接得上），关后端时停", async () => {
  const home = tmp("ompbot-seat-share2-");
  const vm = new FakeVm();
  const fileShare = new FileShare({ home, roots: () => null });
  const seats = new SeatBackend({ home, vm, share: new SeatShare({ fileShare, botIdFor: () => null }) });
  await seats.status("pc_x");
  assert.equal(fileShare.port, null, "共享电脑没开不起服务");
  vm.state = "running";
  await seats.status("pc_x");
  for (let i = 0; i < 50 && !fileShare.port; i++) await sleep(20);
  const port = fileShare.port;
  assert.ok(port > 0);
  assert.equal(await probePort(port), true);
  await seats.close();
  assert.equal(await probePort(port), false);
  rmSync(home, { recursive: true, force: true });
});

test("08 共享目录的根：workspace 是 team/workspace，bot 是自己的 work，删掉的 bot 不认", () => {
  const home = "/tmp/ompbot-roots";
  const live = new Set(["bot_a"]);
  const roots = seatShareRoots({ home, getBot: (id) => (live.has(id) ? { id } : null), teamPaths, teamRoot });
  assert.equal(roots("workspace"), join(teamRoot(home), "workspace"));
  assert.equal(roots("bot_a"), teamPaths(home, "bot_a").workDir);
  assert.equal(roots("bot_a"), join(home, "team", "bots", "bot_a", "work"));
  assert.equal(roots("bot_gone"), null);
  live.delete("bot_a");
  assert.equal(roots("bot_a"), null);
});

// ---------------- 09 共享登录 ----------------
test("09 登录屏：打开时开浏览器；完成时先关浏览器让 cookie 落盘，再经管理通道以 root 发布，然后停登录屏", async () => {
  const home = tmp("ompbot-seat-login-");
  try {
    const vm = new FakeVm();
    vm.createDelay = 0;
    const seats = seated(home, vm);
    await assert.rejects(seats.publishLogin(), (e) => e.code === "computer_not_created", "没开登录屏不能发布");
    let st = await seats.openLogin();
    assert.equal(st.state, "running");
    assert.equal(st.seat.user, "omp-login");
    const opened = vm.events.filter((e) => e.startsWith("seat 3316 "));
    assert.equal(opened.length, 1);
    assert.match(opened[0], /setsid -f chromium /);
    assert.match(opened[0], /pgrep -u "\$\(id -u\)" -x 'chromium\|chrome'/, "已经开着就不再开");
    // 发布失败：登录屏留着，用户可以重试
    vm.failPublish = "no cookies";
    vm.events.length = 0;
    await assert.rejects(seats.publishLogin(), /发布登录失败.*no cookies/);
    assert.equal((await seats.status(LOGIN_SEAT_ID)).state, "running");
    vm.failPublish = null;
    // 浏览器关不掉：不发布
    vm.failSeatRun = (opts) => (opts.command.includes("pkill -TERM") ? "still running" : null);
    const publishesBefore = vm.publishes;
    await assert.rejects(seats.publishLogin(), /没有关掉，没有发布/);
    assert.equal(vm.publishes, publishesBefore);
    vm.failSeatRun = null;
    vm.events.length = 0;
    const out = await seats.publishLogin();
    assert.ok(!Number.isNaN(Date.parse(out.publishedAt)));
    assert.equal(out.status.state, "stopped");
    const close = vm.events.findIndex((e) => e.startsWith("seat 3316 ") && e.includes("pkill -TERM"));
    const publish = vm.events.findIndex((e) => e.startsWith("mgmt exec /usr/bin/python3 "));
    const down = vm.events.findIndex((e) => e === "mgmt exec /usr/local/lib/omp-bot/omp-seat down omp-login");
    assert.ok(close >= 0 && publish > close && down > publish, vm.events.join("\n"));
    assert.equal(vm.events[publish],
      "mgmt exec /usr/bin/python3 /usr/local/lib/omp-bot/omp-login-sync publish --from '/home/omp-login/.config/chromium' --store /var/lib/omp-login --group team");
    // 最后一个座席停掉，共享电脑也关了
    assert.equal(vm.state, "stopped");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("09 登录屏接口：打开、输入要带当前代号、完成记下发布时间、关闭不保存；后端没有登录屏时 501", async () => {
  const home = tmp("ompbot-login-http-");
  mkdirSync(home, { recursive: true });
  const calls = [];
  let state = "stopped";
  const backend = {
    status: async (id) => ({ state: id === "login" ? state : "stopped", vm: { state }, display: { width: 1280, height: 800 } }),
    openLogin: async () => { calls.push("open"); state = "running"; return { state, vm: { state } }; },
    publishLogin: async () => { calls.push("publish"); state = "stopped"; return { publishedAt: "2026-10-16T01:02:03.000Z", status: { state } }; },
    stop: async (id) => { calls.push(`stop ${id}`); state = "stopped"; return { state }; },
    input: async (id, action) => { calls.push(`input ${id} ${action.action}`); },
    screenshot: async (id) => ({ width: 2, height: 2, mimeType: "image/png", data: Buffer.from(`png-${id}`) }),
  };
  const server = await startServer({ home, port: 0, computerBackend: backend, bin: join(home, "no-model-binary") });
  const call = async (method, path, body) => {
    const res = await fetch(`${server.url}/api/computer/login${path}`, {
      method,
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, data: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  try {
    let r = await call("GET", "");
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.computer.state, r.data.computer.holder, r.data.computer.published], ["stopped", null, null]);
    r = await call("POST", "/input", { generation: 0, action: "click", x: 1, y: 1 });
    assert.equal(r.status, 409, "没开不能输入");
    r = await call("POST", "/open");
    assert.equal(r.status, 200);
    const gen = r.data.computer.generation;
    assert.deepEqual([r.data.computer.state, r.data.computer.holder, gen], ["running", "human", 1]);
    r = await call("POST", "/input", { generation: gen - 1, action: "click", x: 1, y: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "computer_generation_stale");
    r = await call("POST", "/input", { generation: gen, action: "click", x: 1, y: 1 });
    assert.equal(r.status, 200);
    r = await call("GET", "/screen");
    assert.equal(r.status, 200);
    assert.equal(String(r.data), "png-login");
    r = await call("POST", "/done");
    assert.equal(r.status, 200);
    assert.equal(r.data.computer.state, "stopped");
    assert.equal(r.data.computer.published.at, "2026-10-16T01:02:03.000Z");
    assert.ok(r.data.computer.generation > gen, "完成后旧代号作废");
    assert.equal(JSON.parse(readFileSync(join(home, "computers", "login.json"), "utf8")).publishedAt, "2026-10-16T01:02:03.000Z");
    await call("POST", "/open");
    r = await call("POST", "/stop");
    assert.equal(r.data.computer.state, "stopped");
    assert.deepEqual(calls, ["open", "input login click", "publish", "open", "stop login"]);
  } finally {
    await server.close();
  }
  const bare = await startServer({ home, port: 0, computerBackend: { status: async () => ({ state: "stopped" }) }, bin: join(home, "no-model-binary") });
  try {
    const res = await fetch(`${bare.url}/api/computer/login`, { headers: { Authorization: `Bearer ${bare.token}` } });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).code, "computer_login_unsupported");
  } finally {
    await bare.close();
    rmSync(home, { recursive: true, force: true });
  }
});

for (const run of pending) await run();
console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);
