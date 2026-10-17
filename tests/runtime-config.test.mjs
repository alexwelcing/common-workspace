import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRuntimeConfig, stunServersFromEnv } from '../lib/runtime-config.mjs';
import { loadRuntimeConfig, normalizeRuntimeConfig } from '../src/runtime-config.js';
import { DiagnosticLog, buildDiagnosticReport } from '../src/diagnostics.js';
import { ScreenSharing } from '../src/media.js';

test('private configuration disables default external requests and never serializes server credentials', () => {
  const env = { COMMON_NETWORK_PROFILE: 'private', TURN_URLS: 'turn:relay.internal:3478', TURN_SECRET: 'private-turn-secret', TURN_USERNAME: 'private-user', TURN_CREDENTIAL: 'private-password', COMMON_OTLP_TOKEN: 'private-tracing-token' };
  const config = publicRuntimeConfig(env);
  assert.equal(config.transport, 'websocket');
  assert.deepEqual(config.rtc.iceServers, []);
  assert.deepEqual(config.plantUml, { enabled: false, endpoint: null });
  assert.equal(config.rtc.hasTurn, true);
  assert.doesNotMatch(JSON.stringify(config), /private-(turn|user|password|tracing)/);
  assert.deepEqual(normalizeRuntimeConfig(config).rtc.iceServers, []);
});

test('runtime configuration honors explicit organization services and transport independently of build environment', () => {
  const env = { COMMON_NETWORK_PROFILE: 'private', STUN_URLS: 'stun:stun.internal:3478,turn:ignored:3478,https://ignored', PLANTUML_URL: 'https://diagrams.internal/plantuml/', ICE_TRANSPORT_POLICY: 'relay', VITE_SESSION_TRANSPORT: 'websocket' };
  const config = publicRuntimeConfig(key => env[key], { transport: 'polling' });
  assert.equal(config.transport, 'polling');
  assert.deepEqual(config.rtc.iceServers, [{ urls: ['stun:stun.internal:3478'] }]);
  assert.equal(config.rtc.iceTransportPolicy, 'relay');
  assert.equal(config.plantUml.endpoint, 'https://diagrams.internal/plantuml');
  assert.deepEqual(stunServersFromEnv({ STUN_URLS: 'none' }), []);
  assert.equal(publicRuntimeConfig({ PLANTUML_URL: 'https://user:secret@example.test/' }).plantUml.enabled, false);
});

test('client normalizer discards injected credentials, TURN fallback and unsafe renderer URLs', () => {
  const value = publicRuntimeConfig({});
  value.rtc.iceServers.push({ urls: 'turn:relay.test', credential: 'sensitive' });
  value.plantUml.endpoint = 'javascript:alert(1)';
  value.token = 'sensitive';
  const normalized = normalizeRuntimeConfig(value);
  assert.equal(normalized.plantUml.enabled, false);
  assert.doesNotMatch(JSON.stringify(normalized), /sensitive|turn:relay|javascript:/);
  assert.throws(() => normalizeRuntimeConfig({ version: 2 }), /Unsupported/);
});

test('configuration failure fails closed and a later fetch can recover', async () => {
  const unavailable = await loadRuntimeConfig({ force: true, fetch: async () => new Response('<html>fallback</html>') });
  assert.equal(unavailable.available, false);
  assert.deepEqual(unavailable.rtc.iceServers, []);
  assert.equal(unavailable.plantUml.enabled, false);
  const recovered = await loadRuntimeConfig({ force: true, fetch: async () => Response.json(publicRuntimeConfig({ COMMON_NETWORK_PROFILE: 'private' }, { transport: 'polling' })) });
  assert.equal(recovered.available, true);
  assert.equal(recovered.transport, 'polling');
});

test('private ICE fallback remains private during an admission service outage', async t => {
  const sharing = new ScreenSharing({ send() {}, getIceConfig: async () => { throw new Error('outage'); }, fallbackIceConfig: () => ({ iceServers: [], iceTransportPolicy: 'relay' }) });
  t.after(() => sharing.destroy());
  assert.deepEqual(await sharing._iceConfiguration(), { iceServers: [], iceTransportPolicy: 'relay' });
});

test('downloadable diagnostics retain operational counters without content or room identifiers', () => {
  const log = new DiagnosticLog({ now: () => 100, limit: 2 });
  log.record('connection', { state: 'connected', participants: 12, token: 'sensitive', room: 'sensitive' });
  log.record('poll', { durationMs: 4.5, text: 'sensitive', error: 'sensitive' });
  log.record('queue', { queuedMessages: 3, queueAgeMs: 80, state: 'sensitive' });
  const report = buildDiagnosticReport({ runtime: { ...publicRuntimeConfig({}), token: 'sensitive' }, connection: { connected: true, participants: 12, roomId: 'sensitive' }, canvas: { objects: 8, text: 'sensitive' }, log });
  assert.equal(report.events.length, 2);
  assert.equal(report.events[0].durationMs, 5);
  assert.equal(report.events[1].queuedMessages, 3);
  assert.doesNotMatch(JSON.stringify(report), /sensitive|roomId|password|credential/);
  assert.equal(report.canvas.objects, 8);
});
