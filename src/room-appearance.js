import './room-appearance.css';
import { ROOM_APPEARANCE_PRESETS, restoreAppearance } from '../lib/room-appearance.mjs';

const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const rgb = color => [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16));
const hex = channels => `#${channels.map(channel => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('')}`;
const mix = (from, to, amount) => hex(rgb(from).map((channel, index) => channel + (rgb(to)[index] - channel) * amount));
const luminance = color => rgb(color).map(channel => { const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
const contrast = (one, two) => { const a = luminance(one), b = luminance(two); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
const readableOn = color => {
  const light = contrast(color, '#ffffff'), dark = contrast(color, '#202520');
  if (Math.max(light, dark) < 4.5) return contrast(color, '#000000') >= 4.5 ? '#000000' : '#ffffff';
  return light > dark ? '#ffffff' : '#202520';
};
function contrastColor(color, background, target = 4.5) {
  if (contrast(color, background) >= target) return color;
  const end = readableOn(background);
  for (let amount = .04; amount <= 1; amount += .04) {
    const candidate = mix(color, end, Math.min(1, amount));
    if (contrast(candidate, background) >= target) return candidate;
  }
  return end;
}

/** Keep room chrome light and readable, independently of the canvas colour. */
function palette(value) {
  const appearance = restoreAppearance(value);
  const paper = mix('#fbf8f0', appearance.accent, .035);
  const surface = mix('#fffef9', appearance.accent, .012);
  const ink = mix('#252b25', appearance.accent, .18);
  const sage = mix(paper, appearance.accent, .11);
  const sidebar = mix(paper, appearance.accent, .045);
  const hover = mix(paper, appearance.accent, .07);
  const darkestChrome = [paper, surface, sage, sidebar, hover].sort((a, b) => luminance(a) - luminance(b))[0];
  const muted = contrastColor(mix(ink, paper, .34), darkestChrome);
  const primaryOn = readableOn(appearance.accent);
  const accentInk = contrastColor(appearance.accent, darkestChrome);
  const canvasInk = readableOn(appearance.canvas);
  return {
    '--paper': paper,
    '--surface': surface,
    '--ink': ink,
    '--muted': muted,
    '--green': accentInk,
    '--border': mix(paper, ink, .16),
    '--sage': sage,
    '--room-accent': appearance.accent,
    '--room-accent-ink': accentInk,
    '--room-primary-on': primaryOn,
    '--room-primary-hover': mix(appearance.accent, primaryOn === '#ffffff' ? '#000000' : '#ffffff', .1),
    '--room-strong-border': contrastColor(appearance.accent, paper, 3),
    '--room-sidebar': sidebar,
    '--room-hover': hover,
    '--room-focus': contrastColor(appearance.accent, paper, 3),
    '--room-canvas': appearance.canvas,
    '--room-canvas-ink': canvasInk,
    '--room-canvas-focus': contrastColor(appearance.accent, appearance.canvas, 3),
    '--room-pattern-color': mix(appearance.canvas, canvasInk, .19),
    '--room-pattern': appearance.pattern,
  };
}

const inlinePalette = value => Object.entries(palette(value)).map(([key, color]) => `${key}:${color}`).join(';');
const sameAppearance = (one, two) => one.preset === two.preset && one.accent === two.accent && one.canvas === two.canvas && one.pattern === two.pattern;
const presetAppearance = preset => restoreAppearance({ preset: preset.id });
const pickerElement = container => container?.matches?.('[data-appearance-picker]') ? container : container?.querySelector?.('[data-appearance-picker]');

/** A form fragment. Preview changes are isolated from the room until its form is saved. */
export function renderAppearancePicker(value, { compact = false, disabled = false } = {}) {
  const appearance = restoreAppearance(value);
  const disabledAttribute = disabled ? ' disabled' : '';
  const content = `<section class="appearance-picker" data-appearance-picker data-preset="${escapeHTML(appearance.preset)}">
    <fieldset class="appearance-fields room-appearance-picker"${disabledAttribute}>
      <legend class="appearance-legend">Make a little room of your own</legend>
      <div class="appearance-presets" role="group" aria-label="Room colour themes">${ROOM_APPEARANCE_PRESETS.map(preset => {
        const selected = sameAppearance(appearance, presetAppearance(preset));
        return `<button type="button" class="appearance-preset" data-appearance-preset="${escapeHTML(preset.id)}" aria-pressed="${selected}"${disabledAttribute}><span class="appearance-swatch" aria-hidden="true" style="--swatch-accent:${preset.accent};--swatch-canvas:${preset.canvas}"><span></span></span><span>${escapeHTML(preset.name)}</span><span class="appearance-preset-check" aria-hidden="true">✓</span></button>`;
      }).join('')}</div>
      <div class="appearance-custom">
        <label class="appearance-colour-label"><span>Accent colour</span><span class="appearance-colour-control"><input type="color" data-appearance-accent aria-label="Accent colour" value="${appearance.accent}"${disabledAttribute}><code data-appearance-accent-value>${appearance.accent}</code></span></label>
        <label class="appearance-colour-label"><span>Canvas colour</span><span class="appearance-colour-control"><input type="color" data-appearance-canvas aria-label="Canvas colour" value="${appearance.canvas}"${disabledAttribute}><code data-appearance-canvas-value>${appearance.canvas}</code></span></label>
      </div>
      <label class="appearance-pattern-label"><span>Canvas pattern</span><select data-appearance-pattern aria-label="Canvas pattern"${disabledAttribute}>${[['dots', 'Little dots'], ['grid', 'Quiet grid'], ['plain', 'Plain canvas']].map(([pattern, label]) => `<option value="${pattern}"${appearance.pattern === pattern ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <div class="appearance-preview" data-appearance-preview data-room-pattern="${appearance.pattern}" style="${inlinePalette(appearance)}" role="img" aria-label="Room style preview"><div class="appearance-preview-bar"><span aria-hidden="true">✿</span><span>A room for good ideas</span><span class="appearance-preview-button">Let’s begin</span></div><div class="appearance-preview-canvas"><span class="appearance-preview-note">One small thought…</span><span class="appearance-preview-note appearance-preview-note-second">Room to grow.</span></div></div>
      <p class="appearance-canvas-note" data-appearance-canvas-note${contrast('#34483b', appearance.canvas) >= 4.5 ? ' hidden' : ''}>Dark canvases can hide dark text. Choose lighter text colours or adjust existing objects.</p>
      <div class="appearance-picker-bottom"><p class="appearance-help">A preview of the room. Notes, drawings, and images keep their own colours.</p><button type="button" class="appearance-reset" data-appearance-reset${disabledAttribute}>Reset to Meadow</button></div>
    </fieldset>
  </section>`;
  return compact ? `<details class="appearance-details"><summary><span aria-hidden="true">✿</span> Room style <span class="appearance-details-hint">Colours & canvas</span></summary>${content}</details>` : content;
}

/** Read only controls owned by this picker; it never reads arbitrary style strings. */
export function readAppearancePicker(container) {
  const picker = pickerElement(container);
  return restoreAppearance({
    preset: picker?.dataset.preset,
    accent: picker?.querySelector('[data-appearance-accent]')?.value,
    canvas: picker?.querySelector('[data-appearance-canvas]')?.value,
    pattern: picker?.querySelector('[data-appearance-pattern]')?.value,
  });
}

/** Update controls in place so focus and the native colour picker are preserved. */
export function bindAppearancePicker(container, { onChange = () => {} } = {}) {
  const picker = pickerElement(container);
  if (!picker) return () => {};
  let lastValue = readAppearancePicker(picker);
  function refresh(emit = true) {
    const appearance = readAppearancePicker(picker);
    const preview = picker.querySelector('[data-appearance-preview]');
    if (preview) {
      for (const [key, value] of Object.entries(palette(appearance))) preview.style.setProperty(key, value);
      preview.dataset.roomPattern = appearance.pattern;
    }
    for (const kind of ['accent', 'canvas']) {
      const label = picker.querySelector(`[data-appearance-${kind}-value]`);
      if (label) label.textContent = appearance[kind];
    }
    for (const button of picker.querySelectorAll('[data-appearance-preset]')) {
      const preset = ROOM_APPEARANCE_PRESETS.find(item => item.id === button.dataset.appearancePreset);
      button.setAttribute('aria-pressed', String(!!preset && sameAppearance(appearance, presetAppearance(preset))));
    }
    const canvasNote = picker.querySelector('[data-appearance-canvas-note]');
    if (canvasNote) canvasNote.hidden = contrast('#34483b', appearance.canvas) >= 4.5;
    const changed = !sameAppearance(lastValue, appearance);
    lastValue = appearance;
    if (emit && changed) onChange({ ...appearance });
  }
  function select(value) {
    const appearance = restoreAppearance(value);
    picker.dataset.preset = appearance.preset;
    picker.querySelector('[data-appearance-accent]').value = appearance.accent;
    picker.querySelector('[data-appearance-canvas]').value = appearance.canvas;
    picker.querySelector('[data-appearance-pattern]').value = appearance.pattern;
    refresh();
  }
  const click = event => {
    const button = event.target.closest?.('[data-appearance-preset], [data-appearance-reset]');
    if (!button || !picker.contains(button) || button.disabled || button.closest('fieldset')?.disabled) return;
    const id = button.hasAttribute('data-appearance-reset') ? 'meadow' : button.dataset.appearancePreset;
    const preset = ROOM_APPEARANCE_PRESETS.find(item => item.id === id);
    if (preset) select(presetAppearance(preset));
  };
  const change = event => {
    if (event.target.matches?.('[data-appearance-accent], [data-appearance-canvas], [data-appearance-pattern]')) refresh();
  };
  picker.addEventListener('click', click);
  picker.addEventListener('input', change);
  picker.addEventListener('change', change);
  refresh(false);
  return () => {
    picker.removeEventListener('click', click);
    picker.removeEventListener('input', change);
    picker.removeEventListener('change', change);
  };
}

/** Own just theme variables and attributes; unmount restores the host’s prior values. */
export class RoomAppearance {
  constructor({ root = document.documentElement } = {}) {
    this.root = root;
    this.previous = new Map();
    this.attributes = new Map(['data-room-appearance', 'data-room-pattern'].map(name => [name, root.getAttribute(name)]));
    this.destroyed = false;
  }
  apply(value) {
    const appearance = restoreAppearance(value);
    if (this.destroyed) return appearance;
    for (const [key, color] of Object.entries(palette(appearance))) {
      if (!this.previous.has(key)) this.previous.set(key, { value: this.root.style.getPropertyValue(key), priority: this.root.style.getPropertyPriority(key) });
      this.root.style.setProperty(key, color);
    }
    this.root.dataset.roomAppearance = appearance.preset;
    this.root.dataset.roomPattern = appearance.pattern;
    return appearance;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [key, previous] of this.previous) {
      if (previous.value) this.root.style.setProperty(key, previous.value, previous.priority);
      else this.root.style.removeProperty(key);
    }
    for (const [name, value] of this.attributes) {
      if (value === null) this.root.removeAttribute(name);
      else this.root.setAttribute(name, value);
    }
    this.previous.clear();
  }
}
