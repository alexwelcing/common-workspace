import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Board } from '../src/board.js';
import { createAgentAPI } from '../src/agent-api.js';
import { installAgentTools } from '../src/agent-tools.js';
import { SharedCanvas } from '../src/shared-canvas.js';
import { Walkthrough } from '../src/walkthrough.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const settle = () => new Promise(resolve => setImmediate(resolve));

function dom(t) {
  const window = new Window({ url: 'https://common.test/' });
  const properties = {
    window, document: window.document, navigator: window.navigator, location: window.location,
    history: window.history, localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    HTMLElement: window.HTMLElement, FileReader: window.FileReader, Image: window.Image,
    CustomEvent: window.CustomEvent, XMLSerializer: window.XMLSerializer,
    ResizeObserver: window.ResizeObserver, innerWidth: 1200,
    requestAnimationFrame: callback => window.requestAnimationFrame(callback),
    cancelAnimationFrame: id => window.cancelAnimationFrame(id),
    fetch: async () => new Response('Not available in the DOM test', { status: 404 }),
  };
  const originals = new Map(Object.keys(properties).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const cleanup = [];
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    for (const destroy of cleanup.reverse()) destroy();
    window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { window, cleanup };
}

function setup(t) {
  const { window, cleanup } = dom(t);
  document.body.innerHTML = '<header></header><main id="canvas"></main>';
  const el = document.querySelector('#canvas');
  Object.defineProperties(el, { clientWidth: { value: 1000 }, clientHeight: { value: 700 } });
  const context = { enabled: false, sandbox: false, connected: true, room: { id: 'room-one', name: 'Demo' }, participantId: 'owner', participants: [] };
  const board = new Board({ el });
  const model = new SharedCanvas({ onChange: entity => board.upsert(entity), onDelete: id => board.remove(id) });
  const calls = [];
  let recording = null;
  let windowShared = false;
  const records = [];
  const capture = {
    status: () => ({ state: recording ? 'recording' : 'idle', source: recording?.source, elapsedMs: recording ? 12_500 : 0, windowShared }),
    list: () => records.map(item => ({ ...item })),
    async start({ source }) { calls.push(['start', source]); recording = { source }; return this.status(); },
    async stop() {
      calls.push(['stop']);
      if (!recording) return null;
      const item = { id: `recording-${records.length + 1}`, name: 'Product demo', source: recording.source, durationMs: 12_500, size: 120_000 };
      records.push(item); recording = null; return item;
    },
    download(id) { calls.push(['download', id]); return records.find(item => item.id === id); },
    discard(id) { calls.push(['discard', id]); const index = records.findIndex(item => item.id === id); if (index < 0) return false; records.splice(index, 1); return true; },
    async snapshot(options) { calls.push(['snapshot', options]); return { dataUrl: PNG, width: 1000, height: 700 }; },
  };
  let tools;
  const walkthrough = new Walkthrough({ getBoard: () => board, onChange: () => tools?.refresh() });
  const api = createAgentAPI({ getBoard: () => board, getModel: () => model, getContext: () => context, recording: capture, walkthrough });
  const statuses = [];
  tools = installAgentTools({
    api, capture, walkthrough, getEnabled: () => context.enabled,
    onEnabledChange: enabled => { context.enabled = enabled; },
    onRequestWindowShare: () => { calls.push(['share-window']); windowShared = true; tools.refresh(); },
    onStatus: message => statuses.push(message), buttonParent: document.querySelector('header'),
  });
  cleanup.push(() => { tools.destroy(); board.destroy(); model.destroy(); });
  const query = selector => document.querySelector(selector);
  function enable(value = true) { query('#agent-enable').checked = value; query('#agent-enable').dispatchEvent(new window.Event('change', { bubbles: true })); }
  async function run(command) { query('#agent-command').value = typeof command === 'string' ? command : JSON.stringify(command); query('#agent-run').click(); await settle(); return query('#agent-result').textContent; }
  return { window, query, board, model, api, context, tools, capture, walkthrough, calls, statuses, enable, run };
}

test('agent panel requires visible opt-in before JSON commands create shared objects and rendered canvas nodes', async (t) => {
  const env = setup(t);
  env.model.setLocal({ id: 'private', type: 'text', text: 'Existing private content', x: 0, y: 0, width: 100, height: 80 });
  env.query('[aria-label="Agent tools"]').click();
  assert.equal(env.query('#agent-tools-panel').hidden, false);
  assert.equal(env.query('#agent-run').disabled, true);
  env.query('#agent-inspect').click(); await settle();
  assert.equal(JSON.parse(env.query('#agent-result').textContent).enabled, false);
  assert.equal(env.query('#agent-result').textContent.includes('Existing private content'), false);
  await env.run({ action: 'canvas.add', entity: { id: 'blocked', type: 'text', text: 'Blocked' } });
  assert.equal(env.model.get('blocked'), undefined);
  env.enable();
  assert.equal(env.query('#agent-run').disabled, false);
  assert.equal(JSON.parse(await env.run({ action: 'canvas.add', entity: { id: 'title', type: 'text', text: 'Product walkthrough', x: 120, y: 80 } })).ok, true);
  assert.equal(JSON.parse(await env.run({ action: 'canvas.add', entity: { id: 'callout', type: 'rectangle', text: 'Feature', x: 120, y: 220, width: 320, height: 180 } })).ok, true);
  assert.equal(env.model.get('title').text, 'Product walkthrough');
  assert.equal(env.model.get('callout').width, 320);
  assert.equal(env.query('[data-entity-id="title"] .board-text-content').textContent, 'Product walkthrough');
  assert.ok(env.query('[data-entity-id="callout"] svg'));
  const batch = JSON.parse(await env.run([
    { action: 'canvas.update', id: 'title', patch: { text: 'Updated walkthrough' } },
    { action: 'canvas.update', id: 'callout', patch: { width: 420 } },
  ]));
  assert.equal(batch.ok, true);
  assert.equal(env.query('[data-entity-id="title"] .board-text-content').textContent, 'Updated walkthrough');
  assert.equal(env.model.get('callout').width, 420);
  const peer = new SharedCanvas();
  t.after(() => peer.destroy());
  peer.applyUpdate(env.model.encodeState());
  assert.equal(peer.get('callout').text, 'Feature');
});

test('disconnected sessions deny UI commands and inspection does not leak existing canvas content', async (t) => {
  const env = setup(t); env.enable();
  await env.run({ action: 'canvas.add', entity: { id: 'retained', type: 'text', text: 'Retained content' } });
  env.context.connected = false;
  const result = JSON.parse(await env.run({ action: 'canvas.update', id: 'retained', patch: { text: 'Changed' } }));
  assert.equal(result.error.code, 'DISCONNECTED');
  assert.equal(env.model.get('retained').text, 'Retained content');
  env.query('#agent-inspect').click(); await settle();
  const state = JSON.parse(env.query('#agent-result').textContent);
  assert.equal(state.connected, false); assert.equal(state.entities, undefined);
});

test('malformed commands and HTML-looking text stay inert in the result, board and walkthrough UI', async (t) => {
  const env = setup(t); env.enable();
  assert.match(await env.run('{broken json'), /valid JSON command/);
  assert.equal(env.model.all().length, 0);
  const markup = '<img src=x onerror="window.injected=true"><script>window.injected=true</script>';
  const invalid = JSON.parse(await env.run({ action: markup }));
  assert.equal(invalid.ok, false);
  await env.run({ action: 'canvas.add', entity: { id: 'inert', type: 'text', text: markup } });
  assert.equal(env.query('[data-entity-id="inert"] .board-text-content').textContent, markup);
  await env.run({ action: 'walkthrough.load', steps: [{ title: markup, text: markup, targetId: 'inert' }] });
  assert.equal(env.query('.agent-walkthrough h2').textContent, markup);
  assert.equal(env.query('.agent-walkthrough p').textContent, markup);
  assert.equal(env.query('#agent-tools-panel img, #agent-tools-panel script, .agent-walkthrough img, .agent-walkthrough script, .board-text-content img, .board-text-content script'), null);
  assert.equal(env.window.injected, undefined);
});

test('image results and explicit image inspection omit binary payloads from the visible result', async (t) => {
  const env = setup(t); env.enable();
  const bytes = Buffer.concat([Buffer.from(PNG.split(',')[1], 'base64'), Buffer.alloc(60_000, 97)]);
  const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
  const result = await env.run({ action: 'image.add', dataUrl, title: 'Generated architecture illustration' });
  assert.equal(JSON.parse(result).ok, true);
  assert.equal(env.model.all()[0].url, dataUrl);
  assert.match(result, /omitted/);
  assert.equal(result.includes(dataUrl.slice(0, 80)), false);
  assert.ok(result.length < 3000);
  const inspected = await env.run({ action: 'canvas.inspect', includeImageData: true });
  assert.match(inspected, /omitted/);
  assert.equal(inspected.includes(dataUrl.slice(0, 80)), false);
  assert.equal(env.api.state({ includeImageData: true }).entities[0].url, dataUrl);
});

test('walkthrough controls move forward and backward through real steps and focus the canvas', async (t) => {
  const env = setup(t); env.enable();
  await env.run({ action: 'canvas.add', entity: { id: 'feature', type: 'rectangle', x: 200, y: 100, width: 300, height: 180 } });
  const initial = env.board.getView();
  await env.run({ action: 'walkthrough.load', steps: [
    { title: 'Overview', text: 'Start with the feature', targetId: 'feature' },
    { title: 'Detail', text: 'Look closer', bounds: { x: 700, y: 400, width: 180, height: 120 } },
  ] });
  assert.equal(env.query('.agent-walkthrough').hidden, false);
  assert.equal(env.query('.agent-walkthrough h2').textContent, 'Overview');
  assert.equal(env.query('#agent-walkthrough-previous').disabled, true);
  assert.notDeepEqual(env.board.getView(), initial);
  env.query('#agent-walkthrough-next').click();
  assert.equal(env.walkthrough.state().index, 1);
  assert.equal(env.query('.agent-walkthrough h2').textContent, 'Detail');
  assert.equal(env.query('#agent-walkthrough-next').disabled, true);
  env.query('#agent-walkthrough-previous').click();
  assert.equal(env.walkthrough.state().index, 0);
  env.query('#agent-walkthrough-stop').click();
  assert.equal(env.walkthrough.state().active, false);
  assert.equal(env.query('.agent-walkthrough').hidden, true);
});

test('manual recording controls remain available with agent control disabled and expose download/discard lifecycle', async (t) => {
  const env = setup(t);
  assert.equal(env.context.enabled, false);
  assert.equal(env.query('#agent-record-start').disabled, false);
  env.query('#agent-record-start').click(); await settle();
  assert.deepEqual(env.calls.at(-1), ['start', 'canvas']);
  assert.equal(env.query('#agent-record-start').hidden, true);
  assert.equal(env.query('#agent-record-stop').hidden, false);
  assert.equal(env.query('.agent-recording-live').hidden, false);
  assert.match(env.query('.agent-recording-live').textContent, /0:12/);
  env.enable(); env.enable(false);
  assert.equal(env.capture.status().state, 'recording');
  env.query('#agent-record-stop').click(); await settle();
  assert.equal(env.capture.status().state, 'idle');
  assert.equal(env.query('.agent-recording-live').hidden, true);
  assert.equal(document.querySelectorAll('.agent-recording-item').length, 1);
  env.query('[aria-label="Download Product demo"]').click(); await settle();
  assert.deepEqual(env.calls.at(-1), ['download', 'recording-1']);
  env.query('[aria-label="Discard Product demo"]').click(); await settle();
  assert.deepEqual(env.calls.at(-1), ['discard', 'recording-1']);
  assert.equal(env.query('.agent-recording-item'), null);
  env.query('#agent-record-source').value = 'window';
  env.query('#agent-record-source').dispatchEvent(new env.window.Event('change'));
  assert.equal(env.query('.agent-window-help').hidden, false);
  env.query('#agent-share-window').click();
  assert.deepEqual(env.calls.at(-1), ['share-window']);
  env.query('#agent-record-start').click(); await settle();
  assert.deepEqual(env.calls.at(-1), ['start', 'window']);
  env.query('.agent-recording-stop').click(); await settle();
  assert.equal(env.capture.status().state, 'idle');
  env.query('#agent-snapshot').click(); await settle();
  assert.deepEqual(env.calls.at(-1), ['snapshot', { download: true }]);
  assert.match(env.query('#agent-result').textContent, /omitted/);
  assert.equal(env.context.enabled, false);
});

test('the full application boots with opt-in agent control and shares a personal window only after an explicit click', async (t) => {
  const { window, cleanup } = dom(t);
  document.body.innerHTML = '<div id="app"></div><div id="modal-root"></div><div id="toasts"></div>';
  const track = new window.EventTarget();
  Object.assign(track, {
    id: 'approved-window-track', kind: 'video', readyState: 'live', stops: 0,
    stop() { this.readyState = 'ended'; this.stops++; },
    getSettings: () => ({ width: 1280, height: 720 }),
  });
  const stream = new window.MediaStream([track]);
  // Happy DOM enforces MediaStream identity on video.srcObject but omits this
  // standard method. The mock track supplies the capture lifecycle we assert.
  stream.getTracks = () => [track];
  const permissionRequests = [];
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true, value: { getDisplayMedia: async options => { permissionRequests.push(options); return stream; } },
  });
  cleanup.push(() => window.dispatchEvent(new window.Event('beforeunload')));
  await import('../src/main.js');
  // Agent tools load in their own chunk after the canvas renders.
  for (let attempt = 0; attempt < 200 && !window.commonAgent; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  await settle();
  assert.equal(document.documentElement.dataset.commonAgent, '1');
  const panelToggle = document.querySelector('#toggle-panel');
  assert.equal(panelToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('#right-panel').classList.contains('collapsed'), true);
  panelToggle.click();
  assert.equal(panelToggle.getAttribute('aria-expanded'), 'true');
  document.querySelector('[data-panel="chat"]').click();
  assert.equal(document.querySelector('#chat-text').disabled, true, 'personal canvases do not imply a live chat session');
  document.querySelector('[data-panel="people"]').click();
  document.querySelector('#panel-invite').click();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(document.querySelector('#create-form input[name="password"]').required);
  assert.equal(document.activeElement.name, 'name');
  document.querySelector('.close-modal').click();
  panelToggle.click();
  assert.equal(panelToggle.getAttribute('aria-expanded'), 'false');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  assert.equal(document.querySelector('.canvas-toolbar [data-tool="sticky"]').getAttribute('aria-pressed'), 'true');
  document.querySelector('.canvas-toolbar [data-tool="select"]').click();
  assert.equal(document.querySelector('.canvas-toolbar [data-tool="sticky"]').getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector('.canvas-toolbar [data-tool="select"]').getAttribute('aria-pressed'), 'true');
  assert.equal(window.commonAgent.state().enabled, false);
  assert.equal(document.querySelector('#agent-run').disabled, true);
  const enable = document.querySelector('#agent-enable');
  enable.checked = true;
  enable.dispatchEvent(new window.Event('change', { bubbles: true }));
  const state = window.commonAgent.state();
  assert.equal(state.enabled, true); assert.equal(state.sandbox, true);
  assert.ok(state.entities.some(entity => entity.id === 'welcome'));
  document.querySelector('#agent-command').value = JSON.stringify({ action: 'canvas.add', entity: { id: 'boot-check', type: 'text', text: 'Real application integration' } });
  document.querySelector('#agent-run').click(); await settle();
  assert.equal(JSON.parse(document.querySelector('#agent-result').textContent).ok, true);
  assert.equal(document.querySelector('[data-entity-id="boot-check"] .board-text-content').textContent, 'Real application integration');
  assert.ok(JSON.parse(localStorage.getItem('common.canvas')).some(entity => entity.id === 'boot-check'));
  assert.equal(permissionRequests.length, 0);
  assert.equal(track.stops, 0);
  document.querySelector('#share-screen').click(); await settle();
  assert.equal(permissionRequests.length, 1);
  assert.equal(permissionRequests[0].audio, false);
  const screen = window.commonAgent.state().entities.find(entity => entity.type === 'screen');
  assert.ok(screen);
  assert.equal(screen.participantId, 'local');
  const video = document.querySelector(`[data-entity-id="${screen.id}"] video`);
  assert.ok(video); assert.equal(video.hidden, false, document.querySelector('#toasts').textContent); assert.equal(video.srcObject, stream);
  assert.equal(window.commonAgent.state().recording.windowShared, true);
  assert.match(document.querySelector('#share-screen').textContent, /Stop sharing/);
  document.querySelector('#share-screen').click(); await settle();
  assert.equal(permissionRequests.length, 1);
  assert.equal(track.stops, 1);
  assert.equal(track.readyState, 'ended');
  assert.equal(window.commonAgent.state().entities.some(entity => entity.type === 'screen'), false);
  assert.equal(document.querySelector(`[data-entity-id="${screen.id}"]`), null);
  assert.equal(window.commonAgent.state().recording.windowShared, false);
  assert.match(document.querySelector('#share-screen').textContent, /Share a window/);
});
