import { writeAgentManifest } from './build-agent-manifest.mjs';
import { projectRoot } from './local-runtime.mjs';
import { buildGeometry } from './build-wasm.mjs';

await writeAgentManifest();
await buildGeometry();
const { build } = await import('vite');
await build({ root: projectRoot });
