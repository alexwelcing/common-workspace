import DOMPurify from 'dompurify';
import { deflateRaw } from 'pako';

const MAX_SOURCE_LENGTH = 20_000;
let mermaidPromise;
let renderQueue = Promise.resolve();
let renderSequence = 0;

function checkedSource(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Enter diagram source first.');
  if (source.length > MAX_SOURCE_LENGTH) throw new Error('Diagram source must be 20,000 characters or fewer.');
  return source;
}

async function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        maxTextSize: MAX_SOURCE_LENGTH,
        maxEdges: 300,
        theme: 'neutral',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/** Mermaid renders locally. Only sanitized SVG may be inserted in the board. */
export async function renderMermaid(source) {
  const text = checkedSource(source);
  // Mermaid uses a shared DOM renderer, so simultaneous edits are serialized.
  const render = renderQueue.then(async () => {
    const mermaid = await getMermaid();
    const { svg } = await mermaid.render(`common-diagram-${++renderSequence}`, text);
    return DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['script', 'foreignObject'],
    });
  });
  renderQueue = render.catch(() => undefined);
  return render;
}

/**
 * This URL sends the complete diagram source to the public PlantUML service.
 * The UI MUST obtain explicit consent before assigning it to an image or fetch.
 * Calling this encoder alone does not make a network request.
 */
export function plantUmlUrl(source) {
  const text = checkedSource(source);
  if (/!(?:include[a-z_]*|import)\b/i.test(text) ||
      /%(?:load_json|load_yaml|load_csv|file_exists|getenv)\s*\(/i.test(text)) {
    throw new Error('PlantUML remote includes, imports, and external data loading are disabled.');
  }
  const compressed = deflateRaw(new TextEncoder().encode(text), { level: 9 });
  // PlantUML uses standard Base64 bit packing with its own URL-safe alphabet.
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  let encoded = '';
  for (let index = 0; index < compressed.length; index += 3) {
    const a = compressed[index];
    const b = compressed[index + 1] ?? 0;
    const c = compressed[index + 2] ?? 0;
    encoded += alphabet[a >> 2];
    encoded += alphabet[((a & 3) << 4) | (b >> 4)];
    encoded += alphabet[((b & 15) << 2) | (c >> 6)];
    encoded += alphabet[c & 63];
  }
  return `https://www.plantuml.com/plantuml/svg/${encoded}`;
}
