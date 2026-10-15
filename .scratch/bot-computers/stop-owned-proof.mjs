import { ComputerBackend } from '../../src/computer-backend.mjs';
import { resolve } from 'node:path';
const backend = new ComputerBackend({ home: resolve('.scratch/bot-computers/backend-proof-home') });
try {
  const result = await backend.stop('pc_000000000000000000000001');
  if (result.state !== 'stopped') throw new Error('Owned failed probe remains running');
  console.log(JSON.stringify({ fixture: 'pc_000000000000000000000001', state: result.state }));
} finally {
  await backend.close();
}
