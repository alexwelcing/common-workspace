import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { creationCases, joinCases, activityCases, validCreation } from './protocol-cases.mjs';

const databaseUrl = process.env.COMMON_TEST_DATABASE_URL;
const integration = { skip: !databaseUrl };
const PASSWORD = 'correct horse browser canvas';
const origin = 'https://common-test.example';

// Real SQL transactions are necessary to verify concurrent room admission.
// Each test owns a schema, so parallel test processes cannot share room state.
async function fixture(t, options = {}) {
  const { createApiHandler } = await import('../netlify/lib/api.mjs');
  const schema = `common_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 16 });
  const gates = [];
  const pauseQuery = (matches, phase = 'after') => {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const resumed = new Promise(resolve => { release = resolve; });
    const gate = { matches, phase, enter, release, entered, resumed, used: false };
    gates.push(gate);
    return gate;
  };
  const pause = async (sql, params, phase) => {
    const gate = gates.find(gate => !gate.used && gate.phase === phase && gate.matches(sql, params));
    if (gate) { gate.used = true; gate.enter(); await gate.resumed; }
  };
  const handlerPool = {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return {
        release: () => client.release(),
        async query(sql, params) {
          await pause(sql, params, 'before');
          const result = await client.query(sql, params);
          await pause(sql, params, 'after');
          return result;
        },
      };
    },
  };
  t.after(async () => {
    for (const gate of gates) gate.release();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  const directory = path.resolve(import.meta.dirname, '../netlify/database/migrations');
  for (const filename of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(path.join(directory, filename), 'utf8'));
  }
  let clock = Date.now();
  const handler = createApiHandler({ pool: handlerPool, env: () => undefined, now: () => clock, rateLimits: false, ...options });
  const request = async (route, { method = 'GET', body, auth, headers = {}, raw } = {}) => {
    const response = await handler(new Request(`${origin}${route}`, {
      method,
      headers: {
        ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth ? { Authorization: `Bearer ${auth.token}`, ...(auth.connectionId ? { 'X-Common-Connection': auth.connectionId } : {}) } : {}),
        ...headers,
      },
      ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}),
    }), { ip: '127.0.0.1' });
    const json = await response.json();
    return { status: response.status, ...json };
  };
  const post = (route, body, auth, headers) => request(route, { method: 'POST', body, auth, headers });
  const create = (name = 'Browser collaboration', extra = {}) => post('/api/rooms', { name, displayName: 'Alex', password: PASSWORD, collaboration: 'peer', ...extra });
  const join = (room, displayName = 'Sam', password = PASSWORD) => post(`/api/rooms/${room.id}/join`, { displayName, password });
  const connect = async auth => {
    const result = await post(`/api/rooms/${auth.room.id}/connect`, {}, auth);
    if (result.status === 200) {
      auth.connectionId = result.connectionId;
      auth.cursor = result.cursor;
    }
    return result;
  };
  const poll = (auth, after = auth.cursor) => request(`/api/rooms/${auth.room.id}/events?after=${encodeURIComponent(after)}`, { auth });
  const send = (auth, message) => post(`/api/rooms/${auth.room.id}/messages`, message, auth);
  const leave = auth => post(`/api/rooms/${auth.room.id}/leave`, {}, auth);
  return { pool, handler, request, post, create, join, connect, poll, send, leave, pauseQuery, advance: milliseconds => { clock += milliseconds; } };
}

test('Netlify admission protects passwords, bearer sessions, and same-origin writes', integration, async t => {
  const f = await fixture(t);
  assert.equal((await f.create('Invalid', { password: 'short' })).status, 400);
  assert.equal((await f.post('/api/rooms', { name: 'Denied', displayName: 'A', password: PASSWORD }, undefined, { Origin: 'https://untrusted.example' })).status, 403);
  const host = await f.create();
  assert.equal(host.status, 201);
  assert.equal(host.isAdmin, true);
  assert.equal(host.room.collaboration, 'peer');
  const info = await f.request(`/api/rooms/${host.room.id}`);
  assert.equal(info.status, 200);
  assert.equal(JSON.stringify(info).includes(PASSWORD), false);
  assert.equal(JSON.stringify(info).includes(host.token), false);
  assert.equal((await f.request(`/api/rooms/${host.room.id}/session`)).status, 401);
  assert.equal((await f.join(host.room, 'Sam', 'wrong-password')).code, 'WRONG_PASSWORD');
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
});

test('Netlify admits and connects more than ten participants without weakening token revocation', integration, async t => {
  const f = await fixture(t);
  const host = await f.create();
  await f.connect(host);
  const guests = await Promise.all(Array.from({ length: 14 }, (_, i) => f.join(host.room, `Guest ${i}`)));
  assert.ok(guests.every(result => result.status === 200));
  const connected = await Promise.all(guests.map(auth => f.connect(auth)));
  assert.ok(connected.every(result => result.status === 200));
  assert.equal((await f.poll(host)).participants.length, 15);
  const guest = guests[0];
  assert.equal((await f.leave(guest)).status, 200);
  assert.equal((await f.join(host.room, 'Replacement')).status, 200);
  assert.equal((await f.connect(guest)).status, 401);
});

test('expired connections require reconnect and can return alongside more than ten new peers', integration, async t => {
  const f = await fixture(t, { leaseMs: 90000, reservationMs: 90000 });
  const old = await f.create();
  await f.connect(old);
  f.advance(90001);
  assert.equal((await f.poll(old)).code, 'RESYNC_REQUIRED');
  const replacements = await Promise.all(Array.from({ length: 12 }, (_, i) => f.join(old.room, `New peer ${i}`)));
  assert.ok(replacements.every(result => result.status === 200));
  const originalConnection = old.connectionId;
  const reconnected = await f.connect(old);
  assert.equal(reconnected.status, 200);
  assert.notEqual(reconnected.connectionId, originalConnection);
  assert.equal(reconnected.init.self.id, old.participantId);
  assert.ok((await Promise.all(replacements.map(auth => f.connect(auth)))).every(result => result.status === 200));
  assert.equal((await f.poll(old)).participants.length, 13);
});

const memberRead = sql => sql.startsWith('SELECT * FROM common_members WHERE room_id = $1 AND token_hash = $2');
const pollRenewal = sql => sql.includes('SET lease_until =');
const messageRenewal = sql => sql.includes('SET rate_start =');
const leaseState = async (f, auth) => (await f.pool.query('SELECT connection_id, lease_until FROM common_members WHERE id = $1', [auth.participantId])).rows[0];
async function waitForDatabaseState(check) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Database did not reach the expected lock or expiry state.');
}

for (const operation of ['poll', 'message']) {
  test(`${operation} renewal checks expiry after an unchanged member-row lock wait`, integration, async t => {
    const f = await fixture(t, { now: Date.now });
    const host = await f.create();
    await f.connect(host);
    await f.pool.query("UPDATE common_members SET lease_until = clock_timestamp() + interval '1200 milliseconds' WHERE id = $1", [host.participantId]);
    const original = await leaseState(f, host);
    const blocker = await f.pool.connect();
    let pending;
    try {
      await blocker.query('BEGIN');
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
      await blocker.query('SELECT id FROM common_members WHERE id = $1 FOR UPDATE', [host.participantId]);
      pending = operation === 'poll' ? f.poll(host) : f.send(host, { type: 'chat', text: 'Must expire before acceptance' });
      // Observe a real PostgreSQL row-lock wait, then let DB time cross the lease
      // deadline without modifying the blocked tuple. A plain UPDATE can evaluate
      // its volatile predicate before waiting and wrongly revive this connection.
      await waitForDatabaseState(async () => (await f.pool.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount > 0);
      await waitForDatabaseState(async () => (await f.pool.query('SELECT lease_until <= clock_timestamp() AS expired FROM common_members WHERE id = $1', [host.participantId])).rows[0].expired);
      await blocker.query('ROLLBACK');
      assert.equal((await pending).code, 'RESYNC_REQUIRED');
      assert.equal((await leaseState(f, host)).lease_until.getTime(), original.lease_until.getTime());
      if (operation === 'message') assert.deepEqual((await f.pool.query('SELECT chat FROM common_rooms WHERE id = $1', [host.room.id])).rows[0].chat, []);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      if (pending) await pending;
    }
  });
}

test('poll renewal checks replacement after waiting for the member-row lock', integration, async t => {
  const f = await fixture(t, { now: Date.now });
  const host = await f.create();
  await f.connect(host);
  await f.pool.query("UPDATE common_members SET lease_until = clock_timestamp() + interval '60 seconds' WHERE id = $1", [host.participantId]);
  const blocker = await f.pool.connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
    await blocker.query('SELECT id FROM common_members WHERE id = $1 FOR UPDATE', [host.participantId]);
    pending = f.poll(host);
    await waitForDatabaseState(async () => (await f.pool.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount > 0);
    await blocker.query("UPDATE common_members SET connection_id = 'replacement-under-lock', lease_until = clock_timestamp() + interval '120 seconds' WHERE id = $1", [host.participantId]);
    const replacement = await blocker.query('SELECT lease_until FROM common_members WHERE id = $1', [host.participantId]);
    await blocker.query('COMMIT');
    assert.equal((await pending).code, 'CONNECTION_REPLACED');
    const current = await leaseState(f, host);
    assert.equal(current.connection_id, 'replacement-under-lock');
    assert.equal(current.lease_until.getTime(), replacement.rows[0].lease_until.getTime());
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    if (pending) await pending;
  }
});

test('a poll delayed across lease expiry cannot revive a connection swept by new admissions', integration, async t => {
  const f = await fixture(t);
  const host = await f.create();
  await f.connect(host);
  const original = await leaseState(f, host);
  f.advance(119000);
  const gate = f.pauseQuery(memberRead);
  const pending = f.poll(host);
  try {
    await gate.entered;
    f.advance(2000);
    const newcomers = await Promise.all(Array.from({ length: 12 }, (_, i) => f.join(host.room, `Newcomer ${i}`)));
    assert.ok(newcomers.every(result => result.status === 200));
    assert.equal((await leaseState(f, host)).connection_id, null);
    gate.release();
    assert.equal((await pending).code, 'CONNECTION_REPLACED');
    assert.equal((await leaseState(f, host)).lease_until.getTime(), original.lease_until.getTime());
    assert.equal((await f.connect(host)).status, 200);
    assert.notEqual(host.connectionId, original.connection_id);
  } finally { gate.release(); await pending; }
});

test('an expired connection cannot be renewed by an in-flight poll before the sweep runs', integration, async t => {
  const f = await fixture(t);
  const host = await f.create();
  await f.connect(host);
  const original = await leaseState(f, host);
  f.advance(119000);
  const gate = f.pauseQuery(memberRead);
  const pending = f.poll(host);
  try {
    await gate.entered;
    f.advance(2000);
    gate.release();
    assert.equal((await pending).code, 'RESYNC_REQUIRED');
    assert.equal((await leaseState(f, host)).lease_until.getTime(), original.lease_until.getTime());
  } finally { gate.release(); await pending; }
});

test('a replaced connection cannot renew the current tab from a stale poll snapshot', integration, async t => {
  const f = await fixture(t);
  const host = await f.create();
  await f.connect(host);
  const oldConnection = host.connectionId;
  f.advance(35000);
  const gate = f.pauseQuery(memberRead);
  const pending = f.poll(host);
  try {
    await gate.entered;
    f.advance(20000);
    assert.equal((await f.connect(host)).status, 200);
    assert.notEqual(host.connectionId, oldConnection);
    const replacement = await leaseState(f, host);
    gate.release();
    assert.equal((await pending).code, 'CONNECTION_REPLACED');
    const current = await leaseState(f, host);
    assert.equal(current.connection_id, replacement.connection_id);
    assert.equal(current.lease_until.getTime(), replacement.lease_until.getTime());
    assert.equal((await f.poll(host)).status, 200);
  } finally { gate.release(); await pending; }
});

test('a delayed poll update preserves a newer lease from accepted activity', integration, async t => {
  const f = await fixture(t);
  const host = await f.create();
  await f.connect(host);
  f.advance(35000);
  const gate = f.pauseQuery(pollRenewal, 'before');
  const pending = f.poll(host);
  try {
    await gate.entered;
    f.advance(20000);
    assert.equal((await f.send(host, { type: 'chat', text: 'Fresh activity' })).status, 200);
    const latest = await leaseState(f, host);
    gate.release();
    assert.equal((await pending).status, 200);
    assert.equal((await leaseState(f, host)).lease_until.getTime(), latest.lease_until.getTime());
  } finally { gate.release(); await pending; }
});

test('a delayed message update preserves a newer lease from concurrent polling', integration, async t => {
  const f = await fixture(t);
  const host = await f.create();
  await f.connect(host);
  f.advance(35000);
  const gate = f.pauseQuery(messageRenewal, 'before');
  const pending = f.send(host, { type: 'chat', text: 'Delayed activity' });
  try {
    await gate.entered;
    f.advance(20000);
    assert.equal((await f.poll(host)).status, 200);
    const latest = await leaseState(f, host);
    gate.release();
    assert.equal((await pending).status, 200);
    assert.equal((await leaseState(f, host)).lease_until.getTime(), latest.lease_until.getTime());
  } finally { gate.release(); await pending; }
});

test('targeted signaling cannot cross room or participant boundaries', integration, async t => {
  const f = await fixture(t);
  const host = await f.create();
  const guest = await f.join(host.room);
  const observer = await f.join(host.room, 'Observer');
  const outsider = await f.create('Other room');
  for (const auth of [host, guest, observer, outsider]) await f.connect(auth);
  const data = { description: { type: 'offer', sdp: 'private-rtc-offer' } };
  assert.equal((await f.send(host, { type: 'signal', to: guest.participantId, from: outsider.participantId, data })).status, 200);
  const received = await f.poll(guest);
  assert.deepEqual(received.events.filter(event => event.message.type === 'signal').map(event => event.message), [{ type: 'signal', from: host.participantId, data }]);
  assert.equal((await f.poll(observer)).events.some(event => event.message.type === 'signal'), false);
  assert.equal((await f.poll(outsider)).events.some(event => event.message.type === 'signal'), false);
  assert.equal((await f.send(host, { type: 'signal', to: outsider.participantId, data })).status, 400);
  assert.equal((await f.send(host, { type: 'signal', to: host.participantId, data })).code, 'INVALID_SIGNAL');
  for (const invalid of [null, [], 'not an object']) {
    assert.equal((await f.send(host, { type: 'signal', to: guest.participantId, data: invalid })).code, 'INVALID_SIGNAL');
  }
  assert.equal((await f.request(`/api/rooms/${host.room.id}/events?after=0`, { auth: outsider })).status, 401);
  const forged = { ...host, connectionId: guest.connectionId };
  assert.equal((await f.send(forged, { type: 'chat', text: 'forged connection' })).code, 'CONNECTION_REPLACED');
});

test('poll cursors preserve concurrent message order and advance past invisible events', integration, async t => {
  const f = await fixture(t);
  const host = await f.create();
  const guest = await f.join(host.room);
  const observer = await f.join(host.room, 'Observer');
  for (const auth of [host, guest, observer]) await f.connect(auth);
  const baseline = await f.poll(guest);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.send(host, { type: 'chat', text: `Concurrent ${i}` })));
  assert.ok(results.every(result => result.status === 200));
  const batch = await f.poll(guest, baseline.cursor);
  const messages = batch.events.filter(event => event.message.type === 'chat');
  assert.equal(messages.length, 12);
  assert.equal(new Set(messages.map(event => event.message.message.text)).size, 12);
  const sequences = messages.map(event => BigInt(event.sequence));
  assert.ok(sequences.every((value, i) => i === 0 || value > sequences[i - 1]));
  assert.equal((await f.poll(guest, batch.cursor)).events.length, 0);
  const unseenBaseline = (await f.poll(observer)).cursor;
  await f.send(host, { type: 'signal', to: guest.participantId, data: { candidate: null } });
  const unseen = await f.poll(observer, unseenBaseline);
  assert.equal(unseen.events.some(event => event.message.type === 'signal'), false);
  assert.ok(BigInt(unseen.cursor) > BigInt(unseenBaseline));
  assert.equal((await f.poll(observer, unseen.cursor)).events.length, 0);
});

test('replacement connections invalidate old pollers and keep one participant identity', integration, async t => {
  const f = await fixture(t);
  const host = await f.create();
  await f.connect(host);
  const stale = { ...host };
  await f.connect(host);
  assert.notEqual(host.connectionId, stale.connectionId);
  assert.equal((await f.poll(stale)).code, 'CONNECTION_REPLACED');
  assert.equal((await f.send(stale, { type: 'chat', text: 'stale' })).code, 'CONNECTION_REPLACED');
  const current = await f.poll(host);
  assert.equal(current.participants.filter(person => person.id === host.participantId).length, 1);
});

test('Netlify rooms never accept or retain canvas writes and only hosts can end them', integration, async t => {
  const f = await fixture(t);
  const host = await f.create();
  const guest = await f.join(host.room);
  const hostInit = await f.connect(host);
  const guestInit = await f.connect(guest);
  assert.deepEqual(hostInit.init.entities, []);
  assert.deepEqual(guestInit.init.entities, []);
  assert.equal((await f.send(host, { type: 'upsert', entity: { id: 'private-canvas-only', type: 'sticky', text: 'must never persist' } })).code, 'PEER_CANVAS');
  assert.equal((await f.send(guest, { type: 'delete', id: 'private-canvas-only' })).code, 'PEER_CANVAS');
  assert.equal((await f.send(guest, { type: 'end' })).status, 403);
  const beforeEnd = await f.poll(guest);
  assert.equal((await f.send(host, { type: 'end' })).status, 200);
  assert.ok((await f.poll(guest, beforeEnd.cursor)).events.some(event => event.message.type === 'ended'));
  assert.equal((await f.join(host.room, 'Too late')).status, 404);
  assert.equal((await f.request(`/api/rooms/${host.room.id}/session`, { auth: host })).status, 404);
  const tables = await f.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()");
  for (const { table_name: table } of tables.rows) {
    assert.match(table, /^[a-z_]+$/);
    const rows = await f.pool.query(`SELECT row_to_json(t) AS value FROM ${table} t`);
    assert.equal(JSON.stringify(rows.rows).includes('private-canvas-only'), false);
    assert.equal(JSON.stringify(rows.rows).includes('must never persist'), false);
  }
});

test('malformed requests, oversized signaling, and invalid event cursors are bounded', integration, async t => {
  const f = await fixture(t);
  const host = await f.create();
  const guest = await f.join(host.room);
  await f.connect(host);
  await f.connect(guest);
  assert.equal((await f.request('/api/rooms', { method: 'POST', raw: '{broken' })).status, 400);
  const oversized = await f.send(host, { type: 'signal', to: guest.participantId, data: { description: { type: 'offer', sdp: 'x'.repeat(140 * 1024) } } });
  assert.ok([400, 413].includes(oversized.status));
  for (const after of ['-1', 'no-sequence', '1.5']) assert.equal((await f.poll(guest, after)).status, 400);
  assert.equal((await f.poll(guest, '999999999999999999')).code, 'RESYNC_REQUIRED');
  assert.equal((await f.poll(guest)).events.some(event => event.message.type === 'signal'), false);
});

test('expired event history requests resynchronization and room TTL removes sessions', integration, async t => {
  const f = await fixture(t, { eventTtlMs: 1000, roomTtlMs: 5000, leaseMs: 90000 });
  const host = await f.create();
  const guest = await f.join(host.room);
  await f.connect(host);
  await f.connect(guest);
  const originalCursor = guest.cursor;
  await f.send(host, { type: 'chat', text: 'This event will expire' });
  f.advance(1001);
  assert.equal((await f.poll(guest, originalCursor)).code, 'RESYNC_REQUIRED');
  const restored = await f.connect(guest);
  assert.equal(restored.status, 200);
  const oldEvents = await f.pool.query("SELECT COUNT(*)::integer AS count FROM common_events WHERE payload->>'type' = 'chat'");
  assert.equal(oldEvents.rows[0].count, 0);
  f.advance(5000);
  assert.equal((await f.request(`/api/rooms/${host.room.id}`)).status, 404);
  assert.equal((await f.request(`/api/rooms/${host.room.id}/session`, { auth: host })).status, 404);
  assert.equal((await f.create('Next temporary room')).status, 201);
  for (const table of ['common_rooms', 'common_members', 'common_events']) {
    const key = table === 'common_rooms' ? 'id' : 'room_id';
    assert.equal((await f.pool.query(`SELECT COUNT(*)::integer AS count FROM ${table} WHERE ${key} = $1`, [host.room.id])).rows[0].count, 0);
  }
});

test('TURN credentials require room admission and secret-derived credentials expire', integration, async t => {
  const settings = { TURN_URLS: 'turn:relay.example:3478?transport=tcp', TURN_SECRET: 'local-test-secret', TURN_TTL_SECONDS: '120' };
  const f = await fixture(t, { env: key => settings[key] });
  const host = await f.create();
  const publicIce = await f.request('/api/ice');
  assert.ok(publicIce.iceServers.every(server => !server.credential && !server.username));
  assert.equal((await f.request(`/api/ice?room=${host.room.id}`)).status, 401);
  const admitted = await f.request(`/api/ice?room=${host.room.id}`, { auth: host });
  assert.equal(admitted.status, 200);
  const relay = admitted.iceServers.find(server => server.credential);
  assert.deepEqual(relay.urls, [settings.TURN_URLS]);
  assert.equal(relay.username.split(':')[1], host.participantId);
  assert.equal(relay.credential, createHmac('sha1', settings.TURN_SECRET).update(relay.username).digest('base64'));
  assert.equal(admitted.expiresAt, Number(relay.username.split(':')[0]) * 1000);
  assert.equal(JSON.stringify(admitted).includes(settings.TURN_SECRET), false);
  f.advance(121000);
  const refreshed = await f.request(`/api/ice?room=${host.room.id}`, { auth: host });
  assert.ok(refreshed.expiresAt > admitted.expiresAt);
  assert.notEqual(refreshed.iceServers.find(server => server.credential).credential, relay.credential);
});

test('polling reads without locking, refreshes leases sparingly, and leaves cleanup to the sweep', integration, async t => {
  const f = await fixture(t, { leaseMs: 120000, leaseRefreshMs: 30000, eventTtlMs: 60000 });
  const host = await f.create();
  const guest = await f.join(host.room);
  await f.connect(host);
  await f.connect(guest);
  const lease = async auth => (await f.pool.query('SELECT lease_until FROM common_members WHERE id = $1', [auth.participantId])).rows[0].lease_until.getTime();
  const connected = await lease(guest);
  f.advance(10000);
  assert.equal((await f.poll(guest)).status, 200);
  assert.equal(await lease(guest), connected);
  f.advance(25000);
  assert.equal((await f.poll(guest)).status, 200);
  assert.ok(await lease(guest) > connected);

  // A row lock held by a room write must not block a reader.
  const blocker = await f.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM common_rooms WHERE id = $1 FOR UPDATE', [host.room.id]);
    const result = await Promise.race([f.poll(guest), new Promise(resolve => setTimeout(() => resolve('blocked'), 2000))]);
    assert.equal(result.status, 200);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }

  await f.send(host, { type: 'chat', text: 'Old news' });
  f.advance(121000);
  assert.equal((await f.poll(guest)).code, 'RESYNC_REQUIRED');
  assert.deepEqual(await f.handler.sweep(), { pruned: 1 });
  const left = await f.pool.query('SELECT COUNT(*)::integer AS count FROM common_members WHERE room_id = $1 AND connection_id IS NOT NULL', [host.room.id]);
  assert.equal(left.rows[0].count, 0);
  const events = await f.pool.query("SELECT payload->>'type' AS type FROM common_events WHERE room_id = $1 ORDER BY seq", [host.room.id]);
  assert.deepEqual(events.rows.map(row => row.type), ['participants']);
  assert.deepEqual(await f.handler.sweep(), { pruned: 0 });
});

test('only public, member-free responses are cacheable at the CDN', integration, async t => {
  const settings = { TURN_URLS: 'turn:relay.example:3478', TURN_SECRET: 'local-test-secret' };
  const f = await fixture(t, { env: key => settings[key] });
  const host = await f.create();
  const get = (route, headers = {}) => f.handler(new Request(`${origin}${route}`, { headers }), { ip: '127.0.0.1' });
  const publicIce = await get('/api/ice');
  assert.match(publicIce.headers.get('netlify-cdn-cache-control'), /s-maxage=3600/);
  assert.equal(publicIce.headers.get('netlify-vary'), 'query=room');
  const health = await get('/api/health');
  assert.match(health.headers.get('netlify-cdn-cache-control'), /s-maxage=15/);
  const admitted = await get(`/api/ice?room=${host.room.id}`, { Authorization: `Bearer ${host.token}` });
  assert.equal(admitted.status, 200);
  assert.equal(admitted.headers.get('cache-control'), 'no-store');
  assert.equal(admitted.headers.get('netlify-cdn-cache-control'), null);
  const session = await get(`/api/rooms/${host.room.id}/session`, { Authorization: `Bearer ${host.token}` });
  assert.equal(session.headers.get('cache-control'), 'no-store');
});

async function seedEvents(f, auth, entries) {
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [room] } = await client.query('SELECT event_seq FROM common_rooms WHERE id = $1 FOR UPDATE', [auth.room.id]);
    await client.query(`INSERT INTO common_events (room_id, seq, target_id, payload, created_at)
      SELECT $1, $2::bigint + ordinal, item->>'target', item->'payload', $4
      FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS item(item, ordinal)`, [auth.room.id, room.event_seq, JSON.stringify(entries), new Date()]);
    await client.query('UPDATE common_rooms SET event_seq = event_seq + $2 WHERE id = $1', [auth.room.id, entries.length]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

test('recipient batches skip hundreds of invisible events without skipping a visible event', integration, async t => {
  const f = await fixture(t);
  const host = await f.create();
  const guest = await f.join(host.room);
  await f.connect(host); await f.connect(guest);
  const baseline = (await f.poll(host)).cursor;
  const hidden = () => ({ target: guest.participantId, payload: { type: 'signal', from: 'hidden', data: { secret: 'never returned' } } });
  const visible = index => ({ target: host.participantId, payload: { type: 'signal', from: guest.participantId, data: { index } } });
  await seedEvents(f, host, [...Array.from({ length: 300 }, hidden), ...Array.from({ length: 70 }, (_, i) => visible(i)),
    ...Array.from({ length: 400 }, hidden), ...Array.from({ length: 60 }, (_, i) => visible(i + 70)), ...Array.from({ length: 20 }, hidden)]);
  const seen = []; let cursor = baseline; let batches = 0; let result;
  do {
    result = await f.poll(host, cursor); batches++;
    assert.equal(result.status, 200);
    assert.ok(result.events.length <= 64);
    assert.equal(JSON.stringify(result).includes('never returned'), false);
    for (const event of result.events) { assert.ok(BigInt(event.sequence) > BigInt(cursor)); seen.push(event.message.data.index); }
    assert.ok(BigInt(result.cursor) > BigInt(cursor));
    cursor = result.cursor;
  } while (result.hasMore);
  assert.equal(batches, 3);
  assert.deepEqual(seen, Array.from({ length: 130 }, (_, i) => i));
  assert.equal(cursor, (await f.pool.query('SELECT event_seq FROM common_rooms WHERE id = $1', [host.room.id])).rows[0].event_seq);
  assert.equal((await f.poll(host, cursor)).events.length, 0);
});

test('event batches respect a byte budget and a pruning race requests resynchronization', integration, async t => {
  const f = await fixture(t, { eventTtlMs: 1000 });
  const host = await f.create(); await f.connect(host);
  const baseline = host.cursor;
  await seedEvents(f, host, Array.from({ length: 6 }, (_, index) => ({ target: host.participantId, payload: { type: 'signal', data: { index, text: 'x'.repeat(120000) } } })));
  const first = await f.poll(host, baseline);
  assert.equal(first.status, 200); assert.equal(first.events.length, 4); assert.equal(first.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 512 * 1024);
  const second = await f.poll(host, first.cursor);
  assert.equal(second.events.length, 2); assert.equal(second.hasMore, false);
  const gate = f.pauseQuery(sql => sql.startsWith('SELECT room.event_seq'), 'before');
  const pending = f.poll(host, baseline);
  try {
    await gate.entered;
    f.advance(2000); await f.handler.sweep(); gate.release();
    assert.equal((await pending).code, 'RESYNC_REQUIRED');
  } finally { gate.release(); await pending; }
});

test('roster versions omit unchanged membership and detect lease expiry before a scheduled sweep', integration, async t => {
  const f = await fixture(t);
  const host = await f.create(); const guest = await f.join(host.room);
  const connected = await f.connect(host); await f.connect(guest);
  const originalCursor = host.cursor;
  const poll = async version => {
    const result = await f.request(`/api/rooms/${host.room.id}/events?after=${host.cursor}&rosterVersion=${version}`, { auth: host });
    if (result.status === 200) host.cursor = result.cursor;
    return result;
  };
  const changed = await poll(connected.rosterVersion);
  assert.equal(changed.participants.length, 2);
  assert.notEqual(changed.rosterVersion, connected.rosterVersion);
  assert.equal(Object.hasOwn(await poll(changed.rosterVersion), 'participants'), false);
  assert.equal((await f.poll(host)).participants.length, 2, 'legacy clients still receive complete rosters');
  f.advance(35000); await poll(changed.rosterVersion);
  f.advance(86000);
  const expired = await poll(changed.rosterVersion);
  assert.equal(expired.status, 200);
  assert.notEqual(expired.rosterVersion, changed.rosterVersion);
  assert.deepEqual(expired.participants.map(p => p.id), [host.participantId]);
  assert.equal(Object.hasOwn(await poll(expired.rosterVersion), 'participants'), false);
  const historical = await f.request(`/api/rooms/${host.room.id}/events?after=${originalCursor}&rosterVersion=${expired.rosterVersion}`, { auth: host });
  assert.deepEqual(historical.participants.map(p => p.id), [host.participantId], 'historical presence events must be followed by the current roster');
});

test('signal request IDs deduplicate concurrent retries and fence changed payloads and replaced connections', integration, async t => {
  const f = await fixture(t);
  const host = await f.create(); const guest = await f.join(host.room);
  await f.connect(host); await f.connect(guest);
  const signal = { type: 'signal', to: guest.participantId, data: { candidate: 'one candidate' }, requestId: 'same_request_0001' };
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.send(host, signal)));
  assert.ok(replies.every(reply => reply.status === 200));
  assert.equal(replies.filter(reply => reply.duplicate).length, 11);
  assert.equal((await f.poll(guest)).events.filter(event => event.message.type === 'signal').length, 1);
  assert.equal((await f.send(host, { ...signal, data: { candidate: 'different' } })).code, 'REQUEST_ID_REUSED');
  assert.equal((await f.send(host, { ...signal, requestId: 'bad id' })).code, 'INVALID_REQUEST_ID');
  const old = { ...host }; await f.connect(host);
  assert.equal((await f.send(old, signal)).code, 'CONNECTION_REPLACED');
  assert.equal((await f.send(host, signal)).status, 200, 'request IDs are scoped to one authenticated connection');
});

test('shared portable protocol boundary cases match the hosted adapter', integration, async t => {
  const f = await fixture(t);
  for (const sample of creationCases) {
    const result = await f.post('/api/rooms', sample.input);
    assert.equal(result.status, sample.status, sample.label);
    if (sample.code) assert.equal(result.code, sample.code, sample.label);
  }
  const host = await f.post('/api/rooms', validCreation);
  for (const sample of joinCases) {
    const result = await f.post(`/api/rooms/${host.room.id}/join`, sample.input);
    assert.equal(result.status, sample.status, sample.label);
    if (sample.code) assert.equal(result.code, sample.code, sample.label);
  }
  await f.connect(host);
  for (const sample of activityCases) assert.equal((await f.send(host, sample.message)).code, sample.code, sample.label);
});
