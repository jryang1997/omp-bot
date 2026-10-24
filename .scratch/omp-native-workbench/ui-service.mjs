import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server.mjs';
const home = mkdtempSync(join(tmpdir(), 'ompbot-ui-proof-'));
const backend = await startServer({ port: 0, home, bin: 'C:/Users/<user>/Desktop/omp_bot/.desktop-runtime/omp.exe' });
const bot = backend.orch.addBot({ name: 'BrowserNativeQA', role: 'Temporary product verification', model: 'magpie/commandcode-plan/deepseek/deepseek-v4.1-flash', thinking: 'low', approvalMode: 'always-ask', instructions: 'Temporary authorized local QA. Read only requested inputs and write only requested outputs. Do not send external messages or use network.' });
writeFileSync(new URL('./ui-service.json', import.meta.url), JSON.stringify({ home, url: backend.url, launchUrl: backend.launchUrl, botId: bot.id }));
console.log('UI_ACCEPTANCE_READY ' + backend.url);
let closing = false;
async function close() { if (closing) return; closing = true; await backend.close(); rmSync(home, { recursive: true, force: true }); process.exit(0); }
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => { if (text.trim() === 'close') void close(); });
