import './agent-tools.css';
import { appPath } from './app-path.js';
import { AGENT_CAPABILITIES } from './agent-api.js';

const MAX_IMAGE_BYTES = Math.floor(1.3 * 1024 * 1024);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const EXAMPLES = {
  text: {
    action: 'canvas.add',
    entity: { id: 'agent-intro', type: 'text', text: 'Product walkthrough', x: 120, y: 100, width: 440, height: 100, fontSize: 28, color: '#305e48' },
  },
  annotation: {
    action: 'canvas.add',
    entity: { type: 'rectangle', x: 120, y: 220, width: 320, height: 180, color: '#e3a444', fill: 'transparent', text: 'Key feature' },
  },
  walkthrough: {
    action: 'walkthrough.load',
    steps: [{ title: 'Start here', text: 'Explain this part of the product.', targetId: 'agent-intro' }],
  },
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className = 'agent-button') {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

function formatDuration(ms = 0) {
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatSize(bytes = 0) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Keep binary payloads out of the visible log; the underlying API result is unchanged. */
function displayResult(value) {
  const seen = new WeakSet();
  let output;
  try {
    output = JSON.stringify(value, (key, item) => {
      if (typeof item === 'string' && (key === 'dataUrl' || key === 'data' || /^data:/i.test(item))) {
        return `[${item.length.toLocaleString()} characters; image or recording data omitted from this view]`;
      }
      if (typeof item === 'string' && item.length > 12000) return `${item.slice(0, 12000)}… [text shortened]`;
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[already shown]';
        seen.add(item);
        if (ArrayBuffer.isView(item)) return `[${item.byteLength.toLocaleString()} bytes]`;
        if (item instanceof ArrayBuffer) return `[${item.byteLength.toLocaleString()} bytes]`;
        if (typeof Blob !== 'undefined' && item instanceof Blob) return { type: item.type, size: item.size };
      }
      return item;
    }, 2);
  } catch {
    output = 'This result could not be displayed.';
  }
  output ??= 'Done.';
  return output.length > 25000 ? `${output.slice(0, 24950)}\n… [result shortened for display]` : output;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('This image could not be opened.'));
    reader.onabort = () => reject(new Error('Opening the image was cancelled.'));
    reader.readAsDataURL(file);
  });
}

/** Browser-agent controls. Enabling mutations is deliberately a visible, per-tab choice. */
export function installAgentTools({
  api,
  capture,
  walkthrough,
  permissions,
  getEnabled = () => false,
  onEnabledChange = () => {},
  onRequestWindowShare = () => {},
  onStatus = () => {},
  buttonParent,
}) {
  let destroyed = false;
  let commandBusy = false;
  let captureBusy = false;
  let recordingFingerprint = '';
  let opener = null;
  let permissionFingerprint = '';

  const trigger = button('Agent tools', 'button agent-tools-trigger');
  trigger.setAttribute('aria-label', 'Agent tools');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'agent-tools-panel');
  buttonParent?.append(trigger);

  const panel = element('section', 'agent-tools-panel');
  panel.id = 'agent-tools-panel';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'agent-tools-heading');
  const header = element('header', 'agent-tools-header');
  const headingGroup = element('div');
  headingGroup.append(element('span', 'agent-eyebrow', 'CREATE TOGETHER'));
  const heading = element('h2', '', 'Agent tools');
  heading.id = 'agent-tools-heading';
  headingGroup.append(heading);
  const closeButton = button('×', 'agent-close');
  closeButton.setAttribute('aria-label', 'Close agent tools');
  header.append(headingGroup, closeButton);
  panel.append(header);

  const scroll = element('div', 'agent-tools-content');
  const intro = element('p', 'agent-copy', 'Let your agent write, draw, and guide a product walkthrough on this canvas.');
  const consent = element('label', 'agent-enable-row');
  const enable = element('input');
  enable.type = 'checkbox';
  enable.id = 'agent-enable';
  enable.setAttribute('aria-label', 'Enable agent control');
  const consentCopy = element('span');
  consentCopy.append(element('strong', '', 'Enable agent control'), element('small', '', 'Choose what your agent can do and when access ends.'));
  consent.append(enable, consentCopy);
  const permissionStatus = element('p', 'agent-permission-status');
  permissionStatus.setAttribute('aria-live', 'polite');
  const instructions = element('a', 'agent-instructions', 'Agent instructions ↗');
  instructions.href = appPath('/agents.md');
  instructions.target = '_blank';
  instructions.rel = 'noopener';
  scroll.append(intro, consent, permissionStatus, instructions);

  const grantsSection = element('fieldset', 'agent-grants');
  grantsSection.append(element('legend', '', 'Agent permissions'));
  const grantInputs = new Map();
  for (const [capability, detail] of Object.entries(AGENT_CAPABILITIES)) {
    const row = element('label', 'agent-grant-row'); const input = element('input');
    input.type = 'checkbox'; input.id = `agent-grant-${capability}`;
    input.checked = ['inspect', 'canvas-write'].includes(capability);
    input.setAttribute('aria-label', detail.title);
    const text = element('span'); text.append(element('strong', '', detail.title), element('small', '', detail.description));
    row.append(input, text); grantsSection.append(row); grantInputs.set(capability, input);
    input.addEventListener('change', () => {
      if (capability !== 'inspect' && input.checked) grantInputs.get('inspect').checked = true;
      if (capability === 'inspect' && !input.checked) for (const [key, control] of grantInputs) if (key !== 'inspect') control.checked = false;
    });
  }
  const durationLabel = element('label', 'agent-field-label', 'Access duration'); durationLabel.htmlFor = 'agent-grant-duration';
  const duration = element('select', 'agent-source-select'); duration.id = 'agent-grant-duration';
  for (const minutes of [15, 30, 60]) { const option = element('option', '', `${minutes} minutes`); option.value = String(minutes * 60_000); duration.append(option); }
  const grantActions = element('div', 'agent-actions');
  const applyGrant = button('Apply permissions', 'agent-button agent-primary'); applyGrant.id = 'agent-grant-apply';
  const revokeGrant = button('Revoke access'); revokeGrant.id = 'agent-grant-revoke';
  grantActions.append(applyGrant, revokeGrant);
  grantsSection.append(durationLabel, duration, grantActions, element('p', 'agent-small', 'Reading is included with other permissions. Access ends when this canvas session changes.'));
  grantsSection.hidden = !permissions; scroll.append(grantsSection);

  const commandSection = element('section', 'agent-section');
  commandSection.setAttribute('aria-labelledby', 'agent-command-heading');
  const commandHeading = element('h3', '', 'Canvas commands');
  commandHeading.id = 'agent-command-heading';
  const exampleRow = element('div', 'agent-example-row');
  const exampleLabel = element('label', '', 'Example');
  exampleLabel.htmlFor = 'agent-example';
  const examples = element('select');
  examples.id = 'agent-example';
  for (const [value, title] of [['text', 'Add text'], ['annotation', 'Add an annotation'], ['walkthrough', 'Start a walkthrough']]) {
    const option = element('option', '', title);
    option.value = value;
    examples.append(option);
  }
  const loadExample = button('Use example', 'agent-text-button');
  exampleRow.append(exampleLabel, examples, loadExample);
  const commandLabel = element('label', 'agent-field-label', 'Agent command');
  commandLabel.htmlFor = 'agent-command';
  const command = element('textarea', 'agent-command');
  command.id = 'agent-command';
  command.rows = 8;
  command.spellcheck = false;
  command.autocomplete = 'off';
  command.setAttribute('autocapitalize', 'off');
  command.value = JSON.stringify(EXAMPLES.text, null, 2);
  const commandActions = element('div', 'agent-actions');
  const run = button('Run command', 'agent-button agent-primary');
  run.id = 'agent-run';
  const inspect = button('Inspect canvas');
  inspect.id = 'agent-inspect';
  commandActions.append(run, inspect);
  const resultLabel = element('h4', 'agent-result-label', 'Result');
  resultLabel.id = 'agent-result-heading';
  const result = element('pre', 'agent-result', 'Inspect the canvas or run a command to see its result.');
  result.id = 'agent-result';
  result.setAttribute('aria-live', 'polite');
  result.setAttribute('aria-atomic', 'true');
  result.setAttribute('aria-labelledby', 'agent-result-heading');
  result.tabIndex = 0;
  commandSection.append(commandHeading, exampleRow, commandLabel, command, commandActions, resultLabel, result);
  scroll.append(commandSection);

  const imageSection = element('section', 'agent-section');
  imageSection.append(element('h3', '', 'Generated images'), element('p', 'agent-copy', 'Ask your agent to generate an image with its image tools, then add the finished image here.'));
  const imageLabel = element('label', 'agent-field-label', 'Add generated image');
  imageLabel.htmlFor = 'agent-image-file';
  const imageFile = element('input', 'agent-file-input');
  imageFile.type = 'file';
  imageFile.id = 'agent-image-file';
  imageFile.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
  const imageHelp = element('p', 'agent-small', 'PNG, JPG, WebP, GIF, or AVIF · up to 1.3 MB');
  imageHelp.id = 'agent-image-help';
  imageFile.setAttribute('aria-describedby', imageHelp.id);
  imageSection.append(imageLabel, imageFile, imageHelp);
  scroll.append(imageSection);

  const captureSection = element('section', 'agent-section');
  captureSection.append(element('h3', '', 'Capture your walkthrough'));
  const sourceLabel = element('label', 'agent-field-label', 'Recording source');
  sourceLabel.htmlFor = 'agent-record-source';
  const source = element('select', 'agent-source-select');
  source.id = 'agent-record-source';
  for (const [value, title] of [['canvas', 'Canvas + annotations'], ['window', 'Shared window only']]) {
    const option = element('option', '', title);
    option.value = value;
    source.append(option);
  }
  const windowHelp = element('div', 'agent-window-help');
  windowHelp.hidden = true;
  windowHelp.append(element('p', 'agent-small', 'Record only the window you choose to share. Canvas annotations are included when you select Canvas + annotations.'));
  const shareWindow = button('Share a window first', 'agent-text-button');
  shareWindow.id = 'agent-share-window';
  windowHelp.append(shareWindow);
  const captureActions = element('div', 'agent-actions');
  const start = button('Start recording', 'agent-button agent-primary');
  start.id = 'agent-record-start';
  const stop = button('Stop recording', 'agent-button agent-stop');
  stop.id = 'agent-record-stop';
  stop.hidden = true;
  captureActions.append(start, stop);
  const captureStatus = element('p', 'agent-capture-status', 'Ready to record.');
  captureStatus.setAttribute('role', 'status');
  const captureTime = element('p', 'agent-capture-time');
  captureTime.hidden = true;
  const snapshot = button('Download canvas PNG');
  snapshot.id = 'agent-snapshot';
  const captureHelp = element('p', 'agent-small', 'Record up to 5 minutes and keep up to 3 clips in this tab. Download clips before closing the tab. Canvas recording includes visible canvas objects and live screens.');
  const recordingsHeading = element('h4', 'agent-result-label', 'Recordings');
  const recordings = element('div', 'agent-recordings');
  recordings.id = 'agent-recordings';
  recordings.setAttribute('aria-label', 'Saved recordings');
  captureSection.append(sourceLabel, source, windowHelp, captureActions, captureStatus, captureTime, snapshot, captureHelp, recordingsHeading, recordings);
  scroll.append(captureSection);
  panel.append(scroll);
  document.body.append(panel);

  const live = element('aside', 'agent-recording-live');
  live.hidden = true;
  live.setAttribute('aria-label', 'Recording in progress');
  const liveDot = element('span', 'agent-recording-dot');
  liveDot.setAttribute('aria-hidden', 'true');
  const liveText = button('', 'agent-recording-open');
  liveText.setAttribute('aria-label', 'Open recording controls');
  const liveStop = button('Stop recording', 'agent-recording-stop');
  live.append(liveDot, liveText, liveStop);
  document.body.append(live);

  const tour = element('section', 'agent-walkthrough');
  tour.hidden = true;
  tour.setAttribute('aria-label', 'Product walkthrough');
  const tourCopy = element('div', 'agent-walkthrough-copy');
  const tourCount = element('span', 'agent-eyebrow');
  const tourTitle = element('h2');
  const tourText = element('p');
  tourCopy.append(tourCount, tourTitle, tourText);
  const tourControls = element('div', 'agent-walkthrough-controls');
  const previous = button('Previous');
  const next = button('Next', 'agent-button agent-primary');
  const endTour = button('Stop walkthrough', 'agent-text-button');
  previous.id = 'agent-walkthrough-previous';
  next.id = 'agent-walkthrough-next';
  endTour.id = 'agent-walkthrough-stop';
  tourControls.append(previous, next, endTour);
  tour.append(tourCopy, tourControls);
  document.body.append(tour);

  function showResult(value) {
    if (destroyed) return;
    result.textContent = displayResult(value);
  }

  function showError(error) {
    const message = error?.message || String(error || 'Something went wrong.');
    showResult({ error: message });
    onStatus(message);
  }

  function open() {
    if (destroyed) return;
    opener = document.activeElement;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    refresh();
    closeButton.focus();
  }

  function close() {
    if (destroyed) return;
    const restoreFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) (opener?.isConnected ? opener : trigger).focus();
  }

  async function executeCommand(value) {
    if (commandBusy || destroyed) return;
    commandBusy = true;
    refresh();
    try { showResult(await (Array.isArray(value) ? api.batch(value) : api.execute(value))); }
    catch (error) { showError(error); }
    finally { commandBusy = false; refresh(); }
  }

  async function captureAction(action) {
    if (captureBusy || destroyed) return;
    captureBusy = true;
    refresh();
    try { showResult(await action()); }
    catch (error) { showError(error); }
    finally { captureBusy = false; refresh(); }
  }

  function refreshRecordings() {
    const items = capture?.list?.() || [];
    const fingerprint = JSON.stringify([items, permissions?.state?.().revision]);
    if (fingerprint === recordingFingerprint) return;
    recordingFingerprint = fingerprint;
    recordings.replaceChildren();
    if (!items.length) {
      recordings.append(element('p', 'agent-small', 'Your recordings will appear here. Download anything you want to keep before closing this tab.'));
      return;
    }
    for (const item of items.slice(-3).reverse()) {
      const row = element('article', 'agent-recording-item');
      const details = element('div');
      const createdAt = item.createdAt ? new Date(item.createdAt) : null;
      const createdTime = createdAt && Number.isFinite(createdAt.getTime())
        ? createdAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
        : null;
      const title = item.name || `${item.source === 'window' ? 'Window' : 'Canvas'} recording${createdTime ? ` · ${createdTime}` : ''}`;
      details.append(element('strong', '', title));
      const descriptor = `${formatDuration(item.durationMs ?? item.elapsedMs)} · ${formatSize(item.size ?? item.bytes)}`;
      details.append(element('small', '', descriptor));
      const actions = element('div', 'agent-recording-item-actions');
      const download = button('Download', 'agent-text-button');
      download.setAttribute('aria-label', `Download ${title}`);
      download.addEventListener('click', () => captureAction(() => capture.download(item.id)));
      const discard = button('Discard', 'agent-text-button agent-discard');
      discard.setAttribute('aria-label', `Discard ${title}`);
      discard.addEventListener('click', () => captureAction(() => capture.discard(item.id)));
      actions.append(download, discard);
      row.append(details, actions);
      recordings.append(row);
    }
  }

  function refresh() {
    if (destroyed) return;
    const grant = permissions?.state?.();
    const enabled = Boolean(getEnabled()) && (!permissions || !!grant?.active);
    const has = capability => enabled && (!permissions || grant.capabilities.includes(capability));
    enable.checked = enabled;
    permissionStatus.textContent = enabled ? `Agent access ends at ${new Date(grant?.expiresAt || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
      : grant?.reason === 'expired' ? 'Agent access expired. Choose permissions to allow access again.' : 'Agent control is off. Inspect shows connection status until you grant access.';
    const nextPermissionFingerprint = JSON.stringify([grant?.revision, grant?.active]);
    if (nextPermissionFingerprint !== permissionFingerprint) {
      permissionFingerprint = nextPermissionFingerprint;
      if (grant?.active) for (const [capability, input] of grantInputs) input.checked = grant.capabilities.includes(capability);
    }
    revokeGrant.disabled = !grant?.active;
    permissionStatus.classList.toggle('is-enabled', enabled);
    trigger.classList.toggle('is-enabled', enabled);
    run.disabled = !enabled || commandBusy;
    imageFile.disabled = !has('canvas-write') || commandBusy;
    inspect.disabled = commandBusy;
    run.textContent = commandBusy ? 'Running…' : 'Run command';
    const state = capture?.status?.() || { state: 'idle', elapsedMs: 0 };
    const isRecording = state.state === 'recording' || state.state === 'stopping';
    const captureWorking = captureBusy || state.state === 'starting' || state.state === 'stopping';
    source.disabled = captureWorking || isRecording;
    start.hidden = isRecording;
    start.disabled = captureWorking || !capture || (source.value === 'window' && !state.windowShared);
    stop.hidden = !isRecording;
    stop.disabled = captureWorking;
    snapshot.disabled = captureBusy || !capture;
    shareWindow.disabled = captureWorking || isRecording;
    shareWindow.hidden = Boolean(state.windowShared);
    windowHelp.hidden = source.value !== 'window';
    const recordingSource = state.source === 'window' ? 'Shared window' : 'Canvas';
    captureStatus.textContent = isRecording ? `Recording ${recordingSource.toLowerCase()}.` : captureWorking ? 'Preparing capture…' : 'Ready to record.';
    captureStatus.classList.toggle('is-recording', isRecording);
    captureTime.hidden = !isRecording;
    captureTime.textContent = `${formatDuration(state.elapsedMs)} elapsed`;
    live.hidden = !isRecording;
    liveText.textContent = `${recordingSource} recording · ${formatDuration(state.elapsedMs)}`;
    liveStop.disabled = captureWorking;
    refreshRecordings();
    const presentation = walkthrough?.state?.() || { active: false };
    tour.classList.toggle('is-recording', isRecording);
    tour.hidden = !presentation.active;
    if (presentation.active) {
      tourCount.textContent = `STEP ${presentation.index + 1} OF ${presentation.total}`;
      tourTitle.textContent = presentation.current?.title || 'Product walkthrough';
      tourText.textContent = presentation.current?.text || '';
      tourText.hidden = !presentation.current?.text;
      previous.disabled = presentation.index <= 0;
      next.disabled = presentation.index >= presentation.total - 1;
    }
  }

  trigger.addEventListener('click', () => panel.hidden ? open() : close());
  closeButton.addEventListener('click', close);
  liveText.addEventListener('click', open);
  enable.addEventListener('change', () => {
    try {
      onEnabledChange(enable.checked);
      if (enable.checked) permissions?.grant({ capabilities: [...grantInputs].filter(([, input]) => input.checked).map(([capability]) => capability), ttlMs: Number(duration.value) });
      else permissions?.revoke('disabled');
    }
    catch (error) { showError(error); }
    refresh();
  });
  applyGrant.addEventListener('click', () => {
    try { onEnabledChange(true); permissions?.grant({ capabilities: [...grantInputs].filter(([, input]) => input.checked).map(([capability]) => capability), ttlMs: Number(duration.value) }); }
    catch (error) { showError(error); }
    refresh();
  });
  revokeGrant.addEventListener('click', () => { permissions?.revoke('revoked'); onEnabledChange(false); refresh(); });
  loadExample.addEventListener('click', () => {
    command.value = JSON.stringify(EXAMPLES[examples.value], null, 2);
    command.focus();
  });
  run.addEventListener('click', () => {
    if (!getEnabled()) return;
    try { void executeCommand(JSON.parse(command.value)); }
    catch (error) { showError(new Error(`Enter a valid JSON command. ${error.message}`)); }
  });
  command.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      run.click();
    }
  });
  inspect.addEventListener('click', async () => {
    if (commandBusy) return;
    commandBusy = true;
    refresh();
    try { showResult(await api.state()); }
    catch (error) { showError(error); }
    finally { commandBusy = false; refresh(); }
  });
  imageFile.addEventListener('change', async () => {
    const file = imageFile.files?.[0];
    imageFile.value = '';
    if (!file || !getEnabled()) return;
    if (!IMAGE_TYPES.has(file.type)) return showError(new Error('Choose a PNG, JPG, WebP, GIF, or AVIF image.'));
    if (file.size > MAX_IMAGE_BYTES) return showError(new Error('Choose an image smaller than 1.3 MB.'));
    try {
      const initial = api.state();
      const scope = JSON.stringify([Boolean(initial.sandbox), initial.room?.id ?? null, initial.participantId ?? null]);
      const dataUrl = await readFile(file);
      if (destroyed) return;
      const current = api.state();
      const currentScope = JSON.stringify([Boolean(current.sandbox), current.room?.id ?? null, current.participantId ?? null]);
      if (!getEnabled() || !current.enabled || !current.ready || scope !== currentScope) {
        throw new Error('The canvas session changed. Choose the image again.');
      }
      await executeCommand({ action: 'image.add', dataUrl, title: file.name });
    } catch (error) { showError(error); }
  });
  source.addEventListener('change', refresh);
  shareWindow.addEventListener('click', () => {
    try {
      // This direct click keeps the browser's native screen-sharing permission flow intact.
      const pending = onRequestWindowShare();
      Promise.resolve(pending).catch(showError);
    } catch (error) { showError(error); }
  });
  // These direct buttons are human controls. Agent-triggered capture continues
  // through the scoped API, while people can record without granting an agent.
  start.addEventListener('click', () => captureAction(() => capture.start({ source: source.value })));
  stop.addEventListener('click', () => captureAction(() => capture.stop()));
  liveStop.addEventListener('click', () => captureAction(() => capture.stop()));
  snapshot.addEventListener('click', () => captureAction(() => capture.snapshot({ download: true })));
  previous.addEventListener('click', () => { walkthrough.previous(); refresh(); });
  next.addEventListener('click', () => { walkthrough.next(); refresh(); });
  endTour.addEventListener('click', () => { walkthrough.stop(); refresh(); });
  const keyHandler = (event) => {
    if (event.key === 'Escape' && !panel.hidden && panel.contains(document.activeElement)) {
      event.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', keyHandler);
  const timer = setInterval(() => {
    if (capture?.status?.().state === 'recording' || permissions?.state?.().active) refresh();
  }, 1000);
  const unsubscribePermissions = permissions?.subscribe?.(() => refresh());
  refresh();
  return {
    open,
    close,
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer);
      unsubscribePermissions?.();
      document.removeEventListener('keydown', keyHandler);
      trigger.remove();
      panel.remove();
      live.remove();
      tour.remove();
    },
  };
}
