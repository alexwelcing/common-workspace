import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scopes = {
  canvas: ['geometry', 'shared-canvas', 'peer-canvas', 'peer-topology', 'board-subscriptions', 'screen-subscriptions', 'walkthrough'],
  sessions: ['protocol', 'server', 'session-transport'],
  hosted: ['netlify-api'],
  media: ['capture', 'media-data', 'media-ice', 'media-subscriptions', 'media-export', 'media-worker'],
  agents: ['agent-api', 'agent-ui', 'webmcp', 'walkthrough'],
  runtime: ['dev', 'runtime-config', 'observability'],
};
const usage = `Run deeper checks explicitly for the area you changed.

Usage: bun run check:deep <scope> [scope ...]
Scopes: ${[...Object.keys(scopes), 'all'].join(', ')}

Examples:
  bun run check:deep canvas
  bun run check:deep sessions runtime
  bun run check:deep hosted

Hosted and all require COMMON_TEST_DATABASE_URL pointing to a disposable Postgres
database. This command does not create a database or download tools. Media checks
report their real FFmpeg export case as skipped when FFmpeg is unavailable.
`;

const args = process.argv.slice(2);
if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  console.log(usage);
  process.exit(0);
}
const unknown = args.filter(value => value !== 'all' && !Object.hasOwn(scopes, value));
if (unknown.length) {
  console.error(`Unknown check scope. Choose one of: ${[...Object.keys(scopes), 'all'].join(', ')}.\n\n${usage}`);
  process.exit(2);
}
const selected = args.includes('all') ? Object.keys(scopes) : [...new Set(args)];
if (selected.includes('hosted') && !process.env.COMMON_TEST_DATABASE_URL?.trim()) {
  console.error('Hosted checks need COMMON_TEST_DATABASE_URL pointing to a disposable Postgres database.\nNothing ran. Configure the database, or choose a scope such as sessions or canvas.');
  process.exit(2);
}
const files = [...new Set(selected.flatMap(scope => scopes[scope]))].map(name => `./tests/${name}.test.mjs`);
console.log(`Deep checks: ${selected.join(', ')} (${files.length} files)\n${files.join('\n')}\n`);
const child = spawn(process.versions.bun ? process.execPath : 'bun', ['test', ...files], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', env: process.env,
});
const signals = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]));
for (const [signal, handler] of signals) process.on(signal, handler);
child.once('error', () => {
  console.error('Could not start Bun. Install Bun 1.4.3 or newer, then run this command again.');
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  for (const [event, handler] of signals) process.off(event, handler);
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});
