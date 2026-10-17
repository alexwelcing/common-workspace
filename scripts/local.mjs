import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot, parsePort, normalizeOrigin, healthOrigin, certificateFetch, standaloneEnv, requireFreePorts, waitForHealth, supervise, requireBun } from './local-runtime.mjs';

const services = supervise();

function options(args) {
  const result = { https: false, build: true, origin: process.env.COMMON_LOCAL_ORIGIN };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--https') result.https = true;
    else if (arg === '--no-build') result.build = false;
    else if (arg === '--origin' && args[index + 1]) result.origin = args[++index];
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error('Supported options: --https, --origin https://host:8443, --no-build, --help.');
  }
  if (result.origin?.startsWith('https:')) result.https = true;
  return result;
}

async function waitForCertificate(file, alive) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error('Caddy exited before creating its local certificate authority.');
    try { return await readFile(file); } catch { /* Caddy creates the CA on its first HTTPS start. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Caddy did not create its local root certificate. Check its startup output.');
}

try {
  requireBun();
  const config = options(process.argv.slice(2));
  if (config.help) {
    console.log('bun run local [--https] [--origin https://host:8443] [--no-build]');
    console.log('Build and serve Common with Bun. HTTPS optionally uses an installed Caddy binary.');
    process.exit(0);
  }
  const port = parsePort(process.env.PORT, { fallback: 3001 });
  const httpsPort = parsePort(process.env.COMMON_HTTPS_PORT, { name: 'COMMON_HTTPS_PORT', fallback: 8443 });
  const origin = normalizeOrigin(config.origin, { https: config.https, port: config.https ? httpsPort : port });
  const url = new URL(origin);
  if (!config.https && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Team access needs HTTPS. Use --https --origin https://your-reachable-host:8443.');
  }
  if (!config.https && Number(url.port || 80) !== port) throw new Error('The HTTP origin port must match PORT.');
  const host = config.https ? '127.0.0.1' : process.env.HOST || '127.0.0.1';
  const tlsPort = Number(url.port || 443);
  const caddy = process.env.CADDY_BIN || 'caddy';
  if (config.https && spawnSync(caddy, ['version'], { stdio: 'ignore', timeout: 5000 }).status !== 0) {
    throw new Error('HTTPS needs Caddy installed on this computer. Install Caddy or use bun run local for localhost HTTP.');
  }
  await requireFreePorts([
    { port, host, name: 'Backend' },
    ...(config.https ? [{ port: tlsPort, host: '0.0.0.0', name: 'HTTPS' }] : []),
  ]);
  process.env.VITE_SESSION_TRANSPORT = 'websocket';
  process.env.COMMON_SESSION_TRANSPORT = 'websocket';
  const profile = process.env.COMMON_NETWORK_PROFILE || 'private';
  if (!['private', 'standard'].includes(profile)) throw new Error('COMMON_NETWORK_PROFILE must be private or standard.');
  if (config.build) await import('./build-local.mjs');
  else {
    try { await stat(path.join(projectRoot, 'dist', 'index.html')); }
    catch { throw new Error('No built app found. Run bun run local once without --no-build.'); }
  }
  const backend = services.spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot, stdio: 'inherit', env: standaloneEnv(process.env, { PORT: String(port), HOST: host, COMMON_NETWORK_PROFILE: profile }),
  }, 'Backend');
  await waitForHealth(`${healthOrigin(port, host)}/api/health`, { processState: () => services.alive(backend) });
  if (config.https) {
    const directory = path.join(projectRoot, 'data', 'local');
    const storage = path.join(directory, 'caddy');
    const configFile = path.join(directory, 'Caddyfile');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const caddyfile = `{
  admin off
  auto_https disable_redirects
  skip_install_trust
  storage file_system {
    root ${JSON.stringify(storage)}
  }
}
${origin} {
  tls internal
  reverse_proxy 127.0.0.1:${port}
}
`;
    await writeFile(configFile, caddyfile, { mode: 0o600 });
    if (spawnSync(caddy, ['fmt', '--overwrite', configFile], { stdio: 'ignore', timeout: 5000 }).status !== 0) throw new Error('Caddy could not format its generated configuration.');
    const proxy = services.spawn(caddy, ['run', '--config', configFile, '--adapter', 'caddyfile'], {
      cwd: projectRoot, stdio: 'inherit', env: process.env,
    }, 'Caddy');
    const rootCertificate = path.join(storage, 'pki', 'authorities', 'local', 'root.crt');
    const certificate = await waitForCertificate(rootCertificate, () => services.alive(proxy));
    await copyFile(rootCertificate, path.join(projectRoot, 'common-local-root.crt'));
    await waitForHealth(`${origin}/api/health`, {
      processState: () => services.alive(backend) && services.alive(proxy), fetchImpl: certificateFetch(certificate),
    });
    console.log('\nHTTPS is ready. Trust common-local-root.crt in this computer’s OS/browser certificate store.');
    console.log('Give teammates only that public certificate to trust, and ensure the hostname reaches this computer.');
    console.log('The certificate authority persists under data/local/caddy. Do not copy its private files to teammates.');
  }
  console.log(`\nCommon is ready: ${origin}`);
  console.log(`Network profile: ${profile}. Everyone joining a session must use this same origin.`);
  if (!config.https) console.log('Localhost supports screen sharing. For teammates, use --https --origin https://your-reachable-host:8443.');
  console.log('Press Ctrl+C to stop all local services.');
} catch (error) {
  services.fail(error);
}
