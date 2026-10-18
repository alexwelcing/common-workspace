import initLoro, { LoroDoc, LoroMap, VersionVector } from 'loro-crdt/web';
import wasmUrl from 'loro-crdt/web/loro_wasm_bg.wasm?url';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { compareSharedEntities } from '../shared-canvas.js';
import { restoreAppearance } from '../../lib/room-appearance.mjs';
import { openSpatialStorage } from './storage.js';

const FORMAT = 'common-spatial-archive';
const SCHEMA = 1;
const MAX_BOARDS = 64;
const MAX_ENTITIES = 1000;
const MAX_BOARD_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT = 12 * 1024 * 1024;
const MAX_WORKSPACE_HISTORY = 40 * 1024 * 1024;
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_PACKET = 18 * 1024 * 1024;
const COMPACT_SEGMENTS = 128;
const COMPACT_BYTES = 256 * 1024;
const MAX_PENDING_SEGMENTS = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const TYPES = new Set(['text', 'sticky', 'rectangle', 'ellipse', 'arrow', 'draw', 'image', 'diagram', 'screen']);
const TEXT_FIELDS = { text: 20000, color: 100, fill: 100, source: 20000, title: 200, streamId: 200, screenId: 200, participantId: 200, updatedBy: 200 };
const ENTITY_FIELDS = new Set(['id', 'type', 'x', 'y', 'width', 'height', ...Object.keys(TEXT_FIELDS), 'fontSize', 'z', 'points', 'language', 'externalConsent', 'url', 'updatedAt', 'orderKey', 'locked']);
const POSE_FIELDS = ['x', 'y', 'z', 'rotationX', 'rotationY', 'rotationZ'];
const copy = value => structuredClone(value);
const finite = (value, maximum) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maximum;
const idValid = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const workspaceIdValid = value => typeof value === 'string' && value.length > 0 && value.length <= 250 && ![...value].some(character => character.charCodeAt(0) < 32);
const newId = () => crypto.randomUUID();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let initialization;
function initialize() { return initialization ||= initLoro({ module_or_path: wasmUrl }); }
function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
function unbase64(value, maximum = MAX_DOCUMENT) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('The spatial document contains invalid or oversized binary data.');
  const binary = atob(value);
  if (binary.length > maximum) throw new Error('This spatial document is too large to open.');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
function pack(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > MAX_PACKET) throw new Error('This spatial history is too large to synchronize. Download an archive and start a fresh branch.');
  return bytes;
}
function docKeyValid(id) { return id === 'manifest' || (typeof id === 'string' && id.startsWith('board:') && idValid(id.slice(6))); }
function normalEntity(input) {
  if (!input || typeof input !== 'object' || !idValid(input.id) || !TYPES.has(input.type)) throw new Error('This spatial object has an invalid identity or type.');
  if (!finite(input.x, 100000) || !finite(input.y, 100000) || !finite(input.width, 10000) || !finite(input.height, 10000) || input.width <= 0 || input.height <= 0) throw new Error('This spatial object has invalid coordinates.');
  const result = { id: input.id, type: input.type, x: input.x, y: input.y, width: input.width, height: input.height, locked: input.locked ?? false };
  if (typeof result.locked !== 'boolean') throw new Error('Invalid spatial object lock.');
  for (const [field, maximum] of Object.entries(TEXT_FIELDS)) if (input[field] !== undefined) {
    if (typeof input[field] !== 'string' || input[field].length > maximum) throw new Error(`Invalid spatial object ${field}.`);
    if (['color', 'fill'].includes(field) && !/^(?:#[\da-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d\s.,%+\-/]+\))$/i.test(input[field])) throw new Error('Colors must be a CSS color without URLs or variables.');
    result[field] = input[field];
  }
  for (const [field, maximum, minimum] of [['z', 1e8, -1e8], ['fontSize', 200, 8], ['updatedAt', Number.MAX_SAFE_INTEGER, 0]]) if (input[field] !== undefined) {
    if (!finite(input[field], maximum) || input[field] < minimum) throw new Error(`Invalid spatial object ${field}.`);
    result[field] = input[field];
  }
  if (input.orderKey !== undefined) {
    if (typeof input.orderKey !== 'string' || input.orderKey.length > 128 || !/^[0-9A-Za-z]+$/.test(input.orderKey)) throw new Error('Invalid spatial object layer.');
    try { generateKeyBetween(input.orderKey, null); } catch { throw new Error('Invalid spatial object layer.'); }
    result.orderKey = input.orderKey;
  }
  if (input.points !== undefined) {
    if (!Array.isArray(input.points) || input.points.length > 10000 || input.points.some(point => !point || !finite(point.x, 100000) || !finite(point.y, 100000))) throw new Error('Invalid spatial drawing.');
    result.points = input.points.map(({ x, y }) => ({ x, y }));
  }
  if (input.language !== undefined) {
    if (!['mermaid', 'plantuml'].includes(input.language)) throw new Error('Invalid spatial diagram language.');
    result.language = input.language;
  }
  if (input.externalConsent !== undefined) {
    if (typeof input.externalConsent !== 'boolean') throw new Error('Invalid external diagram consent.');
    result.externalConsent = input.externalConsent;
  }
  if (input.url !== undefined) {
    if (typeof input.url !== 'string' || input.url.length > 2 * 1024 * 1024 || !/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(input.url)) throw new Error('Use an embedded PNG, JPEG, WebP, GIF, or AVIF image.');
    result.url = input.url;
  }
  return result;
}
function normalBoard(input, id = input?.id || newId()) {
  if (!input || typeof input !== 'object' || !idValid(id)) throw new Error('Invalid spatial board.');
  const name = input.name ?? 'Untitled board';
  if (typeof name !== 'string' || name.length > 200) throw new Error('Board names must be at most 200 characters.');
  const pose = {};
  for (const key of POSE_FIELDS) {
    const value = input.pose?.[key] ?? 0;
    if (!finite(value, key.startsWith('rotation') ? 36000 : 100000)) throw new Error('Invalid board position or rotation.');
    pose[key] = value;
  }
  const width = input.width ?? 1200, height = input.height ?? 800;
  if (!finite(width, 10000) || !finite(height, 10000) || width < 100 || height < 100) throw new Error('Board dimensions must be between 100 and 10,000.');
  return { id, name, pose, width, height };
}
function normalObjects(data = {}, expectedId) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['entities', 'deleted', 'board'].includes(key))) throw new Error('Invalid spatial board document.');
  if (data.board !== undefined && (!data.board || typeof data.board !== 'object' || Array.isArray(data.board) || (data.board.id !== undefined && data.board.id !== expectedId))) throw new Error('The board document has an invalid identity.');
  const entities = data.entities ?? {}, deleted = data.deleted ?? {};
  if (!entities || typeof entities !== 'object' || Array.isArray(entities) || Object.keys(entities).length > MAX_ENTITIES) throw new Error('A board exceeds the 1,000-object beta limit.');
  if (!deleted || typeof deleted !== 'object' || Array.isArray(deleted) || Object.keys(deleted).length > MAX_ENTITIES || Object.entries(deleted).some(([id, value]) => !idValid(id) || value !== true)) throw new Error('Invalid spatial object deletion history.');
  const objects = []; let bytes = 0;
  for (const [id, value] of Object.entries(entities)) {
    const entity = normalEntity({ ...value, id });
    if (deleted[id]) continue;
    bytes += encoder.encode(JSON.stringify(entity)).byteLength;
    if (bytes > MAX_BOARD_BYTES) throw new Error('A board exceeds the 16 MiB content limit. Move some images to another board.');
    objects.push(entity);
  }
  return objects.sort(compareSharedEntities);
}
function normalState(manifest, documents, { historical = false } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).some(key => !['boards', 'room'].includes(key))) throw new Error('Invalid spatial room manifest.');
  const boardRecords = manifest.boards ?? {};
  if (!boardRecords || typeof boardRecords !== 'object' || Array.isArray(boardRecords) || Object.keys(boardRecords).length > MAX_BOARDS) throw new Error('This workspace exceeds the 64-board beta limit.');
  const boards = [];
  for (const [id, raw] of Object.entries(boardRecords)) {
    const board = normalBoard(raw, id);
    if (raw.deleted !== undefined && typeof raw.deleted !== 'boolean') throw new Error('Invalid spatial board deletion history.');
    if (raw.deleted) continue;
    board.objects = normalObjects(documents.get(`board:${id}`)?.toJSON() || {}, id);
    if (historical) for (const entity of board.objects) if (entity.type === 'screen') entity.historical = true;
    boards.push(board);
  }
  const room = manifest.room ?? {};
  if (!room || typeof room !== 'object' || Array.isArray(room) || (room.title !== undefined && (typeof room.title !== 'string' || room.title.length > 200))) throw new Error('Invalid workspace title.');
  return { title: room.title || 'Spatial workspace', appearance: restoreAppearance(room.appearance), boards };
}
function configure(doc) { doc.setRecordTimestamp(true); doc.setChangeMergeInterval(0); return doc; }
function metadata(change) {
  try {
    const value = JSON.parse(change.message || '{}');
    if (idValid(value.action) && finite(value.at, Number.MAX_SAFE_INTEGER) && typeof value.label === 'string' && value.label.length <= 200
      && (value.requires === undefined || (Array.isArray(value.requires) && value.requires.length <= 4096 && value.requires.every(idValid)))) {
      return { action: value.action, at: value.at, label: value.label, requires: value.requires || [], ...(typeof value.actor === 'string' ? { actor: value.actor.slice(0, 200) } : {}) };
    }
  } catch { /* An older peer can supply a plain commit message. */ }
  return { action: `${change.peer}-${change.counter}`, at: change.timestamp * 1000, label: 'Workspace updated' };
}

/** Validate an archive before opening it. Opening preserves its complete automatic history. */
export function parseSpatialArchive(input) {
  let value;
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length > MAX_ARCHIVE) throw new Error('Spatial archives must be smaller than 64 MiB.');
    value = JSON.parse(decoder.decode(bytes));
  } else if (typeof input === 'string') {
    if (encoder.encode(input).length > MAX_ARCHIVE) throw new Error('Spatial archives must be smaller than 64 MiB.');
    value = JSON.parse(input);
  } else value = input;
  if (!value || value.format !== FORMAT || value.version !== SCHEMA || !Array.isArray(value.documents) || value.documents.length > MAX_BOARDS + 1 || !value.documents.some(document => document.id === 'manifest')) throw new Error('This is not a supported Common spatial archive.');
  const ids = new Set();
  const documents = value.documents.map(document => {
    if (!document || !docKeyValid(document.id) || ids.has(document.id)) throw new Error('The spatial archive contains an invalid or repeated document.');
    ids.add(document.id);
    const bytes = document.bytes instanceof Uint8Array ? document.bytes.slice() : unbase64(document.data);
    if (bytes.byteLength > MAX_DOCUMENT) throw new Error('This spatial document is too large to open.');
    return { id: document.id, bytes };
  });
  if (documents.reduce((sum, document) => sum + document.bytes.length, 0) > MAX_ARCHIVE) throw new Error('This spatial archive is too large.');
  return { format: FORMAT, version: SCHEMA, documents };
}

export async function createSpatialStore(options = {}) {
  await initialize();
  const store = new SpatialStore(options);
  await store.open(options);
  return store;
}

class SpatialStore {
  constructor({ id = newId(), onChange = () => {}, onStatus = () => {}, onUpdate = () => {}, actor = '' } = {}) {
    if (!workspaceIdValid(id)) throw new Error('Invalid spatial workspace identity.');
    this.id = id; this.actor = typeof actor === 'string' ? actor.slice(0, 200) : '';
    this.onChange = onChange; this.onStatus = onStatus; this.onUpdate = onUpdate;
    this.documents = new Map(); this.dirty = new Set(); this.destroyed = false;
    this.pendingUpdates = new Map(); this.pendingBytes = 0; this.forceSnapshot = new Set();
    this.documentSizes = new Map(); this.knownSnapshots = new Map(); this.knownSegments = new Map();
    this.saveTimer = null; this.saving = Promise.resolve(); this.historyCache = null; this.causalCache = null; this.pastCache = new Map(); this.generation = 0;
  }
  async open({ seed, archive, storage } = {}) {
    try { this.storage = storage || await openSpatialStorage(); }
    catch (error) { this.storage = null; this.status('memory', error.message, error); }
    let saved;
    try { saved = await this.storage?.load(this.id); }
    catch (error) { this.status('error', 'Your earlier workspace could not be read. Download an archive before leaving this tab.', error); throw error; }
    const incoming = archive ? parseSpatialArchive(archive) : saved;
    if (incoming) {
      try {
        for (const { id, bytes, token, segments = [] } of incoming.documents) {
          const parts = [...(bytes ? [bytes] : []), ...segments.map(segment => segment.bytes)];
          if (!docKeyValid(id) || parts.length > MAX_PENDING_SEGMENTS + 1 || parts.some(part => !(part instanceof Uint8Array) || part.byteLength > MAX_DOCUMENT)) throw new Error('The saved workspace contains an invalid document.');
          const doc = configure(new LoroDoc());
          let size;
          try {
            const result = doc.importBatch(parts);
            if (result.pending?.size) throw new Error('The saved workspace is missing earlier edits.');
            if (id !== 'manifest') normalObjects(doc.toJSON(), id.slice(6));
            size = doc.export({ mode: 'snapshot' }).length; this.checkHistorySizes(new Map([[id, size]]));
          }
          catch (error) { doc.free(); throw error; }
          this.documents.set(id, doc); this.documentSizes.set(id, size);
          if (!archive) {
            if (bytes) this.knownSnapshots.set(id, token || 'legacy');
            this.knownSegments.set(id, new Set(segments.map(segment => segment.id)));
          }
        }
        if (!this.documents.has('manifest')) throw new Error('The saved workspace has no room manifest.');
        this.state();
      } catch (error) { this.destroy(); throw error; }
      if (archive) { for (const id of this.documents.keys()) { this.dirty.add(id); this.forceSnapshot.add(id); } this.scheduleSave(); }
      else this.status('saved', 'Saved on this device');
    } else {
      this.documents.set('manifest', configure(new LoroDoc()));
      this.documentSizes.set('manifest', this.manifest().export({ mode: 'snapshot' }).length);
      if (seed?.boards?.length > MAX_BOARDS) throw new Error('This workspace exceeds the 64-board beta limit.');
      if (!seed?.empty) {
        this.updateRoom({ title: seed?.title || 'Spatial workspace', appearance: seed?.appearance });
        for (const board of seed?.boards || [{ name: 'Main board' }]) this.addBoard(board);
      }
    }
    this.tabId = newId();
    if (globalThis.BroadcastChannel) {
      this.channel = new BroadcastChannel(`common-spatial:${this.id}`);
      this.channel.onmessage = ({ data }) => {
        if (!data || data.from === this.tabId || (data.to && data.to !== this.tabId) || !(data.bytes instanceof Uint8Array)) return;
        this.receive(data.bytes, `tab:${data.from}`, bytes => this.channel?.postMessage({ from: this.tabId, to: data.from, bytes }));
      };
      this.channel.postMessage({ from: this.tabId, bytes: this.encodeSync() });
    }
    this.pageHide = () => { this.flush().catch(() => {}); };
    globalThis.addEventListener?.('pagehide', this.pageHide);
    return this;
  }
  status(state, message, error) { this.onStatus({ state, message, ...(error ? { error } : {}) }); }
  requireLive() { if (this.destroyed) throw new Error('This spatial workspace is closed.'); }
  manifest() { return this.documents.get('manifest'); }
  boardDocument(id) {
    if (!idValid(id) || !this.manifest().getMap('boards').get(id) || this.manifest().getMap('boards').get(id).get('deleted')) throw new Error('This board is no longer available.');
    const key = `board:${id}`;
    if (!this.documents.has(key)) this.documents.set(key, configure(new LoroDoc()));
    return this.documents.get(key);
  }
  beginGroup(label = 'Arranged objects') {
    this.requireLive();
    this.group = { action: newId(), at: Date.now(), label: String(label).slice(0, 200), requires: this.observedActions(), ...(this.actor ? { actor: this.actor } : {}) };
  }
  endGroup() { this.group = null; }
  observedActions() {
    const actions = new Set();
    for (const doc of this.documents.values()) for (const frontier of doc.oplogFrontiers()) actions.add(metadata(doc.getChangeAt(frontier)).action);
    if (actions.size > 4096) throw new Error('This workspace has too many concurrent history branches. Synchronize teammates before continuing.');
    return [...actions].sort();
  }
  emitUpdate(bytes, origin) {
    this.onUpdate(bytes, origin);
    if (!String(origin || '').startsWith('tab:')) this.channel?.postMessage({ from: this.tabId, bytes });
  }
  checkHistorySizes(replacements) {
    for (const size of replacements.values()) if (size > MAX_DOCUMENT) throw new Error('This board history exceeds the 12 MiB beta limit. Download an archive and continue in a fresh branch.');
    const total = [...this.documentSizes].reduce((sum, [id, size]) => sum + (replacements.has(id) ? 0 : size), 0) + [...replacements.values()].reduce((sum, size) => sum + size, 0);
    if (total > MAX_WORKSPACE_HISTORY) throw new Error('This workspace history exceeds the 40 MiB beta limit. Download an archive and continue in a fresh branch.');
  }
  queueUpdate(id, bytes) {
    if (!this.pendingUpdates.has(id)) this.pendingUpdates.set(id, new Map());
    let entries = this.pendingUpdates.get(id);
    const documentBytes = [...entries.values()].reduce((sum, update) => sum + update.bytes.length, 0);
    if (documentBytes + bytes.length > MAX_DOCUMENT || entries.size >= MAX_PENDING_SEGMENTS || this.pendingBytes + bytes.length > MAX_ARCHIVE) {
      // A quota outage must not allow an unbounded second copy of the history
      // to build up in the autosave queue. A full-history segment can replace
      // its own earlier deltas without losing their operations.
      const snapshot = this.documents.get(id).export({ mode: 'snapshot' });
      this.pendingBytes -= documentBytes; entries.clear();
      if (snapshot.length > MAX_DOCUMENT || this.pendingBytes + snapshot.length > MAX_ARCHIVE) {
        this.forceSnapshot.add(id);
        this.status('error', 'Unsaved history exceeds the beta memory limit. Download an archive before continuing.');
        return;
      }
      bytes = snapshot;
    }
    const update = { id: newId(), document: id, bytes };
    entries.set(update.id, update); this.pendingBytes += bytes.length;
  }
  commit(ids, label, action) {
    this.requireLive();
    const before = new Map(), backups = new Map(), updates = [], sizes = new Map();
    try {
      const at = Date.now();
      const message = JSON.stringify(this.group || { action: newId(), at, label, requires: this.observedActions(), ...(this.actor ? { actor: this.actor } : {}) });
      for (const id of ids) { before.set(id, this.documents.get(id).oplogVersion()); backups.set(id, configure(this.documents.get(id).fork())); }
      action();
      for (const id of ids) {
        const doc = this.documents.get(id); doc.commit({ timestamp: Math.floor(at / 1000), message });
        const version = doc.oplogVersion();
        const same = before.get(id).compare(version) === 0; version.free();
        if (same) continue;
        sizes.set(id, doc.export({ mode: 'snapshot' }).length);
        updates.push({ id, bytes: doc.export({ mode: 'update', from: before.get(id) }) });
      }
      this.checkHistorySizes(sizes);
    } catch (error) {
      // Roll back both document state and operation history before publishing.
      // The backups share history internally until a write diverges.
      for (const [id, backup] of backups) { this.documents.get(id).free(); this.documents.set(id, backup); }
      backups.clear(); throw error;
    } finally { for (const vector of before.values()) vector.free(); for (const backup of backups.values()) backup.free(); }
    for (const [id, size] of sizes) this.documentSizes.set(id, size);
    for (const update of updates) {
      this.dirty.add(update.id); this.queueUpdate(update.id, update.bytes);
      try { this.emitUpdate(pack({ version: SCHEMA, kind: 'update', id: update.id, data: base64(update.bytes) })); }
      catch (error) { this.status('error', error.message, error); }
    }
    if (updates.length) this.changed();
    return !!updates.length;
  }
  changed() {
    this.generation++; this.historyCache = null; this.causalCache = null; this.pastCache.clear();
    this.scheduleSave(); this.onChange();
  }
  scheduleSave() {
    if (this.destroyed) return;
    clearTimeout(this.saveTimer); this.status(this.storage ? 'saving' : 'memory', this.storage ? 'Saving on this device…' : 'Not saved: download an archive before leaving');
    this.saveTimer = setTimeout(() => { this.flush().catch(() => {}); }, 350);
  }
  async flush() {
    if (this.destroyed && !this.dirty.size) return;
    clearTimeout(this.saveTimer); this.saveTimer = null;
    const runLocked = async () => {
      if (!this.dirty.size) return;
      if (!this.storage) { const error = new Error('Browser storage is unavailable. Download an archive before leaving this tab.'); this.status('memory', error.message, error); throw error; }
      // Merge before writing so a previously suspended tab cannot replace
      // another tab's newer history. Importing persisted segments is idempotent.
      const stored = await this.storage.load(this.id);
      const previous = new Map((stored?.documents || []).map(document => [document.id, document]));
      for (const document of previous.values()) {
        const known = this.knownSegments.get(document.id) || new Set();
        const unseen = (document.segments || []).filter(segment => !known.has(segment.id));
        const newSnapshot = document.bytes && this.knownSnapshots.get(document.id) !== (document.token || 'legacy');
        const parts = [...(newSnapshot ? [document.bytes] : []), ...unseen.map(segment => segment.bytes)];
        if (parts.length) {
          const candidate = this.documents.get(document.id)?.fork() || configure(new LoroDoc());
          try {
            const result = candidate.importBatch(parts);
            if (result.pending?.size || !this.receive(pack({ version: SCHEMA, kind: 'update', id: document.id, data: base64(candidate.export({ mode: 'snapshot' })) }), 'storage', () => {}, true)) throw new Error('An earlier saved spatial edit could not be read.');
          } finally { candidate.free(); }
        }
        if (document.bytes) this.knownSnapshots.set(document.id, document.token || 'legacy');
        this.knownSegments.set(document.id, new Set((document.segments || []).map(segment => segment.id)));
      }
      const dirty = [...this.dirty], generation = this.generation;
      const queued = [...this.pendingUpdates.values()].flatMap(entries => [...entries.values()]);
      const documents = [], removeSegments = [];
      let workspaceBytes = [...previous.values()].reduce((sum, document) => sum + (document.bytes?.length || 0) + (document.segments || []).reduce((count, segment) => count + segment.bytes.length, 0), 0);
      for (const id of dirty) {
        const previousDocument = previous.get(id), segments = previousDocument?.segments || [];
        const updates = queued.filter(update => update.document === id);
        const journalBytes = segments.reduce((sum, segment) => sum + segment.bytes.length, 0) + updates.reduce((sum, update) => sum + update.bytes.length, 0);
        if (!previousDocument?.bytes || this.forceSnapshot.has(id) || segments.length + updates.length >= COMPACT_SEGMENTS || journalBytes >= COMPACT_BYTES) {
          const bytes = this.documents.get(id).export({ mode: 'snapshot' });
          if (bytes.length > MAX_DOCUMENT) throw new Error('This board history exceeds the beta storage limit. Download an archive and continue in a fresh branch.');
          documents.push({ id, bytes, token: newId() });
          removeSegments.push(...segments.map(segment => ({ document: id, id: segment.id })));
          workspaceBytes += bytes.length - (previousDocument?.bytes?.length || 0) - segments.reduce((sum, segment) => sum + segment.bytes.length, 0);
        }
      }
      workspaceBytes += queued.reduce((sum, update) => sum + update.bytes.length, 0);
      if (workspaceBytes > MAX_ARCHIVE) throw new Error('This autosaved workspace exceeds the 64 MiB beta limit. Download an archive and continue in a fresh branch.');
      await this.storage.save(this.id, { metadata: { version: SCHEMA, title: this.manifest().getMap('room').get('title') || 'Spatial workspace', updatedAt: Date.now() }, documents, updates: queued, removeSegments });
      for (const document of documents) this.knownSnapshots.set(document.id, document.token);
      for (const segment of removeSegments) this.knownSegments.get(segment.document)?.delete(segment.id);
      for (const update of queued) {
        if (!this.knownSegments.has(update.document)) this.knownSegments.set(update.document, new Set());
        this.knownSegments.get(update.document).add(update.id);
        const entries = this.pendingUpdates.get(update.document);
        if (entries?.delete(update.id)) this.pendingBytes -= update.bytes.length;
        if (!entries?.size) this.pendingUpdates.delete(update.document);
      }
      if (generation === this.generation) for (const document of documents) this.forceSnapshot.delete(document.id);
      // Changes arriving during the transaction remain dirty for the next save.
      if (generation === this.generation) for (const id of dirty) this.dirty.delete(id);
      this.status(this.dirty.size ? 'saving' : 'saved', this.dirty.size ? 'Saving on this device…' : 'Saved on this device');
    };
    const run = async () => {
      try {
        return await (globalThis.navigator?.locks?.request
          ? navigator.locks.request(`common-spatial:${this.id}`, { mode: 'exclusive' }, runLocked)
          : runLocked());
      } catch (error) {
        this.status('error', 'Autosave failed. Keep this tab open and download an archive before leaving.', error); throw error;
      }
    };
    const pending = this.saving.catch(() => {}).then(run); this.saving = pending;
    return pending;
  }
  updateRoom(patch = {}) {
    const room = this.manifest().getMap('room');
    const value = {};
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string' || patch.title.length > 200) throw new Error('Workspace titles must be at most 200 characters.');
      value.title = patch.title;
    }
    if (patch.appearance !== undefined) value.appearance = restoreAppearance(patch.appearance);
    if (!Object.keys(value).some(key => !equal(room.get(key), value[key]))) return false;
    return this.commit(['manifest'], 'Changed workspace style', () => { for (const [key, item] of Object.entries(value)) room.set(key, item); });
  }
  addBoard(value = {}) {
    if (this.manifest().getMap('boards').keys().length >= MAX_BOARDS) throw new Error('The spatial beta supports up to 64 boards per workspace.');
    const id = idValid(value.id) ? value.id : newId();
    if (this.manifest().getMap('boards').get(id)) throw new Error('This board already exists.');
    const board = normalBoard(value, id);
    const objects = (value.objects || []).map(entity => normalEntity({ ...entity, id: entity.id || newId() }));
    if (objects.reduce((sum, entity) => sum + encoder.encode(JSON.stringify(entity)).byteLength, 0) > MAX_BOARD_BYTES) throw new Error('A board exceeds the 16 MiB content limit.');
    if (objects.length > MAX_ENTITIES || new Set(objects.map(entity => entity.id)).size !== objects.length) throw new Error('This board has too many or repeated objects.');
    const keys = generateNKeysBetween(null, null, objects.length);
    const docId = `board:${id}`, doc = configure(new LoroDoc()); this.documents.set(docId, doc);
    try { this.commit(['manifest', docId], `Added ${board.name}`, () => {
      const record = this.manifest().getMap('boards').setContainer(id, new LoroMap());
      for (const [key, item] of Object.entries({ name: board.name, width: board.width, height: board.height, ...board.pose })) record.set(key, item);
      // Even an empty board has a birth operation. Its later changes can
      // therefore carry the manifest creation through causal replay.
      doc.getMap('board').set('id', id);
      const entities = doc.getMap('entities');
      for (const [index, entity] of objects.entries()) {
        const record = entities.setContainer(entity.id, new LoroMap());
        for (const [key, item] of Object.entries({ ...entity, orderKey: keys[index] })) record.set(key, item);
      }
    }); } catch (error) { this.documents.get(docId)?.free(); this.documents.delete(docId); this.documentSizes.delete(docId); throw error; }
    return id;
  }
  updateBoard(id, patch = {}) {
    const current = this.state().boards.find(board => board.id === id);
    if (!current) throw new Error('This board is no longer available.');
    const board = normalBoard({ ...current, ...patch, pose: { ...current.pose, ...patch.pose } }, id);
    const record = this.manifest().getMap('boards').get(id);
    const changes = { name: board.name, width: board.width, height: board.height, ...board.pose };
    if (!Object.keys(changes).some(key => !equal(record.get(key), changes[key]))) return false;
    return this.commit(['manifest'], patch.name !== undefined ? 'Renamed board' : 'Moved board in space', () => {
      for (const [key, value] of Object.entries(changes)) if (!equal(record.get(key), value)) record.set(key, value);
    });
  }
  removeBoard(id) {
    const record = this.manifest().getMap('boards').get(id);
    if (!(record instanceof LoroMap) || record.get('deleted')) return false;
    return this.commit(['manifest'], 'Removed board', () => record.set('deleted', true));
  }
  setEntity(boardId, input, changedFields) {
    const doc = this.boardDocument(boardId), entities = doc.getMap('entities');
    if (!idValid(input?.id)) throw new Error('Invalid spatial object identity.');
    if (doc.getMap('deleted').get(input.id)) return false;
    let record = entities.get(input.id);
    if (record && !(record instanceof LoroMap)) throw new Error('Invalid spatial object record.');
    const previous = record?.toJSON();
    const fields = changedFields ? [...new Set(changedFields)].filter(field => ENTITY_FIELDS.has(field) && field !== 'id') : Object.keys(input).filter(field => ENTITY_FIELDS.has(field));
    const candidate = previous ? { ...previous } : { ...input };
    for (const field of fields) if (input[field] !== undefined) candidate[field] = input[field];
    if (!previous) {
      if (entities.keys().length >= MAX_ENTITIES) throw new Error('This board has reached its 1,000-object beta limit.');
      const all = this.state().boards.find(board => board.id === boardId)?.objects || [];
      candidate.orderKey ||= generateKeyBetween(all.at(-1)?.orderKey ?? null, null);
    }
    const entity = normalEntity(candidate);
    const currentObjects = this.state().boards.find(board => board.id === boardId)?.objects || [];
    if (currentObjects.reduce((sum, item) => sum + (item.id === entity.id ? 0 : encoder.encode(JSON.stringify(item)).byteLength), encoder.encode(JSON.stringify(entity)).byteLength) > MAX_BOARD_BYTES) throw new Error('This board is full. Move some images to another board.');
    const updates = previous ? fields.filter(field => !equal(previous[field], entity[field])) : Object.keys(entity);
    if (!updates.length) return false;
    const label = !previous ? `Added ${entity.type === 'sticky' ? 'note' : entity.type}` : updates.some(field => ['text', 'source', 'title'].includes(field)) ? 'Edited writing' : updates.some(field => ['x', 'y', 'width', 'height', 'points'].includes(field)) ? 'Arranged objects' : 'Styled object';
    return this.commit([`board:${boardId}`], label, () => {
      if (!record) record = entities.setContainer(entity.id, new LoroMap());
      for (const field of updates) if (entity[field] !== undefined) record.set(field, entity[field]);
    });
  }
  deleteEntity(boardId, id) {
    const doc = this.boardDocument(boardId);
    if (!doc.getMap('entities').get(id) || doc.getMap('deleted').get(id)) return false;
    return this.commit([`board:${boardId}`], 'Removed object', () => doc.getMap('deleted').set(id, true));
  }
  reorderEntity(boardId, id, position) {
    const objects = this.state().boards.find(board => board.id === boardId)?.objects || [];
    const index = objects.findIndex(entity => entity.id === id);
    if (index < 0) return false;
    const entity = objects[index], rest = objects.filter(item => item.id !== id);
    const destination = position === 'front' ? rest.length : position === 'back' ? 0 : position === 'forward' ? Math.min(rest.length, index + 1) : position === 'backward' ? Math.max(0, index - 1) : Math.max(0, Math.min(rest.length, Math.floor(position)));
    if (!Number.isFinite(destination)) throw new Error('Invalid object layer.');
    if (index === destination) return false;
    return this.setEntity(boardId, { ...entity, orderKey: generateKeyBetween(rest[destination - 1]?.orderKey ?? null, rest[destination]?.orderKey ?? null) }, ['orderKey']);
  }
  changes() {
    const changes = [];
    for (const [docId, doc] of this.documents) for (const records of doc.getAllChanges().values()) for (const change of records) changes.push({ ...change, docId, ...metadata(change) });
    // Lamport order preserves dependencies inside each document. Device time is
    // the presentation coordinate; a causal closure is applied during replay.
    return changes.sort((a, b) => a.at - b.at || a.lamport - b.lamport || (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : a.counter - b.counter) || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
  }
  causalHistory() {
    if (this.causalCache) return this.causalCache;
    const changes = this.changes(), groups = new Map(), streams = new Map();
    for (const change of changes) {
      if (!groups.has(change.action)) groups.set(change.action, { id: change.action, at: change.at, label: change.label, actor: change.actor, requires: new Set(), following: new Set(), changes: [] });
      const group = groups.get(change.action); group.changes.push(change);
      for (const id of change.requires || []) if (id !== group.id) group.requires.add(id);
      const key = `${change.docId}/${change.peer}`;
      if (!streams.has(key)) streams.set(key, []);
      streams.get(key).push(change);
    }
    for (const stream of streams.values()) {
      stream.sort((a, b) => a.counter - b.counter);
      for (let index = 1; index < stream.length; index++) if (stream[index - 1].action !== stream[index].action) groups.get(stream[index].action).requires.add(stream[index - 1].action);
    }
    for (const change of changes) for (const dependency of change.deps) {
      const stream = streams.get(`${change.docId}/${dependency.peer}`) || [];
      let low = 0, high = stream.length;
      while (low < high) { const middle = (low + high) >>> 1; if (stream[middle].counter <= dependency.counter) low = middle + 1; else high = middle; }
      const match = stream[low - 1];
      const prior = match && match.counter + match.length > dependency.counter ? match : null;
      if (prior && prior.action !== change.action) groups.get(change.action).requires.add(prior.action);
    }
    for (const group of groups.values()) for (const id of group.requires) {
      if (groups.has(id)) groups.get(id).following.add(group.id);
      else group.requires.delete(id); // A partial transfer can fill this on its next sync.
    }
    const compare = (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const indegree = new Map([...groups.values()].map(group => [group.id, group.requires.size]));
    const ready = [...groups.values()].filter(group => !indegree.get(group.id)).sort(compare), ordered = [];
    while (ready.length) {
      const group = ready.shift(); ordered.push(group);
      for (const id of group.following) {
        indegree.set(id, indegree.get(id) - 1);
        if (indegree.get(id) === 0) {
          const next = groups.get(id);
          let low = 0, high = ready.length;
          while (low < high) { const middle = (low + high) >>> 1; if (compare(ready[middle], next) <= 0) low = middle + 1; else high = middle; }
          ready.splice(low, 0, next);
        }
      }
    }
    // Old grouped archives can contain a collapsed concurrent-action cycle.
    // Preserve those actions deterministically rather than dropping history.
    if (ordered.length !== groups.size) {
      const seen = new Set(ordered.map(group => group.id));
      ordered.push(...[...groups.values()].filter(group => !seen.has(group.id)).sort(compare));
    }
    this.causalCache = { changes, groups, ordered };
    return this.causalCache;
  }
  revisions() {
    if (!this.historyCache) this.historyCache = this.causalHistory().ordered.map(group => ({ id: group.id, at: group.at, label: group.label, ...(group.actor ? { actor: group.actor } : {}) }));
    return copy(this.historyCache);
  }
  state(revisionId = null) {
    this.requireLive();
    if (revisionId === null) {
      const raw = this.manifest().toJSON();
      for (const value of Object.values(raw.boards || {})) if (value && typeof value === 'object') value.pose = Object.fromEntries(POSE_FIELDS.map(key => [key, value[key] ?? 0]));
      return normalState(raw, this.documents);
    }
    if (this.pastCache.has(revisionId)) return copy(this.pastCache.get(revisionId));
    const revisions = this.revisions(), index = revisions.findIndex(revision => revision.id === revisionId);
    if (index < 0) throw new Error('This point in history is no longer available.');
    const included = new Set(revisions.slice(0, index + 1).map(revision => revision.id));
    const { groups, changes: allChanges } = this.causalHistory();
    const pending = [...included];
    while (pending.length) for (const dependency of groups.get(pending.pop())?.requires || []) if (!included.has(dependency)) { included.add(dependency); pending.push(dependency); }
    const documents = new Map();
    try {
      for (const [docId, doc] of this.documents) {
        const changes = allChanges.filter(change => change.docId === docId);
        const chosen = changes.filter(change => included.has(change.action));
        const vv = new VersionVector();
        for (const change of chosen) if ((vv.get(change.peer) ?? 0) < change.counter + change.length) vv.setEnd({ peer: change.peer, counter: change.counter + change.length });
        const past = doc.forkAt(doc.vvToFrontiers(vv)); vv.free(); documents.set(docId, past);
      }
      const raw = documents.get('manifest').toJSON();
      for (const value of Object.values(raw.boards || {})) if (value && typeof value === 'object') value.pose = Object.fromEntries(POSE_FIELDS.map(key => [key, value[key] ?? 0]));
      const state = normalState(raw, documents, { historical: true });
      if (this.pastCache.size >= 8) this.pastCache.delete(this.pastCache.keys().next().value);
      this.pastCache.set(revisionId, state);
      return copy(state);
    } finally { for (const doc of documents.values()) doc.free(); }
  }
  fork(revisionId = null, { id = newId() } = {}) {
    if (!workspaceIdValid(id)) throw new Error('Invalid branch identity.');
    const state = this.state(revisionId);
    return { ...state, id, title: `${state.title} · branch`, boards: state.boards.map(board => ({ ...board, id: newId(), objects: board.objects.filter(entity => entity.type !== 'screen').map(entity => ({ ...entity, id: newId() })) })) };
  }
  exportReplayData() {
    this.requireLive();
    const documents = [...this.documents].map(([id, doc]) => ({ id, bytes: doc.export({ mode: 'snapshot' }) }));
    this.checkHistorySizes(new Map(documents.map(document => [document.id, document.bytes.length])));
    return { format: FORMAT, version: SCHEMA, documents };
  }
  exportArchive() {
    this.requireLive();
    const bytes = encoder.encode(JSON.stringify({ format: FORMAT, version: SCHEMA, exportedAt: new Date().toISOString(), documents: [...this.documents].map(([id, doc]) => ({ id, data: base64(doc.export({ mode: 'snapshot' })) })) }));
    if (bytes.length > MAX_ARCHIVE) throw new Error('This workspace exceeds the 64 MiB archive limit. Branch smaller groups of boards before exporting.');
    return bytes;
  }
  encodeSync() {
    this.requireLive();
    return pack({ version: SCHEMA, kind: 'sync', documents: [...this.documents].map(([id, doc]) => {
      const vv = doc.oplogVersion(); const vector = base64(vv.encode()); vv.free(); return { id, vector };
    }) });
  }
  receive(bytes, peerId, reply = () => {}, savingMerge = false) {
    if ((this.destroyed && !savingMerge) || !(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > MAX_PACKET) return false;
    try {
      const value = JSON.parse(decoder.decode(bytes));
      if (!value || value.version !== SCHEMA) return false;
      if (value.kind === 'sync') {
        if (!Array.isArray(value.documents) || value.documents.length > MAX_BOARDS + 1) return false;
        const remote = new Map();
        try {
          for (const item of value.documents) {
            if (!item || !docKeyValid(item.id) || remote.has(item.id)) return false;
            remote.set(item.id, VersionVector.decode(unbase64(item.vector, 65536)));
          }
          for (const [id, doc] of this.documents) {
            const from = remote.get(id) || new VersionVector();
            try {
              const current = doc.oplogVersion(); const same = from.compare(current) === 0; current.free();
              if (!same) reply(pack({ version: SCHEMA, kind: 'update', id, data: base64(doc.export({ mode: 'update', from })) }));
            } finally { if (!remote.has(id)) from.free(); }
          }
        } finally { for (const vv of remote.values()) vv.free(); }
        return true;
      }
      if (value.kind !== 'update' || !docKeyValid(value.id)) return false;
      if (!this.documents.has(value.id) && this.documents.size >= MAX_BOARDS + 1) return false;
      const update = unbase64(value.data);
      const original = this.documents.get(value.id);
      const candidate = original ? original.fork() : configure(new LoroDoc());
      let candidateSize;
      try {
        const result = candidate.import(update);
        if (result.pending?.size) { candidate.free(); try { if (!savingMerge) reply(this.encodeSync()); } catch { /* Periodic sync also requests missing dependencies. */ } return false; }
        if (value.id !== 'manifest') normalObjects(candidate.toJSON(), value.id.slice(6));
        const candidateDocuments = new Map(this.documents); candidateDocuments.set(value.id, candidate);
        if (value.id === 'manifest' || this.manifest()) {
          const raw = candidateDocuments.get('manifest').toJSON();
          for (const item of Object.values(raw.boards || {})) if (item && typeof item === 'object') item.pose = Object.fromEntries(POSE_FIELDS.map(key => [key, item[key] ?? 0]));
          normalState(raw, candidateDocuments);
        }
        candidateSize = candidate.export({ mode: 'snapshot' }).byteLength;
        this.checkHistorySizes(new Map([[value.id, candidateSize]]));
      } catch (error) { candidate.free(); throw error; }
      if (original) {
        const before = original.oplogVersion();
        original.import(update);
        const after = original.oplogVersion(), changed = before.compare(after) !== 0; before.free(); after.free(); candidate.free();
        if (!changed) return true;
      } else this.documents.set(value.id, candidate);
      this.documentSizes.set(value.id, candidateSize);
      // A remote action can depend on the current gesture. Continuing under
      // the same action ID would create a cycle in the grouped timeline.
      if (this.group) this.group = { ...this.group, action: newId(), at: Date.now(), requires: this.observedActions() };
      this.dirty.add(value.id);
      if (peerId !== 'storage') this.queueUpdate(value.id, update);
      this.changed(); this.emitUpdate(bytes, peerId);
      return true;
    } catch (error) { this.status('error', `A spatial update could not be read. ${error.message}`, error); return false; }
  }
  destroy() {
    if (this.destroyed) return;
    clearTimeout(this.saveTimer); globalThis.removeEventListener?.('pagehide', this.pageHide);
    this.channel?.close(); this.channel = null;
    // Callers should await flush before switching workspaces. This final attempt
    // also preserves edits when teardown occurs through an embedded host.
    const saving = this.flush().catch(() => {});
    this.destroyed = true;
    saving.finally(() => { for (const doc of this.documents.values()) doc.free(); this.documents.clear(); this.storage?.close?.(); });
    this.onChange = () => {}; this.onUpdate = () => {};
  }
}
