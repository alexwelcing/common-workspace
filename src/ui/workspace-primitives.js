import './workspace-primitives.css';

let nextPanelId = 0;
const disclosureClosers = new WeakMap();
const focusableSelector = 'button, [href], input, select, textarea, summary, [tabindex]';
const snapshotAttribute = (node, name) => ({ node, name, value: node.getAttribute(name) });
const restoreAttribute = ({ node, name, value }) => value === null ? node.removeAttribute(name) : node.setAttribute(name, value);
const availableControls = root => [...root.querySelectorAll(focusableSelector)].filter(node => !node.matches(':disabled') && !node.closest('[hidden], [inert]') && node.getAttribute('aria-disabled') !== 'true' && node.getClientRects().length);

/** A short, cancelable entrance/exit. WAAPI owns no lasting inline styles. */
export function animatePanel(panel, { opening = true, duration = 180 } = {}) {
  const win = panel.ownerDocument.defaultView;
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced || typeof panel.animate !== 'function' || !panel.isConnected) return { cancel() {}, finished: Promise.resolve(true) };
  const computed = win.getComputedStyle(panel);
  const transform = computed.transform === 'none' ? '' : `${computed.transform} `;
  const resting = { opacity: computed.opacity, transform: `${transform}translateY(0) scale(1)` };
  const tucked = { opacity: 0, transform: `${transform}translateY(${opening ? 6 : 3}px) scale(.975)` };
  const animation = panel.animate(opening ? [tucked, resting] : [resting, tucked], {
    duration: Math.max(0, Math.min(240, Number(duration) || 0)),
    easing: opening ? 'cubic-bezier(.2,.8,.2,1)' : 'cubic-bezier(.4,0,1,1)',
    fill: 'none',
  });
  const finished = animation.finished.then(() => { animation.cancel(); return true; }, () => false);
  return { cancel: () => animation.cancel(), finished };
}

/**
 * A tucked-away surface, with keyboard access and a visual-viewport-safe position.
 * Give the panel an appropriate role (menu, dialog, or listbox) and label in markup.
 */
export function attachPopover({ trigger, panel, placement = 'bottom-start', onOpenChange, initialFocus } = {}) {
  if (!trigger?.ownerDocument || trigger.ownerDocument !== panel?.ownerDocument) throw new TypeError('A popover needs a trigger and panel in the same document.');
  const doc = trigger.ownerDocument;
  const win = doc.defaultView;
  const abort = new AbortController();
  const signal = abort.signal;
  const attributes = [snapshotAttribute(trigger, 'aria-expanded'), snapshotAttribute(trigger, 'aria-controls'), snapshotAttribute(trigger, 'aria-haspopup'), snapshotAttribute(panel, 'id'), snapshotAttribute(panel, 'hidden'), snapshotAttribute(panel, 'inert'), snapshotAttribute(panel, 'aria-hidden'), snapshotAttribute(panel, 'popover'), snapshotAttribute(panel, 'data-cw-placement')];
  const ownedStyleNames = ['position', 'left', 'top', 'right', 'bottom', 'margin', 'min-width', 'max-width', 'max-height', 'overflow', 'box-sizing', 'transform-origin'];
  const styles = ownedStyleNames.map(name => ({ name, value: panel.style.getPropertyValue(name), priority: panel.style.getPropertyPriority(name) }));
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
  if (!trigger.hasAttribute('aria-haspopup')) trigger.setAttribute('aria-haspopup', ['menu', 'dialog', 'listbox', 'tree', 'grid'].includes(role) ? role : 'dialog');
  const useNative = typeof panel.showPopover === 'function' && typeof panel.hidePopover === 'function';
  if (useNative) panel.setAttribute('popover', 'manual');
  panel.hidden = true;
  panel.inert = true;
  panel.setAttribute('aria-hidden', 'true');
  Object.assign(panel.style, { position: 'fixed', right: 'auto', bottom: 'auto', margin: '0', overflow: 'auto', boxSizing: 'border-box' });

  function triggerAvailable() {
    return trigger.isConnected && !trigger.matches(':disabled') && trigger.getAttribute('aria-disabled') !== 'true' && !trigger.closest('[hidden],[inert]') && trigger.getClientRects().length > 0 && win.getComputedStyle(trigger).visibility !== 'hidden';
  }

  function update() {
    if (!opened || destroyed) return;
    if (!panel.isConnected || !triggerAvailable()) { close({ restoreFocus: false }); return; }
    const viewport = win.visualViewport;
    const leftEdge = (viewport?.offsetLeft || 0) + 8;
    const topEdge = (viewport?.offsetTop || 0) + 8;
    const rightEdge = leftEdge + (viewport?.width || win.innerWidth) - 16;
    const bottomEdge = topEdge + (viewport?.height || win.innerHeight) - 16;
    // At pinch zoom, CSS vw still describes the wider layout viewport.
    panel.style.minWidth = `${Math.max(0, Math.min(180, rightEdge - leftEdge))}px`;
    panel.style.maxWidth = `${Math.max(0, rightEdge - leftEdge)}px`;
    panel.style.maxHeight = `${Math.max(0, bottomEdge - topEdge)}px`;
    const anchor = trigger.getBoundingClientRect();
    // Transform animations must not feed back into layout and move the resting panel.
    const surface = { width: panel.offsetWidth, height: panel.offsetHeight };
    const [requestedSide, align = 'start'] = placement.split('-');
    let side = ['top', 'bottom', 'left', 'right'].includes(requestedSide) ? requestedSide : 'bottom';
    const spaces = { top: anchor.top - topEdge - 8, bottom: bottomEdge - anchor.bottom - 8, left: anchor.left - leftEdge - 8, right: rightEdge - anchor.right - 8 };
    const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
    const vertical = side === 'top' || side === 'bottom';
    if (spaces[side] < (vertical ? surface.height : surface.width) && spaces[opposite[side]] > spaces[side]) side = opposite[side];
    let x = anchor.left;
    let y = anchor.bottom + 8;
    if (side === 'top' || side === 'bottom') {
      y = side === 'top' ? anchor.top - surface.height - 8 : anchor.bottom + 8;
      x = align === 'end' ? anchor.right - surface.width : align === 'center' ? anchor.left + (anchor.width - surface.width) / 2 : anchor.left;
    } else {
      x = side === 'left' ? anchor.left - surface.width - 8 : anchor.right + 8;
      y = align === 'end' ? anchor.bottom - surface.height : align === 'center' ? anchor.top + (anchor.height - surface.height) / 2 : anchor.top;
    }
    panel.style.left = `${Math.round(Math.max(leftEdge, Math.min(x, rightEdge - surface.width)))}px`;
    panel.style.top = `${Math.round(Math.max(topEdge, Math.min(y, bottomEdge - surface.height)))}px`;
    panel.style.transformOrigin = side === 'top' ? 'center bottom' : side === 'bottom' ? 'center top' : side === 'left' ? 'right center' : 'left center';
    panel.dataset.cwPlacement = `${side}-${align}`;
  }
  function scheduleUpdate() {
    if (!opened || frame) return;
    frame = win.requestAnimationFrame(() => { frame = 0; update(); });
  }
  function focusFirst(last = false) {
    const requested = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
    const controls = availableControls(panel);
    const candidate = typeof requested === 'string' ? panel.querySelector(requested) : requested;
    (candidate?.focus && panel.contains(candidate) ? candidate : controls[last ? controls.length - 1 : 0])?.focus({ preventScroll: true });
  }
  function open({ focus = false } = {}) {
    if (destroyed || opened || !triggerAvailable() || !panel.isConnected) return;
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
      try { panel.showPopover(); nativeOpen = true; } catch { panel.removeAttribute('popover'); nativeOpen = false; }
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
    if (restoreFocus && triggerAvailable() && (hadFocus || doc.activeElement === trigger)) trigger.focus({ preventScroll: true });
    else if (hadFocus) doc.activeElement.blur?.();
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    onOpenChange?.(false);
    motion = animatePanel(panel, { opening: false });
    motion.finished.then(() => {
      if (destroyed || opened || generation !== closingGeneration) return;
      if (nativeOpen) { try { panel.hidePopover(); } catch { /* The browser may already have removed it. */ } }
      nativeOpen = false;
      panel.hidden = true;
    });
  }
  function toggle() { if (opened) close(); else open(); }
  trigger.addEventListener('click', event => {
    event.preventDefault();
    if (opened) close(); else open({ focus: event.detail === 0 });
  }, { signal });
  trigger.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    open(); focusFirst(event.key === 'ArrowUp');
  }, { signal });
  doc.addEventListener('pointerdown', event => {
    if (opened && !event.composedPath().includes(panel) && !event.composedPath().includes(trigger)) close({ restoreFocus: false });
  }, { signal, capture: true });
  doc.addEventListener('focusin', event => {
    if (opened && !panel.contains(event.target) && !trigger.contains(event.target)) close({ restoreFocus: false });
  }, { signal });
  doc.addEventListener('keydown', event => {
    if (!opened || event.key !== 'Escape' || (!panel.contains(event.target) && !trigger.contains(event.target))) return;
    event.preventDefault(); event.stopPropagation(); close();
  }, { signal });
  panel.addEventListener('keydown', event => {
    if (event.target.matches('input,textarea,select,[contenteditable="true"]')) return;
    const menu = panel.matches('[role="menu"],[role="listbox"]');
    if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const controls = availableControls(panel);
    if (!controls.length) return;
    event.preventDefault();
    const current = controls.indexOf(doc.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
    controls[index].focus({ preventScroll: true });
  }, { signal });
  win.addEventListener('resize', scheduleUpdate, { signal });
  doc.addEventListener('scroll', scheduleUpdate, { signal, capture: true });
  win.visualViewport?.addEventListener('resize', scheduleUpdate, { signal });
  win.visualViewport?.addEventListener('scroll', scheduleUpdate, { signal });
  const Observer = win.ResizeObserver;
  const observer = Observer ? new Observer(scheduleUpdate) : null;
  observer?.observe(panel); observer?.observe(trigger);
  const availabilityObserver = new win.MutationObserver(scheduleUpdate);
  for (let ancestor = trigger; ancestor; ancestor = ancestor.parentElement) availabilityObserver.observe(ancestor, { attributes: true, attributeFilter: ['disabled', 'hidden', 'inert', 'aria-disabled', 'style', 'class'] });
  return {
    open, close, toggle, update,
    get isOpen() { return opened; },
    destroy() {
      if (destroyed) return;
      destroyed = true; opened = false; generation++;
      abort.abort(); observer?.disconnect(); availabilityObserver.disconnect(); motion?.cancel();
      if (frame) win.cancelAnimationFrame(frame);
      if (nativeOpen) { try { panel.hidePopover(); } catch { /* A detached surface is already closed. */ } }
      for (const attribute of attributes) restoreAttribute(attribute);
      for (const { name, value, priority } of styles) { if (value) panel.style.setProperty(name, value, priority); else panel.style.removeProperty(name); }
      if (!hadClass) panel.classList.remove('cw-popover');
    },
  };
}

/** Native details remain usable without JavaScript; only the reveal gets motion. */
export function bindDetailsMotion(details, { duration = 180 } = {}) {
  const summary = details.querySelector(':scope > summary');
  const content = details.querySelector(':scope > [data-cw-disclosure-content]') || [...details.children].find(child => child !== summary);
  if (!summary || !content) return () => {};
  let motion = null;
  let desiredOpen = details.open;
  let closing = false;
  let generation = 0;
  const originalInert = snapshotAttribute(content, 'inert');
  const originalHidden = snapshotAttribute(content, 'aria-hidden');
  function restoreContent() { restoreAttribute(originalInert); restoreAttribute(originalHidden); }
  function setOpen(opened) {
    desiredOpen = opened;
    closing = !opened && details.open;
    const currentGeneration = ++generation;
    motion?.cancel(); restoreContent();
    if (opened) {
      details.open = true;
      motion = animatePanel(content, { opening: true, duration });
    } else if (details.open) {
      if (content.contains(details.ownerDocument.activeElement)) summary.focus({ preventScroll: true });
      content.inert = true;
      content.setAttribute('aria-hidden', 'true');
      motion = animatePanel(content, { opening: false, duration });
      motion.finished.then(() => { if (generation === currentGeneration) { closing = false; details.open = false; restoreContent(); } });
    }
  }
  function click(event) { event.preventDefault(); setOpen(!desiredOpen); }
  function toggle() {
    if (!details.open) { desiredOpen = false; closing = false; generation++; motion?.cancel(); restoreContent(); }
    else if (!closing) { desiredOpen = true; motion?.cancel(); motion = animatePanel(content, { opening: true, duration }); }
  }
  summary.addEventListener('click', click);
  details.addEventListener('toggle', toggle);
  const close = () => setOpen(false);
  disclosureClosers.set(details, close);
  return () => {
    generation++; motion?.cancel(); restoreContent();
    summary.removeEventListener('click', click); details.removeEventListener('toggle', toggle);
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
    if (restoreFocus && details.contains(details.ownerDocument.activeElement)) summary.focus({ preventScroll: true });
    const animatedClose = disclosureClosers.get(details);
    if (animatedClose) animatedClose(); else details.open = false;
  };
  details.ownerDocument.addEventListener('pointerdown', event => { if (!event.composedPath().includes(details)) close(false); }, { signal: abort.signal, capture: true });
  details.addEventListener('keydown', event => { if (event.key === 'Escape' && details.open) { event.preventDefault(); event.stopPropagation(); close(true); } }, { signal: abort.signal });
  return () => abort.abort();
}

/** One tab stop for a compact toolbar; arrows keep its controls discoverable. */
export function attachRovingToolbar(toolbar, { orientation = 'horizontal' } = {}) {
  const original = new Map();
  const abort = new AbortController();
  let active = null;
  function controls() {
    return [...toolbar.querySelectorAll('button,[role="button"],[role="radio"],[role="tab"]')].filter(node => !node.matches(':disabled') && !node.closest('[hidden],[inert]') && node.getAttribute('aria-disabled') !== 'true' && node.getClientRects().length);
  }
  function refresh(preferred = active) {
    const available = controls();
    active = available.includes(preferred) ? preferred : available.find(node => node.getAttribute('aria-pressed') === 'true' || node.getAttribute('aria-selected') === 'true' || node.getAttribute('aria-checked') === 'true') || available[0];
    for (const node of available) {
      if (!original.has(node)) original.set(node, node.getAttribute('tabindex'));
      node.tabIndex = node === active ? 0 : -1;
    }
  }
  toolbar.addEventListener('focusin', event => { if (controls().includes(event.target)) refresh(event.target); }, { signal: abort.signal });
  toolbar.addEventListener('keydown', event => {
    const available = controls();
    const index = available.indexOf(event.target);
    const previousKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
    const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
    if (index < 0 || !['Home', 'End', previousKey, nextKey].includes(event.key)) return;
    event.preventDefault();
    const rtl = orientation === 'horizontal' && toolbar.ownerDocument.defaultView.getComputedStyle(toolbar).direction === 'rtl';
    const direction = (event.key === nextKey ? 1 : -1) * (rtl ? -1 : 1);
    const next = event.key === 'Home' ? available[0] : event.key === 'End' ? available[available.length - 1] : available[(index + direction + available.length) % available.length];
    refresh(next); next?.focus({ preventScroll: true });
  }, { signal: abort.signal });
  const Observer = toolbar.ownerDocument.defaultView.MutationObserver;
  const observer = new Observer(() => refresh());
  observer.observe(toolbar, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'aria-disabled', 'aria-pressed', 'aria-selected', 'aria-checked'] });
  refresh();
  return () => {
    abort.abort(); observer.disconnect();
    for (const [node, value] of original) { if (value === null) node.removeAttribute('tabindex'); else node.setAttribute('tabindex', value); }
  };
}
