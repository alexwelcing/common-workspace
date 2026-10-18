import { createCommon } from 'common-workspace/bun';

// These are the host application's settings, routes, and WebSocket handlers.
const port = Number(process.env.PORT || 3100);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
const hostname = process.env.HOST || '127.0.0.1';
const authDemo = process.env.DEMO_AUTH === '1';
const page = Bun.file(new URL('./public/index.html', import.meta.url));
const clientBundle = Bun.file(new URL(import.meta.resolve('common-workspace/client')));
let count = 0;
const adapters = [];

function signedIn(request) {
  return !authDemo || (request.headers.get('cookie') || '').split(';').some(part => part.trim() === 'common_embed_demo=on');
}
// Demonstration only: replace this with your existing application's real session
// lookup. The checkbox below deliberately lets anyone set the demo cookie.
function authorize(request) {
  return signedIn(request) || new Response('Use the host page demo sign-in toggle before opening Common.', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
function sameOrigin(request) { return request.headers.get('origin') === new URL(request.url).origin; }
async function hostFetch(request, server) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/') return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (request.method === 'GET' && url.pathname === '/vendor/common-client.js') return new Response(clientBundle, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (request.method === 'GET' && url.pathname === '/api/health') return Response.json({ ok: true, application: 'Your existing Bun app', counter: count, authDemo, signedIn: signedIn(request), mounts: adapters.map(adapter => adapter.basePath) });
  if (url.pathname === '/api/counter') {
    if (request.method === 'POST') {
      if (!sameOrigin(request)) return Response.json({ error: 'Use the host app origin.' }, { status: 403 });
      count += 1;
    } else if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    return Response.json({ count });
  }
  if (url.pathname === '/api/demo-auth' && authDemo && request.method === 'POST') {
    if (!sameOrigin(request) || !request.headers.get('content-type')?.startsWith('application/json')) return new Response('Use the host app sign-in toggle.', { status: 403 });
    let input; try { input = await request.json(); } catch { return new Response('Send a JSON signedIn boolean.', { status: 400 }); }
    if (typeof input?.signedIn !== 'boolean') return new Response('Send a signedIn boolean.', { status: 400 });
    const cookie = input.signedIn ? 'common_embed_demo=on; Path=/; HttpOnly; SameSite=Lax' : 'common_embed_demo=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
    return Response.json({ signedIn: input.signedIn }, { headers: { 'Set-Cookie': cookie } });
  }
  if (url.pathname === '/echo') {
    if (request.method === 'GET' && server.upgrade(request, { data: { kind: 'host-echo' } })) return;
    return new Response('Open /echo as a WebSocket.', { status: 400 });
  }
  return new Response('The host app has no route here.', { status: 404 });
}
const hostWebSocket = {
  idleTimeout: 60,
  maxPayloadLength: 3 * 1024 * 1024,
  open(socket) { socket.send('Host echo is connected.'); },
  message(socket, message) {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    socket.send(`Host echo: ${text}`);
  },
};

let server;
try {
  // Independent namespaces keep app assets, API paths, rooms, and browser-local
  // canvas storage separate. Neither adapter opens its own server/listener.
  const inline = await createCommon({ basePath: '/common-inline/', dataFile: null, authorize });
  adapters.push(inline);
  const floating = await createCommon({ basePath: '/common-floating/', dataFile: null, authorize });
  adapters.push(floating);
  server = Bun.serve({
    hostname, port,
    fetch: inline.wrapFetch(floating.wrapFetch(hostFetch)),
    websocket: inline.wrapWebSocket(floating.wrapWebSocket(hostWebSocket)),
  });
  console.log(`Host application: ${server.url}\nExisting routes: /api/health, /api/counter, /echo\nCommon namespaces: ${adapters.map(adapter => adapter.basePath).join(', ')}\nDemo cookie gate: ${authDemo ? 'enabled (demonstration only)' : 'off; use DEMO_AUTH=1 to enable'}`);
} catch (error) {
  await Promise.allSettled(adapters.map(adapter => adapter.close()));
  console.error('The embedding example could not start:', error);
  process.exitCode = 1;
}
let stopping;
function stop() {
  if (stopping) return stopping;
  stopping = (async () => { server?.stop(true); await Promise.allSettled(adapters.map(adapter => adapter.close())); })();
  return stopping;
}
process.once('SIGINT', () => { void stop().finally(() => process.exit()); });
process.once('SIGTERM', () => { void stop().finally(() => process.exit()); });
