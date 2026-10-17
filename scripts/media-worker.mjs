import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalMediaEngine, MEDIA_LIMITS, MediaError } from '../media/engine.mjs';

function allowedOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Set an exact app origin, such as http://localhost:5173.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use an HTTPS app origin, or HTTP on localhost.');
  return url.origin;
}
function errorJson(response, error) {
  const status = error instanceof MediaError ? error.status : 500;
  const message = error instanceof MediaError ? error.message : 'The local export could not be completed.';
  if (!response.headersSent && !response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: message, code: error.code || 'EXPORT_FAILED' })); }
}
function bearerMatches(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)), expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function bodyBytes(request, limit, signal) {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new MediaError('The local export upload exceeds its size limit.', 413, 'MEDIA_LIMIT');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw new MediaError('Media export was canceled.', 499, 'CANCELED');
    size += chunk.length;
    if (size > limit) throw new MediaError('The local export upload exceeds its size limit.', 413, 'MEDIA_LIMIT');
    chunks.push(chunk);
  }
  if (!size) throw new MediaError('The local export upload was empty.');
  return Buffer.concat(chunks);
}

/** Loopback-only authenticated local processor. This is not an app backend. */
export async function startMediaWorker({ port = 8788, origins, token = randomBytes(32).toString('base64url'), engine = new LocalMediaEngine(), checkEngine = true, onEvent = () => {} } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Choose a valid local port.');
  if (!Array.isArray(origins) || !origins.length || origins.length > 8) throw new Error('Pass at least one explicit allowed app origin.');
  const allowed = new Set(origins.map(allowedOrigin));
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('The local export token must contain at least 32 random URL-safe characters.');
  if (checkEngine) await engine.check();
  let busy = false, current = null, closing = false, currentJob = null, lastJob = null, currentCompletion = null, closePromise = null; const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const workerPort = server.address()?.port;
    const validHosts = new Set([`127.0.0.1:${workerPort}`, `localhost:${workerPort}`]);
    const origin = request.headers.origin;
    if (!validHosts.has(request.headers.host) || typeof origin !== 'string' || !allowed.has(origin)) return errorJson(response, new MediaError('This app origin or local host is not allowed.', 403, 'ORIGIN_DENIED'));
    response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Media-Width, X-Media-Height, X-Media-Duration-Ms, X-Media-Engine');
    let url; try { url = new URL(request.url, 'http://127.0.0.1'); } catch { return errorJson(response, new MediaError('Invalid local export URL.')); }
    if (url.search || !['/health', '/v1/capabilities', '/v1/recording', '/v1/walkthrough'].includes(url.pathname)) return errorJson(response, new MediaError('Local export route not found.', 404, 'NOT_FOUND'));
    if (request.method === 'OPTIONS') {
      const method = request.headers['access-control-request-method'];
      const headers = String(request.headers['access-control-request-headers'] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      if (!['GET', 'POST'].includes(method) || headers.some(value => !['authorization', 'content-type'].includes(value))) return errorJson(response, new MediaError('This preflight request is not allowed.', 403, 'ORIGIN_DENIED'));
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); response.setHeader('Access-Control-Max-Age', '600');
      if (request.headers['access-control-request-private-network'] === 'true') response.setHeader('Access-Control-Allow-Private-Network', 'true');
      response.writeHead(204); return response.end();
    }
    if (!bearerMatches(request.headers.authorization, token)) return errorJson(response, new MediaError('Enter the local export token shown by your worker.', 401, 'UNAUTHORIZED'));
    if (request.method === 'GET' && ['/health', '/v1/capabilities'].includes(url.pathname)) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ version: 1, engine: `ffmpeg-${engine.engine || 'native'}`, formats: ['mp4'], recordingTypes: ['video/webm', 'video/mp4'], limits: MEDIA_LIMITS, busy, job: currentJob || lastJob }));
    }
    if (request.method !== 'POST' || ['/health', '/v1/capabilities'].includes(url.pathname)) return errorJson(response, new MediaError('Use the documented local export method.', 405, 'METHOD_NOT_ALLOWED'));
    if (closing || busy) return errorJson(response, new MediaError('The local media worker is busy. Wait for its current export to finish.', 409, 'WORKER_BUSY'));
    const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if ((url.pathname === '/v1/recording' && !['video/webm', 'video/mp4'].includes(contentType)) || (url.pathname === '/v1/walkthrough' && contentType !== 'application/json')) return errorJson(response, new MediaError('Use a supported recording or walkthrough content type.', 415, 'UNSUPPORTED_MEDIA'));
    const abort = new AbortController(); current = abort; busy = true;
    let finishJob; const completion = new Promise(resolveJob => { finishJob = resolveJob; }); currentCompletion = completion;
    currentJob = { state: 'uploading', kind: url.pathname === '/v1/recording' ? 'recording' : 'walkthrough', startedAt: new Date().toISOString() };
    const emit = event => { try { onEvent(event); } catch {} }; emit({ ...currentJob });
    const onAbort = () => abort.abort();
    request.once('aborted', onAbort);
    const onClose = () => { if (!response.writableFinished) abort.abort(); }; response.once('close', onClose);
    const deadline = setTimeout(() => { const error = new MediaError('Local export reached its processing deadline.', 408, 'MEDIA_TIMEOUT'); abort.abort(error); if (!response.headersSent) errorJson(response, error); else response.destroy(); }, MEDIA_LIMITS.jobTimeoutMs + 45000);
    try {
      const bytes = await bodyBytes(request, url.pathname === '/v1/recording' ? MEDIA_LIMITS.recordingBytes : MEDIA_LIMITS.walkthroughBytes, abort.signal);
      currentJob = { ...currentJob, state: 'processing', uploadedBytes: bytes.length }; emit({ ...currentJob });
      let result;
      if (url.pathname === '/v1/recording') result = await engine.exportRecording(bytes, { mimeType: contentType, signal: abort.signal });
      else {
        let spec; try { spec = JSON.parse(bytes.toString('utf8')); } catch { throw new MediaError('Walkthrough upload must contain valid JSON.'); }
        result = await engine.exportWalkthrough(spec, { signal: abort.signal });
      }
      if (abort.signal.aborted || response.destroyed) { currentJob = { ...currentJob, state: 'canceled', completedAt: new Date().toISOString() }; emit({ ...currentJob }); return; }
      const filename = `common-${url.pathname === '/v1/recording' ? 'recording' : 'walkthrough'}-${Date.now()}.mp4`;
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': result.bytes.length, 'Content-Disposition': `attachment; filename="${filename}"`, 'X-Media-Width': String(result.width), 'X-Media-Height': String(result.height), 'X-Media-Duration-Ms': String(result.durationMs || 0), 'X-Media-Engine': result.engine });
      await new Promise(resolveSent => {
        const sent = () => { response.off('finish', sent); response.off('close', sent); resolveSent(); };
        response.once('finish', sent); response.once('close', sent); response.end(result.bytes);
      });
      if (!response.writableFinished) { currentJob = { ...currentJob, state: 'canceled', completedAt: new Date().toISOString() }; emit({ ...currentJob }); return; }
      currentJob = { ...currentJob, state: 'finished', completedAt: new Date().toISOString(), outputBytes: result.bytes.length, width: result.width, height: result.height, durationMs: result.durationMs }; emit({ ...currentJob });
    } catch (error) {
      currentJob = { ...currentJob, state: error.code === 'MEDIA_TIMEOUT' ? 'failed' : abort.signal.aborted ? 'canceled' : 'failed', completedAt: new Date().toISOString(), error: { code: error.code || 'EXPORT_FAILED', message: error instanceof MediaError ? error.message : 'The local export could not be completed.' } };
      emit({ ...currentJob, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }); errorJson(response, error);
    }
    finally { clearTimeout(deadline); request.off('aborted', onAbort); response.off('close', onClose); if (current === abort) current = null; lastJob = currentJob; currentJob = null; busy = false; if (currentCompletion === completion) currentCompletion = null; finishJob(); }
  });
  server.headersTimeout = 15000; server.requestTimeout = 30000; server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 50;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('checkContinue', (request, response) => { response.writeHead(417); response.end(); });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  return { server, token, url: `http://127.0.0.1:${server.address().port}`, origins: [...allowed], close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true; const completion = currentCompletion; current?.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolveClose => server.close(resolveClose));
      if (completion) { let timer; await Promise.race([completion, new Promise(resolveDone => { timer = setTimeout(resolveDone, 5000); })]); clearTimeout(timer); }
    })();
    return closePromise;
  } };
}

export function parseMediaArgs(args) {
  const options = { origins: [], port: 8788, engine: 'native' };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index], value = args[++index];
    if (!value) throw new Error('Usage: bun scripts/media-worker.mjs --origin APP_ORIGIN [--port 8788] [--engine native|docker]');
    if (key === '--origin') options.origins.push(value);
    else if (key === '--port' && /^\d+$/.test(value)) options.port = Number(value);
    else if (key === '--engine' && ['native', 'docker'].includes(value)) options.engine = value;
    else throw new Error('Unknown local export option. Use --origin, --port, or --engine.');
  }
  if (!options.origins.length || options.port < 1024 || options.port > 65535) throw new Error('Set an explicit app origin and a port between 1024 and 65535.');
  return options;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseMediaArgs(process.argv.slice(2));
    const worker = await startMediaWorker({ ...options, engine: new LocalMediaEngine({ engine: options.engine }), onEvent: event => { console.log(`[media] ${event.kind}: ${event.state}${event.outputBytes ? ` · ${event.width}×${event.height} · ${event.durationMs}ms · ${event.outputBytes} bytes` : ''}${event.error ? ` · ${event.error.code}: ${event.error.message}` : ''}`); if (event.diagnostic) console.error(event.diagnostic); } });
    console.log(`Local media export: ${worker.url}\nAllowed app origins: ${worker.origins.join(', ')}\nSession token (paste into your app; do not share): ${worker.token}\nStop this process to revoke the token. Media is processed in temporary local files and deleted after each export.`);
    const stop = () => { worker.close().finally(() => process.exit()); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
