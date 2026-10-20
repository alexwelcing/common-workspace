const MAX_RESULT_CHARACTERS = 5000;
const captureOwners = new WeakMap();
const sourceError = (code, message) => Object.assign(new Error(message), { code });
const invalid = message => { throw sourceError('SOURCE_INVALID', message); };
const fits = value => JSON.stringify(value).length <= MAX_RESULT_CHARACTERS;
const rounded = value => Math.round(value * 1000) / 1000;
const composedParent = element => element.assignedSlot || element.parentElement || element.getRootNode()?.host || null;

function boundedString(value, maximum, label, { optional = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) invalid(`${label} must be a nonempty string of at most ${maximum} characters.`);
  return value;
}

function pageInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) invalid(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

/** Explicit, read-only page context owned by the host application. No DOM text or form values are collected. */
export function createPageCompanion({ root, describe, targets, captureHandle = false } = {}) {
  const document = root?.ownerDocument;
  const window = document?.defaultView;
  if (!window || !(root instanceof window.Element)) invalid('Page context needs a host-page root Element.');
  if (typeof describe !== 'function' || typeof targets !== 'function') invalid('Page context needs synchronous describe and targets callbacks.');
  if (typeof captureHandle !== 'boolean') invalid('captureHandle must be a boolean.');
  if (!['http:', 'https:'].includes(window.location.protocol) || window.location.origin === 'null') invalid('Page context requires an HTTP or HTTPS host origin.');

  const identifier = () => window.crypto.randomUUID?.() || [...window.crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
  const sourceId = identifier();
  const origin = window.location.origin;
  const listeners = new Set();
  const captureOwner = {};
  let documentId = identifier(), pathname = window.location.pathname, revision = 1;
  let destroyed = false, pendingFrame = null, configuredHandle = null;
  let observer, ancestryObserver, ancestorNodes = [], watchedAncestors = [], dirty = false, synchronizing = false;

  const available = () => {
    try { return !destroyed && root.isConnected && window.document === document; } catch { return false; }
  };
  const notify = reason => {
    Array.from(listeners).forEach(listener => { try { listener({ reason }); } catch {} });
  };
  let lastAvailable = available();
  function ancestors() {
    const nodes = new Set();
    for (let node = root.parentNode; node; node = node.parentNode || node.host) nodes.add(node);
    for (let element = composedParent(root); element; element = composedParent(element)) nodes.add(element);
    return [...nodes];
  }
  function watchAncestors(nodes) {
    ancestryObserver?.disconnect();
    for (const node of watchedAncestors) node.removeEventListener('scroll', scheduleUpdate, true);
    ancestorNodes = nodes; watchedAncestors = nodes;
    for (const node of nodes) {
      ancestryObserver?.observe(node, { childList: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'data-common-private'] });
      node.addEventListener('scroll', scheduleUpdate, true);
    }
  }
  function syncState(force = false) {
    if (destroyed || synchronizing) return;
    synchronizing = true;
    try {
      const rootChanged = !!observer?.takeRecords().length;
      const ancestorAttributesChanged = ancestryObserver?.takeRecords().some(record => record.type === 'attributes');
      const nextAvailable = available(), nodes = ancestors();
      const ancestryChanged = nodes.length !== ancestorNodes.length || nodes.some((node, index) => node !== ancestorNodes[index]);
      const navigation = nextAvailable && pathname !== window.location.pathname;
      if (!force && !dirty && !rootChanged && !ancestorAttributesChanged && !ancestryChanged && nextAvailable === lastAvailable && !navigation) return;
      if (pendingFrame !== null) { window.cancelAnimationFrame(pendingFrame); pendingFrame = null; }
      dirty = false; lastAvailable = nextAvailable;
      // Keep the former chain while detached so reattachment to it can be seen.
      if (ancestryChanged) {
        if (nodes.length) watchAncestors(nodes);
        else ancestorNodes = nodes;
      }
      if (navigation) { pathname = window.location.pathname; documentId = identifier(); }
      revision++; notify(navigation ? 'navigation' : 'updated');
    } finally { synchronizing = false; }
  }
  function getState() {
    syncState();
    return { available: available(), sourceId, documentId, revision, origin, captureHandle: configuredHandle };
  }
  function assertAvailable() {
    const state = getState();
    if (!state.available) throw sourceError('SOURCE_UNAVAILABLE', 'The linked host page has closed or its configured root is no longer available.');
    return state;
  }
  function update() {
    syncState(true);
    return getState();
  }
  function scheduleUpdate(event) {
    if (destroyed) return;
    if (event?.type === 'scroll' && event.target !== window && event.target !== document && event.target !== window.visualViewport
      && !ancestorNodes.includes(event.target) && (!(event.target instanceof window.Node) || !root.contains(event.target))) return;
    dirty = true;
    if (pendingFrame === null) pendingFrame = window.requestAnimationFrame(() => { pendingFrame = null; syncState(); });
  }
  function viewport() {
    const visual = window.visualViewport;
    const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
    return {
      width: rounded(positive(visual?.width, positive(window.innerWidth, 1))),
      height: rounded(positive(visual?.height, positive(window.innerHeight, 1))),
      offsetLeft: rounded(Number.isFinite(visual?.offsetLeft) ? visual.offsetLeft : 0),
      offsetTop: rounded(Number.isFinite(visual?.offsetTop) ? visual.offsetTop : 0),
    };
  }
  function visibleBounds(element, view) {
    if (!element.isConnected || !element.getClientRects().length || element.matches('input[type="password"], input[type="hidden"]')) return null;
    const rect = element.getBoundingClientRect();
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
    let left = Math.max(rect.left, view.offsetLeft), top = Math.max(rect.top, view.offsetTop);
    let right = Math.min(rect.right, view.offsetLeft + view.width), bottom = Math.min(rect.bottom, view.offsetTop + view.height);
    for (let ancestor = element; ancestor; ancestor = composedParent(ancestor)) {
      if (ancestor.matches('[hidden], [inert], [aria-hidden="true"], [data-common-private]')) return null;
      const style = window.getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || style.contentVisibility === 'hidden' || Number.parseFloat(style.opacity) === 0) return null;
      if (ancestor === element) continue;
      const clipX = /^(hidden|clip|scroll|auto)$/.test(style.overflowX);
      const clipY = /^(hidden|clip|scroll|auto)$/.test(style.overflowY);
      if (!clipX && !clipY) continue;
      const clip = ancestor.getBoundingClientRect();
      const scaleX = ancestor.offsetWidth ? clip.width / ancestor.offsetWidth : 1;
      const scaleY = ancestor.offsetHeight ? clip.height / ancestor.offsetHeight : 1;
      const clipLeft = clip.left + ancestor.clientLeft * scaleX, clipTop = clip.top + ancestor.clientTop * scaleY;
      if (clipX) { left = Math.max(left, clipLeft); right = Math.min(right, clipLeft + ancestor.clientWidth * scaleX); }
      if (clipY) { top = Math.max(top, clipTop); bottom = Math.min(bottom, clipTop + ancestor.clientHeight * scaleY); }
    }
    if (right <= left || bottom <= top) return null;
    return {
      bounds: { x: rounded(rect.left), y: rounded(rect.top), width: rounded(rect.width), height: rounded(rect.height) },
      normalizedBounds: { x: (left - view.offsetLeft) / view.width, y: (top - view.offsetTop) / view.height,
        width: (right - left) / view.width, height: (bottom - top) / view.height },
    };
  }
  function registeredTargets(view) {
    let result;
    try { result = targets(); } catch { invalid('The page targets callback failed. Check the host integration.'); }
    if (!Array.isArray(result) || result.length > 200) invalid('The page targets callback must return an array of at most 200 targets.');
    const ids = new Set();
    return result.map(item => {
      if (!item || typeof item !== 'object') invalid('Every page target needs an id, label, and root-contained Element.');
      const id = boundedString(item.id, 100, 'Target id');
      const label = boundedString(item.label, 120, 'Target label');
      if (ids.has(id)) invalid('Page target ids must be unique.');
      ids.add(id);
      const element = item.element;
      if (!(element instanceof window.Element) || !root.contains(element)) invalid('Every page target Element must belong to the configured root.');
      const role = boundedString(item.role ?? element.getAttribute('role') ?? element.tagName.toLowerCase(), 40, 'Target role');
      const geometry = visibleBounds(element, view);
      return { id, label, role, disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true', ...geometry };
    });
  }
  function metadata(state) {
    return { sourceId: state.sourceId, documentId: state.documentId, revision: state.revision };
  }
  function ensureCurrent(state) {
    const current = assertAvailable();
    if (current.documentId !== state.documentId || current.revision !== state.revision) {
      throw sourceError('SOURCE_CHANGED', 'The page changed while its context was being read. Read the page again.');
    }
  }
  function inspect() {
    const state = assertAvailable(), view = viewport();
    let description;
    try { description = describe(); } catch { invalid('The page description callback failed. Check the host integration.'); }
    if (!description || typeof description !== 'object' || typeof description.then === 'function') invalid('The page description callback must return a synchronous description object.');
    for (const key of ['title', 'summary', 'route']) if (description[key] !== undefined && typeof description[key] !== 'string') invalid(`Page ${key} must be a string.`);
    let route;
    try { route = new URL(description.route ?? pathname, origin).pathname; } catch { invalid('Page route must describe a valid pathname.'); }
    const title = (description.title ?? document.title).slice(0, 120);
    const originalSummary = description.summary ?? '';
    const result = { ...metadata(state), origin, title, summary: originalSummary.slice(0, 1600), route: route.slice(0, 200),
      viewport: view, targetCount: registeredTargets(view).filter(item => item.bounds).length };
    if (title.length < (description.title ?? document.title).length || result.summary.length < originalSummary.length || result.route.length < route.length) result.truncated = true;
    while (!fits(result) && result.summary.length) { result.summary = result.summary.slice(0, Math.floor(result.summary.length / 2)); result.truncated = true; }
    ensureCurrent(state);
    if (!fits(result)) throw sourceError('SOURCE_TOO_LARGE', 'The page description is too large. Shorten the supplied title and route.');
    return result;
  }
  function search({ query = '', offset, limit } = {}) {
    if (typeof query !== 'string' || query.length > 200) invalid('Page search query must be a string of at most 200 characters.');
    offset = pageInteger(offset, 0, 0, 100000, 'Page offset');
    limit = pageInteger(limit, 6, 1, 12, 'Page limit');
    const state = assertAvailable(), view = viewport();
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = registeredTargets(view).filter(item => item.bounds && terms.every(term => `${item.id} ${item.label} ${item.role}`.toLowerCase().includes(term)));
    const result = { ...metadata(state), items: [], total: matches.length, offset, nextOffset: null };
    for (const item of matches.slice(offset, offset + limit)) {
      const { normalizedBounds: _normalized, ...summary } = item;
      result.items.push(summary);
      result.nextOffset = offset + result.items.length < result.total ? offset + result.items.length : null;
      if (!fits(result)) { result.items.pop(); result.nextOffset = offset + result.items.length; break; }
    }
    ensureCurrent(state);
    return result;
  }
  function locate({ id } = {}) {
    boundedString(id, 100, 'Target id');
    const state = assertAvailable(), view = viewport();
    const item = registeredTargets(view).find(target => target.id === id);
    if (!item) throw sourceError('SOURCE_TARGET_NOT_FOUND', 'That page target is no longer registered. Use source.search to find a current target.');
    if (!item.bounds) throw sourceError('SOURCE_TARGET_NOT_VISIBLE', 'That page target is hidden or outside the visible viewport. Make it visible, then locate it again.');
    const { normalizedBounds, ...target } = item;
    const result = { ...metadata(state), target, viewport: view, normalizedBounds };
    ensureCurrent(state);
    if (!fits(result)) throw sourceError('SOURCE_TOO_LARGE', 'The page target is too large. Shorten its supplied label.');
    return result;
  }

  if (captureHandle && window.top === window && window.isSecureContext && typeof window.navigator.mediaDevices?.setCaptureHandleConfig === 'function' && !captureOwners.has(document)) {
    try {
      window.navigator.mediaDevices.setCaptureHandleConfig({ handle: sourceId, exposeOrigin: true, permittedOrigins: [origin] });
      captureOwners.set(document, captureOwner); configuredHandle = sourceId;
    } catch { /* Page context remains available when capture identity is unsupported. */ }
  }
  observer = typeof window.MutationObserver === 'function' ? new window.MutationObserver(scheduleUpdate) : null;
  observer?.observe(root, { subtree: true, attributes: true, childList: true, characterData: true });
  ancestryObserver = typeof window.MutationObserver === 'function' ? new window.MutationObserver(records => {
    // Only the ancestor chain is observed, without subtree content or values.
    if (records.length) dirty = true;
    syncState();
  }) : null;
  watchAncestors(ancestors());
  root.addEventListener('scroll', scheduleUpdate, true);
  window.addEventListener('scroll', scheduleUpdate, true);
  window.addEventListener('resize', scheduleUpdate);
  window.addEventListener('popstate', update);
  window.addEventListener('hashchange', update);
  window.visualViewport?.addEventListener('resize', scheduleUpdate);
  window.visualViewport?.addEventListener('scroll', scheduleUpdate);
  function destroy() {
    if (destroyed) return;
    destroyed = true; revision++;
    if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
    pendingFrame = null; observer?.disconnect(); ancestryObserver?.disconnect();
    root.removeEventListener('scroll', scheduleUpdate, true);
    for (const node of watchedAncestors) node.removeEventListener('scroll', scheduleUpdate, true);
    watchedAncestors = []; ancestorNodes = [];
    window.removeEventListener('scroll', scheduleUpdate, true); window.removeEventListener('resize', scheduleUpdate);
    window.removeEventListener('popstate', update); window.removeEventListener('hashchange', update);
    window.removeEventListener('pagehide', onPageHide);
    window.visualViewport?.removeEventListener('resize', scheduleUpdate); window.visualViewport?.removeEventListener('scroll', scheduleUpdate);
    if (captureOwners.get(document) === captureOwner) {
      captureOwners.delete(document);
      try { window.navigator.mediaDevices.setCaptureHandleConfig({}); } catch {}
    }
    configuredHandle = null; notify('destroyed'); listeners.clear();
  }
  const onPageHide = event => { if (!event.persisted) destroy(); };
  window.addEventListener('pagehide', onPageHide);
  return Object.freeze({ ownerDocument: document, getState, inspect, search, locate, update, destroy,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A page context listener must be a function.');
      if (!destroyed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
