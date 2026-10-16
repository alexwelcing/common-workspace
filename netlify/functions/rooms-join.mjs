import { handle } from '../lib/netlify-handler.mjs';

export default handle;

// Password attempts per visitor, across all rooms. Blocked before the function runs.
export const config = {
  path: '/api/rooms/:id/join',
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
