const WINDOW_MS = 60_000;
const HEARTBEAT_MS = 1_000;
const WARMUP_MS = 5_000;
const FRAME_ACTIVITY_MS = 2_000;
const MAX_DURATION_MS = WINDOW_MS;
const MAX_OPERATION_SAMPLES = 256;
const MAX_OBSERVER_SAMPLES = 256;

// These are diagnostic budgets, not device benchmarks. Asynchronous work can
// explain waiting, but only synchronous work contributes to responsiveness.
const OPERATIONS = Object.freeze({
  'canvas-render': { label: 'Canvas render', good: 16, poor: 100, critical: true, suggestion: 'Reduce visible objects or split a large canvas update across frames.' },
  'spatial-render': { label: 'Spatial view render', good: 16, poor: 100, critical: true, suggestion: 'Reduce visible boards or avoid rebuilding unchanged spatial surfaces.' },
  'state-projection': { label: 'Object projection', good: 16, poor: 100, critical: true, suggestion: 'Inspect changed object counts and reuse unchanged board and object projections.' },
  'spatial-edit': { label: 'Spatial edit', good: 16, poor: 100, critical: true, suggestion: 'Group repeated changes and reduce the amount of document work per gesture.' },
  'history-read': { label: 'History read', good: 50, poor: 250, critical: true, suggestion: 'Reduce repeated historical reconstruction and keep the selected revision cached.' },
  'peer-sync': { label: 'Peer synchronization', good: 25, poor: 150, critical: true, suggestion: 'Inspect update sizes and avoid applying a large batch of peer changes in one turn.' },
  autosave: { label: 'Device autosave', good: 100, poor: 1_000, suggestion: 'Check device storage pressure and reduce the amount written per autosave.' },
  'archive-export': { label: 'Replay export', good: 1_000, poor: 5_000, suggestion: 'Inspect replay size and compress or process large documents in smaller batches.' },
  'archive-import': { label: 'Replay import', good: 1_000, poor: 5_000, suggestion: 'Inspect replay size and the amount of history being restored.' },
  request: { label: 'Session request', suggestion: 'Check connection diagnostics and the application’s readable errors.' },
});

const CONTEXT_KEYS = [
  'objects', 'boards', 'participants', 'peerConnections', 'watchedWindows',
  'queuedBytes', 'bufferedBytes', 'historyBytes',
];

const SIGNALS = [
  { key: 'main-thread-delay', label: 'Main-thread delay', unit: 'ms', good: 50, poor: 250, suggestion: 'Look for slow canvas, document, or synchronization work below.' },
  { key: 'long-task-blocking', label: 'Long-task blocking', unit: 'ms/s', good: 10, poor: 100, suggestion: 'Split long synchronous work into smaller batches so input can run between them.' },
  { key: 'frame-stalls', label: 'Active frame stalls', unit: '%', good: 1, poor: 10, suggestion: 'Reduce work during dragging, drawing, and navigation, especially repeated rendering.' },
  { key: 'interaction-latency', label: 'Observed slow interactions', unit: 'ms', good: 200, poor: 500, suggestion: 'Inspect work triggered by input. This measures observed Event Timing entries, not standard INP.' },
];

const noOp = () => {};
const boundedNumber = (value, maximum = Number.MAX_SAFE_INTEGER) => Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : null;
const rounded = value => value === null ? null : Math.round(value * 10) / 10;
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
const budgetScore = (value, good, poor) => value === null ? null : Math.round(Math.max(0, Math.min(100, 100 * (poor - value) / (poor - good))));

/**
 * Local, bounded operational measurements. No payloads, URLs, DOM targets,
 * identifiers, arbitrary metric names, or error messages enter this collector.
 * A score is the worst measured responsiveness signal, never an average that
 * hides one bad signal. It is a troubleshooting index, not a benchmark.
 */
export function createPerformanceIndex({
  windowImpl = globalThis.window,
  documentImpl = windowImpl?.document || globalThis.document,
  now,
} = {}) {
  const clock = now || (() => windowImpl?.performance?.now?.() ?? globalThis.performance?.now?.() ?? Date.now());
  const timers = windowImpl?.setTimeout ? windowImpl : globalThis;
  const requestFrame = windowImpl?.requestAnimationFrame?.bind(windowImpl);
  const cancelFrame = windowImpl?.cancelAnimationFrame?.bind(windowImpl);
  const observers = [];
  const listeners = [];
  const subscribers = new Set();
  // Absence of a measurement is different from an observed empty workload.
  const context = Object.fromEntries(CONTEXT_KEYS.map(key => [key, null]));
  const samples = Object.fromEntries(Object.keys(OPERATIONS).map(name => [name, []]));
  const delays = [];
  const longTasks = [];
  const interactions = [];
  const frameBuckets = [];
  const visibleSpans = [];
  const recent = [];
  const supported = { heartbeat: true, longTasks: false, interactions: false, frames: Boolean(requestFrame && cancelFrame) };
  let lastClock = 0;
  let destroyed = false;
  let externallyVisible = true;
  let active = false;
  let visibleSince = 0;
  let resetAt = readNow();
  let generation = 0;
  let visibilityGeneration = 0;
  let heartbeatTimer = null;
  let heartbeatAt = 0;
  let frame = null;
  let frameUntil = 0;
  let previousFrameAt = null;

  function readNow() {
    let value;
    try { value = clock(); } catch { value = lastClock; }
    if (Number.isFinite(value)) lastClock = Math.max(lastClock, value);
    return lastClock;
  }

  function prune(records, at, limit) {
    const cutoff = at - WINDOW_MS;
    let first = 0;
    while (first < records.length && records[first].at < cutoff) first++;
    if (first) records.splice(0, first);
    if (records.length > limit) records.splice(0, records.length - limit);
  }

  function append(records, entry, limit) {
    records.push(entry);
    prune(records, entry.at, limit);
  }

  function observedMs(at) {
    const cutoff = Math.max(resetAt, at - WINDOW_MS);
    let observed = active ? Math.max(0, at - Math.max(cutoff, visibleSince)) : 0;
    for (const span of visibleSpans) observed += Math.max(0, span.end - Math.max(cutoff, span.start));
    return Math.min(WINDOW_MS, observed);
  }

  function pruneAll(at) {
    for (const records of Object.values(samples)) prune(records, at, MAX_OPERATION_SAMPLES);
    prune(delays, at, 90);
    prune(longTasks, at, 61);
    prune(interactions, at, MAX_OBSERVER_SAMPLES);
    prune(frameBuckets, at, 61);
    prune(recent, at, 61);
    while (visibleSpans.length && visibleSpans[0].end < at - WINDOW_MS) visibleSpans.shift();
  }

  function operationRows() {
    return Object.entries(OPERATIONS).flatMap(([name, definition]) => {
      const records = samples[name];
      if (!records.length) return [];
      const values = records.map(record => record.value);
      return [{
        name, label: definition.label, count: records.length,
        p50Ms: rounded(percentile(values, 0.5)), p95Ms: rounded(percentile(values, 0.95)),
        maxMs: rounded(Math.max(...values)), failures: records.filter(record => record.failed).length,
        ...(definition.good ? { budgetMs: definition.good, poorMs: definition.poor } : {}),
        contributesToScore: definition.critical === true,
      }];
    });
  }

  function buildSnapshot(at = readNow()) {
    pruneAll(at);
    const observed = observedMs(at);
    const frameCount = frameBuckets.reduce((total, bucket) => total + bucket.count, 0);
    const frameStalls = frameBuckets.reduce((total, bucket) => total + bucket.stalls, 0);
    const blockingMs = longTasks.reduce((total, entry) => total + entry.blockingMs, 0);
    const longTaskCount = longTasks.reduce((total, entry) => total + entry.count, 0);
    const signalValues = [
      delays.length ? percentile(delays.map(entry => entry.value), 0.95) : null,
      supported.longTasks && observed >= HEARTBEAT_MS ? blockingMs / (observed / 1_000) : null,
      frameCount >= 30 ? frameStalls / frameCount * 100 : null,
      interactions.length ? percentile(interactions.map(entry => entry.value), 0.95) : null,
    ];
    const counts = [delays.length, longTaskCount, frameCount, interactions.length];
    const signals = SIGNALS.map((definition, index) => ({
      key: definition.key, label: definition.label, unit: definition.unit,
      value: rounded(signalValues[index]), score: budgetScore(signalValues[index], definition.good, definition.poor),
      threshold: { good: definition.good, poor: definition.poor }, samples: counts[index],
      ...(definition.key === 'long-task-blocking' ? { count: longTaskCount, blockingMs: rounded(blockingMs) } : {}),
      ...(definition.key === 'frame-stalls' ? { count: frameStalls, stallThresholdMs: 50 } : {}),
    }));
    const operations = operationRows();
    for (const operation of operations) {
      const definition = OPERATIONS[operation.name];
      if (!definition.critical) continue;
      // One severe synchronous stall matters; smaller timings need enough
      // samples before they can lower the index.
      const severe = operation.maxMs >= 250;
      const value = severe ? operation.maxMs : operation.count >= 5 ? operation.p95Ms : null;
      signals.push({
        key: `operation:${operation.name}`, label: `${operation.label} time`, unit: 'ms', value,
        score: budgetScore(value, definition.good, definition.poor), samples: operation.count,
        threshold: { good: definition.good, poor: definition.poor }, statistic: severe ? 'maximum' : 'p95',
      });
    }
    const available = signals.filter(signal => signal.score !== null);
    const score = active && observed >= WARMUP_MS && available.length ? Math.min(...available.map(signal => signal.score)) : null;
    const status = !active ? 'paused' : score === null ? 'warming' : score < 50 ? 'poor' : score < 80 ? 'strained' : 'healthy';
    return {
      version: 1, score, status, windowMs: WINDOW_MS, observedMs: Math.round(observed),
      coverage: {
        ...supported, heartbeatSamples: delays.length, longTaskSamples: longTaskCount,
        interactionSamples: interactions.length, frameSamples: frameCount,
      },
      signals, operations, context: { ...context }, causes: causesFor(signals, operations),
      recent: recent.map(point => ({ atMs: Math.round(point.at - at), score: point.score })),
    };
  }

  function causesFor(signals, operations) {
    const causes = [];
    for (const signal of signals) {
      if (signal.score === null || signal.score >= 80 || signal.key.startsWith('operation:')) continue;
      const definition = SIGNALS.find(item => item.key === signal.key);
      const detail = signal.key === 'long-task-blocking'
        ? `${signal.count} observed long tasks added ${signal.blockingMs} ms of blocking above 50 ms.`
        : signal.key === 'frame-stalls'
          ? `${signal.count} of ${signal.samples} active frame intervals exceeded 50 ms.`
          : `${signal.value} ${signal.unit} across ${signal.samples} observed samples.`;
      causes.push({ key: signal.key, label: signal.label, detail, suggestion: definition.suggestion, priority: signal.score });
    }
    for (const operation of operations) {
      const definition = OPERATIONS[operation.name];
      const severe = definition.critical && operation.maxMs >= 250;
      const score = definition.good ? budgetScore(severe ? operation.maxMs : operation.p95Ms, definition.good, definition.poor) : null;
      if (score !== null && score < 80) {
        causes.push({
          key: `operation:${operation.name}`, label: `Slow ${operation.label.toLowerCase()}`,
          detail: `${operation.p95Ms} ms at the 95th percentile; ${operation.maxMs} ms maximum across ${operation.count} samples.${definition.critical ? '' : ' Includes asynchronous waiting; this alone does not indicate main-thread blocking.'}`,
          suggestion: definition.suggestion, priority: score,
        });
      }
      if (operation.failures) causes.push({
        key: `failure:${operation.name}`, label: `${operation.label} failures`,
        detail: `${operation.failures} of ${operation.count} measured operations reported failure.`,
        suggestion: 'Inspect the application’s readable errors and connection diagnostics for the reason.', priority: 30,
      });
    }
    return causes.sort((a, b) => a.priority - b.priority).slice(0, 6).map(({ priority: _priority, ...cause }) => cause);
  }

  function notify(includeRecent = false) {
    if (destroyed) return;
    const at = readNow();
    const snapshot = buildSnapshot(at);
    if (includeRecent) {
      append(recent, { at, score: snapshot.score }, 61);
      snapshot.recent = recent.map(point => ({ atMs: Math.round(point.at - at), score: point.score }));
    }
    for (const subscriber of Array.from(subscribers)) {
      // Diagnostics must never break the application being observed.
      try { subscriber(snapshot); } catch { /* A consumer owns its rendering errors. */ }
    }
  }

  function scheduleHeartbeat() {
    if (destroyed || !active || heartbeatTimer !== null) return;
    heartbeatAt = readNow();
    const scheduledGeneration = generation;
    const scheduledVisibility = visibilityGeneration;
    heartbeatTimer = timers.setTimeout(() => {
      if (destroyed || generation !== scheduledGeneration || visibilityGeneration !== scheduledVisibility) return;
      heartbeatTimer = null;
      if (!active) return;
      const at = readNow();
      append(delays, { at, value: Math.min(MAX_DURATION_MS, Math.max(0, at - heartbeatAt - HEARTBEAT_MS)) }, 90);
      notify(true);
      scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) timers.clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }

  function stopFrames() {
    if (frame !== null) { try { cancelFrame?.(frame); } catch { /* Optional frame signal. */ } }
    frame = null;
    frameUntil = 0;
    previousFrameAt = null;
  }

  function sampleFrame() {
    frame = null;
    const at = readNow();
    if (destroyed || !active || at > frameUntil) { previousFrameAt = null; return; }
    if (previousFrameAt !== null) {
      const interval = Math.max(0, at - previousFrameAt);
      const bucketAt = Math.floor(at / 1_000) * 1_000;
      let bucket = frameBuckets.at(-1);
      if (!bucket || bucket.at !== bucketAt) {
        bucket = { at: bucketAt, count: 0, stalls: 0 };
        append(frameBuckets, bucket, 61);
      }
      bucket.count++;
      if (interval > 50) bucket.stalls++;
    }
    previousFrameAt = at;
    scheduleFrame();
  }

  function scheduleFrame() {
    const scheduledGeneration = generation;
    const scheduledVisibility = visibilityGeneration;
    try {
      frame = requestFrame(() => {
        if (destroyed || generation !== scheduledGeneration || visibilityGeneration !== scheduledVisibility) return;
        sampleFrame();
      });
    } catch {
      supported.frames = false;
      stopFrames();
    }
  }

  function onActivity() {
    if (!active || destroyed || !supported.frames) return;
    frameUntil = readNow() + FRAME_ACTIVITY_MS;
    if (frame === null) scheduleFrame();
  }

  function updateVisibility() {
    if (destroyed) return;
    const next = externallyVisible && documentImpl?.hidden !== true;
    if (next === active) return;
    const at = readNow();
    visibilityGeneration++;
    if (active) {
      visibleSpans.push({ start: visibleSince, end: at });
      if (visibleSpans.length > 256) visibleSpans.splice(0, visibleSpans.length - 256);
    }
    active = next;
    visibleSince = at;
    stopFrames();
    stopHeartbeat();
    if (active) scheduleHeartbeat();
    notify();
  }

  function listen(target, type, listener, options) {
    try {
      target?.addEventListener?.(type, listener, options);
      listeners.push(() => target?.removeEventListener?.(type, listener, options));
    } catch { /* An unavailable optional browser signal stays unsupported. */ }
  }

  function observe(type, handleEntries, options = {}) {
    const Observer = windowImpl?.PerformanceObserver || globalThis.PerformanceObserver;
    if (typeof Observer !== 'function') return false;
    let observer;
    try {
      const supportedTypes = Observer.supportedEntryTypes;
      if (Array.isArray(supportedTypes) && !supportedTypes.includes(type)) return false;
      observer = new Observer(list => {
        if (destroyed || !active) return;
        const at = readNow();
        // No buffered collection: entries from hidden pages or before reset
        // would misattribute browser throttling to this application.
        let entries;
        try { entries = list.getEntries(); } catch { return; }
        for (const entry of entries) {
          const start = boundedNumber(entry.startTime);
          const duration = boundedNumber(entry.duration, MAX_DURATION_MS);
          if (start === null || duration === null || start < Math.max(resetAt, visibleSince) || start > at) continue;
          handleEntries(entry, { at, value: duration });
        }
      });
      observer.observe({ type, buffered: false, ...options });
      observers.push(observer);
      return true;
    } catch {
      try { observer?.disconnect(); } catch { /* Unsupported observer. */ }
      return false;
    }
  }

  supported.longTasks = observe('longtask', (_entry, record) => {
    const bucketAt = Math.floor(record.at / 1_000) * 1_000;
    let bucket = longTasks.at(-1);
    if (!bucket || bucket.at !== bucketAt) {
      bucket = { at: bucketAt, count: 0, blockingMs: 0 };
      append(longTasks, bucket, 61);
    }
    bucket.count++;
    bucket.blockingMs += Math.max(0, record.value - 50);
  });
  supported.interactions = observe('event', (entry, record) => {
    // Event Timing may omit short interactions. Do not call its observed
    // percentile INP, or store interaction identifiers or event targets.
    if (entry.interactionId > 0) append(interactions, record, MAX_OBSERVER_SAMPLES);
  }, { durationThreshold: 40 });
  listen(documentImpl, 'visibilitychange', updateVisibility);
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel']) listen(documentImpl, type, onActivity, { passive: true, capture: true });
  updateVisibility();

  function record(name, durationMs, { failed = false } = {}) {
    if (destroyed || !active || !Object.hasOwn(OPERATIONS, name)) return;
    const value = boundedNumber(durationMs, MAX_DURATION_MS);
    if (value === null) return;
    append(samples[name], { at: readNow(), value, failed: failed === true }, MAX_OPERATION_SAMPLES);
  }

  function start(name) {
    if (destroyed || !active || !Object.hasOwn(OPERATIONS, name)) return noOp;
    const startedAt = readNow();
    const startedGeneration = generation;
    const startedVisibility = visibilityGeneration;
    let ended = false;
    return (options = {}) => {
      if (ended) return;
      ended = true;
      if (destroyed || generation !== startedGeneration || visibilityGeneration !== startedVisibility) return;
      record(name, readNow() - startedAt, options);
    };
  }

  return {
    start,
    measure(name, work) {
      const end = start(name);
      try {
        const result = work();
        if (result && typeof result.then === 'function') return Promise.resolve(result).then(
          value => { end(); return value; },
          error => { end({ failed: true }); throw error; },
        );
        end();
        return result;
      } catch (error) {
        end({ failed: true });
        throw error;
      }
    },
    record,
    setContext(partial = {}) {
      if (destroyed || !partial || typeof partial !== 'object') return;
      for (const key of CONTEXT_KEYS) {
        const value = boundedNumber(partial[key]);
        if (value !== null) context[key] = Math.round(value);
      }
    },
    snapshot() { return buildSnapshot(); },
    subscribe(listener) {
      if (destroyed || typeof listener !== 'function') return noOp;
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    setVisible(value) {
      externallyVisible = value !== false;
      updateVisibility();
    },
    reset() {
      if (destroyed) return;
      generation++;
      resetAt = readNow();
      visibleSince = resetAt;
      for (const records of [...Object.values(samples), delays, longTasks, interactions, frameBuckets, visibleSpans, recent]) records.length = 0;
      for (const observer of observers) { try { observer.takeRecords?.(); } catch { /* Optional drain. */ } }
      stopFrames();
      stopHeartbeat();
      if (active) scheduleHeartbeat();
      notify();
    },
    destroy() {
      if (destroyed) return;
      if (active) visibleSpans.push({ start: visibleSince, end: readNow() });
      active = false;
      destroyed = true;
      generation++;
      stopFrames();
      stopHeartbeat();
      for (const remove of listeners) { try { remove(); } catch { /* Optional listener. */ } }
      listeners.length = 0;
      for (const observer of observers) { try { observer.disconnect(); } catch { /* Optional observer. */ } }
      observers.length = 0;
      subscribers.clear();
    },
  };
}

/** Add build correlation without allowing metadata to carry identifiers. */
export function createPerformanceReport(snapshot, { buildId, frontendBuildId, experience } = {}) {
  const build = value => typeof value === 'string' ? value.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40) || 'unknown' : 'unknown';
  return {
    type: 'common-performance-report', version: 1, generatedAt: new Date().toISOString(),
    application: {
      buildId: build(buildId), frontendBuildId: build(frontendBuildId),
      experience: ['classic', 'spatial-beta'].includes(experience) ? experience : 'unknown',
    },
    // Callers supply the collector's allowlisted snapshot, never app state.
    performance: snapshot,
  };
}

/** A read-only console aid; teardown restores only the property we installed. */
export function installPerformanceDebugApi(monitor, { windowImpl = globalThis.window } = {}) {
  if (!windowImpl || typeof monitor?.snapshot !== 'function') return noOp;
  const api = Object.freeze({ version: 1, snapshot: () => monitor.snapshot() });
  let previous;
  try {
    previous = Object.getOwnPropertyDescriptor(windowImpl, 'commonPerformance');
    if (previous && !previous.configurable) return noOp;
    Object.defineProperty(windowImpl, 'commonPerformance', { value: api, writable: false, configurable: true, enumerable: false });
  } catch { return noOp; }
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    try {
      if (Object.getOwnPropertyDescriptor(windowImpl, 'commonPerformance')?.value !== api) return;
      if (previous) Object.defineProperty(windowImpl, 'commonPerformance', previous);
      else delete windowImpl.commonPerformance;
    } catch { /* Host ownership may have changed. */ }
  };
}
