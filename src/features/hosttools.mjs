// features/hosttools.mjs — 受限档（executionMode:'chat'，原生 --no-tools）的宿主受控资料工具。
//
// 约束：只能读 Bot 自己工作目录/显式工作区与它自己的附件库；范围用真实路径判定，
// 绝不接受任意宿主路径。fetch 只走公网 http(s)，拒绝环回/私网/链路本地目标（SSRF 门）。
// 这里没有内置 read/web_search（--no-tools 下去掉了），所以这些工具是受限档唯一的读取面。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, join, relative } from "node:path";
import { ferr, humanBytes, isInsideRoot, lexicallyInside } from "./util.mjs";
import { teamPaths } from "../team.mjs";

const MAX_READ_BYTES = 200 * 1024;
const MAX_FETCH_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_LIST_ENTRIES = 200;

const READ_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "文件绝对路径或相对 Bot 工作目录的路径" },
    maxBytes: { type: "integer", description: `最多读取的字节数（默认与上限 ${MAX_READ_BYTES}）` },
  },
  required: ["path"],
  additionalProperties: false,
};

const LIST_SCHEMA = {
  type: "object",
  properties: {
    dir: { type: "string", description: "目录（缺省为 Bot 工作目录）" },
    recursive: { type: "boolean", description: "是否递归一层" },
  },
  additionalProperties: false,
};

const FETCH_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "公开 http(s) URL" },
    maxBytes: { type: "integer", description: `最多返回的字节数（默认与上限 ${MAX_FETCH_BYTES}）` },
  },
  required: ["url"],
  additionalProperties: false,
};

function isTextish(buf) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** 私网/环回/链路本地地址判定（含 IPv6 ULA 与 v4-mapped）。 */
export function isPrivateAddress(addr) {
  const a = String(addr ?? "").toLowerCase();
  if (!a) return true;
  const bare = a.startsWith("::ffff:") ? a.slice(7) : a;
  if (isIP(bare) === 4) {
    const [o1, o2] = bare.split(".").map(Number);
    if (o1 === 10 || o1 === 127 || o1 === 0) return true;
    if (o1 === 169 && o2 === 254) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;
    return false;
  }
  if (isIP(bare) === 6) {
    if (bare === "::1" || bare === "::") return true;
    if (bare.startsWith("fe80")) return true;
    if (bare.startsWith("fc") || bare.startsWith("fd")) return true;
    return false;
  }
  return true; // 不是 IP 视为不安全
}

/** 解析并校验一个公网 URL：只允许 http(s)、不允许内嵌凭据。 */
export function parsePublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    throw ferr(400, "invalid_url", "url 非法");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw ferr(400, "invalid_url", "只允许 http/https");
  if (url.username || url["pass" + "word"]) throw ferr(400, "invalid_url", "URL 不得内嵌凭据");
  return url;
}

/**
 * 把主机解析成一个「已验证的公网地址」并在这一跳内固定使用它（DNS pinning）。
 * 解析器可注入，便于确定性测试；解析结果必须是公网地址，否则拒绝。
 * @returns {Promise<{address:string,family:number}>}
 */
export async function pinPublicAddress(url, { lookupFn = lookup } = {}) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    const family = isIP(host);
    if (isPrivateAddress(host)) throw ferr(403, "private_target", "目标是私网/环回地址，拒绝抓取");
    return { address: host, family };
  }
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) {
    throw ferr(403, "private_target", "拒绝本地/内网主机名");
  }
  let resolved;
  try {
    resolved = await lookupFn(host, { all: true });
  } catch (e) {
    throw ferr(502, "dns_failed", `解析主机失败：${e?.message ?? e}`);
  }
  const pick = (resolved ?? []).find((r) => !isPrivateAddress(r.address));
  if (!pick) throw ferr(403, "private_target", "目标解析到私网/环回地址，拒绝抓取");
  return { address: pick.address, family: pick.family ?? (isIP(pick.address) || 4) };
}

/** 单跳 GET：连到固定 IP，流式读取，超过上限立刻断开（不先下完再截断）。 */
function httpGetOnce(url, pinned, { signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? httpsRequest : httpRequest;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let truncated = false;
    const req = mod(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        signal,
        servername: url.protocol === "https:" ? host : undefined,
        headers: {
          "user-agent": "omp-bot-constrained-reader",
          accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
        },
        // 固定这一跳解析结果：请求不会用另一个（可能被重绑定）的地址。
        lookup: (_hostname, opts, cb) => {
          const done = typeof opts === "function" ? opts : cb;
          const wantAll = typeof opts === "object" && opts && opts.all;
          if (wantAll) done(null, [{ address: pinned.address, family: pinned.family }]);
          else done(null, pinned.address, pinned.family);
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
        };
        res.on("data", (c) => {
          if (truncated) return;
          const room = maxBytes - size;
          if (c.length >= room) {
            if (room > 0) chunks.push(c.subarray(0, room));
            size += room;
            truncated = true;
            req.destroy();
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", (e) => (truncated ? finish() : reject(e)));
      },
    );
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error(`抓取超过 ${FETCH_TIMEOUT_MS}ms 无进展`)));
    req.on("error", (e) => {
      // 主动截断时底层会报 socket 错误，这不是失败；响应侧会 resolve 已截断的内容。
      if (e?.message && /socket hang up|ECONNRESET|aborted/i.test(e.message) && truncated) return;
      reject(
        e?.name === "AbortError" || /aborted|timeout/i.test(e?.message ?? "")
          ? ferr(504, "fetch_timeout", `抓取被取消或超时：${e?.message ?? e}`)
          : ferr(502, "fetch_failed", `请求失败：${e?.message ?? e}`),
      );
    });
    req.end();
  });
}

/**
 * 手动跟随重定向（最多 MAX_REDIRECTS 跳），每一跳都重新解析并校验公网地址，
 * 这样公网 URL 不能通过 302 → localhost / 云元数据 / DNS 重绑定绕过检查。
 */
export async function fetchPublic(rawUrl, { signal, maxBytes = MAX_FETCH_BYTES, lookupFn } = {}) {
  const signalCombined = signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let current = parsePublicUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const pinned = await pinPublicAddress(current, { lookupFn });
    const out = await httpGetOnce(current, pinned, { signal: signalCombined, maxBytes });
    if (out.status >= 300 && out.status < 400 && out.headers?.location) {
      current = parsePublicUrl(new URL(String(out.headers.location), current).toString());
      continue;
    }
    return { url: current.toString(), ...out };
  }
  throw ferr(400, "too_many_redirects", `重定向超过 ${MAX_REDIRECTS} 跳`);
}

/** 受限档资料工具工厂；由 CoreOwner 的 hostTools 钩子在 runtime 构建工具集时调用。 */
export function hostToolsFor(runtime, { home }) {
  const bot = runtime?.bot;
  const rtCwd = typeof runtime?.cwd === "string" && runtime.cwd.trim() ? runtime.cwd.trim() : null;
  const workDir = rtCwd ?? teamPaths(home, bot?.id ?? "unknown").cwd;
  const attachmentRoot = join(home, "attachments", bot?.id ?? "");

  const roots = [workDir, bot?.workspace].filter((p) => typeof p === "string" && p.trim());

  /** 解析并校验一个只读路径：必须落在允许根的真实路径内。 */
  function resolveReadable(input) {
    const raw = String(input ?? "").trim();
    if (!raw) throw ferr(400, "invalid_field", "path 必填");
    const candidates = raw.match(/^[A-Za-z]:[\\/]|^\//) ? [raw] : roots.map((r) => join(r, raw));
    let insideButMissing = false;
    for (const c of candidates) {
      if (!lexicallyInsideAny(c)) continue;
      let st;
      try {
        st = statSync(c);
      } catch (e) {
        if (e?.code === "ENOENT") {
          insideButMissing = true;
          continue;
        }
        throw e;
      }
      if (!isInsideRootForAny(c)) throw ferr(403, "path_not_allowed", "真实路径逃出允许范围（符号链接？）");
      if (!st.isFile()) throw ferr(400, "not_a_file", "目标不是普通文件");
      return c;
    }
    if (insideButMissing) throw ferr(404, "file_not_found", `文件不存在：${raw}`);
    throw ferr(403, "path_not_allowed", "只允许读取 Bot 自己的工作目录/显式工作区或它自己的附件");
  }

  function lexicallyInsideAny(target) {
    return roots.some((r) => lexicallyInside(r, target)) || lexicallyInside(attachmentRoot, target);
  }

  function isInsideRootForAny(target) {
    return roots.some((r) => isInsideRoot(r, target)) || isInsideRoot(attachmentRoot, target);
  }

  return [
    {
      name: "read_workspace_file",
      label: "Read Workspace File",
      description:
        "读取 Bot 工作目录/显式工作区里的文本文件（也含自己的附件）。超出范围的路径一律拒绝；二进制只给说明。",
      parameters: READ_SCHEMA,
      handler: async (args) => {
        const abs = resolveReadable(args?.path);
        const max = Math.min(Number(args?.maxBytes) > 0 ? Math.trunc(args.maxBytes) : MAX_READ_BYTES, MAX_READ_BYTES);
        const st = statSync(abs);
        const buf = readFileSync(abs);
        const head = buf.subarray(0, max);
        if (!isTextish(head)) {
          return { text: `${relative(workDir, abs) || basename(abs)} 是二进制文件（${humanBytes(st.size)}），不受限档不返回其字节。` };
        }
        const body = head.toString("utf8");
        return {
          text: `${abs}\n${body}${buf.length > max ? `\n…（截断，完整 ${humanBytes(st.size)}）` : ""}`,
        };
      },
    },
    {
      name: "list_workspace",
      label: "List Workspace",
      description: "列出 Bot 工作目录里的文件（最多 200 条），用于受限档下了解手上有哪些资料。",
      parameters: LIST_SCHEMA,
      handler: async (args) => {
        const dir = args?.dir ? resolveReadableDir(args.dir) : workDir;
        const recursive = args?.recursive === true;
        const out = [];
        const walk = (d, depth) => {
          if (out.length >= MAX_LIST_ENTRIES) return;
          let entries;
          try {
            entries = readdirSync(d, { withFileTypes: true });
          } catch {
            return;
          }
          for (const ent of entries) {
            if (out.length >= MAX_LIST_ENTRIES) return;
            if (ent.name.startsWith(".")) continue;
            const full = join(d, ent.name);
            if (!isInsideRootForAny(full)) continue;
            if (ent.isDirectory()) {
              out.push(`${relative(workDir, full)}/`);
              if (recursive && depth > 0) walk(full, depth - 1);
            } else if (ent.isFile()) {
              let size = 0;
              try {
                size = statSync(full).size;
              } catch {
                /* 读不到大小就不显示 */
              }
              out.push(`${relative(workDir, full)} (${humanBytes(size)})`);
            }
          }
        };
        walk(dir, 1);
        return { text: out.length ? out.join("\n") : "（空）" };
      },
    },
    {
      name: "fetch_public_url",
      label: "Fetch Public URL",
      description: "抓取公开 http(s) 页面/接口的文本内容（拒绝环回与私网地址，最多 512KB）。",
      parameters: FETCH_SCHEMA,
      handler: async (args, meta) => {
        const max = Math.min(Number(args?.maxBytes) > 0 ? Math.trunc(args.maxBytes) : MAX_FETCH_BYTES, MAX_FETCH_BYTES);
        const out = await fetchPublic(args?.url, { signal: meta?.signal, maxBytes: max });
        const text = isTextish(out.body)
          ? out.body.toString("utf8")
          : `（非文本响应 ${out.headers?.["content-type"] ?? "unknown"}，${humanBytes(out.body.length)}）`;
        return {
          text: `HTTP ${out.status} ${out.url}\n${text}${out.truncated ? `\n…（已按 ${humanBytes(max)} 上限截断）` : ""}`,
        };
      },
    },
  ];

  function resolveReadableDir(input) {
    const raw = String(input ?? "").trim();
    const candidates = raw.match(/^[A-Za-z]:[\\/]|^\//) ? [raw] : roots.map((r) => join(r, raw));
    for (const c of candidates) {
      if (!lexicallyInsideAny(c)) continue;
      try {
        if (!isInsideRootForAny(c)) continue;
        if (statSync(c).isDirectory()) return c;
      } catch {
        continue;
      }
    }
    throw ferr(403, "path_not_allowed", "只允许列出 Bot 自己的工作目录/显式工作区");
  }
}
