const MiB = 1024 * 1024;
const captureError = (message, code) => Object.assign(new Error(message), { code });
const SAFE_RASTER = /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i;
const MIME_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const liveVideo = stream => stream?.getVideoTracks?.().some(track => track.readyState === 'live');
const pointsOf = entity => (entity.points || []).map(point => Array.isArray(point) ? { x: finite(point[0]), y: finite(point[1]) } : { x: finite(point.x), y: finite(point.y) });
const hasExternalUrl = value => [...String(value).matchAll(/url\(([^)]*)\)/gi)].some(match => !match[1].trim().replace(/^(['"])(.*)\1$/, '$2').startsWith('#'));

/** Local-only PNG capture and bounded video recording. Never requests screen permissions. */
export class CanvasCapture {
  constructor({ getBoard = () => null, getWindowStream = () => null, getSession = null, onChange = () => {}, onStatus = () => {},
    document = globalThis.document, MediaRecorder = globalThis.MediaRecorder, Image = globalThis.Image,
    XMLSerializer = globalThis.XMLSerializer, URL = globalThis.URL, Blob = globalThis.Blob,
    now = () => Date.now(), setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval,
    setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout,
    maxDurationMs = 5 * 60 * 1000, maxRecordingBytes = 100 * MiB, maxTotalBytes = 150 * MiB, maxRecords = 3, fps = 12,
  } = {}) {
    Object.assign(this, { getBoard, getWindowStream, onChange, onStatus, document, MediaRecorder, Image, XMLSerializer, URL, Blob, now, setInterval, clearInterval, setTimeout, clearTimeout });
    // Browser timer methods require Window as their receiver. Calling an
    // unbound method through a capture instance raises Illegal invocation.
    this.setInterval = setInterval.bind(globalThis); this.clearInterval = clearInterval.bind(globalThis);
    this.setTimeout = setTimeout.bind(globalThis); this.clearTimeout = clearTimeout.bind(globalThis);
    this.getSession = getSession || (() => this.getBoard());
    this.limits = { maxDurationMs: Math.max(1, Math.min(300000, maxDurationMs)), maxRecordingBytes: Math.max(1, Math.min(100 * MiB, maxRecordingBytes)), maxTotalBytes: Math.max(1, Math.min(150 * MiB, maxTotalBytes)), maxRecords: Math.max(1, Math.min(3, Math.floor(maxRecords))) };
    this.fps = Math.min(15, Math.max(1, fps));
    this.records = new Map(); this.assets = new Map(); this.urls = new Set(); this.downloadTimers = new Set(); this.current = null; this.starting = false; this.pending = null; this.generation = 0; this.destroyed = false; this.nextId = 0;
  }

  status() {
    const item = this.current;
    return { state: this.destroyed ? 'destroyed' : this.starting ? 'starting' : item ? item.stopping ? 'stopping' : 'recording' : 'idle', source: item?.source || null, id: item?.id || null,
      elapsedMs: item ? Math.max(0, this.now() - item.startedAt) : 0, bytes: item?.bytes || 0, windowShared: !!liveVideo(this.getWindowStream()), recordings: this.records.size, retainedBytes: this._retainedBytes(), limits: { ...this.limits } };
  }
  _changed() { this.onChange(this.status()); }
  _assertAlive() { if (this.destroyed) throw captureError('Capture has been closed.', 'CAPTURE_CLOSED'); }
  _retainedBytes() { return [...this.records.values()].reduce((sum, item) => sum + item.blob.size, 0); }
  list() { return [...this.records.values()].map(item => ({ ...item.metadata })); }
  /** Read an immutable saved Blob for an explicitly requested local export. */
  getRecordingBlob(id) {
    this._assertAlive();
    const item = this.records.get(id);
    if (!item) throw captureError('Recording not found.', 'RECORDING_NOT_FOUND');
    return item.blob;
  }
  _board() {
    const board = this.getBoard();
    if (!board?.el || typeof board.listEntities !== 'function') throw captureError('Open the canvas before capturing it.', 'CAPTURE_UNAVAILABLE');
    return board;
  }
  _canvas(board) {
    const canvas = this.document?.createElement('canvas');
    if (!canvas?.getContext) throw captureError('Canvas capture is unavailable in this browser.', 'CAPTURE_UNSUPPORTED');
    const width = Math.max(1, finite(board.el.clientWidth, 1280)), height = Math.max(1, finite(board.el.clientHeight, 720));
    const scale = Math.min(1, 1920 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    if (!canvas.getContext('2d')) throw captureError('Canvas capture is unavailable in this browser.', 'CAPTURE_UNSUPPORTED');
    return canvas;
  }

  _assertSnapshot(board, session, isAllowed) {
    this._assertAlive();
    if (this.getBoard() !== board || this.getSession() !== session || !isAllowed()) throw captureError('Snapshot was canceled because access or the session changed.', 'CAPTURE_CANCELLED');
  }
  async _prepareInitial(board, check) {
    if (typeof board.whenReadyForCapture === 'function') { await board.whenReadyForCapture(); check(); }
    await this._prepareAssets(board); check();
  }
  async snapshot({ download = false, isAllowed = () => true } = {}) {
    this._assertAlive();
    if (typeof isAllowed !== 'function') throw captureError('Snapshot access must be checked with a function.', 'CAPTURE_INVALID');
    const board = this._board(), session = this.getSession(), canvas = this._canvas(board);
    const check = () => this._assertSnapshot(board, session, isAllowed);
    check(); await this._prepareInitial(board, check);
    check(); this._drawFrame(canvas, board);
    const result = { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, mimeType: 'image/png' };
    check();
    if (download) { check(); this._downloadUrl(result.dataUrl, `common-canvas-${this.now()}.png`); }
    return result;
  }

  _assertStart(pending) {
    this._assertAlive();
    if (pending.cancelled || this.pending !== pending || pending.generation !== this.generation || !pending.isAllowed()
      || this.getBoard() !== pending.board || this.getSession() !== pending.session || (pending.source === 'window' && this.getWindowStream() !== pending.stream)) {
      throw captureError('Recording start was canceled because access, the session, or its source changed.', 'CAPTURE_CANCELLED');
    }
  }
  _cancelPending() {
    const pending = this.pending;
    if (!pending) return false;
    this.generation++; pending.cancelled = true; pending.cancel(); this.pending = null; this.starting = false;
    return true;
  }
  async start({ source = 'canvas', isAllowed = () => true } = {}) {
    this._assertAlive();
    if (this.current || this.starting) throw captureError('A recording is already running.', 'RECORDING_BUSY');
    if (!['canvas', 'window'].includes(source)) throw captureError('Choose canvas or window as the recording source.', 'RECORDING_INVALID');
    if (typeof isAllowed !== 'function') throw captureError('Recording access must be checked with a function.', 'CAPTURE_INVALID');
    if (!this.MediaRecorder) throw captureError('Video recording is unavailable in this browser.', 'RECORDING_UNSUPPORTED');
    if (this.records.size >= this.limits.maxRecords || this._retainedBytes() >= this.limits.maxTotalBytes) throw captureError('Download and discard a saved recording before starting another.', 'RECORDING_LIMIT');
    const pending = { generation: ++this.generation, source, board: this.getBoard(), session: this.getSession(), stream: source === 'window' ? this.getWindowStream() : null, isAllowed, cancelled: false };
    pending.cancelledPromise = new Promise(resolve => { pending.cancel = resolve; });
    this.pending = pending; this.starting = true;
    let stream, canvas, item, ownedTracks = [];
    try {
      this._changed(); this._assertStart(pending);
      if (source === 'window') {
        stream = pending.stream;
        if (!liveVideo(stream)) throw captureError('Share a window using the screen-share button before recording it.', 'WINDOW_NOT_SHARED');
      } else {
        const board = this._board(); canvas = this._canvas(board);
        if (typeof canvas.captureStream !== 'function') throw captureError('Canvas recording is unavailable in this browser.', 'RECORDING_UNSUPPORTED');
        await Promise.race([this._prepareInitial(board, () => this._assertStart(pending)), pending.cancelledPromise]);
        this._assertStart(pending); this._drawFrame(canvas, board);
        stream = canvas.captureStream(this.fps); ownedTracks = stream.getTracks();
        if (!liveVideo(stream)) throw captureError('The canvas recording stream could not be started.', 'RECORDING_FAILED');
      }
      this._assertStart(pending);
      const mimeType = MIME_TYPES.find(type => this.MediaRecorder.isTypeSupported?.(type));
      const recorder = new this.MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined);
      this._assertStart(pending);
      const startedAt = this.now();
      item = { id: `recording-${startedAt}-${++this.nextId}`, source, recorder, stream, canvas, ownedTracks, startedAt, board: pending.board, session: pending.session, mimeType: recorder.mimeType || mimeType || 'video/webm', chunks: [], bytes: 0, stopping: false, reason: 'user', timer: null, renderTimer: null, endedTracks: [], error: null };
      item.promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
      // A recorder can fail without a caller explicitly awaiting stop(). Keep automatic stops handled.
      item.promise.catch(() => {});
      recorder.ondataavailable = event => {
        if (!event.data?.size) return;
        const cap = Math.min(this.limits.maxRecordingBytes, this.limits.maxTotalBytes - this._retainedBytes());
        if (item.bytes + event.data.size > cap) {
          item.reason = 'size-limit'; this.onStatus('Recording reached its local size limit.'); this._requestStop(item); return;
        }
        item.chunks.push(event.data); item.bytes += event.data.size; this._changed();
        if (!item.stopping && this.now() - item.startedAt >= this.limits.maxDurationMs) { item.reason = 'duration-limit'; this._requestStop(item); }
      };
      recorder.onstop = () => this._finish(item);
      recorder.onerror = event => { item.error = captureError(event.error?.message || 'The browser could not finish this recording.', 'RECORDING_FAILED'); this._requestStop(item); };
      this._assertStart(pending);
      this.current = item;
      recorder.start(500);
      for (const track of stream.getVideoTracks()) {
        const handler = () => { item.reason = 'source-ended'; this._requestStop(item); };
        track.addEventListener?.('ended', handler); item.endedTracks.push([track, handler]);
      }
      if (canvas) item.renderTimer = this.setInterval(() => {
        try { const board = this.getBoard(); if (!board || board !== item.board || this.getSession() !== item.session) { item.reason = 'source-ended'; this._requestStop(item); return; } this._prepareAssets(board).catch(() => {}); this._drawFrame(canvas, board); }
        catch (error) { item.error = error; this._requestStop(item); }
      }, 1000 / this.fps);
      item.timer = this.setInterval(() => {
        if (this.now() - item.startedAt >= this.limits.maxDurationMs) { item.reason = 'duration-limit'; this.onStatus('Recording reached the five-minute limit.'); this._requestStop(item); }
        else { this.syncSource(); this._changed(); }
      }, 500);
      if (this.pending === pending) { this.pending = null; this.starting = false; }
      this._changed();
      return this._metadata(item);
    } catch (error) {
      // Only compositor-owned tracks are stopped. The user's live screen share remains active.
      if (item) {
        if (this.current === item) this.current = null;
        item.finished = true;
        try { if (item.recorder.state !== 'inactive') item.recorder.stop(); } catch {}
        this._cleanup(item); item.reject(error);
      }
      else ownedTracks.forEach(track => track.stop());
      if (this.pending === pending) { this.pending = null; this.starting = false; }
      this._changed(); throw error;
    }
  }

  _metadata(item, blob = null) {
    const settings = item.stream.getVideoTracks()[0]?.getSettings?.() || {};
    return { id: item.id, source: item.source, mimeType: blob?.type || item.mimeType, bytes: blob?.size ?? item.bytes,
      createdAt: new Date(item.startedAt).toISOString(), durationMs: Math.max(0, this.now() - item.startedAt),
      width: item.canvas?.width || settings.width || null, height: item.canvas?.height || settings.height || null,
      filename: `common-${item.source}-${item.startedAt}.${item.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'}`, stopReason: item.reason };
  }
  _requestStop(item) {
    if (item.stopping) return item.promise;
    item.stopping = true;
    if (item.timer != null) this.clearInterval(item.timer); item.timer = null;
    if (item.renderTimer != null) this.clearInterval(item.renderTimer); item.renderTimer = null;
    try { if (item.recorder.state !== 'inactive') item.recorder.stop(); else this._finish(item); }
    catch (error) { item.error = error; this._finish(item); }
    this._changed(); return item.promise;
  }
  async stop() {
    const cancelled = this._cancelPending();
    if (this.current) return this._requestStop(this.current);
    if (cancelled) this._changed();
    return null;
  }
  _cleanup(item) {
    if (item.timer != null) this.clearInterval(item.timer);
    if (item.renderTimer != null) this.clearInterval(item.renderTimer);
    item.endedTracks.forEach(([track, handler]) => track.removeEventListener?.('ended', handler));
    item.ownedTracks.forEach(track => track.stop());
    item.ownedTracks = []; item.chunks = [];
    item.recorder.ondataavailable = item.recorder.onstop = item.recorder.onerror = null;
  }
  _finish(item) {
    if (item.finished) return;
    item.finished = true;
    const blob = new this.Blob(item.chunks, { type: item.mimeType });
    const metadata = this._metadata(item, blob);
    this._cleanup(item);
    if (this.current === item) this.current = null;
    if (item.error) { this.onStatus(item.error.message); item.reject(item.error); }
    else if (!blob.size) { const error = captureError('The recording contained no video data. Try recording for a little longer.', 'RECORDING_EMPTY'); this.onStatus(error.message); item.reject(error); }
    else {
      if (!this.destroyed) this.records.set(item.id, { blob, metadata });
      item.resolve({ ...metadata });
    }
    this._changed();
  }
  syncSource() {
    const item = this.current;
    if (item && (this.getSession() !== item.session || (item.source === 'window' && (this.getWindowStream() !== item.stream || !liveVideo(item.stream))))) { item.reason = 'source-ended'; this._requestStop(item); }
    return this.status();
  }
  download(id) {
    this._assertAlive(); const item = this.records.get(id);
    if (!item) throw captureError('Recording not found.', 'RECORDING_NOT_FOUND');
    const url = this.URL.createObjectURL(item.blob); this.urls.add(url);
    this._downloadUrl(url, item.metadata.filename);
    // Allow the browser time to start the local download before releasing its URL.
    const timer = this.setTimeout(() => { this.downloadTimers.delete(timer); this._revoke(url); }, 1000);
    this.downloadTimers.add(timer);
    return { ...item.metadata };
  }
  _downloadUrl(url, filename) {
    const anchor = this.document.createElement('a'); anchor.href = url; anchor.download = filename;
    this.document.body?.append(anchor); anchor.click(); anchor.remove();
  }
  _revoke(url) { if (this.urls.delete(url)) this.URL.revokeObjectURL(url); }
  discard(id) { const removed = this.records.delete(id); if (removed) this._changed(); return removed; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this._cancelPending();
    if (this.current) this._requestStop(this.current);
    this.records.clear();
    for (const asset of this.assets.values()) asset.cancel?.();
    this.assets.clear();
    for (const timer of this.downloadTimers) this.clearTimeout(timer);
    this.downloadTimers.clear();
    for (const url of this.urls) this._revoke(url);
    this._changed();
  }

  _svgSource(svg) {
    if (!svg || !this.XMLSerializer) return null;
    const copy = svg.cloneNode(true);
    copy.querySelectorAll('script, foreignObject, iframe, object, embed, image, animate, animateTransform, set').forEach(node => node.remove());
    for (const node of [copy, ...copy.querySelectorAll('*')]) {
      // Attribute removal mutates the live NamedNodeMap, so retain a snapshot.
      for (const attribute of Array.from(node.attributes)) {
        const name = attribute.name.toLowerCase(), value = attribute.value;
        if (name.startsWith('on') || ((name === 'href' || name.endsWith(':href')) && !value.startsWith('#')) || hasExternalUrl(value)) node.removeAttribute(attribute.name);
      }
      if (node.tagName.toLowerCase() === 'style' && (/@import/i.test(node.textContent) || hasExternalUrl(node.textContent))) node.remove();
    }
    const viewBox = copy.getAttribute('viewBox')?.split(/[ ,]+/).map(Number);
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', String(viewBox?.[2] || 800)); copy.setAttribute('height', String(viewBox?.[3] || 500));
    return new this.XMLSerializer().serializeToString(copy);
  }
  _assetSpec(entity, board) {
    if (entity.type === 'image' && SAFE_RASTER.test(entity.url || '')) return { key: entity.url, url: entity.url };
    if (entity.type === 'diagram' && entity.language !== 'plantuml') {
      const svg = board.nodes?.get(entity.id)?.querySelector('.board-diagram-body > svg');
      const source = this._svgSource(svg);
      if (source) return { key: source, svg: source };
    }
    return null;
  }
  _prepareAssets(board) {
    const entities = board.listVisibleEntities?.() ?? board.listEntities(), retained = new Set(), promises = [];
    for (const entity of entities) {
      const spec = this._assetSpec(entity, board); if (!spec) continue;
      retained.add(entity.id);
      let asset = this.assets.get(entity.id);
      if (!asset || asset.key !== spec.key) {
        asset?.cancel?.();
        asset = { key: spec.key, image: null };
        asset.promise = new Promise(resolve => {
          if (!this.Image) { resolve(); return; }
          const image = new this.Image(); let url = null, timeout = null, settled = false;
          const done = loaded => {
            if (settled) return; settled = true;
            if (timeout != null) this.clearTimeout(timeout);
            image.onload = image.onerror = null;
            if (url) this._revoke(url);
            if (loaded && !this.destroyed) asset.image = image;
            resolve();
          };
          asset.cancel = () => { image.src = ''; done(false); };
          image.onload = () => done(true); image.onerror = () => done(false);
          timeout = this.setTimeout(() => done(false), 10000);
          if (spec.svg) { url = this.URL.createObjectURL(new this.Blob([spec.svg], { type: 'image/svg+xml' })); this.urls.add(url); }
          image.src = url || spec.url;
        });
        this.assets.set(entity.id, asset);
      }
      promises.push(asset.promise);
    }
    for (const [id, asset] of this.assets) if (!retained.has(id)) { asset.cancel?.(); this.assets.delete(id); }
    return Promise.all(promises);
  }

  _drawFrame(canvas, board) {
    const ctx = canvas.getContext('2d'); const view = board.getView?.() || { x: 0, y: 0, zoom: 1 };
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#f5f6f2'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const width = Math.max(1, finite(board.el.clientWidth, canvas.width)), height = Math.max(1, finite(board.el.clientHeight, canvas.height));
    const scale = Math.min(canvas.width / width, canvas.height / height);
    ctx.save(); ctx.translate((canvas.width - width * scale) / 2, (canvas.height - height * scale) / 2); ctx.scale(scale, scale);
    ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip(); ctx.translate(finite(view.x), finite(view.y)); ctx.scale(Math.max(.01, finite(view.zoom, 1)), Math.max(.01, finite(view.zoom, 1)));
    for (const entity of board.listVisibleEntities?.() ?? board.listEntities()) {
      ctx.save();
      try { ctx.translate(finite(entity.x), finite(entity.y)); this._drawEntity(ctx, entity, board); }
      finally { ctx.restore(); }
    }
    ctx.restore();
  }
  _fitImage(ctx, image, x, y, width, height) {
    const imageWidth = image.videoWidth || image.naturalWidth || image.width, imageHeight = image.videoHeight || image.naturalHeight || image.height;
    if (!imageWidth || !imageHeight || width <= 0 || height <= 0) return false;
    const scale = Math.min(width / imageWidth, height / imageHeight);
    ctx.drawImage(image, x + (width - imageWidth * scale) / 2, y + (height - imageHeight * scale) / 2, imageWidth * scale, imageHeight * scale); return true;
  }
  _text(ctx, text, x, y, width, height, fontSize, color, { center = false, weight = 500 } = {}) {
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, Math.max(0, width), Math.max(0, height)); ctx.clip();
    ctx.font = `${weight} ${fontSize}px system-ui, sans-serif`; ctx.fillStyle = color; ctx.textBaseline = 'top';
    const lines = [];
    for (const paragraph of String(text || '').split('\n')) {
      let line = '';
      for (const char of paragraph) {
        if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = ''; }
        line += char;
      }
      lines.push(line);
    }
    const lineHeight = fontSize * 1.45; let top = center ? y + Math.max(0, (height - lines.length * lineHeight) / 2) : y;
    for (const line of lines) { if (top >= y + height) break; ctx.fillText(line, center ? x + Math.max(0, (width - ctx.measureText(line).width) / 2) : x, top); top += lineHeight; }
    ctx.restore();
  }
  _drawEntity(ctx, entity, board) {
    const width = Math.max(1, finite(entity.width, 100)), height = Math.max(1, finite(entity.height, 100));
    const color = entity.color || '#567263', fontSize = Math.max(10, Math.min(100, finite(entity.fontSize, entity.type === 'text' ? 24 : 18)));
    ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (entity.type === 'text' || entity.type === 'sticky') {
      if (entity.type === 'sticky') { ctx.fillStyle = entity.fill || '#fff0b5'; ctx.fillRect(0, 0, width, height); }
      const padding = entity.type === 'sticky' ? 22 : 4;
      this._text(ctx, entity.text, padding, entity.type === 'sticky' ? 23 : 5, width - padding * 2, height - padding * 2, fontSize, entity.color || (entity.type === 'sticky' ? '#5b5237' : '#28322f'));
    } else if (entity.type === 'rectangle' || entity.type === 'ellipse') {
      ctx.beginPath();
      if (entity.type === 'ellipse') ctx.ellipse(width / 2, height / 2, Math.max(1, width / 2 - 2), Math.max(1, height / 2 - 2), 0, 0, Math.PI * 2);
      else ctx.rect(2, 2, Math.max(1, width - 4), Math.max(1, height - 4));
      if (entity.fill && entity.fill !== 'transparent') { ctx.fillStyle = entity.fill; ctx.fill(); } ctx.stroke();
      this._text(ctx, entity.text, 10, 10, width - 20, height - 20, finite(entity.fontSize, 14), '#435b43', { center: true });
    } else if (entity.type === 'draw' || entity.type === 'arrow') {
      const points = pointsOf(entity);
      if (entity.type === 'draw' && points.length) {
        const minX = Math.min(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y)), maxX = Math.max(...points.map(p => p.x)), maxY = Math.max(...points.map(p => p.y));
        const scaleX = width / Math.max(6, maxX - minX + 6), scaleY = height / Math.max(6, maxY - minY + 6);
        ctx.beginPath(); points.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo']((p.x - minX + 3) * scaleX, (p.y - minY + 3) * scaleY)); ctx.stroke();
      } else if (entity.type === 'arrow') {
        const start = points[0] || { x: 6, y: height / 2 }, end = points.at(-1) || { x: width - 6, y: height / 2 };
        const maxX = Math.max(1, ...points.map(p => p.x)), maxY = Math.max(1, ...points.map(p => p.y));
        const sx = points.length ? width / maxX : 1, sy = points.length ? height / maxY : 1;
        const a = { x: start.x * sx, y: start.y * sy }, b = { x: end.x * sx, y: end.y * sy }, angle = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(b.x - 12 * Math.cos(angle - .45), b.y - 12 * Math.sin(angle - .45)); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x - 12 * Math.cos(angle + .45), b.y - 12 * Math.sin(angle + .45)); ctx.stroke();
      }
    } else if (entity.type === 'image') {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
      const image = this.assets.get(entity.id)?.image;
      if (image) this._fitImage(ctx, image, 0, 0, width, height);
      else this._text(ctx, 'Image unavailable', 10, 10, width - 20, height - 20, 14, '#798775', { center: true });
    } else if (entity.type === 'screen' || entity.type === 'diagram') {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); ctx.strokeStyle = '#dde2d8'; ctx.strokeRect(0, 0, width, height);
      this._text(ctx, entity.title || (entity.type === 'screen' ? 'Shared window' : 'Diagram'), 14, 15, width - 28, 25, 12, '#46523f');
      if (entity.type === 'screen') {
        const video = board.nodes?.get(entity.id)?.querySelector('video');
        ctx.fillStyle = '#20261e'; ctx.fillRect(0, 44, width, Math.max(0, height - 74));
        if (!video || video.readyState < 2 || !this._fitImage(ctx, video, 0, 44, width, height - 74)) this._text(ctx, 'Waiting for shared window', 12, 54, width - 24, height - 94, 14, '#cad2c6', { center: true });
        this._text(ctx, 'Live screen', 12, height - 22, width - 24, 20, 9, '#89917f');
      } else {
        const image = this.assets.get(entity.id)?.image;
        if (image) this._fitImage(ctx, image, 20, 61, width - 40, height - 78);
        else this._text(ctx, entity.language === 'plantuml' ? 'PlantUML diagram (external image omitted)' : 'Diagram is rendering…', 20, 61, width - 40, height - 78, 13, '#798775', { center: true });
      }
    }
  }
}
