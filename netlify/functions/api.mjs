import { handle } from '../lib/netlify-handler.mjs';

export default handle;

// Room creation and joining are served by their own rate-limited functions.
export const config = { path: '/api/*', excludedPath: ['/api/rooms', '/api/rooms/:id/join'] };
