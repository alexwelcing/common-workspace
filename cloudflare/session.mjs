import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { normalizeRoomCreation, normalizeJoin, normalizeSignal, normalizeChat, normalizeCursor, normalizeEnvelope, protocolCapabilities } from '../lib/session-protocol.mjs';
import { workshopChecklist, workshopSnapshot, workshopUpdate } from '../lib/session-workshop.mjs';
import { normalizeAppearance, appearanceSnapshot } from '../lib/room-appearance.mjs';
import { stunServersFromEnv, iceTransportPolicyFromEnv } from '../lib/runtime-config.mjs';

const scrypt = promisify(scryptCallback);
const COLORS = ['#7867ef', '#e3a444', '#4aa3b9', '#df7b9d', '#75b790', '#d27b58', '#8b9ed5', '#ba91ce', '#9baf5f', '#68b3aa'];
const MAX_BODY = 128 * 1024;
const EVENT_BATCH_SIZE = 64;
const EVENT_BATCH_BYTES = 512 * 1024;
const LEASE_MS = 120000;
const LEASE_REFRESH_MS = 30000;
const RESERVATION_MS = 60000;
const EVENT_TTL_MS = 600000;
const ROOM_TTL_MS = 86400000;
const SESSION_TTL_MS = 86400000;
const randomId = (length = 12) => randomBytes(length).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const roomMissing = () => error(404, 'ROOM_NOT_FOUND', 'This session has ended or the link is invalid.');
const sessionExpired = () => error(401, 'SESSION_EXPIRED', 'Please enter the room password again.');
const resync = () => error(409, 'RESYNC_REQUIRED', 'Reconnect to refresh the session.');
const publicRoom = room => ({ id: room.id, name: room.name, createdAt: room.created_at, appearance: appearanceSnapshot(room.appearance), ...(room.experience === 'spatial-beta' ? { experience: 'spatial-beta' } : {}), collaboration: 'peer', transport: 'poll' });
const publicMember = (member, room) => ({ id: member.id, name: member.name, color: member.color, isAdmin: member.is_admin, ...(room.workshop ? { checklist: workshopChecklist(room.workshop, member.checklist) } : {}) });
const guidedState = room => room.workshop ? { workshop: workshopSnapshot(room.workshop) } : {};
const first = cursor => cursor.toArray()[0];

function json(value, status = 200) {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'display-capture=(self), camera=(), microphone=()',
  } });
}

function failureResponse(failure) {
  if (!failure.status) console.error('Common Cloudflare session failure:', failure.code ?? failure.name ?? 'unknown');
  return json({ error: failure.status ? failure.message : 'Session storage is unavailable. Please try again.', code: failure.status ? failure.code : 'SERVICE_UNAVAILABLE' }, failure.status ?? 503);
}

async function body(request, maxBytes = MAX_BODY) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw error(415, 'JSON_REQUIRED', 'Send JSON content.');
  if (Number(request.headers.get('content-length')) > maxBytes) throw error(413, 'TOO_LARGE', 'Request is too large.');
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw error(413, 'TOO_LARGE', 'Request is too large.'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw error(400, 'INVALID_JSON', 'Request must be a JSON object.'); }
}

function verifyOrigin(request) {
  const origin = request.headers.get('origin');
  if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== new URL(request.url).origin)) throw error(403, 'INVALID_ORIGIN', 'This request must come from the app.');
}

/** One named SQLite Durable Object owns a room and its ordered polling stream.
 * No browser canvas, image or media content is accepted into this store.
 */
export class CommonRoom {
  constructor(state, env) {
    this.state = state;
    this.env = key => env[key];
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS room (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
          expires_at INTEGER NOT NULL, lease_until INTEGER NOT NULL, connection_id TEXT, joined_at INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS members_presence ON members (lease_until, expires_at);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, target_id TEXT, except_id TEXT,
          payload TEXT NOT NULL, created_at INTEGER NOT NULL, sender_id TEXT, connection_id TEXT, request_id TEXT, request_hash TEXT);
        CREATE INDEX IF NOT EXISTS events_recipient ON events (target_id, seq);
        CREATE INDEX IF NOT EXISTS events_expiry ON events (created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS events_request ON events (sender_id, connection_id, request_id) WHERE request_id IS NOT NULL;`);
    });
  }

  now() { return Date.now(); }

  readRoom(id, allowEnded = false) {
    const stored = first(this.sql.exec('SELECT data FROM room WHERE singleton = 1'));
    const room = stored && JSON.parse(stored.data);
    if (!room || room.id !== id || room.expires_at <= this.now() || (!allowEnded && room.ended_at)) throw roomMissing();
    return room;
  }

  saveRoom(room) { this.sql.exec('INSERT INTO room (singleton, data) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET data = excluded.data', JSON.stringify(room)); }

  member(request, room) {
    const authorization = request.headers.get('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token || token.length > 128) throw sessionExpired();
    const stored = first(this.sql.exec('SELECT data FROM members WHERE token_hash = ?', hash(token)));
    const member = stored && JSON.parse(stored.data);
    if (room.expires_at <= this.now()) throw roomMissing();
    if (!member || member.expires_at <= this.now()) throw sessionExpired();
    return member;
  }

  saveMember(member) {
    this.sql.exec(`INSERT INTO members (id, token_hash, expires_at, lease_until, connection_id, joined_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash,
      expires_at = excluded.expires_at, lease_until = excluded.lease_until, connection_id = excluded.connection_id,
      joined_at = excluded.joined_at, data = excluded.data`, member.id, member.token_hash, member.expires_at,
    member.lease_until, member.connection_id, member.joined_at, JSON.stringify(member));
  }

  checkConnection(member, request, time = this.now()) {
    const connection = request.headers.get('x-common-connection');
    if (!connection || connection !== member.connection_id) throw error(409, 'CONNECTION_REPLACED', 'This session is connected in another tab.');
    if (member.lease_until <= time || member.expires_at <= time) throw resync();
  }

  roster(room, time = this.now(), except) {
    const people = this.sql.exec(`SELECT data FROM members WHERE expires_at > ? AND lease_until > ?
      AND connection_id IS NOT NULL ORDER BY joined_at, id`, time, time).toArray().map(row => JSON.parse(row.data));
    let checkAt = room.expires_at;
    for (const member of people) checkAt = Math.min(checkAt, member.lease_until, member.expires_at);
    return { participants: people.filter(member => member.id !== except).map(member => publicMember(member, room)), checkAt };
  }

  append(room, message, time, { target = null, except = null, sender = null, connection = null, requestId = null, requestHash = null } = {}) {
    room.event_seq = String(BigInt(room.event_seq) + 1n);
    this.sql.exec(`INSERT INTO events (seq, target_id, except_id, payload, created_at, sender_id, connection_id, request_id, request_hash)
      VALUES (CAST(? AS INTEGER), ?, ?, ?, ?, ?, ?, ?, ?)`, room.event_seq, target, except, JSON.stringify(message), time, sender, connection, requestId, requestHash);
    this.saveRoom(room);
  }

  presence(room, time, except) {
    const snapshot = this.roster(room, time, except);
    room.roster_version = String(BigInt(room.roster_version) + 1n);
    room.roster_check_at = snapshot.checkAt;
    this.append(room, { type: 'participants', participants: snapshot.participants, rosterVersion: room.roster_version }, time);
  }

  clearUnavailableFeature(room, time) {
    if (!room.workshop?.featuredParticipantId) return;
    const active = first(this.sql.exec(`SELECT id FROM members WHERE id = ? AND connection_id IS NOT NULL AND lease_until > ? AND expires_at > ?`, room.workshop.featuredParticipantId, time, time));
    if (active) return;
    room.workshop = { ...room.workshop, featuredParticipantId: null };
    this.append(room, { type: 'workshop', workshop: workshopSnapshot(room.workshop) }, time);
  }

  prune(room, time) {
    const removed = first(this.sql.exec('SELECT CAST(MAX(seq) AS TEXT) AS floor FROM events WHERE created_at < ?', time - EVENT_TTL_MS));
    if (removed?.floor !== null && removed?.floor !== undefined) {
      this.sql.exec('DELETE FROM events WHERE created_at < ?', time - EVENT_TTL_MS);
      if (BigInt(removed.floor) > BigInt(room.event_floor)) room.event_floor = removed.floor;
    }
    const expired = this.sql.exec('SELECT data FROM members WHERE connection_id IS NOT NULL AND (lease_until <= ? OR expires_at <= ?)', time, time).toArray();
    for (const stored of expired) { const member = JSON.parse(stored.data); member.connection_id = null; this.saveMember(member); }
    if (expired.length) this.presence(room, time);
    this.clearUnavailableFeature(room, time);
    room.roster_check_at = this.roster(room, time).checkAt;
    this.saveRoom(room);
  }

  addMember(room, displayName, isAdmin, time) {
    const token = randomId(32);
    const { count } = first(this.sql.exec('SELECT COUNT(*) AS count FROM members'));
    const member = { id: randomId(10), token_hash: hash(token), name: displayName, color: COLORS[count % COLORS.length],
      is_admin: isAdmin, expires_at: time + SESSION_TTL_MS, lease_until: time + RESERVATION_MS, joined_at: time,
      connection_id: null, rate_start: time, rate_count: 0, rate_bytes: 0, checklist: null };
    this.saveMember(member);
    return { room: publicRoom(room), token, participantId: member.id, isAdmin, ...guidedState(room) };
  }

  async fetch(request) {
    // Password derivation and streamed request parsing yield. Hold the room gate
    // across them, then atomically commit SQLite changes before releasing it.
    return this.state.blockConcurrencyWhile(async () => {
      try {
        const url = new URL(request.url);
        if (!['GET', 'POST'].includes(request.method)) throw error(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
        if (request.method === 'POST') verifyOrigin(request);
        const route = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,100})(?:\/(join|session|connect|events|messages|leave))?$/);
        if (url.pathname !== '/api/rooms' && url.pathname !== '/api/ice' && !route) throw error(404, 'NOT_FOUND', 'Endpoint not found.');
        if (route) {
          const action = route[2];
          const expected = ['join', 'connect', 'messages', 'leave'].includes(action) ? 'POST' : 'GET';
          if (request.method !== expected) throw error(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
          if (action === 'events') {
            const after = url.searchParams.get('after') ?? '0';
            if (!/^\d{1,19}$/.test(after) || BigInt(after) > 9223372036854775807n) throw error(400, 'INVALID_CURSOR', 'Invalid event cursor.');
          }
        } else if ((url.pathname === '/api/rooms' && request.method !== 'POST') || (url.pathname === '/api/ice' && request.method !== 'GET')) {
          throw error(404, 'NOT_FOUND', 'Endpoint not found.');
        }
        const prepared = {};
        if (request.method === 'POST') prepared.input = await body(request, url.pathname === '/api/rooms' ? 64 * 1024 : MAX_BODY);
        if (url.pathname === '/api/rooms' && request.method === 'POST') {
          prepared.input = normalizeRoomCreation(prepared.input);
          prepared.salt = randomBytes(16).toString('hex');
          prepared.passwordHash = (await scrypt(prepared.input.password, prepared.salt, 64)).toString('hex');
        } else if (url.pathname.endsWith('/join') && request.method === 'POST') {
          prepared.input = normalizeJoin(prepared.input);
          const id = url.pathname.split('/')[3];
          const room = this.readRoom(id);
          prepared.passwordHash = await scrypt(prepared.input.password, room.password_salt, 64);
        }
        const response = this.state.storage.transactionSync(() => this.handle(request, url, prepared));
        await this.scheduleAlarm();
        await this.state.storage.sync();
        return response;
      } catch (failure) {
        // A rejected content type/origin can leave the forwarded request stream
        // unread. Cancel it before returning across the Durable Object boundary.
        if (request.body && !request.bodyUsed) await request.body.cancel().catch(() => {});
        return failureResponse(failure);
      }
    });
  }

  handle(request, url, prepared) {
    const time = this.now();
    const method = request.method;
    if (url.pathname === '/api/rooms' && method === 'POST') {
      const id = request.headers.get('x-common-room-id');
      if (!id || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw error(400, 'INVALID_ROOM_ID', 'Invalid room admission.');
      if (first(this.sql.exec('SELECT singleton FROM room'))) throw error(409, 'ROOM_EXISTS', 'This session already exists.');
      const input = prepared.input;
      const admissionExpiry = Number(request.headers.get('x-common-room-expires-at'));
      const expiresAt = Number.isSafeInteger(admissionExpiry) && admissionExpiry > time && admissionExpiry <= time + ROOM_TTL_MS
        ? admissionExpiry : time + ROOM_TTL_MS;
      const room = { id, name: input.name, password_hash: prepared.passwordHash, password_salt: prepared.salt,
        created_at: time, expires_at: expiresAt, ended_at: null, event_seq: '0', event_floor: '0',
        roster_version: '0', roster_check_at: expiresAt, chat: [], appearance: input.appearance,
        workshop: input.workshop ?? null, experience: input.experience ?? null };
      this.saveRoom(room);
      return json(this.addMember(room, input.displayName, true, time), 201);
    }

    if (url.pathname === '/api/ice' && method === 'GET') return this.ice(request, url);
    const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,100})(?:\/(join|session|connect|events|messages|leave))?$/);
    if (!match) throw error(404, 'NOT_FOUND', 'Endpoint not found.');
    const [, id, action] = match;
    const room = this.readRoom(id, action === 'events');

    if (action === 'join' && method === 'POST') {
      if (!timingSafeEqual(Buffer.from(room.password_hash, 'hex'), prepared.passwordHash)) throw error(401, 'WRONG_PASSWORD', 'That password does not match.');
      this.prune(room, time);
      return json(this.addMember(room, prepared.input.displayName, false, time));
    }
    if (method === 'GET' && !action) return json({ room: publicRoom(room) });
    const member = this.member(request, room);
    if (method === 'GET' && action === 'session') return json({ room: publicRoom(room), participantId: member.id, isAdmin: member.is_admin, displayName: member.name, ...guidedState(room) });
    if (method === 'POST' && action === 'connect') {
      this.prune(room, time);
      // A replacement connection emits a temporary roster without the old peer,
      // so existing clients discard the old WebRTC connection before recreating it.
      if (member.connection_id) this.presence(room, time, member.id);
      member.connection_id = randomId(18);
      member.lease_until = Math.max(member.lease_until, time + LEASE_MS);
      member.expires_at = Math.max(member.expires_at, time + SESSION_TTL_MS);
      member.rate_start = time; member.rate_count = 0; member.rate_bytes = 0;
      this.saveMember(member);
      this.presence(room, time);
      return json({ init: { type: 'init', capabilities: protocolCapabilities('poll'), room: publicRoom(room), self: publicMember(member, room),
        ...guidedState(room), participants: this.roster(room, time).participants, entities: [], chat: room.chat },
      cursor: room.event_seq, connectionId: member.connection_id, rosterVersion: room.roster_version,
      capabilities: { ...protocolCapabilities('poll'), targetedEvents: true, signalIdempotency: true } });
    }
    if (method === 'GET' && action === 'events') return json(this.events(request, url, room, member, time));
    if (method === 'POST' && (action === 'messages' || action === 'leave')) {
      const input = action === 'leave' ? prepared.input : normalizeEnvelope(prepared.input, { maxBytes: MAX_BODY });
      this.checkConnection(member, request, this.now());
      if (action === 'leave' || input.type === 'leave') {
        this.sql.exec('DELETE FROM members WHERE id = ?', member.id);
        this.presence(room, time);
        this.clearUnavailableFeature(room, time);
        return json({ ok: true });
      }
      return json(this.message(request, room, member, input, time));
    }
    throw error(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  }

  events(request, url, room, member, time) {
    const after = url.searchParams.get('after') ?? '0';
    if (!/^\d{1,19}$/.test(after) || BigInt(after) > 9223372036854775807n) throw error(400, 'INVALID_CURSOR', 'Invalid event cursor.');
    this.checkConnection(member, request, this.now());
    if (room.ended_at) return { events: [{ sequence: room.event_seq, message: { type: 'ended' } }], cursor: room.event_seq, participants: [] };
    if (BigInt(after) < BigInt(room.event_floor) || BigInt(after) > BigInt(room.event_seq)) throw resync();
    if (member.lease_until - time < LEASE_MS - LEASE_REFRESH_MS) {
      this.checkConnection(member, request, this.now());
      member.lease_until = Math.max(member.lease_until, this.now() + LEASE_MS);
      this.saveMember(member);
    }
    if (!room.roster_check_at || room.roster_check_at <= this.now()) this.prune(room, this.now());
    const bounds = first(this.sql.exec(`SELECT CAST(MIN(seq) AS TEXT) AS first_seq,
      COALESCE(MAX(CASE WHEN created_at < ? THEN 1 ELSE 0 END), 0) AS expired FROM events WHERE seq > CAST(? AS INTEGER)`, time - EVENT_TTL_MS, after));
    if (BigInt(after) < BigInt(room.event_floor) || BigInt(after) > BigInt(room.event_seq) || bounds.expired ||
      (BigInt(after) < BigInt(room.event_seq) && (bounds.first_seq === null || BigInt(bounds.first_seq) !== BigInt(after) + 1n))) throw resync();
    const candidates = this.sql.exec(`SELECT CAST(seq AS TEXT) AS sequence, payload FROM events WHERE seq > CAST(? AS INTEGER)
      AND (target_id IS NULL OR target_id = ?) AND (except_id IS NULL OR except_id != ?) ORDER BY seq LIMIT ?`,
    after, member.id, member.id, EVENT_BATCH_SIZE + 1).toArray();
    const events = [];
    let bytes = 0;
    for (const event of candidates) {
      const size = Buffer.byteLength(event.payload);
      if (events.length >= EVENT_BATCH_SIZE || (events.length && bytes + size > EVENT_BATCH_BYTES)) break;
      events.push({ sequence: event.sequence, message: JSON.parse(event.payload) }); bytes += size;
    }
    const hasMore = events.length < candidates.length;
    const cursor = hasMore ? events.at(-1).sequence : room.event_seq;
    const historicalRoster = events.some(event => ['participants', 'checklist'].includes(event.message.type) && String(event.message.rosterVersion) !== room.roster_version);
    const unchanged = url.searchParams.get('rosterVersion') === room.roster_version && !historicalRoster;
    return { events, cursor, hasMore, rosterVersion: room.roster_version, appearance: appearanceSnapshot(room.appearance),
      ...(!unchanged ? { participants: this.roster(room, this.now()).participants } : {}) };
  }

  message(request, room, member, input, time) {
    const bytes = Buffer.byteLength(JSON.stringify(input));
    const reset = time - member.rate_start >= 1000;
    const count = reset ? 1 : member.rate_count + 1;
    const total = reset ? bytes : member.rate_bytes + bytes;
    if (count > 200 || total > 1024 * 1024) throw error(429, 'RATE_LIMITED', 'Slow down and try again.');
    this.checkConnection(member, request, this.now());
    member.rate_start = reset ? time : member.rate_start;
    member.rate_count = count; member.rate_bytes = total;
    member.lease_until = Math.max(member.lease_until, this.now() + LEASE_MS);
    this.saveMember(member);
    if (input.type === 'signal') {
      normalizeSignal(input, { senderId: member.id });
      let requestHash = null;
      if (input.requestId !== undefined) {
        if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw error(400, 'INVALID_REQUEST_ID', 'Invalid signal request ID.');
        requestHash = hash(JSON.stringify({ to: input.to, data: input.data }));
        const previous = first(this.sql.exec('SELECT request_hash FROM events WHERE sender_id = ? AND connection_id = ? AND request_id = ?', member.id, member.connection_id, input.requestId));
        if (previous) {
          if (previous.request_hash !== requestHash) throw error(409, 'REQUEST_ID_REUSED', 'Signal request ID was already used for different content.');
          return { ok: true, duplicate: true };
        }
      }
      const target = first(this.sql.exec('SELECT id FROM members WHERE id = ? AND connection_id IS NOT NULL AND lease_until > ? AND expires_at > ?', input.to, time, time));
      if (!target) throw error(400, 'INVALID_SIGNAL', 'Signal recipient is unavailable.');
      this.append(room, { type: 'signal', from: member.id, data: input.data }, time, { target: input.to,
        sender: member.id, connection: member.connection_id, requestId: input.requestId ?? null, requestHash });
    } else if (input.type === 'appearance') {
      if (!member.is_admin) throw error(403, 'FORBIDDEN', 'Only the host can change the room style.');
      if (!Object.hasOwn(input, 'appearance')) throw error(400, 'INVALID_ROOM_APPEARANCE', 'Include the room style to apply.');
      room.appearance = normalizeAppearance(input.appearance);
      this.append(room, { type: 'appearance', appearance: appearanceSnapshot(room.appearance) }, this.now());
    } else if (input.type === 'workshop') {
      const observedAt = this.now();
      const people = this.sql.exec('SELECT data FROM members ORDER BY id').toArray().map(row => JSON.parse(row.data)).map(person => ({ id: person.id, checklist: person.checklist,
        active: Boolean(person.connection_id) && person.lease_until > observedAt && person.expires_at > observedAt }));
      const changes = workshopUpdate(room.workshop, people, { id: member.id, isAdmin: member.is_admin }, input);
      if (changes.workshop) { room.workshop = changes.workshop; this.append(room, { type: 'workshop', workshop: workshopSnapshot(room.workshop) }, observedAt); }
      if (changes.members.length) {
        room.roster_version = String(BigInt(room.roster_version) + 1n);
        for (const change of changes.members) {
          const changed = JSON.parse(first(this.sql.exec('SELECT data FROM members WHERE id = ?', change.id)).data);
          changed.checklist = change.checklist; this.saveMember(changed);
          this.append(room, { type: 'checklist', id: change.id, checklist: change.checklist, rosterVersion: room.roster_version }, observedAt);
        }
      }
    } else if (input.type === 'cursor') {
      normalizeCursor(input);
      this.append(room, { type: 'cursor', participantId: member.id, x: input.x, y: input.y }, time, { except: member.id });
    } else if (input.type === 'chat') {
      const text = normalizeChat(input.text);
      const entry = { id: randomId(10), participantId: member.id, name: member.name, text, createdAt: time };
      room.chat = [...room.chat, entry].slice(-100);
      this.append(room, { type: 'chat', message: entry }, time);
    } else if (input.type === 'end') {
      if (!member.is_admin) throw error(403, 'FORBIDDEN', 'Only the host can end this session.');
      this.append(room, { type: 'ended' }, time);
      room.ended_at = time; room.chat = [];
      this.sql.exec('DELETE FROM events WHERE seq < CAST(? AS INTEGER)', room.event_seq);
      this.saveRoom(room);
    } else if (input.type === 'upsert' || input.type === 'delete') throw error(409, 'PEER_CANVAS', 'Canvas changes belong on the peer data channel.');
    else if (input.type === 'ping') this.append(room, { type: 'pong' }, time, { target: member.id });
    else throw error(400, 'INVALID_MESSAGE', 'Unknown message type.');
    return { ok: true };
  }

  ice(request, url) {
    const iceServers = stunServersFromEnv(this.env);
    const urls = this.env('TURN_URLS'), secret = this.env('TURN_SECRET');
    let username = this.env('TURN_USERNAME'), credential = this.env('TURN_CREDENTIAL'), expiresAt;
    if (urls && (secret || (username && credential)) && url.searchParams.has('room')) {
      const room = this.readRoom(url.searchParams.get('room'));
      const member = this.member(request, room);
      if (secret) {
        const configuredTtl = Number(this.env('TURN_TTL_SECONDS'));
        const ttl = Number.isFinite(configuredTtl) && configuredTtl > 0 ? Math.min(86400, Math.max(60, Math.floor(configuredTtl))) : 3600;
        const seconds = Math.floor(this.now() / 1000) + ttl;
        username = `${seconds}:${member.id}`;
        credential = createHmac('sha1', secret).update(username).digest('base64');
        expiresAt = seconds * 1000;
      }
      iceServers.push({ urls: urls.split(',').map(value => value.trim()).filter(Boolean), username, credential });
    }
    return json({ iceServers, iceTransportPolicy: iceTransportPolicyFromEnv(this.env), ...(expiresAt ? { expiresAt } : {}) });
  }

  async scheduleAlarm() {
    const stored = first(this.sql.exec('SELECT data FROM room WHERE singleton = 1'));
    if (!stored) return;
    const room = JSON.parse(stored.data);
    const event = first(this.sql.exec('SELECT MIN(created_at) AS earliest FROM events'));
    // The roster deadline is a conservative cached minimum. Lease renewal only
    // extends it, so this avoids scanning every member on every ordinary poll.
    const next = Math.max(this.now() + 1, Math.min(room.expires_at, event.earliest === null ? Infinity : event.earliest + EVENT_TTL_MS + 1,
      room.roster_check_at ?? room.expires_at));
    const scheduled = await this.state.storage.getAlarm();
    if (scheduled === null || scheduled !== next) await this.state.storage.setAlarm(next);
  }

  async alarm() {
    return this.state.blockConcurrencyWhile(async () => {
      const stored = first(this.sql.exec('SELECT data FROM room WHERE singleton = 1'));
      if (!stored) return;
      const room = JSON.parse(stored.data);
      if (room.expires_at <= this.now()) {
        // Keep the schema valid in this still-live object instance. A later
        // request for the expired invite must return ROOM_NOT_FOUND reliably.
        this.state.storage.transactionSync(() => {
          this.sql.exec('DELETE FROM events');
          this.sql.exec('DELETE FROM members');
          this.sql.exec('DELETE FROM room');
        });
        await this.state.storage.deleteAlarm();
        return;
      }
      this.state.storage.transactionSync(() => this.prune(room, this.now()));
      await this.scheduleAlarm();
    });
  }
}

/** A single named object fences global admission across every Worker isolate.
 * Internal fetch endpoints are reachable only through the Worker binding.
 */
export class CommonAdmission {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms(expires_at);
        CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS limits_expiry ON limits(expires_at);`);
    });
  }

  now() { return Date.now(); }

  limit(ip, kind, maximum, time) {
    const key = hash(`${String(ip ?? 'unknown').slice(0, 256)}:${kind}`);
    const old = first(this.sql.exec('SELECT window_start, attempts FROM limits WHERE key = ?', key));
    const reset = !old || old.window_start <= time - 60000;
    const attempts = reset ? 1 : old.attempts + 1;
    this.sql.exec(`INSERT INTO limits(key, window_start, attempts, expires_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, attempts = excluded.attempts, expires_at = excluded.expires_at`,
    key, reset ? time : old.window_start, attempts, time + 120000);
    // Return a failure instead of throwing: attempt counters must survive denied
    // requests rather than rolling back with the room reservation transaction.
    return attempts <= maximum;
  }

  async fetch(request) {
    return this.state.blockConcurrencyWhile(async () => {
      try {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/health') { this.sql.exec('SELECT 1'); return json({ ok: true }); }
        if (request.method !== 'POST') throw error(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
        const input = await body(request, 4096);
        const time = this.now();
        const result = this.state.storage.transactionSync(() => {
          this.sql.exec('DELETE FROM rooms WHERE expires_at <= ?', time);
          this.sql.exec('DELETE FROM limits WHERE expires_at <= ?', time);
          if (url.pathname === '/release') { this.sql.exec('DELETE FROM rooms WHERE id = ?', String(input.id ?? '')); return json({ ok: true }); }
          if (url.pathname === '/limit' && input.kind === 'join') {
            if (!this.limit(input.ip, 'join', 30, time)) return json({ error: 'Too many attempts. Try again in a minute.', code: 'RATE_LIMITED' }, 429);
            return json({ ok: true });
          }
          if (url.pathname !== '/reserve') throw error(404, 'NOT_FOUND', 'Endpoint not found.');
          if (!this.limit(input.ip, 'create', 15, time)) return json({ error: 'Too many attempts. Try again in a minute.', code: 'RATE_LIMITED' }, 429);
          const { count } = first(this.sql.exec('SELECT COUNT(*) AS count FROM rooms'));
          if (count >= 1000) return json({ error: 'This service has reached its session capacity.', code: 'CAPACITY' }, 503);
          const id = randomId(), expiresAt = time + ROOM_TTL_MS;
          this.sql.exec('INSERT INTO rooms(id, expires_at) VALUES(?, ?)', id, expiresAt);
          return json({ id, expiresAt }, 201);
        });
        await this.scheduleAlarm();
        await this.state.storage.sync();
        return result;
      } catch (failure) {
        if (request.body && !request.bodyUsed) await request.body.cancel().catch(() => {});
        return failureResponse(failure);
      }
    });
  }

  async scheduleAlarm() {
    const room = first(this.sql.exec('SELECT MIN(expires_at) AS earliest FROM rooms'));
    const limit = first(this.sql.exec('SELECT MIN(expires_at) AS earliest FROM limits'));
    const next = Math.min(room.earliest ?? Infinity, limit.earliest ?? Infinity);
    if (Number.isFinite(next)) await this.state.storage.setAlarm(Math.max(next, this.now() + 1));
    else await this.state.storage.deleteAlarm();
  }

  async alarm() {
    return this.state.blockConcurrencyWhile(async () => {
      const time = this.now();
      this.state.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM rooms WHERE expires_at <= ?', time);
        this.sql.exec('DELETE FROM limits WHERE expires_at <= ?', time);
      });
      await this.scheduleAlarm();
    });
  }
}
