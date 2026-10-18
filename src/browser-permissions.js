/** Display capture is a one-time browser choice, never a remembered permission.
 * These checks do not query, request, or assume a persistent capture grant.
 */
export function displayCaptureSupport({
  secureContext = globalThis.isSecureContext,
  mediaDevices = globalThis.navigator?.mediaDevices,
  document = globalThis.document,
} = {}) {
  if (secureContext === false) return Object.freeze({
    available: false, code: 'insecure-context', title: 'A secure address is needed',
    detail: 'Open Common over HTTPS or localhost to share a window.',
    help: ['For another laptop on your network, use the local HTTPS setup. A plain HTTP network address cannot request screen capture.'],
  });
  const policy = document?.permissionsPolicy || document?.featurePolicy;
  let captureAllowed = true;
  try {
    // Some implementations expose a policy object without recognizing display
    // capture. An unknown feature is not evidence that a parent denied it.
    const knownFeatures=typeof policy?.features==='function'?policy.features():null;
    if (typeof policy?.allowsFeature === 'function' && (!knownFeatures || knownFeatures.includes('display-capture'))) {
      captureAllowed = policy.allowsFeature('display-capture');
    }
  }
  catch { /* Older browsers may not recognize this feature name. Let the picker decide. */ }
  if (!captureAllowed) return Object.freeze({
    available: false, code: 'permissions-policy', title: 'This page cannot request a window',
    detail: 'The app containing Common has blocked screen capture. You can still use the canvas.',
    help: ['The app owner must allow display-capture in its Permissions-Policy and on the Common iframe.', 'Opening Common in its own tab can help when the restriction comes from an outer frame.'],
  });
  if (typeof mediaDevices?.getDisplayMedia !== 'function') return Object.freeze({
    available: false, code: 'unavailable', title: 'Window sharing is unavailable here',
    detail: 'Try a current desktop browser. This browser can still join and edit the canvas.',
    help: ['Screen capture is not available in every browser, mobile browser, or in-app browser. Open the link in a full desktop browser to share a window.'],
  });
  return Object.freeze({ available: true, code: 'available', title: '', detail: '', help: [] });
}

export function displayCaptureFailure(error, support = displayCaptureSupport()) {
  if (!support.available) return { phase: 'blocked', code:support.code, title:support.title, detail:support.detail, help:support.help };
  const name = typeof error?.name === 'string' ? error.name : 'CaptureError';
  const commonHelp = [
    'Try one window or browser tab first. Keep the source open and return here to choose again.',
    'If access stays blocked, check this browser’s site controls and your system’s screen recording permission. On macOS: System Settings → Privacy & Security → Screen & System Audio Recording (or Screen Recording). Reopen the browser if your system asks.',
  ];
  switch (name) {
    case 'NotAllowedError':
      // Browsers use the same error for a dismissed picker and denied access.
      return { phase: 'dismissed', code: name, title: 'Nothing shared',
        detail: 'The picker was closed, or access wasn’t allowed. Choose again whenever you’re ready.', help: commonHelp };
    case 'NotReadableError':
      return { phase: 'error', code: name, title: 'That window could not be read',
        detail: 'Keep the window open and your screen unlocked, then try again. Your system may need to allow screen recording for this browser.', help: commonHelp };
    case 'InvalidStateError':
      return { phase: 'error', code: name, title: 'Choose from an active browser tab',
        detail: 'Return to this tab and click Share a window. Your browser needs a fresh click in the active page.',
        help: ['A background tab or an agent command cannot open the browser picker on its own. Use the visible share button.'] };
    case 'NotFoundError':
      return { phase: 'error', code: name, title: 'No shareable window was found',
        detail: 'Open the window you want to share, then choose again.', help: commonHelp };
    case 'AbortError':
      return { phase: 'error', code: name, title: 'The browser stopped this request',
        detail: 'Nothing was shared. You can choose a window again.', help: commonHelp };
    case 'SecurityError':
      return { phase: 'error', code: name, title: 'Capture is disabled in this browser',
        detail: 'Check the browser or organization’s screen capture settings, or open Common in another desktop browser.', help: commonHelp };
    case 'TypeError':
    case 'OverconstrainedError':
      return { phase: 'error', code: name, title: 'The browser could not start capture',
        detail: 'Try another window or update your browser, then choose again.', help: commonHelp };
    default:
      return { phase: 'error', code: name, title: 'This window could not be shared',
        detail: 'Nothing was shared. Choose again, or check browser and system screen recording access.', help: commonHelp };
  }
}

/** Only the surface type is exposed. Window/document titles stay private. */
export function displayCaptureSource(track) {
  let surface;
  try { surface = track?.getSettings?.().displaySurface; } catch { /* Optional browser metadata. */ }
  return Object.freeze({
    kind: ['browser', 'window', 'monitor'].includes(surface) ? surface : 'unknown',
    label: surface === 'browser' ? 'Browser tab' : surface === 'window' ? 'Window' : surface === 'monitor' ? 'Entire screen' : 'Chosen source',
  });
}
