const VERSION = '1';
const MAX_BATCH = 50;
const MAX_COMMAND_BYTES = 3 * 1024 * 1024;
const IMAGE_LIMIT = 2 * 1024 * 1024;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const TYPES = new Set(['text', 'sticky', 'rectangle', 'ellipse', 'arrow', 'draw', 'image', 'diagram']);
const GEOMETRY = new Set(['x', 'y', 'width', 'height', 'points']);
const ENTITY_FIELDS = ['x', 'y', 'width', 'height', 'text', 'color', 'fill', 'fontSize', 'points', 'title', 'language', 'source', 'url', 'locked'];
const DEFAULTS = {
  text: { width: 300, height: 86, text: '', fontSize: 24 },
  sticky: { width: 224, height: 182, text: '', fontSize: 18, fill: '#fff0b5' },
  rectangle: { width: 220, height: 130, fill: 'transparent' },
  ellipse: { width: 180, height: 130, fill: 'transparent' },
  arrow: { width: 180, height: 64 }, draw: { width: 100, height: 100, points: [] },
  image: { width: 360, height: 260, title: 'Image' },
  diagram: { width: 440, height: 300, title: 'Diagram', language: 'mermaid', source: '' },
};
const SCHEMAS = {
  'canvas.inspect': ['includeImageData'], 'canvas.add': ['entity'], 'canvas.update': ['id', 'patch'],
  'canvas.remove': ['id'], 'canvas.layer': ['id', 'position'], 'canvas.lock': ['id', 'locked'],
  'view.focus': ['id', 'bounds'], 'view.fit': [],
  'image.add': ['dataUrl', 'title', 'x', 'y', 'width', 'height'],
  'walkthrough.load': ['steps'], 'walkthrough.next': [], 'walkthrough.previous': [], 'walkthrough.stop': [],
  'capture.snapshot': ['download'], 'recording.start': ['source'], 'recording.stop': [],
  'recording.list': [], 'recording.download': ['id'], 'canvas.export': ['format', 'download'],
};
const EDIT_ACTIONS = new Set(['canvas.add', 'canvas.update', 'canvas.remove', 'canvas.layer', 'canvas.lock', 'image.add']);
const CONTEXT_ERRORS = new Set(['SESSION_CHANGED', 'AGENT_DISABLED', 'DISCONNECTED']);
const sessionScope = ctx => JSON.stringify([!!ctx.sandbox, ctx.room?.id ?? null, ctx.participantId ?? null]);
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const envelope = error => ({ ok: false, error: { code: error?.code || 'FAILED', message: error?.code ? error.message : 'The command could not be completed.' } });
const clone = value => value === undefined ? null : structuredClone(value);

function object(value, label = 'Object') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_COMMAND', `${label} must be a plain JSON object.`);
  return value;
}
function keys(value, allowed, label = 'Object') {
  object(value, label);
  for (const key of Object.keys(value)) if (RESERVED.has(key) || !allowed.includes(key)) fail('INVALID_COMMAND', `${label} contains an unsupported field: ${key}.`);
}
function string(value, max, label, required = true) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('INVALID_COMMAND', `${label} must be a${required ? ' nonempty' : ''} string of at most ${max} characters.`);
}
function boolean(value, label, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== 'boolean') fail('INVALID_COMMAND', `${label} must be a boolean.`);
}
function number(value, max, label, positive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > max || (positive && value <= 0)) fail('INVALID_COMMAND', `${label} must be a finite ${positive ? 'positive ' : ''}number within ${max}.`);
}
function bounds(value) {
  keys(value, ['x', 'y', 'width', 'height'], 'Bounds');
  number(value.x, 100000, 'Bounds x'); number(value.y, 100000, 'Bounds y');
  number(value.width, 10000, 'Bounds width', true); number(value.height, 10000, 'Bounds height', true);
}
function image(value) {
  if (typeof value !== 'string' || value.length > IMAGE_LIMIT) fail('INVALID_IMAGE', 'Images must be embedded raster data URLs smaller than 2 MiB.');
  const match = /^data:image\/(png|jpe?g|webp|gif|avif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || match[2].length % 4 !== 0) fail('INVALID_IMAGE', 'Use a base64 PNG, JPEG, WebP, GIF, or AVIF image; remote URLs and SVG are not supported.');
  let header;
  try { header = atob(match[2].slice(0, 64)); } catch { fail('INVALID_IMAGE', 'The image has invalid base64 data.'); }
  const type = match[1].toLowerCase();
  const valid = type === 'png' ? header.startsWith('\x89PNG\r\n\x1a\n')
    : ['jpeg', 'jpg'].includes(type) ? header.startsWith('\xff\xd8\xff')
    : type === 'gif' ? /^GIF8[79]a/.test(header)
    : type === 'webp' ? header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP'
    : header.slice(4, 8) === 'ftyp' && /avif|avis/.test(header.slice(8, 40));
  if (!valid) fail('INVALID_IMAGE', 'The embedded image does not match its declared raster format.');
}
function fields(value, { creation = false, type, allowEmpty = false } = {}) {
  keys(value, creation ? ['id', 'type', ...ENTITY_FIELDS] : ENTITY_FIELDS, creation ? 'Entity' : 'Patch');
  if (creation) { if (!TYPES.has(value.type)) fail('INVALID_COMMAND', 'Choose a supported canvas type; screen objects are managed by screen sharing.'); if (value.id !== undefined) string(value.id, 100, 'Entity id'); }
  if (!creation && !allowEmpty && !Object.keys(value).length) fail('INVALID_COMMAND', 'Patch must contain at least one supported field.');
  for (const key of ['x', 'y']) if (value[key] !== undefined) number(value[key], 100000, key);
  for (const key of ['width', 'height']) if (value[key] !== undefined) number(value[key], 10000, key, true);
  for (const key of ['text', 'source']) string(value[key], 20000, key, false);
  string(value.title, 200, 'Title', false);
  if (value.fontSize !== undefined) { number(value.fontSize, 200, 'Font size', true); if (value.fontSize < 8) fail('INVALID_COMMAND', 'Font size must be at least 8.'); }
  for (const key of ['color', 'fill']) if (value[key] !== undefined) {
    string(value[key], 100, key);
    if (!/^(?:#[\da-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d\s.,%+\-/]+\))$/i.test(value[key])) fail('INVALID_COMMAND', 'Colors must be a CSS color without URLs or variables.');
  }
  boolean(value.locked, 'Locked');
  if (value.points !== undefined) {
    if ((type !== undefined && !['draw', 'arrow'].includes(type)) || !Array.isArray(value.points) || value.points.length > 10000) fail('INVALID_COMMAND', 'Drawing points require a draw or arrow object and at most 10,000 points.');
    for (const point of value.points) { keys(point, ['x', 'y'], 'Point'); number(point.x, 100000, 'Point x'); number(point.y, 100000, 'Point y'); }
  }
  if (value.language !== undefined && ((type !== undefined && type !== 'diagram') || !['mermaid', 'plantuml'].includes(value.language))) fail('INVALID_COMMAND', 'Diagram language must be mermaid or plantuml.');
  if (value.source !== undefined && type !== undefined && type !== 'diagram') fail('INVALID_COMMAND', 'Only diagrams have source text.');
  if (value.url !== undefined) { if (type !== undefined && type !== 'image') fail('INVALID_IMAGE', 'Only image objects accept embedded image URLs.'); image(value.url); }
  if (creation && type === 'image' && !value.url) fail('INVALID_IMAGE', 'Image objects need an embedded raster URL.');
  if (type === 'screen' && Object.keys(value).some(key => !['x', 'y', 'width', 'height', 'title', 'locked'].includes(key))) fail('INVALID_COMMAND', 'Screen content is managed by screen sharing.');
}

// Reject non-JSON input before any service sees it. Accessors, custom prototypes,
// prototype-related keys, excessive nesting and non-finite numbers are excluded.
function jsonCopy(value, depth = 0) {
  if (depth > 12) fail('INVALID_COMMAND', 'Command nesting exceeds the limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('INVALID_COMMAND', 'JSON numbers must be finite.'); return value; }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10000 || Object.getOwnPropertySymbols(value).length) fail('INVALID_COMMAND', 'Use a plain JSON array within the command limit.');
    if (Object.keys(value).some(key => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail('INVALID_COMMAND', 'Arrays cannot contain named fields.');
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) fail('INVALID_COMMAND', 'Arrays cannot contain holes, getters or setters.');
      return jsonCopy(descriptor.value, depth + 1);
    });
  }
  object(value, 'Command value');
  if (Object.getOwnPropertySymbols(value).length) fail('INVALID_COMMAND', 'Commands cannot contain symbol fields.');
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (RESERVED.has(key)) fail('INVALID_COMMAND', 'Prototype-related fields are not supported.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) fail('INVALID_COMMAND', 'Commands cannot contain getters or setters.');
    output[key] = jsonCopy(descriptor.value, depth + 1);
  }
  return output;
}
function normalize(input) {
  const command = jsonCopy(input);
  if (JSON.stringify(command).length > MAX_COMMAND_BYTES) fail('INVALID_COMMAND', 'Command exceeds the 3 MiB limit.');
  object(command, 'Command');
  if (!Object.hasOwn(SCHEMAS, command.action)) fail('UNKNOWN_ACTION', 'Unknown action. Call describe() for supported commands.');
  keys(command, ['action', 'requestId', ...SCHEMAS[command.action]], 'Command');
  string(command.requestId, 100, 'Request id', false);
  if (command.requestId !== undefined && !command.requestId.trim()) fail('INVALID_COMMAND', 'Request id cannot be empty.');
  const action = command.action;
  if (['canvas.update', 'canvas.remove', 'canvas.layer', 'canvas.lock', 'recording.download'].includes(action)) string(command.id, 100, 'Object id');
  if (action === 'canvas.inspect') boolean(command.includeImageData, 'Include image data');
  if (action === 'canvas.add') fields(command.entity, { creation: true, type: command.entity?.type });
  if (action === 'canvas.update') fields(command.patch);
  if (action === 'canvas.layer' && !['front', 'back', 'forward', 'backward'].includes(command.position)) fail('INVALID_COMMAND', 'Layer position must be front, back, forward, or backward.');
  if (action === 'canvas.lock') boolean(command.locked, 'Locked', true);
  if (action === 'view.focus') {
    if (Number(command.id !== undefined) + Number(command.bounds !== undefined) !== 1) fail('INVALID_COMMAND', 'Focus requires either id or bounds.');
    if (command.id !== undefined) string(command.id, 100, 'Object id'); else bounds(command.bounds);
  }
  if (action === 'image.add') {
    image(command.dataUrl);
    fields(Object.fromEntries(Object.entries(command).filter(([key]) => !['action', 'requestId', 'dataUrl'].includes(key))), { type: 'image', allowEmpty: true });
  }
  if (action === 'walkthrough.load') {
    if (!Array.isArray(command.steps) || !command.steps.length || command.steps.length > 50) fail('INVALID_COMMAND', 'Walkthroughs need 1–50 steps.');
    for (const step of command.steps) {
      keys(step, ['title', 'text', 'targetId', 'bounds'], 'Walkthrough step'); string(step.title, 200, 'Step title'); string(step.text, 5000, 'Step text', false); if (step.targetId !== undefined) string(step.targetId, 100, 'Step target id');
      if (step.bounds !== undefined) bounds(step.bounds);
      if (step.targetId !== undefined && step.bounds !== undefined) fail('INVALID_COMMAND', 'A walkthrough step may focus a target id or bounds, not both.');
    }
  }
  if (action === 'recording.start' && !['canvas', 'window'].includes(command.source)) fail('INVALID_COMMAND', 'Recording source must be canvas or window.');
  if (['capture.snapshot', 'canvas.export'].includes(action)) boolean(command.download, 'Download');
  if (action === 'canvas.export' && command.format !== undefined && !['svg', 'json'].includes(command.format)) fail('INVALID_COMMAND', 'Export format must be svg or json.');
  return command;
}

/** Browser-local, opt-in automation. Credentials and transport internals are never exposed. */
export function createAgentAPI({ getBoard, getModel, getContext, recording, walkthrough, onStatus = () => {} }) {
  const cache = new Map(); let cacheScope; let cacheModel;
  const context = () => getContext?.() || {};
  const active = ctx => !!ctx.enabled && (!!ctx.sandbox || !!ctx.connected);
  function access(command) {
    const ctx = context();
    if (!ctx.enabled) fail('AGENT_DISABLED', 'Enable Agent tools in this browser before using canvas commands.');
    if (!ctx.sandbox && !ctx.connected) fail('DISCONNECTED', 'Reconnect to the session before using canvas commands.');
    if (!getModel?.() || !getBoard?.()) fail('NOT_READY', 'The canvas is not ready.');
    if (EDIT_ACTIONS.has(command.action) && getBoard().readOnly) fail('READ_ONLY', 'The canvas is currently read-only.');
    return ctx;
  }
  function editable(id, ctx) {
    const entity = getModel().get(id);
    if (!entity) fail('NOT_FOUND', 'The canvas object was not found.');
    const board = getBoard();
    if (entity.type === 'screen' && !ctx.sandbox && entity.participantId !== ctx.participantId) fail('FORBIDDEN', 'Only the screen owner may edit this screen object.');
    if (board.canEdit && !board.canEdit(entity)) fail('FORBIDDEN', 'This canvas object cannot be edited by this participant.');
    return entity;
  }
  function entities(includeImageData = false) {
    return getModel().all().map(entity => {
      const { streamId, screenId, ...safe } = entity;
      if (safe.type === 'image' && !includeImageData && safe.url) { safe.hasImageData = true; safe.imageDataLength = safe.url.length; delete safe.url; }
      return safe;
    });
  }
  function state({ includeImageData = false } = {}) {
    try {
      boolean(includeImageData, 'Include image data');
      const ctx = context(); const board = getBoard?.(); const permitted = active(ctx);
      const output = { version: VERSION, enabled: !!ctx.enabled, sandbox: !!ctx.sandbox, connected: !!ctx.connected, ready: permitted && !!board && !!getModel?.(), readOnly: !!board?.readOnly };
      if (permitted) {
        output.room = ctx.room ? { id: ctx.room.id, name: ctx.room.name } : null;
        output.participantId = ctx.participantId ?? null;
        output.participants = (Array.isArray(ctx.participants) ? ctx.participants : []).map(person => Object.fromEntries(['id', 'name', 'color', 'isHost', 'sharing'].filter(key => ['string', 'boolean'].includes(typeof person?.[key])).map(key => [key, person[key]])));
        output.view = board?.getView?.() || null;
        output.entities = getModel?.() ? entities(includeImageData) : [];
        output.walkthrough = walkthrough?.state?.() || null;
        output.recording = recording?.status?.() || null;
      }
      return clone(output);
    } catch (error) { return envelope(error); }
  }
  function describe() {
    return { version: VERSION, enabled: !!context().enabled, actions: clone(SCHEMAS), limits: { batch: MAX_BATCH, requestCache: 100, imageDataUrlCharacters: IMAGE_LIMIT, walkthroughSteps: 50 },
      command: '{action, requestId?, ...arguments}', examples: [{ action: 'canvas.add', entity: { type: 'text', text: 'Product walkthrough', x: 40, y: 40 } }, { action: 'view.focus', id: 'object-id' }],
      notes: ['Enable Agent tools in the local browser first.', 'Use requestId for idempotent retries in the same session.', 'Batch validates all command shapes first and runs sequentially; execution failures do not roll back earlier commands. Session changes, disabled Agent tools, or disconnection abort the remaining commands.', 'Window recording uses an existing user-approved screen share. Image generation happens in the agent; image.add imports its raster output.', 'Position locks prevent geometry edits. Screen objects are created by browser screen sharing.'] };
  }
  async function service(target, method, ...args) {
    if (typeof target?.[method] !== 'function') fail('UNSUPPORTED', `The ${method} service is not available in this browser.`);
    return (await target[method](...args)) ?? null;
  }
  function focus(target) {
    const board = getBoard(); const width = board.el?.clientWidth || 1000; const height = board.el?.clientHeight || 700;
    board.setZoom(Math.min(1.5, (width - 96) / target.width, (height - 96) / target.height));
    board.pan = { x: width / 2 - (target.x + target.width / 2) * board.zoom, y: height / 2 - (target.y + target.height / 2) * board.zoom };
    board.updateView(); return board.getView();
  }
  async function run(command, ctx, isAllowed) {
    const model = getModel(); const board = getBoard(); const action = command.action;
    if (action === 'canvas.inspect') return state({ includeImageData: command.includeImageData ?? false });
    if (action === 'canvas.add' || action === 'image.add') {
      const input = action === 'canvas.add' ? command.entity : { type: 'image', url: command.dataUrl, ...Object.fromEntries(['title', 'x', 'y', 'width', 'height'].filter(key => command[key] !== undefined).map(key => [key, command[key]])) };
      const entity = { ...DEFAULTS[input.type], x: 0, y: 0, ...input, id: input.id || crypto.randomUUID() };
      if (model.get(entity.id)) fail('ALREADY_EXISTS', 'An object with that id already exists.');
      if (board.canEdit && !board.canEdit(entity)) fail('FORBIDDEN', 'This participant cannot add this object.');
      if (!model.setLocal(entity)) fail('MODEL_REJECTED', 'The canvas rejected this object. Check its limits and choose a fresh id.');
      return model.get(entity.id);
    }
    if (EDIT_ACTIONS.has(action)) {
      const entity = editable(command.id, ctx);
      if (action === 'canvas.update') {
        fields(command.patch, { type: entity.type });
        if (entity.locked && Object.keys(command.patch).some(key => GEOMETRY.has(key))) fail('LOCKED', 'Unlock the object before changing its position, size, or drawing points.');
        const changed = model.patch(command.id, command.patch);
        if (!changed && Object.entries(command.patch).some(([key, value]) => JSON.stringify(entity[key]) !== JSON.stringify(value))) fail('MODEL_REJECTED', 'The canvas rejected this update.');
        return { changed, entity: model.get(command.id) };
      }
      if (action === 'canvas.remove') return { id: command.id, removed: model.deleteLocal(command.id) };
      if (action === 'canvas.layer') return { id: command.id, changed: model.reorder(command.id, command.position), order: model.getOrder() };
      const changed = model.patch(command.id, { locked: command.locked });
      if (model.get(command.id)?.locked !== command.locked) fail('MODEL_REJECTED', 'The canvas rejected this lock change.');
      return { id: command.id, changed, locked: model.get(command.id)?.locked };
    }
    if (action === 'view.focus') {
      const entity = command.id ? model.get(command.id) : null;
      if (command.id && !entity) fail('NOT_FOUND', 'The canvas object was not found.');
      if (entity) board.select(entity.id);
      return focus(entity || command.bounds);
    }
    if (action === 'view.fit') { board.fit(); return board.getView(); }
    if (action.startsWith('walkthrough.')) return service(walkthrough, action.split('.')[1], ...(action === 'walkthrough.load' ? [command.steps] : []));
    if (action === 'capture.snapshot') return service(recording, 'snapshot', { download: command.download ?? false, isAllowed });
    if (action.startsWith('recording.')) {
      const method = action.split('.')[1];
      return service(recording, method, ...(method === 'start' ? [{ source: command.source, isAllowed }] : method === 'download' ? [command.id] : []));
    }
    if (action === 'canvas.export') {
      const format = command.format || 'svg'; const mimeType = format === 'svg' ? 'image/svg+xml' : 'application/json'; const filename = `common-canvas.${format}`;
      const data = format === 'svg' ? board.exportSvg() : JSON.stringify({ version: 1, entities: model.all().filter(entity => entity.type !== 'screen') }, null, 2);
      if (command.download) await service(recording, 'exportCanvas', data, { format, mimeType, filename, download: true });
      return { format, mimeType, filename, data };
    }
    fail('UNKNOWN_ACTION', 'Unsupported action.');
  }
  async function execute(input) {
    try {
      const command = normalize(input); const ctx = access(command); const initialModel = getModel();
      const scope = sessionScope(ctx);
      if (scope !== cacheScope || cacheModel !== initialModel) { cache.clear(); cacheScope = scope; cacheModel = initialModel; }
      const fingerprint = JSON.stringify(Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'requestId')));
      const previous = command.requestId ? cache.get(command.requestId) : null;
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('REQUEST_ID_CONFLICT', 'That request id was already used for a different command.');
        return clone(await previous.promise);
      }
      if (command.requestId && cache.size >= 100) {
        const completed = [...cache].find(([, entry]) => entry.done);
        if (!completed) fail('BUSY', 'Too many commands are still running. Wait for a command to complete.');
        cache.delete(completed[0]);
      }
      const entry = { fingerprint, done: false };
      // Defer service work until the cache entry exists, so concurrent identical
      // retries share even an asynchronous recording/snapshot operation.
      const currentContext = () => {
        const current = access(command);
        if (getModel() !== initialModel || scope !== sessionScope(current)) fail('SESSION_CHANGED', 'The session changed before this command completed.');
        return current;
      };
      // Capture may await image/diagram rendering before it creates a recorder.
      // Its final permission check must run before the side effect, while the
      // ordinary post-result check still protects every command response.
      const isAllowed = () => { try { currentContext(); return true; } catch { return false; } };
      entry.promise = Promise.resolve().then(() => run(command, currentContext(), isAllowed)).then(result => { currentContext(); return { ok: true, result: clone(result) }; }).catch(error => envelope(error)).finally(() => { entry.done = true; });
      if (command.requestId) cache.set(command.requestId, entry);
      const result = await entry.promise;
      if (!result.ok) { try { onStatus(result.error.message); } catch {} }
      return clone(result);
    } catch (error) { return envelope(error); }
  }
  async function batch(commands) {
    try {
      if (!Array.isArray(commands) || !commands.length || commands.length > MAX_BATCH) fail('INVALID_COMMAND', 'Batch must contain 1–50 commands.');
      const normalized = jsonCopy(commands).map(normalize);
      if (JSON.stringify(normalized).length > MAX_COMMAND_BYTES) fail('INVALID_COMMAND', 'Batch exceeds the 3 MiB limit.');
      const initialScope = sessionScope(access(normalized[0])); const initialModel = getModel();
      const checkContext = command => {
        const current = access(command);
        if (getModel() !== initialModel || sessionScope(current) !== initialScope) fail('SESSION_CHANGED', 'The session changed before this batch completed.');
      };
      // Validate entity patches against current types before starting a batch.
      // Commands targeting objects created earlier in the batch are validated
      // again at execution, when the target exists.
      for (const command of normalized) {
        checkContext(command);
        if (command.action === 'canvas.update') { const entity = getModel().get(command.id); if (entity) fields(command.patch, { type: entity.type }); }
      }
      const results = [];
      for (const command of normalized) {
        checkContext(command);
        const result = await execute(command);
        // A batch belongs to the browser session where it began. Never let an
        // awaited snapshot/recording move later confidential edits to a new room.
        checkContext(command);
        if (!result.ok && CONTEXT_ERRORS.has(result.error.code)) return result;
        results.push(result);
      }
      return { ok: true, result: results };
    } catch (error) { return envelope(error); }
  }
  return Object.freeze({ version: VERSION, describe, state, execute, batch });
}
