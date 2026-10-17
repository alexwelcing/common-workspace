import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { SharedCanvas } from '../src/shared-canvas.js';
import { PeerCanvas } from '../src/peer-canvas.js';
import { canvasNeighbors, MAX_CANVAS_NEIGHBORS } from '../src/peer-topology.js';

const item = (id, fields = {}) => ({ id, type: 'rectangle', x: 20, y: 30, width: 220, height: 130, ...fields });

// Queued transport models reliable ordered data channels, while allowing a
// deliberate loss to exercise the provider's state-vector repair protocol.
function network() {
  const nodes = new Map(); const queue = []; const sent = []; let drop = () => false;
  const add = id => {
    const updates = []; const statuses = []; const invalid = []; const deleted = []; let provider;
    const model = new SharedCanvas({ onInvalid: error => invalid.push(error.message), onDelete: id => deleted.push(id), onUpdate: (bytes, origin) => { updates.push({ bytes, origin }); provider?.broadcast(bytes, origin); } });
    provider = new PeerCanvas({ model, intervalMs: 60000, onStatus: status => statuses.push(status), send: (to, bytes) => {
      const message = { from: id, to, bytes: bytes.slice() }; sent.push(message);
      if (!drop(message)) queue.push(message);
      return true;
    } });
    const node = { id, model, provider, updates, statuses, invalid, deleted }; nodes.set(id, node); return node;
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

test('a lost predecessor cannot hide a valid resized item while state-vector recovery fills Yjs dependencies', () => {
  const net = network();
  try {
    const a = net.add('a'); const b = net.add('b');
    a.model.replaceInitial([item('prior'), item('resized')]);
    net.connect(a, b); net.flush();
    const previous = b.model.get('resized'); let dropped = false;
    net.dropWhen(message => {
      if (!dropped && message.from === 'a' && message.to === 'b' && message.bytes[0] === 2) {
        dropped = true; return true;
      }
      return false;
    });
    assert.equal(a.model.patch('prior', { x: 50 }), true);
    assert.equal(a.model.patch('resized', { width: 640, height: 360 }), true);
    net.flush();
    assert.equal(dropped, true);
    // Yjs integrates a later packet's delete-set immediately, while its new
    // width/height structs await the missing predecessor. An incomplete map
    // during that bounded repair interval is not a malformed authored item.
    assert.deepEqual(b.model.get('resized'), previous, 'keep the last complete view while replacement fields are pending');
    assert.deepEqual(b.model.all().find(entity => entity.id === 'resized'), previous);
    assert.deepEqual(b.deleted, [], 'dependency gaps must not emit a false canvas deletion');
    assert.deepEqual(b.invalid, [], 'valid but causally incomplete packets must not produce malformed-item errors');
    assert.deepEqual(b.statuses, []);

    net.dropWhen(() => false);
    assert.equal(b.provider.requestSync(a.id), true); net.flush();
    assert.equal(b.model.get('resized').width, 640);
    assert.equal(b.model.get('resized').height, 360);
    assert.equal(b.model.get('prior').x, 50);
    assert.deepEqual(b.model.all(), a.model.all());
    assert.deepEqual(b.model.encodeStateVector(), a.model.encodeStateVector());
    assert.deepEqual(b.deleted, []); assert.deepEqual(b.invalid, []); assert.deepEqual(b.statuses, []);
    // A real deletion still removes the cached view once it arrives.
    assert.equal(a.model.deleteLocal('resized'), true); net.flush();
    assert.equal(b.model.get('resized'), undefined);
    assert.deepEqual(b.deleted, ['resized']);
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

// These are simulated network participants, not browser instances. Every one
// owns a real Y.Doc and uses the production provider's packet encoding, relay,
// state-vector exchange and SharedCanvas mutation paths. No document updates
// are copied directly between models by the transport or its assertions.
function sparseNetwork(count = 100) {
  const nodes = new Map(); let members = new Set(); let queue = []; let queueCursor = 0; let shouldDrop = () => false;
  const errors = []; const stats = { sent: 0, delivered: 0, dropped: 0, vectors: 0, maxDegree: 0, peakQueued: 0, maxFlush: 0 };
  const add = id => {
    assert.equal(nodes.has(id), false, 'each simulated participant owns a distinct document');
    let provider;
    const model = new SharedCanvas({
      clientId: nodes.size + 1,
      onUpdate: (bytes, origin) => provider?.broadcast(bytes, origin),
      onInvalid: error => errors.push(error.message),
    });
    assert.ok(model.doc instanceof Y.Doc);
    provider = new PeerCanvas({ model, intervalMs: 3600000, onStatus: status => errors.push(status), send: (to, bytes) => {
      assert.ok(provider.peers.has(to), 'packets must use an open sparse-topology edge');
      assert.ok(provider.peers.size <= MAX_CANVAS_NEIGHBORS, 'a participant must never create a full mesh');
      if (!members.has(id) || !members.has(to)) return false;
      const message = { from: id, to, bytes: bytes.slice() };
      stats.sent += 1;
      if (bytes[0] === 1) stats.vectors += 1;
      if (shouldDrop(message)) { stats.dropped += 1; return true; }
      queue.push(message); stats.peakQueued = Math.max(stats.peakQueued, queue.length - queueCursor); return true;
    } });
    const node = { id, model, provider }; nodes.set(id, node); return node;
  };
  const ids = Array.from({ length: count }, (_, index) => `participant-${String(index).padStart(4, '0')}`);
  ids.forEach(add);
  return {
    ids, nodes, stats, add,
    dropWhen(predicate) { shouldDrop = predicate; },
    membership(ids) {
      members = new Set(ids);
      const neighbors = new Map([...nodes].map(([id]) => [id, new Set(canvasNeighbors(ids, id))]));
      // Close obsolete edges everywhere before opening replacement edges.
      for (const [id, node] of nodes) for (const peerId of node.provider.peers) {
        if (!neighbors.get(id).has(peerId)) node.provider.close(peerId);
      }
      for (const [id, node] of nodes) for (const peerId of neighbors.get(id)) {
        assert.ok(neighbors.get(peerId)?.has(id), 'the production topology must be symmetric');
        if (!node.provider.peers.has(peerId)) node.provider.open(peerId);
      }
      for (const [id, { provider }] of nodes) {
        assert.ok(provider.peers.size <= MAX_CANVAS_NEIGHBORS);
        assert.equal(provider.peers.size, neighbors.get(id).size);
        stats.maxDegree = Math.max(stats.maxDegree, provider.peers.size);
      }
    },
    active() { return [...members].map(id => nodes.get(id)); },
    flush({ reverse = false } = {}) {
      if (reverse) {
        // Vary delivery between links while preserving reliable data-channel
        // FIFO ordering within each directed link.
        const links = new Map();
        for (const message of queue) {
          const key = `${message.from}:${message.to}`;
          if (!links.has(key)) links.set(key, []);
          links.get(key).push(message);
        }
        queue = [...links.values()].reverse().flat();
      }
      // Bound work even if a regression accidentally introduces a relay loop.
      while (queueCursor < queue.length) {
        assert.ok(queueCursor < 300000, 'sparse canvas packet delivery did not settle within its bounded budget');
        const { from, to, bytes } = queue[queueCursor++];
        if (members.has(from) && members.has(to)) {
          nodes.get(to).provider.receive(from, bytes); stats.delivered += 1;
        }
      }
      const delivered = queueCursor;
      stats.maxFlush = Math.max(stats.maxFlush, delivered);
      queue = []; queueCursor = 0;
      assert.deepEqual(errors, [], 'valid simulated traffic must not produce decoding or validation errors');
      return delivered;
    },
    assertConverged() {
      const active = this.active(); assert.ok(active.length >= 100, 'the convergence check must cover at least 100 participants');
      const reference = active[0].model;
      const expectedItems = reference.all();
      const clocks = model => [...Y.decodeStateVector(model.encodeStateVector())].sort(([a], [b]) => a - b);
      const expectedClocks = clocks(reference);
      const expectedTombstones = [...reference.tombstones.keys()].sort();
      for (const { id, model } of active) {
        assert.deepEqual(model.all(), expectedItems, `${id} must agree on every visible field and layer`);
        assert.deepEqual(clocks(model), expectedClocks, `${id} must possess the same Yjs struct clocks`);
        assert.deepEqual([...model.tombstones.keys()].sort(), expectedTombstones, `${id} must agree on delete tombstones`);
      }
      assert.ok(stats.maxDegree <= 6, 'per-participant transport fanout stays bounded independently of room size');
      assert.ok(stats.maxDegree < active.length - 1, 'the simulated room must not use a full mesh');
      return expectedItems;
    },
    destroy() { for (const { model, provider } of nodes.values()) { provider.destroy(); model.destroy(); } },
  };
}

test('100 simulated Yjs participants converge concurrent edits, inserts, deletes and layer moves over sparse links', { timeout: 20000 }, t => {
  const net = sparseNetwork();
  try {
    const peers = [...net.nodes.values()];
    assert.equal(peers[0].model.replaceInitial([
      item('shared-fields'),
      ...peers.map((_, index) => item(`shape-${index}`)),
    ]), true);
    net.membership(net.ids); net.flush(); net.assertConverged();
    const originalLayers = new Map(peers[0].model.all().map(entity => [entity.id, entity.orderKey]));

    // Queue all local operations before delivering any, so these writes are
    // genuinely concurrent rather than a sequence of already-synchronized edits.
    peers.forEach(({ model }, index) => {
      assert.equal(model.patch(`shape-${index}`, { x: 1000 + index, text: `edited by ${index}` }), true);
      if (index % 10 === 0) assert.equal(model.setLocal(item(`new-${index}`, { type: 'sticky', text: `note ${index}` })), true);
      if (index < 10) assert.equal(model.deleteLocal(`shape-${90 + index}`), true);
      if (index >= 20 && index < 40) assert.equal(model.reorder(`shape-${index}`, index % 2 ? 'front' : 'back'), true);
    });
    assert.equal(peers[10].model.patch('shared-fields', { x: 420, y: 240 }), true);
    assert.equal(peers[11].model.patch('shared-fields', { width: 640, height: 360 }), true);
    assert.equal(peers[12].model.patch('shared-fields', { text: 'Concurrent text survives geometry and layer edits' }), true);
    assert.equal(peers[13].model.patch('shared-fields', { locked: true }), true);
    assert.equal(peers[14].model.reorder('shared-fields', 'back'), true);
    assert.equal(peers[15].model.patch('shared-fields', { fill: '#10b981' }), true);
    assert.equal(peers[16].model.patch('shared-fields', { fill: '#f59e0b' }), true);
    assert.notDeepEqual(peers[0].model.all(), peers[1].model.all(), 'the simulation must contain divergent documents before delivery');
    net.flush({ reverse: true });
    const result = net.assertConverged();
    assert.equal(result.length, 101);
    assert.deepEqual(peers[0].model.get('shared-fields'), {
      ...peers[0].model.get('shared-fields'), x: 420, y: 240, width: 640, height: 360,
      text: 'Concurrent text survives geometry and layer edits', locked: true,
    });
    assert.ok(['#10b981', '#f59e0b'].includes(peers[0].model.get('shared-fields').fill), 'a same-field conflict must converge to an authored value');
    for (let index = 0; index < 90; index += 1) {
      assert.equal(peers[0].model.get(`shape-${index}`).x, 1000 + index);
      assert.equal(peers[0].model.get(`shape-${index}`).text, `edited by ${index}`);
    }
    for (let index = 90; index < 100; index += 1) {
      assert.equal(peers[0].model.get(`shape-${index}`), undefined, 'deletion wins over the concurrent stale edit');
      assert.equal(peers[index].model.setLocal(item(`shape-${index}`)), false, 'deleted IDs cannot be resurrected');
    }
    for (let index = 0; index < 100; index += 10) assert.equal(peers[0].model.get(`new-${index}`).text, `note ${index}`);
    for (let index = 20; index < 40; index += 1) {
      assert.notEqual(peers[0].model.get(`shape-${index}`).orderKey, originalLayers.get(`shape-${index}`), 'each concurrent layer move must survive convergence');
    }
    assert.notEqual(peers[0].model.get('shared-fields').orderKey, originalLayers.get('shared-fields'));
    const order = peers[0].model.getOrder();
    assert.ok(order.indexOf('shared-fields') < order.indexOf('shape-0'), 'the shared item moves behind unchanged layers while retaining concurrent geometry and text');
    t.diagnostic(`100 real Yjs documents; ${JSON.stringify(net.stats)}`);
  } finally { net.destroy(); }
});

test('100 simulated Yjs participants recover dropped updates and deletes through state-vector anti-entropy', { timeout: 20000 }, t => {
  const net = sparseNetwork();
  try {
    const peers = [...net.nodes.values()]; const origin = peers[0];
    origin.model.replaceInitial([item('delete-during-loss'), ...peers.map((_, index) => item(`shape-${index}`))]);
    net.membership(net.ids); net.flush();

    // Drop every outgoing update from one participant. Multiple redundant
    // routes cannot accidentally mask the loss: its local changes are stranded.
    net.dropWhen(({ from, bytes }) => from === origin.id && bytes[0] === 2);
    assert.equal(origin.model.setLocal(item('lost-insert', { text: 'initial text' })), true);
    assert.equal(origin.model.patch('lost-insert', { text: 'second dependent update', x: 875 }), true);
    assert.equal(origin.model.deleteLocal('delete-during-loss'), true);
    peers.slice(1).forEach(({ model }, index) => assert.equal(model.patch(`shape-${index + 1}`, { x: 2000 + index }), true));
    assert.equal(peers[40].model.patch('delete-during-loss', { text: 'stale in-flight edit' }), true);
    net.flush();
    assert.ok(net.stats.dropped >= origin.provider.peers.size * 3, 'the transport actually dropped all three local updates');
    for (const { model } of peers.slice(1)) {
      assert.equal(model.get('lost-insert'), undefined, 'the lost insert must still be absent before repair');
      assert.ok(model.get('delete-during-loss'), 'the lost delete must still be absent before repair');
    }

    net.dropWhen(() => false);
    const neighbor = net.nodes.get([...origin.provider.peers][0]);
    const vectorsBefore = net.stats.vectors;
    // This is the same public request used by the provider's periodic timer.
    assert.equal(neighbor.provider.requestSync(origin.id), true);
    net.flush(); net.assertConverged();
    assert.ok(net.stats.vectors > vectorsBefore, 'recovery must issue a real state-vector packet');
    for (const { model } of peers) {
      assert.equal(model.get('lost-insert').text, 'second dependent update');
      assert.equal(model.get('lost-insert').x, 875);
      assert.equal(model.get('delete-during-loss'), undefined, 'anti-entropy recovers delete tombstones as well as inserted fields');
      assert.equal(model.get('shape-99').x, 2098);
    }
    t.diagnostic(`100 real Yjs documents; ${JSON.stringify(net.stats)}`);
  } finally { net.destroy(); }
});

test('100 active simulated participants retain canvas state across fresh joins, leaves and offline rejoin churn', { timeout: 20000 }, t => {
  const net = sparseNetwork();
  try {
    const first = net.nodes.get(net.ids[0]);
    first.model.replaceInitial([item('shared'), item('deleted-while-away'), item('front'), item('back')]);
    net.membership(net.ids); net.flush(); net.assertConverged();

    const away = net.ids.slice(90);
    const stay = net.ids.slice(0, 90);
    net.membership(stay); net.flush();
    away.forEach((id, index) => {
      const { model, provider } = net.nodes.get(id);
      assert.equal(provider.peers.size, 0, 'departed participants must close every data edge');
      assert.equal(model.setLocal(item(`offline-${index}`, { text: `created offline by ${id}` })), true);
      assert.equal(model.patch('deleted-while-away', { text: `stale offline edit ${index}` }), true);
    });
    assert.equal(first.model.deleteLocal('deleted-while-away'), true);
    assert.equal(first.model.patch('shared', { text: 'edited while others were away', locked: true }), true);
    assert.equal(first.model.reorder('front', 'front'), true);
    stay.slice(1, 11).forEach((id, index) => assert.equal(net.nodes.get(id).model.setLocal(item(`online-${index}`)), true));
    net.flush();

    const fresh = Array.from({ length: 10 }, (_, index) => `fresh-${String(index).padStart(4, '0')}`);
    fresh.forEach(net.add);
    net.membership([...stay, ...fresh]); net.flush(); net.assertConverged();
    for (const id of fresh) {
      const { model } = net.nodes.get(id);
      assert.equal(model.get('shared').text, 'edited while others were away');
      assert.equal(model.get('shared').locked, true);
      assert.equal(model.getOrder().at(-1), 'online-9');
      assert.equal(model.get('deleted-while-away'), undefined);
      assert.equal(model.setLocal(item('deleted-while-away')), false, 'fresh joins receive tombstones, preventing resurrection');
    }

    // Rejoin five existing documents with edits made while disconnected and
    // replace five fresh participants, keeping the active population at 100.
    const rejoined = away.slice(0, 5);
    net.membership([...stay, ...fresh.slice(0, 5), ...rejoined]);
    net.flush({ reverse: true }); net.assertConverged();
    for (const { model } of net.active()) {
      for (let index = 0; index < 5; index += 1) assert.equal(model.get(`offline-${index}`).text, `created offline by ${away[index]}`);
      for (let index = 5; index < 10; index += 1) assert.equal(model.get(`offline-${index}`), undefined, 'offline documents that did not rejoin must not leak state');
      assert.equal(model.get('deleted-while-away'), undefined, 'offline stale edits cannot undo an online deletion');
      assert.equal(model.setLocal(item('deleted-while-away')), false);
    }
    assert.equal(net.active().length, 100);
    assert.equal(net.nodes.size, 110, 'fresh joins must create genuinely new Yjs documents');
    t.diagnostic(`110 real Yjs documents, 100 active after churn; ${JSON.stringify(net.stats)}`);
  } finally { net.destroy(); }
});
