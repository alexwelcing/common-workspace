// Presentation values are separate from the public, mutable state() snapshots.
// The brand is stronger than Object.isFrozen(array): every descendant is frozen.
const immutableValues = new WeakSet();
const encoder = new TextEncoder();
const byteLength = value => encoder.encode(JSON.stringify(value)).byteLength;

function immutable(value) {
  if (!value || typeof value !== 'object' || immutableValues.has(value)) return value;
  for (const item of Object.values(value)) immutable(item);
  Object.freeze(value);
  immutableValues.add(value);
  return value;
}

export function isSpatialProjection(value) {
  return !!value && typeof value === 'object' && immutableValues.has(value);
}

function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

function preserveEntity(previous, value) {
  if (!previous) return immutable(value);
  // A move does not need a new drawing path when its points are unchanged.
  if (value.points && equal(previous.points, value.points)) value.points = previous.points;
  return equal(previous, value) ? previous : immutable(value);
}

function addMapKeys(target, diff) {
  if (diff.type !== 'map' || !diff.updated || typeof diff.updated !== 'object') return false;
  for (const key of Object.keys(diff.updated)) target.add(key);
  return true;
}

/**
 * A bounded materialized view of accepted live documents. The store owns every
 * validation boundary; these readers normalize one board or object at a time.
 * Diff hints never contain content and are discarded only after a successful read.
 */
export class SpatialProjection {
  constructor({ readState, readRoom, readBoard, readObjects, readEntity, readBoardOrder, compareEntities, maximumBoardBytes, maximumEntities, measure = work => work() }) {
    this.measure = measure;
    this.readState = readState;
    this.readRoom = readRoom;
    this.readBoard = readBoard;
    this.readObjects = readObjects;
    this.readEntity = readEntity;
    this.readBoardOrder = readBoardOrder;
    this.compareEntities = compareEntities;
    this.maximumBoardBytes = maximumBoardBytes;
    this.maximumEntities = maximumEntities;
    this.current = null;
    this.records = new Map();
    this.pending = new Map();
  }

  /** Call only after an edit/import has passed validation, before any callbacks. */
  accept(id, doc, from) {
    if (!this.current) return;
    let pending = this.pending.get(id);
    if (!pending) this.pending.set(id, pending = { full: false, room: false, ids: new Set() });
    if (pending.full) return;
    if (!from) {
      pending.full = true;
      pending.ids.clear();
      return;
    }
    try {
      for (const [container, diff] of doc.diff(from, doc.frontiers(), false)) {
        const path = doc.getPathToContainer(container);
        const root = path?.[0];
        if (id === 'manifest' && root === 'room') {
          pending.room = true;
        } else if (id === 'manifest' && root === 'boards') {
          if (path.length > 1 && typeof path[1] === 'string') pending.ids.add(path[1]);
          else if (!addMapKeys(pending.ids, diff)) pending.full = true;
        } else if (id !== 'manifest' && ['entities', 'deleted'].includes(root)) {
          if (path.length > 1 && typeof path[1] === 'string') pending.ids.add(path[1]);
          else if (!addMapKeys(pending.ids, diff)) pending.full = true;
        } else {
          // Deleted/replaced containers can no longer have a path. Re-read this
          // document rather than guessing which visible object they belonged to.
          pending.full = true;
        }
        if (pending.full || pending.ids.size > this.maximumEntities) {
          pending.full = true;
          pending.ids.clear();
          break;
        }
      }
    } catch {
      pending.full = true;
      pending.ids.clear();
    }
  }

  createRecord(board, previous) {
    const entities = new Map();
    const sizes = new Map();
    let bytes = 0;
    for (const raw of board.objects) {
      const entity = preserveEntity(previous?.entities.get(raw.id), raw);
      entities.set(entity.id, entity);
      const size = entity === previous?.entities.get(entity.id)
        ? previous.sizes.get(entity.id) : byteLength(entity);
      sizes.set(entity.id, size);
      bytes += size;
    }
    const objects = immutable([...entities.values()].sort(this.compareEntities));
    const metadata = { ...board };
    delete metadata.objects;
    return this.finishRecord(metadata, { entities, sizes, bytes, objects }, previous);
  }

  finishRecord(metadata, contents, previous) {
    if (contents.entities.size > this.maximumEntities || contents.bytes > this.maximumBoardBytes) {
      throw new Error('This board exceeds the spatial content limit.');
    }
    let objects = contents.objects;
    if (previous && objects.length === previous.board.objects.length
      && objects.every((entity, index) => entity === previous.board.objects[index])) {
      objects = previous.board.objects;
    }
    const value = { ...metadata, objects };
    const board = previous && equal(previous.metadata, metadata) && objects === previous.board.objects
      ? previous.board : immutable(value);
    return { ...contents, objects, board, metadata: board === previous?.board ? previous.metadata : immutable(metadata) };
  }

  updateRecord(id, previous, metadata, pending) {
    if (!previous || pending?.full) {
      const contents = this.readObjects(id);
      return this.createRecord({ ...metadata, objects: contents.objects }, previous);
    }
    const entities = new Map(previous.entities);
    const sizes = new Map(previous.sizes);
    let bytes = previous.bytes;
    let changed = false;
    for (const entityId of pending?.ids || []) {
      const old = entities.get(entityId);
      const raw = this.readEntity(id, entityId);
      const next = raw ? preserveEntity(old, raw) : null;
      if (old === next || (!old && !next)) continue;
      changed = true;
      bytes -= sizes.get(entityId) || 0;
      if (next) {
        entities.set(entityId, next);
        const size = byteLength(next);
        sizes.set(entityId, size);
        bytes += size;
      } else {
        entities.delete(entityId);
        sizes.delete(entityId);
      }
    }
    const objects = changed ? immutable([...entities.values()].sort(this.compareEntities)) : previous.board.objects;
    return this.finishRecord(metadata, { entities, sizes, bytes, objects }, previous);
  }

  snapshot() {
    if (this.current && !this.pending.size) return this.current;
    return this.measure(() => this.materialize());
  }

  materialize() {
    if (!this.current) {
      const state = this.readState();
      const records = new Map(state.boards.map(board => [board.id, this.createRecord(board)]));
      this.current = immutable({ ...state, boards: [...records.values()].map(record => record.board) });
      this.records = records;
      this.pending.clear();
      return this.current;
    }
    if (!this.pending.size) return this.current;
    const manifest = this.pending.get('manifest');
    if (manifest?.full) {
      const state = this.readState();
      const records = new Map(state.boards.map(board => [board.id, this.createRecord(board, this.records.get(board.id))]));
      return this.publish(state, records);
    }
    const records = new Map(this.records);
    const affected = new Set(manifest?.ids);
    for (const id of this.pending.keys()) if (id.startsWith('board:')) affected.add(id.slice(6));
    for (const id of affected) {
      const metadata = this.readBoard(id);
      if (!metadata) {
        records.delete(id);
        continue;
      }
      const previous = records.get(id);
      records.set(id, this.updateRecord(id, previous, metadata, this.pending.get(`board:${id}`)));
    }
    const room = manifest?.room ? this.readRoom() : this.current;
    const ordered = manifest?.ids.size
      ? new Map(this.readBoardOrder().filter(id => records.has(id)).map(id => [id, records.get(id)])) : records;
    return this.publish(room, ordered);
  }

  publish(room, records) {
    const previous = this.current;
    let boards = [...records.values()].map(record => record.board);
    // Preserve document/manifest order rather than moving an edited board.
    if (boards.length === previous.boards.length && boards.every((board, index) => board === previous.boards[index])) {
      boards = previous.boards;
    } else boards = immutable(boards);
    const appearance = equal(room.appearance, previous.appearance) ? previous.appearance : immutable(room.appearance);
    this.current = room.title === previous.title && appearance === previous.appearance && boards === previous.boards
      ? previous : immutable({ title: room.title, appearance, boards });
    this.records = records;
    this.pending.clear();
    return this.current;
  }

  contents(id) {
    // A cold store retains its existing board-local validation path; do not
    // materialize the whole room merely to check the first object's byte budget.
    if (!this.current) return null;
    this.snapshot();
    const record = this.records.get(id);
    return record && { objects: record.board.objects, bytes: record.bytes, sizes: record.sizes };
  }

  historical(read) {
    // Historical snapshots share the store's existing eight-entry pastCache;
    // keeping a second map would retain another eight potentially large rooms.
    return this.measure(() => immutable(read()));
  }

  clear() {
    this.current = null;
    this.records.clear();
    this.pending.clear();
  }
}
