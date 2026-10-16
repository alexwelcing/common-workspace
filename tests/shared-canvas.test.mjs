import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { SharedCanvas, compareSharedEntities } from '../src/shared-canvas.js';

const item = (id, fields = {}) => ({ id, type: 'rectangle', x: 10, y: 20, width: 220, height: 130, text: 'Original', ...fields });
const exchange = (a, b) => {
  const aUpdate = a.encodeDiff(b.encodeStateVector());
  const bUpdate = b.encodeDiff(a.encodeStateVector());
  assert.equal(a.applyUpdate(bUpdate), true);
  assert.equal(b.applyUpdate(aUpdate), true);
};

test('field-level changes preserve a simultaneous move, resize, text edit and layer action', () => {
  const a = new SharedCanvas({ clientId: 1 }); const b = new SharedCanvas({ clientId: 2 });
  a.replaceInitial([item('one', { z: 1 }), item('two', { z: 2 }), item('three', { z: 3 })]); exchange(a, b);
  a.patch('one', { x: 400, y: 200 });
  a.reorder('one', 'front');
  b.patch('one', { width: 500, height: 300, text: 'Edited by a peer', locked: true });
  exchange(a, b);
  assert.deepEqual(a.all(), b.all());
  assert.deepEqual(a.getOrder(), ['two', 'three', 'one']);
  assert.deepEqual(a.get('one'), { ...a.get('one'), x: 400, y: 200, width: 500, height: 300, text: 'Edited by a peer', locked: true });
  a.destroy(); b.destroy();
});

test('explicit field patches on a stale gesture preserve a remote lock and layer', () => {
  const a = new SharedCanvas(); const b = new SharedCanvas();
  a.replaceInitial([item('one'), item('two')]); exchange(a, b);
  const stale = a.get('one');
  b.reorder('one', 'front'); b.patch('one', { locked: true, text: 'Peer edit' }); exchange(a, b);
  a.setLocal({ ...stale, x: 250, y: 350 }, { x: 250, y: 350 }); exchange(a, b);
  assert.equal(b.get('one').locked, true);
  assert.equal(b.get('one').text, 'Peer edit');
  assert.equal(b.get('one').x, 250);
  assert.deepEqual(b.getOrder(), ['two', 'one']);
  a.destroy(); b.destroy();
});

test('delete wins over a concurrent edit and stale full entities cannot resurrect items', () => {
  const deletions = [];
  const a = new SharedCanvas(); const b = new SharedCanvas({ onDelete: id => deletions.push(id) });
  a.setLocal(item('one')); exchange(a, b);
  const stale = b.get('one');
  a.deleteLocal('one'); b.patch('one', { x: 500 }); exchange(a, b);
  assert.equal(a.get('one'), undefined); assert.equal(b.get('one'), undefined);
  assert.equal(b.setLocal(stale), false); assert.equal(b.patch('one', { y: 100 }), false);
  assert.deepEqual(deletions, ['one']);
  const late = new SharedCanvas(); late.applyUpdate(b.encodeState());
  assert.equal(late.setLocal(stale), false);
  assert.equal(late.replaceInitial([stale]), false);
  a.destroy(); b.destroy(); late.destroy();
});

test('all four layer actions move one slot or to the boundary without changing geometry', () => {
  const canvas = new SharedCanvas();
  canvas.replaceInitial(['a', 'b', 'c', 'd'].map(id => item(id)));
  const geometry = canvas.get('b');
  assert.equal(canvas.reorder('b', 'forward'), true);
  assert.deepEqual(canvas.getOrder(), ['a', 'c', 'b', 'd']);
  canvas.reorder('b', 'backward'); assert.deepEqual(canvas.getOrder(), ['a', 'b', 'c', 'd']);
  canvas.reorder('b', 'front'); assert.deepEqual(canvas.getOrder(), ['a', 'c', 'd', 'b']);
  assert.equal(canvas.reorder('b', 'front'), false);
  canvas.reorder('b', 'back'); assert.deepEqual(canvas.getOrder(), ['b', 'a', 'c', 'd']);
  const { orderKey: before, ...beforeFields } = geometry;
  const { orderKey: after, ...afterFields } = canvas.get('b');
  assert.deepEqual(afterFields, beforeFields);
  assert.notEqual(before, after);
  canvas.destroy();
});

test('simultaneous inserts into the same layer gap converge and can be reordered', () => {
  const a = new SharedCanvas({ clientId: 1 }); const b = new SharedCanvas({ clientId: 2 });
  a.setLocal(item('base')); exchange(a, b);
  a.setLocal(item('a')); b.setLocal(item('b')); exchange(a, b);
  assert.equal(a.get('a').orderKey, a.get('b').orderKey);
  assert.deepEqual(a.getOrder(), ['base', 'a', 'b']);
  assert.deepEqual(a.getOrder(), b.getOrder());
  // The insertion gap is between equal keys, so this exercises normalization.
  a.reorder('base', 'forward'); exchange(a, b);
  assert.deepEqual(a.getOrder(), ['a', 'base', 'b']);
  assert.deepEqual(a.all(), b.all());
  assert.notEqual(a.get('a').orderKey, a.get('b').orderKey);
  a.destroy(); b.destroy();
});

test('simultaneous layer actions converge with opposite packet delivery order', () => {
  const a = new SharedCanvas({ clientId: 1 }); const b = new SharedCanvas({ clientId: 2 });
  a.replaceInitial(['a', 'b', 'c', 'd'].map(id => item(id))); exchange(a, b);
  a.reorder('a', 'front'); b.reorder('d', 'back'); exchange(a, b);
  assert.deepEqual(a.all(), b.all()); assert.deepEqual(a.getOrder(), ['d', 'b', 'c', 'a']);
  // Both participants may act on one object. Yjs resolves the shared field,
  // while either unrelated geometry update must remain present.
  a.reorder('b', 'front'); a.patch('b', { x: 111 });
  b.reorder('b', 'back'); b.patch('b', { width: 333 }); exchange(a, b);
  assert.deepEqual(a.all(), b.all());
  assert.equal(a.get('b').x, 111); assert.equal(a.get('b').width, 333);
  a.destroy(); b.destroy();
});

test('late join receives layers, locks, drawings and edits through state-vector diffs', () => {
  const updates = []; const changes = []; const deletions = [];
  const a = new SharedCanvas({ onUpdate: (update, origin) => updates.push({ update, origin }) });
  a.replaceInitial([item('shape'), item('draw', { type: 'draw', points: [{ x: 1, y: 2 }, { x: 30, y: 40 }] })]);
  a.patch('draw', { locked: true }); a.reorder('shape', 'front');
  const late = new SharedCanvas({ onChange: entity => changes.push(entity), onDelete: id => deletions.push(id) });
  assert.equal(late.applyUpdate(a.encodeState()), true);
  assert.deepEqual(a.all(), late.all()); assert.equal(changes.length, 2);
  const before = late.encodeStateVector();
  a.patch('shape', { text: 'Ready for discussion' }); a.deleteLocal('draw');
  late.applyUpdate(a.encodeDiff(before));
  assert.deepEqual(a.all(), late.all()); assert.deepEqual(deletions, ['draw']);
  assert.equal(updates.every(({ origin }) => origin === 'local'), true);
  assert.equal(late.replaceInitial([item('seed')]), false);
  a.destroy(); late.destroy();
});

test('malformed packets and invalid materialized peer fields never reach a renderer', () => {
  const invalid = []; const changes = []; const a = new SharedCanvas({ onInvalid: error => invalid.push(error), onChange: entity => changes.push(entity) });
  assert.equal(a.applyUpdate(new Uint8Array([1, 2, 3])), false);
  assert.equal(a.applyUpdate('not bytes'), false);
  assert.equal(a.applyUpdate(new Uint8Array(24 * 1024 * 1024 + 1)), false);
  assert.equal(a.setLocal(item('bad', { x: Infinity })), false);
  assert.equal(a.setLocal(item('bad', { url: 'data:image/svg+xml;base64,PHN2Zz4=' })), false);
  a.setLocal(item('safe'));
  const before = a.get('safe');
  assert.equal(a.patch('safe', { width: NaN }), false);
  assert.deepEqual(a.get('safe'), before);
  // Peer state is still CRDT data, not trusted display data.
  const malicious = new Y.Doc(); Y.applyUpdate(malicious, a.encodeState());
  malicious.getMap('canvas').get('safe').set('x', Infinity);
  a.applyUpdate(Y.encodeStateAsUpdate(malicious));
  assert.equal(a.get('safe'), undefined);
  assert.equal(changes.some(entity => !Number.isFinite(entity.x)), false);
  assert.ok(invalid.length >= 6);
  a.destroy(); malicious.destroy();
});

test('snapshots are detached and deterministic legacy sorting uses IDs for ties', () => {
  const a = new SharedCanvas();
  a.setLocal(item('a', { points: [{ x: 0, y: 1 }] }));
  const snapshot = a.get('a'); snapshot.points[0].x = 500; snapshot.x = 500;
  assert.equal(a.get('a').x, 10); assert.equal(a.get('a').points[0].x, 0);
  assert.deepEqual([item('c'), item('a', { z: 0 }), item('b')].sort(compareSharedEntities).map(entity => entity.id), ['a', 'b', 'c']);
  a.destroy();
});

test('the local byte budget rejects growing images and text atomically and frees space on delete', () => {
  const errors = []; const canvas = new SharedCanvas({ maxBytes: 1024, onInvalid: error => errors.push(error.message) });
  const image = id => item(id, { type: 'image', url: 'data:image/png;base64,' + 'a'.repeat(700) });
  assert.equal(canvas.setLocal(image('first')), true);
  const before = canvas.encodeStateVector();
  assert.equal(canvas.setLocal(image('second')), false);
  assert.deepEqual(canvas.encodeStateVector(), before, 'a rejected change must not enter Yjs state');
  assert.equal(canvas.patch('first', { title: 'a'.repeat(200) }), false);
  assert.equal(canvas.get('first').title, undefined);
  assert.equal(canvas.deleteLocal('first'), true);
  assert.equal(canvas.totalBytes, 0);
  assert.equal(canvas.setLocal(image('second')), true);
  assert.ok(errors.every(message => message.includes('canvas is full')));
  canvas.destroy();
});

test('initial seeding respects the whole-canvas byte budget and counts UTF-8 bytes', () => {
  const canvas = new SharedCanvas({ maxBytes: 1024 });
  assert.equal(canvas.replaceInitial([item('a', { text: 'a'.repeat(500) }), item('b', { text: 'b'.repeat(500) })]), false);
  assert.deepEqual(canvas.all(), []);
  assert.equal(canvas.setLocal(item('a')), true);
  assert.equal(canvas.patch('a', { text: '🙂'.repeat(240) }), false, 'UTF-8 payload bytes, rather than JS string length, determine the budget');
  assert.equal(canvas.patch('a', { text: 'a'.repeat(500) }), true);
  canvas.destroy();
  assert.throws(() => new SharedCanvas({ maxBytes: 0 }), RangeError);
  assert.throws(() => new SharedCanvas({ maxBytes: 17 * 1024 * 1024 }), RangeError);
});
