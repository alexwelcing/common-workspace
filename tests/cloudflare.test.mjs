import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { creationCases, joinCases, activityCases, validCreation } from './protocol-cases.mjs';

const endpoint = process.env.COMMON_TEST_CLOUDFLARE_URL;
const integration = { skip: !endpoint };
const PASSWORD = 'correct horse browser canvas';
let nextAddress = 1;

// The harness owns the Worker and its temporary SQLite persistence. Never let
// this integration suite accidentally create rooms on a deployed application.
if (endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('COMMON_TEST_CLOUDFLARE_URL must point to a disposable local Worker.');
  }
}

function fixture() {
  let offset = 0;
  const ip = `192.0.2.${nextAddress++}`;
  async function request(route, { method = 'GET', body, auth, headers = {}, raw, signal } = {}) {
    const response = await fetch(new URL(route, endpoint), {
      method,
      signal,
      headers: {
        'CF-Connecting-IP': ip,
        // This header is interpreted only by the generated local test subclass.
        // The production Worker has no test clock or externally mutable clock.
        'X-Common-Test-Time': String(offset),
        ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth ? { Authorization: `Bearer ${auth.token}`, ...(auth.connectionId ? { 'X-Common-Connection': auth.connectionId } : {}) } : {}),
        ...headers,
      },
      ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); }
    catch { assert.fail(`Expected JSON from ${method} ${route}; received HTTP ${response.status}: ${text.slice(0, 200)}`); }
    return { ...result, status: response.status, headers: response.headers };
  }
  const post = (route, body, auth, headers) => request(route, { method: 'POST', body, auth, headers });
  const create = (name = 'Cloudflare collaboration', extra = {}) => post('/api/rooms', { name, displayName: 'Alex', password: PASSWORD, collaboration: 'peer', ...extra });
  const join = (room, displayName = 'Sam', password = PASSWORD) => post(`/api/rooms/${room.id}/join`, { displayName, password });
  const connect = async auth => {
    const result = await post(`/api/rooms/${auth.room.id}/connect`, {}, auth);
    if (result.status === 200) { auth.connectionId = result.connectionId; auth.cursor = result.cursor; }
    return result;
  };
  const poll = (auth, after = auth.cursor, extra = '') => request(`/api/rooms/${auth.room.id}/events?after=${encodeURIComponent(after)}${extra}`, { auth });
  const send = (auth, message) => post(`/api/rooms/${auth.room.id}/messages`, message, auth);
  const leave = auth => post(`/api/rooms/${auth.room.id}/leave`, {}, auth);
  return { request, post, create, join, connect, poll, send, leave, advance: ms => { offset += ms; } };
}

test('Cloudflare admission protects passwords, bearer sessions and same-origin writes', integration, async () => {
  const f = fixture();
  assert.equal((await f.create('Invalid', { password: 'short' })).status, 400);
  for (const headers of [{ Origin: 'https://untrusted.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await f.post('/api/rooms', validCreation, undefined, headers)).status, 403);
  }
  const host = await f.create();
  assert.equal(host.status, 201);
  assert.equal(host.isAdmin, true);
  assert.equal(host.room.collaboration, 'peer');
  assert.equal(host.room.transport, 'poll');
  const info = await f.request(`/api/rooms/${host.room.id}`);
  assert.equal(info.status, 200);
  assert.equal(JSON.stringify(info).includes(PASSWORD), false);
  assert.equal(JSON.stringify(info).includes(host.token), false);
  assert.equal((await f.request(`/api/rooms/${host.room.id}/session`)).status, 401);
  assert.equal((await f.join(host.room, 'Sam', 'wrong password')).code, 'WRONG_PASSWORD');
  const session = await f.request(`/api/rooms/${host.room.id}/session`, { auth: host });
  assert.equal(session.participantId, host.participantId);
  assert.equal(session.isAdmin, true);
  const guest = await f.join(host.room);
  assert.equal(guest.status, 200);
  assert.equal(guest.isAdmin, false);
  const connected = await f.connect(host);
  assert.equal(connected.status, 200);
  assert.equal(connected.init.self.id, host.participantId);
  assert.deepEqual(connected.init.entities, []);
  assert.equal(JSON.stringify(connected.init).includes(host.token), false);
  assert.equal(session.headers.get('cache-control'), 'no-store');
});

test('Cloudflare connects more than ten peers and revokes sessions when they leave', integration, async () => {
  const f = fixture(), host = await f.create();
  assert.equal(host.status, 201);
  await f.connect(host);
  const guests = await Promise.all(Array.from({ length: 14 }, (_, i) => f.join(host.room, `Guest ${i}`)));
  assert.ok(guests.every(result => result.status === 200), JSON.stringify(guests.map(value => [value.status, value.code])));
  const connected = await Promise.all(guests.map(auth => f.connect(auth)));
  assert.ok(connected.every(result => result.status === 200));
  assert.equal((await f.poll(host)).participants.length, 15);
  assert.equal((await f.leave(guests[0])).status, 200);
  assert.equal((await f.connect(guests[0])).status, 401);
  assert.equal((await f.poll(host)).participants.length, 14);
});

test('Cloudflare targeted signals cannot cross participant or room boundaries', integration, async () => {
  const f = fixture(), host = await f.create();
  const guest = await f.join(host.room), observer = await f.join(host.room, 'Observer'), outsider = await f.create('Other room');
  for (const auth of [host, guest, observer, outsider]) assert.equal((await f.connect(auth)).status, 200);
  const data = { description: { type: 'offer', sdp: 'private-rtc-offer' } };
  assert.equal((await f.send(host, { type: 'signal', to: guest.participantId, from: outsider.participantId, data })).status, 200);
  const received = await f.poll(guest);
  assert.deepEqual(received.events.filter(event => event.message.type === 'signal').map(event => event.message), [{ type: 'signal', from: host.participantId, data }]);
  assert.equal((await f.poll(observer)).events.some(event => event.message.type === 'signal'), false);
  assert.equal((await f.poll(outsider)).events.some(event => event.message.type === 'signal'), false);
  assert.equal((await f.send(host, { type: 'signal', to: outsider.participantId, data })).status, 400);
  assert.equal((await f.send(host, { type: 'signal', to: host.participantId, data })).code, 'INVALID_SIGNAL');
  assert.equal((await f.request(`/api/rooms/${host.room.id}/events?after=0`, { auth: outsider })).status, 401);
  const forged = { ...host, connectionId: guest.connectionId };
  assert.equal((await f.send(forged, { type: 'chat', text: 'forged connection' })).code, 'CONNECTION_REPLACED');
  const baseline = (await f.poll(observer)).cursor;
  await f.send(host, { type: 'signal', to: guest.participantId, data: { candidate: null } });
  const unseen = await f.poll(observer, baseline);
  assert.equal(unseen.events.some(event => event.message.type === 'signal'), false);
  assert.ok(BigInt(unseen.cursor) > BigInt(baseline));
  assert.deepEqual((await f.poll(observer, unseen.cursor)).events, []);
});

test('Cloudflare concurrent signal retries are idempotent and reject changed payloads', integration, async () => {
  const f = fixture(), host = await f.create(), guest = await f.join(host.room);
  await f.connect(host); await f.connect(guest);
  const signal = { type: 'signal', to: guest.participantId, requestId: 'retry-the-same-signal', data: { candidate: 'same candidate' } };
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.send(host, signal)));
  assert.ok(replies.every(reply => reply.status === 200));
  assert.equal(replies.filter(reply => reply.duplicate).length, 11);
  assert.equal((await f.poll(guest)).events.filter(event => event.message.type === 'signal').length, 1);
  assert.equal((await f.send(host, { ...signal, data: { candidate: 'different' } })).code, 'REQUEST_ID_REUSED');
  assert.equal((await f.send(host, { ...signal, requestId: 'bad id' })).code, 'INVALID_REQUEST_ID');
  const stale = { ...host };
  await f.connect(host);
  assert.equal((await f.send(stale, signal)).code, 'CONNECTION_REPLACED');
  assert.equal((await f.send(host, { ...signal, data: { candidate: 'different connection' } })).status, 200);
});

test('Cloudflare serializes burst writes and paginates ordered event sequences without loss', integration, async () => {
  const f = fixture(), host = await f.create(), guest = await f.join(host.room);
  await f.connect(host); await f.connect(guest);
  let cursor = (await f.poll(guest)).cursor;
  const results = await Promise.all(Array.from({ length: 80 }, (_, i) => f.send(host, { type: 'chat', text: `Concurrent ${i}` })));
  assert.ok(results.every(result => result.status === 200), JSON.stringify(results.map(value => [value.status, value.code])));
  const messages = [];
  let batch, batches = 0;
  do {
    batch = await f.poll(guest, cursor);
    assert.equal(batch.status, 200);
    assert.ok(batch.events.length <= 64);
    assert.ok(BigInt(batch.cursor) > BigInt(cursor));
    messages.push(...batch.events.filter(event => event.message.type === 'chat'));
    cursor = batch.cursor;
    assert.ok(++batches < 10, 'event pagination must make progress');
  } while (batch.hasMore);
  assert.equal(messages.length, 80);
  assert.equal(new Set(messages.map(event => event.message.message.text)).size, 80);
  const sequences = messages.map(event => BigInt(event.sequence));
  assert.ok(sequences.every((value, i) => i === 0 || value > sequences[i - 1]));
  assert.deepEqual((await f.poll(guest, cursor)).events, []);
  const restored = await f.connect(guest);
  assert.equal(restored.init.chat.length, 80);
});

test('Cloudflare connection takeover rejects stale pollers and preserves one identity', integration, async () => {
  const f = fixture(), host = await f.create();
  await f.connect(host);
  const stale = { ...host };
  await f.connect(host);
  assert.notEqual(host.connectionId, stale.connectionId);
  assert.equal((await f.poll(stale)).code, 'CONNECTION_REPLACED');
  assert.equal((await f.send(stale, { type: 'chat', text: 'stale' })).code, 'CONNECTION_REPLACED');
  const current = await f.poll(host);
  assert.equal(current.participants.filter(person => person.id === host.participantId).length, 1);
});

test('Cloudflare slow unauthenticated uploads cannot block an admitted room', integration, async () => {
  const f = fixture(), host = await f.create();
  assert.equal(host.status, 201);
  assert.equal((await f.connect(host)).status, 200);
  let upload, responseStatus;
  const completed = new Promise((resolve, reject) => {
    upload = httpRequest(new URL(`/api/rooms/${host.room.id}/messages`, endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked', 'CF-Connecting-IP': '192.0.2.240' },
    }, response => {
      responseStatus = response.statusCode;
      response.resume();
      response.once('end', () => resolve(response.statusCode));
      response.once('error', reject);
    });
    upload.once('error', reject);
    upload.setTimeout(8000, () => upload.destroy(new Error('Slow-upload regression request timed out.')));
  });
  // Attach rejection handling before any socket event can occur. The assertion
  // below still awaits the original result after releasing the body.
  void completed.catch(() => {});
  try {
    upload.flushHeaders();
    await new Promise((resolve, reject) => upload.write('{"type":', error => error ? reject(error) : resolve()));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(responseStatus, undefined, 'the incomplete upload must remain pending during the competing read');
    const result = await f.request(`/api/rooms/${host.room.id}/events?after=${host.cursor}`, {
      auth: host, signal: AbortSignal.timeout(3000),
    });
    assert.equal(result.status, 200, 'an admitted participant must remain able to poll before the unauthenticated upload finishes');
    assert.equal(responseStatus, undefined, 'the authenticated poll must finish before releasing the uploaded body');
    upload.end('"ping"}');
    assert.equal(await completed, 401);
  } finally {
    if (!upload.destroyed && !upload.writableEnded) upload.end('"ping"}');
    // Destroy even when a poll assertion fails so an incomplete upload cannot
    // keep the test process or disposable Worker alive.
    upload.destroy();
  }
});

test('Cloudflare expired leases cannot be revived by polling or messages', integration, async () => {
  const f = fixture(), host = await f.create();
  await f.connect(host);
  const stale = { ...host };
  f.advance(120001);
  assert.equal((await f.poll(stale)).code, 'RESYNC_REQUIRED');
  assert.equal((await f.send(stale, { type: 'chat', text: 'expired' })).code, 'RESYNC_REQUIRED');
  assert.equal((await f.connect(host)).status, 200);
  assert.notEqual(host.connectionId, stale.connectionId);
  assert.equal((await f.poll(stale)).code, 'CONNECTION_REPLACED');
  assert.equal((await f.poll(host)).participants.length, 1);
});

test('Cloudflare bounds event history and expires room and bearer-session state', integration, async () => {
  const f = fixture(), host = await f.create(), guest = await f.join(host.room);
  await f.connect(host); await f.connect(guest);
  const originalCursor = guest.cursor;
  await f.send(host, { type: 'chat', text: 'history that will expire' });
  f.advance(600001);
  assert.equal((await f.connect(guest)).status, 200);
  assert.equal((await f.poll(guest, originalCursor)).code, 'RESYNC_REQUIRED');
  f.advance(24 * 60 * 60 * 1000);
  assert.equal((await f.request(`/api/rooms/${host.room.id}`)).status, 404);
  assert.equal((await f.request(`/api/rooms/${host.room.id}`, { headers: { 'X-Common-Test-Alarm': '1' } })).status, 404, 'expired alarms must preserve the SQLite schema for later requests');
  assert.equal((await f.request(`/api/rooms/${host.room.id}/session`, { auth: host })).status, 404);
  assert.equal((await f.join(host.room)).status, 404);
});

test('Cloudflare room styling is host-only and canvas writes stay on peer channels', integration, async () => {
  const f = fixture(), host = await f.create(), guest = await f.join(host.room);
  await f.connect(host); await f.connect(guest);
  const appearance = { preset: 'lagoon', accent: '#123456', canvas: '#f0f7f6', pattern: 'grid' };
  assert.equal((await f.send(guest, { type: 'appearance', appearance })).status, 403);
  assert.equal((await f.send(host, { type: 'appearance', appearance: { ...appearance, style: 'unsafe' } })).code, 'INVALID_ROOM_APPEARANCE');
  const baseline = (await f.poll(guest)).cursor;
  assert.equal((await f.send(host, { type: 'appearance', appearance })).status, 200);
  assert.deepEqual((await f.poll(guest, baseline)).events.find(event => event.message.type === 'appearance')?.message.appearance, appearance);
  assert.deepEqual((await f.request(`/api/rooms/${host.room.id}`)).room.appearance, appearance);
  assert.equal((await f.send(host, { type: 'upsert', entity: { id: 'private-canvas-only', text: 'must never persist' } })).code, 'PEER_CANVAS');
  assert.equal((await f.send(guest, { type: 'delete', id: 'private-canvas-only' })).code, 'PEER_CANVAS');
  const restored = await f.connect(guest);
  assert.deepEqual(restored.init.entities, []);
  assert.equal(JSON.stringify(restored).includes('must never persist'), false);
});

test('Cloudflare guided sessions preserve claims, checklists, participation and host features', integration, async () => {
  const f = fixture(), host = await f.create('Guided session', { workshop: { template: 'team-walkthrough', attendees: [{ id: 'sam', name: 'Sam' }] } });
  const guest = await f.join(host.room), observer = await f.join(host.room, 'Observer');
  const init = await f.connect(host); await f.connect(guest); await f.connect(observer);
  assert.equal(init.init.workshop.template, 'team-walkthrough');
  assert.equal((await f.send(guest, { type: 'workshop', action: 'claim', slotId: 'sam' })).status, 200);
  assert.equal((await f.send(observer, { type: 'workshop', action: 'claim', slotId: 'sam' })).code, 'WORKSHOP_SLOT_TAKEN');
  assert.equal((await f.send(guest, { type: 'workshop', action: 'complete', taskId: 'ready', completed: true })).status, 200);
  assert.equal((await f.send(guest, { type: 'workshop', action: 'participation', mode: 'viewer' })).status, 200);
  assert.equal((await f.send(guest, { type: 'workshop', action: 'feature', participantId: guest.participantId })).status, 403);
  assert.equal((await f.send(host, { type: 'workshop', action: 'feature', participantId: guest.participantId })).status, 200);
  const snapshot = await f.poll(host);
  const member = snapshot.participants.find(person => person.id === guest.participantId);
  assert.deepEqual(member.checklist, { slotId: 'sam', completed: ['ready'], participation: 'viewer' });
  assert.equal(snapshot.events.findLast(event => event.message.type === 'workshop')?.message.workshop.featuredParticipantId, guest.participantId);
  assert.equal((await f.leave(guest)).status, 200);
  assert.equal((await f.poll(host, snapshot.cursor)).events.findLast(event => event.message.type === 'workshop')?.message.workshop.featuredParticipantId, null);
  assert.equal((await f.send(observer, { type: 'workshop', action: 'claim', slotId: 'sam' })).status, 200);
});

test('Cloudflare spatial rooms preserve their experience and remain peer canvases', integration, async () => {
  const f = fixture(), host = await f.create('Space and time', { experience: 'spatial-beta' });
  assert.equal(host.status, 201);
  assert.equal(host.room.experience, 'spatial-beta');
  assert.equal(host.room.collaboration, 'peer');
  const guest = await f.join(host.room);
  assert.equal(guest.room.experience, 'spatial-beta');
  const connected = await f.connect(host);
  assert.equal(connected.init.room.experience, 'spatial-beta');
  assert.equal((await f.create('Invalid spatial collaboration', { experience: 'spatial-beta', collaboration: 'hosted' })).code, 'INVALID_COLLABORATION');
});

test('Cloudflare only hosts can end sessions and ended sessions reject further admission', integration, async () => {
  const f = fixture(), host = await f.create(), guest = await f.join(host.room);
  await f.connect(host); await f.connect(guest);
  assert.equal((await f.send(guest, { type: 'end' })).status, 403);
  const baseline = (await f.poll(guest)).cursor;
  assert.equal((await f.send(host, { type: 'end' })).status, 200);
  assert.ok((await f.poll(guest, baseline)).events.some(event => event.message.type === 'ended'));
  assert.equal((await f.join(host.room, 'Too late')).status, 404);
  assert.equal((await f.request(`/api/rooms/${host.room.id}/session`, { auth: host })).status, 404);
});

test('Cloudflare rejects malformed requests, oversized signals and invalid event cursors', integration, async () => {
  const f = fixture(), host = await f.create(), guest = await f.join(host.room);
  await f.connect(host); await f.connect(guest);
  assert.equal((await f.request('/api/rooms', { method: 'POST', raw: '{broken' })).status, 400);
  assert.equal((await f.request('/api/rooms', { method: 'POST', raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const large = await f.send(host, { type: 'signal', to: guest.participantId, data: { sdp: 'x'.repeat(140 * 1024) } });
  assert.ok([400, 413].includes(large.status));
  for (const after of ['-1', 'not-a-sequence', '1.5']) assert.equal((await f.poll(guest, after)).status, 400);
  assert.equal((await f.poll(guest, '999999999999999999')).code, 'RESYNC_REQUIRED');
  assert.equal((await f.poll(guest)).events.some(event => event.message.type === 'signal'), false);
});

test('Cloudflare TURN credentials require admission and match the configured secret', integration, async () => {
  const f = fixture(), host = await f.create();
  const publicIce = await f.request('/api/ice');
  assert.ok(publicIce.iceServers.every(server => !server.credential && !server.username));
  assert.equal((await f.request(`/api/ice?room=${host.room.id}`)).status, 401);
  const admitted = await f.request(`/api/ice?room=${host.room.id}`, { auth: host });
  assert.equal(admitted.status, 200);
  const relay = admitted.iceServers.find(server => server.credential);
  assert.ok(relay, 'test harness must configure its own disposable TURN credentials');
  assert.deepEqual(relay.urls, ['turn:relay.example:3478?transport=tcp']);
  assert.equal(relay.username.split(':')[1], host.participantId);
  assert.equal(relay.credential, createHmac('sha1', 'cloudflare-local-test-secret').update(relay.username).digest('base64'));
  assert.equal(admitted.expiresAt, Number(relay.username.split(':')[0]) * 1000);
  assert.equal(JSON.stringify(admitted).includes('cloudflare-local-test-secret'), false);
});

test('Cloudflare preserves shared portable protocol boundary cases', integration, async () => {
  const f = fixture();
  for (const sample of creationCases) {
    const result = await f.post('/api/rooms', sample.input);
    assert.equal(result.status, sample.status, sample.label);
    if (sample.code) assert.equal(result.code, sample.code, sample.label);
  }
  const host = await f.post('/api/rooms', validCreation);
  assert.equal(host.status, 201);
  for (const sample of joinCases) {
    const result = await f.post(`/api/rooms/${host.room.id}/join`, sample.input);
    assert.equal(result.status, sample.status, sample.label);
    if (sample.code) assert.equal(result.code, sample.code, sample.label);
  }
  await f.connect(host);
  for (const sample of activityCases) assert.equal((await f.send(host, sample.message)).code, sample.code, sample.label);
});
