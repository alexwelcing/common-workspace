import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createLocalSession } from './lib/local-session.mjs';
import { startRequestObservation } from './lib/observability.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });
const safeErrorCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';

function webRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  return new Request(url, { method: req.method, headers,
    ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
  });
}

export async function createApp(options = {}) {
  const env = options.env ?? process.env;
  const envValue = key => typeof env === 'function' ? env(key) : env[key];
  const engine = await createLocalSession({ ...options,
    dataFile: options.dataFile === undefined ? envValue('DATA_FILE') ?? path.join(ROOT, 'data/rooms.json') : options.dataFile,
  });
  const staticDir = options.staticDir ?? path.join(ROOT, 'dist');
  const server = http.createServer(async (req, res) => {
    const observation = startRequestObservation(req, { env });
    for (const [name, value] of Object.entries(observation.headers)) res.setHeader(name, value);
    res.once('finish', () => { observation.finish(res.statusCode).catch(() => {}); });
    res.once('close', () => { if (!res.writableFinished) observation.finish(499).catch(() => {}); });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'display-capture=(self), camera=(), microphone=()');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const response = await engine.fetch(webRequest(req), { ip: req.socket.remoteAddress });
        if (response) {
          for (const [name, value] of response.headers) res.setHeader(name, value);
          res.writeHead(response.status);
          res.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw httpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      let requested;
      try { requested = decodeURIComponent(url.pathname); } catch { throw httpError(400, 'INVALID_PATH', 'Invalid path.'); }
      if (requested.includes('\\') || requested.includes('\0') || requested.split('/').some(segment => segment === '.' || segment === '..')) throw httpError(403, 'FORBIDDEN', 'Invalid path.');
      const filename = path.resolve(staticDir, `.${requested}`);
      if (!filename.startsWith(`${path.resolve(staticDir)}${path.sep}`) && filename !== path.resolve(staticDir)) throw httpError(403, 'FORBIDDEN', 'Invalid path.');
      async function readStatic(asset) {
        const root = await realpath(staticDir);
        const resolved = await realpath(asset);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw httpError(403, 'FORBIDDEN', 'Invalid path.');
        return readFile(resolved);
      }
      const extensions = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
      let asset = filename;
      let content;
      try { content = await readStatic(asset); }
      catch (error) {
        if (error.status) throw error;
        if (path.extname(requested) && requested !== '/') throw httpError(404, 'NOT_FOUND', 'File not found.');
        asset = path.join(staticDir, 'index.html');
        try { content = await readStatic(asset); } catch (failure) { if (failure.status) throw failure; throw httpError(503, 'NOT_BUILT', 'Build the app first with bun run build, or use bun run dev.'); }
      }
      res.writeHead(200, { 'Content-Type': extensions[path.extname(asset)] || 'application/octet-stream', 'Cache-Control': asset.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(error.status ?? 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: error.status ? error.message : 'An unexpected server error occurred.', code: error.code ?? 'INTERNAL_ERROR' }));
      } else res.end();
      if (!error.status) console.error('Common request failed:', safeErrorCode(error));
    }
  });
  server.headersTimeout = 15000; server.requestTimeout = 15000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024, perMessageDeflate: false });
  const upgradeObservations = new WeakMap();
  wss.on('headers', (headers, request) => {
    const observation = upgradeObservations.get(request);
    if (observation) for (const [name, value] of Object.entries(observation.headers)) headers.push(`${name}: ${value}`);
  });
  server.on('upgrade', (req, socket, head) => {
    const observation = startRequestObservation(req, { env });
    upgradeObservations.set(req, observation);
    try {
      const admission = engine.authorizeWebSocket(webRequest(req));
      admission.diagnostics = { requestId: observation.headers['X-Common-Request-Id'], buildId: observation.headers['X-Common-Build'], protocolVersion: 1, traceparent: observation.headers.traceparent };
      wss.handleUpgrade(req, socket, head, ws => {
        observation.finish(101).catch(() => {});
        ws.on('pong', () => engine.pong(ws));
        ws.on('error', () => {});
        ws.on('close', () => engine.close(ws));
        ws.on('message', (buffer, isBinary) => engine.message(ws, buffer, isBinary));
        try { engine.open(ws, admission); }
        catch { ws.close(4003, 'Session expired'); }
      });
    } catch (error) {
      observation.finish(error.status ?? 400).catch(() => {});
      const headers = Object.entries(observation.headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
      socket.write(`HTTP/1.1 ${error.status ?? 400} Error\r\n${headers}Connection: close\r\n\r\n`);
      socket.destroy();
    }
  });
  let closing;
  return {
    server,
    async listen(port = Number(envValue('PORT')) || 3001, host = envValue('HOST') || '0.0.0.0') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return server.address();
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        try { await engine.closeEngine(); }
        finally {
          await new Promise(resolve => wss.close(resolve));
          await new Promise(resolve => server.close(resolve));
        }
      })();
      return closing;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const address = await app.listen();
  console.log(`Common server listening on http://localhost:${address.port}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
