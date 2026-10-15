import { createRequire } from 'node:module';
const require = createRequire('/vercel/sandbox/node_modules/');
const esbuild = require('esbuild');
const OMS = process.env.OMS_DIR ?? '/data/oms';
const HERE = new URL('.', import.meta.url).pathname;
await esbuild.build({
  entryPoints: [`${HERE}react-entry.tsx`], bundle: true, format: 'esm', minify: true, outfile: `${HERE}react-bundle.js`, jsx: 'automatic',
  alias: { '@oms': `${OMS}/src`, '@oms-shared': `${OMS}/shared`, zod: `${HERE}zod-stub.mjs` },
  nodePaths: ['/vercel/sandbox/node_modules'], define: { 'process.env.NODE_ENV': '"production"' },
});
await esbuild.build({
  entryPoints: [`${HERE}compare-entry.tsx`], bundle: true, format: 'esm', minify: true, outfile: `${HERE}compare-bundle.js`, jsx: 'automatic',
  alias: { '@oms': `${OMS}/src`, '@oms-shared': `${OMS}/shared`, zod: `${HERE}zod-stub.mjs` },
  nodePaths: ['/vercel/sandbox/node_modules'], define: { 'process.env.NODE_ENV': '"production"' },
});
console.log('ok');
