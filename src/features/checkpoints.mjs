// features/checkpoints.mjs — 工作区文件检查点（与原生对话 checkpoint/rewind 完全分离）。
//
// 原生 checkpoint/rewind 只保存对话消息计数与条目 id，不碰文件系统、不调 git（见官方
// docs/tools/checkpoint.md）。本模块补的是文件侧：把 Bot 工作目录的内容按内容寻址存到
// <home>/checkpoints/<botId>/，恢复时保护快照之后被人工/别的 Run 改过的文件。
//
// 明确不做：不改用户 .git、不写 index/HEAD、不删除快照里没有的文件、不撤销外部副作用。

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { genId } from "../domain.mjs";
import { byCreatedDesc, clone, ferr, fileEntry, isInsideRoot, sha256Hex, walkFiles } from "./util.mjs";

const SKIP_DIRS = new Set([".git", "node_modules", ".omp", ".venv", "venv", "__pycache__", ".cache"]);

function treeOf(root) {
  const entries = {};
  let bytes = 0;
  for (const abs of walkFiles(root, { skipDirs: SKIP_DIRS })) {
    const e = fileEntry(abs);
    if (!e) continue;
    entries[relative(root, abs).replace(/\\/g, "/")] = e;
    bytes += e.size;
  }
  return { entries, bytes };
}

export class Checkpoints {
  /** @param {{orch:object, home:string, maxFiles?:number}} deps */
  constructor({ orch, home, maxFiles = 5000 }) {
    this.orch = orch;
    this.home = home;
    this.maxFiles = maxFiles;
    this.root = join(home, "checkpoints");
    mkdirSync(this.root, { recursive: true });
  }

  #dir(botId) {
    const d = join(this.root, String(botId));
    mkdirSync(join(d, "blobs"), { recursive: true });
    mkdirSync(join(d, "manifests"), { recursive: true });
    return d;
  }

  #manifestPath(botId, id) {
    return join(this.#dir(botId), "manifests", `${id}.json`);
  }

  #blobPath(botId, hash) {
    return join(this.#dir(botId), "blobs", hash);
  }

  /**
   * 建立检查点。
   * @param {{botId:string, scope?:string, root:string, reason?:string}} input
   */
  create(input = {}) {
    const botId = String(input.botId ?? "").trim();
    if (!botId) throw ferr(400, "invalid_field", "botId 必填");
    const root = String(input.root ?? "").trim();
    if (!root || !existsSync(root)) throw ferr(400, "invalid_field", "root 必填且必须已存在");
    if (this.orch.getBot && !this.orch.getBot(botId)) throw ferr(404, "bot_not_found", `未知 Bot：${botId}`);

    const { entries, bytes } = treeOf(root);
    const keys = Object.keys(entries);
    if (keys.length > this.maxFiles) {
      throw ferr(413, "checkpoint_too_large", `目录内文件数 ${keys.length} 超过检查点上限 ${this.maxFiles}`);
    }
    const id = genId("ckpt");
    for (const rel of keys) {
      const blob = this.#blobPath(botId, entries[rel].hash);
      if (!existsSync(blob)) {
        try {
          mkdirSync(dirname(blob), { recursive: true });
          copyFileSync(join(root, ...rel.split("/")), blob);
        } catch (e) {
          throw ferr(500, "checkpoint_blob_failed", `写入 blob 失败：${e?.message ?? e}`);
        }
      }
    }
    const manifest = {
      id,
      botId,
      scope: input.scope ?? "private",
      root,
      reason: String(input.reason ?? "").slice(0, 300),
      createdAt: Date.now(),
      fileCount: keys.length,
      bytes,
      entries,
    };
    writeFileSync(this.#manifestPath(botId, id), JSON.stringify(manifest));
    this.orch.emit?.("checkpoint_created", {
      checkpoint: { id, botId, scope: manifest.scope, root, fileCount: keys.length, bytes, createdAt: manifest.createdAt },
    });
    return clone(manifest);
  }

  list({ botId } = {}) {
    const base = join(this.root, String(botId ?? ""));
    if (!botId || !existsSync(base)) return [];
    const dir = join(base, "manifests");
    if (!existsSync(dir)) return [];
    const out = [];
    for (const f of walkFiles(dir)) {
      try {
        const m = JSON.parse(readFileSync(f, "utf8"));
        out.push({
          id: m.id,
          botId: m.botId,
          scope: m.scope,
          root: m.root,
          reason: m.reason,
          fileCount: m.fileCount,
          bytes: m.bytes,
          createdAt: m.createdAt,
        });
      } catch (e) {
        // 坏清单不静默跳过：回报是哪一份读不出来，其余记录照常返回。
        this.orch.emit?.("checkpoint_manifest_unreadable", { path: f, error: e?.message ?? String(e) });
      }
    }
    return out.sort(byCreatedDesc);
  }

  get(botId, id) {
    const p = this.#manifestPath(botId, String(id ?? ""));
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  }

  /** 与当前工作区对比：新增/修改/删除/未变。 */
  diff(botId, id) {
    const m = this.get(botId, id);
    if (!m) throw ferr(404, "checkpoint_not_found", `检查点不存在：${id}`);
    const now = existsSync(m.root) ? treeOf(m.root) : { entries: {}, bytes: 0 };
    const added = [];
    const modified = [];
    const deleted = [];
    let unchanged = 0;
    for (const [rel, cur] of Object.entries(now.entries)) {
      const prev = m.entries[rel];
      if (!prev) added.push({ relPath: rel, size: cur.size });
      else if (prev.hash !== cur.hash) modified.push({ relPath: rel, size: cur.size, snapshotSize: prev.size });
      else unchanged += 1;
    }
    for (const rel of Object.keys(m.entries)) if (!now.entries[rel]) deleted.push({ relPath: rel });
    return {
      id: m.id,
      botId: m.botId,
      root: m.root,
      createdAt: m.createdAt,
      added,
      modified,
      deleted,
      unchanged,
    };
  }

  /**
   * 恢复检查点。默认保护快照之后被改动的文件（除非 force）。
   * 只还原清单内的文件；不动清单外的文件，也不动 .git。
   */
  restore(botId, id, { force = false } = {}) {
    const m = this.get(botId, id);
    if (!m) throw ferr(404, "checkpoint_not_found", `检查点不存在：${id}`);
    const restored = [];
    const protectedFiles = [];
    const missingBlob = [];
    let unchanged = 0;

    for (const [rel, snap] of Object.entries(m.entries)) {
      const abs = join(m.root, ...rel.split("/"));
      const cur = existsSync(abs) ? fileEntry(abs) : null;
      const blob = this.#blobPath(botId, snap.hash);
      if (!existsSync(blob)) {
        missingBlob.push(rel);
        continue;
      }
      if (cur && cur.hash === snap.hash) {
        unchanged += 1;
        continue;
      }
      if (cur && !force) {
        // 内容与快照不一致本身就是「快照后被改过」的证据；mtime 只用于区分文案，
        // 因为保留/回拨时间戳的写入（tar -p、rsync -t、cp -p）会让 mtime 判据漏判。
        const newerMtime = cur.mtimeMs > m.createdAt;
        protectedFiles.push({
          relPath: rel,
          reason: newerMtime ? "snapshot 之后被改动（保护较新编辑）" : "内容与快照不一致（时间戳不可信，仍保护）",
        });
        continue;
      }
      mkdirSync(dirname(abs), { recursive: true });
      copyFileSync(blob, abs);
      restored.push({ relPath: rel, from: cur ? "modified" : "deleted" });
    }

    const result = {
      id: m.id,
      botId: m.botId,
      root: m.root,
      force: force === true,
      restored,
      protected: protectedFiles,
      missingBlob,
      unchanged,
      diff: this.diff(botId, id),
    };
    this.orch.emit?.("checkpoint_restored", {
      checkpoint: { id: m.id, botId, restored: restored.length, protected: protectedFiles.length, force: force === true },
    });
    return result;
  }

  /** 删除一个检查点的清单（blob 内容寻址共享，不随之删除）。 */
  remove(botId, id) {
    const p = this.#manifestPath(botId, String(id ?? ""));
    if (!existsSync(p)) return false;
    rmSync(p, { force: true });
    return true;
  }

  /** 预留：以哈希写入 blob（供未来导出/比对用）。 */
  putBlob(botId, buf) {
    const hash = sha256Hex(buf);
    const blob = this.#blobPath(botId, hash);
    if (!existsSync(blob)) writeFileSync(blob, buf);
    return { hash, path: blob, inside: isInsideRoot(this.#dir(botId), blob) };
  }
}
