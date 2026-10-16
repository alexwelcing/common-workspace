import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { createApp } from '../server.mjs';

const PASSWORD = 'correct horse battery';
const entity = (id, extra = {}) => ({ id, type: 'sticky', x: 20, y: 30, width: 240, height: 160, text: 'A shared idea', color: '#fff0b9', ...extra });

function upgradeRequest(base, room, token, headers = {}) {
  const url = new URL('/ws', base);
  url.searchParams.set('room', room.id);
  url.searchParams.set('token', token);
  return httpRequest(url, {
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      ...headers,
    },
  });
}

function upgradeStatus(base, room, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = upgradeRequest(base, room, token, headers);
    request.on('response', response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('WebSocket upgrade request timed out')));
    request.end();
  });
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'common-test-'));
  const app = await createApp({ dataFile: path.join(directory, 'rooms.json'), ...options });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const clients = [];
  t.after(async () => { for (const client of clients) client.ws.terminate(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (route, body, headers = {}) => {
    const response = await fetch(`${base}${route}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, ...(await response.json()) };
  };
  const create = (name = 'Design together', extra = {}) => request('/api/rooms', { name, displayName: 'Alex', password: PASSWORD, ...extra });
  const join = (room, displayName = 'Sam') => request(`/api/rooms/${room.id}/join`, { displayName, password: PASSWORD });
  const connect = async (auth, wsOptions) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${auth.room.id}&token=${auth.token}`, wsOptions);
    const queue = [];
    ws.on('message', data => queue.push(JSON.parse(data)));
    ws.on('error', () => {});
    await once(ws, 'open');
    const client = {
      ws, queue,
      send(message) { ws.send(JSON.stringify(message)); },
      async next(type, predicate = () => true) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const index = queue.findIndex(message => message.type === type && predicate(message));
          if (index >= 0) return queue.splice(index, 1)[0];
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.fail(`Timed out waiting for ${type}. Received: ${JSON.stringify(queue)}`);
      },
    };
    clients.push(client);
    client.init = await client.next('init');
    return client;
  };
  const connectWithoutPong = auth => new Promise((resolve, reject) => {
    const request = upgradeRequest(base, auth.room, auth.token);
    request.on('upgrade', (_response, socket) => {
      // Discard server frames so ping frames never receive an automatic pong.
      socket.resume();
      const client = {
        ws: { terminate: () => socket.destroy() },
        send(message) {
          const payload = Buffer.from(JSON.stringify(message));
          assert.ok(payload.length <= 65535, 'Raw heartbeat client supports short test messages');
          const mask = randomBytes(4);
          const header = Buffer.alloc(payload.length < 126 ? 6 : 8);
          header[0] = 0x81;
          header[1] = 0x80 | (payload.length < 126 ? payload.length : 126);
          if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
          mask.copy(header, header.length - 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          socket.write(Buffer.concat([header, payload]));
        },
      };
      clients.push(client);
      resolve(client);
    });
    request.on('response', response => {
      response.resume();
      reject(new Error(`Expected WebSocket upgrade, received ${response.statusCode}`));
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('WebSocket upgrade request timed out')));
    request.end();
  });
  return { app, directory, base, request, create, join, connect, connectWithoutPong };
}

test('rooms require passwords, reject cross-origin writes, and keep credentials private', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/rooms', { name: 'A', displayName: 'Alex', password: 'short' })).code, 'INVALID_PASSWORD');
  assert.equal((await f.request('/api/rooms', { name: 'A', displayName: 'Alex', password: PASSWORD }, { Origin: 'https://attacker.example' })).status, 403);
  const auth = await f.create();
  assert.equal(auth.status, 201);
  assert.equal(auth.isAdmin, true);
  const info = await f.request(`/api/rooms/${auth.room.id}`);
  assert.deepEqual(Object.keys(info.room).sort(), ['createdAt', 'id', 'name']);
  assert.equal((await f.request(`/api/rooms/${auth.room.id}/session`)).status, 401);
  const session = await f.request(`/api/rooms/${auth.room.id}/session`, undefined, { Authorization: `Bearer ${auth.token}` });
  assert.equal(session.participantId, auth.participantId);
  assert.equal(session.isAdmin, true);
  assert.equal(session.displayName, 'Alex');
  assert.equal((await f.request(`/api/rooms/${auth.room.id}/join`, { displayName: 'Sam', password: 'wrong' })).code, 'WRONG_PASSWORD');
  const guest = await f.join(auth.room);
  assert.equal(guest.isAdmin, false);
  const client = await f.connect(auth);
  assert.equal(client.init.self.id, auth.participantId);
  assert.equal(client.init.self.isAdmin, true);
  assert.equal(JSON.stringify(client.init).includes(auth.token), false);
  assert.equal(await upgradeStatus(f.base, auth.room, 'incorrect'), 401);
  assert.equal(await upgradeStatus(f.base, auth.room, guest.token, { Origin: 'https://attacker.example' }), 403);
});

test('concurrent joins reserve exactly ten spots and explicit leave frees one', async t => {
  const f = await fixture(t);
  const host = await f.create();
  const hostClient = await f.connect(host);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.join(host.room, `Person ${i}`)));
  assert.equal(results.filter(r => r.status === 200).length, 9);
  assert.equal(results.filter(r => r.code === 'ROOM_FULL').length, 3);
  const guest = results.find(r => r.status === 200);
  const client = await f.connect(guest);
  client.send({ type: 'leave' });
  await once(client.ws, 'close');
  assert.equal((await f.join(host.room, 'Replacement')).status, 200);
  assert.equal(await upgradeStatus(f.base, host.room, guest.token), 401);
  assert.equal((await hostClient.next('participants', message => message.participants.length === 1)).participants[0].id, host.participantId);
});

test('collaboration mode is explicit and invalid modes cannot create rooms', async t => {
  const f = await fixture(t);
  for (const collaboration of ['unknown', null, 1, {}]) {
    const result = await f.create('Invalid mode', { collaboration });
    assert.equal(result.status, 400);
    assert.equal(result.code, 'INVALID_COLLABORATION');
  }
  const legacy = await f.create('Server mode', { collaboration: 'server' });
  assert.equal(legacy.status, 201);
  assert.deepEqual(Object.keys(legacy.room).sort(), ['createdAt', 'id', 'name']);
});

test('peer rooms keep canvas out of the server while retaining admission and isolated signaling', async t => {
  const f = await fixture(t);
  const auth = await f.create('Peer canvas', { collaboration: 'peer' });
  assert.equal(auth.status, 201);
  assert.equal(auth.room.collaboration, 'peer');
  assert.equal((await f.request(`/api/rooms/${auth.room.id}`)).room.collaboration, 'peer');
  assert.equal((await f.request(`/api/rooms/${auth.room.id}/session`, undefined, { Authorization: `Bearer ${auth.token}` })).room.collaboration, 'peer');
  const host = await f.connect(auth);
  assert.equal(host.init.room.collaboration, 'peer');
  assert.deepEqual(host.init.entities, []);
  const guests = await Promise.all(Array.from({ length: 10 }, (_, i) => f.join(auth.room, `Peer ${i}`)));
  assert.equal(guests.filter(guest => guest.status === 200).length, 9);
  assert.equal(guests.filter(guest => guest.code === 'ROOM_FULL').length, 1);
  const guestAuth = guests.find(guest => guest.status === 200);
  assert.equal(guestAuth.room.collaboration, 'peer');
  const guest = await f.connect(guestAuth);
  const otherAuth = await f.create('Different peer room', { collaboration: 'peer' });
  const other = await f.connect(otherAuth);
  host.send({ type: 'signal', to: guestAuth.participantId, data: { description: { type: 'offer', sdp: 'peer-channel-offer' } } });
  assert.deepEqual(await guest.next('signal'), { type: 'signal', from: auth.participantId, data: { description: { type: 'offer', sdp: 'peer-channel-offer' } } });
  host.send({ type: 'signal', to: otherAuth.participantId, data: { description: { type: 'offer', sdp: 'cannot-cross-rooms' } } });
  assert.equal((await host.next('error')).code, 'INVALID_SIGNAL');
  host.send({ type: 'upsert', entity: entity('must-stay-on-peer') });
  assert.equal((await host.next('error')).code, 'PEER_CANVAS');
  guest.send({ type: 'delete', id: 'must-stay-on-peer' });
  assert.equal((await guest.next('error')).code, 'PEER_CANVAS');
  guest.send({ type: 'ping' });
  await guest.next('pong');
  assert.equal(guest.queue.some(message => ['upsert', 'delete'].includes(message.type)), false);
  assert.equal(other.queue.some(message => message.type === 'signal'), false);
  const saved = JSON.parse(await readFile(path.join(f.directory, 'rooms.json'), 'utf8'));
  assert.equal(saved.rooms.find(room => room.id === auth.room.id).collaboration, 'peer');
  assert.deepEqual(saved.rooms.find(room => room.id === auth.room.id).entities, []);
  assert.equal(JSON.stringify(saved).includes('must-stay-on-peer'), false);
});

test('board, chat, and signaling synchronize within a room and cannot reach another room', async t => {
  const f = await fixture(t);
  const auth = await f.create();
  const guest = await f.join(auth.room);
  const otherAuth = await f.create('Another room');
  const host = await f.connect(auth);
  const peer = await f.connect(guest);
  const other = await f.connect(otherAuth);
  host.send({ type: 'upsert', entity: entity('note-1') });
  const accepted = await host.next('upsert');
  const received = await peer.next('upsert');
  assert.deepEqual(received, accepted);
  assert.equal(received.entity.updatedBy, auth.participantId);
  assert.equal(received.entity.text, 'A shared idea');
  peer.send({ type: 'upsert', entity: entity('note-1', { orderKey: 'a0', locked: true }) });
  const layer = await host.next('upsert');
  assert.equal(layer.entity.orderKey, 'a0');
  assert.equal(layer.entity.locked, true);
  peer.send({ type: 'upsert', entity: entity('note-1', { text: 'A better idea', x: 300 }) });
  assert.equal((await host.next('upsert')).entity.text, 'A better idea');
  host.send({ type: 'cursor', x: 300, y: 200 });
  assert.equal((await peer.next('cursor')).participantId, auth.participantId);
  host.send({ type: 'signal', to: guest.participantId, data: { description: { type: 'offer', sdp: 'test' } } });
  assert.deepEqual((await peer.next('signal')).data, { description: { type: 'offer', sdp: 'test' } });
  host.send({ type: 'signal', to: otherAuth.participantId, data: { secret: 'private' } });
  assert.equal((await host.next('error')).code, 'INVALID_SIGNAL');
  peer.send({ type: 'chat', text: 'Hello team' });
  assert.equal((await host.next('chat')).message.name, 'Sam');
  assert.equal((await peer.next('chat')).message.text, 'Hello team');
  peer.send({ type: 'delete', id: 'note-1' });
  assert.equal((await host.next('delete')).id, 'note-1');
  assert.equal(other.queue.filter(message => ['upsert', 'chat', 'cursor', 'signal', 'delete'].includes(message.type)).length, 0);
});

test('invalid board data is rejected without changing the shared board', async t => {
  const f = await fixture(t);
  const auth = await f.create();
  const client = await f.connect(auth);
  for (const item of [entity('bad', { x: null }), entity('bad', { width: -2 }), entity('bad', { type: 'script' }), entity('bad', { type: 'image', url: 'data:image/svg+xml;base64,PHN2Zz4=' }), entity('bad', { points: [{ x: Infinity, y: 0 }] }), entity('bad', { orderKey: '' }), entity('bad', { orderKey: 'a-0' }), entity('bad', { orderKey: 'a'.repeat(201) }), entity('bad', { locked: 'true' })]) {
    client.send({ type: 'upsert', entity: item });
    assert.equal((await client.next('error')).type, 'error');
  }
  client.send({ type: 'upsert', entity: entity('diagram', { type: 'diagram', source: 'graph TD; A-->B', language: 'mermaid' }) });
  assert.equal((await client.next('upsert')).entity.externalConsent, false);
  const newcomer = await f.connect(await f.join(auth.room));
  assert.deepEqual(newcomer.init.entities.map(item => item.id), ['diagram']);
});

test('screen sharing belongs to its owner and is removed on disconnect', async t => {
  const f = await fixture(t);
  const auth = await f.create();
  const guestAuth = await f.join(auth.room);
  const host = await f.connect(auth);
  const guest = await f.connect(guestAuth);
  guest.send({ type: 'upsert', entity: entity('screen-1', { type: 'screen', participantId: auth.participantId, streamId: 'stream' }) });
  assert.equal((await guest.next('error')).code, 'FORBIDDEN');
  host.send({ type: 'upsert', entity: entity('screen-1', { type: 'screen', participantId: auth.participantId, streamId: 'stream' }) });
  await guest.next('upsert');
  guest.send({ type: 'delete', id: 'screen-1' });
  assert.equal((await guest.next('error')).code, 'FORBIDDEN');
  host.ws.close();
  assert.equal((await guest.next('delete')).id, 'screen-1');
  assert.equal((await guest.next('participants', message => message.participants.length === 1)).participants[0].id, guestAuth.participantId);
});

test('reconnect keeps identity and replacing a tab does not duplicate presence', async t => {
  const f = await fixture(t);
  const auth = await f.create();
  const original = await f.connect(auth);
  const closed = once(original.ws, 'close');
  const replacement = await f.connect(auth);
  assert.equal((await closed)[0], 4001);
  assert.equal(replacement.init.self.id, auth.participantId);
  assert.equal(replacement.init.participants.length, 1);
  replacement.ws.close();
  await once(replacement.ws, 'close');
  const reconnected = await f.connect(auth);
  assert.equal(reconnected.init.self.id, auth.participantId);
});

test('only the host can end a room and end invalidates all session tokens', async t => {
  const f = await fixture(t);
  const auth = await f.create();
  const guestAuth = await f.join(auth.room);
  const host = await f.connect(auth);
  const guest = await f.connect(guestAuth);
  guest.send({ type: 'end' });
  assert.equal((await guest.next('error')).code, 'FORBIDDEN');
  assert.equal((await f.request(`/api/rooms/${auth.room.id}`)).status, 200);
  host.send({ type: 'end' });
  await host.next('ended');
  await guest.next('ended');
  assert.equal((await f.request(`/api/rooms/${auth.room.id}`)).status, 404);
  assert.equal((await f.join(auth.room)).status, 404);
});

test('heartbeat removes ghost participants and their screen entities', async t => {
  const f = await fixture(t, { heartbeatMs: 40 });
  const auth = await f.create();
  const guestAuth = await f.join(auth.room);
  const ghost = await f.connectWithoutPong(auth);
  const guest = await f.connect(guestAuth);
  ghost.send({ type: 'upsert', entity: entity('ghost-screen', { type: 'screen', participantId: auth.participantId, streamId: 'ghost-stream' }) });
  await guest.next('upsert');
  assert.equal((await guest.next('delete')).id, 'ghost-screen');
  assert.deepEqual((await guest.next('participants', message => message.participants.length === 1)).participants.map(p => p.id), [guestAuth.participantId]);
});

test('expired session tokens lose access even when the room continues', async t => {
  const f = await fixture(t, { heartbeatMs: 20, sessionTtl: 100 });
  const auth = await f.create();
  const client = await f.connect(auth);
  const [code] = await once(client.ws, 'close');
  assert.equal(code, 4003);
  assert.equal(await upgradeStatus(f.base, auth.room, auth.token), 401);
  assert.equal((await f.request(`/api/rooms/${auth.room.id}`)).status, 200);
  assert.equal((await f.request(`/api/rooms/${auth.room.id}/session`, undefined, { Authorization: `Bearer ${auth.token}` })).status, 401);
});

test('production serves room deep links, WebAssembly MIME, and rejects file traversal', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'common-static-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Common</title>');
  await writeFile(path.join(directory, 'geometry.wasm'), Buffer.from([0, 97, 115, 109]));
  const f = await fixture(t, { staticDir: directory });
  const room = await fetch(`${f.base}/room/abc123`);
  assert.equal(room.status, 200);
  assert.match(await room.text(), /<title>Common<\/title>/);
  const wasm = await fetch(`${f.base}/geometry.wasm`);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.equal((await wasm.arrayBuffer()).byteLength, 4);
  const traversal = await fetch(`${f.base}/%2e%2e%2fsecret.txt`);
  assert.equal(traversal.status, 403);
  assert.equal((await fetch(`${f.base}/missing.js`)).status, 404);
});

test('TURN credentials require room membership and support expiring HMAC credentials', async t => {
  const keys = ['TURN_URLS', 'TURN_SECRET', 'TURN_TTL_SECONDS', 'TURN_USERNAME', 'TURN_CREDENTIAL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  Object.assign(process.env, { TURN_URLS: 'turn:relay.example:3478,turns:relay.example:5349', TURN_SECRET: 'integration-test-secret', TURN_TTL_SECONDS: '600' });
  const f = await fixture(t);
  const auth = await f.create();
  assert.equal((await f.request('/api/ice')).iceServers.length, 1);
  assert.equal((await f.request(`/api/ice?room=${auth.room.id}`)).status, 401);
  assert.equal((await f.request(`/api/ice?room=${auth.room.id}`, undefined, { Authorization: 'Bearer invalid' })).status, 401);
  const headers = { Authorization: `Bearer ${auth.token}` };
  const response = await f.request(`/api/ice?room=${auth.room.id}`, undefined, headers);
  assert.equal(response.status, 200);
  const relay = response.iceServers[1];
  assert.deepEqual(relay.urls, ['turn:relay.example:3478', 'turns:relay.example:5349']);
  const [expiry, participantId] = relay.username.split(':');
  assert.equal(participantId, auth.participantId);
  assert.ok(Math.abs(Number(expiry) - Math.floor(Date.now() / 1000) - 600) <= 2);
  assert.equal(relay.credential, createHmac('sha1', 'integration-test-secret').update(relay.username).digest('base64'));
  assert.equal(JSON.stringify(response).includes(process.env.TURN_SECRET), false);
  delete process.env.TURN_SECRET;
  process.env.TURN_USERNAME = 'dedicated-test-user';
  process.env.TURN_CREDENTIAL = 'test-relay-password';
  const legacy = await f.request(`/api/ice?room=${auth.room.id}`, undefined, headers);
  assert.equal(legacy.iceServers[1].username, 'dedicated-test-user');
  assert.equal(legacy.iceServers[1].credential, 'test-relay-password');
});

test('board and identity survive server restart while plaintext credentials and screens do not persist', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'common-persist-'));
  const dataFile = path.join(directory, 'rooms.json');
  let app = await createApp({ dataFile });
  let socket;
  t.after(async () => { socket?.terminate(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Persistent', displayName: 'Alex', password: PASSWORD }) });
  const auth = await response.json();
  const peerResponse = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Peer session', displayName: 'Alex', password: PASSWORD, collaboration: 'peer' }) });
  const peerAuth = await peerResponse.json();
  socket = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${auth.room.id}&token=${auth.token}`);
  await once(socket, 'message');
  socket.send(JSON.stringify({ type: 'upsert', entity: entity('saved', { orderKey: 'a0', locked: true }) }));
  let seen = false;
  while (!seen) { const [raw] = await once(socket, 'message'); seen = JSON.parse(raw).type === 'upsert'; }
  socket.send(JSON.stringify({ type: 'upsert', entity: entity('ephemeral', { type: 'screen', participantId: auth.participantId, streamId: 'x' }) }));
  while (true) { const [raw] = await once(socket, 'message'); if (JSON.parse(raw).type === 'upsert') break; }
  await app.close();
  const saved = await readFile(dataFile, 'utf8');
  assert.equal(saved.includes(PASSWORD), false);
  assert.equal(saved.includes(auth.token), false);
  assert.equal(saved.includes('ephemeral'), false);
  assert.equal(JSON.parse(saved).rooms[0].passwordHash.length, 128);
  const savedData = JSON.parse(saved);
  const peerRoom = savedData.rooms.find(room => room.id === peerAuth.room.id);
  assert.equal(peerRoom.collaboration, 'peer');
  assert.deepEqual(peerRoom.entities, []);
  // Even a stale or externally modified peer-room snapshot must not resurrect canvas content.
  peerRoom.entities.push(entity('stale-peer-item'));
  await writeFile(dataFile, JSON.stringify(savedData));
  app = await createApp({ dataFile });
  const restarted = await app.listen(0, '127.0.0.1');
  socket = new WebSocket(`ws://127.0.0.1:${restarted.port}/ws?room=${auth.room.id}&token=${auth.token}`);
  const [raw] = await once(socket, 'message');
  const initial = JSON.parse(raw);
  assert.equal(initial.type, 'init');
  assert.equal(initial.self.id, auth.participantId);
  assert.deepEqual(initial.entities.map(item => item.id), ['saved']);
  assert.equal(initial.entities[0].orderKey, 'a0');
  assert.equal(initial.entities[0].locked, true);
  socket = new WebSocket(`ws://127.0.0.1:${restarted.port}/ws?room=${peerAuth.room.id}&token=${peerAuth.token}`);
  const [peerRaw] = await once(socket, 'message');
  const peerInitial = JSON.parse(peerRaw);
  assert.equal(peerInitial.room.collaboration, 'peer');
  assert.equal(peerInitial.self.id, peerAuth.participantId);
  assert.deepEqual(peerInitial.entities, []);
});
