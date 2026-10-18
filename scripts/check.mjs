import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectRoot, waitForHealth } from './local-runtime.mjs';
import { runBrowserJourney, resolveChromiumPath } from '../tests/browser-smoke.mjs';

const usage = `Usage: bun run check [--hosted | --all-adapters] [--skip-build]

Default: build once, then exercise five user journeys against a temporary Bun app.
--hosted       Use the production-shaped Netlify adapter and real Postgres instead.
--all-adapters Exercise both adapters using the same built frontend.
--skip-build   Reuse dist/ while investigating a failure.

Hosted modes need COMMON_TEST_DATABASE_URL pointing to a disposable database.
Install a browser once with: bunx playwright-core install chromium
An existing Chrome/Chromium or CHROMIUM_PATH works too. No browser is downloaded
by this command. Reports and failure screenshots stay under artifacts/check/.
`;
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
if (args.some(arg => !['--hosted', '--all-adapters', '--skip-build'].includes(arg)) || (args.includes('--hosted') && args.includes('--all-adapters'))) {
  console.error(usage); process.exit(2);
}
const adapters = args.includes('--all-adapters') ? ['bun', 'hosted'] : [args.includes('--hosted') ? 'hosted' : 'bun'];
const interrupted = new AbortController();
const interrupt = signal => interrupted.abort(new Error(`Interrupted by ${signal}.`));
const handlers = ['SIGINT', 'SIGTERM'].map(signal => [signal, () => interrupt(signal)]);
for (const [signal, handler] of handlers) process.once(signal, handler);
await mkdir(path.join(projectRoot, 'artifacts/check'), { recursive: true });
const artifactDir = await mkdtemp(path.join(projectRoot, 'artifacts/check/run-'));
const report = { status: 'running', startedAt: new Date().toISOString(), adapters, steps: [], journeys: [] };
const privateEnv = { ...process.env, COMMON_NETWORK_PROFILE: 'private', ICE_TRANSPORT_POLICY: 'all', STUN_URLS: 'none', TURN_URLS: '', TURN_SECRET: '', TURN_USERNAME: '', TURN_CREDENTIAL: '', PLANTUML_URL: 'none' };
const clean = value => String(value).replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[database address]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\/(rooms|room)\/[A-Za-z0-9_-]+/g, '/$1/[session]').slice(-64000);
let activeStep;
async function step(name, work) {
  interrupted.signal.throwIfAborted();
  const item = { name, status: 'running' }, started = Date.now(); report.steps.push(item); activeStep = name;
  try { const value = await work(); item.status = 'passed'; console.log(`PASS ${name} (${Date.now() - started} ms)`); return value; }
  catch (error) { item.status = 'failed'; item.message = clean(error.message); throw error; }
  finally { item.durationMs = Date.now() - started; }
}
function childProcess(script, env = privateEnv, logName = script.replaceAll('/', '-'), extraArgs = []) {
  const child = spawn(process.execPath, [script, ...extraArgs], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', failure;
  child.stdout.on('data', data => { output = (output + data).slice(-64000); });
  child.stderr.on('data', data => { output = (output + data).slice(-64000); });
  const exited = new Promise(resolve => {
    child.once('error', error => { failure = error; resolve(null); });
    child.once('exit', code => resolve(code));
  });
  let stopping;
  return {
    alive: () => !failure && child.exitCode === null && child.signalCode === null,
    async finish() {
      const code = await exited;
      await writeFile(path.join(artifactDir, `${logName}.log`), clean(output));
      if (failure || code !== 0) throw new Error(`${script} failed${failure ? `: ${failure.message}` : ` (exit ${code})`}. See ${logName}.log.`);
    },
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        let forced = false, timer;
        if (this.alive()) {
          child.kill('SIGTERM');
          timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 8000);
        }
        try { await exited; } finally { clearTimeout(timer); await writeFile(path.join(artifactDir, `${logName}.log`), clean(output)); }
        if (forced) throw new Error(`${script} did not stop cleanly. Check ${logName}.log and disposable database cleanup.`);
      })();
      return stopping;
    },
  };
}
async function command(script, logName, extraArgs = []) {
  const job = childProcess(script, privateEnv, logName, extraArgs);
  const abort = () => { void job.stop().catch(() => {}); };
  interrupted.signal.addEventListener('abort', abort, { once: true });
  if (interrupted.signal.aborted) abort();
  try { await job.finish(); interrupted.signal.throwIfAborted(); }
  finally { interrupted.signal.removeEventListener('abort', abort); await job.stop(); }
}
async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

try {
  const chromiumPath = await step('Browser and adapter setup', async () => {
    if (!process.versions.bun) throw new Error('Run this command with Bun: bun run check.');
    if (adapters.includes('hosted') && !process.env.COMMON_TEST_DATABASE_URL?.trim()) throw new Error('Hosted checks require COMMON_TEST_DATABASE_URL pointing to a disposable Postgres database. Nothing has been started.');
    return resolveChromiumPath();
  });
  await step('Lint production code', () => command('run', 'lint', ['lint']));
  if (!args.includes('--skip-build')) {
    const manifest = await readFile(path.join(projectRoot, 'public/agent-tools.json'), 'utf8');
    await step('Build the app once', () => command('scripts/build.mjs', 'build'));
    await step('Published agent schema matches the source', async () => {
      if (await readFile(path.join(projectRoot, 'public/agent-tools.json'), 'utf8') !== manifest) throw new Error('The agent schema was stale. Review public/agent-tools.json generated by this build and commit it.');
    });
  } else await step('Built app is available', () => readFile(path.join(projectRoot, 'dist/index.html')));
  for (const adapter of adapters) {
    const port = await freePort(), baseUrl = `http://127.0.0.1:${port}`;
    const env = { ...privateEnv, HOST: '127.0.0.1', PORT: String(port), COMMON_LOCAL_PORT: String(port) };
    // Local room storage is disposable and removed after this run. The hosted
    // harness owns a random schema and drops only that schema on shutdown.
    const temporary = await mkdtemp(path.join(tmpdir(), 'common-check-'));
    env.DATA_FILE = path.join(temporary, 'rooms.json');
    const server = childProcess(adapter === 'bun' ? 'server.mjs' : 'scripts/netlify-local.mjs', env, `${adapter}-server`);
    try {
      await step(`${adapter}: temporary app is healthy`, () => waitForHealth(`${baseUrl}/api/health`, { processState: () => server.alive() && !interrupted.signal.aborted }));
      await step(`${adapter}: five browser journeys`, async () => {
        const result = await runBrowserJourney({ baseUrl, artifactDir: path.join(artifactDir, adapter), chromiumPath, signal: interrupted.signal });
        report.journeys.push({ adapter, status: result.passed ? 'passed' : 'incomplete', report: `${adapter}/report.json` });
        if (!result.passed) throw new Error('The browser walkthrough did not verify all journeys.');
      });
    } finally {
      try { await server.stop(); }
      finally { await rm(temporary, { recursive: true, force: true }); }
    }
  }
  report.status = 'passed';
} catch (error) {
  report.status = interrupted.signal.aborted ? 'interrupted' : 'failed';
  report.failure = { step: activeStep, message: clean(error.message) };
  console.error(`\nFAIL ${activeStep || 'Setup'}\n${clean(error.message)}`);
  process.exitCode = interrupted.signal.aborted ? 130 : 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\nReport: ${path.join(artifactDir, 'report.json')}`);
  for (const [signal, handler] of handlers) process.off(signal, handler);
}
