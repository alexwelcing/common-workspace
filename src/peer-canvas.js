// Yjs state-vector exchange over the existing reliable WebRTC data channel.
// This provider contains no room content storage or application server calls.
const VECTOR = 1;
const UPDATE = 2;
const MAX_BYTES = 24 * 1024 * 1024;
function packet(kind, bytes) {
  const value = new Uint8Array(bytes.byteLength + 1);
  value[0] = kind; value.set(bytes, 1); return value;
}
export class PeerCanvas {
  constructor({ model, send, onStatus = () => {}, intervalMs = 5000 }) {
    this.model = model; this.send = send; this.onStatus = onStatus;
    this.peers = new Set(); this.destroyed = false;
    this.timer = setInterval(() => { for (const id of this.peers) this.requestSync(id); }, intervalMs);
    this.timer.unref?.();
  }
  open(id) {
    if (this.destroyed) return;
    this.peers.add(id); this.requestSync(id);
  }
  close(id) { this.peers.delete(id); }
  requestSync(id) {
    if (!this.destroyed && this.peers.has(id)) return this.send(id, packet(VECTOR, this.model.encodeStateVector()));
    return false;
  }
  receive(id, bytes) {
    if (this.destroyed || !this.peers.has(id) || !(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > MAX_BYTES) return false;
    try {
      if (bytes[0] === VECTOR) {
        if (bytes.byteLength > 65536) return false;
        const update = this.model.encodeDiff(bytes.subarray(1));
        if (update.byteLength + 1 > MAX_BYTES) { this.onStatus('This canvas is too large to synchronize. Remove a few images and try again.'); return false; }
        return this.send(id, packet(UPDATE, update));
      }
      if (bytes[0] === UPDATE) return this.model.applyUpdate(bytes.subarray(1), { peerId: id });
    } catch { this.onStatus('A canvas update could not be read. The next sync will retry.'); }
    return false;
  }
  broadcast(update, origin) {
    if (this.destroyed || update.byteLength + 1 > MAX_BYTES) return;
    const data = packet(UPDATE, update);
    for (const id of this.peers) if (id !== origin?.peerId) this.send(id, data);
    // A full queue recovers through the next state-vector exchange.
  }
  destroy() { this.destroyed = true; clearInterval(this.timer); this.peers.clear(); }
}
