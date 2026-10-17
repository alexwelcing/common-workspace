// A real local export exercise with synthetic annotated frames. No room data.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { LocalMediaEngine } from '../media/engine.mjs';
import { pngDataUrl } from '../media/fixtures.mjs';
import { startMediaWorker } from './media-worker.mjs';
import { LocalMediaExport } from '../src/media-export.js';

export async function mediaSmoke({ engine = 'native', output = 'media/artifacts/walkthrough-smoke.mp4' } = {}) {
  const origin = 'http://localhost:5173';
  const worker = await startMediaWorker({ port: 0, origins: [origin], engine: new LocalMediaEngine({ engine }), onEvent: event => console.log(`[media] ${event.kind}: ${event.state}${event.error ? ` · ${event.error.message}` : ''}`) });
  const client = new LocalMediaExport({ endpoint: worker.url, token: worker.token, fetch: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Origin: origin } }) });
  try {
    const result = await client.exportWalkthrough({ width: 640, height: 360, frames: [
      { dataUrl: pngDataUrl({ width: 320, height: 180, color: [86, 119, 91], annotation: true }), durationMs: 1500, title: 'An annotated idea', text: 'The yellow box is baked into this local canvas snapshot.' },
      { dataUrl: pngDataUrl({ width: 320, height: 180, color: [122, 146, 107], annotation: true }), durationMs: 1500, title: 'A shared next step', text: 'Ordered frames become a downloadable H.264 MP4, without a cloud account.' },
    ] });
    const bytes = Buffer.from(await result.blob.arrayBuffer()), file = resolve(output);
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes);
    const manifest = { artifact: file, input: 'Two synthetic PNG frames with raster annotation boxes and text captions', engine: result.engine, codec: 'H.264 / yuv420p / 24 fps', width: result.width, height: result.height, durationMs: result.durationMs, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() };
    await writeFile(`${file}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2)); return manifest;
  } finally { client.destroy(); await worker.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index], value = process.argv[index + 1];
    if (key === '--engine' && ['native', 'docker'].includes(value)) options.engine = value;
    else if (key === '--output' && value) options.output = value;
    else throw new Error('Usage: bun scripts/media-smoke.mjs [--engine native|docker] [--output FILE.mp4]');
  }
  try { await mediaSmoke(options); } catch (error) { console.error(error.message); if (error.diagnostic) console.error(error.diagnostic); process.exitCode = 1; }
}
