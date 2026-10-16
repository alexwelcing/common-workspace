import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenSharing } from '../src/media.js';

const relay = (credential, expiresAt = Date.now() + 3_600_000) => ({
  iceServers: [{ urls: 'turn:relay.example:3478', username: 'participant', credential }], expiresAt,
});

class PeerConnection {
  constructor(configuration) {
    this.configuration = configuration;
    this.signalingState = 'stable';
    this.events = [];
    this.transceiver = { sender: { replaceTrack: async () => {} }, receiver: { track: { kind: 'video' } } };
  }
  setConfiguration(configuration) { this.configuration = configuration; this.events.push('configure'); }
  restartIce() { this.events.push('restart'); }
  createDataChannel(label) { return { label, readyState: 'connecting', close() {} }; }
  addTransceiver() { return this.transceiver; }
  getTransceivers() { return [this.transceiver]; }
  async setRemoteDescription(description) { this.remoteDescription = description; this.events.push('remote'); }
  async setLocalDescription() { this.localDescription = { type: 'answer', sdp: 'answer' }; this.events.push('local'); }
  close() { this.signalingState = 'closed'; }
}

function transport(t, getIceConfig) {
  const sharing = new ScreenSharing({
    send() {}, getIceConfig,
    peerConnectionFactory: (configuration) => new PeerConnection(configuration),
  });
  t.after(() => sharing.destroy());
  return sharing;
}

test('parallel peer setup shares one ICE fetch and keeps expiry metadata out of the browser configuration', async (t) => {
  let calls = 0;
  const sharing = transport(t, async () => { ++calls; return relay('initial'); });
  await sharing.syncParticipants(['z', 'a', 'b'], 'z');
  assert.equal(calls, 1);
  for (const { pc } of sharing.peers.values()) {
    assert.equal(pc.configuration.iceServers[0].credential, 'initial');
    assert.equal(Object.hasOwn(pc.configuration, 'expiresAt'), false);
  }
  await sharing.syncParticipants(['z', 'a', 'b', 'c'], 'z');
  assert.equal(calls, 1);
});

test('a failed connection refreshes nearly expired TURN credentials before restarting ICE', async (t) => {
  let calls = 0;
  const sharing = transport(t, async () => ++calls === 1 ? relay('old', Date.now() + 5_000) : relay('renewed'));
  await sharing.syncParticipants(['z', 'a'], 'z');
  const peer = sharing.peers.get('a');
  await sharing._restartPeer(peer, true);
  assert.equal(calls, 2);
  assert.equal(peer.pc.configuration.iceServers[0].credential, 'renewed');
  assert.deepEqual(peer.pc.events, ['configure', 'restart']);
  assert.equal(peer.hasTurn, true);
  await sharing._restartPeer(peer, true);
  assert.equal(calls, 2);
  assert.deepEqual(peer.pc.events, ['configure', 'restart']);
});

test('a peer-requested ICE restart configures fresh credentials before generating the offer', async (t) => {
  let calls = 0;
  const sharing = transport(t, async () => ++calls === 1 ? relay('old', Date.now() + 5_000) : relay('renewed'));
  await sharing.syncParticipants(['a', 'z'], 'a');
  const peer = sharing.peers.get('z');
  await sharing.handleSignal('z', { renegotiate: true, iceRestart: true });
  await peer.operations;
  assert.equal(calls, 2);
  assert.deepEqual(peer.pc.events, ['configure', 'restart', 'local']);
  assert.equal(peer.pc.configuration.iceServers[0].credential, 'renewed');
});

test('an incoming restart offer refreshes the answerer before remote SDP is applied', async (t) => {
  let calls = 0;
  const sharing = transport(t, async () => ++calls === 1 ? relay('old', Date.now() + 5_000) : relay('renewed'));
  await sharing.syncParticipants(['z', 'a'], 'z');
  const peer = sharing.peers.get('a');
  await sharing.handleSignal('a', { description: { type: 'offer', sdp: 'restart offer' } });
  assert.equal(calls, 2);
  assert.deepEqual(peer.pc.events, ['configure', 'remote', 'local']);
  assert.equal(peer.pc.configuration.iceServers[0].credential, 'renewed');
});

test('an ICE fetch failure or expired credential falls back for that attempt and retries later', async (t) => {
  let calls = 0;
  const sharing = transport(t, async () => {
    if (++calls === 1) throw new Error('temporary outage');
    if (calls === 2) return relay('expired', Date.now() - 1_000);
    return relay('renewed', new Date(Date.now() + 3_600_000).toISOString());
  });
  await sharing.syncParticipants(['z', 'a'], 'z');
  assert.match(sharing.peers.get('a').pc.configuration.iceServers[0].urls, /^stun:/);
  await sharing.syncParticipants(['z', 'a', 'b'], 'z');
  assert.match(sharing.peers.get('b').pc.configuration.iceServers[0].urls, /^stun:/);
  await sharing.syncParticipants(['z', 'a', 'b', 'c'], 'z');
  assert.equal(calls, 3);
  assert.equal(sharing.peers.get('c').pc.configuration.iceServers[0].credential, 'renewed');
});

test('closing a peer during credential refresh prevents configuration and restart on a closed connection', async (t) => {
  let finish;
  let calls = 0;
  const sharing = transport(t, async () => ++calls === 1
    ? relay('old', Date.now() + 5_000)
    : new Promise((resolve) => { finish = resolve; }));
  await sharing.syncParticipants(['z', 'a'], 'z');
  const peer = sharing.peers.get('a');
  const restarting = sharing._restartPeer(peer, true);
  while (!finish) await Promise.resolve();
  sharing.destroy();
  finish(relay('renewed'));
  await restarting;
  assert.deepEqual(peer.pc.events, []);
});
