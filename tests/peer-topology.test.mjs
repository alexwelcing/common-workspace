import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasNeighbors, MAX_CANVAS_NEIGHBORS } from '../src/peer-topology.js';

const compareIds = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const participantIds = count => Array.from({ length: count }, (_, index) => `participant-${String(index).padStart(4, '0')}`);
const graphs = new Map();

// A complete graph is built only in these tests to inspect its global
// properties. Each production client computes only its own neighbor list.
function graph(ids) {
  return new Map(ids.map(id => [id, canvasNeighbors(ids, id)]));
}
function fixture(count) {
  if (!graphs.has(count)) graphs.set(count, graph(participantIds(count)));
  return graphs.get(count);
}
function reachable(adjacency, start = adjacency.keys().next().value) {
  const distances = new Map([[start, 0]]); const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    for (const neighbor of adjacency.get(id) || []) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distances.get(id) + 1); queue.push(neighbor);
    }
  }
  return distances;
}
function edges(adjacency) {
  const result = new Set();
  for (const [from, neighbors] of adjacency) for (const to of neighbors) {
    if (from < to) result.add(JSON.stringify([from, to]));
  }
  return result;
}
function changedCount(before, after, ids) {
  return ids.filter(id => JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))).length;
}
function difference(left, right) { return [...left].filter(value => !right.has(value)); }

function assertGraph(adjacency) {
  for (const [id, neighbors] of adjacency) {
    assert.ok(neighbors.length <= MAX_CANVAS_NEIGHBORS, `${id} exceeded the degree bound`);
    assert.equal(new Set(neighbors).size, neighbors.length, 'neighbor IDs are unique');
    assert.deepEqual(neighbors, [...neighbors].sort(compareIds), 'neighbor IDs use a deterministic string order');
    assert.ok(!neighbors.includes(id), 'a participant never connects to itself');
    for (const neighbor of neighbors) {
      assert.ok(adjacency.has(neighbor), 'all edges stay within membership');
      assert.ok(adjacency.get(neighbor).includes(id), `${id} → ${neighbor} must also exist in the opposite direction`);
    }
  }
  assert.equal(reachable(adjacency).size, adjacency.size, 'all participants must remain connected');
}

test('canvas neighbors handle empty, missing, duplicate, and object memberships without mutation', () => {
  assert.equal(MAX_CANVAS_NEIGHBORS, 6);
  assert.deepEqual(canvasNeighbors([], 'a'), []);
  assert.deepEqual(canvasNeighbors(undefined, 'a'), []);
  assert.deepEqual(canvasNeighbors(['a'], 'a'), []);
  assert.deepEqual(canvasNeighbors(['a', 'b'], 'absent'), []);
  assert.deepEqual(canvasNeighbors(['a', 'b'], null), []);
  assert.deepEqual(canvasNeighbors(['a', 'b'], 'a'), ['b']);
  const participants = Object.freeze([
    Object.freeze({ id: 'a', name: 'Alice' }), 'b', Object.freeze({ id: 'c' }),
    Object.freeze({ id: 'a', name: 'Duplicate' }), null, 8, '', Object.freeze({ name: 'No ID' }),
  ]);
  assert.deepEqual(canvasNeighbors(participants, 'a'), ['b', 'c']);
  assert.deepEqual(canvasNeighbors(['a', 'b', 'c'], 'b'), ['a', 'c']);
});

test('membership arrival order, metadata, and mixed Unicode IDs do not change the graph', () => {
  const ids = ['alice', 'ALICE', 'Alice', 'é', 'e\u0301', '😀', '🚀', 'z', 'Z', 'ä', '10', '2'];
  const baseline = graph(ids);
  const shuffled = [...ids.filter((_, i) => i % 2), ...ids.filter((_, i) => !(i % 2))].reverse();
  const objects = shuffled.map((id, index) => ({ id, name: `Name ${index}`, isAdmin: index === 2 }));
  for (const id of ids) {
    assert.deepEqual(canvasNeighbors(shuffled, id), baseline.get(id));
    assert.deepEqual(canvasNeighbors(objects, id), baseline.get(id));
    assert.deepEqual(canvasNeighbors([...objects, ...objects].reverse(), id), baseline.get(id));
  }
  assertGraph(baseline);
});

for (const count of [10, 100, 1000]) {
  test(`${count} participants form a connected symmetric graph with at most six neighbors per client`, () => {
    const adjacency = fixture(count);
    assertGraph(adjacency);
    const edgeCount = edges(adjacency).size;
    assert.ok(edgeCount <= 3 * count, 'the total edge count stays linear in membership');
    if (count >= 100) assert.ok(edgeCount < count * (count - 1) / 10, 'canvas transport must not approach a full mesh');
    const reversed = participantIds(count).reverse();
    // Include the first, middle, and last IDs rather than checking only one
    // participant's view of reordered membership at scale.
    for (const id of [reversed[0], reversed[Math.floor(count / 2)], reversed.at(-1)]) {
      assert.deepEqual(canvasNeighbors(reversed, id), adjacency.get(id));
    }
  });

  test(`${count} participants have short routes compared with a single nearest-neighbor ring`, () => {
    const adjacency = fixture(count); let diameter = 0; let totalDistances = 0;
    for (const id of adjacency.keys()) {
      const distances = reachable(adjacency, id);
      assert.equal(distances.size, count);
      for (const distance of distances.values()) {
        diameter = Math.max(diameter, distance); totalDistances += distance;
      }
    }
    const average = totalDistances / (count * (count - 1));
    // Any single predecessor/successor ring has diameter floor(N / 2),
    // regardless of its hash order. The two extra rings supply shortcuts.
    assert.ok(diameter < Math.floor(count / 2), `diameter ${diameter} should improve on a plain ring`);
    assert.ok(diameter <= Math.ceil(Math.log2(count)), `fixture diameter ${diameter} should remain logarithmic`);
    assert.ok(average <= Math.log2(count), `mean distance ${average} should remain small`);
  });

  test(`joining and leaving ${count}-participant membership changes only neighboring ring edges`, () => {
    const ids = participantIds(count); const before = fixture(count); const beforeEdges = edges(before);
    const joined = graph([...ids.slice().reverse(), 'late-participant']); const joinedEdges = edges(joined);
    assertGraph(joined);
    assert.ok(changedCount(before, joined, ids) <= 6, 'a join changes at most six existing clients’ neighbor sets');
    assert.ok(difference(beforeEdges, joinedEdges).length <= 3, 'a join splits at most one old edge per ring');
    assert.ok(difference(joinedEdges, beforeEdges).length <= 6, 'a join introduces at most two edges per ring');

    const leaving = ids[Math.floor(count / 2)]; const survivors = ids.filter(id => id !== leaving);
    const after = graph(survivors); const afterEdges = edges(after);
    assertGraph(after);
    assert.ok(changedCount(before, after, survivors) <= 6, 'a leave changes at most six surviving clients’ neighbor sets');
    assert.ok(difference(beforeEdges, afterEdges).length <= 6, 'a leave removes only the departed participant’s edges');
    assert.ok(difference(afterEdges, beforeEdges).length <= 3, 'a leave adds at most one replacement edge per ring');
    assert.deepEqual(canvasNeighbors(survivors, leaving), []);
    // Reordering announcements and then rejoining must reconstruct exactly
    // the original graph, with no remembered rank or connection history.
    const rejoined = graph([...survivors.reverse(), leaving]);
    assert.deepEqual(rejoined, before);
  });
}
