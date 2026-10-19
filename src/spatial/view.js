import './style.css';
import { attachPopover, attachRovingToolbar } from '../ui/workspace-primitives.js';
import { isSpatialProjection } from './projection.js';

const clamp = (value, low, high, fallback = 0) =>
  Number.isFinite(Number(value)) ? Math.min(high, Math.max(low, Number(value))) : fallback;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const validColor = value => (/^#[0-9a-f]{3,8}$/i.test(value || '') ? value : null);
function objectList(board) {
  if (Array.isArray(board?.objects)) return board.objects;
  if (Array.isArray(board?.entities)) return board.entities;
  return Object.values(board?.objects || board?.entities || {});
}
const poseOf = board => {
  const pose = board?.pose || board || {};
  return {
    x: clamp(pose.x, -100000, 100000),
    y: clamp(pose.y, -100000, 100000),
    z: clamp(pose.z, -100000, 100000),
    rotationX: clamp(pose.rotationX ?? pose.rx, -360, 360),
    rotationY: clamp(pose.rotationY ?? pose.ry, -360, 360),
    rotationZ: clamp(pose.rotationZ ?? pose.rz ?? pose.rotation, -360, 360),
  };
};
const timeOf = revision => {
  const raw = revision?.at ?? revision?.timestamp ?? revision?.createdAt ?? revision?.time;
  const date = new Date(raw);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
const POSE_FIELDS = [
  ['x', 'Across · X'],
  ['y', 'Down · Y'],
  ['z', 'Depth · Z'],
  ['rotationX', 'Tilt · X°'],
  ['rotationY', 'Turn · Y°'],
  ['rotationZ', 'Rotate · Z°'],
];
const TOOLS = [
  ['select', 'Select'],
  ['sticky', 'Note'],
  ['draw', 'Draw'],
  ['text', 'Text'],
  ['rectangle', 'Box'],
  ['hand', 'Move view'],
];
const PRIMARY_TOOLS = ['select', 'sticky', 'draw'];
const NAVIGATION_TOOLS = ['select', 'hand'];
const NAVIGATION_ACTIONS = ['fit', 'zoom-in', 'zoom-out'];
const ACTION_LABELS = {
  diagram: 'Diagram',
  fit: 'Fit board',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
};
const SAVE_MESSAGES = {
  saving: 'Saving your changes…',
  saved: 'Autosaved · all changes saved',
  unsaved: 'Unsaved changes · keep this page open',
  offline: 'Offline · changes stay on this device',
  error: 'Not saved · changes need attention',
  connecting: 'Connecting to the room…',
  loading: 'Opening your room…',
};
const CAMERA_KEYS = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  '+': 'in',
  '=': 'in',
  '-': 'out',
  0: 'reset',
};

const ICONS = {
  select: 'm5 3 5 18 3-8 8-3Z',
  sticky: 'M5 3h14v13l-5 5H5zM14 21v-5h5M8 8h8M8 12h6',
  draw: 'm4 17-1 4 4-1L20 7l-4-4ZM13 6l5 5',
  hand: 'M8 12V5a2 2 0 0 1 4 0v6-7a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v8c0 4-3 6-7 6h-1c-3 0-4-2-6-5L3 12a2 2 0 0 1 3-2l2 2',
  text: 'M4 5V3h16v2M12 3v18M8 21h8',
  rectangle: 'M4 5h16v14H4z',
  image: 'M3 3h18v18H3zM3 16l6-6 12 11M16 7h.01',
  share: 'M3 4h18v13H3zM8 21h8M12 17v4M9 10l3-3 3 3M12 7v7',
  stop: 'M6 6h12v12H6z',
  more: 'M12 5v14M5 12h14',
  room: 'M3 7h7l2-3h9v16H3zM3 7V4h7',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  diagram: 'M9 3h6v5H9zM2 16h6v5H2zM16 16h6v5h-6zM12 8v4M5 16v-4h14v4',
  fit: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  'zoom-in': 'M5 12h14M12 5v14',
  'zoom-out': 'M5 12h14',
  position: 'm12 3 9 5v9l-9 5-9-5V8Zm0 9 9-4M12 12 3 8M12 12v10',
  chevron: 'm8 10 4 4 4-4',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  branch: 'M5 20V4M5 14c7 0 6-8 14-8m-4-4 4 4-4 4',
  left: 'm14 6-6 6 6 6',
  right: 'm10 6 6 6-6 6',
  up: 'm6 14 6-6 6 6',
  down: 'm6 10 6 6 6-6',
  reset: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.5,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': true,
  }))
    svg.setAttribute(key, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || ICONS.more);
  svg.append(path);
  return svg;
}

/** Spatial workspace shell. Camera and history selection stay personal; callbacks own shared mutations. */
export function mountSpatialView(root, handlers = {}) {
  const abort = new AbortController();
  const signal = abort.signal;
  const shell = element('section', 'beta-workspace');
  shell.setAttribute('aria-label', 'Common Space and Time');
  shell.innerHTML = `
    <header class="beta-header">
      <a class="beta-brand" href="/" aria-label="Common home">common<span aria-hidden="true">✳</span></a><span class="beta-label">Space & time</span>
      <div class="beta-room-heading"><h1></h1><p class="beta-save-state cw-status-bead" role="status"></p></div>
      <button type="button" class="beta-room-trigger cw-quiet-button" aria-label="Room actions" aria-expanded="false"><span aria-hidden="true">⌑</span><span>Room</span><span class="beta-menu-chevron" aria-hidden="true">⌄</span></button>
      <div class="beta-room-menu cw-folded-menu" role="dialog" aria-label="Room actions" hidden><p class="beta-menu-eyebrow">A little room of your own</p><button type="button" data-beta-action="create-room">Start a shared room <span aria-hidden="true"></span></button><button type="button" data-beta-action="retry" hidden>Retry connection</button><button type="button" data-beta-action="join" hidden>Join room</button><button type="button" data-beta-action="invite" hidden>Invite a teammate</button><button type="button" data-beta-action="local" hidden>Back to your local workspace</button><button type="button" data-beta-action="workspaces">On this device <span aria-hidden="true"></span></button><div class="beta-menu-rule"></div><button type="button" data-beta-action="theme">Room style</button><button type="button" data-beta-action="export">Export room</button><button type="button" data-beta-action="import">Import room</button><div class="beta-agent-tools-host"></div><div class="beta-menu-rule"></div><button type="button" data-beta-action="leave" hidden>Leave room</button><button type="button" data-beta-action="end" hidden>End room for everyone</button><button type="button" data-beta-action="exit">Back to the classic canvas <span aria-hidden="true"></span></button></div>
    </header>
    <div class="beta-body">
      <aside class="beta-sidebar" aria-label="Boards and room controls">
        <div class="beta-sidebar-heading"><h2>Your boards</h2><button type="button" class="beta-add-board cw-round-button" aria-label="Add a board">+</button></div>
        <nav class="beta-board-list" aria-label="Room boards"></nav>
        <div class="beta-sidebar-bottom"><span aria-hidden="true">✿</span><p>A little space.<br>A bigger picture.</p><p class="beta-private-note">Your view is yours.<br>The room grows together.</p></div>
      </aside>
      <main class="beta-main">
        <div class="beta-view-bar"><div class="beta-view-modes cw-capsule" role="group" aria-label="Workspace view"><button type="button" class="cw-segment" data-beta-mode="work" aria-pressed="true">Work</button><button type="button" class="cw-segment" data-beta-mode="space" aria-pressed="false">Space <span aria-hidden="true">◇</span></button></div><div class="beta-current-board"><strong></strong><span></span></div><details class="beta-placement"><summary aria-label="Position in space" title="Position in space"><span class="beta-position-icon" aria-hidden="true"></span><span class="beta-sr-only">Position in space</span></summary><div class="beta-position-panel cw-folded-menu" data-cw-disclosure-content><h2>A place in space</h2><p>Shared placement. Your camera stays yours.</p><form class="beta-pose-form"><fieldset><legend class="beta-sr-only">Selected board position and rotation</legend><div class="beta-coordinate-fields"></div><button type="submit" class="beta-button beta-pose-apply">Apply position</button></fieldset></form></div></details></div>
        <div class="beta-notice" role="status" hidden></div>
        <div class="beta-viewport" data-beta-mode="work">
          <div class="beta-past-banner" hidden><span>Exploring the past · read-only</span></div>
          <div class="beta-board-host board-viewport"></div>
          <div class="beta-space" hidden tabindex="0" aria-label="Spatial overview. Arrow keys orbit your camera, plus and minus zoom."><div class="beta-world"></div></div>
          <div class="beta-work-tools cw-pebble-dock" role="toolbar" aria-label="Board tools"><div class="beta-primary-tools"></div><span class="beta-dock-divider" aria-hidden="true"></span><button type="button" class="beta-tool-palette-trigger cw-round-button" aria-label="More board tools" aria-expanded="false" title="More board tools"></button></div>
          <div class="beta-tool-palette cw-folded-menu" role="dialog" aria-label="More board tools" hidden><p class="beta-menu-eyebrow">A little more possibility</p><div class="beta-tool-extras"></div></div>
          <button type="button" class="beta-share-control cw-round-button" data-beta-action="share" aria-label="Share a window" aria-pressed="false" title="Share a window"></button>
          <section class="beta-capture-status cw-folded-menu" aria-label="Window sharing" hidden><div class="beta-capture-copy" role="status" aria-live="polite" aria-atomic="true"><strong></strong><p id="spatial-capture-detail"></p></div><details class="beta-capture-help"><summary>Sharing help</summary><ul></ul><a target="_blank" rel="noopener">Open Common in its own tab</a><small></small></details><button type="button" class="beta-capture-dismiss" aria-label="Dismiss sharing message">×</button></section>
          <button type="button" class="beta-navigation-trigger cw-round-button" aria-label="View controls" aria-expanded="false" title="View controls"></button><div class="beta-navigation-panel cw-folded-menu" role="dialog" aria-label="View controls" hidden><p class="beta-menu-eyebrow">Only your view</p><div class="beta-navigation-host"></div></div>
          <div class="beta-camera" role="group" aria-label="Your spatial camera" hidden><div class="beta-compass"><button type="button" data-beta-camera="left" aria-label="Orbit left"></button><button type="button" data-beta-camera="up" aria-label="Tilt up"></button><button type="button" data-beta-camera="reset" aria-label="Reset camera"></button><button type="button" data-beta-camera="down" aria-label="Tilt down"></button><button type="button" data-beta-camera="right" aria-label="Orbit right"></button></div><div class="beta-camera-zoom"><button type="button" data-beta-camera="in" aria-label="Zoom in">+</button><button type="button" data-beta-camera="out" aria-label="Zoom out">−</button></div></div>
          <p class="beta-space-hint" hidden>Your camera, your curiosity. Open a board to step inside.</p>
          <div class="beta-empty" hidden><span aria-hidden="true">✳</span><h2>A little space for what comes next.</h2><p>Add a board to start growing your room.</p><button type="button" class="beta-button beta-empty-add">Add your first board</button></div>
        </div>
      </main>
      <footer class="beta-history" aria-label="Automatic room history">
        <div class="beta-history-heading"><span class="beta-time-pill">Live now</span><p class="beta-history-status"></p><span class="beta-live-changes" hidden></span><button type="button" class="beta-branch" data-beta-action="fork" aria-label="Branch from here" hidden><span class="beta-branch-label">Branch from here</span><span class="beta-branch-short" aria-hidden="true">Branch</span><span class="beta-branch-icon" aria-hidden="true"></span></button><button type="button" class="beta-button beta-return-live" hidden>Return to live →</button></div>
        <div class="beta-scrubber"><span class="beta-history-first"></span><input class="beta-time-slider" type="range" min="0" max="0" step="1" value="0" aria-label="Explore automatically saved room history"><span class="beta-history-last">Now</span></div>
        <div class="beta-timeline-labels"><span class="beta-history-count"></span><p class="beta-mobile-save-state" role="status"></p></div>
      </footer>
    </div>
    <div class="beta-announcement beta-sr-only" role="status" aria-live="polite"></div>`;
  root.replaceChildren(shell);
  const $ = selector => shell.querySelector(selector);
  const boardHost = $('.beta-board-host');
  const toolbarHost = $('.beta-work-tools');
  const toolExtrasHost = $('.beta-tool-extras');
  const navigationHost = $('.beta-navigation-host');
  const agentToolsHost = $('.beta-agent-tools-host');
  const scene = $('.beta-space');
  const world = $('.beta-world');
  const boardList = $('.beta-board-list');
  const timeline = $('.beta-time-slider');
  const poseForm = $('.beta-pose-form');
  const poseFields = new Map();
  let state = { boards: [], mode: 'work', live: true, revisions: [] };
  let destroyed = false;
  // Camera changes are local to this view; only the pose form mutates shared placement.
  let orbit = { x: 24, y: -22, zoom: 1 };
  let baseScale = 1;
  let pointer = null;
  let contentSignature = '';
  let poseSignature = '';
  let sceneGeometrySignature = '';
  let capturePhase = '';
  let captureDismissed = false;
  let captureHelpRequested = false;
  let captureHelpSignature = '';
  const planes = new Map();
  const boardButtons = new Map();
  const previewStates = new Map();
  const placementDetails = $('.beta-placement');
  const placementPanel = $('.beta-position-panel');
  // Keep the inspector out of the canvas clipping region and in the same safe
  // popover layer as other controls. The summary remains a native disclosure.
  placementPanel.setAttribute('role', 'dialog');
  placementPanel.setAttribute('aria-label', 'Position in space');
  shell.append(placementPanel);
  const popovers = [
    attachPopover({
      trigger: $('.beta-room-trigger'),
      panel: $('.beta-room-menu'),
      placement: 'bottom-end',
    }),
    attachPopover({
      trigger: $('.beta-tool-palette-trigger'),
      panel: $('.beta-tool-palette'),
      placement: 'top-end',
    }),
    attachPopover({
      trigger: $('.beta-navigation-trigger'),
      panel: $('.beta-navigation-panel'),
      placement: 'top-end',
    }),
    attachPopover({
      trigger: placementDetails.querySelector('summary'),
      panel: placementPanel,
      placement: 'bottom-end',
      onOpenChange: open => {
        placementDetails.open = open;
      },
    }),
  ];
  const toolbarCleanup = attachRovingToolbar(toolbarHost);
  boardHost.addEventListener('focusin', event => {
    if (event.target.closest('.board-writing-surface')) closePopovers();
  }, { signal });

  function closePopovers() {
    for (const popover of popovers) popover.close({ restoreFocus: false });
  }

  $('.beta-position-icon').append(icon('position'));
  $('.beta-tool-palette-trigger').append(icon('more'));
  $('.beta-navigation-trigger').append(icon('settings'));
  $('.beta-share-control').append(icon('share'), element('span', 'beta-sr-only', 'Share a window'));
  $('.beta-room-trigger').firstElementChild.replaceWith(icon('room'));
  $('.beta-menu-chevron').replaceChildren(icon('chevron'));
  for (const span of $('.beta-room-menu').querySelectorAll('[aria-hidden]'))
    span.append(icon('arrow'));
  $('.beta-branch-icon').append(icon('branch'));
  $('[data-beta-mode="space"] [aria-hidden]').replaceChildren(icon('position'));
  for (const button of $('.beta-compass').querySelectorAll('button'))
    button.append(icon(button.dataset.betaCamera));

  const action = (name, payload) => handlers.onAction?.(name, payload);
  const announce = text => {
    $('.beta-announcement').textContent = text;
  };
  const select = id => handlers.onSelectBoard?.(id);
  const setMode = mode => handlers.onModeChange?.(mode);
  const live = () => handlers.onLive?.();
  const isLive = () => state.live !== false;
  const canEdit = () =>
    isLive() &&
    state.canEdit !== false &&
    state.connection !== 'disconnected' &&
    state.connection !== 'offline';

  for (const [key, label] of POSE_FIELDS) {
    const labelNode = element('label', 'beta-coordinate');
    labelNode.append(element('span', '', label));
    const input = element('input');
    input.type = 'number';
    input.name = key;
    input.step = 'any';
    input.value = '0';
    input.required = true;
    input.min = key.startsWith('rotation') ? '-360' : '-100000';
    input.max = key.startsWith('rotation') ? '360' : '100000';
    labelNode.append(input);
    $('.beta-coordinate-fields').append(labelNode);
    poseFields.set(key, input);
  }
  for (const [tool, label] of TOOLS) {
    const button = element('button', 'beta-tool');
    button.type = 'button';
    button.dataset.betaTool = tool;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(tool === 'select'));
    button.append(icon(tool), element('span', 'beta-tool-label', label));
    (PRIMARY_TOOLS.includes(tool) ? $('.beta-primary-tools') : toolExtrasHost).append(button);
  }
  const imageButton = element('button', 'beta-palette-action');
  imageButton.type = 'button';
  imageButton.dataset.betaAction = 'image';
  imageButton.append(icon('image'), element('span', '', 'Add image'));
  toolExtrasHost.append(imageButton);

  shell.addEventListener(
    'pointerdown',
    event => {
      if (event.target.closest('.beta-share-control') && boardHost.querySelector('.board-is-writing'))
        event.preventDefault();
    },
    { signal },
  );
  shell.addEventListener(
    'click',
    event => {
      const button = event.target.closest('button');
      if (!button || !shell.contains(button) || button.disabled) return;
      if (button.classList.contains('beta-capture-dismiss')) {
        captureDismissed = true;
        renderCaptureControls();
        const share = $('.beta-share-control');
        (share.hidden || share.disabled ? $('.beta-room-trigger') : share).focus({ preventScroll: true });
      } else if (button.dataset.betaAction === 'sharing-help') {
        closePopovers();
        captureHelpRequested = true;
        captureDismissed = false;
        renderCaptureControls();
        $('.beta-capture-help').open = true;
      } else if (button.dataset.betaMode) setMode(button.dataset.betaMode);
      else if (button.dataset.betaCamera) moveCamera(button.dataset.betaCamera);
      else if (button.dataset.betaTool) {
        // Dismiss synchronously so actions retain the click's native capture/download gesture.
        closePopovers();
        action('tool', { tool: button.dataset.betaTool });
      } else if (button.dataset.betaAction) {
        closePopovers();
        action(button.dataset.betaAction);
      } else if (button.classList.contains('beta-return-live')) live();
      else if (
        button.classList.contains('beta-add-board') ||
        button.classList.contains('beta-empty-add')
      )
        handlers.onAddBoard?.();
      else if (button.classList.contains('agent-tools-trigger')) closePopovers();
    },
    { signal },
  );
  // History selection is personal. The owner supplies the selected snapshot and keeps
  // receiving live edits while this shell presents that snapshot as read-only.
  timeline.addEventListener('input', () => handlers.onTimeChange?.(Number(timeline.value)), {
    signal,
  });
  poseForm.addEventListener(
    'submit',
    event => {
      event.preventDefault();
      if (!canEdit() || !state.activeBoardId || !poseForm.reportValidity()) return;
      const pose = Object.fromEntries(
        [...poseFields].map(([key, input]) => [key, Number(input.value)]),
      );
      action('pose', { boardId: state.activeBoardId, pose });
    },
    { signal },
  );

  function updateCamera() {
    world.style.transform = `translate3d(-50%,-50%,0) scale(${baseScale * orbit.zoom}) rotateX(${orbit.x}deg) rotateY(${orbit.y}deg)`;
  }
  function moveCamera(direction) {
    if (direction === 'left') orbit.y -= 12;
    else if (direction === 'right') orbit.y += 12;
    else if (direction === 'up') orbit.x = clamp(orbit.x + 8, -75, 75);
    else if (direction === 'down') orbit.x = clamp(orbit.x - 8, -75, 75);
    else if (direction === 'in') orbit.zoom = clamp(orbit.zoom * 1.2, 0.15, 4, 1);
    else if (direction === 'out') orbit.zoom = clamp(orbit.zoom / 1.2, 0.15, 4, 1);
    else orbit = { x: 24, y: -22, zoom: 1 };
    updateCamera();
  }
  scene.addEventListener(
    'keydown',
    event => {
      if (event.target !== scene) return;
      const cameraKey = CAMERA_KEYS[event.key];
      if (cameraKey) {
        event.preventDefault();
        moveCamera(cameraKey);
      }
    },
    { signal },
  );
  scene.addEventListener(
    'pointerdown',
    event => {
      if (event.button !== 0 || event.target.closest('.beta-plane')) return;
      pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        orbitX: orbit.x,
        orbitY: orbit.y,
      };
      scene.setPointerCapture(event.pointerId);
      scene.classList.add('beta-orbiting');
    },
    { signal },
  );
  scene.addEventListener(
    'pointermove',
    event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      orbit.x = clamp(pointer.orbitX - (event.clientY - pointer.y) * 0.25, -75, 75);
      orbit.y = clamp(pointer.orbitY + (event.clientX - pointer.x) * 0.3, -360, 360);
      updateCamera();
    },
    { signal },
  );
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
    scene.addEventListener(
      name,
      () => {
        pointer = null;
        scene.classList.remove('beta-orbiting');
      },
      { signal },
    );
  scene.addEventListener(
    'wheel',
    event => {
      if (state.mode !== 'space') return;
      event.preventDefault();
      orbit.zoom = clamp(orbit.zoom * Math.exp(-event.deltaY * 0.001), 0.15, 4, 1);
      updateCamera();
    },
    { signal, passive: false },
  );

  function fitScene() {
    if (!scene.clientWidth || !scene.clientHeight) return;
    const boards = state.boards || [];
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    let back = Infinity;
    let front = -Infinity;
    for (const board of boards) {
      const pose = poseOf(board);
      const width = clamp(board.width, 160, 4000, 960);
      const height = clamp(board.height, 120, 3000, 600);
      left = Math.min(left, pose.x);
      right = Math.max(right, pose.x + width);
      top = Math.min(top, pose.y);
      bottom = Math.max(bottom, pose.y + height);
      back = Math.min(back, pose.z);
      front = Math.max(front, pose.z);
    }
    const width = boards.length ? Math.max(600, right - left) : 960;
    const height = boards.length ? Math.max(400, bottom - top) : 600;
    const depth = boards.length ? front - back : 0;
    baseScale = Math.min(
      0.85,
      (scene.clientWidth - 70) / (width + depth * 0.6),
      (scene.clientHeight - 130) / (height + depth * 0.5),
    );
    baseScale = Math.max(0.015, baseScale);
    world.style.width = `${width}px`;
    world.style.height = `${height}px`;
    world.style.setProperty('--beta-origin-x', `${boards.length ? -left : 0}px`);
    world.style.setProperty('--beta-origin-y', `${boards.length ? -top : 0}px`);
    world.style.setProperty('--beta-origin-z', `${boards.length ? -(front + back) / 2 : 0}px`);
    updateCamera();
  }
  const observer = new ResizeObserver(fitScene);
  observer.observe(scene);

  function previewObject(object, liveView) {
    if (!object || typeof object !== 'object') return null;
    const node = element(
      'span',
      `beta-preview-object beta-preview-${String(object.type || 'unknown').replace(/[^a-z]/g, '')}`,
    );
    const width = clamp(object.width, 1, 10000, 180);
    const height = clamp(object.height, 1, 10000, 90);
    node.style.left = `${clamp(object.x, -100000, 100000)}px`;
    node.style.top = `${clamp(object.y, -100000, 100000)}px`;
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;
    if (validColor(object.color)) node.style.color = object.color;
    if (validColor(object.fill)) node.style.backgroundColor = object.fill;
    if (object.type === 'image') {
      const src = object.src || object.url;
      if (
        typeof src === 'string' &&
        (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(src) ||
          /^blob:/i.test(src) ||
          /^\/(?!\/)/.test(src))
      ) {
        const image = element('img');
        image.src = src;
        image.alt = object.title || 'Image';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        node.append(image);
      } else node.textContent = object.title || 'Image';
    } else if (object.type === 'screen') {
      node.append(
        element('span', 'beta-preview-card-title', object.title || 'Shared window'),
        element(
          'span',
          'beta-preview-card-note',
          liveView ? 'Open board to view shared window' : 'Screen pixels require a recording',
        ),
      );
    } else if (object.type === 'diagram') {
      node.append(
        element('span', 'beta-preview-card-title', object.title || 'Diagram'),
        element('span', 'beta-preview-card-note', object.source || 'Open board to view diagram'),
      );
    } else if (object.type === 'draw' || object.type === 'arrow') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const points = Array.isArray(object.points)
        ? object.points.filter(point => point && typeof point === 'object').slice(0, 500)
        : [];
      const d =
        object.type === 'arrow'
          ? `M 2 ${height / 2} H ${Math.max(2, width - 5)} m -12 -8 l 12 8 -12 8`
          : points
              .map(
                (point, index) =>
                  `${index ? 'L' : 'M'} ${clamp(point.x ?? point[0], -10000, 10000)} ${clamp(point.y ?? point[1], -10000, 10000)}`,
              )
              .join(' ');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', validColor(object.color) || '#567263');
      path.setAttribute('stroke-width', '3');
      svg.append(path);
      node.append(svg);
    } else {
      node.textContent = object.text || object.title || '';
      node.style.fontSize = `${clamp(object.fontSize, 8, 240, 24)}px`;
    }
    return node;
  }

  function boardPreviewState(board) {
    const objects = objectList(board);
    return {
      objects, live: isLive(),
      width: clamp(board.width, 160, 4000, 960), height: clamp(board.height, 120, 3000, 600),
      // Only projections created by our store promise deep immutability.
      // Ordinary callers may mutate an existing array and still need comparison.
      serializedObjects: isSpatialProjection(objects) ? null : JSON.stringify(objects),
    };
  }

  function samePreviewState(previous, next) {
    return !!previous && previous.live === next.live
      && previous.width === next.width && previous.height === next.height
      && (next.serializedObjects === null
        ? previous.serializedObjects === null && previous.objects === next.objects
        : previous.serializedObjects === next.serializedObjects);
  }

  function renderBoards({ enteringSpace = false } = {}) {
    const currentIds = new Set(state.boards.map(board => String(board.id)));
    for (const [id, plane] of planes) {
      if (!currentIds.has(id)) {
        plane.remove();
        planes.delete(id);
        boardButtons.get(id)?.remove();
        boardButtons.delete(id);
        previewStates.delete(id);
      }
    }
    for (const board of state.boards) {
      const id = String(board.id);
      const active = id === String(state.activeBoardId);
      const objects = objectList(board);
      let button = boardButtons.get(id);
      if (!button) {
        button = element('button', 'beta-board-link cw-board-tab');
        button.type = 'button';
        button.dataset.betaBoard = id;
        button.append(
          element('span', 'beta-board-icon'),
          element('span', 'beta-board-link-text'),
          element('span', 'beta-board-count'),
        );
        button.addEventListener('click', () => select(id), { signal });
        boardButtons.set(id, button);
      }
      button.querySelector('.beta-board-link-text').textContent =
        board.name || board.title || 'Untitled board';
      button.querySelector('.beta-board-count').textContent = String(objects.length);
      button.querySelector('.beta-board-icon').textContent = String(
        state.boards.indexOf(board) + 1,
      ).padStart(2, '0');
      button.setAttribute('aria-pressed', String(active));
      const index = state.boards.indexOf(board);
      if (boardList.children[index] !== button)
        boardList.insertBefore(button, boardList.children[index] || null);
      let plane = planes.get(id);
      if (!plane) {
        plane = element('button', 'beta-plane');
        plane.type = 'button';
        plane.dataset.betaBoard = id;
        plane.append(
          element('span', 'beta-plane-heading'),
          element('span', 'beta-plane-preview'),
          element('span', 'beta-plane-open', 'Step inside →'),
        );
        plane.addEventListener(
          'click',
          () => {
            select(id);
            setMode('work');
          },
          { signal },
        );
        planes.set(id, plane);
      }
      const pose = poseOf(board);
      const width = clamp(board.width, 160, 4000, 960);
      const height = clamp(board.height, 120, 3000, 600);
      plane.style.width = `${width}px`;
      plane.style.height = `${height}px`;
      plane.style.transform = `translate3d(calc(${pose.x}px + var(--beta-origin-x,0px)),calc(${pose.y}px + var(--beta-origin-y,0px)),calc(${pose.z}px + var(--beta-origin-z,0px))) rotateX(${pose.rotationX}deg) rotateY(${pose.rotationY}deg) rotateZ(${pose.rotationZ}deg)`;
      plane.setAttribute(
        'aria-label',
        `Open ${board.name || board.title || 'Untitled board'}, ${objects.length} objects, depth ${pose.z}`,
      );
      plane.setAttribute('aria-pressed', String(active));
      const heading = plane.querySelector('.beta-plane-heading');
      heading.replaceChildren(
        element('strong', '', board.name || board.title || 'Untitled board'),
        element('span', '', `Z ${pose.z}`),
      );
      // Work mode keeps plane metadata current without rebuilding an invisible
      // second copy of every board. Space entry compares the latest contents.
      if (state.mode === 'space') {
        const previewState = boardPreviewState(board);
        if (!samePreviewState(previewStates.get(id), previewState)) {
          const preview = plane.querySelector('.beta-plane-preview');
          preview.replaceChildren();
          const availableHeight = height - 76;
          const bounds = objects.reduce(
            (acc, object) => ({
              width: Math.max(
                acc.width,
                clamp(object?.x, -100000, 100000) + clamp(object?.width, 0, 10000, 180),
              ),
              height: Math.max(
                acc.height,
                clamp(object?.y, -100000, 100000) + clamp(object?.height, 0, 10000, 90),
              ),
            }),
            { width, height: availableHeight },
          );
          const previewScale = Math.min(1, width / bounds.width, availableHeight / bounds.height);
          const content = element('span', 'beta-plane-content');
          content.style.transform = `scale(${previewScale})`;
          for (const object of objects.slice(0, 100)) {
            const node = previewObject(object, isLive());
            if (node) content.append(node);
          }
          if (!objects.length)
            content.append(element('span', 'beta-plane-empty', 'Room for a little thought…'));
          preview.append(content);
          previewStates.set(id, previewState);
        }
      }
      if (world.children[index] !== plane) world.insertBefore(plane, world.children[index] || null);
    }
    if (state.mode === 'space') {
      const geometrySignature = JSON.stringify(state.boards.map(board => [
        board.id, poseOf(board), board.width, board.height,
      ]));
      // Object contents cannot change the scene bounds. Avoid a layout read
      // after every edit; ResizeObserver handles visible viewport size changes.
      if (enteringSpace || geometrySignature !== sceneGeometrySignature) {
        sceneGeometrySignature = geometrySignature;
        fitScene();
      }
    }
  }

  function renderHeading(saveState, saveMessage) {
    const title = state.title || 'A little room to explore';
    $('.beta-room-heading h1').textContent = title;
    $('.beta-room-heading h1').title = title;
    $('.beta-save-state').textContent = saveMessage;
    $('.beta-mobile-save-state').textContent = saveMessage;
    $('.beta-save-state').dataset.state = saveState;
    $('.beta-mobile-save-state').dataset.state = saveState;
    $('.beta-notice').hidden = !state.notice;
    $('.beta-notice').textContent = state.notice || '';
    const inRoom = Boolean(state.room || state.inRoom);
    for (const button of shell.querySelectorAll('[data-beta-action="create-room"]'))
      button.hidden = inRoom || state.canCreateRoom === false;
    for (const button of shell.querySelectorAll(
      '[data-beta-action="invite"],[data-beta-action="leave"]',
    ))
      button.hidden = !inRoom || state.admitted === false || state.terminal;
    for (const button of shell.querySelectorAll('[data-beta-action="end"]'))
      button.hidden = !inRoom || state.terminal || !(state.isAdmin || state.isHost);
    for (const button of shell.querySelectorAll('[data-beta-action="retry"]'))
      button.hidden = !state.canRetry;
    for (const button of shell.querySelectorAll('[data-beta-action="join"]'))
      button.hidden = !state.canJoin;
    for (const button of shell.querySelectorAll('[data-beta-action="local"]'))
      button.hidden = !inRoom || !(state.terminal || state.admitted === false);
    for (const button of shell.querySelectorAll('[data-beta-action="theme"]'))
      button.disabled = state.canStyle === false;
  }

  function renderViewport(activeBoard, liveView, space) {
    $('.beta-current-board strong').textContent = space
      ? `${state.boards.length} ${state.boards.length === 1 ? 'board' : 'boards'} in space`
      : activeBoard?.name || activeBoard?.title || 'Your room';
    $('.beta-current-board span').textContent =
      `${liveView ? 'Live room' : 'Exploring history'} · Your view`;
    $('.beta-viewport').dataset.betaMode = space ? 'space' : 'work';
    boardHost.hidden = space || !activeBoard;
    scene.hidden = !space;
    $('.beta-camera').hidden = !space || !state.boards.length;
    $('.beta-space-hint').hidden = !space || !state.boards.length;
    $('.beta-past-banner').hidden = liveView;
    $('.beta-empty').hidden = !!state.boards.length;
    $('.beta-empty-add').disabled = !canEdit();
    $('.beta-add-board').disabled = !canEdit();
    const hideTools = space || state.tools === false || !activeBoard || !liveView;
    if (toolbarHost.hidden !== hideTools) toolbarHost.hidden = hideTools;
    $('.beta-share-control').hidden = (!activeBoard || space || !liveView) && !state.sharing && !state.capture?.requestPending;
    $('.beta-navigation-trigger').hidden = space || !activeBoard;
    for (const button of shell.querySelectorAll('[data-beta-mode]'))
      button.setAttribute('aria-pressed', String(button.dataset.betaMode === state.mode));
  }

  function renderToolControls() {
    for (const button of [
      ...toolbarHost.querySelectorAll('button'),
      ...toolExtrasHost.querySelectorAll('button'),
      ...navigationHost.querySelectorAll('button'),
    ]) {
      const navigation =
        NAVIGATION_TOOLS.includes(button.dataset.betaTool) ||
        NAVIGATION_ACTIONS.includes(button.dataset.betaAction);
      const disabled =
        !canEdit() && !navigation && !button.classList.contains('beta-tool-palette-trigger');
      if (button.disabled !== disabled) button.disabled = disabled;
      if (button.dataset.betaTool) {
        const pressed = String(button.dataset.betaTool === (state.tool || 'select'));
        if (button.getAttribute('aria-pressed') !== pressed)
          button.setAttribute('aria-pressed', pressed);
      }
      if (button.dataset.betaAction && !button.dataset.betaEnhanced) {
        const name = button.dataset.betaAction;
        if (['diagram', 'fit', 'zoom-in', 'zoom-out'].includes(name)) {
          const label = ACTION_LABELS[name];
          button.className = 'beta-palette-action';
          button.setAttribute('aria-label', label);
          button.replaceChildren(icon(name), element('span', '', label));
        }
        button.dataset.betaEnhanced = 'true';
      }
    }
    renderCaptureControls();
    $('.beta-tool-palette-trigger').dataset.active = String(
      !PRIMARY_TOOLS.includes(state.tool || 'select'),
    );
  }

  // Capture owns its browser permission state. Present it here without querying
  // persistent permissions or introducing another request before the native picker.
  function renderCaptureControls() {
    const capture = state.capture || {};
    const sharing = Boolean(state.sharing);
    const pending = Boolean(capture.requestPending);
    const blocked = !sharing && !pending && state.captureSupport?.available === false;
    const status = blocked ? { ...capture, ...state.captureSupport, phase: 'blocked' } : capture;
    const phase = status.phase || 'idle';
    const phaseKey = `${phase}:${status.code || ''}`;
    if (phaseKey !== capturePhase) {
      capturePhase = phaseKey;
      captureDismissed = false;
      $('.beta-capture-help').open = false;
    }
    const button = $('.beta-share-control');
    const label = sharing ? 'Stop sharing' : pending ? 'Cancel request' : blocked ? 'Sharing help' : 'Share a window';
    if (button.getAttribute('aria-label') !== label || !button.childNodes.length)
      button.replaceChildren(icon(sharing || pending ? 'stop' : 'share'), element('span', 'beta-sr-only', label));
    button.disabled = phase === 'abandoning' || (!canEdit() && !sharing && !pending);
    button.dataset.betaAction = blocked ? 'sharing-help' : 'share';
    button.dataset.capturePhase = phase;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(sharing));
    button.setAttribute('aria-busy', String(pending));
    button.title = label;
    const panel = $('.beta-capture-status');
    panel.dataset.phase = phase;
    const hasMessage = phase !== 'idle' && (!blocked || captureHelpRequested || capture.phase === 'blocked');
    panel.hidden = !(sharing || pending || (hasMessage && !captureDismissed));
    if (panel.hidden) button.removeAttribute('aria-describedby');
    else button.setAttribute('aria-describedby', 'spatial-capture-detail');
    const source = capture.source?.label || 'Chosen source';
    const title = sharing
      ? `${source} · ${capture.paused ? 'paused by browser' : 'sharing'}`
      : status.title || '';
    const detail = sharing
      ? `${state.personal ? 'Only on your canvas' : `Available to the session · ${capture.viewerCount || 0} watching`}. Sound is off.`
      : status.detail || '';
    if ($('.beta-capture-copy strong').textContent !== title) $('.beta-capture-copy strong').textContent = title;
    if ($('.beta-capture-copy p').textContent !== detail) $('.beta-capture-copy p').textContent = detail;
    const help = $('.beta-capture-help');
    const assistance = Array.isArray(status.help) ? status.help : [];
    help.hidden = !assistance.length;
    const helpSignature = JSON.stringify([assistance, status.code]);
    if (helpSignature !== captureHelpSignature) {
      captureHelpSignature = helpSignature;
      help.querySelector('ul').replaceChildren(...assistance.map(text => element('li', '', text)));
      help.querySelector('small').textContent = status.code ? `Browser detail: ${status.code}` : '';
    }
    const ownTab = help.querySelector('a');
    ownTab.hidden = window.parent === window;
    ownTab.href = location.href;
    $('.beta-capture-dismiss').hidden = sharing || pending;
  }

  function renderPlacement(activeBoard) {
    poseForm.querySelector('fieldset').disabled = !canEdit() || !activeBoard;
    // Do not overwrite an in-progress coordinate draft on an unrelated status render.
    const newPoseSignature = JSON.stringify([activeBoard?.id, poseOf(activeBoard)]);
    if (newPoseSignature !== poseSignature) {
      const pose = poseOf(activeBoard);
      for (const [key, input] of poseFields) input.value = String(pose[key]);
      poseSignature = newPoseSignature;
    }
  }

  function renderHistory(liveView, saveState, saveMessage) {
    const max = Math.max(0, state.revisions.length - 1);
    const index = liveView ? max : clamp(state.revisionIndex ?? max, 0, max, max);
    timeline.max = String(max);
    timeline.value = String(index);
    timeline.disabled = !state.revisions.length;
    const current = state.revisions[index];
    const currentTime = timeOf(current);
    const revisionDetail = [
      typeof current?.label === 'string' ? current.label : '',
      typeof current?.actor === 'string' ? current.actor : '',
      currentTime,
    ]
      .filter(Boolean)
      .join(' · ');
    timeline.setAttribute(
      'aria-valuetext',
      `${liveView ? state.terminal ? 'Latest saved' : 'Live' : 'History'}${revisionDetail ? `, ${revisionDetail}` : ''}, change ${index + 1} of ${state.revisions.length}`,
    );
    $('.beta-history-status').textContent = liveView && state.terminal
      ? 'This session is closed. Its history stays on this device.'
      : liveView
      ? ['unsaved', 'error', 'saving'].includes(saveState)
        ? saveMessage
        : 'A room, quietly remembering.'
      : revisionDetail || 'Earlier in this room';
    $('.beta-history-status').title = state.terminal
      ? 'Explore retained history, or branch from an earlier change to keep working locally.'
      : liveView
      ? 'Every change is saved automatically. Scrub to explore the past.'
      : `${revisionDetail} · Read-only. Teammates can keep working live.`;
    $('.beta-time-pill').textContent = liveView ? state.terminal ? 'Latest saved' : 'Live now' : currentTime || 'Earlier';
    $('.beta-history-first').textContent = timeOf(state.revisions[0]) || 'Then';
    $('.beta-history-last').textContent = state.terminal ? 'Latest' : 'Now';
    $('.beta-history-count').textContent =
      `${state.revisions.length} automatic ${state.revisions.length === 1 ? 'revision' : 'revisions'}`;
    const pending = Math.max(0, Number(state.pendingChanges) || 0);
    $('.beta-live-changes').hidden = liveView || !pending;
    $('.beta-live-changes').textContent =
      `${pending} new live ${pending === 1 ? 'change' : 'changes'}`;
    $('.beta-return-live').textContent = state.terminal ? 'Back to latest →' : 'Return to live →';
    $('.beta-return-live').hidden = liveView;
    $('.beta-return-live').disabled = liveView;
    $('.beta-branch').hidden = liveView;
    shell.dataset.history = liveView ? 'live' : 'past';
  }

  function render(next) {
    if (destroyed) return;
    const wasSpace = state.mode === 'space';
    state = { ...state, ...next };
    state.boards = Array.isArray(state.boards) ? state.boards : [];
    state.revisions = Array.isArray(state.revisions) ? state.revisions : [];

    const liveView = isLive();
    const space = state.mode === 'space';
    const activeBoard = state.boards.find(
      board => String(board.id) === String(state.activeBoardId),
    );
    const saveState = state.saveState || 'saved';
    const saveMessage =
      state.automaticSaveState ||
      state.saveMessage ||
      SAVE_MESSAGES[saveState] ||
      String(saveState);

    renderHeading(saveState, saveMessage);
    renderViewport(activeBoard, liveView, space);
    renderToolControls();
    renderPlacement(activeBoard);

    // Hidden previews need only board metadata and counts. Include the mode so
    // stepping into Space always checks contents changed while it was hidden.
    const boardContent = state.boards.map(board => [
      board.id, board.name, board.title, poseOf(board), board.width, board.height,
      objectList(board).length,
    ]);
    const newSignature = JSON.stringify([boardContent, state.activeBoardId, liveView, space]);
    const previewChanged = space && state.boards.some(
      board => !samePreviewState(previewStates.get(String(board.id)), boardPreviewState(board)),
    );
    if (newSignature !== contentSignature || previewChanged) {
      contentSignature = newSignature;
      renderBoards({ enteringSpace: space && !wasSpace });
    } else if (space && !wasSpace) {
      fitScene();
    }
    renderHistory(liveView, saveState, saveMessage);
  }

  render(state);
  return {
    boardHost,
    toolbarHost,
    toolExtrasHost,
    navigationHost,
    agentToolsHost,
    element: shell,
    render,
    announce,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      observer.disconnect();
      for (const popover of popovers) popover.destroy();
      toolbarCleanup();
      shell.remove();
      planes.clear();
      boardButtons.clear();
      previewStates.clear();
    },
  };
}
