import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('dist/node-gateway', { recursive: true });

await build({
  entryPoints: ['src/interfaces/http/gateway/node-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/node-gateway/index.mjs',
  minify: false,
  sourcemap: false,
  // jsencrypt only works behind a bundler in the browser/workerd runtime; on
  // Node its RNG fails. The shim re-implements the same API on node:crypto.
  alias: {
    jsencrypt: './src/infrastructure/ugreen/jsencrypt-node-shim.ts'
  },
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);"
  }
});

console.log('node gateway bundled -> dist/node-gateway/index.mjs');
