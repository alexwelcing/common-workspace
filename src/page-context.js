import { createPageHighlight } from './page-highlight.js';

const RESULT_CHARACTERS = 6000;
const PROVIDER_CHARACTERS = 5000;
const failure = (code, message) => Object.assign(new Error(message), { code });
const unavailable = () => failure('SOURCE_UNAVAILABLE', 'No linked host page is available. Open Common inside an application with a page companion.');
const invalid = () => failure('SOURCE_INVALID', 'The linked page returned invalid context. Check the page companion integration.');
const changed = () => failure('SOURCE_CHANGED', 'The linked page changed before this command completed. Inspect the current source and retry.');
const invoke = (callback, ...args) => { try { callback?.(...args); } catch {} };
const string = (value, maximum, optional = false) => {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maximum || (!optional && !value.trim())) throw invalid();
  return value;
};
const integer = (value, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw invalid();
  return value;
};
function rect(value, normalized = false) {
  if (!value || typeof value !== 'object') throw invalid();
  const output = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isFinite(value[key]) || Math.abs(value[key]) > 100000) throw invalid();
    output[key] = value[key];
  }
  if (output.width <= 0 || output.height <= 0) throw invalid();
  if (normalized && (output.x < 0 || output.y < 0 || output.x + output.width > 1.000001 || output.y + output.height > 1.000001)) throw invalid();
  return output;
}
function viewport(value) {
  if (!value || typeof value !== 'object') throw invalid();
  const output = {};
  for (const key of ['width', 'height', 'offsetLeft', 'offsetTop']) {
    if (!Number.isFinite(value[key]) || Math.abs(value[key]) > 100000 || (['width', 'height'].includes(key) && value[key] <= 0)) throw invalid();
    output[key] = value[key];
  }
  return output;
}
function target(value, boundsRequired = false) {
  if (!value || typeof value !== 'object' || typeof value.disabled !== 'boolean') throw invalid();
  return {
    id: string(value.id, 100), label: string(value.label, 120), role: string(value.role, 40), disabled: value.disabled,
    ...(value.bounds !== undefined || boundsRequired ? { bounds: rect(value.bounds) } : {}),
  };
}
function identity(value) {
  if (!value || typeof value !== 'object') throw invalid();
  return { sourceId: string(value.sourceId, 100), documentId: string(value.documentId, 100), revision: integer(value.revision) };
}
function bounded(value, maximum = PROVIDER_CHARACTERS) {
  let text;
  try { text = JSON.stringify(value); } catch { throw invalid(); }
  if (!text || text.length > maximum) throw failure('SOURCE_TOO_LARGE', 'The linked page context is too large. Reduce the page size or shorten the companion summary.');
  return value;
}
function providerResult(method, value) {
  // Providers live in the host's realm. Clone before validating their JSON shape;
  // no DOM objects or host references are retained in an agent result.
  let data;
  try { bounded(value); data = structuredClone(value); } catch (error) { if (error?.code) throw error; throw invalid(); }
  const base = identity(data);
  if (method === 'inspect') {
    const origin = string(data.origin, 500);
    const route = string(data.route, 500);
    if (!route.startsWith('/') || route.includes('?') || route.includes('#') || route.startsWith('//')) throw invalid();
    return { ...base, origin, title: string(data.title, 200, true) ?? '', summary: string(data.summary, 2000, true) ?? '', route,
      viewport: viewport(data.viewport), targetCount: integer(data.targetCount, 200), ...(data.truncated === true ? { truncated: true } : {}) };
  }
  if (method === 'search') {
    if (!Array.isArray(data.items) || data.items.length > 12) throw invalid();
    const total = integer(data.total, 200), offset = integer(data.offset, 100000);
    const nextOffset = data.nextOffset === null ? null : integer(data.nextOffset, 100000);
    if (nextOffset !== null && (nextOffset !== offset + data.items.length || nextOffset <= offset || nextOffset >= total)) throw invalid();
    if (data.items.length > Math.max(0, total - offset)) throw invalid();
    return { ...base, items: data.items.map(item => target(item)), total, offset, nextOffset };
  }
  return { ...base, target: target(data.target, true), viewport: viewport(data.viewport), normalizedBounds: rect(data.normalizedBounds, true) };
}

/** A browser-local connection to one explicitly supplied host-page companion. */
export function createPageContext({ getBoard, getModel, getWindowStream = () => null, getParticipantId = () => null,
  onChange = () => {}, onInvalidate = () => {},
} = {}) {
  let provider = null, unsubscribe = null, destroyed = false, epoch = 0, documentId = null, sourceId = null;
  let watchedStream = null, watchedTrack = null, highlight = null, updating = false, updateAgain = false;
  let lastStatus = '';
  const visual = createPageHighlight({ getBoard, getStream: getWindowStream });

  function clearHighlight() {
    const active = highlight; highlight = null;
    active?.options.signal?.removeEventListener?.('abort', active.onAbort);
    visual.clear();
  }
  function sourceState() {
    if (destroyed || !provider) return null;
    try {
      const state = provider.getState();
      if (!state?.available) return null;
      const safe = { ...identity(state), origin: string(state.origin, 500), captureHandle: state.captureHandle == null ? null : string(state.captureHandle, 1024) };
      if (safe.origin !== provider.ownerDocument?.location?.origin) return null;
      if ((documentId !== null && safe.documentId !== documentId) || (sourceId !== null && safe.sourceId !== sourceId)) { epoch++; clearHighlight(); }
      documentId = safe.documentId; sourceId = safe.sourceId;
      return safe;
    } catch { return null; }
  }
  function binding(state = sourceState()) {
    const stream = getWindowStream();
    const track = stream?.getVideoTracks?.().find(item => item.readyState === 'live');
    if (!track) return { status: 'not-sharing' };
    if (!state || track.muted || getBoard()?.readOnly || !state.captureHandle) return { status: 'unverified' };
    try {
      const settings = track.getSettings();
      const handle = track.getCaptureHandle?.();
      const participantId = getParticipantId();
      if (settings.displaySurface !== 'browser' || handle?.handle !== state.captureHandle || handle?.origin !== state.origin || typeof participantId !== 'string') return { status: 'unverified' };
      const screen = getModel()?.all?.().find(entity => entity.type === 'screen' && entity.streamId === stream.id && entity.participantId === participantId);
      return screen ? { status: 'verified', screenId: screen.id } : { status: 'unverified' };
    } catch { return { status: 'unverified' }; }
  }
  function status() {
    const state = sourceState();
    return { available: !!state, ...(state ? { binding: binding(state) } : {}) };
  }
  function notify() {
    const next = status(), signature = JSON.stringify(next);
    if (signature !== lastStatus) { lastStatus = signature; invoke(onChange, next); }
  }
  function stopWatching() {
    if (watchedTrack) for (const type of ['ended', 'mute', 'unmute', 'capturehandlechange']) watchedTrack.removeEventListener?.(type, refresh);
    watchedTrack = watchedStream = null;
  }
  function watch() {
    const stream = getWindowStream();
    const track = stream?.getVideoTracks?.()[0] || null;
    if (stream === watchedStream && track === watchedTrack) return;
    stopWatching(); watchedStream = stream; watchedTrack = track;
    if (track) for (const type of ['ended', 'mute', 'unmute', 'capturehandlechange']) track.addEventListener?.(type, refresh);
  }
  function check(activeProvider, ticket, expectedDocument, options = {}) {
    if (options.signal?.aborted) throw failure('ABORTED', 'Page access ended before this command completed.');
    if (destroyed || provider !== activeProvider || epoch !== ticket) throw changed();
    const current = sourceState();
    if (!current || current.documentId !== expectedDocument || epoch !== ticket) throw changed();
    if (options.isAllowed && !options.isAllowed()) throw failure('ABORTED', 'Page access ended before this command completed.');
    return current;
  }
  async function read(method, args, options = {}) {
    const state = sourceState();
    if (!state) throw unavailable();
    const activeProvider = provider, ticket = epoch;
    check(activeProvider, ticket, state.documentId, options);
    let raw;
    try { raw = await activeProvider[method](args); }
    catch (error) { check(activeProvider, ticket, state.documentId, options); throw error; }
    const current = check(activeProvider, ticket, state.documentId, options);
    const value = providerResult(method, raw);
    if (value.sourceId !== current.sourceId || value.documentId !== current.documentId || value.revision !== current.revision) throw changed();
    const output = { ...value, binding: binding(current) };
    bounded({ ok: true, result: output }, RESULT_CHARACTERS - 1);
    return output;
  }
  async function updateHighlight() {
    if (updating) { updateAgain = true; return; }
    if (!highlight) return;
    updating = true;
    const active = highlight;
    try {
      const result = await read('locate', { id: active.id }, active.options);
      if (highlight !== active) return;
      if (result.sourceId !== active.sourceId || result.documentId !== active.documentId || result.binding.status !== 'verified' || result.binding.screenId !== active.screenId) { clearHighlight(); return; }
      if (visual.update({ normalizedBounds: result.normalizedBounds, label: result.target.label }) === false) clearHighlight();
    } catch { if (highlight === active) clearHighlight(); }
    finally { updating = false; if (updateAgain) { updateAgain = false; void updateHighlight(); } }
  }
  function refresh() {
    if (destroyed) return;
    watch();
    const state = sourceState();
    if (provider && !state) { detach(provider, 'page-source-closed'); return; }
    if (highlight && (!state || binding(state).status !== 'verified' || (highlight.options.isAllowed && !highlight.options.isAllowed()))) clearHighlight();
    else if (highlight) void updateHighlight();
    notify();
  }
  function detach(activeProvider, reason = 'page-source-changed') {
    if (provider !== activeProvider) return;
    provider = null; documentId = sourceId = null; epoch++;
    unsubscribe?.(); unsubscribe = null;
    clearHighlight(); stopWatching();
    invoke(onInvalidate, reason); notify();
  }
  function attach(next) {
    if (destroyed) throw unavailable();
    const document = getBoard()?.el?.ownerDocument || globalThis.document;
    const owner = next?.ownerDocument;
    const window = document?.defaultView;
    if (!window || window.parent === window || owner?.defaultView !== window.parent || owner?.location?.origin !== document.location?.origin
      || ['getState', 'inspect', 'search', 'locate', 'subscribe'].some(method => typeof next?.[method] !== 'function')) throw invalid();
    if (provider === next) return () => {};
    if (provider) detach(provider);
    provider = next; documentId = sourceId = null; epoch++;
    unsubscribe = next.subscribe(event => {
      if (provider !== next) return;
      if (event?.reason === 'destroyed') { detach(next, 'page-source-closed'); return; }
      if (event?.reason === 'navigation') { epoch++; documentId = null; clearHighlight(); }
      refresh();
    });
    if (!sourceState()) { detach(next); throw unavailable(); }
    refresh();
    return () => detach(next);
  }
  async function highlightTarget(args, options = {}) {
    const result = await read('locate', { id: args.id }, options);
    if (result.revision !== args.revision) throw failure('SOURCE_STALE', 'The page changed since this target was located. Run source.locate again, then use its revision.');
    if (result.binding.status !== 'verified') throw failure('SOURCE_NOT_VERIFIED', 'The shared video is not verified as the linked page. Share that browser tab with Capture Handle enabled before highlighting.');
    const durationMs = args.durationMs ?? 8000;
    const assertCurrent = () => {
      if (options.signal?.aborted || (options.isAllowed && !options.isAllowed())) throw failure('ABORTED', 'Page access ended before this command completed.');
      const state = sourceState();
      if (!state || state.sourceId !== result.sourceId || state.documentId !== result.documentId || state.revision !== result.revision) throw changed();
      const currentBinding = binding(state);
      if (currentBinding.status !== 'verified' || currentBinding.screenId !== result.binding.screenId) throw failure('SOURCE_NOT_VERIFIED', 'The shared video is no longer verified as the linked page. Share the linked browser tab again.');
    };
    clearHighlight();
    try {
      // read() resolves asynchronously. Recheck authority immediately before the
      // visual side effect so revocation cannot leave a late highlight behind.
      assertCurrent();
      visual.show({ screenId: result.binding.screenId, normalizedBounds: result.normalizedBounds, label: result.target.label, durationMs });
      const active = { id: args.id, sourceId: result.sourceId, documentId: result.documentId, screenId: result.binding.screenId, options,
        onAbort: () => { if (highlight === active) clearHighlight(); },
      };
      highlight = active;
      options.signal?.addEventListener?.('abort', active.onAbort, { once: true });
      assertCurrent();
    } catch (error) { clearHighlight(); throw error; }
    return { sourceId: result.sourceId, documentId: result.documentId, revision: result.revision, screenId: result.binding.screenId, targetId: args.id, durationMs };
  }
  function destroy() {
    if (destroyed) return;
    if (provider) detach(provider, 'page-source-closed');
    destroyed = true; epoch++; clearHighlight(); stopWatching(); visual.destroy();
  }
  return Object.freeze({ attach, status, refresh, clearHighlight, destroy,
    cacheStamp() { const state = sourceState(); return JSON.stringify([epoch, state?.sourceId ?? null, state?.documentId ?? null, state?.revision ?? null]); },
    inspect: (args, options) => read('inspect', args, options),
    search: (args, options) => read('search', args, options),
    locate: (args, options) => read('locate', args, options),
    highlight: highlightTarget,
  });
}
