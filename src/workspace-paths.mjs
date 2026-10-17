// src/workspace-paths.mjs — 设了工作区时，把工具调用里的相对路径落到工作区。
// OMP 的 cwd 是 bot 自己的目录（这样才读得到团队层、身份层 AGENTS.md 和私有 .omp/），工作区靠 --add-dir 加进来。
// 真模型会直接写 `sum.js`、跑 `node sum.js`，人格里怎么说都照样落进 bot 目录；所以在 tool_call 里改参数。
// 绝对路径、~、内部 URL（xd://、local://）不动。eval 的代码里的相对路径管不到。
import { isAbsolute, join } from "node:path";

const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;
const HASHLINE = /^(\[)([^#\r\n]+)(#[0-9A-Fa-f]{4}\])$/;
// edit 补丁文本里写文件路径的行（和 write-guard 认的同一批格式）。
const PATCH_LINES = [
  /^(\s*\[)([^#\r\n]+)(#[0-9A-Fa-f]{4}\]\s*)$/,
  /^(\s*MV\s+)(.+?)(\s*)$/i,
  /^(\s*\*\*\*\s*(?:Add|Update|Delete)\s+File:\s*)(.+?)(\s*)$/i,
  /^(\s*\*\*\*\s*Move\s+to:\s*)(.+?)(\s*)$/i,
  /^(\s*\*\*\*\s*Edit\s+File:\s*)(.+?)(\s+all)?(\s*)$/i,
];
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "glob", "find", "ast_grep", "ast_edit", "ls"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "find", "ast_grep"]);

function relative(p) {
  if (typeof p !== "string") return false;
  const s = p.trim();
  return !!s && !isAbsolute(s) && s !== "~" && !s.startsWith("~/") && !s.startsWith("~\\") && !URL_SCHEME.test(s);
}

function rebase(p, ws) {
  const s = p.trim();
  const m = HASHLINE.exec(s);
  if (m) return relative(m[2]) ? `${m[1]}${join(ws, m[2].trim())}${m[3]}` : p;
  return relative(s) ? join(ws, s) : p;
}

function rebasePatch(text, ws) {
  return text.split("\n").map((line) => {
    for (const re of PATCH_LINES) {
      const m = re.exec(line);
      if (!m) continue;
      const [, head, path, ...tail] = m;
      const q = path.trim().replace(/^"(.*)"$/, "$1");
      return relative(q) ? head + (path.trim().startsWith('"') ? `"${join(ws, q)}"` : join(ws, q)) + tail.filter(Boolean).join("") : line;
    }
    return line;
  }).join("\n");
}

/**
 * @returns {object|null} 改过的 input；不用改返回 null
 */
export function toWorkspace(toolName, input, workspace) {
  if (!workspace || !input || typeof input !== "object") return null;
  const next = { ...input };
  if (toolName === "bash") {
    if (next.cwd === undefined || next.cwd === null || next.cwd === "") next.cwd = workspace;
    else if (relative(next.cwd)) next.cwd = join(workspace, next.cwd.trim());
  } else if (PATH_TOOLS.has(toolName)) {
    if (relative(next.path)) next.path = rebase(next.path, workspace);
    else if (next.path === undefined && SEARCH_TOOLS.has(toolName)) next.path = workspace;
    if (Array.isArray(next.paths)) next.paths = next.paths.map((p) => (relative(p) ? join(workspace, p.trim()) : p));
    if (toolName === "edit") {
      if (typeof next.input === "string") next.input = rebasePatch(next.input, workspace);
      if (Array.isArray(next.edits)) next.edits = next.edits.map((e) => (e && relative(e.rename) ? { ...e, rename: join(workspace, e.rename.trim()) } : e));
    }
  } else {
    return null;
  }
  return JSON.stringify(next) === JSON.stringify(input) ? null : next;
}

/**
 * OMP 每轮在用户消息前注入「current working directory: '<cwd>'」，模型认这句（context 钩子之后才加，所以改请求体）。
 * 设了工作区就把这句里的 bot 目录换成工作区，和上面的路径改写对齐。只换这一句，不认各家请求体的格式。
 * @returns {unknown} 改过的请求体；不用改返回 undefined
 */
export function payloadToWorkspace(payload, cwd, workspace) {
  if (!workspace || !cwd) return undefined;
  const from = `current working directory: '${cwd}'`;
  const to = `current working directory: '${workspace}'`;
  let changed = false;
  const walk = (v) => {
    if (typeof v === "string") {
      if (!v.includes(from)) return v;
      changed = true;
      return v.split(from).join(to);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  const out = walk(payload);
  return changed ? out : undefined;
}
