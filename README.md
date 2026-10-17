# Common

A browser workspace for password-protected team sessions: invite links, a shared canvas, text, sticky notes, images, shapes, freehand drawing, Mermaid and PlantUML diagrams, chat, presence, simultaneous window sharing, and shared layer controls.

Try the hosted app at [commonwork.netlify.app](https://commonwork.netlify.app/), or [run it on your own laptop](public/self-hosting.html). The standalone version needs Bun and a local room file; it needs no Netlify account, Postgres database, or hosted API key.

WebAssembly runs the canvas geometry kernel for grid snapping and drawing simplification. The interface is JavaScript, with a JavaScript geometry fallback. Yjs synchronizes canvas content directly between browsers over a sparse WebRTC network. Video connections are selected separately, so joining a room does not require receiving everyone's screen. The standalone Bun server handles temporary room access, presence, chat, and connection signaling on your own machine. The optional Netlify deployment uses Functions and a small Postgres database for those same tasks.

## Browser agents and product walkthroughs

Open **Agent tools** and enable agent control in the current tab. Browser agents can use its labeled JSON command runner, or `window.commonAgent` when their tools permit page JavaScript. They can inspect object IDs, write text, draw annotations, import generated images, change geometry and layers, focus objects, and guide a walkthrough. Edits use the same shared document as human edits. Solo walkthroughs and window sharing also work on the personal canvas without creating a room.

Agents discover instructions at `/agents.md` and capabilities at `/.well-known/agent.json` on the current installation's origin, so local sessions do not send agents to the hosted app. See [AGENT_API.md](AGENT_API.md) for commands and examples. Common supplies the canvas interface; an agent uses its own image-generation tool and imports the resulting raster image. There is no embedded model credential or remote MCP endpoint.

Use **Canvas + annotations** to record the current canvas view, including live windows and drawings, or **Shared window only** to record a window already approved with the browser's native share picker. Recordings contain video only, stay in browser memory, and can be downloaded as WebM or MP4 depending on browser support. Download before reloading. Each recording is capped at five minutes or 100 MiB; a tab retains up to three recordings and 150 MiB total. PNG snapshots are available too. External PlantUML images use a placeholder in canvas captures.

Agent control starts disabled on each page load. Position locks, screen ownership, room access, and disconnect behavior still apply. Commands and pending captures retain their original session scope, so changing rooms cannot redirect queued edits into another room. Recording controls remain available to the person using the canvas when agent control is off.

## Run on your own laptop

Use Bun 1.4.3 (the pinned version in `package.json`). Clone this repository using an account with read access, or unpack a source archive supplied by your administrator. This is currently a private repository; public access to the hosted app does not grant source access.

The [self-hosting guide](public/self-hosting.html), available from **How it works → Run Common on your own laptop**, covers installation, team networking, HTTPS, and data handling. It is also served at `/self-hosting.html` on each local installation.

```sh
bun install --frozen-lockfile
bun run dev
```

Open http://localhost:5173. The development script starts Vite and the API server together under Bun. Start a session, choose your display name and a password of at least eight characters, then share the generated link and password separately. Use another browser profile or a private window to test a second participant.

To run the built app:

```sh
bun install --frozen-lockfile
bun run build:local
bun run start
```

`build:local` explicitly selects the standalone WebSocket transport, even if your shell or `.env` was configured for Netlify polling. It does not change the hosted build.

Open http://localhost:3001. The server serves `dist/` and the API on the same port. `bun run test` runs the automated checks. See [API.md](API.md) for the collaboration protocol.

### Invite teammates over LAN or VPN

One laptop runs the Bun server; the other participants only need a browser. Run the built app behind HTTPS with the [included Caddy example](public/self-hosting/Caddyfile). Bind Bun to `127.0.0.1:3001` in `.env`, replace `localhost` in the Caddy site address with the host's reachable LAN/VPN IP or internal DNS name, and run:

```sh
caddy run --config public/self-hosting/Caddyfile --adapter caddyfile
```

The example uses port `8443`, Caddy's local certificate authority, and WebSocket-aware proxying. Every participant must trust that authority through their organization's certificate process, or use an organization-issued TLS certificate instead. See the guide for certificate export and trust steps. Forward the original `Host` header; Caddy does this automatically.

Everyone, including the host, opens the same address, for example `https://192.168.1.50:8443`, **before creating the room**. Share its generated link and password separately. `localhost` on a teammate's laptop refers to that teammate's own machine; separate Bun servers create separate room stores. Keep the host awake and both processes running. Permit the HTTPS port and browser-to-browser WebRTC connections through the LAN/VPN; a working web page alone does not prove peer connectivity.

Self-hosting removes the Netlify runtime dependency, but the current defaults still use Google Fonts and public Google/Cloudflare STUN servers. Consented PlantUML rendering sends diagram source to the public renderer; Mermaid stays local. This is not a preconfigured offline deployment. The guide explains these external requests and the changes a disconnected installation would need.

## Deploy to Netlify

Import this repository from GitHub into your Netlify team. The committed `netlify.toml` pins Bun 1.4.3, builds the Vite/WASM frontend, publishes `dist`, bundles the API, rate-limited room admission and scheduled cleanup functions, and enables the browser's HTTP polling transport. Functions run on Node.js 22; they do not require a persistent Bun process or a separate WebSocket host.

`@netlify/database` and the committed SQL migrations provision the small room database during deployment. Netlify Database requires a credit-based plan; this setup does not change your account plan. If the team's plan does not support it, enable a supported database plan before importing. No canvas objects, images, or screen recordings are stored in the database.

Configure a production TURN relay under **Project configuration → Environment variables**, scoped to Functions: `TURN_URLS` plus `TURN_SECRET`, or `TURN_USERNAME` and `TURN_CREDENTIAL`. These are server secrets; never prefix them with `VITE_`. Without a relay, STUN-only connections can be used for a pilot, but some network combinations will not connect. No production relay is included in this repository.

After the first deploy, open the HTTPS site in two separate browser profiles, create a room, join its invite link, and check shared objects, chat, each person's window capture, and Watch/Pause controls. Verify the operating system picker and the networks and devices your team actually uses before wider use. The absence of a participant cap does not establish a supported room size or video audience.

For local Netlify development, authenticate the Netlify CLI, link the project, run `bun run dev:netlify`, then apply local migrations in a second terminal with `bunx netlify-cli@26.0.0 database migrations apply`. Netlify applies the committed migrations automatically on hosted deploys. The regular `bun run dev` uses the standalone Bun/WebSocket backend.

## Sharing and collaboration

- Rooms have no fixed participant admission cap. Authentication, rate limits, connection leases, canvas budgets, and hosting resources still apply. See the scaling limits below before choosing a room size.
- Each participant can share one selected window or screen at a time. The browser requires a click and its native capture picker. An operating system window cannot be dragged directly into a web page to grant capture access. Image files can be dropped onto the canvas.
- Screen sharing is video-only. Use **Watch window** or **Pause view** on a remote screen tile to choose the video this browser receives. The frontend defaults to watching up to four remote windows on desktop and two on small devices; a hidden tab pauses its remote video subscriptions. Pausing is local and does not stop the presenter's capture or change shared annotations. Sharing pixels does not provide remote control of another participant's computer.
- New rooms use Yjs with a shared map for each object property. Reordering an object merges with another person’s resize or text change. Concurrent changes to the same property resolve deterministically. Canvas updates are forwarded across a sparse network, with five-second state-vector checks between neighbors to repair missed updates; the canvas does not promise offline editing.
- Select an object to use Bring to front, Bring forward, Send backward, Send to back, and Lock position. Open Layers at the top right of the canvas to select a covered object. Position locks prevent accidental dragging/resizing for everyone; participants can unlock the object. Text remains editable. Screen tiles remain under their owner’s control.
- Move and resize with the mouse or pointer; hold Shift while resizing to preserve proportions. Ctrl/Cmd + ] or [ moves a layer one place, with Shift moving it to the front/back.
- New room canvas documents live in browser memory, including shared images, layer order and locks. A late joiner gets the document from connected participants. Once every participant closes the room, its canvas is gone unless someone exported it. The personal canvas still saves on the current device.
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
| `ALLOWED_ORIGINS` | Optional comma-separated additional origins; same-host browser requests are accepted by default |
| `TURN_URLS` | Optional comma-separated `turn:` / `turns:` relay URLs |
| `TURN_SECRET` | Preferred shared secret for coturn REST authentication; use with `TURN_URLS` |
| `TURN_TTL_SECONDS` | Time-limited TURN credential lifetime; default `3600`, bounded to 60–86400 seconds |
| `TURN_USERNAME` | Alternative static TURN username; use with `TURN_URLS` and `TURN_CREDENTIAL` |
| `TURN_CREDENTIAL` | Alternative static TURN password; omit if using `TURN_SECRET` |

Canvas routing uses the union of three deterministic hash rings. Each browser connects to its predecessor and successor in each ring, yielding at most six canvas neighbors rather than a room-wide mesh. Yjs updates are forwarded across those links, excluding their source; five-second state-vector exchanges repair missed updates. Reliable ordered data channels split large updates into 16 KiB frames with backpressure and bounded queues. A consistent roster gives browsers the same routing choices, and membership changes replace affected neighboring edges.

Video subscriptions are independent of canvas routing. The media layer's `setSubscriptions(ids)` selects the screen owners whose video this browser receives. A watched screen can require an additional direct connection even when its owner is not a canvas neighbor. Pausing remote video leaves the canvas links active. A presenter still uploads a separate stream to each actual viewer, so presenter upload and encoding work grow with the number of viewers.

The default configuration uses direct WebRTC and public STUN servers, with no external media relay included. Restrictive firewalls and NATs can prevent direct connections. Provide a reachable TURN relay where those networks require it; browser WASM cannot make an unreachable browser into a public relay. TURN credentials are returned only after room-token authentication. Prefer `TURN_SECRET` matching your coturn `static-auth-secret` with `use-auth-secret`: the server generates expiring credentials per participant and keeps the shared secret private. With static relay credentials, use a dedicated, restricted account and rotate credentials. The browser refreshes cached ICE settings before connection restarts.

### Docker

```sh
docker build -t common .
docker run --name common -p 3001:3001 -v common-data:/data common
```

To configure TURN or an origin allowlist, pass the relevant environment variables with Docker's `--env-file` or `-e` options. The image sets `DATA_FILE=/data/rooms.json`; preserve that location when mounting the data volume. Terminate TLS at the hosting platform or reverse proxy.

## Scope and limits

Room creation is open to visitors; there is no separate administrator account, identity provider, invitation allowlist, or host recovery flow. The creator's browser holds the host access token in session storage. Room metadata can be looked up by its opaque room ID; participation requires a password-derived session token. Passwords are hashed with scrypt and are not included in room URLs. On Netlify, rooms expire after 24 hours, connected presence leases last two minutes, and an initial admission lease lasts one minute before connecting. These leases track connection activity; they do not reserve seats. An expired presence lease requires reconnecting with a still-valid token. Connecting renews the 24-hour token lifetime, while the room's expiry remains unchanged. Reloading preserves the participant identity and host access; explicitly leaving revokes that token. Scheduled cleanup removes expired room data, with additional cleanup on room creation and connect. The standalone Bun service retains its seven-day room lifetime and refreshes token expiry on a WebSocket connection.

Sparse routing bounds each browser's canvas neighbors, but every browser still receives and stores the full shared document. Local edits are constrained by a 1000-object limit and a 16 MiB materialized-content budget; concurrent peer changes can exceed local budgets, so they are not a global memory guarantee. Yjs history and decoded images add memory overhead. More participants also increase roster processing, presence traffic, chat fan-out, and Netlify database/HTTP polling work. The backend's room serialization and rate/resource limits remain relevant. There is no measured room-size or simultaneous-video capacity guarantee.

Larger canvases need interest regions or document sharding, including awareness data, so devices receive only relevant content. Larger rooms need roster deltas and less room-wide presence/polling work. A large audience watching one presenter may need an optional SFU to receive one upstream video stream and forward it to viewers; an SFU requires a reachable server outside participants' browsers. These are further development steps, not features supplied by the current relay-free deployment.

Before a public rollout, assess your deployment's capacity, access requirements, backup policy, TURN capacity, proxy rate limits, and monitoring. Test actual screen capture, network recovery, and multiple real browsers on the networks your team uses.

## Verified in this workspace

The automated suite runs under Bun 1.4.3, including twenty integration checks against real PostgreSQL when `COMMON_TEST_DATABASE_URL` is set. The GitHub workflow supplies a disposable Postgres service. Coverage includes transactional admission, signaling, leases, cleanup, TURN expiry, polling recovery, Yjs convergence, layer edits, agent command validation, session isolation, delayed-operation cancellation, capture limits, and recording lifecycle. DOM integration checks use the real application, board, shared model, and agent interface with injected media services; these do not claim native browser capture or codec verification.

Before the sparse routing and selective video changes, the Netlify adapter passed 12 browser checks across three Chromium profiles, using its production frontend and the actual Function handler against PostgreSQL: passwords, chat, layer ordering, shared move/resize/lock, late joining, reload recovery with the same identity, and two simultaneous real WebRTC streams decoded by peers. Six peer links connected through a local TURN TCP relay. The test confirms no application WebSocket connections, no HTTP canvas writes, empty server canvas snapshots, and no uncaught browser errors. This verifies the adapter locally; it does not claim a deployed Netlify site or production network verification.

The standalone Bun backend also passed the earlier 13-check browser smoke suite and nine-check layering suite, including a 338 KB image transferred in chunks. Screen-capture tests use synthetic canvas capture sources over real WebRTC. The native operating system picker and larger simultaneous audiences still need real-device and network testing.

The scaling tests model topology for 1000 participant IDs and canvas convergence across 100 synthetic peers. These exercise routing and Yjs update propagation in a simulated network; they do not run 100 or 1000 browsers, encode that many streams, or establish device, network, signaling, or production database capacity.

To run the optional browser suite, start the app, install Playwright and Chromium in your test environment, then run `bun run test:browser`. `BASE_URL`, `PLAYWRIGHT_MODULE`, and `CHROMIUM_PATH` can select your running server and installed browser. A restrictive browser policy may require a configured TURN relay.


For the Netlify browser suite, build with `VITE_SESSION_TRANSPORT=polling bun run build`, start `bun run dev:netlify-harness` with `COMMON_TEST_DATABASE_URL` pointing to a disposable local Postgres instance, then run `BASE_URL=http://127.0.0.1:4173 bun run test:netlify-browser`. Configure a local TURN relay if your browser policy blocks direct UDP. The harness creates and removes its own isolated database schema.
