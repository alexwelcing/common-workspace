import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateRaw } from 'pako';
import { initGeometry, geometryBackend, snap, simplifyPoints } from '../src/geometry.js';
import { plantUmlUrl } from '../src/diagrams.js';

test('the compiled WebAssembly kernel performs real geometry calculations', async () => {
  const bytes = await readFile(new URL('../src/geometry.wasm', import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  const kernel = instance.exports;
  assert.equal(kernel.snap_grid(31, 20), 40);
  assert.equal(kernel.snap_grid(-31, 20), -40);
  assert.equal(kernel.point_segment_distance_sq(5, 3, 0, 0, 10, 0), 9);
  assert.equal(kernel.point_segment_distance_sq(15, 3, 0, 0, 10, 0), 34);
  assert.equal(kernel.point_segment_distance_sq(3, 4, 0, 0, 0, 0), 25);
  assert.equal(kernel.point_in_box(10, 10, 20, 20, -20, -20), 1);
  assert.equal(kernel.point_in_box(30, 10, 0, 0, 20, 20), 0);

  assert.equal(await initGeometry(bytes), true);
  assert.equal(geometryBackend(), 'wasm');
  assert.equal(snap(29), 20);
  assert.equal(snap(-10), 0);
  assert.equal(snap(31, -20), 40);
  assert.equal(snap(31, 0), 31);
});

test('path simplification preserves meaningful corners without mutating input', () => {
  const points = [[0, 0], [5, 0.5], [10, 0], [10, 10], [10, 20]];
  const before = structuredClone(points);
  assert.deepEqual(simplifyPoints(points, 1), [[0, 0], [10, 0], [10, 20]]);
  assert.deepEqual(points, before);
  assert.notEqual(simplifyPoints(points, 1)[0], points[0]);
  assert.deepEqual(simplifyPoints([[0, 0], [3, 4], [0, 0]], 1), [[0, 0], [3, 4], [0, 0]]);
  assert.deepEqual(simplifyPoints([[0, 0], [Number.NaN, 0], [1, 1]]), [[0, 0], [1, 1]]);
});

test('PlantUML URLs losslessly encode Unicode source using raw DEFLATE', () => {
  const source = '@startuml\nAlice -> Bob: Hello, 世界\n@enduml';
  const url = plantUmlUrl(source);
  assert.ok(url.startsWith('https://www.plantuml.com/plantuml/svg/'));
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const encoded = url.split('/svg/')[1];
  const decode = (text) => {
    const standardBase64 = [...text].map((character) => base64[alphabet.indexOf(character)]).join('');
    return inflateRaw(Buffer.from(standardBase64, 'base64'), { to: 'string' });
  };
  assert.equal(decode(encoded), source);
  // The same independent decoder accepts the official documentation's vector.
  // Different DEFLATE libraries can generate different valid compressed bytes.
  assert.equal(decode('Syp9J4vLqBLJSCfFib9mB2t9ICqhoKnEBCdCprC8IYqiJIqkuGBAAUW2rO0LOr5LN92VLvpA1G00'),
    'Alice -> Bob: Authentication Request\nBob --> Alice: Authentication Response\n');
  assert.throws(() => plantUmlUrl('!includeurl https://example.com/remote.puml'), /disabled/);
  assert.throws(() => plantUmlUrl('!include <C4/C4_Context>'), /disabled/);
  assert.throws(() => plantUmlUrl('!includesub https://example.com/remote.puml!PART'), /disabled/);
  assert.throws(() => plantUmlUrl('!import private.puml'), /disabled/);
  assert.throws(() => plantUmlUrl('%load_json("https://example.com")'), /disabled/);
  assert.throws(() => plantUmlUrl('x'.repeat(20_001)), /20,000/);
  assert.throws(() => plantUmlUrl(' '), /Enter diagram/);
});
