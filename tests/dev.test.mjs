import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePort, normalizeOrigin, standaloneEnv, checkPortAvailable, requireFreePorts, waitForHealth, projectRoot } from '../scripts/local-runtime.mjs';
import { getAgentManifest } from '../src/agent-api.js';

async function server(t, handler = (_request, response) => response.end('{}')) {
  const instance = createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return instance;
}

async function freePort() {
  const instance = createServer();
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const port = instance.address().port;
  await new Promise(resolve => instance.close(resolve));
  return port;
}

function child(t, args, env = {}) {
  const process = spawn(globalThis.process.execPath, args, { cwd: projectRoot, env: { ...globalThis.process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  process.stdout.on('data', chunk => { output += chunk; });
  process.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (process.exitCode !== null || process.signalCode !== null) return;
    const exited = once(process, 'exit'); process.kill('SIGTERM');
    const timeout = setTimeout(() => process.kill('SIGKILL'), 4000);
    await exited; clearTimeout(timeout);
  });
  return { process, output: () => output };
}

test('ports and origins reject invalid startup settings without echoing their contents', () => {
  assert.equal(parsePort(undefined), 3001);
  assert.equal(parsePort('8443'), 8443);
  for (const value of ['0', '-1', '65536', '12.5', '12hello', 'a-secret-looking-value']) assert.throws(() => parsePort(value), /must be an integer/);
  assert.equal(normalizeOrigin(undefined, { https: true }), 'https://localhost:8443');
  assert.equal(normalizeOrigin('https://192.168.1.50:8443/'), 'https://192.168.1.50:8443');
  for (const value of ['https://user:password@example.test', 'https://example.test/a', 'https://example.test?token=secret', 'https://example.test#token', 'file:///tmp/canvas', 'https://example.test\n']) assert.throws(() => normalizeOrigin(value), /origin/);
  assert.throws(() => normalizeOrigin('http://localhost:8443', { https: true }), /HTTPS/);
});

test('standalone environment overrides inherited polling without mutating unrelated settings', () => {
  const original = { VITE_SESSION_TRANSPORT: 'polling', COMMON_SESSION_TRANSPORT: 'polling', PORT: '3001', COMMON_NETWORK_PROFILE: 'private' };
  const env = standaloneEnv(original, { PORT: '3101', VITE_SESSION_TRANSPORT: 'polling' });
  assert.equal(env.VITE_SESSION_TRANSPORT, 'websocket');
  assert.equal(env.COMMON_SESSION_TRANSPORT, 'websocket');
  assert.equal(env.COMMON_NETWORK_PROFILE, 'private');
  assert.equal(env.PORT, '3101'); assert.equal(original.PORT, '3001');
  assert.equal(original.VITE_SESSION_TRANSPORT, 'polling');
});

test('the published agent manifest matches the current command schema', async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'public', 'agent-tools.json'), 'utf8'));
  assert.deepEqual(manifest, getAgentManifest());
});

test('doctor reports setup as JSON without printing server credentials', async t => {
  const port = await freePort(); let devPort = await freePort();
  while (devPort === port) devPort = await freePort();
  const secret = 'doctor-check-this-must-never-appear';
  const doctor = child(t, ['scripts/doctor.mjs', '--json'], {
    PORT: String(port), COMMON_DEV_PORT: String(devPort), COMMON_LOCAL_ORIGIN: '', COMMON_NETWORK_PROFILE: 'private',
    CADDY_BIN: 'common-no-caddy-for-test', TURN_SECRET: secret, TURN_CREDENTIAL: secret,
  });
  const [code] = await once(doctor.process, 'exit');
  assert.equal(code, 0, doctor.output());
  const report = JSON.parse(doctor.output());
  assert.equal(report.ok, true); assert.ok(report.checks.some(item => item.name === 'Caddy' && item.status === 'warn'));
  assert.equal(doctor.output().includes(secret), false);
});

test('port preflight detects a real listener and rejects overlapping services', async t => {
  const instance = await server(t); const port = instance.address().port;
  assert.equal(await checkPortAvailable(port), false);
  await assert.rejects(requireFreePorts([{ port, name: 'Backend' }]), /already in use/);
  const available = await freePort();
  assert.equal(await checkPortAvailable(available), true);
  await assert.rejects(requireFreePorts([{ port: available }, { port: available }]), /different port/);
});

test('readiness waits through 503 responses, then requires an explicit healthy body', async t => {
  let requests = 0;
  const instance = await server(t, (_request, response) => {
    requests++;
    response.writeHead(requests > 2 ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: requests > 2 }));
  });
  await waitForHealth(`http://127.0.0.1:${instance.address().port}/api/health`, { timeoutMs: 1000, intervalMs: 5 });
  assert.ok(requests >= 3);
});

test('readiness fails for unhealthy servers and children that exit before becoming ready', async t => {
  const instance = await server(t, (_request, response) => response.end('{"ok":false}'));
  await assert.rejects(waitForHealth(`http://127.0.0.1:${instance.address().port}/api/health`, { timeoutMs: 50, intervalMs: 5 }), /Timed out/);
  await assert.rejects(waitForHealth('http://127.0.0.1:1/api/health', { processState: () => false }), /exited/);
});

test('occupied Vite port fails before spawning a backend and leaves the backend port free', async t => {
  const occupied = await server(t); const backendPort = await freePort();
  const app = child(t, ['scripts/dev.mjs'], { PORT: String(backendPort), HOST: '127.0.0.1', COMMON_DEV_PORT: String(occupied.address().port), VITE_SESSION_TRANSPORT: 'polling' });
  const [code] = await once(app.process, 'exit');
  assert.equal(code, 1, app.output());
  assert.match(app.output(), /Vite port .*already in use/);
  assert.equal(await checkPortAvailable(backendPort), true);
});

test('development startup serves only after backend health and releases both ports on shutdown', async t => {
  const backendPort = await freePort(); let devPort = await freePort();
  while (devPort === backendPort) devPort = await freePort();
  const directory = await mkdtemp(path.join(tmpdir(), 'common-dev-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = child(t, ['scripts/dev.mjs'], { PORT: String(backendPort), HOST: '127.0.0.1', COMMON_DEV_PORT: String(devPort), VITE_SESSION_TRANSPORT: 'polling', DATA_FILE: path.join(directory, 'rooms.json') });
  await waitForHealth(`http://127.0.0.1:${devPort}/api/health`, { timeoutMs: 15000, processState: () => app.process.exitCode === null });
  assert.equal((await fetch(`http://127.0.0.1:${devPort}/`)).status, 200);
  assert.match(app.output(), /Backend health passed/);
  const exited = once(app.process, 'exit'); app.process.kill('SIGTERM');
  assert.equal((await exited)[0], 0, app.output());
  assert.equal(await checkPortAvailable(backendPort), true);
  assert.equal(await checkPortAvailable(devPort), true);
});

test('a failed managed child shuts down its healthy sibling instead of leaving an orphan listener', async t => {
  const port = await freePort();
  const runtime = new URL('../scripts/local-runtime.mjs', import.meta.url).href;
  const listener = `import {createServer} from 'node:http';const s=createServer((q,r)=>r.end('ok'));s.listen(${port},'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`;
  const fixture = `import {supervise} from ${JSON.stringify(runtime)};const s=supervise();s.spawn(process.execPath,['-e',${JSON.stringify(listener)}],{stdio:'ignore'},'Listener');s.spawn(process.execPath,['-e','setTimeout(()=>process.exit(7),150)'],{stdio:'ignore'},'Failing child');`;
  const app = child(t, ['-e', fixture]);
  const [code] = await once(app.process, 'exit');
  assert.equal(code, 1, app.output());
  assert.match(app.output(), /Failing child exited with code 7/);
  assert.equal(await checkPortAvailable(port), true);
});
