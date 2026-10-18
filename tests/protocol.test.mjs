import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoomCreation, normalizeJoin, normalizeEnvelope, normalizeSignal, normalizeChat, normalizeCursor, protocolCapabilities, SESSION_POLICY, SIGNAL_MAX_BYTES } from '../lib/session-protocol.mjs';
import { creationCases, joinCases, validCreation } from './protocol-cases.mjs';

test('portable admission validation preserves shared error codes and intentional adapter policies', () => {
  for (const sample of creationCases) {
    if (sample.code) assert.throws(() => normalizeRoomCreation(sample.input), { status: sample.status, code: sample.code }, sample.label);
    else assert.equal(normalizeRoomCreation(sample.input).name, sample.name);
  }
  for (const sample of joinCases.filter(sample => sample.code && sample.label !== 'wrong password')) {
    assert.throws(() => normalizeJoin(sample.input), { status: sample.status, code: sample.code }, sample.label);
  }
  assert.equal(normalizeJoin({ displayName: '  Ada  ', password: '  password  ' }).displayName, 'Ada');
  assert.equal(normalizeJoin({ displayName: 'Ada', password: '  password  ' }).password, '  password  ', 'password bytes must never be trimmed');
  const legacy = { ...validCreation, collaboration: undefined };
  assert.equal(normalizeRoomCreation(legacy).collaboration, 'peer');
  assert.equal(normalizeRoomCreation(legacy, { defaultCollaboration: 'server', allowedCollaborations: ['server', 'peer'] }).collaboration, 'server');
  assert.throws(() => normalizeRoomCreation({ ...validCreation, collaboration: 'server' }), { code: 'INVALID_COLLABORATION' });
  assert.equal(normalizeRoomCreation({ ...validCreation, isAdmin: true }).isAdmin, undefined);
  assert.equal(SESSION_POLICY.standaloneRoomTtlMs, 7 * SESSION_POLICY.hostedRoomTtlMs);
});

test('signaling stays extensible but bounds encoded UTF-8 bytes and rejects invalid destinations', () => {
  const signal = { type: 'signal', to: 'recipient_1', data: { subscribe: true, futureFeature: { value: 1 } }, requestId: 'retry-1' };
  assert.deepEqual(normalizeSignal(signal, { senderId: 'sender' }), { to: signal.to, data: signal.data });
  assert.throws(() => normalizeSignal(signal, { senderId: signal.to }), { code: 'INVALID_SIGNAL' });
  for (const data of [null, [], 'offer']) assert.throws(() => normalizeSignal({ ...signal, data }), { code: 'INVALID_SIGNAL' });
  assert.throws(() => normalizeSignal({ ...signal, to: 'bad target' }), { code: 'INVALID_SIGNAL' });
  const unicode = { ...signal, data: { sdp: '界'.repeat(Math.ceil(SIGNAL_MAX_BYTES / 3)) } };
  assert.ok(JSON.stringify(unicode).length < SIGNAL_MAX_BYTES);
  assert.throws(() => normalizeSignal(unicode), { code: 'INVALID_SIGNAL' });
  assert.throws(() => normalizeSignal(signal, { receivedBytes: SIGNAL_MAX_BYTES + 1 }), { code: 'INVALID_SIGNAL' });
  assert.throws(() => normalizeSignal(unicode, { receivedBytes: 0 }), { code: 'INVALID_SIGNAL' }, 'supplied lengths cannot understate actual bytes');
});

test('message envelopes, cursor and chat share transport-independent validation', () => {
  assert.equal(normalizeChat('  hello team  '), 'hello team');
  assert.throws(() => normalizeChat(' '.repeat(10)), { code: 'INVALID_CHAT' });
  assert.throws(() => normalizeChat('a'.repeat(2001)), { code: 'INVALID_CHAT' });
  assert.deepEqual(normalizeCursor({ x: -100000, y: 100000 }), { x: -100000, y: 100000 });
  for (const x of [Infinity, NaN, '4', 100001]) assert.throws(() => normalizeCursor({ x, y: 0 }), { code: 'INVALID_CURSOR' });
  for (const input of [[], null, {}, { type: 4 }]) assert.throws(() => normalizeEnvelope(input), { code: 'INVALID_MESSAGE' });
  assert.throws(() => normalizeEnvelope({ type: 'other' }, { allowedTypes: ['chat'] }), { code: 'INVALID_MESSAGE' });
  assert.throws(() => normalizeEnvelope({ type: 'chat', text: 'hello' }, { maxBytes: 4 }), { status: 413, code: 'TOO_LARGE' });
  assert.deepEqual(protocolCapabilities('websocket'), { protocolVersion: 1, transport: 'websocket', guidedSessions: 1 });
  assert.deepEqual(protocolCapabilities('poll'), { protocolVersion: 1, transport: 'poll', guidedSessions: 1 });
});
