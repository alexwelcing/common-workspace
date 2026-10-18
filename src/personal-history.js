const copy = value => value === undefined ? undefined : structuredClone(value);
const same = (a, b) => a === b || (a != null && b != null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
const own = (object, key) => Object.hasOwn(object, key);
const encoder = new TextEncoder();
const MAX_ENTRIES = 100;
const MAX_BYTES = 24 * 1024 * 1024;
const POSITION_FIELDS = new Set(['x', 'y', 'width', 'height', 'points']);
const changedFields = (before, after) => [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter(field => field !== 'id' && !same(before?.[field], after?.[field]));

/**
 * Personal history deliberately never rewinds the Y.Doc. A reversal is a new
 * local edit, conditional on the exact field revisions that this person wrote.
 * Permanent tombstones remain permanent; recovering a deletion creates a copy
 * with a fresh ID. This also keeps delayed peer gestures from reviving it.
 */
export class PersonalHistory {
  constructor(model, { onChange = () => {}, canApply = () => true } = {}) {
    this.model = model; this.onChange = onChange; this.canApply = canApply;
    this.undoStack = []; this.redoStack = []; this.pending = null;
    this.depth = 0; this.suppressed = 0; this.bytes = 0; this.sequence = 0; this.revision = 0;
  }

  get canUndo() { return !!this.pending?.actions.size || !!this.undoStack.length; }
  get canRedo() { return !!this.redoStack.length; }
  state() { return { canUndo: this.canUndo, canRedo: this.canRedo, undoLabel: this.pending?.actions.size ? this.pending.label : this.undoStack.at(-1)?.label, redoLabel: this.redoStack.at(-1)?.label, revision: this.revision }; }
  notify() { this.revision++; this.onChange(this.state()); }
  begin(label = 'Canvas change') { if (!this.depth) { this.flush(); this.pending = { label, actions: new Map(), explicit: true, bytes: 0 }; } this.depth++; }
  end() { if (this.depth && !--this.depth) this.flush(); }
  stop() { this.depth = 0; this.flush(); }
  without(action) { this.suppressed++; try { return action(); } finally { this.suppressed--; } }
  clear() { this.undoStack = []; this.redoStack = []; this.pending = null; this.depth = 0; this.bytes = 0; this.notify(); }

  trim() {
    this.bytes = [...this.undoStack, ...this.redoStack].reduce((bytes, entry) => {
      // Rebased IDs and fractional keys can change the stored action's size.
      entry.bytes = encoder.encode(JSON.stringify(entry)).byteLength + 64;
      return bytes + entry.bytes;
    }, 0);
    while (this.undoStack.length + this.redoStack.length > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      const stack = this.undoStack.length ? this.undoStack : this.redoStack;
      this.bytes -= stack.shift().bytes;
    }
  }

  flush() {
    const pending = this.pending; this.pending = null;
    if (!pending?.actions.size) return;
    const entry = { label: pending.label, actions: [...pending.actions.values()] };
    entry.bytes = encoder.encode(JSON.stringify(entry)).byteLength;
    // A single exceptionally large action must not grow history indefinitely.
    if (entry.bytes <= MAX_BYTES) {
      this.undoStack.push(entry); this.trim();
    }
    this.notify();
  }

  record(before, after, beforeVersions, afterVersions, label = 'Canvas change') {
    if (this.suppressed || before?.type === 'screen' || after?.type === 'screen') return;
    const id = before?.id || after?.id; if (!id) return;
    const fields = changedFields(before, after);
    if (before && after && !fields.length) return;
    const key = before && after ? `${id}:${fields.slice().sort().join(',')}` : null;
    const now = Date.now();
    if (!this.depth && this.pending && (!key || this.pending.key !== key || now - this.pending.time > 700)) this.flush();
    if (!this.pending) this.pending = { label, actions: new Map(), key, time: now, bytes: 0 };
    this.pending.time = now;
    this.redoStack = [];
    if (this.pending.overflow) return;
    let action = this.pending.actions.get(id);
    const oldBytes = action?.byteCost || 0;
    if (!before) {
      action = { kind: 'remove', id, snapshot: copy(after), versions: { ...afterVersions }, foreignTouched: false };
    } else if (!after) {
      if (action?.kind === 'remove') { this.pending.actions.delete(id); this.pending.bytes -= oldBytes; this.notify(); return; }
      const snapshot = copy(before); const versions = { ...beforeVersions };
      // A deletion at the end of a gesture also reverses that gesture. Keep any
      // peer fields that arrived between its last local write and the deletion.
      if (action?.kind === 'patch') for (const [field, change] of Object.entries(action.fields)) {
        if (beforeVersions[field] !== change.version || !same(before[field], change.expected)) continue;
        if (change.value === undefined) delete snapshot[field]; else snapshot[field] = copy(change.value);
        versions[field] = change.valueVersion;
      }
      action = { kind: 'restore', id, snapshot, versions };
    } else if (action?.kind === 'remove') {
      for (const field of new Set([...Object.keys(action.snapshot), ...Object.keys(beforeVersions), ...Object.keys(action.versions)])) if (beforeVersions[field] !== action.versions[field] || !same(before[field], action.snapshot[field])) action.foreignTouched = true;
      for (const field of fields) {
        if (own(after, field)) action.snapshot[field] = copy(after[field]); else delete action.snapshot[field];
        action.versions[field] = afterVersions[field];
      }
    } else {
      if (!action || action.kind !== 'patch') action = { kind: 'patch', id, fields: {} };
      for (const field of fields) {
        const previous = action.fields[field];
        // A peer changed this field during a drag/typing group. Their latest
        // value becomes the recovery baseline instead of the gesture's start.
        const sameLineage = previous && beforeVersions[field] === previous.version && same(before[field], previous.expected);
        const value = sameLineage ? previous.value : before[field];
        if (same(value, after[field])) {
          this.rebase(id, id, { [field]: sameLineage ? previous.valueVersion : beforeVersions[field] }, afterVersions, after);
          delete action.fields[field];
        }
        else action.fields[field] = { value: copy(value), valueVersion: sameLineage ? previous.valueVersion : beforeVersions[field], expected: copy(after[field]), version: afterVersions[field] };
      }
      if (!Object.keys(action.fields).length) { this.pending.actions.delete(id); this.pending.bytes -= oldBytes; this.notify(); return; }
    }
    action.byteCost = encoder.encode(JSON.stringify(action)).byteLength + 64;
    this.pending.bytes += action.byteCost - oldBytes;
    if (this.pending.bytes > MAX_BYTES) {
      this.pending.actions.clear(); this.pending.bytes = 0; this.pending.overflow = true;
      this.model.onInvalid(new Error('This change is too large to keep in undo history. Your canvas has still been updated.'));
    } else this.pending.actions.set(id, action);
    this.notify();
  }

  allowed(entity, fields) {
    try { return !!this.canApply(copy(entity), fields); } catch { return false; }
  }

  rebase(id, nextId, fromVersions, toVersions, values) {
    const actions = [...this.undoStack, ...this.redoStack].flatMap(entry => entry.actions);
    if (this.pending) actions.push(...this.pending.actions.values());
    for (const action of actions) {
      if (action.id !== id) continue;
      action.id = nextId;
      if (action.snapshot) action.snapshot.id = nextId;
      if (action.kind === 'patch') {
        for (const [field, change] of Object.entries(action.fields)) {
          if (change.version === fromVersions[field] && same(change.expected, values[field])) change.version = toVersions[field];
          if (change.valueVersion === fromVersions[field] && same(change.value, values[field])) change.valueVersion = toVersions[field];
        }
      } else if (action.versions) {
        for (const field of new Set([...Object.keys(action.versions), ...Object.keys(fromVersions)])) if (action.versions[field] === fromVersions[field] && same(action.snapshot[field], values[field])) action.versions[field] = toVersions[field];
      }
    }
  }

  normalizeLayers(before, after, versions) {
    const previous = new Map(before.map(entity => [entity.id, entity]));
    const next = new Map(after.map(entity => [entity.id, entity]));
    const coordinate = (value, id, version) => {
      const current = previous.get(id);
      if (current && current.orderKey === value && versions.get(id)?.orderKey === version) return { value: next.get(id).orderKey, version: this.model.historyVersions(id).orderKey };
      if (typeof value !== 'string') return { value, version };
      const remaining = before.filter(entity => entity.id !== id);
      const index = remaining.findIndex(entity => typeof entity.orderKey === 'string' && (entity.orderKey > value || entity.orderKey === value && entity.id > id));
      const position = index < 0 ? remaining.length : index;
      return { value: generateKeyBetween(next.get(remaining[position - 1]?.id)?.orderKey ?? null, next.get(remaining[position]?.id)?.orderKey ?? null), version };
    };
    const actions = [...this.undoStack, ...this.redoStack].flatMap(entry => entry.actions);
    if (this.pending) actions.push(...this.pending.actions.values());
    for (const action of actions) {
      const field = action.fields?.orderKey;
      if (field) {
        const expected = coordinate(field.expected, action.id, field.version);
        const value = coordinate(field.value, action.id, field.valueVersion);
        field.expected = expected.value; field.version = expected.version;
        field.value = value.value; field.valueVersion = value.version;
      } else if (action.snapshot) {
        const key = coordinate(action.snapshot.orderKey, action.id, action.versions?.orderKey);
        action.snapshot.orderKey = key.value;
        if (action.versions) action.versions.orderKey = key.version;
      }
    }
    const count = this.undoStack.length + this.redoStack.length;
    this.trim();
    if (count !== this.undoStack.length + this.redoStack.length) this.notify();
  }

  applyAction(action) {
    const model = this.model;
    const current = model.get(action.id);
    if (action.kind === 'restore') {
      if (action.snapshot.type === 'screen' || !model.tombstones.has(action.id) || current || !this.allowed(action.snapshot, ['id'])) return { conflicts: 1 };
      const id = globalThis.crypto?.randomUUID?.() || `history-${model.doc.clientID}-${Date.now()}-${++this.sequence}`;
      const restored = { ...copy(action.snapshot), id };
      // Preserve the layer key but never reuse an object ID or remove a tombstone.
      if (!model.insertHistoryEntity(restored)) return { conflicts: 1, limited: true };
      // An absent field still has a revision if somebody added and deleted it.
      // Carry those opaque guards into the new copy instead of turning them
      // back into never-written fields during fresh-ID recovery.
      const versions = model.retainHistoryVersions(id, Object.keys(action.versions || {}));
      this.rebase(action.id, id, action.versions || {}, versions, restored);
      return { changed: 1, restoredId: id, inverse: { kind: 'remove', id, snapshot: model.get(id), versions, foreignTouched: false } };
    }
    if (!current || current.type === 'screen') return { conflicts: 1 };
    const versions = model.historyVersions(action.id);
    if (action.kind === 'remove') {
      const keys = new Set([...Object.keys(current), ...Object.keys(action.snapshot), ...Object.keys(versions), ...Object.keys(action.versions)]);
      if (action.foreignTouched || [...keys].some(field => !same(current[field], action.snapshot[field]) || versions[field] !== action.versions[field]) || !this.allowed(current, ['id'])) return { conflicts: 1 };
      if (!model.deleteLocal(action.id)) return { conflicts: 1 };
      return { changed: 1, inverse: { kind: 'restore', id: action.id, snapshot: current, versions } };
    }
    const patch = {}; let conflicts = 0;
    for (const [field, change] of Object.entries(action.fields)) {
      if (versions[field] !== change.version || !same(current[field], change.expected) || !this.allowed(current, [field])) { conflicts++; continue; }
      patch[field] = copy(change.value);
    }
    if (current.locked && patch.locked !== false) for (const field of Object.keys(patch)) if (POSITION_FIELDS.has(field)) { delete patch[field]; conflicts++; }
    if (!Object.keys(patch).length) return { conflicts };
    if (!model.patch(action.id, patch)) return { conflicts: conflicts + Object.keys(patch).length, limited: true };
    const after = model.get(action.id); const afterVersions = model.historyVersions(action.id); const fields = {};
    const sourceVersions = {};
    for (const field of Object.keys(patch)) {
      sourceVersions[field] = action.fields[field].valueVersion;
      fields[field] = { value: copy(current[field]), valueVersion: versions[field], expected: copy(after[field]), version: afterVersions[field] };
    }
    this.rebase(action.id, action.id, sourceVersions, afterVersions, after);
    return { changed: 1, conflicts, inverse: { kind: 'patch', id: action.id, fields } };
  }

  run(direction) {
    if (this.model.destroyed) return { ok: false, changed: 0, conflicts: 0, restoredIds: [], message: 'This canvas has been closed.' };
    this.stop();
    const from = direction === 'undo' ? this.undoStack : this.redoStack;
    const to = direction === 'undo' ? this.redoStack : this.undoStack;
    const entry = from.pop();
    if (!entry) return { ok: false, changed: 0, conflicts: 0, restoredIds: [], message: `Nothing to ${direction} yet.` };
    const inverses = []; const restoredIds = []; let changed = 0; let conflicts = 0; let limited = false;
    this.without(() => {
      for (const action of [...entry.actions].reverse()) {
        const result = this.applyAction(action);
        changed += result.changed || 0; conflicts += result.conflicts || 0; limited ||= !!result.limited;
        if (result.inverse) inverses.push(result.inverse);
        if (result.restoredId) restoredIds.push(result.restoredId);
      }
    });
    if (inverses.length) {
      const inverse = { label: entry.label, actions: inverses };
      inverse.bytes = encoder.encode(JSON.stringify(inverse)).byteLength;
      to.push(inverse);
    }
    this.trim();
    this.notify();
    const verb = direction === 'undo' ? 'Undid' : 'Redid';
    const message = conflicts ? `${changed ? `${verb} the changes still belonging to you. ` : ''}${limited ? 'Some changes could not fit on this canvas.' : 'Newer changes, removed objects, and locked positions were kept.'}` : `${verb} ${entry.label.toLowerCase()}.${restoredIds.length ? ' Deleted objects were recovered as new copies.' : ''}`;
    return { ok: changed > 0, changed, conflicts, restoredIds, message };
  }
}
import { generateKeyBetween } from 'fractional-indexing';

