import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { get } from 'node:https';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function parsePort(value, { name = 'PORT', fallback = 3001 } = {}) {
  const input = value === undefined || value === '' ? fallback : value;
  if (!/^\d+$/.test(String(input)) || !Number.isInteger(Number(input)) || Number(input) < 1 || Number(input) > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return Number(input);
}

export function standaloneEnv(env = process.env, overrides = {}) {
  return { ...env, ...overrides, VITE_SESSION_TRANSPORT: 'websocket', COMMON_SESSION_TRANSPORT: 'websocket' };
}

export function healthOrigin(port, host = '127.0.0.1') {
  const address = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}:${port}`;
}

export function certificateFetch(certificate) {
  return (url, { signal } = {}) => new Promise((resolve, reject) => {
    const request = get(url, { ca: certificate, signal }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 65536) request.destroy(new Error('Unexpected health response.')); });
      response.on('end', () => resolve({ status: response.statusCode, json: async () => JSON.parse(body) }));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

export function normalizeOrigin(value, { https = false, port = 8443 } = {}) {
  const input = value || `${https ? 'https' : 'http'}://localhost:${port}`;
  let url;
  try { url = new URL(input); } catch { throw new Error('Use a complete origin, such as https://localhost:8443.'); }
  if (/\s/.test(input) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The origin must contain only an http(s) scheme, hostname, and optional port.');
  }
  if (https && url.protocol !== 'https:') throw new Error('HTTPS mode requires an https:// origin.');
  return url.origin;
}

export async function checkPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', error => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(new Error(`Cannot bind ${host}:${port}: ${error.code || error.message}`));
    });
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

export async function requireFreePorts(entries) {
  const seen = new Set();
  for (const { port, host = '127.0.0.1', name = 'Server' } of entries) {
    if (seen.has(port)) throw new Error('Each local service needs a different port.');
    seen.add(port);
    if (!await checkPortAvailable(port, host)) throw new Error(`${name} port ${port} is already in use. Stop that process or choose a different port.`);
  }
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function waitForHealth(url, { timeoutMs = 12000, intervalMs = 100, processState = () => true, fetchImpl = globalThis.fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processState()) throw new Error('The server exited before it became healthy.');
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))), headers: { Accept: 'application/json' } });
      if (response.status === 200 && (await response.json()).ok === true && processState()) return;
    } catch { /* A starting server can temporarily refuse connections or return 503. */ }
    await pause(Math.max(1, Math.min(intervalMs, deadline - Date.now())));
  }
  if (!processState()) throw new Error('The server exited before it became healthy.');
  throw new Error(`Timed out waiting for a healthy server at ${url}.`);
}

/** Keep child processes and in-process servers tied to a single terminal session. */
export function supervise() {
  const children = new Set(); const cleanups = [];
  let closing = null; let stopping = false;
  const shutdown = () => {
    if (closing) return closing;
    stopping = true;
    closing = (async () => {
      await Promise.allSettled(cleanups.reverse().map(close => close()));
      await Promise.allSettled([...children].map(child => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      })));
    })();
    return closing;
  };
  const fail = error => {
    if (stopping) return;
    console.error(`Common startup failed: ${error.message}`);
    void shutdown().then(() => process.exit(1));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown().then(() => process.exit(0)); });
  return {
    addCleanup(close) { cleanups.push(close); },
    spawn(command, args, options, label = 'Server') {
      const child = spawn(command, args, options); children.add(child);
      child.once('error', error => fail(new Error(`${label} could not start: ${error.message}`)));
      child.once('exit', (code, signal) => fail(new Error(`${label} exited${signal ? ` (${signal})` : ` with code ${code}`}.`)));
      return child;
    },
    alive: child => child.exitCode === null && child.signalCode === null && !stopping,
    shutdown,
    fail,
  };
}

export function requireBun() {
  if (!process.versions.bun) throw new Error('Run this command with Bun: bun run local (or bun run dev).');
}
