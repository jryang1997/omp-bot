// features/util.mjs — 特性层的共享工具：错误、路径边界、文本与文件遍历。
// 只放无状态纯函数；写盘/网络动作都在各模块内，便于测试。

import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  existsSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

/** 带 HTTP 语义的特性层错误。status 供 handleRequest 直接映射。 */
export function ferr(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}

export function isFeatureError(e) {
  return !!e && typeof e.status === "number" && typeof e.code === "string";
}

export function intArg(value, { min, max, dflt }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  const i = Math.trunc(n);
  if (min != null && i < min) return min;
  if (max != null && i > max) return max;
  return i;
}

export function requireString(value, field, { max = 4000, min = 1 } = {}) {
  const s = typeof value === "string" ? value : "";
  if (s.length < min) throw ferr(400, "invalid_field", `${field} 必填且为非空字符串`);
  if (s.length > max) throw ferr(400, "invalid_field", `${field} 超长（>${max}）`);
  return s;
}

/**
 * 真实路径是否落在 root 内（防符号链接与 `..` 逃逸）。
 * 任一侧不存在时返回 false —— 调用方必须先确保文件存在。
 */
export function isInsideRoot(root, target) {
  if (!root || !target) return false;
  try {
    const r = realpathSync(root);
    const t = realpathSync(target);
    const rel = relative(r, t);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}

/** 词法范围检查（不要求存在）；写盘前先用它挡一次，落盘后再按真实路径复查。 */
export function lexicallyInside(root, target) {
  const r = normalize(root);
  const t = normalize(target);
  const rel = relative(r, t);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 把紧凑相对路径 `a/b/c` 拼进 root，并拒绝绝对路径、空段与 `..` 逃逸。
 */
export function resolveInside(root, relPath) {
  const rel = String(relPath ?? "").replace(/\\/g, "/");
  if (!rel || isAbsolute(rel) || rel.split("/").some((s) => s === ".." || s === "")) {
    throw ferr(400, "invalid_path", `非法相对路径 ${JSON.stringify(relPath)}`);
  }
  const target = join(root, ...rel.split("/"));
  if (!lexicallyInside(root, target)) throw ferr(400, "path_escape", `路径越界：${relPath}`);
  return target;
}

/** 文件名规范化：只留 basename，拒绝控制字符、Windows 保留字符与保留名。 */
export function canonicalFilename(name) {
  const raw = typeof name === "string" ? name : "";
  const flat = raw.replace(/[\\/]/g, "/");
  const base = flat.slice(flat.lastIndexOf("/") + 1).trim();
  if (!base || base === "." || base === "..") throw ferr(400, "invalid_filename", "文件名不合法");
  if (/[\u0000-\u001f\u007f]/.test(base)) throw ferr(400, "invalid_filename", "文件名含控制字符");
  if (/[<>:"|?*]/.test(base)) throw ferr(400, "invalid_filename", "文件名含 Windows 保留字符");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(base)) {
    throw ferr(400, "invalid_filename", "文件名是系统保留名");
  }
  if (base.length > 200) throw ferr(400, "invalid_filename", "文件名超长（>200）");
  return base;
}

export function extOf(filename) {
  const i = filename.lastIndexOf(".");
  return i <= 0 ? "" : filename.slice(i).toLowerCase();
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 时间倒序（不依赖 SQLite 返回顺序）。 */
export function byCreatedDesc(a, b) {
  return Number(b?.createdAt ?? 0) - Number(a?.createdAt ?? 0);
}

/** 可读字节数（回执与错误信息用）。 */
export function humanBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 递归收集 root 下的普通文件；跳过排除目录，不跟随符号链接。 */
export function walkFiles(root, { skipDirs = new Set(), maxFiles = 20000 } = {}) {
  const out = [];
  const stack = [root];
  const seenDirs = new Set();
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      out.push(full);
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

/** 文件快照条目 {hash,size,mtimeMs}；读不到返回 null。 */
export function fileEntry(path) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { hash: sha256Hex(readFileSync(path)), size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

export function safeReadJson(path, code = "config_unreadable") {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw ferr(409, code, `${path} 不是合法 JSON：${e?.message ?? e}`);
  }
}

export function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

export { dirname, isAbsolute, join, normalize, relative, sep };
