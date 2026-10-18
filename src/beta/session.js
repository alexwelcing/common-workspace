import { ScreenSharing } from '../media.js';
import { PollingSessionTransport } from '../session-transport.js';
import { getRuntimeConfig, loadRuntimeConfig } from '../runtime-config.js';
import { appPath, appStorageKey, appWebSocketURL } from '../app-path.js';

const EXPERIENCE = 'spatial-beta';
const ROOM_ID = /^[A-Za-z0-9_-]{1,100}$/;
const noop = () => {};
const failure = (code, message, status) => Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
const cancelled = () => new DOMException('The session changed before this operation finished.', 'AbortError');

function roomId(value) {
  if (typeof value !== 'string' || !ROOM_ID.test(value)) throw failure('INVALID_ROOM_ID', 'Ask the host for a valid session link.');
  return value;
}
function requireSpatial(room) {
  if (!room || room.experience !== EXPERIENCE || room.collaboration !== 'peer') {
    throw failure('WRONG_EXPERIENCE', 'This is a regular canvas room. Open its original invitation to join it.');
  }
  roomId(room.id);
  return room;
}

/** Admission and native peer transport only. Canvas content stays in the spatial document. */
export class BetaSession {
  constructor(options = {}) {
    this.callbacks = Object.fromEntries([
      'onAdmitted', 'onParticipants', 'onData', 'onPeerOpen', 'onPeerClose', 'onStream', 'onCaptureState',
      'onStatus', 'onConnection', 'onEnded', 'onRoom', 'onAppearance', 'onStopped',
    ].map(name => [name, typeof options[name] === 'function' ? options[name] : noop]));
    this._fetch = options.fetchImpl || globalThis.fetch.bind(globalThis);
    this._WebSocket = options.WebSocketImpl || globalThis.WebSocket;
    this._PollingTransport = options.PollingTransport || PollingSessionTransport;
    this._mediaFactory = options.mediaFactory || (configuration => new ScreenSharing(configuration));
    this._document = options.documentImpl || globalThis.document;
    this._window = options.windowImpl || globalThis.window;
    this._generation = 0; this._requests = new Set(); this._timer = null; this._connectionTimer = null;
    this._auth = null; this._media = null; this._socket = null;
    this._destroyed = false; this._ended = false; this._connected = false;
    this._connecting = false; this._failures = 0; this._outageAt = null; this._lastStatus = '';
    this._storage = new Map();
    this._embedIdentity = this._window?.parent !== this._window &&
      /^common-embed-(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(this._window?.name || '')
      ? this._window.name : '';
  }

  get auth() { return this._auth; }
  get media() { return this._media; }
  get peerIds() { return this._media?.dataPeerIds || []; }
  get connected() { return this._connected && !this._destroyed && !this._ended; }

  _current(generation) { return !this._destroyed && !this._ended && generation === this._generation; }
  _assert(generation) { if (!this._current(generation)) throw cancelled(); }
  _emit(name, ...args) {
    if (this._destroyed) return;
    try { this.callbacks[name](...args); } catch { /* View observers cannot interrupt transport cleanup. */ }
  }
  _status(message) {
    if (message === this._lastStatus) return;
    this._lastStatus = message; this._emit('onStatus', message);
  }
  _connection(state) { this._connected = state === 'connected'; this._emit('onConnection', state); }
  _storageKey(id) { return appStorageKey(`common.beta.auth.${id}${this._embedIdentity ? '.' + this._embedIdentity : ''}`); }
  _saveAuth() {
    const auth = this._auth;
    if (!auth) return;
    // Passwords, canvas content and history never enter admission storage.
    const value = JSON.stringify({ room: auth.room, token: auth.token, participantId: auth.participantId, isAdmin: auth.isAdmin, displayName: auth.displayName });
    const key = this._storageKey(auth.room.id); this._storage.set(key, value);
    try { this._window?.sessionStorage.setItem(key, value); } catch { /* This tab can continue without storage. */ }
  }
  _forget(id = this._auth?.room.id) {
    if (!id) return;
    const key = this._storageKey(id); this._storage.delete(key);
    try { this._window?.sessionStorage.removeItem(key); } catch { /* Storage is optional. */ }
  }
  _saved(id) {
    const key = this._storageKey(id);
    let value = this._storage.get(key);
    try { value = this._window?.sessionStorage.getItem(key) ?? value; } catch { /* Use tab memory. */ }
    try {
      const auth = JSON.parse(value);
      if (auth?.room?.id === id && auth.room.experience === EXPERIENCE && auth.room.collaboration === 'peer' &&
        typeof auth.token === 'string' && auth.token && typeof auth.participantId === 'string' && auth.participantId) return auth;
    } catch { /* Invalid or unavailable admission needs a fresh password. */ }
    this._forget(id); return null;
  }

  async _request(path, { body, token, timeoutMs = 20000 } = {}, generation = this._generation) {
    this._assert(generation);
    const controller = new AbortController(); this._requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this._fetch(appPath(path), {
        method: body === undefined ? 'GET' : 'POST', signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let value;
      try { value = await response.json(); }
      catch { throw failure('INVALID_RESPONSE', 'The server returned an unreadable response. Check your application sign-in and try again.', response.status); }
      this._assert(generation);
      if (!response.ok) throw failure(value?.code || 'REQUEST_FAILED', value?.error || 'The session request could not be completed.', response.status);
      return value;
    } catch (error) {
      this._assert(generation);
      if (controller.signal.aborted) throw failure('REQUEST_TIMEOUT', 'The session server took too long to respond. Check your connection and try again.');
      if (error instanceof TypeError) throw failure('NETWORK_UNAVAILABLE', 'The session server could not be reached. Check your connection and try again.');
      throw error;
    } finally { clearTimeout(timer); this._requests.delete(controller); }
  }

  async lookup(id) {
    const result = await this._request('/api/rooms/' + encodeURIComponent(roomId(id)));
    return result.room;
  }

  _reset() {
    if (this._destroyed) throw failure('SESSION_CLOSED', 'This session controller has been closed.');
    ++this._generation; this._ended = false;
    clearTimeout(this._timer); this._timer = null;
    for (const request of this._requests) request.abort(); this._requests.clear();
    this._detach(); this._auth = null; this._connecting = false; this._connected = false;
    this._failures = 0; this._outageAt = null; this._lastStatus = '';
    return this._generation;
  }
  _detach() {
    this._closeSocket();
    this._media?.destroy(); this._media = null;
  }
  _closeSocket() {
    clearTimeout(this._connectionTimer); this._connectionTimer = null;
    if (this._socket) {
      this._socket.onopen = null; this._socket.onmessage = null; this._socket.onclose = null; this._socket.onerror = null;
      this._socket.close(); this._socket = null;
    }
  }

  async resume(id) {
    roomId(id);
    const saved = this._saved(id);
    if (!saved) return false;
    const generation = this._reset();
    let result;
    try { result = await this._request(`/api/rooms/${encodeURIComponent(id)}/session`, { token: saved.token }, generation); }
    catch (error) {
      if ([401, 403, 404].includes(error.status)) { this._forget(id); return false; }
      throw error;
    }
    requireSpatial(result.room);
    await this._admit({ ...saved, ...result, token: saved.token }, { isNew: false }, generation);
    return true;
  }

  async create({ name, displayName, password, appearance } = {}) {
    const generation = this._reset();
    const result = await this._request('/api/rooms', { body: { name, displayName, password, appearance, experience: EXPERIENCE, collaboration: 'peer' } }, generation);
    requireSpatial(result.room);
    return this._admit({ ...result, displayName }, { isNew: true }, generation);
  }

  async join(id, { displayName, password } = {}) {
    roomId(id);
    const generation = this._reset();
    const publicResult = await this._request('/api/rooms/' + encodeURIComponent(id), {}, generation);
    requireSpatial(publicResult.room);
    const result = await this._request(`/api/rooms/${encodeURIComponent(id)}/join`, { body: { displayName, password } }, generation);
    requireSpatial(result.room);
    return this._admit({ ...result, displayName }, { isNew: false }, generation);
  }

  async _admit(auth, context, generation) {
    this._assert(generation);
    if (typeof auth.token !== 'string' || !auth.token || typeof auth.participantId !== 'string' || !auth.participantId) {
      throw failure('INVALID_ADMISSION', 'The server did not provide a valid session admission. Please join again.');
    }
    this._auth = auth; this._saveAuth();
    // The document and browser store must be ready before a peer can deliver bytes.
    await this.callbacks.onAdmitted(auth, context);
    this._assert(generation);
    const current = () => this._current(generation) && this._media === media;
    const media = this._mediaFactory({
      send: message => current() && this.send(message),
      onStream: (id, stream) => { if (current()) this._emit('onStream', id === 'local' ? auth.participantId : id, stream); },
      onData: (id, bytes) => { if (current()) this._emit('onData', id, bytes); },
      onPeerOpen: id => { if (current()) this._emit('onPeerOpen', id); },
      onPeerClose: id => { if (current()) this._emit('onPeerClose', id); },
      onCaptureState: state => { if (current()) this._emit('onCaptureState', state); },
      onStatus: message => { if (current()) this._status(message); },
      onStopped: () => { if (current()) this._emit('onStopped'); },
      getIceConfig: () => this._request('/api/ice?room=' + encodeURIComponent(auth.room.id), { token: auth.token }, generation),
      fallbackIceConfig: () => ({ iceServers: getRuntimeConfig().rtc.iceServers, iceTransportPolicy: getRuntimeConfig().rtc.iceTransportPolicy }),
    });
    this._media = media;
    this._emit('onRoom', auth.room); this._emit('onAppearance', auth.room.appearance);
    void this._connect(generation);
    return auth;
  }

  async _connect(generation) {
    if (!this._current(generation) || this._connecting) return;
    this._connecting = true; this._connection('connecting');
    const auth = this._auth;
    try {
      const session = await this._request(`/api/rooms/${encodeURIComponent(auth.room.id)}/session`, { token: auth.token }, generation);
      requireSpatial(session.room);
      Object.assign(auth, session); this._saveAuth();
      const runtime = await loadRuntimeConfig({ fetch: (input, options) => this._configFetch(input, options, generation) });
      this._assert(generation);
      const polling = runtime.transport === 'polling' || (!runtime.transport && import.meta.env?.VITE_SESSION_TRANSPORT === 'polling');
      const socket = polling
        ? new this._PollingTransport({ room: auth.room.id, token: auth.token, basePath: appPath('/api/rooms'), fetchImpl: this._fetch, documentImpl: this._document })
        : new this._WebSocket(appWebSocketURL('/ws?room=' + encodeURIComponent(auth.room.id) + '&token=' + encodeURIComponent(auth.token)));
      this._socket = socket;
      const current = () => this._current(generation) && this._socket === socket;
      this._connectionTimer = setTimeout(() => {
        if (!current() || this.connected) return;
        this._closeSocket(); this._disconnected(generation);
      }, 25000);
      socket.onmessage = event => {
        if (!current()) return;
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'init') {
          try { requireSpatial(message.room); }
          catch (error) { this._terminal(error.message); return; }
          clearTimeout(this._connectionTimer); this._connectionTimer = null;
          auth.room = message.room; auth.isAdmin = !!message.self?.isAdmin; this._saveAuth();
          this._failures = 0; this._outageAt = null; this._lastStatus = '';
          this._connection('connected'); this._emit('onRoom', auth.room); this._emit('onAppearance', auth.room.appearance);
          this._participants(message.participants, generation);
        } else if (message.type === 'participants') this._participants(message.participants, generation);
        else if (message.type === 'signal') void this._media?.handleSignal(message.from, message.data);
        else if (message.type === 'appearance') {
          auth.room = { ...auth.room, appearance: message.appearance }; this._saveAuth();
          this._emit('onRoom', auth.room); this._emit('onAppearance', message.appearance);
        } else if (message.type === 'ended') this._terminal('The host ended this session.');
        else if (message.type === 'error') this._status(typeof message.error === 'string' ? message.error : 'The session request was rejected.');
      };
      socket.onclose = event => {
        if (!current()) return;
        clearTimeout(this._connectionTimer); this._connectionTimer = null;
        this._socket = null;
        if ([4001, 4003, 4004, 1008].includes(event.code)) { this._terminal('Your session access has expired. Join again with the session password.'); return; }
        this._disconnected(generation);
      };
      socket.onerror = noop;
    } catch (error) {
      if (!this._current(generation)) return;
      if ([401, 403, 404].includes(error.status) || error.code === 'WRONG_EXPERIENCE') this._terminal(error.code === 'WRONG_EXPERIENCE' ? error.message : 'Your session access has expired, or the room has ended.');
      else this._disconnected(generation);
    } finally { if (generation === this._generation) this._connecting = false; }
  }

  async _configFetch(input, options = {}, generation) {
    this._assert(generation);
    const controller = new AbortController(); this._requests.add(controller);
    const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    try {
      const response = await this._fetch(input, { ...options, signal: controller.signal, credentials: 'same-origin' });
      // Runtime configuration consumes this body after fetch resolves. Keep its
      // controller registered until consumption settles so destroy can cancel it.
      const value = await response.arrayBuffer(); this._assert(generation);
      return new Response(value, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally { options.signal?.removeEventListener('abort', abort); this._requests.delete(controller); }
  }

  _participants(value, generation) {
    const participants = Array.isArray(value) ? value : [];
    this._emit('onParticipants', participants);
    Promise.resolve(this._media?.syncParticipants(participants, this._auth.participantId)).catch(() => {
      if (this._current(generation)) this._status('Some peer connections are still opening. Your workspace stays open while they retry.');
    });
  }
  _disconnected(generation) {
    if (!this._current(generation)) return;
    this._connection('disconnected');
    const wasSharing = !!this._media?.localStream;
    this._media?.stop();
    if (wasSharing) this._emit('onStopped');
    void this._media?.syncParticipants([], this._auth.participantId);
    this._outageAt ??= Date.now(); ++this._failures;
    if (Date.now() - this._outageAt >= 10 * 60_000 || this._failures > 30) {
      this._status('The session could not reconnect. Your local workspace is still available; reload to try joining again.');
      return;
    }
    this._status('The session connection dropped. Window sharing stopped; reconnecting…');
    clearTimeout(this._timer);
    const delay = Math.min(30000, 1500 * 2 ** Math.min(5, this._failures - 1));
    this._timer = setTimeout(() => { this._timer = null; void this._connect(generation); }, delay);
  }

  send(message) {
    if (!this.connected || this._socket?.readyState !== 1 || !message || typeof message.type !== 'string') return false;
    // This channel is admission/signaling only; spatial documents never enter an API request.
    if (!['signal', 'appearance', 'end', 'leave'].includes(message.type)) return false;
    try { this._socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  sendData(peerId, bytes) { return this.connected && this._media?.sendData(peerId, bytes) || false; }
  share() {
    if (!this.connected || !this._media) { this._status('Reconnect before sharing a window.'); return Promise.resolve(null); }
    return this._media.start();
  }
  stopSharing() { return this._media?.stop(); }
  watch(ids) { return this._media?.setSubscriptions(this.connected ? ids : []); }
  end() {
    if (!this._auth?.isAdmin) { this._status('Only the host can end this session.'); return false; }
    const accepted = this.send({ type: 'end' });
    if (!accepted) this._status('Reconnect before ending the shared session.');
    return accepted;
  }
  leave() { if (this._destroyed || this._ended) return; this.send({ type: 'leave' }); this._terminal('You left this session.'); }
  _terminal(reason) {
    if (this._destroyed || this._ended) return;
    this._ended = true; ++this._generation; this._connected = false; this._connecting = false;
    clearTimeout(this._timer); this._timer = null;
    for (const request of this._requests) request.abort(); this._requests.clear();
    this._forget(); this._detach(); this._emit('onConnection', 'disconnected'); this._emit('onParticipants', []);
    this._emit('onEnded', reason);
  }
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true; ++this._generation; this._connected = false;
    clearTimeout(this._timer); this._timer = null;
    for (const request of this._requests) request.abort(); this._requests.clear();
    this._detach();
  }
}

export const createBetaSession = options => new BetaSession(options);
