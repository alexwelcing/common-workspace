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

/** Direct peer connections carry one screen and the shared canvas per participant. */
export class ScreenSharing {
  constructor({
    send,
    onStream = () => {},
    onStatus = () => {},
    onStopped = () => {},
    onData = () => {},
    onPeerOpen = () => {},
    onPeerClose = () => {},
    getIceConfig = async () => DEFAULT_ICE,
    mediaDevices = globalThis.navigator?.mediaDevices,
    peerConnectionFactory = (configuration) => new globalThis.RTCPeerConnection(configuration),
    streamFactory = (tracks) => new globalThis.MediaStream(tracks),
  }) {
    this.send = send;
    this.onStream = onStream;
    this.onStatus = onStatus;
    this.onStopped = onStopped;
    this.onData = onData;
    this.onPeerOpen = onPeerOpen;
    this.onPeerClose = onPeerClose;
    this.getIceConfig = getIceConfig;
    this.mediaDevices = mediaDevices;
    this.peerConnectionFactory = peerConnectionFactory;
    this.streamFactory = streamFactory;
    this.localStream = null;
    this.peers = new Map();
    this.myId = null;
    this._wantedPeers = new Set();
    this._pendingPeers = new Map();
    this._captureVersion = 0;
    this._destroyed = false;
    this._lastStatus = '';
    this._lastStatusAt = 0;
  }

  /** Queue one complete binary message. False means the peer cannot accept it. */
  sendData(peerId, bytes) {
    const peer = this.peers.get(peerId);
    if (this._destroyed || !peer || peer.closed || peer.channel?.readyState !== 'open' ||
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
    for (const id of this.peers.keys()) if (this.sendData(id, bytes)) ++accepted;
    return accepted;
  }

  async start() {
    if (this._destroyed) return null;
    if (this._capturePending) return this._capturePending;
    if (!this.mediaDevices?.getDisplayMedia) {
      this._status('Screen sharing needs a supported desktop browser over HTTPS or localhost.');
      return null;
    }

    const version = ++this._captureVersion;
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
          return null;
        }
        this._releaseCapture();
        this.localStream = stream;
        try { track.contentHint = 'detail'; } catch { /* Optional browser hint. */ }
        this._captureEnded = () => {
          if (this.localStream === stream) this._stopLocal(true);
        };
        track.addEventListener('ended', this._captureEnded);
        this.onStream('local', stream);
        await Promise.all([...this.peers.values()].map((peer) => this._updateSender(peer)));
        return stream;
      } catch (error) {
        this._captureError(error);
        return null;
      } finally {
        if (this._capturePending === pending) this._capturePending = null;
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
    if (this._destroyed || !data || !this._wantedPeers.has(from)) return;
    try {
      const peer = await this._ensurePeer(from);
      if (!peer) return;
      return this._enqueue(peer, async () => {
        const pc = peer.pc;
        if (data.description) {
          const description = data.description;
          if (!['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string') return;
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
          if (!peer.transceiver) {
            peer.transceiver = pc.getTransceivers().find((item) => item.receiver.track.kind === 'video');
          }
          await this._applySender(peer);
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

  syncParticipants(participants, myId) {
    if (this._destroyed) return Promise.resolve();
    if (this.myId && this.myId !== myId) {
      for (const peer of this.peers.values()) this._closePeer(peer);
      this.peers.clear();
    }
    this.myId = myId;
    this._wantedPeers = new Set((participants || []).map((person) =>
      typeof person === 'string' ? person : person.id).filter((id) => id && id !== myId));
    for (const [id, peer] of this.peers) {
      if (!this._wantedPeers.has(id)) {
        this._closePeer(peer);
        this.peers.delete(id);
      }
    }
    return Promise.all([...this._wantedPeers].map((id) => this._ensurePeer(id).catch((error) => {
      this._status(`Live screen sharing is unavailable: ${error.message || 'browser connection error'}`);
    })));
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
    const message = error?.name === 'NotAllowedError'
      ? 'Screen sharing was canceled or blocked by your browser.'
      : error?.name === 'NotReadableError'
        ? 'Your browser could not read that window. Check screen recording permissions and try again.'
        : `Could not share this screen: ${error?.message || 'please try again'}`;
    this._status(message);
  }

  _releaseCapture() {
    if (!this.localStream) return;
    for (const track of this.localStream.getTracks()) {
      if (this._captureEnded) track.removeEventListener('ended', this._captureEnded);
      track.stop();
    }
    this._captureEnded = null;
    this.localStream = null;
  }

  _stopLocal(notifyStopped) {
    const wasSharing = Boolean(this.localStream);
    this._releaseCapture();
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
      this._status('Connection settings could not be loaded; using the default connection service.');
      return DEFAULT_ICE;
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
        channel: null, dataOpen: false, nextDataId: 0,
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
            this.onStream(id, null);
          }
        };
        event.track.addEventListener('ended', ended);
        peer.remoteCleanup = () => event.track.removeEventListener('ended', ended);
        this._emitRemote(peer);
      };
      pc.onconnectionstatechange = () => {
        clearTimeout(peer.disconnectTimer);
        if (pc.connectionState === 'connected') peer.restarted = false;
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
        const track = this.localStream?.getVideoTracks()[0];
        peer.transceiver = pc.addTransceiver(track || 'video', {
          direction: 'sendrecv',
        });
      }
      return peer;
    })().finally(() => this._pendingPeers.delete(id));
    this._pendingPeers.set(id, pending);
    return pending;
  }

  _openDataChannel(peer) {
    if (peer.closed || this._destroyed || peer.channel || peer.pc.signalingState === 'closed') return;
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
      if (peer.closed || this._destroyed || peer.channel !== channel || peer.dataOpen) return;
      peer.dataOpen = true;
      this.onPeerOpen(peer.id);
      this._flushData(peer);
    };
    channel.onmessage = ({ data }) => this._receiveData(peer, channel, data);
    channel.onbufferedamountlow = () => this._flushData(peer);
    channel.onclose = () => {
      if (peer.channel !== channel) return;
      this._clearDataChannel(peer);
      // The same deterministic offer owner recreates a closed data channel.
      // Existing video transceivers stay intact while SDP adds its replacement.
      if (!peer.polite && !peer.closed && !this._destroyed) {
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

  _flushData(peer) {
    clearTimeout(peer.dataSendTimer);
    peer.dataSendTimer = null;
    const channel = peer.channel;
    if (peer.closed || this._destroyed || channel?.readyState !== 'open') return;
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
    if (peer.closed || this._destroyed || peer.channel !== channel) return;
    if (data instanceof ArrayBuffer) return this._receiveFrame(peer, new Uint8Array(data));
    if (ArrayBuffer.isView(data)) {
      return this._receiveFrame(peer, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    // binaryType is arraybuffer, but accept Blob for browser adapters too. Bound
    // conversions in flight so queued asynchronous reads cannot consume memory.
    if (typeof Blob !== 'undefined' && data instanceof Blob &&
      data.size <= DATA_HEADER_BYTES + DATA_CHUNK_BYTES && peer.dataBlobBytes + data.size <= MAX_ASSEMBLY_BYTES) {
      peer.dataBlobBytes += data.size;
      data.arrayBuffer().then((buffer) => {
        if (!peer.closed && !this._destroyed && peer.channel === channel) {
          this._receiveFrame(peer, new Uint8Array(buffer));
        }
      }).catch(() => {}).finally(() => {
        if (peer.channel === channel) peer.dataBlobBytes -= data.size;
      });
    }
  }

  _receiveFrame(peer, frame) {
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

  _clearDataChannel(peer) {
    clearTimeout(peer.dataSendTimer);
    clearTimeout(peer.dataExpiryTimer);
    clearTimeout(peer.dataReconnectTimer);
    peer.dataSendTimer = peer.dataExpiryTimer = peer.dataReconnectTimer = null;
    const channel = peer.channel;
    peer.channel = null;
    if (channel) {
      channel.onopen = channel.onmessage = channel.onbufferedamountlow = channel.onclose = channel.onerror = null;
      channel.close();
    }
    peer.dataQueue.length = 0;
    peer.dataQueuedBytes = peer.dataAssemblyBytes = peer.dataBlobBytes = 0;
    peer.dataAssemblies.clear();
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
        peer.negotiateAgain = true;
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

  _sendDescription(peer) {
    const { type, sdp } = peer.pc.localDescription;
    this.send({ type: 'signal', to: peer.id, data: {
      description: { type, sdp }, sharing: Boolean(this.localStream),
    } });
  }

  _updateSender(peer) {
    return this._enqueue(peer, async () => {
      await this._applySender(peer);
      // replaceTrack alone does not require SDP negotiation. Publish capture
      // state separately and keep the receiver's stream stable per participant.
      this.send({ type: 'signal', to: peer.id, data: { sharing: Boolean(this.localStream) } });
    });
  }

  async _applySender(peer) {
    if (!peer.transceiver) return; // Initial offer has not reached the answerer.
    const track = this.localStream?.getVideoTracks()[0] || null;
    await peer.transceiver.sender.replaceTrack(track);
    peer.transceiver.direction = 'sendrecv';
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
    this.onStream(peer.id, peer.remoteSharing === false ? null : peer.remoteStream);
  }

  _restartPeer(peer, failed) {
    if (peer.closed || this._destroyed) return;
    if (failed && (this.localStream || peer.remoteSharing)) this._status(peer.hasTurn
      ? 'A screen connection failed. Reconnecting; check your network if it continues.'
      : 'A screen connection failed. Reconnecting; this network may need a TURN relay.');
    if (!peer.restarted) {
      peer.restarted = true;
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
