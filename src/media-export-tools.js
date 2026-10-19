import { LocalMediaExport } from './media-export.js';

// Deliberately private to this tab. Neither token nor media is put in storage or the agent API.
let client = null;
let active = null;
let closeActiveDialog = null;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const readPng = (file, signal) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  let settled = false;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', abort);
    reader.onload = reader.onerror = reader.onabort = null;
    if (error) reject(error); else resolve(result);
  };
  const abort = () => {
    const reading = reader.readyState === FileReader.LOADING;
    finish(new DOMException('Reading the frame was canceled.', 'AbortError'));
    if (reading) reader.abort();
  };
  reader.onload = () => finish(null, reader.result);
  reader.onerror = () => finish(new Error('This PNG frame could not be opened.'));
  reader.onabort = () => finish(new Error('Reading the frame was canceled.'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) { abort(); return; }
  try { reader.readAsDataURL(file); } catch (error) { finish(error); }
});

export function disconnectMediaExport() {
  closeActiveDialog?.();
  active?.abort(); active = null;
  client?.destroy(); client = null;
}

/** Explicit, user-driven export to an independently running processor on this laptop. */
export function openMediaExportDialog({ capture, modal, closeModal, onStatus = () => {} }) {
  closeActiveDialog?.();
  const recordings = capture.list();
  modal(`<h2 id="modal-title">Recording exports</h2><p>Make a shareable MP4 on your own laptop.</p>
    <p class="export-help">Start the optional worker with FFmpeg installed:<br><code id="media-worker-command"></code><br>Paste its session token below. Your browser may ask for local-network access.</p>
    <form id="media-worker-connect"><label>Worker address<input name="endpoint" id="media-worker-endpoint" type="url" value="http://127.0.0.1:8788" required autocomplete="off"></label><label>Session token<input name="token" id="media-worker-token" type="password" autocomplete="off" required minlength="32"></label><button class="button" id="media-worker-connect-button" type="submit">Connect local worker</button><button class="button" id="media-worker-disconnect" type="button">Disconnect</button></form>
    <p class="export-result" id="media-export-status" role="status" aria-live="polite"></p>
    <section class="export-section"><h3>Saved recording</h3><p class="export-help">Record Canvas + annotations in Agent tools to include your shared windows and drawings.</p><label>Recording<select id="media-export-recording">${recordings.length ? recordings.map(item => `<option value="${esc(item.id)}">${esc(item.source)} · ${Math.round((item.durationMs || 0) / 1000)} seconds</option>`).join('') : '<option value="">Record a walkthrough first</option>'}</select></label><button class="button" id="media-export-mp4" ${recordings.length ? '' : 'disabled'}>Export recording as MP4</button></section>
    <section class="export-section"><h3>Walkthrough from images</h3><p class="export-help">Choose up to 50 PNG frames in playback order. You can save canvas snapshots in Agent tools.</p><label>PNG frames<input type="file" id="media-export-frames" accept="image/png" multiple></label><label>Seconds per frame<input id="media-export-duration" type="number" value="3" min="0.5" max="30" step="0.1"></label><button class="button" id="media-export-walkthrough">Export image walkthrough</button></section>
    <p class="export-help">Media goes only to the worker you connect on this laptop. The session token stays in this tab. Closing this dialog cancels an active export.</p><button class="button modal-submit" id="media-export-cancel">Cancel export</button>`);
  const root = $('#modal-root');
  $('#media-worker-command').textContent = `bun run media:export --origin ${location.origin}`;
  const status = $('#media-export-status');
  const connectButton = $('#media-worker-connect-button');
  const endpointInput = $('#media-worker-endpoint');
  const tokenInput = $('#media-worker-token');
  const disconnectButton = $('#media-worker-disconnect');
  const recordingInput = $('#media-export-recording');
  const recordingButton = $('#media-export-mp4');
  const framesInput = $('#media-export-frames');
  const durationInput = $('#media-export-duration');
  const walkthroughButton = $('#media-export-walkthrough');
  const cancelButton = $('#media-export-cancel');
  const originalClose = root.querySelector('.close-modal');
  const overlay = root.querySelector('.modal-overlay');
  let closed = false, operation = null;
  const alive = () => !closed && status.isConnected;
  // Each awaited path owns this token. Cancellation releases it immediately so
  // a retry can start while a late response or rejection finishes settling.
  const current = token => alive() && operation === token;
  const update = message => { if (alive()) status.textContent = message; };
  function renderControls() {
    if (!alive()) return;
    const busy = !!operation || !!active;
    connectButton.disabled = busy;
    connectButton.textContent = operation?.kind === 'connect' ? 'Connecting…' : 'Connect local worker';
    endpointInput.disabled = tokenInput.disabled = busy;
    disconnectButton.disabled = !client && !busy;
    recordingInput.disabled = busy || !recordings.length;
    recordingButton.disabled = busy || !client || !recordings.length;
    framesInput.disabled = durationInput.disabled = busy;
    walkthroughButton.disabled = busy || !client;
    cancelButton.disabled = !operation;
    cancelButton.textContent = operation?.kind === 'connect' ? 'Cancel connection' : 'Cancel export';
  }
  function cancelOperation() {
    const canceled = operation;
    operation = null;
    canceled?.candidate?.destroy();
    canceled?.controller?.abort();
    if (active === canceled?.controller) active = null;
    renderControls();
    return canceled;
  }
  function cleanup() {
    if (closed) return;
    closed = true;
    cancelOperation();
    observer.disconnect();
    tokenInput.value = '';
    if (closeActiveDialog === cleanup) closeActiveDialog = null;
  }
  const close = () => { if (!closed) { cleanup(); closeModal(); } };
  originalClose.onclick = close;
  overlay.onclick = event => { if (event.target === event.currentTarget) close(); };
  const observer = new MutationObserver(() => {
    if (!status.isConnected) cleanup();
  });
  observer.observe(root, { childList: true, subtree: true });
  if (root.parentNode) observer.observe(root.parentNode, { childList: true });
  closeActiveDialog = cleanup;
  renderControls();
  update(client ? 'Local worker connected. Choose an export below.' : 'Connect your local worker to enable MP4 exports.');
  $('#media-worker-connect').onsubmit = async event => {
    event.preventDefault();
    if (!alive()) return;
    if (operation || active) { update('Wait for the current operation to finish or cancel it first.'); return; }
    const token = { kind: 'connect', candidate: null };
    operation = token;
    renderControls();
    update('Connecting to the local worker…');
    try {
      token.candidate = new LocalMediaExport({ endpoint: endpointInput.value, token: tokenInput.value.trim() });
      await token.candidate.capabilities();
      if (!current(token)) return;
      client?.destroy(); client = token.candidate;
      tokenInput.value = '';
      update('Local worker connected. Choose an export below.');
    } catch (error) {
      if (current(token)) update(`${error.message}${client ? ' Your previous worker is still connected.' : ''}`);
    } finally {
      if (token.candidate !== client) token.candidate?.destroy();
      if (operation === token) { operation = null; renderControls(); }
    }
  };
  disconnectButton.onclick = () => {
    if (!alive()) return;
    cancelOperation();
    client?.destroy(); client = null;
    tokenInput.value = '';
    renderControls();
    update('Local worker disconnected.');
  };
  async function run(work) {
    if (!alive()) return;
    if (operation || active) { update('Wait for the current operation to finish or cancel it first.'); return; }
    if (!client) { update('Connect your local worker first.'); return; }
    const connection = client, controller = new AbortController();
    const token = { kind: 'export', controller };
    operation = token; active = controller;
    renderControls();
    update('Making your MP4 on this laptop…');
    try {
      const result = await work(connection, controller.signal);
      if (!current(token) || controller.signal.aborted || connection !== client) return;
      connection.download(result);
      update('MP4 exported. Your original recording is still available.');
      try { onStatus('Your MP4 is ready.'); } catch { /* The host owns its status display. */ }
    } catch (error) {
      if (current(token)) update(controller.signal.aborted ? 'Export canceled.' : error.message);
    } finally {
      if (active === controller) active = null;
      if (operation === token) { operation = null; renderControls(); }
    }
  }
  recordingButton.onclick = () => run((connection, signal) => connection.exportRecording(capture.getRecordingBlob(recordingInput.value), { signal }));
  walkthroughButton.onclick = () => run(async (connection, signal) => {
    const files = [...framesInput.files];
    const durationMs = Math.round(Number(durationInput.value) * 1000);
    if (!files.length || files.length > 50 || files.some(file => file.type !== 'image/png' || file.size > 5 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 45 * 1024 * 1024) throw new Error('Choose 1–50 PNG frames, each under 5 MB and under 45 MB together.');
    if (!Number.isFinite(durationMs) || durationMs < 500 || durationMs > 30000 || durationMs * files.length > 300000) throw new Error('Choose 0.5–30 seconds per frame and no more than five minutes total.');
    const frames = [];
    for (const file of files) { if (signal.aborted) throw new Error('Export canceled.'); frames.push({ dataUrl: await readPng(file, signal), durationMs }); }
    return connection.exportWalkthrough({ frames }, { signal });
  });
  cancelButton.onclick = () => {
    if (!alive()) return;
    const canceled = cancelOperation();
    if (canceled) update(canceled.kind === 'connect'
      ? `Connection canceled.${client ? ' Your previous worker is still connected.' : ''}`
      : 'Export canceled. Your original recording is still available.');
  };
  return cleanup;
}

globalThis.addEventListener?.('beforeunload', disconnectMediaExport);
