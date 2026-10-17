import { randomBytes } from 'node:crypto';
import { PROTOCOL_VERSION } from './session-protocol.mjs';

const read = (env, key) => typeof env === 'function' ? env(key) : env?.[key];
const hexId = bytes => randomBytes(bytes).toString('hex');
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Paths are classified, never copied into logs or traces. IDs and queries stay out. */
export function routeCategory(url) {
  let pathname;
  try { pathname = new URL(url, 'http://local.invalid').pathname; } catch { return 'unknown'; }
  if (pathname === '/ws') return 'session.websocket';
  if (pathname === '/api/health') return 'health';
  if (pathname === '/api/config') return 'config';
  if (pathname === '/api/ice') return 'session.ice';
  if (pathname === '/api/rooms') return 'rooms';
  const match = pathname.match(/^\/api\/rooms\/[^/]+(?:\/(join|session|connect|events|messages|leave))?$/);
  if (match) return match[1] ? `room.${match[1]}` : 'room.metadata';
  return pathname.startsWith('/api/') ? 'api.unknown' : 'static';
}

function incomingHeader(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const value = headers?.[name];
  return typeof value === 'string' ? value : null;
}

/** Support W3C version 00; invalid/zero IDs start a fresh trace. */
export function parseTraceparent(value) {
  const match = typeof value === 'string' && /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1], parentSpanId: match[2], sampled: (parseInt(match[3], 16) & 1) === 1 };
}

function exportConfiguration(env) {
  const configured = read(env, 'COMMON_OTLP_ENDPOINT');
  if (!configured) return null;
  try {
    const endpoint = new URL(configured);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
    const requested = Number(read(env, 'COMMON_OTLP_TIMEOUT_MS'));
    const timeoutMs = Number.isFinite(requested) && requested > 0 ? Math.max(25, Math.min(750, requested)) : 500;
    return { endpoint: endpoint.href, token: read(env, 'COMMON_OTLP_TOKEN'), timeoutMs };
  } catch { return null; }
}

function otlpPayload(record, startedAt, endedAt, parent) {
  const attribute = (key, value) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } });
  return { resourceSpans: [{
    resource: { attributes: [attribute('service.name', 'common'), attribute('service.version', record.buildId)] },
    scopeSpans: [{ scope: { name: 'common.observability', version: '1' }, spans: [{
      traceId: record.traceId, spanId: record.spanId,
      ...(parent ? { parentSpanId: parent.parentSpanId } : {}),
      name: `${record.method} ${record.route}`, kind: 2,
      startTimeUnixNano: String(BigInt(Math.floor(startedAt)) * 1000000n),
      endTimeUnixNano: String(BigInt(Math.floor(endedAt)) * 1000000n),
      attributes: [attribute('http.request.method', record.method), attribute('http.route', record.route),
        attribute('http.response.status_code', record.status), attribute('common.request_id', record.requestId),
        attribute('common.protocol_version', record.protocolVersion)],
      status: { code: record.status >= 500 ? 2 : 0 },
    }] }],
  }] };
}

async function exportTrace(configuration, payload, fetchImpl) {
  if (typeof fetchImpl !== 'function') return;
  const controller = new AbortController(); let timer;
  try {
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(); }, configuration.timeoutMs);
    });
    const send = Promise.resolve().then(() => fetchImpl(configuration.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(configuration.token ? { Authorization: `Bearer ${configuration.token}` } : {}) },
      body: JSON.stringify(payload), signal: controller.signal,
    })).then(response => { Promise.resolve(response.body?.cancel?.()).catch(() => {}); });
    // The race also bounds a collector/mock which fails to honor AbortSignal.
    await Promise.race([send, timeout]);
  } catch { /* Diagnostics must never break a room or expose collector errors. */ }
  finally { clearTimeout(timer); }
}

/** Finish returns a bounded Promise so serverless adapters can await trace delivery. */
export function startRequestObservation(request, { env = process.env, log = value => console.log(value), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const startedAt = now();
  const exporter = exportConfiguration(env);
  const parent = parseTraceparent(incomingHeader(request.headers, 'traceparent'));
  const sampled = parent ? parent.sampled : Boolean(exporter);
  const traceId = parent?.traceId || hexId(16), spanId = hexId(8), requestId = hexId(16);
  const buildId = String(read(env, 'COMMIT_REF') || read(env, 'COMMON_BUILD_ID') || 'local').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40) || 'local';
  const method = methods.has(request.method) ? request.method : 'OTHER';
  const route = routeCategory(request.url);
  let completion;
  const headers = {
    'X-Common-Request-Id': requestId,
    'X-Common-Build': buildId,
    'X-Common-Protocol': String(PROTOCOL_VERSION),
    traceparent: `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`,
  };
  return {
    headers,
    finish(status) {
      if (completion) return completion;
      const endedAt = Math.max(startedAt, now());
      const record = { event: 'common.request', requestId, traceId, spanId, route, method,
        status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500,
        durationMs: Math.round((endedAt - startedAt) * 100) / 100, buildId, protocolVersion: PROTOCOL_VERSION };
      if (read(env, 'COMMON_LOG_DIAGNOSTICS') === '1') {
        try { log(JSON.stringify(record)); } catch { /* Logging is optional. */ }
      }
      completion = exporter && sampled ? exportTrace(exporter, otlpPayload(record, startedAt, endedAt, parent), fetchImpl) : Promise.resolve();
      return completion;
    },
  };
}

export async function observeRequest(request, handler, options) {
  const observation = startRequestObservation(request, options);
  let response;
  try { response = await handler(request); }
  catch (failure) { await observation.finish(500); throw failure; }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(observation.headers)) headers.set(name, value);
  const observed = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  await observation.finish(response.status);
  return observed;
}
