import * as Y from 'yjs';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

const MAX_UPDATE_BYTES = 24 * 1024 * 1024;
const MAX_CANVAS_BYTES = 16 * 1024 * 1024;
const MAX_ENTITIES = 1000;
const TYPES = new Set(['text', 'sticky', 'rectangle', 'ellipse', 'arrow', 'draw', 'image', 'diagram', 'screen']);
const STRINGS = { text: 20000, color: 100, fill: 100, source: 20000, title: 200, streamId: 200, screenId: 200, participantId: 200, updatedBy: 200 };
const FIELDS = new Set(['id', 'type', 'x', 'y', 'width', 'height', ...Object.keys(STRINGS), 'fontSize', 'z', 'points', 'language', 'externalConsent', 'url', 'updatedAt', 'orderKey', 'locked']);
const finite = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
const copy = value => structuredClone(value);
const same = (a, b) => a === b || (a != null && b != null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
const encoder = new TextEncoder();
const byteSize = entity => encoder.encode(JSON.stringify(entity)).byteLength;

function validKey(key) {
  if (typeof key !== 'string' || key.length > 128 || !/^[0-9A-Za-z]+$/.test(key)) return false;
  try { generateKeyBetween(key, null); return true; } catch { return false; }
}

/** Order is bottom to top. Never use localeCompare for fractional-indexing keys. */
export function compareSharedEntities(a, b) {
  const aKey = typeof a.orderKey === 'string' ? a.orderKey : null;
  const bKey = typeof b.orderKey === 'string' ? b.orderKey : null;
  if (aKey !== bKey) {
    if (aKey == null) return -1;
    if (bKey == null) return 1;
    return aKey < bKey ? -1 : 1;
  }
  // Legacy entities without a fractional key retain their original stacking.
  if (aKey == null) {
    const delta = (Number.isFinite(a.z) ? a.z : 0) - (Number.isFinite(b.z) ? b.z : 0);
    if (delta) return delta;
  }
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

function sanitize(input, id = input?.id) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof id !== 'string' || !id.trim() || id.length > 100 || !TYPES.has(input.type)) throw new Error('Invalid shared canvas item.');
  if (!finite(input.x, 100000) || !finite(input.y, 100000) || !finite(input.width, 10000) || !finite(input.height, 10000) || input.width <= 0 || input.height <= 0) throw new Error('Invalid shared canvas coordinates.');
  const entity = { id, type: input.type, x: input.x, y: input.y, width: input.width, height: input.height, locked: input.locked ?? false };
  if (typeof entity.locked !== 'boolean') throw new Error('Invalid canvas lock.');
  for (const [field, limit] of Object.entries(STRINGS)) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'string' || input[field].length > limit) throw new Error(`Invalid canvas ${field}.`);
    entity[field] = input[field];
  }
  if (input.z !== undefined) {
    if (!finite(input.z, 1e8)) throw new Error('Invalid canvas layer.');
    entity.z = input.z;
  }
  if (input.orderKey !== undefined) {
    if (!validKey(input.orderKey)) throw new Error('Invalid canvas layer key.');
    entity.orderKey = input.orderKey;
  }
  if (input.fontSize !== undefined) {
    if (!finite(input.fontSize, 200) || input.fontSize < 8) throw new Error('Invalid canvas font size.');
    entity.fontSize = input.fontSize;
  }
  if (input.points !== undefined) {
    if (!Array.isArray(input.points) || input.points.length > 10000 || input.points.some(point => !point || !finite(point.x, 100000) || !finite(point.y, 100000))) throw new Error('Invalid canvas drawing.');
    entity.points = input.points.map(({ x, y }) => ({ x, y }));
  }
  if (input.language !== undefined) {
    if (!['mermaid', 'plantuml'].includes(input.language)) throw new Error('Invalid canvas diagram language.');
    entity.language = input.language;
  }
  if (input.externalConsent !== undefined) {
    if (typeof input.externalConsent !== 'boolean') throw new Error('Invalid external diagram consent.');
    entity.externalConsent = input.externalConsent;
  }
  if (input.url !== undefined) {
    if (typeof input.url !== 'string' || input.url.length > 2 * 1024 * 1024 || !/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(input.url)) throw new Error('Invalid canvas image. Use a supported embedded raster image.');
    entity.url = input.url;
  }
  if (input.updatedAt !== undefined) {
    if (!finite(input.updatedAt, Number.MAX_SAFE_INTEGER)) throw new Error('Invalid canvas timestamp.');
    entity.updatedAt = input.updatedAt;
  }
  return entity;
}

/**
 * Browser-owned, field-level Yjs state. Each item is a nested Y.Map, so a layer
 * change does not overwrite a simultaneous resize or text change from a peer.
 * Item IDs are unique and never reused. Tombstones prevent an in-flight gesture
 * from resurrecting an item that another participant deleted.
 */
export class SharedCanvas {
  constructor({ onChange = () => {}, onDelete = () => {}, onUpdate = () => {}, onInvalid = () => {}, clientId, maxBytes = MAX_CANVAS_BYTES } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_CANVAS_BYTES) throw new RangeError('Canvas byte limit must be between 1 KiB and 16 MiB.');
    this.doc = new Y.Doc();
    if (Number.isInteger(clientId) && clientId > 0 && clientId <= 0xffffffff) this.doc.clientID = clientId;
    this.entities = this.doc.getMap('canvas');
    this.tombstones = this.doc.getMap('canvas-deleted');
    this.onChange = onChange; this.onDelete = onDelete; this.onInvalid = onInvalid;
    this.cache = new Map(); this.bytesById = new Map(); this.totalBytes = 0; this.maxBytes = maxBytes; this.destroyed = false;
    this.entityObserver = events => {
      const ids = new Set();
      for (const event of events) {
        if (event.target === this.entities) for (const id of event.keysChanged) ids.add(id);
        else if (event.path.length) ids.add(event.path[0]);
      }
      this.publish(ids);
    };
    this.deletedObserver = event => this.publish(event.keysChanged);
    this.updateObserver = (update, origin) => onUpdate(update, origin);
    this.entities.observeDeep(this.entityObserver);
    this.tombstones.observe(this.deletedObserver);
    this.doc.on('update', this.updateObserver);
  }

  materialize(id) {
    if (this.tombstones.has(id)) return undefined;
    const record = this.entities.get(id);
    if (!(record instanceof Y.Map)) return undefined;
    // Unknown CRDT fields never reach DOM/SVG renderers.
    const candidate = {};
    for (const [field, value] of record) if (FIELDS.has(field)) candidate[field] = value;
    try { return sanitize(candidate, id); }
    catch (error) { this.onInvalid(error); return undefined; }
  }

  publish(ids) {
    for (const id of ids) {
      const entity = this.materialize(id); const previous = this.cache.get(id);
      if (entity) {
        if (!previous || !same(previous, entity)) {
          const bytes = byteSize(entity);
          this.totalBytes += bytes - (this.bytesById.get(id) || 0);
          this.bytesById.set(id, bytes); this.cache.set(id, entity); this.onChange(copy(entity));
        }
      } else if (previous) {
        this.totalBytes -= this.bytesById.get(id) || 0;
        this.bytesById.delete(id); this.cache.delete(id); this.onDelete(id);
      }
    }
  }

  get(id) { const entity = this.materialize(id); return entity ? copy(entity) : undefined; }
  all() { return [...this.entities.keys()].map(id => this.materialize(id)).filter(Boolean).sort(compareSharedEntities).map(copy); }
  getOrder() { return this.all().map(entity => entity.id); }

  checkBudget(entity, previous) {
    const nextBytes = byteSize(entity); const previousBytes = previous ? byteSize(previous) : 0;
    // Simultaneous peer edits can cross the local budget. Continue allowing
    // shrinking edits and deletions so participants can recover together.
    if (this.totalBytes - previousBytes + nextBytes > this.maxBytes && nextBytes > previousBytes) throw new Error('This canvas is full. Remove a few images or objects before adding more content.');
  }

  /**
   * For a new item, pass the full entity. For edits, pass changedFields when a
   * pointer gesture keeps an old snapshot: only those fields will be written.
   * Prefer patch(id, fields) for move/resize/layer/lock actions.
   */
  setLocal(entity, changedFields) {
    if (this.destroyed || !entity?.id || this.tombstones.has(entity.id)) return false;
    const existing = this.get(entity.id);
    if (existing) return this.patch(entity.id, changedFields ?? entity);
    if (this.entities.has(entity.id) || this.entities.size >= MAX_ENTITIES) return false;
    try {
      const items = this.all();
      const orderKey = generateKeyBetween(items.at(-1)?.orderKey ?? null, null);
      const normalized = sanitize({ ...entity, orderKey });
      this.checkBudget(normalized);
      const record = new Y.Map();
      for (const [field, value] of Object.entries(normalized)) record.set(field, copy(value));
      this.doc.transact(() => this.entities.set(normalized.id, record), 'local');
      return true;
    } catch (error) { this.onInvalid(error); return false; }
  }

  patch(id, fields) {
    if (this.destroyed || !fields || typeof fields !== 'object' || Array.isArray(fields) || this.tombstones.has(id)) return false;
    const current = this.get(id); const record = this.entities.get(id);
    if (!current || !(record instanceof Y.Map)) return false;
    try {
      const candidate = { ...current };
      for (const [field, value] of Object.entries(fields)) if (FIELDS.has(field) && field !== 'id') {
        if (value === undefined) delete candidate[field]; else candidate[field] = value;
      }
      const normalized = sanitize(candidate, id);
      this.checkBudget(normalized, current);
      let changed = false;
      this.doc.transact(() => {
        for (const [field, value] of Object.entries(normalized)) if (!same(current[field], value)) { record.set(field, copy(value)); changed = true; }
        for (const field of Object.keys(current)) if (!(field in normalized)) { record.delete(field); changed = true; }
      }, 'local');
      return changed;
    } catch (error) { this.onInvalid(error); return false; }
  }

  deleteLocal(id) {
    if (this.destroyed || !this.entities.has(id) || this.tombstones.has(id)) return false;
    this.doc.transact(() => { this.tombstones.set(id, true); this.entities.delete(id); }, 'local');
    return true;
  }

  /** Seed only an entirely empty document, after its initial peer sync. */
  replaceInitial(entities) {
    if (this.destroyed || this.entities.size || this.tombstones.size || !Array.isArray(entities) || entities.length > MAX_ENTITIES) return false;
    try {
      const initial = entities.map(entity => sanitize(entity)).sort(compareSharedEntities);
      if (new Set(initial.map(entity => entity.id)).size !== initial.length) throw new Error('Duplicate canvas IDs.');
      const keys = generateNKeysBetween(null, null, initial.length);
      if (initial.reduce((bytes, entity, index) => bytes + byteSize({ ...entity, orderKey: keys[index] }), 0) > this.maxBytes) throw new Error('This canvas is full. Remove a few images or objects before adding more content.');
      this.doc.transact(() => {
        initial.forEach((entity, index) => {
          const record = new Y.Map();
          for (const [field, value] of Object.entries({ ...entity, orderKey: keys[index] })) record.set(field, copy(value));
          this.entities.set(entity.id, record);
        });
      }, 'local');
      return true;
    } catch (error) { this.onInvalid(error); return false; }
  }

  /** Move one item without rewriting other item fields or using numeric z. */
  reorder(id, action) {
    if (this.destroyed || !['front', 'back', 'forward', 'backward'].includes(action)) return false;
    let items = this.all();
    const index = items.findIndex(entity => entity.id === id);
    if (index < 0) return false;
    const destination = action === 'front' ? items.length - 1 : action === 'back' ? 0 : action === 'forward' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
    if (destination === index) return false;
    this.doc.transact(() => {
      const remaining = items.filter(entity => entity.id !== id);
      let before = remaining[destination - 1]?.orderKey ?? null;
      let after = remaining[destination]?.orderKey ?? null;
      // Simultaneous inserts can produce equal fractional keys. Their ID order
      // is deterministic; normalize once when a later move needs that gap.
      if (items.some(entity => !validKey(entity.orderKey) || entity.orderKey.length > 96) || (before != null && after != null && before >= after)) {
        const keys = generateNKeysBetween(null, null, items.length);
        items = items.map((entity, i) => ({ ...entity, orderKey: keys[i] }));
        for (const entity of items) this.entities.get(entity.id).set('orderKey', entity.orderKey);
        const normalized = items.filter(entity => entity.id !== id);
        before = normalized[destination - 1]?.orderKey ?? null;
        after = normalized[destination]?.orderKey ?? null;
      }
      this.entities.get(id).set('orderKey', generateKeyBetween(before, after));
    }, 'local');
    return true;
  }

  applyUpdate(bytes, origin = 'remote') {
    if (this.destroyed || !(bytes instanceof Uint8Array) || bytes.byteLength > MAX_UPDATE_BYTES) { this.onInvalid(new Error('Invalid or oversized canvas update.')); return false; }
    try {
      // Decode first: malformed/truncated packets must not partially integrate.
      Y.decodeUpdate(bytes);
      Y.applyUpdate(this.doc, bytes, origin);
      return true;
    } catch (error) { this.onInvalid(error); return false; }
  }
  encodeState() { return Y.encodeStateAsUpdate(this.doc); }
  encodeStateVector() { return Y.encodeStateVector(this.doc); }
  encodeDiff(vector) { return Y.encodeStateAsUpdate(this.doc, vector); }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.entities.unobserveDeep(this.entityObserver);
    this.tombstones.unobserve(this.deletedObserver);
    this.doc.off('update', this.updateObserver);
    this.doc.destroy(); this.cache.clear(); this.bytesById.clear(); this.totalBytes = 0;
  }
}
