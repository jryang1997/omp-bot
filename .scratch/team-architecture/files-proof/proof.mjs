// 04 号票沙盒替身证明：宿主目录是唯一权威，客机通过 sshfs 挂载看到同一份文件。
// 运行前先 ./setup.sh <宿主目录> <挂载点>。运行：HOST_DIR=... MNT=... node proof.mjs
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
const HOST = process.env.HOST_DIR ?? '/data/hostshare/workspace';
const MNT = process.env.MNT ?? '/workspace-host';
const asBot = (user, script) => run('sudo', ['-n', '-u', user, '-H', 'bash', '-c', script], { maxBuffer: 16 << 20 })
  .then(r => ({ ok: true, out: r.stdout.trim(), err: r.stderr.trim() }), e => ({ ok: false, out: (e.stdout ?? '').trim(), err: (e.stderr ?? '').trim() }));
const q = s => `'${s.replaceAll("'", `'\\''`)}'`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r = { ticket: '04-host-guest-files', at: new Date().toISOString(), environment: 'sandbox stand-in: 宿主侧 OpenSSH sftp-server 经 socat 直连（普通用户，不做缓存，代替将来的 Node SFTP 服务），客机侧 sshfs 3.7.3（root 挂载，gid=team，umask=0007，cache=no）', checks: {} };

for (const f of fs.readdirSync(HOST)) fs.rmSync(path.join(HOST, f), { recursive: true, force: true });

// 1) 宿主写，客机马上读
const name = '中文 笔记.md';
let t = Date.now();
fs.writeFileSync(path.join(HOST, name), '宿主第一版\n');
let seen = await asBot('bot-a', `cat ${q(`${MNT}/${name}`)}`);
r.checks.hostWriteGuestRead = { ok: seen.out === '宿主第一版', ms: Date.now() - t };

// 2) 宿主像编辑器那样写临时文件再改名，客机读到完整新内容
fs.writeFileSync(path.join(HOST, `.${name}.tmp`), '宿主第二版，改名落盘\n');
fs.renameSync(path.join(HOST, `.${name}.tmp`), path.join(HOST, name));
seen = await asBot('bot-a', `cat ${q(`${MNT}/${name}`)}`);
r.checks.hostAtomicRenameGuestRead = { ok: seen.out === '宿主第二版，改名落盘' };

// 3) 客机写，宿主马上读
t = Date.now();
const w = await asBot('bot-a', `printf '客机写的\\n' > ${q(`${MNT}/来自客机.txt`)}`);
r.checks.guestWriteHostRead = { ok: w.ok && fs.readFileSync(path.join(HOST, '来自客机.txt'), 'utf8') === '客机写的\n', ms: Date.now() - t, err: w.err };

// 4) 另一个 bot 能追加
const b = await asBot('bot-b', `printf 'b 追加\\n' >> ${q(`${MNT}/来自客机.txt`)} && cat ${q(`${MNT}/来自客机.txt`)}`);
r.checks.otherBotAppend = { ok: b.ok && b.out.endsWith('b 追加'), err: b.err };

// 5) 两个 bot 同时往同一个文件追加 200 行
const N = 200;
fs.writeFileSync(path.join(HOST, 'shared.log'), '');
await Promise.all(['bot-a', 'bot-b'].map(u => asBot(u, `for i in $(seq ${N}); do echo "${u} $i" >> ${MNT}/shared.log; done`)));
const lines = fs.readFileSync(path.join(HOST, 'shared.log'), 'utf8').split('\n').filter(Boolean);
r.checks.concurrentAppendSameFile = { expected: 2 * N, got: lines.length, ok: lines.length === 2 * N };

// 6) 宿主和客机同时各写 200 个不同文件
const hostFiles = (async () => { for (let i = 0; i < N; i++) { fs.writeFileSync(path.join(HOST, `h-${i}.txt`), `h${i}`); await sleep(0); } })();
const guestFiles = asBot('bot-a', `for i in $(seq 0 ${N - 1}); do echo g$i > ${MNT}/g-$i.txt; done`);
await Promise.all([hostFiles, guestFiles]);
const listing = await asBot('bot-b', `ls ${MNT} | grep -c -E '^(h|g)-'`);
r.checks.concurrentDistinctFiles = { expected: 2 * N, guestSees: Number(listing.out), hostSees: fs.readdirSync(HOST).filter(f => /^(h|g)-/.test(f)).length };
r.checks.concurrentDistinctFiles.ok = r.checks.concurrentDistinctFiles.guestSees === 2 * N && r.checks.concurrentDistinctFiles.hostSees === 2 * N;

// 7) 可执行位
const x = await asBot('bot-a', `printf '#!/bin/sh\\necho ran\\n' > ${MNT}/run.sh && chmod +x ${MNT}/run.sh; ${MNT}/run.sh`);
r.checks.execBit = { ok: x.out === 'ran', err: x.err.split('\n')[0] };

// 8) 小文件吞吐：客机侧写 500 个 1 KiB 文件，对比客机本地盘
const timeIt = async (dir) => { const s = Date.now(); const o = await asBot('bot-a', `mkdir -p ${dir} && for i in $(seq 500); do head -c 1024 /dev/zero > ${dir}/f$i; done && cat ${dir}/f* > /dev/null`); return { ok: o.ok, ms: Date.now() - s }; };
r.checks.smallFiles500 = { mount: await timeIt(`${MNT}/perf`), guestLocal: await timeIt('/home/bot-a/perf') };

r.pass = ['hostWriteGuestRead', 'hostAtomicRenameGuestRead', 'guestWriteHostRead', 'otherBotAppend', 'concurrentDistinctFiles'].every(k => r.checks[k].ok);
fs.writeFileSync(new URL('proof.json', import.meta.url), JSON.stringify(r, null, 2) + '\n');
console.log(JSON.stringify(r, null, 1));
process.exit(0);
