import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { parsePort } from './scripts/local-runtime.mjs';

function buildId() {
  if (/^[a-f0-9]{7,40}$/i.test(process.env.COMMIT_REF || '')) return process.env.COMMIT_REF.slice(0, 12);
  try { return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'local'; }
}
const apiPort = parsePort(process.env.PORT, { fallback: 3001 });
export default defineConfig({
  base: './',
  define: { __COMMON_BUILD_ID__: JSON.stringify(buildId()) },
  server: {
    host: process.env.COMMON_DEV_HOST || '127.0.0.1',
    port: parsePort(process.env.COMMON_DEV_PORT, { name: 'COMMON_DEV_PORT', fallback: 5173 }),
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true, changeOrigin: false },
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
});
