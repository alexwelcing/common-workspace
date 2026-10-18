import { createAgentAPI, createAgentPermissions } from '../agent-api.js';
import { CanvasCapture } from '../capture.js';
import { Walkthrough } from '../walkthrough.js';
import { installAgentTools } from '../agent-tools.js';
import { installWebMCP } from '../webmcp.js';

/** Opt-in tools for the selected flat board. Spatial navigation stays with the beta UI. */
export function installBetaAgent({
  getBoard, getModel, getContext, getSession = getModel,
  getWindowStream = () => null, onStatus = () => {}, onChange = () => {},
  buttonParent = document.body, onRequestWindowShare = () => {},
  getSharingState = () => ({}), signal,
} = {}) {
  for (const getter of [getBoard, getModel, getContext, getSession]) {
    if (typeof getter !== 'function') throw new TypeError('Beta agent tools need board, model, context, and session getters.');
  }
  if (signal?.aborted) throw new DOMException('Beta agent tools were canceled.', 'AbortError');
  if (Object.getOwnPropertyDescriptor(window, 'commonAgent')) throw new Error('Agent tools are already installed in this browser. Close them before opening another canvas.');

  let destroyed = false, enabled = false, refreshing = false;
  let tools, webMCP, permissions, capture, walkthrough;
  let sourceModel, sourceSession, sourceIdentity;
  const downloadUrls = new Map();
  const previousAgentMarker = document.documentElement.getAttribute('data-common-agent');
  const status = message => { if (!destroyed) { try { onStatus(message); } catch {} } };
  const board = () => destroyed ? null : getBoard();
  const model = () => destroyed ? null : getModel();
  const context = () => destroyed ? { enabled: false } : { ...getContext(), enabled };
  // A Board instance may be reused when selecting another surface or history time.
  // Bind grants and asynchronous capture to both its document facade and room.
  const session = () => {
    const nextModel = model(), nextSession = destroyed ? null : getSession();
    if (!sourceIdentity || nextModel !== sourceModel || nextSession !== sourceSession) {
      sourceModel = nextModel; sourceSession = nextSession; sourceIdentity = {};
    }
    return sourceIdentity;
  };
  function getState() {
    const sharing = destroyed ? {} : getSharingState() || {};
    const recording = capture.status();
    return {
      destroyed, enabled: !destroyed && enabled,
      recording, walkthrough: walkthrough.state(),
      sharing: { windowShared: recording.windowShared, phase: typeof sharing.phase === 'string' ? sharing.phase : 'idle', requestPending: !!sharing.requestPending },
    };
  }
  function notify() { try { onChange(getState()); } catch {} }
  function ready() {
    window.dispatchEvent(new CustomEvent('common-agent-ready', { detail: { version: '1', enabled: !destroyed && enabled } }));
  }
  function refresh() {
    if (destroyed || refreshing) return;
    refreshing = true;
    try {
      capture?.syncSource();
      permissions?.refresh();
      tools?.refresh();
      void webMCP?.refresh();
    } finally { refreshing = false; }
    notify();
  }
  function stop() {
    walkthrough?.stop();
    return capture?.stop() || Promise.resolve(null);
  }
  function revoke(reason = 'revoked') {
    if (destroyed) return;
    enabled = false;
    permissions.revoke(reason);
    void stop().catch(() => {});
    ready(); refresh();
  }

  capture = new CanvasCapture({ getBoard: board, getSession: session, getWindowStream: () => destroyed ? null : getWindowStream(), onChange: refresh, onStatus: status });
  capture.exportCanvas = (data, { mimeType, filename, download = false } = {}) => {
    if (destroyed) throw new Error('Common was closed.');
    if (download) {
      const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
      const link = document.createElement('a'); link.href = url; link.download = filename;
      try { document.body.append(link); link.click(); }
      catch (error) { URL.revokeObjectURL(url); throw error; }
      finally { link.remove(); }
      const timer = setTimeout(() => { downloadUrls.delete(url); URL.revokeObjectURL(url); }, 1000);
      downloadUrls.set(url, timer);
    }
    return { filename, mimeType };
  };
  walkthrough = new Walkthrough({ getBoard: board, onChange: refresh, onStatus: status });
  permissions = createAgentPermissions({
    getContext: context, getSession: session, onChange: refresh,
    onRevoke: reason => {
      if (destroyed) return;
      if (reason !== 'permissions-reduced') enabled = false;
      void stop().catch(() => {});
      ready(); refresh();
    },
  });
  const api = createAgentAPI({ getBoard: board, getModel: model, getContext: context, permissions, recording: capture, walkthrough, onStatus: status });
  tools = installAgentTools({
    api, capture, walkthrough, permissions, buttonParent,
    getEnabled: () => !destroyed && enabled,
    onEnabledChange: value => { enabled = !destroyed && !!value; ready(); notify(); },
    onRequestWindowShare, getSharingState, onStatus: status,
  });
  webMCP = installWebMCP({ api, permissions, onStatus: status });
  Object.defineProperty(window, 'commonAgent', { value: api, writable: false, configurable: true });
  document.documentElement.dataset.commonAgent = '1';

  function destroy() {
    if (destroyed) return;
    destroyed = true; enabled = false;
    signal?.removeEventListener('abort', destroy);
    webMCP.destroy(); permissions.destroy(); tools.destroy(); walkthrough.stop(); capture.destroy();
    for (const [url, timer] of downloadUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
    downloadUrls.clear();
    if (Object.getOwnPropertyDescriptor(window, 'commonAgent')?.value === api) delete window.commonAgent;
    if (previousAgentMarker === null) document.documentElement.removeAttribute('data-common-agent');
    else document.documentElement.setAttribute('data-common-agent', previousAgentMarker);
    ready(); notify();
  }
  signal?.addEventListener('abort', destroy, { once: true });
  ready(); refresh();
  return Object.freeze({ api, open() { if (!destroyed) tools.open(); }, refresh, revoke, stop, getState, destroy });
}
