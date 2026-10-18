const installations = new WeakMap();
const properties = ['--common-viewport-height', '--common-viewport-top', '--common-keyboard-inset'];

function textInputFocused(document) {
  let active = document?.activeElement;
  // Focus can be inside the SDK's shadow tree and then its same-origin iframe.
  // A redirected or third-party frame is deliberately treated as opaque.
  for (let depth = 0; active && depth < 12; depth++) {
    let nested;
    try { nested = active.shadowRoot?.activeElement || active.contentDocument?.activeElement; } catch {}
    if (!nested || nested === active) break;
    active = nested;
  }
  if (!active || active.disabled || active.readOnly) return false;
  if (active.isContentEditable || active.tagName === 'TEXTAREA') return true;
  return active.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(active.type);
}

/** Keep app chrome inside the visible viewport without overriding browser zoom.
 * The returned cleanup also exposes refresh() for focus changes in child frames.
 * Pass targetElement for an isolated SDK overlay; inline mounts need no observer.
 */
export function installMobileViewport({ windowImpl = window, documentImpl = document, targetElement = documentImpl.documentElement, onChange = () => {} } = {}) {
  if (!targetElement?.style || !windowImpl?.addEventListener) return Object.assign(() => {}, { refresh() {} });
  let installation = installations.get(targetElement);
  if (!installation) {
    const listeners = new Set();
    const viewport = windowImpl.visualViewport;
    let parentWindow, parentViewport, parentDocument;
    // A same-origin embedded frame is resized by its host overlay when the
    // keyboard opens. Its own visual and layout viewports then match, so only
    // the parent's viewport can reveal why space disappeared. Keep all sizing
    // in this frame's coordinates and use the parent solely for keyboard state.
    try {
      if (windowImpl.parent && windowImpl.parent !== windowImpl) {
        parentWindow = windowImpl.parent;
        parentDocument = parentWindow.document;
        parentViewport = parentWindow.visualViewport;
      }
    } catch { parentWindow = parentViewport = parentDocument = null; }
    const previous = properties.map(name => [name, targetElement.style.getPropertyValue(name), targetElement.style.getPropertyPriority(name)]);
    const previousClass = targetElement.classList.contains('common-keyboard-open');
    const request = windowImpl.requestAnimationFrame.bind(windowImpl);
    const cancel = windowImpl.cancelAnimationFrame.bind(windowImpl);
    let frame = null, last, disposed = false;
    const update = () => {
      frame = null;
      if (disposed) return;
      const layoutHeight = Math.max(windowImpl.innerHeight || 0, documentImpl.documentElement?.clientHeight || 0);
      const normalZoom = !viewport || !Number.isFinite(viewport.scale) || Math.abs(viewport.scale - 1) < 0.05;
      const height = normalZoom && viewport?.height > 0 ? viewport.height : layoutHeight;
      const top = normalZoom && Number.isFinite(viewport?.offsetTop) ? Math.max(0, viewport.offsetTop) : 0;
      const occlusion = Math.max(0, layoutHeight - height - top);
      // Browser toolbars and ordinary landscape layouts are not keyboards.
      // Requiring both text focus and a substantial actual occlusion also avoids
      // interpreting a resized desktop window as an on-screen keyboard.
      const focused = textInputFocused(documentImpl);
      const localKeyboard = occlusion > Math.max(100, Math.min(160, layoutHeight * 0.18));
      const parentHeight = parentWindow ? Math.max(parentWindow.innerHeight || 0, parentDocument.documentElement?.clientHeight || 0) : 0;
      const parentNormalZoom = parentViewport && (!Number.isFinite(parentViewport.scale) || Math.abs(parentViewport.scale - 1) < 0.05);
      const parentOcclusion = parentNormalZoom ? Math.max(0, parentHeight - parentViewport.height - Math.max(0, parentViewport.offsetTop || 0)) : 0;
      const parentKeyboard = parentOcclusion > Math.max(100, Math.min(160, parentHeight * 0.18)) && documentImpl.hasFocus?.() !== false;
      const keyboardOpen = normalZoom && focused && (localKeyboard || parentKeyboard);
      const keyboardInset = keyboardOpen && localKeyboard ? occlusion : 0;
      const state = { height, top, keyboardInset, keyboardOpen };
      if (last && Object.keys(state).every(key => state[key] === last[key])) return;
      last = state;
      targetElement.style.setProperty(properties[0], `${height}px`);
      targetElement.style.setProperty(properties[1], `${top}px`);
      targetElement.style.setProperty(properties[2], `${keyboardInset}px`);
      targetElement.classList.toggle('common-keyboard-open', keyboardOpen);
      for (const callback of listeners) { try { callback({ ...state }); } catch {} }
    };
    const refresh = () => { if (!disposed && frame === null) frame = request(update); };
    for (const type of ['resize', 'orientationchange', 'focus', 'blur']) windowImpl.addEventListener(type, refresh);
    for (const type of ['focusin', 'focusout']) documentImpl.addEventListener(type, refresh);
    for (const type of ['resize', 'scroll']) viewport?.addEventListener(type, refresh);
    for (const type of ['resize', 'scroll']) parentViewport?.addEventListener(type, refresh);
    installation = {
      listeners, refresh, get state() { return last; },
      dispose() {
        disposed = true;
        if (frame !== null) cancel(frame);
        for (const type of ['resize', 'orientationchange', 'focus', 'blur']) windowImpl.removeEventListener(type, refresh);
        for (const type of ['focusin', 'focusout']) documentImpl.removeEventListener(type, refresh);
        for (const type of ['resize', 'scroll']) viewport?.removeEventListener(type, refresh);
        for (const type of ['resize', 'scroll']) parentViewport?.removeEventListener(type, refresh);
        for (const [name, value, priority] of previous) {
          if (value) targetElement.style.setProperty(name, value, priority);
          else targetElement.style.removeProperty(name);
        }
        targetElement.classList.toggle('common-keyboard-open', previousClass);
        installations.delete(targetElement);
      },
    };
    installations.set(targetElement, installation);
    update();
  }
  // Each mount gets an independent subscription, including identical callbacks.
  const callback = state => onChange(state);
  installation.listeners.add(callback);
  if (installation.state) { try { callback({ ...installation.state }); } catch {} }
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false; installation.listeners.delete(callback);
    if (!installation.listeners.size) installation.dispose();
  };
  cleanup.refresh = installation.refresh;
  return cleanup;
}
