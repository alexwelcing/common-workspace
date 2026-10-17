import { appPath } from './app-path.js';

const safeDefault = () => ({ version: 1, protocolVersion: 1, transport: null, networkProfile: 'private', buildId: 'unknown', rtc: { iceServers: [], iceTransportPolicy: 'all', hasTurn: false }, plantUml: { enabled: false, endpoint: null }, available: false });
let current = safeDefault();
let pending;
let activeController;

export function getRuntimeConfig() { return current; }
export function cancelRuntimeConfigLoad() { activeController?.abort(); }

export function normalizeRuntimeConfig(value) {
  if (value?.version !== 1 || !['websocket', 'polling'].includes(value.transport)) throw new Error('Unsupported configuration');
  const config = safeDefault();
  config.transport = value.transport;
  config.networkProfile = value.networkProfile === 'standard' ? 'standard' : 'private';
  config.buildId = String(value.buildId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40);
  config.rtc.iceTransportPolicy = value.rtc?.iceTransportPolicy === 'relay' ? 'relay' : 'all';
  config.rtc.hasTurn = value.rtc?.hasTurn === true;
  config.rtc.iceServers = (Array.isArray(value.rtc?.iceServers) ? value.rtc.iceServers : []).slice(0, 8).map(server => ({
    urls: [server?.urls].flat().filter(url => typeof url === 'string' && /^stuns?:[^\s<>]+$/i.test(url)).slice(0, 8),
  })).filter(server => server.urls.length);
  if (value.plantUml?.enabled === true) {
    try {
      const endpoint = new URL(value.plantUml.endpoint);
      if (['https:', 'http:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash) {
        config.plantUml = { enabled: true, endpoint: endpoint.href.replace(/\/+$/, '') };
      }
    } catch { /* External rendering stays disabled for invalid configuration. */ }
  }
  config.available = true;
  return config;
}

/** Configuration failure keeps external services disabled; callers choose legacy transport explicitly. */
export function loadRuntimeConfig({ fetch: fetcher = globalThis.fetch, timeoutMs = 4000, force = false } = {}) {
  if (pending) return pending;
  if (current.available && !force) return Promise.resolve(current);
  const controller = new AbortController();
  activeController = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const request = Promise.resolve().then(() => fetcher(appPath('/api/config'), { cache: 'no-store', signal: controller.signal })).then(async response => {
    if (!response.ok) throw new Error('Configuration unavailable');
    current = normalizeRuntimeConfig(await response.json());
    return current;
  }).catch(() => current).finally(() => { clearTimeout(timer); if (pending === request) { pending = null; activeController = null; } });
  pending = request;
  return request;
}
