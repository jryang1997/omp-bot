/**
 * 密钥目录硬拦（作为 OMP 扩展的 tool_call 处理器加载，除了聊天档都挂）。
 *
 * 不管哪个档位，工具调用碰到 ~/.ssh、云凭据、OMP 登录库、omp-bot 自己的 token 文件，一律拦下，不弹卡。
 * 01 让 cat/grep/head 在要我同意档直接放行，read 工具本来也不弹卡；没有这一层，
 * `cat ~/.ssh/id_rsa` 和 `cat $OMPBOT_HOME/runtime.json`（服务 token）都能静默读走。
 * OMP 没有原生的敏感目录设置，所以用和 09 同一个 tool_call 扩展。
 *
 * bash 是图灵完备的，这层在全部放手档只是尽力而为；要我同意档里能自动放行的都是不带
 * $ ; | ` ( 的简单命令，参数里的路径在这里都看得见。
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { realish, writeTargets, GUARDED_TOOLS } from "./write-guard.mjs";

const HOME_SECRETS = [
  ".ssh", ".gnupg", ".aws", ".kube", ".azure", ".docker/config.json", ".config/gcloud", ".config/gh",
  ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".omp/agent",
];
/** 不管在哪一层出现都算密钥目录：挡住 `cd ~; cat .ssh/id_rsa` 这类相对路径。 */
const SECRET_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".kube"]);
/** 只交给模型文字、不碰文件系统的工具。电脑工具在虚拟机里，碰不到本机文件。 */
const TEXT_ONLY_TOOLS = new Set(["web_search", "ask", "todo", "task", "resolve"]);
/** 会递归读整棵目录的命令：目标是密钥的上级目录也拦（`grep -r token ~`）。 */
/** 只列文件名的 ls/find/glob 不算：名字不是秘密。 */
const RECURSIVE_READERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "tar", "zip", "rsync", "cp", "scp"]);
const RECURSIVE_TOOLS = new Set(["grep", "ast_grep"]);
const GLOB = /[*?[{]/;
const TOKEN_SPLIT = /[\s"'`;|&<>()=,]+/;
/** 不带路径参数时默认搜 cwd 的递归命令：`grep -rn token`、`rg token`。cp/tar 不给路径什么也不做。 */
const DEFAULT_CWD_SEARCH = /(?:^|[\s;|&(])(?:rg|ag|ack|(?:e|f)?grep\s+(?:[^;|&]*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive))(?=\s|$)/;
/** omp-bot 数据目录里整棵都是凭据的子目录：电脑的 token、control.key、seats.json、文件共享的 SSH 私钥。 */
const OMPBOT_SECRET_DIRS = ["computers"];

/**
 * 启动时算一次要保护的路径。
 * @param {{home?:string, ompbotHome?:string, agentDirs?:string[]}} where
 * @returns {{paths:string[], ompbotHome:string|null}}
 */
export function secretPaths(where = {}) {
  const home = where.home ?? homedir();
  const paths = HOME_SECRETS.map((p) => join(home, p));
  for (const d of where.agentDirs ?? []) if (typeof d === "string" && d) paths.push(d);
  if (where.ompbotHome) for (const d of OMPBOT_SECRET_DIRS) paths.push(join(where.ompbotHome, d));
  return {
    paths: [...new Set(paths.map((p) => realish(resolve(p))))],
    ompbotHome: where.ompbotHome ? realish(resolve(where.ompbotHome)) : null,
  };
}

const within = (root, p) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** omp-bot 数据目录第一层的文件全是服务自己的：runtime.json 带 token，channels/mobile 带渠道密钥。 */
function isOmpbotFile(target, ompbotHome) {
  if (!ompbotHome || !within(ompbotHome, target) || target === ompbotHome) return false;
  const rest = target.slice(ompbotHome.length + 1);
  return !rest.includes(sep) && !isDir(target);
}

function expand(raw, ctx) {
  let p = raw;
  if (p.startsWith("file:")) {
    try { p = fileURLToPath(p); } catch { return null; }
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(p)) {
    return null;
  }
  p = p.replace(/\$\{?(HOME|OMPBOT_HOME|PI_CODING_AGENT_DIR)\}?/g, (_, k) => ctx.env[k] ?? `$${k}`);
  if (p === "~") p = ctx.home;
  else if (p.startsWith("~/")) p = join(ctx.home, p.slice(2));
  return p;
}

/** 一个路径（或带通配的路径）是不是落在密钥里。ancestors=true 时，密钥的上级目录也算。 */
function hits(raw, ctx, ancestors) {
  const p = expand(raw, ctx);
  if (p === null || !p) return false;
  if (p.split(/[\\/]/).some((seg) => SECRET_SEGMENTS.has(seg))) return true;
  const abs = isAbsolute(p) ? p : join(ctx.cwd, p);
  const g = abs.search(GLOB);
  if (g >= 0) {
    // 通配：取到第一个通配符所在段之前的目录，剩下的半截名字当前缀比。
    const head = abs.slice(0, g);
    const cut = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
    const dir = realish(resolve(head.slice(0, cut + 1) || "/"));
    const partial = head.slice(cut + 1);
    const prefix = dir.endsWith(sep) ? dir + partial : dir + sep + partial;
    const reachable = (secret) => {
      if (!secret.startsWith(prefix)) return false;
      // shell 的 * ? 不匹配开头的点：~/* 碰不到 ~/.ssh。
      const next = secret.slice(dir.length).replace(/^[\\/]/, "");
      return partial.startsWith(".") || !next.startsWith(".");
    };
    if (ctx.secrets.paths.some(reachable)) return true;
    if (ctx.secrets.ompbotHome && (dir === ctx.secrets.ompbotHome || reachable(ctx.secrets.ompbotHome))) return true;
    return false;
  }
  const target = realish(resolve(abs));
  if (ctx.secrets.paths.some((s) => within(s, target))) return true;
  if (isOmpbotFile(target, ctx.secrets.ompbotHome)) return true;
  if (ancestors) {
    const all = [...ctx.secrets.paths, ...(ctx.secrets.ompbotHome ? [ctx.secrets.ompbotHome] : [])];
    if (all.some((s) => within(target, s))) return true;
  }
  return false;
}

function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

/**
 * 按分隔符拆开会把带空格的路径拆碎（/home/John Doe/.netrc）。
 * 别的工具的参数整串就可能是路径；bash 里补上引号里的整段和 `\ ` 转义的整段。
 */
function wholePaths(s, bash) {
  if (!bash) return [s.trim()];
  const out = [];
  for (const m of s.matchAll(/"([^"]+)"|'([^']+)'/g)) out.push(m[1] ?? m[2]);
  if (s.includes("\\ ")) for (const t of s.split(/(?<!\\)\s+/)) if (t.includes("\\ ")) out.push(t.replace(/\\ /g, " "));
  return out;
}

/** 这次调用碰到的密钥路径（原样）。空数组就放行。 */
export function secretHits(toolName, input, opts) {
  if (TEXT_ONLY_TOOLS.has(toolName) || toolName.startsWith("computer")) return [];
  const ctx = {
    cwd: opts.cwd || process.cwd(),
    home: opts.home ?? homedir(),
    env: opts.env ?? process.env,
    secrets: opts.secrets,
  };
  if (GUARDED_TOOLS.includes(toolName)) {
    // 写类工具只看目标路径，正文里写到 ~/.ssh 的文档不算。
    return writeTargets(toolName, input).paths.filter((p) => hits(p, ctx, false));
  }
  const bash = toolName === "bash";
  const tokens = strings(input).flatMap((s) => [...s.split(TOKEN_SPLIT), ...wholePaths(s, bash)]).filter(Boolean);
  const ancestors = RECURSIVE_TOOLS.has(toolName) || (bash && tokens.some((t) => RECURSIVE_READERS.has(t)));
  // 不给 path 就搜 cwd
  if (RECURSIVE_TOOLS.has(toolName) || (bash && strings(input).some((s) => DEFAULT_CWD_SEARCH.test(s)))) tokens.push(".");
  return [...new Set(tokens.filter((t) => hits(t, ctx, ancestors)))];
}

/** OMP 扩展的 tool_call 处理器。返回 undefined 放行，{block, reason} 拦下。 */
export function secretToolCall(event, opts) {
  if (!event?.toolName || !opts?.secrets) return undefined;
  const found = secretHits(event.toolName, event.input, opts);
  if (!found.length) return undefined;
  return {
    block: true,
    reason: `没执行。${found.join("、")} 是密钥或凭据，助手在任何档位都不读不写。` +
      "这是硬规矩，不要换个写法再试；真需要就告诉主人，让主人自己操作。",
  };
}
