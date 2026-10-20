// Discovery pages stay small enough for browser agents without cutting JSON or
// silently dropping text. Limits include the command API's success envelope.
export const DISCOVERY_LIMITS = Object.freeze({
  queryCharacters: 200, searchPage: 12, searchDefaultPage: 6,
  readPageCharacters: 2000, readDefaultCharacters: 1000,
  offset: 100000, responseCharacters: 6000,
});

const fits = result => JSON.stringify({ ok: true, result }).length < DISCOVERY_LIMITS.responseCharacters;
const textValue = value => typeof value === 'string' ? value : '';

function originalOffset(content, normalizedOffset) {
  // Lowercasing can expand a character (for example, İ). Translate the match
  // back to the original text so a preview still includes a deep match.
  if (content.length === content.toLowerCase().length) return normalizedOffset;
  let original = 0;
  let normalized = 0;
  for (const character of content) {
    if (normalized >= normalizedOffset) break;
    original += character.length;
    normalized += character.toLowerCase().length;
  }
  return original;
}

function searchableFields(entity) {
  return [textValue(entity.title), textValue(entity.text), entity.type === 'diagram' ? textValue(entity.source) : ''];
}

function snippet(fields, terms) {
  const candidates = [fields[1], fields[2], fields[0]].filter(Boolean);
  let content = candidates[0] || '';
  let match = -1;
  if (terms.length) {
    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();
      const positions = terms.map(term => lower.indexOf(term)).filter(position => position >= 0);
      if (positions.length) { content = candidate; match = originalOffset(candidate, Math.min(...positions)); break; }
    }
  }
  const start = Math.max(0, match - 32);
  const end = Math.min(content.length, start + 120);
  return `${start ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

function summary(entity, fields, terms, selectedId) {
  const bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number.isFinite(entity[key]) ? entity[key] : 0]));
  const title = textValue(entity.title).slice(0, 120);
  const preview = snippet(fields, terms);
  return {
    id: entity.id, type: entity.type,
    ...(title ? { title } : {}), ...(preview ? { snippet: preview } : {}),
    bounds, locked: !!entity.locked, selected: entity.id === selectedId,
  };
}

/** Input is validated by the command layer. all() supplies canonical layer order. */
export function searchCanvas(entities, selectedId, { query = '', types, selectedOnly = false, offset = 0, limit = DISCOVERY_LIMITS.searchDefaultPage } = {}) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = [];
  for (const entity of entities) {
    if ((types && !types.includes(entity.type)) || (selectedOnly && entity.id !== selectedId)) continue;
    // Browsing without a query need not lowercase every diagram on the board.
    const fields = terms.length ? searchableFields(entity) : null;
    const lower = fields?.map(field => field.toLowerCase());
    if (!terms.length || terms.every(term => lower.some(field => field.includes(term)))) matches.push({ entity, fields });
  }
  const result = { items: [], total: matches.length, offset, nextOffset: null };
  for (const match of matches.slice(offset, offset + limit)) {
    result.items.push(summary(match.entity, match.fields || searchableFields(match.entity), terms, selectedId));
    result.nextOffset = offset + result.items.length < result.total ? offset + result.items.length : null;
    if (!fits(result)) {
      result.items.pop();
      result.nextOffset = offset + result.items.length < result.total ? offset + result.items.length : null;
      break;
    }
  }
  return result;
}

/** Offsets and limits are JavaScript string (UTF-16) positions; returned text is exact. */
export function readCanvasContent(entity, { field = entity.type === 'diagram' ? 'source' : 'text', offset = 0, limit = DISCOVERY_LIMITS.readDefaultCharacters } = {}) {
  const content = textValue(entity[field]);
  const result = { id: entity.id, type: entity.type, field, text: '', total: content.length, offset, nextOffset: null };
  let low = 0;
  let high = Math.min(limit, Math.max(0, content.length - offset));
  // Escapes can make a short substring much larger than its character count.
  // Find a fitting prefix without changing any of its original text.
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    result.text = content.slice(offset, offset + length);
    result.nextOffset = offset + length < content.length ? offset + length : null;
    if (fits(result)) low = length;
    else high = length - 1;
  }
  result.text = content.slice(offset, offset + low);
  result.nextOffset = offset + low < content.length ? offset + low : null;
  return result;
}
