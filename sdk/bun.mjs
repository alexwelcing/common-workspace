import { createLocalSession } from '../lib/local-session.mjs';
import { startRequestObservation } from '../lib/observability.mjs';
import { normalizeBasePath, matchBasePath } from './path.mjs';
import { createStaticHandler, commonError } from './static.mjs';

const callbacks = ['open', 'message', 'close', 'drain', 'ping', 'pong'];
const MAX_MESSAGE_BYTES = 3 * 1024 * 1024;

/** Attach Common to an existing Bun.serve instance without opening a listener. */
export async function createCommon(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Common options must be an object.');
  if (options.env !== undefined && (options.env === null || (!['function', 'object'].includes(typeof options.env)) || Array.isArray(options.env))) {
    throw new TypeError('Common env must be an object or a lookup function.');
  }
  if (options.dataFile !== undefined && options.dataFile !== null && (typeof options.dataFile !== 'string' || !options.dataFile.trim())) {
    throw new TypeError('Common dataFile must be a nonempty path or null.');
  }
  if (options.assetsDir !== undefined && !(typeof options.assetsDir === 'string' && options.assetsDir.trim()) && !(options.assetsDir instanceof URL && options.assetsDir.protocol === 'file:')) {
    throw new TypeError('Common assetsDir must be a directory path or file URL.');
  }
  const basePath = normalizeBasePath(options.basePath);
  const suppliedEnv = options.env ?? {};
  const env = key => {
    const value = typeof suppliedEnv === 'function' ? suppliedEnv(key) : suppliedEnv?.[key];
    return key === 'COMMON_NETWORK_PROFILE' && value === undefined ? 'private' : value;
  };
  if (options.authorize !== undefined && typeof options.authorize !== 'function') throw new TypeError('Common authorize must be a function.');
  const engine = await createLocalSession({ dataFile: options.dataFile ?? null, env });
  const serveStatic = createStaticHandler({ basePath, ...(options.assetsDir !== undefined ? { assetsDir: options.assetsDir } : {}) });
  const admissionKey = Symbol('common-admission');
  const owner = {};
  const socketShims = new WeakMap();
  const ownedSockets = new Set();
  let closed = false, closing;

  function pathname(request) {
    try { return matchBasePath(new URL(request.url).pathname, basePath); } catch { return null; }
  }
  function owns(socket) { return socket.data?.[admissionKey]?.owner === owner; }
  function shim(socket) {
    let value = socketShims.get(socket);
    if (!value) {
      value = {
        get readyState() { return socket.readyState; },
        get bufferedAmount() { return socket.getBufferedAmount?.() ?? socket.bufferedAmount ?? 0; },
        send: data => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        terminate: () => socket.terminate(),
        ping: data => socket.ping(data),
      };
      socketShims.set(socket, value);
    }
    return value;
  }
  const websocket = {
    maxPayloadLength: MAX_MESSAGE_BYTES,
    sendPings: false,
    open(socket) {
      if (!owns(socket)) return;
      if (closed) { socket.close(1012, 'Common is closed'); return; }
      ownedSockets.add(socket);
      try { engine.open(shim(socket), socket.data[admissionKey].admission); }
      catch { ownedSockets.delete(socket); socket.close(4001, 'Common session admission expired'); }
    },
    message(socket, message) {
      if (!owns(socket)) return;
      // A host may set a larger global Bun WebSocket payload limit. Keep
      // Common's independent limit even when sharing that server configuration.
      const size = typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength;
      if (size > MAX_MESSAGE_BYTES) { socket.close(1009, 'Message is too large'); return; }
      engine.message(shim(socket), message, typeof message !== 'string');
    },
    close(socket) {
      if (!owns(socket)) return;
      ownedSockets.delete(socket);
      engine.close(shim(socket));
    },
    pong(socket) { if (owns(socket)) engine.pong(shim(socket)); },
  };

  async function authorize(request, kind) {
    if (!options.authorize) return null;
    try {
      const result = await options.authorize(request, { kind });
      if (result === true) return null;
      if (result instanceof Response) return result;
      return commonError(403, 'FORBIDDEN', 'Access to Common is not authorized.');
    } catch { return commonError(503, 'AUTHORIZATION_UNAVAILABLE', 'Common authorization is unavailable.'); }
  }

  async function fetchCommon(request, server) {
    const internalPath = pathname(request);
    if (internalPath === null) return null;
    const internalUrl = new URL(request.url);
    internalUrl.pathname = internalPath;
    const observation = startRequestObservation({ url: internalUrl.href, method: request.method, headers: request.headers }, { env });
    let response;
    try {
      if (closed) response = commonError(503, 'COMMON_CLOSED', 'Common is closed.');
      else {
        const isWebSocket = internalPath === '/ws';
        response = await authorize(request, isWebSocket ? 'websocket' : 'http');
        if (!response && closed) response = commonError(503, 'COMMON_CLOSED', 'Common is closed.');
        if (!response) {
          const externalUrl = new URL(request.url);
          if (basePath !== '/' && externalUrl.pathname === basePath.slice(0, -1)) {
            externalUrl.pathname = basePath;
            response = new Response(null, { status: 308, headers: { Location: externalUrl.pathname + externalUrl.search, 'Cache-Control': 'no-store' } });
          } else {
            const internalRequest = new Request(internalUrl, request);
            if (isWebSocket) {
              if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
                response = commonError(426, 'WEBSOCKET_REQUIRED', 'A WebSocket connection is required.');
              } else if (!server || typeof server.upgrade !== 'function') {
                response = commonError(503, 'UPGRADE_UNAVAILABLE', 'Pass the Bun server to Common fetch to enable WebSocket connections.');
              } else {
                const admission = engine.authorizeWebSocket(internalRequest);
                admission.diagnostics = {
                  requestId: observation.headers['X-Common-Request-Id'], buildId: observation.headers['X-Common-Build'],
                  protocolVersion: 1, traceparent: observation.headers.traceparent,
                };
                if (closed) response = commonError(503, 'COMMON_CLOSED', 'Common is closed.');
                else if (server.upgrade(request, { data: { [admissionKey]: { owner, admission } }, headers: observation.headers })) {
                  await observation.finish(101);
                  return undefined;
                } else response = commonError(400, 'UPGRADE_FAILED', 'The WebSocket connection could not be opened.');
              }
            } else {
              let ip;
              try { ip = server?.requestIP?.(request)?.address; } catch { /* Unknown IP shares one bounded rate bucket. */ }
              response = await engine.fetch(internalRequest, { ip }) ?? await serveStatic(request, internalPath);
            }
          }
        }
      }
    } catch (error) {
      const expected = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;
      response = commonError(expected ? error.status : 500, expected ? error.code : 'INTERNAL_ERROR', expected ? error.message : 'Common could not handle this request.');
    }
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(observation.headers)) headers.set(name, value);
    const observed = new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, statusText: response.statusText, headers });
    await observation.finish(response.status);
    return observed;
  }

  function wrapFetch(existingFetch) {
    if (typeof existingFetch !== 'function') throw new TypeError('Common wrapFetch requires the host fetch function.');
    return async function commonAndHost(request, server) {
      const response = await fetchCommon(request, server);
      return response === null ? existingFetch.call(this, request, server) : response;
    };
  }

  function wrapWebSocket(existingHandlers = {}) {
    if (!existingHandlers || typeof existingHandlers !== 'object' || Array.isArray(existingHandlers)) throw new TypeError('Common wrapWebSocket requires a handler object.');
    const wrapped = { ...websocket, ...existingHandlers };
    for (const event of callbacks) wrapped[event] = function dispatch(socket, ...args) {
      if (owns(socket)) return websocket[event]?.call(websocket, socket, ...args);
      return existingHandlers[event]?.call(this, socket, ...args);
    };
    return wrapped;
  }

  return {
    basePath, fetch: fetchCommon, matches: request => pathname(request) !== null,
    websocket, wrapFetch, wrapWebSocket,
    close() {
      if (closing) return closing;
      closed = true;
      for (const socket of ownedSockets) socket.terminate();
      ownedSockets.clear();
      closing = engine.closeEngine();
      return closing;
    },
  };
}
