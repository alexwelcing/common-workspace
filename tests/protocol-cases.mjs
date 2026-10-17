// The same public-boundary cases run against both independent room adapters.
export const protocolPassword = 'correct horse battery';
export const validCreation = { name: '  Shared work  ', displayName: '  Host  ', password: protocolPassword, collaboration: 'peer' };
export const creationCases = [
  { label: 'trimmed valid names', input: validCreation, status: 201, name: 'Shared work' },
  { label: 'blank room name', input: { ...validCreation, name: '  ' }, status: 400, code: 'INVALID_NAME' },
  { label: 'long display name', input: { ...validCreation, displayName: 'a'.repeat(61) }, status: 400, code: 'INVALID_NAME' },
  { label: 'non-string room name', input: { ...validCreation, name: ['room'] }, status: 400, code: 'INVALID_NAME' },
  { label: 'short password', input: { ...validCreation, password: 'short' }, status: 400, code: 'INVALID_PASSWORD' },
  { label: 'oversized password', input: { ...validCreation, password: 'p'.repeat(129) }, status: 400, code: 'INVALID_PASSWORD' },
  { label: 'unknown collaboration mode', input: { ...validCreation, collaboration: 'unknown' }, status: 400, code: 'INVALID_COLLABORATION' },
];
export const joinCases = [
  { label: 'trimmed participant name', input: { displayName: '  Guest  ', password: protocolPassword }, status: 200 },
  { label: 'blank participant name', input: { displayName: ' ', password: protocolPassword }, status: 400, code: 'INVALID_NAME' },
  { label: 'non-string participant name', input: { displayName: ['Guest'], password: protocolPassword }, status: 400, code: 'INVALID_NAME' },
  { label: 'wrong password', input: { displayName: 'Guest', password: 'wrong password' }, status: 401, code: 'WRONG_PASSWORD' },
  { label: 'non-string password', input: { displayName: 'Guest', password: 12345678 }, status: 401, code: 'WRONG_PASSWORD' },
  { label: 'oversized join password', input: { displayName: 'Guest', password: 'p'.repeat(129) }, status: 401, code: 'WRONG_PASSWORD' },
];
export const activityCases = [
  { label: 'blank chat', message: { type: 'chat', text: ' ' }, code: 'INVALID_CHAT' },
  { label: 'oversized chat', message: { type: 'chat', text: 'x'.repeat(2001) }, code: 'INVALID_CHAT' },
  { label: 'invalid signal payload', message: { type: 'signal', to: 'unavailable', data: [] }, code: 'INVALID_SIGNAL' },
  { label: 'non-string signal target', message: { type: 'signal', to: 4, data: {} }, code: 'INVALID_SIGNAL' },
  { label: 'invalid cursor', message: { type: 'cursor', x: 100001, y: 0 }, code: 'INVALID_CURSOR' },
  { label: 'unknown activity', message: { type: 'unknown' }, code: 'INVALID_MESSAGE' },
];
