/**
 * Integration check against a running app (bun run dev, or the built server).
 * Uses installed Playwright and Chromium; it does not download a browser.
 * BASE_URL, PLAYWRIGHT_MODULE, and CHROMIUM_PATH can override local defaults.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core', '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core'].filter(Boolean)) {
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
const report = { baseUrl, startedAt: new Date().toISOString(), checks: [], consoleErrors: [], pageErrors: [], failedRequests: [], screenshots: [] };
const browser = await playwright.chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
const contexts = [];

async function context(options = {}) {
  const result = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  contexts.push(result);
  await result.addInitScript(() => {
    window.__captureStreams = [];
    window.__peerConnections = [];
    window.__testSockets = [];
    window.__socketTraffic = [];
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget);
        window.__peerConnections.push(peer);
        return peer;
      },
    });
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        if (new URL(socket.url).pathname !== '/ws') return socket;
        const record = (direction, value) => {
          try {
            const message = JSON.parse(value);
            window.__socketTraffic.push({ direction, type: message.type, signal: message.data?.description?.type || (message.data?.candidate ? 'candidate' : null) });
          } catch { /* Not application JSON. */ }
        };
        socket.addEventListener('message', (event) => record('in', event.data));
        const send = socket.send.bind(socket);
        socket.send = (value) => { record('out', value); return send(value); };
        window.__testSockets.push(socket);
        return socket;
      },
    });
    // Synthetic capture source only. Real RTCPeerConnections and media transport
    // remain untouched, allowing decoded remote video frames to be verified.
    if (!navigator.mediaDevices) return; // The initial about:blank is not a secure context.
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        const paint = canvas.getContext('2d');
        let frame = 0;
        function draw() {
          paint.fillStyle = frame % 2 ? '#2c5944' : '#567263';
          paint.fillRect(0, 0, canvas.width, canvas.height);
          paint.fillStyle = '#fff'; paint.font = 'bold 32px sans-serif';
          paint.fillText('Common browser capture', 44, 145);
          paint.font = '24px sans-serif'; paint.fillText(`Frame ${++frame}`, 44, 195);
        }
        draw();
        const stream = canvas.captureStream(12);
        const timer = setInterval(draw, 80);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        window.__captureStreams.push(stream);
        return stream;
      },
    });
  });
  result.on('page', (page) => {
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push({ page: page.url(), text: message.text() });
    });
    page.on('pageerror', (error) => report.pageErrors.push({ page: page.url(), message: error.message }));
    page.on('requestfailed', (request) => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  });
  return result;
}
async function check(name, work) {
  const start = Date.now();
  await work();
  report.checks.push({ name, passed: true, durationMs: Date.now() - start });
  console.log(`PASS ${name}`);
}
async function screenshot(page, name) {
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(artifactDir, filename), fullPage: true });
  report.screenshots.push(filename);
}
async function connected(page) {
  await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent.includes('Connected'), null, { timeout: 15000 });
}
async function addText(page, type, text, position) {
  await page.locator(`[data-tool="${type}"]`).click();
  await page.locator('#board-viewport').click({ position });
  const editing = page.locator('.board-text-content[contenteditable="true"]');
  await editing.fill(text);
  await page.locator('#room-title').click();
}
async function decodedVideo(page, count) {
    await page.waitForFunction((expected) => {
    const videos = [...document.querySelectorAll('.type-screen video')];
    return videos.length === expected && videos.every((video) =>
      video.srcObject && video.readyState >= 2 && video.videoWidth === 640 && video.currentTime > 0);
  }, count, { timeout: 25000 });
}

let host, guest, roomUrl;
try {
  const hostContext = await context();
  host = await hostContext.newPage();
  await check('personal canvas loads with the real WebAssembly kernel', async () => {
    await host.goto(baseUrl);
    await host.locator('#engine-label[title="wasm"]').waitFor();
    assert.equal(await host.locator('.board-entity').count(), 9);
    assert.match(await host.locator('.type-rectangle').first().textContent(), /An idea/);
    await screenshot(host, 'desktop-canvas');
  });

  const password = `Common-browser-${Date.now()}`;
  await check('host creates a password-protected room and invitation link through the UI', async () => {
    await host.locator('#new-session').click();
    await host.locator('input[name="name"]').fill('Friday thinking space');
    await host.locator('input[name="displayName"]').fill('Alex');
    await host.locator('input[name="password"]').fill(password);
    await host.locator('#create-form button[type="submit"], #create-form .modal-submit').click();
    await host.locator('#invite-link').waitFor();
    roomUrl = await host.locator('#invite-link').inputValue();
    assert.match(roomUrl, /\/room\/[A-Za-z0-9_-]+$/);
    assert.ok(!roomUrl.includes(password));
    await host.locator('#done-invite').click();
    await connected(host);
  });

  const guestContext = await context();
  guest = await guestContext.newPage();
  await check('a separate browser rejects a wrong password, then joins with the correct password', async () => {
    await guest.goto(roomUrl);
    await guest.locator('input[name="displayName"]').fill('Sam');
    await guest.locator('input[name="password"]').fill('wrong-password');
    await guest.locator('.modal-submit').click();
    await guest.locator('.form-error').filter({ hasText: 'does not match' }).waitFor();
    await guest.locator('input[name="password"]').fill(password);
    await guest.locator('.modal-submit').click();
    await connected(guest);
    await host.waitForFunction(() => document.querySelector('#people-number')?.textContent === '2');
    assert.equal(await guest.locator('#people-number').textContent(), '2');
  });

  await check('text and sticky edits synchronize in both directions', async () => {
    await addText(host, 'text', 'An idea from Alex', { x: 450, y: 100 });
    await guest.locator('.type-text').filter({ hasText: 'An idea from Alex' }).waitFor();
    await addText(guest, 'sticky', 'Sam adds a second perspective', { x: 460, y: 245 });
    await host.locator('.type-sticky').filter({ hasText: 'Sam adds a second perspective' }).waitFor();
  });

  await check('dropping one image creates exactly one shared image', async () => {
    await host.evaluate(async () => {
      const image = document.createElement('canvas'); image.width = 80; image.height = 60;
      const paint = image.getContext('2d'); paint.fillStyle = '#2c5944'; paint.fillRect(0, 0, 80, 60);
      const blob = await new Promise((resolve) => image.toBlob(resolve, 'image/png'));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([blob], 'shared-image.png', { type: 'image/png' }));
      document.querySelector('#board-viewport').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });
    await host.locator('.type-image img').waitFor();
    await guest.locator('.type-image img').waitFor();
    assert.equal(await host.locator('.type-image').count(), 1);
    assert.equal(await guest.locator('.type-image').count(), 1);
  });

  await check('chat messages reach the other browser', async () => {
    await Promise.all([host.locator('[data-panel="chat"]').click(), guest.locator('[data-panel="chat"]').click()]);
    await host.locator('#chat-text').fill('Let’s connect these two ideas.');
    await host.locator('#chat-form button').click();
    await guest.locator('.chat-message').filter({ hasText: 'Let’s connect these two ideas.' }).waitFor();
    await guest.locator('#chat-text').fill('The shared canvas is in sync.');
    await guest.locator('#chat-form button').click();
    await host.locator('.chat-message').filter({ hasText: 'The shared canvas is in sync.' }).waitFor();
  });

  await check('Mermaid renders locally as SVG in both browsers', async () => {
    await host.locator('[data-tool="diagram"]').click();
    await host.locator('textarea[name="source"]').fill('flowchart LR\n  spark[A shared thought] --> plan[A plan together]');
    await host.locator('.modal-submit').click();
    await host.locator('.board-diagram-body svg').waitFor({ timeout: 25000 });
    await guest.locator('.board-diagram-body svg').waitFor({ timeout: 25000 });
    assert.match(await guest.locator('.board-diagram-body svg').textContent(), /A shared thought/);
  });

  await check('an expired stored token returns to password entry instead of retrying forever', async () => {
    const invalidContext = await context();
    const invalidPage = await invalidContext.newPage();
    const saved = await guest.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find((key) => key.startsWith('common.auth.')))));
    saved.token = 'deliberately-invalid-token';
    await invalidContext.addInitScript((value) => { sessionStorage.setItem('common.auth.' + value.room.id, JSON.stringify(value)); }, saved);
    await invalidPage.goto(roomUrl);
    await invalidPage.locator('input[name="password"]').waitFor({ timeout: 15000 });
    assert.equal(await invalidPage.locator('.modal-submit').textContent().then((text) => text.trim()), 'Join the conversation');
    await invalidContext.close();
  });

  await check('mobile canvas, participants toggle, and session menu fit a 390 × 844 viewport', async () => {
    const mobileContext = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await mobileContext.newPage();
    await mobile.goto(baseUrl);
    await mobile.locator('#engine-label[title="wasm"]').waitFor();
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The page overflows horizontally.');
    await mobile.locator('#toggle-panel').click();
    assert.equal(await mobile.locator('#toggle-panel').getAttribute('aria-expanded'), 'true');
    await mobile.locator('#toggle-panel').click();
    await mobile.locator('#room-menu').click();
    const bounds = await mobile.locator('.modal').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 844, JSON.stringify(bounds));
    await mobile.locator('.close-modal').click();
    await screenshot(mobile, 'mobile-canvas');
  });

  await check('two simultaneous synthetic captures travel over real WebRTC and decode remotely', async () => {
    await host.locator('#share-screen').click();
    await decodedVideo(guest, 1);
    await guest.locator('#share-screen').click();
    await Promise.all([decodedVideo(host, 2), decodedVideo(guest, 2)]);
    const peers = await guest.evaluate(async () => {
      const result = [];
      for (const pc of window.__peerConnections) {
        const stats = await pc.getStats();
      const values = [...stats.values()];
      const transport = values.find((value) => value.type === 'transport');
      const selected = stats.get(transport?.selectedCandidatePairId);
      const local = stats.get(selected?.localCandidateId);
      result.push({ state: pc.connectionState, inboundFrames: values.filter((value) => value.type === 'inbound-rtp' && value.kind === 'video').reduce((sum, value) => sum + (value.framesDecoded || 0), 0), localCandidateType: local?.candidateType, localProtocol: local?.protocol, relayProtocol: local?.relayProtocol });
      }
      return result;
    });
    assert.ok(peers.some((peer) => peer.state === 'connected' && peer.inboundFrames > 0), JSON.stringify(peers));
    report.webRtc = { captureSource: 'synthetic canvas.captureStream', transport: 'real localhost RTCPeerConnection', guestPeers: peers };
    await host.locator('#fit-canvas').click();
    await screenshot(host, 'desktop-live-session');
  });

  await check('explicit stop removes each owner’s screen tile in both browsers and ends capture', async () => {
    await host.locator('#share-screen').click();
    await host.waitForFunction(() => document.querySelectorAll('.type-screen').length === 1);
    await guest.waitForFunction(() => document.querySelectorAll('.type-screen').length === 1);
    assert.equal(await host.evaluate(() => window.__captureStreams[0].getVideoTracks()[0].readyState), 'ended');
    await guest.locator('#share-screen').click();
    await host.waitForFunction(() => document.querySelectorAll('.type-screen').length === 0);
    await guest.waitForFunction(() => document.querySelectorAll('.type-screen').length === 0);
    assert.equal(await guest.evaluate(() => window.__captureStreams[0].getVideoTracks()[0].readyState), 'ended');
  });

  await check('a socket disconnect stops capture, blocks offline edits, and reconnects with the same identity', async () => {
    await guest.locator('#share-screen').click();
    await decodedVideo(host, 1);
    const entityCount = await guest.locator('.board-entity:not(.type-screen)').count();
    const identity = await guest.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find((key) => key.startsWith('common.auth.')))).participantId);
    await guest.evaluate(() => window.__testSockets.filter((socket) => socket.readyState === WebSocket.OPEN).forEach((socket) => socket.close()));
    await guest.waitForFunction(() => document.querySelector('#connection-status').classList.contains('disconnected'));
    await guest.locator('[data-tool="sticky"]').click();
    await guest.locator('#board-viewport').click({ position: { x: 250, y: 100 } });
    assert.equal(await guest.locator('[contenteditable="true"]').count(), 0);
    assert.equal(await guest.locator('.board-entity:not(.type-screen)').count(), entityCount);
    assert.equal(await guest.evaluate(() => window.__captureStreams.at(-1).getVideoTracks()[0].readyState), 'ended');
    await connected(guest);
    assert.equal(await guest.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find((key) => key.startsWith('common.auth.')))).participantId), identity);
    await host.waitForFunction(() => document.querySelectorAll('.type-screen').length === 0);
    await guest.waitForFunction(() => document.querySelectorAll('.type-screen').length === 0);
    await guest.locator('[data-tool="select"]').click();
  });

  await check('no uncaught browser runtime errors', async () => {
    assert.deepEqual(report.pageErrors, []);
    // Password rejection and the deliberately-invalid token above intentionally
    // produce 401 resource messages in Chromium's console.
    const unexpected = report.consoleErrors.filter((entry) => !/Failed to load resource: the server responded with a status of 401/.test(entry.text));
    assert.deepEqual(unexpected, []);
  });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { message: error.message, stack: error.stack };
  console.error(error);
  for (const [name, page] of [['host-failure', host], ['guest-failure', guest]]) {
    if (page && !page.isClosed()) {
      report[name] = await page.evaluate(async () => ({
        videos: [...document.querySelectorAll('video')].map((video) => ({ width: video.videoWidth, height: video.videoHeight, readyState: video.readyState, currentTime: video.currentTime, paused: video.paused, error: video.error?.message, stream: video.srcObject?.id, tracks: video.srcObject?.getVideoTracks().map((track) => ({ state: track.readyState, muted: track.muted, enabled: track.enabled, settings: track.getSettings() })) })),
        captures: window.__captureStreams?.map((stream) => stream.getVideoTracks().map((track) => ({ readyState: track.readyState, settings: track.getSettings() }))),
        peers: await Promise.all((window.__peerConnections || []).map(async (peer) => ({
          state: peer.connectionState, iceState: peer.iceConnectionState, signaling: peer.signalingState, localDescription: peer.localDescription?.type, remoteDescription: peer.remoteDescription?.type,
          transceivers: peer.getTransceivers().map((value) => ({ direction: value.direction, currentDirection: value.currentDirection, mid: value.mid, sender: value.sender.track?.readyState, receiver: value.receiver.track?.readyState, receiverMuted: value.receiver.track?.muted })),
          stats: [...(await peer.getStats()).values()].filter((value) => ['inbound-rtp', 'outbound-rtp', 'transport', 'candidate-pair'].includes(value.type)).map((value) => ({ type: value.type, kind: value.kind, state: value.state, framesEncoded: value.framesEncoded, framesDecoded: value.framesDecoded, bytesSent: value.bytesSent, bytesReceived: value.bytesReceived, nominated: value.nominated, dtlsState: value.dtlsState })),
        }))),
        traffic: window.__socketTraffic,
        toasts: [...document.querySelectorAll('.toast')].map((value) => value.textContent),
      })).catch((error) => ({ error: error.message }));
      await screenshot(page, name).catch(() => {});
    }
  }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(artifactDir, 'browser-smoke-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
