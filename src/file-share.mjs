// file-share.mjs — 给共享电脑用的内置 SFTP 服务。
//
// 共享电脑经 QEMU 用户网络的 10.0.2.2 连回宿主，用 sshfs 把两类目录挂进客机：
//   用户名 workspace   → team/workspace，root 挂到 /workspace，team 组可写
//   用户名 <bot id>    → team/bots/<id>/work，这个 bot 的座席用户自己挂到 ~/work
// 只监听 127.0.0.1，只认 omp-bot 给这个用户名生成的那把密钥。每个用户名一把，
// 一个座席拿到的密钥登不进别的根。路径不许有 ..，跟随符号链接后必须还在根里。
// 不做缓存，每个请求直接读写磁盘，宿主和客机看到的是同一份文件。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

export const WORKSPACE_USER = 'workspace';
/** known_hosts 里用这个别名，端口换了也不用改。 */
export const HOST_KEY_ALIAS = 'omp-bot-share';
const USER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const READDIR_BATCH = 64;
const MAX_READ = 256 * 1024;

function statusOf(error) {
  switch (error?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return STATUS_CODE.NO_SUCH_FILE;
    case 'EACCES':
    case 'EPERM':
    case 'EOUTSIDE':
      return STATUS_CODE.PERMISSION_DENIED;
    default:
      return STATUS_CODE.FAILURE;
  }
}

function outside(what) {
  const error = new Error(`${what} 不在这个共享目录里`);
  error.code = 'EOUTSIDE';
  return error;
}

function attrsOf(st) {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.trunc(st.atimeMs / 1000),
    mtime: Math.trunc(st.mtimeMs / 1000),
  };
}

function openFlags(pflags) {
  const c = fs.constants;
  const read = (pflags & OPEN_MODE.READ) !== 0;
  const write = (pflags & OPEN_MODE.WRITE) !== 0 || (pflags & OPEN_MODE.APPEND) !== 0;
  let flags = read && write ? c.O_RDWR : write ? c.O_WRONLY : c.O_RDONLY;
  if (pflags & OPEN_MODE.APPEND) flags |= c.O_APPEND;
  if (pflags & OPEN_MODE.CREAT) flags |= c.O_CREAT;
  if (pflags & OPEN_MODE.TRUNC) flags |= c.O_TRUNC;
  if (pflags & OPEN_MODE.EXCL) flags |= c.O_EXCL;
  return flags;
}

function longname(name, st) {
  const type = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-';
  const bits = 'rwxrwxrwx'.split('').map((ch, i) => (st.mode & (0o400 >> i) ? ch : '-')).join('');
  return `${type}${bits} 1 ${st.uid} ${st.gid} ${st.size} ${new Date(st.mtimeMs).toISOString().slice(0, 16)} ${name}`;
}

function writeSecret(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

/** 一个 SFTP 会话，所有路径都落在 root 里。 */
class ShareSession {
  #sftp;
  #root;
  #handles = new Map();
  #next = 0;

  constructor(sftp, root) {
    this.#sftp = sftp;
    this.#root = root;
    const on = (event, fn) => sftp.on(event, (reqid, ...args) => {
      Promise.resolve()
        .then(() => fn(reqid, ...args))
        .catch(error => {
          try {
            sftp.status(reqid, statusOf(error), error?.code === 'EOUTSIDE' ? error.message : undefined);
          } catch {}
        });
    });
    on('OPEN', (id, file, pflags, attrs) => this.#open(id, file, pflags, attrs));
    on('READ', (id, handle, offset, length) => this.#read(id, handle, offset, length));
    on('WRITE', (id, handle, offset, data) => this.#write(id, handle, offset, data));
    on('FSTAT', async (id, handle) => sftp.attrs(id, attrsOf(await this.#fileOf(handle).fh.stat())));
    on('FSETSTAT', async (id, handle, attrs) => {
      await this.#applyAttrs(this.#fileOf(handle).fh, attrs);
      sftp.status(id, STATUS_CODE.OK);
    });
    on('CLOSE', (id, handle) => this.#close(id, handle));
    on('OPENDIR', (id, dir) => this.#opendir(id, dir));
    on('READDIR', (id, handle) => this.#readdir(id, handle));
    on('LSTAT', async (id, p) => sftp.attrs(id, attrsOf(await fsp.lstat(await this.#resolve(p, { follow: false })))));
    on('STAT', async (id, p) => sftp.attrs(id, attrsOf(await fsp.stat(await this.#resolve(p)))));
    on('SETSTAT', async (id, p, attrs) => {
      // 按路径改，只读打开的句柄截断不了文件
      const real = await this.#resolve(p);
      if (Number.isInteger(attrs?.size)) await fsp.truncate(real, attrs.size);
      if (Number.isInteger(attrs?.mode)) await fsp.chmod(real, attrs.mode & 0o7777);
      if (Number.isFinite(attrs?.atime) && Number.isFinite(attrs?.mtime)) await fsp.utimes(real, attrs.atime, attrs.mtime);
      sftp.status(id, STATUS_CODE.OK);
    });
    on('REMOVE', async (id, p) => {
      await fsp.unlink(await this.#resolve(p, { follow: false, notRoot: true }));
      sftp.status(id, STATUS_CODE.OK);
    });
    on('RMDIR', async (id, p) => {
      await fsp.rmdir(await this.#resolve(p, { follow: false, notRoot: true }));
      sftp.status(id, STATUS_CODE.OK);
    });
    on('MKDIR', async (id, p, attrs) => {
      await fsp.mkdir(await this.#resolve(p, { follow: false, notRoot: true }), { mode: attrs?.mode ?? 0o777 });
      sftp.status(id, STATUS_CODE.OK);
    });
    // 目标已存在时直接覆盖（POSIX rename），编辑器写临时文件再改名的保存方式才能用
    on('RENAME', async (id, from, to) => {
      const a = await this.#resolve(from, { follow: false, notRoot: true });
      const b = await this.#resolve(to, { follow: false, notRoot: true });
      await fsp.rename(a, b);
      sftp.status(id, STATUS_CODE.OK);
    });
    on('REALPATH', async (id, p) => {
      const virt = this.#virtual(p);
      sftp.name(id, [{ filename: virt, longname: virt, attrs: {} }]);
    });
    on('READLINK', async (id, p) => {
      const real = await this.#resolve(p, { follow: false });
      const target = await fsp.readlink(real);
      if (path.isAbsolute(target)) throw outside('符号链接的目标');
      this.#inside(path.resolve(path.dirname(real), target), '符号链接的目标');
      sftp.name(id, [{ filename: target, longname: target, attrs: {} }]);
    });
    // 只许建指向根内的相对链接
    on('SYMLINK', async (id, linkPath, target) => {
      const real = await this.#resolve(linkPath, { follow: false, notRoot: true });
      if (typeof target !== 'string' || target === '' || path.isAbsolute(target)) throw outside('符号链接的目标');
      this.#inside(path.resolve(path.dirname(real), target), '符号链接的目标');
      await fsp.symlink(target, real);
      sftp.status(id, STATUS_CODE.OK);
    });
    sftp.on('end', () => this.#closeAll());
    sftp.on('close', () => this.#closeAll());
  }

  /** SFTP 路径换成根里的绝对虚拟路径；有 .. 就拒绝。 */
  #virtual(p) {
    const s = String(p ?? '');
    if (s.includes('\u0000')) throw outside('路径');
    const parts = s.split('/');
    if (parts.includes('..')) throw outside(`路径 ${s}`);
    const norm = path.posix.normalize(`/${s}`).replace(/\/+$/, '');
    return norm === '' ? '/' : norm;
  }

  #inside(real, what = '路径') {
    if (real !== this.#root && !real.startsWith(`${this.#root}${path.sep}`)) throw outside(what);
  }

  /**
   * 虚拟路径 → 宿主真实路径。follow 时跟随全部符号链接，结果必须在根里；
   * 不跟随（或者文件还不存在）时父目录的真实路径必须在根里。
   */
  async #resolve(p, { follow = true, notRoot = false } = {}) {
    const virt = this.#virtual(p);
    if (virt === '/') {
      if (notRoot) throw outside('共享根目录本身');
      return this.#root;
    }
    const full = path.join(this.#root, ...virt.split('/').filter(Boolean));
    if (follow) {
      try {
        const real = await fsp.realpath(full);
        this.#inside(real);
        return real;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        // 悬空的符号链接：O_CREAT 会在链接目标那里建文件，拒绝
        const link = await fsp.lstat(full).catch(() => null);
        if (link?.isSymbolicLink()) throw outside('悬空符号链接的目标');
      }
    }
    const parent = await fsp.realpath(path.dirname(full));
    this.#inside(parent);
    return path.join(parent, path.basename(full));
  }

  #handle(entry) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(this.#next++ >>> 0);
    this.#handles.set(buf.toString('hex'), entry);
    return buf;
  }

  #entry(handle) {
    const entry = this.#handles.get(Buffer.from(handle).toString('hex'));
    if (!entry) {
      const error = new Error('无效的句柄');
      error.code = 'EBADF';
      throw error;
    }
    return entry;
  }

  #fileOf(handle) {
    const entry = this.#entry(handle);
    if (entry.kind !== 'file') throw Object.assign(new Error('不是文件句柄'), { code: 'EBADF' });
    return entry;
  }

  async #open(id, file, pflags, attrs) {
    const real = await this.#resolve(file);
    const fh = await fsp.open(real, openFlags(pflags), attrs?.mode ?? 0o666);
    if ((await fh.stat()).isDirectory()) {
      await fh.close();
      throw Object.assign(new Error('是目录'), { code: 'EISDIR' });
    }
    this.#sftp.handle(id, this.#handle({ kind: 'file', fh, append: (pflags & OPEN_MODE.APPEND) !== 0 }));
  }

  async #read(id, handle, offset, length) {
    const { fh } = this.#fileOf(handle);
    const buf = Buffer.alloc(Math.min(length, MAX_READ));
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    if (bytesRead === 0) this.#sftp.status(id, STATUS_CODE.EOF);
    else this.#sftp.data(id, buf.subarray(0, bytesRead));
  }

  async #write(id, handle, offset, data) {
    const { fh, append } = this.#fileOf(handle);
    let done = 0;
    while (done < data.length) {
      // O_APPEND 下每次写都落在文件末尾，两个客户端同时追加不会互相覆盖
      const { bytesWritten } = await fh.write(data, done, data.length - done, append ? null : offset + done);
      done += bytesWritten;
    }
    this.#sftp.status(id, STATUS_CODE.OK);
  }

  async #applyAttrs(fh, attrs = {}) {
    if (Number.isInteger(attrs.size)) await fh.truncate(attrs.size);
    if (Number.isInteger(attrs.mode)) await fh.chmod(attrs.mode & 0o7777);
    if (Number.isFinite(attrs.atime) && Number.isFinite(attrs.mtime)) await fh.utimes(attrs.atime, attrs.mtime);
  }

  async #close(id, handle) {
    const key = Buffer.from(handle).toString('hex');
    const entry = this.#handles.get(key);
    if (!entry) throw Object.assign(new Error('无效的句柄'), { code: 'EBADF' });
    this.#handles.delete(key);
    if (entry.kind === 'file') await entry.fh.close();
    this.#sftp.status(id, STATUS_CODE.OK);
  }

  async #opendir(id, dir) {
    const real = await this.#resolve(dir);
    if (!(await fsp.stat(real)).isDirectory()) throw Object.assign(new Error('不是目录'), { code: 'ENOTDIR' });
    this.#sftp.handle(id, this.#handle({ kind: 'dir', real, names: null }));
  }

  async #readdir(id, handle) {
    const entry = this.#entry(handle);
    if (entry.kind !== 'dir') throw Object.assign(new Error('不是目录句柄'), { code: 'EBADF' });
    if (!entry.names) {
      const names = [];
      for (const name of ['.', '..', ...(await fsp.readdir(entry.real))]) {
        const st = await fsp.lstat(name === '..' ? path.dirname(entry.real) : path.join(entry.real, name)).catch(() => null);
        if (st) names.push({ filename: name, longname: longname(name, st), attrs: attrsOf(st) });
      }
      entry.names = names;
    }
    if (entry.names.length === 0) {
      this.#sftp.status(id, STATUS_CODE.EOF);
      return;
    }
    this.#sftp.name(id, entry.names.splice(0, READDIR_BATCH));
  }

  #closeAll() {
    for (const entry of this.#handles.values()) if (entry.kind === 'file') entry.fh.close().catch(() => {});
    this.#handles.clear();
  }
}

export class FileShare {
  #dir;
  #roots;
  #server = null;
  #starting = null;
  #port = null;
  #hostKey;
  #hostPublic;
  #clients = new Set();

  /**
   * @param {object} opts
   * @param {string} opts.home 应用数据根，密钥放 <home>/computers/file-share/
   * @param {(username: string) => string|null} opts.roots 用户名对应的宿主目录，不认识就返回 null
   */
  constructor({ home, roots } = {}) {
    if (typeof home !== 'string' || !home) throw new Error('FileShare 需要 home');
    if (typeof roots !== 'function') throw new Error('FileShare 需要 roots(username)');
    this.#dir = path.join(path.resolve(home), 'computers', 'file-share');
    this.#roots = roots;
    const hostFile = path.join(this.#dir, 'host_ed25519');
    if (!fs.existsSync(hostFile) || !fs.existsSync(`${hostFile}.pub`)) {
      const pair = utils.generateKeyPairSync('ed25519', { comment: 'omp-bot file share host' });
      writeSecret(hostFile, pair.private);
      writeSecret(`${hostFile}.pub`, `${pair.public}\n`, 0o644);
    }
    this.#hostKey = fs.readFileSync(hostFile, 'utf8');
    this.#hostPublic = fs.readFileSync(`${hostFile}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  }

  get port() {
    return this.#port;
  }

  /** known_hosts 的一行。客机 ssh 用 HostKeyAlias，端口变了也对得上。 */
  get knownHosts() {
    return `${HOST_KEY_ALIAS} ${this.#hostPublic}`;
  }

  /** 这个用户名的客户端私钥。第一次要时生成，之后不变。 */
  credentials(username) {
    if (!USER_PATTERN.test(String(username ?? ''))) throw new Error(`共享目录用户名不合法：${JSON.stringify(username)}`);
    const file = path.join(this.#dir, 'clients', username);
    if (!fs.existsSync(file) || !fs.existsSync(`${file}.pub`)) {
      const pair = utils.generateKeyPairSync('ed25519', { comment: `omp-bot ${username}` });
      writeSecret(file, pair.private);
      writeSecret(`${file}.pub`, `${pair.public}\n`, 0o644);
    }
    return { username, privateKey: fs.readFileSync(file, 'utf8') };
  }

  /** 只监听 127.0.0.1。优先用上次的端口，客机里 sshfs 的 reconnect 才接得上。 */
  async start() {
    if (this.#server) return { port: this.#port };
    if (!this.#starting) {
      this.#starting = this.#listen().finally(() => {
        this.#starting = null;
      });
    }
    return await this.#starting;
  }

  async close() {
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    for (const client of this.#clients) client.end();
    this.#clients.clear();
    if (server) await new Promise(resolve => server.close(() => resolve()));
  }

  async #listen() {
    const portFile = path.join(this.#dir, 'port.json');
    let preferred = 0;
    try {
      preferred = Number(JSON.parse(fs.readFileSync(portFile, 'utf8')).port) || 0;
    } catch {}
    const server = new Server({ hostKeys: [this.#hostKey], ident: 'omp-bot-share' }, client => this.#onClient(client));
    const listen = port => new Promise((resolve, reject) => {
      const onError = error => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    try {
      await listen(preferred);
    } catch (error) {
      if (!preferred || error?.code !== 'EADDRINUSE') throw error;
      await listen(0);
    }
    this.#server = server;
    this.#port = server.address().port;
    writeSecret(portFile, `${JSON.stringify({ port: this.#port })}\n`, 0o644);
    return { port: this.#port };
  }

  #expectedKey(username) {
    if (!USER_PATTERN.test(username)) return null;
    try {
      return utils.parseKey(fs.readFileSync(path.join(this.#dir, 'clients', `${username}.pub`), 'utf8'));
    } catch {
      return null;
    }
  }

  #onClient(client) {
    this.#clients.add(client);
    let root = null;
    client.on('error', () => {});
    client.on('close', () => this.#clients.delete(client));
    client.on('authentication', ctx => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
      const expected = this.#expectedKey(ctx.username);
      const dir = expected && !(expected instanceof Error) ? this.#roots(ctx.username) : null;
      const offered = Buffer.from(ctx.key?.data ?? []);
      const want = expected && !(expected instanceof Error) ? expected.getPublicSSH() : null;
      if (!dir || !want || ctx.key?.algo !== expected.type || offered.length !== want.length || !timingSafeEqual(offered, want)) {
        return ctx.reject(['publickey']);
      }
      if (ctx.signature && expected.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(['publickey']);
      if (!ctx.signature) return ctx.accept();
      try {
        fs.mkdirSync(dir, { recursive: true });
        root = fs.realpathSync(dir);
      } catch {
        return ctx.reject(['publickey']);
      }
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('sftp', acceptSftp => {
          if (!root) return;
          new ShareSession(acceptSftp(), root);
        });
      });
    });
  }
}

/** 端口能不能连上（测试和诊断用）。 */
export function probePort(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    const done = ok => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
