/**
 * 要我同意档的写文件边界（作为 OMP 扩展的 tool_call 处理器加载）。
 *
 * OMP 的 write 档会直接放行 write/edit/ast_edit，不看路径在哪。这里补一条：
 * 目标在 bot 自己的目录、工作区、系统临时目录以外，就先弹一张「要我同意」卡，
 * 主人同意才写；看不出要写哪儿也弹卡。处理器出错时 OMP 按拦截处理（失败即关）。
 * 只在 supervised + write 档生效；全部放手档按用户选择不拦，chat 档本来就没有写工具。
 * 和密钥硬拦（secret-guard.mjs）挂在同一个扩展里，扩展源码由 persona.mjs 生成。
 */
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const GUARDED_TOOLS = Object.freeze(["write", "edit", "ast_edit"]);

const HASHLINE_HEADER = /^\[([^#\r\n]+)#[0-9A-Fa-f]{4}\]\s*$/;
const LINE_PATTERNS = [
  HASHLINE_HEADER,
  /^MV\s+(.+)$/i,
  /^\*\*\*\s*(?:Add|Update|Delete)\s+File:\s*(.+)$/i,
  /^\*\*\*\s*Move\s+to:\s*(.+)$/i,
];
const SLOPPY_HEADER = /^\*\*\*\s*Edit\s+File:(.*)$/i;
// 两个字母以上的 scheme 才算内部 URL（local:// 之类由 OMP 自己管落点），C:\ 这种盘符不算。
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;

function unwrapHashline(path) {
  const m = HASHLINE_HEADER.exec(path.trim());
  return m ? m[1].trim() : path;
}

/** 从 edit 的整段文本（hashline / apply_patch / sloppy）里抠出所有要写的文件。正文行以 + 开头，锚定的正则自然不中。 */
function pathsFromPatchText(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trimStart();
    let hit = null;
    for (const re of LINE_PATTERNS) {
      const m = re.exec(line);
      if (m) { hit = m[1]; break; }
    }
    if (hit === null) {
      const m = SLOPPY_HEADER.exec(line);
      if (m) hit = m[1].trim().replace(/\s+all$/i, "");
    }
    if (hit !== null && hit.trim()) out.push(hit.trim());
  }
  return out;
}

/** 把 ast_edit 的 glob 截到第一个通配符前，剩下的前缀就是它可能写到的最外层。 */
function globBase(pattern) {
  const i = pattern.search(/[*?[{]/);
  return i < 0 ? pattern : pattern.slice(0, i);
}

/**
 * 这次工具调用要写的路径（原样，未解析）。
 * @returns {{paths: string[], unknown: boolean}} unknown=true 表示带了写入内容却看不出写哪儿
 */
export function writeTargets(toolName, input) {
  const args = input && typeof input === "object" ? input : {};
  const paths = [];
  if (toolName === "write") {
    if (typeof args.path !== "string" || !args.path.trim()) return { paths, unknown: true };
    paths.push(unwrapHashline(args.path));
    return { paths, unknown: false };
  }
  if (toolName === "ast_edit") {
    // 没给 paths 就是在 cwd 里改，不用拦。
    for (const p of Array.isArray(args.paths) ? args.paths : []) {
      if (typeof p !== "string") return { paths, unknown: true };
      paths.push(globBase(p) || ".");
    }
    return { paths, unknown: false };
  }
  if (toolName === "edit") {
    if (typeof args.path === "string" && args.path.trim()) paths.push(unwrapHashline(args.path));
    for (const e of Array.isArray(args.edits) ? args.edits : []) {
      if (e && typeof e.rename === "string" && e.rename.trim()) paths.push(e.rename);
    }
    if (typeof args.input === "string") paths.push(...pathsFromPatchText(args.input));
    return { paths, unknown: paths.length === 0 };
  }
  return { paths, unknown: false };
}

/** 解析符号链接：取最近一个存在的上级做 realpath，再接回剩下的部分。 */
export function realish(path) {
  let head = path;
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      tail.push(basename(head));
      head = parent;
    }
  }
}

function normalizeFsPath(raw, cwd, home) {
  let p = raw.trim();
  if (p.startsWith("file:")) {
    try { p = fileURLToPath(p); } catch { return null; }
  } else if (URL_SCHEME.test(p)) {
    return undefined; // 内部 URL：不归这里管
  }
  if (p === "~") p = home;
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = join(home, p.slice(2));
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  return realish(resolve(abs));
}

function inside(root, target) {
  const a = process.platform === "win32" ? root.toLowerCase() : root;
  const b = process.platform === "win32" ? target.toLowerCase() : target;
  const rel = relative(a, b);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 判一次调用：哪些目标落在允许的根以外。
 * @param {{cwd:string, roots?:string[], home?:string, tmp?:string}} opts
 */
export function checkWrite(toolName, input, opts) {
  const cwd = opts.cwd;
  const home = opts.home ?? homedir();
  const roots = [cwd, ...(opts.roots ?? []), opts.tmp ?? tmpdir()]
    .filter((r) => typeof r === "string" && r)
    .map((r) => realish(resolve(r)));
  const { paths, unknown } = writeTargets(toolName, input);
  const outside = [];
  for (const raw of paths) {
    const target = normalizeFsPath(raw, cwd, home);
    if (target === undefined) continue;
    if (target === null || !roots.some((root) => inside(root, target))) outside.push(target ?? raw);
  }
  return { outside, unknown };
}

const MAX_DETAIL = 1500;

/** OMP 扩展的 tool_call 处理器本体。返回 undefined 放行，{block, reason} 拦下。 */
export async function guardToolCall(event, ctx, opts = {}) {
  if (!event || !GUARDED_TOOLS.includes(event.toolName)) return undefined;
  const cwd = opts.cwd || ctx?.cwd || process.cwd();
  const { outside, unknown } = checkWrite(event.toolName, event.input, { ...opts, cwd });
  if (!unknown && outside.length === 0) return undefined;

  const what = unknown
    ? `看不出 ${event.toolName} 要改哪个文件。\n${JSON.stringify(event.input ?? {}).slice(0, MAX_DETAIL)}`
    : `${event.toolName} 要改助手目录和工作区以外的文件：\n${outside.join("\n")}`;
  const denied = {
    block: true,
    reason: `没写。${unknown ? "看不出要改哪个文件" : `目标在允许范围外：${outside.join("、")}`}。` +
      "要我同意档只能直接改自己的目录、工作区和临时目录；别的位置需要主人同意。",
  };
  if (!ctx?.hasUI || typeof ctx.ui?.confirm !== "function") return denied;
  const ok = await ctx.ui.confirm("允许改目录外的文件？", what);
  return ok === true ? undefined : denied;
}
