import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startMediaWorker, parseMediaArgs } from '../scripts/media-worker.mjs';
import { LocalMediaEngine, validateWalkthrough, MEDIA_LIMITS } from '../media/engine.mjs';
import { LocalMediaExport } from '../src/media-export.js';
import { pngDataUrl } from '../media/fixtures.mjs';

const origin = 'http://localhost:5173'; const token = 'b'.repeat(43);
const hasFFmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() })); });
    req.on('error', reject); req.end(body);
  });
}
const headers = { Origin: origin, Authorization: `Bearer ${token}` };

test('local worker configuration requires explicit origins, strong tokens and valid CLI flags', async () => {
  assert.deepEqual(parseMediaArgs(['--origin', origin, '--engine', 'docker', '--port', '8789']), { origins: [origin], engine: 'docker', port: 8789 });
  for (const args of [[], ['--origin'], ['--host', '0.0.0.0'], ['--origin', origin, '--port', '1'], ['--origin', origin, '--engine', 'shell']]) assert.throws(() => parseMediaArgs(args));
  await assert.rejects(startMediaWorker({ origins: [] }), /explicit/);
  await assert.rejects(startMediaWorker({ origins: ['http://evil.example'], checkEngine: false }), /HTTPS|localhost/);
  await assert.rejects(startMediaWorker({ origins: [origin], token: 'weak', checkEngine: false }), /random/);
});

test('loopback worker rejects unauthenticated requests, unapproved origins, rebinding hosts and oversized uploads before processing', async t => {
  let calls = 0;
  const worker = await startMediaWorker({ port: 0, origins: [origin], token, checkEngine: false, engine: { engine: 'test', exportRecording: async () => { calls++; throw new Error('Should not run'); } } });
  t.after(() => worker.close());
  assert.equal(worker.server.address().address, '127.0.0.1');
  for (const bad of [{}, { Origin: 'null', Authorization: `Bearer ${token}` }, { Origin: 'https://evil.example', Authorization: `Bearer ${token}` }, { ...headers, Host: 'rebound.example' }]) {
    const response = await request(`${worker.url}/health`, { headers: bad }); assert.equal(response.status, 403); assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const unauthorized = await request(`${worker.url}/health`, { headers: { Origin: origin } }); assert.equal(unauthorized.status, 401);
  const wrong = await request(`${worker.url}/health`, { headers: { ...headers, Authorization: `Bearer ${'c'.repeat(43)}` } }); assert.equal(wrong.status, 401);
  const healthy = await request(`${worker.url}/health`, { headers }); assert.equal(healthy.status, 200);
  assert.equal(JSON.parse(healthy.text).version, 1); assert.ok(!healthy.text.includes(token)); assert.equal(healthy.headers['cache-control'], 'no-store');
  const tooLarge = await request(`${worker.url}/v1/recording`, { method: 'POST', headers: { ...headers, 'Content-Type': 'video/webm', 'Content-Length': MEDIA_LIMITS.recordingBytes + 1 } }); assert.equal(tooLarge.status, 413);
  const urlInput = await request(`${worker.url}/v1/recording`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"url":"file:///etc/passwd"}' }); assert.equal(urlInput.status, 415);
  assert.equal(calls, 0);
});

test('CORS preflight grants only configured app origins and explicit local-network access', async t => {
  const worker = await startMediaWorker({ port: 0, origins: [origin], token, checkEngine: false, engine: {} }); t.after(() => worker.close());
  const good = await request(`${worker.url}/v1/walkthrough`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(good.status, 204); assert.equal(good.headers['access-control-allow-origin'], origin); assert.equal(good.headers['access-control-allow-private-network'], 'true');
  assert.ok(good.headers['access-control-allow-headers'].includes('Authorization'));
  for (const bad of [{ Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }, { Origin: origin, 'Access-Control-Request-Method': 'DELETE' }, { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-command' }]) assert.equal((await request(`${worker.url}/v1/recording`, { method: 'OPTIONS', headers: bad })).status, 403);
});

test('walkthrough validation rejects remote resources, unknown commands, image bombs and unbounded durations', () => {
  const frame = { dataUrl: pngDataUrl(), durationMs: 1000 };
  assert.equal(validateWalkthrough({ frames: [frame] }).durationMs, 1000);
  for (const spec of [
    { frames: [frame], command: 'ffmpeg -i remote' }, { frames: [{ ...frame, url: 'https://example.com/image.png' }] },
    { frames: [{ ...frame, dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }] }, { frames: [{ ...frame, dataUrl: 'https://example.com/image.png' }] },
    { frames: [{ ...frame, durationMs: 499 }] }, { frames: Array.from({ length: 11 }, () => ({ ...frame, durationMs: 30000 })) },
    { frames: [frame], width: 3840, height: 2160 }, { frames: [frame], width: 321, height: 180 },
  ]) assert.throws(() => validateWalkthrough(spec));
  const bomb = Buffer.from(frame.dataUrl.split(',')[1], 'base64'); bomb.writeUInt32BE(100000, 16);
  assert.throws(() => validateWalkthrough({ frames: [{ dataUrl: `data:image/png;base64,${bomb.toString('base64')}` }] }), /megapixel/);
});

test('one local job runs at a time and client cancellation propagates to its processor', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; }); let canceled = false;
  const worker = await startMediaWorker({ port: 0, origins: [origin], token, checkEngine: false, engine: { engine: 'test', exportRecording: async (bytes, { signal }) => { entered(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => { canceled = true; reject(new Error('canceled')); }, { once: true })); } } }); t.after(() => worker.close());
  const abort = new AbortController();
  const first = fetch(`${worker.url}/v1/recording`, { method: 'POST', headers: { ...headers, 'Content-Type': 'video/webm' }, body: new Uint8Array([1, 2, 3]), signal: abort.signal });
  await started;
  const second = await request(`${worker.url}/v1/recording`, { method: 'POST', headers: { ...headers, 'Content-Type': 'video/webm' }, body: 'x' }); assert.equal(second.status, 409);
  assert.equal(JSON.parse((await request(`${worker.url}/health`, { headers })).text).busy, true);
  abort.abort(); await assert.rejects(first, /abort/i);
  for (let attempt = 0; attempt < 30 && !canceled; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(canceled, true);
});

test('native media subprocess deadlines and cancellation terminate work', async () => {
  const engine = new LocalMediaEngine({ ffmpeg: process.execPath });
  await assert.rejects(engine.run('ffmpeg', ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 100 }), error => error.code === 'MEDIA_TIMEOUT');
  const abort = new AbortController();
  const pending = engine.run('ffmpeg', ['-e', 'setTimeout(()=>{},10000)'], { signal: abort.signal }); abort.abort();
  await assert.rejects(pending, error => error.code === 'CANCELED');
});

test('real local HTTP worker exports WebM recordings and ordered annotated PNG frames to playable H.264 MP4', { skip: !hasFFmpeg, timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'common-export-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new LocalMediaEngine();
  const worker = await startMediaWorker({ port: 0, origins: [origin], token, engine }); t.after(() => worker.close());
  const client = new LocalMediaExport({ endpoint: worker.url, token, fetch: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Origin: origin } }) }); t.after(() => client.destroy());
  assert.equal((await client.capabilities()).engine, 'ffmpeg-native');
  await engine.run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=12', '-t', '0.6', '-an', '-c:v', 'libvpx', '-b:v', '100k', 'sample.webm'], { directory });
  const recording = await client.exportRecording(new Blob([await readFile(join(directory, 'sample.webm'))], { type: 'video/webm' }));
  assert.equal(recording.width, 64); assert.equal(recording.height, 64); assert.ok(recording.durationMs >= 500 && recording.durationMs <= 1000); assert.ok(recording.blob.size > 1000);
  assert.match(recording.filename, /^common-recording-.*\.mp4$/);

  const walkthrough = await client.exportWalkthrough({ width: 320, height: 180, frames: [{ dataUrl: pngDataUrl({ color: [220, 20, 20], annotation: true }), durationMs: 500 }, { dataUrl: pngDataUrl({ color: [20, 200, 20], annotation: true }), durationMs: 500 }] });
  assert.equal(walkthrough.width, 320); assert.equal(walkthrough.height, 180); assert.ok(walkthrough.durationMs >= 950 && walkthrough.durationMs <= 1100);
  await writeFile(join(directory, 'slides.mp4'), new Uint8Array(await walkthrough.blob.arrayBuffer()));
  for (const [time, dominant] of [['0.1', 0], ['0.7', 1]]) {
    const pixel = await engine.run('ffmpeg', ['-v', 'error', '-nostdin', '-ss', time, '-i', 'slides.mp4', '-vf', 'crop=100:100:110:0,scale=1:1,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { directory });
    assert.equal(pixel.length, 3); assert.ok(pixel[dominant] > 150 && pixel[dominant] > pixel[1 - dominant] * 2, `frame at ${time}s preserves the correct slide color`);
  }
  const captioned = await client.exportWalkthrough({ width: 320, height: 180, frames: [{ dataUrl: pngDataUrl(), durationMs: 500, title: 'A real annotation', text: "Literal text: %{metadata:secret}; 'quotes' and \\paths stay text." }] });
  assert.ok(captioned.blob.size > 2000, 'the caption pipeline must also encode real frames');
  const unsupported = await fetch(`${worker.url}/v1/recording`, { method: 'POST', headers: { ...headers, 'Content-Type': 'video/webm' }, body: '<html>not video</html>' }); assert.equal(unsupported.status, 415);
});
