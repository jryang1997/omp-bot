// memory-config.mjs — Bot 私有记忆的「模型来源」前置：判定 + 生成私有 provider 文件。
//
// 只做两件事（不重复 OMP 的模型/记忆引擎）：
//  1) memoryPrereqStatus({model,agentDir,sourceFile})：选定模型能否在 Bot 私有 agentDir 上
//     无凭据跑起来。addBot/updateBot 与运行时启动共用这一处判定，Features 状态面直接复用。
//  2) writePrivateMemoryConfig：把选定 provider 的非密传输信息 + 选定模型行写到
//     <agentDir>/models.yml。
//
// 复制安全模型（失败关闭，不猜 YAML）：
//  - 源文件按「结构白名单」重新序列化，绝不整行照抄：只认 `key: value`、`key:` + 子映射、
//    标量列表这三种形状；引号键、flow map（{...}）、list-of-map、锚点、缩进异常一律拒绝。
//  - provider/模型两级都只允许白名单键；未知键、凭据类键名（apiKey/authHeader/token/...）、
//    凭据类值（Bearer、{{模板}}、长 base64）默认拒绝，不复制。
//  - 所有 baseUrl（provider 级与模型级）逐个校验：http(s)、不带 userinfo/query/hash；
//    loopback 之外不算 keyless。
//  - 原生 auth broker（URL + token 都在）成立时，provider 块里的凭据行会被「剔除」而不是
//    复制（broker 在运行时提供凭据）；剔除项以键名如实上报。凭据类值（如 URL userinfo）
//    永远拒绝，不因 broker 而放宽。
//
// 依据（OMP 18.10.0 实测二进制/源码，未逐项实跑）：
//  - ModelRegistry 只读 <agentDir>/models.yml，所以私有 agentDir 没有该文件就没有任何模型；
//    authStorage 仍走全局 store，与本文件无关。
//  - provider 显式 `auth: none` → 原生 keyless（getApiKey 直接返回 "N/A"），不需要 broker/凭据；
//    仅凭 loopback baseUrl 不能推断 keyless，必须 provider 自己声明。
//  - 记忆整理阶段用 modelRoles（phase1 default、phase2 smol）与 memory 角色，角色必须钉在选定
//    模型上，否则会落到用户全局配置里的 cpa/tiny 等别的 provider（见 memoryModelRoles）。
//  - named profile（OMP_PROFILE/PI_PROFILE）会重定位 agentDir 到 profiles/<name>/agent，
//    因此私有目录的运行时环境必须显式清掉 profile 变量（见 BotRuntime.buildEnv）。
//  - OMP_AUTH_BROKER_URL 不带 token 时 OMP 直接报错（discover.ts: 设置 URL 但拿不到 bearer
//    token 就 throw），所以 broker 只算「URL + token 都在」才成立；PI_AUTH_BROKER_URL 在
//    18.10.0 不存在（只读 OMP_*），不作为别名。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
/** 私有 models.yml 的生成标记：有这行 = 本工具所有、可覆盖；没有 = 用户文件，只读不改。 */
export const MEMORY_CONFIG_MARKER =
  "# omp-bot generated — Bot 私有 provider 定义（仅非密传输信息）。删除本行即保留你自己的文件，本工具不再改写。";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** provider 级允许复制的键（其余一律失败关闭）。 */
const PROVIDER_KEYS = new Set(["baseUrl", "api", "auth", "headers", "compat", "transport", "disableStrictTools", "models"]);
/** 模型行允许复制的键。 */
const MODEL_KEYS = new Set([
  "id", "name", "reasoning", "thinking", "contextWindow", "maxTokens", "input",
  "api", "baseUrl", "omitMaxOutputTokens", "supportsTools", "priority", "cost",
]);
const API_VALUES = new Set([
  "openai-completions", "openai-responses", "anthropic-messages", "openai-embeddings",
  "openai-images", "google-generative-ai", "google-vertex", "bedrock",
]);
const AUTH_VALUES = new Set(["none", "apiKey", "oauth"]);
const THINKING_KEYS = new Set(["mode", "efforts"]);
const THINKING_MODES = new Set(["effort", "anthropic-adaptive", "budget"]);
const COST_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite"]);
const IDENT_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

function readBounded(path, max = MAX_SOURCE_BYTES) {
  try {
    const s = readFileSync(path, "utf8");
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return null;
  }
}

/** 用户配置根（OMP 的 yu()：homedir 下的 <PI_CONFIG_DIR|.omp>）。 */
export function configRoot() {
  return join(homedir(), process.env.PI_CONFIG_DIR || ".omp");
}

/** 用户当前生效的全局 agentDir：named profile 优先于 PI_CODING_AGENT_DIR，再落到默认。 */
export function globalAgentDir() {
  const profile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? "").trim();
  if (profile && profile !== "default") return join(configRoot(), "profiles", profile, "agent");
  return process.env.PI_CODING_AGENT_DIR || join(configRoot(), "agent");
}

function indentOf(line) {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}
const isBlank = (l) => l.trim() === "";
const isComment = (l) => l.trimStart().startsWith("#");
function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * `<provider>/<model-id>[:<effort>]` 的显式选择。
 * 没有 provider 前缀就返回 null（失败关闭：不猜 provider，也不 fuzzy match）。
 */
export function splitSelector(model) {
  const raw = typeof model === "string" ? model.trim() : "";
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  return { raw, provider: raw.slice(0, slash), rest: raw.slice(slash + 1) };
}

/** 记忆/配置角色：default + smol + memory 全部钉在选定模型（值用用户原始 selector，含思考档）。 */
export function memoryModelRoles(model) {
  const sel = splitSelector(model);
  if (!sel) return null;
  return { default: sel.raw, smol: sel.raw, memory: sel.raw };
}

// ---------------- 凭据识别（键名按 camelCase 拆词；值是启发式） ----------------

const CRED_COMPOUND = new Set([
  "apikey", "authkey", "authheader", "authheaders", "privatekey", "accesstoken",
  "refreshtoken", "authtoken", "bearertoken", "idtoken", "secretkey", "clientsecret",
  "apisecret", "sessiontoken", "credential", "credentials", "password", "passwd", "pwd",
]);
const CRED_WORDS = new Set([
  "key", "token", "secret", "password", "passwd", "pwd", "credential", "credentials",
  "authorization", "bearer", "cookie",
]);
const COUNT_KEY = /^(?:max|min|input|output|cache|cached|total|reasoning|context|maxoutput)?tokens?(?:limit|budget|count)?$/;
const wordsOf = (key) =>
  String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function isCredentialKey(key) {
  const words = wordsOf(key);
  const joined = words.join("");
  if (COUNT_KEY.test(joined)) return false;
  if (CRED_COMPOUND.has(joined)) return true;
  return words.some((w) => CRED_WORDS.has(w));
}

/** 值层面的启发式：Bearer/Basic、{{模板}}、明显的长随机串都当凭据。 */
function looksLikeCredentialValue(value) {
  const s = String(value ?? "").trim();
  if (!s) return false;
  if (s.startsWith("{{")) return true;
  if (/^(?:bearer|basic|token)\s+\S/i.test(s)) return true;
  // 长随机串：必须大小写+数字混合且不含 `/`（模型 id 这类小写标识符不算）。
  if (/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9_\-+=]{32,}$/.test(s)) return true;
  return false;
}

/** baseUrl 体检：合法 http(s)、不带 userinfo/query/hash（那常是凭据）、给出是否 loopback。 */
function checkEndpoint(url) {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return { ok: false, reason: "baseUrl 为空" };
  let u;
  try {
    u = new URL(raw);
  } catch {
    // 不回显原值：它可能带未校验的 userinfo/query。
    return { ok: false, reason: "baseUrl 不是合法 URL（已省略原值）" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `baseUrl 协议不支持：${u.protocol}` };
  }
  // authority 段判定 userinfo：不依赖 URL 的凭据字段名，只看原文里 scheme 之后的 @。
  const m = raw.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/);
  if (!m || m[1].includes("@")) {
    return { ok: false, reason: "baseUrl 带 userinfo（可能是凭据），拒绝复制" };
  }
  if (u.search || u.hash) {
    return { ok: false, reason: "baseUrl 带 query/hash（可能是凭据），拒绝复制" };
  }
  const host = u.hostname.toLowerCase();
  return { ok: true, url: raw, host, loopback: LOOPBACK_HOSTS.has(host) };
}

// ---------------- YAML 子集解析（失败关闭） ----------------

/**
 * 解析 YAML 子集（失败关闭）：映射、标量列表、list-of-map。
 * 拒绝：引号键、flow 形状（{...}/[...]）、锚点/别名/标签、无法确定的缩进、值里的裸 `: `。
 * @returns {{ok:true, entries:object[]}|{ok:false, reason:string}}
 */
function parseMap(lines, start, end, indent) {
  const entries = [];
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) return { ok: false, reason: "缩进异常（无法确定结构）" };
    const body = line.slice(ind);
    if (body.startsWith("- ") || body === "-") return { ok: false, reason: "意外的列表项（无法确定结构）" };
    const m = body.match(/^([A-Za-z][A-Za-z0-9_.-]*):(.*)$/);
    if (!m) return { ok: false, reason: "存在无法识别的行（可能是引号键/flow map/锚点）" };
    const key = m[1];
    const value = m[2].trim();
    if (value !== "") {
      // flow 序列（如 `efforts: [low, high]`）拆成标量列表；flow map/锚点一律拒绝。
      const flow = value.match(/^\[(.*)\]$/);
      if (flow) {
        const items = flow[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const it of items) {
          if (/[:{}&*!]/.test(it)) return { ok: false, reason: `键「${key}」的 flow 列表项不是纯标量（拒绝复制）` };
        }
        entries.push({ key, value: null, children: null, items, itemMaps: null });
        i++;
        continue;
      }
      const bad = scalarProblem(key, value);
      if (bad) return { ok: false, reason: bad };
      entries.push({ key, value, children: null, items: null, itemMaps: null });
      i++;
      continue;
    }
    // 块状：由第一条更深缩进的行决定是标量列表还是 list-of-map 还是子映射。
    let j = i + 1;
    while (j < end && (isBlank(lines[j]) || isComment(lines[j]))) j++;
    if (j >= end || indentOf(lines[j]) <= ind) {
      entries.push({ key, value: null, children: null, items: null, itemMaps: null });
      i = j;
      continue;
    }
    const childIndent = indentOf(lines[j]);
    if (lines[j].slice(childIndent).startsWith("- ")) {
      const list = parseList(lines, j, end, childIndent);
      if (!list.ok) return { ok: false, reason: `列表「${key}」：${list.reason}` };
      entries.push({ key, value: null, children: null, items: list.items, itemMaps: list.maps });
      i = list.next;
      continue;
    }
    const sub = parseMap(lines, j, end, childIndent);
    if (!sub.ok) return sub;
    entries.push({ key, value: null, children: sub.entries, items: null, itemMaps: null });
    i = sub.next;
  }
  return { ok: true, entries, next: i };
}

/** 值体检：拒绝 flow/锚点/裸 `: `（URL 的 `://` 合法，因为不带空格）。 */
function scalarProblem(key, value) {
  if (value.startsWith("{") || value.startsWith("[") || value.startsWith("&") || value.startsWith("*") || value.startsWith("!")) {
    return `键「${key}」的值是 flow/锚点形状（拒绝复制）`;
  }
  if (value.includes(": ") || value.endsWith(":")) return `键「${key}」的值含裸冒号（歧义）`;
  return null;
}

/**
 * 解析列表：项只能是标量，或 `- key: value` 开头的 list-of-map（模型条目就是这种）。
 * 混合标量与映射、flow 项一律拒绝。映射项的后续键与子结构由 parseMap 按更深缩进吸收。
 */
function parseList(lines, start, end, indent) {
  const items = [];
  const maps = [];
  let kind = null;
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) {
      // 只有映射项允许更深缩进的续行（例如模型条目的 name/thinking/input）。
      if (kind !== "map" || maps.length === 0) return { ok: false, reason: "列表项缩进不一致（拒绝复制）" };
      const sub = parseMap(lines, i, end, ind);
      if (!sub.ok) return sub;
      maps[maps.length - 1].push(...sub.entries);
      i = sub.next;
      continue;
    }
    const body = line.slice(ind);
    if (!body.startsWith("- ")) return { ok: false, reason: "列表里混入了非列表行" };
    const rest = body.slice(2).trim();
    if (!rest) return { ok: false, reason: "列表项为空" };
    const isMapItem = /^[A-Za-z][A-Za-z0-9_.-]*:(\s|$)/.test(rest);
    if (kind === null) kind = isMapItem ? "map" : "scalar";
    if (kind === "scalar" && isMapItem) return { ok: false, reason: "标量列表里混入了映射项" };
    if (kind === "map" && !isMapItem) return { ok: false, reason: "映射列表里混入了标量项" };
    if (kind === "scalar") {
      const bad = scalarProblem("item", rest);
      if (bad) return { ok: false, reason: bad };
      items.push(rest);
      i++;
      continue;
    }
    const m = rest.match(/^([A-Za-z][A-Za-z0-9_.-]*):(.*)$/);
    if (!m) return { ok: false, reason: "映射项缺少键" };
    const first = { key: m[1], value: m[2].trim() || null, children: null, items: null, itemMaps: null };
    if (first.value !== null) {
      const bad = scalarProblem(first.key, first.value);
      if (bad) return { ok: false, reason: bad };
    }
    maps.push([first]);
    i++;
  }
  return { ok: true, items: kind === "scalar" ? items : [], maps: kind === "map" ? maps : [], next: i };
}

/** 从 entries 里取直接子项（不递归）。 */
const childOf = (entries, key) => entries.find((e) => e.key === key) ?? null;

/** 校验 provider 级条目。返回 {ok, stripped[], endpoint?, auth?}。 */
function validateProviderEntry(entry, { allowStrip }) {
  const { key } = entry;
  if (key === "models") return { ok: true, stripped: [] }; // 单独处理
  if (isCredentialKey(key)) {
    if (allowStrip) return { ok: true, stripped: [key] };
    return { ok: false, reason: `provider 级凭据类键「${key}」，拒绝复制` };
  }
  if (!PROVIDER_KEYS.has(key)) {
    return { ok: false, reason: `provider 级未知键「${key}」（白名单外，拒绝复制）` };
  }
  if (key === "baseUrl") {
    const ep = checkEndpoint(unquote(entry.value ?? ""));
    if (!ep.ok) return { ok: false, reason: ep.reason };
    return { ok: true, endpoint: ep, stripped: [] };
  }
  if (key === "api") {
    const v = unquote(entry.value ?? "");
    if (!API_VALUES.has(v)) return { ok: false, reason: `api 值「${v}」不在已知集合内` };
    return { ok: true, stripped: [] };
  }
  if (key === "auth") {
    const v = unquote(entry.value ?? "");
    if (!AUTH_VALUES.has(v)) return { ok: false, reason: `auth 值「${v}」不是 none/apiKey/oauth` };
    return { ok: true, auth: v, stripped: [] };
  }
  if (key === "transport") {
    const v = unquote(entry.value ?? "");
    if (v !== "pi-native") return { ok: false, reason: `transport 值「${v}」不支持` };
    return { ok: true, stripped: [] };
  }
  if (key === "disableStrictTools") {
    const v = unquote(entry.value ?? "");
    if (v !== "true" && v !== "false") return { ok: false, reason: "disableStrictTools 需要布尔值" };
    return { ok: true, stripped: [] };
  }
  if (key === "headers") {
    const stripped = [];
    const kept = { key: "headers", value: null, children: [], items: null, itemMaps: null };
    for (const h of entry.children ?? []) {
      if (!IDENT_RE.test(h.key) || h.children || h.items || h.value === null) {
        return { ok: false, reason: `headers 里有非标量项「${h.key}」（拒绝复制）` };
      }
      const credName = isCredentialKey(h.key);
      const credValue = looksLikeCredentialValue(unquote(h.value));
      if (credName || credValue) {
        if (allowStrip) {
          stripped.push(`headers:${h.key}`);
          continue;
        }
        return { ok: false, reason: `headers 里有凭据类头「${h.key}」，拒绝复制` };
      }
      kept.children.push(h);
    }
    return { ok: true, headers: kept, stripped };
  }
  if (key === "compat") {
    for (const c of entry.children ?? []) {
      if (isCredentialKey(c.key) || looksLikeCredentialValue(unquote(c.value ?? ""))) {
        return { ok: false, reason: `compat 里有凭据类项「${c.key}」，拒绝复制` };
      }
      if (c.children || c.items) return { ok: false, reason: `compat 里「${c.key}」不是标量（拒绝复制）` };
    }
    return { ok: true, compat: entry, stripped: [] };
  }
  return { ok: false, reason: `provider 级键「${key}」未处理（拒绝复制）` };
}

/** 校验单个模型条目（entry = 该 map 项的键值行数组，含 thinking/cost/input 子结构）。 */
function validateModelEntry(entryLines) {
  const id = childOf(entryLines, "id");
  if (!id || id.value === null) return { ok: false, reason: "模型条目缺少同行的 - id:" };
  const modelId = unquote(id.value);
  if (!modelId) return { ok: false, reason: "模型 id 为空" };
  const baseUrls = [];
  for (const c of entryLines) {
    if (!MODEL_KEYS.has(c.key)) return { ok: false, reason: `模型「${modelId}」有白名单外的键「${c.key}」（拒绝复制）` };
    if (isCredentialKey(c.key)) return { ok: false, reason: `模型「${modelId}」有凭据类键「${c.key}」，拒绝复制` };
    if (c.value !== null && looksLikeCredentialValue(unquote(c.value))) {
      return { ok: false, reason: `模型「${modelId}」的「${c.key}」值像凭据，拒绝复制` };
    }
    if (c.key === "baseUrl") {
      const ep = checkEndpoint(unquote(c.value ?? ""));
      if (!ep.ok) return { ok: false, reason: ep.reason };
      baseUrls.push(ep);
    }
    if (c.key === "thinking") {
      for (const t of c.children ?? []) {
        if (!THINKING_KEYS.has(t.key)) return { ok: false, reason: `thinking 有未知键「${t.key}」` };
        if (t.key === "mode") {
          const v = unquote(t.value ?? "");
          if (!THINKING_MODES.has(v)) return { ok: false, reason: `thinking.mode「${v}」不支持` };
        }
        if (t.key === "efforts" && !t.items) return { ok: false, reason: "thinking.efforts 必须是标量列表" };
      }
    }
    if (c.key === "input" && !c.items) return { ok: false, reason: "input 必须是标量列表" };
    if (c.key === "cost") {
      for (const k of c.children ?? []) {
        if (!COST_KEYS.has(k.key)) return { ok: false, reason: `cost 有未知键「${k.key}」` };
        if (!/^\d+(?:\.\d+)?$/.test(unquote(k.value ?? ""))) return { ok: false, reason: `cost.${k.key} 不是数字` };
      }
    }
  }
  return { ok: true, modelId, baseUrls };
}

/** 从 entries 生成规范化 YAML 行。 */
function emitEntries(entries, indent, out) {
  const pad = " ".repeat(indent);
  for (const e of entries) {
    if (e.itemMaps) {
      out.push(`${pad}${e.key}:`);
      const itemPad = `${pad}  `;
      for (const mapLines of e.itemMaps) {
        const first = mapLines[0];
        out.push(`${itemPad}- ${first.key}:${first.value === null ? "" : ` ${first.value}`}`);
        for (const r of mapLines.slice(1)) {
          const keyPad = `${itemPad}  `;
          if (r.items) {
            out.push(`${keyPad}${r.key}:`);
            for (const it of r.items) out.push(`${keyPad}  - ${it}`);
            continue;
          }
          if (r.children) {
            out.push(`${keyPad}${r.key}:`);
            for (const c of r.children) {
              const childPad = `${keyPad}  `;
              if (c.items) {
                out.push(`${childPad}${c.key}:`);
                for (const it of c.items) out.push(`${childPad}  - ${it}`);
                continue;
              }
              if (c.children) {
                out.push(`${childPad}${c.key}:`);
                emitEntries(c.children, keyPad.length + 4, out);
                continue;
              }
              out.push(`${childPad}${c.key}:${c.value === null ? "" : ` ${c.value}`}`);
            }
            continue;
          }
          out.push(`${keyPad}${r.key}:${r.value === null ? "" : ` ${r.value}`}`);
        }
      }
      continue;
    }
    if (e.items) {
      out.push(`${pad}${e.key}:`);
      for (const it of e.items) out.push(`${pad}  - ${it}`);
      continue;
    }
    if (e.children) {
      out.push(`${pad}${e.key}:`);
      emitEntries(e.children, indent + 2, out);
      continue;
    }
    out.push(`${pad}${e.key}:${e.value === null ? "" : ` ${e.value}`}`);
  }
}

/**
 * 取选定 provider 的传输行与选定模型行，按结构白名单校验后重新序列化。
 * @returns {{ok:true, auth:string|null, baseUrl:string|null, providerLines:string[], modelLines:string[],
 *            stripped:string[], endpoint:object}
 *          |{ok:false, reason:string}}
 */
export function extractProvider({ text, provider, modelId, allowStripCredentials = false }) {
  const lines = String(text ?? "").split(/\r?\n/);
  const esc = provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyRe = new RegExp(`^  ${esc}:(\\s*#.*)?$`);
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (keyRe.test(lines[i])) hits.push(i);
  if (hits.length === 0) return { ok: false, reason: `源文件里没有 provider「${provider}」` };
  if (hits.length > 1) return { ok: false, reason: `源文件里 provider「${provider}」出现 ${hits.length} 次（歧义）` };

  const start = hits[0];
  let top = null;
  for (let i = start - 1; i >= 0; i--) {
    const l = lines[i];
    if (isBlank(l) || isComment(l)) continue;
    if (indentOf(l) === 0) {
      top = l.trim();
      break;
    }
  }
  if (top !== "providers:") return { ok: false, reason: `provider「${provider}」不在顶层 providers: 下（歧义）` };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l) || isComment(l)) continue;
    if (indentOf(l) <= 2) {
      end = i;
      break;
    }
  }

  const parsed = parseMap(lines, start + 1, end, 4);
  if (!parsed.ok) return { ok: false, reason: `provider「${provider}」结构无法安全解析：${parsed.reason}` };
  const entries = parsed.entries;

  // 校验 provider 级：未知键/凭据键失败关闭；broker 场景允许剔除凭据键。
  const stripped = [];
  const providerOut = [];
  let auth = null;
  let providerEndpoint = null;
  for (const e of entries) {
    const v = validateProviderEntry(e, { allowStrip: allowStripCredentials });
    if (!v.ok) return { ok: false, reason: `provider「${provider}」：${v.reason}` };
    stripped.push(...(v.stripped ?? []));
    if (v.auth !== undefined) auth = v.auth;
    if (v.endpoint) providerEndpoint = v.endpoint;
    if (v.headers) providerOut.push(v.headers); // 已剔除凭据头的净化副本
    else if (v.compat) providerOut.push(v.compat);
    else if (v.stripped?.length) continue; // 剔除，不复制
    else providerOut.push(e);
  }

  const modelsIdx = entries.findIndex((e) => e.key === "models");
  if (modelsIdx < 0) {
    return { ok: false, reason: `provider「${provider}」没有 models: 列表（无法确定选定模型的传输信息）` };
  }
  const modelEntries = entries[modelsIdx].itemMaps;
  if (!modelEntries || modelEntries.length === 0) {
    return { ok: false, reason: `provider「${provider}」的 models: 不是「- id:」映射列表（拒绝复制）` };
  }
  // 复制用白名单结果：凭据键被剔除，headers 里被剔除的头也不会进入 transportEntries。
  const transportEntries = providerOut.filter((e) => e.key !== "models");

  const matched = [];
  for (const e of modelEntries) {
    const v = validateModelEntry(e);
    if (!v.ok) return { ok: false, reason: `provider「${provider}」：${v.reason}` };
    if (v.modelId === modelId) matched.push({ entry: e, check: v });
  }
  if (matched.length === 0 && modelId.includes(":")) {
    const base = modelId.replace(/:[^:/]+$/, "");
    for (const e of modelEntries) {
      const v = validateModelEntry(e);
      if (!v.ok) return { ok: false, reason: `provider「${provider}」：${v.reason}` };
      if (v.modelId === base) matched.push({ entry: e, check: v });
    }
  }
  if (matched.length === 0) return { ok: false, reason: `provider「${provider}」下没有模型「${modelId}」` };
  if (matched.length > 1) {
    return { ok: false, reason: `provider「${provider}」下模型「${modelId}」出现 ${matched.length} 次（歧义）` };
  }

  // 所有 baseUrl（provider 级 + 模型级）都必须通过校验；有效端点取模型级优先。
  const modelEndpoints = matched[0].check.baseUrls;
  const endpoint = modelEndpoints[0] ?? providerEndpoint;
  if (!endpoint) return { ok: false, reason: "选定模型没有可用的 baseUrl（provider 与模型行都没写）" };

  const providerLines = [];
  emitEntries(transportEntries, 4, providerLines);
  const modelLines = [];
  emitEntries([{ key: "models", value: null, children: null, items: null, itemMaps: [matched[0].entry] }], 4, modelLines);
  // emitEntries 已按 `    models:` + `      - id: ...` 形状生成；去掉 models 行本身，只留条目。
  const modelItemLines = modelLines.slice(1);

  return {
    ok: true,
    auth,
    baseUrl: endpoint.url,
    endpoint,
    providerLines,
    modelLines: modelItemLines,
    stripped,
    modelId: matched[0].check.modelId,
  };
}

function brokerState() {
  const url = (process.env.OMP_AUTH_BROKER_URL ?? "").trim();
  const token =
    (process.env.OMP_AUTH_BROKER_TOKEN ?? "").trim() ||
    (readBounded(join(configRoot(), "auth-broker.token"), 4096) ?? "").trim();
  return { configured: url.length > 0, hasToken: token.length > 0 };
}

/**
 * 解析「选定模型 + 私有目录」的可用来源。私有 models.yml 已存在且不是本工具生成的
 * （无标记）→ 以它为准判定，绝不覆盖用户文件。
 * @returns {{status:object, source?:object}}
 */
function resolvePrivateSource({ model = "", agentDir = null, sourceFile = null } = {}) {
  const broker = brokerState();
  const status = {
    ready: false,
    source: null,
    reason: null,
    model: typeof model === "string" ? model.trim() : "",
    provider: null,
    modelId: null,
    auth: null,
    endpoint: null,
    endpointHost: null,
    loopback: false,
    roles: null,
    agentDir: agentDir ?? null,
    files: agentDir ? { models: join(agentDir, "models.yml") } : null,
    providerSource: null,
    preserved: false,
    stripped: [],
    broker,
  };
  const sel = splitSelector(status.model);
  if (!sel) {
    return { status: { ...status, reason: "需要 <provider>/<model-id> 形式的显式模型（当前为空或缺少 provider 前缀）" } };
  }
  status.provider = sel.provider;
  status.roles = memoryModelRoles(status.model);

  const privateFile = status.files?.models ?? null;
  const existing = privateFile ? readBounded(privateFile) : null;
  const preserved = existing !== null && !existing.startsWith(MEMORY_CONFIG_MARKER);
  const src = sourceFile ?? join(globalAgentDir(), "models.yml");
  const text = preserved ? existing : readBounded(src);
  if (text === null) return { status: { ...status, reason: `读不到 provider 源文件：${src}` } };
  status.providerSource = preserved ? privateFile : src;
  status.preserved = preserved;

  // broker 已配置（哪怕缺 token）就允许剔除凭据行：这样 broker 分支能给出真实原因，
  // 而不是被「块里有 apiKey」提前挡住（见 MEM-GATE-01）。
  const ext = extractProvider({
    text,
    provider: sel.provider,
    modelId: sel.rest,
    allowStripCredentials: broker.configured,
  });
  if (!ext.ok) {
    return {
      status: {
        ...status,
        reason: preserved
          ? `私有 models.yml 已存在但不是本工具生成的，且不能用作选定模型的无凭据源：${ext.reason}`
          : ext.reason,
      },
    };
  }
  status.modelId = ext.modelId;
  status.auth = ext.auth ?? null;
  status.endpoint = ext.endpoint.url;
  status.endpointHost = ext.endpoint.host;
  status.loopback = ext.endpoint.loopback === true;
  status.stripped = ext.stripped;

  const source = { providerLines: ext.providerLines, modelLines: ext.modelLines };

  // 无凭据可用：provider 自己声明 auth: none、端点是 loopback、且块里没有凭据字段。
  if (status.auth === "none" && status.loopback && status.stripped.length === 0) {
    return { status: { ...status, ready: true, source: "native-keyless-loopback" }, source };
  }
  if (broker.configured) {
    if (broker.hasToken) return { status: { ...status, ready: true, source: "native-auth-broker" }, source };
    return {
      status: {
        ...status,
        reason:
          "OMP_AUTH_BROKER_URL 已设置但没有 bearer token（OMP_AUTH_BROKER_TOKEN 或 <configRoot>/auth-broker.token）；" +
          "OMP 会在启动时直接报错，因此失败关闭",
      },
    };
  }
  if (status.stripped.length > 0) {
    return {
      status: {
        ...status,
        reason: `provider「${sel.provider}」的块里有凭据类字段（${status.stripped.join(", ")}）：要么改用 auth: none 的 loopback keyless provider，要么配置带 token 的原生 auth broker`,
      },
    };
  }
  if (status.auth !== "none") {
    return {
      status: {
        ...status,
        reason: `provider「${sel.provider}」未显式声明 auth: none（当前：${status.auth ?? "未声明，默认 apiKey"}），无法无凭据使用`,
      },
    };
  }
  return {
    status: {
      ...status,
      reason: `provider「${sel.provider}」的 baseUrl 不是 loopback（${status.endpoint}），拒绝把远程端点当作私有 keyless 源`,
    },
  };
}

/**
 * Bot 私有记忆的真实前置状态（nonsecret；供 addBot/updateBot 门控、运行时启动与 Features 状态面）。
 * ready 只表示「选定模型能在私有 agentDir 上跑起来」这一件事，不表示记忆文件已存在。
 * @param {{model?:string, agentDir?:string|null, sourceFile?:string|null}} [opts]
 */
export function memoryPrereqStatus({ model = "", agentDir = null, sourceFile = null } = {}) {
  return resolvePrivateSource({ model, agentDir, sourceFile }).status;
}

/**
 * 写私有 <agentDir>/models.yml：只含选定 provider 的非密传输行 + 选定模型行
 * （结构白名单重新序列化，绝不整行照抄源文件）。
 * 私有文件已存在且没有生成标记 → 原样保留（用户文件），只做校验。
 * 失败关闭：前置不满足或写完自校验不过就抛错，绝不静默跑在缺模型的私有目录上。
 */
export function writePrivateMemoryConfig({ agentDir, model, sourceFile = null } = {}) {
  if (typeof agentDir !== "string" || !isAbsolute(agentDir)) {
    throw Object.assign(new Error("私有记忆的 agentDir 必须是绝对路径"), {
      code: "memory_prereq_missing",
      status: 409,
    });
  }
  const { status, source } = resolvePrivateSource({ model, agentDir, sourceFile });
  if (!status.ready) {
    throw Object.assign(new Error(`Bot 私有记忆前置不满足：${status.reason}`), {
      code: "memory_prereq_missing",
      status: 409,
      memory: status,
    });
  }
  if (status.preserved) return { ...status, written: [], preserved: ["models.yml"] };

  const file = status.files.models;
  const body = [
    MEMORY_CONFIG_MARKER,
    "providers:",
    `  ${status.provider}:`,
    ...source.providerLines,
    "    models:",
    ...source.modelLines,
    "",
  ].join("\n");
  mkdirSync(agentDir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, file);

  // 写完自校验：私有文件必须能被同一个提取器读回选定 provider/模型，且不含任何凭据痕迹。
  const written = readBounded(file) ?? "";
  const check = extractProvider({ text: written, provider: status.provider, modelId: status.modelId });
  if (!check.ok) {
    throw Object.assign(new Error(`写入私有 models.yml 后校验失败：${check.reason}`), {
      code: "memory_prereq_missing",
      status: 409,
      memory: status,
    });
  }
  if (check.stripped.length > 0 || /apiKey|authHeader|authorization/i.test(written)) {
    throw Object.assign(new Error("写入私有 models.yml 后仍检测到凭据类字段，拒绝保留该文件"), {
      code: "memory_prereq_missing",
      status: 409,
      memory: status,
    });
  }
  return { ...status, written: ["models.yml"], preserved: [] };
}
