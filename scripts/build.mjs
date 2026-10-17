import { writeAgentManifest } from './build-agent-manifest.mjs';
import { projectRoot } from './local-runtime.mjs';

await writeAgentManifest();
await import('./build-wasm.mjs');
const { build } = await import('vite');
await build({ root: projectRoot });
