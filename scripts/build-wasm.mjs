import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import wabtFactory from 'wabt';

const sourceUrl = new URL('../geometry.wat', import.meta.url);
const outputUrl = new URL('../public/geometry.wasm', import.meta.url);
const wabt = await wabtFactory();
const source = await readFile(sourceUrl, 'utf8');
const module = wabt.parseWat(fileURLToPath(sourceUrl), source);

try {
  module.resolveNames();
  module.validate();
  const { buffer } = module.toBinary({ canonicalize_lebs: true, write_debug_names: false });
  await mkdir(new URL('../public/', import.meta.url), { recursive: true });
  await writeFile(outputUrl, buffer);
  console.log(`Built public/geometry.wasm (${buffer.byteLength} bytes)`);
} finally {
  module.destroy();
}
