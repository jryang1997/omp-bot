// 05 证明：用 omp-bot 真实生成的 overlay 跑真实 omp + 假模型服务，看发给模型的请求里有没有秘密原文。
// 三种秘密：bots/<id>/.omp/secrets.yml 里配的、OMP_ 前缀的环境变量（buildRuntimeEnv 会放行）、ghp_ 形状的凭据串。
// 对照组：同一份 overlay 去掉 secrets 两行再跑一次，应该泄露。结果写 prove-secrets.txt。
// 用法：cd /data && node omp-bot/.scratch/moat/proof/secrets/prove-secrets.mjs
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockLlm } from "./mock-llm.mjs";
import { writePersonaFiles } from "../../../../src/persona.mjs";
import { buildRuntimeEnv } from "../../../../src/bot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OMP_BIN = "/data/omp-probe/node_modules/.bin";
const FILE_SECRET = "Hunter2-FileSecret-5150";
const ENV_SECRET = "EnvSecret-Zebra-31337";
const GHP = "ghp_" + "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"; // 36 位，像 GitHub 令牌
process.env.OMP_PROBE_API_KEY = ENV_SECRET;

async function runOnce(label, keepSecrets) {
  const llm = await startMockLlm();
  const agent = mkdtempSync("/tmp/sec-agent-");
  writeFileSync(join(agent, "models.yml"), `providers:\n  mock:\n    baseUrl: http://127.0.0.1:${llm.port}/v1\n    api: openai-completions\n    apiKey: dummy-key\n    models:\n      - id: mock-model\n`);
  const team = mkdtempSync("/tmp/sec-team-");
  const cwd = join(team, "bots", "probe");
  mkdirSync(join(cwd, ".omp"), { recursive: true });
  writeFileSync(join(cwd, ".omp", "secrets.yml"), `- type: plain\n  content: ${FILE_SECRET}\n`);
  writeFileSync(join(cwd, "secret.txt"), `db password: ${FILE_SECRET}\napi key: ${ENV_SECRET}\ngithub: ${GHP}\n`);
  const base = join(team, ".base");
  const { argv, overlayPath } = writePersonaFiles({ id: "probe", name: "探针", executionMode: "work" }, base, {});
  const overlay = readFileSync(overlayPath, "utf8");
  if (!keepSecrets) {
    const cut = overlay.replace("secrets:\n  enabled: true\n", "");
    if (cut === overlay) throw new Error("overlay 里没有 secrets 段，对照组无从去掉");
    writeFileSync(overlayPath, cut);
  }
  const env = { ...buildRuntimeEnv(), PATH: `${OMP_BIN}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agent, HOME: agent };
  const prompt = `读一下 secret.txt。顺便说一句我的口令是 ${FILE_SECRET}，令牌 ${GHP}`;
  const args = ["-p", prompt, "--model", "mock/mock-model", "--session-dir", join(cwd, "sessions"), ...argv];
  const exit = await new Promise((resolve) => {
    const ch = spawn(join(OMP_BIN, "omp"), args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    ch.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => ch.kill(), 90000);
    ch.on("exit", (c) => { clearTimeout(t); resolve({ code: c, err: err.slice(0, 400) }); });
  });
  await llm.close();
  const chats = llm.requests.filter((r) => r.url.includes("chat"));
  const all = chats.map((r) => r.body).join("\n");
  const sessFiles = readdirSync(join(cwd, "sessions"), { recursive: true }).filter((f) => String(f).endsWith(".jsonl"));
  const sess = sessFiles.map((f) => readFileSync(join(cwd, "sessions", f), "utf8")).join("\n");
  const sawToolResult = chats.some((r) => { try { return JSON.parse(r.body).messages.some((m) => m.role === "tool"); } catch { return false; } });
  return {
    label, exit: exit.code, stderr: exit.err, chatRequests: chats.length, sawToolResult,
    overlayHasSecrets: readFileSync(overlayPath, "utf8").includes("secrets:\n  enabled: true"),
    envPassedToOmp: env.OMP_PROBE_API_KEY === ENV_SECRET,
    leak: { file: all.includes(FILE_SECRET), env: all.includes(ENV_SECRET), ghp: all.includes(GHP) },
    placeholders: (all.match(/\$\$[A-Z0-9]+:[A-Z]\$\$/g) ?? []).length,
    sessionHasRaw: sess.includes(FILE_SECRET),
  };
}

const on = await runOnce("overlay 原样（secrets 打开）", true);
const off = await runOnce("对照：去掉 secrets 两行", false);
const checks = [
  ["两次都跑完、都把工具结果发回了模型", on.exit === 0 && off.exit === 0 && on.sawToolResult && off.sawToolResult],
  ["OMP_ 前缀的秘密环境变量确实传给了 omp", on.envPassedToOmp],
  ["打开时：secrets.yml 里的秘密不在模型请求里", on.overlayHasSecrets && !on.leak.file],
  ["打开时：名字像密钥的环境变量值不在模型请求里", !on.leak.env],
  ["打开时：ghp_ 形状的令牌不在模型请求里", !on.leak.ghp],
  ["打开时：模型请求里有占位符", on.placeholders > 0],
  ["对照：去掉后三种秘密都出现在模型请求里", !off.overlayHasSecrets && off.leak.file && off.leak.env && off.leak.ghp],
  ["本地会话文件是原文（OMP 设计，所以 sessions/ 不进 git）", on.sessionHasRaw],
];
const lines = [
  `05 秘密不进模型 证明（${new Date().toISOString()}）`,
  `omp: ${OMP_BIN}/omp`,
  JSON.stringify(on), JSON.stringify(off), "",
  ...checks.map(([n, ok]) => `${ok ? "PASS" : "FAIL"} ${n}`),
  `${checks.filter(([, ok]) => ok).length}/${checks.length}`,
];
writeFileSync(join(HERE, "prove-secrets.txt"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
