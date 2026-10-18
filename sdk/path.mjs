/** Mounts are same-origin paths, so they can be used safely in HTML and URLs. */
export function normalizeBasePath(value = '/__common/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') ||
      /[\\%?#\s]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || value.includes('//')) {
    throw new TypeError('Common basePath must be an absolute same-origin path without query, hash, or encoded segments.');
  }
  const segments = value.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))) {
    throw new TypeError('Common basePath contains an unsupported path segment.');
  }
  return segments.length ? `/${segments.join('/')}/` : '/';
}

/** Return an internal absolute path, preserving a strict mount boundary. */
export function matchBasePath(pathname, basePath) {
  if (basePath === '/') return pathname.startsWith('/') ? pathname : null;
  if (pathname === basePath.slice(0, -1)) return '/';
  return pathname.startsWith(basePath) ? `/${pathname.slice(basePath.length)}` : null;
}
