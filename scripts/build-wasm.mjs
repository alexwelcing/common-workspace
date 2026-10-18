import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import wabtFactory from 'wabt';

const sourceUrl = new URL('../geometry.wat', import.meta.url);
const outputUrl = new URL('../src/geometry.wasm', import.meta.url);
export async function buildGeometry() {
  const wabt = await wabtFactory();
  const source = await readFile(sourceUrl, 'utf8');
  const module = wabt.parseWat(fileURLToPath(sourceUrl), source);

  try {
    module.resolveNames();
    module.validate();
    const { buffer } = module.toBinary({ canonicalize_lebs: true, write_debug_names: false });
    await writeFile(outputUrl, buffer);
    console.log(`Built src/geometry.wasm (${buffer.byteLength} bytes)`);
  } finally {
    module.destroy();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildGeometry();
