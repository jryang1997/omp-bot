// 迷你资源目录：验证内容指纹（packDigest）的稳定性与灵敏度，全部在临时目录进行，不碰真实 release/。
// 覆盖：清单未记录的资源文件变化必须改变指纹；资源包范围外的 cua.exe 变化不影响指纹；
//       包内 manifest 原文变化必须改变指纹；目录缺失直接报错。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectPackEntries, hashPackEntries, packDigest, packedManifest } from "../../../scripts/package-windows.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ompbot-digest-"));
try {
  const runtime = path.join(tmp, "runtime");
  for (const dir of ["qemu", "images", "licenses"]) fs.mkdirSync(path.join(runtime, dir), { recursive: true });
  fs.writeFileSync(path.join(runtime, "cua.exe"), "cli-only");
  fs.writeFileSync(path.join(runtime, "qemu", "qemu-system-x86_64.exe"), "qemu-main");
  fs.writeFileSync(path.join(runtime, "qemu", "libaccel.dll"), "accel-v1");
  fs.writeFileSync(path.join(runtime, "images", "linux.img"), "image-bytes");
  fs.writeFileSync(path.join(runtime, "licenses", "GPL.txt"), "gpl");
  const manifest = {
    version: 1,
    generatedAt: "2026-10-14T00:00:00.000Z",
    runtimeDir: ".computer-runtime",
    cli: { file: "cua.exe", sha256: sha("cli-only") },
    qemu: { file: "qemu/qemu-system-x86_64.exe", sha256: sha("qemu-main") },
    image: { path: "images/linux.img", sha256: sha("image-bytes") },
  };

  const digestOf = async () => {
    const entries = collectPackEntries(runtime);
    const hashes = await hashPackEntries(entries);
    return packDigest(entries, hashes, `${JSON.stringify(packedManifest(manifest), null, 2)}\n`);
  };

  const d1 = await digestOf();
  assert.equal(await digestOf(), d1, "内容不变时指纹必须稳定");

  fs.writeFileSync(path.join(runtime, "qemu", "libaccel.dll"), "accel-v2");
  const d2 = await digestOf();
  assert.notEqual(d2, d1, "清单没记录的资源文件变化必须改变指纹");

  fs.writeFileSync(path.join(runtime, "cua.exe"), "cli-only-updated");
  assert.equal(await digestOf(), d2, "资源包外的 cua.exe 变化不应影响指纹");

  fs.writeFileSync(path.join(runtime, "qemu", "libaccel.dll"), "accel-v1");
  fs.writeFileSync(path.join(runtime, "cua.exe"), "cli-only");
  assert.equal(await digestOf(), d1, "内容改回后指纹应还原");

  const manifestChanged = { ...manifest, generatedAt: "2026-10-14T01:00:00.000Z" };
  const entries = collectPackEntries(runtime);
  const hashes = await hashPackEntries(entries);
  const d3 = packDigest(entries, hashes, `${JSON.stringify(packedManifest(manifestChanged), null, 2)}\n`);
  assert.notEqual(d3, d1, "写进包的 manifest 原文变化必须改变指纹");

  fs.rmSync(path.join(runtime, "licenses"), { recursive: true });
  await assert.rejects(async () => digestOf(), /缺少 licenses/, "缺少资源目录时必须报错");

  console.log("PASS probe-digest：指纹稳定、灵敏、范围正确");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
