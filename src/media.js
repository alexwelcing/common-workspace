import { canvasNeighbors } from './peer-topology.js';
import { displayCaptureSupport, displayCaptureFailure, displayCaptureSource } from './browser-permissions.js';

const DEFAULT_ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const ICE_CACHE_MS = 5 * 60_000;
const ICE_EXPIRY_MARGIN_MS = 30_000;
const hasTurn = (configuration) => configuration.iceServers.some((server) =>
  [server.urls].flat().some((url) => /^turns?:/i.test(url || '')));
const DATA_LABEL = 'common-canvas-v1';
const DATA_MAGIC = 0x43435631; // CCV1: the framing version is part of the magic.
const DATA_HEADER_BYTES = 20;
const DATA_CHUNK_BYTES = 16 * 1024;
const MAX_DATA_BYTES = 24 * 1024 * 1024;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const MAX_ASSEMBLY_BYTES = 32 * 1024 * 1024;
const MAX_ASSEMBLIES = 8;
const ASSEMBLY_TIMEOUT_MS = 60_000;
const DATA_HIGH_WATER = 512 * 1024;
const DATA_LOW_WATER = 128 * 1024;
const MAX_FRAMES_PER_SECOND = 4096;
const SCREEN_BUDGET_BITS = 1_500_000;
const MIN_VIEWER_BITS = 180_000;
const EARLY_SUBSCRIPTION_MS = 30_000;
const MAX_EARLY_SUBSCRIPTIONS = 2048;
const NEGOTIATION_RETRY_MS = 2000;
const MAX_NEGOTIATION_RETRIES = 8;

/** A bounded canvas overlay plus explicitly subscribed screen connections.
 * A presenter still uploads one media copy per viewer; large audiences need an SFU.
 */
export class ScreenSharing {
  constructor({
    send,
    onStream = () => {},
    onStatus = () => {},
    onStopped = () => {},
    onCaptureState = () => {},
    onData = () => {},
    onPeerOpen = () => {},
    onPeerClose = () => {},
    getIceConfig = async () => DEFAULT_ICE,
    fallbackIceConfig = DEFAULT_ICE,
    mediaDevices = globalThis.navigator?.mediaDevices,
    peerConnectionFactory = (configuration) => new globalThis.RTCPeerConnection(configuration),
    streamFactory = (tracks) => new globalThis.MediaStream(tracks),
  }) {
    this.send = send;
    this.onStream = onStream;
    this.onStatus = onStatus;
    this.onStopped = onStopped;
    this.onCaptureState = onCaptureState;
    this.onData = onData;
    this.onPeerOpen = onPeerOpen;
    this.onPeerClose = onPeerClose;
    this.getIceConfig = getIceConfig;
    this.fallbackIceConfig = fallbackIceConfig;
    this.mediaDevices = mediaDevices;
    this.peerConnectionFactory = peerConnectionFactory;
    this.streamFactory = streamFactory;
    this.localStream = null;
    this.peers = new Map();
    this.myId = null;
    this.members = new Set();
    this.desiredCanvasPeers = new Set();
    this.subscriptions = new Set();
    this.viewers = new Set();
    this._announcedSubscriptions = new Set();
    this._earlySubscriptions = new Map();
    this._hasMembership = false;
    this._wantedPeers = new Set();
    this._pendingPeers = new Map();
    this._captureVersion = 0;
    this._captureState = Object.freeze({phase:'idle',requestPending:false,source:null,viewerCount:0,paused:false,code:null,title:'',detail:'',help:[]});
    this._destroyed = false;
    this._lastStatus = '';
    this._lastStatusAt = 0;
  }

  /** Open canvas transport neighbors, excluding media-only connections. */
  get dataPeerIds() {
    return [...this.desiredCanvasPeers].filter((id) => this.peers.get(id)?.dataOpen);
  }

  getCaptureState() { return this._captureState; }

  _setCaptureState(state) {
    this._captureState = Object.freeze({...this._captureState,...state,help:Object.freeze([...(state.help ?? this._captureState.help)]),viewerCount:this.viewers.size});
    try { this.onCaptureState(this._captureState); } catch { /* UI observers must never interrupt capture cleanup. */ }
  }

  _captureAudienceChanged() {
    if (this._captureState.viewerCount !== this.viewers.size) this._setCaptureState({});
  }

  /** Watch only these screen owners. This never opts the participant into capture. */
  setSubscriptions(ids) {
    if (this._destroyed) return Promise.resolve();
    const next = new Set([...(ids || [])].filter((id) => typeof id === 'string' && id && id !== this.myId &&
      (!this._hasMembership || this.members.has(id))));
    for (const id of this.subscriptions) if (!next.has(id)) this._sendSubscription(id, false);
    this.subscriptions = next;
    for (const id of next) this._sendSubscription(id, true);
    return this._reconcileRoles();
  }

  _sendSubscription(id, subscribed, force = false) {
    if (!this.myId || !this.members.has(id) || this._destroyed) return;
    if (!force && this._announcedSubscriptions.has(id) === subscribed) return;
    if (subscribed) this._announcedSubscriptions.add(id); else this._announcedSubscriptions.delete(id);
    this.send({ type: 'signal', to: id, data: { subscribe: subscribed } });
  }

  _reconcileRoles() {
    this._wantedPeers = new Set([...this.desiredCanvasPeers, ...this.subscriptions, ...this.viewers]
      .filter((id) => this.members.has(id)));
    for (const [id, peer] of this.peers) {
      if (!this._wantedPeers.has(id)) { this._closePeer(peer); this.peers.delete(id); }
      else { this._syncCanvasRole(peer); this._emitRemote(peer); }
    }
    return Promise.all([...this._wantedPeers].map((id) => this._ensurePeer(id).catch((error) => {
      this._status(`Live screen sharing is unavailable: ${error.message || 'browser connection error'}`);
    }))).then(() => Promise.all([...this.peers.values()].map((peer) => this._updateSender(peer))));
  }

  /** Queue one complete binary message. False means the peer cannot accept it. */
  sendData(peerId, bytes) {
    const peer = this.peers.get(peerId);
    if (this._destroyed || !peer || peer.closed || !this.desiredCanvasPeers.has(peerId) || !peer.dataOpen || peer.channel?.readyState !== 'open' ||
      !(bytes instanceof Uint8Array) || bytes.byteLength > MAX_DATA_BYTES ||
      peer.dataQueuedBytes + bytes.byteLength > MAX_QUEUED_BYTES || peer.dataQueue.length >= 1024) return false;
    // The caller can reuse its buffer as soon as this method returns.
    const message = new Uint8Array(bytes);
    peer.nextDataId = (peer.nextDataId + 1) >>> 0 || 1;
    peer.dataQueue.push({
      id: peer.nextDataId, bytes: message, index: 0,
      count: Math.max(1, Math.ceil(message.byteLength / DATA_CHUNK_BYTES)),
    });
    peer.dataQueuedBytes += message.byteLength;
    this._flushData(peer);
    return true;
  }

  broadcastData(bytes) {
    let accepted = 0;
    for (const id of this.desiredCanvasPeers) if (this.sendData(id, bytes)) ++accepted;
    return accepted;
  }

  async start() {
    if (this._destroyed) return null;
    if (this._capturePending) return this._capturePending;
    if (this.localStream?.getVideoTracks().some(track => track.readyState === 'live')) return this.localStream;
    const support = displayCaptureSupport({mediaDevices:this.mediaDevices});
    if (!support.available) {
      this._setCaptureState({...displayCaptureFailure(null,support),requestPending:false,source:null,paused:false});
      return null;
    }

    const version = ++this._captureVersion;
    this._captureAbandoned = false;
    this._setCaptureState({phase:'requesting',requestPending:true,source:null,paused:false,code:null,
      title:'Choose a window in your browser',detail:'Select a tab, window, or screen in the browser picker. Nothing is shared until you confirm.',help:[]});
    // Invoke the browser picker before any asynchronous work consumes user activation.
    let capture;
    try {
      capture = this.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1280 }, frameRate: { ideal: 15, max: 15 } },
        audio: false,
      });
    } catch (error) {
      this._captureError(error);
      return null;
    }

    const pending = (async () => {
      try {
        const stream = await capture;
        const track = stream.getVideoTracks()[0];
        if (this._destroyed || version !== this._captureVersion || !track) {
          stream.getTracks().forEach((item) => item.stop());
          if (!this._destroyed && version === this._captureVersion && !track) this._captureError({name:'NotFoundError'});
          return null;
        }
        // The native picker has settled. Sender negotiation may continue, but
        // it must not prevent a new choice after the person stops this source.
        if (this._capturePending === pending) this._capturePending = null;
        this._releaseCapture();
        this.localStream = stream;
        try { track.contentHint = 'detail'; } catch { /* Optional browser hint. */ }
        this._captureEnded = () => {
          if (this.localStream === stream) this._stopLocal(true);
        };
        this._captureMuted = () => {
          if (this.localStream === stream) this._setCaptureState({paused:track.muted,source:displayCaptureSource(track)});
        };
        track.addEventListener('ended', this._captureEnded);
        track.addEventListener('mute', this._captureMuted);
        track.addEventListener('unmute', this._captureMuted);
        this._setCaptureState({phase:'sharing',requestPending:false,source:displayCaptureSource(track),paused:track.muted,code:null,
          title:'',detail:'',help:[]});
        this.onStream('local', stream);
        await Promise.all([...this.peers.values()].map((peer) => this._updateSender(peer)));
        if (this._destroyed || version !== this._captureVersion || this.localStream !== stream) return null;
        return stream;
      } catch (error) {
        if (version === this._captureVersion) this._captureError(error);
        return null;
      } finally {
        if (this._capturePending === pending) {
          this._capturePending = null;
          if (!this._destroyed && this._captureAbandoned) {
            this._captureAbandoned = false;
            this._setCaptureState({phase:'dismissed',requestPending:false,source:null,paused:false,code:null,
              title:'Nothing shared',detail:'The request was cancelled. Choose a window again whenever you’re ready.',help:[]});
          }
        }
      }
    })();
    this._capturePending = pending;
    return pending;
  }

  stop() {
    ++this._captureVersion;
    return this._stopLocal(false);
  }

  async handleSignal(from, data) {
    if (this._destroyed || !data || typeof from !== 'string' || !from || from === this.myId) return;
    if (!this.members.has(from)) {
      // Admission and signaling can arrive before the next membership snapshot.
      // Hold only the authenticated subscription intent, never unknown SDP.
      if (typeof data.subscribe === 'boolean') {
        const now = Date.now();
        for (const [id, expires] of this._earlySubscriptions) if (expires <= now) this._earlySubscriptions.delete(id);
        if (data.subscribe) {
          if (!this._earlySubscriptions.has(from) && this._earlySubscriptions.size >= MAX_EARLY_SUBSCRIPTIONS) {
            this._earlySubscriptions.delete(this._earlySubscriptions.keys().next().value);
          }
          this._earlySubscriptions.set(from, now + EARLY_SUBSCRIPTION_MS);
        }
        else this._earlySubscriptions.delete(from);
      }
      return;
    }
    try {
      if (typeof data.subscribe === 'boolean') {
        if (data.subscribe) this.viewers.add(from); else this.viewers.delete(from);
        this._captureAudienceChanged();
        await this._reconcileRoles();
      }
      if (!this._wantedPeers.has(from)) return;
      const peer = await this._ensurePeer(from);
      if (!peer) return;
      return this._enqueue(peer, async () => {
        const pc = peer.pc;
        if (data.description) {
          const description = data.description;
          if (!['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string') return;
          // A retry may reach a participant that already answered. Reuse its
          // answer; an already-applied answer likewise needs no second apply.
          if (pc.signalingState === 'stable' && pc.remoteDescription?.sdp === description.sdp) {
            if (description.type === 'offer' && pc.localDescription?.type === 'answer') this._sendDescription(peer);
            return;
          }
          const readyForOffer = !peer.makingOffer &&
            (pc.signalingState === 'stable' || peer.settingRemoteAnswer);
          const collision = description.type === 'offer' && !readyForOffer;
          peer.ignoreOffer = !peer.polite && collision;
          if (peer.ignoreOffer) {
            peer.candidates.length = 0;
            return;
          }
          // A remote ICE restart can arrive without a local failure event.
          // Refresh the answerer's relay credentials before gathering again.
          if (description.type === 'offer') await this._configurePeerIce(peer);
          if (peer.closed || this._destroyed) return;
          peer.settingRemoteAnswer = description.type === 'answer';
          try {
            // Roll back the polite participant's offer when both start sharing together.
            if (collision && pc.signalingState !== 'stable') {
              await pc.setLocalDescription({ type: 'rollback' });
            }
            await pc.setRemoteDescription(description);
          } finally {
            peer.settingRemoteAnswer = false;
          }
          // The answerer adopts the offered video transceiver. Creating its own
          // before the first offer would leave two independent video m-lines
          // after glare instead of one bidirectional screen connection.
          const adoptingTransceiver = !peer.transceiver;
          if (adoptingTransceiver) {
            peer.transceiver = pc.getTransceivers().find((item) => item.receiver.track.kind === 'video');
          }
          await this._applySender(peer);
          if (adoptingTransceiver && peer.transceiver) {
            // The answerer now has a real sender. Rebalance other viewers too;
            // their budget previously excluded this not-yet-negotiated sender.
            for (const other of this.peers.values()) if (other !== peer) this._updateSender(other);
          }
          if (typeof data.sharing === 'boolean') {
            peer.remoteSharing = data.sharing;
            this._emitRemote(peer);
          }
          const candidates = peer.candidates.splice(0);
          for (const candidate of candidates) await this._addCandidate(peer, candidate);
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            this._sendDescription(peer);
          } else if (peer.negotiateAgain) {
            peer.negotiateAgain = false;
            this._negotiate(peer);
          }
        } else if (Object.hasOwn(data, 'candidate') && data.candidate) {
          if (peer.ignoreOffer) return;
          if (pc.remoteDescription) await this._addCandidate(peer, data.candidate);
          else if (peer.candidates.length < 256) peer.candidates.push(data.candidate);
        } else if (typeof data.sharing === 'boolean') {
          peer.remoteSharing = data.sharing;
          this._emitRemote(peer);
        } else if (data.renegotiate === true && !peer.polite) {
          if (data.iceRestart) {
            await this._configurePeerIce(peer);
            if (peer.closed || this._destroyed) return;
            pc.restartIce?.();
          }
          this._negotiate(peer);
        }
      });
    } catch (error) {
      this._status(`Could not prepare a screen connection: ${error.message || 'browser connection error'}`);
    }
  }

  syncParticipants(participants, myId, { reconnect = false } = {}) {
    if (this._destroyed) return Promise.resolve();
    if (this.myId && this.myId !== myId) {
      for (const peer of this.peers.values()) this._closePeer(peer);
      this.peers.clear();
      this.viewers.clear(); this.subscriptions.clear(); this._announcedSubscriptions.clear(); this._earlySubscriptions.clear();
    }
    const previousMembers = this.members;
    this.myId = myId;
    this.members = new Set((participants || []).map((person) =>
      typeof person === 'string' ? person : person.id).filter((id) => id && id !== myId));
    this._hasMembership = true;
    for (const id of previousMembers) if (!this.members.has(id)) this._earlySubscriptions.delete(id);
    this.desiredCanvasPeers = new Set(canvasNeighbors(participants || [], myId));
    for (const set of [this.subscriptions, this.viewers, this._announcedSubscriptions]) {
      for (const id of set) if (!this.members.has(id)) set.delete(id);
    }
    const now = Date.now();
    for (const [id, expires] of this._earlySubscriptions) {
      if (expires <= now) this._earlySubscriptions.delete(id);
      else if (this.members.has(id)) { this.viewers.add(id); this._earlySubscriptions.delete(id); }
    }
    for (const id of this.subscriptions) this._sendSubscription(id, true, reconnect);
    this._captureAudienceChanged();
    return this._reconcileRoles();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    ++this._captureVersion;
    this._releaseCapture();
    this.onStream('local', null);
    for (const peer of this.peers.values()) this._closePeer(peer);
    this.peers.clear();
    this._wantedPeers.clear();
    this.members.clear(); this.desiredCanvasPeers.clear(); this.subscriptions.clear(); this.viewers.clear();
    this._announcedSubscriptions.clear(); this._earlySubscriptions.clear();
  }

  _status(message) {
    if (this._destroyed) return;
    const now = Date.now();
    if (message === this._lastStatus && now - this._lastStatusAt < 5000) return;
    this._lastStatus = message;
    this._lastStatusAt = now;
    this.onStatus(message);
  }

  _captureError(error) {
    if (this._destroyed) return;
    this._setCaptureState({...displayCaptureFailure(error,displayCaptureSupport({mediaDevices:this.mediaDevices})),
      requestPending:false,source:null,paused:false});
  }

  _releaseCapture() {
    if (!this.localStream) return;
    for (const track of this.localStream.getTracks()) {
      if (this._captureEnded) track.removeEventListener('ended', this._captureEnded);
      if (this._captureMuted) {
        track.removeEventListener('mute',this._captureMuted);
        track.removeEventListener('unmute',this._captureMuted);
      }
      track.stop();
    }
    this._captureEnded = null;
    this._captureMuted = null;
    this.localStream = null;
  }

  _stopLocal(notifyStopped) {
    const wasSharing = Boolean(this.localStream);
    this._releaseCapture();
    if (!this._destroyed) {
      // getDisplayMedia cannot be aborted. Keep the pending marker until its
      // picker settles, and stop every track if an abandoned choice arrives.
      if (this._capturePending && this._captureState.requestPending) {
        this._captureAbandoned = true;
        this._setCaptureState({phase:'abandoning',requestPending:true,source:null,paused:false,code:null,
          title:'Close the browser picker',detail:'This request is cancelled here. Close or cancel the browser picker before choosing again. Any late choice will be stopped.',help:[]});
      } else if (wasSharing) this._setCaptureState({phase:'stopped',requestPending:false,source:null,paused:false,code:null,
        title:'Sharing stopped',detail:'Your window is no longer shared. You can choose another whenever you’re ready.',help:[]});
    }
    if (wasSharing) this.onStream('local', null);
    const updates = Promise.all([...this.peers.values()].map((peer) => this._updateSender(peer)));
    if (wasSharing && notifyStopped) this.onStopped();
    return updates;
  }

  _iceConfiguration() {
    if (this._iceConfig && Date.now() < this._iceExpiresAt) return Promise.resolve(this._iceConfig);
    if (this._icePromise) return this._icePromise;
    const pending = Promise.resolve().then(() => this.getIceConfig()).then((response) => {
      if (!response || !Array.isArray(response.iceServers)) throw new Error('Missing ICE configuration');
      // expiresAt is metadata from the admission service, not RTCConfiguration.
      const { expiresAt, ...configuration } = response;
      const numericExpiry = typeof expiresAt === 'number' ? expiresAt : Number(expiresAt);
      const expiry = expiresAt == null ? Infinity : Number.isFinite(numericExpiry)
        ? numericExpiry * (numericExpiry < 1e12 ? 1000 : 1) : Date.parse(expiresAt);
      const now = Date.now();
      if ((!Number.isFinite(expiry) && expiry !== Infinity) || expiry <= now) {
        throw new Error('Expired ICE configuration');
      }
      this._iceConfig = configuration;
      this._iceExpiresAt = Math.min(now + ICE_CACHE_MS, expiry - ICE_EXPIRY_MARGIN_MS);
      return configuration;
    }).catch(() => {
      // A transient outage must not permanently pin this session to STUN-only.
      this._iceConfig = null;
      this._iceExpiresAt = 0;
      this._status('Connection settings could not be loaded. Retrying with this installation’s fallback settings.');
      return typeof this.fallbackIceConfig === 'function' ? this.fallbackIceConfig() : this.fallbackIceConfig;
    }).finally(() => {
      if (this._icePromise === pending) this._icePromise = null;
    });
    this._icePromise = pending;
    return this._icePromise;
  }

  async _configurePeerIce(peer) {
    const configuration = await this._iceConfiguration();
    if (peer.closed || this._destroyed || peer.iceConfiguration === configuration) return;
    peer.pc.setConfiguration(configuration);
    peer.iceConfiguration = configuration;
    peer.hasTurn = hasTurn(configuration);
  }

  _ensurePeer(id) {
    if (this.peers.has(id)) return Promise.resolve(this.peers.get(id));
    if (this._pendingPeers.has(id)) return this._pendingPeers.get(id);
    const pending = (async () => {
      const configuration = await this._iceConfiguration();
      if (this._destroyed || !this._wantedPeers.has(id) || !this.myId) return null;
      const pc = this.peerConnectionFactory(configuration);
      const peer = {
        id, pc, polite: String(this.myId) > String(id),
        makingOffer: false, ignoreOffer: false, settingRemoteAnswer: false,
        candidates: [], operations: Promise.resolve(), closed: false,
        remoteStream: null, remoteSharing: undefined, remoteCleanup: null,
        iceConfiguration: configuration, hasTurn: hasTurn(configuration),
        channel: null, dataOpen: false, canvasRole: this.desiredCanvasPeers.has(id), dataRoleVersion: 0, nextDataId: 0,
        dataQueue: [], dataQueuedBytes: 0, dataAssemblies: new Map(), dataAssemblyBytes: 0,
        dataBlobBytes: 0, dataFrames: 0, dataFrameWindow: Date.now(),
      };
      this.peers.set(id, peer);
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && !peer.closed) this.send({
          type: 'signal', to: id, data: { candidate: candidate.toJSON?.() || candidate },
        });
      };
      pc.onnegotiationneeded = () => this._negotiate(peer);
      pc.ondatachannel = ({ channel }) => this._adoptDataChannel(peer, channel);
      pc.ontrack = (event) => {
        if (event.track.kind !== 'video' || peer.closed) return;
        peer.remoteCleanup?.();
        peer.remoteStream = event.streams?.[0] || this.streamFactory([event.track]);
        const ended = () => {
          if (peer.remoteStream?.getVideoTracks().every((track) => track.readyState === 'ended')) {
            peer.remoteStream = null;
            this._emitRemote(peer);
          }
        };
        event.track.addEventListener('ended', ended);
        peer.remoteCleanup = () => event.track.removeEventListener('ended', ended);
        this._emitRemote(peer);
      };
      pc.onconnectionstatechange = () => {
        clearTimeout(peer.disconnectTimer);
        if (pc.connectionState === 'connected') {
          peer.restarted = false;
          peer.negotiationRetries = 0;
          clearTimeout(peer.negotiationRetryTimer); peer.negotiationRetryTimer = null;
        }
        else if (pc.connectionState === 'failed') this._restartPeer(peer, true);
        else if (pc.connectionState === 'disconnected') {
          peer.disconnectTimer = setTimeout(() => this._restartPeer(peer, false), 10000);
        }
      };
      // Only one participant creates the initial transceiver. Keep it sendrecv
      // while idle so screen capture can start or stop without disabling ICE or
      // changing the media section the other participant uses for its screen.
      if (!peer.polite) {
        this._openDataChannel(peer);
        const track = this.viewers.has(id) ? this.localStream?.getVideoTracks()[0] : null;
        peer.transceiver = pc.addTransceiver(track || 'video', {
          direction: 'sendrecv',
        });
        peer.attachedTrack = track || null;
      } else {
        // This also retries an offer that arrived before membership caught up.
        this._negotiate(peer);
      }
      this._scheduleNegotiationRetry(peer);
      return peer;
    })().finally(() => this._pendingPeers.delete(id));
    this._pendingPeers.set(id, pending);
    return pending;
  }

  _openDataChannel(peer) {
    if (peer.closed || this._destroyed || !this.desiredCanvasPeers.has(peer.id) || peer.channel || peer.pc.signalingState === 'closed') return;
    try {
      this._adoptDataChannel(peer, peer.pc.createDataChannel(DATA_LABEL, { ordered: true }));
    } catch (error) {
      this._status(`The shared canvas connection is unavailable: ${error.message || 'browser connection error'}`);
    }
  }

  _adoptDataChannel(peer, channel) {
    if (!channel) return;
    if (peer.closed || this._destroyed || channel.label !== DATA_LABEL ||
      (peer.channel && peer.channel !== channel)) {
      channel.close();
      return;
    }
    if (peer.channel === channel) return;
    clearTimeout(peer.dataReconnectTimer);
    peer.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = DATA_LOW_WATER;
    channel.onopen = () => {
      if (peer.closed || this._destroyed || peer.channel !== channel) return;
      this._syncCanvasRole(peer);
    };
    channel.onmessage = ({ data }) => this._receiveData(peer, channel, data);
    channel.onbufferedamountlow = () => this._flushData(peer);
    channel.onclose = () => {
      if (peer.channel !== channel) return;
      this._clearDataChannel(peer);
      // The same deterministic offer owner recreates a closed data channel.
      // Existing video transceivers stay intact while SDP adds its replacement.
      if (!peer.polite && !peer.closed && !this._destroyed && this.desiredCanvasPeers.has(peer.id)) {
        peer.dataReconnectTimer = setTimeout(() => this._openDataChannel(peer), 500);
        peer.dataReconnectTimer.unref?.();
      }
    };
    channel.onerror = () => {
      if (peer.channel === channel && channel.readyState === 'closed') channel.onclose?.();
    };
    // Browsers normally dispatch open later. This also handles an already-open
    // channel delivered by a test adapter without calling users mid-adoption.
    if (channel.readyState === 'open') queueMicrotask(() => channel.onopen?.());
  }

  _syncCanvasRole(peer) {
    const desired = this.desiredCanvasPeers.has(peer.id);
    if (peer.canvasRole !== desired) {
      peer.canvasRole = desired;
      ++peer.dataRoleVersion;
      if (!desired) this._resetDataBuffers(peer);
    }
    if (desired && !peer.channel && !peer.polite) this._openDataChannel(peer);
    const open = desired && peer.channel?.readyState === 'open' && !peer.closed && !this._destroyed;
    if (open && !peer.dataOpen) { peer.dataOpen = true; this.onPeerOpen(peer.id); }
    else if (!open && peer.dataOpen) { peer.dataOpen = false; this.onPeerClose(peer.id); }
    if (open) this._flushData(peer);
  }

  _flushData(peer) {
    clearTimeout(peer.dataSendTimer);
    peer.dataSendTimer = null;
    const channel = peer.channel;
    if (peer.closed || this._destroyed || !peer.dataOpen || !this.desiredCanvasPeers.has(peer.id) || channel?.readyState !== 'open') return;
    let sent = 0;
    while (peer.dataQueue.length && sent < 64) {
      const message = peer.dataQueue[0];
      const offset = message.index * DATA_CHUNK_BYTES;
      const length = Math.min(DATA_CHUNK_BYTES, message.bytes.byteLength - offset);
      if (channel.bufferedAmount + length + DATA_HEADER_BYTES > DATA_HIGH_WATER) break;
      const frame = new Uint8Array(DATA_HEADER_BYTES + length);
      const header = new DataView(frame.buffer);
      header.setUint32(0, DATA_MAGIC);
      header.setUint32(4, message.id);
      header.setUint32(8, message.bytes.byteLength);
      header.setUint32(12, message.index);
      header.setUint32(16, message.count);
      frame.set(message.bytes.subarray(offset, offset + length), DATA_HEADER_BYTES);
      try { channel.send(frame); } catch {
        // OperationError can mean the browser's SCTP buffer is temporarily full.
        // Retain this frame and retry; a close event performs final cleanup.
        break;
      }
      ++sent;
      if (++message.index === message.count) {
        peer.dataQueue.shift();
        peer.dataQueuedBytes -= message.bytes.byteLength;
      }
    }
    if (peer.dataQueue.length && channel.readyState === 'open') {
      // The low-buffer event is primary; the timer also supports browsers which
      // do not emit it after a send failure or a queue added below the threshold.
      peer.dataSendTimer = setTimeout(() => this._flushData(peer), sent === 64 ? 0 : 50);
      peer.dataSendTimer.unref?.();
    }
  }

  _receiveData(peer, channel, data) {
    if (peer.closed || this._destroyed || !this.desiredCanvasPeers.has(peer.id) || peer.channel !== channel) return;
    if (data instanceof ArrayBuffer) return this._receiveFrame(peer, new Uint8Array(data));
    if (ArrayBuffer.isView(data)) {
      return this._receiveFrame(peer, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    // binaryType is arraybuffer, but accept Blob for browser adapters too. Bound
    // conversions in flight so queued asynchronous reads cannot consume memory.
    if (typeof Blob !== 'undefined' && data instanceof Blob &&
      data.size <= DATA_HEADER_BYTES + DATA_CHUNK_BYTES && peer.dataBlobBytes + data.size <= MAX_ASSEMBLY_BYTES) {
      const roleVersion = peer.dataRoleVersion;
      peer.dataBlobBytes += data.size;
      data.arrayBuffer().then((buffer) => {
        if (!peer.closed && !this._destroyed && peer.channel === channel && peer.dataRoleVersion === roleVersion) {
          this._receiveFrame(peer, new Uint8Array(buffer));
        }
      }).catch(() => {}).finally(() => {
        if (peer.channel === channel && peer.dataRoleVersion === roleVersion) peer.dataBlobBytes -= data.size;
      });
    }
  }

  _receiveFrame(peer, frame) {
    if (peer.closed || this._destroyed || !peer.dataOpen || !this.desiredCanvasPeers.has(peer.id)) return;
    const now = Date.now();
    if (now - peer.dataFrameWindow >= 1000) {
      peer.dataFrameWindow = now;
      peer.dataFrames = 0;
    }
    if (++peer.dataFrames > MAX_FRAMES_PER_SECOND || frame.byteLength < DATA_HEADER_BYTES ||
      frame.byteLength > DATA_HEADER_BYTES + DATA_CHUNK_BYTES) return;
    const header = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const id = header.getUint32(4);
    const total = header.getUint32(8);
    const index = header.getUint32(12);
    const count = header.getUint32(16);
    if (header.getUint32(0) !== DATA_MAGIC || !id || total > MAX_DATA_BYTES ||
      count !== Math.max(1, Math.ceil(total / DATA_CHUNK_BYTES)) || index >= count ||
      frame.byteLength !== DATA_HEADER_BYTES + Math.min(DATA_CHUNK_BYTES, total - index * DATA_CHUNK_BYTES)) return;
    this._expireDataAssemblies(peer, now);
    let assembly = peer.dataAssemblies.get(id);
    if (assembly && (assembly.total !== total || assembly.count !== count)) return;
    if (!assembly) {
      if (peer.dataAssemblies.size >= MAX_ASSEMBLIES || peer.dataAssemblyBytes + total > MAX_ASSEMBLY_BYTES) return;
      assembly = {
        total, count, bytes: new Uint8Array(total), received: new Uint8Array(count),
        parts: 0, expires: now + ASSEMBLY_TIMEOUT_MS,
      };
      peer.dataAssemblies.set(id, assembly);
      peer.dataAssemblyBytes += total;
      this._scheduleDataExpiry(peer);
    }
    if (assembly.received[index]) return;
    assembly.received[index] = 1;
    assembly.bytes.set(frame.subarray(DATA_HEADER_BYTES), index * DATA_CHUNK_BYTES);
    if (++assembly.parts === count) {
      peer.dataAssemblies.delete(id);
      peer.dataAssemblyBytes -= total;
      this._scheduleDataExpiry(peer);
      this.onData(peer.id, assembly.bytes);
    }
  }

  _expireDataAssemblies(peer, now = Date.now()) {
    for (const [id, assembly] of peer.dataAssemblies) {
      if (assembly.expires <= now) {
        peer.dataAssemblies.delete(id);
        peer.dataAssemblyBytes -= assembly.total;
      }
    }
  }

  _scheduleDataExpiry(peer) {
    clearTimeout(peer.dataExpiryTimer);
    peer.dataExpiryTimer = null;
    if (!peer.dataAssemblies.size) return;
    const deadline = Math.min(...[...peer.dataAssemblies.values()].map((assembly) => assembly.expires));
    peer.dataExpiryTimer = setTimeout(() => {
      this._expireDataAssemblies(peer);
      this._scheduleDataExpiry(peer);
    }, Math.max(1, deadline - Date.now()));
    peer.dataExpiryTimer.unref?.();
  }

  _resetDataBuffers(peer) {
    clearTimeout(peer.dataSendTimer);
    clearTimeout(peer.dataExpiryTimer);
    peer.dataSendTimer = peer.dataExpiryTimer = null;
    peer.dataQueue.length = 0;
    peer.dataQueuedBytes = peer.dataAssemblyBytes = peer.dataBlobBytes = 0;
    peer.dataAssemblies.clear();
  }

  _clearDataChannel(peer) {
    this._resetDataBuffers(peer);
    clearTimeout(peer.dataReconnectTimer);
    peer.dataReconnectTimer = null;
    ++peer.dataRoleVersion;
    const channel = peer.channel;
    peer.channel = null;
    if (channel) {
      channel.onopen = channel.onmessage = channel.onbufferedamountlow = channel.onclose = channel.onerror = null;
      channel.close();
    }
    if (peer.dataOpen) {
      peer.dataOpen = false;
      this.onPeerClose(peer.id);
    }
  }

  _enqueue(peer, operation) {
    const next = peer.operations.then(() => {
      if (!peer.closed && !this._destroyed) return operation();
    }).catch((error) => {
      if (!peer.closed && !this._destroyed) {
        this._status(`A screen connection could not be updated: ${error.message || 'connection error'}`);
      }
    });
    peer.operations = next;
    return next;
  }

  _negotiate(peer) {
    return this._enqueue(peer, async () => {
      // A single offer owner also serializes simultaneous ICE restarts. The
      // answerer requests an offer instead of introducing negotiation glare.
      if (peer.polite) {
        this.send({ type: 'signal', to: peer.id, data: {
          renegotiate: true, iceRestart: Boolean(peer.restarted),
        } });
        return;
      }
      if (peer.pc.signalingState !== 'stable') {
        if (peer.pc.signalingState === 'have-local-offer' && peer.pc.localDescription?.type === 'offer') this._sendDescription(peer);
        else peer.negotiateAgain = true;
        return;
      }
      try {
        peer.makingOffer = true;
        await peer.pc.setLocalDescription();
        this._sendDescription(peer);
      } finally {
        peer.makingOffer = false;
      }
    });
  }

  _scheduleNegotiationRetry(peer) {
    if (!this._needsNegotiationRetry(peer) || peer.negotiationRetryTimer ||
      (peer.negotiationRetries || 0) >= MAX_NEGOTIATION_RETRIES) return;
    peer.negotiationRetryTimer = setTimeout(() => this._retryNegotiation(peer), NEGOTIATION_RETRY_MS);
    peer.negotiationRetryTimer.unref?.();
  }

  _retryNegotiation(peer) {
    clearTimeout(peer.negotiationRetryTimer); peer.negotiationRetryTimer = null;
    if (!this._needsNegotiationRetry(peer) ||
      (peer.negotiationRetries || 0) >= MAX_NEGOTIATION_RETRIES) return Promise.resolve();
    peer.negotiationRetries = (peer.negotiationRetries || 0) + 1;
    if (this.subscriptions.has(peer.id)) this._sendSubscription(peer.id, true, true);
    const operation = this._enqueue(peer, () => this._configurePeerIce(peer)).then(() => this._negotiate(peer));
    this._scheduleNegotiationRetry(peer);
    return operation;
  }

  _needsNegotiationRetry(peer) {
    return !peer.closed && !this._destroyed &&
      (peer.pc.connectionState !== 'connected' || peer.pc.signalingState !== 'stable');
  }

  _sendDescription(peer) {
    const { type, sdp } = peer.pc.localDescription;
    this.send({ type: 'signal', to: peer.id, data: {
      description: { type, sdp }, sharing: Boolean(this.localStream && this.viewers.has(peer.id)),
    } });
    if (type === 'offer') this._scheduleNegotiationRetry(peer);
  }

  _updateSender(peer) {
    return this._enqueue(peer, async () => {
      await this._applySender(peer);
      // replaceTrack alone does not require SDP negotiation. Publish capture
      // state separately and keep the receiver's stream stable per participant.
      const sharing = Boolean(this.localStream && this.viewers.has(peer.id));
      if (sharing !== peer.lastSentSharing) {
        peer.lastSentSharing = sharing;
        this.send({ type: 'signal', to: peer.id, data: { sharing } });
      }
    });
  }

  async _applySender(peer) {
    if (!peer.transceiver) return; // Initial offer has not reached the answerer.
    const track = this.viewers.has(peer.id) ? this.localStream?.getVideoTracks()[0] || null : null;
    const sender = peer.transceiver.sender;
    if (peer.attachedTrack !== track) {
      await sender.replaceTrack(track);
      peer.attachedTrack = track;
    }
    peer.transceiver.direction = 'sendrecv';
    if (track && typeof sender.getParameters === 'function' && typeof sender.setParameters === 'function') {
      const viewers = [...this.viewers].filter((id) => this.peers.get(id)?.transceiver && !this.peers.get(id)?.closed).length;
      const bitrate = Math.max(MIN_VIEWER_BITS, Math.floor(SCREEN_BUDGET_BITS / Math.max(1, viewers)));
      if (peer.senderBudgetBits !== bitrate) {
        peer.senderBudgetBits = bitrate;
        try {
          const parameters = sender.getParameters() || {};
          if (!parameters.encodings?.length) parameters.encodings = [{}];
          parameters.encodings[0].maxBitrate = bitrate;
          parameters.encodings[0].maxFramerate = 15;
          await sender.setParameters(parameters);
        } catch { /* Sender budgets are optional browser capabilities. */ }
      }
    }
  }

  async _addCandidate(peer, candidate) {
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (error) {
      // Ignore stale candidates belonging to a rolled-back offer or ICE restart.
      const fragment = candidate.usernameFragment;
      if (peer.ignoreOffer || (fragment && !peer.pc.remoteDescription?.sdp?.includes(`a=ice-ufrag:${fragment}`))) return;
      throw error;
    }
  }

  _emitRemote(peer) {
    const stream = this.subscriptions.has(peer.id) && peer.remoteSharing !== false ? peer.remoteStream : null;
    if (stream !== (peer.emittedStream || null)) {
      peer.emittedStream = stream;
      this.onStream(peer.id, stream);
    }
  }

  _restartPeer(peer, failed) {
    if (peer.closed || this._destroyed) return;
    if (this.subscriptions.has(peer.id)) this._sendSubscription(peer.id, true, true);
    if (failed && (this.localStream || peer.remoteSharing)) this._status(peer.hasTurn
      ? 'A screen connection failed. Reconnecting; check your network if it continues.'
      : 'A screen connection failed. Reconnecting; this network may need a TURN relay.');
    if (!peer.restarted) {
      peer.restarted = true;
      peer.negotiationRetries = 0;
      this._scheduleNegotiationRetry(peer);
      return this._enqueue(peer, async () => {
        await this._configurePeerIce(peer);
        if (!peer.closed && !this._destroyed) peer.pc.restartIce?.();
      });
    }
  }

  _closePeer(peer) {
    peer.closed = true;
    this._clearDataChannel(peer);
    clearTimeout(peer.disconnectTimer);
    clearTimeout(peer.negotiationRetryTimer); peer.negotiationRetryTimer = null;
    peer.remoteCleanup?.();
    peer.pc.onicecandidate = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.ontrack = null;
    peer.pc.ondatachannel = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.onStream(peer.id, null);
  }
}
