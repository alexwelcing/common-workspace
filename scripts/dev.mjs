import { createServer } from 'vite';
import { writeAgentManifest } from './build-agent-manifest.mjs';
import { projectRoot, parsePort, healthOrigin, standaloneEnv, requireFreePorts, waitForHealth, supervise, requireBun } from './local-runtime.mjs';

const services = supervise();
try {
  requireBun();
  const apiPort = parsePort(process.env.PORT, { fallback: 3001 });
  const devPort = parsePort(process.env.COMMON_DEV_PORT, { name: 'COMMON_DEV_PORT', fallback: 5173 });
  const host = process.env.HOST || '127.0.0.1';
  const devHost = process.env.COMMON_DEV_HOST || '127.0.0.1';
  await requireFreePorts([{ port: apiPort, host, name: 'Backend' }, { port: devPort, host: devHost, name: 'Vite' }]);
  process.env.VITE_SESSION_TRANSPORT = 'websocket';
  process.env.COMMON_SESSION_TRANSPORT = 'websocket';
  await writeAgentManifest();
  await import('./build-wasm.mjs');
  const backend = services.spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot, stdio: 'inherit', env: standaloneEnv(process.env, { PORT: String(apiPort), HOST: host }),
  }, 'Backend');
  await waitForHealth(`${healthOrigin(apiPort, host)}/api/health`, { processState: () => services.alive(backend) });
  const vite = await createServer({ root: projectRoot, server: { host: devHost, port: devPort, strictPort: true } });
  services.addCleanup(() => vite.close());
  await vite.listen();
  vite.printUrls();
  console.log('Common development is ready. Backend health passed; sessions use WebSocket.');
} catch (error) {
  services.fail(error);
}
