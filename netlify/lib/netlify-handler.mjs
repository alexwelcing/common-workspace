import { getDatabase } from '@netlify/database';
import { createApiHandler } from './api.mjs';
import { publicRuntimeConfig } from '../../lib/runtime-config.mjs';
import { observeRequest } from '../../lib/observability.mjs';

let handler;

// Netlify's edge rate limits (see the room create and join functions) replace
// the database-backed attempt counters used by the self-hosted server.
export function apiHandler() {
  // Lazy initialization also lets imports/build analysis run without credentials.
  handler ??= createApiHandler({ pool: getDatabase().pool, rateLimits: false });
  return handler;
}

async function handleApi(request, context) {
  try {
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/config') {
      return Response.json(publicRuntimeConfig(key => globalThis.Netlify?.env?.get(key) ?? process.env[key], { transport: 'polling', buildId: context?.deploy?.id }), {
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    return await apiHandler()(request, context);
  } catch {
    return Response.json({ error: 'Session storage is unavailable. Please try again.', code: 'SERVICE_UNAVAILABLE' }, {
      status: 503, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }
}

export function handle(request, context) {
  return observeRequest(request, () => handleApi(request, context), {
    env: key => (globalThis.Netlify?.env?.get(key) ?? process.env[key]) || (key === 'COMMON_BUILD_ID' ? context?.deploy?.id : undefined),
  });
}
