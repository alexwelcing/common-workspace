import './workspace-primitives.css';

let nextPanelId = 0;
const disclosureClosers = new WeakMap();
const focusableSelector = 'button, [href], input, select, textarea, summary, [tabindex]';
const popoverViewportInset = 8;
const popoverAnchorGap = 8;

function snapshotAttributes(node, names) {
  return names.map(name => ({ node, name, value: node.getAttribute(name) }));
}

function restoreAttributes(attributes) {
  for (const { node, name, value } of attributes) {
    if (value === null) node.removeAttribute(name);
    else node.setAttribute(name, value);
  }
}

function snapshotStyles(node, names) {
  return names.map(name => ({
    name,
    value: node.style.getPropertyValue(name),
    priority: node.style.getPropertyPriority(name),
  }));
}

function restoreStyles(node, styles) {
  for (const { name, value, priority } of styles) {
    if (value) node.style.setProperty(name, value, priority);
    else node.style.removeProperty(name);
  }
}

function isAvailableControl(node) {
  return !node.matches(':disabled')
    && !node.closest('[hidden], [inert]')
    && node.getAttribute('aria-disabled') !== 'true'
    && node.getClientRects().length > 0;
}

function availableControls(root) {
  return [...root.querySelectorAll(focusableSelector)].filter(isAvailableControl);
}

function viewportBounds(win) {
  const viewport = win.visualViewport;
  const left = (viewport?.offsetLeft || 0) + popoverViewportInset;
  const top = (viewport?.offsetTop || 0) + popoverViewportInset;
  return {
    left,
    top,
    right: left + (viewport?.width || win.innerWidth) - popoverViewportInset * 2,
    bottom: top + (viewport?.height || win.innerHeight) - popoverViewportInset * 2,
  };
}

function alignedCoordinate(start, end, span, size, alignment) {
  if (alignment === 'end') return end - size;
  if (alignment === 'center') return start + (span - size) / 2;
  return start;
}

function hideNativePopover(panel) {
  try {
    panel.hidePopover();
  } catch {
    // A detached surface or one the browser already closed needs no cleanup.
  }
}

/** A short, cancelable entrance/exit. WAAPI owns no lasting inline styles. */
export function animatePanel(panel, { opening = true, duration = 180 } = {}) {
  const win = panel.ownerDocument.defaultView;
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced || typeof panel.animate !== 'function' || !panel.isConnected) {
    return { cancel() {}, finished: Promise.resolve(true) };
  }
  const computed = win.getComputedStyle(panel);
  const transform = computed.transform === 'none' ? '' : `${computed.transform} `;
  const resting = { opacity: computed.opacity, transform: `${transform}translateY(0) scale(1)` };
  const tucked = { opacity: 0, transform: `${transform}translateY(${opening ? 6 : 3}px) scale(.975)` };
  const animation = panel.animate(opening ? [tucked, resting] : [resting, tucked], {
    duration: Math.max(0, Math.min(240, Number(duration) || 0)),
    easing: opening ? 'cubic-bezier(.2,.8,.2,1)' : 'cubic-bezier(.4,0,1,1)',
    fill: 'none',
  });
  const finished = animation.finished.then(() => {
    animation.cancel();
    return true;
  }, () => false);
  return { cancel: () => animation.cancel(), finished };
}

/**
 * A tucked-away surface, with keyboard access and a visual-viewport-safe position.
 * Give the panel an appropriate role (menu, dialog, or listbox) and label in markup.
 */
export function attachPopover({ trigger, panel, placement = 'bottom-start', onOpenChange, initialFocus } = {}) {
  if (!trigger?.ownerDocument || trigger.ownerDocument !== panel?.ownerDocument) {
    throw new TypeError('A popover needs a trigger and panel in the same document.');
  }
  const doc = trigger.ownerDocument;
  const win = doc.defaultView;
  const abort = new AbortController();
  const signal = abort.signal;
  const attributes = [
    ...snapshotAttributes(trigger, ['aria-expanded', 'aria-controls', 'aria-haspopup']),
    ...snapshotAttributes(panel, ['id', 'hidden', 'inert', 'aria-hidden', 'popover', 'data-cw-placement']),
  ];
  const styles = snapshotStyles(panel, [
    'position', 'left', 'top', 'right', 'bottom', 'margin',
    'min-width', 'max-width', 'max-height', 'overflow', 'box-sizing', 'transform-origin',
  ]);
  const hadClass = panel.classList.contains('cw-popover');
  const role = panel.getAttribute('role');
  let opened = false;
  let destroyed = false;
  let motion = null;
  let generation = 0;
  let nativeOpen = false;
  let frame = 0;
  panel.id ||= `cw-popover-${++nextPanelId}`;
  panel.classList.add('cw-popover');
  trigger.setAttribute('aria-controls', panel.id);
  trigger.setAttribute('aria-expanded', 'false');
  if (!trigger.hasAttribute('aria-haspopup')) {
    const popupRole = ['menu', 'dialog', 'listbox', 'tree', 'grid'].includes(role) ? role : 'dialog';
    trigger.setAttribute('aria-haspopup', popupRole);
  }
  const useNative = typeof panel.showPopover === 'function' && typeof panel.hidePopover === 'function';
  if (useNative) panel.setAttribute('popover', 'manual');
  panel.hidden = true;
  panel.inert = true;
  panel.setAttribute('aria-hidden', 'true');
  Object.assign(panel.style, {
    position: 'fixed',
    right: 'auto',
    bottom: 'auto',
    margin: '0',
    overflow: 'auto',
    boxSizing: 'border-box',
  });

  function triggerAvailable() {
    return trigger.isConnected
      && isAvailableControl(trigger)
      && win.getComputedStyle(trigger).visibility !== 'hidden';
  }

  function update() {
    if (!opened || destroyed) return;
    if (!panel.isConnected || !triggerAvailable()) {
      close({ restoreFocus: false });
      return;
    }
    const { left, top, right, bottom } = viewportBounds(win);
    // At pinch zoom, CSS vw still describes the wider layout viewport.
    panel.style.minWidth = `${Math.max(0, Math.min(180, right - left))}px`;
    panel.style.maxWidth = `${Math.max(0, right - left)}px`;
    panel.style.maxHeight = `${Math.max(0, bottom - top)}px`;
    const anchor = trigger.getBoundingClientRect();
    // Transform animations must not feed back into layout and move the resting panel.
    const surface = { width: panel.offsetWidth, height: panel.offsetHeight };
    const [requestedSide, align = 'start'] = placement.split('-');
    let side = ['top', 'bottom', 'left', 'right'].includes(requestedSide) ? requestedSide : 'bottom';
    const spaces = {
      top: anchor.top - top - popoverAnchorGap,
      bottom: bottom - anchor.bottom - popoverAnchorGap,
      left: anchor.left - left - popoverAnchorGap,
      right: right - anchor.right - popoverAnchorGap,
    };
    const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
    const vertical = side === 'top' || side === 'bottom';
    const requiredSpace = vertical ? surface.height : surface.width;
    if (spaces[side] < requiredSpace && spaces[opposite[side]] > spaces[side]) {
      side = opposite[side];
    }
    let x = anchor.left;
    let y = anchor.bottom + popoverAnchorGap;
    if (side === 'top' || side === 'bottom') {
      y = side === 'top' ? anchor.top - surface.height - popoverAnchorGap : anchor.bottom + popoverAnchorGap;
      x = alignedCoordinate(anchor.left, anchor.right, anchor.width, surface.width, align);
    } else {
      x = side === 'left' ? anchor.left - surface.width - popoverAnchorGap : anchor.right + popoverAnchorGap;
      y = alignedCoordinate(anchor.top, anchor.bottom, anchor.height, surface.height, align);
    }
    panel.style.left = `${Math.round(Math.max(left, Math.min(x, right - surface.width)))}px`;
    panel.style.top = `${Math.round(Math.max(top, Math.min(y, bottom - surface.height)))}px`;
    const transformOrigins = { top: 'center bottom', bottom: 'center top', left: 'right center', right: 'left center' };
    panel.style.transformOrigin = transformOrigins[side];
    panel.dataset.cwPlacement = `${side}-${align}`;
  }
  function scheduleUpdate() {
    if (!opened || frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      update();
    });
  }
  function focusFirst(last = false) {
    const requested = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
    const controls = availableControls(panel);
    const candidate = typeof requested === 'string' ? panel.querySelector(requested) : requested;
    const target = candidate?.focus && panel.contains(candidate)
      ? candidate
      : controls[last ? controls.length - 1 : 0];
    target?.focus({ preventScroll: true });
  }
  function open({ focus = false } = {}) {
    if (destroyed || opened || !triggerAvailable() || !panel.isConnected) return;
    // Reopening invalidates any pending exit callback before revealing the panel.
    generation++;
    motion?.cancel();
    opened = true;
    panel.hidden = false;
    panel.inert = false;
    panel.removeAttribute('aria-hidden');
    trigger.setAttribute('aria-expanded', 'true');
    onOpenChange?.(true);
    if (destroyed || !opened) return;
    if (useNative) {
      panel.setAttribute('popover', 'manual');
      try {
        panel.showPopover();
        nativeOpen = true;
      } catch {
        // Keep the fixed-position fallback usable if top-layer entry is denied.
        panel.removeAttribute('popover');
        nativeOpen = false;
      }
    }
    update();
    motion = animatePanel(panel, { opening: true });
    if (focus) focusFirst();
  }
  function close({ restoreFocus = true } = {}) {
    if (destroyed || !opened) return;
    const closingGeneration = ++generation;
    opened = false;
    motion?.cancel();
    const hadFocus = panel.contains(doc.activeElement);
    if (restoreFocus && triggerAvailable() && (hadFocus || doc.activeElement === trigger)) {
      trigger.focus({ preventScroll: true });
    } else if (hadFocus) {
      doc.activeElement.blur?.();
    }
    // Exit motion may remain visible, but its controls must stop accepting focus.
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    onOpenChange?.(false);
    motion = animatePanel(panel, { opening: false });
    motion.finished.then(() => {
      // A later open/close or destroy owns the panel now; do not hide its state.
      if (destroyed || opened || generation !== closingGeneration) return;
      if (nativeOpen) hideNativePopover(panel);
      nativeOpen = false;
      panel.hidden = true;
    });
  }
  function toggle() {
    if (opened) close();
    else open();
  }
  trigger.addEventListener('click', event => {
    event.preventDefault();
    // Keyboard and assistive-technology clicks enter the surface immediately.
    if (opened) close();
    else open({ focus: event.detail === 0 });
  }, { signal });
  trigger.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    open();
    focusFirst(event.key === 'ArrowUp');
  }, { signal });
  doc.addEventListener('pointerdown', event => {
    if (opened && !event.composedPath().includes(panel) && !event.composedPath().includes(trigger)) {
      close({ restoreFocus: false });
    }
  }, { signal, capture: true });
  doc.addEventListener('focusin', event => {
    if (opened && !panel.contains(event.target) && !trigger.contains(event.target)) {
      close({ restoreFocus: false });
    }
  }, { signal });
  doc.addEventListener('keydown', event => {
    if (!opened || event.key !== 'Escape' || (!panel.contains(event.target) && !trigger.contains(event.target))) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }, { signal });
  panel.addEventListener('keydown', event => {
    if (event.target.matches('input,textarea,select,[contenteditable="true"]')) return;
    const menu = panel.matches('[role="menu"],[role="listbox"]');
    if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const controls = availableControls(panel);
    if (!controls.length) return;
    event.preventDefault();
    const current = controls.indexOf(doc.activeElement);
    let index;
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = controls.length - 1;
    else {
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      index = (current + direction + controls.length) % controls.length;
    }
    controls[index].focus({ preventScroll: true });
  }, { signal });
  win.addEventListener('resize', scheduleUpdate, { signal });
  doc.addEventListener('scroll', scheduleUpdate, { signal, capture: true });
  win.visualViewport?.addEventListener('resize', scheduleUpdate, { signal });
  win.visualViewport?.addEventListener('scroll', scheduleUpdate, { signal });
  const Observer = win.ResizeObserver;
  const observer = Observer ? new Observer(scheduleUpdate) : null;
  observer?.observe(panel);
  observer?.observe(trigger);
  const availabilityObserver = new win.MutationObserver(scheduleUpdate);
  for (let ancestor = trigger; ancestor; ancestor = ancestor.parentElement) {
    availabilityObserver.observe(ancestor, {
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'inert', 'aria-disabled', 'style', 'class'],
    });
  }
  return {
    open,
    close,
    toggle,
    update,
    get isOpen() {
      return opened;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      opened = false;
      generation++;
      abort.abort();
      observer?.disconnect();
      availabilityObserver.disconnect();
      motion?.cancel();
      if (frame) win.cancelAnimationFrame(frame);
      if (nativeOpen) hideNativePopover(panel);
      restoreAttributes(attributes);
      restoreStyles(panel, styles);
      if (!hadClass) panel.classList.remove('cw-popover');
    },
  };
}

/** Native details remain usable without JavaScript; only the reveal gets motion. */
export function bindDetailsMotion(details, { duration = 180 } = {}) {
  const summary = details.querySelector(':scope > summary');
  const content = details.querySelector(':scope > [data-cw-disclosure-content]')
    || [...details.children].find(child => child !== summary);
  if (!summary || !content) return () => {};
  let motion = null;
  let desiredOpen = details.open;
  let closing = false;
  let generation = 0;
  const originalAttributes = snapshotAttributes(content, ['inert', 'aria-hidden']);
  function restoreContent() {
    restoreAttributes(originalAttributes);
  }
  function setOpen(opened) {
    desiredOpen = opened;
    closing = !opened && details.open;
    const currentGeneration = ++generation;
    motion?.cancel();
    restoreContent();
    if (opened) {
      details.open = true;
      motion = animatePanel(content, { opening: true, duration });
    } else if (details.open) {
      if (content.contains(details.ownerDocument.activeElement)) {
        summary.focus({ preventScroll: true });
      }
      content.inert = true;
      content.setAttribute('aria-hidden', 'true');
      motion = animatePanel(content, { opening: false, duration });
      motion.finished.then(() => {
        // Rapid toggles and teardown invalidate the previous closing animation.
        if (generation !== currentGeneration) return;
        closing = false;
        details.open = false;
        restoreContent();
      });
    }
  }
  function click(event) {
    event.preventDefault();
    setOpen(!desiredOpen);
  }
  function toggle() {
    if (!details.open) {
      desiredOpen = false;
      closing = false;
      generation++;
      motion?.cancel();
      restoreContent();
    } else if (!closing) {
      desiredOpen = true;
      motion?.cancel();
      motion = animatePanel(content, { opening: true, duration });
    }
  }
  summary.addEventListener('click', click);
  details.addEventListener('toggle', toggle);
  const close = () => setOpen(false);
  disclosureClosers.set(details, close);
  return () => {
    generation++;
    motion?.cancel();
    restoreContent();
    summary.removeEventListener('click', click);
    details.removeEventListener('toggle', toggle);
    if (disclosureClosers.get(details) === close) disclosureClosers.delete(details);
    if (!desiredOpen) details.open = false;
  };
}

/** Outside-click and Escape dismissal for a native details menu or inspector. */
export function bindDetailsDismiss(details) {
  const summary = details.querySelector(':scope > summary');
  if (!summary) return () => {};
  const abort = new AbortController();
  const close = restoreFocus => {
    if (!details.open) return;
    if (restoreFocus && details.contains(details.ownerDocument.activeElement)) {
      summary.focus({ preventScroll: true });
    }
    const animatedClose = disclosureClosers.get(details);
    if (animatedClose) animatedClose(); else details.open = false;
  };
  details.ownerDocument.addEventListener('pointerdown', event => {
    if (!event.composedPath().includes(details)) close(false);
  }, { signal: abort.signal, capture: true });
  details.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !details.open) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }, { signal: abort.signal });
  return () => abort.abort();
}

/** One tab stop for a compact toolbar; arrows keep its controls discoverable. */
export function attachRovingToolbar(toolbar, { orientation = 'horizontal' } = {}) {
  const original = new Map();
  const abort = new AbortController();
  let active = null;
  function controls() {
    return [...toolbar.querySelectorAll('button,[role="button"],[role="radio"],[role="tab"]')]
      .filter(isAvailableControl);
  }
  function refresh(preferred = active) {
    const available = controls();
    if (available.includes(preferred)) {
      active = preferred;
    } else {
      const selected = available.find(node => node.getAttribute('aria-pressed') === 'true'
        || node.getAttribute('aria-selected') === 'true'
        || node.getAttribute('aria-checked') === 'true');
      active = selected || available[0];
    }
    for (const node of available) {
      if (!original.has(node)) original.set(node, node.getAttribute('tabindex'));
      node.tabIndex = node === active ? 0 : -1;
    }
  }
  toolbar.addEventListener('focusin', event => {
    if (controls().includes(event.target)) refresh(event.target);
  }, { signal: abort.signal });
  toolbar.addEventListener('keydown', event => {
    const available = controls();
    const index = available.indexOf(event.target);
    const previousKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
    const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
    if (index < 0 || !['Home', 'End', previousKey, nextKey].includes(event.key)) return;
    event.preventDefault();
    const rtl = orientation === 'horizontal'
      && toolbar.ownerDocument.defaultView.getComputedStyle(toolbar).direction === 'rtl';
    const direction = (event.key === nextKey ? 1 : -1) * (rtl ? -1 : 1);
    let next;
    if (event.key === 'Home') next = available[0];
    else if (event.key === 'End') next = available[available.length - 1];
    else next = available[(index + direction + available.length) % available.length];
    refresh(next);
    next?.focus({ preventScroll: true });
    // Keep the focused action visible in a narrow, scrollable toolbar without
    // scrolling the surrounding canvas or changing its camera.
    if (next) {
      const bounds = toolbar.getBoundingClientRect(), item = next.getBoundingClientRect();
      if (orientation === 'vertical') {
        if (item.top < bounds.top) toolbar.scrollTop += item.top - bounds.top;
        else if (item.bottom > bounds.bottom) toolbar.scrollTop += item.bottom - bounds.bottom;
      } else {
        if (item.left < bounds.left) toolbar.scrollLeft += item.left - bounds.left;
        else if (item.right > bounds.right) toolbar.scrollLeft += item.right - bounds.right;
      }
    }
  }, { signal: abort.signal });
  const Observer = toolbar.ownerDocument.defaultView.MutationObserver;
  const observer = new Observer(() => refresh());
  observer.observe(toolbar, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'hidden', 'aria-disabled', 'aria-pressed', 'aria-selected', 'aria-checked'],
  });
  refresh();
  return () => {
    abort.abort();
    observer.disconnect();
    for (const [node, value] of original) {
      if (value === null) node.removeAttribute('tabindex');
      else node.setAttribute('tabindex', value);
    }
  };
}
