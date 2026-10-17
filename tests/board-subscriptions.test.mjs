import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Board } from '../src/board.js';

function setup(t, options = {}) {
  const window = new Window({ url: 'https://common.test/' });
  const properties = {
    window, document: window.document, ResizeObserver: window.ResizeObserver,
    fetch: async () => new Response('No WASM in this DOM test', { status: 404 }),
  };
  const originals = new Map(Object.keys(properties).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const el = document.createElement('main'); document.body.append(el);
  const writes = []; const watches = [];
  const board = new Board({ el, onChange: value => writes.push(value), onWatchScreen: id => watches.push(id), ...options });
  t.after(() => {
    board.destroy(); window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  function screen(id, participantId, extra = {}) {
    board.upsert({ id, type: 'screen', participantId, x: 0, y: 0, width: 600, height: 370, title: `${participantId}'s window`, ...extra });
    return board.nodes.get(id);
  }
  return { board, window, writes, watches, screen };
}

test('standalone boards preserve the connecting screen view before subscriptions are configured', (t) => {
  const { screen } = setup(t);
  const node = screen('remote-window', 'remote');
  assert.equal(node.querySelector('.board-screen-placeholder strong').textContent, 'Connecting to shared window');
  assert.equal(node.querySelector('[data-screen-watch]'), null);
});

test('foreign locked screens remain watchable without selecting, moving, or editing shared content', (t) => {
  const { board, window, screen, writes, watches } = setup(t, { canEdit: () => false });
  board.setScreenSubscriptions([], 'local');
  const node = screen('remote-window', 'remote', { locked: true });
  board.setReadOnly(true);
  const watch = node.querySelector('[data-screen-watch="watch"]');
  assert.equal(watch.textContent, 'Watch window');
  assert.equal(watch.getAttribute('aria-label'), "Watch window: remote's window");
  watch.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  watch.click();
  assert.deepEqual(watches, ['remote']);
  assert.equal(board.gesture, null);
  assert.equal(board.selectedId, null);
  assert.deepEqual(writes, []);
  assert.equal(board.entities.get('remote-window').locked, true);
});

test('watching connects a remote tile and pausing detaches its video without changing the screen entity', (t) => {
  const { board, window, screen, writes, watches } = setup(t);
  board.setScreenSubscriptions([], 'local');
  const node = screen('remote-window', 'remote');
  const stream = new window.MediaStream();
  board.setStream('remote', stream);
  assert.equal(node.querySelector('video').hidden, true);
  assert.equal(node.querySelector('video').srcObject, null);
  board.setScreenSubscriptions(['remote'], 'local');
  const video = node.querySelector('video');
  assert.equal(video.srcObject, stream);
  assert.equal(video.hidden, false);
  node.querySelector('[data-screen-watch="pause"]').click();
  assert.deepEqual(watches, ['remote']);
  board.setScreenSubscriptions([], 'local');
  assert.equal(video.srcObject, null);
  assert.equal(node.querySelector('video').hidden, true);
  assert.equal(node.querySelector('.board-screen-placeholder strong').textContent, 'Window ready to watch');
  assert.equal(board.streams.get('remote'), stream);
  assert.deepEqual(writes, []);
});

test('subscription changes preserve every unrelated screen video and canvas node', (t) => {
  const { board, window, screen } = setup(t);
  board.setScreenSubscriptions(['one', 'two'], 'local');
  const one = screen('first', 'one'); const two = screen('second', 'two');
  board.setStream('one', new window.MediaStream()); board.setStream('two', new window.MediaStream());
  board.upsert({ id: 'note', type: 'text', text: 'Shared plan', x: 20, y: 20 });
  const oneVideo = one.querySelector('video'); const twoVideo = two.querySelector('video');
  const note = board.nodes.get('note').firstChild;
  board.setScreenSubscriptions(['two', 'one'], 'local');
  assert.equal(one.querySelector('video'), oneVideo);
  assert.equal(two.querySelector('video'), twoVideo);
  board.setScreenSubscriptions(['two'], 'local');
  assert.notEqual(one.querySelector('video'), oneVideo);
  assert.equal(two.querySelector('video'), twoVideo);
  assert.equal(board.nodes.get('note').firstChild, note);
});

test('local previews always display their stream and never offer Watch or Pause controls', (t) => {
  const { board, window, screen } = setup(t);
  board.setScreenSubscriptions([], 'local');
  const local = screen('local-window', 'local');
  assert.equal(local.querySelector('[data-screen-watch]'), null);
  const stream = new window.MediaStream(); board.setStream('local', stream);
  assert.equal(local.querySelector('video').srcObject, stream);
  assert.equal(local.querySelector('video').hidden, false);
  assert.equal(local.querySelector('[data-screen-watch]'), null);
  board.setScreenSubscriptions(['remote'], 'local');
  assert.equal(local.querySelector('video').srcObject, stream);
});

test('a watched remote window without a stream shows connection status and can still be paused', (t) => {
  const { board, screen } = setup(t);
  board.setScreenSubscriptions(['remote'], 'local');
  const node = screen('remote-window', 'remote');
  assert.equal(node.querySelector('.board-screen-placeholder strong').textContent, 'Connecting to shared window');
  assert.equal(node.querySelector('[data-screen-watch="pause"]').textContent, 'Pause view');
  assert.equal(node.querySelector('[data-screen-watch="watch"]'), null);
});
