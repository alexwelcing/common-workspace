import test from 'node:test';
import assert from 'node:assert/strict';
import { observeRequest, startRequestObservation, parseTraceparent, routeCategory } from '../lib/observability.mjs';

const validParent = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`;

test('trace context accepts valid W3C IDs and rejects malformed, zero, duplicated or injected headers', () => {
  assert.deepEqual(parseTraceparent(validParent), { traceId: '1'.repeat(32), parentSpanId: '2'.repeat(16), sampled: true });
  for (const value of [null, '', 'secret', validParent + ', ' + validParent, validParent + '\r\npassword:secret', validParent.replace('00-', 'ff-'), validParent.replace('1'.repeat(32), '0'.repeat(32)), validParent.replace('2'.repeat(16), '0'.repeat(16))]) {
    assert.equal(parseTraceparent(value), null);
  }
  assert.equal(routeCategory('/api/rooms/private-room/events?token=private-token'), 'room.events');
  assert.equal(routeCategory('/api/rooms/private-room/unknown'), 'api.unknown');
  assert.equal(routeCategory('/private-user-content?password=secret'), 'static');
});

test('default observation adds correlation/build headers while leaving logging and export off', async () => {
  let logs = 0, requests = 0;
  const request = new Request('https://common.test/api/health');
  const response = await observeRequest(request, () => Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } }), {
    env: {}, log: () => logs++, fetchImpl: () => requests++,
  });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('x-common-request-id'), /^[a-f0-9]{32}$/);
  assert.equal(response.headers.get('x-common-build'), 'local');
  assert.equal(response.headers.get('x-common-protocol'), '1');
  assert.ok(parseTraceparent(response.headers.get('traceparent')));
  assert.equal(logs, 0); assert.equal(requests, 0);
});

test('opt-in logs enumerate safe fields without request paths, queries, bodies or credentials', async () => {
  const secrets = ['ROOM_PRIVATE_abc', 'TOKEN_PRIVATE_xyz', 'PASSWORD_PRIVATE', 'CANVAS_PRIVATE', 'COLLECTOR_PRIVATE'];
  const logs = [];
  const env = { COMMON_LOG_DIAGNOSTICS: '1', COMMON_BUILD_ID: 'test-build', COMMON_OTLP_TOKEN: secrets[4] };
  const request = new Request(`https://common.test/api/rooms/${secrets[0]}/messages?token=${secrets[1]}&password=${secrets[2]}`, {
    method: 'POST', headers: { Authorization: `Bearer ${secrets[1]}`, traceparent: 'invalid-' + secrets[2] },
    body: JSON.stringify({ password: secrets[2], canvas: secrets[3] }),
  });
  const response = await observeRequest(request, () => Response.json({ error: 'Invalid input' }, { status: 422 }), { env: key => env[key], log: line => logs.push(JSON.parse(line)) });
  assert.equal(response.status, 422); assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), ['event', 'requestId', 'traceId', 'spanId', 'route', 'method', 'status', 'durationMs', 'buildId', 'protocolVersion'].sort());
  assert.equal(logs[0].route, 'room.messages'); assert.equal(logs[0].method, 'POST'); assert.equal(logs[0].buildId, 'test-build');
  for (const secret of secrets) assert.equal(JSON.stringify(logs).includes(secret), false);
  assert.equal(JSON.stringify(logs).includes('https://'), false);
});

test('optional OTLP HTTP JSON exports a server span and keeps exporter credentials out of its payload', async () => {
  const calls = [], logs = [];
  const env = { COMMON_OTLP_ENDPOINT: 'https://collector.test/v1/traces', COMMON_OTLP_TOKEN: 'private-collector-token', COMMON_BUILD_ID: 'build-abc', COMMON_LOG_DIAGNOSTICS: '1' };
  let time = 1700000000000;
  const observation = startRequestObservation({ url: '/api/rooms/private-room/events?token=private-session-token', method: 'GET', headers: { traceparent: validParent } }, {
    env, log: line => logs.push(line), now: () => { time += 12; return time; },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('', { status: 200 }); },
  });
  const first = observation.finish(503); assert.equal(observation.finish(503), first, 'HTTP finish and close cannot export twice');
  await first; assert.equal(calls.length, 1);
  assert.equal(calls[0].url, env.COMMON_OTLP_ENDPOINT);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-collector-token');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  const payload = JSON.parse(calls[0].options.body), resource = payload.resourceSpans[0];
  const span = resource.scopeSpans[0].spans[0];
  assert.equal(span.traceId, '1'.repeat(32)); assert.equal(span.parentSpanId, '2'.repeat(16));
  assert.match(span.spanId, /^[a-f0-9]{16}$/); assert.equal(span.kind, 2);
  assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
  assert.equal(span.name, 'GET room.events'); assert.deepEqual(span.status, { code: 2 });
  for (const secret of ['private-room', 'private-session-token', 'private-collector-token']) {
    assert.equal(calls[0].options.body.includes(secret), false);
    assert.equal(logs.join('').includes(secret), false);
  }
});

test('collector failures and timeouts do not fail requests or expose exceptions', async () => {
  for (const mode of ['reject', 'timeout']) {
    let signal; const logs = [];
    const started = performance.now();
    const response = await observeRequest(new Request('https://common.test/api/health'), () => Response.json({ ok: true }), {
      env: { COMMON_OTLP_ENDPOINT: 'http://127.0.0.1:4318/v1/traces', COMMON_OTLP_TIMEOUT_MS: '25', COMMON_LOG_DIAGNOSTICS: '1' },
      log: line => logs.push(line),
      fetchImpl: async (_url, options) => { signal = options.signal; if (mode === 'reject') throw new Error('private token and error stack'); return new Promise(() => {}); },
    });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
    assert.ok(performance.now() - started < 500, 'an uncooperative exporter must remain bounded');
    if (mode === 'timeout') assert.equal(signal.aborted, true);
    assert.equal(logs.join('').includes('private token'), false);
  }
});

test('invalid exporters and unsampled parents make no outbound calls; handler failures retain their behavior', async () => {
  let exports = 0;
  for (const endpoint of ['file:///private-file', 'https://token@collector.test/v1/traces', 'https://collector.test/v1/traces?token=secret']) {
    await observeRequest(new Request('https://common.test/api/health'), () => new Response('OK'), {
      env: { COMMON_OTLP_ENDPOINT: endpoint }, fetchImpl: async () => exports++,
    });
  }
  await observeRequest(new Request('https://common.test/api/health', { headers: { traceparent: validParent.slice(0, -2) + '00' } }), () => new Response('OK'), {
    env: { COMMON_OTLP_ENDPOINT: 'https://collector.test/v1/traces' }, fetchImpl: async () => exports++,
  });
  assert.equal(exports, 0);
  const logs = [];
  await assert.rejects(observeRequest(new Request('https://common.test/api/health'), () => { throw new Error('private-stack'); }, {
    env: { COMMON_LOG_DIAGNOSTICS: '1' }, log: line => logs.push(JSON.parse(line)),
  }), /private-stack/);
  assert.equal(logs[0].status, 500); assert.equal(JSON.stringify(logs).includes('private-stack'), false);
});
