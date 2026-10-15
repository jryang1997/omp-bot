import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { createAttachmentTray } from '../web/workbench-attach.js';

const home = mkdtempSync(join(tmpdir(), 'ompbot-attachment-drafts-'));
const server = await startServer({ home, port: 0, bin: join(home, 'no-model') });
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => nativeFetch(new URL(url, server.url), {
  ...init, headers: { ...init.headers, Authorization: `Bearer ${server.token}` },
});
const tray = createAttachmentTray();
const file = name => new File(['project notes'], name, { type: 'text/plain' });
async function bot(name) {
  const result = await fetch('/api/bots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  assert.equal(result.status, 200);
  return (await result.json()).bot;
}
try {
  const a = await bot('A');
  const b = await bot('B');
  tray.setBot(a.id);
  const first = await tray.upload(file('first.txt'));
  tray.setBot(b.id);
  assert.deepEqual(tray.ids(), []);
  tray.setBot(a.id);
  assert.deepEqual(tray.ids(), [first.id]);
  console.log('PASS attachment drafts follow their owning assistant');

  let finishRead;
  const delayed = file('delayed.txt');
  const read = delayed.arrayBuffer.bind(delayed);
  delayed.arrayBuffer = () => new Promise(resolve => { finishRead = async () => resolve(await read()); });
  const pending = tray.upload(delayed);
  tray.setBot(b.id);
  await finishRead();
  const late = await pending;
  assert.deepEqual(tray.ids(), []);
  const aAttachments = await (await fetch(`/api/attachments?botId=${a.id}`)).json();
  const bAttachments = await (await fetch(`/api/attachments?botId=${b.id}`)).json();
  assert.ok(aAttachments.attachments.some(item => item.id === late.id));
  assert.ok(!bAttachments.attachments.some(item => item.id === late.id));
  tray.setBot(a.id);
  assert.equal(tray.items().find(item => item.id === late.id).botId, a.id);
  assert.deepEqual(tray.ids(), [first.id, late.id]);
  console.log('PASS an in-flight upload retains the assistant selected at upload start');

  const sentIds = tray.ids();
  const next = await tray.upload(file('next.txt'));
  tray.setBot(b.id);
  const bFile = await tray.upload(file('b.txt'));
  tray.clear(a.id, sentIds);
  assert.deepEqual(tray.ids(), [bFile.id]);
  tray.setBot(a.id);
  assert.deepEqual(tray.ids(), [next.id]);
  console.log('PASS accepting a submission removes only its files without clearing newer drafts');
} finally {
  globalThis.fetch = nativeFetch;
  await server.close();
  rmSync(home, { recursive: true, force: true });
}
