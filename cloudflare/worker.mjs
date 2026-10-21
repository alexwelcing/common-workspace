import { createHash } from 'node:crypto';
import { publicRuntimeConfig, stunServersFromEnv, iceTransportPolicyFromEnv } from '../lib/runtime-config.mjs';
import { observeRequest } from '../lib/observability.mjs';
export { CommonRoom, CommonAdmission } from './session.mjs';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const admission = env => env.COMMON_ADMISSION.get(env.COMMON_ADMISSION.idFromName('admission-v1'));
const room = (env, id) => env.COMMON_ROOMS.get(env.COMMON_ROOMS.idFromName(id));
const internal = (stub, path, value) => stub.fetch(new Request(`https://internal${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }));
async function rejected(request, response) {
  await request.body?.cancel().catch(() => {});
  return response;
}

async function api(request, env) {
  const url = new URL(request.url), pathname = url.pathname;
  const value = key => env[key];
  const buildId = env.COMMON_BUILD_ID || env.COMMON_VERSION?.id || 'local';
  if (!['GET', 'POST'].includes(request.method)) return rejected(request, json({ code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed.' }, 405));
  if (request.method === 'POST') {
    const origin = request.headers.get('origin');
    if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== url.origin)) return rejected(request, json({ code: 'INVALID_ORIGIN', error: 'This request must come from the app.' }, 403));
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return rejected(request, json({ code: 'JSON_REQUIRED', error: 'Send JSON content.' }, 415));
    const maxBytes = pathname === '/api/rooms' ? 64 * 1024 : 128 * 1024;
    if (Number(request.headers.get('content-length')) > maxBytes) return rejected(request, json({ code: 'TOO_LARGE', error: 'Request is too large.' }, 413));
  }
  if (pathname === '/api/config' && request.method === 'GET') return json(publicRuntimeConfig(value, { transport: 'polling', buildId }));
  if (pathname === '/api/health' && request.method === 'GET') {
    const health = await admission(env).fetch('https://internal/health');
    if (!health.ok) return json({ code: 'SERVICE_UNAVAILABLE', error: 'Session storage is unavailable. Please try again.' }, 503);
    return json({ ok: true, transport: 'poll', collaboration: 'peer', platform: 'cloudflare' });
  }
  if (pathname === '/api/ice' && request.method === 'GET') {
    const id = url.searchParams.get('room');
    if (id) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return json({ code: 'ROOM_NOT_FOUND', error: 'This session has ended or the link is invalid.' }, 404);
      return room(env, id).fetch(request);
    }
    return json({ iceServers: stunServersFromEnv(value), iceTransportPolicy: iceTransportPolicyFromEnv(value) });
  }
  const ip = createHash('sha256').update(request.headers.get('cf-connecting-ip') || 'local').digest('hex');
  if (pathname === '/api/rooms' && request.method === 'POST') {
    const gate = admission(env), reservation = await internal(gate, '/reserve', { ip });
    if (!reservation.ok) return rejected(request, reservation);
    const { id, expiresAt } = await reservation.json();
    const headers = new Headers(request.headers);
    headers.set('X-Common-Room-Id', id);
    headers.set('X-Common-Room-Expires-At', String(expiresAt));
    const response = await room(env, id).fetch(new Request(request, { headers }));
    // A 5xx/transport failure can happen after the room committed. Retain its
    // reservation until expiry rather than undercounting durable rooms.
    if (response.status >= 400 && response.status < 500) await internal(gate, '/release', { id });
    return response;
  }
  const match = pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,100})(?:\/(join|session|connect|events|messages|leave))?$/);
  if (match) {
    if (match[2] === 'join' && request.method === 'POST') {
      const result = await internal(admission(env), '/limit', { ip, kind: 'join' });
      if (!result.ok) return rejected(request, result);
    }
    return room(env, match[1]).fetch(request);
  }
  return rejected(request, json({ code: 'NOT_FOUND', error: 'Endpoint not found.' }, 404));
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    try {
      if (pathname.startsWith('/api/')) return await observeRequest(request, () => api(request, env), {
        env: key => env[key] ?? (key === 'COMMON_BUILD_ID' ? env.COMMON_VERSION?.id : undefined),
      });
      return await env.ASSETS.fetch(request);
    } catch (failure) {
      console.error('Common Worker failure:', failure?.code || failure?.name || 'unknown');
      return json({ code: 'SERVICE_UNAVAILABLE', error: 'Session storage is unavailable. Please try again.' }, 503);
    }
  },
};
