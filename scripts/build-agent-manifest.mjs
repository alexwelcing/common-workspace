import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getAgentManifest } from '../src/agent-api.js';

export async function writeAgentManifest() {
  await mkdir(new URL('../public/', import.meta.url), { recursive: true });
  await writeFile(new URL('../public/agent-tools.json', import.meta.url), `${JSON.stringify(getAgentManifest(), null, 2)}\n`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await writeAgentManifest();
