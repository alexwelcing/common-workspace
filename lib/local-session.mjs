import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { normalizeRoomCreation, normalizeJoin, normalizeEnvelope, normalizeSignal, normalizeChat, normalizeCursor, protocolCapabilities, SESSION_POLICY } from './session-protocol.mjs';
import { publicRuntimeConfig, stunServersFromEnv, iceTransportPolicyFromEnv } from './runtime-config.mjs';

const scrypt = promisify(scryptCallback);
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

/** Shared in-process room engine. HTTP/WebSocket servers and embedding policy live in adapters. */
export async function createLocalSession(options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  if (!env || !['object', 'function'].includes(typeof env)) throw new TypeError('env must be an object or a lookup function.');
  const envValue = key => typeof env === 'function' ? env(key) : env[key];
  const dataFile = options.dataFile ?? null;
  const heartbeatMs = options.heartbeatMs ?? 30000;
  const reservationMs = options.reservationMs ?? 60000;
  const reconnectGraceMs = options.reconnectGraceMs ?? 15000;
  const sessionTtl = options.sessionTtl ?? options.sessionTtlMs ?? SESSION_TTL;
  const roomTtl = options.roomTtl ?? options.roomTtlMs ?? ROOM_TTL;
  const rooms = new Map();
  const httpRates = new Map();
  const connections = new Map();
  const admissions = new WeakMap();
  let writeQueue = Promise.resolve();
  let persistTimer;
  let closing = false;
  let storageError = null;
  function ensureOpen() { if (closing) throw httpError(503, 'SERVICE_CLOSED', 'Session service is closed.'); }
  if (dataFile !== null) {
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
  }

  function persist() {
    clearTimeout(persistTimer);
    persistTimer = null;
    if (dataFile === null) return Promise.resolve();
    const snapshot = JSON.stringify({ version: 1, rooms: [...rooms.values()].map(room => ({
      id: room.id, name: room.name, createdAt: room.createdAt, expiresAt: room.expiresAt, collaboration: room.collaboration,
      passwordHash: room.passwordHash, passwordSalt: room.passwordSalt,
      participants: [...room.participants.values()].map(({ socket: _socket, rate: _rate, ...participant }) => participant),
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
    if (dataFile === null || closing || persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; persist().catch(() => {}); }, 250);
    persistTimer.unref();
  }
  const send = (socket, message) => {
    if (socket?.readyState !== 1) return;
    if (socket.bufferedAmount > 8 * 1024 * 1024) { socket.close(1013, 'Connection is slow; reconnect for latest state'); return; }
    socket.send(JSON.stringify(message));
  };
  const broadcast = (room, message, except) => { for (const p of room.participants.values()) if (p.id !== except) send(p.socket, message); };
  const participants = room => [...room.participants.values()].filter(p => p.socket?.readyState === 1).map(publicParticipant);
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
    connections.delete(socket);
    if (participant.socket !== socket) return;
    participant.socket = null;
    participant.reservedUntil = Date.now() + reconnectGraceMs;
    removeScreens(room, participant.id);
    broadcast(room, { type: 'participants', participants: participants(room) });
    schedulePersist();
  }
  function sameOrigin(req) {
    const origin = req.headers.get('origin');
    if (!origin) return true;
    try {
      const url = new URL(origin);
      const allowed = (envValue('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);
      return (['http:', 'https:'].includes(url.protocol) && url.host === new URL(req.url).host) || allowed.includes(url.origin);
    } catch { return false; }
  }
  function authorizedParticipant(req, room) {
    if (!room || room.expiresAt <= Date.now()) throw httpError(404, 'ROOM_NOT_FOUND', 'This session has ended or the link is invalid.');
    const authorization = req.headers.get('authorization');
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') && authorization.slice(7);
    const participant = token && token.length <= 128 && room.participants.get(hashToken(token));
    if (!participant || participant.expiresAt <= Date.now()) throw httpError(401, 'SESSION_EXPIRED', 'Please enter the room password again.');
    return participant;
  }
  function limitHttp(ip, kind, limit) {
    const key = `${ip}:${kind}`;
    const now = Date.now();
    const bucket = httpRates.get(key) ?? { start: now, count: 0 };
    if (now - bucket.start > 60000) { bucket.start = now; bucket.count = 0; }
    if (++bucket.count > limit) throw httpError(429, 'RATE_LIMITED', 'Too many attempts. Try again in a minute.');
    httpRates.set(key, bucket);
  }
  async function jsonBody(req) {
    if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw httpError(415, 'JSON_REQUIRED', 'Send JSON content.');
    const reader = req.body?.getReader();
    const chunks = []; let size = 0;
    if (reader) try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) { await reader.cancel(); throw httpError(413, 'TOO_LARGE', 'Request is too large.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (!isObject(result)) throw new Error(); return result; }
    catch { throw httpError(400, 'INVALID_JSON', 'Request must be a JSON object.'); }
  }
  function json(status, value) {
    return Response.json(value, { status, headers: {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY', 'Permissions-Policy': 'display-capture=(self), camera=(), microphone=()',
    } });
  }
  async function fetchRequest(req, { ip = 'unknown' } = {}) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return null;
    if (closing) return json(503, { error: 'Session service is closed.', code: 'SERVICE_CLOSED' });
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let response;
    try { response = await handleApi(req, url, method, ip); }
    catch (failure) {
      if (!failure.status) console.error('Common request failed:', safeErrorCode(failure));
      response = json(failure.status ?? 500, { error: failure.status ? failure.message : 'An unexpected server error occurred.', code: failure.code ?? 'INTERNAL_ERROR' });
    }
    return req.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
  }
  async function handleApi(req, url, method, ip) {
    if (method === 'POST') {
      if (!sameOrigin(req)) throw httpError(403, 'INVALID_ORIGIN', 'This request must come from the app.');
      if (storageError) throw httpError(503, 'STORAGE_UNAVAILABLE', 'Session storage is unavailable. Try again later.');
    }
    if (method === 'GET' && url.pathname === '/api/health') return json(storageError ? 503 : 200, { ok: !storageError });
    if (method === 'GET' && url.pathname === '/api/config') return json(200, publicRuntimeConfig(env, { transport: 'websocket' }));
    if (method === 'GET' && url.pathname === '/api/ice') {
      const iceServers = stunServersFromEnv(env);
      const turnConfigured = envValue('TURN_URLS') && (envValue('TURN_SECRET') || (envValue('TURN_USERNAME') && envValue('TURN_CREDENTIAL')));
      if (turnConfigured && url.searchParams.has('room')) {
        limitHttp(ip, 'ice', 120);
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
      return json(200, { iceServers, iceTransportPolicy: iceTransportPolicyFromEnv(env) });
    }
    if (method === 'POST' && url.pathname === '/api/rooms') {
      limitHttp(ip, 'create', 15);
      if (rooms.size >= 1000) throw httpError(503, 'CAPACITY', 'This server has reached its session capacity.');
      const input = normalizeRoomCreation(await jsonBody(req), { defaultCollaboration: 'server', allowedCollaborations: ['server', 'peer'] });
      const { name, displayName, collaboration } = input;
      const salt = randomBytes(16).toString('hex');
      const passwordHash = (await scrypt(input.password, salt, 64)).toString('hex');
      ensureOpen();
      const room = { id: randomId(), name, collaboration, createdAt: Date.now(), expiresAt: Date.now() + roomTtl, passwordHash, passwordSalt: salt, participants: new Map(), entities: new Map(), entityBytes: 0, chat: [] };
      const { participant, token } = addParticipant(room, displayName, true);
      rooms.set(room.id, room);
      await persist();
      ensureOpen();
      return json(201, { room: publicRoom(room), token, participantId: participant.id, isAdmin: true });
    }
    const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,100})(\/(?:join|session))?$/);
    if (match) {
      const room = rooms.get(match[1]);
      if (!room || room.expiresAt <= Date.now()) throw httpError(404, 'ROOM_NOT_FOUND', 'This session has ended or the link is invalid.');
      if (method === 'GET' && !match[2]) return json(200, { room: publicRoom(room) });
      if (method === 'GET' && match[2] === '/session') {
        const participant = authorizedParticipant(req, room);
        return json(200, { room: publicRoom(room), participantId: participant.id, isAdmin: participant.isAdmin, displayName: participant.name });
      }
      if (method === 'POST' && match[2] === '/join') {
        limitHttp(ip, `join:${room.id}`, 30);
        limitHttp(ip, 'join', 60);
        const input = normalizeJoin(await jsonBody(req));
        const { displayName } = input;
        const actual = await scrypt(input.password, room.passwordSalt, 64);
        ensureOpen();
        if (!timingSafeEqual(Buffer.from(room.passwordHash, 'hex'), actual)) throw httpError(401, 'WRONG_PASSWORD', 'That password does not match.');
        // Revalidate after the asynchronous password work; the host may have ended the room.
        if (!rooms.has(room.id)) throw httpError(404, 'ROOM_NOT_FOUND', 'This session has ended.');
        const { participant, token } = addParticipant(room, displayName, false);
        await persist();
        ensureOpen();
        return json(200, { room: publicRoom(room), token, participantId: participant.id, isAdmin: false });
      }
    }
    if (url.pathname.startsWith('/api/')) throw httpError(404, 'NOT_FOUND', 'Endpoint not found.');
    throw httpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  }
  function authorizeWebSocket(req) {
    if (closing) throw httpError(503, 'SERVICE_CLOSED', 'Session service is closed.');
    const url = new URL(req.url);
    if (url.pathname !== '/ws' || !sameOrigin(req)) throw httpError(403, 'FORBIDDEN', 'Forbidden');
    const room = rooms.get(url.searchParams.get('room'));
    const token = url.searchParams.get('token');
    const participant = token && token.length <= 128 && room?.participants.get(hashToken(token));
    if (!room || !participant || participant.expiresAt <= Date.now() || room.expiresAt <= Date.now()) throw httpError(401, 'UNAUTHORIZED', 'Session expired');
    participant.reservedUntil = Date.now() + reservationMs;
    const admission = {};
    admissions.set(admission, { room, participant });
    return admission;
  }
  function open(ws, admission) {
    if (!admission || !admissions.has(admission)) throw httpError(401, 'UNAUTHORIZED', 'Invalid socket admission.');
    const { room, participant } = admissions.get(admission);
    admissions.delete(admission);
    if (closing || rooms.get(room.id) !== room || room.participants.get(participant.tokenHash) !== participant ||
      participant.expiresAt <= Date.now() || room.expiresAt <= Date.now()) throw httpError(401, 'UNAUTHORIZED', 'Session expired');
    const oldSocket = participant.socket;
    participant.socket = ws;
    participant.expiresAt = Date.now() + sessionTtl;
    participant.rate = { start: Date.now(), count: 0, bytes: 0 };
    connections.set(ws, { room, participant, alive: true });
    if (oldSocket && oldSocket !== ws) oldSocket.close(4001, 'Connected in another tab');
    const diagnostics = admission.diagnostics;
    send(ws, { type: 'init', capabilities: protocolCapabilities('websocket'), diagnostics, room: publicRoom(room), self: publicParticipant(participant), participants: participants(room), entities: room.collaboration === 'peer' ? [] : [...room.entities.values()], chat: room.chat });
    broadcast(room, { type: 'participants', participants: participants(room) });
    schedulePersist();
  }
  function message(ws, data, isBinary = false) {
    const connection = connections.get(ws);
    if (!connection) return;
    const { room, participant } = connection;
    const buffer = Buffer.from(data);
    if (buffer.length > 3 * 1024 * 1024) { ws.close(1009, 'Message is too large'); return; }
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
        if (target?.socket?.readyState !== 1) throw httpError(400, 'INVALID_SIGNAL', 'Signal recipient is unavailable.');
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
        room.expiresAt = Date.now() + roomTtl;
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
  }
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
          const connection = connections.get(ws);
          if (!connection) continue;
          if (!connection.alive) { ws.terminate(); continue; }
          connection.alive = false;
          ws.ping();
        }
      }
    }
    for (const [key, bucket] of httpRates) if (now - bucket.start > 120000) httpRates.delete(key);
    if (changed) schedulePersist();
  }, heartbeatMs);
  interval.unref();

  return {
    fetch: fetchRequest, authorizeWebSocket, open, message,
    close(socket) { const connection = connections.get(socket); if (connection) detach(connection.room, connection.participant, socket); },
    pong(socket) { const connection = connections.get(socket); if (connection) connection.alive = true; },
    async closeEngine() {
      if (closing) return writeQueue;
      closing = true;
      clearInterval(interval); clearTimeout(persistTimer);
      for (const socket of connections.keys()) socket.terminate();
      try { await persist(); }
      finally { connections.clear(); rooms.clear(); }
    },
  };
}
