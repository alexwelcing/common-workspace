// Room admission and signaling use short HTTP requests on Netlify. Canvas and
// screen data still travel over the peers' WebRTC connections.
export class PollingSessionTransport {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor({ room, token, fetchImpl = globalThis.fetch.bind(globalThis), basePath = '/api/rooms', pollIntervalMs = 1000, idleIntervalMs = 3000, activeWindowMs = 10000, backgroundIntervalMs = 15000, requestTimeoutMs = 20000, outageTimeoutMs = 60000, documentImpl = globalThis.document, setTimeoutImpl = globalThis.setTimeout.bind(globalThis), clearTimeoutImpl = globalThis.clearTimeout.bind(globalThis), now = Date.now, random = Math.random, onDiagnostics = null, onDiagnostic = null }) {
    this.readyState = PollingSessionTransport.CONNECTING;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    this._url = `${basePath}/${encodeURIComponent(room)}`;
    this._token = token; this._fetch = fetchImpl; this._document = documentImpl;
    this._setTimeout = setTimeoutImpl; this._clearTimeout = clearTimeoutImpl;
    this._pollInterval = pollIntervalMs; this._backgroundInterval = backgroundIntervalMs;
    this._idleInterval = idleIntervalMs; this._activeWindow = activeWindowMs; this._idle = false; this._activeAt = 0;
    this._requestTimeout = requestTimeoutMs; this._outageTimeout = outageTimeoutMs;
    this._now = now; this._random = random;
    this._requests = new Set(); this._sendChain = Promise.resolve(); this._queued = 0;
    this._failures = 0; this._failureSince = null; this._connectionId = null;
    this._cursor = '0'; this._participants = ''; this._polling = false; this._leaving = false;
    this._rosterVersion = null; this._capabilities = {}; this._requestCounter = 0;
    this._onDiagnostics = onDiagnostics; this._onDiagnostic = onDiagnostic;
    this._metrics = { polls: 0, deliveredEvents: 0, postRetries: 0, lastPollMs: 0 }; this._queueTimes = [];
    this._visibilityChange = () => {
      if (this.readyState === PollingSessionTransport.OPEN && !this._document?.hidden && !this._polling) this._schedulePoll(0);
    };
    this._document?.addEventListener('visibilitychange', this._visibilityChange);
    // Give callers the same opportunity to attach handlers as new WebSocket().
    queueMicrotask(() => this._start());
  }

  _emit(type, data = {}) {
    try { this[`on${type}`]?.({ type, target: this, ...data }); }
    catch (error) { queueMicrotask(() => { throw error; }); }
  }

  getDiagnostics() { return { ...this._metrics, queued: this._queued, polling: Number(this._polling), failures: this._failures, readyState: this.readyState }; }
  diagnostics() { return { queuedMessages: this._queued, queueAgeMs: this._queueTimes.length ? Math.max(0, this._now() - this._queueTimes[0]) : 0,
    pollFailures: this._failures, lastPollMs: this._metrics.lastPollMs, pollCount: this._metrics.polls, eventsReceived: this._metrics.deliveredEvents }; }
  _diagnose(type = 'queue') {
    try { this._onDiagnostics?.(this.getDiagnostics()); } catch {}
    const state = this.diagnostics();
    const values = type === 'poll' ? { durationMs: state.lastPollMs, events: state.eventsReceived, failures: state.pollFailures }
      : type === 'connection' ? { state: this.readyState === 1 ? 'connected' : this.readyState === 0 ? 'connecting' : 'disconnected' }
      : { queuedMessages: state.queuedMessages, queueAgeMs: state.queueAgeMs, attempts: this._metrics.postRetries };
    try { this._onDiagnostic?.(type, values); } catch {}
  }

  async _request(path, { method = 'GET', body, keepalive = false } = {}) {
    const controller = new AbortController(); this._requests.add(controller);
    const timeout = this._setTimeout(() => controller.abort(), this._requestTimeout);
    try {
      const headers = { Authorization: `Bearer ${this._token}` };
      if (this._connectionId) headers['X-Common-Connection'] = this._connectionId;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await this._fetch(this._url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, keepalive, cache: 'no-store' });
      let data;
      try { data = await response.json(); } catch { data = {}; }
      if (!response.ok) {
        const error = new Error(data.error || `Room connection failed (${response.status}).`);
        error.status = response.status; error.code = data.code;
        throw error;
      }
      return data;
    } finally { this._clearTimeout(timeout); this._requests.delete(controller); }
  }

  _errorClose(error) {
    if (this.readyState === PollingSessionTransport.CLOSED) return;
    this._emit('error', { error, message: error.message });
    const code = error.code === 'RESYNC_REQUIRED' ? 1012
      : error.code === 'CONNECTION_REPLACED' || error.status === 403 ? 4003
      : error.status === 401 ? 4001 : error.status === 404 ? 4004
      : error.code === 'ROOM_FULL' ? 1008 : 1006;
    this._finish(code, error.message);
  }

  async _start() {
    if (this.readyState !== PollingSessionTransport.CONNECTING) return;
    try {
      const result = await this._request('/connect', { method: 'POST', body: {} });
      if (this.readyState !== PollingSessionTransport.CONNECTING) return;
      if (result.init?.type !== 'init' || !result.connectionId || result.cursor === undefined) throw new Error('The room connection returned an invalid response.');
      this._connectionId = result.connectionId; this._cursor = String(result.cursor);
      this._capabilities = result.capabilities || {};
      this._rosterVersion = result.rosterVersion === undefined ? null : String(result.rosterVersion);
      this._participants = JSON.stringify(result.init.participants || []);
      this.readyState = PollingSessionTransport.OPEN;
      this._emit('open');
      if (this.readyState !== PollingSessionTransport.OPEN) return;
      this._message(result.init);
      this._diagnose('connection');
      this._schedulePoll();
    } catch (error) { if (this.readyState !== PollingSessionTransport.CLOSED) this._errorClose(error); }
  }

  _message(message) {
    if (this.readyState === PollingSessionTransport.OPEN && message && typeof message.type === 'string') {
      if (message.type === 'participants') {
        this._participants = JSON.stringify(message.participants || []);
        if (message.rosterVersion !== undefined) this._rosterVersion = String(message.rosterVersion);
      } else if (message.type === 'checklist') {
        // Reflect every delivered delta in the dedupe cache. A historical page
        // can then be corrected by the server's current canonical roster.
        const people = JSON.parse(this._participants || '[]');
        this._participants = JSON.stringify(people.map(person => person.id === message.id ? { ...person, checklist: message.checklist } : person));
      }
      this._emit('message', { data: JSON.stringify(message) });
      if (message.type === 'ended') this._finish(1000, 'Session ended');
    }
  }

  /** Peers that already share a WebRTC link need the server less; poll slower until activity resumes. */
  setIdle(idle) {
    const wasIdle = this._idle; this._idle = !!idle;
    if (wasIdle && !this._idle && this.readyState === PollingSessionTransport.OPEN && !this._polling && !this._document?.hidden) this._schedulePoll(0);
  }

  _visibleInterval() {
    return this._idle && this._now() - this._activeAt >= this._activeWindow ? this._idleInterval : this._pollInterval;
  }

  _schedulePoll(delay = this._document?.hidden ? this._backgroundInterval : this._visibleInterval()) {
    if (this.readyState !== PollingSessionTransport.OPEN) return;
    this._clearTimeout(this._pollTimer);
    this._pollTimer = this._setTimeout(() => { this._pollTimer = null; return this._poll(); }, delay);
  }

  async _poll() {
    if (this.readyState !== PollingSessionTransport.OPEN || this._polling) return;
    this._polling = true;
    const startedAt = this._now();
    this._metrics.polls++;
    let nextDelay;
    try {
      const version = this._capabilities.targetedEvents
        ? `&delivery=targeted-v1${this._rosterVersion === null ? '' : `&rosterVersion=${encodeURIComponent(this._rosterVersion)}`}` : '';
      const result = await this._request(`/events?after=${encodeURIComponent(this._cursor)}${version}`);
      if (this.readyState !== PollingSessionTransport.OPEN) return;
      if (!Array.isArray(result.events) || result.cursor === undefined) throw new Error('The room update returned an invalid response.');
      this._failures = 0; this._failureSince = null;
      if (result.events.length) this._activeAt = this._now();
      let deliveredThrough = BigInt(this._cursor);
      for (const event of result.events) {
        const sequence = BigInt(event.sequence);
        if (sequence <= deliveredThrough) continue;
        this._message(event.message); deliveredThrough = sequence; this._metrics.deliveredEvents++;
      }
      // The cursor also advances past events addressed to other participants.
      this._cursor = String(result.cursor);
      if (result.rosterVersion !== undefined) this._rosterVersion = String(result.rosterVersion);
      if (Array.isArray(result.participants) && this._participants !== JSON.stringify(result.participants)) this._message({ type: 'participants', participants: result.participants });
      if (result.hasMore === true) nextDelay = 0;
    } catch (error) {
      if (this.readyState !== PollingSessionTransport.OPEN) return;
      if (error.status && error.status !== 429 && error.status < 500) { this._errorClose(error); return; }
      this._failureSince ??= this._now();
      if (this._now() - this._failureSince >= this._outageTimeout) { this._errorClose(error); return; }
      // Poll failures are safe to retry; POSTs are not replayed after an
      // ambiguous response, so a chat or signaling message cannot duplicate.
      nextDelay = Math.min(15000, this._pollInterval * 2 ** Math.min(++this._failures, 4)) * (0.85 + this._random() * 0.3);
    } finally {
      this._polling = false;
      this._metrics.lastPollMs = Math.max(0, this._now() - startedAt); this._diagnose('poll');
      if (this.readyState === PollingSessionTransport.OPEN) this._schedulePoll(nextDelay);
    }
  }

  send(text) {
    if (this.readyState !== PollingSessionTransport.OPEN) throw new DOMException('The room connection is not open.', 'InvalidStateError');
    const message = JSON.parse(text);
    if (!message || typeof message.type !== 'string') throw new TypeError('A room message needs a type.');
    if (message.type === 'leave') { this._leave(); this.close(); return; }
    if (message.type === 'cursor') {
      this._pendingCursor = message;
      if (!this._cursorTimer) this._cursorTimer = this._setTimeout(() => {
        this._cursorTimer = null;
        const latest = this._pendingCursor; this._pendingCursor = null;
        if (latest && this.readyState === PollingSessionTransport.OPEN) this._enqueue(latest);
      }, 1000);
      return;
    }
    this._enqueue(message);
  }

  _enqueue(message) {
    // Replies to a signal or chat usually follow right away.
    this._activeAt = this._now();
    const retryableSignal = message.type === 'signal' && this._capabilities.signalIdempotency === true;
    if (retryableSignal) message = { ...message, requestId: `${this._connectionId}_${++this._requestCounter}` };
    if (++this._queued > 128) { this._queued--; this._errorClose(new Error('Too many pending room messages. Please reconnect.')); return; }
    this._queueTimes.push(this._now());
    this._diagnose();
    this._sendChain = this._sendChain.then(async () => {
      if (this.readyState !== PollingSessionTransport.OPEN) return;
      try {
        for (let attempt = 0; ; attempt++) {
          try { await this._request('/messages', { method: 'POST', body: message }); break; }
          catch (error) {
            if (!retryableSignal || attempt >= 2 || this.readyState !== PollingSessionTransport.OPEN || (error.status && error.status < 500)) throw error;
            this._metrics.postRetries++; this._diagnose();
          }
        }
      }
      catch (error) {
        // A departed signal recipient or a rejected activity is a message
        // error, matching the WebSocket server. Keep the other peers alive.
        if ([400, 403, 422, 429].includes(error.status) || ['PEER_CANVAS', 'NO_WORKSHOP', 'WORKSHOP_SLOT_TAKEN', 'WORKSHOP_MEMBER_UNAVAILABLE'].includes(error.code)) this._message({ type: 'error', error: error.message, code: error.code });
        else this._errorClose(error);
      }
    }).finally(() => { this._queued--; this._queueTimes.shift(); this._diagnose(); });
  }

  _leave() {
    // keepalive permits the authenticated leave request to finish during a
    // navigation. A lease expires naturally if the browser cannot deliver it.
    if (this._connectionId && !this._leaving) {
      this._leaving = true;
      const headers = { Authorization: `Bearer ${this._token}`, 'X-Common-Connection': this._connectionId, 'Content-Type': 'application/json' };
      try { Promise.resolve(this._fetch(this._url + '/leave', { method: 'POST', headers, body: '{}', keepalive: true })).catch(() => {}); } catch {}
    }
  }

  close(code = 1000, reason = '') {
    // Closing a transport also happens on reload. Keep the room token valid so
    // that the same tab can reconnect as its existing participant or host.
    this._finish(code, reason);
  }

  _finish(code, reason) {
    if (this.readyState === PollingSessionTransport.CLOSED) return;
    this.readyState = PollingSessionTransport.CLOSED;
    this._clearTimeout(this._pollTimer); this._clearTimeout(this._cursorTimer);
    this._document?.removeEventListener('visibilitychange', this._visibilityChange);
    for (const controller of this._requests) controller.abort();
    this._requests.clear(); this._pendingCursor = null;
    this._diagnose('connection');
    this._emit('close', { code, reason, wasClean: code === 1000 });
  }
}
