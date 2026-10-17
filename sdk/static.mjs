import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.json': 'application/json', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

export const embeddedHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "frame-ancestors 'self'",
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'display-capture=(self), camera=(), microphone=(), geolocation=()',
};

export function commonError(status, code, message) {
  return Response.json({ error: message, code }, {
    status, headers: { ...embeddedHeaders, 'Cache-Control': 'no-store' },
  });
}

/** Serve only packaged assets and recognized room links, never an API fallback. */
export function createStaticHandler({ basePath, assetsDir = new URL('./app/', import.meta.url) }) {
  const directory = path.resolve(assetsDir instanceof URL ? fileURLToPath(assetsDir) : assetsDir);
  return async function serveStatic(request, pathname) {
    if (!['GET', 'HEAD'].includes(request.method)) return commonError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return commonError(400, 'INVALID_PATH', 'Invalid path.'); }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(segment => segment === '.' || segment === '..')) {
      return commonError(403, 'FORBIDDEN', 'Invalid path.');
    }
    if (decoded === '/api' || decoded.startsWith('/api/') || decoded === '/ws' || decoded.startsWith('/ws/')) {
      return commonError(404, 'NOT_FOUND', 'Endpoint not found.');
    }
    const isApp = decoded === '/' || /^\/room\/[A-Za-z0-9_-]{1,100}\/?$/.test(decoded);
    const filename = isApp ? 'index.html' : decoded.replace(/^\/+/, '');
    if (!filename) return commonError(404, 'NOT_FOUND', 'File not found.');
    const candidate = path.resolve(directory, filename);
    if (!candidate.startsWith(`${directory}${path.sep}`)) return commonError(403, 'FORBIDDEN', 'Invalid path.');
    let content, resolved;
    try {
      const root = await realpath(directory);
      resolved = await realpath(candidate);
      if (!resolved.startsWith(`${root}${path.sep}`)) return commonError(403, 'FORBIDDEN', 'Invalid path.');
      if (!(await stat(resolved)).isFile()) return commonError(404, 'NOT_FOUND', 'File not found.');
      content = await readFile(resolved);
    } catch {
      return commonError(isApp ? 503 : 404, isApp ? 'ASSETS_UNAVAILABLE' : 'NOT_FOUND', isApp ? 'Common frontend assets are unavailable. Build the module assets first.' : 'File not found.');
    }
    const extension = path.extname(resolved).toLowerCase();
    if (extension === '.html') {
      let html = content.toString('utf8');
      const base = `<base href="${basePath}">`;
      html = /<base\b[^>]*>/i.test(html) ? html.replace(/<base\b[^>]*>/i, base) : html.replace(/<head\b[^>]*>/i, match => `${match}${base}`);
      content = Buffer.from(html);
    }
    return new Response(request.method === 'HEAD' ? null : content, {
      headers: {
        ...embeddedHeaders, 'Content-Type': types[extension] || 'application/octet-stream',
        'Content-Length': String(content.byteLength),
        // The host authorization hook runs on every asset request. Do not let a
        // shared cache bypass that policy, including for hashed assets.
        'Cache-Control': 'private, no-store',
      },
    });
  };
}
