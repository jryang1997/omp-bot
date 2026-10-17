// test/secret-guard.mjs — 密钥目录硬拦（OMP tool_call 扩展），零模型调用。
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { secretHits, secretPaths, secretToolCall } from "../src/secret-guard.mjs";
import { writePersonaFiles } from "../src/persona.mjs";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const sandbox = mkdtempSync(join("/var/tmp", "omp-bot-secret-"));
const home = join(sandbox, "u");
const ompbotHome = join(home, ".ompbot");
const agentDir = join(sandbox, "agent");
const cwd = join(ompbotHome, "team", "bots", "b1");
for (const d of [join(home, ".ssh"), cwd, agentDir, join(home, "proj")]) mkdirSync(d, { recursive: true });
writeFileSync(join(home, ".ssh", "id_rsa"), "KEY");
writeFileSync(join(ompbotHome, "runtime.json"), "{}");
symlinkSync(join(home, ".ssh"), join(cwd, "keys"));
const secrets = secretPaths({ home, ompbotHome, agentDirs: [agentDir] });
const env = { HOME: home, OMPBOT_HOME: ompbotHome };
const opts = { cwd, home, env, secrets };
const bash = (command) => secretHits("bash", { command }, opts);
const blocked = (command) => assert.ok(bash(command).length > 0, `该拦：${command}`);
const allowed = (command) => assert.deepEqual(bash(command), [], `不该拦：${command}`);

await test("要我同意档自动放行的只读命令读不到密钥", () => {
  blocked("cat ~/.ssh/id_rsa");
  blocked(`head ${join(home, ".ssh", "id_rsa")}`);
  blocked("cat $HOME/.ssh/id_rsa");
  blocked("cat ${OMPBOT_HOME}/runtime.json");
  blocked(`cat ${join(ompbotHome, "runtime.json")}`);
  blocked("cat ../../../runtime.json");
  blocked("cat keys/id_rsa");
  blocked(`grep -r token ${join(home, ".aws")}`);
  blocked(`tail ${join(agentDir, "agent.db")}`);
  blocked("cat ~/.ss*/id_rsa");
  blocked(`cat ${ompbotHome}/*.json`);
  blocked("cd ~ && cat .ssh/id_rsa");
});

await test("递归读的命令和工具，目标是密钥的上级也拦；只列名字的不拦", () => {
  blocked("grep -r password ~");
  blocked("tar czf /tmp/x.tgz ~");
  assert.ok(secretHits("grep", { pattern: "token", path: home }, opts).length > 0);
  allowed("ls ~");
  allowed("ls ~/*");
  allowed("du -sh ~");
  allowed("grep -r todo .");
  assert.deepEqual(secretHits("grep", { pattern: "token", path: "src" }, opts), []);
  assert.deepEqual(secretHits("glob", { pattern: "**/*", path: home }, opts), []);
});

await test("平常的路径和命令不受影响", () => {
  allowed("ls -la");
  allowed(`cat ${join(home, "proj", "README.md")}`);
  allowed(`cat ${join(ompbotHome, "team", "AGENTS.md")}`);
  allowed("cat work/notes.md");
  allowed("echo hello world");
  assert.deepEqual(secretHits("read", { path: "work/notes.md" }, opts), []);
  assert.deepEqual(secretHits("read", { path: join(ompbotHome, "team") }, opts), []);
});

await test("各种工具都拦：read、写类按目标、浏览器 file://、python；写正文提到 ~/.ssh 不算", () => {
  assert.ok(secretHits("read", { path: "~/.ssh/id_rsa" }, opts).length > 0);
  assert.ok(secretHits("write", { path: "~/.ssh/authorized_keys", content: "x" }, opts).length > 0);
  assert.ok(secretHits("edit", { input: `*** Begin Patch\n*** Update File: ${join(ompbotHome, "channels.feishu.json")}\n*** End Patch` }, opts).length > 0);
  assert.ok(secretHits("browser", { action: "goto", url: `file://${home}/.ssh/id_rsa` }, opts).length > 0);
  assert.ok(secretHits("python", { code: "print(open('/x/.aws/credentials').read())" }, opts).length > 0);
  assert.deepEqual(secretHits("write", { path: "docs/ssh.md", content: "把公钥放进 ~/.ssh/authorized_keys" }, opts), []);
  assert.deepEqual(secretHits("web_search", { query: "~/.ssh/config 权限" }, opts), []);
});

await test("拦下的理由说清楚是硬规矩，别换写法再试", () => {
  const r = secretToolCall({ toolName: "read", input: { path: "~/.ssh/id_rsa" } }, opts);
  assert.equal(r.block, true);
  assert.match(r.reason, /任何档位/);
  assert.match(r.reason, /不要换个写法再试/);
  assert.equal(secretToolCall({ toolName: "read", input: { path: "a.md" } }, opts), undefined);
});

await test("全部放手档和一直问档也挂；生成的扩展真的拦", async () => {
  const dir = join(sandbox, "persona");
  for (const fields of [{ executionMode: "full", approvalMode: "yolo" }, { executionMode: "supervised", approvalMode: "always-ask" }, { executionMode: "supervised", approvalMode: "write" }]) {
    const { argv } = writePersonaFiles({ id: "b1", ...fields }, dir, { writeRoots: { cwd }, secretDirs: { home, ompbotHome, agentDirs: [agentDir] } });
    const handlers = {};
    const mod = await import(`${pathToFileURL(argv[argv.indexOf("--extension") + 1]).href}?${Math.random()}`);
    mod.default({ on: (name, fn) => { handlers[name] = fn; } });
    const r = await handlers.tool_call({ toolName: "bash", input: { command: `cat ${join(ompbotHome, "runtime.json")}` } }, { hasUI: false, cwd });
    assert.equal(r?.block, true, JSON.stringify(fields));
  }
});

await test("带空格的家目录：整串路径和引号里的路径都看", () => {
  const h = join(sandbox, "John Doe");
  const o = { cwd: join(h, "proj"), home: h, env: {}, secrets: secretPaths({ home: h, ompbotHome: join(h, ".ompbot") }) };
  assert.ok(secretHits("read", { path: join(h, ".netrc") }, o).length, "read 带空格路径");
  assert.ok(secretHits("read", { path: join(h, ".ompbot", "runtime.json") }, o).length, "read 带空格 runtime.json");
  assert.ok(secretHits("bash", { command: `cat "${join(h, ".netrc")}"` }, o).length, "双引号");
  assert.ok(secretHits("bash", { command: `cat '${join(h, ".netrc")}'` }, o).length, "单引号");
  assert.ok(secretHits("bash", { command: `cat ${join(h, ".netrc").replace(/ /g, "\\ ")}` }, o).length, "反斜杠转义");
  assert.deepEqual(secretHits("bash", { command: `cat "${join(h, "proj", "a b.txt")}"` }, o), []);
});

await test("电脑和文件共享的凭据在数据目录里一层以下，也拦", () => {
  for (const rel of ["computers/seats.json", "computers/file-share/host_ed25519", "computers/c1/control.key"]) {
    assert.ok(secretHits("read", { path: join(ompbotHome, rel) }, opts).length, rel);
  }
  blocked("grep -r token ${OMPBOT_HOME}/computers");
});

await test("不给路径的递归搜索按 cwd 算", () => {
  const atHome = { ...opts, cwd: home };
  assert.ok(secretHits("bash", { command: "grep -rn token" }, atHome).length, "grep -rn");
  assert.ok(secretHits("bash", { command: "rg token" }, atHome).length, "rg");
  assert.ok(secretHits("bash", { command: "grep -rn token", cwd: home }, opts).length, "bash 的 cwd 参数");
  assert.deepEqual(secretHits("bash", { command: "grep -n token notes.md" }, atHome), [], "不递归就只看给的文件");
  assert.deepEqual(secretHits("bash", { command: "grep -rn token" }, { ...opts, cwd: join(home, "proj") }), []);
});

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
