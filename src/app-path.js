// Capture a same-origin installation base once. Later DOM changes cannot move
// room-token requests to a different origin or escape the mounted prefix.
const fallback = new URL('/', globalThis.location?.href || 'http://localhost/');
let base;
try {
  base = new URL(globalThis.document?.baseURI || fallback.href, fallback);
  if (base.origin !== fallback.origin || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid application base.');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
} catch { base = fallback; }

export const appBasePath = base.pathname;

export function appURL(value = '') {
  if (typeof value !== 'string' || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//') || value.includes('\\')) throw new Error('Use a path inside this Common installation.');
  const url = new URL(value.replace(/^\/+/, ''), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(appBasePath)) throw new Error('The path is outside this Common installation.');
  return url.href;
}

export function appPath(value = '') {
  const url = new URL(appURL(value));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function appWebSocketURL(value) {
  const url = new URL(appURL(value));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export function appRoute(pathname = globalThis.location?.pathname || '/') {
  return pathname.startsWith(appBasePath) ? `/${pathname.slice(appBasePath.length)}` : '/';
}

export function appStorageKey(key) {
  return appBasePath === '/' ? key : `common.mount.${encodeURIComponent(appBasePath)}.${key}`;
}
