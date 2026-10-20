/** Five user journeys against an isolated loopback app. No browser download,
 * private app state, live deployment, relay, trace, or credential artifacts. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { gunzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const timeout = 20000;
const definitions = [
  ['personal-canvas', 'The WASM canvas creates, edits, and undoes a local note; performance diagnostics measure that work.'],
  ['guided-room', 'A phone joins a styled room with its password and becomes ready without capture.'],
  ['chat-and-reload', 'Chat and host-only room styling update both browsers; reload preserves identity and the plan.'],
  ['agent-consent', 'Visible consent permits bounded object discovery and targeted edits; PNG preserves room colour and revocation ends access.'],
  ['native-peers', 'Native peers share classic media and Space & Time; autosave, history, archives, and room cleanup work.'],
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
  let browser, host, phone, roomUrl, phoneIdentity, hostToken, betaRoomUrl, betaToken, betaEnded = false, ended = false, expectedPasswordFailure = false, active;
  const pages = [];
  const abort = () => { browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const screenshot = async (page, name) => {
    const filename = `${name}.png`;
    await page.screenshot({ path: path.join(artifactDir, filename), fullPage: true,
      mask: [page.locator('#invite-link, #beta-invite-link, input[name="password"]')] });
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
  const initialStyle = { preset: 'lavender', accent: '#735d91', canvas: '#f6f3fa', pattern: 'grid' };
  const sharedStyle = { preset: 'lagoon', accent: '#2c6975', canvas: '#f0f7f6', pattern: 'plain' };
  const styled = (page, expected) => page.waitForFunction(value => {
    const root = document.documentElement, style = getComputedStyle(root);
    return root.dataset.roomAppearance === value.preset && root.dataset.roomPattern === value.pattern
      && style.getPropertyValue('--room-canvas').trim() === value.canvas && style.getPropertyValue('--room-accent').trim() === value.accent;
  }, expected);
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
  const betaMenuAction = async (page, name) => {
    const trigger = page.getByRole('button', { name: 'Room actions', exact: true });
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
    await page.locator('.beta-room-menu').locator(`[data-beta-action="${name}"]`).click();
  };
  const performanceReport = async (page, { experience, operations, excluded = [] }) => {
    // Check work produced by the real journey. Device load can legitimately
    // change the score, and a freshly opened tab may still be warming up.
    await page.waitForFunction(names => names.every(name => window.commonPerformance?.snapshot().operations
      .some(operation => operation.name === name && operation.count > 0)), operations);
    await page.getByRole('heading', { name: 'Performance', exact: true }).waitFor();
    await page.locator('[data-performance-operations]').getByRole('row').first().waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download report', exact: true }).click()]);
    assert.match(download.suggestedFilename(), /^common-performance-.*\.json$/);
    const temporaryPath = await download.path(); assert.ok(temporaryPath, 'The local browser must provide its downloaded report.');
    const text = await readFile(temporaryPath, 'utf8'), data = JSON.parse(text);
    assert.equal(data.type, 'common-performance-report'); assert.equal(data.version, 1);
    assert.equal(data.application.experience, experience);
    assert.deepEqual(Object.keys(data.application).sort(), ['buildId', 'experience', 'frontendBuildId']);
    assert.equal(data.performance.version, 1);
    assert.ok(data.performance.score === null || (Number.isFinite(data.performance.score) && data.performance.score >= 0 && data.performance.score <= 100));
    assert.ok(['paused', 'warming', 'healthy', 'strained', 'poor'].includes(data.performance.status));
    for (const name of operations) {
      const operation = data.performance.operations.find(value => value.name === name);
      assert.ok(operation?.count > 0 && Number.isFinite(operation.p95Ms) && operation.p95Ms >= 0, `The report must measure ${name} from actual canvas work.`);
    }
    assert.ok(data.performance.context.objects > 0, 'The report must describe the current workload without including its content.');
    assert.ok(!/https?:\/\//i.test(text), 'Performance reports must exclude page and resource URLs.');
    assert.ok(!/"(?:roomId|participantId|password|token|authorization)"\s*:/i.test(text), 'Performance reports must exclude identity and credential fields.');
    const roomIds = [roomUrl, betaRoomUrl].filter(Boolean).map(url => new URL(url).pathname.split('/').pop());
    for (const value of [...secrets, ...roomIds, ...excluded]) {
      assert.ok(!text.includes(value), 'Performance reports must exclude credentials, room identifiers, names, and canvas content.');
    }
    // Only retain the report after its privacy checks pass.
    const filename = `${experience}-performance.json`; await writeFile(path.join(artifactDir, filename), text);
    (report.performanceReports ||= []).push({ filename, experience, operations: operations.slice(), status: data.performance.status, score: data.performance.score });
    await page.locator('.close-modal').click();
  };
  const endBetaRoom = async () => {
    if (!betaRoomUrl || betaEnded || !host || host.isClosed()) return;
    await host.locator('.close-modal').click({ timeout: 500 }).catch(() => {});
    await betaMenuAction(host, 'end'); await host.locator('#beta-confirm-end').click({ timeout: 3000 });
    await host.locator('#modal-title').filter({ hasText: 'Session ended' }).waitFor({ timeout }); betaEnded = true;
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
    const done = page.getByRole('button', { name: 'Done editing', exact: true });
    if (await done.isVisible()) await done.click(); else await page.locator('#room-title').click();
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
      await checkpoint('Inspect measured canvas work and download a content-free performance report', async () => {
        await host.locator('#room-menu').click(); await host.locator('#performance-menu').click();
        await performanceReport(host, { experience: 'classic', operations: ['canvas-render', 'autosave'], excluded: ['A small starting point', 'An edited starting point'] });
        await note.waitFor();
      });
    });
    const password = `Common-journey-${Date.now()}`; secrets.push(password);
    await journey(1, async () => {
      await checkpoint('Create a guided room with a planned phone attendee', async () => {
        await host.locator('#new-session').click(); await host.locator('input[name="name"]').fill('Common browser journey');
        await host.locator('input[name="displayName"]').fill('Journey host'); await host.locator('input[name="password"]').fill(password);
        await host.locator('#session-attendees').fill('Phone teammate'); await host.locator('#session-tasks').fill('Review the proposal\nMark yourself ready');
        await host.locator('.appearance-details > summary').click(); await host.locator('[data-appearance-preset="lavender"]').click();
        await host.locator('[data-appearance-pattern]').selectOption('grid');
        const creation = host.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/rooms' && response.ok());
        await host.locator('#create-form .modal-submit').click(); const created = await (await creation).json(); hostToken = created.token; secrets.push(hostToken); assert.deepEqual(created.room.appearance, initialStyle); await host.locator('#invite-link').waitFor();
        roomUrl = await host.locator('#invite-link').inputValue(); assert.equal(new URL(roomUrl).origin, origin.origin); assert.ok(!roomUrl.includes(password));
        await host.locator('#done-invite').click(); await connected(host); await styled(host, initialStyle);
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
        assert.deepEqual(identity.room.appearance, initialStyle); await connected(phone); await styled(phone, initialStyle); await host.waitForFunction(() => document.querySelector('#people-number')?.textContent === '2');
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
      await checkpoint('Only the host can apply a shared room style', async () => {
        await phone.locator('#room-menu').click(); await phone.locator('#room-appearance-menu').click();
        await phone.getByRole('heading', { name: 'Room style', exact: true }).waitFor();
        assert.equal(await phone.locator('.room-appearance-picker').evaluate(fieldset => fieldset.disabled), true, 'Participants may inspect room styling but cannot edit it.');
        assert.equal(await phone.locator('#room-appearance-form .modal-submit').isDisabled(), true);
        await phone.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await host.locator('#room-menu').click(); await host.locator('#room-appearance-menu').click();
        await host.getByRole('heading', { name: 'Room style', exact: true }).waitFor();
        await host.locator('[data-appearance-preset="lagoon"]').click(); await host.locator('[data-appearance-pattern]').selectOption('plain');
        await styled(host, initialStyle); await styled(phone, initialStyle);
        await host.locator('#room-appearance-form .modal-submit').click(); await host.locator('#room-appearance-form').waitFor({ state: 'hidden' });
        await styled(host, sharedStyle); await styled(phone, sharedStyle);
        assert.equal(await host.evaluate(() => window.__journey.captureCalls), 0); assert.equal(await phone.evaluate(() => window.__journey.captureCalls), 0);
      });
      await checkpoint('Reload without losing identity, style, mode, claim, or completed checklist', async () => {
        const session = phone.waitForResponse(response => new URL(response.url()).pathname.endsWith('/session') && response.ok());
        await phone.reload(); const restored = await (await session).json(); assert.equal(restored.participantId, phoneIdentity); assert.deepEqual(restored.room.appearance, sharedStyle);
        await connected(phone); await styled(phone, sharedStyle); await guide(phone, true);
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
      await checkpoint('Agent reads and writes are blocked before visible consent', async () => {
        await host.waitForFunction(() => !!window.commonAgent);
        const denied = await host.evaluate(() => Promise.all([
          { action: 'canvas.add', entity: { type: 'text', text: 'Unapproved annotation' } },
          { action: 'canvas.search', query: 'checkout' },
          { action: 'canvas.read', id: 'unapproved-object' },
        ].map(command => window.commonAgent.execute(command))));
        for (const result of denied) { assert.equal(result.ok, false); assert.equal(result.error.code, 'AGENT_DISABLED'); }
        assert.equal(await host.getByText('Unapproved annotation', { exact: true }).count(), 0);
      });
      await checkpoint('Allow an annotation through Agent tools', async () => {
        await host.getByRole('button', { name: 'Agent tools', exact: true }).click(); await host.locator('#agent-grant-apply').click();
        const allowed = await host.evaluate(() => window.commonAgent.execute({ action: 'canvas.add', entity: { type: 'text', text: 'Approved walkthrough annotation', x: 80, y: 80 } }));
        assert.equal(allowed.ok, true); await host.locator('.type-text').filter({ hasText: 'Approved walkthrough annotation' }).waitFor();
      });
      await checkpoint('Find a note, read every exact page, and edit only the selected object', async () => {
        const evidence = await host.evaluate(async () => {
          const api = window.commonAgent, before = api.state().entities;
          const text = 'Checkout recovery notes\n' + 'Quoted "evidence" and a new line.\n'.repeat(80)
            + '\u0001'.repeat(1500) + '\nKeep the exact ending: café 🌱.';
          const added = await api.execute({ action: 'canvas.add', entity: { id: 'journey-discovery-note', type: 'text', title: 'Journey checkout recovery', text, x: 760, y: 180 } });
          const unrelated = await api.execute({ action: 'canvas.add', entity: { id: 'journey-discovery-other', type: 'text', title: 'Journey checkout contrast', text: 'Keep this other note unchanged.', x: 760, y: 360 } });
          const page = await api.execute({ action: 'canvas.search', query: 'JoUrNeY CHECKOUT', types: ['text'], limit: 1 });
          const next = page.ok && page.result.nextOffset !== null
            ? await api.execute({ action: 'canvas.search', query: 'JoUrNeY CHECKOUT', types: ['text'], offset: page.result.nextOffset, limit: 1 }) : null;
          const search = await api.execute({ action: 'canvas.search', query: 'CHECKOUT recovery', types: ['text'] });
          const id = search.ok ? search.result.items[0]?.id : undefined;
          if (!id) return { added, unrelated, page, next, search };
          const reads = []; let offset = 0;
          do {
            const response = await api.execute({ action: 'canvas.read', id, offset, limit: 2000 });
            reads.push(response);
            if (!response.ok) break;
            offset = response.result.nextOffset;
          } while (offset !== null && reads.length < 20);
          const focus = await api.execute({ action: 'view.focus', id });
          const selected = await api.execute({ action: 'canvas.search', selectedOnly: true });
          const updated = await api.execute({ action: 'canvas.update', id, patch: { text: 'Clarified checkout recovery after bounded discovery' } });
          const after = api.state().entities;
          return { added, unrelated, page, next, search, text, reads, focus, selected, updated,
            before, unchanged: after.filter(entity => !['journey-discovery-note', 'journey-discovery-other'].includes(entity.id)),
            otherAfter: after.find(entity => entity.id === 'journey-discovery-other') };
        });
        for (const result of [evidence.added, evidence.unrelated, evidence.page, evidence.next, evidence.search, evidence.focus, evidence.selected, evidence.updated]) assert.equal(result?.ok, true);
        assert.equal(evidence.page.result.total, 2); assert.equal(evidence.page.result.items.length, 1);
        assert.equal(evidence.next.result.items.length, 1); assert.equal(evidence.next.result.nextOffset, null);
        assert.notEqual(evidence.page.result.items[0].id, evidence.next.result.items[0].id);
        assert.equal(evidence.search.result.total, 1); assert.equal(evidence.search.result.items[0].id, 'journey-discovery-note');
        assert.ok(evidence.reads.length > 1, 'Long note discovery must use continuation rather than a whole-canvas response.');
        for (const result of [evidence.page, evidence.next, evidence.search, evidence.selected, ...evidence.reads]) {
          assert.equal(result.ok, true); assert.ok(JSON.stringify(result).length <= 6000, 'Discovery responses must remain bounded even when text requires JSON escaping.');
        }
        assert.equal(evidence.reads.map(page => page.result.text).join(''), evidence.text, 'Paged reads must preserve exact text, including escapes and Unicode.');
        assert.equal(evidence.reads.at(-1).result.nextOffset, null);
        assert.deepEqual(evidence.selected.result.items.map(item => item.id), ['journey-discovery-note']);
        assert.deepEqual(evidence.unchanged, evidence.before); assert.deepEqual(evidence.otherAfter, evidence.unrelated.result);
        await host.locator('.type-text').filter({ hasText: 'Clarified checkout recovery after bounded discovery' }).waitFor();
        const cleaned = await host.evaluate(async () => {
          const results = [];
          for (const id of ['journey-discovery-note', 'journey-discovery-other']) results.push(await window.commonAgent.execute({ action: 'canvas.remove', id }));
          results.push(await window.commonAgent.execute({ action: 'view.fit' })); return results;
        });
        for (const result of cleaned) assert.equal(result.ok, true);
      });
      await checkpoint('Download a manual PNG, then revoke agent writes', async () => {
        const [png] = await Promise.all([host.waitForEvent('download'), host.locator('#agent-snapshot').click()]);
        assert.match(png.suggestedFilename(), /\.png$/); const filename = 'manual-canvas.png'; await png.saveAs(path.join(artifactDir, filename)); report.screenshots.push(filename);
        const bytes = await readFile(path.join(artifactDir, filename)); assert.ok(bytes.length > 100); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'The downloaded file must be a PNG.');
        const corner = await host.evaluate(async dataUrl => {
          const image = new Image(); image.src = dataUrl; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const paint = canvas.getContext('2d');
          paint.drawImage(image, 0, 0); return [...paint.getImageData(0, 0, 1, 1).data];
        }, `data:image/png;base64,${bytes.toString('base64')}`);
        report.snapshotBackground = corner.slice(0, 3);
        assert.deepEqual(corner, [240, 247, 246, 255], 'PNG corner must preserve the opaque Lagoon/plain room background.');
        await host.locator('#agent-grant-revoke').click();
        const denied = await host.evaluate(() => Promise.all([
          { action: 'canvas.add', entity: { type: 'text', text: 'Revoked annotation' } },
          { action: 'canvas.search', query: 'checkout' },
          { action: 'canvas.read', id: 'journey-discovery-note' },
        ].map(command => window.commonAgent.execute(command))));
        for (const result of denied) {
          assert.equal(result.ok, false); assert.ok(['AGENT_DISABLED', 'GRANT_REVOKED', 'PERMISSION_DENIED'].includes(result.error.code));
        }
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
      const betaSaved = page => page.locator('.beta-save-state[data-state="saved"]:visible, .beta-mobile-save-state[data-state="saved"]:visible').waitFor();
      const betaNote = async (page, text, touch = false) => {
        await page.locator('.beta-work-tools [data-beta-tool="sticky"]').click();
        await page.locator('.beta-board-host')[touch ? 'tap' : 'click']({ position: { x: 115, y: 130 } });
        await page.locator('.beta-board-host .board-text-content[contenteditable="true"]').fill(text);
        const done = page.getByRole('button', { name: 'Done editing', exact: true });
        if (await done.isVisible()) await done.click(); else await page.locator('.beta-current-board strong').click();
        await betaSaved(page);
      };
      await checkpoint('Space & Time automatically saves personal work across reload', async () => {
        await host.goto(origin.origin); await host.locator('#space-time-nav').click();
        await host.getByRole('region', { name: 'Common Space and Time' }).waitFor();
        assert.equal(new URL(host.url()).searchParams.get('experience'), 'space');
        await host.locator('.beta-board-link').first().click(); await betaNote(host, 'A beta thought saved on this device');
        await host.reload(); await betaSaved(host);
        await host.locator('.beta-board-host .type-sticky').filter({ hasText: 'A beta thought saved on this device' }).waitFor();
        await screenshot(host, 'beta-personal-autosave');
      });
      await checkpoint('Create and join a Space & Time room with actual peer edits and shared spatial pose', async () => {
        await betaMenuAction(host, 'create-room');
        await host.locator('#beta-create-form [name="name"]').fill('Spatial browser journey');
        await host.locator('#beta-create-form [name="displayName"]').fill('Spatial host'); await host.locator('#beta-create-form [name="password"]').fill(password);
        const creation = host.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/rooms' && response.ok());
        await host.locator('#beta-create-form button[type="submit"]').click(); const created = await (await creation).json();
        betaToken = created.token; secrets.push(betaToken); betaRoomUrl = `${origin.origin}/room/${created.room.id}?experience=space`;
        assert.equal(created.room.experience, 'spatial-beta');
        await host.locator('#beta-invite-link').waitFor(); assert.equal(await host.locator('#beta-invite-link').inputValue(), betaRoomUrl); await host.locator('#beta-invite-done').click();
        await phone.goto(betaRoomUrl); await phone.locator('#beta-join-form [name="displayName"]').fill('Spatial teammate'); await phone.locator('#beta-join-form [name="password"]').fill(password);
        await phone.locator('#beta-join-form button[type="submit"]').click();
        await betaNote(host, 'A real spatial peer thought');
        await phone.locator('.beta-board-host .type-sticky').filter({ hasText: 'A real spatial peer thought' }).waitFor();
        const boardId = await host.locator('.beta-board-link[aria-pressed="true"]').getAttribute('data-beta-board');
        await host.locator('.beta-placement summary').click(); await host.locator('.beta-pose-form [name="z"]').fill('180'); await host.locator('.beta-pose-form [name="rotationY"]').fill('12');
        await host.getByRole('button', { name: 'Apply position', exact: true }).click(); await betaSaved(host);
        for (const page of [host, phone]) {
          await page.locator('button[data-beta-mode="space"]').click();
          await page.waitForFunction(id => document.querySelector(`.beta-plane[data-beta-board="${id}"]`)?.style.transform.includes('rotateY(12deg)') && document.querySelector(`.beta-plane[data-beta-board="${id}"] .beta-plane-heading`)?.textContent.includes('Z 180'), boardId);
        }
        await screenshot(host, 'beta-shared-space');
        await host.reload(); await betaSaved(host); await host.locator('.beta-board-host .type-sticky').filter({ hasText: 'A real spatial peer thought' }).waitFor();
        await host.waitForFunction(id => document.querySelector(`.beta-plane[data-beta-board="${id}"] .beta-plane-heading`)?.textContent.includes('Z 180'), boardId);
        await phone.locator('button[data-beta-mode="work"]').click();
      });
      await checkpoint('Time exploration stays read-only while a peer keeps editing the live room', async () => {
        const time = host.getByRole('slider', { name: 'Explore automatically saved room history' });
        assert.ok(Number(await time.getAttribute('max')) > 1, 'Edits must create automatic history, without a Save or checkpoint action.');
        await time.focus(); await time.press('ArrowLeft'); await host.locator('.beta-workspace[data-history="past"]').waitFor();
        await host.locator('.beta-past-banner').waitFor(); assert.equal(await host.locator('.beta-work-tools [data-beta-tool="sticky"]').isDisabled(), true);
        await host.locator('.beta-board-host .type-sticky').filter({ hasText: 'A real spatial peer thought' }).dblclick();
        assert.equal(await host.locator('.beta-board-host .board-text-content[contenteditable="true"]').count(), 0);
        await betaNote(phone, 'The room kept moving while history was open', true);
        await host.locator('.beta-live-changes').filter({ hasText: /new live change/ }).waitFor();
        assert.equal(await host.locator('.beta-board-host .type-sticky').filter({ hasText: 'The room kept moving while history was open' }).count(), 0);
        await screenshot(host, 'beta-readonly-history'); await host.locator('.beta-return-live').click();
        await host.locator('.beta-workspace[data-history="live"]').waitFor(); await host.locator('.beta-board-host .type-sticky').filter({ hasText: 'The room kept moving while history was open' }).waitFor();
      });
      await checkpoint('Inspect spatial autosave and history timings without exposing shared content', async () => {
        await betaSaved(host); await betaMenuAction(host, 'performance');
        await performanceReport(host, {
          experience: 'spatial-beta', operations: ['canvas-render', 'spatial-render', 'history-read', 'autosave'],
          excluded: ['Spatial browser journey', 'Spatial host', 'Spatial teammate', 'A real spatial peer thought', 'The room kept moving while history was open'],
        });
        await host.locator('.beta-workspace[data-history="live"]').waitFor();
      });
      await checkpoint('Export the real spatial archive and end only the spatial room created here', async () => {
        const [archive] = await Promise.all([host.waitForEvent('download'), betaMenuAction(host, 'export')]);
        assert.match(archive.suggestedFilename(), /^common-spatial-.*\.common$/);
        const filename = 'beta-workspace.common'; await archive.saveAs(path.join(artifactDir, filename));
        // Read the exported wire format independently of the browser's codec.
        const bytes = await readFile(path.join(artifactDir, filename)), maximum = 64 * 1024 * 1024;
        assert.ok(bytes.length >= 12 && bytes.length <= maximum, 'The archive must fit the 64 MiB container limit.');
        assert.equal(bytes.subarray(0, 8).toString('ascii'), 'CSPACE02');
        const metadataLength = bytes.readUInt32LE(8); assert.ok(metadataLength > 0 && metadataLength <= bytes.length - 12);
        const data = JSON.parse(bytes.subarray(12, 12 + metadataLength).toString('utf8'));
        assert.equal(data.format, 'common-spatial-archive'); assert.equal(data.version, 2);
        assert.ok(['gzip', 'none'].includes(data.compression));
        assert.ok(Number.isSafeInteger(data.payloadBytes) && data.payloadBytes >= 0);
        assert.ok(Number.isSafeInteger(data.uncompressedBytes) && data.uncompressedBytes >= 0 && data.uncompressedBytes <= maximum);
        assert.equal(12 + metadataLength + data.payloadBytes, bytes.length, 'Metadata must describe the complete container exactly.');
        assert.ok(Array.isArray(data.documents) && data.documents.length > 0 && data.documents.length <= 65);
        assert.ok(data.documents.some(document => document.id === 'manifest'));
        const ids = new Set(); let total = 0;
        for (const document of data.documents) {
          assert.ok(typeof document.id === 'string' && document.id.length <= 128 && !ids.has(document.id)); ids.add(document.id);
          assert.ok(Number.isSafeInteger(document.byteLength) && document.byteLength > 0 && document.byteLength <= maximum);
          total += document.byteLength;
        }
        assert.equal(total, data.uncompressedBytes, 'Document lengths must cover the uncompressed payload.');
        const payload = bytes.subarray(12 + metadataLength);
        const decoded = data.compression === 'gzip' ? gunzipSync(payload, { maxOutputLength: maximum }) : payload;
        assert.equal(decoded.length, total, 'The independently decoded payload must match its document table.');
        report.spatialArchive = { filename, bytes: bytes.length, documents: data.documents.length, compression: data.compression, uncompressedBytes: total };
        await endBetaRoom(); await phone.locator('#modal-title').filter({ hasText: 'Session ended' }).waitFor();
        const response = await host.request.get(`${betaRoomUrl.replace('/room/', '/api/rooms/').split('?')[0]}/session`, { headers: { Authorization: `Bearer ${betaToken}` } }); assert.equal(response.status(), 404);
      });
    });
    else { report.journeys[4].status = 'unverified'; report.journeys[4].reason = 'Native peers were explicitly excluded; this is a partial browser review.'; }
    report.passed = requirePeers && report.journeys.every(item => item.status === 'passed'); report.partial = !report.passed; report.status = report.passed ? 'passed' : 'incomplete';
  } catch (error) {
    if (betaRoomUrl && !betaEnded) report.betaRtc = { host: await rtc(host).catch(() => []), phone: await rtc(phone).catch(() => []) };
    report.status = 'failed'; report.failure = { journey: active?.name || 'setup', message: safe(error.message) };
    for (const { name, page } of pages) if (!page.isClosed()) await screenshot(page, `${name}-failure`).catch(() => {});
  } finally {
    try { await endBetaRoom(); await endRoom(); report.cleanup = { ownRoomEnded: (!roomUrl || ended) && (!betaRoomUrl || betaEnded) }; }
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
