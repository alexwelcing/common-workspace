import DOMPurify from 'dompurify';
import { renderMermaid, plantUmlUrl } from './diagrams.js';
import { getRuntimeConfig } from './runtime-config.js';
import { initGeometry, snap, simplifyPoints } from './geometry.js';
import { canvasBackground } from './canvas-background.js';
import { createTextLayout } from './text-layout.js';
import { SVG_TEXT_FONT_CSS } from './text-font.js';
import { DEFAULT_TOOL_COLOR } from './canvas-tools.js';
import { attachPopover, attachRovingToolbar } from './ui/workspace-primitives.js';
import './board.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLORS = { text: '#28322f', sticky: '#5b5237', rectangle: '#567263', ellipse: '#567263', arrow: '#567263', draw: '#567263' };
const DEFAULTS = {
  text: { width: 300, height: 86, text: 'Add your thoughts', fontSize: 24 },
  sticky: { width: 224, height: 182, fill: '#fff0b5', text: 'A thought worth sharing…', fontSize: 18 },
  rectangle: { width: 220, height: 130, fill: 'transparent' },
  ellipse: { width: 180, height: 130, fill: 'transparent' },
  arrow: { width: 180, height: 64 },
  draw: { width: 100, height: 100, points: [] },
  image: { width: 360, height: 260, title: 'Image' },
  diagram: { width: 440, height: 300, title: 'A little clarity', language: 'mermaid', source: 'flowchart LR\n  Idea --> Discuss --> Build' },
  screen: { width: 600, height: 370, title: 'Shared screen' },
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}
function icon(name, size = 18) {
  const svg = svgElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true });
  const paths = {
    grip: ['M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01'],
    screen: ['M4 3h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z', 'M8 21h8M12 17v4'],
    image: ['M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z', 'm3 16 6-6 12 11M14 10h.01'],
    diagram: ['M9 3h6v5H9zM2 16h6v5H2zM16 16h6v5h-6zM12 8v4M5 16v-4h14v4'],
    duplicate: ['M9 9h11v11H9zM5 15H3V3h12v2'],
    trash: ['M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7'],
    edit: ['m16 3 5 5-12 12-6 1 1-6Z', 'm13 6 5 5'],
    focus: ['M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'],
    backToCanvas: ['m9 5-7 7 7 7M2 12h20'],
    layers: ['m12 3 10 6-10 6L2 9Z', 'm2 13 10 6 10-6M2 17l10 6 10-6'],
    front: ['M4 3h16M12 20V7m-5 5 5-5 5 5'],
    back: ['M4 21h16M12 4v13m-5-5 5 5 5-5'],
    forward: ['M12 20V4m-5 5 5-5 5 5'],
    backward: ['M12 4v16m-5-5 5 5 5-5'],
    lock: ['M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4M12 15v2'],
    unlock: ['M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.5-2M12 15v2'],
  };
  (paths[name] || paths.grip).forEach(d => svg.append(svgElement('path', { d })));
  return svg;
}
function button(label, iconName, action) {
  const node = element('button', 'board-mini-button');
  node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
  node.append(icon(iconName, 15));
  node.addEventListener('pointerdown', event => event.stopPropagation());
  node.addEventListener('click', event => { event.stopPropagation(); action(); });
  return node;
}
function signature(entity) {
  // Geometry and collaboration metadata update the existing node in place.
  const { x: _x, y: _y, width: _width, height: _height, z: _z, orderKey: _orderKey, locked: _locked, updatedAt: _updatedAt, updatedBy: _updatedBy, ...content } = entity;
  return JSON.stringify(content);
}
const useWritingSurface = () => window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
function finite(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function pointList(points) { return (points || []).map(p => Array.isArray(p) ? { x: p[0], y: p[1] } : p); }

function editorText(root) {
  // Native contenteditable uses DIVs for Enter and a final BR as a caret
  // placeholder. innerText counts an empty DIV twice with pre-wrap, so read
  // those line boundaries directly without changing the live caret/IME DOM.
  function read(parent) {
    let text = '', previousBlock = false, started = false;
    for (const node of parent.childNodes) {
      const block = node.nodeType === 1 && ['DIV', 'P'].includes(node.nodeName);
      if (block) {
        if (previousBlock || (started && !text.endsWith('\n'))) text += '\n';
        text += read(node); previousBlock = true;
      } else {
        if (previousBlock) text += '\n';
        previousBlock = false;
        if (node.nodeType === 3) text += node.data;
        else if (node.nodeName === 'BR') { if (node.nextSibling) text += '\n'; }
        else if (node.nodeType === 1) text += read(node);
      }
      started = true;
    }
    return text;
  }
  return read(root).slice(0, 20000);
}

/** A collaborative, zoomable DOM/SVG whiteboard. Only local edits call onChange. */
export class Board {
  constructor({ el, onChange = () => {}, onDelete = () => {}, onCursor = () => {}, onSelect = () => {}, onStatus = () => {}, onViewChange = () => {}, onEditDiagram = null, onToolChange = () => {}, onLayerAction = null, onLockChange = null, onWatchScreen = () => {}, onHistoryStart = () => {}, onHistoryEnd = () => {}, allowExternalPlantUml = false, canEdit = () => true, performanceIndex = null }) {
    this.el = el;
    this.onChange = onChange; this.onDelete = onDelete; this.onCursor = onCursor;
    this.onSelect = onSelect; this.onStatus = onStatus; this.onViewChange = onViewChange;
    this.onEditDiagram = onEditDiagram; this.onToolChange = onToolChange; this.allowExternalPlantUml = allowExternalPlantUml; this.canEdit = canEdit; this.readOnly = false;
    this.onLayerAction = onLayerAction; this.onLockChange = onLockChange; this.layerOrder = [];
    this.layerRanks = new Map(); this.layerOrderDirty = false; this.entityBatchDepth = 0;
    this.onHistoryStart = onHistoryStart; this.onHistoryEnd = onHistoryEnd; this.historyGroup = false;
    this.onWatchScreen = onWatchScreen; this.screenSubscriptions = null; this.localParticipantId = null;
    this.performanceIndex = performanceIndex; this.renderMeasurementDepth = 0; this.finishRenderMeasurement = null;
    this.entities = new Map(); this.nodes = new Map(); this.streams = new Map(); this.cursors = new Map();
    this.externalConsents = new Set(); this.selectedId = null; this.tool = 'select'; this.color = DEFAULT_TOOL_COLOR;
    this.zoom = 1; this.pan = { x: 24, y: 24 }; this.gesture = null; this.spaceHeld = false;
    this.touchPointers = new Map(); this.touchNavigation = false;
    this.focusedId = null; this.previousFocusView = null;
    this.abort = new AbortController(); this.lastCursor = 0; this.editingId = null;
    this.textLayout = createTextLayout({ documentImpl: el.ownerDocument });
    this.unsubscribeTextLayout = this.textLayout.subscribe(() => {
      for (const entity of this.entities.values()) this.fitText(this.nodes.get(entity.id), entity);
    });
    this.el.classList.add('common-board'); this.el.tabIndex = 0;
    this.selectionTop = parseFloat(this.el.ownerDocument.defaultView?.getComputedStyle(this.el).getPropertyValue('--board-controls-top')) || 8;
    this.el.setAttribute('aria-label', 'Shared canvas. Use the toolbar to add notes, drawings, and diagrams.');
    this.stage = element('div', 'board-stage');
    this.cursorLayer = element('div', 'board-cursor-layer');
    this.stage.append(this.cursorLayer); this.el.append(this.stage);
    this.selectionTools = element('div', 'board-selection-tools');
    this.selectionTools.setAttribute('role', 'toolbar'); this.selectionTools.setAttribute('aria-label', 'Selected object controls');
    this.focusButton = button('Focus object (F) — only your view', 'focus', () => this.focusSelected());
    this.editButton = button('Edit text or diagram (Enter)', 'edit', () => this.editSelected());
    this.focusButton.classList.add('board-labeled-button'); this.focusButton.append(element('span', '', 'Focus'));
    this.editButton.classList.add('board-labeled-button'); this.editButton.append(element('span', '', 'Edit'));
    this.selectionTools.append(this.focusButton, this.editButton);
    this.layerButtons = new Map();
    for (const [action, label] of [['front', 'Bring to front'], ['forward', 'Bring forward'], ['backward', 'Send backward'], ['back', 'Send to back']]) {
      const control = button(label, action, () => this.changeLayer(this.selectedId, action));
      this.layerButtons.set(action, control); this.selectionTools.append(control);
    }
    this.lockButton = button('Lock position', 'lock', () => this.toggleLock(this.selectedId));
    this.mutationDivider = element('span', 'board-mini-divider');
    this.selectionTools.append(this.lockButton, this.mutationDivider);
    this.duplicateButton = button('Duplicate selected item', 'duplicate', () => this.duplicateSelected());
    this.deleteButton = button('Delete selected item', 'trash', () => this.deleteSelected()); this.deleteButton.dataset.action = 'delete';
    this.selectionTools.append(
      this.duplicateButton, this.deleteButton,
    );
    this.el.append(this.selectionTools);
    this.selectionToolbarCleanup = attachRovingToolbar(this.selectionTools);
    this.selectionHint = element('p', 'board-selection-hint'); this.selectionHint.hidden = true;
    this.selectionHint.id = `board-instructions-${crypto.randomUUID()}`;
    this.el.setAttribute('aria-describedby', this.selectionHint.id); this.el.append(this.selectionHint);
    this.focusBar = element('div', 'board-focus-bar'); this.focusBar.hidden = true;
    this.backButton = button('Back to canvas (Esc)', 'backToCanvas', () => this.exitFocus());
    this.backButton.classList.add('board-focus-back'); this.backButton.append(element('span', '', 'Back to canvas'));
    const focusDetail = element('div', 'board-focus-detail'); this.focusTitle = element('strong');
    this.focusHint = element('span', '', 'Only your view · Shared layout stays the same');
    focusDetail.append(this.focusTitle, this.focusHint);
    this.focusActions = element('div', 'board-focus-actions');
    this.focusBar.append(this.backButton, focusDetail, this.focusActions); this.el.append(this.focusBar);
    this.layersControl = element('div', 'board-layers-control');
    this.layersToggle = element('button', 'board-layers-toggle'); this.layersToggle.type = 'button';
    this.layersToggle.setAttribute('aria-label', 'Layers'); this.layersToggle.setAttribute('aria-expanded', 'false');
    this.layersToggle.append(icon('layers', 16), element('span', '', 'Layers'));
    this.layersCount = element('span', 'board-layers-count', '0'); this.layersToggle.append(this.layersCount);
    this.layersPanel = element('section', 'board-layers-panel'); this.layersPanel.hidden = true;
    this.layersPanel.setAttribute('role', 'dialog');
    this.layersPanel.setAttribute('aria-label', 'Canvas layers');
    this.layersPanel.append(element('div', 'board-layers-heading', 'Top of canvas'));
    this.layersList = element('div', 'board-layers-list'); this.layersPanel.append(this.layersList);
    this.layersControl.append(this.layersToggle, this.layersPanel); this.el.append(this.layersControl);
    this.layersControl.addEventListener('pointerdown', event => event.stopPropagation());
    this.layersControl.addEventListener('dblclick', event => event.stopPropagation());
    this.layersControl.addEventListener('wheel', event => event.stopPropagation());
    this.layersPopover = attachPopover({
      trigger: this.layersToggle, panel: this.layersPanel, placement: 'bottom-end',
      onOpenChange: () => this.updateLayers(),
    });
    const signal = this.abort.signal;
    this.el.addEventListener('pointerdown', e => this.pointerDown(e), { signal });
    this.el.addEventListener('pointermove', e => this.pointerMove(e), { signal });
    this.el.addEventListener('pointerup', e => this.pointerUp(e), { signal });
    this.el.addEventListener('pointercancel', e => this.pointerUp(e, true), { signal });
    this.el.addEventListener('lostpointercapture', e => this.pointerUp(e, true), { signal });
    this.el.addEventListener('wheel', e => this.wheel(e), { passive: false, signal });
    this.el.addEventListener('dblclick', e => this.doubleClick(e), { signal });
    document.addEventListener('keydown', e => this.keyDown(e), { signal });
    document.addEventListener('keyup', e => { if (e.code === 'Space') { this.spaceHeld = false; this.el.classList.remove('board-space-pan'); } }, { signal });
    window.addEventListener('blur', () => { this.spaceHeld = false; this.el.classList.remove('board-space-pan'); this.cancelPointers(); }, { signal });
    this.resizeObserver = new ResizeObserver(() => {
      this.selectionTop = parseFloat(this.el.ownerDocument.defaultView?.getComputedStyle(this.el).getPropertyValue('--board-controls-top')) || 8;
      if (this.editingId) { this.revealWritingCaret?.(); return; }
      if (this.focusedId) this.fitFocusedEntity(); else this.updateSelectionTools();
    }); this.resizeObserver.observe(this.el);
    this.updateView();
    initGeometry().catch(() => {});
  }

  getView() { return { zoom: this.zoom, x: this.pan.x, y: this.pan.y }; }
  worldPoint(event) {
    const rect = this.el.getBoundingClientRect();
    return { x: (event.clientX - rect.left - this.pan.x) / this.zoom, y: (event.clientY - rect.top - this.pan.y) / this.zoom };
  }
  toClient(point) { return { x: point.x * this.zoom + this.pan.x, y: point.y * this.zoom + this.pan.y }; }
  centerPoint() { return { x: (this.el.clientWidth / 2 - this.pan.x) / this.zoom, y: (this.el.clientHeight / 2 - this.pan.y) / this.zoom }; }
  updateView() {
    this.el.style.setProperty('--board-inverse-zoom', String(1 / this.zoom));
    this.stage.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
    const spacing = Math.max(8, 20 * this.zoom);
    this.el.style.backgroundSize = `${spacing}px ${spacing}px`;
    this.el.style.backgroundPosition = `${this.pan.x}px ${this.pan.y}px`;
    this.updateSelectionTools(); this.onViewChange(this.getView());
  }
  setZoom(value, anchor) {
    const next = Math.max(.15, Math.min(2.5, finite(value, 1)));
    const screen = anchor || { x: this.el.clientWidth / 2, y: this.el.clientHeight / 2 };
    const world = { x: (screen.x - this.pan.x) / this.zoom, y: (screen.y - this.pan.y) / this.zoom };
    this.zoom = next; this.pan = { x: screen.x - world.x * next, y: screen.y - world.y * next }; this.updateView();
    return this.zoom;
  }
  fit() {
    if (this.focusedId) { this.fitFocusedEntity(); return; }
    const items = [...this.entities.values()];
    if (!items.length) { this.pan = { x: 24, y: 24 }; this.zoom = 1; this.updateView(); return; }
    const minX = Math.min(...items.map(e => e.x)); const minY = Math.min(...items.map(e => e.y));
    const maxX = Math.max(...items.map(e => e.x + e.width)); const maxY = Math.max(...items.map(e => e.y + e.height));
    this.zoom = Math.max(.15, Math.min(1.25, (this.el.clientWidth - 120) / Math.max(1, maxX - minX), (this.el.clientHeight - 120) / Math.max(1, maxY - minY)));
    this.pan = { x: (this.el.clientWidth - (maxX - minX) * this.zoom) / 2 - minX * this.zoom, y: (this.el.clientHeight - (maxY - minY) * this.zoom) / 2 - minY * this.zoom };
    this.updateView();
  }
  setTool(tool) {
    if (this.focusedId && tool !== 'select') this.exitFocus();
    const changed = this.tool !== tool;
    this.tool = tool;
    this.el.dataset.tool = tool;
    if (tool !== 'select') this.select(null);
    if (changed) this.onToolChange(tool);
  }
  mayEdit(entity) { return !this.readOnly && (!entity || this.canEdit(entity)); }
  /** Stable bottom-to-top order, including objects received before their ordering update. */
  listEntities() {
    const positions = new Map(this.layerOrder.map((id, index) => [id, index]));
    return [...this.entities.values()].sort((a, b) => {
      const aPosition = positions.get(a.id); const bPosition = positions.get(b.id);
      if (aPosition != null && bPosition != null) return aPosition - bPosition;
      if (aPosition != null) return -1;
      if (bPosition != null) return 1;
      return finite(a.z) - finite(b.z) || a.id.localeCompare(b.id);
    });
  }
  listVisibleEntities() { return this.focusedId ? this.listEntities().filter(entity => entity.id === this.focusedId) : this.listEntities(); }
  setLayerOrder(ids) {
    const next = [...new Set(ids.filter(id => typeof id === 'string'))];
    if (next.length === this.layerOrder.length && next.every((id, index) => id === this.layerOrder[index])) return;
    this.layerOrder = next;
    this.refreshEntityControls(true);
  }
  applyLayerOrder() {
    this.layerOrderDirty = false;
    this.layerRanks.clear();
    this.listEntities().forEach((entity, index) => {
      const rank = index + 1; this.layerRanks.set(entity.id, rank);
      const node = this.nodes.get(entity.id); if (node && node.style.zIndex !== String(rank)) node.style.zIndex = String(rank);
    });
    this.updateLayers();
  }
  refreshEntityControls(orderChanged = false) {
    this.layerOrderDirty ||= orderChanged;
    if (this.entityBatchDepth) return;
    if (this.layerOrderDirty) this.applyLayerOrder(); else this.updateLayers();
    this.updateSelectionTools();
  }
  changeLayer(id, action) {
    const entity = this.entities.get(id);
    if (!entity || !this.mayEdit(entity) || !['front', 'back', 'forward', 'backward'].includes(action)) return;
    if (this.onLayerAction) { this.onLayerAction(id, action); return; }
    const ids = this.listEntities().map(item => item.id); const previous = ids.indexOf(id);
    const target = action === 'front' ? ids.length - 1 : action === 'back' ? 0 : previous + (action === 'forward' ? 1 : -1);
    if (target < 0 || target >= ids.length || target === previous) return;
    ids.splice(previous, 1); ids.splice(target, 0, id); this.setLayerOrder(ids);
    // Standalone Boards can persist their order using the original change callback.
    ids.forEach((itemId, index) => {
      const current = this.entities.get(itemId); this.commit({ ...current, z: index + 1 }, { z: index + 1 });
    });
  }
  toggleLock(id) {
    const entity = this.entities.get(id); if (!entity || !this.mayEdit(entity)) return;
    const locked = !entity.locked;
    if (this.onLockChange) this.onLockChange(id, locked);
    else this.commit({ ...entity, locked }, { locked });
  }
  updateLayers() {
    if (!this.layersList) return;
    this.layersCount.textContent = String(this.entities.size);
    // The collapsed layers panel does not need a second DOM tree for the canvas.
    // Build its current rows when opened, and release them again when closed.
    if (!this.layersPopover.isOpen) {
      this.layersSignature = null;
      if (this.layersList.childElementCount) this.layersList.replaceChildren();
      return;
    }
    const entities = this.listEntities().reverse();
    const nextSignature = JSON.stringify([this.selectedId, entities.map(entity => [entity.id, entity.type, entity.title, entity.text, !!entity.locked, this.mayEdit(entity)])]);
    if (nextSignature === this.layersSignature) return;
    const active = this.el.ownerDocument.activeElement;
    const focusedRow = this.layersPanel.contains(active) ? active.closest('[data-layer-id]') : null;
    const focusedControl = focusedRow && { id: focusedRow.dataset.layerId, lock: active.classList.contains('board-layer-lock') };
    const scrollTop = this.layersList.scrollTop;
    this.layersSignature = nextSignature; this.layersList.replaceChildren();
    if (!entities.length) this.layersList.append(element('p', 'board-layers-empty', 'Objects appear here as you add them.'));
    for (const entity of entities) {
      const row = element('div', 'board-layer-row'); row.classList.toggle('is-selected', entity.id === this.selectedId);
      row.dataset.layerId = entity.id;
      const select = element('button', 'board-layer-select'); select.type = 'button';
      const type = entity.type === 'sticky' ? 'Sticky note' : entity.type === 'screen' ? 'Shared screen' : entity.type[0].toUpperCase() + entity.type.slice(1);
      const title = (entity.title || entity.text || type).replace(/\s+/g, ' ').trim().slice(0, 100) || type;
      select.setAttribute('aria-label', `Select ${type.toLowerCase()}: ${title}`);
      select.setAttribute('aria-pressed', String(entity.id === this.selectedId));
      select.append(icon(['screen', 'image', 'diagram'].includes(entity.type) ? entity.type : 'layers', 15));
      const detail = element('span', 'board-layer-detail');
      detail.append(element('span', 'board-layer-title', title), element('span', 'board-layer-type', type)); select.append(detail);
      select.addEventListener('click', () => {
        if (this.focusedId && this.focusedId !== entity.id) this.exitFocus();
        this.setTool('select'); this.select(entity.id); this.revealEntity(entity.id);
        this.el.focus({ preventScroll: true });
      });
      const lock = button(entity.locked ? 'Unlock position' : 'Lock position', entity.locked ? 'lock' : 'unlock', () => this.toggleLock(entity.id));
      lock.classList.add('board-layer-lock'); lock.disabled = !this.mayEdit(entity); lock.setAttribute('aria-pressed', String(!!entity.locked));
      row.append(select, lock); this.layersList.append(row);
    }
    this.layersList.scrollTop = scrollTop;
    if (focusedControl) {
      const row = [...this.layersList.children].find(row => row.dataset.layerId === focusedControl.id);
      const control = row?.querySelector(focusedControl.lock ? '.board-layer-lock' : '.board-layer-select');
      (control && !control.disabled ? control : this.layersToggle).focus({ preventScroll: true });
    }
  }
  cancelPositionGesture() {
    if (!this.gesture || !['move', 'resize'].includes(this.gesture.type)) return;
    const gesture = this.gesture;
    this.gesture = null; this.el.classList.remove('board-is-dragging');
    const pointerId = this.activePointerId; this.activePointerId = null;
    this.releasePointer(pointerId); if (gesture.pointerType !== 'touch') this.endHistoryGroup();
  }
  // Measure synchronous DOM and layer work once per outer update. A bulk
  // setEntities call includes its nested upserts/removals, without extra samples.
  // Camera transforms and asynchronous diagram/image loading are separate work.
  beginRenderMeasurement() {
    this.renderMeasurementDepth += 1;
    if (this.renderMeasurementDepth !== 1) return;
    try { this.finishRenderMeasurement = this.performanceIndex?.start?.('canvas-render'); } catch { /* Diagnostics must never interrupt editing. */ }
  }
  endRenderMeasurement(failed) {
    this.renderMeasurementDepth -= 1;
    if (this.renderMeasurementDepth !== 0) return;
    const finish = this.finishRenderMeasurement; this.finishRenderMeasurement = null;
    try { if (typeof finish === 'function') finish({ failed }); } catch { /* Preserve the canvas result even if diagnostics fail. */ }
  }
  setReadOnly(value) {
    this.beginRenderMeasurement(); let failed = true;
    try {
      this.readOnly = !!value;
      if (this.readOnly) this.closeDiagramEditor();
      this.el.classList.toggle('board-read-only', this.readOnly);
      if (this.readOnly && this.touchPointers.size) this.cancelPointers();
      if (this.readOnly && this.gesture && this.gesture.type !== 'pan') {
        if (this.gesture.type === 'create') this.remove(this.gesture.id);
        else if (this.gesture.original) this.upsert(this.gesture.original);
        this.gesture = null; this.el.classList.remove('board-is-dragging');
        if (this.activePointerId != null && this.el.hasPointerCapture(this.activePointerId)) this.el.releasePointerCapture(this.activePointerId);
        this.activePointerId = null; this.endHistoryGroup();
      }
      if (this.readOnly && this.editingId) this.finishTextEdit?.(false);
      for (const entity of this.entities.values()) this.renderEntity(entity);
      this.updateSelectionTools(); this.updateLayers();
      failed = false;
    } finally {
      this.endRenderMeasurement(failed);
    }
  }
  setColor(color) {
    this.color = color;
    const entity = this.entities.get(this.selectedId);
    if (entity && this.mayEdit(entity) && entity.type !== 'screen' && entity.type !== 'image' && entity.type !== 'diagram') this.commit({ ...entity, color }, { color });
  }
  setEntities(entities) {
    this.beginRenderMeasurement(); let failed = true;
    try {
      this.entityBatchDepth += 1;
      try {
        const incoming = new Set(entities.map(e => e.id));
        for (const id of this.entities.keys()) if (!incoming.has(id)) this.remove(id);
        for (const entity of entities) this.upsert(entity);
      } finally {
        this.entityBatchDepth -= 1;
        this.refreshEntityControls();
      }
      failed = false;
    } finally {
      this.endRenderMeasurement(failed);
    }
  }
  upsert(entity, { gesturePreview = false } = {}) {
    if (!entity?.id || !DEFAULTS[entity.type]) return;
    this.beginRenderMeasurement(); let failed = true;
    try {
      const normalized = { ...DEFAULTS[entity.type], ...entity, x: finite(entity.x), y: finite(entity.y), width: Math.max(2, finite(entity.width, DEFAULTS[entity.type].width)), height: Math.max(2, finite(entity.height, DEFAULTS[entity.type].height)) };
      // A touch drag is an unshared preview. Remember newer canonical geometry so
      // switching to navigation never restores an older position over a teammate.
      if (!gesturePreview && this.gesture?.id === entity.id && this.gesture.pointerType === 'touch' && ['move', 'resize'].includes(this.gesture.type)) this.gesture.original = { ...normalized };
      if (this.gesture?.id === entity.id && (normalized.locked || !this.mayEdit(normalized))) this.cancelPositionGesture();
      const previous = this.entities.get(entity.id);
      this.entities.set(entity.id, normalized); this.renderEntity(normalized);
      this.refreshEntityControls(!previous || previous.z !== normalized.z);
      if (this.focusedId === entity.id) this.updateFocusBar();
      if (this.focusedId === entity.id && (!previous || ['x', 'y', 'width', 'height'].some(key => previous[key] !== normalized[key]))) this.fitFocusedEntity();
      failed = false;
    } finally {
      this.endRenderMeasurement(failed);
    }
  }
  remove(id) {
    this.beginRenderMeasurement(); let failed = true;
    try {
      if (this.diagramEditor?.id === id) this.closeDiagramEditor();
      if (this.editingId === id) this.finishTextEdit?.(false);
      if (this.focusedId === id) this.exitFocus();
      if (this.gesture?.id === id) this.cancelPositionGesture();
      this.entities.delete(id); this.nodes.get(id)?.remove(); this.nodes.delete(id); this.externalConsents.delete(id);
      if (this.selectedId === id) this.select(null);
      this.refreshEntityControls(true);
      failed = false;
    } finally {
      this.endRenderMeasurement(failed);
    }
  }
  commit(entity, patch) {
    const current = this.entities.get(entity.id);
    if (!this.mayEdit(current || entity)) {
      this.onStatus(this.readOnly ? 'Reconnect to edit the shared canvas.' : 'Only the screen owner or host can change this live screen.');
      if (current) { const node = this.nodes.get(current.id); if (node) node._signature = null; this.renderEntity(current); }
      return false;
    }
    if (patch == null && current) patch = Object.fromEntries(Object.entries(entity).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key])));
    this.upsert(entity); this.onChange(this.entities.get(entity.id), patch); return true;
  }
  add(type, options = {}) {
    if (!DEFAULTS[type]) return null;
    if (this.readOnly) { this.onStatus('Reconnect to edit the shared canvas.'); return null; }
    if (this.focusedId) this.exitFocus();
    const center = this.centerPoint(); const defaults = DEFAULTS[type];
    const entity = { id: crypto.randomUUID(), type, ...defaults, color: this.color, x: Math.round(center.x - defaults.width / 2), y: Math.round(center.y - defaults.height / 2), z: this.nextZ(), ...options };
    if (entity.externalConsent) this.externalConsents.add(entity.id);
    this.commit(entity); this.select(entity.id);
    return entity;
  }
  nextZ() { return Math.max(0, ...[...this.entities.values()].map(e => finite(e.z))) + 1; }
  select(id) {
    if (this.focusedId && id !== this.focusedId) this.exitFocus();
    if (this.selectedId === id) return;
    if (this.selectedId) this.nodes.get(this.selectedId)?.classList.remove('is-selected');
    this.selectedId = id && this.entities.has(id) ? id : null;
    if (this.selectedId) this.nodes.get(this.selectedId)?.classList.add('is-selected');
    this.updateSelectionTools(); this.updateLayers(); this.onSelect(this.entities.get(this.selectedId) || null);
  }
  deleteSelected() {
    if (!this.selectedId) return;
    const entity = this.entities.get(this.selectedId);
    if (!this.mayEdit(entity)) { this.onStatus(this.readOnly ? 'Reconnect to edit the shared canvas.' : 'Only the screen owner or host can remove this live screen.'); return; }
    const id = this.selectedId; this.remove(id); this.onDelete(id);
  }
  duplicateSelected() {
    const entity = this.entities.get(this.selectedId);
    if (!entity) return;
    if (entity.type === 'screen') { this.onStatus('Live screens cannot be duplicated. Share another window to add a screen.'); return; }
    const { id: _id, orderKey: _orderKey, z: _z, locked: _locked, updatedAt: _updatedAt, updatedBy: _updatedBy, ...content } = entity;
    return this.add(entity.type, { ...content, x: entity.x + 28, y: entity.y + 28, locked: false });
  }
  updateSelected(patch) {
    const entity = this.entities.get(this.selectedId);
    if (entity) {
      if (entity.locked && ['x', 'y', 'width', 'height'].some(key => key in patch)) { this.onStatus('Unlock position to move or resize this object.'); return; }
      this.commit({ ...entity, ...patch }, patch);
    }
  }
  editableContent(entity) { return !!entity && ['text', 'sticky', 'rectangle', 'ellipse', 'diagram'].includes(entity.type); }
  beginHistoryGroup(label) {
    if (this.historyGroup) return;
    this.historyGroup = true; this.onHistoryStart(label);
  }
  endHistoryGroup() {
    if (!this.historyGroup) return;
    this.historyGroup = false; this.onHistoryEnd();
  }
  /** Reveal a layer locally, preserving zoom unless the object is larger than the viewport. */
  revealEntity(id) {
    const entity = this.entities.get(id); if (!entity) return false;
    if (this.focusedId) { this.fitFocusedEntity(); return true; }
    const point = this.toClient(entity); const margin = 64;
    if (point.x >= margin && point.y >= margin && point.x + entity.width * this.zoom <= this.el.clientWidth - margin && point.y + entity.height * this.zoom <= this.el.clientHeight - margin) return true;
    const availableWidth = Math.max(40, this.el.clientWidth - margin * 2); const availableHeight = Math.max(40, this.el.clientHeight - margin * 2);
    this.zoom = Math.max(.15, Math.min(this.zoom, availableWidth / entity.width, availableHeight / entity.height));
    this.pan = { x: this.el.clientWidth / 2 - (entity.x + entity.width / 2) * this.zoom, y: this.el.clientHeight / 2 - (entity.y + entity.height / 2) * this.zoom };
    this.updateView(); return true;
  }
  /** Reading view: no geometry writes, capture requests, or subscription changes. */
  focusEntity(id = this.selectedId, { hint = null, focusControls = true } = {}) {
    const entity = this.entities.get(id); if (!entity || this.gesture || this.editingId) return false;
    this.focusHintText = hint;
    if (!this.focusedId) this.previousFocusView = this.getView();
    this.focusedId = id; this.tool = 'select'; this.el.dataset.tool = 'select'; this.onToolChange('select');
    this.layersPopover.close({ restoreFocus: false });
    this.select(id); this.updateLayers();
    this.el.classList.add('board-is-focused');
    for (const [entityId, node] of this.nodes) node.classList.toggle('is-focused', entityId === id);
    this.focusBar.hidden = false; this.updateFocusBar();
    this.fitFocusedEntity(); if (focusControls) this.backButton.focus({ preventScroll: true }); return true;
  }
  focusSelected() { return this.focusEntity(this.selectedId); }
  updateFocusBar() {
    const entity = this.entities.get(this.focusedId); if (!entity) return;
    this.focusHint.textContent = this.focusHintText || 'Only your view · Shared layout stays the same';
    this.focusTitle.textContent = entity.title || (entity.type === 'screen' ? 'Shared window' : 'Focused object');
    const view = entity.type === 'screen' ? this.screenView(entity) : null;
    const next = JSON.stringify([entity.id, view]); if (next === this.focusActionsSignature) return;
    this.focusActionsSignature = next; const hadFocus = this.focusActions.contains(document.activeElement);
    this.focusActions.replaceChildren();
    if (view?.managed && !view.local) this.focusActions.append(this.screenWatchButton(entity, view.watched));
    this.focusActions.hidden = !this.focusActions.childElementCount;
    if (hadFocus) (this.focusActions.firstElementChild || this.backButton).focus({ preventScroll: true });
  }
  fitFocusedEntity() {
    const entity = this.entities.get(this.focusedId); if (!entity) return;
    const top = Math.max(84, this.focusBar.offsetHeight + 32); const side = this.el.clientWidth < 540 ? 24 : 48; const bottom = Math.max(64, parseFloat(getComputedStyle(this.el).getPropertyValue('--canvas-overlay-bottom')) || 124);
    const width = Math.max(40, this.el.clientWidth - side * 2); const height = Math.max(40, this.el.clientHeight - top - bottom);
    this.zoom = Math.max(.01, Math.min(2.5, width / entity.width, height / entity.height));
    this.pan = { x: this.el.clientWidth / 2 - (entity.x + entity.width / 2) * this.zoom, y: top + height / 2 - (entity.y + entity.height / 2) * this.zoom };
    this.updateView();
  }
  exitFocus({ restoreFocus = this.el.contains(document.activeElement), preserveView = false } = {}) {
    if (!this.focusedId) return false;
    const previous = this.previousFocusView; this.focusedId = null; this.previousFocusView = null;
    this.el.classList.remove('board-is-focused'); this.focusBar.hidden = true;
    for (const node of this.nodes.values()) node.classList.remove('is-focused');
    if (previous && !preserveView) { this.zoom = previous.zoom; this.pan = { x: previous.x, y: previous.y }; }
    this.updateView(); if (restoreFocus) this.el.focus({ preventScroll: true }); return true;
  }
  editSelected() {
    const entity = this.entities.get(this.selectedId);
    if (!entity || !this.mayEdit(entity) || !this.editableContent(entity)) return false;
    const writing = entity.type !== 'diagram' && useWritingSurface();
    if (this.focusedId) this.exitFocus({ restoreFocus: false, preserveView: writing });
    if (!writing) this.revealEntity(entity.id);
    if (entity.type === 'diagram') { if (this.onEditDiagram) this.onEditDiagram(entity); else this.editDiagram(entity); }
    else this.editText(entity.id);
    return true;
  }
  updateSelectionTools() {
    const entity = this.entities.get(this.selectedId); const editable = entity && this.mayEdit(entity);
    const show = !!entity && !this.gesture && this.editingId !== this.selectedId && !this.focusedId;
    if (this.selectionTools.hidden !== !show) this.selectionTools.hidden = !show;
    if (this.selectionHint.hidden !== !show) this.selectionHint.hidden = !show;
    if (!entity) return;
    const hint = editable && !entity.locked
      ? `Arrows move · Alt + arrows resize · Shift for 10 px · ${this.editableContent(entity) ? 'Enter edit · ' : ''}F focus`
      : `${entity.locked ? 'Position locked · ' : ''}${editable && this.editableContent(entity) ? 'Enter edit · ' : ''}F focus (only your view)`;
    if (this.selectionHint.textContent !== hint) this.selectionHint.textContent = hint;
    for (const control of [...this.layerButtons.values(), this.lockButton, this.duplicateButton, this.deleteButton, this.mutationDivider]) {
      if (control.hidden !== !editable) control.hidden = !editable;
    }
    const hideEdit = !editable || !this.editableContent(entity);
    if (this.editButton.hidden !== hideEdit) this.editButton.hidden = hideEdit;
    const order = this.listEntities(); const position = order.findIndex(item => item.id === entity.id);
    for (const action of ['front', 'forward', 'back', 'backward']) {
      const control = this.layerButtons.get(action);
      const disabled = !editable || position === (['front', 'forward'].includes(action) ? order.length - 1 : 0);
      if (control.disabled !== disabled) control.disabled = disabled;
    }
    const locked = String(!!entity.locked);
    if (this.lockButton.getAttribute('aria-pressed') !== locked) {
      const label = entity.locked ? 'Unlock position' : 'Lock position';
      this.lockButton.title = label; this.lockButton.setAttribute('aria-label', label); this.lockButton.setAttribute('aria-pressed', locked);
      this.lockButton.replaceChildren(icon(entity.locked ? 'lock' : 'unlock', 15));
    }
    const disableDuplicate = entity.type === 'screen';
    if (this.duplicateButton.disabled !== disableDuplicate) this.duplicateButton.disabled = disableDuplicate;
    const point = this.toClient(entity);
    const width = this.selectionTools.offsetWidth || Math.min(310, this.el.clientWidth - 16);
    const height = this.selectionTools.offsetHeight || 44;
    const x = Math.max(8, Math.min(this.el.clientWidth - width - 8, point.x + entity.width * this.zoom / 2 - width / 2));
    const top = Math.min(this.selectionTop, Math.max(8, this.el.clientHeight - height - 8));
    const y = Math.max(top, Math.min(this.el.clientHeight - height - 8, point.y - height - 8));
    this.selectionTools.style.transform = `translate(${x}px, ${y}px)`;
  }

  renderEntity(entity) {
    let node = this.nodes.get(entity.id);
    if (!node) {
      node = element('div', `board-entity type-${entity.type}`); node.dataset.entityId = entity.id;
      node.setAttribute('role', 'group'); this.nodes.set(entity.id, node); this.stage.insertBefore(node, this.cursorLayer);
    }
    node.style.left = `${entity.x}px`; node.style.top = `${entity.y}px`;
    node.style.width = `${entity.width}px`; node.style.height = `${entity.height}px`;
    // Membership and stacking changes assign all ranks together. Geometry and
    // content edits retain their rank without sorting the canvas for every node.
    const rank = this.layerRanks.get(entity.id); if (rank != null) node.style.zIndex = String(rank);
    node.classList.toggle('is-selected', entity.id === this.selectedId);
    node.classList.toggle('is-focused', entity.id === this.focusedId);
    node.classList.toggle('is-readonly', !this.mayEdit(entity));
    node.classList.toggle('is-position-locked', !!entity.locked);
    node.setAttribute('aria-label', entity.title || `${entity.type} on canvas`);
    if (this.editingId === entity.id) return;
    if (node._signature === signature(entity)) { this.fitText(node, entity); return; }
    node._signature = signature(entity);
    const previousVideo = node.querySelector('video'); if (previousVideo) previousVideo.srcObject = null;
    node.replaceChildren();
    if (entity.type === 'text' || entity.type === 'sticky') this.renderText(node, entity);
    else if (entity.type === 'screen') this.renderScreen(node, entity);
    else if (entity.type === 'image') this.renderImage(node, entity);
    else if (entity.type === 'diagram') this.renderDiagram(node, entity);
    else this.renderShape(node, entity);
    this.fitText(node, entity);
    const resize = element('button', 'board-resize-handle'); resize.type = 'button'; resize.dataset.resize = 'true';
    resize.setAttribute('aria-label', 'Resize selected object. Use arrow keys; hold Shift for 10 pixels.'); resize.title = 'Drag to resize · Arrows resize · Shift for 10 px';
    node.append(resize);
  }
  header(entity, label, iconName) {
    const header = element('div', 'board-card-header'); header.dataset.dragHandle = 'true';
    const title = element('div', 'board-card-title');
    if (iconName) title.append(icon(iconName, 15));
    title.append(element('span', '', label)); header.append(title);
    if (entity.type === 'screen') {
      const live = element('span', 'board-live-badge', 'LIVE'); live.append(element('i')); header.append(live);
    } else header.append(icon('grip', 14));
    return header;
  }
  renderText(node, entity) {
    if (entity.type === 'sticky') node.style.backgroundColor = entity.fill || '#fff0b5';
    const content = element('div', 'board-text-content', entity.text || '');
    content.style.color = entity.color || COLORS[entity.type] || COLORS.text;
    content.setAttribute('aria-label', entity.type === 'sticky' ? 'Sticky note text; double click to edit' : 'Text; double click to edit');
    content.spellcheck = true; content.dataset.editable = 'true';
    if (entity.type === 'text' && entity.title) node.append(element('div', 'board-text-eyebrow', entity.title));
    node.append(content);
    const grip = element('div', 'board-text-grip'); grip.dataset.dragHandle = 'true'; grip.append(icon('grip', 15)); node.append(grip);
  }
  fitText(node, entity) {
    if (!node || this.editingId === entity.id || !['text', 'sticky', 'rectangle', 'ellipse'].includes(entity.type)) return;
    const content = node.querySelector('[data-editable]'); if (!content) return;
    const previous = content._layoutSource;
    // Position, stacking, selection, and room updates do not measure text again.
    if (previous && previous.text === entity.text && previous.type === entity.type
      && previous.width === entity.width && previous.height === entity.height
      && previous.revision === this.textLayout.revision) return;
    const layout = this.textLayout.layout(entity);
    this.setTextMetrics(content, layout);
    content.textContent = layout.lines.join('\n');
    content._layoutSource = { text: entity.text, type: entity.type, width: entity.width, height: entity.height, revision: this.textLayout.revision };
  }
  setTextMetrics(content, layout) {
    const style = content.style;
    for (const [key, value] of Object.entries({
      'x': layout.domX, 'y': layout.domY,
      'width': layout.domWidth, 'height': layout.textHeight / layout.renderScale,
      'font-size': layout.fontSize, 'line-height': layout.lineHeight,
      'render-size': layout.renderFontSize, 'render-line-height': layout.renderLineHeight,
    })) style.setProperty(`--text-${key}`, `${value}px`);
    style.setProperty('--text-render-scale', layout.renderScale);
    style.setProperty('--text-font-family', layout.fontFamily);
    style.setProperty('--text-font-weight', layout.fontWeight);
    style.setProperty('--text-align', layout.align);
  }
  getEditingText() {
    if (!this.editingContent) return null;
    return this.editingDirty ? editorText(this.editingContent) : this.entities.get(this.editingId)?.text || '';
  }
  renderScreen(node, entity) {
    const header = this.header(entity, entity.title || 'Shared screen', 'screen'); node.append(header);
    if (entity.historical) {
      header.querySelector('.board-live-badge').textContent = 'HISTORY';
      const frame = element('div', 'board-screen-frame');
      const placeholder = element('div', 'board-screen-placeholder');
      placeholder.append(icon('screen', 32), element('strong', '', 'Window at this point in history'), element('span', '', 'The window’s placement was saved. Live video is not part of the canvas history.'));
      frame.append(placeholder); node.append(frame);
      return;
    }
    const frame = element('div', 'board-screen-frame');
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true;
    video.setAttribute('aria-label', entity.title || 'Shared window video');
    const view = this.screenView(entity);
    const stream = view.watched ? this.streams.get(entity.streamId) || this.streams.get(entity.participantId) : null;
    if (stream) { video.srcObject = stream; video.play().catch(() => {}); }
    const placeholder = element('div', 'board-screen-placeholder');
    placeholder.append(icon('screen', 32), element('strong', '', view.watched ? 'Connecting to shared window' : 'Window ready to watch'), element('span', '', view.watched ? 'The live view will appear here.' : 'Choose the windows you want to view.'));
    if (view.managed && !view.local && !view.watched) placeholder.append(this.screenWatchButton(entity, false));
    placeholder.hidden = !!stream; video.hidden = !stream;
    frame.append(video, placeholder); node.append(frame);
    if (!stream) header.querySelector('.board-live-badge').textContent = view.watched ? 'CONNECTING' : 'NOT WATCHING';
    const footer = element('div', 'board-screen-footer');
    footer.append(element('span', 'board-window-dot'), element('span', 'board-screen-footer-title', entity.title || 'Shared window'));
    if (view.managed && !view.local && view.watched) footer.append(this.screenWatchButton(entity, true));
    else footer.append(element('span', 'board-screen-footer-end', view.watched ? 'Live screen' : 'View paused'));
    const focus = button('Focus window — only your view', 'focus', () => this.focusEntity(entity.id));
    focus.classList.add('board-screen-focus'); focus.append(element('span', '', 'Focus'));
    footer.append(focus); node.append(footer);
  }
  screenView(entity, subscriptions = this.screenSubscriptions, localParticipantId = this.localParticipantId) {
    const participantId = entity.participantId || entity.streamId;
    const local = localParticipantId != null && participantId === localParticipantId;
    return { managed: subscriptions !== null, local, watched: local || subscriptions === null || subscriptions.has(participantId) };
  }
  screenWatchButton(entity, watched) {
    const label = watched ? 'Pause view' : 'Watch window';
    const control = element('button', watched ? 'board-screen-pause' : 'board-screen-watch', label);
    control.type = 'button'; control.dataset.screenWatch = watched ? 'pause' : 'watch';
    control.setAttribute('aria-label', `${label}: ${entity.title || 'Shared window'}`);
    control.addEventListener('pointerdown', event => event.stopPropagation());
    control.addEventListener('dblclick', event => event.stopPropagation());
    control.addEventListener('keydown', event => event.stopPropagation());
    control.addEventListener('keyup', event => event.stopPropagation());
    control.addEventListener('click', event => {
      event.stopPropagation();
      this.onWatchScreen(entity.participantId || entity.streamId);
    });
    return control;
  }
  /** Local viewing choices do not change screen entities or stop another person's capture. */
  setScreenSubscriptions(ids, localParticipantId = this.localParticipantId) {
    const next = new Set([...(ids || [])].filter(id => typeof id === 'string' && id));
    const previous = this.screenSubscriptions; const previousLocalId = this.localParticipantId;
    this.screenSubscriptions = next; this.localParticipantId = localParticipantId;
    for (const entity of this.entities.values()) {
      if (entity.type !== 'screen') continue;
      const before = this.screenView(entity, previous, previousLocalId); const after = this.screenView(entity);
      if (before.managed === after.managed && before.local === after.local && before.watched === after.watched) continue;
      const node = this.nodes.get(entity.id);
      if (node) { node._signature = null; this.renderEntity(entity); }
    }
    if (this.focusedId) this.updateFocusBar();
  }
  setStream(participantId, stream) {
    if (stream) this.streams.set(participantId, stream); else this.streams.delete(participantId);
    for (const entity of this.entities.values()) if (entity.participantId === participantId || entity.streamId === participantId) {
      const node = this.nodes.get(entity.id); if (node) { node._signature = null; this.renderEntity(entity); }
    }
  }
  renderImage(node, entity) {
    const image = document.createElement('img'); image.alt = entity.title || 'Shared image'; image.draggable = false;
    // Only inline image data can be persisted or loaded by this canvas.
    if (/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i.test(entity.url || '')) image.src = entity.url;
    node.append(image);
    if (entity.title) node.append(element('div', 'board-image-caption', entity.title));
  }
  renderDiagram(node, entity) {
    const header = this.header(entity, entity.title || 'Diagram', 'diagram');
    header.append(element('span', 'board-diagram-language', entity.language === 'plantuml' ? 'PLANTUML' : 'MERMAID'));
    node.append(header);
    const body = element('div', 'board-diagram-body'); node.append(body);
    const currentSignature = node._signature;
    if (entity.language === 'plantuml') {
      const renderer = getRuntimeConfig().plantUml;
      if (!renderer.enabled) {
        body.append(element('p', 'board-diagram-error', 'PlantUML rendering is disabled for this installation. Use Mermaid, or configure your organization’s renderer.')); return;
      }
      // A teammate's synchronized consent is not this browser's permission.
      if (!this.allowExternalPlantUml && !this.externalConsents.has(entity.id)) {
        const message = element('div', 'board-diagram-consent');
        message.append(icon('diagram', 27), element('strong', '', 'Render PlantUML diagram'), element('p', '', `Rendering sends the diagram source to ${new URL(renderer.endpoint).host}.`));
        const allow = element('button', 'board-consent-button', 'Allow rendering'); allow.type = 'button';
        allow.addEventListener('pointerdown', e => e.stopPropagation());
        allow.addEventListener('click', e => { e.stopPropagation(); this.externalConsents.add(entity.id); node._signature = null; this.renderEntity(this.entities.get(entity.id)); });
        message.append(allow); body.append(message); return;
      }
      const image = document.createElement('img'); image.alt = entity.title || 'PlantUML diagram'; image.draggable = false;
      try { image.src = plantUmlUrl(entity.source || '', renderer.endpoint); } catch (error) { body.append(element('p', 'board-diagram-error', error.message)); return; }
      image.addEventListener('error', () => { body.replaceChildren(element('p', 'board-diagram-error', 'Unable to render this diagram. Double click to edit the source.')); });
      body.append(image); return;
    }
    body.append(element('span', 'board-diagram-loading', 'Bringing your diagram to life…'));
    node._renderPromise = renderMermaid(entity.source || '').then(result => {
      if (!this.entities.has(entity.id) || node._signature !== currentSignature || !body.isConnected) return;
      const svgSource = typeof result === 'string' ? result : result.svg;
      const clean = DOMPurify.sanitize(svgSource, { USE_PROFILES: { svg: true, svgFilters: true } });
      const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
      if (parsed.documentElement.tagName !== 'svg') throw new Error('The diagram could not be rendered.');
      const svg = document.importNode(parsed.documentElement, true); svg.removeAttribute('height'); svg.removeAttribute('width'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', entity.title || 'Mermaid diagram');
      body.replaceChildren(svg);
    }).catch(error => {
      if (body.isConnected) body.replaceChildren(element('p', 'board-diagram-error', `Couldn’t render the diagram. Double click to edit its source. ${String(error.message || '').slice(0, 120)}`));
    });
  }
  renderShape(node, entity) {
    const svg = svgElement('svg', { width: '100%', height: '100%', viewBox: `0 0 ${entity.width} ${entity.height}`, preserveAspectRatio: 'none' });
    const color = entity.color || this.color;
    if (entity.type === 'rectangle') svg.append(svgElement('rect', { x: 2, y: 2, width: Math.max(1, entity.width - 4), height: Math.max(1, entity.height - 4), rx: 7, fill: entity.fill || 'transparent', stroke: color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
    else if (entity.type === 'ellipse') svg.append(svgElement('ellipse', { cx: entity.width / 2, cy: entity.height / 2, rx: Math.max(1, entity.width / 2 - 2), ry: Math.max(1, entity.height / 2 - 2), fill: entity.fill || 'transparent', stroke: color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
    else if (entity.type === 'draw') {
      const points = pointList(entity.points); const bounds = this.pointBounds(points);
      svg.setAttribute('viewBox', `${bounds.minX - 3} ${bounds.minY - 3} ${Math.max(6, bounds.maxX - bounds.minX + 6)} ${Math.max(6, bounds.maxY - bounds.minY + 6)}`);
      svg.append(svgElement('polyline', { points: points.map(p => `${p.x},${p.y}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    } else if (entity.type === 'arrow') {
      const points = pointList(entity.points);
      const start = points[0] || { x: 6, y: entity.height / 2 }; const end = points[points.length - 1] || { x: entity.width - 6, y: entity.height / 2 };
      // Scale an existing arrow's endpoints when its bounding box is resized.
      const bound = points.length ? this.pointBounds(points) : null;
      const scaleX = bound && bound.maxX > 0 ? entity.width / Math.max(1, bound.maxX) : 1;
      const scaleY = bound && bound.maxY > 0 ? entity.height / Math.max(1, bound.maxY) : 1;
      const a = { x: start.x * scaleX, y: start.y * scaleY }; const b = { x: end.x * scaleX, y: end.y * scaleY };
      const angle = Math.atan2(b.y - a.y, b.x - a.x); const head = 12;
      const path = `M${a.x},${a.y} L${b.x},${b.y} M${b.x - head * Math.cos(angle - .45)},${b.y - head * Math.sin(angle - .45)} L${b.x},${b.y} L${b.x - head * Math.cos(angle + .45)},${b.y - head * Math.sin(angle + .45)}`;
      svg.append(svgElement('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    }
    node.append(svg);
    if (entity.type === 'rectangle' || entity.type === 'ellipse') {
      const label = element('div', 'board-shape-label board-text-content', entity.text || '');
      label.dataset.editable = 'true';
      label.setAttribute('aria-label', 'Shape label; double click to edit');
      node.append(label);
    }
  }
  pointBounds(points) {
    if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)) };
  }

  releasePointer(pointerId) {
    if (pointerId != null && this.el.hasPointerCapture(pointerId)) this.el.releasePointerCapture(pointerId);
  }
  cancelTouchGesture() {
    const gesture = this.gesture; if (gesture?.pointerType !== 'touch') return;
    this.gesture = null; this.activePointerId = null;
    if (gesture.type === 'create') this.remove(gesture.id);
    else if (['move', 'resize'].includes(gesture.type)) {
      const current = this.entities.get(gesture.id);
      if (current) {
        const patch = gesture.type === 'move' ? { x: gesture.original.x, y: gesture.original.y } : { width: gesture.original.width, height: gesture.original.height };
        this.upsert({ ...current, ...patch });
      }
    }
    this.el.classList.remove('board-is-dragging'); this.updateSelectionTools();
  }
  cancelPointers() {
    const touchIds = [...this.touchPointers.keys()]; this.touchPointers.clear(); this.touchNavigation = false;
    if (this.gesture?.pointerType === 'touch') this.cancelTouchGesture();
    else if (this.gesture) this.pointerUp({ pointerId: this.activePointerId }, true);
    for (const id of touchIds) this.releasePointer(id);
  }
  touchViewPoints() {
    const [first, second] = [...this.touchPointers.entries()]; if (!second) return null;
    const rect = this.el.getBoundingClientRect();
    return {
      ids: [first[0], second[0]],
      midpoint: { x: (first[1].x + second[1].x) / 2 - rect.left, y: (first[1].y + second[1].y) / 2 - rect.top },
      distance: Math.max(1, Math.hypot(first[1].x - second[1].x, first[1].y - second[1].y)),
    };
  }
  beginTouchView() {
    const points = this.touchViewPoints(); if (!points) return;
    this.touchNavigation = true; this.cancelTouchGesture();
    this.gesture = { type: 'touch-view', pointerType: 'touch' };
    // Keep the object at the same size while leaving the leader's reading view.
    // updateView also tells the session guide this browser chose to explore.
    if (this.focusedId) this.exitFocus({ restoreFocus: false, preserveView: true });
    Object.assign(this.gesture, {
      ids: points.ids, distance: points.distance, zoom: this.zoom, minimumZoom: Math.min(.15, this.zoom),
      anchor: { x: (points.midpoint.x - this.pan.x) / this.zoom, y: (points.midpoint.y - this.pan.y) / this.zoom },
    });
    this.el.classList.add('board-is-dragging'); this.updateSelectionTools();
  }
  moveTouchView() {
    const gesture = this.gesture; const points = this.touchViewPoints();
    if (gesture?.type !== 'touch-view' || !points) return;
    this.zoom = Math.max(gesture.minimumZoom, Math.min(2.5, gesture.zoom * points.distance / gesture.distance));
    this.pan = { x: points.midpoint.x - gesture.anchor.x * this.zoom, y: points.midpoint.y - gesture.anchor.y * this.zoom };
    this.updateView();
  }

  pointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.target.closest('button:not([data-resize]),input,textarea,select,[contenteditable="true"]')) return;
    if (event.pointerType === 'touch') {
      if (this.gesture && this.gesture.pointerType !== 'touch') return;
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.el.setPointerCapture(event.pointerId);
      if (this.touchPointers.size >= 2) { event.preventDefault(); if (!this.touchNavigation) this.beginTouchView(); return; }
      if (this.touchNavigation) { event.preventDefault(); return; }
    } else if (this.touchPointers.size) return;
    if (this.gesture) return;
    const point = this.worldPoint(event); const targetNode = event.target.closest('[data-entity-id]');
    const entity = targetNode && this.entities.get(targetNode.dataset.entityId);
    // A two-finger navigation start must not dismiss chat or a text editor.
    // A completed one-finger action takes focus when it is committed instead.
    if (event.pointerType !== 'touch') this.el.focus({ preventScroll: true });
    if (this.spaceHeld || this.tool === 'hand' || event.button === 1) {
      event.preventDefault(); this.gesture = { type: 'pan', clientX: event.clientX, clientY: event.clientY, pan: { ...this.pan } };
    } else if (this.focusedId) { event.preventDefault(); return; }
    else if (entity && this.tool === 'select') {
      this.select(entity.id); event.preventDefault();
      if (this.focusedId || !this.mayEdit(entity) || entity.locked) return;
      if (event.target.closest('[data-resize]')) this.gesture = { type: 'resize', id: entity.id, start: point, original: { ...entity } };
      else this.gesture = { type: 'move', id: entity.id, start: point, original: { ...entity } };
    } else if (this.tool === 'select') { this.select(null); return; }
    else if (['rectangle', 'ellipse', 'arrow', 'draw'].includes(this.tool)) {
      if (this.readOnly) { this.onStatus('Reconnect to edit the shared canvas.'); return; }
      event.preventDefault(); this.select(null);
      const type = this.tool;
      const drawing = { id: crypto.randomUUID(), type, x: point.x, y: point.y, width: 2, height: 2, color: this.color, fill: 'transparent', z: this.nextZ(), points: [{ x: 0, y: 0 }] };
      this.gesture = { type: 'create', id: drawing.id, start: point, points: [point], entity: drawing, drawType: type };
      this.upsert(drawing);
    } else if (this.tool === 'text' || this.tool === 'sticky') {
      if (this.readOnly) { this.onStatus('Reconnect to edit the shared canvas.'); return; }
      if (event.pointerType === 'touch') { event.preventDefault(); this.gesture = { type: 'add-text', start: point, clientX: event.clientX, clientY: event.clientY, drawType: this.tool }; }
      else {
        const added = this.add(this.tool, { x: point.x, y: point.y, text: '' });
        this.setTool('select'); this.select(added.id); requestAnimationFrame(() => this.editText(added.id)); return;
      }
    } else if (this.tool === 'image') { this.onStatus('Drop an image onto the canvas, or use Add image in the toolbar.'); return; }
    else if (this.tool === 'diagram') { this.onStatus('Use the diagram button to add Mermaid or PlantUML source.'); return; }
    if (this.gesture) {
      this.gesture.pointerType = event.pointerType;
      if (this.gesture.type !== 'pan' && event.pointerType !== 'touch') this.beginHistoryGroup(this.gesture.type);
      this.activePointerId = event.pointerId; this.el.setPointerCapture(event.pointerId); this.el.classList.add('board-is-dragging'); this.updateSelectionTools();
    }
  }
  pointerMove(event) {
    if (this.touchPointers.has(event.pointerId)) {
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.touchNavigation) { event.preventDefault(); this.moveTouchView(); return; }
    }
    if (this.gesture && event.pointerId !== this.activePointerId) return;
    const point = this.worldPoint(event);
    if (performance.now() - this.lastCursor > 60) { this.lastCursor = performance.now(); this.onCursor({ x: Math.round(point.x), y: Math.round(point.y) }); }
    const gesture = this.gesture; if (!gesture) return;
    if (gesture.type === 'add-text') { if (Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) > 10) gesture.moved = true; return; }
    if (gesture.type !== 'pan' && this.readOnly) return;
    if (gesture.type === 'pan') {
      this.pan = { x: gesture.pan.x + event.clientX - gesture.clientX, y: gesture.pan.y + event.clientY - gesture.clientY }; this.updateView(); return;
    }
    if (gesture.type === 'move' || gesture.type === 'resize') {
      const current = this.entities.get(gesture.id); if (!current) return;
      if (current.locked || !this.mayEdit(current)) { this.cancelPositionGesture(); this.updateSelectionTools(); return; }
      const dx = point.x - gesture.start.x; const dy = point.y - gesture.start.y;
      const next = gesture.type === 'move' ? { ...current, x: gesture.original.x + dx, y: gesture.original.y + dy } : { ...current, width: Math.max(40, gesture.original.width + dx), height: Math.max(32, gesture.original.height + dy) };
      if (event.shiftKey && gesture.type === 'move') { next.x = snap(next.x); next.y = snap(next.y); }
      if (event.shiftKey && gesture.type === 'resize') next.height = next.width * gesture.original.height / gesture.original.width;
      this.upsert(next, { gesturePreview: true });
      // Share intermediate positions at a modest rate; the final position is always sent.
      // Touch previews wait for release so a second finger can navigate safely.
      if (gesture.pointerType !== 'touch' && (!gesture.lastSent || performance.now() - gesture.lastSent > 70)) {
        gesture.lastSent = performance.now();
        this.onChange(next, gesture.type === 'move' ? { x: next.x, y: next.y } : { width: next.width, height: next.height });
      }
      return;
    }
    if (gesture.type === 'create') {
      if (gesture.drawType === 'draw') gesture.points.push(point);
      const points = gesture.drawType === 'draw' ? gesture.points : [gesture.start, point];
      const bounds = this.pointBounds(points);
      const next = { ...gesture.entity, x: bounds.minX, y: bounds.minY, width: Math.max(2, bounds.maxX - bounds.minX), height: Math.max(2, bounds.maxY - bounds.minY) };
      if (gesture.drawType === 'draw' || gesture.drawType === 'arrow') next.points = points.map(p => ({ x: p.x - bounds.minX, y: p.y - bounds.minY }));
      this.upsert(next);
    }
  }
  pointerUp(event, cancelled = false) {
    const wasTouch = this.touchPointers.delete(event.pointerId);
    if (this.touchNavigation) {
      if (this.touchPointers.size < 2) {
        this.gesture = null; this.el.classList.remove('board-is-dragging'); this.updateSelectionTools();
      } else if (this.gesture?.ids.includes(event.pointerId)) this.beginTouchView();
      if (!this.touchPointers.size) this.touchNavigation = false;
      this.releasePointer(event.pointerId); return;
    }
    if (cancelled && wasTouch && this.gesture?.pointerType === 'touch') {
      this.cancelTouchGesture(); this.releasePointer(event.pointerId); return;
    }
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== this.activePointerId) { if (wasTouch) this.releasePointer(event.pointerId); return; }
    this.gesture = null; this.el.classList.remove('board-is-dragging');
    this.activePointerId = null;
    this.releasePointer(event.pointerId);
    let touchHistory = false;
    try {
    if (gesture.type === 'add-text') {
      if (cancelled || gesture.moved || this.readOnly) return;
      const added = this.add(gesture.drawType, { x: gesture.start.x, y: gesture.start.y, text: '' });
      if (added) { this.setTool('select'); this.select(added.id); this.editText(added.id); }
      return;
    }
    if (gesture.pointerType === 'touch' && gesture.type !== 'pan' && !this.readOnly) {
      this.el.focus({ preventScroll: true }); this.beginHistoryGroup(gesture.type); touchHistory = true;
    }
    if (gesture.type === 'move' || gesture.type === 'resize') {
      const entity = this.entities.get(gesture.id);
      if (entity && !entity.locked && this.mayEdit(entity)) {
        const source = cancelled ? gesture.original : entity;
        const patch = gesture.type === 'move' ? { x: source.x, y: source.y } : { width: source.width, height: source.height };
        this.commit({ ...entity, ...patch }, patch); this.onSelect(this.entities.get(gesture.id));
      }
    } else if (gesture.type === 'create') {
      let entity = this.entities.get(gesture.id);
      if (!entity) return;
      if (cancelled || (entity.width < 4 && entity.height < 4)) { this.remove(entity.id); return; }
      if (entity.type === 'draw') {
        const points = simplifyPoints(pointList(entity.points).map(p => [p.x, p.y]), 1.5);
        entity = { ...entity, points: pointList(points) };
      }
      this.commit(entity); this.select(entity.id);
      if (entity.type !== 'draw') this.setTool('select');
    }
    } finally { if (gesture.pointerType !== 'touch' || touchHistory) this.endHistoryGroup(); this.updateSelectionTools(); }
  }
  wheel(event) {
    if (event.target.closest('textarea,[contenteditable="true"]')) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = this.el.getBoundingClientRect();
      this.setZoom(this.zoom * Math.exp(-event.deltaY * .008), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    } else { this.pan.x -= event.deltaX; this.pan.y -= event.deltaY; this.updateView(); }
  }
  doubleClick(event) {
    if (this.tool !== 'select' || event.target.closest('button,input,textarea,select,[contenteditable="true"]')) return;
    // Pointer capture can retarget the native double-click to the viewport.
    const hit = event.target.closest('[data-entity-id]') || document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-entity-id]');
    const node = hit && this.el.contains(hit) ? hit : null; if (!node) return;
    const entity = this.entities.get(node.dataset.entityId); if (!entity) return;
    this.select(entity.id);
    if (entity.type === 'screen' || entity.type === 'image') { this.focusEntity(entity.id); return; }
    if (!this.mayEdit(entity)) { this.onStatus(this.readOnly ? 'Reconnect to edit the shared canvas.' : 'Only the screen owner or host can change this live screen.'); return; }
    this.editSelected();
  }

  setWritingStatus(value) {
    this.writingStatus = { state: value?.state || '', message: value?.message || '' };
    if (!this.writingStatusNode) return;
    if (this.writingStatusNode.textContent !== this.writingStatus.message) this.writingStatusNode.textContent = this.writingStatus.message;
    this.writingStatusNode.title = this.writingStatus.message;
    this.writingStatusNode.dataset.state = this.writingStatus.state;
    this.writingStatusNode.hidden = !this.writingStatus.message;
  }

  // Move the live editor, not a copy of its text. Canvas geometry and camera
  // remain untouched, while native selection, paste, and composition stay owned
  // by the same contenteditable throughout this session.
  openWritingSurface(content, entity, signal, complete) {
    const parent = content.parentNode, next = content.nextSibling;
    const originalAttributes = ['role', 'aria-label', 'aria-multiline'].map(name => [name, content.getAttribute(name)]);
    const surface = element('section', 'board-writing-surface');
    const bar = element('header', 'board-writing-bar');
    const heading = element('div', 'board-writing-heading');
    const label = entity.type === 'sticky' ? 'Note' : entity.type === 'text' ? 'Text' : 'Label';
    heading.append(element('strong', '', label));
    this.writingStatusNode = element('span', 'board-writing-status');
    this.writingStatusNode.setAttribute('role', 'status');
    heading.append(this.writingStatusNode);
    const done = element('button', 'board-writing-done', 'Done');
    done.type = 'button'; done.setAttribute('aria-label', 'Done editing');
    // Keep the live editor focused until completion; a pointer blur must not
    // remove its Done button before the click is dispatched.
    done.addEventListener('pointerdown', event => event.preventDefault(), { signal });
    done.addEventListener('click', () => {
      content.blur();
      complete();
      this.el.focus({ preventScroll: true });
    }, { signal });
    bar.append(heading, done);
    const body = element('div', 'board-writing-body');
    body.append(content); surface.append(bar, body);
    content.classList.add('board-writing-text');
    content.setAttribute('role', 'textbox'); content.setAttribute('aria-multiline', 'true');
    content.setAttribute('aria-label', `${label} text`);
    this.layersPopover.close({ restoreFocus: false });
    this.el.classList.add('board-is-writing'); this.el.append(surface);
    this.setWritingStatus(this.writingStatus);
    for (const type of ['pointerdown', 'dblclick', 'wheel'])
      surface.addEventListener(type, event => event.stopPropagation(), { signal });

    let frame;
    const reveal = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (this.editingContent !== content || this.editingComposing || !content.isConnected) return;
        const selection = document.getSelection();
        if (!selection?.rangeCount || !selection.isCollapsed || !content.contains(selection.focusNode)) return;
        const caret = selection.getRangeAt(0).getBoundingClientRect();
        if (!caret.height) return;
        const bounds = content.getBoundingClientRect(), viewport = window.visualViewport;
        const top = Math.max(bounds.top, viewport?.offsetTop || 0) + 16;
        const bottom = Math.min(bounds.bottom, viewport ? viewport.offsetTop + viewport.height : innerHeight) - 16;
        if (bottom <= top) return;
        if (caret.bottom > bottom) content.scrollTop += caret.bottom - bottom;
        else if (caret.top < top) content.scrollTop += caret.top - top;
      });
    };
    this.revealWritingCaret = reveal;
    for (const type of ['input', 'compositionend']) content.addEventListener(type, reveal, { signal });
    document.addEventListener('selectionchange', reveal, { signal });
    window.visualViewport?.addEventListener('resize', reveal, { signal });
    window.visualViewport?.addEventListener('scroll', reveal, { signal });
    window.addEventListener('resize', reveal, { signal });
    reveal();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      this.revealWritingCaret = null; this.writingStatusNode = null;
      content.classList.remove('board-writing-text');
      for (const [name, value] of originalAttributes) {
        if (value === null) content.removeAttribute(name); else content.setAttribute(name, value);
      }
      parent.insertBefore(content, next?.parentNode === parent ? next : null);
      surface.remove(); this.el.classList.remove('board-is-writing');
    };
  }

  editText(id) {
    const entity = this.entities.get(id), node = this.nodes.get(id);
    const content = node?.querySelector('[data-editable]');
    if (!entity || !content || !this.mayEdit(entity) || this.editingId === id) return;
    this.finishTextEdit?.();
    this.beginHistoryGroup('edit text');
    this.editingId = id; this.editingContent = content; this.editingComposing = false; this.editingDirty = false;
    this.select(id); this.updateSelectionTools();
    // Fitted display lines contain soft wraps. Only the original, unwrapped text
    // belongs in the editor and shared document, including on a no-op edit.
    const originalText = (entity.text || '').slice(0, 20000);
    content.textContent = originalText;
    const editEvents = new AbortController();
    const mobile = useWritingSurface();
    let completionFrame, compositionFrame, compositionSettling = false, completionRequested = false;
    const complete = () => {
      if (this.finishTextEdit !== finish) return;
      completionRequested = true;
      // A native IME owns unfinished composition. Wait for compositionend, then
      // one settling frame for final input; lifecycle cleanup remains synchronous.
      if (this.editingComposing) return;
      if (compositionSettling) {
        if (completionFrame === undefined) completionFrame = requestAnimationFrame(() => {
          completionFrame = undefined;
          if (!this.editingComposing) finish();
        });
      } else finish();
    };
    const restore = mobile ? this.openWritingSurface(content, entity, editEvents.signal, complete) : () => {};
    const finish = (save = true) => {
      if (this.finishTextEdit !== finish) return;
      if (completionFrame !== undefined) cancelAnimationFrame(completionFrame);
      if (compositionFrame !== undefined) cancelAnimationFrame(compositionFrame);
      const text = this.editingDirty ? editorText(content) : originalText;
      editEvents.abort(); content.removeEventListener('blur', onBlur);
      content.contentEditable = 'false'; node.classList.remove('is-editing');
      restore();
      this.editingId = null; this.editingContent = null; this.editingComposing = false; this.editingDirty = false; this.finishTextEdit = null;
      const current = this.entities.get(id);
      if (save && current && text !== originalText) this.commit({ ...current, text }, { text });
      else if (current) {
        // Remote content is deferred while this editor owns the DOM. Merely
        // opening and leaving it must not overwrite a teammate's latest text.
        node._signature = null; this.renderEntity(current);
      }
      this.endHistoryGroup(); this.updateSelectionTools();
    };
    const onBlur = event => {
      if (event.relatedTarget?.closest('.board-writing-surface')) return;
      complete();
    };
    this.finishTextEdit = finish;
    content.addEventListener('blur', onBlur);
    content.addEventListener('compositionstart', () => { this.editingComposing = true; }, { signal: editEvents.signal });
    content.addEventListener('compositionend', () => {
      this.editingComposing = false; compositionSettling = true;
      if (compositionFrame !== undefined) cancelAnimationFrame(compositionFrame);
      compositionFrame = requestAnimationFrame(() => { compositionFrame = undefined; compositionSettling = false; });
      this.revealWritingCaret?.();
      if (completionRequested) complete();
    }, { signal: editEvents.signal });
    content.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); content.blur(); this.el.focus({ preventScroll: true }); }
    }, { signal: editEvents.signal });
    content.addEventListener('paste', event => {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain').slice(0, 20000);
      document.execCommand('insertText', false, text);
    }, { signal: editEvents.signal });
    content.addEventListener('beforeinput', event => {
      if (event.inputType !== 'insertLineBreak' || event.isComposing || this.editingComposing) return;
      // This is a plain-text editor: Shift+Enter is the same newline as Enter.
      // The native paragraph command retains caret/undo behavior without the
      // extra terminal text-node newline Chromium adds for pre-wrap line breaks.
      event.preventDefault(); document.execCommand('insertParagraph', false);
    }, { signal: editEvents.signal });
    content.addEventListener('input', () => {
      this.editingDirty = true;
      // Keep the caret/IME DOM intact while fitting a desktop edit in place.
      if (!mobile) this.setTextMetrics(content, this.textLayout.layout({ ...this.entities.get(id), text: editorText(content) }));
    }, { signal: editEvents.signal });
    content.contentEditable = 'true'; node.classList.add('is-editing');
    content.focus({ preventScroll: mobile });
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(content); range.collapse(false);
    selection.removeAllRanges(); selection.addRange(range);
    this.revealWritingCaret?.();
  }
  editDiagram(entity) {
    this.closeDiagramEditor({ restoreFocus: false });
    if (!this.mayEdit(this.entities.get(entity.id))) return;
    const dialog = document.createElement('dialog'); dialog.className = 'board-source-dialog';
    const heading = element('h2', '', 'Edit diagram'); const label = element('label', '', entity.language === 'plantuml' ? 'PlantUML source' : 'Mermaid source');
    const headingId = `diagram-heading-${crypto.randomUUID()}`; heading.id = headingId; dialog.setAttribute('aria-labelledby', headingId);
    const originalSource = entity.source || '';
    const source = element('textarea', ''); source.value = originalSource; source.rows = 12; source.setAttribute('aria-label', label.textContent);
    source.id = `diagram-source-${crypto.randomUUID()}`; label.htmlFor = source.id; source.maxLength = 20000;
    const editor = { id: entity.id, dialog, opener: document.activeElement, restoreFocus: true }; this.diagramEditor = editor;
    const actions = element('div', 'board-dialog-actions');
    const cancel = element('button', '', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
    const save = element('button', 'primary', 'Update diagram'); save.type = 'button'; save.addEventListener('click', () => { const current = this.entities.get(entity.id); const nextSource = source.value.slice(0, 20000); if (current && nextSource !== originalSource) this.commit({ ...current, source: nextSource }, { source: nextSource }); dialog.close(); });
    actions.append(cancel, save); dialog.append(heading, label, source, actions); document.body.append(dialog);
    dialog.addEventListener('close', () => {
      if (this.diagramEditor === editor) this.diagramEditor = null;
      dialog.remove();
      if (!editor.restoreFocus || this.abort.signal.aborted) return;
      const opener = editor.opener;
      const target = opener?.isConnected && !opener.disabled && !opener.closest('[hidden],[inert]') && opener.getClientRects().length ? opener : this.el;
      target.focus({ preventScroll: true });
    }, { once: true });
    dialog.showModal(); source.focus();
  }
  closeDiagramEditor({ restoreFocus = true } = {}) {
    const editor = this.diagramEditor; if (!editor) return;
    this.diagramEditor = null; editor.restoreFocus = restoreFocus;
    editor.dialog.close(); editor.dialog.remove();
  }
  keyDown(event) {
    const target = event.target;
    if (!(target instanceof Element) || !this.el.contains(target) || event.defaultPrevented) return;
    if (document.querySelector('#modal-root .modal, dialog[open], [role="dialog"][aria-modal="true"]')) return;
    if (target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (event.key === 'Escape' && this.gesture) {
      event.preventDefault();
      const pan = this.gesture.type === 'pan' ? this.gesture.pan : null;
      this.cancelPointers();
      if (pan) { this.pan = { ...pan }; this.updateView(); }
      return;
    }
    if (event.key === 'Escape' && this.focusedId) { event.preventDefault(); this.exitFocus(); return; }
    const resizeHandle = target.closest('[data-resize]');
    if (target.closest('button,a,[role="button"]') && !resizeHandle) return;
    if (resizeHandle && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return;
    if (event.code === 'Space' && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); this.spaceHeld = true; this.el.classList.add('board-space-pan'); return; }
    if (event.key === 'Escape') { event.preventDefault(); this.select(null); this.setTool('select'); return; }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'f') { if (this.selectedId) { event.preventDefault(); this.focusSelected(); } return; }
    if (this.focusedId) return;
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'Enter') { if (this.editableContent(this.entities.get(this.selectedId))) { event.preventDefault(); this.editSelected(); } return; }
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (this.selectedId && !event.metaKey && !event.ctrlKey && directions[event.key]) {
      event.preventDefault(); const entity = this.entities.get(this.selectedId);
      if (!this.mayEdit(entity)) { this.onStatus(this.readOnly ? 'Reconnect to edit the shared canvas.' : 'Only the screen owner or host can change this live screen.'); return; }
      if (entity.locked) { this.onStatus('Unlock position to move or resize this object.'); return; }
      const [dx, dy] = directions[event.key]; const step = event.shiftKey ? 10 : 1;
      const patch = event.altKey || resizeHandle ? { width: Math.max(40, entity.width + dx * step), height: Math.max(32, entity.height + dy * step) } : { x: entity.x + dx * step, y: entity.y + dy * step };
      this.commit({ ...entity, ...patch }, patch); this.revealEntity(entity.id); return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedId) { event.preventDefault(); this.deleteSelected(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); this.duplicateSelected(); }
    if ((event.metaKey || event.ctrlKey) && event.key === '0') { event.preventDefault(); this.fit(); }
    if ((event.metaKey || event.ctrlKey) && this.selectedId && ['BracketRight', 'BracketLeft'].includes(event.code)) {
      event.preventDefault();
      const forward = event.code === 'BracketRight';
      this.changeLayer(this.selectedId, event.shiftKey ? (forward ? 'front' : 'back') : (forward ? 'forward' : 'backward'));
    }
  }

  setCursor(participantId, cursor) {
    if (!cursor) { this.removeCursor(participantId); return; }
    let node = this.cursors.get(participantId);
    if (!node) {
      node = element('div', 'board-remote-cursor');
      const pointer = svgElement('svg', { width: 18, height: 23, viewBox: '0 0 18 23', fill: 'currentColor' }); pointer.append(svgElement('path', { d: 'M1 1 16 13l-7 1-3 7Z', stroke: '#fff', 'stroke-width': 1.4 }));
      node.append(pointer, element('span', '', cursor.name || 'Teammate')); this.cursorLayer.append(node); this.cursors.set(participantId, node);
    }
    node.style.color = cursor.color || '#52765e'; node.style.transform = `translate(${finite(cursor.x)}px, ${finite(cursor.y)}px)`;
    node.querySelector('span').textContent = cursor.name || 'Teammate';
  }
  removeCursor(participantId) { this.cursors.get(participantId)?.remove(); this.cursors.delete(participantId); }
  async whenReadyForCapture(timeoutMs = 8000) {
    const pending = [...this.nodes.values()].map(node => node._renderPromise).filter(Boolean);
    if (!pending.length) return;
    let timer;
    try { await Promise.race([Promise.allSettled(pending), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  exportSvg() {
    const entities = this.listEntities().filter(e => e.type !== 'screen');
    const minX = entities.length ? Math.min(...entities.map(e => e.x)) - 24 : 0;
    const minY = entities.length ? Math.min(...entities.map(e => e.y)) - 24 : 0;
    const width = entities.length ? Math.max(...entities.map(e => e.x + e.width)) - minX + 24 : 1200;
    const height = entities.length ? Math.max(...entities.map(e => e.y + e.height)) - minY + 24 : 800;
    const svg = svgElement('svg', { xmlns: SVG_NS, width, height, viewBox: `${minX} ${minY} ${width} ${height}` });
    const fonts = svgElement('style'); fonts.textContent = SVG_TEXT_FONT_CSS; svg.append(fonts);
    const background = canvasBackground(this.el);
    svg.append(svgElement('rect', { x: minX, y: minY, width, height, fill: background.color }));
    if (background.pattern !== 'plain') {
      const defs = svgElement('defs');
      const pattern = svgElement('pattern', { id: 'common-export-background-pattern', patternUnits: 'userSpaceOnUse', width: 20, height: 20 });
      if (background.pattern === 'dots') pattern.append(svgElement('circle', { cx: 10, cy: 10, r: .8, fill: background.patternColor }));
      else pattern.append(svgElement('rect', { width: 1, height: 20, fill: background.patternColor }), svgElement('rect', { width: 20, height: 1, fill: background.patternColor }));
      defs.append(pattern); svg.append(defs, svgElement('rect', { x: minX, y: minY, width, height, fill: 'url(#common-export-background-pattern)' }));
    }
    for (const entity of entities) {
      const group = svgElement('g', { transform: `translate(${entity.x},${entity.y})` });
      if (['rectangle', 'ellipse', 'draw', 'arrow'].includes(entity.type)) {
        const shape = this.nodes.get(entity.id)?.querySelector('svg');
        if (shape) { const clone = shape.cloneNode(true); clone.setAttribute('width', entity.width); clone.setAttribute('height', entity.height); clone.style.overflow = 'visible'; group.append(clone); }
        if (entity.text && ['rectangle', 'ellipse'].includes(entity.type)) this.exportText(group, entity, '#435b43');
      } else if (entity.type === 'image' && (entity.url || '').startsWith('data:image/')) {
        group.append(svgElement('image', { href: entity.url, width: entity.width, height: entity.height, preserveAspectRatio: 'xMidYMid meet' }));
      } else if (entity.type === 'diagram') {
        group.append(svgElement('rect', { width: entity.width, height: entity.height, rx: 10, fill: '#fff', stroke: '#dfe4de' }));
        const diagram = this.nodes.get(entity.id)?.querySelector('.board-diagram-body svg');
        if (diagram) { const clone = diagram.cloneNode(true); clone.setAttribute('x', '16'); clone.setAttribute('y', '48'); clone.setAttribute('width', String(entity.width - 32)); clone.setAttribute('height', String(entity.height - 64)); group.append(clone); }
        else { const text = svgElement('text', { x: 16, y: 32, fill: '#28322f', 'font-family': 'sans-serif', 'font-size': 15 }); text.textContent = entity.title || 'Diagram'; group.append(text); }
      } else {
        if (entity.type === 'sticky') group.append(svgElement('rect', { width: entity.width, height: entity.height, rx: 6, fill: entity.fill || '#fff0b5' }));
        this.exportText(group, entity, entity.color || COLORS[entity.type] || COLORS.text);
      }
      svg.append(group);
    }
    return new XMLSerializer().serializeToString(svg);
  }
  exportText(group, entity, color) {
    const layout = this.textLayout.layout(entity);
    const text = svgElement('text', { fill: color, 'font-family': layout.fontFamily, 'font-weight': layout.fontWeight,
      'font-size': layout.renderFontSize, transform: `scale(${layout.renderScale})`, 'text-anchor': layout.align === 'center' ? 'middle' : 'start', 'xml:space': 'preserve',
      style: 'font-optical-sizing:none;font-kerning:normal;letter-spacing:0;white-space:pre' });
    layout.lines.forEach((line, index) => {
      const span = svgElement('tspan', { x: layout.x / layout.renderScale, y: layout.baseline / layout.renderScale + index * layout.renderLineHeight });
      span.textContent = line; text.append(span);
    });
    group.append(text);
  }
  destroy() {
    this.cancelPointers();
    this.closeDiagramEditor({ restoreFocus: false });
    this.finishTextEdit?.(false);
    this.endHistoryGroup(); this.abort.abort(); this.resizeObserver.disconnect(); this.layersPopover.destroy(); this.selectionToolbarCleanup();
    this.unsubscribeTextLayout(); this.textLayout.destroy();
    this.el.classList.remove('board-is-focused', 'board-space-pan', 'board-is-dragging', 'board-read-only');
    for (const node of this.nodes.values()) { const video = node.querySelector('video'); if (video) video.srcObject = null; }
    this.stage.remove(); this.selectionTools.remove(); this.selectionHint.remove(); this.focusBar.remove(); this.layersControl.remove(); this.el.removeAttribute('aria-describedby'); this.entities.clear(); this.nodes.clear(); this.streams.clear(); this.cursors.clear(); this.layerRanks.clear();
  }
}
export default Board;
