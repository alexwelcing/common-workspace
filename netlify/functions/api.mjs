import { getDatabase } from '@netlify/database';
import { createApiHandler } from '../lib/api.mjs';

let handler;

export default async function api(request, context) {
  // Lazy initialization also lets imports/build analysis run without credentials.
  try {
    if (!handler) handler = createApiHandler({ pool: getDatabase().pool });
    return handler(request, context);
  } catch {
    return Response.json({ error: 'Session storage is unavailable. Please try again.', code: 'SERVICE_UNAVAILABLE' }, {
      status: 503, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }
}

export const config = { path: '/api/*' };
