// A replay contains the engine's operation history, not rendered video frames.
// Documents stay binary here; schema 1 JSON remains readable for older exports.
// Schema 2 layout: 8-byte magic, little-endian u32 metadata length, JSON
// metadata, then concatenated document bytes (optionally compressed as one gzip).
const FORMAT = 'common-spatial-archive';
const MAGIC = new TextEncoder().encode('CSPACE02');
const HEADER_BYTES = MAGIC.length + 4;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_DOCUMENTS = 65;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const own = (object, key) => Object.hasOwn(object, key);
// Imports accept plain data records only: no extra keys or accessor properties.
const objectWithKeys = (value, allowed, required = allowed) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => allowed.includes(key) && own(Object.getOwnPropertyDescriptor(value, key), 'value'))
  && required.every(key => own(value, key));
const documentId = value => value === 'manifest' || (typeof value === 'string' && /^board:[A-Za-z0-9_-]{1,100}$/.test(value));
const invalid = message => new Error(message || 'This is not a supported Common replay archive.');

function inputBytes(value) {
  const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
  if (!bytes || bytes.byteLength > MAX_ARCHIVE_BYTES) throw invalid('Choose a Common archive smaller than 64 MiB.');
  return bytes;
}

function parseJson(bytes) {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw invalid('The replay archive contains invalid JSON or text.');
  }
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw invalid('A replay document contains invalid or oversized binary data.');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const length = value.length / 4 * 3 - padding;
  if (length > MAX_DOCUMENT_BYTES) throw invalid('A replay document exceeds the 12 MiB limit.');
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw invalid('A replay document contains invalid binary data.');
  }
  if (binary.length !== length) throw invalid('A replay document has an invalid binary length.');
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function validateDocuments(documents, readDocument) {
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > MAX_DOCUMENTS) {
    throw invalid('A replay must contain a manifest and at most 64 board documents.');
  }
  const seen = new Set();
  let total = 0;
  const result = Array.from(documents, document => {
    const item = readDocument(document);
    if (!document || !own(document, 'id') || !documentId(document.id) || seen.has(document.id)) {
      throw invalid('The replay archive contains an invalid or repeated document.');
    }
    seen.add(document.id);
    const length = item.byteLength;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DOCUMENT_BYTES) {
      throw invalid('A replay document has an invalid size or exceeds 12 MiB.');
    }
    total += length;
    if (total > MAX_ARCHIVE_BYTES) throw invalid('The replay history exceeds the 64 MiB limit.');
    return { id: document.id, ...item };
  });
  if (!seen.has('manifest')) throw invalid('The replay archive has no room manifest.');
  return { documents: result, total };
}

function legacyArchive(bytes) {
  const value = parseJson(bytes);
  if (!objectWithKeys(value, ['format', 'version', 'exportedAt', 'documents'], ['format', 'version', 'documents'])
    || value.format !== FORMAT || value.version !== 1
    || (own(value, 'exportedAt') && (typeof value.exportedAt !== 'string' || value.exportedAt.length > 100))) {
    throw invalid();
  }
  const { documents } = validateDocuments(value.documents, document => {
    if (!objectWithKeys(document, ['id', 'data'])) throw invalid('The replay archive contains an invalid document record.');
    const data = decodeBase64(document.data);
    return { bytes: data, byteLength: data.byteLength };
  });
  return { format: FORMAT, version: 1, documents: documents.map(({ id, bytes: data }) => ({ id, bytes: data })) };
}

function normalizedArchive(value) {
  if (!objectWithKeys(value, ['format', 'version', 'documents']) || value.format !== FORMAT || value.version !== 1) throw invalid();
  return validateDocuments(value.documents, document => {
    if (!objectWithKeys(document, ['id', 'bytes']) || !(document.bytes instanceof Uint8Array)) {
      throw invalid('The replay archive contains an invalid binary document record.');
    }
    return { bytes: document.bytes, byteLength: document.bytes.byteLength };
  });
}

// CRC detects accidental damage in uncompressed files too. It is not authentication.
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function checksum(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return ((value ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

async function collect(stream, maximum, expected) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > maximum - length) {
        throw invalid('The replay expands beyond its declared size or the 64 MiB limit.');
      }
      length += value.byteLength;
      chunks.push(value);
    }
    if (expected !== undefined && length !== expected) throw invalid('The replay history is truncated or has an invalid expanded length.');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function byteStream(bytes) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 64 * 1024, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

/**
 * Pack normalized engine documents or a legacy JSON byte export into a replay.
 * originalBytes is the raw document sum for object input, or JSON size for bytes.
 */
export async function writeReplayArchive(input) {
  const source = input instanceof Uint8Array || input instanceof ArrayBuffer ? inputBytes(input) : null;
  const archive = source ? legacyArchive(source) : normalizedArchive(input);
  const uncompressedBytes = archive.documents.reduce((sum, document) => sum + document.bytes.byteLength, 0);
  // Capture lengths before awaiting compression: callers may reuse their buffers.
  const documents = archive.documents.map(({ id, bytes }) => ({ id, byteLength: bytes.byteLength }));
  const raw = new Uint8Array(uncompressedBytes);
  let offset = 0;
  for (const document of archive.documents) {
    raw.set(document.bytes, offset);
    offset += document.bytes.byteLength;
  }
  let payload = raw, compression = 'none';
  if (typeof CompressionStream === 'function') {
    try {
      const packed = await collect(byteStream(raw).pipeThrough(new CompressionStream('gzip')), MAX_ARCHIVE_BYTES);
      // Loro already compresses its history. Keep an extra gzip layer only when useful.
      if (packed.byteLength + 64 < raw.byteLength && packed.byteLength <= raw.byteLength * 0.98) {
        payload = packed;
        compression = 'gzip';
      }
    } catch { /* A browser without usable gzip can still export the binary format. */ }
  }
  const metadata = encoder.encode(JSON.stringify({
    format: FORMAT, version: 2, compression, uncompressedBytes,
    payloadBytes: payload.byteLength, checksum: checksum(raw),
    documents,
  }));
  if (metadata.byteLength > MAX_METADATA_BYTES || HEADER_BYTES + metadata.byteLength + payload.byteLength > MAX_ARCHIVE_BYTES) {
    throw invalid('This replay exceeds the 64 MiB archive limit.');
  }
  const bytes = new Uint8Array(HEADER_BYTES + metadata.byteLength + payload.byteLength);
  bytes.set(MAGIC);
  new DataView(bytes.buffer).setUint32(MAGIC.length, metadata.byteLength, true);
  bytes.set(metadata, HEADER_BYTES);
  bytes.set(payload, HEADER_BYTES + metadata.byteLength);
  return { bytes, originalBytes: source ? source.byteLength : uncompressedBytes, packedBytes: bytes.byteLength, compression };
}

/** Read binary replays or legacy JSON into the core's normalized schema 1 shape. */
export async function readReplayArchive(input) {
  const bytes = inputBytes(input);
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) return legacyArchive(bytes);
  if (bytes.byteLength < HEADER_BYTES) throw invalid('The replay archive header is truncated.');
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.length, true);
  if (metadataLength < 2 || metadataLength > MAX_METADATA_BYTES || metadataLength > bytes.byteLength - HEADER_BYTES) {
    throw invalid('The replay archive metadata has an invalid length.');
  }
  const metadata = parseJson(bytes.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength));
  if (!objectWithKeys(metadata, ['format', 'version', 'compression', 'uncompressedBytes', 'payloadBytes', 'checksum', 'documents'])
    || metadata.format !== FORMAT || metadata.version !== 2 || !['none', 'gzip'].includes(metadata.compression)
    || !Number.isSafeInteger(metadata.uncompressedBytes) || metadata.uncompressedBytes < 0 || metadata.uncompressedBytes > MAX_ARCHIVE_BYTES
    || !Number.isSafeInteger(metadata.payloadBytes) || metadata.payloadBytes < 0 || metadata.payloadBytes !== bytes.byteLength - HEADER_BYTES - metadataLength
    || typeof metadata.checksum !== 'string' || !/^[0-9a-f]{8}$/.test(metadata.checksum)) {
    throw invalid('The replay archive has invalid or unsupported metadata.');
  }
  const { documents, total } = validateDocuments(metadata.documents, document => {
    if (!objectWithKeys(document, ['id', 'byteLength'])) throw invalid('The replay archive contains an invalid document record.');
    return { byteLength: document.byteLength };
  });
  if (total !== metadata.uncompressedBytes) throw invalid('The replay document sizes do not match its declared history size.');
  let payload = bytes.subarray(HEADER_BYTES + metadataLength);
  if (metadata.compression === 'gzip') {
    if (typeof DecompressionStream !== 'function') throw invalid('This browser cannot unpack gzip replay archives. Open it in an up-to-date browser.');
    try {
      payload = await collect(byteStream(payload).pipeThrough(new DecompressionStream('gzip')), metadata.uncompressedBytes, metadata.uncompressedBytes);
    } catch (error) {
      throw invalid(`The compressed replay is damaged or has an invalid size. ${error.message || ''}`.trim());
    }
  } else if (payload.byteLength !== metadata.uncompressedBytes) {
    throw invalid('The replay history is truncated or has unexpected trailing data.');
  }
  if (checksum(payload) !== metadata.checksum) throw invalid('The replay archive is damaged: its history checksum does not match.');
  let offset = 0;
  return {
    format: FORMAT,
    version: 1,
    documents: documents.map(({ id, byteLength }) => {
      const data = payload.slice(offset, offset + byteLength);
      offset += byteLength;
      return { id, bytes: data };
    }),
  };
}
