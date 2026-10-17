import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot, parsePort, normalizeOrigin, certificateFetch, checkPortAvailable } from './local-runtime.mjs';

const args = new Set(process.argv.slice(2).filter(arg => arg !== '--'));
const json = args.has('--json');
const https = args.has('--https') || process.env.COMMON_LOCAL_ORIGIN?.startsWith('https:');
const checks = [];
const caFile = path.join(projectRoot, 'data', 'local', 'caddy', 'pki', 'authorities', 'local', 'root.crt');
const exportedFile = path.join(projectRoot, 'common-local-root.crt');
const add = (status, name, detail) => checks.push({ status, name, detail });
const exists = async file => { try { return (await stat(file)).isFile(); } catch { return false; } };

for (const arg of args) if (!['--json', '--https', '--help', '-h'].includes(arg)) add('fail', 'Options', 'Use --https, --json, or --help.');
if (args.has('--help') || args.has('-h')) {
  console.log('bun run doctor [--https] [--json]\nChecks versions, local ports, network configuration, Caddy and public certificates. Never prints credentials.');
  process.exit(0);
}

const bunVersion = process.versions.bun;
const versionParts = (bunVersion || '0.0.0').split('.').map(Number);
const bunSupported = versionParts[0] > 1 || versionParts[0] === 1 && (versionParts[1] > 4 || versionParts[1] === 4 && versionParts[2] >= 3);
add(bunSupported ? 'pass' : 'fail', 'Bun', bunVersion ? `Bun ${bunVersion}${bunSupported ? '' : '; install Bun 1.4.3 or newer.'}` : 'Run with bun run doctor; Bun 1.4.3 or newer is required.');
const dependenciesPresent = await exists(path.join(projectRoot, 'node_modules', 'vite', 'package.json'));
add(dependenciesPresent ? 'pass' : 'fail', 'Dependencies', dependenciesPresent ? 'Installed.' : 'Run bun install --frozen-lockfile.');
add('pass', 'Local transport', 'dev, local, and build:local force WebSocket; inherited polling settings are ignored.');
const profile = process.env.COMMON_NETWORK_PROFILE || 'private';
add(['private', 'standard'].includes(profile) ? 'pass' : 'fail', 'Network profile', ['private', 'standard'].includes(profile) ? `Local launcher profile: ${profile}.` : 'COMMON_NETWORK_PROFILE must be private or standard.');
if (process.env.VITE_SESSION_TRANSPORT === 'polling') add('warn', 'Inherited hosted setting', 'VITE_SESSION_TRANSPORT=polling is present; local launchers override it.');

let port; let httpsPort; let origin;
try {
  port = parsePort(process.env.PORT, { fallback: 3001 });
  const devPort = parsePort(process.env.COMMON_DEV_PORT, { name: 'COMMON_DEV_PORT', fallback: 5173 });
  httpsPort = parsePort(process.env.COMMON_HTTPS_PORT, { name: 'COMMON_HTTPS_PORT', fallback: 8443 });
  origin = normalizeOrigin(process.env.COMMON_LOCAL_ORIGIN, { https, port: https ? httpsPort : port });
  const originUrl = new URL(origin);
  if (!https && !['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname)) throw new Error('Team access needs an HTTPS origin; HTTP is supported only on localhost.');
  if (!https && Number(originUrl.port || 80) !== port) throw new Error('The HTTP origin port must match PORT.');
  const ports = [{ name: 'Backend', port }, { name: 'Development UI', port: devPort }];
  if (https) ports.push({ name: 'HTTPS', port: Number(new URL(origin).port || 443) });
  const uniquePorts = new Set(ports.map(item => item.port));
  if (uniquePorts.size !== ports.length) add('fail', 'Service ports', 'Backend, development UI, and HTTPS need distinct ports.');
  for (const item of ports) {
    try {
      const free = await checkPortAvailable(item.port);
      if (free) add('pass', `${item.name} port`, `${item.port} is available.`);
      else {
        let common = false;
        try {
          const tls = item.name === 'HTTPS';
          const request = tls ? certificateFetch(await readFile(caFile)) : fetch;
          const response = await request(`${tls ? origin : `http://127.0.0.1:${item.port}`}/api/health`, { signal: AbortSignal.timeout(1000) });
          common = response.status === 200 && (await response.json()).ok === true;
        } catch { /* Another service can occupy this port, or the local CA may not exist yet. */ }
        add(common ? 'warn' : 'fail', `${item.name} port`, `${item.port} is occupied${common ? ' by a healthy Common server; stop it before starting another' : '; stop the process or choose another port'}.`);
      }
    } catch (error) { add('fail', `${item.name} port`, error.message); }
  }
  add('pass', 'Stable origin', `${origin}; use the same hostname and port for every participant.`);
} catch (error) { add('fail', 'Ports / origin', error.message); }

const caddy = spawnSync(process.env.CADDY_BIN || 'caddy', ['version'], { encoding: 'utf8', timeout: 5000 });
add(caddy.status === 0 ? 'pass' : https ? 'fail' : 'warn', 'Caddy', caddy.status === 0 ? 'Installed; optional HTTPS launcher is available.' : 'Not installed. Localhost HTTP works; install Caddy before using --https.');
if (await exists(caFile)) {
  try {
    const certificate = new X509Certificate(await readFile(caFile));
    add(Date.parse(certificate.validTo) > Date.now() ? 'pass' : 'fail', 'Local CA certificate', Date.parse(certificate.validTo) > Date.now() ? 'Present and within its validity period.' : 'Expired; renew the local Caddy CA before sharing.');
    if (await exists(exportedFile)) {
      const matches = (await readFile(caFile)).equals(await readFile(exportedFile));
      add(matches ? 'pass' : 'warn', 'Public CA export', matches ? 'common-local-root.crt matches the current Caddy root.' : 'common-local-root.crt differs from the current Caddy root. Rerun bun run local --https to refresh it.');
    }
    else add('warn', 'Public CA export', 'No common-local-root.crt export yet; the HTTPS launcher creates it.');
    add('warn', 'Browser trust', 'Verify the public CA is trusted in every participant’s OS/browser. File checks cannot prove browser trust.');
  } catch { add('fail', 'Local CA certificate', 'The stored root.crt is not a valid public X.509 certificate.'); }
} else add(https ? 'warn' : 'pass', 'Local CA certificate', 'Not created yet. The first bun run local --https creates and exports it.');
add(await exists(path.join(projectRoot, 'dist', 'index.html')) ? 'pass' : 'warn', 'Built app', 'bun run local builds automatically; --no-build requires an existing dist/index.html.');

if (json) console.log(JSON.stringify({ ok: !checks.some(item => item.status === 'fail'), checks }, null, 2));
else {
  console.log('Common local setup\n');
  for (const item of checks) console.log(`${item.status.toUpperCase().padEnd(4)} ${item.name}: ${item.detail}`);
  console.log('\nStart: bun run local   Develop: bun run dev   Team HTTPS: bun run local --https --origin https://your-reachable-host:8443');
}
process.exitCode = checks.some(item => item.status === 'fail') ? 1 : 0;
