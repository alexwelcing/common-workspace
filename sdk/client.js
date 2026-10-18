import { normalizeBasePath } from './path.mjs';

const READY_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const error = (code, message) => Object.assign(new Error(message), { name: 'CommonEmbedError', code });
const invoke = (callback, ...args) => { try { callback?.(...args); } catch {} };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Mounting does not require the host to observe readiness immediately.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

function jsonValue(value, depth = 0) {
  if (depth > 14) throw new TypeError('Arguments exceed the nesting limit.');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || Object.getOwnPropertySymbols(value).length) throw new TypeError('Use JSON values for agent arguments.');
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10000) throw new TypeError('Use plain JSON arrays within the item limit.');
    const output = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) throw new TypeError('Arrays cannot have holes or accessors.');
      output.push(jsonValue(descriptor.value, depth + 1));
    }
    if (Object.keys(value).some(key => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new TypeError('Arrays cannot have named fields.');
    return output;
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Use plain JSON objects for agent arguments.');
  const output = {};
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('Prototype-related fields are not supported.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new TypeError('Agent arguments cannot have accessors.');
    output[key] = jsonValue(descriptor.value, depth + 1);
  }
  return output;
}

/** Mount the same-origin Common Bun application without touching host globals. */
export function mountCommon({ target, basePath = '/__common/', mode = 'overlay', open: initialOpen, roomId,
  onReady, onError, onOpenChange,
} = {}) {
  const document = target?.ownerDocument;
  const window = document?.defaultView;
  if (!window || !(target instanceof window.Element) || typeof target.append !== 'function') throw error('SDK_INVALID_TARGET', 'mountCommon needs a browser Element as its target. Call it after the host page has mounted.');
  if (mode === 'floating') mode = 'overlay';
  if (!['overlay', 'inline'].includes(mode)) throw error('SDK_INVALID_MODE', 'Common mode must be inline or overlay.');
  if (initialOpen !== undefined && typeof initialOpen !== 'boolean') throw error('SDK_INVALID_OPTIONS', 'Common open must be a boolean.');
  try { basePath = normalizeBasePath(basePath); } catch { throw error('SDK_INVALID_BASE_PATH', 'Common basePath must be an absolute same-origin path such as /__common/.'); }
  if (window.location.origin === 'null') throw error('SDK_INVALID_ORIGIN', 'Common embedding requires an HTTP or HTTPS host origin.');
  if (roomId !== undefined && (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(roomId))) throw error('SDK_INVALID_ROOM_ID', 'Common roomId must be a valid room identifier from an invitation.');
  const route = new URL(basePath + (roomId ? `room/${encodeURIComponent(roomId)}` : ''), window.location.origin);
  const AbortControllerClass = window.AbortController || globalThis.AbortController;
  const setTimer = window.setTimeout.bind(window), clearTimer = window.clearTimeout.bind(window);
  const host = document.createElement('div'); host.setAttribute('data-common-embed', ''); host.dataset.mode = mode;
  const shadow = host.attachShadow({ mode: 'open' });
  const stylesheetUrl = new URL('embed.css', new URL(basePath, route));
  const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = stylesheetUrl.href;
  const launcher = document.createElement('button'); launcher.type = 'button'; launcher.className = 'common-embed-launcher';
  const launcherLabel = document.createElement('span'); launcherLabel.textContent = 'Common';
  const launcherIndicator = document.createElement('span'); launcherIndicator.className = 'common-embed-indicator'; launcherIndicator.hidden = true;
  launcherIndicator.setAttribute('role', 'status'); launcher.append(launcherLabel, launcherIndicator);
  const panel = document.createElement('section'); panel.className = 'common-embed-panel'; panel.id = 'common-embed-panel'; panel.setAttribute('aria-label', 'Common collaborative canvas');
  launcher.setAttribute('aria-controls', panel.id);
  const heading = document.createElement('header'); heading.className = 'common-embed-header';
  const title = document.createElement('strong'); title.textContent = 'Common';
  const headingIndicator = document.createElement('span'); headingIndicator.className = 'common-embed-indicator'; headingIndicator.hidden = true;
  const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'common-embed-close'; closeButton.textContent = 'Close'; closeButton.setAttribute('aria-label', 'Close Common canvas');
  heading.append(title, headingIndicator, closeButton);
  const status = document.createElement('p'); status.className = 'common-embed-status'; status.setAttribute('role', 'status'); status.textContent = 'Opening Common…';
  const iframe = document.createElement('iframe'); iframe.className = 'common-embed-frame'; iframe.title = 'Common collaborative canvas';
  // Same-origin iframes share sessionStorage. Keep room admission distinct for
  // separate mounts while allowing this iframe to reconnect after a reload.
  const mountId = window.crypto.randomUUID?.() || [...window.crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  iframe.name = `common-embed-${mountId}`;
  iframe.setAttribute('allow', 'display-capture; clipboard-write');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads allow-modals');
  iframe.referrerPolicy = 'same-origin';
  panel.append(heading, status, iframe); shadow.append(stylesheet, launcher, panel);
  let destroyed = false, destroyPromise, generation = 0, current, controller, loaded = false;
  let stylesheetState = 'loading', stylesheetRetries = 0;
  let isOpen = initialOpen ?? mode === 'inline';
  const report = problem => invoke(onError, problem);

  function updateIndicator(state = {}) {
    const label = [state.sharing && 'Sharing', state.recording && 'Recording'].filter(Boolean).join(' · ') || (state.hasCapture ? 'Capture active' : '');
    for (const indicator of [launcherIndicator, headingIndicator]) { indicator.textContent = label; indicator.hidden = !label; }
    launcher.setAttribute('aria-label', `${isOpen ? 'Hide' : 'Open'} Common canvas${label ? `. ${label} continues while hidden` : ''}`);
  }
  function setOpen(next, notify = true) {
    if (destroyed) return;
    const changed = isOpen !== Boolean(next); isOpen = Boolean(next);
    if (isOpen) ensureLoaded();
    // Native hidden prevents a closed overlay flashing in the host document
    // before its external stylesheet loads. Once styled, retain its dimensions
    // so an explicitly-readied closed canvas can initialize at its real size.
    panel.hidden = !isOpen && stylesheetState !== 'loaded';
    panel.inert = !isOpen; panel.setAttribute('aria-hidden', String(!isOpen)); host.dataset.open = String(isOpen); launcher.setAttribute('aria-expanded', String(isOpen));
    try { current?.lifecycle?.setVisible?.(isOpen); } catch {}
    try { updateIndicator(current?.lifecycle?.getState?.()); } catch { updateIndicator(); }
    if (changed && notify) invoke(onOpenChange, isOpen);
    if (changed) { if (isOpen) closeButton.focus(); else launcher.focus(); }
  }
  function clearGeneration(entry) {
    clearTimer(entry.timeout); clearTimer(entry.poll);
    entry.unsubscribe?.(); entry.removePageHide?.(); entry.abort.abort();
  }
  function invalidate(entry, problem) {
    if (!entry) return;
    clearGeneration(entry); entry.cancel.reject(problem);
    if (!entry.settled) { entry.settled = true; entry.ready.reject(problem); }
  }
  function beginGeneration(problem) {
    if (current) invalidate(current, problem || error('SDK_FRAME_RELOADED', 'Common reloaded before this operation completed. Wait for it to become ready and try again.'));
    const entry = { id: ++generation, abort: new AbortControllerClass(), ready: deferred(), cancel: deferred(), settled: false, api: null, lifecycle: null, document: null };
    current = entry; status.hidden = false; status.textContent = 'Opening Common…'; updateIndicator();
    if (loaded) armTimeout(entry);
    return entry;
  }
  function armTimeout(entry) {
    entry.timeout = setTimer(() => failGeneration(entry, error('SDK_READY_TIMEOUT', `Common did not become ready at ${basePath}. Check the Bun mount path and sign-in, then reload the canvas.`)), READY_TIMEOUT_MS);
  }
  function ensureLoaded() {
    if (destroyed) return;
    if (stylesheetState === 'failed') {
      stylesheetState = 'loading';
      // A denied stylesheet response may be cached independently of the iframe.
      // Retry only after a failure, when the host explicitly opens or readies it.
      const retryUrl = new URL(stylesheetUrl);
      retryUrl.searchParams.set('__common_style_retry', String(++stylesheetRetries));
      stylesheet.href = retryUrl.href;
    }
    if (loaded) {
      if (current.failed) { beginGeneration(); iframe.src = route.href; }
      return;
    }
    loaded = true; armTimeout(current); iframe.src = route.href;
  }
  function failGeneration(entry, problem) {
    if (destroyed || current !== entry || entry.settled) return;
    entry.settled = true; entry.failed = true; clearGeneration(entry); entry.cancel.reject(problem); entry.ready.reject(problem);
    status.hidden = false; status.textContent = problem.message; report(problem);
  }
  function checkOrigin(entry) {
    const child = iframe.contentWindow;
    if (!child) return null;
    try {
      const location = new URL(child.location.href);
      if (location.protocol === 'about:') return null;
      if (location.origin !== route.origin) throw error('SDK_CROSS_ORIGIN', 'Common must stay on the same origin as the host app. Open the host app sign-in page first.');
      if (basePath !== '/' && location.pathname !== basePath.slice(0, -1) && !location.pathname.startsWith(basePath)) throw error('SDK_ROUTE_MISMATCH', 'The iframe left the configured Common mount. Check basePath and host routing.');
      return child;
    } catch (problem) {
      failGeneration(entry, problem?.code ? problem : error('SDK_CROSS_ORIGIN', 'Common must use a same-origin iframe. Check whether host authentication redirected it to another origin.'));
      return null;
    }
  }
  function poll(entry) {
    if (destroyed || current !== entry || entry.settled) return;
    const child = checkOrigin(entry); if (entry.settled) return;
    if (child) {
      try {
        const api = child.commonAgent, lifecycle = child.commonEmbedLifecycle;
        if (api && ['describe', 'state', 'execute', 'batch'].every(method => typeof api[method] === 'function') && typeof lifecycle?.destroy === 'function') {
          if (stylesheetState === 'loading') { entry.poll = setTimer(() => poll(entry), 50); return; }
          if (stylesheetState === 'failed') { failGeneration(entry, error('SDK_STYLESHEET_ERROR', `Common styles could not load from ${basePath}embed.css. Check host authentication and Content Security Policy, then reopen the canvas.`)); return; }
          entry.api = api; entry.lifecycle = lifecycle; entry.window = child;
          entry.document = child.document;
          const pageHide = () => { if (!destroyed && current === entry) beginGeneration(); };
          child.addEventListener('pagehide', pageHide, { once: true });
          entry.removePageHide = () => child.removeEventListener('pagehide', pageHide);
          lifecycle.setVisible?.(isOpen);
          if (typeof lifecycle.subscribe === 'function') entry.unsubscribe = lifecycle.subscribe(state => { if (!destroyed && current === entry) updateIndicator(state); });
          else updateIndicator(lifecycle.getState?.());
          if (destroyed || current !== entry) return;
          entry.settled = true; clearTimer(entry.timeout); clearTimer(entry.poll);
          status.hidden = true; entry.ready.resolve(controller); invoke(onReady, controller); return;
        }
      } catch { failGeneration(entry, error('SDK_INIT_FAILED', 'Common could not finish initialization. Reload the canvas and check the host mount configuration.')); return; }
    }
    entry.poll = setTimer(() => poll(entry), 50);
  }
  async function probe(entry) {
    if (typeof window.fetch !== 'function') return;
    try {
      const response = await window.fetch(route.href, { credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: entry.abort.signal });
      if (destroyed || current !== entry || entry.settled) return;
      if (response.status === 401) failGeneration(entry, error('SDK_UNAUTHORIZED', 'Common requires authentication. Sign in to the host application, then reopen the canvas.'));
      else if (response.status === 403) failGeneration(entry, error('SDK_FORBIDDEN', 'The host application denied access to Common. Check your account and the mount authorization settings.'));
      else if (response.status === 404) failGeneration(entry, error('SDK_ROUTE_NOT_FOUND', `No Common app was found at ${basePath}. Check that the Bun adapter is mounted at that path.`));
      else if (response.status >= 500) failGeneration(entry, error('SDK_SERVER_ERROR', 'The Common server could not load the canvas. Check the Bun application logs and try again.'));
      else if (response.type === 'opaqueredirect') failGeneration(entry, error('SDK_SIGN_IN_REQUIRED', 'Common redirected before startup. Sign in to the host app directly, then reopen the canvas.'));
    } catch { /* The iframe poll reports cross-origin and timeout failures. */ }
  }
  function onLoad() {
    if (destroyed || !loaded) return;
    let entry = current;
    let loadedDocument;
    try { loadedDocument = iframe.contentDocument; } catch {}
    if (entry.settled && (entry.api || entry.failed) && entry.document !== loadedDocument) entry = beginGeneration();
    if (!entry.settled) { void probe(entry); clearTimer(entry.poll); poll(entry); }
  }
  async function agentCall(method, args, options = {}) {
    if (destroyed) throw error('SDK_DESTROYED', 'This Common mount has been destroyed. Create a new mount before using it.');
    const signal = options?.signal;
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw error('SDK_INVALID_OPTIONS', 'Common agent signal must be an AbortSignal.');
    if (signal?.aborted) throw error('SDK_CANCELLED', 'The Common operation was cancelled.');
    const cancelled = deferred(), execution = new AbortControllerClass();
    const abort = () => { execution.abort(); cancelled.reject(error('SDK_CANCELLED', 'The Common operation was cancelled.')); };
    const abortGeneration = () => execution.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let entry;
    try {
      ensureLoaded(); entry = current;
      entry.abort.signal.addEventListener('abort', abortGeneration, { once: true });
      if (signal?.aborted) abort();
      if (entry.abort.signal.aborted) abortGeneration();
      await Promise.race([entry.ready.promise, entry.cancel.promise, cancelled.promise]);
      if (destroyed || current !== entry) throw error('SDK_FRAME_RELOADED', 'Common reloaded before this operation completed. Try again when it is ready.');
      let childArgs;
      try {
        // JSON parsing in the child realm preserves its strict plain-object checks.
        childArgs = args.map(value => {
          const serialized = JSON.stringify(jsonValue(value));
          if (serialized.length > 3 * 1024 * 1024) throw new TypeError('Arguments exceed the command size limit.');
          return entry.window.JSON.parse(serialized);
        });
      } catch { return { ok: false, error: { code: 'INVALID_COMMAND', message: 'Use plain JSON agent arguments within the command limits.' } }; }
      const invocation = Promise.resolve().then(() => {
        if (destroyed || current !== entry || execution.signal.aborted) throw error('SDK_CANCELLED', 'The Common operation was cancelled.');
        return ['execute', 'batch'].includes(method) ? entry.api[method](...childArgs, { signal: execution.signal }) : entry.api[method](...childArgs);
      });
      const result = await Promise.race([invocation, entry.cancel.promise, cancelled.promise]);
      if (destroyed || current !== entry) throw error('SDK_FRAME_RELOADED', 'Common reloaded before this operation completed.');
      return JSON.parse(JSON.stringify(result));
    } finally {
      entry?.abort.signal.removeEventListener('abort', abortGeneration); signal?.removeEventListener('abort', abort);
    }
  }
  controller = Object.freeze({
    open() { setOpen(true); }, close() { setOpen(false); }, toggle() { setOpen(!isOpen); },
    ready() { if (destroyed) return Promise.reject(error('SDK_DESTROYED', 'This Common mount has been destroyed.')); ensureLoaded(); return current.ready.promise; },
    agent: Object.freeze({ describe: () => agentCall('describe', []), state: (options = {}) => agentCall('state', [options]),
      execute: (command, options) => agentCall('execute', [command], options), batch: (commands, options) => agentCall('batch', [commands], options) }),
    destroy() {
      if (destroyPromise) return destroyPromise;
      destroyed = true; const entry = current;
      let lifecycle = entry?.lifecycle;
      try { lifecycle ||= iframe.contentWindow?.commonEmbedLifecycle; } catch {}
      invalidate(entry, error('SDK_DESTROYED', 'This Common mount was destroyed before the operation completed.'));
      iframe.removeEventListener('load', onLoad); stylesheet.onerror = stylesheet.onload = null;
      destroyPromise = (async () => {
        let timeout;
        try {
          if (lifecycle) await Promise.race([Promise.resolve().then(() => lifecycle.destroy()), new Promise((_, reject) => { timeout = setTimer(() => reject(error('SDK_CLEANUP_TIMEOUT', 'Common cleanup timed out. The iframe has been removed to stop its session.')), CLEANUP_TIMEOUT_MS); })]);
        } catch (problem) { report(problem?.code === 'SDK_CLEANUP_TIMEOUT' ? problem : error('SDK_CLEANUP_FAILED', 'Common cleanup could not finish before the iframe was removed.')); }
        finally { clearTimer(timeout); iframe.remove(); host.remove(); }
      })();
      return destroyPromise;
    },
  });
  launcher.addEventListener('click', () => controller.toggle()); closeButton.addEventListener('click', () => controller.close());
  shadow.addEventListener('keydown', event => { if (event.key === 'Escape' && isOpen) { event.preventDefault(); event.stopPropagation(); controller.close(); } });
  stylesheet.onload = () => { if (!destroyed) { stylesheetState = 'loaded'; panel.hidden = false; } };
  stylesheet.onerror = () => {
    if (destroyed) return;
    stylesheetState = 'failed';
    report(error('SDK_STYLESHEET_ERROR', `Common styles could not load from ${basePath}embed.css. Check host authentication and Content Security Policy, then reopen the canvas.`));
  };
  iframe.addEventListener('load', onLoad);
  beginGeneration(); setOpen(isOpen, false); target.append(host);
  return controller;
}

export default mountCommon;
