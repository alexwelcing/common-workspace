import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenSubscriptions, defaultWatchBudget } from '../src/screen-subscriptions.js';

const screen = (id, patch = {}) => ({ id: `screen-${id}`, type: 'screen', participantId: id, x: 0, y: 0, width: 200, height: 150, ...patch });
const context = { participantId: 'self', width: 800, height: 600, view: { x: 0, y: 0, zoom: 1 } };

test('device resource budget affects simultaneous decoders, without limiting room membership', () => {
  assert.equal(defaultWatchBudget({ hardwareConcurrency: 2 }), 2);
  assert.equal(defaultWatchBudget({ deviceMemory: 4, hardwareConcurrency: 12 }), 2);
  assert.equal(defaultWatchBudget({ deviceMemory: 8, hardwareConcurrency: 12 }), 4);
  assert.equal(defaultWatchBudget({}), 4);
  const subscriptions = new ScreenSubscriptions({ maxStreams: 4 });
  const room = Array.from({ length: 1000 }, (_, i) => screen(`person-${i}`));
  assert.deepEqual(subscriptions.plan(room, context), ['person-0', 'person-1', 'person-2', 'person-3']);
});

test('only visible remote windows consume subscriptions; pan, zoom and resize change interest', () => {
  const subscriptions = new ScreenSubscriptions();
  const room = [screen('self'), screen('near'), screen('far', { x: 900 }), screen('above', { y: -200 }), { type: 'image', id: 'image' }];
  assert.deepEqual(subscriptions.plan(room, context), ['near']);
  assert.deepEqual(subscriptions.plan(room, { ...context, view: { x: -800, y: 0, zoom: 1 } }), ['far']);
  assert.deepEqual(subscriptions.plan(room, { ...context, view: { x: 0, y: 0, zoom: .5 } }), ['far', 'near']);
  assert.deepEqual(subscriptions.plan(room, { ...context, width: 0 }), []);
});

test('explicit Watch replaces a view at the budget and Pause persists through selection and movement', () => {
  const subscriptions = new ScreenSubscriptions({ maxStreams: 2 });
  const room = ['a', 'b', 'c'].map(id => screen(id));
  assert.deepEqual(subscriptions.plan(room, context), ['a', 'b']);
  subscriptions.toggle('c');
  assert.deepEqual(subscriptions.plan(room, context), ['c', 'a']);
  subscriptions.toggle('c');
  assert.deepEqual(subscriptions.plan(room, { ...context, selectedId: 'screen-c' }), ['a', 'b']);
  assert.deepEqual(subscriptions.plan(room, { ...context, view: { x: 1 } }), ['a', 'b']);
  subscriptions.toggle('c');
  assert.deepEqual(subscriptions.plan(room, context), ['c', 'a']);
});

test('selection prioritizes an unpaused screen while stable views avoid cycling decoders', () => {
  const subscriptions = new ScreenSubscriptions({ maxStreams: 2 });
  const room = ['a', 'b', 'c'].map(id => screen(id));
  subscriptions.plan(room, context);
  assert.deepEqual(subscriptions.plan(room, { ...context, selectedId: 'screen-c' }), ['c', 'a']);
  assert.deepEqual(subscriptions.plan([...room].reverse(), context), ['c', 'a']);
});

test('hidden tabs release incoming video and restore interest without altering screen objects', () => {
  const subscriptions = new ScreenSubscriptions({ maxStreams: 1 });
  const room = [screen('a'), screen('b')], before = structuredClone(room);
  subscriptions.plan(room, context);
  subscriptions.toggle('b');
  assert.deepEqual(subscriptions.plan(room, context), ['b']);
  assert.deepEqual(subscriptions.plan(room, { ...context, hidden: true }), []);
  assert.deepEqual(subscriptions.plan(room, context), ['b']);
  assert.deepEqual(room, before);
  subscriptions.plan([], context);
  assert.deepEqual(subscriptions.preferred, []);
  assert.equal(subscriptions.paused.size, 0);
  subscriptions.reset();
  assert.deepEqual(subscriptions.plan(room, context), ['a']);
});
