/** Real workerd + SQLite checks; creates no Cloudflare account resources. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const usage = `Usage: bun scripts/check-cloudflare.mjs [--skip-build] [--browser]

Build the frontend, start an isolated local Wrangler/workerd with temporary
SQLite storage, run the Cloudflare HTTP contract suite and verify a restart.
--skip-build  Reuse dist/.
--browser     Also run the five existing browser journeys.
No Cloudflare login, production secrets, account resources or deployed URLs
are used. Test reports stay under artifacts/check-cloudflare/.
`;
if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
if (args.some(arg => !['--skip-build', '--browser'].includes(arg))) { console.error(usage); process.exit(2); }

const directory = await mkdtemp(path.join(tmpdir(), 'common-cloudflare-'));
await mkdir(path.join(root, 'artifacts/check-cloudflare'), { recursive: true });
const artifacts = await mkdtemp(path.join(root, 'artifacts/check-cloudflare/run-'));
const report = { status: 'running', startedAt: new Date().toISOString(), steps: [] };
const abort = new AbortController();
const signals = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => abort.abort(new Error(`Interrupted by ${signal}.`))]));
for (const [signal, handler] of signals) process.once(signal, handler);
const clean = value => String(value).replace(/Bearer\s+[A-Za-z0-9_-]{20,}/gi, 'Bearer [redacted]').slice(-64000);
let server, stepName;

async function step(name, work) {
  abort.signal.throwIfAborted();
  stepName = name;
  const item = { name, status: 'running' }, started = Date.now();
  report.steps.push(item);
  try { const value = await work(); item.status = 'passed'; console.log(`PASS ${name} (${Date.now() - started} ms)`); return value; }
  catch (error) { item.status = 'failed'; item.message = clean(error.message); throw error; }
  finally { item.durationMs = Date.now() - started; }
}

function launch(command, commandArgs, logName, env = {}) {
  // A narrow environment also prevents Wrangler reading inherited account
  // credentials or an unrelated application database/secret configuration.
  const child = spawn(command, commandArgs, {
    cwd: root,
    env: {
      PATH: process.env.PATH, TMPDIR: directory, XDG_CONFIG_HOME: directory,
      SYSTEMROOT: process.env.SYSTEMROOT,
      WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(directory, 'wrangler.log'), CI: 'true', NO_COLOR: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', failure, stopping;
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-64000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-64000); });
  const exited = new Promise(resolve => {
    child.once('error', error => { failure = error; resolve(null); });
    child.once('exit', code => resolve(code));
  });
  const save = () => writeFile(path.join(artifacts, `${logName}.log`), clean(output));
  const job = {
    alive: () => !failure && child.exitCode === null && child.signalCode === null,
    output: () => output,
    async finish() {
      const code = await exited; await save();
      if (failure || code !== 0) throw new Error(`${logName} failed${failure ? `: ${failure.message}` : ` (exit ${code})`}. See ${path.join(artifacts, `${logName}.log`)}.`);
    },
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        let timer;
        if (job.alive()) { child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 8000); }
        try { await exited; } finally { clearTimeout(timer); await save(); }
      })();
      return stopping;
    },
  };
  const onAbort = () => { void job.stop(); };
  abort.signal.addEventListener('abort', onAbort, { once: true });
  void exited.then(() => abort.signal.removeEventListener('abort', onAbort));
  return job;
}

async function command(commandName, commandArgs, logName, env) {
  const job = launch(commandName, commandArgs, logName, env);
  try { await job.finish(); abort.signal.throwIfAborted(); }
  finally { await job.stop(); }
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

try {
  if (!args.includes('--skip-build')) await step('Build the frontend', () => command('bun', ['scripts/build.mjs'], 'build'));
  await readFile(path.join(root, 'dist/index.html'));
  const config = JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
  const wrapper = path.join(directory, 'worker.mjs');
  const workerPath = path.join(root, config.main);
  await writeFile(wrapper, `import worker, { CommonRoom as BaseRoom, CommonAdmission as BaseAdmission } from ${JSON.stringify(workerPath)};
export default worker;
// This generated subclass exists only inside this disposable local test run.
export class CommonRoom extends BaseRoom {
  now() { return Date.now() + (this.testOffset || 0); }
  async fetch(request) {
    this.testOffset = Number(request.headers.get('X-Common-Test-Time')) || 0;
    if (request.headers.get('X-Common-Test-Alarm') === '1') await this.alarm();
    return super.fetch(request);
  }
}
export class CommonAdmission extends BaseAdmission {}
`);
  // Intentionally reconstruct local config: no routes, account identifiers,
  // preview resources, remote bindings or .dev.vars from the working checkout.
  const localConfig = {
    name: 'common-cloudflare-check', main: wrapper,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    assets: { ...config.assets, directory: path.join(root, config.assets.directory) },
    durable_objects: { bindings: config.durable_objects.bindings.map(({ name, class_name }) => ({ name, class_name })) },
    migrations: config.migrations,
    vars: {
      COMMON_NETWORK_PROFILE: 'private', ICE_TRANSPORT_POLICY: 'all', STUN_URLS: 'none', PLANTUML_URL: 'none',
      TURN_URLS: 'turn:relay.example:3478?transport=tcp', TURN_SECRET: 'cloudflare-local-test-secret', TURN_TTL_SECONDS: '120',
    },
  };
  const configPath = path.join(directory, 'wrangler.json');
  await writeFile(configPath, JSON.stringify(localConfig, null, 2));
  const port = await freePort(), baseUrl = `http://127.0.0.1:${port}`;
  const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
  await readFile(wrangler);
  const start = async logName => {
    server = launch('node', [wrangler, 'dev', '--local', '--config', configPath, '--persist-to', path.join(directory, 'state'), '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0'], logName);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      abort.signal.throwIfAborted();
      if (!server.alive()) throw new Error(`Local Wrangler stopped during startup. ${clean(server.output())}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (response.ok && (await response.json()).ok) return;
      } catch { /* The listener may not exist during the initial bundle. */ }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Local Wrangler did not become healthy. ${clean(server.output())}`);
  };
  await step('Start disposable Cloudflare runtime', () => start('workerd'));
  await step('Real Worker HTTP contract tests', () => command(process.execPath, process.versions.bun ? ['test', './tests/cloudflare.test.mjs'] : ['--test', './tests/cloudflare.test.mjs'], 'api-tests', { COMMON_TEST_CLOUDFLARE_URL: baseUrl }));
  await step('Worker API has no uncaught runtime exceptions', () => {
    assert.doesNotMatch(server.output(), /\bUncaught\b/, 'workerd reported an uncaught exception; inspect workerd.log');
  });
  await step('SQLite room state survives a runtime restart', async () => {
    const request = async (route, { auth, body } = {}) => {
      const response = await fetch(`${baseUrl}${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'CF-Connecting-IP': '192.0.2.250', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: `Bearer ${auth.token}`, ...(auth.connectionId ? { 'X-Common-Connection': auth.connectionId } : {}) } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.ok(response.ok, `Persistence request failed with HTTP ${response.status}`);
      return response.json();
    };
    const host = await request('/api/rooms', { body: { name: 'Restart verification', displayName: 'Host', password: 'temporary restart password', collaboration: 'peer' } });
    host.connectionId = (await request(`/api/rooms/${host.room.id}/connect`, { auth: host, body: {} })).connectionId;
    await request(`/api/rooms/${host.room.id}/messages`, { auth: host, body: { type: 'chat', text: 'durable restart receipt' } });
    await server.stop();
    await start('workerd-restarted');
    const session = await request(`/api/rooms/${host.room.id}/session`, { auth: host });
    assert.equal(session.participantId, host.participantId);
    const connected = await request(`/api/rooms/${host.room.id}/connect`, { auth: host, body: {} });
    assert.equal(connected.init.self.id, host.participantId);
    assert.equal(connected.init.chat.at(-1).text, 'durable restart receipt');
    await request(`/api/rooms/${host.room.id}/messages`, { auth: { ...host, connectionId: connected.connectionId }, body: { type: 'end' } });
  });
  if (args.includes('--browser')) await step('Five Cloudflare browser journeys', async () => {
    const { runBrowserJourney, resolveChromiumPath } = await import('../tests/browser-smoke.mjs');
    const result = await runBrowserJourney({ baseUrl, artifactDir: path.join(artifacts, 'browser'), chromiumPath: await resolveChromiumPath(), signal: abort.signal });
    assert.equal(result.passed, true, 'Browser walkthrough did not verify all journeys.');
  });
  report.status = 'passed';
} catch (error) {
  report.status = abort.signal.aborted ? 'interrupted' : 'failed';
  report.failure = { step: stepName, message: clean(error.message) };
  console.error(`FAIL ${stepName || 'Setup'}: ${clean(error.message)}`);
  process.exitCode = abort.signal.aborted ? 130 : 1;
} finally {
  try { await server?.stop(); }
  finally {
    await rm(directory, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`Report: ${path.join(artifacts, 'report.json')}`);
    for (const [signal, handler] of signals) process.off(signal, handler);
  }
}
