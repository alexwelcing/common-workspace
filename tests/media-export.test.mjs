import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalMediaExport, localMediaEndpoint } from '../src/media-export.js';

const token = 'a'.repeat(43);
const video = () => new Response(new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112]), { headers: { 'content-type': 'video/mp4', 'content-disposition': 'attachment; filename="common-walkthrough-123.mp4"', 'x-media-width': '1280', 'x-media-height': '720', 'x-media-duration-ms': '6000', 'x-media-engine': 'ffmpeg-native' } });

test('local export accepts only explicit loopback endpoints and keeps credentials out of URLs and storage', async () => {
  for (const value of ['https://example.com', 'http://127.0.0.1.evil.test', 'http://0.0.0.0:8788', 'http://127.0.0.1:8788/path', 'http://user:pass@localhost:8788', 'http://localhost:8788/?token=secret', 'file:///tmp/export']) assert.throws(() => localMediaEndpoint(value), /loopback|valid local/);
  assert.equal(localMediaEndpoint('http://localhost:8788/'), 'http://localhost:8788');
  assert.equal(localMediaEndpoint('http://[::1]:8788'), 'http://[::1]:8788');
  assert.throws(() => new LocalMediaExport({ token: 'weak' }), /session token/);
  const requests = [];
  const client = new LocalMediaExport({ token, fetch: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ version: 1, formats: ['mp4'] }), { headers: { 'content-type': 'application/json' } }); } });
  assert.equal((await client.capabilities()).version, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:8788/v1/capabilities');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[0].options.credentials, 'omit'); assert.equal(requests[0].options.cache, 'no-store'); assert.equal(requests[0].options.redirect, 'error');
  assert.ok(!requests[0].url.includes(token)); client.destroy(); assert.equal(client.token, '');
  await assert.rejects(client.capabilities(), /disconnected/);
});

test('recording and walkthrough exports send bounded local payloads and return real downloadable Blob metadata', async () => {
  const requests = [];
  const client = new LocalMediaExport({ token, fetch: async (url, options) => { requests.push({ url, options }); return video(); } });
  const source = new Blob(['webm'], { type: 'video/webm;codecs=vp8' });
  const result = await client.exportRecording(source);
  assert.equal(requests[0].options.body, source); assert.equal(requests[0].options.headers['Content-Type'], 'video/webm');
  assert.equal(result.blob.type, 'video/mp4'); assert.equal(result.blob.size, 8);
  assert.deepEqual({ ...result, blob: undefined }, { blob: undefined, filename: 'common-walkthrough-123.mp4', mimeType: 'video/mp4', width: 1280, height: 720, durationMs: 6000, engine: 'ffmpeg-native' });
  const frames = [{ dataUrl: 'data:image/png;base64,image', durationMs: 3000, title: 'Step one' }];
  await client.exportWalkthrough({ frames, width: 1280, height: 720 });
  assert.deepEqual(JSON.parse(requests[1].options.body).frames, frames);
  assert.equal(requests[1].options.headers['Content-Type'], 'application/json');
  assert.throws(() => client.exportRecording(new Blob()), /100 MB/);
  assert.throws(() => client.exportRecording(new Blob(['bad'], { type: 'text/html' })), /WebM and MP4/);
  assert.throws(() => client.exportWalkthrough({ frames: [] }), /between 1 and 50/);
  client.destroy();
});

test('local exports surface worker errors and bound untrusted result headers and streaming chunks', async () => {
  const denied = new LocalMediaExport({ token, fetch: async () => new Response(JSON.stringify({ error: 'Origin denied', code: 'ORIGIN_DENIED' }), { status: 403, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(denied.capabilities(), error => error.status === 403 && error.code === 'ORIGIN_DENIED'); denied.destroy();
  const oversized = new LocalMediaExport({ token, fetch: async () => new Response('x', { headers: { 'content-type': 'video/mp4', 'content-length': String(101 * 1024 * 1024) } }) });
  await assert.rejects(oversized.exportRecording(new Blob(['x'], { type: 'video/webm' })), /download size/); oversized.destroy();
  let canceled = false, released = false;
  const streaming = new LocalMediaExport({ token, fetch: async () => ({ ok: true, headers: new Headers({ 'content-type': 'video/mp4' }), body: { getReader: () => ({ read: async () => ({ value: { byteLength: 101 * 1024 * 1024 }, done: false }), cancel: async () => { canceled = true; }, releaseLock: () => { released = true; } }) } }) });
  await assert.rejects(streaming.exportRecording(new Blob(['x'], { type: 'video/mp4' })), /download size/);
  assert.equal(canceled, true); assert.equal(released, true); streaming.destroy();
});

test('disconnecting or canceling the client aborts in-flight exports and does not retain the token', async () => {
  let observedSignal;
  const client = new LocalMediaExport({ token, fetch: (url, options) => new Promise((resolve, reject) => { observedSignal = options.signal; options.signal.addEventListener('abort', () => reject(options.signal.reason)); }) });
  const pending = client.exportRecording(new Blob(['x'], { type: 'video/webm' }));
  client.destroy(); assert.equal(observedSignal.aborted, true);
  await assert.rejects(pending, /disconnected/); assert.equal(client.pending.size, 0); assert.equal(client.token, '');
  const signal = new AbortController(); signal.abort(new Error('User canceled'));
  const unused = new LocalMediaExport({ token, fetch: () => { throw new Error('Must not fetch'); } });
  await assert.rejects(unused.capabilities({ signal: signal.signal }), /User canceled/); unused.destroy();
});
