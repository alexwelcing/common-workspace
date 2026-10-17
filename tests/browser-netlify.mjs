/**
 * Browser integration for the production Netlify build and HTTP polling adapter.
 * Start scripts/netlify-local.mjs, then set BASE_URL if its port is not 4173.
 * Capture uses a synthetic source; RTCPeerConnection, data channels, and remote
 * video decoding are real. The harness observes public HTTP/native WebRTC APIs.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core', '/opt/codex/cua_node/lib/node_modules/playwright', '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core'].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch { /* Try the next installed module. */ }
}
if (!playwright) throw new Error('Install Playwright, or set PLAYWRIGHT_MODULE to its installed module.');
let executablePath = process.env.CHROMIUM_PATH;
if (!executablePath) {
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    try { await access(candidate); executablePath = candidate; break; } catch { /* Try the next executable. */ }
  }
}
const baseUrl = process.env.BASE_URL || 'http://localhost:4173';
const artifacts = path.resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const report = { baseUrl, startedAt: new Date().toISOString(), checks: [], pageErrors: [], consoleErrors: [], screenshots: [] };
const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
const pages = [];
const timeout = 25000;

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.__netlifyObservation = { http: [], inits: [], channels: [], peers: [], webSockets: 0, captures: [] };
    const observation = window.__netlifyObservation;
    function inspectIncoming(value) {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'init') observation.inits.push({ collaboration: value.room?.collaboration, entities: value.entities?.length });
      if (Array.isArray(value)) value.forEach(inspectIncoming);
      else for (const [key, item] of Object.entries(value)) if (['events', 'messages', 'message', 'init', 'data'].includes(key)) inspectIncoming(item);
    }
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, options = {}) => {
      const url = new URL(input instanceof Request ? input.url : input, location.href);
      const signaling = /\/api\/rooms\/[^/]+\/(messages|events|connect|poll|leave)$/.test(url.pathname);
      let record;
      if (signaling) {
        let body;
        try { body = JSON.parse(typeof options.body === 'string' ? options.body : '{}'); } catch { body = {}; }
        const values = Array.isArray(body) ? body : body.messages || [body];
        record = { path: url.pathname.split('/').at(-1), method: options.method || 'GET', types: values.map(value => value.type).filter(Boolean), containsCanvas: /Netlify (bottom|middle|top) note|data:image\//.test(options.body || '') };
        observation.http.push(record);
      }
      const response = await nativeFetch(input, options);
      if (record) {
        record.status = response.status;
        response.clone().json().then(inspectIncoming).catch(() => {});
      }
      return response;
    };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, { construct(target, args, newTarget) { observation.webSockets++; return Reflect.construct(target, args, newTarget); } });
    const seenChannels = new WeakSet();
    function observeChannel(channel) {
      if (seenChannels.has(channel)) return;
      seenChannels.add(channel);
      const record = { label: channel.label, state: channel.readyState, sent: 0, received: 0, sentBytes: 0, receivedBytes: 0 };
      observation.channels.push(record);
      channel.addEventListener('open', () => { record.state = channel.readyState; });
      channel.addEventListener('close', () => { record.state = channel.readyState; });
      channel.addEventListener('message', event => { record.received++; record.receivedBytes += event.data.byteLength || event.data.size || event.data.length || 0; });
      const send = channel.send.bind(channel);
      channel.send = value => { record.sent++; record.sentBytes += value.byteLength || value.size || value.length || 0; return send(value); };
    }
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget); observation.peers.push(peer);
        const create = peer.createDataChannel.bind(peer);
        peer.createDataChannel = (...values) => { const channel = create(...values); observeChannel(channel); return channel; };
        peer.addEventListener('datachannel', event => observeChannel(event.channel));
        return peer;
      },
    });
    if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const paint = canvas.getContext('2d'); let frame = 0;
        const draw = () => { paint.fillStyle = frame % 2 ? '#2c5944' : '#567263'; paint.fillRect(0, 0, 640, 360); paint.fillStyle = '#fff'; paint.font = '28px sans-serif'; paint.fillText(`Polling transport capture ${++frame}`, 32, 180); };
        draw(); const stream = canvas.captureStream(12); const timer = setInterval(draw, 80);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        observation.captures.push(stream); return stream;
      },
    });
  });
  const page = await context.newPage(); page.setDefaultTimeout(timeout); pages.push(page);
  page.on('pageerror', error => report.pageErrors.push({ page: page.url(), message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ page: page.url(), message: message.text() }); });
  return page;
}
async function check(name, work) {
  const started = Date.now();
  try { await work(); report.checks.push({ name, passed: true, durationMs: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, passed: false, durationMs: Date.now() - started, message: error.message }); throw error; }
}
async function connected(page) { await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent.includes('Connected'), null, { timeout }); }
async function join(page, roomUrl, password, name) {
  await page.goto(roomUrl); await page.locator('input[name="displayName"]').fill(name); await page.locator('input[name="password"]').fill(password); await page.locator('.modal-submit').click(); await connected(page);
}
const entity = (page, id) => page.locator(`[data-entity-id="${id}"]`);
async function layers(page, open) {
  const button = page.getByRole('button', { name: 'Layers', exact: true });
  if ((await button.getAttribute('aria-expanded') === 'true') !== open) await button.click();
}
async function select(page, id) { await layers(page, true); await page.locator(`[data-layer-id="${id}"] .board-layer-select`).click(); await layers(page, false); }
async function action(page, id, name) { await select(page, id); await page.getByRole('toolbar', { name: 'Selected object controls' }).getByRole('button', { name, exact: true }).click(); }
async function order(page) { return page.locator('.board-entity').evaluateAll(nodes => nodes.sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex)).map(node => node.dataset.entityId)); }
async function geometry(page, id) { return entity(page, id).evaluate(node => ({ x: parseFloat(node.style.left), y: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height), locked: node.classList.contains('is-position-locked') })); }
async function awaitOrder(page, expected) {
  await page.waitForFunction(ids => JSON.stringify([...document.querySelectorAll('.board-entity')].sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex)).map(node => node.dataset.entityId)) === JSON.stringify(ids), expected, { timeout });
}
async function awaitGeometry(page, id, expected) {
  await page.waitForFunction(({ id, expected }) => {
    const node = document.querySelector(`[data-entity-id="${id}"]`); if (!node) return false;
    const value = { x: parseFloat(node.style.left), y: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height), locked: node.classList.contains('is-position-locked') };
    return Object.entries(expected).every(([key, item]) => typeof item === 'number' ? Math.abs(value[key] - item) < .1 : value[key] === item);
  }, { id, expected }, { timeout });
}
async function drag(page, start, dx, dy) { await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 }); await page.mouse.up(); }
async function resize(page, id, dx, dy) { const bounds = await entity(page, id).locator('.board-resize-handle').boundingBox(); assert.ok(bounds, 'Selection needs a resize handle.'); await drag(page, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, dx, dy); }
async function addNote(page, text) {
  await page.locator('[data-tool="sticky"]').click(); await page.locator('#board-viewport').click({ position: { x: 350, y: 200 } }); await page.locator('.board-text-content[contenteditable="true"]').fill(text); await page.locator('#room-title').click(); return page.locator('.type-sticky').filter({ hasText: text }).getAttribute('data-entity-id');
}
async function decodedVideo(page, expected) { await page.waitForFunction(count => { const videos = [...document.querySelectorAll('.type-screen video')]; return videos.length === count && videos.every(video => video.srcObject && video.readyState >= 2 && video.videoWidth === 640 && video.currentTime > 0); }, expected, { timeout }); }
async function transport(page) {
  return page.evaluate(async () => {
    const value = window.__netlifyObservation;
    return { http: value.http, inits: value.inits, channels: value.channels, webSockets: value.webSockets, peers: await Promise.all(value.peers.map(async peer => {
      const stats = await peer.getStats(); const rows = [...stats.values()]; const pair = stats.get(rows.find(row => row.type === 'transport')?.selectedCandidatePairId); const local = stats.get(pair?.localCandidateId);
      return { state: peer.connectionState, localCandidateType: local?.candidateType, protocol: local?.protocol, relayProtocol: local?.relayProtocol, bytesSent: pair?.bytesSent, bytesReceived: pair?.bytesReceived, framesDecoded: rows.filter(row => row.type === 'inbound-rtp' && row.kind === 'video').reduce((sum, row) => sum + (row.framesDecoded || 0), 0) };
    })) };
  });
}
async function screenshot(page, filename) { await page.screenshot({ path: path.join(artifacts, filename), fullPage: true }); report.screenshots.push(filename); }

let host, guest, late, roomUrl, targetId;
const password = `Common-Netlify-${Date.now()}`;
try {
  await check('production assets and the WebAssembly kernel load', async () => {
    host = await newPage(); await host.goto(baseUrl); await host.locator('#engine-label[title="wasm"]').waitFor(); assert.equal(await host.locator('[data-entity-id="welcome"]').count(), 1);
  });
  await check('host creates a password-protected peer room through the polling backend', async () => {
    await host.locator('#new-session').click(); await host.locator('input[name="name"]').fill('Netlify team smoke'); await host.locator('input[name="displayName"]').fill('Polling host'); await host.locator('input[name="password"]').fill(password); await host.locator('#create-form .modal-submit').click(); await host.locator('#invite-link').waitFor(); roomUrl = await host.locator('#invite-link').inputValue(); assert.match(roomUrl, /\/room\/[A-Za-z0-9_-]+$/); assert.ok(!roomUrl.includes(password)); await host.locator('#done-invite').click(); await connected(host);
  });
  await check('wrong password is rejected and two separate browsers join the same room', async () => {
    guest = await newPage(); await guest.goto(roomUrl); await guest.locator('input[name="displayName"]').fill('Polling teammate'); await guest.locator('input[name="password"]').fill('wrong-password'); await guest.locator('.modal-submit').click(); await guest.locator('.form-error').filter({ hasText: 'does not match' }).waitFor(); await guest.locator('input[name="password"]').fill(password); await guest.locator('.modal-submit').click(); await connected(guest);
    await Promise.all([host, guest].map(page => page.waitForFunction(() => document.querySelector('#people-number')?.textContent === '2', null, { timeout })));
    await guest.waitForFunction(() => document.querySelectorAll('.board-entity').length === 2, null, { timeout });
  });
  await check('chat messages travel in both directions through authenticated HTTP polling', async () => {
    await Promise.all([host, guest].map(page => page.locator('[data-panel="chat"]').click())); await host.locator('#chat-text').fill('A thought from the polling host.'); await host.locator('#chat-form button').click(); await guest.locator('.chat-message').filter({ hasText: 'A thought from the polling host.' }).waitFor(); await guest.locator('#chat-text').fill('The team receives the conversation.'); await guest.locator('#chat-form button').click(); await host.locator('.chat-message').filter({ hasText: 'The team receives the conversation.' }).waitFor();
  });
  await check('peer canvas edits and every layer action converge across browsers', async () => {
    const ids = []; for (const text of ['Netlify bottom note', 'Netlify middle note', 'Netlify top note']) ids.push(await addNote(host, text)); targetId = ids[1]; await guest.locator('.type-sticky').filter({ hasText: 'Netlify top note' }).waitFor(); await awaitOrder(guest, await order(host));
    let expected = await order(host);
    for (const [name, index] of [['Send to back', 0], ['Bring forward', 1], ['Bring to front', expected.length - 1], ['Send backward', expected.length - 2]]) { expected = expected.filter(id => id !== targetId); expected.splice(index, 0, targetId); await action(host, targetId, name); await Promise.all([awaitOrder(host, expected), awaitOrder(guest, expected)]); }
    await action(guest, targetId, 'Bring to front'); await awaitOrder(host, await order(guest));
  });
  await check('position, size, and locks synchronize without writing canvas content to HTTP', async () => {
    await select(host, targetId); const before = await geometry(host, targetId); const bounds = await entity(host, targetId).boundingBox(); await drag(host, { x: bounds.x + 25, y: bounds.y + 30 }, 55, 30); const moved = await geometry(host, targetId); assert.ok(moved.x > before.x + 25 && moved.y > before.y + 10); await awaitGeometry(guest, targetId, moved);
    await resize(host, targetId, 80, 45); const resized = await geometry(host, targetId); assert.ok(resized.width > moved.width + 40 && resized.height > moved.height + 20); await awaitGeometry(guest, targetId, resized);
    await action(host, targetId, 'Lock position'); await awaitGeometry(guest, targetId, { locked: true }); await select(guest, targetId); assert.equal(await entity(guest, targetId).locator('.board-resize-handle').isVisible(), false); const locked = await geometry(guest, targetId); const boundsLocked = await entity(guest, targetId).boundingBox(); await drag(guest, { x: boundsLocked.x + 25, y: boundsLocked.y + 30 }, 45, 25); assert.deepEqual(await geometry(guest, targetId), locked); await awaitGeometry(host, targetId, locked);
    report.sharedGeometry = locked;
  });
  await check('a late third participant receives current layers and locked geometry from peers', async () => {
    const expected = await order(host); const locked = await geometry(host, targetId); late = await newPage(); await join(late, roomUrl, password, 'Late polling teammate'); await awaitOrder(late, expected); await awaitGeometry(late, targetId, locked); await Promise.all([host, guest, late].map(page => page.waitForFunction(() => document.querySelector('#people-number')?.textContent === '3', null, { timeout }))); await screenshot(late, 'netlify-late-peer.png');
  });
  await check('reloading restores saved identity and the peer canvas without creating another seat', async () => {
    const identity = await guest.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith('common.auth.')))).participantId);
    const expected = await order(host); const locked = await geometry(host, targetId);
    await guest.reload(); await connected(guest); await awaitOrder(guest, expected); await awaitGeometry(guest, targetId, locked);
    assert.equal(await guest.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith('common.auth.')))).participantId), identity);
    await Promise.all([host, guest, late].map(page => page.waitForFunction(() => document.querySelector('#people-number')?.textContent === '3', null, { timeout })));
  });
  await check('two simultaneous captures decode remotely over real WebRTC after HTTP signaling', async () => {
    await host.locator('#share-screen').click(); await decodedVideo(guest, 1); await guest.locator('#share-screen').click(); await Promise.all([decodedVideo(host, 2), decodedVideo(guest, 2), decodedVideo(late, 2)]);
    const observations = await Promise.all([host, guest, late].map(transport)); assert.ok(observations.every(value => value.peers.some(peer => peer.state === 'connected' && peer.framesDecoded > 0)), JSON.stringify(observations.map(value => value.peers))); report.media = { source: 'synthetic canvas.captureStream', transport: 'native RTCPeerConnection', peers: observations.map(value => value.peers) };
    await host.locator('#share-screen').click(); await guest.locator('#share-screen').click(); await Promise.all([host, guest, late].map(page => page.waitForFunction(() => document.querySelectorAll('.type-screen').length === 0, null, { timeout }))); assert.equal(await host.evaluate(() => window.__netlifyObservation.captures[0].getVideoTracks()[0].readyState), 'ended'); assert.equal(await guest.evaluate(() => window.__netlifyObservation.captures[0].getVideoTracks()[0].readyState), 'ended');
  });
  await check('signaling uses HTTP, server snapshots contain no canvas, and peer data channels carry edits', async () => {
    report.transports = await Promise.all([host, guest, late].map(transport));
    for (const value of report.transports) {
      assert.equal(value.webSockets, 0, 'The Netlify build must not open persistent WebSockets.'); assert.ok(value.http.some(request => request.path === 'messages' && request.method === 'POST'), 'Authenticated messages must be sent through HTTP.'); assert.ok(value.inits.length > 0, 'The polling response must expose its init envelope.'); assert.ok(value.inits.every(init => init.collaboration === 'peer' && init.entities === 0), JSON.stringify(value.inits)); assert.ok(value.http.every(request => !request.containsCanvas && !request.types.some(type => ['upsert', 'delete'].includes(type))), 'Canvas writes must remain on RTC data channels.'); assert.ok(value.channels.some(channel => channel.label === 'common-canvas-v1' && channel.state === 'open' && channel.sent && channel.received));
    }
  });
  await check('host ends the room and every participant receives the end event', async () => {
    await host.locator('#room-menu').click(); await host.locator('#end-room').click(); await host.locator('#confirm-end').click(); await Promise.all([host, guest, late].map(page => page.locator('#modal-title').filter({ hasText: 'Session ended' }).waitFor()));
  });
  await check('no uncaught browser errors or unexpected failed HTTP resources', async () => {
    assert.deepEqual(report.pageErrors, []); const unexpected = report.consoleErrors.filter(value => !/Failed to load resource: the server responded with a status of 401/.test(value.message)); assert.deepEqual(unexpected, []);
  });
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; console.error(error);
  for (const [index, page] of pages.entries()) { if (page.isClosed()) continue; await screenshot(page, `netlify-failure-${index}.png`).catch(() => {}); report[`failure-${index}`] = { transport: await transport(page).catch(error => ({ error: error.message })), order: await order(page).catch(() => []), toasts: await page.locator('.toast').allTextContents().catch(() => []) }; }
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(artifacts, 'browser-netlify-report.json'), JSON.stringify(report, null, 2)); await browser.close();
}
