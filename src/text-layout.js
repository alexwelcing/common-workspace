const FONT_FAMILY = '"DM Sans", system-ui, sans-serif';
const MAX_TEXT_LENGTH = 20_000;
const MAX_LAYOUT_ENTRIES = 128;
const MAX_MEASURE_ENTRIES = 512;
const MAX_CACHE_UNITS = 256_000;
const MAX_MEASURE_UNITS = 8_192;
const SEARCH_STEPS = 24;
const SHAPE_TYPES = new Set(['rectangle', 'ellipse']);
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positive = (value, fallback) => Math.max(0, finite(value, fallback));
const mark = /\p{Mark}/u;
const breakAfter = /[\s\-‐–/\u200b]/u;
const eastAsian = /[\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff01-\uff60]/u;

function fallbackGraphemes(text) {
  const result = [];
  let joinNext = false, regionalCount = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    const regional = code >= 0x1f1e6 && code <= 0x1f1ff;
    const attached = mark.test(character) || code === 0xfe0f || code === 0xfe0e
      || code === 0x200d || (code >= 0x1f3fb && code <= 0x1f3ff);
    if (result.length && (attached || joinNext || (regional && regionalCount % 2 === 1))) result[result.length - 1] += character;
    else result.push(character);
    joinNext = code === 0x200d;
    regionalCount = regional ? regionalCount + 1 : 0;
  }
  return result;
}

function segmentParagraph(text, graphemeSegmenter, wordSegmenter) {
  const offsets = [0];
  if (graphemeSegmenter) {
    for (const { index, segment } of graphemeSegmenter.segment(text)) offsets.push(index + segment.length);
  } else {
    let offset = 0;
    for (const segment of fallbackGraphemes(text)) { offset += segment.length; offsets.push(offset); }
  }
  const breaks = [];
  if (wordSegmenter) {
    const boundaries = new Map(offsets.map((offset, index) => [offset, index]));
    for (const { index, segment } of wordSegmenter.segment(text)) {
      const boundary = boundaries.get(index + segment.length);
      if (boundary !== undefined) breaks.push(boundary);
    }
  } else {
    for (let index = 1; index < offsets.length; index++) {
      const segment = text.slice(offsets[index - 1], offsets[index]);
      if (breakAfter.test(segment) || eastAsian.test(segment)) breaks.push(index);
    }
  }
  return { text, offsets, breaks };
}

function previousBreak(breaks, maximum, minimum) {
  let low = 0, high = breaks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (breaks[middle] <= maximum) low = middle + 1;
    else high = middle;
  }
  const boundary = breaks[low - 1];
  return boundary > minimum ? boundary : maximum;
}

function fontString(weight, size) {
  // Avoid exponent notation at the tiny sizes needed for valid, very long text.
  const pixels = size.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') || '0';
  return `${weight} ${pixels}px ${FONT_FAMILY}`;
}

function boxFor(entity) {
  const width = positive(entity.width, 300), height = positive(entity.height, 86);
  const shape = SHAPE_TYPES.has(entity.type);
  const insetX = entity.type === 'sticky' ? 22 : shape ? 10 : 4;
  const insetY = entity.type === 'sticky' ? 23 : shape ? 10 : 5;
  let x = Math.min(insetX, width * 0.2), y = Math.min(insetY, height * 0.2);
  if (entity.type === 'ellipse') {
    // Corners of this centered rectangle stay inside the ellipse's stroke.
    const curveInset = (1 - Math.SQRT1_2) / 2;
    x = Math.max(x, width * curveInset + Math.min(2, width * 0.02));
    y = Math.max(y, height * curveInset + Math.min(2, height * 0.02));
  }
  return Object.freeze({ x, y, width: Math.max(0, width - x * 2), height: Math.max(0, height - y * 2) });
}

/**
 * One bounded, consumer-owned text layout cache. Dimensions are canvas/world
 * units; zoom never affects fitting. DOM, SVG, previews, and capture use the same
 * explicit lines. Persist the original text, never these display-only soft wraps.
 */
export function createTextLayout({ documentImpl = globalThis.document, context = null, maxEntries = MAX_LAYOUT_ENTRIES } = {}) {
  const capacity = Math.max(1, Math.min(MAX_LAYOUT_ENTRIES, Math.floor(finite(maxEntries, MAX_LAYOUT_ENTRIES))));
  const cache = new Map(), subscribers = new Set();
  const fonts = documentImpl?.fonts;
  let measuringContext = context, revision = 0, destroyed = false, cacheUnits = 0;
  let graphemeSegmenter, wordSegmenter;
  try {
    graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });
  } catch { /* Older embedders retain code-point/combining-mark wrapping. */ }

  function invalidateFonts() {
    if (destroyed) return;
    cache.clear(); cacheUnits = 0; revision++;
    for (const subscriber of Array.from(subscribers)) {
      try { subscriber(revision); } catch { /* A consumer owns its rendering. */ }
    }
  }
  fonts?.addEventListener?.('loadingdone', invalidateFonts);
  fonts?.addEventListener?.('loadingerror', invalidateFonts);

  function getContext() {
    if (measuringContext) return measuringContext;
    try { measuringContext = documentImpl?.createElement?.('canvas')?.getContext?.('2d') || null; }
    catch { /* A non-rendering embedder can still inspect a conservative layout. */ }
    return measuringContext;
  }

  function measureLayout(entity, text, box, fontReady) {
    const shape = SHAPE_TYPES.has(entity.type);
    const fontWeight = entity.type === 'sticky' ? 450 : shape ? 400 : 500;
    const ratio = entity.type === 'sticky' ? 1.48 : shape ? 1.4 : 1.45;
    const align = shape ? 'center' : 'left';
    const renderFontSize = 64;
    const renderFont = fontString(fontWeight, renderFontSize);
    const paragraphs = text.split('\n').map(paragraph => segmentParagraph(paragraph, graphemeSegmenter, wordSegmenter));
    const ctx = getContext();
    const previous = ctx ? { font: ctx.font, textBaseline: ctx.textBaseline, textAlign: ctx.textAlign, letterSpacing: ctx.letterSpacing, fontKerning: ctx.fontKerning } : null;
    let saved = false;
    try {
      if (ctx?.save && ctx?.restore) { ctx.save(); saved = true; }
      if (ctx) {
        ctx.font = renderFont; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
        if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
      }
      // Shape at a stable reference size and scale the result in every renderer.
      // Native tiny font metrics can otherwise retain a one-pixel ink floor.
      const measured = new Map();
      let measuredUnits = 0;
      function metricsFor(value) {
        if (measured.has(value)) return measured.get(value);
        const raw = ctx?.measureText?.(value);
        const width = raw ? positive(raw.width, 0)
          : Array.from(value).reduce((sum, character) => sum + (character.codePointAt(0) > 0xff ? 1 : 0.6), 0) * renderFontSize;
        const result = {
          width,
          ascent: positive(raw?.actualBoundingBoxAscent, renderFontSize * 0.8),
          descent: positive(raw?.actualBoundingBoxDescent, renderFontSize * 0.2),
          left: finite(raw?.actualBoundingBoxLeft, 0),
          right: finite(raw?.actualBoundingBoxRight, width),
          fontAscent: positive(raw?.fontBoundingBoxAscent, renderFontSize * 0.8),
          fontDescent: positive(raw?.fontBoundingBoxDescent, renderFontSize * 0.2),
        };
        if (value.length <= MAX_MEASURE_UNITS) {
          while (measured.size >= MAX_MEASURE_ENTRIES || measuredUnits + value.length > MAX_MEASURE_UNITS) {
            const oldest = measured.keys().next().value;
            measuredUnits -= oldest.length; measured.delete(oldest);
          }
          measured.set(value, result); measuredUnits += value.length;
        }
        return result;
      }
      const primary = metricsFor('Mg');
      // A small reference-space inset covers raster/CSS metric rounding. It
      // scales with the text, so even subpixel boxes keep their full contents.
      const inkGuard = 2;
      let ascent = primary.fontAscent + inkGuard, descent = primary.fontDescent + inkGuard;
      let overhangLeft = inkGuard, overhangRight = inkGuard;
      function includeInk(metrics) {
        const nextAscent = Math.max(ascent, metrics.ascent + inkGuard, metrics.fontAscent + inkGuard);
        const nextDescent = Math.max(descent, metrics.descent + inkGuard, metrics.fontDescent + inkGuard);
        const nextLeft = Math.max(overhangLeft, metrics.left + inkGuard);
        const nextRight = Math.max(overhangRight, metrics.right - metrics.width + inkGuard);
        const changed = nextAscent > ascent || nextDescent > descent || nextLeft > overhangLeft || nextRight > overhangRight;
        ascent = nextAscent; descent = nextDescent;
        overhangLeft = nextLeft; overhangRight = nextRight;
        return changed;
      }
      // Paragraph ink covers contextual shaping; graphemes cover the edges that
      // may become soft-wrap boundaries. Stacked accents and fallback glyphs
      // must contribute actual ink, not just the primary font's Mg metrics.
      const seen = new Set();
      for (const paragraph of paragraphs) {
        if (paragraph.text) includeInk(metricsFor(paragraph.text));
        for (let index = 1; index < paragraph.offsets.length; index++) {
          const grapheme = paragraph.text.slice(paragraph.offsets[index - 1], paragraph.offsets[index]);
          if (seen.has(grapheme)) continue;
          seen.add(grapheme); includeInk(metricsFor(grapheme));
        }
      }
      const referenceHeight = () => Math.max(renderFontSize * ratio, ascent + descent);

      function candidate(scale, includeLines = false) {
        if (!(scale > 0)) return { fits: false };
        // Contextual shaping at a new line edge can increase an overhang. Retry
        // with the expanded ink envelope before accepting that candidate.
        for (let attempt = 0; attempt < 4; attempt++) {
          const renderLineHeight = referenceHeight();
          const lineLimit = Math.floor((box.height + 1e-10) / (renderLineHeight * scale));
          const width = box.width / scale - overhangLeft - overhangRight;
          if (lineLimit < paragraphs.length || width <= 0) return { fits: false };
          const lines = [], widths = [];
          let count = 0, expanded = false;
          function append(value) {
            count++;
            if (count > lineLimit) return false;
            const metrics = metricsFor(value);
            expanded = includeInk(metrics) || expanded;
            if (includeLines) { lines.push(value); widths.push(metrics.width * scale); }
            return true;
          }
          for (const paragraph of paragraphs) {
            const { offsets, breaks } = paragraph;
            const length = offsets.length - 1;
            if (!length) { if (!append('')) return { fits: false }; continue; }
            let start = 0;
            while (start < length) {
              const slice = end => paragraph.text.slice(offsets[start], offsets[end]);
              // Exponential search bounds shaped prefixes to one line; unlike
              // a growing character-by-character prefix it is not quadratic.
              let lower = start, upper = Math.min(length, start + 1);
              if (metricsFor(slice(upper)).width > width) return { fits: false };
              lower = upper;
              let span = 2;
              while (lower < length) {
                upper = Math.min(length, start + span);
                if (metricsFor(slice(upper)).width > width) break;
                lower = upper; span *= 2;
              }
              if (lower < length) {
                while (upper - lower > 1) {
                  const middle = (lower + upper) >>> 1;
                  if (metricsFor(slice(middle)).width <= width) lower = middle;
                  else upper = middle;
                }
              }
              const end = lower === length ? length : previousBreak(breaks, lower, start);
              if (!append(slice(end))) return { fits: false };
              start = end;
            }
          }
          if (!expanded) return { fits: true, scale, renderLineHeight, lines, widths, count };
        }
        return { fits: false };
      }

      function fitBelow(ceiling) {
        if (!(ceiling > 0 && box.width > 0)) return 0;
        let upper = ceiling;
        if (candidate(upper).fits) return upper;
        let lower = upper / 2;
        // Establish an actual positive fit before refining. A single enormous
        // grapheme can need a scale below a fixed search's initial resolution.
        while (lower > 0 && !candidate(lower).fits) { upper = lower; lower /= 2; }
        for (let step = 0; step < SEARCH_STEPS && lower > 0; step++) {
          const middle = (lower + upper) / 2;
          if (candidate(middle).fits) lower = middle;
          else upper = middle;
        }
        return lower;
      }
      let lower = fitBelow(box.height > 0 ? box.height / Math.max(1, paragraphs.length) / referenceHeight() : 0);
      // No legacy fontSize cap or minimum may discard valid text. The positive
      // box always has a positive scale, even with 20k explicit blank lines.
      let result = candidate(lower, true);
      if (!result.fits && lower > 0) {
        lower = fitBelow(lower);
        result = candidate(lower, true);
      }
      const renderScale = lower;
      const fontSize = renderFontSize * renderScale;
      const renderLineHeight = result.renderLineHeight || referenceHeight();
      const lineHeight = renderLineHeight * renderScale;
      const lines = result.lines || text.split('\n');
      const widths = result.widths || lines.map(() => 0);
      const textHeight = lines.length * lineHeight;
      const y = box.y + (shape ? Math.max(0, (box.height - textHeight) / 2) : 0);
      const baselineOffset = (renderLineHeight - ascent - descent) / 2 + ascent;
      const cssBaselineOffset = (renderLineHeight - primary.fontAscent - primary.fontDescent) / 2 + primary.fontAscent;
      const baseline = y + baselineOffset * renderScale;
      const domY = y + (baselineOffset - cssBaselineOffset) * renderScale;
      const contentBox = Object.freeze({
        x: box.x + overhangLeft * renderScale, y,
        width: Math.max(0, box.width - (overhangLeft + overhangRight) * renderScale),
        height: box.height,
      });
      const x = contentBox.x + (shape ? contentBox.width / 2 : 0);
      const widestLine = widths.reduce((maximum, width) => Math.max(maximum, width), 0);
      // Using the whole box divided by a tiny scale can exceed CSS layout's
      // width limit. Center a block bounded by actual text width instead.
      const domWidth = renderScale > 0 ? widestLine / renderScale : 0;
      const domX = x - (shape ? widestLine / 2 : 0);
      return Object.freeze({
        text, fontSize, fontFamily: FONT_FAMILY, fontWeight, letterSpacing: 0,
        fontOpticalSizing: 'none', font: fontString(fontWeight, fontSize),
        renderFontSize, renderFont, renderScale, renderLineHeight, domX, domY, domWidth, contentBox,
        lineHeight, lineHeightRatio: renderLineHeight / renderFontSize,
        lines: Object.freeze(lines), widths: Object.freeze(widths), box, textHeight,
        x, y, baseline,
        align, verticalAlign: shape ? 'middle' : 'top', fontReady, measured: Boolean(ctx?.measureText),
      });
    } finally {
      if (saved) ctx.restore();
      else if (ctx) for (const [key, value] of Object.entries(previous)) if (value !== undefined) ctx[key] = value;
    }
  }

  return {
    layout(entity = {}) {
      if (destroyed) throw new Error('Text layout has been closed.');
      const raw = typeof entity.text === 'string' ? entity.text : '';
      if (raw.length > MAX_TEXT_LENGTH) throw new RangeError('Canvas text must be at most 20,000 characters.');
      const text = raw.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/\t/g, '    ');
      const box = boxFor(entity);
      let fontReady = true;
      try { fontReady = !fonts?.check || fonts.check(`500 16px ${FONT_FAMILY}`); } catch { fontReady = false; }
      const key = JSON.stringify([entity.type, text, box.x, box.y, box.width, box.height, fontReady, revision]);
      if (cache.has(key)) {
        const entry = cache.get(key); cache.delete(key); cache.set(key, entry); return entry.result;
      }
      const result = measureLayout(entity, text, box, fontReady);
      // Bound retained text and line-array slots as well as entry count: a room
      // of maximum-length notes must not keep 128 full copies of their layouts.
      const units = key.length + text.length + result.lines.length * 8;
      if (units <= MAX_CACHE_UNITS) {
        while (cache.size >= capacity || cacheUnits + units > MAX_CACHE_UNITS) {
          const oldest = cache.keys().next().value;
          cacheUnits -= cache.get(oldest).units; cache.delete(oldest);
        }
        cache.set(key, { result, units }); cacheUnits += units;
      }
      return result;
    },
    get revision() { return revision; },
    subscribe(listener) {
      if (destroyed || typeof listener !== 'function') return () => {};
      subscribers.add(listener); return () => subscribers.delete(listener);
    },
    clear() { cache.clear(); cacheUnits = 0; },
    destroy() {
      if (destroyed) return;
      destroyed = true; cache.clear(); cacheUnits = 0; subscribers.clear();
      fonts?.removeEventListener?.('loadingdone', invalidateFonts);
      fonts?.removeEventListener?.('loadingerror', invalidateFonts);
      measuringContext = null;
    },
  };
}
