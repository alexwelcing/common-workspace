import { LocalMediaExport } from './media-export.js';

// Deliberately private to this tab. Neither token nor media is put in storage or the agent API.
let client = null;
let active = null;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const readPng = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('This PNG frame could not be opened.'));
  reader.onabort = () => reject(new Error('Reading the frame was canceled.'));
  reader.readAsDataURL(file);
});

export function disconnectMediaExport() { active?.abort(); active = null; client?.destroy(); client = null; }

/** Explicit, user-driven export to an independently running processor on this laptop. */
export function openMediaExportDialog({ capture, modal, closeModal, onStatus = () => {} }) {
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
  const originalClose = root.querySelector('.close-modal');
  const overlay = root.querySelector('.modal-overlay');
  let closed = false, connectionGeneration = 0, pendingConnection = null, dialogJob = null;
  const close = () => { closed = true; connectionGeneration++; pendingConnection?.destroy(); dialogJob?.abort(); closeModal(); };
  originalClose.onclick = close;
  overlay.onclick = event => { if (event.target === event.currentTarget) close(); };
  const observer = new MutationObserver(() => {
    if (!status.isConnected) { closed = true; connectionGeneration++; pendingConnection?.destroy(); dialogJob?.abort(); observer.disconnect(); }
  });
  observer.observe(root, { childList: true, subtree: true });
  const update = message => { if (!closed) status.textContent = message; };
  update(client ? 'Local worker connected. Choose an export below.' : 'Connect your local worker to enable MP4 exports.');
  $('#media-worker-connect').onsubmit = async event => {
    event.preventDefault();
    if (active) { update('Wait for the current export to finish or cancel it first.'); return; }
    connectButton.disabled = true;
    let candidate; const ticket = ++connectionGeneration;
    try {
      candidate = new LocalMediaExport({ endpoint: $('#media-worker-endpoint').value, token: $('#media-worker-token').value.trim() });
      pendingConnection = candidate; await candidate.capabilities();
      if (closed || ticket !== connectionGeneration) { candidate.destroy(); return; }
      client?.destroy(); client = candidate;
      $('#media-worker-token').value = '';
      update('Local worker connected. Choose an export below.');
    } catch (error) { candidate?.destroy(); update(error.message); }
    finally { if (pendingConnection === candidate) pendingConnection = null; if (!closed) connectButton.disabled = false; }
  };
  $('#media-worker-disconnect').onclick = () => { connectionGeneration++; pendingConnection?.destroy(); disconnectMediaExport(); $('#media-worker-token').value = ''; update('Local worker disconnected.'); };
  async function run(work) {
    if (!client) { update('Connect your local worker first.'); return; }
    if (active) { update('An export is already running.'); return; }
    const connection = client, controller = new AbortController(); active = controller; dialogJob = controller;
    update('Making your MP4 on this laptop…');
    try {
      const result = await work(connection, controller.signal);
      if (closed || controller.signal.aborted || connection !== client) return;
      connection.download(result); update('MP4 exported. Your original recording is still available.'); onStatus('Your MP4 is ready.');
    } catch (error) { update(controller.signal.aborted ? 'Export canceled.' : error.message); }
    finally { if (active === controller) active = null; if (dialogJob === controller) dialogJob = null; }
  }
  $('#media-export-mp4').onclick = () => run((connection, signal) => connection.exportRecording(capture.getRecordingBlob($('#media-export-recording').value), { signal }));
  $('#media-export-walkthrough').onclick = () => run(async (connection, signal) => {
    const files = [...$('#media-export-frames').files];
    const durationMs = Math.round(Number($('#media-export-duration').value) * 1000);
    if (!files.length || files.length > 50 || files.some(file => file.type !== 'image/png' || file.size > 5 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 45 * 1024 * 1024) throw new Error('Choose 1–50 PNG frames, each under 5 MB and under 45 MB together.');
    if (!Number.isFinite(durationMs) || durationMs < 500 || durationMs > 30000 || durationMs * files.length > 300000) throw new Error('Choose 0.5–30 seconds per frame and no more than five minutes total.');
    const frames = [];
    for (const file of files) { if (signal.aborted) throw new Error('Export canceled.'); frames.push({ dataUrl: await readPng(file), durationMs }); }
    return connection.exportWalkthrough({ frames }, { signal });
  });
  $('#media-export-cancel').onclick = () => { active?.abort(); update('Export canceled.'); };
}

globalThis.addEventListener?.('beforeunload', disconnectMediaExport);
