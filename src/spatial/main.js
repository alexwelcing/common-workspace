import '../style.css';
import '../mobile.css';
import { Board } from '../board.js';
import {
  RoomAppearance,
  renderAppearancePicker,
  bindAppearancePicker,
  readAppearancePicker,
} from '../room-appearance.js';
import { restoreAppearance } from '../../lib/room-appearance.mjs';
import { appPath, appRoute, appStorageKey } from '../app-path.js';
import { isSpatialRoom, spacePath } from '../experience.js';
import { ModalController } from '../modal-controller.js';
import { installMobileViewport } from '../mobile-viewport.js';
import { prepareImage, clipboardImages, MAX_IMAGE_BATCH } from '../image-import.js';
import { ScreenSharing } from '../media.js';
import { displayCaptureSupport } from '../browser-permissions.js';
import { ScreenSubscriptions } from '../screen-subscriptions.js';
import { loadRuntimeConfig, getRuntimeConfig, cancelRuntimeConfigLoad } from '../runtime-config.js';
import { createSpatialStore, parseSpatialArchive } from './store.js';
import { openSpatialStorage } from './storage.js';
import { writeReplayArchive, readReplayArchive } from './archive.js';
import { mountSpatialView } from './view.js';
import { createSpatialSession } from './session.js';
import { installSpatialAgent } from './agent.js';
import { createWorkspaceTemplate } from './templates.js';
import { mediaDiagnostics } from '../diagnostics.js';
import { createPerformanceIndex, createPerformanceReport, installPerformanceDebugApi } from '../performance-index.js';
import { openPerformancePanel, bindPerformanceIndicator } from '../performance-panel.js';

const root = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const events = new AbortController();
const performanceIndex = createPerformanceIndex();
const cleanupPerformanceDebug = installPerformanceDebugApi(performanceIndex);
let cleanupPerformanceIndicator = () => {};
const appearanceUI = new RoomAppearance();
const subscriptions = new ScreenSubscriptions();
const streams = new Map();
const listeners = new Set();
const personalId = `personal-${crypto.randomUUID()}`;
// Long-lived browser resources. The active model changes with the selected board/time.
let store;
let board;
let view;
let agent;
let session;
let activeBoardModel;
let activeBoardId = null;
let selectedRevisionId = null;
let mode = 'work';
let sandbox = true;
let connected = false;
let terminal = false;
let visible = true;
let disposed = false;
let storageStatus = { state: 'loading', message: 'Opening your autosaved room…' };
let participants = [];
let pendingRoom = null;
let roomLookupError = '';

// Workspace changes cancel old room/import work; selection changes cancel board-local work.
let workspaceGeneration = 0;
let selectionGeneration = 0;
let renderedBoardSource = '';
let renderedTerminal = false;
let pendingChanges = 0;
let renderFrame;
let draftTimer;
let toastTimer;
let modalCleanup;
let modalRevision = 0;
let historyFingerprint = '';
let appearanceSignature = '';
let createSeed = null;
let personalMedia;
let destroyPromise;
const imageRequests = new Set();
const downloadUrls = new Set();
const renderedEntities = new Map();
const localEntityChanges = new Set();
const $ = selector => document.querySelector(selector);
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const editable = () => !!store && !disposed && !terminal && !selectedRevisionId && (sandbox || connected);
const ownId = () => (sandbox ? personalId : session?.auth?.participantId);
const activeMedia = () => (sandbox ? personalMedia : session?.media);
const state = () => store?.projection(selectedRevisionId) || { boards: [] };
const objects = () => state().boards.find(item => item.id === activeBoardId)?.objects || [];

function toast(message) {
  if (disposed) return;
  clearTimeout(toastTimer);
  const item = document.createElement('div');
  item.className = 'toast';
  item.textContent = String(message);
  $('#toasts').replaceChildren(item);
  view?.announce(String(message));
  toastTimer = setTimeout(() => {
    item.remove();
  }, 7000);
}
const modalController = new ModalController({
  root: modalRoot,
  getFallback: () => board?.el || root,
  onRequestClose: closeModal,
  signal: events.signal,
});
function closeModal() {
  modalCleanup?.();
  modalCleanup = null;
  modalRevision++;
  modalController.close();
}
function modal(html, onSubmit) {
  modalCleanup?.();
  modalCleanup = null;
  modalRevision++;
  modalRoot.innerHTML = `<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button class="close-modal" aria-label="Close dialog" type="button">×</button>${html}</section></div>`;
  modalRoot.querySelector('.close-modal').onclick = closeModal;
  modalRoot.querySelector('.modal-overlay').onclick = event => {
    if (event.target === event.currentTarget) closeModal();
  };
  const form = modalRoot.querySelector('form');
  if (onSubmit && form) form.onsubmit = onSubmit;
  modalController.activate();
}
function formError(form, message) {
  let error = form.querySelector('.form-error');
  if (!error) {
    error = document.createElement('p');
    error.className = 'form-error';
    error.setAttribute('role', 'alert');
    form.append(error);
  }
  error.textContent = String(message);
}
function download(data, type, filename) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  downloadUrls.add(url);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    downloadUrls.delete(url);
  }, 1000);
}
function seedWorkspace(template = 'walkthrough') {
  return createWorkspaceTemplate(template, restoreAppearance());
}

// Board and agent APIs share this adapter; replacing it also invalidates old agent grants.
function bindActiveBoardModel() {
  activeBoardModel = {
    all: () => objects(),
    get: id => objects().find(item => item.id === id),
    getOrder: () => objects().map(item => item.id),
    setLocal: (entity, fields) => editable() && store.setEntity(activeBoardId, entity, fields),
    patch: (id, patch) => {
      const entity = objects().find(item => item.id === id);
      return (
        !!entity && editable() && store.setEntity(activeBoardId, { ...entity, ...patch }, Object.keys(patch))
      );
    },
    deleteLocal: id => editable() && store.deleteEntity(activeBoardId, id),
    reorder: (id, position) => editable() && store.reorderEntity(activeBoardId, id, position),
    beginHistoryGroup() {},
    endHistoryGroup() {},
    stopCapturing() {},
  };
}
function flushDraft() {
  clearTimeout(draftTimer);
  if (!editable() || !board?.editingId || !board.editingDirty || board.editingComposing || !store) return;
  const entity = board.entities.get(board.editingId);
  const content = board.editingContent;
  if (entity && content)
    try {
      store.setEntity(activeBoardId, { ...entity, text: board.getEditingText() }, ['text']);
    } catch (error) {
      toast(error.message);
    }
}
// Commit the old selection before changing board/time, then cancel its pending edits.
function finishActiveSelection() {
  flushDraft();
  board?.finishTextEdit?.();
  board?.closeDiagramEditor({ restoreFocus: false });
  board?.cancelPointers();
  agent?.revoke('session-changed');
  selectionGeneration++;
  for (const controller of imageRequests) controller.abort();
  imageRequests.clear();
}
function selectBoard(id) {
  if (!state().boards.some(item => item.id === id)) return;
  finishActiveSelection();
  activeBoardId = id;
  renderedBoardSource = '';
  bindActiveBoardModel();
  render();
}
function selectTime(index) {
  const revisions = store?.revisions() || [];
  if (!revisions[index]) return;
  finishActiveSelection();
  selectedRevisionId = index === revisions.length - 1 ? null : revisions[index].id;
  pendingChanges = 0;
  renderedBoardSource = '';
  bindActiveBoardModel();
  render();
}
function returnLive() {
  finishActiveSelection();
  selectedRevisionId = null;
  pendingChanges = 0;
  renderedBoardSource = '';
  bindActiveBoardModel();
  render();
}
function scheduleRender() {
  if (disposed || renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    render();
  });
}
function syncWatching() {
  if (!board || disposed) return;
  const ids = subscriptions.plan(board.listEntities(), {
    participantId: ownId(),
    selectedId: board.selectedId,
    focusedId: board.focusedId,
    view: board.getView(),
    width: board.el.clientWidth,
    height: board.el.clientHeight,
    hidden: !visible || document.hidden || mode !== 'work' || !!selectedRevisionId || terminal,
  });
  board.setScreenSubscriptions(ids, ownId());
  session?.watch(ids);
}
function render() {
  if (disposed || !store || !view) return;
  return performanceIndex.measure('spatial-render', renderWorkspace);
}

function renderWorkspace() {
  let snapshot;
  try {
    snapshot = state();
  } catch (error) {
    toast(error.message);
    return;
  }
  // Projection contents are immutable; sorting is a personal presentation choice.
  snapshot = { ...snapshot, boards: [...snapshot.boards].sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1)) };
  const revisions = store.revisions();
  const fingerprint = revisions.at(-1)?.id || '';
  if (selectedRevisionId && historyFingerprint && fingerprint !== historyFingerprint) pendingChanges++;
  historyFingerprint = fingerprint;
  if (!snapshot.boards.some(item => item.id === activeBoardId)) {
    finishActiveSelection();
    activeBoardId = snapshot.boards[0]?.id || null;
    renderedBoardSource = '';
    bindActiveBoardModel();
  }
  const roomAppearance =
    !sandbox && !selectedRevisionId
      ? session?.auth?.room.appearance || snapshot.appearance
      : snapshot.appearance;
  const nextAppearanceSignature = JSON.stringify(roomAppearance);
  if (nextAppearanceSignature !== appearanceSignature) {
    appearanceUI.apply(roomAppearance);
    appearanceSignature = nextAppearanceSignature;
  }
  view.render({
    ...snapshot,
    activeBoardId,
    mode,
    live: !selectedRevisionId,
    revisions,
    selectedRevisionId,
    revisionIndex: selectedRevisionId
      ? revisions.findIndex(item => item.id === selectedRevisionId)
      : revisions.length - 1,
    pendingChanges,
    terminal,
    canJoin: !sandbox && !terminal && !roomLookupError && !session?.auth && !!pendingRoom,
    canRetry: !sandbox && !terminal && !!roomLookupError,
    admitted: !!session?.auth,
    connection: sandbox ? 'local' : connected ? 'connected' : 'disconnected',
    canEdit: editable(),
    saveState: storageStatus.state,
    saveMessage: storageStatus.message,
    notice: terminal
      ? 'This session is closed. Its autosaved history remains on this device.'
      : roomLookupError
        ? `${roomLookupError} Your history is available here. Open Room → Retry connection to try again.`
      : pendingRoom && !session?.auth
        ? 'Join this room to collaborate. Open Room → Join room when you are ready.'
      : !sandbox && !connected
        ? 'Connecting to teammates. Existing history is available while the room reconnects.'
        : '',
    room: !sandbox,
    isAdmin: session?.auth?.isAdmin,
    canCreateRoom: sandbox,
    canStyle: editable() && (sandbox || session?.auth?.isAdmin),
    tool: board?.tool || 'select',
    sharing: !!activeMedia()?.localStream,
    capture: activeMedia()?.getCaptureState(),
    captureSupport: displayCaptureSupport(),
    personal: sandbox,
  });
  board?.setWritingStatus(storageStatus);
  const media = mediaDiagnostics(activeMedia());
  performanceIndex.setContext({
    objects: snapshot.boards.reduce((count, item) => count + item.objects.length, 0),
    boards: snapshot.boards.length,
    participants: sandbox ? 1 : participants.length,
    peerConnections: media.peerConnections,
    watchedWindows: media.watchedWindows,
    queuedBytes: media.queuedBytes,
    bufferedBytes: media.bufferedBytes,
    historyBytes: store.getPerformanceState?.().historyBytes || 0,
  });
  if (!board) return;
  renderActiveBoard(snapshot);
  syncWatching();
  agent?.refresh();
  publishState();
}

// Update existing nodes so status renders preserve live video and text drafts.
function renderActiveBoard(snapshot) {
  const source = `${workspaceGeneration}:${activeBoardId}:${selectedRevisionId || 'live'}`;
  const sourceChanged = source !== renderedBoardSource;
  const readOnlyChanged = board.readOnly !== !editable();
  const reconcileAll = sourceChanged || readOnlyChanged || renderedTerminal !== terminal;
  const entries = snapshot.boards.find(item => item.id === activeBoardId)?.objects || [];
  const displayEntity = entity => terminal && entity.type === 'screen' ? { ...entity, historical: true } : entity;
  // A read-only transition can cancel an optimistic gesture inside Board.
  // Apply that cancellation first, then restore the accepted projection.
  if (readOnlyChanged) board.setReadOnly(!editable());
  if (reconcileAll) {
    board.finishTextEdit?.(false);
    board.setEntities(entries.map(displayEntity));
    if (sourceChanged) {
      renderedBoardSource = source;
      board.streams.clear();
      bindActiveBoardModel();
      if (mode === 'work' && entries.length)
        requestAnimationFrame(() => {
          if (!disposed && renderedBoardSource === source) board.fit();
        });
    }
  } else {
    const incoming = new Set(entries.map(item => item.id));
    for (const id of board.entities.keys()) {
      // A new shape is a local preview until pointer-up commits it.
      const creating = board.gesture?.type === 'create' && board.gesture.id === id;
      if (!incoming.has(id) && !creating) board.remove(id);
    }
    for (const entity of entries)
      if (renderedEntities.get(entity.id) !== entity || localEntityChanges.has(entity.id) || !board.entities.has(entity.id))
        board.upsert(displayEntity(entity));
  }
  renderedEntities.clear();
  for (const entity of entries) renderedEntities.set(entity.id, entity);
  localEntityChanges.clear();
  renderedTerminal = terminal;
  board.setLayerOrder(entries.map(item => item.id));
  for (const [id, stream] of streams) {
    const target = selectedRevisionId || terminal ? null : stream;
    if (board.streams.get(id) !== target && (target || board.streams.has(id))) board.setStream(id, target);
  }
  if (selectedRevisionId) for (const id of board.streams.keys()) board.setStream(id, null);
}

async function openWorkspace(id, options = {}) {
  finishActiveSelection();
  const workspaceAtStart = ++workspaceGeneration;
  const previous = store;
  store = null;
  activeBoardModel = null;
  renderedEntities.clear();
  localEntityChanges.clear();
  board?.setEntities([]);
  if (previous) {
    await previous.flush().catch(() => {});
    previous.destroy();
  }
  if (disposed || workspaceAtStart !== workspaceGeneration) return;
  performanceIndex.reset();
  storageStatus = { state: 'loading', message: 'Opening your autosaved room…' };
  const next = await createSpatialStore({
    id,
    actor: sandbox ? 'You' : session?.auth?.displayName || 'Teammate',
    ...options,
    performanceIndex,
    onChange: () => {
      if (workspaceAtStart === workspaceGeneration) scheduleRender();
    },
    onStatus: value => {
      if (workspaceAtStart === workspaceGeneration) {
        storageStatus = value;
        scheduleRender();
      }
    },
    onUpdate: (bytes, origin) => {
      if (workspaceAtStart === workspaceGeneration && !sandbox)
        for (const peer of session?.peerIds || []) if (peer !== origin) session.sendData(peer, bytes);
    },
  });
  if (disposed || workspaceAtStart !== workspaceGeneration) {
    next.destroy();
    return;
  }
  store = next;
  selectedRevisionId = null;
  const initialBoards = next.projection().boards;
  activeBoardId = initialBoards.find(item => item.name === 'Demo stage')?.id || initialBoards[0]?.id || null;
  pendingChanges = 0;
  historyFingerprint = '';
  renderedBoardSource = '';
  bindActiveBoardModel();
  render();
}
function stoppedSharing() {
  const id = ownId();
  streams.delete(id);
  if (!store || disposed) return;
  for (const item of store.projection().boards)
    for (const entity of item.objects)
      if (entity.type === 'screen' && entity.participantId === id) store.deleteEntity(item.id, entity.id);
  board?.setStream(id, null);
  scheduleRender();
  publishState();
}
function streamReceived(id, stream) {
  const key = id === 'local' ? ownId() : id;
  if (stream) streams.set(key, stream);
  else streams.delete(key);
  if (!selectedRevisionId) board?.setStream(key, stream);
  scheduleRender();
  publishState();
}
async function shareWindow() {
  const media = activeMedia(),
    workspaceAtStart = workspaceGeneration,
    boardId = activeBoardId;
  // Stopping stays available in history or Space, even when creating new content is blocked.
  if (media?.localStream || media?.getCaptureState().requestPending) {
    const stopping = media.stop();
    stoppedSharing();
    await stopping;
    return;
  }
  if (!editable() || !activeBoardId) {
    toast('Return to the live room before sharing a window.');
    return;
  }
  if (!media) {
    toast('Wait for the room connection before sharing.');
    return;
  }
  // Invoke capture while the original click still has browser activation.
  const capture = media.start();
  try {
    const stream = await capture;
    if (!stream) return;
    if (disposed || workspaceAtStart !== workspaceGeneration || !editable()) {
      media.stop();
      return;
    }
    const entity = {
      id: crypto.randomUUID(),
      type: 'screen',
      participantId: ownId(),
      streamId: stream.id,
      title: sandbox ? 'Your window' : `${session.auth.displayName || 'Your'} window`,
      x: 90,
      y: 120,
      width: 640,
      height: 390,
    };
    if (!store.setEntity(boardId, entity)) throw new Error('The room could not add this shared window. Choose another board and try again.');
    streamReceived(ownId(), stream);
    publishState();
  } catch (error) {
    const stopping = media.stop();
    if (!disposed && workspaceAtStart === workspaceGeneration) stoppedSharing();
    await stopping;
    if (disposed || workspaceAtStart !== workspaceGeneration) return;
    toast(error.message || 'The window could not be shared.');
  }
}
async function addImages(files, point = null) {
  if (!editable() || !activeBoardId) return;
  if (files.length > MAX_IMAGE_BATCH) {
    toast(`Choose up to ${MAX_IMAGE_BATCH} images at once.`);
    return;
  }
  const workspaceAtStart = workspaceGeneration,
    boardId = activeBoardId,
    selectionAtStart = selectionGeneration;
  const controller = new AbortController();
  imageRequests.add(controller);
  try {
    const prepared = await Promise.all(files.map(file => prepareImage(file, { signal: controller.signal })));
    if (
      disposed ||
      workspaceAtStart !== workspaceGeneration ||
      selectionAtStart !== selectionGeneration ||
      !editable()
    )
      return;
    const center = point || board.centerPoint();
    prepared.forEach((image, index) =>
      store.setEntity(boardId, {
        id: crypto.randomUUID(),
        type: 'image',
        ...image,
        x: center.x + index * 28,
        y: center.y + index * 28,
      }),
    );
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message);
  } finally {
    imageRequests.delete(controller);
  }
}
function pickImages() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
  input.multiple = true;
  input.onchange = () => addImages([...input.files]);
  input.click();
}
function roomForm(join = null) {
  if (join) { pendingRoom = join; scheduleRender(); }
  const title = join ? join.name : 'Start a spatial room';
  modal(
    `<h2 id="modal-title">${esc(title)}</h2><p>${join ? 'Join this room with the name and password from your host.' : 'Your room, its boards, and automatic history are shared directly between browsers.'}</p><form id="${join ? 'beta-join-form' : 'beta-create-form'}">${join ? '' : '<label>Session name<input name="name" maxlength="60" required value="A spatial room"></label><label>Start with<select name="template"><option value="current">Your current boards</option><option value="walkthrough">Team walkthrough</option><option value="review">Design review</option><option value="open">Open room</option></select></label>'}<label>Your name<input name="displayName" maxlength="60" required autocomplete="given-name"></label><label>Room password<input name="password" type="password" minlength="8" maxlength="128" required autocomplete="${join ? 'current-password' : 'new-password'}"></label><button class="primary modal-submit" type="submit">${join ? 'Join room' : 'Create room'}</button></form>`,
    async event => {
      event.preventDefault();
      const form = event.target,
        revision = modalRevision;
      const button = form.querySelector('.modal-submit');
      button.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form));
        if (join) await session.join(join.id, values);
        else {
          createSeed = values.template === 'current' ? store.fork() : seedWorkspace(values.template);
          await session.create({ ...values, appearance: state().appearance });
        }
        if (disposed || revision !== modalRevision) return;
        closeModal();
        if (!join) invite();
      } catch (error) {
        if (!disposed && revision === modalRevision) {
          formError(form, error.message);
          button.disabled = false;
        }
      }
    },
  );
}
function invite() {
  if (!session.auth) return;
  const url = new URL(spacePath(`/room/${encodeURIComponent(session.auth.room.id)}`), location.origin);
  modal(
    `<h2 id="modal-title">Invite your team</h2><p>This invitation opens Space & time. Share the password separately.</p><label>Session link<input id="beta-invite-link" readonly value="${esc(url.href)}"></label><button class="button" id="beta-copy-invite">Copy link</button><button class="primary modal-submit" id="beta-invite-done">Done</button>`,
  );
  $('#beta-copy-invite').onclick = async () => {
    try {
      await navigator.clipboard.writeText(url.href);
      toast('Invitation copied.');
    } catch {
      $('#beta-invite-link')?.select();
      toast('Select and copy the session link.');
    }
  };
  $('#beta-invite-done').onclick = closeModal;
}
function themeDialog() {
  if (!editable() || (!sandbox && !session.auth?.isAdmin)) return;
  const workspaceAtOpen = workspaceGeneration;
  modal(
    `<h2 id="modal-title">Room style</h2><p>Style changes join the automatic history.</p><form id="beta-style-form">${renderAppearancePicker(state().appearance)}<button class="primary modal-submit">Apply style</button></form>`,
    event => {
      event.preventDefault();
      if (workspaceAtOpen !== workspaceGeneration || !editable()) return;
      const appearance = readAppearancePicker(event.target);
      if (sandbox) store.updateRoom({ appearance });
      else if (!session.send({ type: 'appearance', appearance })) {
        formError(event.target, 'Reconnect before changing the room style.');
        return;
      }
      closeModal();
    },
  );
  modalCleanup = bindAppearancePicker($('#beta-style-form'));
}
function addBoard() {
  if (!editable()) return;
  modal(
    '<h2 id="modal-title">A new place in your room</h2><form id="beta-board-form"><label>Board name<input name="name" maxlength="100" required placeholder="e.g. Questions worth asking"></label><button class="primary modal-submit">Add board</button></form>',
    event => {
      event.preventDefault();
      if (!editable()) return;
      try {
        const count = store.projection().boards.length;
        const id = store.addBoard({
          name: new FormData(event.target).get('name'),
          pose: { x: (count % 3) * 1100 - 550, y: Math.floor(count / 3) * 820, z: -count * 60 },
        });
        closeModal();
        selectBoard(id);
      } catch (error) {
        formError(event.target, error.message);
      }
    },
  );
}
function confirmEnd() {
  modal(
    '<h2 id="modal-title">End this session?</h2><p>Everyone will disconnect. Each device keeps its autosaved history.</p><button class="primary danger-fill modal-submit" id="beta-confirm-end">End session for everyone</button><button class="button modal-submit" id="beta-cancel-end">Keep session open</button>',
  );
  $('#beta-confirm-end').onclick = () => {
    if (session.end()) closeModal();
    else toast('Reconnect to end the room.');
  };
  $('#beta-cancel-end').onclick = closeModal;
}
function importArchive() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.common,application/json';
  input.onchange = async () => {
    const workspaceAtStart = workspaceGeneration;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 64 * 1024 * 1024) {
      toast('Choose an archive smaller than 64 MiB.');
      return;
    }
    try {
      const archive = await performanceIndex.measure('archive-import', async () =>
        parseSpatialArchive(await readReplayArchive(new Uint8Array(await file.arrayBuffer()))),
      );
      if (disposed || workspaceAtStart !== workspaceGeneration) return;
      await openLocal({ archive });
      toast('Archive opened locally with its automatic history.');
    } catch (error) {
      toast(error.message || 'The archive could not be opened.');
    }
  };
  input.click();
}
async function deviceWorkspaces() {
  let storage;
  try {
    storage = await openSpatialStorage();
    const prefix = appStorageKey('common.spatial.');
    const records = (await storage.list()).filter(item => item.id.startsWith(prefix));
    modal(
      `<h2 id="modal-title">On this device</h2><p>Rooms and branches save here automatically. Closed sessions open with their retained history.</p><div class="menu-actions">${records.length ? records.map(item => `<button type="button" class="button beta-saved-workspace" data-workspace="${esc(item.id)}"><span>${esc(item.title || 'Spatial workspace')}<small style="display:block">${esc(new Date(item.updatedAt).toLocaleString())}</small></span></button>`).join('') : '<p>No rooms have been saved on this device yet.</p>'}</div>`,
    );
    for (const button of modalRoot.querySelectorAll('[data-workspace]'))
      button.onclick = async () => {
        const id = button.dataset.workspace,
          roomPrefix = appStorageKey('common.spatial.room.');
        closeModal();
        flushDraft();
        await store?.flush().catch(() => {});
        if (id.startsWith(roomPrefix)) {
          const roomId = id.slice(roomPrefix.length);
          if (/^[A-Za-z0-9_-]{1,100}$/.test(roomId)) location.href = spacePath(`/room/${roomId}`);
        } else await openLocal({ existingId: id });
      };
  } catch (error) {
    toast(error.message || 'This browser could not read its saved rooms.');
  } finally {
    storage?.close();
  }
}
async function openLocal(options) {
  session.destroy();
  personalMedia?.stop();
  sandbox = true;
  connected = false;
  terminal = false;
  pendingRoom = null;
  roomLookupError = '';
  streams.clear();
  session = createSpatialSession(sessionOptions);
  const rawId = options?.existingId
    ? options.existingId.slice(appStorageKey('').length)
    : options
      ? `common.spatial.branch.${crypto.randomUUID()}`
      : 'common.spatial.personal';
  const id = options?.existingId || appStorageKey(rawId);
  try {
    localStorage.setItem(appStorageKey('common.spatial.current'), rawId);
  } catch {
    /* The store reports browser persistence separately. */
  }
  history.replaceState(null, '', spacePath());
  await openWorkspace(id, options || { seed: seedWorkspace() });
}
async function exportWorkspace() {
  flushDraft();
  // Export the current in-memory history even if device persistence has failed.
  void store.flush().catch(() => {});
  const workspaceAtStart = workspaceGeneration;
  const result = await performanceIndex.measure('archive-export', () =>
    writeReplayArchive(store.exportReplayData ? store.exportReplayData() : store.exportArchive()),
  );
  if (disposed || workspaceAtStart !== workspaceGeneration) return;
  download(result.bytes, 'application/octet-stream', `common-spatial-${Date.now()}.common`);
  toast('Replay archive downloaded with the room’s automatic history.');
}

async function branchFromHistory() {
  const seed = store.fork(selectedRevisionId);
  await openLocal({ seed });
  toast('A new local branch is ready. Its history will save automatically.');
}

function showPerformance() {
  modalCleanup = openPerformancePanel({
    monitor: performanceIndex,
    modal,
    closeModal,
    onDownload: snapshot => {
      const runtime = getRuntimeConfig();
      const report = createPerformanceReport(snapshot, {
        buildId: runtime.buildId,
        frontendBuildId: typeof __COMMON_BUILD_ID__ === 'string' ? __COMMON_BUILD_ID__ : 'development',
        experience: 'spatial-beta',
      });
      download(JSON.stringify(report, null, 2), 'application/json', `common-performance-${Date.now()}.json`);
    },
  });
}

// Measure response-header latency without recording URLs or replacing cancellation signals.
async function measuredSessionFetch(input, options) {
  const finish = performanceIndex.start('request');
  let failed = true;
  try {
    const response = await fetch(input, options);
    failed = !response.ok;
    return response;
  } finally {
    finish({ failed });
  }
}

async function action(name, payload) {
  if (disposed) return;
  try {
    switch (name) {
      case 'tool':
        if (editable() || ['select', 'hand'].includes(payload.tool)) board.setTool(payload.tool);
        break;
      case 'pose':
        if (editable()) store.updateBoard(payload.boardId, { pose: payload.pose });
        break;
      case 'image':
        pickImages();
        break;
      case 'share':
        await shareWindow();
        break;
      case 'theme':
        themeDialog();
        break;
      case 'create-room':
        roomForm();
        break;
      case 'retry': {
        const match = appRoute().match(/^\/room\/([A-Za-z0-9_-]{1,100})\/?$/);
        if (match) await lookupRoom(match[1]);
        break;
      }
      case 'join':
        if (pendingRoom && !session.auth && !terminal) roomForm(pendingRoom);
        break;
      case 'local':
        await openLocal();
        break;
      case 'invite':
        invite();
        break;
      case 'agents':
        agent?.open();
        break;
      case 'performance':
        showPerformance();
        break;
      case 'end':
        confirmEnd();
        break;
      case 'leave':
        session.leave();
        break;
      case 'import':
        importArchive();
        break;
      case 'workspaces':
        await deviceWorkspaces();
        break;
      case 'export':
        await exportWorkspace();
        break;
      case 'fork':
        await branchFromHistory();
        break;
      case 'exit':
        await destroy();
        location.href = appPath('/');
        break;
      case 'diagram':
        if (editable()) board.add('diagram');
        break;
      case 'fit':
        board.fit();
        break;
      case 'zoom-in':
        board.setZoom(board.zoom * 1.2);
        break;
      case 'zoom-out':
        board.setZoom(board.zoom / 1.2);
        break;
    }
  } catch (error) {
    toast(error.message || 'That change could not be completed.');
  }
}

function lifecycleState() {
  return Object.freeze({
    destroyed: disposed,
    visible: !disposed && visible && !document.hidden,
    connected: !disposed && connected,
    sharing: !disposed && !!activeMedia()?.localStream,
    recording:
      !disposed && ['starting', 'recording', 'stopping'].includes(agent?.getState().recording?.state),
    hasCapture:
      !disposed &&
      (!!activeMedia()?.localStream ||
        ['starting', 'recording', 'stopping'].includes(agent?.getState().recording?.state)),
  });
}
function publishState() {
  const next = lifecycleState();
  for (const listener of listeners)
    try {
      listener(next);
    } catch {}
}
function destroy() {
  if (destroyPromise) return destroyPromise;
  flushDraft();
  board?.finishTextEdit?.();
  disposed = true;
  workspaceGeneration++;
  selectionGeneration++;
  // Invalidate callbacks before releasing resources; repeated destroy calls await the same work.
  destroyPromise = (async () => {
    events.abort();
    cleanupPerformanceIndicator();
    cleanupPerformanceDebug();
    performanceIndex.destroy();
    clearTimeout(draftTimer);
    clearTimeout(toastTimer);
    clearInterval(syncTimer);
    cancelAnimationFrame(renderFrame);
    for (const controller of imageRequests) controller.abort();
    imageRequests.clear();
    cancelRuntimeConfigLoad();
    session?.destroy();
    personalMedia?.destroy();
    await agent?.destroy();
    await store?.flush().catch(() => {});
    store?.destroy();
    board?.destroy();
    renderedEntities.clear();
    localEntityChanges.clear();
    modalCleanup?.();
    modalController.destroy();
    cleanupViewport();
    appearanceUI.destroy();
    for (const url of downloadUrls) URL.revokeObjectURL(url);
    downloadUrls.clear();
    publishState();
    listeners.clear();
    view?.destroy();
  })();
  return destroyPromise;
}
Object.defineProperty(window, 'commonEmbedLifecycle', {
  value: Object.freeze({
    destroy,
    getState: lifecycleState,
    setVisible(value) {
      visible = !!value;
      performanceIndex.setVisible(visible);
      if (!visible && activeMedia()?.getCaptureState().requestPending) activeMedia().stop();
      syncWatching();
      publishState();
      return lifecycleState();
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A listener is required.');
      if (!disposed) listeners.add(listener);
      listener(lifecycleState());
      return () => listeners.delete(listener);
    },
  }),
  writable: false,
  configurable: false,
});
const cleanupViewport = installMobileViewport();
view = mountSpatialView(root, {
  onSelectBoard: selectBoard,
  onModeChange: value => {
    finishActiveSelection();
    mode = value;
    render();
  },
  onTimeChange: selectTime,
  onLive: returnLive,
  onAddBoard: addBoard,
  onAction: action,
});
view.render({ canEdit: false, saveState: 'loading', saveMessage: 'Opening your autosaved room…' });
view.element.querySelector('.beta-brand').href = spacePath();
const performanceMenuItem = document.createElement('button');
performanceMenuItem.type = 'button';
performanceMenuItem.dataset.betaAction = 'performance';
performanceMenuItem.textContent = 'Performance';
view.element.querySelector('.beta-agent-tools-host').before(performanceMenuItem);
cleanupPerformanceIndicator = bindPerformanceIndicator({
  monitor: performanceIndex,
  trigger: view.element.querySelector('.beta-room-trigger'),
  item: performanceMenuItem,
});
board = new Board({
  el: view.boardHost,
  performanceIndex,
  onChange: (entity, patch) => {
    // Board has already applied this edit optimistically. Reconcile even when
    // validation rejects it or the accepted document returns an unchanged result.
    localEntityChanges.add(entity.id);
    if (editable()) {
      try {
        store.setEntity(activeBoardId, entity, patch ? Object.keys(patch) : undefined);
      } catch (error) {
        toast(error.message);
        scheduleRender();
      }
    }
    scheduleRender();
  },
  onDelete: id => {
    localEntityChanges.add(id);
    try { if (editable()) store.deleteEntity(activeBoardId, id); }
    catch (error) { toast(error.message); }
    scheduleRender();
  },
  onLayerAction: (id, position) => {
    if (editable()) store.reorderEntity(activeBoardId, id, position);
  },
  onLockChange: (id, locked) => activeBoardModel?.patch(id, { locked }),
  onStatus: toast,
  onToolChange: scheduleRender,
  onViewChange: syncWatching,
  onSelect: syncWatching,
  onWatchScreen: id => {
    subscriptions.toggle(id);
    syncWatching();
  },
  onHistoryStart: label => {
    if (!label.includes('text')) store?.beginGroup?.(label);
  },
  onHistoryEnd: () => store?.endGroup?.(),
  canEdit: entity =>
    entity.type !== 'screen' || sandbox || entity.participantId === ownId() || session?.auth?.isAdmin,
});
const tools = [
  ['diagram', 'Diagram'],
  ['fit', 'Fit board'],
  ['zoom-out', '−'],
  ['zoom-in', '+'],
];
for (const [name, text] of tools) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = name === 'diagram' ? 'beta-palette-item' : 'beta-hud-button';
  button.dataset.betaAction = name;
  button.textContent = text;
  button.setAttribute('aria-label', name === 'zoom-in' ? 'Zoom in' : name === 'zoom-out' ? 'Zoom out' : text);
  (name === 'diagram'
    ? view.toolExtrasHost || view.toolbarHost
    : view.navigationHost || view.toolbarHost
  ).append(button);
}
personalMedia = new ScreenSharing({
  send: () => false,
  onStream: streamReceived,
  onStopped: stoppedSharing,
  onStatus: toast,
  onCaptureState: () => {
    scheduleRender();
    publishState();
  },
  fallbackIceConfig: () => getRuntimeConfig().rtc,
});
const sessionOptions = {
  fetchImpl: measuredSessionFetch,
  onAdmitted: async (auth, { isNew }) => {
    finishActiveSelection();
    personalMedia.stop();
    sandbox = false;
    pendingRoom = null;
    roomLookupError = '';
    terminal = false;
    connected = false;
    streams.clear();
    participants = [];
    const seed = isNew
      ? { ...(createSeed || seedWorkspace()), title: auth.room.name, appearance: auth.room.appearance }
      : { empty: true, boards: [] };
    createSeed = null;
    history.replaceState(null, '', spacePath(`/room/${auth.room.id}`));
    await openWorkspace(appStorageKey(`common.spatial.room.${auth.room.id}`), { seed });
  },
  onConnection: value => {
    connected = value === 'connected';
    if (!connected) agent?.revoke('disconnected');
    scheduleRender();
    publishState();
  },
  onParticipants: people => {
    participants = people;
    scheduleRender();
  },
  onRoom: () => scheduleRender(),
  onAppearance: appearance => {
    if (store && !sandbox && session.auth?.isAdmin) store.updateRoom({ appearance });
  },
  onData: (id, bytes) => {
    try {
      store?.receive(bytes, id, reply => session.sendData(id, reply));
    } catch (error) {
      toast(error.message);
    }
  },
  onPeerOpen: id => {
    if (store) session.sendData(id, store.encodeSync());
    scheduleRender();
  },
  onPeerClose: () => scheduleRender(),
  onStream: streamReceived,
  onStopped: stoppedSharing,
  onCaptureState: () => {
    scheduleRender();
    publishState();
  },
  onStatus: toast,
  onEnded: reason => {
    terminal = true;
    connected = false;
    agent?.revoke('session-ended');
    streams.clear();
    for (const id of board.streams.keys()) board.setStream(id, null);
    render();
    modal(
      `<h2 id="modal-title">Session ended</h2><p>${esc(reason)} Your automatically saved history remains on this device.</p><button class="primary modal-submit" id="beta-back-local">Back to your local room</button>`,
    );
    $('#beta-back-local').onclick = async () => {
      closeModal();
      await openLocal();
    };
  },
};
session = createSpatialSession(sessionOptions);
agent = installSpatialAgent({
  getBoard: () => (disposed ? null : board),
  getModel: () => (disposed ? null : activeBoardModel),
  getSession: () => `${workspaceGeneration}:${activeBoardId}:${selectedRevisionId || 'live'}`,
  getContext: () => ({
    sandbox,
    connected,
    room: sandbox ? null : session.auth?.room,
    participantId: ownId(),
    participants,
  }),
  getWindowStream: () => activeMedia()?.localStream,
  onStatus: toast,
  onChange: publishState,
  buttonParent: view.agentToolsHost || view.element.querySelector('.beta-header'),
  onRequestWindowShare: shareWindow,
  getSharingState: () => activeMedia()?.getCaptureState() || {},
  signal: events.signal,
});
view.boardHost.addEventListener(
  'input',
  event => {
    if (event.target.closest('[contenteditable="true"]')) {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(flushDraft, 300);
    }
  },
  { signal: events.signal },
);
view.boardHost.addEventListener('compositionend', () => {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 300);
}, { signal: events.signal });
view.boardHost.addEventListener(
  'dragover',
  event => {
    if (event.dataTransfer.types.includes('Files') && editable()) event.preventDefault();
  },
  { signal: events.signal },
);
view.boardHost.addEventListener(
  'drop',
  event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    addImages([...event.dataTransfer.files], board.worldPoint(event));
  },
  { signal: events.signal },
);
document.addEventListener(
  'paste',
  event => {
    if (event.target.closest('input,textarea,[contenteditable="true"]')) return;
    const images = clipboardImages(event.clipboardData);
    if (images.length) {
      event.preventDefault();
      addImages(images);
    }
  },
  { signal: events.signal },
);
document.addEventListener(
  'visibilitychange',
  () => {
    if (document.hidden) {
      flushDraft();
      store?.endGroup?.();
      void store?.flush().catch(() => {});
    }
    syncWatching();
    publishState();
  },
  { signal: events.signal },
);
window.addEventListener(
  'pagehide',
  () => {
    flushDraft();
    store?.endGroup?.();
    void store?.flush().catch(() => {});
  },
  { signal: events.signal },
);
const syncTimer = setInterval(() => {
  if (!store || sandbox || !connected) return;
  try {
    const packet = store.encodeSync();
    for (const id of session.peerIds) session.sendData(id, packet);
  } catch (error) {
    toast(error.message);
  }
}, 5000);

async function lookupRoom(id) {
  const targetSession = session;
  const current = () => !disposed && session === targetSession && !sandbox;
  roomLookupError = '';
  scheduleRender();
  try {
    const room = await targetSession.lookup(id);
    if (!current()) return;
    if (!isSpatialRoom(room)) {
      location.replace(appPath(`/room/${id}`));
      return;
    }
    pendingRoom = room;
    if (!(await targetSession.resume(id)) && current()) roomForm(room);
  } catch (error) {
    if (!current() || error.name === 'AbortError') return;
    terminal = error.status === 404;
    roomLookupError = terminal ? '' : error.message || 'The session server could not be reached.';
    toast(`${error.message} Any history autosaved on this device is still available here.`);
    render();
  }
}

async function start() {
  void loadRuntimeConfig();
  let current = 'common.spatial.personal';
  try {
    const saved = localStorage.getItem(appStorageKey('common.spatial.current'));
    if (/^common\.spatial\.(?:personal|branch\.[a-z0-9-]{36})$/.test(saved || '')) current = saved;
  } catch {
    /* IndexedDB reports its own availability. */
  }
  const match = appRoute().match(/^\/room\/([A-Za-z0-9_-]{1,100})\/?$/);
  if (match) {
    sandbox = false;
    connected = false;
    await openWorkspace(appStorageKey(`common.spatial.room.${match[1]}`), {
      seed: { empty: true, boards: [] },
    });
    await lookupRoom(match[1]);
  } else await openWorkspace(appStorageKey(current), { seed: seedWorkspace() });
}
start().catch(error => {
  storageStatus = { state: 'error', message: error.message || 'This workspace could not open.' };
  view.render({
    saveState: 'error',
    saveMessage: storageStatus.message,
    notice: 'Reload to retry. Your existing autosave has not been replaced.',
    canEdit: false,
  });
  toast(storageStatus.message);
});
