import { readFile, readdir, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAgentManifest } from './build-agent-manifest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'module-dist');
const packages = new Set();

async function notices() {
  const sections = ['Third-party notices for the bundled Common application.\nDM Sans is distributed under the SIL Open Font License; see app/fonts/OFL-DM-Sans.txt.'];
  for (const directory of [...packages].sort()) {
    const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const files = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name));
    const heading = `${info.name}@${info.version} — ${typeof info.license === 'string' ? info.license : 'see license text'}`;
    const contents = [];
    for (const name of files.sort()) {
      try { contents.push(`${name}\n${await readFile(path.join(directory, name), 'utf8')}`); } catch { /* A package can use a directory of notices. */ }
    }
    if (!contents.length) console.warn(`Module notice: ${info.name} has no top-level license text; review its declared ${info.license || 'unspecified'} license before redistribution.`);
    sections.push(`${heading}\n${'='.repeat(heading.length)}\n${contents.join('\n')}`);
  }
  return `${sections.join('\n\n')}\n`;
}

async function bundle(entrypoint, filename, target) {
  const result = await Bun.build({ entrypoints: [path.join(root, entrypoint)], target, format: 'esm', minify: false, splitting: false });
  if (!result.success) throw new AggregateError(result.logs, `Cannot build ${entrypoint}.`);
  if (result.outputs.length !== 1) throw new Error(`Expected one self-contained ${target} entry point.`);
  await writeFile(path.join(output, filename), await result.outputs[0].text());
}

export async function buildModule() {
  if (!globalThis.Bun?.build) throw new Error('Build the module with Bun: bun run build:module.');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeAgentManifest();
  await import('./build-wasm.mjs');
  const { build } = await import('vite');
  await build({
    root, base: './',
    build: { outDir: path.join(output, 'app'), emptyOutDir: true },
    plugins: [{
      name: 'common-module-notices',
      generateBundle(_options, chunks) {
        for (const chunk of Object.values(chunks)) for (const id of Object.keys(chunk.modules || {})) {
          const clean = id.replace(/^\0/, '').split('?')[0];
          const marker = clean.lastIndexOf('/node_modules/');
          if (marker < 0) continue;
          const parts = clean.slice(marker + 14).split('/');
          const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
          packages.add(`${clean.slice(0, marker + 14)}${name}`);
        }
      },
    }],
  });
  await bundle('sdk/client.js', 'client.js', 'browser');
  await bundle('sdk/bun.mjs', 'bun.mjs', 'bun');
  for (const filename of ['client.d.ts', 'bun.d.ts']) await copyFile(path.join(root, 'sdk', filename), path.join(output, filename));
  await copyFile(path.join(root, 'module/package.json'), path.join(output, 'package.json'));
  await copyFile(path.join(root, 'docs/embedding.md'), path.join(output, 'README.md'));
  await writeFile(path.join(output, 'THIRD_PARTY_NOTICES.txt'), await notices());
  console.log(`Common module built at ${output}. It includes its frontend assets and needs no runtime npm dependencies.`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildModule();
