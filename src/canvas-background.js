const DEFAULT_BACKGROUND = { color: '#fbf8f0', patternColor: '#d1d0c8', pattern: 'dots' };
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Read only the room's controlled appearance tokens, never arbitrary CSS or URLs. */
export function canvasBackground(element) {
  const fallback = { ...DEFAULT_BACKGROUND };
  const owner = element?.ownerDocument?.defaultView;
  if (!owner?.getComputedStyle) return fallback;
  try {
    const style = owner.getComputedStyle(element);
    const color = style.getPropertyValue('--room-canvas').trim();
    const patternColor = style.getPropertyValue('--room-pattern-color').trim();
    const pattern = style.getPropertyValue('--room-pattern').trim();
    return {
      color: HEX_COLOR.test(color) ? color : fallback.color,
      patternColor: HEX_COLOR.test(patternColor) ? patternColor : fallback.patternColor,
      pattern: ['dots', 'grid', 'plain'].includes(pattern) ? pattern : fallback.pattern,
    };
  } catch { return fallback; }
}
