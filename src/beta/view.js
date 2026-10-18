import './style.css';

const clamp = (value, low, high, fallback = 0) => Number.isFinite(Number(value)) ? Math.min(high, Math.max(low, Number(value))) : fallback;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const validColor = value => /^#[0-9a-f]{3,8}$/i.test(value || '') ? value : null;
const objectList = board => Array.isArray(board?.objects) ? board.objects : Array.isArray(board?.entities) ? board.entities : Object.values(board?.objects || board?.entities || {});
const poseOf = board => {
  const pose = board?.pose || board || {};
  return {
    x: clamp(pose.x, -100000, 100000), y: clamp(pose.y, -100000, 100000), z: clamp(pose.z, -100000, 100000),
    rotationX: clamp(pose.rotationX ?? pose.rx, -360, 360), rotationY: clamp(pose.rotationY ?? pose.ry, -360, 360), rotationZ: clamp(pose.rotationZ ?? pose.rz ?? pose.rotation, -360, 360),
  };
};
const timeOf = revision => {
  const raw = revision?.at ?? revision?.timestamp ?? revision?.createdAt ?? revision?.time;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

/** Separate beta shell. Camera and history selection stay personal; callbacks own shared mutations. */
export function mountBetaView(root, handlers = {}) {
  const abort = new AbortController();
  const signal = abort.signal;
  const shell = element('section', 'beta-workspace');
  shell.setAttribute('aria-label', 'Common Space and Time beta');
  shell.innerHTML = `
    <header class="beta-header">
      <a class="beta-brand" href="/" aria-label="Common home">common<span aria-hidden="true">✳</span></a>
      <span class="beta-label">Space & time <span>Beta</span></span>
      <div class="beta-room-heading"><h1></h1><p class="beta-save-state" role="status"></p></div>
      <details class="beta-room-menu"><summary aria-label="Room actions">•••</summary><div class="beta-room-menu-items"><button type="button" data-beta-action="workspaces">On this device</button><button type="button" data-beta-action="create-room">Start a shared room</button><button type="button" data-beta-action="invite" hidden>Invite a teammate</button><button type="button" data-beta-action="theme">Room style</button><button type="button" data-beta-action="export">Export room</button><button type="button" data-beta-action="import">Import room</button><button type="button" data-beta-action="leave" hidden>Leave room</button><button type="button" data-beta-action="end" hidden>End room for everyone</button></div></details>
      <button type="button" class="beta-button beta-exit" data-beta-action="exit" title="Exit beta">Exit beta <span aria-hidden="true">→</span></button>
    </header>
    <div class="beta-body">
      <aside class="beta-sidebar" aria-label="Boards and room controls">
        <div class="beta-sidebar-heading"><h2>Places in this room</h2><button type="button" class="beta-icon-button beta-add-board" aria-label="Add a board">+</button></div>
        <nav class="beta-board-list" aria-label="Room boards"></nav>
        <details class="beta-placement"><summary>Position in space <span aria-hidden="true">→</span></summary>
          <p>Shared placement. Your camera stays yours.</p>
          <form class="beta-pose-form"><fieldset><legend class="beta-sr-only">Selected board position and rotation</legend>
            <div class="beta-coordinate-fields"></div><button type="submit" class="beta-button beta-pose-apply">Apply position</button>
          </fieldset></form>
        </details>
        <div class="beta-sidebar-bottom"><p><span aria-hidden="true">✿</span> A little room to see the bigger picture.</p>
          <div class="beta-room-actions"><button type="button" class="beta-button" data-beta-action="theme">Room style</button><button type="button" class="beta-button" data-beta-action="export">Export room</button></div>
          <p class="beta-private-note">Your view and time position are personal. Teammates can keep working live.</p>
        </div>
      </aside>
      <main class="beta-main">
        <div class="beta-view-bar"><div class="beta-view-modes" role="group" aria-label="Workspace view"><button type="button" data-beta-mode="work" aria-pressed="true">2D · Work</button><button type="button" data-beta-mode="space" aria-pressed="false">3D · Space</button></div><div class="beta-current-board"><strong></strong><span></span></div></div>
        <div class="beta-notice" role="status" hidden></div>
        <div class="beta-work-tools" role="toolbar" aria-label="Board tools"></div>
        <div class="beta-viewport" data-beta-mode="work">
          <div class="beta-past-banner" hidden><span>Exploring the past · read-only</span><button type="button" class="beta-button" data-beta-action="fork">Branch from here</button><button type="button" class="beta-button beta-banner-live">Return to live →</button></div>
          <div class="beta-board-host board-viewport"></div>
          <div class="beta-space" hidden tabindex="0" aria-label="Spatial overview. Arrow keys orbit your camera, plus and minus zoom."><div class="beta-world"></div></div>
          <div class="beta-camera" role="group" aria-label="Your spatial camera" hidden><button type="button" class="beta-icon-button" data-beta-camera="left" aria-label="Orbit left">↶</button><button type="button" class="beta-icon-button" data-beta-camera="right" aria-label="Orbit right">↷</button><button type="button" class="beta-icon-button" data-beta-camera="up" aria-label="Tilt up">↑</button><button type="button" class="beta-icon-button" data-beta-camera="down" aria-label="Tilt down">↓</button><button type="button" class="beta-icon-button" data-beta-camera="out" aria-label="Zoom out">−</button><button type="button" class="beta-icon-button" data-beta-camera="in" aria-label="Zoom in">+</button><button type="button" class="beta-icon-button" data-beta-camera="reset" aria-label="Reset camera">⌖</button></div>
          <p class="beta-space-hint" hidden>Choose a board to step inside. Drag the open space to look around.</p>
          <div class="beta-empty" hidden><span aria-hidden="true">✳</span><h2>A little space for what comes next.</h2><p>Add a board to start growing your room.</p><button type="button" class="beta-button beta-empty-add">Add your first board</button></div>
        </div>
      </main>
      <footer class="beta-history" aria-label="Automatic room history">
        <div class="beta-history-heading"><div><h2>A room, over time.</h2><p class="beta-history-status"></p></div><span class="beta-live-changes" hidden></span><button type="button" class="beta-button beta-return-live">You’re live</button></div>
        <input class="beta-time-slider" type="range" min="0" max="0" step="1" value="0" aria-label="Explore automatically saved room history">
        <div class="beta-timeline-labels"><span class="beta-history-first"></span><span class="beta-history-count"></span><span class="beta-history-last"></span></div><p class="beta-mobile-save-state" role="status"></p>
      </footer>
    </div>
    <div class="beta-announcement beta-sr-only" role="status" aria-live="polite"></div>`;
  root.replaceChildren(shell);
  const $ = selector => shell.querySelector(selector);
  const boardHost = $('.beta-board-host');
  const toolbarHost = $('.beta-work-tools');
  const scene = $('.beta-space');
  const world = $('.beta-world');
  const boardList = $('.beta-board-list');
  const timeline = $('.beta-time-slider');
  const poseForm = $('.beta-pose-form');
  const poseFields = new Map();
  let state = { boards: [], mode: 'work', live: true, revisions: [] };
  let destroyed = false;
  let orbit = { x: 24, y: -22, zoom: 1 };
  let baseScale = 1;
  let pointer = null;
  let contentSignature = '';
  let poseSignature = '';
  const planes = new Map();
  const boardButtons = new Map();

  const action = (name, payload) => handlers.onAction?.(name, payload);
  const announce = text => { $('.beta-announcement').textContent = text; };
  const select = id => handlers.onSelectBoard?.(id);
  const setMode = mode => handlers.onModeChange?.(mode);
  const live = () => handlers.onLive?.();
  const isLive = () => state.live !== false;
  const canEdit = () => isLive() && state.canEdit !== false && state.connection !== 'disconnected' && state.connection !== 'offline';

  for (const [key, label] of [['x', 'Across · X'], ['y', 'Down · Y'], ['z', 'Depth · Z'], ['rotationX', 'Tilt · X°'], ['rotationY', 'Turn · Y°'], ['rotationZ', 'Rotate · Z°']]) {
    const labelNode = element('label', 'beta-coordinate');
    labelNode.append(element('span', '', label));
    const input = element('input'); input.type = 'number'; input.name = key; input.step = 'any'; input.value = '0'; input.required = true;
    input.min = key.startsWith('rotation') ? '-360' : '-100000'; input.max = key.startsWith('rotation') ? '360' : '100000';
    labelNode.append(input); $('.beta-coordinate-fields').append(labelNode); poseFields.set(key, input);
  }
  const tools = [['select', '↖', 'Select'], ['hand', '✋', 'Move view'], ['text', 'T', 'Text'], ['sticky', '▤', 'Note'], ['rectangle', '□', 'Box'], ['draw', '⌁', 'Draw']];
  for (const [tool, symbol, label] of tools) {
    const button = element('button', 'beta-tool'); button.type = 'button'; button.dataset.betaTool = tool; button.title = label; button.setAttribute('aria-label', label); button.setAttribute('aria-pressed', String(tool === 'select'));
    const toolSymbol = element('span', 'beta-tool-symbol', symbol);
    if (tool === 'select') toolSymbol.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="m4 3 6 18 3-8 8-3Z"/></svg>';
    button.append(toolSymbol, element('span', 'beta-tool-label', label));
    toolbarHost.append(button);
  }
  for (const [name, label] of [['image', 'Add image'], ['share', 'Share a window']]) {
    const button = element('button', 'beta-button beta-media-tool', label); button.type = 'button'; button.dataset.betaAction = name; toolbarHost.append(button);
  }

  shell.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || !shell.contains(button) || button.disabled) return;
    if (button.dataset.betaMode) setMode(button.dataset.betaMode);
    else if (button.dataset.betaCamera) moveCamera(button.dataset.betaCamera);
    else if (button.dataset.betaTool) action('tool', { tool: button.dataset.betaTool });
    else if (button.dataset.betaAction) { $('.beta-room-menu').open = false; action(button.dataset.betaAction); }
    else if (button.classList.contains('beta-return-live') || button.classList.contains('beta-banner-live')) live();
    else if (button.classList.contains('beta-add-board') || button.classList.contains('beta-empty-add')) handlers.onAddBoard?.();
  }, { signal });
  shell.addEventListener('keydown', event => {
    const menu = $('.beta-room-menu');
    if (event.key === 'Escape' && menu.open) { event.preventDefault(); menu.open = false; menu.querySelector('summary').focus(); }
  }, { signal });
  timeline.addEventListener('input', () => handlers.onTimeChange?.(Number(timeline.value)), { signal });
  poseForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!canEdit() || !state.activeBoardId || !poseForm.reportValidity()) return;
    const pose = Object.fromEntries([...poseFields].map(([key, input]) => [key, Number(input.value)]));
    action('pose', { boardId: state.activeBoardId, pose });
  }, { signal });

  function updateCamera() {
    world.style.transform = `translate3d(-50%,-50%,0) scale(${baseScale * orbit.zoom}) rotateX(${orbit.x}deg) rotateY(${orbit.y}deg)`;
  }
  function moveCamera(direction) {
    if (direction === 'left') orbit.y -= 12;
    else if (direction === 'right') orbit.y += 12;
    else if (direction === 'up') orbit.x = clamp(orbit.x + 8, -75, 75);
    else if (direction === 'down') orbit.x = clamp(orbit.x - 8, -75, 75);
    else if (direction === 'in') orbit.zoom = clamp(orbit.zoom * 1.2, .15, 4, 1);
    else if (direction === 'out') orbit.zoom = clamp(orbit.zoom / 1.2, .15, 4, 1);
    else orbit = { x: 24, y: -22, zoom: 1 };
    updateCamera();
  }
  scene.addEventListener('keydown', event => {
    if (event.target !== scene) return;
    const cameraKey = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', '+': 'in', '=': 'in', '-': 'out', '0': 'reset' }[event.key];
    if (cameraKey) { event.preventDefault(); moveCamera(cameraKey); }
  }, { signal });
  scene.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.beta-plane')) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, orbitX: orbit.x, orbitY: orbit.y };
    scene.setPointerCapture(event.pointerId); scene.classList.add('beta-orbiting');
  }, { signal });
  scene.addEventListener('pointermove', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    orbit.x = clamp(pointer.orbitX - (event.clientY - pointer.y) * .25, -75, 75);
    orbit.y = clamp(pointer.orbitY + (event.clientX - pointer.x) * .3, -360, 360);
    updateCamera();
  }, { signal });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) scene.addEventListener(name, () => { pointer = null; scene.classList.remove('beta-orbiting'); }, { signal });
  scene.addEventListener('wheel', event => {
    if (state.mode !== 'space') return;
    event.preventDefault(); orbit.zoom = clamp(orbit.zoom * Math.exp(-event.deltaY * .001), .15, 4, 1); updateCamera();
  }, { signal, passive: false });

  function fitScene() {
    if (!scene.clientWidth || !scene.clientHeight) return;
    const boards = state.boards || [];
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, back = Infinity, front = -Infinity;
    for (const board of boards) {
      const pose = poseOf(board); const width = clamp(board.width, 160, 4000, 960); const height = clamp(board.height, 120, 3000, 600);
      left = Math.min(left, pose.x); right = Math.max(right, pose.x + width); top = Math.min(top, pose.y); bottom = Math.max(bottom, pose.y + height); back = Math.min(back, pose.z); front = Math.max(front, pose.z);
    }
    const width = boards.length ? Math.max(600, right - left) : 960;
    const height = boards.length ? Math.max(400, bottom - top) : 600;
    const depth = boards.length ? front - back : 0;
    baseScale = Math.min(.85, (scene.clientWidth - 70) / (width + depth * .6), (scene.clientHeight - 130) / (height + depth * .5));
    baseScale = Math.max(.015, baseScale);
    world.style.width = `${width}px`; world.style.height = `${height}px`;
    world.style.setProperty('--beta-origin-x', `${boards.length ? -left : 0}px`);
    world.style.setProperty('--beta-origin-y', `${boards.length ? -top : 0}px`);
    world.style.setProperty('--beta-origin-z', `${boards.length ? -(front + back) / 2 : 0}px`);
    updateCamera();
  }
  const observer = new ResizeObserver(fitScene); observer.observe(scene);

  function previewObject(object, liveView) {
    if (!object || typeof object !== 'object') return null;
    const node = element('span', `beta-preview-object beta-preview-${String(object.type || 'unknown').replace(/[^a-z]/g, '')}`);
    const width = clamp(object.width, 1, 10000, 180), height = clamp(object.height, 1, 10000, 90);
    node.style.left = `${clamp(object.x, -100000, 100000)}px`; node.style.top = `${clamp(object.y, -100000, 100000)}px`;
    node.style.width = `${width}px`; node.style.height = `${height}px`;
    if (validColor(object.color)) node.style.color = object.color;
    if (validColor(object.fill)) node.style.backgroundColor = object.fill;
    if (object.type === 'image') {
      const src = object.src || object.url;
      if (typeof src === 'string' && (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(src) || /^blob:/i.test(src) || /^\/(?!\/)/.test(src))) {
        const image = element('img'); image.src = src; image.alt = object.title || 'Image'; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; node.append(image);
      } else node.textContent = object.title || 'Image';
    } else if (object.type === 'screen') {
      node.append(element('span', 'beta-preview-card-title', object.title || 'Shared window'), element('span', 'beta-preview-card-note', liveView ? 'Open board to view shared window' : 'Screen pixels require a recording'));
    } else if (object.type === 'diagram') {
      node.append(element('span', 'beta-preview-card-title', object.title || 'Diagram'), element('span', 'beta-preview-card-note', object.source || 'Open board to view diagram'));
    } else if (object.type === 'draw' || object.type === 'arrow') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const points = Array.isArray(object.points) ? object.points.filter(point => point && typeof point === 'object').slice(0, 500) : [];
      const d = object.type === 'arrow' ? `M 2 ${height / 2} H ${Math.max(2, width - 5)} m -12 -8 l 12 8 -12 8` : points.map((point, index) => `${index ? 'L' : 'M'} ${clamp(point.x ?? point[0], -10000, 10000)} ${clamp(point.y ?? point[1], -10000, 10000)}`).join(' ');
      path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', validColor(object.color) || '#567263'); path.setAttribute('stroke-width', '3'); svg.append(path); node.append(svg);
    } else {
      node.textContent = object.text || object.title || '';
      node.style.fontSize = `${clamp(object.fontSize, 8, 240, 24)}px`;
    }
    return node;
  }

  function renderBoards() {
    const currentIds = new Set(state.boards.map(board => String(board.id)));
    for (const [id, plane] of planes) if (!currentIds.has(id)) { plane.remove(); planes.delete(id); boardButtons.get(id)?.remove(); boardButtons.delete(id); }
    for (const board of state.boards) {
      const id = String(board.id), active = id === String(state.activeBoardId), objects = objectList(board);
      let button = boardButtons.get(id);
      if (!button) {
        button = element('button', 'beta-board-link'); button.type = 'button'; button.dataset.betaBoard = id;
        button.append(element('span', 'beta-board-icon', '▱'), element('span', 'beta-board-link-text'), element('span', 'beta-board-count'));
        button.addEventListener('click', () => select(id), { signal }); boardButtons.set(id, button);
      }
      button.querySelector('.beta-board-link-text').textContent = board.name || board.title || 'Untitled board'; button.querySelector('.beta-board-count').textContent = String(objects.length);
      button.setAttribute('aria-pressed', String(active));
      const index = state.boards.indexOf(board); if (boardList.children[index] !== button) boardList.insertBefore(button, boardList.children[index] || null);
      let plane = planes.get(id);
      if (!plane) {
        plane = element('button', 'beta-plane'); plane.type = 'button'; plane.dataset.betaBoard = id;
        plane.append(element('span', 'beta-plane-heading'), element('span', 'beta-plane-preview'), element('span', 'beta-plane-open', 'Step inside →'));
        plane.addEventListener('click', () => { select(id); setMode('work'); }, { signal }); planes.set(id, plane);
      }
      const pose = poseOf(board), width = clamp(board.width, 160, 4000, 960), height = clamp(board.height, 120, 3000, 600);
      plane.style.width = `${width}px`; plane.style.height = `${height}px`;
      plane.style.transform = `translate3d(calc(${pose.x}px + var(--beta-origin-x,0px)),calc(${pose.y}px + var(--beta-origin-y,0px)),calc(${pose.z}px + var(--beta-origin-z,0px))) rotateX(${pose.rotationX}deg) rotateY(${pose.rotationY}deg) rotateZ(${pose.rotationZ}deg)`;
      plane.setAttribute('aria-label', `Open ${board.name || board.title || 'Untitled board'}, ${objects.length} objects, depth ${pose.z}`); plane.setAttribute('aria-pressed', String(active));
      const heading = plane.querySelector('.beta-plane-heading'); heading.replaceChildren(element('strong', '', board.name || board.title || 'Untitled board'), element('span', '', `Z ${pose.z}`));
      const preview = plane.querySelector('.beta-plane-preview'); preview.replaceChildren();
      const availableHeight = height - 76;
      const bounds = objects.reduce((acc, object) => ({ width: Math.max(acc.width, clamp(object?.x, -100000, 100000) + clamp(object?.width, 0, 10000, 180)), height: Math.max(acc.height, clamp(object?.y, -100000, 100000) + clamp(object?.height, 0, 10000, 90)) }), { width, height: availableHeight });
      const previewScale = Math.min(1, width / bounds.width, availableHeight / bounds.height);
      const content = element('span', 'beta-plane-content'); content.style.transform = `scale(${previewScale})`;
      for (const object of objects.slice(0, 100)) { const node = previewObject(object, isLive()); if (node) content.append(node); }
      if (!objects.length) content.append(element('span', 'beta-plane-empty', 'Room for a little thought…'));
      preview.append(content); if (world.children[index] !== plane) world.insertBefore(plane, world.children[index] || null);
    }
    fitScene();
  }

  function render(next) {
    if (destroyed) return;
    state = { ...state, ...next };
    state.boards = Array.isArray(state.boards) ? state.boards : [];
    state.revisions = Array.isArray(state.revisions) ? state.revisions : [];
    const liveView = isLive(), space = state.mode === 'space';
    const activeBoard = state.boards.find(board => String(board.id) === String(state.activeBoardId));
    const title = state.title || 'A little room to explore';
    $('.beta-room-heading h1').textContent = title; $('.beta-room-heading h1').title = title;
    const saveMessages = { saving: 'Saving your changes…', saved: 'Autosaved · all changes saved', unsaved: 'Unsaved changes · keep this page open', offline: 'Offline · changes stay on this device', error: 'Not saved · changes need attention', connecting: 'Connecting to the room…', loading: 'Opening your room…' };
    const saveState = state.saveState || 'saved';
    const saveMessage = state.automaticSaveState || state.saveMessage || saveMessages[saveState] || String(saveState);
    $('.beta-save-state').textContent = saveMessage;
    $('.beta-mobile-save-state').textContent = saveMessage;
    $('.beta-save-state').dataset.state = saveState;
    $('.beta-mobile-save-state').dataset.state = saveState;
    $('.beta-notice').hidden = !state.notice; $('.beta-notice').textContent = state.notice || '';
    const inRoom = Boolean(state.room || state.inRoom);
    for (const button of shell.querySelectorAll('[data-beta-action="create-room"]')) button.hidden = inRoom || state.canCreateRoom === false;
    for (const button of shell.querySelectorAll('[data-beta-action="invite"],[data-beta-action="leave"]')) button.hidden = !inRoom;
    for (const button of shell.querySelectorAll('[data-beta-action="end"]')) button.hidden = !inRoom || !(state.isAdmin || state.isHost);
    for (const button of shell.querySelectorAll('[data-beta-action="theme"]')) button.disabled = state.canStyle === false;
    $('.beta-current-board strong').textContent = space ? `${state.boards.length} ${state.boards.length === 1 ? 'board' : 'boards'} in space` : activeBoard?.name || activeBoard?.title || 'Your room';
    $('.beta-current-board span').textContent = `${liveView ? 'Live room' : 'Exploring history'} · Your view`;
    $('.beta-viewport').dataset.betaMode = space ? 'space' : 'work';
    boardHost.hidden = space || !activeBoard; scene.hidden = !space;
    $('.beta-camera').hidden = !space || !state.boards.length; $('.beta-space-hint').hidden = !space || !state.boards.length;
    $('.beta-past-banner').hidden = liveView;
    $('.beta-empty').hidden = !!state.boards.length;
    $('.beta-empty-add').disabled = !canEdit(); $('.beta-add-board').disabled = !canEdit();
    toolbarHost.hidden = space || state.tools === false || !activeBoard;
    for (const button of shell.querySelectorAll('[data-beta-mode]')) button.setAttribute('aria-pressed', String(button.dataset.betaMode === state.mode));
    for (const button of toolbarHost.querySelectorAll('button')) {
      const navigation = ['select', 'hand'].includes(button.dataset.betaTool) || ['fit', 'zoom-in', 'zoom-out'].includes(button.dataset.betaAction);
      button.disabled = !canEdit() && !navigation && !(button.dataset.betaAction === 'share' && state.sharing);
      if (button.dataset.betaTool) button.setAttribute('aria-pressed', String(button.dataset.betaTool === (state.tool || 'select')));
      if (button.dataset.betaAction === 'share') {
        button.textContent = state.sharing ? 'Stop sharing' : 'Share a window';
        button.setAttribute('aria-pressed', String(!!state.sharing));
      }
    }
    poseForm.querySelector('fieldset').disabled = !canEdit() || !activeBoard;
    const newPoseSignature = JSON.stringify([activeBoard?.id, poseOf(activeBoard)]);
    if (newPoseSignature !== poseSignature) {
      const pose = poseOf(activeBoard); for (const [key, input] of poseFields) input.value = String(pose[key]); poseSignature = newPoseSignature;
    }
    const newSignature = JSON.stringify([state.boards, state.activeBoardId, liveView]);
    if (newSignature !== contentSignature) { contentSignature = newSignature; renderBoards(); }
    else if (space) fitScene();
    const max = Math.max(0, state.revisions.length - 1);
    const index = liveView ? max : clamp(state.revisionIndex ?? max, 0, max, max);
    timeline.max = String(max); timeline.value = String(index); timeline.disabled = !state.revisions.length;
    const current = state.revisions[index];
    const currentTime = timeOf(current);
    const revisionDetail = [typeof current?.label === 'string' ? current.label : '', typeof current?.actor === 'string' ? current.actor : '', currentTime].filter(Boolean).join(' · ');
    timeline.setAttribute('aria-valuetext', `${liveView ? 'Live' : 'History'}${revisionDetail ? `, ${revisionDetail}` : ''}, change ${index + 1} of ${state.revisions.length}`);
    $('.beta-history-status').textContent = liveView ? (['unsaved', 'error', 'saving'].includes(saveState) ? saveMessage : 'Every change is saved as you work.') : `${revisionDetail || 'Earlier in this room'} · Read-only. The live room keeps moving.`;
    $('.beta-history-first').textContent = timeOf(state.revisions[0]) || 'Room started'; $('.beta-history-last').textContent = 'Live now';
    $('.beta-history-count').textContent = `${state.revisions.length} automatic ${state.revisions.length === 1 ? 'revision' : 'revisions'}`;
    const pending = Math.max(0, Number(state.pendingChanges) || 0);
    $('.beta-live-changes').hidden = liveView || !pending; $('.beta-live-changes').textContent = `${pending} new live ${pending === 1 ? 'change' : 'changes'}`;
    $('.beta-return-live').disabled = liveView; $('.beta-return-live').textContent = liveView ? 'You’re live' : 'Return to live →';
    shell.dataset.history = liveView ? 'live' : 'past';
  }

  render(state);
  return {
    boardHost, toolbarHost, element: shell, render, announce,
    destroy() { if (destroyed) return; destroyed = true; abort.abort(); observer.disconnect(); shell.remove(); planes.clear(); boardButtons.clear(); },
  };
}
