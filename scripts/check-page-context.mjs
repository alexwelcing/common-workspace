import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { projectRoot } from './local-runtime.mjs';
import { resolveChromiumPath } from '../tests/browser-smoke.mjs';

const usage = `Usage: bun run check:page-context --url http://127.0.0.1:3100

Exercise the packaged Bun example with real browser-tab capture and WebMCP.
Start a fresh local example first. This command does not start or stop its server.
Add ?experience=space to the URL to exercise Space & Time instead of Classic.
CHROMIUM_PATH selects an installed Chrome/Chromium; no browser is downloaded.
Reports and a masked failure screenshot stay under artifacts/page-context/.
`;
const args = process.argv.slice(2).filter(arg => arg !== '--');
if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
if (args.length !== 2 || args[0] !== '--url') { console.error(usage); process.exit(2); }
let target;
try {
  target = new URL(args[1]);
  if (!['http:', 'https:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || target.username || target.password || !['', '?experience=space'].includes(target.search) || target.hash || target.pathname !== '/') throw new Error();
} catch {
  console.error('Use the loopback origin of a fresh Bun example, optionally with ?experience=space.');
  process.exit(2);
}

const exampleTitle = 'Your app, with Common inside';
const privateValue = 'PRIVATE_ADDRESS_VALUE_MUST_STAY_IN_THE_HOST_INPUT';
const timeout = 15_000;
const experience = target.searchParams.get('experience') === 'space' ? 'space' : 'classic';
const report = { status: 'running', browser: null, experience, capture: 'native browser tab', checkpoints: [], errors: [] };
const artifactRoot = path.join(projectRoot, 'artifacts/page-context');
await mkdir(artifactRoot, { recursive: true });
const artifactDir = await mkdtemp(path.join(artifactRoot, 'run-'));
let context, page, profile, frame, activeCheckpoint;
const clean = value => String(value).replaceAll(privateValue, '[private field value]')
  .replace(/https?:\/\/[^\s)]+/g, '[URL]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 1200);
async function checkpoint(name, work) {
  const entry = { name, passed: false }, start = Date.now();
  report.checkpoints.push(entry); activeCheckpoint = name;
  try { await work(); entry.passed = true; console.log(`PASS ${name}`); }
  finally { entry.durationMs = Date.now() - start; }
}
function success(response, action) {
  if (response?.ok !== true) {
    const code = typeof response?.error?.code === 'string' ? response.error.code.replace(/[^A-Z_]/g, '').slice(0, 80) : 'INVALID_RESPONSE';
    throw new Error(`${action} failed (${code}). Check the linked page, active grant, and browser support.`);
  }
  assert.ok(JSON.stringify(response).length < 6000, `${action} must return a bounded complete envelope.`);
  return response.result;
}
function denied(response, code, action) {
  assert.equal(response?.ok, false, `${action} must reject this operation.`);
  assert.equal(response.error.code, code, `${action} must explain why the operation is unavailable.`);
}
const command = value => page.evaluate(value => window.commonExample.inline.agent.execute(value), value);
async function tools() { return page.evaluate(async () => (await document.modelContext.getTools()).map(tool => tool.name)); }
async function native(action, argumentsObject = {}) {
  return page.evaluate(async ({ name, args, objectInput }) => {
    const api = document.modelContext;
    const tool = (await api.getTools()).find(tool => tool.name === name);
    if (!tool) throw new Error(`Native tool ${name} is unavailable. Check the current grant.`);
    const output = await api.executeTool(tool, objectInput ? args : JSON.stringify(args));
    return typeof output === 'string' ? JSON.parse(output) : output;
  }, { name: `common_${action.replaceAll('.', '_')}`, args: argumentsObject, objectInput: Number(report.browser.split('.')[0]) >= 155 });
}
async function waitForSourceState(predicate) {
  await page.waitForFunction(async predicate => {
    const response = await window.commonExample.inline.agent.execute({ action: 'source.inspect' });
    if (!response.ok) return false;
    return predicate === 'verified' ? response.result.binding.status === 'verified' : response.result.revision > predicate;
  }, predicate, { timeout });
}
const settlePage = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function openAgentTools() {
  if (experience === 'space') {
    const menu = frame.getByRole('button', { name: 'Room actions', exact: true });
    if (await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  }
  await frame.getByRole('button', { name: 'Agent tools', exact: true }).click();
}
async function verifyHighlightPlacement(normalizedBounds) {
  const error = await frame.evaluate(bounds => {
    const box = document.querySelector('.common-page-highlight-box');
    const video = box?.closest('.board-screen-frame')?.querySelector('video');
    if (!box || !video || !video.videoWidth || !video.videoHeight || getComputedStyle(video).objectFit !== 'contain') return null;
    const visible = video.getBoundingClientRect();
    const scale = Math.min(visible.width / video.videoWidth, visible.height / video.videoHeight);
    const width = video.videoWidth * scale, height = video.videoHeight * scale;
    const expected = {
      x: visible.x + (visible.width - width) / 2 + bounds.x * width,
      y: visible.y + (visible.height - height) / 2 + bounds.y * height,
      width: bounds.width * width, height: bounds.height * height,
    };
    const actual = box.getBoundingClientRect();
    return Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(actual[key] - expected[key])));
  }, normalizedBounds);
  assert.ok(Number.isFinite(error) && error <= 2, 'The highlight must match the located source region inside the contain-fit video within two CSS pixels.');
  report.maxHighlightPlacementErrorPx = Math.max(report.maxHighlightPlacementErrorPx || 0, error);
}

try {
  const executablePath = await resolveChromiumPath();
  profile = await mkdtemp(path.join(tmpdir(), 'common-page-context-browser-'));
  // A temporary normal profile is deliberate: native Capture Handle can be
  // unavailable in an incognito context even when tab video capture succeeds.
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    viewport: { width: 1440, height: 1100 }, args: ['--no-sandbox', '--enable-features=WebMCP',
      '--enable-usermedia-screen-capturing', `--auto-select-tab-capture-source-by-title=${exampleTitle}`] });
  report.browser = context.browser().version();
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(clean(error.message)));
  await checkpoint('Open the fresh packaged example and require visible permission', async () => {
    await page.goto(target.href);
    assert.equal(await page.title(), exampleTitle, 'Use the current packaged Bun example for this walkthrough.');
    await page.waitForFunction(() => !!window.commonExample?.inline);
    await page.evaluate(() => window.commonExample.inline.ready());
    assert.equal(await page.evaluate(() => typeof document.modelContext?.getTools), 'function', 'This browser needs native WebMCP support.');
    frame = page.frames().find(item => new URL(item.url()).pathname.startsWith('/common-inline/'));
    assert.ok(frame, 'The example must mount Common under /common-inline/.');
    await frame.waitForFunction(() => !!window.commonAgent);
    denied(await command({ action: 'source.inspect' }), 'AGENT_DISABLED', 'source.inspect before access');
    await openAgentTools();
    await frame.locator('#agent-grant-apply').click();
    denied(await command({ action: 'source.inspect' }), 'PERMISSION_DENIED', 'source.inspect with the default grant');
    assert.ok(!(await tools()).some(name => name.startsWith('common_source_')), 'Default grants must not expose source tools.');
  });

  await checkpoint('Grant linked-page reading and discover source and canvas together', async () => {
    await frame.locator('#agent-grant-page-context').check();
    await frame.locator('#agent-grant-apply').click();
    await page.waitForFunction(async () => (await document.modelContext.getTools()).some(tool => tool.name === 'common_source_inspect'));
    await settlePage();
    const names = await tools();
    for (const name of ['common_canvas_search', 'common_source_inspect', 'common_source_search', 'common_source_locate']) assert.ok(names.includes(name), 'The native catalog must include source and canvas tools.');
    const source = success(await native('source.inspect'), 'source.inspect');
    assert.equal(source.binding.status, 'not-sharing', 'Page context alone must not claim a video binding.');
    const search = success(await native('source.search', { query: 'pay' }), 'source.search');
    assert.equal(search.items.length, 1, 'The named payment control must be discoverable.');
    assert.equal(search.items[0].id, 'pay-now');
    assert.equal(search.items[0].disabled, true, 'The demo payment control starts disabled.');
    const located = success(await native('source.locate', { id: 'pay-now' }), 'source.locate');
    denied(await native('source.highlight', { id: 'pay-now', revision: located.revision }), 'SOURCE_NOT_VERIFIED', 'source.highlight without a verified capture');
    success(await native('canvas.search'), 'canvas.search');
  });

  await checkpoint('Capture the real parent tab and verify a visible walkthrough cue', async () => {
    await frame.getByRole('button', { name: 'Close agent tools', exact: true }).click();
    await frame.locator(experience === 'space' ? '[data-beta-action="share"]' : '#share-screen').click();
    await waitForSourceState('verified');
    await frame.waitForFunction(() => [...document.querySelectorAll('.board-screen-frame video')]
      .some(video => video.videoWidth > 0 && video.srcObject?.getVideoTracks().some(track => track.readyState === 'live' && track.getSettings().displaySurface === 'browser')),
    null, { timeout });
    await frame.evaluate(() => {
      // Retain only native track references to verify SDK teardown later.
      window.parent.__commonPageCheckTracks = [...document.querySelectorAll('.board-screen-frame video')]
        .flatMap(video => video.srcObject?.getVideoTracks() || []);
    });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await settlePage();
    const located = success(await native('source.locate', { id: 'pay-now' }), 'source.locate');
    assert.equal(located.binding.status, 'verified');
    success(await native('source.highlight', { id: 'pay-now', revision: located.revision, durationMs: 30000 }), 'source.highlight');
    await frame.locator('.common-page-highlight-box').waitFor({ state: 'visible', timeout });
    await verifyHighlightPlacement(located.normalizedBounds);
  });

  await checkpoint('Read changed readiness without exporting the private input', async () => {
    const before = success(await native('source.locate', { id: 'pay-now' }), 'source.locate');
    await page.locator('#delivery-address').fill(privateValue);
    await waitForSourceState(before.revision);
    await settlePage();
    assert.equal(await page.locator('#pay-now').isEnabled(), true, 'A human input must enable the demo control.');
    const inspected = await native('source.inspect');
    const searched = await native('source.search', { query: 'pay' });
    const located = await native('source.locate', { id: 'pay-now' });
    for (const [action, response] of [['source.inspect', inspected], ['source.search', searched], ['source.locate', located]]) {
      success(response, action);
      assert.equal(JSON.stringify(response).includes(privateValue), false, 'Private input values must stay outside page context results.');
    }
    assert.equal(searched.result.items[0].disabled, false, 'The source must report current control readiness.');
    denied(await native('source.highlight', { id: 'pay-now', revision: before.revision }), 'SOURCE_STALE', 'source.highlight after a page change');
    const revision = located.result.revision;
    await page.evaluate(() => window.scrollBy({ top: 24, behavior: 'instant' }));
    await waitForSourceState(revision);
    await settlePage();
    denied(await native('source.highlight', { id: 'pay-now', revision }), 'SOURCE_STALE', 'source.highlight after scrolling');
    const current = success(await native('source.locate', { id: 'pay-now' }), 'source.locate');
    success(await native('source.highlight', { id: 'pay-now', revision: current.revision, durationMs: 30000 }), 'source.highlight');
    await frame.locator('.common-page-highlight-box').waitFor({ state: 'visible', timeout });
    await verifyHighlightPlacement(current.normalizedBounds);
  });

  await checkpoint('Revoke page access and remove native tools and the cue', async () => {
    await openAgentTools();
    await frame.locator('#agent-grant-page-context').uncheck();
    await frame.locator('#agent-grant-apply').click();
    await page.waitForFunction(async () => {
      const names = (await document.modelContext.getTools()).map(tool => tool.name);
      return names.includes('common_canvas_search') && !names.some(name => name.startsWith('common_source_'));
    });
    denied(await command({ action: 'source.inspect' }), 'PERMISSION_DENIED', 'source.inspect after page access ends');
    await frame.locator('.common-page-highlight').waitFor({ state: 'detached', timeout });
  });

  await checkpoint('Remount and tear down Common while preserving host controls', async () => {
    await page.evaluate(() => { window.__commonPreviousInline = window.commonExample.inline; });
    await page.locator('#reload-mounts').click();
    await page.waitForFunction(() => window.commonExample.inline && window.commonExample.inline !== window.__commonPreviousInline);
    await page.evaluate(() => window.commonExample.inline.ready());
    assert.equal(await page.evaluate(() => window.__commonPageCheckTracks.every(track => track.readyState === 'ended')), true, 'Remounting must stop the owned native capture.');
    denied(await command({ action: 'source.inspect' }), 'AGENT_DISABLED', 'source.inspect after remount');
    const count = Number(await page.locator('#host-count').textContent());
    await page.locator('#increment').click();
    await page.waitForFunction(count => Number(document.querySelector('#host-count').textContent) === count + 1, count);
    await page.locator('#probe-host').click();
    await page.waitForFunction(() => document.querySelector('#health-output').textContent.startsWith('Host healthy'));
    await page.evaluate(() => Promise.all([window.commonExample.inline, window.commonExample.floating].filter(Boolean).map(controller => controller.destroy())));
    assert.equal(await page.locator('iframe').count(), 0, 'Destroy must remove Common frames.');
    assert.equal((await tools()).some(name => name.startsWith('common_')), false, 'Destroyed mounts must leave no Common native tools.');
    await page.goto(new URL('/api/health', target).href);
    assert.equal(await page.evaluate(async () => (await document.modelContext.getTools()).length), 0, 'Leaving the example must release page context.');
  });
  assert.equal(report.errors.length, 0, 'The browser reported an uncaught error; see the sanitized report.');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { checkpoint: activeCheckpoint || 'Setup', message: clean(error.message) };
  if (page && !page.isClosed()) {
    try {
      const masks = page.frames().map(item => item.locator('input, textarea, video, [contenteditable="true"], #agent-result, #echo-output, #health-output'));
      await page.screenshot({ path: path.join(artifactDir, 'failure.png'), fullPage: true, mask: masks });
      report.screenshot = 'failure.png';
    } catch { report.screenshot = 'unavailable'; }
  }
  console.error(`FAIL ${report.failure.checkpoint}: ${report.failure.message}`); process.exitCode = 1;
} finally {
  try { await context?.close(); }
  catch (error) { report.status = 'failed'; report.cleanupError = clean(error.message); process.exitCode = 1; }
  finally { if (profile) await rm(profile, { recursive: true, force: true }); }
  await writeFile(path.join(artifactDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${path.join(artifactDir, 'report.json')}`);
}
