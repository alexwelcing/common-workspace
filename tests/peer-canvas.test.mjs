import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedCanvas } from '../src/shared-canvas.js';
import { PeerCanvas } from '../src/peer-canvas.js';

const item = (id, fields = {}) => ({ id, type: 'rectangle', x: 20, y: 30, width: 220, height: 130, ...fields });

// Queued transport models reliable ordered data channels, while allowing a
// deliberate loss to exercise the provider's state-vector repair protocol.
function network() {
  const nodes = new Map(); const queue = []; const sent = []; let drop = () => false;
  const add = id => {
    const updates = []; const statuses = []; let provider;
    const model = new SharedCanvas({ onUpdate: (bytes, origin) => { updates.push({ bytes, origin }); provider?.broadcast(bytes, origin); } });
    provider = new PeerCanvas({ model, intervalMs: 60000, onStatus: status => statuses.push(status), send: (to, bytes) => {
      const message = { from: id, to, bytes: bytes.slice() }; sent.push(message);
      if (!drop(message)) queue.push(message);
      return true;
    } });
    const node = { id, model, provider, updates, statuses }; nodes.set(id, node); return node;
  };
  return {
    add, sent, queue,
    dropWhen: predicate => { drop = predicate; },
    connect(a, b) { a.provider.open(b.id); b.provider.open(a.id); },
    flush() {
      let delivered = 0;
      while (queue.length) {
        assert.ok(++delivered < 100, 'canvas sync produced an echo loop');
        const message = queue.shift();
        nodes.get(message.to)?.provider.receive(message.from, message.bytes);
      }
      return delivered;
    },
    destroy() { for (const { model, provider } of nodes.values()) { provider.destroy(); model.destroy(); } },
  };
}

test('opening both peers exchanges initial state and an edit propagates without an echo', () => {
  const net = network();
  try {
    const a = net.add('a'); const b = net.add('b');
    a.model.replaceInitial([item('shared')]);
    net.connect(a, b); net.flush();
    assert.deepEqual(a.model.all(), b.model.all());
    assert.equal(b.updates.length, 1);
    assert.deepEqual(b.updates[0].origin, { peerId: 'a' });
    const sentBefore = net.sent.length;
    a.model.patch('shared', { text: 'Team discussion', width: 450 }); net.flush();
    assert.equal(b.model.get('shared').text, 'Team discussion');
    assert.equal(b.model.get('shared').width, 450);
    assert.equal(net.sent.length - sentBefore, 1, 'receiver must not echo an update to its sender');
    assert.equal(net.queue.length, 0);
  } finally { net.destroy(); }
});

test('state-vector anti-entropy recovers a deliberately dropped live update', () => {
  const net = network();
  try {
    const a = net.add('a'); const b = net.add('b');
    a.model.setLocal(item('shared')); net.connect(a, b); net.flush();
    let dropped = false;
    net.dropWhen(message => {
      if (!dropped && message.from === 'a' && message.to === 'b' && message.bytes[0] === 2) { dropped = true; return true; }
      return false;
    });
    a.model.patch('shared', { x: 800, y: 400 }); net.flush();
    assert.equal(dropped, true); assert.equal(b.model.get('shared').x, 20);
    net.dropWhen(() => false);
    // The periodic timer invokes this exact state-vector request path.
    assert.equal(b.provider.requestSync('a'), true); net.flush();
    assert.equal(b.model.get('shared').x, 800);
    assert.deepEqual(a.model.all(), b.model.all());
    assert.equal(net.sent.at(-2).bytes[0], 1);
    assert.equal(net.sent.at(-1).bytes[0], 2);
  } finally { net.destroy(); }
});

test('a late peer receives shared ordering and locks from existing browser state', () => {
  const net = network();
  try {
    const a = net.add('a'); const b = net.add('b');
    a.model.replaceInitial(['one', 'two', 'three'].map((id, z) => item(id, { z })));
    net.connect(a, b); net.flush();
    a.model.reorder('one', 'front'); b.model.patch('two', { locked: true }); net.flush();
    const late = net.add('late'); net.connect(late, b); net.flush();
    assert.deepEqual(late.model.getOrder(), ['two', 'three', 'one']);
    assert.equal(late.model.get('two').locked, true);
    assert.deepEqual(a.model.all(), late.model.all());
    late.model.patch('three', { x: 650 }); net.flush();
    assert.equal(a.model.get('three').x, 650, 'an intermediary peer relays updates to its other connected peers');
    assert.deepEqual(a.model.all(), late.model.all());
  } finally { net.destroy(); }
});

test('closed or unknown peer IDs and malformed payloads cannot mutate canvas state', () => {
  const net = network();
  try {
    const a = net.add('a'); const b = net.add('b');
    a.model.setLocal(item('shared'));
    const update = a.model.encodeState();
    const valid = new Uint8Array(update.byteLength + 1); valid[0] = 2; valid.set(update, 1);
    assert.equal(b.provider.receive('unknown', valid), false);
    assert.equal(b.model.get('shared'), undefined);
    b.provider.open('a'); b.provider.close('a');
    assert.equal(b.provider.receive('a', valid), false);
    b.provider.open('a');
    assert.equal(b.provider.receive('a', 'not bytes'), false);
    assert.equal(b.provider.receive('a', new Uint8Array()), false);
    assert.equal(b.provider.receive('a', new Uint8Array([2])), false);
    assert.equal(b.provider.receive('a', new Uint8Array([99, 0])), false);
    assert.equal(b.provider.receive('a', new Uint8Array([1, 255])), false);
    assert.equal(b.provider.receive('a', new Uint8Array([2, 255])), false);
    assert.equal(b.provider.receive('a', new Uint8Array(24 * 1024 * 1024 + 1)), false);
    const longVector = new Uint8Array(65537); longVector[0] = 1;
    assert.equal(b.provider.receive('a', longVector), false);
    assert.equal(b.model.get('shared'), undefined);
    assert.ok(b.statuses.some(status => status.includes('could not be read')));
    b.provider.destroy();
    assert.equal(b.provider.receive('a', valid), false);
    assert.equal(b.provider.requestSync('a'), false);
    b.provider.open('a'); assert.equal(b.provider.peers.size, 0);
  } finally { net.destroy(); }
});
