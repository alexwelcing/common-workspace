import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasCapture } from '../src/capture.js';

class Track extends EventTarget {
  constructor() { super(); this.readyState = 'live'; this.stops = 0; }
  stop() { this.readyState = 'ended'; this.stops++; }
  getSettings() { return { width: 1280, height: 720 }; }
}
function stream() {
  const track = new Track();
  return { track, getVideoTracks: () => [track], getTracks: () => [track] };
}
class Recorder {
  static instances = [];
  static isTypeSupported(type) { return type === 'video/webm;codecs=vp8'; }
  constructor(source, options) { this.stream = source; this.mimeType = options?.mimeType || 'video/webm'; this.state = 'inactive'; Recorder.instances.push(this); }
  start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; }
  chunk(value = 'video') { this.ondataavailable?.({ data: new Blob([value], { type: this.mimeType }) }); }
  stop() { this.state = 'inactive'; queueMicrotask(() => { this.chunk('end'); this.onstop?.(); }); }
}
function setup(options = {}) {
  const calls = [], contexts = [], canvases = [], intervals = new Map(), timeouts = new Map(), anchors = [], revoked = [], statusMessages = [];
  let tick = 1000, nextTimer = 1, windowStream = stream();
  const board = { el: { clientWidth: 800, clientHeight: 600 }, getView: () => ({ x: 25, y: 35, zoom: 1.2 }), listEntities: () => [], nodes: new Map() };
  const document = { body: { append() {} }, createElement(tag) {
    if (tag === 'a') { const anchor = { click() { this.clicked = true; }, remove() {} }; anchors.push(anchor); return anchor; }
    const ctx = new Proxy({ measureText: text => ({ width: text.length * 8 }) }, { get(target, key) { if (key in target) return target[key]; return (...args) => calls.push([key, ...args]); }, set(target, key, value) { target[key] = value; calls.push(['style', key, value]); return true; } });
    const captured = stream();
    const canvas = { getContext: () => ctx, captureStream: fps => { canvas.fps = fps; return captured; }, toDataURL: mime => `data:${mime};base64,snapshot`, captured };
    contexts.push(ctx); canvases.push(canvas); return canvas;
  } };
  const capture = new CanvasCapture({ getBoard: () => board, getWindowStream: () => windowStream, document, MediaRecorder: Recorder,
    now: () => tick, Image: null, XMLSerializer: null,
    URL: { createObjectURL: () => `blob:${nextTimer++}`, revokeObjectURL: url => revoked.push(url) },
    setInterval: fn => { const id = nextTimer++; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    setTimeout: fn => { const id = nextTimer++; timeouts.set(id, fn); return id; }, clearTimeout: id => timeouts.delete(id),
    onStatus: message => statusMessages.push(message), ...options });
  return { capture, board, calls, contexts, canvases, intervals, timeouts, anchors, revoked, statusMessages, get windowStream() { return windowStream; }, replaceWindow: value => { windowStream = value; }, advance: ms => { tick += ms; for (const fn of [...intervals.values()]) fn(); } };
}

test('window recording requires a live user-approved source and never asks for permissions', async () => {
  const f = setup(); f.replaceWindow(null);
  await assert.rejects(f.capture.start({ source: 'window' }), /Share a window/);
  assert.equal(f.capture.status().state, 'idle');
  f.replaceWindow(stream()); f.windowStream.track.stop();
  await assert.rejects(f.capture.start({ source: 'window' }), /Share a window/);
  await assert.rejects(f.capture.start({ source: 'other' }), /Choose canvas or window/);
  f.capture.destroy();
});

test('window stop keeps shared tracks alive, captures final data, and exposes metadata only', async () => {
  const f = setup();
  const started = await f.capture.start({ source: 'window' });
  const recorder = Recorder.instances.at(-1);
  assert.equal(recorder.stream, f.windowStream);
  assert.equal(recorder.mimeType, 'video/webm;codecs=vp8');
  assert.equal(recorder.timeslice, 500);
  recorder.chunk('first'); f.advance(1200);
  const stopping = f.capture.stop(); assert.equal(f.capture.status().state, 'stopping');
  const saved = await stopping;
  assert.equal(saved.bytes, 8);
  assert.equal(saved.durationMs, 1200);
  assert.equal(saved.width, 1280); assert.equal(saved.height, 720);
  assert.equal(f.windowStream.track.stops, 0);
  assert.equal(f.capture.status().state, 'idle');
  assert.equal(f.intervals.size, 0);
  assert.equal(f.capture.list()[0].id, started.id);
  assert.equal('blob' in f.capture.list()[0], false);
  const clone = f.capture.list(); clone[0].bytes = -1;
  assert.equal(f.capture.list()[0].bytes, 8);
  f.capture.destroy(); assert.equal(f.windowStream.track.stops, 0);
});

test('loss or replacement of the window stops recording without ending a replacement share', async () => {
  const f = setup(); await f.capture.start({ source: 'window' });
  Recorder.instances.at(-1).chunk();
  const original = f.windowStream; const replacement = stream(); f.replaceWindow(replacement);
  f.capture.syncSource(); await f.capture.stop();
  assert.equal(f.capture.list()[0].stopReason, 'source-ended');
  assert.equal(original.track.stops, 0); assert.equal(replacement.track.stops, 0);
  await f.capture.start({ source: 'window' }); Recorder.instances.at(-1).chunk();
  replacement.track.stop(); f.capture.syncSource(); await f.capture.stop();
  assert.equal(f.capture.list()[1].stopReason, 'source-ended');
  assert.equal(replacement.track.stops, 1);
  f.capture.destroy();
});

test('track ended events finalize recordings and remove lifecycle listeners', async () => {
  const f = setup(); await f.capture.start({ source: 'window' });
  Recorder.instances.at(-1).chunk();
  f.windowStream.track.dispatchEvent(new Event('ended'));
  await f.capture.stop();
  assert.equal(f.capture.list()[0].stopReason, 'source-ended');
  assert.equal(f.windowStream.track.stops, 0); f.capture.destroy();
});

test('canvas snapshots use current view and preserve bottom-to-top layering with live video', async () => {
  const f = setup(); const video = { readyState: 4, videoWidth: 1280, videoHeight: 720 };
  f.board.nodes.set('screen', { querySelector: () => video });
  f.board.listEntities = () => [
    { id: 'screen', type: 'screen', x: 10, y: 20, width: 600, height: 370, title: 'Product walkthrough' },
    { id: 'box', type: 'rectangle', x: 200, y: 50, width: 150, height: 80, fill: 'yellow', color: 'red' },
    { id: 'label', type: 'text', x: 200, y: 100, width: 150, height: 60, text: 'Important' },
  ];
  const shot = await f.capture.snapshot({ download: true });
  assert.deepEqual(shot, { dataUrl: 'data:image/png;base64,snapshot', width: 800, height: 600, mimeType: 'image/png' });
  const draw = f.calls.findIndex(call => call[0] === 'drawImage' && call[1] === video);
  const box = f.calls.findIndex(call => call[0] === 'style' && call[1] === 'fillStyle' && call[2] === 'yellow');
  const text = f.calls.findIndex(call => call[0] === 'fillText' && call[1] === 'Important');
  assert.ok(draw >= 0 && box > draw && text > box);
  assert.ok(f.calls.some(call => call[0] === 'translate' && call[1] === 25 && call[2] === 35));
  assert.ok(f.calls.some(call => call[0] === 'scale' && call[1] === 1.2));
  assert.equal(f.anchors[0].clicked, true); assert.match(f.anchors[0].download, /\.png$/);
  f.capture.destroy();
});

test('canvas recording owns only its compositor stream and releases it after stop', async () => {
  const f = setup(); const started = await f.capture.start();
  assert.equal(started.source, 'canvas'); assert.equal(f.canvases[0].fps, 12);
  Recorder.instances.at(-1).chunk();
  await assert.rejects(f.capture.start(), /already running/);
  await f.capture.stop();
  assert.equal(f.canvases[0].captured.track.stops, 1);
  assert.equal(f.windowStream.track.stops, 0); assert.equal(f.intervals.size, 0);
  f.capture.destroy();
});

test('recording limits stop duration and reject oversized chunks without exceeding storage', async () => {
  const f = setup({ maxDurationMs: 1000, maxRecordingBytes: 8, maxTotalBytes: 10, maxRecords: 2 });
  await f.capture.start({ source: 'window' }); Recorder.instances.at(-1).chunk('12345'); f.advance(1000);
  await f.capture.stop(); assert.equal(f.capture.list()[0].stopReason, 'duration-limit');
  assert.equal(f.capture.list()[0].bytes, 8);
  await f.capture.start({ source: 'window' }); Recorder.instances.at(-1).chunk('12');
  Recorder.instances.at(-1).chunk('large chunk'); await f.capture.stop();
  assert.equal(f.capture.list()[1].bytes, 2); assert.equal(f.capture.list()[1].stopReason, 'size-limit');
  assert.equal(f.capture.status().retainedBytes, 10);
  await assert.rejects(f.capture.start(), /discard/);
  assert.equal(f.capture.discard(f.capture.list()[0].id), true);
  assert.equal(f.capture.discard('missing'), false);
  await f.capture.start({ source: 'window' }); await f.capture.stop();
  assert.equal(f.capture.list().length, 2); f.capture.destroy();
});

test('download uses temporary local URLs and discard releases retained recording data', async () => {
  const f = setup(); await f.capture.start({ source: 'window' }); await f.capture.stop();
  const [saved] = f.capture.list(); const metadata = f.capture.download(saved.id);
  assert.equal(metadata.id, saved.id); assert.equal(f.anchors[0].clicked, true);
  assert.match(f.anchors[0].href, /^blob:/); assert.equal(f.anchors[0].download, saved.filename);
  for (const fn of f.timeouts.values()) fn();
  assert.deepEqual(f.revoked, [f.anchors[0].href]);
  f.capture.discard(saved.id); assert.equal(f.capture.status().retainedBytes, 0);
  assert.throws(() => f.capture.download(saved.id), /not found/);
  f.capture.destroy();
});

test('destroy finalizes active capture and retains no recordings or shared-track ownership', async () => {
  const f = setup(); await f.capture.start({ source: 'window' }); Recorder.instances.at(-1).chunk();
  const stop = f.capture.stop(); f.capture.destroy(); await stop;
  assert.equal(f.capture.status().state, 'destroyed'); assert.equal(f.capture.list().length, 0);
  assert.equal(f.intervals.size, 0); assert.equal(f.windowStream.track.stops, 0);
  await assert.rejects(f.capture.snapshot(), /closed/); await assert.rejects(f.capture.start(), /closed/);
});

test('MediaRecorder setup failure releases compositor tracks and leaves capture idle', async () => {
  class BrokenRecorder extends Recorder { start() { throw new Error('codec failed'); } }
  const f = setup({ MediaRecorder: BrokenRecorder });
  await assert.rejects(f.capture.start(), /codec failed/);
  assert.equal(f.capture.status().state, 'idle'); assert.equal(f.canvases[0].captured.track.stops, 1);
  assert.equal(f.intervals.size, 0); f.capture.destroy();
});

test('external images and PlantUML are omitted from the safe compositor', async () => {
  const f = setup();
  f.board.listEntities = () => [
    { id: 'external', type: 'image', url: 'https://external.invalid/picture.png', width: 300, height: 200 },
    { id: 'plant', type: 'diagram', language: 'plantuml', width: 300, height: 200 },
  ];
  await f.capture.snapshot();
  assert.equal(f.capture.assets.size, 0);
  assert.equal(f.calls.some(call => call[0] === 'drawImage'), false);
  assert.ok(f.calls.some(call => call[0] === 'fillText' && call[1].includes('external image')));
  f.capture.destroy();
});

test('safe inline images render, pending image loads are canceled, and asset timers are cleaned', async () => {
  const images = [];
  class Image {
    constructor() { this.naturalWidth = 400; this.naturalHeight = 200; images.push(this); }
    set src(value) { this.url = value; }
  }
  const f = setup({ Image });
  f.board.listEntities = () => [{ id: 'inline', type: 'image', url: 'data:image/png;base64,aW1hZ2U=', width: 300, height: 200 }];
  const pending = f.capture.snapshot();
  assert.equal(images.length, 1); images[0].onload(); await pending;
  assert.ok(f.calls.some(call => call[0] === 'drawImage' && call[1] === images[0]));
  assert.equal(f.timeouts.size, 0);
  f.board.listEntities = () => [{ id: 'inline', type: 'image', url: 'data:image/png;base64,bmV3', width: 300, height: 200 }];
  const loading = f.capture.snapshot(); assert.equal(images.length, 2);
  f.capture.destroy();
  await assert.rejects(loading, /closed/);
  assert.equal(f.timeouts.size, 0); assert.equal(images[1].onload, null);
});

test('SVG diagram rasterization removes active content and external links while preserving local markers', () => {
  class Node {
    constructor(tagName, attributes = {}, textContent = '') { this.tagName = tagName; this.attrs = new Map(Object.entries(attributes)); this.textContent = textContent; }
    get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
    removeAttribute(name) { this.attrs.delete(name); }
    getAttribute(name) { return this.attrs.get(name); }
    setAttribute(name, value) { this.attrs.set(name, value); }
    remove() { this.removed = true; }
  }
  const unsafe = new Node('image'), external = new Node('use', { href: 'https://invalid/image.svg', onclick: 'bad()' });
  const local = new Node('path', { 'marker-end': 'url("#arrow")', fill: "url('#gradient')" });
  const css = new Node('style', {}, '@import "https://invalid/style.css";');
  const root = new Node('svg', { viewBox: '0 0 320 200' });
  root.querySelectorAll = selector => selector === '*' ? [external, local, css] : [unsafe];
  const f = setup({ XMLSerializer: class { serializeToString() { return 'safe SVG'; } } });
  assert.equal(f.capture._svgSource({ cloneNode: () => root }), 'safe SVG');
  assert.equal(unsafe.removed, true); assert.equal(css.removed, true);
  assert.equal(external.attrs.size, 0);
  assert.equal(local.attrs.get('marker-end'), 'url("#arrow")'); assert.equal(local.attrs.get('fill'), "url('#gradient')");
  assert.equal(root.attrs.get('width'), '320'); assert.equal(root.attrs.get('height'), '200');
  f.capture.destroy();
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('stop cancels a pending asset wait immediately and a stale start cannot stop a newer recording', async () => {
  const f = setup(); const assets = deferred();
  f.capture._prepareAssets = () => assets.promise;
  const oldStart = f.capture.start({ source: 'canvas' });
  assert.equal(f.capture.status().state, 'starting');
  const stopping = f.capture.stop(); assert.equal(f.capture.status().state, 'idle');
  // Start synchronously before the canceled async call reaches its catch handler.
  const newerStart = f.capture.start({ source: 'window' });
  const newer = await newerStart;
  assert.equal(await stopping, null);
  const recorder = Recorder.instances.at(-1);
  await assert.rejects(oldStart, /canceled/);
  assert.equal(f.capture.status().state, 'recording'); assert.equal(f.capture.status().id, newer.id);
  assert.equal(recorder.state, 'recording'); assert.equal(f.windowStream.track.stops, 0);
  assets.resolve(); await Promise.resolve();
  assert.equal(f.capture.status().id, newer.id); assert.equal(f.canvases[0].fps, undefined);
  await f.capture.stop(); assert.equal(f.capture.list().length, 1); f.capture.destroy();
});

test('session identity changes during pending canvas setup prevent recording the previous board', async () => {
  const f = setup(); const assets = deferred(); let board = f.board;
  f.capture.getBoard = () => board; f.capture._prepareAssets = () => assets.promise;
  const start = f.capture.start();
  board = { ...f.board }; assets.resolve();
  await assert.rejects(start, /session, or its source changed/);
  assert.equal(f.capture.status().state, 'idle'); assert.equal(f.canvases[0].fps, undefined);
  assert.equal(f.capture.list().length, 0); f.capture.destroy();
});

test('revoked access is rechecked after assets load and before a recorder can be constructed', async () => {
  const f = setup(); const assets = deferred(); let allowed = true;
  f.capture._prepareAssets = () => assets.promise;
  const count = Recorder.instances.length;
  const start = f.capture.start({ isAllowed: () => allowed });
  allowed = false; assets.resolve();
  await assert.rejects(start, /access/);
  assert.equal(Recorder.instances.length, count);
  assert.equal(f.canvases[0].fps, undefined); assert.equal(f.capture.status().state, 'idle'); f.capture.destroy();
});

test('destroy wakes pending asset setup without allowing a late recorder to start', async () => {
  const f = setup(); const assets = deferred(); f.capture._prepareAssets = () => assets.promise;
  const count = Recorder.instances.length;
  const start = f.capture.start(); f.capture.destroy();
  await assert.rejects(start, /closed/);
  assert.equal(f.capture.status().state, 'destroyed');
  assets.resolve(); await Promise.resolve();
  assert.equal(Recorder.instances.length, count); assert.equal(f.intervals.size, 0);
});

test('access is checked again after recorder construction without stopping the user screen stream', async () => {
  let allowed = true;
  class RevokingRecorder extends Recorder { constructor(...args) { super(...args); allowed = false; } }
  const f = setup({ MediaRecorder: RevokingRecorder });
  await assert.rejects(f.capture.start({ source: 'window', isAllowed: () => allowed }), /access/);
  assert.equal(Recorder.instances.at(-1).state, 'inactive');
  assert.equal(f.capture.status().state, 'idle'); assert.equal(f.windowStream.track.stops, 0);
  f.capture.destroy();
});

test('canvas setup canceled after acquiring its own stream releases only that pending stream', async () => {
  let allowed = true;
  class RevokingRecorder extends Recorder { constructor(...args) { super(...args); allowed = false; } }
  const f = setup({ MediaRecorder: RevokingRecorder });
  await assert.rejects(f.capture.start({ isAllowed: () => allowed }), /access/);
  assert.equal(f.canvases[0].captured.track.stops, 1);
  assert.equal(f.windowStream.track.stops, 0); assert.equal(f.intervals.size, 0); f.capture.destroy();
});

test('initial canvas snapshots await diagram readiness before rasterizing or drawing', async () => {
  const f = setup(); const ready = deferred(); const order = [];
  f.board.whenReadyForCapture = () => ready.promise.then(() => order.push('ready'));
  f.capture._prepareAssets = async () => { order.push('assets'); };
  f.capture._drawFrame = () => { order.push('draw'); };
  const snapshot = f.capture.snapshot();
  assert.deepEqual(order, []);
  ready.resolve(); await snapshot;
  assert.deepEqual(order, ['ready', 'assets', 'draw']); f.capture.destroy();
});

test('recording startup can be canceled immediately while diagrams are rendering', async () => {
  const f = setup(); const ready = deferred(); let assets = 0;
  f.board.whenReadyForCapture = () => ready.promise;
  f.capture._prepareAssets = async () => { assets++; };
  const count = Recorder.instances.length;
  const start = f.capture.start();
  const stopping = f.capture.stop(); await assert.rejects(start, /canceled/); await stopping;
  assert.equal(f.capture.status().state, 'idle'); assert.equal(assets, 0);
  ready.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(assets, 0); assert.equal(Recorder.instances.length, count); f.capture.destroy();
});

test('snapshots revoked during diagram readiness never draw, prepare assets, or download', async () => {
  const f = setup(); const ready = deferred(); let allowed = true, assets = 0;
  f.board.whenReadyForCapture = () => ready.promise;
  f.capture._prepareAssets = async () => { assets++; };
  const snapshot = f.capture.snapshot({ download: true, isAllowed: () => allowed });
  allowed = false; ready.resolve();
  await assert.rejects(snapshot, /canceled/);
  assert.equal(assets, 0); assert.equal(f.calls.length, 0); assert.equal(f.anchors.length, 0); f.capture.destroy();
});

test('snapshots revoked during image loading never draw or trigger a local download', async () => {
  const f = setup(); const assets = deferred(); let allowed = true;
  f.capture._prepareAssets = () => assets.promise;
  const snapshot = f.capture.snapshot({ download: true, isAllowed: () => allowed });
  allowed = false; assets.resolve();
  await assert.rejects(snapshot, /canceled/);
  assert.equal(f.calls.length, 0); assert.equal(f.anchors.length, 0); f.capture.destroy();
});

test('snapshots reject replacement boards and recheck access before file download', async () => {
  const f = setup(); const assets = deferred(); let board = f.board;
  f.capture.getBoard = () => board; f.capture._prepareAssets = () => assets.promise;
  const snapshot = f.capture.snapshot({ download: true }); board = { ...board }; assets.resolve();
  await assert.rejects(snapshot, /session changed/); assert.equal(f.anchors.length, 0); assert.equal(f.calls.length, 0);
  f.capture._prepareAssets = async () => {};
  let allowed = true;
  const next = f.capture.snapshot({ download: true, isAllowed: () => allowed });
  f.canvases.at(-1).toDataURL = () => { allowed = false; return 'data:image/png;base64,private'; };
  await assert.rejects(next, /canceled/); assert.equal(f.anchors.length, 0); f.capture.destroy();
});

test('manual snapshots reject a session change even when the same Board instance is reused', async () => {
  let session = { room: 'first' };
  const f = setup({ getSession: () => session }); const assets = deferred();
  f.capture._prepareAssets = () => assets.promise;
  const snapshot = f.capture.snapshot({ download: true });
  session = { room: 'second' }; assets.resolve();
  await assert.rejects(snapshot, /session changed/);
  assert.equal(f.capture.getBoard(), f.board);
  assert.equal(f.calls.length, 0); assert.equal(f.anchors.length, 0); f.capture.destroy();
});

test('manual recording startup rejects changed session identity on a reused Board', async () => {
  let session = { room: 'first' };
  const f = setup({ getSession: () => session }); const ready = deferred();
  f.board.whenReadyForCapture = () => ready.promise;
  const recording = f.capture.start(); session = { room: 'second' }; ready.resolve();
  await assert.rejects(recording, /session, or its source changed/);
  assert.equal(f.canvases[0].fps, undefined); assert.equal(f.capture.status().state, 'idle'); f.capture.destroy();
});
