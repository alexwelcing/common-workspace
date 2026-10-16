import { getDatabase } from '@netlify/database';
import { createApiHandler } from './api.mjs';

let handler;

// Netlify's edge rate limits (see the room create and join functions) replace
// the database-backed attempt counters used by the self-hosted server.
export function apiHandler() {
  // Lazy initialization also lets imports/build analysis run without credentials.
  handler ??= createApiHandler({ pool: getDatabase().pool, rateLimits: false });
  return handler;
}

export async function handle(request, context) {
  try {
    return await apiHandler()(request, context);
  } catch {
    return Response.json({ error: 'Session storage is unavailable. Please try again.', code: 'SERVICE_UNAVAILABLE' }, {
      status: 503, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }
}
