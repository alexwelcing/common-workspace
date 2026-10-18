import { displayCaptureSupport } from './browser-permissions.js';

const number = value => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
const STATES = new Set(['connecting', 'connected', 'disconnected', 'closed', 'failed', 'new', 'checking', 'completed', 'stable', 'config-ready', 'config-unavailable']);
const TYPES = new Set(['connection', 'config', 'poll', 'queue', 'peer', 'sync', 'request', 'capture']);
const CAPTURE_PHASES = new Set(['idle', 'requesting', 'sharing', 'abandoning', 'dismissed', 'blocked', 'error', 'stopped']);
const CAPTURE_CODES = new Set(['insecure-context', 'permissions-policy', 'unavailable', 'NotAllowedError', 'NotReadableError', 'InvalidStateError', 'NotFoundError', 'AbortError', 'SecurityError', 'TypeError', 'OverconstrainedError']);
const CAPABILITIES = ['inspect', 'canvas-write', 'media-capture', 'recording'];
const NUMBERS = ['durationMs', 'queuedMessages', 'queueAgeMs', 'events', 'participants', 'failures', 'bytes', 'cursor', 'attempts', 'status'];

/** An allowlisted operational history. Content, identifiers and arbitrary errors are excluded. */
export class DiagnosticLog {
  constructor({ now = Date.now, limit = 80 } = {}) { this.now = now; this.limit = limit; this.events = []; }
  record(type, values = {}) {
    if (!TYPES.has(type)) return;
    const entry = { at: this.now(), type };
    if (STATES.has(values.state)) entry.state = values.state;
    if (type === 'capture') {
      if (CAPTURE_PHASES.has(values.phase)) entry.phase = values.phase;
      if (CAPTURE_CODES.has(values.code)) entry.code = values.code;
    }
    if (typeof values.requestId === 'string' && /^[a-f0-9]{32}$/.test(values.requestId)) entry.requestId = values.requestId;
    for (const key of NUMBERS) if (Number.isFinite(values[key])) entry[key] = number(values[key]);
    this.events.push(entry);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }
  snapshot() { return this.events.map(event => ({ ...event })); }
}

export function mediaDiagnostics(media) {
  const peers = [...(media?.peers?.values?.() || [])];
  const result = {
    peerConnections: peers.length, connected: 0, connecting: 0, failed: 0,
    canvasNeighbors: media?.desiredCanvasPeers?.size || 0, openCanvasNeighbors: media?.dataPeerIds?.length || 0,
    watchedWindows: media?.subscriptions?.size || 0, viewers: media?.viewers?.size || 0,
    queuedBytes: 0, bufferedBytes: 0, assemblingBytes: 0, turnConfigured: false,
  };
  for (const peer of peers) {
    const state = peer.pc?.connectionState || peer.pc?.iceConnectionState;
    if (['connected', 'completed'].includes(state)) result.connected++;
    else if (state === 'failed') result.failed++;
    else if (!['closed', 'disconnected'].includes(state)) result.connecting++;
    result.queuedBytes += number(peer.dataQueuedBytes);
    result.bufferedBytes += number(peer.channel?.bufferedAmount);
    result.assemblingBytes += number(peer.dataAssemblyBytes);
    result.turnConfigured ||= Boolean(peer.hasTurn);
  }
  return result;
}

export function buildDiagnosticReport({ runtime = {}, connection = {}, canvas = {}, media, transport, log, agentAccess = {} } = {}) {
  const support = displayCaptureSupport(), capture = media?.getCaptureState?.() || {};
  const report = {
    version: 1, generatedAt: new Date().toISOString(),
    application: { buildId: String(runtime.buildId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40), frontendBuildId: String(runtime.frontendBuildId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40), protocolVersion: 1 },
    environment: { transport: ['polling', 'websocket'].includes(runtime.transport) ? runtime.transport : 'unknown', networkProfile: runtime.networkProfile === 'standard' ? 'standard' : 'private', secureContext: globalThis.isSecureContext === true },
    session: { personal: connection.sandbox === true, connected: connection.connected === true, participants: number(connection.participants) },
    canvas: { objects: number(canvas.objects), connectedNeighbors: number(canvas.connectedNeighbors) },
    media: mediaDiagnostics(media), signaling: {}, events: log?.snapshot?.() || [],
    permissions: {
      screenShare: {
        available: support.available === true, readiness: support.code,
        embedded: globalThis.window ? globalThis.window.parent !== globalThis.window : false,
        phase: CAPTURE_PHASES.has(capture.phase) ? capture.phase : 'idle',
        requestPending: capture.requestPending === true,
        source: ['browser', 'window', 'monitor', 'unknown'].includes(capture.source?.kind) ? capture.source.kind : null,
        ...(CAPTURE_CODES.has(capture.code) ? { code: capture.code } : {}),
      },
      agent: {
        active: agentAccess.active === true,
        capabilities: CAPABILITIES.filter(capability => Array.isArray(agentAccess.capabilities) && agentAccess.capabilities.includes(capability)),
        remainingSeconds: number(agentAccess.remainingMs / 1000),
      },
    },
  };
  const signaling = transport?.diagnostics?.() || {};
  for (const key of ['queuedMessages', 'queueAgeMs', 'pollFailures', 'lastPollMs', 'pollCount', 'eventsReceived']) {
    if (Number.isFinite(signaling[key])) report.signaling[key] = number(signaling[key]);
  }
  return report;
}
