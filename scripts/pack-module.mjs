import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModule } from './build-module.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await buildModule();
const artifactDir = path.join(root, 'artifacts');
await mkdir(artifactDir, { recursive: true });
const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
const filename = `${info.name.replace(/^@/, '').replaceAll('/', '-')}-${info.version}.tgz`;
const target = path.join(artifactDir, filename);
const staging = await mkdtemp(path.join(artifactDir, '.common-pack-'));
const stagedArchive = path.join(staging, filename);
try {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['pm', 'pack', '--filename', stagedArchive], { cwd: directory, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Module packaging failed (${signal || code}).`)));
  });
  const sha256 = createHash('sha256').update(await readFile(stagedArchive)).digest('hex');
  await writeFile(`${stagedArchive}.sha256`, `${sha256}  ${filename}\n`);
  await rename(stagedArchive, target);
  await rename(`${stagedArchive}.sha256`, `${target}.sha256`);
  console.log(`\nInstall in your Bun app: bun add ${target}\nSHA-256: ${sha256}`);
} finally { await rm(staging, { recursive: true, force: true }); }
