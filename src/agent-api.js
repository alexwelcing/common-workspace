import { DISCOVERY_LIMITS, searchCanvas, readCanvasContent } from './agent-discovery.js';

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
  'canvas.inspect': ['includeImageData'], 'canvas.search': ['query', 'types', 'selectedOnly', 'offset', 'limit'],
  'canvas.read': ['id', 'field', 'offset', 'limit'], 'canvas.add': ['entity'], 'canvas.update': ['id', 'patch'],
  'canvas.remove': ['id'], 'canvas.layer': ['id', 'position'], 'canvas.lock': ['id', 'locked'],
  'view.focus': ['id', 'bounds'], 'view.fit': [],
  'image.add': ['dataUrl', 'title', 'x', 'y', 'width', 'height'],
  'walkthrough.load': ['steps'], 'walkthrough.next': [], 'walkthrough.previous': [], 'walkthrough.stop': [],
  'capture.snapshot': ['download'], 'recording.start': ['source'], 'recording.stop': [],
  'recording.list': [], 'recording.download': ['id'], 'canvas.export': ['format', 'download'],
};
export const AGENT_CAPABILITIES = Object.freeze({
  inspect: Object.freeze({ title: 'Read the canvas', description: 'Read canvas text, images, positions, participants, and exports.' }),
  'canvas-write': Object.freeze({ title: 'Edit and present', description: 'Add, update, remove, and arrange canvas objects; control views and walkthroughs.' }),
  'media-capture': Object.freeze({ title: 'Capture canvas and shared windows', description: 'Take snapshots and capture an already approved shared window. Never opens the screen picker.' }),
  recording: Object.freeze({ title: 'Manage recordings', description: 'Start, stop, list, and download local clips. Starting also requires media capture.' }),
});
const ACTION_CAPABILITIES = Object.fromEntries(Object.keys(SCHEMAS).map(action => [action,
  action === 'recording.stop' ? ['recording'] : action === 'recording.start' ? ['inspect', 'media-capture', 'recording']
    : action.startsWith('recording.') ? ['inspect', 'recording'] : action === 'capture.snapshot' ? ['inspect', 'media-capture']
      : ['canvas.inspect', 'canvas.search', 'canvas.read', 'canvas.export'].includes(action) ? ['inspect'] : ['inspect', 'canvas-write'],
]));
const DEFAULT_GRANTS = ['inspect', 'canvas-write'];
const GRANT_TTL_MS = 15 * 60_000;
const MAX_GRANT_TTL_MS = 60 * 60_000;
const EDIT_ACTIONS = new Set(['canvas.add', 'canvas.update', 'canvas.remove', 'canvas.layer', 'canvas.lock', 'image.add']);
const CONTEXT_ERRORS = new Set(['SESSION_CHANGED', 'AGENT_DISABLED', 'DISCONNECTED', 'GRANT_EXPIRED', 'GRANT_REVOKED', 'PERMISSION_DENIED', 'ABORTED']);
const sessionScope = ctx => JSON.stringify([!!ctx.sandbox, ctx.room?.id ?? null, ctx.participantId ?? null]);
const SAFE_ERROR = Symbol('controlled-agent-error');
const fail = (code, message) => { const error = new Error(message); error.code = code; error[SAFE_ERROR] = true; throw error; };
const envelope = error => ({ ok: false, error: error?.[SAFE_ERROR]
  ? { code: error.code, message: error.message, ...(error.action ? { action: error.action, category: error.category } : {}) }
  : { code: 'FAILED', message: 'The command could not be completed.' } });
const clone = value => value === undefined ? null : structuredClone(value);

const SERVICE_MESSAGES = {
  CAPTURE_CLOSED: 'Capture tools have closed. Reload this canvas before capturing again.',
  CAPTURE_UNAVAILABLE: 'Open the canvas and wait for it to finish loading before capturing.',
  CAPTURE_UNSUPPORTED: 'Canvas capture is unavailable in this browser. Try a current desktop browser with canvas capture support.',
  CAPTURE_CANCELLED: 'Capture was cancelled because access, the canvas session, or the shared source changed. Check Agent tools permissions and try again.',
  CAPTURE_PERMISSION_DENIED: 'The browser blocked capture. Check browser and system screen-recording permissions, then share the window again.',
  CAPTURE_INVALID: 'Capture options are invalid. Use the documented capture command and choose a supported source.',
  RECORDING_BUSY: 'A recording is already running or starting. Stop it before starting another.',
  RECORDING_INVALID: 'Choose canvas or window as the recording source. Share a window first when recording a window.',
  RECORDING_UNSUPPORTED: 'This browser cannot record the selected source. Try a current desktop browser with MediaRecorder support.',
  RECORDING_LIMIT: 'Local recording storage is full. Download and discard a saved clip before starting another.',
  WINDOW_NOT_SHARED: 'Share a window using the Share a window button, then retry recording.start with source window.',
  RECORDING_FAILED: 'The browser could not start or finish the recording. Check that the shared source is still live and try again.',
  RECORDING_EMPTY: 'No video data was recorded. Keep the source visible and record for a little longer before stopping.',
  RECORDING_NOT_FOUND: 'That clip is no longer in this tab. Use recording.list and choose an available recording id.',
  WALKTHROUGH_INVALID: 'Use 1–50 walkthrough steps with a title and valid canvas targets or bounds.',
};

function controlledServiceError(error, action) {
  const category = action === 'canvas.export' ? 'export' : action.split('.')[0];
  let code = Object.hasOwn(SERVICE_MESSAGES, error?.code) ? error.code : null;
  if (!code) {
    if (['NotAllowedError', 'SecurityError'].includes(error?.name)) code = 'CAPTURE_PERMISSION_DENIED';
    else if (error?.name === 'NotSupportedError') code = category === 'recording' ? 'RECORDING_UNSUPPORTED' : 'CAPTURE_UNSUPPORTED';
    else if (error?.name === 'AbortError') code = 'CAPTURE_CANCELLED';
  }
  const safe = new Error(code ? SERVICE_MESSAGES[code] : `${action} could not complete in the ${category} service. Reload and try again. If it continues, report this action and category.`);
  safe.code = code || 'SERVICE_FAILED'; safe.action = action; safe.category = category; safe[SAFE_ERROR] = true;
  return safe;
}

/** Keep this controller in the trusted UI closure, never on window.commonAgent. */
export function createAgentPermissions({ getContext = () => ({}), getSession = () => null,
  onChange = () => {}, onRevoke = () => {}, now = () => Date.now(),
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: unschedule = globalThis.clearTimeout,
  setInterval: monitor = globalThis.setInterval, clearInterval: unmonitor = globalThis.clearInterval,
} = {}) {
  let grant = null; let revision = 0; let reason = 'not-granted'; let expiryTimer; let contextTimer; let destroyed = false; let refreshing = false;
  const listeners = new Set();
  const snapshot = () => ({ active: !!grant && !destroyed, capabilities: grant ? [...grant.capabilities] : [], expiresAt: grant?.expiresAt ?? null,
    remainingMs: grant ? Math.max(0, grant.expiresAt - now()) : 0, revision, reason,
    scope: grant ? clone(grant.scope) : null });
  const clearTimers = () => { unschedule?.(expiryTimer); unmonitor?.(contextTimer); expiryTimer = contextTimer = null; };
  const notify = () => { const state = snapshot(); try { onChange(state); } catch {} for (const listener of listeners) { try { listener(clone(state)); } catch {} } };
  function revoke(nextReason = 'revoked') {
    const existed = !!grant; grant = null; clearTimers(); reason = nextReason;
    if (existed) { revision++; notify(); try { onRevoke(nextReason, snapshot()); } catch {} }
    return snapshot();
  }
  function refresh() {
    if (destroyed || refreshing || !grant) return snapshot();
    refreshing = true;
    try {
      const ctx = getContext() || {};
      if (now() >= grant.expiresAt) return revoke('expired');
      if (!ctx.enabled) return revoke('disabled');
      if (!ctx.sandbox && !ctx.connected) return revoke('disconnected');
      if (sessionScope(ctx) !== grant.identity || getSession() !== grant.session) return revoke('session-changed');
      return snapshot();
    } finally { refreshing = false; }
  }
  function allow({ capabilities = DEFAULT_GRANTS, ttlMs = GRANT_TTL_MS } = {}) {
    if (destroyed) throw new Error('Agent permissions have been closed.');
    if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some(capability => !Object.hasOwn(AGENT_CAPABILITIES, capability))) throw new Error('Choose at least one supported agent permission.');
    if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > MAX_GRANT_TTL_MS) throw new Error('Choose a permission duration between one second and one hour.');
    const ctx = getContext() || {};
    if (!ctx.enabled || (!ctx.sandbox && !ctx.connected)) throw new Error('Open a personal canvas or connect to a session, then choose Allow selected access.');
    const selected = new Set(capabilities);
    if ([...selected].some(capability => capability !== 'inspect')) selected.add('inspect');
    const removed = grant && [...grant.capabilities].some(capability => !selected.has(capability));
    clearTimers(); revision++; reason = 'granted';
    grant = { capabilities: Object.keys(AGENT_CAPABILITIES).filter(capability => selected.has(capability)), expiresAt: now() + ttlMs,
      identity: sessionScope(ctx), session: getSession(), scope: { sandbox: !!ctx.sandbox, roomId: ctx.room?.id ?? null, participantId: ctx.participantId ?? null } };
    expiryTimer = schedule?.(() => refresh(), ttlMs + 1); expiryTimer?.unref?.();
    contextTimer = monitor?.(() => refresh(), 500); contextTimer?.unref?.();
    notify();
    if (removed) { try { onRevoke('permissions-reduced', snapshot()); } catch {} }
    return snapshot();
  }
  return Object.freeze({ grant: allow, revoke, state: refresh, refresh,
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('Permission listener must be a function.'); listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { if (destroyed) return; revoke('destroyed'); destroyed = true; listeners.clear(); clearTimers(); },
  });
}

/** The browser adapter and downloadable manifest consume this same registry. */
export function getAgentToolDefinitions() {
  const id = { type: 'string', minLength: 1, maxLength: 100 };
  const coordinate = { type: 'number', minimum: -100000, maximum: 100000 };
  const dimension = { type: 'number', exclusiveMinimum: 0, maximum: 10000 };
  const box = { type: 'object', additionalProperties: false, properties: { x: coordinate, y: coordinate, width: dimension, height: dimension }, required: ['x', 'y', 'width', 'height'] };
  const raster = { type: 'string', maxLength: IMAGE_LIMIT, pattern: '^data:image/(png|jpe?g|webp|gif|avif);base64,', description: 'An embedded base64 raster image. Remote URLs and SVG are rejected.' };
  const content = {
    x: coordinate, y: coordinate, width: dimension, height: dimension, text: { type: 'string', maxLength: 20000 },
    color: { type: 'string', maxLength: 100 }, fill: { type: 'string', maxLength: 100 }, fontSize: { type: 'number', minimum: 8, maximum: 200 },
    title: { type: 'string', maxLength: 200 }, language: { type: 'string', enum: ['mermaid', 'plantuml'] }, source: { type: 'string', maxLength: 20000 },
    url: raster, locked: { type: 'boolean' }, points: { type: 'array', maxItems: 10000, items: { type: 'object', additionalProperties: false, properties: { x: coordinate, y: coordinate }, required: ['x', 'y'] } },
  };
  const properties = {
    ...content, id, requestId: { ...id, description: 'Optional idempotency key within this permission grant and canvas session.' },
    includeImageData: { type: 'boolean', default: false },
    query: { type: 'string', maxLength: DISCOVERY_LIMITS.queryCharacters, description: 'Case-insensitive words matched across titles, text, and diagram source. Every word must match. Empty lists objects.' },
    types: { type: 'array', minItems: 1, maxItems: TYPES.size + 1, uniqueItems: true, items: { type: 'string', enum: [...TYPES, 'screen'] } },
    selectedOnly: { type: 'boolean', default: false, description: 'Limit results to the object selected in this browser.' },
    offset: { type: 'integer', minimum: 0, maximum: DISCOVERY_LIMITS.offset, default: 0, description: 'Continue with nextOffset from the previous response.' },
    field: { type: 'string', enum: ['text', 'source', 'title'], description: 'Exact content to read. Defaults to source for diagrams and text for other objects.' },
    entity: { type: 'object', additionalProperties: false, properties: { ...content, id, type: { type: 'string', enum: [...TYPES] } }, required: ['type'], description: 'Only supported canvas fields. Coordinates and sizes have defaults; images require url. Screen objects and ownership fields are managed by the app.' },
    patch: { type: 'object', minProperties: 1, additionalProperties: false, properties: content },
    position: { type: 'string', enum: ['front', 'back', 'forward', 'backward'] }, bounds: box, dataUrl: raster,
    steps: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, text: { type: 'string', maxLength: 5000 }, targetId: id, bounds: box }, required: ['title'], not: { required: ['targetId', 'bounds'] } } },
    download: { type: 'boolean', default: false }, format: { type: 'string', enum: ['svg', 'json'], default: 'svg' },
  };
  const required = { 'canvas.read': ['id'], 'canvas.add': ['entity'], 'canvas.update': ['id', 'patch'], 'canvas.remove': ['id'], 'canvas.layer': ['id', 'position'], 'canvas.lock': ['id', 'locked'], 'image.add': ['dataUrl'], 'walkthrough.load': ['steps'], 'recording.start': ['source'], 'recording.download': ['id'] };
  const descriptions = {
    'canvas.inspect': 'Read the complete current canvas, participants, and view. Use for full-state integration; choose canvas search to find objects with compact results.',
    'canvas.search': 'Find objects on the current canvas and return compact previews with reusable IDs. Use to discover relevant content or inspect the current selection before reading or editing.',
    'canvas.read': 'Read exact text from one canvas object in small pages. Use after canvas search when you need complete wording or diagram source for an explanation or edit.',
    'canvas.add': 'Add text, a note, a shape, a drawing, an embedded image, or a diagram to the shared canvas.',
    'canvas.update': 'Patch supported fields of one canvas object. Respects screen ownership and position locks.',
    'canvas.remove': 'Remove one editable object from the shared canvas.', 'canvas.layer': 'Move one editable object forward, backward, to the front, or to the back.',
    'canvas.lock': 'Lock or unlock an editable canvas object position.', 'view.focus': 'Focus this browser on a canvas object or explicit bounds.',
    'view.fit': 'Fit the shared canvas into this browser viewport.', 'image.add': 'Add a generated PNG, JPEG, WebP, GIF, or AVIF supplied as embedded base64 data.',
    'walkthrough.load': 'Load and start up to fifty inert walkthrough steps. Steps display text and focus objects; they never execute commands.',
    'walkthrough.next': 'Advance to the next walkthrough step.', 'walkthrough.previous': 'Return to the previous walkthrough step.', 'walkthrough.stop': 'Stop the current walkthrough.',
    'capture.snapshot': 'Capture canvas annotations and visible shared screens as PNG. Optional download. Never opens a native picker.',
    'recording.start': 'Start a bounded local recording of the canvas or an already user-approved shared window. Never opens a native picker.',
    'recording.stop': 'Stop the local recording.', 'recording.list': 'List locally retained recording metadata.', 'recording.download': 'Download one locally retained recording.',
    'canvas.export': 'Export canvas objects as SVG or JSON. Live screen streams are excluded. Optional download.',
  };
  return Object.keys(SCHEMAS).map(action => {
    const args = Object.fromEntries([...SCHEMAS[action], 'requestId'].map(key => [key,
      key === 'limit' ? { type: 'integer', minimum: 1, maximum: action === 'canvas.search' ? DISCOVERY_LIMITS.searchPage : DISCOVERY_LIMITS.readPageCharacters,
        default: action === 'canvas.search' ? DISCOVERY_LIMITS.searchDefaultPage : DISCOVERY_LIMITS.readDefaultCharacters,
        description: action === 'canvas.search' ? 'Maximum objects in this page. Responses may contain fewer to stay compact.' : 'Maximum UTF-16 characters in this page. Follow nextOffset if more remains.' }
        : action === 'recording.start' && key === 'source' ? { type: 'string', enum: ['canvas', 'window'] } : properties[key],
    ]));
    const inputSchema = { type: 'object', additionalProperties: false, properties: args, ...(required[action] ? { required: required[action] } : {}) };
    if (action === 'view.focus') inputSchema.oneOf = [{ required: ['id'], not: { required: ['bounds'] } }, { required: ['bounds'], not: { required: ['id'] } }];
    return clone({ name: `common_${action.replaceAll('.', '_')}`, action, description: descriptions[action], inputSchema,
      capabilities: ACTION_CAPABILITIES[action], annotations: { readOnlyHint: ['canvas.inspect', 'canvas.search', 'canvas.read', 'recording.list'].includes(action), untrustedContentHint: true, consequentialHint: false } });
  });
}

export function getAgentManifest() {
  return { version: VERSION, bridge: 'window.commonAgent', experimentalAdapter: 'WebMCP document.modelContext.registerTool',
    capabilities: clone(AGENT_CAPABILITIES), defaultCapabilities: [...DEFAULT_GRANTS], grantDurationMs: GRANT_TTL_MS, maxGrantDurationMs: MAX_GRANT_TTL_MS,
    tools: getAgentToolDefinitions() };
}

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
function pageInteger(value, maximum, label, minimum = 0) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail('INVALID_COMMAND', `${label} must be an integer between ${minimum} and ${maximum}.`);
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
  if (['canvas.read', 'canvas.update', 'canvas.remove', 'canvas.layer', 'canvas.lock', 'recording.download'].includes(action)) string(command.id, 100, 'Object id');
  if (action === 'canvas.inspect') boolean(command.includeImageData, 'Include image data');
  if (action === 'canvas.search' || action === 'canvas.read') {
    pageInteger(command.offset, DISCOVERY_LIMITS.offset, 'Page offset');
    pageInteger(command.limit, action === 'canvas.search' ? DISCOVERY_LIMITS.searchPage : DISCOVERY_LIMITS.readPageCharacters, 'Page limit', 1);
  }
  if (action === 'canvas.search') {
    string(command.query, DISCOVERY_LIMITS.queryCharacters, 'Search query', false);
    boolean(command.selectedOnly, 'Selected only');
    if (command.types !== undefined && (!Array.isArray(command.types) || !command.types.length || command.types.length > TYPES.size + 1
      || new Set(command.types).size !== command.types.length || command.types.some(type => !TYPES.has(type) && type !== 'screen'))) {
      fail('INVALID_COMMAND', 'Search types must be a nonempty list of unique canvas object types. Use describe() for supported types.');
    }
  }
  if (action === 'canvas.read' && command.field !== undefined && !['text', 'source', 'title'].includes(command.field)) {
    fail('INVALID_COMMAND', 'Read field must be text, source, or title. Omit it for the object’s default content.');
  }
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
export function createAgentAPI({ getBoard, getModel, getContext, recording, walkthrough, permissions, onStatus = () => {} }) {
  const cache = new Map(); let cacheScope; let cacheModel; let cacheGrantRevision; let legacyEnabled = false;
  const rawContext = () => getContext?.() || {};
  const grants = permissions || createAgentPermissions({ getContext: rawContext, getSession: getModel });
  const context = () => {
    const ctx = rawContext();
    // Compatibility for existing trusted embedders. New UI integrations pass a
    // private permissions controller and select explicit, time-limited scopes.
    if (!permissions) {
      if (ctx.enabled && !legacyEnabled && (ctx.sandbox || ctx.connected)) { legacyEnabled = true; grants.grant({ capabilities: Object.keys(AGENT_CAPABILITIES) }); }
      if (!ctx.enabled) legacyEnabled = false;
    }
    return ctx;
  };
  const active = ctx => !!ctx.enabled && (!!ctx.sandbox || !!ctx.connected);
  function access(command) {
    const ctx = context();
    if (!ctx.enabled) fail('AGENT_DISABLED', 'Open Agent tools, choose permissions, then select Allow selected access in this browser.');
    if (!ctx.sandbox && !ctx.connected) fail('DISCONNECTED', 'Reconnect to the session before using canvas commands.');
    const permission = grants.state();
    if (!permission.active) {
      const code = permission.reason === 'expired' ? 'GRANT_EXPIRED' : permission.reason === 'session-changed' ? 'SESSION_CHANGED' : 'GRANT_REVOKED';
      fail(code, 'Agent access has ended. Ask the user to grant access again in Agent tools.');
    }
    const missingCapabilities = ACTION_CAPABILITIES[command.action].filter(capability => !permission.capabilities.includes(capability));
    if (missingCapabilities.length) fail('PERMISSION_DENIED', `This command needs ${missingCapabilities.map(capability => AGENT_CAPABILITIES[capability].title).join(' and ')}. Ask the user to choose those permissions in Agent tools, then select Update access.`);
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
      const { streamId: _streamId, screenId: _screenId, ...safe } = entity;
      if (safe.type === 'image' && !includeImageData && safe.url) { safe.hasImageData = true; safe.imageDataLength = safe.url.length; delete safe.url; }
      return safe;
    });
  }
  function state({ includeImageData = false } = {}) {
    try {
      boolean(includeImageData, 'Include image data');
      const ctx = context(); const board = getBoard?.(); const permission = grants.state(); const permitted = active(ctx) && permission.active && permission.capabilities.includes('inspect');
      const output = { version: VERSION, enabled: !!ctx.enabled, sandbox: !!ctx.sandbox, connected: !!ctx.connected, ready: permitted && !!board && !!getModel?.(), readOnly: !!board?.readOnly, grants: permission };
      if (permitted) {
        output.room = ctx.room ? { id: ctx.room.id, name: ctx.room.name } : null;
        output.participantId = ctx.participantId ?? null;
        output.participants = (Array.isArray(ctx.participants) ? ctx.participants : []).map(person => Object.fromEntries(['id', 'name', 'color', 'isHost', 'sharing'].filter(key => ['string', 'boolean'].includes(typeof person?.[key])).map(key => [key, person[key]])));
        output.view = board?.getView?.() || null;
        output.entities = getModel?.() ? entities(includeImageData) : [];
        output.walkthrough = walkthrough?.state?.() || null;
        if (permission.capabilities.includes('recording')) output.recording = recording?.status?.() || null;
      }
      return clone(output);
    } catch (error) { return envelope(error); }
  }
  function describe() {
    return { version: VERSION, enabled: !!context().enabled, actions: clone(SCHEMAS), capabilities: clone(AGENT_CAPABILITIES), actionCapabilities: clone(ACTION_CAPABILITIES), grants: grants.state(), tools: getAgentToolDefinitions(), limits: { batch: MAX_BATCH, requestCache: 100, imageDataUrlCharacters: IMAGE_LIMIT, walkthroughSteps: 50, grantDurationMs: GRANT_TTL_MS, maxGrantDurationMs: MAX_GRANT_TTL_MS,
      searchQueryCharacters: DISCOVERY_LIMITS.queryCharacters, searchPage: DISCOVERY_LIMITS.searchPage,
      readPageCharacters: DISCOVERY_LIMITS.readPageCharacters, discoveryResponseCharacters: DISCOVERY_LIMITS.responseCharacters },
      command: '{action, requestId?, ...arguments}', examples: [{ action: 'canvas.add', entity: { type: 'text', text: 'Product walkthrough', x: 40, y: 40 } }, { action: 'view.focus', id: 'object-id' }],
      notes: ['Enable Agent tools in the local browser first.', 'Use requestId for idempotent retries in the same session.', 'Batch validates all command shapes first and runs sequentially; execution failures do not roll back earlier commands. Session changes, disabled Agent tools, or disconnection abort the remaining commands.', 'Window recording uses an existing user-approved screen share. Image generation happens in the agent; image.add imports its raster output.', 'Position locks prevent geometry edits. Screen objects are created by browser screen sharing.'] };
  }
  async function service(action, target, method, ...args) {
    if (typeof target?.[method] !== 'function') {
      const error = controlledServiceError(null, action); error.code = 'SERVICE_UNAVAILABLE';
      error.message = `${action} is unavailable in this browser. Reload or use a browser that supports this feature.`;
      throw error;
    }
    try { return (await target[method](...args)) ?? null; }
    catch (error) { throw controlledServiceError(error, action); }
  }
  function focus(target) {
    const board = getBoard(); const width = board.el?.clientWidth || 1000; const height = board.el?.clientHeight || 700;
    board.exitFocus?.({ restoreFocus: false });
    board.setZoom(Math.min(1.5, (width - 96) / target.width, (height - 96) / target.height));
    board.pan = { x: width / 2 - (target.x + target.width / 2) * board.zoom, y: height / 2 - (target.y + target.height / 2) * board.zoom };
    board.updateView(); return board.getView();
  }
  async function run(command, ctx, isAllowed) {
    const model = getModel(); const board = getBoard(); const action = command.action;
    if (action === 'canvas.inspect') return state({ includeImageData: command.includeImageData ?? false });
    if (action === 'canvas.search') return searchCanvas(model.all(), board.selectedId, command);
    if (action === 'canvas.read') {
      const entity = model.get(command.id);
      if (!entity) fail('NOT_FOUND', 'The canvas object was not found. Use canvas.search to find a current object id.');
      return readCanvasContent(entity, command);
    }
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
    if (action === 'view.fit') { board.exitFocus?.({ restoreFocus: false }); board.fit(); return board.getView(); }
    if (action.startsWith('walkthrough.')) return service(action, walkthrough, action.split('.')[1], ...(action === 'walkthrough.load' ? [command.steps] : []));
    if (action === 'capture.snapshot') return service(action, recording, 'snapshot', { download: command.download ?? false, isAllowed });
    if (action.startsWith('recording.')) {
      const method = action.split('.')[1];
      return service(action, recording, method, ...(method === 'start' ? [{ source: command.source, isAllowed }] : method === 'download' ? [command.id] : []));
    }
    if (action === 'canvas.export') {
      const format = command.format || 'svg'; const mimeType = format === 'svg' ? 'image/svg+xml' : 'application/json'; const filename = `common-canvas.${format}`;
      const data = format === 'svg' ? board.exportSvg() : JSON.stringify({ version: 1, entities: model.all().filter(entity => entity.type !== 'screen') }, null, 2);
      if (command.download) await service(action, recording, 'exportCanvas', data, { format, mimeType, filename, download: true });
      return { format, mimeType, filename, data };
    }
    fail('UNKNOWN_ACTION', 'Unsupported action.');
  }
  async function execute(input, { signal } = {}) {
    try {
      if (signal?.aborted) fail('ABORTED', 'The agent command was cancelled.');
      const command = normalize(input); const ctx = access(command); const initialModel = getModel(); const initialGrantRevision = grants.state().revision;
      const scope = sessionScope(ctx);
      if (scope !== cacheScope || cacheModel !== initialModel || cacheGrantRevision !== initialGrantRevision) { cache.clear(); cacheScope = scope; cacheModel = initialModel; cacheGrantRevision = initialGrantRevision; }
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
        if (signal?.aborted) fail('ABORTED', 'The agent command was cancelled.');
        const current = access(command);
        if (getModel() !== initialModel || scope !== sessionScope(current)) fail('SESSION_CHANGED', 'The session changed before this command completed.');
        if (grants.state().revision !== initialGrantRevision) fail('GRANT_REVOKED', 'Agent permissions changed before this command completed.');
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
  async function batch(commands, { signal } = {}) {
    try {
      if (!Array.isArray(commands) || !commands.length || commands.length > MAX_BATCH) fail('INVALID_COMMAND', 'Batch must contain 1–50 commands.');
      const normalized = jsonCopy(commands).map(normalize);
      if (JSON.stringify(normalized).length > MAX_COMMAND_BYTES) fail('INVALID_COMMAND', 'Batch exceeds the 3 MiB limit.');
      const initialScope = sessionScope(access(normalized[0])); const initialModel = getModel(); const initialGrantRevision = grants.state().revision;
      const checkContext = command => {
        if (signal?.aborted) fail('ABORTED', 'The agent batch was cancelled.');
        const current = access(command);
        if (getModel() !== initialModel || sessionScope(current) !== initialScope) fail('SESSION_CHANGED', 'The session changed before this batch completed.');
        if (grants.state().revision !== initialGrantRevision) fail('GRANT_REVOKED', 'Agent permissions changed before this batch completed.');
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
        const result = await execute(command, { signal });
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
