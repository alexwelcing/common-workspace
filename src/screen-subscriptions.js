/** Local video interest, independent of room admission and the shared document. */
export function defaultWatchBudget(device = globalThis.navigator) {
  return (device?.deviceMemory > 0 && device.deviceMemory <= 4) ||
    (device?.hardwareConcurrency > 0 && device.hardwareConcurrency <= 4) ? 2 : 4;
}

export class ScreenSubscriptions {
  constructor({ maxStreams = defaultWatchBudget() } = {}) {
    this.maxStreams = Math.max(1, Math.floor(maxStreams));
    this.reset();
  }

  reset() { this.paused = new Set(); this.preferred = []; this.watching = []; }

  toggle(id) {
    this.preferred = this.preferred.filter(value => value !== id);
    if (this.watching.includes(id)) this.paused.add(id);
    else { this.paused.delete(id); this.preferred.unshift(id); }
  }

  plan(entities, { participantId, selectedId, focusedId = null, view = {}, width, height, hidden = false } = {}) {
    const screens = entities.filter(entity => entity.type === 'screen' && entity.participantId && entity.participantId !== participantId);
    const owners = new Set(screens.map(entity => entity.participantId));
    this.preferred = this.preferred.filter(id => owners.has(id));
    for (const id of this.paused) if (!owners.has(id)) this.paused.delete(id);
    if (hidden || !(width > 0 && height > 0)) return (this.watching = []);
    const zoom = view.zoom || 1, panX = view.x || 0, panY = view.y || 0;
    const visible = screens.filter(entity => {
      if (focusedId && entity.id !== focusedId) return false;
      const x = entity.x * zoom + panX, y = entity.y * zoom + panY;
      return !this.paused.has(entity.participantId) && x < width && y < height &&
        x + entity.width * zoom > 0 && y + entity.height * zoom > 0;
    });
    // Explicit Watch actions come first, followed by selection, then existing
    // views. Retaining existing views avoids cycling decoders on every update.
    const selected = visible.find(entity => entity.id === selectedId)?.participantId;
    const available = new Set(visible.map(entity => entity.participantId));
    const priority = [...this.preferred, selected, ...this.watching, ...visible.map(entity => entity.participantId)];
    this.watching = [...new Set(priority)].filter(id => available.has(id)).slice(0, this.maxStreams);
    return [...this.watching];
  }
}
