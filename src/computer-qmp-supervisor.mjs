import { timingSafeEqual } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const RAW_CONNECT_DEADLINE_MS = 60_000;
const RAW_GREETING_TIMEOUT_MS = 15_000;
const RAW_LINE_LIMIT_BYTES = 4 * 1024 * 1024;
const QMP_COMMAND_TIMEOUT_MS = 10_000;
const CONTROL_IDLE_TIMEOUT_MS = 20_000;
const CONTROL_REQUEST_LIMIT_BYTES = 8 * 1024;
const PIPE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const FORWARDED_COMMANDS = new Set(['query-status', 'query-block', 'query-name', 'system_powerdown', 'quit']);

function pipePath(name) {
  return `\\\\.\\pipe\\${name}`;
}

function fail(message) {
  process.stderr.write(`computer-qmp-supervisor: ${message}\n`);
  process.exit(1);
}

function parseOptions(argv) {
  const options = { raw: null, control: null, keyFile: null };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (typeof value !== 'string') fail(`missing value for ${name}`);
    if (name === '--raw-pipe') options.raw = value;
    else if (name === '--control-pipe') options.control = value;
    else if (name === '--key-file') options.keyFile = value;
    else fail(`unknown option ${name}`);
  }
  if (
    !PIPE_NAME_PATTERN.test(options.raw ?? '') ||
    !PIPE_NAME_PATTERN.test(options.control ?? '') ||
    typeof options.keyFile !== 'string' ||
    options.keyFile === ''
  ) {
    fail('usage: computer-qmp-supervisor.mjs --raw-pipe <name> --control-pipe <name> --key-file <path>');
  }
  return options;
}

function readControlKey(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(text)) return null;
    return Buffer.from(text, 'hex');
  } catch {
    return null;
  }
}

const options = parseOptions(process.argv.slice(2));
const controlKey = readControlKey(options.keyFile);
if (controlKey === null) fail(`cannot read a 64-hex host control key from ${options.keyFile}`);

let rawSocket = null;
let rawBuffer = '';
let greetingWaiter = null;
let controlServer = null;
let nextId = 0;
let chain = Promise.resolve();
let stopping = false;
const pending = new Map();
const clients = new Set();

function stop() {
  if (stopping) return;
  stopping = true;
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('the QEMU QMP session ended'));
  }
  pending.clear();
  for (const socket of clients) socket.destroy();
  clients.clear();
  controlServer?.close();
  rawSocket?.destroy();
  process.exit(0);
}

function send(command, args) {
  const work = () =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`QMP ${command} timed out`));
      }, QMP_COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      const payload = args === undefined ? { execute: command, id } : { execute: command, arguments: args, id };
      rawSocket.write(`${JSON.stringify(payload)}\n`, error => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  const result = chain.then(work, work);
  chain = result.then(() => undefined, () => undefined);
  return result;
}

function dispatchRaw(message) {
  if (message?.QMP !== undefined) {
    const waiter = greetingWaiter;
    greetingWaiter = null;
    waiter?.();
    return;
  }
  if (message?.event !== undefined) return;
  const id = message?.id;
  if (id === undefined || id === null) return;
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (message.error) {
    entry.reject(new Error(`QMP ${message.error.class ?? 'error'}: ${message.error.desc ?? 'unknown error'}`));
    return;
  }
  entry.resolve(message.return);
}

function onRawData(chunk) {
  rawBuffer += chunk.toString('utf8');
  for (;;) {
    const index = rawBuffer.indexOf('\n');
    if (index < 0) {
      if (rawBuffer.length > RAW_LINE_LIMIT_BYTES) fail('the QMP session sent a line over the framing limit');
      return;
    }
    const line = rawBuffer.slice(0, index).trim();
    rawBuffer = rawBuffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    dispatchRaw(message);
  }
}

function keyMatches(candidate) {
  const provided = Buffer.from(candidate, 'hex');
  return provided.length === controlKey.length && timingSafeEqual(provided, controlKey);
}

function handleClient(socket) {
  clients.add(socket);
  socket.setTimeout(CONTROL_IDLE_TIMEOUT_MS, () => socket.destroy());
  let text = '';
  let answered = false;
  const respond = payload => {
    if (answered) return;
    answered = true;
    socket.end(`${JSON.stringify(payload)}\n`);
  };
  socket.on('data', chunk => {
    if (answered) return;
    text += chunk.toString('utf8');
    const index = text.indexOf('\n');
    if (index < 0) {
      if (text.length > CONTROL_REQUEST_LIMIT_BYTES) respond({ ok: false, error: { class: 'request_too_large' } });
      return;
    }
    let request;
    try {
      request = JSON.parse(text.slice(0, index));
    } catch {
      respond({ ok: false, error: { class: 'invalid_request' } });
      return;
    }
    if (typeof request?.key !== 'string' || !keyMatches(request.key)) {
      respond({ ok: false, error: { class: 'unauthorized' } });
      return;
    }
    if (typeof request.command !== 'string' || !FORWARDED_COMMANDS.has(request.command)) {
      respond({ ok: false, error: { class: 'command_not_allowed' } });
      return;
    }
    const args = request.arguments;
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      respond({ ok: false, error: { class: 'invalid_request' } });
      return;
    }
    if (rawSocket === null || stopping) {
      respond({ ok: false, error: { class: 'qmp_session_unavailable' } });
      return;
    }
    send(request.command, args ?? undefined).then(
      value => respond({ ok: true, return: value ?? null }),
      error => respond({ ok: false, error: { class: 'qmp_failed', desc: String(error?.message ?? error) } }),
    );
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => clients.delete(socket));
}

async function openRawSession() {
  const deadline = Date.now() + RAW_CONNECT_DEADLINE_MS;
  for (;;) {
    try {
      rawSocket = await new Promise((resolve, reject) => {
        const socket = createConnection({ path: pipePath(options.raw) });
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`the QEMU QMP pipe ${options.raw} never accepted a connection`);
      await sleep(100);
    }
  }
  rawSocket.on('data', onRawData);
  rawSocket.on('error', stop);
  rawSocket.on('close', stop);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      greetingWaiter = null;
      reject(new Error('the QEMU QMP greeting timed out'));
    }, RAW_GREETING_TIMEOUT_MS);
    greetingWaiter = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  await send('qmp_capabilities');
}

async function main() {
  await openRawSession();
  controlServer = createServer(handleClient);
  controlServer.on('error', error => fail(`the control pipe ${options.control} failed: ${error?.message ?? error}`));
  await new Promise((resolve, reject) => {
    controlServer.once('listening', resolve);
    controlServer.once('error', reject);
    controlServer.listen(pipePath(options.control));
  });
}

main().catch(error => fail(String(error?.message ?? error)));
