import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../../src/server.mjs';

const home = mkdtempSync(join(tmpdir(), 'ompbot-quality-'));
const service = await startServer({ port: 0, home, bin: 'C:/Users/Jerry/Desktop/omp_bot/.desktop-runtime/omp.exe' });
const observations = [];
const results = [];
let reader;
async function api(path, body) {
  const response = await fetch(service.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + service.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(JSON.stringify(data)), { status: response.status });
  return data;
}
async function terminal(id) {
  const expires = Date.now() + 180000;
  while (Date.now() < expires) {
    const { run } = await api('/api/runs/' + id);
    if (['completed', 'failed', 'cancelled', 'interrupted', 'reconciliation_required'].includes(run.state)) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Quality run did not reach a terminal state: ' + id);
}
try {
  const stream = await fetch(service.url + '/api/events', { headers: { Authorization: 'Bearer ' + service.token } });
  assert.equal(stream.status, 200);
  reader = stream.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let pending = '';
    try {
      for (;;) {
        const frame = await reader.read();
        if (frame.done) break;
        pending += decoder.decode(frame.value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) observations.push(JSON.parse(data));
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') console.error('SSE observation ended:', error.message);
    }
  })();
  const bots = [];
  for (const kind of ['research', 'development', 'data']) {
    const { bot } = await api('/api/bots', {
      name: 'Quality_' + kind,
      role: 'Temporary native acceptance ' + kind,
      model: 'magpie/commandcode-plan/deepseek/deepseek-v4.1-flash',
      thinking: 'low', executionMode: 'supervised', approvalMode: 'write',
      instructions: 'Read the supplied attachments with native tools. Write only the requested output inside your temporary working directory. Never alter input files, use network, send messages, or inspect other directories. Complete the exact requested content.',
    });
    bots.push(bot);
  }
  const source = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const metadata = JSON.parse(source);
  for (let sample = 0; sample < 30; sample++) {
    const kind = ['research', 'development', 'data'][sample % 3];
    const bot = bots[sample % 3];
    const round = Math.floor(sample / 3);
    const session = round === 0 ? 'first-process-and-session' : round % 2 === 0 ? 'new-session' : 'continued-session';
    if (round > 0 && round % 2 === 0) await api('/api/bots/' + bot.id + '/session/new', {});
    const rows = [{ qty: 2 + round, price: 7 }, { qty: 0, price: 100 }, { qty: -1, price: 3 }, { qty: 3, price: 5 }];
    const expectedTotal = rows.reduce((sum, row) => sum + row.qty * row.price, 0);
    let filename;
    let mime;
    let input;
    let output;
    let task;
    if (kind === 'research') {
      filename = 'package-source-' + round + '.json'; mime = 'application/json'; input = source; output = 'research-' + round + '.md';
      task = `Read the attached real repository package metadata. Write ${output} in your working directory. Report its exact package name, version, minimum Node engine, and each development dependency with version. Cite the attachment filename ${filename} as your source. State these are repository facts, without inventing runtime measurements.`;
    } else if (kind === 'development') {
      filename = 'requirements-' + round + '.txt'; mime = 'text/plain';
      input = 'Implement export function total(rows) in an ES module. Each row has qty and price; either field can be a numeric string. Return their product sum, preserving zero and negative quantities. Empty rows returns 0. No dependencies, imports, or side effects.';
      output = 'invoice-' + round + '.mjs';
      task = `Read the attached requirements. Write ${output} in your working directory implementing them. Deliver the executable ES module itself. Do not execute shell commands or create other files.`;
    } else {
      filename = 'sales-' + round + '.csv'; mime = 'text/csv';
      input = 'qty,price\n' + rows.map(row => `${row.qty},${row.price}`).join('\n') + '\n';
      output = 'analysis-' + round + '.json';
      task = `Read the attached CSV. Write ${output} in your working directory as one JSON object with exactly total (sum of qty*price including refunds), rowCount (data rows), nonzeroRows (qty != 0). Do not modify the original CSV or create other files.`;
    }
    const { attachment } = await api('/api/attachments', { botId: bot.id, filename, mime, dataBase64: Buffer.from(input).toString('base64') });
    const startedAt = Date.now();
    const { run: admitted } = await api('/api/runs', { botId: bot.id, text: task, attachmentIds: [attachment.id], timeoutMs: 150000 });
    const run = await terminal(admitted.id);
    assert.equal(run.state, 'completed', run.error ?? 'Unexpected terminal state');
    const { artifacts } = await api('/api/artifacts?runId=' + encodeURIComponent(run.id));
    const artifact = artifacts.find(item => item.name === output);
    assert.ok(artifact, 'Expected named deliverable not registered: ' + output);
    const response = await fetch(service.url + '/api/artifacts/' + artifact.id + '/download', { headers: { Authorization: 'Bearer ' + service.token } });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (kind === 'research') {
      const text = bytes.toString('utf8');
      for (const fact of [metadata.name, metadata.version, metadata.engines.node, filename, ...Object.entries(metadata.devDependencies).flat()]) assert.ok(text.includes(fact), 'Missing actual repository fact: ' + fact);
    } else if (kind === 'development') {
      const file = join(home, 'verified-' + sample + '.mjs');
      writeFileSync(file, bytes);
      const code = await import(pathToFileURL(file).href);
      assert.equal(code.total(rows), expectedTotal);
      assert.equal(code.total([]), 0);
      assert.equal(code.total([{ qty: '2', price: '7' }, { qty: '-1', price: '3' }]), 11);
    } else {
      assert.deepEqual(JSON.parse(bytes.toString('utf8')), { total: expectedTotal, rowCount: 4, nonzeroRows: 3 });
    }
    assert.equal(readFileSync(attachment.path, 'utf8'), input, 'Original input was changed');
    const events = observations.filter(event => event.runId === run.id && event.type === 'native_event');
    const firstEvent = events[0];
    const firstText = events.find(event => event.event?.type === 'message_update' && event.event.assistantMessageEvent?.type === 'text_delta');
    const row = { sample: sample + 1, kind, session, model: bot.model, runId: run.id, state: run.state, accepted: true, totalMs: Date.now() - startedAt, firstNativeEventMs: firstEvent ? firstEvent.at - startedAt : null, firstTextMs: firstText ? firstText.at - startedAt : null, stats: run.stats ?? null, artifactHash: artifact.hash };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  const usage = await api('/api/usage');
  writeFileSync(new URL('./quality-baseline.json', import.meta.url), JSON.stringify({ sampledAt: new Date().toISOString(), samples: results, usage, scope: '30 native tasks: actual repository-source reports, executable invoice modules, CSV analyses; first/new/continued sessions. No external service accounts or OS sandbox tested.' }, null, 2));
  console.log(JSON.stringify({ check: 'quality-baseline', accepted: results.length, expected: 30, usage: { totals: usage.totals, ledgerAvailable: usage.ledgerAvailable } }));
} finally {
  if (reader) await reader.cancel().catch(() => {});
  await service.close();
  rmSync(home, { recursive: true, force: true });
}
