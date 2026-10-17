// Synthetic, generated locally; no captured user content or remote assets.
import { deflateSync } from 'node:zlib';
function crc32(bytes) { let crc = 0xffffffff; for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, bytes) { const tag = Buffer.from(type); const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); tag.copy(result, 4); bytes.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([tag, bytes])), result.length - 4); return result; }
export function pngFrame({ width = 64, height = 64, color = [205, 73, 58], annotation = false } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raster = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = annotation && x >= width / 4 && x <= width * 3 / 4 && y >= height / 4 && y <= height * 3 / 4 && (Math.abs(y - height / 4) < 2 || Math.abs(y - height * 3 / 4) < 2 || Math.abs(x - width / 4) < 2 || Math.abs(x - width * 3 / 4) < 2) ? [250, 235, 170] : color;
    const offset = y * (1 + width * 3) + 1 + x * 3; for (let channel = 0; channel < 3; channel++) raster[offset + channel] = pixel[channel];
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raster)), chunk('IEND', Buffer.alloc(0))]);
}
export const pngDataUrl = options => `data:image/png;base64,${pngFrame(options).toString('base64')}`;
