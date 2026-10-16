import { apiHandler } from '../lib/netlify-handler.mjs';

// Keeps cleanup off the polling path. Scheduled functions only run on the
// published deploy; room creation and connects still clean up opportunistically.
export default async function sweep() {
  const { pruned } = await apiHandler().sweep();
  console.log(`Common sweep pruned ${pruned} room(s).`);
}

export const config = { schedule: '* * * * *' };
