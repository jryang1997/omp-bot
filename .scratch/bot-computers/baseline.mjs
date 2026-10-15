import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server.mjs';

const home = mkdtempSync(join(tmpdir(), 'ompbot-computer-baseline-'));
const server = await startServer({ home, port: 0, host: '127.0.0.1' });
try {
  const bot = server.orch.addBot({ name: 'Computer baseline', executionMode: 'chat' });
  const response = await fetch(`${server.url}/api/bots/${bot.id}/computer`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  const baseline = { at: new Date().toISOString(), computerStatusHttp: response.status, home, existingBotMode: bot.executionMode };
  writeFileSync(new URL('./baseline.json', import.meta.url), JSON.stringify(baseline, null, 2));
  console.log(JSON.stringify(baseline));
} finally {
  await server.close();
}
