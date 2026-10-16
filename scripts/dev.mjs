import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import './build-wasm.mjs';
const api=spawn(process.execPath,['server.mjs'],{stdio:'inherit',env:{...process.env,PORT:'3001'}});
const vite=await createServer(); await vite.listen(); vite.printUrls();
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{api.kill(signal);await vite.close();process.exit(0)});
