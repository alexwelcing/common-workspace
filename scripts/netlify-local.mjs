/**
 * Local production-shaped Netlify API + static app harness.
 * Requires an explicit disposable PostgreSQL URL; it creates and removes its
 * own schema, and never reads Netlify credentials or touches a deployed DB.
 */
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import pg from 'pg';
import { createApiHandler } from '../netlify/lib/api.mjs';
import { publicRuntimeConfig } from '../lib/runtime-config.mjs';
import { observeRequest } from '../lib/observability.mjs';

const root = path.resolve(import.meta.dirname, '..');
const databaseUrl = process.env.COMMON_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set COMMON_TEST_DATABASE_URL to a disposable local PostgreSQL database.');

const schema = `common_local_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12 });
let server, startup, closing, shutdownSignal;
let stopping = false;
const requireStarting = () => {
  if (stopping) throw new Error('Local Netlify startup was interrupted.');
};
function close() {
  if (closing) return closing;
  stopping = true;
  closing = (async () => {
    // A CREATE or migration already in flight must settle before cleanup can
    // drop this schema. Startup checks stopping before starting another step.
    await startup?.catch(() => {});
    try {
      if (server) await new Promise(resolve => server.close(resolve));
    } finally {
      try { await pool.end(); }
      finally {
        // The schema name belongs only to this process. Try the drop even if
        // CREATE failed after the database may already have committed it.
        try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
        finally { await admin.end(); }
      }
    }
  })();
  return closing;
}

// Register before the first database operation, including CREATE SCHEMA.
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  shutdownSignal = signal;
  void close().then(() => process.exit(0), error => {
    console.error('Local Netlify harness cleanup failed:', error.message);
    process.exit(1);
  });
});

startup = (async () => {
  requireStarting();
  await admin.query(`CREATE SCHEMA ${schema}`);
  requireStarting();
  const migrationDir = path.join(root, 'netlify/database/migrations');
  for (const filename of (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(path.join(migrationDir, filename), 'utf8');
    requireStarting();
    await pool.query(sql);
  }
  requireStarting();
  const api = createApiHandler({ pool, env: key => process.env[key] });
  const dist = path.join(root, 'dist');
  await stat(path.join(dist, 'index.html'));
  requireStarting();
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
    '.webp': 'image/webp', '.woff2': 'font/woff2',
  };
  server = http.createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, `http://${incoming.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of incoming) {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) {
            outgoing.writeHead(413, { 'Content-Type': 'application/json' });
            outgoing.end(JSON.stringify({ error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' }));
            return;
          }
          chunks.push(chunk);
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        const request = new Request(url, {
          method: incoming.method,
          headers,
          ...(incoming.method !== 'GET' && incoming.method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}),
        });
        const response = await observeRequest(request, () => {
          if (incoming.method === 'GET' && url.pathname === '/api/config') {
            return Response.json(publicRuntimeConfig(process.env, { transport: 'polling' }), {
              headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
            });
          }
          return api(request, { ip: incoming.socket.remoteAddress });
        });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
        outgoing.writeHead(405); outgoing.end(); return;
      }
      const requested = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
      if (requested !== dist && !requested.startsWith(`${dist}${path.sep}`)) {
        outgoing.writeHead(403); outgoing.end(); return;
      }
      let file = requested;
      try {
        if (!(await stat(file)).isFile()) file = path.join(dist, 'index.html');
      } catch {
        if (path.extname(url.pathname)) { outgoing.writeHead(404); outgoing.end(); return; }
        file = path.join(dist, 'index.html');
      }
      const data = await readFile(file);
      outgoing.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      outgoing.end(incoming.method === 'HEAD' ? undefined : data);
    } catch (error) {
      console.error('Local Netlify harness request failed:', error.message);
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'Local request failed' }));
    }
  });
  const port = Number(process.env.COMMON_LOCAL_PORT || process.env.PORT || 4173);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  requireStarting();
  console.log(`Local Netlify app: http://127.0.0.1:${server.address().port}`);
})();

try {
  await startup;
} catch (error) {
  await close();
  if (!shutdownSignal) throw error;
}
