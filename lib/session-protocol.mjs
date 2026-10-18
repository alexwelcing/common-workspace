import { normalizeWorkshop } from './session-workshop.mjs';
/** Portable room protocol: validation and policy, with no storage/runtime imports. */
export const PROTOCOL_VERSION = 1;
export const SIGNAL_MAX_BYTES = 128 * 1024;
export const SESSION_POLICY = Object.freeze({
  sessionTtlMs: 24 * 60 * 60 * 1000,
  standaloneRoomTtlMs: 7 * 24 * 60 * 60 * 1000,
  hostedRoomTtlMs: 24 * 60 * 60 * 1000,
  maxChatMessages: 100,
});
const encoder = new TextEncoder();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class ProtocolError extends Error {
  constructor(status, code, message) { super(message); this.name = 'ProtocolError'; this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ProtocolError(status, code, message); };

export function validateName(value, { message = 'Enter a name with 1–60 characters.' } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60) fail(400, 'INVALID_NAME', message);
  return value.trim();
}

export function normalizeRoomCreation(input, { defaultCollaboration = 'peer', allowedCollaborations = ['peer'] } = {}) {
  if (!object(input)) fail(400, 'INVALID_JSON', 'Request must be a JSON object.');
  const options = { message: 'Session and display names must be 1–60 characters.' };
  const name = validateName(input.name, options), displayName = validateName(input.displayName, options);
  if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) fail(400, 'INVALID_PASSWORD', 'Use a password with 8–128 characters.');
  const collaboration = input.collaboration === undefined ? defaultCollaboration : input.collaboration;
  if (!allowedCollaborations.includes(collaboration)) fail(400, 'INVALID_COLLABORATION', 'Choose a supported collaboration mode.');
  // Ignore unrecognized admission fields; callers always assign identity/roles.
  const workshop = normalizeWorkshop(input.workshop);
  return { name, displayName, password: input.password, collaboration, ...(workshop ? { workshop } : {}) };
}

export function normalizeJoin(input) {
  if (!object(input)) fail(400, 'INVALID_JSON', 'Request must be a JSON object.');
  const displayName = validateName(input.displayName, { message: 'Enter a display name with 1–60 characters.' });
  // Do not expose password policy details through the admission error.
  if (typeof input.password !== 'string' || input.password.length > 128) fail(401, 'WRONG_PASSWORD', 'That password does not match.');
  return { displayName, password: input.password };
}

function messageBytes(input, suppliedBytes, code) {
  if (suppliedBytes !== undefined && (!Number.isSafeInteger(suppliedBytes) || suppliedBytes < 0)) fail(400, code, 'Invalid message length.');
  let serialized;
  try { serialized = JSON.stringify(input); } catch { fail(400, code, 'Message must contain JSON data.'); }
  if (serialized === undefined) fail(400, code, 'Message must contain JSON data.');
  // Never permit callers to understate the encoded payload size.
  return Math.max(suppliedBytes || 0, encoder.encode(serialized).byteLength);
}

export function normalizeEnvelope(input, { allowedTypes, maxBytes = 3 * 1024 * 1024, receivedBytes } = {}) {
  if (!object(input) || typeof input.type !== 'string' || !input.type || (allowedTypes && !allowedTypes.includes(input.type))) fail(400, 'INVALID_MESSAGE', 'Unknown message type.');
  if (messageBytes(input, receivedBytes, 'INVALID_MESSAGE') > maxBytes) fail(413, 'TOO_LARGE', 'Request is too large.');
  return input;
}

export function normalizeSignal(input, { senderId, maxBytes = SIGNAL_MAX_BYTES, receivedBytes } = {}) {
  if (!object(input) || typeof input.to !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.to) || input.to === senderId || !object(input.data)) fail(400, 'INVALID_SIGNAL', 'Invalid connection signal.');
  if (messageBytes(input, receivedBytes, 'INVALID_SIGNAL') > maxBytes) fail(400, 'INVALID_SIGNAL', 'Connection signal is too large.');
  // Signaling data is deliberately extensible (SDP, ICE, viewing interest).
  return { to: input.to, data: input.data };
}

export function normalizeChat(text) {
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 2000) fail(400, 'INVALID_CHAT', 'Messages must be 1–2000 characters.');
  return text.trim();
}

export function normalizeCursor(input) {
  if (!object(input) || ![input.x, input.y].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000)) fail(400, 'INVALID_CURSOR', 'Invalid cursor position.');
  return { x: input.x, y: input.y };
}

/** Additive handshake metadata: clients without capabilities keep working. */
export function protocolCapabilities(transport) {
  if (!['websocket', 'poll'].includes(transport)) throw new TypeError('Unknown session transport.');
  return { protocolVersion: PROTOCOL_VERSION, transport, guidedSessions: 1 };
}
