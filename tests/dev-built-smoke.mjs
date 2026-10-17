import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { projectRoot, waitForHealth, standaloneEnv, checkPortAvailable } from '../scripts/local-runtime.mjs';

await readFile(path.join(projectRoot, 'dist', 'index.html'));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const directory = await mkdtemp(path.join(tmpdir(), 'common-built-smoke-'));
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: projectRoot, env: standaloneEnv(process.env, { HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(directory, 'rooms.json'), COMMON_NETWORK_PROFILE: 'private' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { output += chunk; });
const sockets = [];
const origin = `http://127.0.0.1:${port}`;

async function post(route, body) {
  const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.ok(response.ok, `Local API request failed with HTTP ${response.status}.`);
  return response.json();
}

function connect(auth) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${encodeURIComponent(auth.room.id)}&token=${encodeURIComponent(auth.token)}`, { origin });
    sockets.push(socket);
    const timer = setTimeout(() => reject(new Error('WebSocket init timed out.')), 5000);
    socket.once('error', reject);
    socket.on('message', bytes => {
      const message = JSON.parse(String(bytes));
      if (message.type === 'init') { clearTimeout(timer); resolve({ socket, message }); }
    });
  });
}

try {
  await waitForHealth(`${origin}/api/health`, { processState: () => server.exitCode === null });
  const config = await (await fetch(`${origin}/api/config`)).json();
  assert.equal(config.transport, 'websocket'); assert.equal(config.networkProfile, 'private');
  const html = await (await fetch(origin)).text();
  const script = html.match(/<script[^>]+src="([^"]+)"/);
  assert.ok(script, 'Built HTML must reference a JavaScript entry point.');
  assert.equal((await fetch(new URL(script[1], origin))).status, 200);
  assert.equal((await fetch(`${origin}/room/local-smoke`)).status, 200);
  const manifest = await (await fetch(`${origin}/agent-tools.json`)).json();
  assert.ok(manifest.tools?.some(tool => tool.action === 'canvas.add'));
  const host = await post('/api/rooms', { name: 'Local startup check', displayName: 'Host', password: 'local-smoke-only-password', collaboration: 'peer' });
  const guest = await post(`/api/rooms/${host.room.id}/join`, { displayName: 'Guest', password: 'local-smoke-only-password' });
  const first = await connect(host); const second = await connect(guest);
  assert.equal(first.message.room.collaboration, 'peer'); assert.equal(second.message.participants.length, 2);
  console.log('Local build smoke passed: built assets, runtime profile, room entry, and two WebSocket participants.');
} catch (error) {
  console.error(output);
  throw error;
} finally {
  sockets.forEach(socket => socket.terminate());
  if (server.exitCode === null) {
    const exited = once(server, 'exit'); server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 4000);
    await exited; clearTimeout(timer);
  }
  await rm(directory, { recursive: true, force: true });
  assert.equal(await checkPortAvailable(port), true, 'The smoke server must release its port.');
}
