import { getAgentToolDefinitions } from './agent-api.js';

const errorResult = (code, message) => JSON.stringify({ ok: false, error: { code, message } });

/** Optional experimental browser adapter. The existing command layer remains authoritative. */
export function installWebMCP({ api, permissions, document = globalThis.document, onStatus = () => {} } = {}) {
  const modelContext = document?.modelContext;
  const supported = typeof modelContext?.registerTool === 'function';
  const registered = new Set();
  let destroyed = false; let generation = 0; let signature = ''; let controller; let pending = Promise.resolve(); let lastError = null;
  const status = () => ({ supported, experimental: true, registered: [...registered], error: lastError });
  function argumentsFor(definition, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args)) || Object.getOwnPropertySymbols(args).length) throw new Error('Use a plain JSON argument object.');
    const command = { action: definition.action };
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(definition.inputSchema.properties, key)) throw new Error(`Unsupported tool argument: ${key}.`);
      const property = Object.getOwnPropertyDescriptor(args, key);
      if (!property || !('value' in property)) throw new Error('Tool arguments cannot contain getters or setters.');
      command[key] = property.value;
    }
    return command;
  }
  function toolFor(definition, registration) {
    return {
      name: definition.name, description: definition.description, inputSchema: definition.inputSchema, annotations: definition.annotations,
      async execute(args = {}, { signal } = {}) {
        if (destroyed || registration.signal.aborted || signal?.aborted) return errorResult('ABORTED', 'This agent tool is no longer active.');
        let command;
        try { command = argumentsFor(definition, args); } catch (error) { return errorResult('INVALID_COMMAND', error.message); }
        const execution = new AbortController();
        const abort = () => execution.abort();
        registration.signal.addEventListener('abort', abort, { once: true });
        signal?.addEventListener?.('abort', abort, { once: true });
        try { return JSON.stringify(await api.execute(command, { signal: execution.signal })); }
        finally { registration.signal.removeEventListener('abort', abort); signal?.removeEventListener?.('abort', abort); }
      },
    };
  }
  function refresh() {
    if (destroyed) return Promise.resolve(status());
    const grant = permissions?.state?.() || api.describe().grants;
    const state = api.state();
    const sourceAvailable = !!state.source?.available;
    const nextSignature = JSON.stringify([supported, state.enabled, state.ready, grant?.active, grant?.revision, grant?.capabilities, sourceAvailable]);
    if (nextSignature === signature) return pending.then(status);
    signature = nextSignature;
    const ticket = ++generation;
    controller?.abort(); controller = null; registered.clear(); lastError = null;
    const definitions = supported && state.enabled && state.ready && grant?.active
      ? getAgentToolDefinitions().filter(definition => (!definition.action.startsWith('source.') || sourceAvailable)
        && definition.capabilities.every(capability => grant.capabilities.includes(capability))) : [];
    pending = pending.catch(() => {}).then(async () => {
      if (destroyed || ticket !== generation || !definitions.length) return;
      const registration = new AbortController(); controller = registration;
      try {
        for (const definition of definitions) {
          if (destroyed || ticket !== generation || registration.signal.aborted) break;
          await modelContext.registerTool(toolFor(definition, registration), { signal: registration.signal });
          if (destroyed || ticket !== generation || registration.signal.aborted) { registration.abort(); break; }
          registered.add(definition.name);
        }
      } catch {
        registration.abort(); registered.clear();
        if (!destroyed && ticket === generation) {
          lastError = 'WebMCP registration is unavailable. The existing browser agent API still works.';
          try { onStatus(lastError); } catch {}
        }
      }
    });
    return pending.then(status);
  }
  const unsubscribe = permissions?.subscribe?.(() => { void refresh(); });
  void refresh();
  return Object.freeze({ refresh, status,
    destroy() { if (destroyed) return; destroyed = true; ++generation; controller?.abort(); registered.clear(); unsubscribe?.(); },
  });
}
