const DEFAULT_STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
const DEFAULT_PLANTUML = 'https://www.plantuml.com/plantuml';
const read = (env, key) => typeof env === 'function' ? env(key) : env?.[key];

export function networkProfileFromEnv(env = process.env) {
  return read(env, 'COMMON_NETWORK_PROFILE') === 'private' ? 'private' : 'standard';
}

/** Public connection discovery only. TURN credentials belong to authenticated /api/ice. */
export function stunServersFromEnv(env = process.env) {
  const configured = read(env, 'STUN_URLS');
  const urls = configured === undefined
    ? networkProfileFromEnv(env) === 'private' ? [] : DEFAULT_STUN
    : String(configured).split(',').map(value => value.trim()).filter(value => /^stuns?:[^\s<>]+$/i.test(value)).slice(0, 8);
  return urls.length ? [{ urls }] : [];
}

export function iceTransportPolicyFromEnv(env = process.env) {
  return read(env, 'ICE_TRANSPORT_POLICY') === 'relay' ? 'relay' : 'all';
}

function plantUmlConfig(env) {
  const configured = read(env, 'PLANTUML_URL');
  const endpoint = configured === undefined ? networkProfileFromEnv(env) === 'private' ? '' : DEFAULT_PLANTUML : configured;
  if (!endpoint || endpoint === 'none') return { enabled: false, endpoint: null };
  try {
    const url = new URL(endpoint);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return { enabled: true, endpoint: url.href.replace(/\/+$/, '') };
  } catch { return { enabled: false, endpoint: null }; }
}

/** Deliberately enumerate fields: never spread process.env into a public response. */
export function publicRuntimeConfig(env = process.env, { transport = 'websocket', buildId } = {}) {
  return {
    version: 1,
    protocolVersion: 1,
    transport: transport === 'polling' ? 'polling' : 'websocket',
    networkProfile: networkProfileFromEnv(env),
    buildId: String(read(env, 'COMMIT_REF') || read(env, 'COMMON_BUILD_ID') || buildId || 'local').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40) || 'local',
    rtc: {
      iceServers: stunServersFromEnv(env),
      iceTransportPolicy: iceTransportPolicyFromEnv(env),
      hasTurn: Boolean(read(env, 'TURN_URLS') && (read(env, 'TURN_SECRET') || (read(env, 'TURN_USERNAME') && read(env, 'TURN_CREDENTIAL')))),
    },
    plantUml: plantUmlConfig(env),
  };
}
