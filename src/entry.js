import { appPath, appRoute } from './app-path.js';

// The beta is an explicit entry point. Room metadata also routes invitations
// before either incompatible document engine has been initialized.
async function start() {
  const url = new URL(location.href);
  let spatial = url.searchParams.get('beta') === 'space';
  const room = appRoute().match(/^\/room\/([A-Za-z0-9_-]{1,100})\/?$/);
  if (room) {
    try {
      const response = await fetch(appPath(`/api/rooms/${room[1]}`), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const value = await response.json();
        spatial = value.room?.experience === 'spatial-beta';
        if (spatial) url.searchParams.set('beta', 'space');
        else url.searchParams.delete('beta');
        history.replaceState(null, '', url);
      }
    } catch { /* Each experience handles a failed room lookup with its own UI. */ }
  }
  if (spatial) await import('./beta/main.js');
  else await import('./main.js');
}

start().catch(() => {
  const root = document.querySelector('#app');
  root.replaceChildren();
  const panel = document.createElement('div');
  panel.style.cssText = 'margin:auto;max-width:32rem;padding:2rem;font:16px/1.6 system-ui';
  const message = document.createElement('p');
  message.textContent = 'Common could not open. Check your connection and reload. Space & time beta also needs a browser with WebAssembly enabled.';
  const retry = document.createElement('button'); retry.textContent = 'Reload Common'; retry.onclick = () => location.reload();
  const home = document.createElement('a'); home.href = appPath('/'); home.textContent = ' Open the standard canvas';
  panel.append(message, retry, home); root.append(panel);
});
