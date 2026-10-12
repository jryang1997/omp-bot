// features/attachments.mjs — 用户资料的接收、规范化与入原生回合的物化。
//
// 边界：
// - 每个附件属于一个 Bot（botId 必填且必须是花名册里的真实 Bot）；跨 Bot 引用一律拒绝。
// - 只接受 JSON base64 上送，落盘位置由本模块决定（<home>/attachments/<botId>/<id>/<filename>），
//   调用方给的 path 字段一律忽略 —— 没有任意宿主文件入口。
// - mime 以魔数嗅探为准，声明的 mime 与扩展名必须与之相容，否则拒绝（防混淆类型）。
// - 图片走原生 prompt.images（ImageContent）；文档把规范绝对路径交给 OMP 原生 read 读取，原文保留。

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { genId } from "../domain.mjs";
import {
  byCreatedDesc,
  canonicalFilename,
  clone,
  extOf,
  ferr,
  humanBytes,
  isInsideRoot,
  sha256Hex,
} from "./util.mjs";

/** 单个附件解码后的大小上限（服务端 MAX_BODY=32MiB 给 base64 留足余量）。 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/** 允许显式声明的 mime 及其规范扩展名。 */
const MIME_EXT = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
  "text/plain": [".txt", ".log", ".md"],
  "text/markdown": [".md", ".markdown"],
  "text/csv": [".csv"],
  "application/json": [".json"],
  "application/zip": [".zip"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
};

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ZIP_CONTAINER_MIMES = new Set([
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

/** 魔数嗅探：返回嗅到的 mime 或 null。 */
export function sniffMime(buf) {
  const b = buf;
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b.subarray(0, 6).toString("latin1").match(/^GIF8[79]a$/)) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "application/zip";
  return null;
}

function looksLikeUtf8Text(buf) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** 声明 mime / 扩展名 / 魔数三者是否自洽；不自洽时抛 400。 */
export function assertMimeConsistent({ mime, filename, buf }) {
  if (!MIME_EXT[mime]) {
    throw ferr(400, "unsupported_mime", `不支持的 mime：${mime}（允许：${Object.keys(MIME_EXT).join(", ")}）`);
  }
  const ext = extOf(filename);
  if (ext && !MIME_EXT[mime].includes(ext)) {
    throw ferr(400, "filename_mime_mismatch", `扩展名 ${ext} 与声明 mime ${mime} 不一致`);
  }
  const sniffed = sniffMime(buf);
  if (sniffed === null) {
    if (!TEXT_MIMES.has(mime)) {
      throw ferr(400, "mime_sniff_failed", `文件内容不是可识别的 ${mime}`);
    }
    if (!looksLikeUtf8Text(buf)) {
      throw ferr(400, "mime_sniff_failed", "声明为文本，但内容不是合法 UTF-8 文本");
    }
    return;
  }
  if (sniffed === "application/zip") {
    if (!ZIP_CONTAINER_MIMES.has(mime)) {
      throw ferr(400, "filename_mime_mismatch", `内容是 zip 容器，与声明 mime ${mime} 不一致`);
    }
    return;
  }
  if (sniffed !== mime) {
    throw ferr(400, "mime_mismatch", `内容其实是 ${sniffed}，与声明 ${mime} 不一致`);
  }
}

function kindOf(mime) {
  if (IMAGE_MIMES.has(mime)) return "image";
  if (TEXT_MIMES.has(mime) || mime === "application/pdf") return "document";
  return "binary";
}

/** base64 严格解码：拒绝 data URI 前缀、空白、非法字符与非规范 padding。 */
export function decodeBase64(input) {
  const raw = String(input ?? "");
  const body = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!body) throw ferr(400, "invalid_base64", "dataBase64 为空");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) {
    throw ferr(400, "invalid_base64", "dataBase64 不是规范 base64");
  }
  const buf = Buffer.from(body, "base64");
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    throw ferr(413, "attachment_too_large", `附件 ${humanBytes(buf.length)} 超过上限 ${humanBytes(MAX_ATTACHMENT_BYTES)}`);
  }
  return buf;
}

export class Attachments {
  /** @param {{orch:object, home:string}} deps */
  constructor({ orch, home }) {
    this.orch = orch;
    this.home = home;
    this.root = join(home, "attachments");
    mkdirSync(this.root, { recursive: true });
  }

  #ledger() {
    const l = this.orch.ledger;
    if (!l) throw ferr(500, "ledger_unavailable", "账本不可用，无法登记附件");
    return l;
  }

  #requireBot(botId) {
    const id = String(botId ?? "").trim();
    if (!id) throw ferr(400, "invalid_field", "botId 必填");
    const bot = this.orch.getBot(id);
    if (!bot) throw ferr(404, "bot_not_found", `未知 Bot：${id}`);
    return bot;
  }

  /**
   * 接收一个附件。返回登记后的记录。
   * @param {{botId:string, filename:string, mime:string, dataBase64:string}} input
   */
  create(input = {}) {
    const bot = this.#requireBot(input.botId);
    const filename = canonicalFilename(input.filename);
    const mime = String(input.mime ?? "").trim().toLowerCase();
    const buf = decodeBase64(input.dataBase64);
    if (buf.length === 0) throw ferr(400, "empty_attachment", "附件内容为空");
    assertMimeConsistent({ mime, filename, buf });

    const id = genId("att");
    const dir = join(this.root, bot.id, id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, filename);
    writeFileSync(path, buf);
    if (!isInsideRoot(join(this.root, bot.id), path)) {
      rmSync(dir, { recursive: true, force: true });
      throw ferr(400, "path_escape", "附件落盘路径越界，已回滚");
    }

    const record = {
      id,
      botId: bot.id,
      botName: bot.name,
      filename,
      mime,
      kind: kindOf(mime),
      size: buf.length,
      hash: sha256Hex(buf),
      path,
      createdAt: Date.now(),
      runIds: [],
    };
    this.#ledger().put("attachments", record);
    this.orch.emit?.("attachment_added", { attachment: clone(record) });
    return clone(record);
  }

  get(id) {
    const rec = this.#ledger().get("attachments", String(id ?? ""));
    return rec ? clone(rec) : null;
  }

  list({ botId } = {}) {
    const all = this.#ledger().list("attachments", { limit: 1000 }) ?? [];
    const filtered = botId ? all.filter((a) => a?.botId === botId) : all;
    return filtered.sort(byCreatedDesc).map(clone);
  }

  /** 删除记录与其文件；返回是否真的删到。 */
  remove(id) {
    const rec = this.get(id);
    if (!rec) return false;
    const dir = join(this.root, rec.botId, rec.id);
    if (isInsideRoot(this.root, dir)) rmSync(dir, { recursive: true, force: true });
    const ok = this.#ledger().remove("attachments", rec.id);
    if (ok) this.orch.emit?.("attachment_removed", { id: rec.id, botId: rec.botId });
    return ok;
  }

  /** 记录该附件被哪个 Run 使用（可追溯，不影响原文）。 */
  markUsed(id, runId) {
    const rec = this.get(id);
    if (!rec || !runId) return;
    if (!rec.runIds.includes(runId)) {
      rec.runIds = [...rec.runIds, runId].slice(-20);
      this.#ledger().put("attachments", rec);
    }
  }

  /**
   * 取附件本体并校验它仍属于该 Bot、仍在落盘范围内、仍存在。
   * @returns {{record:object, absPath:string, buf:Buffer}}
   */
  loadFor(botId, id) {
    const rec = this.get(id);
    if (!rec) throw ferr(404, "attachment_not_found", `附件不存在：${id}`);
    if (rec.botId !== botId) {
      throw ferr(403, "attachment_ownership_denied", `附件 ${id} 属于另一个 Bot，拒绝跨 Bot 使用`);
    }
    const ownRoot = join(this.root, rec.botId);
    if (!isInsideRoot(ownRoot, rec.path) || !existsSync(rec.path)) {
      throw ferr(409, "attachment_missing_file", `附件 ${id} 的文件不在受控目录或已被移除`);
    }
    const buf = readFileSync(rec.path);
    if (sha256Hex(buf) !== rec.hash) {
      throw ferr(409, "attachment_hash_mismatch", `附件 ${id} 内容与登记哈希不符，拒绝加载`);
    }
    return { record: rec, absPath: rec.path, buf };
  }

  /**
   * 图片附件预览（UI 的 <img> 直接指向它）。
   * 只对已登记的图片附件输出本体：ownership（可选 botId 复核）、真实路径范围、按登记哈希复核字节。
   * 非图片一律 415，不提供通用文件读出口。
   */
  servePreview(id, res, { botId } = {}) {
    const rec = this.get(id);
    if (!rec) throw ferr(404, "attachment_not_found", `附件不存在：${id}`);
    if (botId && rec.botId !== botId) {
      throw ferr(403, "attachment_ownership_denied", `附件 ${id} 属于另一个 Bot，拒绝跨 Bot 使用`);
    }
    const { record, buf } = this.loadFor(rec.botId, id);
    if (record.kind !== "image") {
      throw ferr(415, "preview_unsupported", `${record.filename} 是 ${record.mime}，只有图片可预览；其他类型请用下载接口`);
    }
    res.writeHead(200, {
      "Content-Type": record.mime,
      "Content-Length": buf.length,
      "Content-Disposition": "inline",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.end(buf);
  }

  /** 文档附件的提示块：给出规范绝对路径，由 OMP 原生 read 读取，原文不动。 */
  documentBlock(rec) {
    return [
      `[附件 document: ${rec.filename} (${rec.mime}, ${humanBytes(rec.size)}, sha256 ${rec.hash.slice(0, 16)}…)]`,
      `用原生 read 工具读取这个本机绝对路径：${rec.path}`,
      `这是用户提供的原始资料，只读；不要改写、不要删除，产物请写到别处。`,
    ].join("\n");
  }

  /** 备份留档用（恢复/审计），保持与源同哈希。 */
  copyTo(id, destPath) {
    const rec = this.get(id);
    if (!rec) throw ferr(404, "attachment_not_found", `附件不存在：${id}`);
    if (!existsSync(rec.path)) throw ferr(409, "attachment_missing_file", "附件文件已丢失");
    mkdirSync(join(destPath, ".."), { recursive: true });
    copyFileSync(rec.path, destPath);
    return destPath;
  }
}
