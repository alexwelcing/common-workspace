# Common

A browser workspace for password-protected team sessions: invite links, a shared canvas, text, sticky notes, images, shapes, freehand drawing, Mermaid and PlantUML diagrams, chat, presence, simultaneous window sharing, and shared layer controls.

WebAssembly runs the canvas geometry kernel for grid snapping and drawing simplification. The interface is JavaScript, with a JavaScript geometry fallback. Yjs synchronizes canvas content directly between browsers over WebRTC data channels. Netlify Functions and a small Postgres database handle temporary room access, presence, chat, and connection signaling; a standalone Bun server is also included for local or self-hosted use.

## Deploy to Netlify

Import this repository from GitHub into your Netlify team. The committed `netlify.toml` pins Bun 1.4.3, builds the Vite/WASM frontend, publishes `dist`, bundles the API function, and enables the browser's HTTP polling transport. Functions run on Node.js 22; they do not require a persistent Bun process or a separate WebSocket host.

`@netlify/database` and the committed SQL migrations provision the small room database during deployment. Netlify Database requires a credit-based plan; this setup does not change your account plan. If the team's plan does not support it, enable a supported database plan before importing. No canvas objects, images, or screen recordings are stored in the database.

Configure a production TURN relay under **Project configuration → Environment variables**, scoped to Functions: `TURN_URLS` plus `TURN_SECRET`, or `TURN_USERNAME` and `TURN_CREDENTIAL`. These are server secrets; never prefix them with `VITE_`. Without a relay, STUN-only connections can be used for a pilot, but some network combinations will not connect. No production relay is included in this repository.

After the first deploy, open the HTTPS site in two separate browser profiles, create a room, join its invite link, and check shared objects, chat, and each person's window capture. Verify the operating system picker and the networks your team actually uses before wider use. Ten simultaneous screen shares have not been load-tested.

For local Netlify development, authenticate the Netlify CLI, link the project, run `bun run dev:netlify`, then apply local migrations in a second terminal with `bunx netlify-cli@26.0.0 database migrations apply`. Netlify applies the committed migrations automatically on hosted deploys. The regular `bun run dev` below uses the standalone Bun/WebSocket backend.

## Run locally

Use Bun 1.4.3 (the pinned version in `package.json`).

```sh
bun install --frozen-lockfile
bun run dev
```

Open http://localhost:5173. The development script starts Vite and the API server together under Bun. Start a session, choose your display name and a password of at least eight characters, then share the generated link and password separately. Use another browser profile or a private window to test a second participant.

To run the built app:

```sh
bun install --frozen-lockfile
bun run build
bun run start
```

Open http://localhost:3001. The server serves `dist/` and the API on the same port. `bun run test` runs the automated checks. See [API.md](API.md) for the collaboration protocol.

## Sharing and collaboration

- A session holds up to ten connected or reserved participants, including its host. The server enforces this cap; ten concurrent video streams have not been load-tested.
- Each participant can share one selected window or screen at a time. The browser requires a click and its native capture picker. An operating system window cannot be dragged directly into a web page to grant capture access. Image files can be dropped onto the canvas.
- Screen sharing is video-only. It shares pixels; annotations are canvas objects. It does not provide remote control of another participant's computer.
- New rooms use Yjs with a shared map for each object property. Reordering an object merges with another person’s resize or text change. Concurrent changes to the same property resolve deterministically. Five-second state-vector checks repair missed updates; the canvas does not promise offline editing.
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

The app uses a WebRTC mesh: participants exchange Yjs canvas updates and video with their peers. Reliable ordered data channels split large canvas updates into 16 KiB frames with backpressure and bounded queues. Upload bandwidth and browser CPU grow with room size. Public STUN servers are configured by default. Provide a TURN relay for restrictive firewalls and NATs; STUN alone cannot guarantee connectivity. TURN credentials are returned only after room-token authentication. Prefer `TURN_SECRET` matching your coturn `static-auth-secret` with `use-auth-secret`: the server generates expiring credentials per participant and keeps the shared secret private. With static relay credentials, use a dedicated, restricted account and rotate credentials. The browser refreshes cached ICE settings before connection restarts. Measure bandwidth and CPU before expanding beyond small team rooms.

### Docker

```sh
docker build -t common .
docker run --name common -p 3001:3001 -v common-data:/data common
```

To configure TURN or an origin allowlist, pass the relevant environment variables with Docker's `--env-file` or `-e` options. The image sets `DATA_FILE=/data/rooms.json`; preserve that location when mounting the data volume. Terminate TLS at the hosting platform or reverse proxy.

## Scope and limits

Room creation is open to visitors; there is no separate administrator account, identity provider, invitation allowlist, or host recovery flow. The creator's browser holds the host access token in session storage. Room metadata can be looked up by its opaque room ID; participation requires a password-derived session token. Passwords are hashed with scrypt and are not included in room URLs. On Netlify, rooms expire after 24 hours, presence leases last two minutes, and unconnected seat reservations last one minute. Reloading preserves the participant identity and host access; explicitly leaving revokes that token. Expired room rows are physically cleaned up on a subsequent room creation. The standalone Bun service retains its original seven-day room lifetime.

Before a public rollout, assess your deployment's capacity, access requirements, backup policy, TURN capacity, proxy rate limits, and monitoring. Test actual screen capture, network recovery, and multiple real browsers on the networks your team uses.

## Verified in this workspace

The production build and 64 automated checks pass under Bun 1.4.3, including ten integration checks against real PostgreSQL. They cover transactional admission, access control, ordered signaling, lease expiry, cleanup, TURN credential expiry, polling recovery, peer transport, Yjs synchronization, concurrent layer edits, and size limits. Database integration tests skip when `COMMON_TEST_DATABASE_URL` is not set; the GitHub workflow provides a disposable Postgres service and runs all 64.

The Netlify adapter passes 12 browser checks across three Chromium profiles, using its production frontend and the actual Function handler against PostgreSQL: passwords, chat, layer ordering, shared move/resize/lock, late joining, reload recovery with the same identity, and two simultaneous real WebRTC streams decoded by peers. Six peer links connected through a local TURN TCP relay. The test confirms no application WebSocket connections, no HTTP canvas writes, empty server canvas snapshots, and no uncaught browser errors. This verifies the adapter locally; it does not claim a deployed Netlify site or production network verification.

The standalone Bun backend also passed the earlier 13-check browser smoke suite and nine-check layering suite, including a 338 KB image transferred in chunks. Screen-capture tests use synthetic canvas capture sources over real WebRTC. The native operating system picker and ten simultaneous shares still need device and network testing.

To run the optional browser suite, start the app, install Playwright and Chromium in your test environment, then run `bun run test:browser`. `BASE_URL`, `PLAYWRIGHT_MODULE`, and `CHROMIUM_PATH` can select your running server and installed browser. A restrictive browser policy may require a configured TURN relay.


For the Netlify browser suite, build with `VITE_SESSION_TRANSPORT=polling bun run build`, start `bun run dev:netlify-harness` with `COMMON_TEST_DATABASE_URL` pointing to a disposable local Postgres instance, then run `BASE_URL=http://127.0.0.1:4173 bun run test:netlify-browser`. Configure a local TURN relay if your browser policy blocks direct UDP. The harness creates and removes its own isolated database schema.
