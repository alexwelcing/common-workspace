// A standalone server speaks WebSocket even when the parent environment was
// configured for Netlify's HTTP polling adapter. Keep this choice local to this
// build process; the regular hosted build retains its existing configuration.
process.env.VITE_SESSION_TRANSPORT = 'websocket';
await import('./build-wasm.mjs');
const { build } = await import('vite');
await build();
