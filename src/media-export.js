const MiB = 1024 * 1024;
const MAX_RECORDING_BYTES = 100 * MiB;
const MAX_WALKTHROUGH_BYTES = 64 * MiB;
const MAX_RESULT_BYTES = 100 * MiB;

export function localMediaEndpoint(value = 'http://127.0.0.1:8788') {
  let url; try { url = new URL(value); } catch { throw new Error('Enter a valid local media worker address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('The media worker must use a loopback address with no path, password, or query.');
  return url.origin;
}
function optionsToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Paste the session token printed by your local media worker.');
  return token;
}
function fileName(header) {
  return /filename="([a-zA-Z0-9._-]+\.mp4)"/.exec(header || '')?.[1] || 'common-export.mp4';
}

/** Opt-in loopback client. A token and all media stay in memory, never storage. */
export class LocalMediaExport {
  constructor({ endpoint = 'http://127.0.0.1:8788', token, fetch = globalThis.fetch?.bind(globalThis), timeoutMs = 240000 } = {}) {
    this.endpoint = localMediaEndpoint(endpoint); this.token = optionsToken(token); this.fetch = fetch;
    if (typeof fetch !== 'function') throw new Error('Local media export needs browser fetch support.');
    // Native browser fetch needs Window as its receiver, including an injected
    // native function. Custom fetch adapters receive the same calling context.
    this.timeoutMs = Math.max(100, Math.min(240000, timeoutMs)); this.pending = new Set(); this.destroyed = false;
  }
  async request(path, { method = 'GET', body, contentType, signal } = {}) {
    if (this.destroyed) throw new Error('Local media export has been disconnected.');
    if (signal?.aborted) throw signal.reason || new DOMException('Export canceled.', 'AbortError');
    const abort = new AbortController(); this.pending.add(abort);
    const canceled = () => abort.abort(signal.reason); signal?.addEventListener('abort', canceled, { once: true });
    const timer = setTimeout(() => abort.abort(new Error('Local media export timed out.')), method === 'GET' ? 10000 : this.timeoutMs);
    try {
      const response = await this.fetch.call(globalThis, `${this.endpoint}${path}`, { method, body, headers: { Authorization: `Bearer ${this.token}`, ...(contentType ? { 'Content-Type': contentType } : {}) }, mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: abort.signal });
      if (!response.ok) {
        let data; try { data = await response.json(); } catch {}
        const error = new Error(data?.error || `The local media worker returned ${response.status}.`); error.code = data?.code || 'LOCAL_EXPORT_FAILED'; error.status = response.status; throw error;
      }
      if (method === 'GET') {
        const data = await response.json();
        if (data.version !== 1 || !Array.isArray(data.formats) || !data.formats.includes('mp4')) throw new Error('This local media worker uses an unsupported protocol.');
        return data;
      }
      if (response.headers.get('content-type')?.split(';')[0] !== 'video/mp4') throw new Error('The local worker did not return an MP4 video.');
      const declared = Number(response.headers.get('content-length'));
      if (declared > MAX_RESULT_BYTES) throw new Error('The local export exceeds its download size limit.');
      // Bound streaming downloads too; a missing or dishonest Content-Length
      // must not allocate an unlimited browser buffer.
      const chunks = []; let bytes = 0;
      if (!response.body?.getReader) throw new Error('The browser could not read this local export.');
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESULT_BYTES) { await reader.cancel(); throw new Error('The local export exceeds its download size limit.'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      if (!bytes) throw new Error('The local export contained no video.');
      return { blob: new Blob(chunks, { type: 'video/mp4' }), filename: fileName(response.headers.get('content-disposition')), mimeType: 'video/mp4', width: Number(response.headers.get('x-media-width')) || null, height: Number(response.headers.get('x-media-height')) || null, durationMs: Number(response.headers.get('x-media-duration-ms')) || null, engine: response.headers.get('x-media-engine') || 'local' };
    } catch (error) {
      if (abort.signal.aborted) throw abort.signal.reason || new DOMException('Export canceled.', 'AbortError');
      if (error instanceof TypeError) throw new Error('The local worker is unreachable. Start it, allow this app origin, and grant local-network access if your browser asks.');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', canceled); this.pending.delete(abort); }
  }
  capabilities(options = {}) { return this.request('/v1/capabilities', options); }
  exportRecording(blob, options = {}) {
    if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_RECORDING_BYTES) throw new Error('Choose a saved browser recording under 100 MB.');
    const mimeType = blob.type.split(';', 1)[0];
    if (!['video/webm', 'video/mp4'].includes(mimeType)) throw new Error('Local MP4 export accepts WebM and MP4 recordings.');
    return this.request('/v1/recording', { ...options, method: 'POST', body: blob, contentType: mimeType });
  }
  exportWalkthrough(input, options = {}) {
    if (!input || !Array.isArray(input.frames) || !input.frames.length || input.frames.length > 50) throw new Error('Export between 1 and 50 walkthrough frames.');
    const body = JSON.stringify(input);
    if (new Blob([body]).size > MAX_WALKTHROUGH_BYTES) throw new Error('This walkthrough exceeds the 64 MB upload limit.');
    return this.request('/v1/walkthrough', { ...options, method: 'POST', body, contentType: 'application/json' });
  }
  download(result, { document = globalThis.document, URL = globalThis.URL } = {}) {
    if (!(result?.blob instanceof Blob) || !document?.body) throw new Error('Choose a completed export to download.');
    const url = URL.createObjectURL(result.blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = result.filename || 'common-export.mp4'; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  destroy() { if (this.destroyed) return; this.destroyed = true; for (const abort of this.pending) abort.abort(new DOMException('Local export disconnected.', 'AbortError')); this.pending.clear(); this.token = ''; }
}
