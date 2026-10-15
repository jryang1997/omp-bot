// Read-only probe: compare RT_ICON payloads embedded in a PE file against a source .ico.
// Usage: node .scratch/icon-probe/probe-icon.mjs <pe.exe> <source.ico>
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [pePath, icoPath] = process.argv.slice(2);
if (!pePath || !icoPath) {
  console.error("usage: probe-icon.mjs <pe.exe> <source.ico>");
  process.exit(2);
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const b = readFileSync(pePath);

const peOff = b.readUInt32LE(0x3c);
const numSections = b.readUInt16LE(peOff + 6);
const optSize = b.readUInt16LE(peOff + 20);
const magic = b.readUInt16LE(peOff + 24);
const dirOff = peOff + 24 + (magic === 0x20b ? 112 : 96);
const resRva = b.readUInt32LE(dirOff + 16);
const resSize = b.readUInt32LE(dirOff + 20);

const sections = [];
const secBase = peOff + 24 + optSize;
for (let i = 0; i < numSections; i++) {
  const o = secBase + i * 40;
  sections.push({
    va: b.readUInt32LE(o + 12),
    vsize: b.readUInt32LE(o + 8),
    rawSize: b.readUInt32LE(o + 16),
    rawPtr: b.readUInt32LE(o + 20),
  });
}

function off(rva) {
  for (const s of sections) {
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) {
      const d = rva - s.va;
      if (d < s.rawSize) return s.rawPtr + d;
    }
  }
  return null;
}

const leaves = [];
const ROOT = resRva;
function walk(dirAbs, level, path) {
  const base = off(dirAbs);
  if (base === null) throw new Error(`unmapped resource dir rva 0x${dirAbs.toString(16)}`);
  const namedCount = b.readUInt16LE(base + 12);
  const idCount = b.readUInt16LE(base + 14);
  for (let i = 0; i < namedCount + idCount; i++) {
    const e = base + 16 + i * 8;
    const nameOrId = b.readUInt32LE(e);
    const target = b.readUInt32LE(e + 4);
    let label;
    if (nameOrId & 0x80000000) {
      const nOff = base + (nameOrId & 0x7fffffff);
      const nLen = b.readUInt16LE(nOff);
      label = b.toString("utf16le", nOff + 2, nOff + 2 + nLen * 2);
    } else {
      label = nameOrId;
    }
    if (target & 0x80000000) {
      walk(ROOT + (target & 0x7fffffff), level + 1, [...path, label]);
    } else {
      const dOff = ROOT + target;
      if (process.env.PROBE_DEBUG) console.error(`leaf L${level} path=${path.join("/")} ROOT=0x${ROOT.toString(16)} base=0x${base.toString(16)} target=0x${target.toString(16)} dOff=0x${dOff.toString(16)} len=0x${b.length.toString(16)}`);
      if (dOff + 8 > b.length) throw new Error(`leaf data entry out of range: ROOT=0x${ROOT.toString(16)} target=0x${target.toString(16)} dOff=0x${dOff.toString(16)} len=0x${b.length.toString(16)}`);
      const dataRva = b.readUInt32LE(dOff);
      const dataSize = b.readUInt32LE(dOff + 4);
      const dataPtr = off(dataRva);
      if (dataPtr === null) throw new Error(`unmapped data rva 0x${dataRva.toString(16)}`);
      leaves.push({ path: [...path, label], data: b.subarray(dataPtr, dataPtr + dataSize) });
    }
  }
}
walk(ROOT, 0, []);

const icons = leaves.filter((l) => l.path[0] === 3);
const groups = leaves.filter((l) => l.path[0] === 14);
console.log(`PE=${pePath}`);
console.log(`resourceDir rva=0x${resRva.toString(16)} size=${resSize} iconResources=${icons.length} groupResources=${groups.length}`);

const embedded = new Map();
for (const ic of icons) {
  const h = sha(ic.data);
  embedded.set(h, `${ic.data.length}B`);
  console.log(`RT_ICON id=${ic.path[1]} lang=0x${Number(ic.path[2]).toString(16)} bytes=${ic.data.length} sha256=${h.slice(0, 16)}`);
}
for (const g of groups) {
  const d = g.data;
  const reserved = d.readUInt16LE(0);
  const type = d.readUInt16LE(2);
  const count = d.readUInt16LE(4);
  const dims = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 14;
    dims.push(`${d[o] || 256}x${d[o + 1] || 256}(${d.readUInt32LE(o + 8)}B)`);
  }
  console.log(`RT_GROUP_ICON id=${g.path[1]} reserved=${reserved} type=${type} entries=${count} ${dims.join(" ")}`);
}

const src = readFileSync(icoPath);
const srcCount = src.readUInt16LE(4);
console.log(`source ico=${icoPath} entries=${srcCount}`);
let match = 0;
for (let i = 0; i < srcCount; i++) {
  const o = 6 + i * 16;
  const w = src[o] || 256;
  const h = src[o + 1] || 256;
  const size = src.readUInt32LE(o + 8);
  const o2 = src.readUInt32LE(o + 12);
  const hh = sha(src.subarray(o2, o2 + size));
  const hit = embedded.has(hh);
  if (hit) match++;
  console.log(`${w}x${h} bytes=${size} sha256=${hh.slice(0, 16)} inExe=${hit}`);
}
console.log(`matched ${match}/${srcCount}`);
