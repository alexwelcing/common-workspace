import DOMPurify from 'dompurify';
import { renderMermaid, plantUmlUrl } from './diagrams.js';
import { initGeometry, snap, simplifyPoints } from './geometry.js';
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
  const { x, y, width, height, z, orderKey, locked, updatedAt, updatedBy, ...content } = entity;
  return JSON.stringify(content);
}
function finite(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function pointList(points) { return (points || []).map(p => Array.isArray(p) ? { x: p[0], y: p[1] } : p); }

/** A collaborative, zoomable DOM/SVG whiteboard. Only local edits call onChange. */
export class Board {
  constructor({ el, onChange = () => {}, onDelete = () => {}, onCursor = () => {}, onSelect = () => {}, onStatus = () => {}, onViewChange = () => {}, onEditDiagram = null, onToolChange = () => {}, onLayerAction = null, onLockChange = null, allowExternalPlantUml = false, canEdit = () => true }) {
    this.el = el;
    this.onChange = onChange; this.onDelete = onDelete; this.onCursor = onCursor;
    this.onSelect = onSelect; this.onStatus = onStatus; this.onViewChange = onViewChange;
    this.onEditDiagram = onEditDiagram; this.onToolChange = onToolChange; this.allowExternalPlantUml = allowExternalPlantUml; this.canEdit = canEdit; this.readOnly = false;
    this.onLayerAction = onLayerAction; this.onLockChange = onLockChange; this.layerOrder = [];
    this.entities = new Map(); this.nodes = new Map(); this.streams = new Map(); this.cursors = new Map();
    this.externalConsents = new Set(); this.selectedId = null; this.tool = 'select'; this.color = '#52765e';
    this.zoom = 1; this.pan = { x: 24, y: 24 }; this.gesture = null; this.spaceHeld = false;
    this.abort = new AbortController(); this.lastCursor = 0; this.editingId = null;
    this.el.classList.add('common-board'); this.el.tabIndex = 0;
    this.el.setAttribute('aria-label', 'Shared canvas. Use the toolbar to add notes, drawings, and diagrams.');
    this.stage = element('div', 'board-stage');
    this.cursorLayer = element('div', 'board-cursor-layer');
    this.stage.append(this.cursorLayer); this.el.append(this.stage);
    this.selectionTools = element('div', 'board-selection-tools');
    this.selectionTools.setAttribute('role', 'toolbar'); this.selectionTools.setAttribute('aria-label', 'Selected object controls');
    this.layerButtons = new Map();
    for (const [action, label] of [['front', 'Bring to front'], ['forward', 'Bring forward'], ['backward', 'Send backward'], ['back', 'Send to back']]) {
      const control = button(label, action, () => this.changeLayer(this.selectedId, action));
      this.layerButtons.set(action, control); this.selectionTools.append(control);
    }
    this.lockButton = button('Lock position', 'lock', () => this.toggleLock(this.selectedId));
    this.selectionTools.append(this.lockButton, element('span', 'board-mini-divider'));
    this.duplicateButton = button('Duplicate selected item', 'duplicate', () => this.duplicateSelected());
    this.deleteButton = button('Delete selected item', 'trash', () => this.deleteSelected()); this.deleteButton.dataset.action = 'delete';
    this.selectionTools.append(
      this.duplicateButton, this.deleteButton,
    );
    this.el.append(this.selectionTools);
    this.layersControl = element('div', 'board-layers-control');
    this.layersToggle = element('button', 'board-layers-toggle'); this.layersToggle.type = 'button';
    this.layersToggle.setAttribute('aria-label', 'Layers'); this.layersToggle.setAttribute('aria-expanded', 'false');
    this.layersToggle.append(icon('layers', 16), element('span', '', 'Layers'));
    this.layersCount = element('span', 'board-layers-count', '0'); this.layersToggle.append(this.layersCount);
    this.layersPanel = element('section', 'board-layers-panel'); this.layersPanel.hidden = true;
    this.layersPanel.setAttribute('aria-label', 'Canvas layers');
    this.layersPanel.append(element('div', 'board-layers-heading', 'Top of canvas'));
    this.layersList = element('div', 'board-layers-list'); this.layersPanel.append(this.layersList);
    this.layersControl.append(this.layersToggle, this.layersPanel); this.el.append(this.layersControl);
    this.layersControl.addEventListener('pointerdown', event => event.stopPropagation());
    this.layersControl.addEventListener('dblclick', event => event.stopPropagation());
    this.layersControl.addEventListener('wheel', event => event.stopPropagation());
    this.layersToggle.addEventListener('click', () => {
      this.layersPanel.hidden = !this.layersPanel.hidden;
      this.layersToggle.setAttribute('aria-expanded', String(!this.layersPanel.hidden));
      this.updateLayers();
    });
    const signal = this.abort.signal;
    this.el.addEventListener('pointerdown', e => this.pointerDown(e), { signal });
    this.el.addEventListener('pointermove', e => this.pointerMove(e), { signal });
    this.el.addEventListener('pointerup', e => this.pointerUp(e), { signal });
    this.el.addEventListener('pointercancel', e => this.pointerUp(e, true), { signal });
    this.el.addEventListener('wheel', e => this.wheel(e), { passive: false, signal });
    this.el.addEventListener('dblclick', e => this.doubleClick(e), { signal });
    document.addEventListener('keydown', e => this.keyDown(e), { signal });
    document.addEventListener('keyup', e => { if (e.code === 'Space') { this.spaceHeld = false; this.el.classList.remove('board-space-pan'); } }, { signal });
    window.addEventListener('blur', () => { this.spaceHeld = false; this.el.classList.remove('board-space-pan'); }, { signal });
    this.resizeObserver = new ResizeObserver(() => this.updateSelectionTools()); this.resizeObserver.observe(this.el);
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
    const items = [...this.entities.values()];
    if (!items.length) { this.pan = { x: 24, y: 24 }; this.zoom = 1; this.updateView(); return; }
    const minX = Math.min(...items.map(e => e.x)); const minY = Math.min(...items.map(e => e.y));
    const maxX = Math.max(...items.map(e => e.x + e.width)); const maxY = Math.max(...items.map(e => e.y + e.height));
    this.zoom = Math.max(.15, Math.min(1.25, (this.el.clientWidth - 120) / Math.max(1, maxX - minX), (this.el.clientHeight - 120) / Math.max(1, maxY - minY)));
    this.pan = { x: (this.el.clientWidth - (maxX - minX) * this.zoom) / 2 - minX * this.zoom, y: (this.el.clientHeight - (maxY - minY) * this.zoom) / 2 - minY * this.zoom };
    this.updateView();
  }
  setTool(tool) {
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
  setLayerOrder(ids) {
    this.layerOrder = [...new Set(ids.filter(id => typeof id === 'string'))];
    this.applyLayerOrder(); this.updateSelectionTools();
  }
  applyLayerOrder() {
    this.listEntities().forEach((entity, index) => {
      const node = this.nodes.get(entity.id); if (node) node.style.zIndex = String(index + 1);
    });
    this.updateLayers();
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
    const entities = this.listEntities().reverse();
    this.layersCount.textContent = String(entities.length);
    const nextSignature = JSON.stringify([this.selectedId, entities.map(entity => [entity.id, entity.type, entity.title, entity.text, !!entity.locked, this.mayEdit(entity)])]);
    if (nextSignature === this.layersSignature) return;
    this.layersSignature = nextSignature; this.layersList.replaceChildren();
    if (!entities.length) { this.layersList.append(element('p', 'board-layers-empty', 'Objects appear here as you add them.')); return; }
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
      select.addEventListener('click', () => { this.setTool('select'); this.select(entity.id); });
      const lock = button(entity.locked ? 'Unlock position' : 'Lock position', entity.locked ? 'lock' : 'unlock', () => this.toggleLock(entity.id));
      lock.classList.add('board-layer-lock'); lock.disabled = !this.mayEdit(entity); lock.setAttribute('aria-pressed', String(!!entity.locked));
      row.append(select, lock); this.layersList.append(row);
    }
  }
  cancelPositionGesture() {
    if (!this.gesture || !['move', 'resize'].includes(this.gesture.type)) return;
    this.gesture = null; this.el.classList.remove('board-is-dragging');
    if (this.activePointerId != null && this.el.hasPointerCapture(this.activePointerId)) this.el.releasePointerCapture(this.activePointerId);
    this.activePointerId = null;
  }
  setReadOnly(value) {
    this.readOnly = !!value;
    this.el.classList.toggle('board-read-only', this.readOnly);
    if (this.readOnly && this.gesture && this.gesture.type !== 'pan') {
      if (this.gesture.type === 'create') this.remove(this.gesture.id);
      else if (this.gesture.original) this.upsert(this.gesture.original);
      this.gesture = null; this.el.classList.remove('board-is-dragging');
      if (this.activePointerId != null && this.el.hasPointerCapture(this.activePointerId)) this.el.releasePointerCapture(this.activePointerId);
    }
    if (this.readOnly && this.editingId) this.nodes.get(this.editingId)?.querySelector('[contenteditable="true"]')?.blur();
    for (const entity of this.entities.values()) this.renderEntity(entity);
    this.updateSelectionTools(); this.updateLayers();
  }
  setColor(color) {
    this.color = color;
    const entity = this.entities.get(this.selectedId);
    if (entity && this.mayEdit(entity) && entity.type !== 'screen' && entity.type !== 'image' && entity.type !== 'diagram') this.commit({ ...entity, color }, { color });
  }
  setEntities(entities) {
    const incoming = new Set(entities.map(e => e.id));
    for (const id of this.entities.keys()) if (!incoming.has(id)) this.remove(id);
    for (const entity of entities) this.upsert(entity);
  }
  upsert(entity) {
    if (!entity?.id || !DEFAULTS[entity.type]) return;
    const normalized = { ...DEFAULTS[entity.type], ...entity, x: finite(entity.x), y: finite(entity.y), width: Math.max(2, finite(entity.width, DEFAULTS[entity.type].width)), height: Math.max(2, finite(entity.height, DEFAULTS[entity.type].height)) };
    if (this.gesture?.id === entity.id && (normalized.locked || !this.mayEdit(normalized))) this.cancelPositionGesture();
    this.entities.set(entity.id, normalized); this.renderEntity(normalized); this.applyLayerOrder(); this.updateSelectionTools();
  }
  remove(id) {
    if (this.gesture?.id === id) this.cancelPositionGesture();
    this.entities.delete(id); this.nodes.get(id)?.remove(); this.nodes.delete(id); this.externalConsents.delete(id);
    if (this.selectedId === id) this.select(null);
    this.applyLayerOrder(); this.updateSelectionTools();
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
    const center = this.centerPoint(); const defaults = DEFAULTS[type];
    const entity = { id: crypto.randomUUID(), type, ...defaults, color: COLORS[type] || this.color, x: Math.round(center.x - defaults.width / 2), y: Math.round(center.y - defaults.height / 2), z: this.nextZ(), ...options };
    if (type === 'draw' && !options.color) entity.color = this.color;
    if (type === 'rectangle' || type === 'ellipse' || type === 'arrow') entity.color = options.color || this.color;
    if (entity.externalConsent) this.externalConsents.add(entity.id);
    this.commit(entity); this.select(entity.id);
    return entity;
  }
  nextZ() { return Math.max(0, ...[...this.entities.values()].map(e => finite(e.z))) + 1; }
  select(id) {
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
    return this.add(entity.type, { ...entity, id: crypto.randomUUID(), x: entity.x + 28, y: entity.y + 28, z: this.nextZ(), locked: false });
  }
  updateSelected(patch) {
    const entity = this.entities.get(this.selectedId);
    if (entity) {
      if (entity.locked && ['x', 'y', 'width', 'height'].some(key => key in patch)) { this.onStatus('Unlock position to move or resize this object.'); return; }
      this.commit({ ...entity, ...patch }, patch);
    }
  }
  updateSelectionTools() {
    const entity = this.entities.get(this.selectedId);
    this.selectionTools.hidden = !entity || !this.mayEdit(entity) || !!this.gesture || this.editingId === this.selectedId;
    if (!entity) return;
    const order = this.listEntities(); const position = order.findIndex(item => item.id === entity.id);
    this.layerButtons.get('front').disabled = this.layerButtons.get('forward').disabled = position === order.length - 1;
    this.layerButtons.get('back').disabled = this.layerButtons.get('backward').disabled = position === 0;
    const label = entity.locked ? 'Unlock position' : 'Lock position';
    this.lockButton.title = label; this.lockButton.setAttribute('aria-label', label); this.lockButton.setAttribute('aria-pressed', String(!!entity.locked));
    this.lockButton.replaceChildren(icon(entity.locked ? 'lock' : 'unlock', 15));
    this.duplicateButton.disabled = entity.type === 'screen';
    const point = this.toClient(entity);
    const width = this.selectionTools.offsetWidth || Math.min(235, this.el.clientWidth - 16);
    const height = this.selectionTools.offsetHeight || 37;
    const x = Math.max(8, Math.min(this.el.clientWidth - width - 8, point.x + entity.width * this.zoom / 2 - width / 2));
    const y = Math.max(8, Math.min(this.el.clientHeight - height - 8, point.y - height - 8));
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
    node.style.zIndex = String(this.listEntities().findIndex(item => item.id === entity.id) + 1);
    node.classList.toggle('is-selected', entity.id === this.selectedId);
    node.classList.toggle('is-readonly', !this.mayEdit(entity));
    node.classList.toggle('is-position-locked', !!entity.locked);
    node.setAttribute('aria-label', entity.title || `${entity.type} on canvas`);
    if (node._signature === signature(entity) || this.editingId === entity.id) return;
    node._signature = signature(entity); node.replaceChildren();
    if (entity.type === 'text' || entity.type === 'sticky') this.renderText(node, entity);
    else if (entity.type === 'screen') this.renderScreen(node, entity);
    else if (entity.type === 'image') this.renderImage(node, entity);
    else if (entity.type === 'diagram') this.renderDiagram(node, entity);
    else this.renderShape(node, entity);
    const resize = element('div', 'board-resize-handle'); resize.dataset.resize = 'true'; resize.setAttribute('aria-label', 'Drag to resize');
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
    content.style.fontSize = `${Math.min(100, Math.max(10, finite(entity.fontSize, 18)))}px`;
    content.style.color = entity.color || COLORS[entity.type] || COLORS.text;
    content.setAttribute('aria-label', entity.type === 'sticky' ? 'Sticky note text; double click to edit' : 'Text; double click to edit');
    content.spellcheck = true; content.dataset.editable = 'true';
    if (entity.type === 'text' && entity.title) node.append(element('div', 'board-text-eyebrow', entity.title));
    node.append(content);
    const grip = element('div', 'board-text-grip'); grip.dataset.dragHandle = 'true'; grip.append(icon('grip', 15)); node.append(grip);
  }
  renderScreen(node, entity) {
    const header = this.header(entity, entity.title || 'Shared screen', 'screen'); node.append(header);
    const frame = element('div', 'board-screen-frame');
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true;
    video.setAttribute('aria-label', entity.title || 'Shared window video');
    const stream = this.streams.get(entity.streamId) || this.streams.get(entity.participantId);
    if (stream) { video.srcObject = stream; video.play().catch(() => {}); }
    const placeholder = element('div', 'board-screen-placeholder'); placeholder.append(icon('screen', 32), element('strong', '', 'Connecting to shared window'), element('span', '', 'The live view will appear here.'));
    placeholder.hidden = !!stream; video.hidden = !stream;
    frame.append(video, placeholder); node.append(frame);
    if (!stream) header.querySelector('.board-live-badge').textContent = 'CONNECTING';
    const footer = element('div', 'board-screen-footer');
    footer.append(element('span', 'board-window-dot'), element('span', '', entity.title || 'Shared window'), element('span', 'board-screen-footer-end', 'Live screen'));
    node.append(footer);
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
      if (!this.allowExternalPlantUml && !entity.externalConsent && !this.externalConsents.has(entity.id)) {
        const message = element('div', 'board-diagram-consent');
        message.append(icon('diagram', 27), element('strong', '', 'Render PlantUML diagram'), element('p', '', 'Rendering sends the diagram source to plantuml.com.'));
        const allow = element('button', 'board-consent-button', 'Allow rendering'); allow.type = 'button';
        allow.addEventListener('pointerdown', e => e.stopPropagation());
        allow.addEventListener('click', e => { e.stopPropagation(); this.externalConsents.add(entity.id); node._signature = null; this.renderEntity(this.entities.get(entity.id)); });
        message.append(allow); body.append(message); return;
      }
      const image = document.createElement('img'); image.alt = entity.title || 'PlantUML diagram'; image.draggable = false;
      try { image.src = plantUmlUrl(entity.source || ''); } catch (error) { body.append(element('p', 'board-diagram-error', error.message)); return; }
      image.addEventListener('error', () => { body.replaceChildren(element('p', 'board-diagram-error', 'Unable to render this diagram. Double click to edit the source.')); });
      body.append(image); return;
    }
    body.append(element('span', 'board-diagram-loading', 'Bringing your diagram to life…'));
    renderMermaid(entity.source || '').then(result => {
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
      label.dataset.editable = 'true'; label.style.fontSize = `${entity.fontSize || 14}px`;
      label.setAttribute('aria-label', 'Shape label; double click to edit');
      node.append(label);
    }
  }
  pointBounds(points) {
    if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)) };
  }

  pointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.target.closest('button,input,textarea,select,[contenteditable="true"]')) return;
    const point = this.worldPoint(event); const targetNode = event.target.closest('[data-entity-id]');
    const entity = targetNode && this.entities.get(targetNode.dataset.entityId);
    this.el.focus({ preventScroll: true });
    if (this.spaceHeld || this.tool === 'hand' || event.button === 1) {
      event.preventDefault(); this.gesture = { type: 'pan', clientX: event.clientX, clientY: event.clientY, pan: { ...this.pan } };
    } else if (entity && this.tool === 'select') {
      this.select(entity.id); event.preventDefault();
      if (!this.mayEdit(entity) || entity.locked) return;
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
      const added = this.add(this.tool, { x: point.x, y: point.y, text: '' });
      this.setTool('select'); this.select(added.id); requestAnimationFrame(() => this.editText(added.id)); return;
    } else if (this.tool === 'image') { this.onStatus('Drop an image onto the canvas, or use Add image in the toolbar.'); return; }
    else if (this.tool === 'diagram') { this.onStatus('Use the diagram button to add Mermaid or PlantUML source.'); return; }
    if (this.gesture) { this.activePointerId = event.pointerId; this.el.setPointerCapture(event.pointerId); this.el.classList.add('board-is-dragging'); this.updateSelectionTools(); }
  }
  pointerMove(event) {
    const point = this.worldPoint(event);
    if (performance.now() - this.lastCursor > 60) { this.lastCursor = performance.now(); this.onCursor({ x: Math.round(point.x), y: Math.round(point.y) }); }
    const gesture = this.gesture; if (!gesture) return;
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
      this.upsert(next);
      // Share intermediate positions at a modest rate; the final position is always sent.
      if (!gesture.lastSent || performance.now() - gesture.lastSent > 70) {
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
    const gesture = this.gesture; if (!gesture) return;
    this.gesture = null; this.el.classList.remove('board-is-dragging');
    if (this.el.hasPointerCapture(event.pointerId)) this.el.releasePointerCapture(event.pointerId);
    this.activePointerId = null;
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
    this.updateSelectionTools();
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
    if (this.tool !== 'select') return;
    const node = event.target.closest('[data-entity-id]'); if (!node) return;
    const entity = this.entities.get(node.dataset.entityId); if (!entity) return;
    if (!this.mayEdit(entity)) { this.onStatus(this.readOnly ? 'Reconnect to edit the shared canvas.' : 'Only the screen owner or host can change this live screen.'); return; }
    if (['text', 'sticky', 'rectangle', 'ellipse'].includes(entity.type)) this.editText(entity.id);
    else if (entity.type === 'diagram') {
      if (this.onEditDiagram) this.onEditDiagram(entity);
      else this.editDiagram(entity);
    }
  }
  editText(id) {
    const entity = this.entities.get(id); const node = this.nodes.get(id); const content = node?.querySelector('[data-editable]');
    if (!entity || !content || !this.mayEdit(entity)) return;
    this.editingId = id; this.select(id); this.updateSelectionTools();
    content.contentEditable = 'true'; node.classList.add('is-editing'); content.focus();
    const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(content); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
    const finish = () => {
      content.removeEventListener('blur', finish); content.contentEditable = 'false'; node.classList.remove('is-editing');
      const text = content.innerText.slice(0, 20000); this.editingId = null;
      const current = this.entities.get(id); if (current) this.commit({ ...current, text }, { text });
      this.updateSelectionTools();
    };
    content.addEventListener('blur', finish, { once: true });
    content.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); content.blur(); } }, { signal: this.abort.signal });
    content.addEventListener('paste', event => { event.preventDefault(); const text = event.clipboardData.getData('text/plain').slice(0, 20000); document.execCommand('insertText', false, text); }, { signal: this.abort.signal });
  }
  editDiagram(entity) {
    const dialog = document.createElement('dialog'); dialog.className = 'board-source-dialog';
    const heading = element('h2', '', 'Edit diagram'); const label = element('label', '', entity.language === 'plantuml' ? 'PlantUML source' : 'Mermaid source');
    const source = element('textarea', ''); source.value = entity.source || ''; source.rows = 12; source.setAttribute('aria-label', label.textContent);
    const actions = element('div', 'board-dialog-actions');
    const cancel = element('button', '', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
    const save = element('button', 'primary', 'Update diagram'); save.type = 'button'; save.addEventListener('click', () => { const current = this.entities.get(entity.id); const nextSource = source.value.slice(0, 20000); if (current) this.commit({ ...current, source: nextSource }, { source: nextSource }); dialog.close(); });
    actions.append(cancel, save); dialog.append(heading, label, source, actions); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove()); dialog.showModal(); source.focus();
  }
  keyDown(event) {
    if (document.querySelector('#modal-root .modal')) return;
    if (event.target.closest('input,textarea,select,[contenteditable="true"],dialog')) return;
    if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
    if (event.code === 'Space') { event.preventDefault(); this.spaceHeld = true; this.el.classList.add('board-space-pan'); }
    if (event.key === 'Escape') { this.select(null); this.setTool('select'); }
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
  exportSvg() {
    const entities = this.listEntities().filter(e => e.type !== 'screen');
    const minX = entities.length ? Math.min(...entities.map(e => e.x)) - 24 : 0;
    const minY = entities.length ? Math.min(...entities.map(e => e.y)) - 24 : 0;
    const width = entities.length ? Math.max(...entities.map(e => e.x + e.width)) - minX + 24 : 1200;
    const height = entities.length ? Math.max(...entities.map(e => e.y + e.height)) - minY + 24 : 800;
    const svg = svgElement('svg', { xmlns: SVG_NS, width, height, viewBox: `${minX} ${minY} ${width} ${height}` });
    svg.append(svgElement('rect', { x: minX, y: minY, width, height, fill: '#f8f9f6' }));
    for (const entity of entities) {
      const group = svgElement('g', { transform: `translate(${entity.x},${entity.y})` });
      if (['rectangle', 'ellipse', 'draw', 'arrow'].includes(entity.type)) {
        const shape = this.nodes.get(entity.id)?.querySelector('svg'); if (shape) group.append(shape.cloneNode(true));
        if (entity.text) {
          const text = svgElement('text', { x: entity.width / 2, y: entity.height / 2, 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: '#435b43', 'font-family': 'sans-serif', 'font-size': entity.fontSize || 14 });
          text.textContent = entity.text; group.append(text);
        }
      } else if (entity.type === 'image' && /^data:image\//.test(entity.url || '')) {
        group.append(svgElement('image', { href: entity.url, width: entity.width, height: entity.height, preserveAspectRatio: 'xMidYMid meet' }));
      } else if (entity.type === 'diagram') {
        group.append(svgElement('rect', { width: entity.width, height: entity.height, rx: 10, fill: '#fff', stroke: '#dfe4de' }));
        const diagram = this.nodes.get(entity.id)?.querySelector('.board-diagram-body svg');
        if (diagram) { const clone = diagram.cloneNode(true); clone.setAttribute('x', '16'); clone.setAttribute('y', '48'); clone.setAttribute('width', String(entity.width - 32)); clone.setAttribute('height', String(entity.height - 64)); group.append(clone); }
        else { const text = svgElement('text', { x: 16, y: 32, fill: '#28322f', 'font-family': 'sans-serif', 'font-size': 15 }); text.textContent = entity.title || 'Diagram'; group.append(text); }
      } else {
        if (entity.type === 'sticky') group.append(svgElement('rect', { width: entity.width, height: entity.height, rx: 6, fill: entity.fill || '#fff0b5' }));
        const fontSize = entity.fontSize || 18; const padding = entity.type === 'sticky' ? 22 : 4;
        const text = svgElement('text', { x: padding, y: padding + fontSize, fill: entity.color || COLORS.text, 'font-family': 'sans-serif', 'font-size': fontSize });
        const lines = (entity.text || '').split('\n'); lines.forEach((line, i) => { const tspan = svgElement('tspan', { x: padding, dy: i ? fontSize * 1.45 : 0 }); tspan.textContent = line; text.append(tspan); }); group.append(text);
      }
      svg.append(group);
    }
    return new XMLSerializer().serializeToString(svg);
  }
  destroy() {
    this.abort.abort(); this.resizeObserver.disconnect();
    for (const node of this.nodes.values()) { const video = node.querySelector('video'); if (video) video.srcObject = null; }
    this.stage.remove(); this.selectionTools.remove(); this.layersControl.remove(); this.entities.clear(); this.nodes.clear(); this.streams.clear(); this.cursors.clear();
  }
}
export default Board;
