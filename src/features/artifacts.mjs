// features/artifacts.mjs — 用户可领取的成果：登记、版本、下载与隔离预览。
//
// 只登记「本次运行在 Bot 自己的工作目录里新生成的用户产出」。人格文件、会话文件、
// omp 项目配置和附件库都不算成果。
//
// 语义：成果是不可变的。登记时把当时的字节复制进 <home>/artifacts/<botId>/<artifactId>/，
// 源文件留在工作区（sourcePath），之后工作区怎么改都不影响已登记版本；下载/预览按登记哈希
// 校验，内容对不上就报 artifact_changed，绝不把新内容当成旧成果发出去。

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { genId } from "../domain.mjs";
import {
  byCreatedDesc,
  clone,
  extOf,
  ferr,
  humanBytes,
  isInsideRoot,
  sha256Hex,
  walkFiles,
} from "./util.mjs";

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_TEXT = 200 * 1024;

/** 扫描时跳过的目录：版本库、依赖、omp 私有项目配置、会话与缓存。 */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".omp",
  "sessions",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "dist-electron",
]);

const PREVIEWABLE_IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const PREVIEWABLE_TEXT = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log", ".yaml", ".yml", ".tsv"]);

const MIME_BY_EXT = {
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
};

function previewTypeOf(name) {
  const ext = extOf(name);
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".svg") return "svg";
  if (PREVIEWABLE_IMAGE.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (PREVIEWABLE_TEXT.has(ext)) return "text";
  return "binary";
}

function mimeOf(name, previewType) {
  const mapped = MIME_BY_EXT[extOf(name)];
  if (mapped) return mapped;
  return previewType === "text" ? "text/plain" : "application/octet-stream";
}

export class Artifacts {
  /**
   * @param {{orch:object, home:string, botWorkDir?:(botId:string,scope:string)=>{baseDir:string,workDir:string}}} deps
   */
  constructor({ orch, home, botWorkDir }) {
    this.orch = orch;
    this.home = home;
    this.botWorkDir = botWorkDir;
    this.root = join(home, "artifacts");
    mkdirSync(this.root, { recursive: true });
  }

  #ledger() {
    const l = this.orch.ledger;
    if (!l) throw ferr(500, "ledger_unavailable", "账本不可用，无法登记成果");
    return l;
  }

  /** 本次运行允许扫描的根：Bot 自己的工作目录 + 用户显式选定的工作区。 */
  scanRoots(run, runtime) {
    const roots = [];
    const add = (p) => {
      if (!p || typeof p !== "string") return;
      const norm = p.replace(/[\\/]+$/, "");
      if (!roots.includes(norm)) roots.push(norm);
    };
    add(runtime?.cwd);
    const bot = this.orch.getBot?.(run.botId);
    add(bot?.workspace);
    return roots.filter((r) => existsSync(r));
  }

  /**
   * 扫描本次运行新生成的用户产出并登记。
   * @returns {object[]} 新登记（或本次运行首次见到的）成果记录
   */
  collect(run, runtime) {
    const botId = run?.botId;
    if (!botId) throw ferr(400, "invalid_field", "run.botId 必填");
    const since = Number(run.createdAt ?? Date.now()) - 3000;
    const roots = this.scanRoots(run, runtime);
    const known = (this.#ledger().list("artifacts", { limit: 1000 }) ?? []).filter((a) => a?.botId === botId);
    const seenKey = new Set(known.map((a) => `${a.root}::${a.relPath}::${a.hash}`));
    const added = [];
    // 跳过的文件按原因计数并回报：不做「读不到就当没有」的静默丢弃。
    const skipped = { unreadable: 0, empty: 0, tooLarge: 0, stale: 0, outsideRoot: 0, duplicate: 0 };
    let scanned = 0;

    this.#snapshotRoots(botId, roots); // 记录扫描基线，供 checkpoint/审计复用

    for (const root of roots) {
      for (const abs of walkFiles(root, { skipDirs: SKIP_DIRS })) {
        scanned += 1;
        let st;
        try {
          st = statSync(abs);
        } catch {
          skipped.unreadable += 1;
          continue;
        }
        if (!st.isFile()) {
          skipped.unreadable += 1;
          continue;
        }
        if (st.mtimeMs < since) {
          skipped.stale += 1;
          continue;
        }
        if (!isInsideRoot(root, abs)) {
          skipped.outsideRoot += 1;
          continue;
        }
        if (st.size === 0) {
          skipped.empty += 1;
          continue;
        }
        if (st.size > MAX_ARTIFACT_BYTES) {
          skipped.tooLarge += 1;
          continue;
        }
        // 源文件只读一次：hash/size 与快照都从这同一份字节得出。
        // 否则登记瞬间源文件被改写时，记录会描述旧字节而快照存的是新字节，之后永远 409。
        let buf;
        try {
          buf = readFileSync(abs);
        } catch {
          skipped.unreadable += 1;
          continue;
        }
        if (buf.length === 0) {
          skipped.empty += 1;
          continue;
        }
        if (buf.length > MAX_ARTIFACT_BYTES) {
          skipped.tooLarge += 1;
          continue;
        }
        const hash = sha256Hex(buf);
        const relPath = relative(root, abs).replace(/\\/g, "/");
        const key = `${root.replace(/\\/g, "/")}::${relPath}::${hash}`;
        if (seenKey.has(key)) {
          skipped.duplicate += 1;
          continue;
        }
        seenKey.add(key);

        const previewType = previewTypeOf(abs);
        const priorVersions = known.filter(
          (a) => a.root.replace(/\\/g, "/") === root.replace(/\\/g, "/") && a.relPath === relPath,
        ).length;
        const id = genId("art");
        // 成果是不可变的：把刚读到的同一份字节写进产品成果根，元数据取自快照本身。
        const snapDir = join(this.root, botId, id);
        const snapPath = join(snapDir, basename(abs));
        try {
          mkdirSync(snapDir, { recursive: true });
          writeFileSync(snapPath, buf);
        } catch (e) {
          throw ferr(500, "artifact_snapshot_failed", `成果快照写入失败：${e?.message ?? e}`);
        }
        const snapSt = statSync(snapPath);
        if (snapSt.size !== buf.length) {
          rmSync(snapPath, { force: true });
          throw ferr(500, "artifact_snapshot_mismatch", `快照字节与读取不一致（源文件在登记期间被改写？）：${snapSt.size} != ${buf.length}`);
        }
        if (snapSt.size > MAX_ARTIFACT_BYTES) {
          rmSync(snapPath, { force: true });
          skipped.tooLarge += 1;
          continue;
        }
        const rec = {
          id,
          runId: run.id ?? null,
          botId,
          scope: run.scope ?? "private",
          root: root.replace(/\\/g, "/"),
          relPath,
          sourcePath: abs,
          path: snapPath,
          name: basename(abs),
          mime: mimeOf(abs, previewType),
          previewType,
          size: snapSt.size,
          hash,
          version: priorVersions + 1,
          immutable: true,
          createdAt: Date.now(),
          downloads: 0,
        };
        this.#ledger().put("artifacts", rec);
        added.push(clone(rec));
      }
    }
    this.lastScan = { botId, runId: run.id ?? null, at: Date.now(), scanned, registered: added.length, skipped };
    this.orch.emit?.("artifact_scan", { ...this.lastScan });
    return added;
  }

  /** 保存每个 Bot 上次扫描时的文件清单（仅用于展示/审计，不参与授权）。失败要可见，不静默。 */
  #snapshotRoots(botId, roots) {
    try {
      const files = roots.flatMap((r) =>
        walkFiles(r, { skipDirs: SKIP_DIRS, maxFiles: 5000 }).map((p) => relative(r, p).replace(/\\/g, "/")),
      );
      writeFileSync(
        join(this.root, `${botId}.scan.json`),
        JSON.stringify({ botId, at: Date.now(), count: files.length, files: files.slice(0, 5000) }, null, 0),
      );
      this.lastBaselineError = null;
    } catch (e) {
      // 基线只是观测数据，不阻断登记；但失败必须留痕，不能吞掉。
      this.lastBaselineError = e?.message ?? String(e);
      this.orch.emit?.("artifact_baseline_failed", { botId, error: this.lastBaselineError });
    }
  }

  get(id) {
    const rec = this.#ledger().get("artifacts", String(id ?? ""));
    return rec ? clone(rec) : null;
  }

  list({ botId, runId } = {}) {
    let all = this.#ledger().list("artifacts", { limit: 1000 }) ?? [];
    if (botId) all = all.filter((a) => a?.botId === botId);
    if (runId) all = all.filter((a) => a?.runId === runId);
    return all.sort(byCreatedDesc).map(clone);
  }

  /**
   * 解析一个可下载/预览的成果：记录存在、快照存在、真实路径仍在产品成果根内、大小仍在上限内。
   * @returns {{record:object,absPath:string,size:number}}
   */
  resolveFile(id) {
    const rec = this.get(id);
    if (!rec) throw ferr(404, "artifact_not_found", `成果不存在：${id}`);
    const storeRoot = join(this.root, rec.botId);
    if (!isInsideRoot(storeRoot, rec.path)) {
      throw ferr(403, "artifact_out_of_root", "成果快照路径不在产品成果根内，拒绝提供");
    }
    if (!existsSync(rec.path)) {
      throw ferr(410, "artifact_snapshot_missing", "成果快照已被移除；源文件可能仍在工作区，请重新登记");
    }
    const st = statSync(rec.path);
    if (!st.isFile()) throw ferr(410, "artifact_file_gone", "成果路径不是普通文件");
    if (st.size > MAX_ARTIFACT_BYTES) {
      throw ferr(413, "artifact_too_large", `成果 ${humanBytes(st.size)} 超过上限 ${humanBytes(MAX_ARTIFACT_BYTES)}`);
    }
    return { record: rec, absPath: rec.path, size: st.size };
  }

  /**
   * 读取并校验本体：内容哈希/大小必须与登记一致，否则明确报错，
   * 绝不把「比登记更新的内容」当作旧成果发出去。
   * @returns {{record:object,absPath:string,buf:Buffer}}
   */
  loadVerified(id) {
    const { record, absPath } = this.resolveFile(id);
    const buf = readFileSync(absPath);
    if (buf.length !== record.size || sha256Hex(buf) !== record.hash) {
      throw ferr(409, "artifact_changed", `成果 ${id} 快照内容与登记哈希不符（可能被外部改写），拒绝提供`);
    }
    return { record, absPath, buf };
  }

  /** 下载：Content-Disposition 附件 + 校验过的内容 + no-store。 */
  serveDownload(id, res) {
    const { record, buf, absPath } = this.loadVerified(id);
    record.downloads = (record.downloads ?? 0) + 1;
    record.lastDownloadAt = Date.now();
    this.#ledger().put("artifacts", record);
    const filename = record.name ?? basename(absPath);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": buf.length,
      "Content-Disposition": `attachment; filename="${filename.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(buf);
    this.orch.emit?.("artifact_downloaded", { artifactId: record.id, size: buf.length, version: record.version });
  }

  /**
   * 预览：html/svg 用严格沙箱 CSP（禁脚本、禁同源、禁连接），不写任何管理 cookie。
   * 二进制类型不给预览。内容同样按登记哈希校验。
   */
  servePreview(id, res) {
    const { record, buf } = this.loadVerified(id);
    const type = record.previewType ?? "binary";
    if (type === "binary") {
      throw ferr(415, "preview_unsupported", `类型 ${record.mime} 不支持预览，请下载`);
    }
    if (type === "text" && buf.length > MAX_PREVIEW_TEXT) {
      throw ferr(413, "preview_too_large", `文本成果 ${humanBytes(buf.length)} 超过预览上限 ${humanBytes(MAX_PREVIEW_TEXT)}`);
    }
    const headers = {
      "Content-Type": record.mime,
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
    };
    if (type === "html" || type === "svg") {
      // sandbox 不给同源权限：预览页读不到管理接口，也拿不到本机 session cookie。
      headers["Content-Security-Policy"] =
        "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
      headers["Content-Disposition"] = "inline";
    } else if (type === "pdf") {
      headers["Content-Security-Policy"] =
        "sandbox; default-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; frame-ancestors 'self'";
      headers["Content-Disposition"] = "inline";
    } else {
      headers["Content-Disposition"] = "inline";
    }
    res.writeHead(200, headers);
    res.end(buf);
  }
}
