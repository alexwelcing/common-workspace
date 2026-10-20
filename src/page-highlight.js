import './page-highlight.css';

const DEFAULT_DURATION_MS = 8000;
const MAX_DURATION_MS = 30000;
const invalid = message => Object.assign(new Error(message), { code: 'SOURCE_INVALID' });
const unavailable = () => Object.assign(new Error('The shared tab is not visible yet. Open its live view and try highlighting again.'), { code: 'SOURCE_TARGET_NOT_VISIBLE' });

function normalizedRect(value) {
  const keys = ['x', 'y', 'width', 'height'];
  if (!value || keys.some(key => !Number.isFinite(value[key]))) throw invalid('Use finite normalized target bounds.');
  const { x, y, width, height } = value;
  if (x < 0 || x >= 1 || y < 0 || y >= 1 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
    throw invalid('The target must be inside the shared page viewport.');
  }
  return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
}

function highlightLabel(value) {
  if (typeof value !== 'string' || value.length > 120) throw invalid('Use a target label of at most 120 characters.');
  return value;
}

/** A local visual cue. The source service owns capture verification and access. */
export function createPageHighlight({ getBoard, getStream } = {}) {
  if (typeof getBoard !== 'function' || typeof getStream !== 'function') throw new TypeError('Page highlights need board and stream getters.');
  let current = null;
  let destroyed = false;

  function clear() {
    const entry = current;
    if (!entry) return;
    current = null;
    entry.window.clearTimeout(entry.timer);
    if (entry.frameRequest !== null) entry.window.cancelAnimationFrame(entry.frameRequest);
    entry.resizeObserver?.disconnect();
    entry.nodeObserver?.disconnect();
    entry.removeVideoListeners?.();
    entry.window.removeEventListener('resize', entry.schedule);
    entry.track?.removeEventListener('ended', entry.clear);
    entry.layer.remove();
  }

  function resolveScreen(board, screenId) {
    const node = board?.nodes?.get?.(screenId) || [...(board?.el?.querySelectorAll?.('[data-entity-id]') || [])]
      .find(item => item.dataset.entityId === screenId);
    const frame = node?.querySelector('.board-screen-frame');
    const video = frame?.querySelector('video');
    const stream = getStream();
    if (!board?.el?.contains(node) || !frame || !video || video.hidden || !stream || video.srcObject !== stream) throw unavailable();
    return { node, frame, video, stream };
  }

  function videoRect(frame, video, stream) {
    const settings = stream.getVideoTracks?.()[0]?.getSettings?.() || {};
    const sourceWidth = video.videoWidth || settings.width;
    const sourceHeight = video.videoHeight || settings.height;
    const width = video.clientWidth || frame.clientWidth;
    const height = video.clientHeight || frame.clientHeight;
    if (!(sourceWidth > 0 && sourceHeight > 0 && width > 0 && height > 0)) throw unavailable();
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const fittedWidth = sourceWidth * scale;
    const fittedHeight = sourceHeight * scale;
    return {
      x: video.offsetLeft + (width - fittedWidth) / 2,
      y: video.offsetTop + (height - fittedHeight) / 2,
      width: fittedWidth, height: fittedHeight,
    };
  }

  function paint(entry) {
    if (current !== entry) return;
    try {
      if (getBoard() !== entry.board) throw unavailable();
      const screen = resolveScreen(entry.board, entry.screenId);
      if (screen.node !== entry.node) throw unavailable();
      if (screen.frame !== entry.frame || screen.video !== entry.video) bindFrame(entry, screen);
      const fitted = videoRect(entry.frame, entry.video, screen.stream);
      const left = fitted.x + entry.bounds.x * fitted.width;
      const top = fitted.y + entry.bounds.y * fitted.height;
      Object.assign(entry.box.style, {
        left: `${left}px`, top: `${top}px`,
        width: `${entry.bounds.width * fitted.width}px`, height: `${entry.bounds.height * fitted.height}px`,
      });
      entry.label.style.maxWidth = `${Math.max(1, Math.min(240, entry.frame.clientWidth - 12))}px`;
      entry.label.style.left = `${Math.max(6, Math.min(left, entry.frame.clientWidth - entry.label.offsetWidth - 6))}px`;
      entry.label.style.top = `${top >= entry.label.offsetHeight + 8 ? top - entry.label.offsetHeight - 6 : top + 6}px`;
    } catch { clear(); }
  }

  function bindFrame(entry, screen) {
    entry.resizeObserver?.disconnect();
    entry.removeVideoListeners?.();
    entry.frame = screen.frame;
    entry.video = screen.video;
    entry.frame.append(entry.layer);
    entry.resizeObserver?.observe(entry.frame);
    entry.video.addEventListener('loadedmetadata', entry.schedule);
    entry.video.addEventListener('resize', entry.schedule);
    entry.removeVideoListeners = () => {
      screen.video.removeEventListener('loadedmetadata', entry.schedule);
      screen.video.removeEventListener('resize', entry.schedule);
    };
  }

  function show({ screenId, normalizedBounds, label = '', durationMs = DEFAULT_DURATION_MS } = {}) {
    if (destroyed) throw Object.assign(new Error('Page highlights have closed.'), { code: 'SOURCE_UNAVAILABLE' });
    if (typeof screenId !== 'string' || !screenId || screenId.length > 100) throw invalid('Choose a current shared screen object.');
    if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > MAX_DURATION_MS) throw invalid('Highlight duration must be between one and thirty seconds.');
    const bounds = normalizedRect(normalizedBounds);
    const text = highlightLabel(label);
    const board = getBoard();
    const screen = resolveScreen(board, screenId);
    videoRect(screen.frame, screen.video, screen.stream);
    const document = screen.node.ownerDocument;
    const window = document.defaultView;
    const layer = document.createElement('div'); layer.className = 'common-page-highlight';
    layer.setAttribute('aria-hidden', 'true'); layer.inert = true;
    const box = document.createElement('div'); box.className = 'common-page-highlight-box';
    const caption = document.createElement('span'); caption.className = 'common-page-highlight-label'; caption.textContent = text;
    caption.hidden = !text; layer.append(box, caption);
    clear();
    const entry = { board, screenId, node: screen.node, frame: screen.frame, video: screen.video,
      window, layer, box, label: caption, bounds, frameRequest: null };
    current = entry;
    entry.clear = () => { if (current === entry) clear(); };
    entry.schedule = () => {
      if (current !== entry || entry.frameRequest !== null) return;
      entry.frameRequest = window.requestAnimationFrame(() => { entry.frameRequest = null; paint(entry); });
    };
    if (typeof window.ResizeObserver === 'function') entry.resizeObserver = new window.ResizeObserver(entry.schedule);
    if (typeof window.MutationObserver === 'function') {
      // The board can replace a screen's video after a stream or title update.
      // Observe the card, not the overlay's children, so our own cue cannot loop.
      entry.nodeObserver = new window.MutationObserver(entry.schedule);
      entry.nodeObserver.observe(entry.node, { childList: true, attributes: true, attributeFilter: ['style'] });
      if (entry.node.parentNode) entry.nodeObserver.observe(entry.node.parentNode, { childList: true });
    }
    bindFrame(entry, screen);
    window.addEventListener('resize', entry.schedule);
    entry.track = screen.stream.getVideoTracks?.()[0];
    entry.track?.addEventListener('ended', entry.clear);
    entry.timer = window.setTimeout(entry.clear, durationMs);
    paint(entry);
    if (current !== entry) throw unavailable();
    return { screenId, durationMs };
  }

  function update({ normalizedBounds, label } = {}) {
    if (!current || destroyed) return false;
    const bounds = normalizedRect(normalizedBounds);
    if (label !== undefined) {
      const text = highlightLabel(label);
      if (current.label.textContent !== text) current.label.textContent = text;
      current.label.hidden = !text;
    }
    current.bounds = bounds;
    paint(current);
    return current !== null;
  }

  return Object.freeze({ show, update, clear, destroy() { if (destroyed) return; destroyed = true; clear(); } });
}
