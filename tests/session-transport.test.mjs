import test from 'node:test';
import assert from 'node:assert/strict';
import { PollingSessionTransport } from '../src/session-transport.js';

const init = { type: 'init', room: { id: 'room', collaboration: 'peer' }, self: { id: 'host' }, participants: [{ id: 'host' }], entities: [], chat: [] };
const response = (data, status = 200) => Response.json(data, { status });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await Promise.resolve(); }
  assert.ok(predicate(), 'asynchronous transport work did not settle');
}

function fixture(handler = () => undefined, { hidden = false, ...transportOptions } = {}) {
  const requests = []; const timers = new Map(); let timerId = 0; let time = 0;
  const document = new EventTarget(); document.hidden = hidden;
  const transport = new PollingSessionTransport({
    ...transportOptions,
    room: 'room', token: 'room-access-token', documentImpl: document, random: () => 0.5, now: () => time,
    setTimeoutImpl: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeoutImpl: id => timers.delete(id),
    fetchImpl: async (url, options) => {
      const request = { url, options, body: options.body && JSON.parse(options.body) }; requests.push(request);
      const result = handler(request);
      if (result !== undefined) return result;
      if (url.endsWith('/connect')) return response({ init, cursor: '7', connectionId: 'connection-one' });
      if (url.includes('/events?')) return response({ events: [], cursor: '7', participants: init.participants });
      return response({ ok: true });
    },
  });
  return {
    transport, requests, timers, document,
    async open() { await until(() => transport.readyState === PollingSessionTransport.OPEN); },
    async run(delay) {
      const match = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(match, `no scheduled ${delay}ms timer`);
      timers.delete(match[0]); time += delay; await match[1].fn();
    },
    advance(ms) { time += ms; },
    destroy() { transport.close(); },
  };
}

test('polling opens before init, authenticates requests, and advances the server cursor', async () => {
  let polls = 0;
  const f = fixture(request => {
    if (request.url.includes('/events?')) {
      polls++;
      return response({ events: polls === 1 ? [{ sequence: '8', message: { type: 'signal', from: 'guest', data: { description: { type: 'offer' } } } }] : [], cursor: polls === 1 ? '12' : '13', participants: [{ id: 'host' }, { id: 'guest' }] });
    }
  });
  const events = []; const messages = [];
  f.transport.onopen = () => events.push('open');
  f.transport.onmessage = event => { const message = JSON.parse(event.data); events.push(message.type); messages.push(message); };
  try {
    await f.open();
    assert.deepEqual(events, ['open', 'init']);
    await f.run(1000); await f.run(1000);
    assert.deepEqual(events, ['open', 'init', 'signal', 'participants']);
    assert.equal(messages[1].from, 'guest');
    assert.equal(f.requests[1].url, '/api/rooms/room/events?after=7');
    assert.equal(f.requests[2].url, '/api/rooms/room/events?after=12');
    assert.equal(f.requests[0].options.headers.Authorization, 'Bearer room-access-token');
    assert.equal(f.requests[1].options.headers['X-Common-Connection'], 'connection-one');
    assert.ok(f.requests.every(request => !request.url.includes('room-access-token')));
  } finally { f.destroy(); }
});

test('signaling POSTs are serialized and preserve their original order', async () => {
  const firstPost = deferred(); let posts = 0;
  const f = fixture(request => {
    if (request.url.endsWith('/messages') && ++posts === 1) return firstPost.promise;
  });
  assert.throws(() => f.transport.send('{}'), { name: 'InvalidStateError' });
  try {
    await f.open();
    f.transport.send(JSON.stringify({ type: 'signal', to: 'guest', data: { order: 1 } }));
    f.transport.send(JSON.stringify({ type: 'signal', to: 'guest', data: { order: 2 } }));
    await until(() => posts === 1);
    assert.equal(f.requests.filter(request => request.url.endsWith('/messages')).length, 1);
    firstPost.resolve(response({ ok: true }));
    await until(() => posts === 2);
    assert.deepEqual(f.requests.filter(request => request.url.endsWith('/messages')).map(request => request.body.data.order), [1, 2]);
  } finally { f.destroy(); }
});

test('cursor activity coalesces to one request per second and leave survives navigation', async () => {
  const f = fixture();
  try {
    await f.open();
    for (let x = 0; x < 30; x++) f.transport.send(JSON.stringify({ type: 'cursor', x, y: 4 }));
    assert.equal(f.requests.filter(request => request.url.endsWith('/messages')).length, 0);
    // The other one-second timer is the first poll.
    await f.run(1000); await f.run(1000);
    await until(() => f.requests.some(request => request.url.endsWith('/messages')));
    assert.deepEqual(f.requests.find(request => request.url.endsWith('/messages')).body, { type: 'cursor', x: 29, y: 4 });
    f.transport.send(JSON.stringify({ type: 'leave' }));
    const leave = f.requests.at(-1);
    assert.equal(leave.url, '/api/rooms/room/leave');
    assert.equal(leave.options.keepalive, true);
    assert.equal(leave.options.headers['X-Common-Connection'], 'connection-one');
    assert.equal(f.transport.readyState, PollingSessionTransport.CLOSED);
    assert.equal(f.timers.size, 0);
    assert.throws(() => f.transport.send('{}'), { name: 'InvalidStateError' });
  } finally { f.destroy(); }
});

test('temporary polling errors back off without replaying or advancing events', async () => {
  let polls = 0;
  const f = fixture(request => {
    if (request.url.includes('/events?') && ++polls <= 2) throw new TypeError('Network disconnected');
  });
  try {
    await f.open(); await f.run(1000);
    assert.equal(f.transport.readyState, PollingSessionTransport.OPEN);
    await f.run(2000); await f.run(4000);
    assert.equal(polls, 3);
    assert.ok(f.requests.filter(request => request.url.includes('/events?')).every(request => request.url.endsWith('after=7')));
    assert.ok([...f.timers.values()].some(timer => timer.delay === 1000), 'successful poll restores the normal cadence');
  } finally { f.destroy(); }
});

test('closing for a reload preserves the room token instead of revoking access', async () => {
  const f = fixture();
  await f.open();
  f.transport.close();
  assert.equal(f.transport.readyState, PollingSessionTransport.CLOSED);
  assert.equal(f.requests.filter(request => request.url.endsWith('/leave')).length, 0);
  assert.equal(f.timers.size, 0);
});

test('expired access, capacity, replaced connection and cursor gaps use reconnect-compatible codes', async () => {
  for (const [status, errorCode, closeCode] of [[401, 'SESSION_EXPIRED', 4001], [404, 'ROOM_NOT_FOUND', 4004], [409, 'ROOM_FULL', 1008], [409, 'CONNECTION_REPLACED', 4003], [409, 'RESYNC_REQUIRED', 1012]]) {
    const f = fixture(request => request.url.includes('/events?') ? response({ error: errorCode, code: errorCode }, status) : undefined);
    let closed;
    f.transport.onclose = event => { closed = event; };
    try { await f.open(); await f.run(1000); assert.equal(closed.code, closeCode, errorCode); assert.equal(f.timers.size, 0); }
    finally { f.destroy(); }
  }
});

test('ambiguous POST failures are never retried and queued messages are abandoned', async () => {
  const f = fixture(request => { if (request.url.endsWith('/messages')) throw new TypeError('Response lost'); });
  let closed;
  f.transport.onclose = event => { closed = event; };
  try {
    await f.open();
    f.transport.send(JSON.stringify({ type: 'chat', text: 'Only once' }));
    f.transport.send(JSON.stringify({ type: 'signal', to: 'guest', data: { next: true } }));
    await until(() => closed);
    await f.transport._sendChain;
    assert.equal(closed.code, 1006);
    assert.equal(f.requests.filter(request => request.url.endsWith('/messages')).length, 1);
  } finally { f.destroy(); }
});

test('a departed signaling recipient does not disconnect the remaining peers', async () => {
  let posts = 0; const messages = [];
  const f = fixture(request => {
    if (request.url.endsWith('/messages') && ++posts === 1) return response({ error: 'Signal recipient is unavailable.', code: 'INVALID_SIGNAL' }, 400);
  });
  f.transport.onmessage = event => messages.push(JSON.parse(event.data));
  try {
    await f.open();
    f.transport.send(JSON.stringify({ type: 'signal', to: 'departed', data: {} }));
    f.transport.send(JSON.stringify({ type: 'chat', text: 'Still connected' }));
    await until(() => posts === 2);
    assert.equal(f.transport.readyState, PollingSessionTransport.OPEN);
    assert.equal(messages.at(-1).code, 'INVALID_SIGNAL');
  } finally { f.destroy(); }
});

test('background polling renews leases every 15 seconds and foregrounding polls immediately', async () => {
  const f = fixture(undefined, { hidden: true });
  try {
    await f.open(); await f.run(15000);
    f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'));
    await f.run(0);
    assert.equal(f.requests.filter(request => request.url.includes('/events?')).length, 2);
    assert.ok([...f.timers.values()].some(timer => timer.delay === 1000));
  } finally { f.destroy(); }
});

test('ending a room delivers the final envelope and stops polling', async () => {
  const f = fixture(request => request.url.includes('/events?') ? response({ events: [{ sequence: '8', message: { type: 'ended' } }], cursor: '8' }) : undefined);
  const events = [];
  f.transport.onmessage = event => events.push(JSON.parse(event.data).type);
  f.transport.onclose = event => events.push(event.code);
  try {
    await f.open(); await f.run(1000);
    assert.deepEqual(events, ['init', 'ended', 1000]);
    assert.equal(f.timers.size, 0);
  } finally { f.destroy(); }
});

test('linked peers poll slowly when quiet and speed up again for room activity', async () => {
  let pending = [];
  const f = fixture(request => {
    if (request.url.includes('/events?')) { const events = pending; pending = []; return response({ events, cursor: '7', participants: init.participants }); }
  });
  try {
    await f.open();
    await f.run(1000);
    f.transport.setIdle(true);
    f.advance(10000);
    await f.run(1000);
    await f.run(3000);
    pending = [{ sequence: '8', message: { type: 'chat', message: { text: 'hi' } } }];
    await f.run(3000);
    await f.run(1000);
    f.advance(10000);
    await f.run(1000);
    f.transport.send(JSON.stringify({ type: 'chat', text: 'hello' }));
    await f.run(3000);
    await f.run(1000);
    f.transport.setIdle(false);
    assert.ok([...f.timers.values()].some(timer => timer.delay === 0));
  } finally { f.destroy(); }
});

test('versioned polling retains an omitted roster, suppresses replay, and immediately drains batches', async () => {
  let polls = 0; const delivered = [];
  const f = fixture(request => {
    if (request.url.endsWith('/connect')) return response({ init, cursor: '7', connectionId: 'connection-one', rosterVersion: '2', capabilities: { targetedEvents: true } });
    if (request.url.includes('/events?')) {
      polls++;
      return response(polls === 1 ? { events: [{ sequence: '8', message: { type: 'chat', message: { text: 'one' } } }], cursor: '8', hasMore: true, rosterVersion: '2' }
        : { events: [{ sequence: '8', message: { type: 'chat', message: { text: 'replayed' } } }, { sequence: '11', message: { type: 'chat', message: { text: 'two' } } }], cursor: '15', hasMore: false, rosterVersion: '2' });
    }
  });
  f.transport.onmessage = event => delivered.push(JSON.parse(event.data));
  try {
    await f.open(); await f.run(1000); await f.run(0);
    assert.match(f.requests[1].url, /after=7&delivery=targeted-v1&rosterVersion=2$/);
    assert.match(f.requests[2].url, /after=8&delivery=targeted-v1&rosterVersion=2$/);
    assert.deepEqual(delivered.map(message => message.type), ['init', 'chat', 'chat']);
    assert.deepEqual(delivered.slice(1).map(message => message.message.text), ['one', 'two']);
    assert.equal(f.transport._participants, JSON.stringify(init.participants));
  } finally { f.destroy(); }
});

test('capability-negotiated signal retries reuse one request ID and preserve the send queue', async () => {
  let posts = 0;
  const f = fixture(request => {
    if (request.url.endsWith('/connect')) return response({ init, cursor: '7', connectionId: 'connection-one', capabilities: { signalIdempotency: true } });
    if (request.url.endsWith('/messages') && ++posts === 1) throw new TypeError('Accepted response was lost');
  });
  try {
    await f.open();
    f.transport.send(JSON.stringify({ type: 'signal', to: 'guest', data: { order: 1 } }));
    f.transport.send(JSON.stringify({ type: 'signal', to: 'guest', data: { order: 2 } }));
    await f.transport._sendChain;
    const sends = f.requests.filter(request => request.url.endsWith('/messages')).map(request => request.body);
    assert.equal(sends.length, 3);
    assert.equal(sends[0].requestId, sends[1].requestId);
    assert.notEqual(sends[1].requestId, sends[2].requestId);
    assert.deepEqual(sends.map(send => send.data.order), [1, 1, 2]);
    assert.equal(f.transport.getDiagnostics().postRetries, 1);
    assert.equal(f.transport.readyState, PollingSessionTransport.OPEN);
  } finally { f.destroy(); }
});

test('signal retries are bounded and chat still never retries an ambiguous POST', async () => {
  for (const type of ['signal', 'chat']) {
    const f = fixture(request => {
      if (request.url.endsWith('/connect')) return response({ init, cursor: '7', connectionId: 'connection-one', capabilities: { signalIdempotency: true } });
      if (request.url.endsWith('/messages')) return response({ error: 'Temporary outage' }, 503);
    });
    try {
      await f.open();
      f.transport.send(JSON.stringify(type === 'signal' ? { type, to: 'guest', data: {} } : { type, text: 'Only once' }));
      await f.transport._sendChain;
      assert.equal(f.requests.filter(request => request.url.endsWith('/messages')).length, type === 'signal' ? 3 : 1);
      assert.equal(f.transport.readyState, PollingSessionTransport.CLOSED);
    } finally { f.destroy(); }
  }
});

test('transport diagnostics contain only bounded counters and lifecycle states', async () => {
  const diagnostics = []; const pending = deferred();
  const f = fixture(request => request.url.endsWith('/messages') ? pending.promise : undefined,
    { onDiagnostic: (type, values) => diagnostics.push({ type, values }) });
  try {
    await f.open();
    f.transport.send(JSON.stringify({ type: 'signal', to: 'private-person', data: { secret: 'private SDP' } }));
    f.advance(250);
    assert.equal(f.transport.diagnostics().queuedMessages, 1);
    assert.equal(f.transport.diagnostics().queueAgeMs, 250);
    pending.resolve(response({ ok: true })); await f.transport._sendChain;
    await f.run(1000);
    assert.equal(f.transport.diagnostics().pollCount, 1);
    assert.equal(f.transport.diagnostics().queuedMessages, 0);
    const serialized = JSON.stringify(diagnostics);
    for (const secret of ['private-person', 'private SDP', 'room-access-token', 'connection-one']) assert.equal(serialized.includes(secret), false);
    assert.ok(diagnostics.every(entry => ['poll', 'queue', 'connection'].includes(entry.type)));
    assert.ok(diagnostics.every(entry => Object.values(entry.values).every(value => typeof value === 'number' || ['connecting', 'connected', 'disconnected'].includes(value))));
  } finally { pending.resolve(response({ ok: true })); f.destroy(); }
});
