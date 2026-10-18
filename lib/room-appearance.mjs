/** Portable, bounded room styling. Values are data, never arbitrary CSS. */
export const ROOM_APPEARANCE_PRESETS = Object.freeze([
  { id: 'meadow', name: 'Meadow', accent: '#365d49', canvas: '#fbf8f0', pattern: 'dots' },
  { id: 'rose', name: 'Rose', accent: '#94566b', canvas: '#fbf3f3', pattern: 'dots' },
  { id: 'lagoon', name: 'Lagoon', accent: '#2c6975', canvas: '#f0f7f6', pattern: 'dots' },
  { id: 'lavender', name: 'Lavender', accent: '#735d91', canvas: '#f6f3fa', pattern: 'dots' },
].map(preset => Object.freeze(preset)));

const keys = new Set(['preset', 'accent', 'canvas', 'pattern']);
const fail = message => { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_ROOM_APPEARANCE' }); };

/** Missing appearance keeps legacy rooms in Meadow; missing fields use the preset. */
export function normalizeAppearance(value) {
  if (value === undefined || value === null) value = {};
  if (typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Choose a room style using a preset, colors, and a canvas pattern.');
  if (Object.keys(value).some(key => !keys.has(key))) fail('Room styles support only preset, accent, canvas, and pattern.');
  const preset = ROOM_APPEARANCE_PRESETS.find(item => item.id === (value.preset === undefined ? 'meadow' : value.preset));
  if (!preset) fail('Choose Meadow, Rose, Lagoon, or Lavender as the room preset.');
  const appearance = { preset: preset.id };
  for (const key of ['accent', 'canvas']) {
    const color = value[key] === undefined ? preset[key] : value[key];
    if (typeof color !== 'string' || color.length !== 7 || !/^#[0-9a-f]{6}$/i.test(color)) fail('Use six-digit hex colors, such as #365d49, for the accent and canvas.');
    appearance[key] = color.toLowerCase();
  }
  const pattern = value.pattern === undefined ? preset.pattern : value.pattern;
  if (!['dots', 'grid', 'plain'].includes(pattern)) fail('Choose dots, grid, or plain for the canvas pattern.');
  appearance.pattern = pattern;
  return appearance;
}

/** Old or damaged persisted metadata must never introduce CSS or break admission. */
export function restoreAppearance(value) {
  try { return normalizeAppearance(value); }
  catch { return normalizeAppearance(); }
}

/** Always return a detached canonical value, including for legacy room records. */
export function appearanceSnapshot(value) {
  return restoreAppearance(value);
}
