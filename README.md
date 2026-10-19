# Common

A browser workspace for password-protected team sessions: invite links, a shared canvas, text, sticky notes, images, shapes, freehand drawing, Mermaid and PlantUML diagrams, presence, simultaneous window sharing, and shared layer controls. The default **classic canvas** also includes chat and guided team sessions. **Space & Time** is a regular optional experience for multiple boards and automatic history.

Try the hosted app at [commonwork.netlify.app](https://commonwork.netlify.app/), or [run it on your own laptop](public/self-hosting.html). The standalone version needs Bun and a local room file; it needs no Netlify account, Postgres database, or hosted API key.

WebAssembly runs the canvas geometry kernel for grid snapping and drawing simplification. The interface is JavaScript, with a JavaScript geometry fallback. Yjs synchronizes standard canvas content directly between browsers over a sparse WebRTC network. Video connections are selected separately, so joining a room does not require receiving everyone's screen. The standalone Bun server handles temporary room access, presence, chat, and connection signaling on your own machine. The optional Netlify deployment uses Functions and a small Postgres database for those same tasks. The frontend reads `/api/config` at startup, so the same built files select the local WebSocket or hosted polling transport at runtime.

## Choose your workspace

| Experience | Choose it for |
| --- | --- |
| **Classic canvas**, the default | A shared canvas with chat, participant checklists, and host-controlled featured-screen rotation. |
| **Space & Time** | Multiple boards, board templates, a 3D overview, and persistent automatic history. Agents work on the active board; chat and guided participant checklists are not yet available in this experience. |

Open [Space & Time](https://commonwork.netlify.app/?experience=space), or add `?experience=space` to your local Common address. Both experiences ship in the normal app. Existing rooms keep their experience, and invitations use room metadata to open the correct interface. The older `?beta=space` link remains supported.

Use **Work** to edit a board, then **Space** to step outside and arrange boards along X, Y, and Z with independent rotations. The timeline records changes automatically as you work. Explore the read-only past while teammates continue live, **Return to live**, or **Branch from here** into a new local workspace. Each browser keeps its own view and time position.

Boards and their history autosave as small edit records in this browser's IndexedDB and synchronize directly between connected peers using Loro's WebAssembly engine. The save indicator reports local persistence, not a server backup. **Export room** downloads a compact binary `.common` replay with history, optionally compressed by the browser; **Import room** opens it locally and still accepts earlier JSON archives. Clearing browser data or browser storage eviction can remove device copies, so export work you want to keep. Canvas replay reconstructs structured edits; past screen pixels require an explicit recording.

See [the Space & Time guide](docs/space-time.md) for templates, themes, local use, embedding, agents, and current limits. Space & Time currently replicates every board and its history to each participant; it has no measured large-room capacity guarantee. It does not convert existing classic canvases into spatial rooms.

## Embed in an existing Bun tool

Common includes a portable module for an inline canvas panel or a floating workspace inside your own application. `createCommon` from `common-workspace/bun` attaches to your existing fetch/WebSocket server; `mountCommon` from `common-workspace/client` loads the interface in a same-origin iframe. It opens no additional port, needs no UI framework, and defaults to private networking and in-memory rooms. Your authentication can protect the mount, while Common room passwords and visible agent grants still apply.

Download the package and its SHA-256 checksum from the [v1.6.1 release](https://github.com/alexwelcing/common-workspace/releases/tag/v1.6.1), or obtain them from your administrator. Release assets require access to this private repository. Install the downloaded package with `bun add /absolute/path/common-workspace-0.6.1.tgz`. From a source checkout with read access, `bun run pack:module` builds that file under `artifacts/`; no registry publishing or Cloudflare account is required. See [the integration guide](docs/embedding.md) for server routing, browser mounting, capture permissions, and process lifetime, or the [complete Bun example](examples/bun-embed/README.md).

The package includes the example: run `bun node_modules/common-workspace/example/server.mjs` in a project where you installed it, then open `http://127.0.0.1:3100`.

## Browser agents and product walkthroughs

Open **Agent tools**, choose the scopes and duration, then select **Allow selected access** in the current tab. The default grant allows canvas inspection and editing for 15 minutes; capture and recording are separate choices. Access can be revoked and expires on a session change. Browser agents can use the labeled JSON command runner, or `window.commonAgent` when their tools permit page JavaScript. They can inspect object IDs, write text, draw annotations, import generated images, change geometry and layers, focus objects, and guide a walkthrough. Edits use the same shared document as human edits. Solo walkthroughs and window sharing also work on the personal canvas without creating a room.

Agents discover instructions at `agents.md`, interfaces at `.well-known/agent.json`, and generated command schemas at `agent-tools.json` beneath the current Common mount: `/` for the standalone app or `/__common/` for the default embedded mount. Supported browsers can expose the same registry through experimental WebMCP, with only currently granted tools registered. The UI/JavaScript bridge works without WebMCP. See [AGENT_API.md](AGENT_API.md) for commands and examples. Image generation uses the agent's own tool and imports its output; there is no embedded model credential or remote MCP endpoint.

**Share a window** opens the browser picker directly. The sharing strip shows the request, approved source type, and audience, with Stop and an entry to the manual recorder. A dismissed or blocked request stays retryable with **Sharing help** for browser, system, HTTPS, and embedding restrictions. Common requests video only; canvas recording and agent access have their own visible controls.

Use **Canvas + annotations** to record the current canvas view, including live windows and drawings, or **Shared window only** to record a window already approved with the browser's native share picker. Recordings contain video only, stay in browser memory, and can be downloaded as WebM or MP4 depending on browser support. Download before reloading. Each recording is capped at five minutes or 100 MiB; a tab retains up to three recordings and 150 MiB total. PNG snapshots are available too. External PlantUML images use a placeholder in canvas captures.

Agent control starts disabled on each page load. Grants are limited to the current browser/session and at most 60 minutes; the agent API cannot grant itself more access. Position locks, screen ownership, room access, and disconnect behavior still apply. Commands and pending captures retain their original session scope, so changing rooms cannot redirect queued edits into another room. The browser's native picker and the person's manual recording controls remain separate from agent grants.

### Optional local MP4 export

Browser recording/downloads work on their own. To convert a saved clip or a sequence of PNG snapshots into MP4, install FFmpeg (`ffmpeg` and `ffprobe`) on the same computer as the browser and start:

```sh
bun run media:export --origin http://localhost:3001
```

Use your actual app origin, including its HTTPS port for a team installation. Open **Canvas options → Recording exports**, connect to the printed loopback worker address, and paste its session token. The token stays in this tab. Choose a retained recording, or 1–50 PNG frames and their duration, then export. The worker processes temporary files locally and removes them after the job; it does not require Cloudflare, Netlify, or Docker. Original browser recordings remain available. The self-hosting guide covers the optional Docker engine and limits. No agent command exposes worker tokens or starts conversion.

## Run on your own laptop

Use Bun 1.4.3 (the pinned version in `package.json`). Clone this repository using an account with read access, or unpack a source archive supplied by your administrator. This is currently a private repository; public access to the hosted app does not grant source access.

The [self-hosting guide](public/self-hosting.html), available from **How it works → Run Common on your own laptop**, covers installation, team networking, HTTPS, and data handling. It is also served at `/self-hosting.html` on each local installation.

```sh
bun install --frozen-lockfile
bun run local
```

Open http://localhost:3001. The launcher builds and starts the standalone app with the private network profile: no default public STUN or external PlantUML renderer. The personal canvas works for a solo walkthrough. For collaboration, create a room with a password of at least eight characters and use its generated invite link.

Run `bun run doctor` for local setup diagnostics. It checks the toolchain, selected profile, origins, ports, and certificate files without printing secrets. For source development with hot reload, `bun run dev` starts Vite at http://localhost:5173 and the Bun API server together.

To run the built app:

```sh
bun install --frozen-lockfile
bun run build:local
bun run start
```

`build:local` remains a compatibility build command. The served `/api/config` now determines transport and network policy, so you can move the built frontend between standalone and Netlify hosting without rebuilding it for a different transport. Bare `bun run start` uses your environment settings; set `COMMON_NETWORK_PROFILE=private` in `.env` for the organization's private profile.

Open http://localhost:3001. The server serves `dist/` and the API on the same port. See [API.md](API.md) for the collaboration protocol.

### Invite teammates over LAN or VPN

One laptop runs Bun and Caddy; the other participants only need a browser. Install Caddy, choose a stable LAN/VPN address, and start:

```sh
bun run local --https --origin https://192.168.1.50:8443
```

Use your host's reachable address instead of the example IP. The launcher writes its Caddy configuration under `data/local`, uses port `8443` by default, and exports the public root certificate as `common-local-root.crt`. Every participant must trust that authority through their organization's certificate process, or use an organization-issued TLS certificate instead. It does not automatically install trust. See the guide for the manual [Caddy configuration](public/self-hosting/Caddyfile) and certificate steps.

Everyone, including the host, opens the same address, for example `https://192.168.1.50:8443`, **before creating the room**. Share its generated link and password separately. `localhost` on a teammate's laptop refers to that teammate's own machine; separate Bun servers create separate room stores. Keep the host awake and both processes running. Permit the HTTPS port and browser-to-browser WebRTC connections through the LAN/VPN; a working web page alone does not prove peer connectivity.

Fonts are bundled, and the private profile uses no default external STUN or PlantUML service. You can explicitly configure organization STUN/TURN or a diagram renderer. The standard profile retains public Google/Cloudflare STUN and the consented public PlantUML renderer; Mermaid stays local. Installation still needs dependencies, and private hosting does not overcome blocked peer connections. The guide explains the network boundaries and optional services.

## Deploy to Netlify

Import this repository from GitHub into your Netlify team. The committed `netlify.toml` pins Bun 1.4.3, builds the Vite/WASM frontend, publishes `dist`, and bundles the API, rate-limited room admission and scheduled cleanup functions. The hosted `/api/config` selects HTTP polling. Functions run on Node.js 22; they do not require a persistent Bun process or a separate WebSocket host.

`@netlify/database` and the committed SQL migrations provision the small room database during deployment. Netlify Database requires a credit-based plan; this setup does not change your account plan. If the team's plan does not support it, enable a supported database plan before importing. No canvas objects, images, or screen recordings are stored in the database.

The default deployment connects browsers directly and requires no separate relay service. Standard mode uses public STUN to discover possible peer routes; STUN does not forward canvas content or video. Network settings are optional: keep the defaults for your team, and use **Connection details** to investigate a connection that fails on an actual device. See the runtime settings below if your organization explicitly wants to configure its own discovery or relay service.

After the first deploy, open the HTTPS site in two separate browser profiles, create a room, join its invite link, and check shared objects, chat, each person's window capture, and Watch/Pause controls. Verify the operating system picker and the networks and devices your team actually uses before wider use. The absence of a participant cap does not establish a supported room size or video audience.

For local Netlify development, authenticate the Netlify CLI, link the project, run `bun run dev:netlify`, then apply local migrations in a second terminal with `bunx netlify-cli@26.0.0 database migrations apply`. Netlify applies the committed migrations automatically on hosted deploys. The regular `bun run dev` uses the standalone Bun/WebSocket backend.

## Guided team sessions in classic

In the classic canvas, choose **Team walkthrough**, **Weekly check-in**, or **Design review** when creating a session. Each preset starts a canvas with prompts and a **Session guide**. Add expected names and edit the checklist before starting, or choose **Open canvas** for a freeform room. Space & Time has separate board templates; it does not yet have this participant-checklist or featured-screen interface.

1. The host shares the session link and password, then approves their main window with **Share a window**. The first host window is featured automatically.
2. Each person joins, chooses their name in the plan (or joins as an additional participant), chooses **Share a window** or **Watch & contribute**, and completes their checklist. Watching does not require capture or count an unavailable window as shared. The host sees waiting names, joined people, shared-window status, and progress.
3. The host chooses **Feature** beside a person or **Next window** to rotate through sharing teammates in planned order. **Feature my window** returns to the main presentation.
4. **Follow featured** shows the host's selection in this browser. **Explore canvas** or Back/Escape leaves that view so you can write and draw. Following never starts screen capture or resumes a window you paused; **Resume watching** does that explicitly.

The planning list is not an identity check or invitation restriction. Everyone still needs the room link and password. Checkboxes belong to the signed-in room participant; only the host can choose the shared featured person. The planning list is bounded to 200 names and the checklist to 12 items to keep setup manageable; additional people can still join. Session metadata and checklist state use the existing room service and expire with the room. Canvas content remains ephemeral and lives in the participating browsers. The app does not send invitations for you.

## Give a room its own style

In classic, choose **Room style** while creating a session, or open **Canvas options → Room style** afterward. In Space & Time, open **Room → Room style**. Start with **Meadow**, **Rose**, **Lagoon**, or **Lavender**, then choose custom accent and canvas colors and a **Little dots**, **Quiet grid**, or **Plain canvas** background. The preview stays in the editor until you apply it.

The host controls the shared style; everyone receives it when joining, reconnecting, or reloading. Room style works in freeform and guided rooms on Netlify, standalone Bun, and embedded installations. Participants can inspect the style, while only the host can apply changes. Existing rooms start in Meadow.

Room colors style the interface and background. Existing notes, drawings, and diagrams keep their own colors; a dark canvas can need lighter text. PNG snapshots, canvas recordings, and SVG exports include the background. A personal canvas has **Canvas options → Canvas style**, saved only in this browser. Styling needs no account, external asset, or new service.

## Phones and tablets

Join with the same link and password. In a classic guided room, choose **Watch & contribute** in the Session guide to take part without sharing a window; complete your manual checklist items, chat, and edit the canvas. The host sees your participation choice and readiness. You can change that choice later without losing progress. Choosing a mode never opens a capture picker, stops capture, or resumes a paused video. Space & Time uses its board and timeline interface instead of the classic Session guide and chat.

Use two fingers to pan and pinch to zoom. With one finger, drag objects or use a drawing tool. Starting a pinch cancels the unfinished one-finger edit. **Focus** enlarges a window or note for your view and hides the mobile drawing tools; **Back to canvas** restores them. Pinching leaves Focus so you can explore independently. Touch controls have larger targets, and People/chat has its own close button.

Select a text object or note and tap **Edit** to write. On a phone, writing opens a focused view with readable text independent of canvas zoom. Tap **Done** to return to the board; its object sizes and your camera stay unchanged. Navigation and drawing controls tuck away while writing, with active sharing/recording Stop controls still available. Desktop editing stays inline.

Common fits chat and dialogs to the visible viewport when the keyboard opens and respects device safe areas. Floating embeds follow the host page's visible viewport too; inline embeds remain in their application's layout. Browser zoom remains available for accessibility.

Screen capture and recording depend on the actual browser APIs, rather than a phone/desktop label. If capture is unavailable, **Sharing help** explains why and the guide offers **Join without sharing**. Canvas snapshots and recording have their own capability requirements. Keep the session tab active for live collaboration; mobile operating systems can suspend background tabs. Download recordings before closing or reloading. Mobile layouts and touch gestures are checked in browser emulation; native keyboard, browser picker, and device-to-device video still need a check on the team's physical devices.

## Sharing and collaboration

The canvas controls below describe classic. Space & Time shares the drawing and window-capture foundations, with its own [board, overview, and history controls](docs/space-time.md#work-in-space-and-time).

- Rooms have no fixed participant admission cap. Authentication, rate limits, connection leases, canvas budgets, and hosting resources still apply. See the scaling limits below before choosing a room size.
- Each participant can share one selected window or screen at a time. The browser requires a click and its native capture picker. An operating system window cannot be dragged directly into a web page to grant capture access. Image files can be dropped onto the canvas.
- Screen sharing is video-only. Use **Watch window** or **Pause view** on a remote screen tile to choose the video this browser receives. The frontend defaults to watching up to four remote windows, or two when reported memory or CPU resources are low; a hidden tab pauses its remote video subscriptions. Pausing is local and does not stop the presenter's capture or change shared annotations. Sharing pixels does not provide remote control of another participant's computer.
- Classic rooms use Yjs with a shared map for each object property. Reordering an object merges with another person’s resize or text change. Concurrent changes to the same property resolve deterministically. Canvas updates are forwarded across a sparse network, with five-second state-vector checks between neighbors to repair missed updates; the canvas does not promise offline editing. Space & Time uses separate Loro documents and automatic history, described above.
- Select an object to use Bring to front, Bring forward, Send backward, Send to back, and Lock position. Open Layers at the top right of the canvas to select a covered object. Position locks prevent accidental dragging/resizing for everyone; participants can unlock the object. Text remains editable. Screen tiles remain under their owner’s control.
- Use **Focus** or F to enlarge a selected object just in your browser; Escape or **Back to canvas** restores your previous view. Other objects are hidden locally during Focus. It respects paused windows, and canvas snapshots/recordings capture that focused view. SVG export still includes the whole canvas.
- Move and resize with the mouse or pointer; hold Shift while resizing to preserve proportions. Resize targets stay usable at every zoom. Arrow keys move a selected object, Alt + arrows resize it, and Shift makes 10-pixel steps. Use **Edit** or Enter for text and diagram editing. Ctrl/Cmd + ] or [ moves a layer one place, with Shift moving it to the front/back.
- **Undo/Redo** reverses this browser's canvas actions, including moves, text, layers, locks, deletes, and image batches. Ctrl/Cmd + Z and Ctrl/Cmd + Shift + Z work with the canvas focused; text fields keep their native undo. Newer peer field changes are kept. Recovering a deleted object makes a new copy with a new ID and the snapshot at deletion time; live screens are excluded. History stays in this tab/session, bounded to 100 entries and 24 MiB of recorded actions, with one active group also capped at 24 MiB.
- Drop up to five images at the pointer, pick multiple files, or paste a screenshot onto the canvas without clipboard-read access. Batches are spaced apart and undo together. Text and editable-field paste remain unchanged; an import finishing after a session change is discarded.
- Chat keeps your draft and cursor through incoming messages, participant updates, panel switches, and reconnects. Enter sends; Shift + Enter adds a line. Drafts live only in this mounted tab/session and are lost on reload or room change. Sending keeps the draft until the server echoes the message; uncertain delivery keeps it for review, without automatic retries. Unread badges and a new-message jump let you read earlier messages without being scrolled away.
- Dialogs keep keyboard focus inside, support Escape, and return to their opening control. Replacing a dialog keeps the original opener. Background controls stay inactive until dismissal, and destructive session confirmation starts on **Keep session open**.
- New classic room canvas documents live in browser memory, including shared images, layer order and locks. A late joiner gets the document from connected participants. Once every participant closes the room, its canvas is gone unless someone exported it. The personal canvas still saves on the current device. Space & Time also saves its boards and history to each participating browser's IndexedDB.
- Screen tiles are removed when their owner disconnects. The room service retains room metadata and recent chat for the room's short lifetime. Ending a room revokes access. Only the standalone Bun service supports older rooms with server-based canvas storage.
- Mermaid renders locally. PlantUML requires explicit consent to send the complete diagram source to the public `plantuml.com` renderer. Avoid confidential source in external diagrams.

## Standalone Bun hosting

Run one long-lived Bun instance behind an HTTPS reverse proxy. Forward both HTTP and WebSocket traffic, preserve the request `Host`, and allow WebSocket upgrades on `/ws`. Public screen sharing needs HTTPS; browsers also permit localhost for development. A static-only hosting plan cannot run the session server.

Room state defaults to `data/rooms.json`. Give the process a writable, persistent volume and back it up as appropriate. This file contains room metadata, password hashes, hashed access tokens, and chat. Only older rooms also store their canvas and images there; new peer rooms reject server canvas writes and return empty server snapshots. Live screens are neither recorded nor persisted. Persistence is debounced, so abrupt process termination can lose the most recent changes. The in-memory server and JSON storage support one server instance, not horizontal replicas.

Environment variables are listed in [.env.example](.env.example). Bun automatically loads a local `.env` file. In hosted environments, set variables through your provider. For local settings:

```sh
cp .env.example .env
bun run start
```

| Variable | Default / purpose |
| --- | --- |
| `PORT` | `3001`; HTTP and WebSocket port |
| `HOST` | `0.0.0.0`; listen address |
| `DATA_FILE` | `data/rooms.json` beside `server.mjs`; persistent storage file |
| `COMMON_LOCAL_ORIGIN` | Optional stable launcher/doctor origin; the launcher's `--origin` overrides it |
| `COMMON_HTTPS_PORT` | `8443`; default port for the optional local HTTPS launcher |
| `CADDY_BIN` | Optional installed Caddy executable path |
| `ALLOWED_ORIGINS` | Optional comma-separated additional origins; same-host browser requests are accepted by default |
| `COMMON_NETWORK_PROFILE` | `standard`, or `private` to remove default external STUN and PlantUML; the local launcher defaults to `private` |
| `STUN_URLS` | Explicit comma-separated STUN URLs; `none` disables STUN. Use organization URLs to override the profile's defaults |
| `PLANTUML_URL` | Explicit renderer endpoint; `none` disables it. Private mode enables no renderer unless one is configured |
| `ICE_TRANSPORT_POLICY` | `all` by default; `relay` requires a working configured TURN relay |
| `TURN_URLS` | Optional comma-separated `turn:` / `turns:` relay URLs |
| `TURN_SECRET` | Preferred shared secret for coturn REST authentication; use with `TURN_URLS` |
| `TURN_TTL_SECONDS` | Time-limited TURN credential lifetime; default `3600`, bounded to 60–86400 seconds |
| `TURN_USERNAME` | Alternative static TURN username; use with `TURN_URLS` and `TURN_CREDENTIAL` |
| `TURN_CREDENTIAL` | Alternative static TURN password; omit if using `TURN_SECRET` |

### Runtime and reliability diagnostics

Open **Canvas options → Connection details** to see the effective profile/build, connected canvas neighbors, watched windows, queued bytes, and configured relay status. **Download connection report** saves counts, connection states, and generated request IDs for correlation, without room IDs, canvas content, credentials, or recordings.

Open **Canvas options → Performance**, or **Room → Performance** in Space & Time, for a local responsiveness index, measured work, and workload context. Measurements stay in the browser; reports download only when requested. See the [performance guide](docs/performance.md) for coverage, interpretation, and comparing changes.

`/api/config` identifies the effective transport, profile, protocol, and build; `/api/health` checks the hosting adapter's health. The public configuration contains STUN settings and a TURN-availability flag, never credentials. Both adapters share validation and session policy. Hosted polling delivers targeted batches, skips unchanged rosters, catches up immediately when more events remain, and retries only idempotent signaling when the server advertises support. Chat is not retried automatically.

Responses include `X-Common-Request-Id`, `X-Common-Build`, `X-Common-Protocol`, and `traceparent` for correlation. Diagnostics are off by default. Set `COMMON_LOG_DIAGNOSTICS=1` for redacted JSON with route category, method, status, duration, build/protocol, and generated IDs. It omits room IDs, URLs/queries, message bodies, canvas content, and credentials.

For an organization OpenTelemetry collector, set `COMMON_OTLP_ENDPOINT` to its full HTTP(S) traces URL, such as `http://127.0.0.1:4318/v1/traces`. `COMMON_OTLP_TOKEN` is an optional server-side Bearer secret. Export waits at most `COMMON_OTLP_TIMEOUT_MS` (default 500 ms; bounded to 25–750 ms); collector failures do not fail a room request. No Cloudflare or observability account is required. Use the guide's short two-browser walkthrough to confirm actual peer video and capture on your devices.

Canvas routing uses the union of three deterministic hash rings. Each browser connects to its predecessor and successor in each ring, yielding at most six canvas neighbors rather than a room-wide mesh. Yjs updates are forwarded across those links, excluding their source; five-second state-vector exchanges repair missed updates. Reliable ordered data channels split large updates into 16 KiB frames with backpressure and bounded queues. A consistent roster gives browsers the same routing choices, and membership changes replace affected neighboring edges.

Video subscriptions are independent of canvas routing. The media layer's `setSubscriptions(ids)` selects the screen owners whose video this browser receives. A watched screen can require an additional direct connection even when its owner is not a canvas neighbor. Pausing remote video leaves the canvas links active. A presenter still uploads a separate stream to each actual viewer, so presenter upload and encoding work grow with the number of viewers.

Direct WebRTC is the default path for canvas and video; the private profile has no public STUN or media relay dependency. Firewalls, NATs, or VPN policy can prevent direct connections even when the page loads. Use connection reports and the actual network configuration to investigate such a failure. A relay is an optional deployment setting, not a requirement to run Common.

If your organization chooses a TURN relay, set `TURN_URLS` plus `TURN_SECRET`, or `TURN_USERNAME` and `TURN_CREDENTIAL`, in the server environment. On Netlify, scope these to Functions and never prefix secrets with `VITE_`. Credentials are returned only after room-token authentication and never appear in public runtime configuration. With coturn REST authentication, match `TURN_SECRET` to `static-auth-secret` with `use-auth-secret` so the server generates expiring credentials; static credentials should use a dedicated, restricted account. The browser refreshes cached ICE settings before connection restarts. Common does not operate a relay service.

### Docker

```sh
docker build -t common .
docker run --name common -p 3001:3001 -v common-data:/data common
```

To customize network policy or an origin allowlist, pass the relevant environment variables with Docker's `--env-file` or `-e` options. The image sets `DATA_FILE=/data/rooms.json`; preserve that location when mounting the data volume. Terminate TLS at the hosting platform or reverse proxy.

## Scope and limits

Room creation is open to visitors; there is no separate administrator account, identity provider, invitation allowlist, or host recovery flow. The creator's browser holds the host access token in session storage. Room metadata can be looked up by its opaque room ID; participation requires a password-derived session token. Passwords are hashed with scrypt and are not included in room URLs. On Netlify, rooms expire after 24 hours, connected presence leases last two minutes, and an initial admission lease lasts one minute before connecting. These leases track connection activity; they do not reserve seats. An expired presence lease requires reconnecting with a still-valid token. Connecting renews the 24-hour token lifetime, while the room's expiry remains unchanged. Reloading preserves the participant identity and host access; explicitly leaving revokes that token. Scheduled cleanup removes expired room data, with additional cleanup on room creation and connect. The standalone Bun service retains its seven-day room lifetime and refreshes token expiry on a WebSocket connection.

Sparse routing bounds each browser's canvas neighbors, but every browser still receives and stores the full shared document. Local edits are constrained by a 1000-object limit and a 16 MiB materialized-content budget; concurrent peer changes can exceed local budgets, so they are not a global memory guarantee. Yjs history and decoded images add overhead. Hosted delivery omits unchanged rosters and irrelevant signals, but roster changes, presence, chat fan-out, and database/polling work still grow with usage. Backend room serialization and rate/resource limits remain relevant. There is no measured room-size or simultaneous-video capacity guarantee.

Larger canvases need interest regions or document/awareness sharding, so devices receive relevant content. Larger rooms need incremental roster deltas and less room-wide presence work beyond today's omission of unchanged rosters. A large audience may need a separately operated SFU to receive one upstream presenter stream and forward it. Common does not include that server or a turnkey integration. These remain further development steps.

Before a public rollout, assess your deployment's capacity, access requirements, backup policy, proxy rate limits, and monitoring. Check actual screen capture, network recovery, and multiple real browsers on the networks your team uses. No separate relay service is required for this release.

## Development and troubleshooting

Run `bun run doctor`, then `bun run local` for a fresh build and a private local server. Use `bun run dev` while changing the source, or `bun run build` when you only need the deployable frontend. The same artifact uses `/api/config` to select its hosting transport; no transport-specific rebuild is needed.

For code boundaries, lifecycle and data invariants, troubleshooting, and the release checklist, see the [maintainer guide](docs/maintaining.md).

Space & Time's compact controls use shared, framework-free [workspace UI primitives](docs/workspace-ui.md) for shape, motion, keyboard behavior, and lifecycle cleanup.

Use `bun run check` for the default quality check: one build and five real desktop/phone journeys, with the failing step, readable report, and screenshots if something breaks. It starts and cleans up its own temporary local app. Existing Chrome/Chromium works; otherwise install a browser once with `bunx playwright-core install chromium`. Deeper checks are explicit, such as `bun run check:deep canvas` or `bun run check:deep hosted`. See [the validation guide](docs/validation.md) for setup, hosted checks, failure evidence, and the short real-device walkthrough. `bun run test` runs the same lean default.

Follow the [two-browser walkthrough](public/self-hosting.html#smoke-test) on the devices and network you plan to use. Confirm shared edits, actual window frames, reconnect behavior, and a downloaded recording. For a problem, open **Canvas options → Connection details** and download its report, then use the guide's [troubleshooting steps](public/self-hosting.html#troubleshooting). The report includes counts, states, and generated request IDs for correlation, without room IDs, canvas content, credentials, or recordings.
