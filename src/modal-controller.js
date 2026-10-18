const focusableSelector = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,iframe,[contenteditable]:not([contenteditable="false"]),[tabindex]';

function canFocus(element) {
  const view = element?.ownerDocument?.defaultView;
  if (!view || !(element instanceof view.HTMLElement) || !element.isConnected || typeof element.focus !== 'function') return false;
  if (element.matches(':disabled,[aria-disabled="true"]') || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
  const style = view.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && element.getClientRects().length > 0;
}

/** A single modal surface. Replacing its content keeps the original opener. */
export class ModalController {
  constructor({ root, getFallback, onRequestClose, signal }) {
    this.root = root;
    this.document = root.ownerDocument;
    this.window = this.document.defaultView;
    this.getFallback = getFallback;
    this.onRequestClose = onRequestClose;
    this.isOpen = false;
    this.destroyed = false;
    this.background = new Map();
    this.events = new AbortController();
    const options = { capture: true, signal: this.events.signal };
    this.document.addEventListener('keydown', event => this.keyDown(event), options);
    this.document.addEventListener('focusin', event => this.keepFocus(event), options);
    signal?.addEventListener('abort', () => this.destroy(), { once: true });
    if (signal?.aborted) this.destroy();
  }

  activate() {
    if (this.destroyed) return;
    this.dialogEvents?.abort();
    this.dialogEvents = new AbortController();
    const dialog = this.root.querySelector('[role="dialog"]');
    if (!dialog) return;
    if (!this.isOpen) {
      const active = this.document.activeElement;
      this.opener = active !== this.document.body && !this.root.contains(active) ? active : null;
      this.overflow = { value: this.document.body.style.getPropertyValue('overflow'), priority: this.document.body.style.getPropertyPriority('overflow') };
      this.document.body.style.setProperty('overflow', 'hidden');
      this.isOpen = true;
      this.inertBackground();
      this.observer = new this.window.MutationObserver(() => { if (this.isOpen) this.inertBackground(); });
      this.observer.observe(this.document.body, { childList: true });
    }
    this.dialog = dialog;
    this.lastFocus = null;
    dialog.tabIndex = -1;
    const overlay = this.root.querySelector('.modal-overlay');
    let startedOnOverlay = false, endedOnOverlay = false, pointerId = null;
    const options = { capture: true, signal: this.dialogEvents.signal };
    overlay?.addEventListener('pointerdown', event => {
      pointerId = event.pointerId;
      startedOnOverlay = event.target === overlay;
      endedOnOverlay = false;
    }, options);
    overlay?.addEventListener('pointerup', event => { endedOnOverlay = event.pointerId === pointerId && event.target === overlay; }, options);
    overlay?.addEventListener('pointercancel', () => { startedOnOverlay = false; endedOnOverlay = false; }, options);
    // A drag that starts in the dialog and ends outside can produce an overlay
    // click. Let real outside clicks through, including custom close handlers.
    overlay?.addEventListener('click', event => {
      if (event.target !== overlay) return;
      if (event.detail > 0 && (!startedOnOverlay || !endedOnOverlay)) { event.preventDefault(); event.stopImmediatePropagation(); }
      startedOnOverlay = false;
      endedOnOverlay = false;
    }, options);
    this.initialFocus().focus({ preventScroll: true });
  }

  inertBackground() {
    for (const child of this.document.body.children) {
      if (!(child instanceof this.window.HTMLElement) || child === this.root || child.contains(this.root)) continue;
      if (!this.background.has(child)) this.background.set(child, child.getAttribute('inert'));
      child.inert = true;
    }
  }

  focusable() {
    return [...this.dialog.querySelectorAll(focusableSelector)].filter(element => element.tabIndex >= 0 && canFocus(element));
  }

  initialFocus() {
    const all = this.focusable();
    return all.find(element => element.matches('[autofocus],[data-initial-focus]'))
      || all.find(element => element.matches('input:not([type="checkbox"]):not([type="radio"]),textarea,select'))
      || all.find(element => element.matches('[data-cancel],#cancel-end'))
      || all.find(element => !element.matches('.close-modal,.danger,.danger-fill'))
      || all.find(element => element.matches('.close-modal'))
      || this.dialog;
  }

  keyDown(event) {
    if (!this.isOpen || this.destroyed || event.isComposing || this.document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const close = this.dialog.querySelector('.close-modal');
      if (close && !close.disabled) close.click(); else this.onRequestClose();
      return;
    }
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const all = this.focusable(), active = this.document.activeElement;
    if (!all.length) { event.preventDefault(); this.dialog.focus({ preventScroll: true }); return; }
    const outside = !this.dialog.contains(active), first = all[0], last = all.at(-1);
    if (outside || active === this.dialog || (!event.shiftKey && active === last) || (event.shiftKey && active === first)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  keepFocus(event) {
    if (!this.isOpen || this.destroyed || this.document.querySelector('dialog[open]')) return;
    if (this.dialog?.contains(event.target)) { this.lastFocus = event.target; return; }
    if (!this.dialog?.isConnected) return;
    const target = canFocus(this.lastFocus) ? this.lastFocus : this.initialFocus();
    target.focus({ preventScroll: true });
  }

  close({ restoreFocus = true } = {}) {
    this.dialogEvents?.abort();
    this.root.replaceChildren();
    if (!this.isOpen) return;
    this.isOpen = false;
    this.observer?.disconnect();
    for (const [element, inert] of this.background) {
      if (inert === null) element.removeAttribute('inert'); else element.setAttribute('inert', inert);
    }
    this.background.clear();
    if (this.overflow.value) this.document.body.style.setProperty('overflow', this.overflow.value, this.overflow.priority);
    else this.document.body.style.removeProperty('overflow');
    const opener = this.opener;
    this.opener = null;
    this.dialog = null;
    this.lastFocus = null;
    if (!restoreFocus || this.destroyed) return;
    const target = canFocus(opener) ? opener : this.getFallback?.();
    if (canFocus(target)) target.focus({ preventScroll: true });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.close({ restoreFocus: false });
    this.events.abort();
  }
}
