# Embed Common in a Bun application

Add Common to an existing Bun application as an inline canvas or a floating workspace. Your application keeps its HTTP listener, routes, WebSocket server, and authentication. Common serves its assets and room service beneath one path, using that same server.

The portable module is included in the [v1.9.0 release](https://github.com/alexwelcing/common-workspace/releases/tag/v1.9.0). You can also [run Common as a standalone app](https://github.com/alexwelcing/common-workspace/blob/main/docs/hosting.md#run-on-your-own-laptop). Source and release links in this guide require access to the private repository.

## Obtain the package

Download `common-workspace-0.9.0.tgz` and its SHA-256 checksum from the [release assets](https://github.com/alexwelcing/common-workspace/releases/tag/v1.9.0), or obtain both from your administrator. Install that file in your Bun application:

```sh
bun add /absolute/path/common-workspace-0.9.0.tgz
```

You do not need an npm account, GitHub registry login, Cloudflare account, or Netlify account to install a tarball you already have. The source repository is private: obtaining its source still requires repository read access or an archive supplied by an administrator.

## Run the included example

The package includes a complete host application. After installing, run it from your Bun project:

```sh
bun node_modules/common-workspace/example/server.mjs
```

Open `http://127.0.0.1:3100` to try inline and floating canvases beside the host's own routes and WebSocket. Use `PORT=3101` if that port is occupied. You can copy `node_modules/common-workspace/example/` into your own project without a separate source checkout.

The optional `DEMO_AUTH=1` cookie toggle demonstrates how host authentication fits in. Replace it with your application's real authentication before using that integration in production.

### Build the package from source

If you have an authorized source checkout, use Bun 1.4.3 to create the archive yourself:

```sh
bun install --frozen-lockfile
bun run pack:module
```

This writes `artifacts/common-workspace-0.9.0.tgz`. `bun run build:module` creates the unpacked `module-dist/` directory instead. Install the archive in your host application using the command above.

The package contains the server module, browser mounting module, types, and built Common frontend, including its fonts, diagrams, canvas libraries, and WebAssembly. It has no runtime npm dependencies. Installing the repository through a Git URL is not a substitute for this package build.

Before distributing a changed package, increment the version in `module/package.json` and update the example install filename. Package managers may reuse an archive previously installed at the same path and version.

## Choose how Common appears

- **Inline:** place the canvas beside your product's existing controls.
- **Overlay:** give people a floating workspace they can open while using the rest of your tool.

Both modes load the same isolated Common interface in a same-origin iframe. Your host does not need React, another UI framework, or Common's internal canvas classes.

The default mount path is `/__common/`. Use the same path in the server and browser configuration. A different prefix lets Common coexist with your own `/api`, `/ws`, and page routes. Keep one Common service instance per intended room store; creating a new instance on every request would create a new in-memory service on every request.

## Attach to your Bun server

Create the service once, then compose it with your existing handlers:

```js
import { createCommon } from 'common-workspace/bun';

const common = await createCommon({ basePath: '/__common/' });

const server = Bun.serve({
  port: 3000,
  fetch: common.wrapFetch((request, server) => {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('Host is running');
    // Your other HTTP routes and WebSocket upgrades go here.
    return new Response('Not found', { status: 404 });
  }),
  websocket: common.wrapWebSocket({
    message(socket, message) {
      // Handles your application's sockets, not Common's sockets.
      socket.send(message);
    },
  }),
});

// During your host application's shutdown:
// await common.close();
// server.stop();
```

`wrapFetch` tries Common's prefix first and passes unmatched requests to your handler. `wrapWebSocket` dispatches Common-owned sockets to Common and your other sockets to the handlers you supply. Keep your own socket upgrade and authentication logic in the host handler. Your existing WebSocket options are retained; choose limits that also accommodate Common's messages when changing server-wide options.

The server options are:

| Option | Default | Purpose |
| --- | --- | --- |
| `basePath` | `/__common/` | Same-origin mount prefix; normalized with a trailing slash. |
| `authorize` | No host-level check | Your asynchronous host-session authorization hook. |
| `dataFile` | `null` | Optional JSON room-state file; otherwise rooms stay in memory. |
| `env` | Private profile only; no process environment inheritance | Explicit environment object or `(name) => value` function for network policy, TURN, and diagnostics. |
| `assetsDir` | Packaged frontend | Override only when deliberately supplying a compatible built frontend. |

Pass selected settings through `env` when configuring organization TURN, a diagram renderer, or diagnostics. `env: process.env` explicitly opts into the full host environment; without it, unrelated host settings do not alter Common's private defaults.

For a complete host page, inline and floating mounts, and an existing WebSocket echo route, see [the Bun example](https://github.com/alexwelcing/common-workspace/blob/main/examples/bun-embed/README.md). It uses the installed tarball directly and needs no frontend build tool.

## Mount the browser panel

In your browser entry point, mount after the target element exists. Give an inline container enough height for the canvas, for example `min-height: 620px`:

```js
import { mountCommon } from 'common-workspace/client';

const canvas = mountCommon({
  target: document.querySelector('#collaboration-panel'),
  basePath: '/__common/',
  mode: 'inline',
  onError(error) {
    console.error(error.code, error.message);
  },
});

await canvas.ready();
```

For a floating launcher and overlay, mount into the page body instead:

```js
const canvas = mountCommon({
  target: document.body,
  basePath: '/__common/',
  mode: 'overlay',
});
```

Inline mode opens immediately. Overlay mode starts closed and loads Common on its first opening; calling `ready()` or an `agent` method also starts that load. Set `open: true` or `false` to choose visibility explicitly.

The default experience is `experience: 'classic'`. Use `experience: 'space'` for a personal Space & Time workspace. To join an existing room, pass `roomId`: its metadata chooses the experience, taking precedence over that preference. The option opens the join view; it does not supply the password or convert the room.

Each mount has its own room identity, so two panels can join the same room without taking over each other's socket. Reloading the same iframe retains its identity; destroying and creating a new mount starts a new identity.

Use `onReady(controller)`, `onError(error)`, and `onOpenChange(isOpen)` to reflect the panel's state in your host. Readiness means the embedded interface has initialized. Joining a room and granting agent access are separate steps.

If your host has no browser bundler, serve the installed client export as a JavaScript module from your existing server:

```js
if (url.pathname === '/common-client.js') {
  return new Response(Bun.file(new URL(import.meta.resolve('common-workspace/client'))), {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
  });
}
```

Then import `mountCommon` from `/common-client.js` in a browser `<script type="module">`. The [example](https://github.com/alexwelcing/common-workspace/blob/main/examples/bun-embed/README.md) shows the complete route and HTML.

The returned controller provides:

| Method | Behavior |
| --- | --- |
| `open()`, `close()`, `toggle()` | Show or hide this panel. |
| `ready()` | Await the current iframe's initialization; call again after a frame reload. |
| `agent.describe()`, `agent.state(options?)` | Read the embedded agent interface and state, subject to its current permissions. |
| `agent.execute(command, options?)`, `agent.batch(commands, options?)` | Call the existing command API; optional `options.signal` cancels pending work. |
| `destroy()` | Asynchronously stop the embedded session and remove its iframe and launcher; safe to call repeatedly. |

### Hiding and removing the panel

Closing the panel abandons a still-pending window choice; any late result is stopped. It **does not stop an already active share or recording**. The launcher continues to show their status, and reopening preserves the room. Incoming video subscriptions pause while hidden.

Call `await canvas.destroy()` when your host view is removed or the person signs out. Destruction stops captures, revokes agent access, and closes the embedded connections. Destroy and mount again to change the prefix or initially selected room.

### Text editing

On phones, editing text or a note opens a focused writing view inside the Common frame, with 18 px text independent of canvas zoom. **Done** restores the board and its controls without changing object geometry or the personal camera. Active sharing/recording Stop controls remain available. The view follows available keyboard space; desktop editing stays inline. No additional SDK option is needed.

In both experiences, text in notes, text objects, rectangles, and ellipses fits the shared `width` and `height`. Resizing the box changes the visual text size; fitting leaves raw text and shared geometry untouched. Legacy `fontSize` remains accepted and stored for compatibility but is ignored for this visual fit. Integrations should choose the box dimensions rather than a font size.

## Host authentication and room access

The optional `authorize(request, { kind })` hook receives the original host request. `kind` is `http` or `websocket`. Return `true` to allow it, `false` to deny it, or a `Response` to supply your own response. The hook may be asynchronous. It runs for every matched Common route, including frontend assets and WebSocket upgrades, so your existing session cookie can protect the whole mount.

Host authorization and Common room passwords serve different purposes. Passing your host's session check does not skip a room's password or grant an agent control of the canvas. The iframe is same-origin, so normal same-origin session cookies remain available; keep bearer credentials out of iframe URLs and invite links.

The hook checks requests and WebSocket admission; it does not continuously recheck an established socket. Destroy the browser mount when the person signs out. If your host requires immediate server-side revocation of existing sessions, account for those open connections in its session design.

The server's `matches(request)` checks the mount boundary. `fetch(request, server)` returns `null` for an unmatched route, a `Response` for a handled request, and `undefined` after a successful Bun WebSocket upgrade. Do not turn that successful upgrade into a fallback HTTP response. Use the provided wrappers when combining Common with an existing fetch or WebSocket handler.

## Agents remain visible and opt in

Embedding does not grant agent access. A person opens **Agent tools** in Common, chooses the current tab's permissions and duration, and selects **Allow selected access**. Presets and edited choices take effect only when the person allows or updates access. Canvas read/edit access is separate from capture and recording permissions, and grants expire or can be revoked. Your product can explain this step, but it should not silently enable access when the panel opens.

The agent command runner and agent API live inside the Common iframe. A browser agent can use the labeled controls there. A JavaScript-capable integration must follow its own browser tooling policy and the current Common grant; embedding is not a permission bypass. See the packaged `agents.md`, `agent-api.md`, and `agent-tools.json` beneath your mount path for the actual interface and command schemas.

The controller's `agent` methods are asynchronous proxies into that iframe. For example, after a person grants read access:

```js
const response = await canvas.agent.execute({ action: 'canvas.inspect' });
if (!response.ok) console.error(response.error.code, response.error.message);
```

Agent command failures use the existing `{ ok: false, error: { code, message } }` envelope. Mount, readiness, reload, destruction, and caller-cancellation failures can instead reject with `CommonEmbedError`; use its `code` and `message` in your host's error handling. Aborting `options.signal` rejects promptly with `SDK_CANCELLED`, including while the iframe starts. A reloaded or destroyed frame cancels pending work rather than forwarding it into a new session. Cancellation does not undo a command that already completed.

## Screen sharing and capture

Serve the host application over trusted HTTPS for team use. Browsers also permit `http://localhost` for development. The host page's Permissions Policy must permit `display-capture` for its same-origin Common frame. A parent policy that denies capture cannot be loosened by the iframe.

Sharing still requires a person's click inside Common and the browser's native screen/window picker. Loading Common, mounting an iframe, opening the overlay, or granting an agent permission does not capture a window automatically. The browser decides which capture sources can be offered; Common cannot silently select your application's tab or another cross-origin page. Sharing pixels does not grant remote control of the source application.

The share button opens the picker directly from the click; Common does not spend that user activation on a preflight request or a second confirmation dialog. The inline sharing strip shows a pending request, the approved surface type and audience, and Stop.

Closing the picker leaves a calm retry message. **Sharing help** gives recovery steps for an insecure address, a host policy block, missing browser support, or system screen-recording access. Browser cancellation and denial can produce the same error, so the interface does not pretend to distinguish them. If a pending request is cancelled in Common, close the native picker too; any source returned by that abandoned request is stopped immediately.

When your host sets a `Permissions-Policy`, its `display-capture` rule must include `self`, for example `display-capture=(self)`. Every ancestor frame must allow capture. The SDK supplies `allow="display-capture; clipboard-write"` on its same-origin iframe; it cannot override a restrictive parent policy. Common requests video only. It does not request microphone, camera, or clipboard-read access. Each new screen share requires the browser's source picker; it is not a persistent permission Common can remember.

**Record** in the active sharing strip opens the manual recorder without granting agent access. Recording the canvas or an already approved shared source requires no new screen picker. The agent's capture and recording grants control its commands separately from these human controls.

The same-origin iframe is an integration boundary, not a separate security origin from your host application. Cross-origin embedding is not provided by this module. The SDK supplies the iframe's capture permissions and sandbox attributes; overriding them can block scripts, storage, downloads, or capture. Keep your host's Content Security Policy compatible with same-origin frames and Common's scripts, styles, connections, and assets.

## Storage, networking, and lifetime

### What survives a restart

The module defaults to an in-memory room service and the private network profile. It does not write a room database unless you explicitly configure `dataFile`. Restarting an in-memory service removes its room access, presence, and chat state. Peer canvas content and shared images live in participating browsers; live video travels between peers. Personal-canvas browser storage is scoped to the installation's mount path.

Call `close()` during your application's shutdown to stop Common-owned sockets and state. It leaves your host listener under your control. Remove the browser mount when its host view is destroyed, so captures and connections do not survive an abandoned panel.

### Local focus, undo, and chat

Each classic mounted canvas has its own local Focus view and personal Undo/Redo history. Focus changes no shared geometry. Undo applies inverse field edits only while those fields still belong to this browser's action; it preserves newer peer writes and respects current locks and edit access. Undoing deletion creates a new copy with a fresh ID, so integrations should inspect again before reusing an old object ID. Live screen objects are excluded from Undo history.

Classic Undo history ends with the session or mount, is not persisted, and is bounded to 100 entries and 24 MiB of recorded actions, plus an active group capped at 24 MiB. Paste uses the browser's normal paste event and requires no clipboard-read policy or permission. Space & Time has its own persistent automatic history, described below.

In classic, chat drafts and reading position stay in the mounted iframe's memory through panel switches and transport reconnects. Reloading, entering a different room/session, or destroying the mount clears drafts. Draft text is not written to browser storage or sent before Send. Sending waits for this participant's server echo before clearing an unchanged draft; an uncertain send keeps it and does not retry automatically. A hidden tab or hidden Common mount retains unread messages. Space & Time does not yet expose chat.

Dialog focus and inactive background state apply inside the iframe; the host controls focus outside that frame.

### Direct peer networking

The private profile uses bundled fonts and does not select public STUN or PlantUML services by default. Mermaid renders locally. Browsers connect directly by default; running the module requires no relay service or hosted account. Your host can explicitly configure organization STUN/TURN or a diagram renderer. A reachable host page does not guarantee a peer connection if firewall, NAT, or VPN policy blocks it; investigate the actual failure with Connection details before changing infrastructure. No SFU or automatic Cloudflare tunnel is included.

### Scaling the room service

One service instance owns one process's room state. Mounting it on multiple unrelated application replicas does not synchronize those stores. Keep a single owner for a room, or design shared admission, signaling, and presence before spreading requests across replicas.

Canvas traffic uses a bounded-neighbor peer network, but every participant still holds the canvas document, and a presenter uploads video separately to each viewer. There is no promised room size or unlimited video audience.

## Guided sessions in classic

Create a classic room with a template inside the Common frame to enable the Session guide, optional expected-name list, personal checklists, and host-controlled featured window. Team walkthrough, Weekly check-in, and Design review seed the new canvas with prompts. Open canvas retains the freeform experience. Space & Time has multi-board templates but does not yet expose participant checklists or featured-screen rotation.

The host's first approved window is featured automatically; Feature and Next window choose later presenters. Each browser can follow or explore independently. Following updates a local view, keeps chat/caret focus, and respects paused video. It neither grants screen capture nor changes shared geometry. Each person must approve their own share through the browser picker. A shared canvas recording includes the focused view when following.

Guided metadata uses the same server instance as admission and chat. It adds no external service dependency to the Bun module. With an explicit dataFile, room plans and checklist state are included in that file; with the default in-memory service they end on restart. Reloading/reconnecting obtains the current plan, progress, and featured participant from the server, while canvas/video still require connected peers. Planned-name claims are self-selected room labels, not verified accounts or an admission limit. Only the authenticated host can feature a person, and participants can update only their own checklist. Current browser agent command schemas are unchanged.

## Check it in your tool

Open the integrated host in two separate browser profiles. Confirm your own pages and WebSockets still work, host authentication protects the Common mount, and both profiles can join the same password-protected room. Add text, resize and reorder an object, approve a window share, and choose **Watch window** in the other profile. Then hide and reopen the panel, revoke an agent grant, and remove the mount while sharing to confirm its visible lifecycle.

Use **Canvas options → Connection details** for transport and peer states, or download its report when diagnosing a problem. Reports include screen-capture availability, request state and known browser error codes, plus the current agent capability names and remaining grant time. They contain no source titles, canvas content, room IDs, credentials, or recordings. Check the host's route and upgrade handling first if assets load but a room cannot connect.

| Error or symptom | What to check |
| --- | --- |
| `SDK_UNAUTHORIZED`, `SDK_FORBIDDEN`, or `SDK_SIGN_IN_REQUIRED` | Sign in through your host page first. Check the authorization hook; an embedded sign-in redirect is not a substitute for host authentication. |
| `SDK_ROUTE_NOT_FOUND` or `SDK_READY_TIMEOUT` | Server and browser `basePath` must match, and Common's built assets must be installed. |
| `SDK_STYLESHEET_ERROR` | Allow the mount's `embed.css` through host authentication and Content Security Policy. |
| `SDK_INVALID_EXPERIENCE` | Pass `experience: 'classic'` or `experience: 'space'`, or omit it for classic. Existing room metadata still determines a `roomId` mount's experience. |
| `UPGRADE_UNAVAILABLE` | Pass Bun's `server` argument to Common's fetch handler; the wrapper does this for you. |
| `SDK_FRAME_RELOADED` or `SDK_DESTROYED` | Await the current frame's readiness, or create a new mount after destruction. Reconsider an interrupted command before retrying. |
| `PERMISSION_DENIED` or `GRANT_EXPIRED` | Let the person review and grant the required agent permissions in Common. |
| Page and room work, but no live window appears | Approve sharing, select **Watch window**, and check browser/OS capture permissions, trusted HTTPS, host Permissions Policy, and peer connectivity. |

## Shared room appearance

The classic embedded app includes **Room style** during session creation and under **Canvas options**. Space & Time has **Room → Room style**, with appearance changes included in automatic history. Hosts can apply Meadow, Rose, Lagoon, or Lavender presets, custom accent/canvas colors, and dots/grid/plain patterns. The same appearance synchronizes across the room and survives reconnects. Inline and floating mounts style their own iframe document and leave the host application's colors unchanged. Destroying a mount restores its owned theme variables.

Personal **Canvas style** stays in that Common mount's browser storage. Existing object colors are retained; snapshots, canvas recordings, and SVG export use the room background. Styles are bounded color/pattern data, with no custom CSS, remote fonts, or image URLs. Existing room files remain compatible and fall back to Meadow.

## Space & Time

The package includes Space & Time as a regular, lazy-loaded option; classic remains the default. Open your Common mount directly with `?experience=space`, such as `/__common/?experience=space`, or select it when mounting:

```js
const canvas = mountCommon({
  target: document.querySelector('#collaboration-panel'),
  basePath: '/__common/',
  mode: 'inline',
  experience: 'space',
});
```

Invitations retain the mount prefix. An ordinary `mountCommon({ target, basePath, roomId })` joins an existing room with the password flow; that room's metadata overrides an `experience` preference. Older `?beta=space` links remain supported. Existing rooms, device authentication, IndexedDB history, and replay formats retain their compatibility names and need no new database or protocol migration.

Space & Time edits one flat board at a time and provides multi-board templates, a 3D overview, and an automatically recorded timeline. Its per-board Loro documents and manifest synchronize directly between peers and autosave small edit records to IndexedDB, scoped to this installation's mount path. Occasional full-history snapshot compaction retains every revision; earlier device storage upgrades automatically. Destroying a mount stops collaboration and capture but leaves the device archive. Ending the room stops room access without deleting those device copies. Browser data removal or eviction can still lose them; **Export room** downloads a binary `.common` replay with history and optional built-in browser compression. Earlier JSON archives still import locally. The module requires no custom filesystem or additional storage process.

Opt-in agent canvas, walkthrough, snapshot, and recording tools act on the active flat board. They add no spatial-navigation or timeline commands. Past views are read-only, and past window pixels require an explicit recording. Agent grants and native browser capture permissions still apply. Both inline and floating mounts keep their theme inside the iframe. Chat, guided participant checklists, and featured-screen rotation remain classic features; Space & Time does not yet expose those interfaces.

All board documents and their history are currently replicated to every browser; per-board documents do not yet provide selective loading. See [the Space & Time guide](https://github.com/alexwelcing/common-workspace/blob/main/docs/space-time.md) for limits, storage behavior, and a short walkthrough. No additional server, account, relay, or cloud storage service is required.
