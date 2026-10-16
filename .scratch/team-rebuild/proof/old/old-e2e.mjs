// 10 沙盒端到端：真的打包和解包。旧电脑里的打包脚本（src/computer-seats.mjs 的 OLD_EXPORT）以一个普通用户跑，
// 替旧电脑里的 cua；guest/omp-seat import-old 以 root 跑，解进一个真的座席用户的 ~/old-computer/。
// 宿主中转（下载、上传）在座席层的替身测试里，这里只验证两个脚本在真实 Linux 上的行为。
// 运行：cd /data/omp-bot && node .scratch/team-rebuild/proof/old/old-e2e.mjs（要免密 sudo，沙盒里原本没有 /work）
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OLD_EXPORT, OLD_EXPORT_DIR, OLD_INBOX } from '../../../../src/computer-seats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const SEAT = `${REPO}/guest/omp-seat`;
const OLD = 'omp-oldcua';
const USER = 'omp-oldseat';
const sh = (cmd, { user = null, input } = {}) => {
  const args = user ? ['-n', '-u', user, '-H', 'bash', '-c', cmd] : ['-n', 'bash', '-c', cmd];
  return execFileSync('sudo', args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
};
const trySh = (cmd, opts) => { try { return { ok: true, out: sh(cmd, opts) }; } catch (e) { return { ok: false, out: String(e.stderr ?? e.message) }; } };
const proof = { startedAt: new Date().toISOString(), checks: [] };
const pass = (name, detail = {}) => { proof.checks.push({ name, ...detail }); console.log(`PASS  ${name}`); };
let createdWork = false;
try {
  assert.ok(!fs.existsSync('/work'), '/work 已经存在，不在这台机器上跑');
  for (const u of [OLD, USER]) trySh(`pkill -KILL -u ${u}; userdel -r ${u}`);
  sh(`getent group team >/dev/null || groupadd team; useradd -m -s /bin/bash ${OLD}; useradd -m -s /bin/bash -G team ${USER}; chmod 0700 /home/${USER}`);
  sh(`rm -rf ${OLD_INBOX} ${OLD_EXPORT_DIR}; install -d -o ${OLD} -g ${OLD} /work`);
  createdWork = true;

  // 旧电脑：/work 和主目录里有文件，还有缓存、浏览器 profile、读不到的文件和一个指向外面的链接
  sh([
    'set -e; cd /work',
    'mkdir -p proj/src; echo old-main > proj/src/main.py; echo old-keep > keep.txt; printf "%s" "带空格 和中文" > "笔记 一.md"',
    'ln -s /etc/passwd outside-link',
    'cd ~; echo hello > notes.txt; mkdir -p .cache/pip .config/chromium/Default .config/other; echo junk > .cache/pip/x; echo cookie > .config/chromium/Default/Cookies; echo keep > .config/other/rc',
  ].join('\n'), { user: OLD });
  sh(`echo secret > /work/root-only.txt; chmod 600 /work/root-only.txt; chown root:root /work/root-only.txt`);

  const packed = sh(OLD_EXPORT, { user: OLD });
  assert.match(packed, /work\.tgz \d+/);
  const listing = sh(`export LC_ALL=C.UTF-8; tar --quoting-style=literal -tzf ${OLD_EXPORT_DIR}/work.tgz; echo ---; tar --quoting-style=literal -tzf ${OLD_EXPORT_DIR}/home.tgz`);
  const [workList, homeList] = listing.split('---\n');
  assert.ok(workList.includes('work/proj/src/main.py') && workList.includes('work/笔记 一.md'));
  assert.ok(!workList.includes('root-only.txt'), '读不到的文件跳过，不让整个打包失败');
  assert.ok(homeList.includes('./notes.txt') && homeList.includes('./.config/other/rc'));
  assert.ok(!/\.cache|\.config\/chromium/.test(homeList), '缓存和浏览器 profile 不打包');
  pass('旧电脑打包：/work 和主目录进包，读不到的文件跳过，缓存和浏览器 profile 不带', { bytes: packed.trim() });

  // 座席里已经有 ~/old-computer/work/keep.txt（比如上次复制了一半）
  sh(`mkdir -p ~/old-computer/work; echo seat-new > ~/old-computer/work/keep.txt`, { user: USER });
  const put = () => sh(`install -d -m 0700 ${OLD_INBOX}; install -m 0600 ${OLD_EXPORT_DIR}/work.tgz ${OLD_INBOX}/pc_x-work.tgz; install -m 0600 ${OLD_EXPORT_DIR}/home.tgz ${OLD_INBOX}/pc_x-home.tgz`);
  put();
  const out = sh(`${SEAT} import-old ${USER} ${OLD_INBOX}/pc_x-work.tgz ${OLD_INBOX}/pc_x-home.tgz`);
  assert.match(out, new RegExp(`dest=/home/${USER}/old-computer`));
  const files = Number(/files=(\d+)/.exec(out)?.[1]);
  const dest = `/home/${USER}/old-computer`;
  assert.equal(sh(`cat ${dest}/work/proj/src/main.py`).trim(), 'old-main');
  assert.equal(sh(`cat "${dest}/work/笔记 一.md"`), '带空格 和中文');
  assert.equal(sh(`cat ${dest}/work/keep.txt`).trim(), 'seat-new', '已有的文件不覆盖');
  assert.equal(sh(`cat ${dest}/home/notes.txt; cat ${dest}/home/.config/other/rc`), 'hello\nkeep\n');
  assert.equal(sh(`readlink ${dest}/work/outside-link`).trim(), '/etc/passwd', '链接原样保留');
  assert.equal(sh(`find ${dest} ! -user ${USER} | wc -l`).trim(), '0', '全部归座席用户');
  assert.equal(sh(`stat -c %a ${dest}`).trim(), '700');
  assert.equal(sh(`ls ${OLD_INBOX} | wc -l`).trim(), '0', '解完删包');
  assert.equal(sh(`stat -c '%U %a' ${OLD_INBOX}`).trim(), 'root 700');
  assert.notEqual(trySh(`cat ${dest}/work/keep.txt`, { user: OLD }).ok, true, '别的用户读不到');
  pass('解进座席的 ~/old-computer：文件归座席用户，已有文件不覆盖，中文和空格文件名照常，包解完就删', { files });

  // 再来一次：什么都不覆盖
  sh(`echo seat-edit > ${dest}/work/proj/src/main.py`, { user: USER });
  put();
  sh(`${SEAT} import-old ${USER} ${OLD_INBOX}/pc_x-work.tgz ${OLD_INBOX}/pc_x-home.tgz`);
  assert.equal(sh(`cat ${dest}/work/proj/src/main.py`).trim(), 'seat-edit');
  pass('重复解包不覆盖座席里改过的文件');

  // 拒绝
  put();
  const bad = [
    [`${SEAT} import-old ${USER} /tmp/x.tgz ${OLD_INBOX}/pc_x-home.tgz`, /旧电脑的包不对/],
    [`${SEAT} import-old ${USER} ${OLD_INBOX}/../omp-old/pc_x-work.tgz ${OLD_INBOX}/pc_x-home.tgz`, /旧电脑的包不对/],
    [`${SEAT} import-old omp-nobody-here ${OLD_INBOX}/pc_x-work.tgz ${OLD_INBOX}/pc_x-home.tgz`, /座席用户不存在/],
    [`${SEAT} import-old root ${OLD_INBOX}/pc_x-work.tgz ${OLD_INBOX}/pc_x-home.tgz`, /座席用户名不合法/],
  ];
  for (const [cmd, want] of bad) {
    const r = trySh(cmd);
    assert.equal(r.ok, false, cmd);
    assert.match(r.out, want, cmd);
  }
  sh(`rm -rf ${dest}; ln -s /etc ${dest}`, { user: USER });
  const link = trySh(`${SEAT} import-old ${USER} ${OLD_INBOX}/pc_x-work.tgz ${OLD_INBOX}/pc_x-home.tgz`);
  assert.equal(link.ok, false);
  assert.match(link.out, /是符号链接，不解/);
  pass('拒绝：包不在收件目录、路径带 ..、用户不存在或不是座席用户、~/old-computer 是符号链接');
  proof.result = `${proof.checks.length}/${proof.checks.length} PASS`;
} catch (error) {
  proof.error = String(error?.stack ?? error);
  console.log(`FAIL  ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  for (const u of [OLD, USER]) trySh(`pkill -KILL -u ${u}; userdel -r ${u}`);
  if (createdWork) trySh('rm -rf /work');
  trySh(`rm -rf ${OLD_INBOX} ${OLD_EXPORT_DIR}`);
  proof.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(HERE, 'old-e2e.json'), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(proof.result ?? 'FAILED');
}
