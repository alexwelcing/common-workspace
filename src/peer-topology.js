/**
 * Canvas updates travel over three independent, consistent hash rings. Each
 * participant connects to its predecessor and successor in each ring. One ring
 * guarantees connectivity; the others provide shortcuts without a full mesh.
 *
 * An unchanged membership list produces the same symmetric edges everywhere.
 * Adding/removing one participant only changes that participant's adjacent
 * edges, rather than shifting every participant's rank in the room.
 */
export const MAX_CANVAS_NEIGHBORS = 6;

// Domain-separated seeds and a final avalanche yield distinct ring orders.
// This is deterministic routing, not a cryptographic or authorization boundary.
const RING_SEEDS = [0x243f6a88, 0x85a308d3, 0x13198a2e];
const compareIds = (a, b) => a === b ? 0 : a < b ? -1 : 1;

function ringHash(id, seed) {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  // Hash both bytes of each UTF-16 code unit. This is identical across browser
  // runtimes and does not depend on the operating system's locale or encoding.
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index);
    hash = Math.imul(hash ^ (code & 255), 0x01000193);
    hash = Math.imul(hash ^ (code >>> 8), 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * Return this participant's sorted, unique canvas neighbor IDs (at most six).
 * Participants may be ID strings or objects with an id string. The input is
 * never mutated. A participant absent from membership has no canvas edges.
 * Cost per client: O(N log N) time and O(N) temporary storage; no adjacency
 * matrix or full-room network graph is constructed by the application.
 */
export function canvasNeighbors(participants, myId) {
  if (!Array.isArray(participants) || typeof myId !== 'string' || !myId) return [];
  const ids = [...new Set(participants.map(participant => typeof participant === 'string' ? participant : participant?.id)
    .filter(id => typeof id === 'string' && id.length > 0))];
  if (ids.length < 2 || !ids.includes(myId)) return [];

  const neighbors = new Set();
  for (const seed of RING_SEEDS) {
    const ring = ids.map(id => ({ id, hash: ringHash(id, seed) }));
    ring.sort((a, b) => a.hash - b.hash || compareIds(a.id, b.id));
    const index = ring.findIndex(participant => participant.id === myId);
    neighbors.add(ring[(index + ring.length - 1) % ring.length].id);
    neighbors.add(ring[(index + 1) % ring.length].id);
  }
  neighbors.delete(myId);
  return [...neighbors].sort(compareIds);
}
