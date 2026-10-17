import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenSharing } from '../src/media.js';
import { canvasNeighbors } from '../src/peer-topology.js';

class Channel {
  constructor(label) { this.label = label; this.readyState = 'connecting'; this.bufferedAmount = 0; this.frames = []; }
  open() { this.readyState = 'open'; this.onopen?.(); }
  send(bytes) { this.frames.push(new Uint8Array(bytes)); }
  close() { if (this.readyState !== 'closed') { this.readyState = 'closed'; this.onclose?.(); } }
}
class Track extends EventTarget {
  constructor() { super(); this.kind = 'video'; this.readyState = 'live'; }
  stop() { this.readyState = 'ended'; }
}
class Stream {
  constructor(tracks = [new Track()]) { this.tracks = tracks; }
  getVideoTracks() { return this.tracks; }
  getTracks() { return this.tracks; }
}
class PeerConnection {
  constructor(configuration) { this.configuration = configuration; this.signalingState = 'stable'; this.connectionState = 'new'; this.channels = []; this.transceivers = []; this.sequence = 0; }
  setConfiguration(configuration) { this.configuration = configuration; }
  createDataChannel(label) { const channel = new Channel(label); this.channels.push(channel); return channel; }
  addTransceiver(source) {
    const sender = {
      track: typeof source === 'string' ? null : source, budgets: [],
      async replaceTrack(track) { this.track = track; },
      getParameters() { return { encodings: [{ rid: 'screen' }] }; },
      async setParameters(parameters) { this.budgets.push(structuredClone(parameters)); },
    };
    const transceiver = { sender, receiver: { track: new Track() }, direction: 'sendrecv' };
    this.transceivers.push(transceiver); return transceiver;
  }
  getTransceivers() { return this.transceivers; }
  async setLocalDescription(description) {
    if (description?.type === 'rollback') { this.signalingState = 'stable'; this.localDescription = null; return; }
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: `${type}-${++this.sequence}` };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    if (description.type === 'offer' && !this.transceivers.length) this.addTransceiver('video');
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() {}
  restartIce() {}
  close() { this.signalingState = 'closed'; this.connectionState = 'closed'; }
}
const roster = count => Array.from({ length: count }, (_, index) => `p${String(index).padStart(3, '0')}`);
function setup(t, options = {}) {
  const sent = []; const streams = []; const opened = []; const closed = []; const received = [];
  const sharing = new ScreenSharing({
    send: message => sent.push(message), onStream: (id, stream) => streams.push([id, stream]),
    onPeerOpen: id => opened.push(id), onPeerClose: id => closed.push(id), onData: (id, bytes) => received.push([id, bytes]),
    getIceConfig: async () => ({ iceServers: [] }), peerConnectionFactory: config => new PeerConnection(config),
    streamFactory: tracks => new Stream(tracks), mediaDevices: { getDisplayMedia: async () => new Stream() }, ...options,
  });
  t.after(() => sharing.destroy());
  return { sharing, sent, streams, opened, closed, received };
}

test('a large roster opens only six canvas neighbors and shares no screen by default', async t => {
  const { sharing, streams } = setup(t); const people = roster(100);
  await sharing.syncParticipants(people, people[0]);
  assert.equal(sharing.members.size, 99); assert.equal(sharing.peers.size, 6);
  assert.deepEqual([...sharing.desiredCanvasPeers], canvasNeighbors(people, people[0]));
  const local = await sharing.start(); assert.ok(local);
  for (const peer of sharing.peers.values()) assert.equal(peer.transceiver.sender.track, null);
  assert.deepEqual(streams.filter(([, stream]) => stream).map(([id]) => id), ['local']);
  assert.deepEqual([...sharing.subscriptions], []); assert.deepEqual([...sharing.viewers], []);
});

test('explicit watches add media-only edges, gate remote video and avoid subscription resends on unchanged polling', async t => {
  const { sharing, sent, streams, opened } = setup(t); const people = roster(100); const me = people[0];
  await sharing.syncParticipants(people, me);
  const owner = people.find(id => id !== me && !sharing.desiredCanvasPeers.has(id));
  await sharing.setSubscriptions([owner]);
  assert.equal(sharing.peers.size, 7); const peer = sharing.peers.get(owner);
  assert.equal(peer.channel, null, 'a media-only edge does not create a canvas channel');
  const channel = new Channel('common-canvas-v1'); peer.pc.ondatachannel({ channel }); channel.open();
  assert.equal(opened.includes(owner), false); assert.equal(sharing.sendData(owner, new Uint8Array([1])), false);
  const remote = new Stream(); peer.pc.ontrack({ track: remote.getVideoTracks()[0], streams: [remote] });
  assert.equal(streams.at(-1)[1], remote);
  await sharing.setSubscriptions([]);
  assert.equal(streams.at(-1)[1], null); assert.equal(sharing.peers.has(owner), false);
  await sharing.setSubscriptions([owner]);
  const subscriptions = () => sent.filter(message => message.to === owner && Object.hasOwn(message.data, 'subscribe'));
  const count = subscriptions().length;
  await sharing.syncParticipants(people, me); await sharing.setSubscriptions([owner]);
  assert.equal(subscriptions().length, count);
  await sharing.syncParticipants(people, me, { reconnect: true });
  assert.equal(subscriptions().length, count + 1); assert.equal(subscriptions().at(-1).data.subscribe, true);
  const canvasPeer = [...sharing.peers.values()].find(candidate => sharing.desiredCanvasPeers.has(candidate.id));
  const unauthorized = new Stream(); canvasPeer.pc.ontrack({ track: unauthorized.getVideoTracks()[0], streams: [unauthorized] });
  assert.equal(streams.some(([, stream]) => stream === unauthorized), false);
});

test('canvas role changes reuse media connections while provider callbacks and binary data stay within topology edges', async t => {
  const { sharing, opened, closed, received } = setup(t); const small = roster(10); const large = roster(100); const me = small[0];
  await sharing.syncParticipants(small, me);
  const target = [...sharing.desiredCanvasPeers].find(id => !canvasNeighbors(large, me).includes(id));
  assert.ok(target); await sharing.setSubscriptions([target]);
  const peer = sharing.peers.get(target); peer.channel.open(); const channel = peer.channel;
  assert.equal(opened.filter(id => id === target).length, 1);
  assert.equal(sharing.sendData(target, new Uint8Array([7])), true); const frame = channel.frames[0];
  channel.onmessage({ data: frame }); assert.equal(received.length, 1);
  await sharing.syncParticipants(large, me);
  assert.equal(sharing.peers.get(target), peer); assert.equal(channel.readyState, 'open');
  assert.equal(closed.filter(id => id === target).length, 1); assert.equal(sharing.dataPeerIds.includes(target), false);
  channel.onmessage({ data: frame }); assert.equal(received.length, 1);
  assert.equal(sharing.sendData(target, new Uint8Array([8])), false);
  await sharing.syncParticipants(small, me);
  assert.equal(sharing.peers.get(target), peer); assert.equal(peer.channel, channel);
  assert.equal(opened.filter(id => id === target).length, 2);
  assert.equal(sharing.dataPeerIds.includes(target), true); assert.equal(sharing.sendData(target, new Uint8Array([9])), true);
});

test('only subscribed viewers receive the local track, with best-effort bitrate and frame budgets per viewer', async t => {
  const { sharing } = setup(t); const people = roster(40); const me = people[0];
  await sharing.syncParticipants(people, me); const local = await sharing.start(); const track = local.getVideoTracks()[0];
  const viewers = people.slice(1, 21);
  await sharing.handleSignal(viewers[0], { subscribe: true });
  assert.equal(sharing.peers.get(viewers[0]).transceiver.sender.budgets.at(-1).encodings[0].maxBitrate, 1_500_000);
  await sharing.handleSignal(viewers[1], { subscribe: true });
  for (const id of viewers.slice(0, 2)) assert.equal(sharing.peers.get(id).transceiver.sender.budgets.at(-1).encodings[0].maxBitrate, 750_000);
  for (const id of viewers.slice(2)) await sharing.handleSignal(id, { subscribe: true });
  assert.equal(sharing.viewers.size, 20, 'authenticated inbound viewers have no arbitrary seat cap');
  for (const [id, peer] of sharing.peers) {
    if (viewers.includes(id)) {
      assert.equal(peer.transceiver.sender.track, track);
      const encoding = peer.transceiver.sender.budgets.at(-1).encodings[0];
      assert.equal(encoding.maxBitrate, 180_000); assert.equal(encoding.maxFramerate, 15); assert.equal(encoding.rid, 'screen');
    } else assert.equal(peer.transceiver.sender.track, null);
  }
  await sharing.handleSignal(viewers[0], { subscribe: false });
  if (sharing.peers.has(viewers[0])) assert.equal(sharing.peers.get(viewers[0]).transceiver.sender.track, null);
  assert.equal(sharing.viewers.has(viewers[0]), false);
});

test('early subscription intent survives a lagging roster and a dropped first offer recovers through offer replay', async t => {
  const people = roster(100); const ownerId = people.at(-1);
  const viewerId = people.find(id => id !== ownerId && !canvasNeighbors(people, ownerId).includes(id));
  const viewer = setup(t); const owner = setup(t);
  await owner.sharing.syncParticipants(people.filter(id => id !== viewerId), ownerId);
  await viewer.sharing.syncParticipants(people, viewerId);
  await viewer.sharing.setSubscriptions([ownerId]);
  const firstSubscribe = viewer.sent.find(message => message.to === ownerId && message.data.subscribe === true);
  await owner.sharing.handleSignal(viewerId, firstSubscribe.data);
  const viewerPeer = viewer.sharing.peers.get(ownerId);
  await viewer.sharing._negotiate(viewerPeer);
  const firstOffer = viewer.sent.find(message => message.to === ownerId && message.data.description?.type === 'offer');
  await owner.sharing.handleSignal(viewerId, firstOffer.data);
  assert.equal(owner.sharing.peers.has(viewerId), false); assert.equal(viewerPeer.pc.signalingState, 'have-local-offer');
  await owner.sharing.syncParticipants(people, ownerId);
  assert.equal(owner.sharing.viewers.has(viewerId), true); assert.equal(owner.sharing.peers.has(viewerId), true);
  const retryRequest = owner.sent.find(message => message.to === viewerId && message.data.renegotiate === true);
  assert.ok(retryRequest);
  const before = viewer.sent.filter(message => message.to === ownerId && message.data.description?.type === 'offer').length;
  await viewer.sharing.handleSignal(ownerId, retryRequest.data); await viewerPeer.operations;
  const offers = viewer.sent.filter(message => message.to === ownerId && message.data.description?.type === 'offer');
  assert.equal(offers.length, before + 1); assert.deepEqual(offers.at(-1).data.description, firstOffer.data.description);
  await owner.sharing.handleSignal(viewerId, offers.at(-1).data);
  const answer = owner.sent.find(message => message.to === viewerId && message.data.description?.type === 'answer');
  assert.ok(answer); await viewer.sharing.handleSignal(ownerId, answer.data);
  assert.equal(viewerPeer.pc.signalingState, 'stable'); assert.equal(owner.sharing.peers.get(viewerId).pc.signalingState, 'stable');
});

test('answer-side transceiver adoption rebalances existing viewers and unsupported sender budgets remain optional', async t => {
  const { sharing } = setup(t); await sharing.syncParticipants(['a', 'b', 'z'], 'z');
  await sharing.start();
  await sharing.handleSignal('a', { subscribe: true }); await sharing.handleSignal('b', { subscribe: true });
  await sharing.handleSignal('a', { description: { type: 'offer', sdp: 'offer-a' } });
  const a = sharing.peers.get('a'); assert.equal(a.transceiver.sender.budgets.at(-1).encodings[0].maxBitrate, 1_500_000);
  await sharing.handleSignal('b', { description: { type: 'offer', sdp: 'offer-b' } }); await a.operations;
  assert.equal(a.transceiver.sender.budgets.at(-1).encodings[0].maxBitrate, 750_000);
  const b = sharing.peers.get('b'); assert.equal(b.transceiver.sender.budgets.at(-1).encodings[0].maxBitrate, 750_000);
  a.transceiver.sender.setParameters = async () => { throw new Error('Unsupported in this browser'); };
  await sharing.handleSignal('b', { subscribe: false });
  assert.equal(a.transceiver.sender.track, sharing.localStream.getVideoTracks()[0]);
});

test('unconnected peers retry subscription and SDP within a bounded budget and stop timers after connect or close', async t => {
  const { sharing, sent } = setup(t); const people = roster(30); const me = people[0];
  await sharing.syncParticipants(people, me);
  const owner = people.find(id => id !== me && !sharing.desiredCanvasPeers.has(id));
  await sharing.setSubscriptions([owner]); const peer = sharing.peers.get(owner);
  await sharing._negotiate(peer);
  const offers = () => sent.filter(message => message.to === owner && message.data.description?.type === 'offer');
  const subscriptions = () => sent.filter(message => message.to === owner && message.data.subscribe === true);
  const before = offers().length; const beforeSubscribe = subscriptions().length;
  await sharing._retryNegotiation(peer);
  assert.equal(offers().length, before + 1); assert.equal(subscriptions().length, beforeSubscribe + 1);
  for (let i = 0; i < 12; i++) await sharing._retryNegotiation(peer);
  assert.equal(peer.negotiationRetries, 8); assert.equal(peer.negotiationRetryTimer, null);
  peer.pc.signalingState = 'stable'; peer.pc.connectionState = 'connected'; peer.pc.onconnectionstatechange();
  const count = offers().length; await sharing._retryNegotiation(peer); assert.equal(offers().length, count);
  const other = [...sharing.peers.values()].find(candidate => candidate !== peer);
  assert.ok(other.negotiationRetryTimer); sharing.destroy(); assert.equal(other.negotiationRetryTimer, null);
});

test('an already connected media-only PC can retry a new canvas-channel offer without dropping the media connection', async t => {
  const { sharing, sent } = setup(t); const large = roster(100); const small = roster(10); const me = small[0];
  await sharing.syncParticipants(large, me);
  const target = canvasNeighbors(small, me).find(id => !sharing.desiredCanvasPeers.has(id));
  assert.ok(target); await sharing.setSubscriptions([target]); const peer = sharing.peers.get(target);
  peer.pc.signalingState = 'stable'; peer.pc.connectionState = 'connected'; peer.pc.onconnectionstatechange();
  assert.equal(peer.channel, null); assert.equal(peer.negotiationRetryTimer, null);
  await sharing.syncParticipants(small, me); assert.equal(sharing.peers.get(target), peer); assert.ok(peer.channel);
  await sharing._negotiate(peer); assert.equal(peer.pc.signalingState, 'have-local-offer'); assert.ok(peer.negotiationRetryTimer);
  const count = sent.filter(message => message.to === target && message.data.description?.type === 'offer').length;
  await sharing._retryNegotiation(peer);
  assert.equal(sent.filter(message => message.to === target && message.data.description?.type === 'offer').length, count + 1);
  assert.equal(sharing.peers.get(target), peer); assert.equal(peer.pc.connectionState, 'connected');
});

test('membership removal clears watch and viewer roles, early intents expire, and unknown intent buffering is bounded', async t => {
  const { sharing } = setup(t); await sharing.syncParticipants(['a', 'b', 'c'], 'a');
  await sharing.setSubscriptions(['b']); await sharing.handleSignal('b', { subscribe: true });
  await sharing.syncParticipants(['a', 'c'], 'a');
  assert.equal(sharing.peers.has('b'), false); assert.equal(sharing.viewers.has('b'), false);
  assert.equal(sharing.subscriptions.has('b'), false); assert.equal(sharing._announcedSubscriptions.has('b'), false);
  await sharing.handleSignal('future', { subscribe: true }); sharing._earlySubscriptions.set('future', Date.now() - 1);
  await sharing.syncParticipants(['a', 'c', 'future'], 'a'); assert.equal(sharing.viewers.has('future'), false);
  for (let i = 0; i < 2050; i++) await sharing.handleSignal(`unknown-${i}`, { subscribe: true });
  assert.equal(sharing._earlySubscriptions.size, 2048);
});

test('destroying while the capture picker is pending stops late tracks and cannot publish a new local stream', async t => {
  let resolveCapture; const { sharing, streams } = setup(t, { mediaDevices: { getDisplayMedia: () => new Promise(resolve => { resolveCapture = resolve; }) } });
  await sharing.syncParticipants(['a', 'b'], 'a');
  const pending = sharing.start(); sharing.destroy(); const late = new Stream(); resolveCapture(late);
  assert.equal(await pending, null); assert.equal(late.getVideoTracks()[0].readyState, 'ended');
  assert.equal(streams.some(([, stream]) => stream), false);
});
