import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentAPI, createAgentPermissions } from '../src/agent-api.js';
import { installWebMCP } from '../src/webmcp.js';
import { SharedCanvas } from '../src/shared-canvas.js';

function setup(t, { modelContext, clock } = {}) {
  const context = { enabled: false, connected: true, sandbox: false, room: { id: 'room-one', name: 'One' }, participantId: 'owner', participants: [] };
  const model = new SharedCanvas(); const tools = new Map();
  const permissions = createAgentPermissions({ getContext: () => context, getSession: () => model, ...(clock ? { now: clock } : {}) });
  const board = { readOnly: false, canEdit: () => true, getView: () => ({ zoom: 1, x: 0, y: 0 }), exportSvg: () => '<svg/>' };
  const recording = { status: () => ({ state: 'idle' }), snapshot: async () => ({ dataUrl: 'example' }) };
  const api = createAgentAPI({ getContext: () => context, getModel: () => model, getBoard: () => board, permissions, recording });
  const defaultContext = { async registerTool(tool, { signal }) {
    tools.set(tool.name, tool);
    signal.addEventListener('abort', () => { if (tools.get(tool.name) === tool) tools.delete(tool.name); }, { once: true });
  } };
  const document = { modelContext: modelContext === undefined ? defaultContext : modelContext };
  const adapter = installWebMCP({ api, permissions, document });
  t.after(() => { adapter.destroy(); permissions.destroy(); model.destroy(); });
  return { api, context, model, tools, permissions, adapter, recording, defaultContext };
}

test('WebMCP is optional and the existing browser bridge works when the experimental API is absent', async t => {
  const env = setup(t, { modelContext: null }); env.context.enabled = true; env.permissions.grant();
  await env.adapter.refresh(); assert.equal(env.adapter.status().supported, false);
  assert.equal((await env.api.execute({ action: 'canvas.add', entity: { type: 'text', text: 'Still works' } })).ok, true);
});

test('only granted semantic tools register, invoke the validated command layer, and cannot retag commands', async t => {
  const env = setup(t); await env.adapter.refresh(); assert.equal(env.tools.size, 0);
  env.context.enabled = true; env.permissions.grant({ capabilities: ['inspect'] }); await env.adapter.refresh();
  assert.deepEqual([...env.tools.keys()].sort(), ['common_canvas_export', 'common_canvas_inspect', 'common_canvas_read', 'common_canvas_search']);
  env.permissions.grant(); await env.adapter.refresh();
  const tool = env.tools.get('common_canvas_add'); assert.ok(tool); assert.equal(env.tools.has('common_recording_start'), false);
  const added = JSON.parse(await tool.execute({ entity: { id: 'note', type: 'text', text: 'Useful semantic tool' } }));
  assert.equal(added.ok, true); assert.equal(env.model.get('note').text, 'Useful semantic tool');
  assert.equal(JSON.parse(await tool.execute({ action: 'recording.start', entity: { type: 'text' } })).error.code, 'INVALID_COMMAND');
  let read = false; const args = { get entity() { read = true; return { type: 'text' }; } };
  assert.equal(JSON.parse(await tool.execute(args)).ok, false); assert.equal(read, false);
  env.permissions.revoke(); assert.equal(env.tools.size, 0);
  assert.equal(JSON.parse(await tool.execute({ entity: { type: 'text', text: 'Revoked' } })).error.code, 'ABORTED');
});

test('expiry, disable and session changes immediately unregister tools through the private grant lifecycle', async t => {
  let now = 10000; const env = setup(t, { clock: () => now }); env.context.enabled = true;
  env.permissions.grant({ ttlMs: 1000 }); await env.adapter.refresh(); assert.ok(env.tools.size > 0);
  now = 11001; env.permissions.refresh(); assert.equal(env.tools.size, 0);
  env.permissions.grant(); await env.adapter.refresh(); assert.ok(env.tools.size > 0);
  env.context.room.id = 'other'; env.permissions.refresh(); assert.equal(env.tools.size, 0);
  env.permissions.grant(); await env.adapter.refresh(); assert.ok(env.tools.size > 0);
  env.context.enabled = false; env.permissions.refresh(); assert.equal(env.tools.size, 0);
});

test('revocation during asynchronous tool registration never leaves stale tools registered', async t => {
  let release; let signalStarted; const started = new Promise(resolve => { signalStarted = resolve; });
  const tools = new Map(); let first = true;
  const env = setup(t, { modelContext: { async registerTool(tool, { signal }) {
    tools.set(tool.name, tool); signal.addEventListener('abort', () => tools.delete(tool.name), { once: true });
    if (first) { first = false; signalStarted(); await new Promise(resolve => { release = resolve; }); }
  } } });
  env.context.enabled = true; env.permissions.grant(); const pending = env.adapter.refresh(); await started;
  env.permissions.revoke(); assert.equal(tools.size, 0); release(); await pending; await env.adapter.refresh();
  assert.equal(tools.size, 0); assert.deepEqual(env.adapter.status().registered, []);
});

test('browser registration failures clean up partial registrations while the original API remains usable', async t => {
  const tools = new Map(); let calls = 0;
  const env = setup(t, { modelContext: { async registerTool(tool, { signal }) {
    if (++calls === 2) throw new Error('Not enabled by browser policy');
    tools.set(tool.name, tool); signal.addEventListener('abort', () => tools.delete(tool.name), { once: true });
  } } });
  env.context.enabled = true; env.permissions.grant(); await env.adapter.refresh();
  assert.equal(tools.size, 0); assert.match(env.adapter.status().error, /existing browser agent API/);
  assert.equal((await env.api.execute({ action: 'canvas.inspect' })).ok, true);
});

test('browser tool cancellation reaches the capture permission guard before deferred pixels are captured', async t => {
  const env = setup(t); env.context.enabled = true; env.permissions.grant({ capabilities: ['media-capture'] }); await env.adapter.refresh();
  let release; let signalStarted; let captured = false; const started = new Promise(resolve => { signalStarted = resolve; });
  env.recording.snapshot = async ({ isAllowed }) => {
    signalStarted(); await new Promise(resolve => { release = resolve; });
    if (!isAllowed()) throw new Error('Cancelled before capture'); captured = true; return { dataUrl: 'pixels' };
  };
  const cancellation = new AbortController();
  const pending = env.tools.get('common_capture_snapshot').execute({}, { signal: cancellation.signal });
  await started; cancellation.abort(); release();
  assert.equal(JSON.parse(await pending).ok, false); assert.equal(captured, false);
});
