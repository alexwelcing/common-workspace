import { handle } from '../lib/netlify-handler.mjs';

export default handle;

// Blocked at Netlify's edge before the function or the database is reached.
export const config = {
  path: '/api/rooms',
  rateLimit: { windowLimit: 15, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
