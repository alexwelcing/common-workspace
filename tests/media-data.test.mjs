import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenSharing } from '../src/media.js';

const CHUNK = 16 * 1024;
const MiB = 1024 * 1024;

class Channel {
  constructor(label = 'common-canvas-v1') {
    this.label = label;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.frames = [];
  }
  open() {
    this.readyState = 'open';
    this.onopen?.();
  }
  send(bytes) {
    if (this.readyState !== 'open') throw new Error('Channel is closed');
    this.frames.push(new Uint8Array(bytes));
    this.bufferedAmount += bytes.byteLength;
  }
  drain() {
    this.bufferedAmount = 0;
    this.onbufferedamountlow?.();
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class PeerConnection {
  constructor() {
    this.signalingState = 'stable';
    this.channels = [];
  }
  createDataChannel(label, options) {
    const channel = new Channel(label);
    channel.options = options;
    this.channels.push(channel);
    return channel;
  }
  addTransceiver() {
    return { sender: { replaceTrack: async () => {} }, receiver: { track: { kind: 'video' } } };
  }
  close() { this.signalingState = 'closed'; }
}

async function transport(t, options = {}, myId = 'a', peerId = 'z') {
  const pcs = [];
  const sharing = new ScreenSharing({
    send() {}, getIceConfig: async () => ({ iceServers: [] }),
    peerConnectionFactory() {
      const pc = new PeerConnection();
      pcs.push(pc);
      return pc;
    },
    ...options,
  });
  t.after(() => sharing.destroy());
  await sharing.syncParticipants([myId, peerId], myId);
  return { sharing, peer: sharing.peers.get(peerId), pc: pcs[0], channel: pcs[0].channels[0] };
}

function frame({ id = 1, total = CHUNK + 1, index = 0, count = Math.ceil(total / CHUNK), magic = 0x43435631 } = {}) {
  const data = new Uint8Array(20 + Math.max(0, Math.min(CHUNK, total - index * CHUNK)));
  const header = new DataView(data.buffer);
  [magic, id, total, index, count].forEach((value, i) => header.setUint32(i * 4, value));
  return data;
}

test('one deterministic offer owner opens a reliable channel and reports lifecycle once', async (t) => {
  const opened = [], closed = [];
  const { sharing, peer, channel } = await transport(t, {
    onPeerOpen: (id) => opened.push(id), onPeerClose: (id) => closed.push(id),
  });
  assert.deepEqual(channel.options, { ordered: true });
  assert.equal(sharing.sendData('z', new Uint8Array([1])), false);
  channel.open();
  channel.open();
  assert.deepEqual(opened, ['z']);
  const duplicate = new Channel();
  peer.pc.ondatachannel({ channel: duplicate });
  assert.equal(duplicate.readyState, 'closed');
  channel.close();
  channel.close();
  assert.deepEqual(closed, ['z']);
  sharing._openDataChannel(peer);
  peer.channel.open();
  assert.deepEqual(opened, ['z', 'z']);
  sharing.destroy();
  assert.deepEqual(closed, ['z', 'z']);
  assert.equal(peer.dataReconnectTimer, null);

  const answerer = await transport(t, {}, 'z', 'a');
  assert.equal(answerer.pc.channels.length, 0);
  const unknown = new Channel('other-protocol');
  answerer.pc.ondatachannel({ channel: unknown });
  assert.equal(unknown.readyState, 'closed');
  const incoming = new Channel();
  answerer.pc.ondatachannel({ channel: incoming });
  assert.equal(answerer.peer.channel, incoming);
});

test('binary frames chunk and reassemble a message with Blob input and duplicate parts', async (t) => {
  const received = [];
  const sender = await transport(t);
  const receiver = await transport(t, { onData: (id, bytes) => received.push({ id, bytes }) }, 'z', 'a');
  const incoming = new Channel();
  receiver.pc.ondatachannel({ channel: incoming });
  incoming.open();
  sender.channel.open();
  const original = Uint8Array.from({ length: CHUNK * 4 + 73 }, (_, i) => i % 251);
  assert.equal(sender.sharing.sendData('z', original), true);
  assert.equal(sender.channel.frames.length, 5);
  for (const part of sender.channel.frames) assert.ok(part.byteLength <= CHUNK + 20);
  incoming.onmessage({ data: sender.channel.frames[3].buffer });
  incoming.onmessage({ data: sender.channel.frames[3].buffer });
  incoming.onmessage({ data: sender.channel.frames[1] });
  incoming.onmessage({ data: sender.channel.frames[4].buffer });
  incoming.onmessage({ data: sender.channel.frames[0].buffer });
  assert.equal(received.length, 0);
  incoming.onmessage({ data: new Blob([sender.channel.frames[2]]) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(received.length, 1);
  assert.equal(received[0].id, 'a');
  assert.deepEqual(received[0].bytes, original);
  assert.equal(receiver.peer.dataAssemblyBytes, 0);
  assert.equal(receiver.peer.dataAssemblies.size, 0);
  assert.equal(receiver.peer.dataBlobBytes, 0);
  assert.equal(receiver.peer.dataExpiryTimer, null);
});

test('backpressure retains immutable messages, resumes on drain, and bounds queued bytes', async (t) => {
  const { sharing, peer, channel } = await transport(t);
  channel.open();
  channel.bufferedAmount = 512 * 1024;
  const original = new Uint8Array(MiB).fill(7);
  assert.equal(sharing.sendData('z', original), true);
  original.fill(9);
  assert.equal(channel.frames.length, 0);
  while (peer.dataQueue.length) channel.drain();
  assert.equal(channel.frames.length, 64);
  assert.equal(channel.frames.at(-1)[20], 7);
  assert.equal(peer.dataQueuedBytes, 0);
  assert.equal(peer.dataSendTimer, null);
  channel.bufferedAmount = 512 * 1024;
  assert.equal(sharing.sendData('z', new Uint8Array(24 * MiB)), true);
  assert.equal(sharing.sendData('z', new Uint8Array(9 * MiB)), false);
  assert.equal(sharing.sendData('z', new Uint8Array(24 * MiB + 1)), false);
  assert.equal(sharing.sendData('missing', new Uint8Array(1)), false);
  sharing.destroy();
  assert.equal(peer.dataQueue.length, 0);
  assert.equal(peer.dataQueuedBytes, 0);
  assert.equal(peer.dataSendTimer, null);
  assert.equal(channel.onbufferedamountlow, null);
});

test('malformed frames, concurrent assemblies, total memory, and stale fragments are bounded', async (t) => {
  const delivered = [];
  const { sharing, peer, channel } = await transport(t, { onData: (...args) => delivered.push(args) });
  channel.open();
  for (const data of [
    new Uint8Array(19), new Uint8Array(CHUNK + 21), frame({ magic: 0 }), frame({ id: 0 }),
    frame({ count: 0 }), frame({ index: 3 }), frame({ total: 24 * MiB + 1 }),
    frame({ total: 4 }).subarray(0, 23),
  ]) channel.onmessage({ data });
  assert.equal(peer.dataAssemblies.size, 0);
  channel.onmessage({ data: frame({ id: 1, total: 24 * MiB }) });
  channel.onmessage({ data: frame({ id: 2, total: 24 * MiB }) });
  assert.equal(peer.dataAssemblies.size, 1);
  assert.equal(peer.dataAssemblyBytes, 24 * MiB);
  peer.dataAssemblies.get(1).expires = Date.now() - 1;
  sharing._expireDataAssemblies(peer);
  assert.equal(peer.dataAssemblyBytes, 0);
  for (let id = 1; id <= 9; ++id) channel.onmessage({ data: frame({ id }) });
  assert.equal(peer.dataAssemblies.size, 8);
  const first = peer.dataAssemblies.get(1);
  channel.onmessage({ data: frame({ id: 1, total: CHUNK * 2 + 1 }) });
  channel.onmessage({ data: frame({ id: 1 }) });
  assert.equal(first.parts, 1);
  assert.equal(delivered.length, 0);
  sharing.destroy();
  assert.equal(peer.dataAssemblies.size, 0);
  assert.equal(peer.dataAssemblyBytes, 0);
  assert.equal(peer.dataExpiryTimer, null);
});

test('destroy ignores an asynchronous Blob that finishes after its channel closes', async (t) => {
  const received = [];
  const { sharing, peer, channel } = await transport(t, { onData: (...args) => received.push(args) });
  channel.open();
  const blob = new Blob([frame({ total: 1 })]);
  let finish;
  blob.arrayBuffer = () => new Promise((resolve) => { finish = resolve; });
  channel.onmessage({ data: blob });
  assert.ok(peer.dataBlobBytes > 0);
  sharing.destroy();
  finish(frame({ total: 1 }).buffer);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(received, []);
  assert.equal(peer.dataBlobBytes, 0);
});

test('broadcast counts open recipients and an abusive frame rate cannot allocate unlimited assemblies', async (t) => {
  const { sharing, peer, channel } = await transport(t);
  await sharing.syncParticipants(['a', 'y', 'z'], 'a');
  const second = sharing.peers.get('y').channel;
  channel.open();
  assert.equal(sharing.broadcastData(new Uint8Array([5, 6])), 1);
  second.open();
  assert.equal(sharing.broadcastData(new Uint8Array([7, 8])), 2);
  assert.equal(channel.frames.length, 2);
  assert.equal(second.frames.length, 1);
  peer.dataFrameWindow = Date.now() + 1000;
  peer.dataFrames = 4096;
  channel.onmessage({ data: frame({ id: 10 }) });
  assert.equal(peer.dataAssemblies.size, 0);
  peer.dataFrameWindow = Date.now() - 1001;
  channel.onmessage({ data: frame({ id: 10 }) });
  assert.equal(peer.dataAssemblies.size, 1);
});
