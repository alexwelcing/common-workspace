// Images stay embedded in the canvas: never fetch pasted URLs or import SVG/HTML.
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
export const MAX_IMAGE_BATCH = 5;
const IMAGE_EDGE = 1600;
const MAX_IMAGE_URL = Math.floor(1.3 * 1024 * 1024 * 4 / 3);

function aborted(signal) {
  if (signal?.aborted) throw new DOMException('Image import was cancelled.', 'AbortError');
}

function readImage(file, signal) {
  return new Promise((resolve, reject) => {
    aborted(signal);
    const reader = new FileReader(); let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true;
      signal?.removeEventListener('abort', cancel);
      reader.onload = reader.onerror = reader.onabort = null;
      if (error) reject(error); else resolve(result);
    };
    const cancel = () => { reader.abort(); finish(new DOMException('Image import was cancelled.', 'AbortError')); };
    reader.onload = () => finish(null, reader.result);
    reader.onerror = () => finish(new Error('This image could not be opened. Choose it again to retry.'));
    reader.onabort = () => finish(new DOMException('Image import was cancelled.', 'AbortError'));
    signal?.addEventListener('abort', cancel, { once: true });
    try { reader.readAsDataURL(file); }
    catch { finish(new Error('This image could not be opened. Choose it again to retry.')); }
  });
}

async function validateImageBytes(file, signal) {
  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  aborted(signal);
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  const valid = file.type === 'image/png' ? bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
    : file.type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : file.type === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
        : file.type === 'image/webp' ? ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP'
          : ascii(4, 4) === 'ftyp' && Array.from({ length: Math.max(0, Math.floor((bytes.length - 8) / 4)) }, (_, index) => ascii(8 + index * 4, 4)).some(brand => brand === 'avif' || brand === 'avis');
  if (!valid) throw new Error('This file is not a supported raster image. Export it as PNG, JPEG, WebP, GIF, or AVIF and try again.');
}

function decodeImage(url, signal) {
  return new Promise((resolve, reject) => {
    aborted(signal);
    const image = new Image();
    const finish = (error) => {
      signal?.removeEventListener('abort', cancel);
      image.onload = image.onerror = null;
      if (error) { image.src = ''; reject(error); } else resolve(image);
    };
    const cancel = () => finish(new DOMException('Image import was cancelled.', 'AbortError'));
    image.onload = () => finish();
    image.onerror = () => finish(new Error('This image could not be decoded. Try a different image.'));
    signal?.addEventListener('abort', cancel, { once: true });
    image.src = url;
  });
}

function compactImage(file, image, url) {
  // Re-encoding would drop the frames of an animated GIF.
  if (file.type === 'image/gif' || (file.size <= 256 * 1024 && Math.max(image.naturalWidth, image.naturalHeight) <= IMAGE_EDGE)) return url;
  const scale = Math.min(1, IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext?.('2d');
  if (!context) return url;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  // Browsers that cannot encode WebP fall back to PNG, which is rarely smaller.
  const encoded = canvas.toDataURL('image/webp', .85);
  return encoded.startsWith('data:image/webp;') && encoded.length < url.length ? encoded : url;
}

/** Read and prepare a local raster image without changing the current canvas. */
export async function prepareImage(file, { signal } = {}) {
  aborted(signal);
  if (!file || !IMAGE_TYPES.has(file.type)) throw new Error('Choose a PNG, JPEG, WebP, GIF, or AVIF image.');
  if (file.size > (file.type === 'image/gif' ? 1.3 : 20) * 1024 * 1024) throw new Error(file.type === 'image/gif' ? 'Choose a GIF smaller than 1.3 MB.' : 'Choose an image smaller than 20 MB.');
  await validateImageBytes(file, signal);
  const url = await readImage(file, signal);
  const image = await decodeImage(url, signal);
  try {
    aborted(signal);
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('This image has no usable dimensions. Try a different image.');
    const compact = compactImage(file, image, url);
    if (compact.length > MAX_IMAGE_URL) throw new Error('This image is still larger than 1.3 MB after resizing. Try a smaller one.');
    const scale = Math.min(1, 460 / image.naturalWidth, 460 / image.naturalHeight);
    return { url: compact, width: image.naturalWidth * scale, height: image.naturalHeight * scale, title: String(file.name || 'Pasted image').slice(0, 200) };
  } finally { image.src = ''; }
}

/** Take only image-only clipboard payloads, leaving text and HTML paste alone. */
export function clipboardImages(data) {
  if (!data || Array.from(data.types || []).some(type => /^text\//i.test(type))) return [];
  const files = Array.from(data.files || []);
  if (files.length) return files.filter(file => IMAGE_TYPES.has(file.type));
  return Array.from(data.items || []).filter(item => item.kind === 'file' && IMAGE_TYPES.has(item.type)).map(item => item.getAsFile()).filter(Boolean);
}
