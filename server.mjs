import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';
import { normalizeRoomCreation, normalizeJoin, normalizeEnvelope, normalizeSignal, normalizeChat, normalizeCursor, protocolCapabilities, SESSION_POLICY } from './lib/session-protocol.mjs';
import { publicRuntimeConfig, stunServersFromEnv, iceTransportPolicyFromEnv } from './lib/runtime-config.mjs';
import { startRequestObservation } from './lib/observability.mjs';

const scrypt = promisify(scryptCallback);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SESSION_TTL = SESSION_POLICY.sessionTtlMs;
const ROOM_TTL = SESSION_POLICY.standaloneRoomTtlMs;
const MAX_ENTITIES = 1000;
const MAX_ROOM_BYTES = 24 * 1024 * 1024;
const COLORS = ['#7867ef', '#e3a444', '#4aa3b9', '#df7b9d', '#75b790', '#d27b58', '#8b9ed5', '#ba91ce', '#9baf5f', '#68b3aa'];
const ENTITY_TYPES = new Set(['text', 'sticky', 'rectangle', 'ellipse', 'arrow', 'draw', 'image', 'diagram', 'screen']);
const hashToken = value => createHash('sha256').update(value).digest('hex');
const randomId = (length = 12) => randomBytes(length).toString('base64url');
const cleanString = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max ? value.trim() : null;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = (value, limit = 100000) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
const publicRoom = room => ({ id: room.id, name: room.name, createdAt: room.createdAt, ...(room.collaboration === 'peer' ? { collaboration: 'peer' } : {}) });
const publicParticipant = participant => ({ id: participant.id, name: participant.name, color: participant.color, isAdmin: participant.isAdmin });
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });
const safeErrorCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';

function entityFrom(input, sender) {
  if (!isObject(input) || !cleanString(input.id, 1, 100) || !ENTITY_TYPES.has(input.type)) throw httpError(400, 'INVALID_ENTITY', 'Choose a supported board item.');
  if (!finite(input.x) || !finite(input.y) || !finite(input.width, 10000) || !finite(input.height, 10000) || input.width <= 0 || input.height <= 0) throw httpError(400, 'INVALID_ENTITY', 'Board coordinates or dimensions are invalid.');
  const entity = { id: input.id.trim(), type: input.type, x: input.x, y: input.y, width: input.width, height: input.height };
  for (const [key, max] of Object.entries({ text: 20000, color: 100, fill: 100, source: 20000, title: 200, streamId: 200, screenId: 200 })) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || input[key].length > max) throw httpError(400, 'INVALID_ENTITY', `Invalid ${key}.`);
      entity[key] = input[key];
    }
  }
  if (input.fontSize !== undefined) {
    if (!finite(input.fontSize, 200) || input.fontSize < 8) throw httpError(400, 'INVALID_ENTITY', 'Invalid font size.');
    entity.fontSize = input.fontSize;
  }
  if (input.z !== undefined) {
    if (!finite(input.z, 1e8)) throw httpError(400, 'INVALID_ENTITY', 'Invalid layer.');
    entity.z = input.z;
  }
  if (input.orderKey !== undefined) {
    if (typeof input.orderKey !== 'string' || input.orderKey.length > 200 || !/^[A-Za-z0-9]+$/.test(input.orderKey)) throw httpError(400, 'INVALID_ENTITY', 'Invalid layer order.');
    entity.orderKey = input.orderKey;
  }
  if (input.locked !== undefined) {
    if (typeof input.locked !== 'boolean') throw httpError(400, 'INVALID_ENTITY', 'Invalid position lock.');
    entity.locked = input.locked;
  }
  if (input.points !== undefined) {
    if (!Array.isArray(input.points) || input.points.length > 10000 || input.points.some(p => !isObject(p) || !finite(p.x) || !finite(p.y))) throw httpError(400, 'INVALID_ENTITY', 'Invalid drawing points.');
    entity.points = input.points.map(({ x, y }) => ({ x, y }));
  }
  if (input.language !== undefined) {
    if (!['mermaid', 'plantuml'].includes(input.language)) throw httpError(400, 'INVALID_ENTITY', 'Choose Mermaid or PlantUML.');
    entity.language = input.language;
  }
  if (input.externalConsent !== undefined) {
    if (typeof input.externalConsent !== 'boolean') throw httpError(400, 'INVALID_ENTITY', 'Invalid external diagram consent.');
    entity.externalConsent = input.externalConsent;
  } else if (input.type === 'diagram') entity.externalConsent = false;
  if (input.url !== undefined) {
    if (typeof input.url !== 'string' || input.url.length > 2 * 1024 * 1024 || !/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(input.url)) throw httpError(400, 'INVALID_IMAGE', 'Use a PNG, JPEG, WebP, or GIF image smaller than 1.5 MB.');
    entity.url = input.url;
  }
  if (input.type === 'screen') {
    if (input.participantId !== sender.id) throw httpError(403, 'FORBIDDEN', 'Share only your own screen.');
    entity.participantId = sender.id;
  }
  entity.updatedBy = sender.id;
  entity.updatedAt = Date.now();
  return entity;
}

export async function createApp(options = {}) {
  const env = options.env ?? process.env;
  const envValue = key => typeof env === 'function' ? env(key) : env[key];
  const dataFile = options.dataFile ?? process.env.DATA_FILE ?? path.join(ROOT, 'data/rooms.json');
  const staticDir = options.staticDir ?? path.join(ROOT, 'dist');
  const heartbeatMs = options.heartbeatMs ?? 30000;
  const reservationMs = options.reservationMs ?? 60000;
  const reconnectGraceMs = options.reconnectGraceMs ?? 15000;
  const sessionTtl = options.sessionTtl ?? SESSION_TTL;
  const rooms = new Map();
  const httpRates = new Map();
  const sockets = new Set();
  let writeQueue = Promise.resolve();
  let persistTimer;
  let closing = false;
  let storageError = null;
  try {
    const saved = JSON.parse(await readFile(dataFile, 'utf8'));
    if (!Array.isArray(saved.rooms)) throw new Error('Invalid room storage.');
    for (const savedRoom of saved.rooms) {
      if (savedRoom.expiresAt < Date.now()) continue;
      const collaboration = savedRoom.collaboration === 'peer' ? 'peer' : 'server';
      const room = { ...savedRoom, collaboration, entities: new Map((collaboration === 'peer' ? [] : savedRoom.entities).filter(e => e.type !== 'screen').map(e => [e.id, e])), participants: new Map(), entityBytes: 0 };
      for (const p of savedRoom.participants) {
        if (p.expiresAt > Date.now()) room.participants.set(p.tokenHash, { ...p, socket: null, reservedUntil: 0 });
      }
      for (const entity of room.entities.values()) room.entityBytes += Buffer.byteLength(JSON.stringify(entity));
      rooms.set(room.id, room);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot load session data: ${error.message}`, { cause: error });
  }

  function persist() {
    clearTimeout(persistTimer);
    persistTimer = null;
    const snapshot = JSON.stringify({ version: 1, rooms: [...rooms.values()].map(room => ({
      id: room.id, name: room.name, createdAt: room.createdAt, expiresAt: room.expiresAt, collaboration: room.collaboration,
      passwordHash: room.passwordHash, passwordSalt: room.passwordSalt,
      participants: [...room.participants.values()].map(({ socket, rate, ...participant }) => participant),
      entities: room.collaboration === 'peer' ? [] : [...room.entities.values()].filter(entity => entity.type !== 'screen'), chat: room.chat,
    })) });
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(dataFile), { recursive: true, mode: 0o700 });
      await writeFile(`${dataFile}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${dataFile}.tmp`, dataFile);
      storageError = null;
    }).catch(error => { storageError = error; console.error('Session persistence failed:', safeErrorCode(error)); throw error; });
    return writeQueue;
  }
  function schedulePersist() {
    if (closing || persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; persist().catch(() => {}); }, 250);
    persistTimer.unref();
  }
  const send = (socket, message) => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 8 * 1024 * 1024) { socket.close(1013, 'Connection is slow; reconnect for latest state'); return; }
    socket.send(JSON.stringify(message));
  };
  const broadcast = (room, message, except) => { for (const p of room.participants.values()) if (p.id !== except) send(p.socket, message); };
  const participants = room => [...room.participants.values()].filter(p => p.socket?.readyState === WebSocket.OPEN).map(publicParticipant);
  function addParticipant(room, name, isAdmin) {
    const token = randomId(32);
    const id = randomId(10);
    const participant = { id, name, isAdmin, tokenHash: hashToken(token), color: COLORS[room.participants.size % COLORS.length], expiresAt: Date.now() + sessionTtl, reservedUntil: Date.now() + reservationMs, socket: null };
    room.participants.set(participant.tokenHash, participant);
    return { participant, token };
  }
  function removeScreens(room, participantId) {
    for (const [id, entity] of room.entities) if (entity.type === 'screen' && entity.participantId === participantId) {
      room.entities.delete(id);
      room.entityBytes -= Buffer.byteLength(JSON.stringify(entity));
      broadcast(room, { type: 'delete', id });
    }
  }
  function detach(room, participant, socket) {
    sockets.delete(socket);
    if (participant.socket !== socket) return;
    participant.socket = null;
    participant.reservedUntil = Date.now() + reconnectGraceMs;
    removeScreens(room, participant.id);
    broadcast(room, { type: 'participants', participants: participants(room) });
    schedulePersist();
  }
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const url = new URL(origin);
      const allowed = (envValue('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);
      return (['http:', 'https:'].includes(url.protocol) && url.host === req.headers.host) || allowed.includes(url.origin);
    } catch { return false; }
  }
  function authorizedParticipant(req, room) {
    if (!room || room.expiresAt <= Date.now()) throw httpError(404, 'ROOM_NOT_FOUND', 'This session has ended or the link is invalid.');
    const authorization = req.headers.authorization;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') && authorization.slice(7);
    const participant = token && token.length <= 128 && room.participants.get(hashToken(token));
    if (!participant || participant.expiresAt <= Date.now()) throw httpError(401, 'SESSION_EXPIRED', 'Please enter the room password again.');
    return participant;
  }
  function limitHttp(req, kind, limit) {
    const key = `${req.socket.remoteAddress}:${kind}`;
    const now = Date.now();
    const bucket = httpRates.get(key) ?? { start: now, count: 0 };
    if (now - bucket.start > 60000) { bucket.start = now; bucket.count = 0; }
    if (++bucket.count > limit) throw httpError(429, 'RATE_LIMITED', 'Too many attempts. Try again in a minute.');
    httpRates.set(key, bucket);
  }
  async function jsonBody(req) {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw httpError(415, 'JSON_REQUIRED', 'Send JSON content.');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw httpError(413, 'TOO_LARGE', 'Request is too large.');
      chunks.push(chunk);
    }
    try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (!isObject(result)) throw new Error(); return result; }
    catch { throw httpError(400, 'INVALID_JSON', 'Request must be a JSON object.'); }
  }
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  const server = http.createServer(async (req, res) => {
    const observation = startRequestObservation(req, { env });
    for (const [name, value] of Object.entries(observation.headers)) res.setHeader(name, value);
    res.once('finish', () => { observation.finish(res.statusCode).catch(() => {}); });
    res.once('close', () => { if (!res.writableFinished) observation.finish(499).catch(() => {}); });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'display-capture=(self), camera=(), microphone=()');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST') {
        if (!sameOrigin(req)) throw httpError(403, 'INVALID_ORIGIN', 'This request must come from the app.');
        if (storageError) throw httpError(503, 'STORAGE_UNAVAILABLE', 'Session storage is unavailable. Try again later.');
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, storageError ? 503 : 200, { ok: !storageError });
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, publicRuntimeConfig(env, { transport: 'websocket' }));
      if (req.method === 'GET' && url.pathname === '/api/ice') {
        const iceServers = stunServersFromEnv(env);
        const turnConfigured = envValue('TURN_URLS') && (envValue('TURN_SECRET') || (envValue('TURN_USERNAME') && envValue('TURN_CREDENTIAL')));
        if (turnConfigured && url.searchParams.has('room')) {
          limitHttp(req, 'ice', 120);
          const participant = authorizedParticipant(req, rooms.get(url.searchParams.get('room')));
          let username = envValue('TURN_USERNAME');
          let credential = envValue('TURN_CREDENTIAL');
          if (envValue('TURN_SECRET')) {
            const configuredTtl = Number(envValue('TURN_TTL_SECONDS'));
            const ttl = Number.isFinite(configuredTtl) && configuredTtl > 0 ? Math.min(86400, Math.max(60, Math.floor(configuredTtl))) : 3600;
            username = `${Math.floor(Date.now() / 1000) + ttl}:${participant.id}`;
            credential = createHmac('sha1', envValue('TURN_SECRET')).update(username).digest('base64');
          }
          iceServers.push({ urls: envValue('TURN_URLS').split(',').map(s => s.trim()).filter(Boolean), username, credential });
        }
        return json(res, 200, { iceServers, iceTransportPolicy: iceTransportPolicyFromEnv(env) });
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        limitHttp(req, 'create', 15);
        if (rooms.size >= 1000) throw httpError(503, 'CAPACITY', 'This server has reached its session capacity.');
        const input = normalizeRoomCreation(await jsonBody(req), { defaultCollaboration: 'server', allowedCollaborations: ['server', 'peer'] });
        const { name, displayName, collaboration } = input;
        const salt = randomBytes(16).toString('hex');
        const passwordHash = (await scrypt(input.password, salt, 64)).toString('hex');
        const room = { id: randomId(), name, collaboration, createdAt: Date.now(), expiresAt: Date.now() + ROOM_TTL, passwordHash, passwordSalt: salt, participants: new Map(), entities: new Map(), entityBytes: 0, chat: [] };
        const { participant, token } = addParticipant(room, displayName, true);
        rooms.set(room.id, room);
        await persist();
        return json(res, 201, { room: publicRoom(room), token, participantId: participant.id, isAdmin: true });
      }
      const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,100})(\/(?:join|session))?$/);
      if (match) {
        const room = rooms.get(match[1]);
        if (!room || room.expiresAt <= Date.now()) throw httpError(404, 'ROOM_NOT_FOUND', 'This session has ended or the link is invalid.');
        if (req.method === 'GET' && !match[2]) return json(res, 200, { room: publicRoom(room) });
        if (req.method === 'GET' && match[2] === '/session') {
          const participant = authorizedParticipant(req, room);
          return json(res, 200, { room: publicRoom(room), participantId: participant.id, isAdmin: participant.isAdmin, displayName: participant.name });
        }
        if (req.method === 'POST' && match[2] === '/join') {
          limitHttp(req, `join:${room.id}`, 30);
          limitHttp(req, 'join', 60);
          const input = normalizeJoin(await jsonBody(req));
          const { displayName } = input;
          const actual = await scrypt(input.password, room.passwordSalt, 64);
          if (!timingSafeEqual(Buffer.from(room.passwordHash, 'hex'), actual)) throw httpError(401, 'WRONG_PASSWORD', 'That password does not match.');
          // Revalidate after the asynchronous password work; the host may have ended the room.
          if (!rooms.has(room.id)) throw httpError(404, 'ROOM_NOT_FOUND', 'This session has ended.');
          const { participant, token } = addParticipant(room, displayName, false);
          await persist();
          return json(res, 200, { room: publicRoom(room), token, participantId: participant.id, isAdmin: false });
        }
      }
      if (url.pathname.startsWith('/api/')) throw httpError(404, 'NOT_FOUND', 'Endpoint not found.');
      if (!['GET', 'HEAD'].includes(req.method)) throw httpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      let requested;
      try { requested = decodeURIComponent(url.pathname); } catch { throw httpError(400, 'INVALID_PATH', 'Invalid path.'); }
      const filename = path.resolve(staticDir, `.${requested}`);
      if (!filename.startsWith(`${path.resolve(staticDir)}${path.sep}`) && filename !== path.resolve(staticDir)) throw httpError(403, 'FORBIDDEN', 'Invalid path.');
      const extensions = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.json': 'application/json', '.woff2': 'font/woff2' };
      let asset = filename;
      let content;
      try { content = await readFile(asset); }
      catch (error) {
        if (path.extname(requested) && requested !== '/') throw httpError(404, 'NOT_FOUND', 'File not found.');
        asset = path.join(staticDir, 'index.html');
        try { content = await readFile(asset); } catch { throw httpError(503, 'NOT_BUILT', 'Build the app first with bun run build, or use bun run dev.'); }
      }
      res.writeHead(200, { 'Content-Type': extensions[path.extname(asset)] || 'application/octet-stream', 'Cache-Control': asset.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : 'An unexpected server error occurred.', code: error.code ?? 'INTERNAL_ERROR' });
      else res.end();
      if (!error.status) console.error('Common request failed:', safeErrorCode(error));
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 15000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024, perMessageDeflate: false });
  const upgradeObservations = new WeakMap();
  wss.on('headers', (headers, request) => {
    const observation = upgradeObservations.get(request);
    if (observation) for (const [name, value] of Object.entries(observation.headers)) headers.push(`${name}: ${value}`);
  });
  server.on('upgrade', (req, socket, head) => {
    const observation = startRequestObservation(req, { env });
    upgradeObservations.set(req, observation);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws' || !sameOrigin(req)) throw httpError(403, 'FORBIDDEN', 'Forbidden');
      const room = rooms.get(url.searchParams.get('room'));
      const token = url.searchParams.get('token');
      const participant = token && token.length <= 128 && room?.participants.get(hashToken(token));
      if (!room || !participant || participant.expiresAt <= Date.now() || room.expiresAt <= Date.now()) throw httpError(401, 'UNAUTHORIZED', 'Session expired');
      participant.reservedUntil = Date.now() + reservationMs;
      wss.handleUpgrade(req, socket, head, ws => {
        observation.finish(101).catch(() => {});
        const oldSocket = participant.socket;
        participant.socket = ws;
        participant.expiresAt = Date.now() + sessionTtl;
        participant.rate = { start: Date.now(), count: 0, bytes: 0 };
        ws.isAlive = true;
        sockets.add(ws);
        if (oldSocket && oldSocket !== ws) oldSocket.close(4001, 'Connected in another tab');
        // Bun's ws adapter does not currently forward custom upgrade headers.
        // Keep the same safe correlation fields available in its init envelope.
        const diagnostics = { requestId: observation.headers['X-Common-Request-Id'], buildId: observation.headers['X-Common-Build'], protocolVersion: 1, traceparent: observation.headers.traceparent };
        send(ws, { type: 'init', capabilities: protocolCapabilities('websocket'), diagnostics, room: publicRoom(room), self: publicParticipant(participant), participants: participants(room), entities: room.collaboration === 'peer' ? [] : [...room.entities.values()], chat: room.chat });
        broadcast(room, { type: 'participants', participants: participants(room) });
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('error', () => {});
        ws.on('close', () => detach(room, participant, ws));
        ws.on('message', (buffer, isBinary) => {
          try {
            if (participant.socket !== ws || !rooms.has(room.id)) return;
            const now = Date.now();
            if (now - participant.rate.start > 1000) participant.rate = { start: now, count: 0, bytes: 0 };
            participant.rate.count++;
            participant.rate.bytes += buffer.length;
            if (participant.rate.count > 200 || participant.rate.bytes > 8 * 1024 * 1024) { ws.close(1008, 'Slow down'); return; }
            if (isBinary) throw httpError(400, 'INVALID_MESSAGE', 'Send JSON messages.');
            let message;
            try { message = JSON.parse(buffer.toString()); } catch { throw httpError(400, 'INVALID_JSON', 'Invalid message.'); }
            normalizeEnvelope(message, { receivedBytes: buffer.length });
            if (message.type === 'ping') return send(ws, { type: 'pong' });
            if (message.type === 'cursor') {
              normalizeCursor(message);
              return broadcast(room, { type: 'cursor', participantId: participant.id, x: message.x, y: message.y }, participant.id);
            }
            if (message.type === 'signal') {
              const signal = normalizeSignal(message, { senderId: participant.id, receivedBytes: buffer.length });
              const target = [...room.participants.values()].find(p => p.id === signal.to);
              if (target?.socket?.readyState !== WebSocket.OPEN) throw httpError(400, 'INVALID_SIGNAL', 'Signal recipient is unavailable.');
              return send(target.socket, { type: 'signal', from: participant.id, data: signal.data });
            }
            if (message.type === 'upsert') {
              if (room.collaboration === 'peer') throw httpError(409, 'PEER_CANVAS', 'Canvas changes belong on the peer data channel.');
              const entity = entityFrom(message.entity, participant);
              const previous = room.entities.get(entity.id);
              if (previous?.type === 'screen' && previous.participantId !== participant.id) throw httpError(403, 'FORBIDDEN', 'Only the sharing participant can edit this screen.');
              if (entity.type === 'screen' && [...room.entities.values()].filter(e => e.type === 'screen' && e.participantId === participant.id && e.id !== entity.id).length >= 3) throw httpError(409, 'SCREEN_LIMIT', 'Share up to three windows per person.');
              if (!previous && room.entities.size >= MAX_ENTITIES) throw httpError(409, 'BOARD_FULL', 'This board has reached its item limit.');
              const size = Buffer.byteLength(JSON.stringify(entity));
              const previousSize = previous ? Buffer.byteLength(JSON.stringify(previous)) : 0;
              if (room.entityBytes + size - previousSize > MAX_ROOM_BYTES) throw httpError(409, 'BOARD_FULL', 'This board has reached its storage limit.');
              room.entityBytes += size - previousSize;
              room.entities.set(entity.id, entity);
              room.expiresAt = Date.now() + ROOM_TTL;
              broadcast(room, { type: 'upsert', entity });
              schedulePersist();
              return;
            }
            if (message.type === 'delete') {
              if (room.collaboration === 'peer') throw httpError(409, 'PEER_CANVAS', 'Canvas changes belong on the peer data channel.');
              const entity = room.entities.get(message.id);
              if (!entity) return;
              if (entity.type === 'screen' && entity.participantId !== participant.id && !participant.isAdmin) throw httpError(403, 'FORBIDDEN', 'Only the host or sharing participant can remove this screen.');
              room.entities.delete(message.id);
              room.entityBytes -= Buffer.byteLength(JSON.stringify(entity));
              broadcast(room, { type: 'delete', id: message.id });
              schedulePersist();
              return;
            }
            if (message.type === 'chat') {
              const text = normalizeChat(message.text);
              const entry = { id: randomId(10), participantId: participant.id, name: participant.name, text, createdAt: Date.now() };
              room.chat.push(entry);
              if (room.chat.length > SESSION_POLICY.maxChatMessages) room.chat.shift();
              broadcast(room, { type: 'chat', message: entry });
              schedulePersist();
              return;
            }
            if (message.type === 'end') {
              if (!participant.isAdmin) throw httpError(403, 'FORBIDDEN', 'Only the host can end this session.');
              broadcast(room, { type: 'ended' });
              rooms.delete(room.id);
              for (const p of room.participants.values()) p.socket?.close(4000, 'Session ended');
              persist().catch(() => {});
              return;
            }
            if (message.type === 'leave') {
              room.participants.delete(participant.tokenHash);
              removeScreens(room, participant.id);
              broadcast(room, { type: 'participants', participants: participants(room) });
              ws.close(1000, 'Left session');
              schedulePersist();
              return;
            }
            throw httpError(400, 'INVALID_MESSAGE', 'Unknown message type.');
          } catch (error) {
            send(ws, { type: 'error', error: error.status ? error.message : 'Could not process this update.', code: error.code ?? 'INTERNAL_ERROR' });
          }
        });
        schedulePersist();
      });
    } catch (error) {
      observation.finish(error.status ?? 400).catch(() => {});
      const correlationHeaders = Object.entries(observation.headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
      socket.write(`HTTP/1.1 ${error.status ?? 400} Error\r\n${correlationHeaders}Connection: close\r\n\r\n`);
      socket.destroy();
    }
  });
  const interval = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const room of rooms.values()) {
      if (room.expiresAt <= now) {
        broadcast(room, { type: 'ended' });
        for (const p of room.participants.values()) p.socket?.close(4000, 'Session expired');
        rooms.delete(room.id);
        changed = true;
        continue;
      }
      for (const [key, participant] of room.participants) {
        const ws = participant.socket;
        if (participant.expiresAt <= now) { ws?.close(4003, 'Session token expired'); room.participants.delete(key); changed = true; }
        else if (ws) {
          if (!ws.isAlive) { ws.terminate(); continue; }
          ws.isAlive = false;
          ws.ping();
        }
      }
    }
    for (const [key, bucket] of httpRates) if (now - bucket.start > 120000) httpRates.delete(key);
    if (changed) schedulePersist();
  }, heartbeatMs);
  interval.unref();

  return {
    server,
    async listen(port = Number(process.env.PORT) || 3001, host = process.env.HOST || '0.0.0.0') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return server.address();
    },
    async close() {
      closing = true;
      clearInterval(interval);
      clearTimeout(persistTimer);
      for (const socket of sockets) socket.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
      await persist();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const address = await app.listen();
  console.log(`Common server listening on http://localhost:${address.port}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
