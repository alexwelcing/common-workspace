import test from 'node:test';
import assert from 'node:assert/strict';
import { Walkthrough } from '../src/walkthrough.js';

function fixture() {
  const board = {
    el: { clientWidth: 1200, clientHeight: 800 },
    entities: new Map([['product', { id: 'product', x: 400, y: 300, width: 600, height: 400 }]]),
    zoom: 1,
    pan: { x: 24, y: 24 },
    updates: 0,
    updateView() { this.updates += 1; },
  };
  const changes = []; const statuses = [];
  const walkthrough = new Walkthrough({ getBoard: () => board, onChange: state => changes.push(state), onStatus: status => statuses.push(status) });
  return { board, changes, statuses, walkthrough };
}

test('walkthrough advances, goes back and stops at the authored boundaries', () => {
  const { walkthrough, changes, board } = fixture();
  assert.deepEqual(walkthrough.state(), { active: false, index: -1, total: 0, current: null });
  walkthrough.load([{ title: 'Welcome', text: 'A short introduction.' }, { title: 'Product', targetId: 'product' }]);
  assert.equal(walkthrough.state().index, 0);
  assert.equal(walkthrough.previous().index, 0);
  assert.equal(walkthrough.next().current.title, 'Product');
  assert.equal(board.updates, 1);
  assert.equal(walkthrough.next().index, 1);
  assert.equal(changes.length, 2);
  assert.equal(walkthrough.previous().current.title, 'Welcome');
  assert.deepEqual(walkthrough.stop(), { active: false, index: -1, total: 2, current: null });
  assert.equal(walkthrough.next().active, false);
  assert.equal(walkthrough.previous().active, false);
  assert.equal(changes.length, 4);
});

test('invalid later steps reject an entire load without moving the view or changing the active presentation', () => {
  const { walkthrough, board, changes } = fixture();
  walkthrough.load([{ title: 'Existing', targetId: 'product' }]);
  const before = walkthrough.state(); const updates = board.updates;
  const invalidSteps = [
    undefined, [], new Array(2), Array.from({ length: 51 }, () => ({ title: 'Too many' })),
    [{ title: '' }], [{ title: ' '.repeat(3) }], [{ title: 'x'.repeat(201) }],
    [{ title: 'Bad text', text: 3 }], [{ title: 'Long text', text: 'x'.repeat(5001) }],
    [{ title: 'Bad target', targetId: '' }], [{ title: 'Bad target', targetId: 10 }],
    [{ title: 'Bad bounds', bounds: { x: '0', y: 0, width: 1, height: 1 } }],
    [{ title: 'Bad bounds', bounds: { x: Infinity, y: 0, width: 1, height: 1 } }],
    [{ title: 'Bad bounds', bounds: { x: 0, y: 0, width: 0, height: 1 } }],
    [{ title: 'Bad bounds', bounds: { x: 0, y: 0, width: 1, height: -1 } }],
    [{ title: 'Bad bounds', bounds: { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 } }],
    [{ title: 'Valid first', bounds: { x: 0, y: 0, width: 100, height: 100 } }, null],
  ];
  for (const invalid of invalidSteps) {
    assert.throws(() => walkthrough.load(invalid));
    assert.deepEqual(walkthrough.state(), before);
  }
  assert.equal(board.updates, updates);
  assert.equal(changes.length, 1);
});

test('authored input, callback state and returned snapshots cannot mutate walkthrough steps', () => {
  const { walkthrough, changes } = fixture();
  const steps = [{ title: 'Overview', text: 'Start here.', bounds: { x: 100, y: 200, width: 300, height: 400 } }];
  const loaded = walkthrough.load(steps);
  steps[0].title = 'Changed input'; steps[0].bounds.width = 1;
  loaded.current.bounds.x = 0; loaded.current.text = 'Changed return';
  changes[0].current.title = 'Changed callback'; changes[0].current.bounds.height = 1;
  assert.deepEqual(walkthrough.state().current, { title: 'Overview', text: 'Start here.', bounds: { x: 100, y: 200, width: 300, height: 400 } });
});

test('focus pads and centers current target geometry without modifying shared entities', () => {
  const { walkthrough, board } = fixture();
  const entity = { ...board.entities.get('product') };
  walkthrough.load([{ title: 'Target', targetId: 'product' }, { title: 'Text only' }]);
  assert.equal(board.zoom, 1.5);
  assert.deepEqual(board.pan, { x: -450, y: -350 });
  assert.deepEqual(board.entities.get('product'), entity);
  walkthrough.next();
  board.entities.get('product').x = 1000;
  walkthrough.previous();
  assert.equal(board.pan.x, 600 - 1300 * 1.5);
  assert.equal(board.updates, 2);
});

test('explicit bounds work without a target and large areas fit within the padded viewport', () => {
  const { walkthrough, board, statuses } = fixture();
  walkthrough.load([{ title: 'Whole area', bounds: { x: -200, y: 500, width: 2000, height: 1000 } }]);
  assert.equal(board.zoom, (1200 - 128) / 2000);
  assert.equal((-200 + 1000) * board.zoom + board.pan.x, 600);
  assert.equal((500 + 500) * board.zoom + board.pan.y, 400);
  assert.deepEqual(statuses, []);
});

test('a deleted target preserves narration and navigation and can use an explicit fallback area', () => {
  const { walkthrough, board, statuses } = fixture();
  walkthrough.load([
    { title: 'Opening' },
    { title: 'Deleted product', text: 'The explanation remains available.', targetId: 'product' },
    { title: 'Fallback', targetId: 'gone', bounds: { x: 0, y: 0, width: 100, height: 100 } },
  ]);
  board.entities.delete('product');
  const state = walkthrough.next();
  assert.equal(state.current.text, 'The explanation remains available.');
  assert.equal(board.updates, 0);
  assert.match(statuses[0], /no longer on the canvas/);
  assert.equal(walkthrough.next().current.title, 'Fallback');
  assert.equal(board.updates, 1);
  assert.equal(walkthrough.previous().current.title, 'Deleted product');
});

test('walkthrough narration is available before the canvas exists or when it has no viewport yet', () => {
  const states = [];
  const walkthrough = new Walkthrough({ getBoard: () => null, onChange: state => states.push(state) });
  assert.equal(walkthrough.load([{ title: 'Available', bounds: { x: 0, y: 0, width: 100, height: 100 } }]).active, true);
  assert.equal(states[0].current.title, 'Available');
  const { walkthrough: hidden, board } = fixture();
  board.el.clientWidth = 0;
  hidden.load([{ title: 'Hidden canvas', targetId: 'product' }]);
  assert.equal(board.updates, 0);
});
