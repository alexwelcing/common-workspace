/**
 * Multiplayer layers integration check against a running app (bun run dev).
 * Uses separate browser contexts, the public UI/DOM, and native transport APIs.
 * No application state, private globals, or server-side board writes are used.
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
if (!playwright) throw new Error('Install Playwright, or set PLAYWRIGHT_MODULE to an installed Playwright module.');
let executablePath = process.env.CHROMIUM_PATH;
if (!executablePath) {
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    try { await access(candidate); executablePath = candidate; break; } catch { /* Check next path. */ }
  }
}
const baseUrl = process.env.BASE_URL || 'http://localhost:5173';
const artifactDir = path.resolve('artifacts');
await mkdir(artifactDir, { recursive: true });
const report = { baseUrl, startedAt: new Date().toISOString(), checks: [], pageErrors: [], consoleErrors: [], screenshots: [] };
const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
const pages = [];

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    // Observation is restricted to standards-based WebRTC and WebSocket APIs.
    window.__layerTransport = { sockets: [], channels: [], peers: [] };
    const observed = new WeakSet();
    const observeChannel = channel => {
      if (observed.has(channel)) return;
      observed.add(channel);
      const record = { label: channel.label, state: channel.readyState, sent: [], received: [] };
      window.__layerTransport.channels.push(record);
      const inspect = value => {
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
        const entry = { bytes: bytes?.byteLength ?? value.size ?? value.length ?? 0 };
        if (bytes?.byteLength >= 20) {
          const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          if (header.getUint32(0) === 0x43435631) Object.assign(entry, { message: header.getUint32(4), total: header.getUint32(8), index: header.getUint32(12), count: header.getUint32(16) });
        }
        return entry;
      };
      channel.addEventListener('open', () => { record.state = channel.readyState; });
      channel.addEventListener('close', () => { record.state = channel.readyState; });
      channel.addEventListener('message', event => record.received.push(inspect(event.data)));
      const send = channel.send.bind(channel);
      channel.send = value => { record.sent.push(inspect(value)); return send(value); };
    };
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget);
        window.__layerTransport.peers.push(peer);
        const create = peer.createDataChannel.bind(peer);
        peer.createDataChannel = (...values) => { const channel = create(...values); observeChannel(channel); return channel; };
        peer.addEventListener('datachannel', event => observeChannel(event.channel));
        return peer;
      },
    });
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        if (new URL(socket.url).pathname !== '/ws') return socket;
        const record = { outgoing: [], inits: [] };
        window.__layerTransport.sockets.push(record);
        socket.addEventListener('message', event => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'init') record.inits.push({ collaboration: message.room?.collaboration, entityCount: message.entities?.length });
          } catch { /* Not JSON. */ }
        });
        const send = socket.send.bind(socket);
        socket.send = value => {
          try { record.outgoing.push(JSON.parse(value).type); } catch { /* Not JSON. */ }
          return send(value);
        };
        return socket;
      },
    });
  });
  const page = await context.newPage();
  pages.push(page);
  page.on('pageerror', error => report.pageErrors.push({ page: page.url(), message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ page: page.url(), message: message.text() }); });
  return page;
}
async function check(name, work) {
  const started = Date.now();
  try { await work(); report.checks.push({ name, passed: true, durationMs: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, passed: false, durationMs: Date.now() - started, message: error.message }); throw error; }
}
async function connected(page) {
  await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent.includes('Connected'), null, { timeout: 25000 });
}
async function join(page, url, password, name) {
  await page.goto(url);
  await page.locator('input[name="displayName"]').fill(name);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('.modal-submit').click();
  await connected(page);
}
const entity = (page, id) => page.locator(`[data-entity-id="${id}"]`);
const layerRow = (page, id) => page.locator(`[data-layer-id="${id}"]`);
async function layers(page, open) {
  const toggle = page.getByRole('button', { name: 'Layers', exact: true });
  if ((await toggle.getAttribute('aria-expanded') === 'true') !== open) await toggle.click();
}
async function select(page, id) {
  await layers(page, true);
  await layerRow(page, id).locator('.board-layer-select').click();
  await layers(page, false);
  assert.ok(await entity(page, id).evaluate(node => node.classList.contains('is-selected')));
}
async function ordered(page) {
  return page.locator('.board-entity').evaluateAll(nodes => nodes.sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex)).map(node => node.dataset.entityId));
}
async function geometry(page, id) {
  return entity(page, id).evaluate(node => ({ x: Number.parseFloat(node.style.left), y: Number.parseFloat(node.style.top), width: Number.parseFloat(node.style.width), height: Number.parseFloat(node.style.height), locked: node.classList.contains('is-position-locked') }));
}
async function awaitOrder(page, expected) {
  await page.waitForFunction(ids => {
    const nodes = [...document.querySelectorAll('.board-entity')].sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex));
    return JSON.stringify(nodes.map(node => node.dataset.entityId)) === JSON.stringify(ids);
  }, expected, { timeout: 20000 });
}
async function awaitGeometry(page, id, expected) {
  await page.waitForFunction(({ id, expected }) => {
    const node = document.querySelector(`[data-entity-id="${id}"]`);
    if (!node) return false;
    const actual = { x: Number.parseFloat(node.style.left), y: Number.parseFloat(node.style.top), width: Number.parseFloat(node.style.width), height: Number.parseFloat(node.style.height), locked: node.classList.contains('is-position-locked') };
    return Object.entries(expected).every(([key, value]) => typeof value === 'number' ? Math.abs(actual[key] - value) < .1 : actual[key] === value);
  }, { id, expected }, { timeout: 20000 });
}
async function drag(page, start, dx, dy) {
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 }); await page.mouse.up();
}
async function resize(page, id, dx, dy) {
  const bounds = await entity(page, id).locator('.board-resize-handle').boundingBox();
  assert.ok(bounds, 'Selected object must expose a resize handle.');
  await drag(page, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, dx, dy);
}
async function action(page, id, label) {
  await select(page, id);
  await page.getByRole('toolbar', { name: 'Selected object controls' }).getByRole('button', { name: label, exact: true }).click();
}
async function addNote(page, text) {
  await page.locator('[data-tool="sticky"]').click();
  await page.locator('#board-viewport').click({ position: { x: 350, y: 200 } });
  await page.locator('.board-text-content[contenteditable="true"]').fill(text);
  await page.locator('#room-title').click();
  return page.locator('.type-sticky').filter({ hasText: text }).getAttribute('data-entity-id');
}
async function screenshot(page, name) {
  const filename = `layers-${name}.png`;
  await page.screenshot({ path: path.join(artifactDir, filename), fullPage: true }); report.screenshots.push(filename);
}
async function transport(page) {
  return page.evaluate(async () => ({
    sockets: window.__layerTransport.sockets,
    channels: window.__layerTransport.channels,
    peers: await Promise.all(window.__layerTransport.peers.map(async peer => {
      const stats = await peer.getStats();
      const values = [...stats.values()]; const transport = values.find(value => value.type === 'transport');
      const pair = stats.get(transport?.selectedCandidatePairId); const local = stats.get(pair?.localCandidateId);
      return { state: peer.connectionState, localCandidateType: local?.candidateType, bytesSent: pair?.bytesSent, bytesReceived: pair?.bytesReceived };
    })),
  }));
}

let host, guest, late, roomUrl, targetId, otherId;
const password = `Shared-layers-${Date.now()}`;
try {
  await check('UI creates a peer canvas and a second browser receives its initial notes over WebRTC', async () => {
    host = await newPage(); await host.goto(baseUrl);
    await host.locator('#engine-label[title="wasm"]').waitFor();
    await host.locator('#new-session').click();
    await host.locator('input[name="name"]').fill('Shared canvas layers');
    await host.locator('input[name="displayName"]').fill('Layer host');
    await host.locator('input[name="password"]').fill(password);
    await host.locator('#create-form button[type="submit"], #create-form .modal-submit').click();
    await host.locator('#invite-link').waitFor(); roomUrl = await host.locator('#invite-link').inputValue();
    await host.locator('#done-invite').click(); await connected(host);
    guest = await newPage(); await join(guest, roomUrl, password, 'Layer teammate');
    await guest.waitForFunction(() => document.querySelectorAll('.board-entity').length >= 2, null, { timeout: 25000 });
    const notes = [];
    for (const text of ['Bottom layer note', 'Middle layer note', 'Top layer note']) notes.push(await addNote(host, text));
    [otherId, targetId] = notes;
    await guest.locator('.type-sticky').filter({ hasText: 'Top layer note' }).waitFor({ timeout: 20000 });
    await awaitOrder(guest, await ordered(host));
    const metadata = await host.evaluate(async () => {
      const auth = JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith('common.auth.'))));
      const response = await fetch('/api/rooms/' + encodeURIComponent(auth.room.id) + '/session', { headers: { Authorization: 'Bearer ' + auth.token } });
      const value = await response.json();
      return { status: response.status, collaboration: auth.room.collaboration, sessionCollaboration: value.room?.collaboration };
    });
    assert.equal(metadata.status, 200); assert.equal(metadata.collaboration, 'peer');
    report.room = metadata;
  });

  await check('all four layer actions update the same bottom-to-top order in both browsers', async () => {
    let expected = await ordered(host);
    for (const [label, destination] of [['Send to back', 0], ['Bring forward', 1], ['Bring to front', expected.length - 1], ['Send backward', expected.length - 2]]) {
      expected = expected.filter(id => id !== targetId); expected.splice(destination, 0, targetId);
      await action(host, targetId, label);
      await Promise.all([awaitOrder(host, expected), awaitOrder(guest, expected)]);
    }
    report.layerActions = ['Send to back', 'Bring forward', 'Bring to front', 'Send backward'];
  });

  await check('Layers selects an object fully hidden beneath another note', async () => {
    await action(host, targetId, 'Send to back'); await awaitOrder(guest, await ordered(host));
    const hidden = await entity(guest, targetId).evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('[data-entity-id]')?.dataset.entityId !== node.dataset.entityId;
    });
    assert.equal(hidden, true, 'The test object must be occluded before selecting it from Layers.');
    await select(guest, targetId);
    await layers(guest, true);
    assert.equal(await layerRow(guest, targetId).locator('.board-layer-select').getAttribute('aria-pressed'), 'true');
    await screenshot(guest, 'hidden-object-selected'); await layers(guest, false);
    await action(guest, targetId, 'Bring to front'); await awaitOrder(host, await ordered(guest));
  });

  await check('moving and resizing an object share x, y, width, and height with the teammate', async () => {
    await select(host, targetId); const before = await geometry(host, targetId);
    const bounds = await entity(host, targetId).boundingBox();
    await drag(host, { x: bounds.x + 30, y: bounds.y + 35 }, 60, 30);
    const moved = await geometry(host, targetId);
    assert.ok(moved.x > before.x + 30 && moved.y > before.y + 10);
    await awaitGeometry(guest, targetId, moved);
    await resize(host, targetId, 90, 55); const resized = await geometry(host, targetId);
    assert.ok(resized.width > moved.width + 40 && resized.height > moved.height + 20);
    await awaitGeometry(guest, targetId, resized); report.resizedGeometry = resized;
  });

  await check('position locks synchronize, block movement and resizing, and unlock for both peers', async () => {
    await action(host, targetId, 'Lock position'); await awaitGeometry(guest, targetId, { locked: true });
    await select(guest, targetId); const locked = await geometry(guest, targetId);
    assert.equal(await entity(guest, targetId).locator('.board-resize-handle').isVisible(), false);
    const bounds = await entity(guest, targetId).boundingBox();
    await drag(guest, { x: bounds.x + 25, y: bounds.y + 30 }, 45, 25);
    await drag(guest, { x: bounds.x + bounds.width - 2, y: bounds.y + bounds.height - 2 }, 35, 25);
    assert.deepEqual(await geometry(guest, targetId), locked);
    await awaitGeometry(host, targetId, locked);
    await action(guest, targetId, 'Unlock position'); await awaitGeometry(host, targetId, { locked: false });
    await resize(guest, targetId, 25, 20); const unlocked = await geometry(guest, targetId);
    assert.ok(unlocked.width > locked.width && unlocked.height > locked.height);
    await awaitGeometry(host, targetId, unlocked);
  });

  await check('reordering during another user’s resize preserves both the layer and the new dimensions', async () => {
    await select(guest, targetId); await select(host, targetId);
    const before = await geometry(guest, targetId); const bounds = await entity(guest, targetId).locator('.board-resize-handle').boundingBox();
    const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    await guest.mouse.move(start.x, start.y); await guest.mouse.down();
    await guest.mouse.move(start.x + 20, start.y + 10, { steps: 3 });
    await host.getByRole('toolbar', { name: 'Selected object controls' }).getByRole('button', { name: 'Send to back', exact: true }).click();
    const expected = (await ordered(host)).filter(id => id !== targetId); expected.unshift(targetId);
    await awaitOrder(guest, expected);
    await guest.mouse.move(start.x + 70, start.y + 40, { steps: 5 }); await guest.mouse.up();
    const after = await geometry(guest, targetId);
    assert.ok(after.width > before.width + 40 && after.height > before.height + 20);
    await Promise.all([awaitGeometry(host, targetId, after), awaitOrder(host, expected), awaitOrder(guest, expected)]);
    report.concurrentResize = { before, after, order: expected };
  });

  await check('a dropped image larger than 64 KB arrives intact through chunked data-channel messages', async () => {
    const image = await host.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 384; canvas.height = 256;
      const paint = canvas.getContext('2d'); const pixels = paint.createImageData(canvas.width, canvas.height);
      let random = 0x12345678;
      for (let i = 0; i < pixels.data.length; i += 4) {
        for (let color = 0; color < 3; ++color) { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; pixels.data[i + color] = random & 255; }
        pixels.data[i + 3] = 255;
      }
      paint.putImageData(pixels, 0, 0); const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'large-peer-image.png', { type: 'image/png' }));
      document.querySelector('#board-viewport').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      return { bytes: blob.size, width: canvas.width, height: canvas.height };
    });
    assert.ok(image.bytes > 64 * 1024 && image.bytes < 1.3 * 1024 * 1024, JSON.stringify(image));
    await guest.waitForFunction(() => [...document.querySelectorAll('.type-image img')].some(node => node.complete && node.naturalWidth === 384 && node.naturalHeight === 256), null, { timeout: 25000 });
    assert.equal(await host.locator('.type-image img').getAttribute('src'), await guest.locator('.type-image img').getAttribute('src'));
    const frames = (await transport(host)).channels.filter(channel => channel.label === 'common-canvas-v1').flatMap(channel => channel.sent);
    const chunks = frames.filter(frame => frame.total > 64 * 1024 && frame.count > 1);
    assert.ok(chunks.length > 4, JSON.stringify(frames)); assert.ok(chunks.every(frame => frame.bytes <= 16 * 1024 + 20));
    report.largeImage = { ...image, chunks: chunks.length, largestFrameBytes: Math.max(...chunks.map(frame => frame.bytes)) };
  });

  await check('a late third browser receives the full canvas, layer order, image, and position lock from peers', async () => {
    await action(host, otherId, 'Lock position'); await awaitGeometry(guest, otherId, { locked: true });
    const expected = await ordered(host); const expectedGeometry = await Promise.all(expected.map(async id => [id, await geometry(host, id)]));
    late = await newPage(); await join(late, roomUrl, password, 'Late teammate');
    await awaitOrder(late, expected);
    for (const [id, value] of expectedGeometry) await awaitGeometry(late, id, value);
    await late.waitForFunction(() => [...document.querySelectorAll('.type-image img')].some(node => node.complete && node.naturalWidth === 384), null, { timeout: 20000 });
    assert.equal(await late.locator('.type-image img').getAttribute('src'), await host.locator('.type-image img').getAttribute('src'));
    await layers(late, true); await screenshot(late, 'late-peer-canvas');
  });

  await check('canvas updates use real peer data channels while signaling retains no board entities', async () => {
    report.transports = await Promise.all([host, guest, late].map(transport));
    for (const observation of report.transports) {
      const inits = observation.sockets.flatMap(socket => socket.inits);
      assert.ok(inits.length > 0); assert.ok(inits.every(init => init.collaboration === 'peer' && init.entityCount === 0), JSON.stringify(inits));
      assert.deepEqual(observation.sockets.flatMap(socket => socket.outgoing).filter(type => ['upsert', 'delete'].includes(type)), []);
      assert.ok(observation.channels.some(channel => channel.label === 'common-canvas-v1' && channel.state === 'open' && channel.sent.length && channel.received.length));
      assert.ok(observation.peers.some(peer => peer.state === 'connected' && peer.bytesSent > 0 && peer.bytesReceived > 0));
    }
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
  });
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; console.error(error);
  for (const [index, page] of pages.entries()) {
    if (page.isClosed()) continue;
    await screenshot(page, `failure-${index}`).catch(() => {});
    report[`failure-${index}`] = { order: await ordered(page).catch(() => []), entities: await page.locator('.board-entity').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.entityId, text: node.textContent.slice(0, 100), left: node.style.left, top: node.style.top, width: node.style.width, height: node.style.height, classes: node.className }))).catch(() => []), transport: await transport(page).catch(error => ({ error: error.message })) };
  }
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(artifactDir, 'browser-layers-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
