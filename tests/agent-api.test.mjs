import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_CAPABILITIES, createAgentAPI, createAgentPermissions, getAgentManifest } from '../src/agent-api.js';
import { SharedCanvas } from '../src/shared-canvas.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const shape = (id, patch = {}) => ({ id, type: 'rectangle', x: 10, y: 20, width: 220, height: 130, ...patch });
function setup(overrides = {}, options = {}) {
  const context = { enabled: true, sandbox: false, connected: true, room: { id: 'room-one', name: 'Demo', secret: 'hidden' }, participantId: 'owner', participants: [{ id: 'owner', name: 'Owner', token: 'secret-token' }], ...overrides };
  let model = new SharedCanvas();
  const board = { readOnly: false, zoom: 1, pan: { x: 0, y: 0 }, el: { clientWidth: 1000, clientHeight: 700 }, canEdit: () => true, selectedId: null,
    select(id) { this.selectedId = id; }, getView() { return { zoom: this.zoom, x: this.pan.x, y: this.pan.y }; },
    setZoom(value) { this.zoom = Math.max(.15, Math.min(2.5, value)); }, updateView() {}, fit() { this.zoom = 1; this.pan = { x: 24, y: 24 }; }, exportSvg: () => '<svg xmlns="http://www.w3.org/2000/svg"/>' };
  const calls = [];
  const recording = Object.fromEntries(['snapshot', 'start', 'stop', 'list', 'download', 'exportCanvas'].map(method => [method, async (...args) => { calls.push([method, ...args]); return { method }; }]));
  recording.status = () => ({ state: 'idle' });
  const walkthrough = Object.fromEntries(['load', 'next', 'previous', 'stop'].map(method => [method, (...args) => { calls.push([method, ...args]); return { method }; }]));
  walkthrough.state = () => ({ active: false });
  const permissions = createAgentPermissions({ getContext: () => context, getSession: () => model, ...options });
  const grant = (settings = {}) => permissions.grant({ capabilities: options.capabilities || Object.keys(AGENT_CAPABILITIES), ...settings });
  if (context.enabled && (context.sandbox || context.connected)) grant();
  const api = createAgentAPI({ getBoard: () => board, getModel: () => model, getContext: () => context, recording, walkthrough, permissions });
  return { api, context, board, permissions, grant, get model() { return model; }, replaceModel(next = new SharedCanvas()) { model.destroy(); model = next; }, recording, walkthrough, calls, destroy() { permissions.destroy(); model.destroy(); } };
}

test('agent commands write the shared model and arrive in another peer with field-level concurrency intact', async () => {
  const env = setup(); const peer = new SharedCanvas({ clientId: 2 });
  const result = await env.api.execute({ action: 'canvas.add', entity: shape('feature', { text: 'Before' }) });
  assert.equal(result.ok, true); peer.applyUpdate(env.model.encodeState());
  assert.equal(peer.get('feature').text, 'Before');
  peer.patch('feature', { width: 500, height: 320 });
  await env.api.execute({ action: 'canvas.update', id: 'feature', patch: { text: 'Walkthrough callout', x: 250 } });
  const local = env.model.encodeDiff(peer.encodeStateVector());
  const remote = peer.encodeDiff(env.model.encodeStateVector());
  env.model.applyUpdate(remote); peer.applyUpdate(local);
  assert.deepEqual(env.model.all(), peer.all());
  assert.equal(peer.get('feature').width, 500); assert.equal(peer.get('feature').text, 'Walkthrough callout');
  assert.equal(peer.get('feature').x, 250);
  peer.destroy(); env.destroy();
});

test('opt-in and live connection gate content reads and writes; disabled state exposes safe metadata only', async () => {
  const env = setup({ enabled: false }); env.model.setLocal(shape('private', { text: 'Private content' }));
  assert.equal((await env.api.execute({ action: 'canvas.inspect' })).error.code, 'AGENT_DISABLED');
  assert.equal((await env.api.execute({ action: 'canvas.add', entity: shape('blocked') })).error.code, 'AGENT_DISABLED');
  assert.equal(env.api.describe().version, '1'); assert.equal(env.api.state().entities, undefined);
  assert.equal(JSON.stringify(env.api.state()).includes('Private content'), false);
  env.context.enabled = true; env.context.connected = false;
  assert.equal((await env.api.execute({ action: 'canvas.inspect' })).error.code, 'DISCONNECTED');
  assert.equal(env.api.state().entities, undefined);
  env.context.sandbox = true;
  env.grant();
  assert.equal((await env.api.execute({ action: 'canvas.inspect' })).ok, true);
  env.destroy();
});

test('read-only state, per-object edit policy, and screen ownership are enforced before model changes', async () => {
  const env = setup(); env.model.setLocal(shape('feature')); env.model.setLocal(shape('screen', { type: 'screen', participantId: 'guest' }));
  env.board.readOnly = true;
  assert.equal((await env.api.execute({ action: 'canvas.update', id: 'feature', patch: { x: 90 } })).error.code, 'READ_ONLY');
  env.board.readOnly = false; env.board.canEdit = entity => entity.id !== 'feature';
  assert.equal((await env.api.execute({ action: 'canvas.remove', id: 'feature' })).error.code, 'FORBIDDEN');
  env.board.canEdit = () => true;
  assert.equal((await env.api.execute({ action: 'canvas.update', id: 'screen', patch: { title: 'Hijacked' } })).error.code, 'FORBIDDEN');
  assert.equal((await env.api.execute({ action: 'canvas.lock', id: 'screen', locked: true })).error.code, 'FORBIDDEN');
  env.context.participantId = 'guest';
  env.grant();
  assert.equal((await env.api.execute({ action: 'canvas.update', id: 'screen', patch: { title: 'My screen' } })).ok, true);
  assert.equal(env.model.get('screen').title, 'My screen');
  assert.equal(env.model.get('feature').x, 10); env.destroy();
});

test('position locks reject geometry and drawing changes but permit text, layers and explicit unlock', async () => {
  const env = setup(); env.model.setLocal(shape('feature', { locked: true })); env.model.setLocal(shape('other'));
  assert.equal((await env.api.execute({ action: 'canvas.update', id: 'feature', patch: { x: 40, locked: false } })).error.code, 'LOCKED');
  assert.equal((await env.api.execute({ action: 'canvas.update', id: 'feature', patch: { width: 450 } })).error.code, 'LOCKED');
  assert.equal((await env.api.execute({ action: 'canvas.update', id: 'feature', patch: { text: 'Locked annotation' } })).ok, true);
  assert.equal((await env.api.execute({ action: 'canvas.layer', id: 'feature', position: 'front' })).ok, true);
  assert.deepEqual(env.model.getOrder(), ['other', 'feature']);
  await env.api.execute({ action: 'canvas.lock', id: 'feature', locked: false });
  assert.equal((await env.api.execute({ action: 'canvas.update', id: 'feature', patch: { x: 40 } })).ok, true);
  assert.equal(env.model.get('feature').x, 40); env.destroy();
});

test('unknown and reserved fields cannot create screens, change types, forge owners or grant external rendering consent', async () => {
  const env = setup(); env.model.setLocal(shape('feature'));
  const commands = [
    { action: 'canvas.add', entity: shape('fake-screen', { type: 'screen' }) },
    { action: 'canvas.add', entity: shape('fake-owner', { participantId: 'owner' }) },
    { action: 'canvas.update', id: 'feature', patch: { type: 'screen' } },
    { action: 'canvas.update', id: 'feature', patch: { orderKey: 'a0' } },
    { action: 'canvas.add', entity: shape('external', { type: 'diagram', source: 'a', externalConsent: true }) },
    { action: 'canvas.remove', id: 'feature', token: 'unexpected' },
    JSON.parse('{"action":"canvas.add","entity":{"type":"text","__proto__":{"enabled":true}}}'),
  ];
  for (const command of commands) assert.equal((await env.api.execute(command)).ok, false);
  assert.deepEqual(env.model.getOrder(), ['feature']); assert.equal({}.enabled, undefined); env.destroy();
});

test('embedded raster imports reject remote images, SVG, malformed data, MIME spoofing and oversized URLs', async () => {
  const env = setup();
  const result = await env.api.execute({ action: 'image.add', dataUrl: PNG });
  assert.equal(result.ok, true); assert.equal(result.result.type, 'image');
  for (const dataUrl of ['https://example.com/image.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,PHN2Zz48L3N2Zz4=', 'data:image/png;base64,a', 'data:image/png;base64,' + 'a'.repeat(2 * 1024 * 1024)]) {
    assert.equal((await env.api.execute({ action: 'image.add', dataUrl })).error.code, 'INVALID_IMAGE');
  }
  const redacted = env.api.state(); assert.equal(redacted.entities[0].url, undefined); assert.equal(redacted.entities[0].hasImageData, true);
  assert.equal(env.api.state({ includeImageData: true }).entities[0].url, PNG);
  assert.equal(JSON.stringify(redacted).includes('secret-token'), false); assert.equal(redacted.room.secret, undefined);
  env.destroy();
});

test('request ids deduplicate concurrent async work and equivalent key order while rejecting mismatched retries', async () => {
  const env = setup(); let release; let started = 0;
  env.recording.snapshot = async () => { started++; await new Promise(resolve => { release = resolve; }); return { dataUrl: PNG }; };
  const first = env.api.execute({ action: 'capture.snapshot', requestId: 'snap-one', download: false });
  const second = env.api.execute({ download: false, requestId: 'snap-one', action: 'capture.snapshot' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(started, 1); release();
  assert.deepEqual(await first, await second);
  const third = await env.api.execute({ action: 'capture.snapshot', requestId: 'snap-one', download: false });
  assert.equal(third.ok, true); assert.equal(started, 1);
  assert.equal((await env.api.execute({ action: 'capture.snapshot', requestId: 'snap-one', download: true })).error.code, 'REQUEST_ID_CONFLICT');
  env.context.enabled = false;
  assert.equal((await env.api.execute({ action: 'capture.snapshot', requestId: 'snap-one', download: false })).error.code, 'AGENT_DISABLED');
  env.destroy();
});

test('request cache follows room identity and is bounded to 100 completed requests', async () => {
  const env = setup();
  const command = { action: 'canvas.add', requestId: 'stable', entity: shape('feature') };
  assert.equal((await env.api.execute(command)).ok, true);
  env.context.room = { id: 'room-two', name: 'Different session' }; env.replaceModel();
  env.grant();
  assert.equal((await env.api.execute(command)).ok, true); assert.equal(env.model.all().length, 1);
  let count = 0; env.recording.list = () => ({ count: ++count });
  for (let i = 0; i < 101; i++) await env.api.execute({ action: 'recording.list', requestId: `list-${i}` });
  assert.equal(count, 101);
  await env.api.execute({ action: 'recording.list', requestId: 'list-100' }); assert.equal(count, 101);
  await env.api.execute({ action: 'recording.list', requestId: 'list-0' }); assert.equal(count, 102);
  env.destroy();
});

test('a session switch before a queued command prevents writes into the newly active model', async () => {
  const env = setup();
  const result = env.api.execute({ action: 'canvas.add', entity: shape('wrong-room') });
  env.context.room.id = 'room-two'; env.replaceModel();
  assert.equal((await result).error.code, 'SESSION_CHANGED'); assert.equal(env.model.all().length, 0);
  env.destroy();
});

test('recording preparation rechecks consent, connection, session identity and model before starting capture', async () => {
  for (const revoke of [
    env => { env.context.enabled = false; },
    env => { env.context.connected = false; },
    env => { env.context.room.id = 'room-two'; },
    env => { env.context.participantId = 'someone-else'; },
    env => { env.replaceModel(); },
  ]) {
    const env = setup(); let release; let started = 0; let receivedPermissionCheck;
    env.recording.start = async ({ source, isAllowed }) => {
      assert.equal(source, 'canvas'); assert.equal(isAllowed(), true);
      receivedPermissionCheck = isAllowed;
      await new Promise(resolve => { release = resolve; });
      if (!isAllowed()) { const error = new Error('Recording start was cancelled.'); error.code = 'START_CANCELLED'; throw error; }
      started++; return { state: 'recording' };
    };
    const pending = env.api.execute({ action: 'recording.start', source: 'canvas' });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(typeof receivedPermissionCheck, 'function');
    revoke(env); assert.equal(receivedPermissionCheck(), false); release();
    assert.equal((await pending).ok, false); assert.equal(started, 0);
    env.destroy();
  }
  const env = setup();
  assert.equal((await env.api.execute({ action: 'recording.start', source: 'canvas', isAllowed: true })).error.code, 'INVALID_COMMAND');
  env.destroy();
});

test('snapshots receive a permission guard that prevents stale downloads after async asset preparation', async () => {
  for (const revoke of [env => { env.context.enabled = false; }, env => { env.context.room.id = 'room-two'; env.replaceModel(); }]) {
    const env = setup(); let release; let signalStarted; let downloaded = false;
    const started = new Promise(resolve => { signalStarted = resolve; });
    env.recording.snapshot = async ({ download, isAllowed }) => {
      assert.equal(download, true); assert.equal(isAllowed(), true); signalStarted();
      await new Promise(resolve => { release = resolve; });
      if (!isAllowed()) { const error = new Error('Snapshot was cancelled.'); error.code = 'SNAPSHOT_CANCELLED'; throw error; }
      downloaded = true; return { dataUrl: PNG };
    };
    const pending = env.api.execute({ action: 'capture.snapshot', download: true });
    await started; revoke(env); release();
    assert.equal((await pending).ok, false); assert.equal(downloaded, false);
    env.destroy();
  }
});

test('batch validates all shapes before edits, caps work and returns individual execution failures', async () => {
  const env = setup();
  const invalid = await env.api.batch([{ action: 'canvas.add', entity: shape('not-added') }, { action: 'canvas.update', id: 'not-added', patch: { width: -1 } }]);
  assert.equal(invalid.ok, false); assert.equal(env.model.all().length, 0);
  assert.equal((await env.api.batch(Array.from({ length: 51 }, () => ({ action: 'view.fit' })))).ok, false);
  const result = await env.api.batch([
    { action: 'canvas.add', entity: shape('feature') },
    { action: 'canvas.update', id: 'feature', patch: { text: 'Step one' } },
    { action: 'canvas.remove', id: 'missing' },
    { action: 'canvas.lock', id: 'feature', locked: true },
  ]);
  assert.equal(result.ok, true); assert.deepEqual(result.result.map(entry => entry.ok), [true, true, false, true]);
  assert.equal(env.model.get('feature').text, 'Step one'); assert.equal(env.model.get('feature').locked, true); env.destroy();
});

test('a deferred batch remains bound to its original room and never writes confidential content into a new shared model', async () => {
  const env = setup(); let release; let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  env.recording.snapshot = async () => { signalStarted(); await new Promise(resolve => { release = resolve; }); return { dataUrl: PNG }; };
  const batch = env.api.batch([
    { action: 'canvas.add', entity: shape('already-applied', { text: 'Original room introduction' }) },
    { action: 'capture.snapshot' },
    { action: 'canvas.add', entity: shape('confidential', { type: 'text', text: 'Original room confidential note' }) },
  ]);
  await started;
  assert.equal(env.model.get('already-applied').text, 'Original room introduction');
  const originalRoomPeer = new SharedCanvas(); originalRoomPeer.applyUpdate(env.model.encodeState());
  const newRoom = new SharedCanvas(); newRoom.setLocal(shape('new-room-content', { text: 'Different room content' }));
  const before = newRoom.all();
  env.context.room = { id: 'room-two', name: 'Different room' }; env.replaceModel(newRoom);
  release();
  const result = await batch;
  assert.equal(result.ok, false); assert.equal(result.error.code, 'SESSION_CHANGED');
  assert.deepEqual(newRoom.all(), before); assert.equal(newRoom.get('confidential'), undefined);
  assert.equal(originalRoomPeer.get('already-applied').text, 'Original room introduction', 'completed effects are not rolled back');
  assert.equal(originalRoomPeer.get('confidential'), undefined);
  originalRoomPeer.destroy(); env.destroy();
});

test('batch stops remaining edits when Agent tools are disabled or the connection is lost during an awaited command', async () => {
  for (const [field, code] of [['enabled', 'AGENT_DISABLED'], ['connected', 'DISCONNECTED']]) {
    const env = setup(); let release; let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    env.recording.snapshot = async () => { signalStarted(); await new Promise(resolve => { release = resolve; }); return { dataUrl: PNG }; };
    const batch = env.api.batch([{ action: 'capture.snapshot' }, { action: 'canvas.add', entity: shape('must-not-run') }]);
    await started; env.context[field] = false; release();
    const result = await batch;
    assert.equal(result.ok, false); assert.equal(result.error.code, code); assert.equal(env.model.all().length, 0);
    env.destroy();
  }
});

test('view commands focus objects and bounds, and walkthrough service only receives validated inert steps', async () => {
  const env = setup(); env.model.setLocal(shape('feature'));
  const focused = await env.api.execute({ action: 'view.focus', id: 'feature' });
  assert.equal(focused.ok, true); assert.equal(env.board.selectedId, 'feature'); assert.ok(focused.result.zoom > 0);
  assert.equal((await env.api.execute({ action: 'view.focus', id: 'feature', bounds: { x: 0, y: 0, width: 100, height: 100 } })).ok, false);
  const steps = [{ title: 'Overview', text: 'Look at this feature', targetId: 'feature' }, { title: 'Detail', bounds: { x: 0, y: 0, width: 100, height: 100 } }];
  assert.equal((await env.api.execute({ action: 'walkthrough.load', steps })).ok, true);
  assert.deepEqual(env.calls.at(-1), ['load', steps]);
  assert.equal((await env.api.execute({ action: 'walkthrough.load', steps: [{ title: 'Unsafe', commands: [{ action: 'canvas.remove', id: 'feature' }] }] })).ok, false);
  for (const action of ['walkthrough.next', 'walkthrough.previous', 'walkthrough.stop']) assert.equal((await env.api.execute({ action })).ok, true);
  await env.api.execute({ action: 'view.fit' }); assert.equal(env.board.pan.x, 24); env.destroy();
});

test('recording and export commands delegate explicit sources and downloads without exposing transport credentials', async () => {
  const env = setup(); env.model.setLocal(shape('feature')); env.model.setLocal(shape('live', { type: 'screen', participantId: 'owner', streamId: 'private-stream' }));
  await env.api.execute({ action: 'recording.start', source: 'window' });
  assert.equal(env.calls.at(-1)[0], 'start'); assert.equal(env.calls.at(-1)[1].source, 'window'); assert.equal(typeof env.calls.at(-1)[1].isAllowed, 'function');
  assert.equal((await env.api.execute({ action: 'recording.start', source: 'camera' })).ok, false);
  await env.api.execute({ action: 'recording.download', id: 'recording-one' }); assert.deepEqual(env.calls.at(-1), ['download', 'recording-one']);
  const result = await env.api.execute({ action: 'canvas.export', format: 'json', download: true });
  assert.equal(result.ok, true); assert.equal(result.result.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(result.result.data).entities.map(entity => entity.id), ['feature']);
  assert.equal(env.calls.at(-1)[0], 'exportCanvas'); assert.equal(env.calls.at(-1)[2].download, true);
  assert.equal((await env.api.execute({ action: 'canvas.export' })).result.data.startsWith('<svg'), true);
  assert.equal(env.api.state().entities.find(entity => entity.id === 'live').streamId, undefined); env.destroy();
});

test('invalid JSON inputs and service failures return structured errors instead of throwing', async () => {
  const env = setup(); let getterRead = false;
  const getter = { action: 'view.fit', get unexpected() { getterRead = true; return 'bad'; } };
  for (const command of [null, 42, [], 'view.fit', { action: 'unknown' }, { action: 'canvas.add', entity: shape('nan', { x: NaN }) }, getter, Object.create({ action: 'view.fit' })]) {
    const result = await env.api.execute(command); assert.equal(result.ok, false); assert.equal(typeof result.error.code, 'string');
  }
  assert.equal(getterRead, false);
  env.recording.stop = () => { throw new Error('secret-provider-credential'); };
  const error = await env.api.execute({ action: 'recording.stop' }); assert.equal(error.ok, false); assert.equal(error.error.message.includes('secret-provider-credential'), false);
  assert.equal(env.model.all().length, 0); env.destroy();
});

test('explicit capability grants separate reading, editing, screen capture and recording', async () => {
  const env = setup({}, { capabilities: ['inspect'] }); env.model.setLocal(shape('feature', { text: 'Read me' }));
  assert.equal((await env.api.execute({ action: 'canvas.inspect' })).ok, true);
  for (const command of [{ action: 'canvas.update', id: 'feature', patch: { text: 'Blocked' } }, { action: 'capture.snapshot' }, { action: 'recording.start', source: 'canvas' }, { action: 'recording.list' }]) {
    assert.equal((await env.api.execute(command)).error.code, 'PERMISSION_DENIED');
  }
  assert.equal(env.api.state().recording, undefined);
  env.permissions.grant();
  assert.deepEqual(env.permissions.state().capabilities, ['inspect', 'canvas-write']);
  assert.equal((await env.api.execute({ action: 'canvas.update', id: 'feature', patch: { text: 'Allowed' } })).ok, true);
  assert.equal((await env.api.execute({ action: 'capture.snapshot' })).error.code, 'PERMISSION_DENIED');
  env.permissions.grant({ capabilities: ['media-capture'] });
  assert.deepEqual(env.permissions.state().capabilities, ['inspect', 'media-capture']);
  assert.equal((await env.api.execute({ action: 'capture.snapshot' })).ok, true);
  assert.equal((await env.api.execute({ action: 'recording.start', source: 'canvas' })).error.code, 'PERMISSION_DENIED');
  env.permissions.grant({ capabilities: ['recording'] });
  assert.equal((await env.api.execute({ action: 'recording.list' })).ok, true);
  assert.equal((await env.api.execute({ action: 'recording.start', source: 'canvas' })).error.code, 'PERMISSION_DENIED');
  env.destroy();
});

test('grant expiry revokes content access and notifies the trusted UI exactly once', async () => {
  let time = 100000; const revoked = [];
  const env = setup({}, { now: () => time, onRevoke: reason => revoked.push(reason) });
  env.permissions.grant({ capabilities: ['inspect'], ttlMs: 1000 });
  env.model.setLocal(shape('private', { text: 'Secret after deadline' }));
  assert.equal(env.api.state().grants.expiresAt, 101000);
  time = 101001;
  assert.equal((await env.api.execute({ action: 'canvas.inspect' })).error.code, 'GRANT_EXPIRED');
  assert.equal(env.api.state().entities, undefined); assert.equal(env.api.describe().grants.active, false);
  env.permissions.refresh(); assert.deepEqual(revoked.filter(reason => reason === 'expired'), ['expired']);
  env.destroy();
});

test('grants are revoked on scope changes and require a new trusted grant before the new room is readable', async () => {
  for (const change of [env => { env.context.room.id = 'other'; }, env => { env.context.participantId = 'other'; }, env => env.replaceModel()]) {
    const env = setup(); change(env);
    assert.equal(env.permissions.refresh().reason, 'session-changed');
    assert.equal((await env.api.execute({ action: 'canvas.inspect' })).error.code, 'SESSION_CHANGED');
    assert.equal(env.api.state().entities, undefined);
    env.grant(); assert.equal((await env.api.execute({ action: 'canvas.inspect' })).ok, true);
    env.destroy();
  }
});

test('revocation and replacement grants invalidate pending capture and cached writes', async () => {
  const env = setup(); let release; let signalStarted; let captured = false;
  const started = new Promise(resolve => { signalStarted = resolve; });
  env.recording.snapshot = async ({ isAllowed }) => {
    signalStarted(); await new Promise(resolve => { release = resolve; });
    if (!isAllowed()) throw new Error('Denied after revocation');
    captured = true; return { dataUrl: PNG };
  };
  const pending = env.api.execute({ action: 'capture.snapshot' }); await started;
  env.permissions.revoke(); env.grant(); release();
  assert.equal((await pending).ok, false); assert.equal(captured, false);
  const command = { action: 'canvas.add', requestId: 'same-write', entity: shape('one') };
  assert.equal((await env.api.execute(command)).ok, true);
  env.permissions.grant({ capabilities: ['inspect'] });
  assert.equal((await env.api.execute(command)).error.code, 'PERMISSION_DENIED');
  assert.equal(env.model.all().length, 1); env.destroy();
});

test('the trusted permissions controller validates grants and no public command can grant itself authority', async () => {
  const env = setup();
  assert.throws(() => env.permissions.grant({ capabilities: ['admin'] }), /supported/);
  for (const ttlMs of [0, Infinity, 3600001]) assert.throws(() => env.permissions.grant({ ttlMs }), /duration/);
  assert.equal(env.api.grant, undefined); assert.equal(env.api.revoke, undefined);
  assert.equal((await env.api.execute({ action: 'permissions.grant', capabilities: ['recording'] })).error.code, 'UNKNOWN_ACTION');
  const manifest = getAgentManifest(); assert.equal(manifest.defaultCapabilities.includes('recording'), false);
  assert.equal(manifest.maxGrantDurationMs, 3600000);
  assert.equal(manifest.tools.length, Object.keys(env.api.describe().actions).length);
  assert.equal(manifest.tools.find(tool => tool.action === 'recording.start').capabilities.includes('media-capture'), true);
  assert.equal(manifest.tools.every(tool => tool.inputSchema.additionalProperties === false), true);
  env.destroy();
});

test('an AbortSignal stops deferred capture and remaining batch edits without changing the command JSON schema', async () => {
  const env = setup(); const cancellation = new AbortController(); let release; let signalStarted; let captured = false;
  const started = new Promise(resolve => { signalStarted = resolve; });
  env.recording.snapshot = async ({ isAllowed }) => {
    signalStarted(); await new Promise(resolve => { release = resolve; });
    if (!isAllowed()) throw new Error('Cancelled'); captured = true; return { dataUrl: PNG };
  };
  const pending = env.api.batch([{ action: 'capture.snapshot' }, { action: 'canvas.add', entity: shape('cancelled-write') }], { signal: cancellation.signal });
  await started; cancellation.abort(); release();
  assert.equal((await pending).error.code, 'ABORTED'); assert.equal(captured, false); assert.equal(env.model.all().length, 0);
  env.destroy();
});
