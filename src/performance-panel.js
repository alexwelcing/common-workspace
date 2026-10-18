import './performance-panel.css';
import { createPerformanceReport } from './performance-index.js';

const statusLabels = {
  warming: 'Gathering measurements',
  healthy: 'Running comfortably',
  strained: 'Some strain',
  poor: 'Running slowly',
  paused: 'Measurement paused',
};
const contextLabels = {
  objects: 'Canvas objects',
  boards: 'Boards',
  participants: 'People',
  peerConnections: 'Peer connections',
  watchedWindows: 'Windows watched',
  queuedBytes: 'Waiting to sync',
  bufferedBytes: 'Connection buffer',
  historyBytes: 'Serialized history',
};
const signalCoverage = {
  'main-thread-delay': 'heartbeat',
  'long-task-blocking': 'longTasks',
  'frame-stalls': 'frames',
  'interaction-latency': 'interactions',
};
const finite = value => typeof value === 'number' && Number.isFinite(value);
const scoreValue = value => finite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
const statusValue = value => Object.hasOwn(statusLabels, value) ? value : 'warming';
const wholeNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const decimalNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const number = value => finite(value) ? (value < 10 ? decimalNumber : wholeNumber).format(value) : '—';

function duration(value) {
  if (!finite(value)) return '—';
  if (value < 1000) return `${number(value)} ms`;
  if (value < 60000) return `${number(value / 1000)} s`;
  return `${number(value / 60000)} min`;
}

function bytes(value) {
  if (!finite(value)) return '—';
  if (value < 1024) return `${number(value)} B`;
  if (value < 1024 * 1024) return `${number(value / 1024)} KB`;
  return `${number(value / (1024 * 1024))} MB`;
}

function metricValue(value, unit) {
  if (!finite(value)) return '—';
  if (unit === 'ms') return duration(value);
  if (unit === '%') return `${number(value)}%`;
  return `${number(value)}${unit ? ` ${unit}` : ''}`;
}

function setText(element, value) {
  const next = String(value ?? '');
  if (element.textContent !== next) element.textContent = next;
}

function element(document, tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

// Keyed rows avoid replacing the dialog (or a focused control) every second.
function reconcileRows(parent, values, keyFor, create, update) {
  const existing = new Map([...parent.children].map(node => [node.dataset.key, node]));
  values.forEach((value, index) => {
    const key = String(keyFor(value, index));
    const row = existing.get(key) || create(value);
    row.dataset.key = key;
    update(row, value);
    if (parent.children[index] !== row) parent.insertBefore(row, parent.children[index] || null);
    existing.delete(key);
  });
  for (const row of existing.values()) row.remove();
}

/** A quiet signal on existing menu controls; it never creates another button. */
export function bindPerformanceIndicator({ monitor, trigger, item }) {
  const document = trigger?.ownerDocument || item?.ownerDocument;
  if (!document) return () => {};
  const bead = element(document, 'span', 'performance-indicator-bead');
  bead.setAttribute('aria-hidden', 'true');
  bead.hidden = true;
  const copy = element(document, 'span', 'performance-indicator-copy');
  const ownedTriggerClass = trigger && !trigger.classList.contains('performance-indicator-trigger');
  if (trigger) {
    trigger.classList.add('performance-indicator-trigger');
    trigger.append(bead);
  }
  if (item) item.append(copy);
  let lastState = '', closed = false;
  function update(snapshot) {
    if (closed) return;
    const score = scoreValue(snapshot?.score), status = statusValue(snapshot?.status);
    const state = `${score}:${status}`;
    if (state === lastState) return;
    lastState = state;
    bead.hidden = status !== 'strained' && status !== 'poor';
    bead.dataset.status = status;
    copy.dataset.status = status;
    const shortStatus = { warming: 'Warming up', healthy: 'Healthy', strained: 'Strained', poor: 'Slow', paused: 'Paused' }[status];
    setText(copy, score === null || status === 'warming' || status === 'paused' ? shortStatus : `${score} / 100 · ${shortStatus}`);
  }
  update(monitor.snapshot());
  const unsubscribe = monitor.subscribe(update);
  return () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    bead.remove();
    copy.remove();
    if (ownedTriggerClass) trigger.classList.remove('performance-indicator-trigger');
  };
}

/**
 * The caller owns the modal and must run the returned cleanup when it closes or
 * replaces it. All reports stay on this device unless the user shares a file.
 */
export function openPerformancePanel({ monitor, modal, onDownload }) {
  modal(`<div class="performance-panel" id="common-performance-panel">
    <h2 id="modal-title" tabindex="-1">Performance</h2>
    <p class="performance-intro">A live view of how Common is running in this browser.</p>
    <section class="performance-summary" aria-label="Performance index">
      <div class="performance-score" aria-hidden="true"><strong data-performance-score>—</strong><span data-performance-denominator>/ 100</span></div>
      <div class="performance-summary-copy"><strong data-performance-status>Gathering measurements</strong><p data-performance-window></p><meter data-performance-meter min="0" max="100" low="50" high="80" optimum="100" value="0" aria-label="Performance index" hidden></meter></div>
    </section>
    <p class="performance-explanation" data-performance-explanation></p>
    <section class="performance-section" aria-labelledby="performance-signals-title">
      <h3 id="performance-signals-title">Measured here</h3>
      <table class="performance-table"><caption class="performance-sr-only">Responsiveness measurements in this browser</caption><thead><tr><th scope="col">Signal</th><th scope="col">Observed</th><th scope="col">Comfort guide</th></tr></thead><tbody data-performance-signals></tbody></table>
      <p class="performance-note" data-performance-coverage></p>
    </section>
    <section class="performance-section" aria-labelledby="performance-causes-title">
      <h3 id="performance-causes-title">Likely contributors</h3>
      <ul class="performance-causes" data-performance-causes></ul>
      <p class="performance-note" data-performance-no-causes></p>
    </section>
    <section class="performance-section" aria-labelledby="performance-operations-title">
      <h3 id="performance-operations-title">Measured work</h3>
      <table class="performance-table performance-operation-table" data-performance-operation-table><caption class="performance-sr-only">Time spent on Common operations</caption><thead><tr><th scope="col">Operation</th><th scope="col">Median / p95</th><th scope="col">Peak</th></tr></thead><tbody data-performance-operations></tbody></table>
      <p class="performance-note" data-performance-no-operations></p>
      <p class="performance-note">p95 is the time that 95% of measured runs stayed below. Slow work is a clue, not proof of a cause.</p>
    </section>
    <section class="performance-section" aria-labelledby="performance-context-title">
      <h3 id="performance-context-title">Current workload</h3>
      <dl class="performance-context" data-performance-context></dl>
      <p class="performance-note" data-performance-no-context></p>
      <p class="performance-note">These counts provide context. More objects or people do not lower the index by themselves.</p>
    </section>
    <footer class="performance-footer"><p>Measurements stay in this tab. Reports exclude canvas content, names, room identifiers, and credentials.</p><div class="performance-actions"><button class="button performance-download" type="button" data-performance-download>Download report</button><button class="performance-reset" type="button" data-performance-reset>Start fresh</button></div><p class="performance-feedback" data-performance-feedback role="status" aria-live="polite"></p><p class="performance-note">Start fresh clears measurements only. Your canvas stays as it is.</p></footer>
    <span class="performance-sr-only" data-performance-announcement role="status" aria-live="polite"></span>
  </div>`);
  const root = globalThis.document.getElementById('common-performance-panel');
  if (!root) return () => {};
  const dialog = root.closest('.modal');
  dialog?.classList.add('performance-dialog');
  const document = root.ownerDocument, window = document.defaultView;
  // Enter at the visible title instead of leaving keyboard focus on an action
  // below the fold. The modal still owns Tab containment and Escape dismissal.
  root.querySelector('#modal-title').focus({ preventScroll: true });
  const events = new AbortController();
  const find = name => root.querySelector(`[data-performance-${name}]`);
  const nodes = Object.fromEntries([
    'score', 'denominator', 'status', 'window', 'meter', 'explanation', 'signals', 'coverage', 'causes', 'no-causes',
    'operation-table', 'operations', 'no-operations', 'context', 'no-context', 'download', 'reset', 'feedback', 'announcement',
  ].map(name => [name, find(name)]));
  let closed = false, timer = null, revokeTimer = null, objectUrl = null;
  let lastPaint = 0, pending = null, lastStatus = null;

  function render(snapshot) {
    if (closed || !root.isConnected) return;
    const score = scoreValue(snapshot.score), status = statusValue(snapshot.status);
    const hasIndex = score !== null && status !== 'warming' && status !== 'paused';
    root.dataset.status = status;
    setText(nodes.score, hasIndex ? score : '—');
    nodes.denominator.hidden = !hasIndex;
    setText(nodes.status, statusLabels[status]);
    setText(nodes.window, `${duration(snapshot.observedMs)} observed · rolling ${duration(snapshot.windowMs)} window`);
    nodes.meter.hidden = !hasIndex;
    if (hasIndex) nodes.meter.value = score;
    setText(nodes.explanation, status === 'paused'
      ? 'Observation pauses when this page is hidden. Return to the canvas to continue measuring.'
      : status === 'warming'
        ? 'Keep using the canvas while the index gathers a few seconds of visible activity. Missing measurements never count as healthy.'
        : 'The index follows the weakest measured responsiveness signal or critical operation. It describes this browser, not every participant or the server.');
    if (status !== lastStatus) {
      if (lastStatus !== null) setText(nodes.announcement, statusLabels[status]);
      lastStatus = status;
    }

    const signals = Array.isArray(snapshot.signals) ? snapshot.signals : [];
    reconcileRows(nodes.signals, signals, signal => signal.key, () => {
      const row = element(document, 'tr');
      const label = element(document, 'th');
      label.scope = 'row';
      const observed = element(document, 'td');
      observed.append(element(document, 'span'), element(document, 'small'));
      row.append(label, observed, element(document, 'td', 'performance-guide'));
      return row;
    }, (row, signal) => {
      setText(row.children[0], signal.label || signal.key);
      const available = finite(signal.value);
      const supported = snapshot.coverage?.[signalCoverage[signal.key]];
      const signalScore = scoreValue(signal.score);
      setText(row.children[1].children[0], available ? metricValue(signal.value, signal.unit) : supported === false ? 'Unavailable' : signal.samples > 0 ? 'More samples needed' : 'Not observed yet');
      const sampleDetail = signal.statistic === 'maximum' ? 'Slowest run'
        : signal.statistic === 'p95' || ['main-thread-delay', 'interaction-latency'].includes(signal.key) ? `p95 · ${number(signal.samples)} samples`
          : signal.key === 'frame-stalls' ? `${number(signal.samples)} active frames`
            : signal.key === 'long-task-blocking' ? `${number(signal.count)} long tasks` : '';
      setText(row.children[1].children[1], available ? sampleDetail : '');
      row.children[1].dataset.state = available && signalScore !== null ? signalScore < 50 ? 'poor' : signalScore < 80 ? 'strained' : 'healthy' : 'unknown';
      const good = signal.threshold?.good;
      setText(row.children[2], finite(good) ? `≤ ${metricValue(good, signal.unit)}` : '—');
    });
    const measured = signals.filter(signal => finite(signal.value)).length;
    setText(nodes.coverage, `${measured} of ${signals.length} signals measured. Browser support and activity determine what is available.`);

    const causes = Array.isArray(snapshot.causes) ? snapshot.causes.slice(0, 4) : [];
    reconcileRows(nodes.causes, causes, cause => cause.key, () => {
      const row = element(document, 'li');
      row.append(element(document, 'strong'), element(document, 'p'), element(document, 'p', 'performance-suggestion'));
      return row;
    }, (row, cause) => {
      setText(row.children[0], cause.label);
      setText(row.children[1], cause.detail);
      setText(row.children[2], cause.suggestion);
    });
    nodes['no-causes'].hidden = causes.length > 0;
    setText(nodes['no-causes'], hasIndex && status === 'healthy' ? 'No pressure stands out in the current measurement window.' : 'No contributor has enough evidence yet. Keep using the canvas and check the measurements above.');

    const operations = Array.isArray(snapshot.operations) ? snapshot.operations : [];
    nodes['operation-table'].hidden = operations.length === 0;
    nodes['no-operations'].hidden = operations.length > 0;
    setText(nodes['no-operations'], 'No timed work in this window yet. Editing, syncing, and exporting will add measurements as they happen.');
    reconcileRows(nodes.operations, operations, operation => operation.name, () => {
      const row = element(document, 'tr');
      const label = element(document, 'th');
      label.scope = 'row';
      label.append(element(document, 'span'), element(document, 'small'));
      row.append(label, element(document, 'td'), element(document, 'td'));
      return row;
    }, (row, operation) => {
      setText(row.children[0].children[0], operation.label || operation.name);
      setText(row.children[0].children[1], `${number(operation.count)} runs${operation.failures ? ` · ${number(operation.failures)} failed` : ''}`);
      setText(row.children[1], `${duration(operation.p50Ms)} / ${duration(operation.p95Ms)}`);
      setText(row.children[2], duration(operation.maxMs));
    });

    const context = Object.entries(contextLabels).filter(([key]) => finite(snapshot.context?.[key]));
    nodes['no-context'].hidden = context.length > 0;
    setText(nodes['no-context'], 'Workload counts are not available in this view yet.');
    reconcileRows(nodes.context, context, ([key]) => key, () => {
      const row = element(document, 'div');
      row.append(element(document, 'dt'), element(document, 'dd'));
      return row;
    }, (row, [key, label]) => {
      setText(row.children[0], label);
      setText(row.children[1], key.endsWith('Bytes') ? bytes(snapshot.context[key]) : number(snapshot.context[key]));
    });
  }

  // Core notifications also include visibility/reset changes. Coalesce those
  // with regular samples so this diagnostic view itself stays inexpensive.
  function requestRender(snapshot) {
    if (closed) return;
    pending = snapshot;
    if (timer !== null) return;
    const wait = Math.max(0, 1000 - (Date.now() - lastPaint));
    const paint = () => {
      timer = null;
      if (closed) return;
      lastPaint = Date.now();
      const next = pending;
      pending = null;
      if (next) render(next);
    };
    if (wait === 0) paint(); else timer = window.setTimeout(paint, wait);
  }

  function releaseDownload() {
    if (revokeTimer !== null) window.clearTimeout(revokeTimer);
    revokeTimer = null;
    if (objectUrl) window.URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  nodes.download.addEventListener('click', async () => {
    if (closed || nodes.download.disabled) return;
    nodes.download.disabled = true;
    setText(nodes.feedback, '');
    try {
      const snapshot = monitor.snapshot();
      if (onDownload) await onDownload(snapshot);
      else {
        // Snapshot is the monitor's numeric/label allowlist. Never serialize
        // application state, browser location, or arbitrary performance entries.
        const { version, score, status, windowMs, observedMs, coverage, signals, operations, context, causes, recent } = snapshot;
        const report = createPerformanceReport({ version, score, status, windowMs, observedMs, coverage, signals, operations, context, causes, recent });
        releaseDownload();
        objectUrl = window.URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
        const link = element(document, 'a');
        link.href = objectUrl;
        link.download = 'common-performance-report.json';
        link.click();
        revokeTimer = window.setTimeout(releaseDownload, 1000);
      }
      if (!closed) setText(nodes.feedback, 'Performance report prepared. Share the file when you need help investigating.');
    } catch {
      if (!closed) setText(nodes.feedback, 'The report could not be downloaded. Try again.');
    } finally {
      if (!closed) nodes.download.disabled = false;
    }
  }, { signal: events.signal });
  nodes.reset.addEventListener('click', () => {
    monitor.reset();
    requestRender(monitor.snapshot());
    setText(nodes.feedback, 'Measurements cleared. Gathering a fresh window; your canvas is unchanged.');
  }, { signal: events.signal });
  requestRender(monitor.snapshot());
  const unsubscribe = monitor.subscribe(requestRender);
  return () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    events.abort();
    if (timer !== null) window.clearTimeout(timer);
    pending = null;
    releaseDownload();
    dialog?.classList.remove('performance-dialog');
  };
}
