/** Five user journeys against an isolated loopback app. No browser download,
 * private app state, live deployment, relay, trace, or credential artifacts. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const require = createRequire(import.meta.url);
const timeout = 20000;
const definitions = [
  ['personal-canvas', 'The WASM canvas creates, edits, and undoes a local note.'],
  ['guided-room', 'A phone rejects a wrong password, joins, and becomes ready without capture.'],
  ['chat-and-reload', 'Chat works both ways; phone reload preserves identity and its checklist.'],
  ['agent-consent', 'Only visible consent enables agent edits; PNG download works and revocation blocks edits.'],
  ['native-peers', 'Native peers exchange canvas edits and decoded video; stop and room end revoke access.'],
];

const loadPlaywright = async playwrightModule => playwrightModule ? require(playwrightModule) : import('playwright-core');
export async function resolveChromiumPath({ chromiumPath = process.env.CHROMIUM_PATH, playwrightModule = process.env.PLAYWRIGHT_MODULE } = {}) {
  const { chromium } = await loadPlaywright(playwrightModule);
  const candidates = chromiumPath ? [chromiumPath] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', chromium.executablePath()];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* Try an existing local executable. */ } }
  throw new Error('No usable Chrome/Chromium executable was found. Set CHROMIUM_PATH to an existing browser, or install one once with bunx playwright-core install chromium. This command never downloads browsers.');
}

export async function runBrowserJourney({ baseUrl = 'http://127.0.0.1:4173', artifactDir = 'artifacts/journeys',
  chromiumPath = process.env.CHROMIUM_PATH, playwrightModule = process.env.PLAYWRIGHT_MODULE, requirePeers = true, signal } = {}) {
  const origin = new URL(baseUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname)) {
    throw new Error('Browser journeys require a loopback origin (for example http://127.0.0.1:4173). Never run them against a shared or live deployment.');
  }
  artifactDir = path.resolve(artifactDir); await mkdir(artifactDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), origin: origin.origin, status: 'incomplete', passed: false, partial: true,
    journeys: definitions.map(([name, expected]) => ({ name, expected, status: 'pending', checkpoints: [] })),
    pageErrors: [], consoleErrors: [], networkErrors: [], screenshots: [] };
  const secrets = [];
  const safe = value => {
    let text = stripVTControlCharacters(String(value)).replace(/\/(?:api\/)?rooms?\/[A-Za-z0-9_-]+/g, match => match.startsWith('/api/') ? '/api/rooms/:room' : '/room/:room');
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/("?(?:token|password|authorization)"?\s*[:=]\s*"?)[^\s",}]+/gi, '$1[redacted]').replace(/\?[^\s"']+/g, '?[redacted]').slice(0, 1600);
  };
  const endpoint = url => { try { return safe(new URL(url).pathname); } catch { return 'unknown endpoint'; } };
  let browser, host, phone, roomUrl, phoneIdentity, hostToken, ended = false, expectedPasswordFailure = false, active;
  const pages = [];
  const abort = () => { browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const screenshot = async (page, name) => {
    const filename = `${name}.png`;
    await page.screenshot({ path: path.join(artifactDir, filename), fullPage: true,
      mask: [page.locator('#invite-link, input[name="password"]')] });
    report.screenshots.push(filename);
  };
  const checkpoint = async (name, work) => {
    const started = Date.now();
    try { const result = await work(); active.checkpoints.push({ name, passed: true, durationMs: Date.now() - started }); return result; }
    catch (error) { active.checkpoints.push({ name, passed: false, durationMs: Date.now() - started }); throw new Error(`${name}: ${safe(error.message)}`, { cause: error }); }
  };
  const journey = async (index, work) => {
    active = report.journeys[index]; active.status = 'running'; const started = Date.now();
    try {
      await work();
      assert.deepEqual(report.pageErrors, [], 'An uncaught browser error occurred; see pageErrors.');
      assert.deepEqual(report.consoleErrors, [], 'An unexpected console error occurred; see consoleErrors.');
      assert.deepEqual(report.networkErrors, [], 'An unexpected HTTP/network error occurred; see networkErrors.');
      active.status = 'passed'; console.log(`PASS ${active.name}: ${active.expected}`);
    } catch (error) { active.status = 'failed'; active.failure = safe(error.message); throw error; }
    finally { active.durationMs = Date.now() - started; }
  };
  const connected = page => page.waitForFunction(() => document.querySelector('#connection-status')?.textContent.includes('Connected'), null, { timeout });
  const guide = async (page, open) => {
    const toggle = page.locator('.session-guide-toggle');
    if ((await toggle.getAttribute('aria-expanded') === 'true') !== open) await toggle.click();
  };
  const endRoom = async () => {
    if (!roomUrl || ended || !host || host.isClosed()) return;
    await host.locator('.close-modal').click({ timeout: 500 }).catch(() => {});
    await host.getByRole('button', { name: 'Close agent tools', exact: true }).click({ timeout: 500 }).catch(() => {});
    await host.locator('#room-menu').click({ timeout: 3000 });
    await host.locator('#end-room').click({ timeout: 3000 });
    await host.locator('#confirm-end').click({ timeout: 3000 });
    await host.locator('#modal-title').filter({ hasText: 'Session ended' }).waitFor({ timeout }); ended = true;
  };
  const newPage = async (name, mobile = false) => {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(({ mobile }) => {
      // Observe standards-based RTC counters. Native negotiation and transport are unchanged.
      window.__journey = { peers: [], captures: [], captureCalls: 0 };
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(NativePeer, { construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget); window.__journey.peers.push(peer); return peer;
      } });
      if (!navigator.mediaDevices) return;
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: mobile ? undefined : async () => {
        window.__journey.captureCalls++;
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const paint = canvas.getContext('2d'); let frame = 0;
        const draw = () => { paint.fillStyle = ++frame % 2 ? '#305e48' : '#7a947e'; paint.fillRect(0, 0, 640, 360);
          paint.fillStyle = '#fff'; paint.font = '28px sans-serif'; paint.fillText(`Common journey frame ${frame}`, 32, 180); };
        draw(); const stream = canvas.captureStream(12); const timer = setInterval(draw, 80);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        window.__journey.captures.push(stream); return stream;
      } });
    }, { mobile });
    const page = await context.newPage(); page.setDefaultTimeout(timeout); pages.push({ name, page });
    page.on('pageerror', error => report.pageErrors.push({ page: name, message: safe(error.message) }));
    page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) report.consoleErrors.push({ page: name, message: safe(message.text()) }); });
    page.on('response', response => {
      if (response.status() < 400) return;
      const entry = { page: name, endpoint: endpoint(response.url()), status: response.status() };
      if (expectedPasswordFailure && response.status() === 401 && entry.endpoint.endsWith('/join')) report.expectedPasswordRejection = entry;
      else report.networkErrors.push(entry);
    });
    page.on('requestfailed', request => { const error = request.failure()?.errorText || 'Network request failed';
      if (!/ERR_ABORTED|NS_BINDING_ABORTED|Target closed/i.test(error)) report.networkErrors.push({ page: name, endpoint: endpoint(request.url()), error: safe(error) }); });
    return page;
  };
  const addNote = async (page, text, touch = false) => {
    await page.locator('[data-tool="sticky"]').click();
    await page.locator('#board-viewport')[touch ? 'tap' : 'click']({ position: { x: 130, y: 145 } });
    await page.locator('.board-text-content[contenteditable="true"]').fill(text);
    await page.locator('#room-title').click();
    return page.locator('.type-sticky').filter({ hasText: text });
  };
  const rtc = page => page.evaluate(async () => Promise.all(window.__journey.peers.map(async peer => {
    const values = [...(await peer.getStats()).values()];
    return { state: peer.connectionState, ice: peer.iceConnectionState, gathering: peer.iceGatheringState, signaling: peer.signalingState,
      localDescription: peer.localDescription?.type || null, remoteDescription: peer.remoteDescription?.type || null,
      localCandidates: values.filter(value => value.type === 'local-candidate').length,
      candidateProtocols: [...new Set(values.filter(value => value.type === 'local-candidate').map(value => value.protocol))], remoteCandidates: values.filter(value => value.type === 'remote-candidate').length,
      dataChannels: values.filter(value => value.type === 'data-channel').map(value => ({ state: value.state, sent: value.messagesSent, received: value.messagesReceived })),
      framesDecoded: values.filter(value => value.type === 'inbound-rtp' && value.kind === 'video').reduce((sum, value) => sum + (value.framesDecoded || 0), 0) };
  })));
  try {
    signal?.throwIfAborted();
    const { chromium } = await loadPlaywright(playwrightModule);
    chromiumPath = await resolveChromiumPath({ chromiumPath, playwrightModule });
    browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
    signal?.throwIfAborted();
    host = await newPage('desktop');
    await journey(0, async () => {
      await checkpoint('Load the real WebAssembly kernel', async () => { await host.goto(origin.origin); await host.locator('#engine-label[title="wasm"]').waitFor(); });
      const note = await checkpoint('Create a personal sticky note', () => addNote(host, 'A small starting point'));
      await checkpoint('Edit the note, then undo only that edit', async () => {
        await note.click(); await host.getByRole('button', { name: 'Edit text or diagram (Enter)', exact: true }).click();
        await host.locator('.board-text-content[contenteditable="true"]').fill('An edited starting point'); await host.locator('#room-title').click();
        await host.locator('#undo-canvas').click(); await note.waitFor();
        assert.equal(await host.locator('.type-sticky').filter({ hasText: 'An edited starting point' }).count(), 0);
        await screenshot(host, 'personal-canvas');
      });
    });
    const password = `Common-journey-${Date.now()}`; secrets.push(password);
    await journey(1, async () => {
      await checkpoint('Create a guided room with a planned phone attendee', async () => {
        await host.locator('#new-session').click(); await host.locator('input[name="name"]').fill('Common browser journey');
        await host.locator('input[name="displayName"]').fill('Journey host'); await host.locator('input[name="password"]').fill(password);
        await host.locator('#session-attendees').fill('Phone teammate'); await host.locator('#session-tasks').fill('Review the proposal\nMark yourself ready');
        const creation = host.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/rooms' && response.ok());
        await host.locator('#create-form .modal-submit').click(); hostToken = (await (await creation).json()).token; secrets.push(hostToken); await host.locator('#invite-link').waitFor();
        roomUrl = await host.locator('#invite-link').inputValue(); assert.equal(new URL(roomUrl).origin, origin.origin); assert.ok(!roomUrl.includes(password));
        await host.locator('#done-invite').click(); await connected(host);
      });
      phone = await newPage('phone', true);
      await checkpoint('Reject one wrong password, then admit the separate phone browser', async () => {
        await phone.goto(roomUrl); await phone.locator('input[name="displayName"]').fill('Phone teammate');
        await phone.locator('input[name="password"]').fill('deliberately-wrong'); expectedPasswordFailure = true;
        await phone.locator('.modal-submit').click(); await phone.locator('.form-error').filter({ hasText: 'does not match' }).waitFor(); expectedPasswordFailure = false;
        assert.ok(report.expectedPasswordRejection, 'The wrong password must receive HTTP 401.');
        await phone.locator('input[name="password"]').fill(password);
        const admission = phone.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/join') && response.ok());
        await phone.locator('.modal-submit').click(); const identity = await (await admission).json(); phoneIdentity = identity.participantId; secrets.push(identity.token);
        await connected(phone); await host.waitForFunction(() => document.querySelector('#people-number')?.textContent === '2');
      });
      await checkpoint('Explicitly choose Watch & contribute, claim a place, and complete real tasks', async () => {
        await guide(phone, true); await phone.getByRole('button', { name: 'Join without sharing', exact: true }).click();
        await phone.waitForFunction(() => document.querySelector('.session-guide-participation-choice[aria-pressed="true"]')?.textContent === 'Watch & contribute');
        await phone.getByLabel('Your place in the session plan').selectOption({ label: 'Phone teammate' });
        for (const name of ['Review the proposal', 'Mark yourself ready']) {
          await phone.getByRole('checkbox', { name: new RegExp(`^${name}`) }).check();
          await phone.locator('.session-guide-task').filter({ hasText: name }).locator('.session-guide-task-state').filter({ hasText: 'Done' }).waitFor();
        }
        await guide(host, true); await host.locator('.session-guide-section-heading').filter({ hasText: 'Who’s ready' }).filter({ hasText: '1 ready' }).waitFor();
        assert.equal(await phone.evaluate(() => window.__journey.captureCalls), 0);
        assert.equal(await phone.evaluate(() => typeof navigator.mediaDevices.getDisplayMedia), 'undefined');
        await screenshot(phone, 'phone-ready'); await guide(phone, false); await guide(host, false);
      });
    });
    await journey(2, async () => {
      await checkpoint('Send chat in both directions', async () => {
        for (const page of [host, phone]) { if (await page.locator('#toggle-panel').getAttribute('aria-expanded') !== 'true') await page.locator('#toggle-panel').click(); await page.locator('[data-panel="chat"]').click(); }
        await host.locator('#chat-text').fill('A thought from the host'); await host.locator('#chat-form button').click();
        await phone.locator('.chat-message').filter({ hasText: 'A thought from the host' }).waitFor();
        await phone.locator('#chat-text').fill('The phone is here too'); await phone.locator('#chat-form button').click();
        await host.locator('.chat-message').filter({ hasText: 'The phone is here too' }).waitFor();
        await phone.locator('#close-panel').click(); await phone.waitForFunction(() => document.activeElement?.id === 'toggle-panel');
      });
      await checkpoint('Reload without losing identity, mode, claim, or completed checklist', async () => {
        const session = phone.waitForResponse(response => new URL(response.url()).pathname.endsWith('/session') && response.ok());
        await phone.reload(); assert.equal((await (await session).json()).participantId, phoneIdentity); await connected(phone); await guide(phone, true);
        assert.equal(await phone.getByRole('button', { name: 'Watch & contribute', exact: true }).getAttribute('aria-pressed'), 'true');
        assert.equal(await phone.getByLabel('Your place in the session plan').locator('option:checked').textContent(), 'Phone teammate');
        for (const name of ['Review the proposal', 'Mark yourself ready']) assert.equal(await phone.getByRole('checkbox', { name: new RegExp(`^${name}`) }).isChecked(), true);
        assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Phone content overflows horizontally.');
        assert.equal(await phone.evaluate(() => window.__journey.captureCalls), 0);
        await screenshot(phone, 'phone-reloaded'); await guide(phone, false);
      });
      await checkpoint('Pinch the phone canvas without changing the host view', async () => {
        const phoneZoom = await phone.locator('#zoom-label').textContent(), hostZoom = await host.locator('#zoom-label').textContent();
        const bounds = await phone.locator('#board-viewport').boundingBox(); assert.ok(bounds);
        const x = bounds.x + bounds.width / 2, y = bounds.y + Math.min(150, bounds.height / 2);
        const touch = await phone.context().newCDPSession(phone);
        try {
          await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 35, y, id: 1 }, { x: x + 35, y, id: 2 }] });
          await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 65, y, id: 1 }, { x: x + 65, y, id: 2 }] });
          await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await phone.waitForFunction(before => document.querySelector('#zoom-label')?.textContent !== before, phoneZoom);
          assert.equal(await host.locator('#zoom-label').textContent(), hostZoom, 'Phone navigation must remain local.');
        } finally { await touch.detach(); }
      });
    });
    await journey(3, async () => {
      await checkpoint('Agent writes are blocked before visible consent', async () => {
        await host.waitForFunction(() => !!window.commonAgent);
        const denied = await host.evaluate(() => window.commonAgent.execute({ action: 'canvas.add', entity: { type: 'text', text: 'Unapproved annotation' } }));
        assert.equal(denied.ok, false); assert.equal(denied.error.code, 'AGENT_DISABLED');
        assert.equal(await host.getByText('Unapproved annotation', { exact: true }).count(), 0);
      });
      await checkpoint('Allow an annotation through Agent tools', async () => {
        await host.getByRole('button', { name: 'Agent tools', exact: true }).click(); await host.locator('#agent-grant-apply').click();
        const allowed = await host.evaluate(() => window.commonAgent.execute({ action: 'canvas.add', entity: { type: 'text', text: 'Approved walkthrough annotation', x: 80, y: 80 } }));
        assert.equal(allowed.ok, true); await host.locator('.type-text').filter({ hasText: 'Approved walkthrough annotation' }).waitFor();
      });
      await checkpoint('Download a manual PNG, then revoke agent writes', async () => {
        const download = host.waitForEvent('download'); await host.locator('#agent-snapshot').click(); const png = await download;
        assert.match(png.suggestedFilename(), /\.png$/); const filename = 'manual-canvas.png'; await png.saveAs(path.join(artifactDir, filename)); report.screenshots.push(filename);
        const bytes = await readFile(path.join(artifactDir, filename)); assert.ok(bytes.length > 100); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'The downloaded file must be a PNG.');
        await host.locator('#agent-grant-revoke').click();
        const denied = await host.evaluate(() => window.commonAgent.execute({ action: 'canvas.add', entity: { type: 'text', text: 'Revoked annotation' } }));
        assert.equal(denied.ok, false); assert.ok(['AGENT_DISABLED', 'GRANT_REVOKED', 'PERMISSION_DENIED'].includes(denied.error.code));
        assert.equal(await host.getByText('Revoked annotation', { exact: true }).count(), 0);
        await host.getByRole('button', { name: 'Close agent tools', exact: true }).click();
      });
    });
    if (requirePeers) await journey(4, async () => {
      await checkpoint('Exchange actual canvas notes over native data channels', async () => {
        try {
          await addNote(host, 'A real peer note from the host');
          await phone.locator('.type-sticky').filter({ hasText: 'A real peer note from the host' }).waitFor();
          await addNote(phone, 'A real peer note from the phone', true);
          await host.locator('.type-sticky').filter({ hasText: 'A real peer note from the phone' }).waitFor();
        } catch (error) {
          report.rtc = { host: await rtc(host), phone: await rtc(phone) };
          report.rtc.feedback = { host: (await host.locator('.toast').allTextContents()).map(safe), phone: (await phone.locator('.toast').allTextContents()).map(safe) };
          const peers = [...report.rtc.host, ...report.rtc.phone].filter(peer => peer.state !== 'closed');
          if (peers.length && peers.every(peer => peer.localCandidates === 0 && peer.state !== 'connected')) throw new Error('Native WebRTC produced no local ICE candidates in this environment. Earlier journeys passed; peer sync/video remain unverified. Run the same command on a machine that permits native UDP/ICE networking. No relay or simulated transport is used.');
          if (peers.length && peers.every(peer => !peer.candidateProtocols.includes('udp') && peer.state !== 'connected')) throw new Error('Native WebRTC gathered no UDP candidates and could not establish data channels. Check native UDP/ICE support on this machine; earlier browser journeys passed, but peer sync/video remain unverified. No relay or simulated transport is used.');
          throw new Error(`Native peer canvas did not synchronize within ${timeout / 1000}s. Inspect the safe RTC states in report.json; check signaling and native UDP/ICE networking. The transport was not simulated. ${safe(error.message)}`);
        }
      });
      await checkpoint('Move an actual shared object behind its peers', async () => {
        const note = host.locator('.type-sticky').filter({ hasText: 'A real peer note from the host' });
        const id = await note.getAttribute('data-entity-id');
        await host.getByRole('button', { name: 'Layers', exact: true }).click();
        await host.locator(`[data-layer-id="${id}"] .board-layer-select`).click();
        await host.getByRole('button', { name: 'Layers', exact: true }).click();
        await host.getByRole('toolbar', { name: 'Selected object controls' }).getByRole('button', { name: 'Send to back', exact: true }).click();
        for (const page of [host, phone]) await page.waitForFunction(target => {
          const nodes = [...document.querySelectorAll('.board-entity')].sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex));
          return nodes[0]?.dataset.entityId === target;
        }, id);
      });
      await checkpoint('Share one synthetic source and decode real remote video frames', async () => {
        await host.locator('#share-screen').click();
        const follow = phone.getByRole('button', { name: 'Follow featured', exact: true });
        if (await follow.count()) await follow.click();
        await phone.waitForFunction(() => [...document.querySelectorAll('.type-screen video')].some(video => video.srcObject && video.readyState >= 2 && video.videoWidth === 640 && video.currentTime > 0), null, { timeout });
        report.rtc = { host: await rtc(host), phone: await rtc(phone) };
        assert.ok(report.rtc.phone.some(peer => peer.state === 'connected' && peer.framesDecoded > 0), 'Native inbound RTP must report decoded video frames.');
        assert.ok([...report.rtc.host, ...report.rtc.phone].some(peer => peer.dataChannels.some(channel => channel.sent > 0 && channel.received > 0)), 'Native data-channel counters must confirm bidirectional traffic.');
        await screenshot(phone, 'phone-live-video');
      });
      await checkpoint('Stop sharing, end the room, and reject its former credentials', async () => {
        await host.locator('#share-screen').click();
        for (const page of [host, phone]) await page.waitForFunction(() => document.querySelectorAll('.type-screen').length === 0);
        assert.equal(await host.evaluate(() => window.__journey.captures[0].getVideoTracks()[0].readyState), 'ended');
        await endRoom(); await phone.locator('#modal-title').filter({ hasText: 'Session ended' }).waitFor();
        const response = await host.request.get(`${roomUrl.replace('/room/', '/api/rooms/')}/session`, { headers: { Authorization: `Bearer ${hostToken}` } }); assert.equal(response.status(), 404, 'The former host token must no longer access the ended session.');
        assert.equal(await host.locator('#undo-canvas').isDisabled(), true);
      });
    });
    else { report.journeys[4].status = 'unverified'; report.journeys[4].reason = 'Native peers were explicitly excluded; this is a partial browser review.'; }
    report.passed = requirePeers && report.journeys.every(item => item.status === 'passed'); report.partial = !report.passed; report.status = report.passed ? 'passed' : 'incomplete';
  } catch (error) {
    report.status = 'failed'; report.failure = { journey: active?.name || 'setup', message: safe(error.message) };
    for (const { name, page } of pages) if (!page.isClosed()) await screenshot(page, `${name}-failure`).catch(() => {});
  } finally {
    try { await endRoom(); report.cleanup = { ownRoomEnded: !roomUrl || ended }; }
    catch (error) { report.cleanup = { ownRoomEnded: false, message: safe(error.message) }; }
    if (!report.cleanup.ownRoomEnded) {
      report.cleanup.next = 'Stop the isolated runner to discard its temporary room data.';
      report.failure ||= { journey: 'cleanup', message: 'The browser could not end its own temporary room. Stop the isolated runner before continuing.' };
      report.passed = false; report.partial = true; report.status = 'failed';
    }
    signal?.removeEventListener('abort', abort); await browser?.close(); report.finishedAt = new Date().toISOString();
    await writeFile(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
  }
  if (report.failure) { const error = new Error(`${report.failure.journey}: ${report.failure.message} See ${path.join(artifactDir, 'report.json')}`); error.report = report; throw error; }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await runBrowserJourney({ baseUrl: process.env.BASE_URL, artifactDir: process.env.ARTIFACT_DIR, chromiumPath: process.env.CHROMIUM_PATH, playwrightModule: process.env.PLAYWRIGHT_MODULE }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
