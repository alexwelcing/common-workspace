import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const COLORS = ['#7867ef', '#e3a444', '#4aa3b9', '#df7b9d', '#75b790', '#d27b58', '#8b9ed5', '#ba91ce', '#9baf5f', '#68b3aa'];
const MAX_PARTICIPANTS = 10;
const MAX_BODY = 128 * 1024;
const randomId = (length = 12) => randomBytes(length).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 60 ? value.trim() : null;
const timestamp = value => new Date(value).getTime();
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const roomMissing = () => error(404, 'ROOM_NOT_FOUND', 'This session has ended or the link is invalid.');
const sessionExpired = () => error(401, 'SESSION_EXPIRED', 'Please enter the room password again.');
const resync = () => error(409, 'RESYNC_REQUIRED', 'Reconnect to refresh the session.');
const full = () => error(409, 'ROOM_FULL', 'This session already has ten people.');
const publicRoom = room => ({ id: room.id, name: room.name, createdAt: timestamp(room.created_at), collaboration: 'peer', transport: 'poll' });
const publicMember = member => ({ id: member.id, name: member.name, color: member.color, isAdmin: member.is_admin });
const defaultEnv = key => globalThis.Netlify?.env?.get(key) ?? process.env[key];

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'display-capture=(self), camera=(), microphone=()',
    ...headers,
  } });
}

// Public responses with no member data may be served from Netlify's CDN, which
// is purged on every deploy. Browsers still revalidate each time.
const edgeCached = seconds => ({
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
});

async function body(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw error(415, 'JSON_REQUIRED', 'Send JSON content.');
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw error(413, 'TOO_LARGE', 'Request is too large.');
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BODY) { await reader.cancel(); throw error(413, 'TOO_LARGE', 'Request is too large.'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(result)) throw new Error();
    return result;
  } catch { throw error(400, 'INVALID_JSON', 'Request must be a JSON object.'); }
}

function verifyOrigin(request) {
  const origin = request.headers.get('origin');
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw error(403, 'INVALID_ORIGIN', 'This request must come from the app.');
  if (origin && origin !== new URL(request.url).origin) throw error(403, 'INVALID_ORIGIN', 'This request must come from the app.');
}

/**
 * Room writes lock the room row before touching seats or event order. Polling
 * only reads, so it skips the lock; cleanup runs in sweep() on a schedule.
 */
export function createApiHandler({ pool, env = defaultEnv, now = Date.now, leaseMs = 120000, leaseRefreshMs = 30000, reservationMs = 60000, eventTtlMs = 600000, roomTtlMs = 86400000, sessionTtlMs = 86400000, rateLimits = true } = {}) {
  if (!pool?.connect) throw new TypeError('A PostgreSQL pool is required.');
  if (leaseMs < 90000) throw new TypeError('Presence leases must be at least 90 seconds.');
  if (leaseRefreshMs < 0 || leaseRefreshMs > leaseMs / 2) throw new TypeError('Lease refreshes must happen within the first half of a lease.');

  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (failure) {
      await client.query('ROLLBACK').catch(() => {});
      throw failure;
    } finally { client.release(); }
  }

  async function connection(work) {
    const client = await pool.connect();
    try { return await work(client); } finally { client.release(); }
  }

  async function limit(context, kind, maximum, time) {
    if (!rateLimits) return;
    const key = hash(`${context.ip ?? 'unknown'}:${kind}`);
    const result = await pool.query(`
      INSERT INTO common_auth_limits (key, window_start, attempts, expires_at)
      VALUES ($1, $2, 1, $3)
      ON CONFLICT (key) DO UPDATE SET
        attempts = CASE WHEN common_auth_limits.window_start <= $4 THEN 1 ELSE common_auth_limits.attempts + 1 END,
        window_start = CASE WHEN common_auth_limits.window_start <= $4 THEN $2 ELSE common_auth_limits.window_start END,
        expires_at = $3
      RETURNING attempts`, [key, new Date(time), new Date(time + 120000), new Date(time - 60000)]);
    if (result.rows[0].attempts > maximum) throw error(429, 'RATE_LIMITED', 'Too many attempts. Try again in a minute.');
  }

  async function roomRow(client, id, time, allowEnded = false, lock = true) {
    const { rows } = await client.query(`SELECT * FROM common_rooms WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    const room = rows[0];
    if (!room || timestamp(room.expires_at) <= time || (!allowEnded && room.ended_at)) throw roomMissing();
    return room;
  }

  async function memberRow(client, room, request, time) {
    const authorization = request.headers.get('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token || token.length > 128) throw sessionExpired();
    const { rows } = await client.query('SELECT * FROM common_members WHERE room_id = $1 AND token_hash = $2', [room.id, hash(token)]);
    const member = rows[0];
    if (!member || timestamp(member.expires_at) <= time) throw sessionExpired();
    return member;
  }

  function checkConnection(member, request, time) {
    const connection = request.headers.get('x-common-connection');
    if (!connection || connection !== member.connection_id) throw error(409, 'CONNECTION_REPLACED', 'This session is connected in another tab.');
    if (timestamp(member.lease_until) <= time) throw error(409, 'RESYNC_REQUIRED', 'Reconnect to refresh your place in the session.');
  }

  async function active(client, room, time, except) {
    const { rows } = await client.query(`SELECT * FROM common_members
      WHERE room_id = $1 AND expires_at > $2 AND lease_until > $2 AND connection_id IS NOT NULL
      ORDER BY joined_at, id`, [room.id, new Date(time)]);
    return rows.filter(member => member.id !== except).map(publicMember);
  }

  async function append(client, room, message, time, { target = null, except = null } = {}) {
    // BIGINT stays a decimal string on the wire; no precision loss in JS clients.
    const { rows } = await client.query('UPDATE common_rooms SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq', [room.id]);
    room.event_seq = String(rows[0].event_seq);
    await client.query(`INSERT INTO common_events (room_id, seq, target_id, except_id, payload, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [room.id, room.event_seq, target, except, JSON.stringify(message), new Date(time)]);
  }

  async function presence(client, room, time, except) {
    await append(client, room, { type: 'participants', participants: await active(client, room, time, except) }, time);
  }

  async function prune(client, room, time) {
    const { rows } = await client.query(`WITH removed AS (
      DELETE FROM common_events WHERE room_id = $1 AND created_at < $2 RETURNING seq
    ) SELECT MAX(seq) AS floor FROM removed`, [room.id, new Date(time - eventTtlMs)]);
    if (rows[0]?.floor !== null && rows[0]?.floor !== undefined) {
      room.event_floor = String(rows[0].floor);
      await client.query('UPDATE common_rooms SET event_floor = GREATEST(event_floor, $2) WHERE id = $1', [room.id, room.event_floor]);
    }
    const expired = await client.query(`UPDATE common_members SET connection_id = NULL
      WHERE room_id = $1 AND connection_id IS NOT NULL AND (lease_until <= $2 OR expires_at <= $2)
      RETURNING id`, [room.id, new Date(time)]);
    if (expired.rowCount) await presence(client, room, time);
  }

  async function seatCount(client, room, time) {
    const { rows } = await client.query('SELECT COUNT(*)::integer AS count FROM common_members WHERE room_id = $1 AND expires_at > $2 AND lease_until > $2', [room.id, new Date(time)]);
    return rows[0].count;
  }

  async function addMember(client, room, displayName, isAdmin, time) {
    const token = randomId(32);
    const { rows } = await client.query('SELECT COUNT(*)::integer AS count FROM common_members WHERE room_id = $1', [room.id]);
    const member = { id: randomId(10), name: displayName, color: COLORS[rows[0].count % COLORS.length], is_admin: isAdmin };
    await client.query(`INSERT INTO common_members
      (id, room_id, token_hash, name, color, is_admin, expires_at, lease_until, joined_at, rate_start)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [member.id, room.id, hash(token), member.name, member.color, isAdmin, new Date(time + sessionTtlMs), new Date(time + reservationMs), new Date(time)]);
    return { room: publicRoom(room), token, participantId: member.id, isAdmin };
  }

  async function handle(request, context) {
    const time = now();
    const url = new URL(request.url);
    const method = request.method;
    if (method === 'POST') verifyOrigin(request);
    if (!['GET', 'POST'].includes(method)) throw error(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');

    if (url.pathname === '/api/health' && method === 'GET') {
      await pool.query('SELECT 1');
      return json({ ok: true, transport: 'poll', collaboration: 'peer' }, 200, edgeCached(15));
    }

    if (url.pathname === '/api/ice' && method === 'GET') {
      const iceServers = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
      const urls = env('TURN_URLS');
      const secret = env('TURN_SECRET');
      let username = env('TURN_USERNAME');
      let credential = env('TURN_CREDENTIAL');
      let expiresAt;
      if (urls && (secret || (username && credential)) && url.searchParams.has('room')) {
        const member = await transaction(async client => {
          const room = await roomRow(client, url.searchParams.get('room'), time);
          return memberRow(client, room, request, time);
        });
        if (secret) {
          const configuredTtl = Number(env('TURN_TTL_SECONDS'));
          const ttl = Number.isFinite(configuredTtl) && configuredTtl > 0 ? Math.min(86400, Math.max(60, Math.floor(configuredTtl))) : 3600;
          const seconds = Math.floor(time / 1000) + ttl;
          username = `${seconds}:${member.id}`;
          credential = createHmac('sha1', secret).update(username).digest('base64');
          expiresAt = seconds * 1000;
        }
        iceServers.push({ urls: urls.split(',').map(value => value.trim()).filter(Boolean), username, credential });
      }
      // Only the STUN-only answer for requests without a room is shareable.
      const shared = !url.searchParams.has('room') && { ...edgeCached(3600), 'Netlify-Vary': 'query=room' };
      return json({ iceServers, ...(expiresAt ? { expiresAt } : {}) }, 200, shared || {});
    }

    if (url.pathname === '/api/rooms' && method === 'POST') {
      await limit(context, 'create', 15, time);
      const input = await body(request);
      const roomName = name(input.name);
      const displayName = name(input.displayName);
      if (!roomName || !displayName) throw error(400, 'INVALID_NAME', 'Session and display names must be 1–60 characters.');
      if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) throw error(400, 'INVALID_PASSWORD', 'Use a password with 8–128 characters.');
      if (input.collaboration !== undefined && input.collaboration !== 'peer') throw error(400, 'INVALID_COLLABORATION', 'Hosted sessions use browser-to-browser collaboration.');
      const salt = randomBytes(16).toString('hex');
      const passwordHash = (await scrypt(input.password, salt, 64)).toString('hex');
      const result = await transaction(async client => {
        // Serialize creation only, both for bounded storage and opportunistic cleanup.
        await client.query('SELECT pg_advisory_xact_lock(74629001)');
        await client.query('DELETE FROM common_rooms WHERE expires_at <= $1', [new Date(time)]);
        if (rateLimits) await client.query('DELETE FROM common_auth_limits WHERE expires_at <= $1', [new Date(time)]);
        const count = await client.query('SELECT COUNT(*)::integer AS count FROM common_rooms');
        if (count.rows[0].count >= 1000) throw error(503, 'CAPACITY', 'This service has reached its session capacity.');
        const room = { id: randomId(), name: roomName, created_at: new Date(time), expires_at: new Date(time + roomTtlMs) };
        await client.query(`INSERT INTO common_rooms (id, name, password_hash, password_salt, created_at, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6)`, [room.id, room.name, passwordHash, salt, room.created_at, room.expires_at]);
        return addMember(client, room, displayName, true, time);
      });
      return json(result, 201);
    }

    const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,100})(?:\/(join|session|connect|events|messages|leave))?$/);
    if (!match) throw error(404, 'NOT_FOUND', 'Endpoint not found.');
    const [, id, action] = match;
    if (action === 'join' && method === 'POST') {
      await limit(context, 'join', 60, time);
      await limit(context, `join:${id}`, 30, time);
      const input = await body(request);
      const displayName = name(input.displayName);
      if (!displayName) throw error(400, 'INVALID_NAME', 'Enter a display name with 1–60 characters.');
      if (typeof input.password !== 'string' || input.password.length > 128) throw error(401, 'WRONG_PASSWORD', 'That password does not match.');
      // Hash before locking, then revalidate the room under its lock.
      const lookup = await pool.query('SELECT password_salt, password_hash FROM common_rooms WHERE id = $1 AND ended_at IS NULL AND expires_at > $2', [id, new Date(time)]);
      if (!lookup.rows[0]) throw roomMissing();
      const expected = Buffer.from(lookup.rows[0].password_hash, 'hex');
      const actual = await scrypt(input.password, lookup.rows[0].password_salt, 64);
      if (!timingSafeEqual(expected, actual)) throw error(401, 'WRONG_PASSWORD', 'That password does not match.');
      return json(await transaction(async client => {
        const room = await roomRow(client, id, time);
        await prune(client, room, time);
        if (await seatCount(client, room, time) >= MAX_PARTICIPANTS) throw full();
        return addMember(client, room, displayName, false, time);
      }));
    }

    if (method === 'GET' && !action) return json(await transaction(async client => ({ room: publicRoom(await roomRow(client, id, time)) })));
    if (method === 'GET' && action === 'session') return json(await transaction(async client => {
      const room = await roomRow(client, id, time);
      const member = await memberRow(client, room, request, time);
      return { room: publicRoom(room), participantId: member.id, isAdmin: member.is_admin, displayName: member.name };
    }));

    if (method === 'POST' && action === 'connect') {
      await body(request);
      return json(await transaction(async client => {
        const room = await roomRow(client, id, time);
        const member = await memberRow(client, room, request, time);
        await prune(client, room, time);
        const reserved = timestamp(member.lease_until) > time;
        if (!reserved && await seatCount(client, room, time) >= MAX_PARTICIPANTS) throw full();
        // Existing peers must discard an older RTC connection for this participant.
        if (member.connection_id) await presence(client, room, time, member.id);
        const connectionId = randomId(18);
        await client.query(`UPDATE common_members SET connection_id = $2, lease_until = $3, expires_at = $4,
          rate_start = $5, rate_count = 0, rate_bytes = 0 WHERE id = $1`,
        [member.id, connectionId, new Date(time + leaseMs), new Date(time + sessionTtlMs), new Date(time)]);
        await presence(client, room, time);
        const people = await active(client, room, time);
        return { init: { type: 'init', room: publicRoom(room), self: publicMember(member), participants: people, entities: [], chat: room.chat }, cursor: String(room.event_seq), connectionId };
      }));
    }

    if (method === 'GET' && action === 'events') {
      const after = url.searchParams.get('after') ?? '0';
      if (!/^\d{1,19}$/.test(after) || BigInt(after) > 9223372036854775807n) throw error(400, 'INVALID_CURSOR', 'Invalid event cursor.');
      return json(await connection(async client => {
        const room = await roomRow(client, id, time, true, false);
        const member = await memberRow(client, room, request, time);
        checkConnection(member, request, time);
        if (room.ended_at) return { events: [{ sequence: String(room.event_seq), message: { type: 'ended' } }], cursor: String(room.event_seq), participants: [] };
        if (BigInt(after) < BigInt(room.event_floor) || BigInt(after) > BigInt(room.event_seq)) throw resync();
        // Most polls skip this write; the lease only needs refreshing every leaseRefreshMs.
        if (timestamp(member.lease_until) - time < leaseMs - leaseRefreshMs) {
          await client.query('UPDATE common_members SET lease_until = $2 WHERE id = $1', [member.id, new Date(time + leaseMs)]);
        }
        // Advance across all rows, including messages intended for another peer.
        const { rows } = await client.query(`SELECT seq, target_id, except_id, payload, created_at < $3 AS expired
          FROM common_events WHERE room_id = $1 AND seq > $2 ORDER BY seq LIMIT 500`, [room.id, after, new Date(time - eventTtlMs)]);
        // Sequences are contiguous until pruned, so a gap or an expired row means
        // this cursor fell behind retained history, even before the sweep runs.
        if (rows.length ? BigInt(rows[0].seq) !== BigInt(after) + 1n || rows.some(event => event.expired) : BigInt(after) < BigInt(room.event_seq)) throw resync();
        const cursor = rows.length ? String(rows[rows.length - 1].seq) : String(room.event_seq);
        const events = rows.filter(event => (!event.target_id || event.target_id === member.id) && event.except_id !== member.id)
          .map(event => ({ sequence: String(event.seq), message: event.payload }));
        return { events, cursor, participants: await active(client, room, time) };
      }));
    }

    if (method === 'POST' && (action === 'messages' || action === 'leave')) {
      const input = await body(request);
      return json(await transaction(async client => {
        const room = await roomRow(client, id, time);
        const member = await memberRow(client, room, request, time);
        checkConnection(member, request, time);
        if (action === 'leave' || input.type === 'leave') {
          await client.query('DELETE FROM common_members WHERE id = $1', [member.id]);
          await presence(client, room, time);
          return { ok: true };
        }
        const bytes = Buffer.byteLength(JSON.stringify(input));
        const reset = time - timestamp(member.rate_start) >= 1000;
        const count = reset ? 1 : member.rate_count + 1;
        const total = reset ? bytes : member.rate_bytes + bytes;
        if (count > 200 || total > 1024 * 1024) throw error(429, 'RATE_LIMITED', 'Slow down and try again.');
        await client.query('UPDATE common_members SET rate_start = $2, rate_count = $3, rate_bytes = $4, lease_until = $5 WHERE id = $1',
          [member.id, reset ? new Date(time) : member.rate_start, count, total, new Date(time + leaseMs)]);
        if (input.type === 'signal') {
          if (typeof input.to !== 'string' || input.to === member.id || !object(input.data)) throw error(400, 'INVALID_SIGNAL', 'Invalid connection signal.');
          const target = await client.query('SELECT id FROM common_members WHERE room_id = $1 AND id = $2 AND connection_id IS NOT NULL AND lease_until > $3 AND expires_at > $3', [room.id, input.to, new Date(time)]);
          if (!target.rows.length) throw error(400, 'INVALID_SIGNAL', 'Signal recipient is unavailable.');
          await append(client, room, { type: 'signal', from: member.id, data: input.data }, time, { target: input.to });
        } else if (input.type === 'cursor') {
          if (![input.x, input.y].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000)) throw error(400, 'INVALID_CURSOR', 'Invalid cursor position.');
          await append(client, room, { type: 'cursor', participantId: member.id, x: input.x, y: input.y }, time, { except: member.id });
        } else if (input.type === 'chat') {
          if (typeof input.text !== 'string' || !input.text.trim() || input.text.trim().length > 2000) throw error(400, 'INVALID_CHAT', 'Messages must be 1–2000 characters.');
          const entry = { id: randomId(10), participantId: member.id, name: member.name, text: input.text.trim(), createdAt: time };
          const chat = [...room.chat, entry].slice(-100);
          await client.query('UPDATE common_rooms SET chat = $2::jsonb WHERE id = $1', [room.id, JSON.stringify(chat)]);
          await append(client, room, { type: 'chat', message: entry }, time);
        } else if (input.type === 'end') {
          if (!member.is_admin) throw error(403, 'FORBIDDEN', 'Only the host can end this session.');
          await append(client, room, { type: 'ended' }, time);
          await client.query("UPDATE common_rooms SET ended_at = $2, chat = '[]'::jsonb WHERE id = $1", [room.id, new Date(time)]);
          await client.query('DELETE FROM common_events WHERE room_id = $1 AND seq < $2', [room.id, room.event_seq]);
        } else if (input.type === 'upsert' || input.type === 'delete') {
          throw error(409, 'PEER_CANVAS', 'Canvas changes belong on the peer data channel.');
        } else if (input.type === 'ping') {
          await append(client, room, { type: 'pong' }, time, { target: member.id });
        } else throw error(400, 'INVALID_MESSAGE', 'Unknown message type.');
        return { ok: true };
      }));
    }
    throw error(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  }

  /** Expire rooms, rate-limit rows, old events and stale leases outside the request path. */
  async function sweep() {
    const time = now();
    await pool.query('DELETE FROM common_rooms WHERE expires_at <= $1', [new Date(time)]);
    if (rateLimits) await pool.query('DELETE FROM common_auth_limits WHERE expires_at <= $1', [new Date(time)]);
    const { rows } = await pool.query(`SELECT room_id FROM common_events WHERE created_at < $1
      UNION SELECT room_id FROM common_members WHERE connection_id IS NOT NULL AND (lease_until <= $2 OR expires_at <= $2)`,
    [new Date(time - eventTtlMs), new Date(time)]);
    let pruned = 0;
    for (const { room_id: id } of rows) {
      try {
        await transaction(async client => {
          const { rows: [room] } = await client.query('SELECT * FROM common_rooms WHERE id = $1 FOR UPDATE', [id]);
          if (room) { await prune(client, room, time); pruned++; }
        });
      } catch (failure) { console.error('Common sweep failure:', failure.code ?? failure.name ?? 'unknown'); }
    }
    return { pruned };
  }

  async function apiHandler(request, context = {}) {
    try { return await handle(request, context); }
    catch (failure) {
      if (!failure.status) console.error('Common API failure:', failure.code ?? failure.name ?? 'unknown');
      return json({ error: failure.status ? failure.message : 'Session storage is unavailable. Please try again.', code: failure.status ? failure.code : 'SERVICE_UNAVAILABLE' }, failure.status ?? 503);
    }
  }
  return Object.assign(apiHandler, { sweep });
}
