# Hosting and operating Common

Run Common on a laptop for a local team, keep a standalone Bun server behind HTTPS,
or deploy the same frontend to Cloudflare Workers. This guide covers the settings, storage,
and network behavior behind those choices. For step-by-step laptop setup, start
with the [self-hosting guide](../public/self-hosting.html).
For an existing Bun application, use the [embedding guide](embedding.md).

## Run on your own laptop

Use Bun 1.4.3 (the pinned version in `package.json`). Clone this repository using an account with read access, or unpack a source archive supplied by your administrator. This is currently a private repository; public access to the hosted app does not grant source access.

The [self-hosting guide](../public/self-hosting.html), available from **How it works → Run Common on your own laptop**, covers installation, team networking, HTTPS, and data handling. It is also served at `/self-hosting.html` on each local installation.

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

`build:local` remains a compatibility build command. The served `/api/config` now determines transport and network policy, so you can move the built frontend between standalone and Cloudflare hosting without rebuilding it for a different transport. Bare `bun run start` uses your environment settings; set `COMMON_NETWORK_PROFILE=private` in `.env` for the organization's private profile.

Open http://localhost:3001. The server serves `dist/` and the API on the same port. See [API.md](../API.md) for the collaboration protocol.

### Invite teammates over LAN or VPN

One laptop runs Bun and Caddy; the other participants only need a browser. Install Caddy, choose a stable LAN/VPN address, and start:

```sh
bun run local --https --origin https://192.168.1.50:8443
```

Use your host's reachable address instead of the example IP. The launcher writes its Caddy configuration under `data/local`, uses port `8443` by default, and exports the public root certificate as `common-local-root.crt`. Every participant must trust that authority through their organization's certificate process, or use an organization-issued TLS certificate instead. It does not automatically install trust. See the guide for the manual [Caddy configuration](../public/self-hosting/Caddyfile) and certificate steps.

Everyone, including the host, opens the same address, for example `https://192.168.1.50:8443`, **before creating the room**. Share its generated link and password separately. `localhost` on a teammate's laptop refers to that teammate's own machine; separate Bun servers create separate room stores. Keep the host awake and both processes running. Permit the HTTPS port and browser-to-browser WebRTC connections through the LAN/VPN; a working web page alone does not prove peer connectivity.

Fonts are bundled, and the private profile uses no default external STUN or PlantUML service. You can explicitly configure organization STUN/TURN or a diagram renderer. The standard profile retains public Google/Cloudflare STUN and the consented public PlantUML renderer; Mermaid stays local. Installation still needs dependencies, and private hosting does not overcome blocked peer connections. The guide explains the network boundaries and optional services.

## Deploy to Cloudflare

The primary hosted address is [commonwork.aw-ab5.workers.dev](https://commonwork.aw-ab5.workers.dev/). The committed `wrangler.jsonc` deploys `cloudflare/worker.mjs`, serves `dist/` through Worker Static Assets, and binds SQLite-backed `CommonRoom` and `CommonAdmission` Durable Objects. API routes run before asset routing. The frontend reads `/api/config` and uses the existing HTTP polling protocol; no persistent Bun server, Postgres service, or Netlify runtime credential is needed.

Each room has its own Durable Object for password admission, token hashes, presence, chat, and signaling. `CommonAdmission` provides the global room budget and IP-based create/join gates. The bindings and initial SQLite migration are versioned in Wrangler configuration. Keep migration tags stable and add a new migration when changing Durable Object classes; deployment configuration is not a room-data import.

### Connect GitHub Workers Builds

Connect this repository to a Cloudflare Worker and select `main` as the production branch. Use the repository root and these settings:

| Setting | Value |
| --- | --- |
| Build command | `bun install --frozen-lockfile && bun run build` |
| Deploy command | `bunx wrangler deploy` |
| `BUN_VERSION` | `1.4.3` |
| `SKIP_DEPENDENCY_INSTALL` | `1` |

Dependency installation is explicit in the build command so the committed Bun lockfile is used. Wrangler is pinned in the repository. Workers Builds supplies its deployment authentication; runtime secrets belong on the Worker, not in the frontend build or Git history. For a local deploy from an authenticated Cloudflare account:

```sh
bun install --frozen-lockfile
bun run build
bun run deploy:cloudflare
```

Configure optional network variables from the [runtime settings](#standalone-bun-hosting) as Worker variables. Put credentials such as `TURN_SECRET`, `TURN_CREDENTIAL`, and `COMMON_OTLP_TOKEN` in Worker secrets using the dashboard or `bunx wrangler secret put NAME`. Never prefix secrets with `VITE_`. `public/_headers` supplies static-asset response headers; API responses receive their headers in the Worker. `COMMON_VERSION` exposes the deployed Worker version for request diagnostics, with an optional `COMMON_BUILD_ID` override.

### Develop and verify the Worker

```sh
bun run build
bun run dev:cloudflare
```

Wrangler runs the native Worker, Static Assets, and local SQLite-backed Durable Objects. This is a separate local room store; it does not inspect production rooms. Use `bun run check:cloudflare` for the native API/storage check and `bun run check:cloudflare --browser` to include the desktop/phone journeys. The regular `bun run dev` still uses the standalone Bun/WebSocket backend. See [validation](validation.md) for the adapter boundaries.

After deploying, confirm the intended Worker version, `/api/health` reporting `platform: "cloudflare"`, and `/api/config` selecting polling. Then open the HTTPS site in two separate browser profiles, create a room, join its invite link, and check shared objects, chat, each person's window capture, and Watch/Pause controls. Verify the operating system picker and the networks and devices your team actually uses before wider use. A healthy API does not prove peer media works or establish a supported room size.

The default deployment connects browsers directly and requires no separate relay service. Standard mode uses public STUN to discover possible peer routes; STUN does not forward canvas content or video. Use **Connection details** to investigate a connection that fails on an actual device before configuring a relay.

### Moving from Netlify

The Cloudflare and Netlify backends have separate room stores. Existing Netlify room IDs, passwords, and access tokens do not by themselves create a room on Cloudflare, and no automatic import is provided. Keep an active session on its original origin until participants finish; create new rooms on the Cloudflare address. Browser storage is also origin-specific: export Space & Time work as a `.common` archive from its original origin and import it at the new one. Download retained recordings before closing their tab. Do not treat deployment or a changed link as evidence that old sessions or local work migrated.

### Legacy Netlify compatibility and rollback

The Netlify adapter remains in `netlify/`, with `netlify.toml` and SQL migrations, for compatibility checks and rollback. It uses Functions on Node.js 22 and `@netlify/database` Postgres; it is not part of the Cloudflare runtime. Its database and deployment history remain separate, so rolling back to that adapter does not carry Cloudflare rooms with it.

For an existing Netlify project, the committed configuration builds `dist/`, bundles the API and cleanup functions, and applies committed migrations. Netlify Database requires a supported credit-based plan. For local compatibility work, authenticate the Netlify CLI, link that project, run `bun run dev:netlify`, and apply local migrations in a second terminal with `bunx netlify-cli@26.0.0 database migrations apply`. Keep platform credentials out of the Cloudflare runtime. The [legacy adapter checks](validation.md#legacy-netlify-compatibility) use a disposable Postgres schema without Netlify credentials.

## Standalone Bun hosting

Run one long-lived Bun instance behind an HTTPS reverse proxy. Forward both HTTP and WebSocket traffic, preserve the request `Host`, and allow WebSocket upgrades on `/ws`. Public screen sharing needs HTTPS; browsers also permit localhost for development. A static-only hosting plan cannot run the session server.

Room state defaults to `data/rooms.json`. Give the process a writable, persistent volume and back it up as appropriate. This file contains room metadata, password hashes, hashed access tokens, and chat. Only older rooms also store their canvas and images there; new peer rooms reject server canvas writes and return empty server snapshots. Live screens are neither recorded nor persisted. Persistence is debounced, so abrupt process termination can lose the most recent changes. The in-memory server and JSON storage support one server instance, not horizontal replicas.

Environment variables are listed in [.env.example](../.env.example). Bun automatically loads a local `.env` file. In hosted environments, set variables through your provider. For local settings:

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

## Runtime and reliability diagnostics

Open **Canvas options → Connection details** to see the effective profile/build, connected canvas neighbors, watched windows, queued bytes, and configured relay status. **Download connection report** saves counts, connection states, and generated request IDs for correlation, without room IDs, canvas content, credentials, or recordings.

Open **Canvas options → Performance**, or **Room → Performance** in Space & Time, for a local responsiveness index, measured work, and workload context. Measurements stay in the browser; reports download only when requested. See the [performance guide](performance.md) for coverage, interpretation, and comparing changes.

`/api/config` identifies the effective transport, profile, protocol, and build; `/api/health` checks the hosting adapter's health. The public configuration contains STUN settings and a TURN-availability flag, never credentials. The hosting adapters share protocol validation and network policy. Hosted polling delivers targeted batches, skips unchanged rosters, catches up immediately when more events remain, and retries only idempotent signaling when the server advertises support. Chat is not retried automatically.

### Request logs and traces

Responses include `X-Common-Request-Id`, `X-Common-Build`, `X-Common-Protocol`, and `traceparent` for correlation. Diagnostics are off by default. Set `COMMON_LOG_DIAGNOSTICS=1` for redacted JSON with route category, method, status, duration, build/protocol, and generated IDs. It omits room IDs, URLs/queries, message bodies, canvas content, and credentials.

For an organization OpenTelemetry collector, set `COMMON_OTLP_ENDPOINT` to its full HTTP(S) traces URL, such as `http://127.0.0.1:4318/v1/traces`. `COMMON_OTLP_TOKEN` is an optional server-side Bearer secret. Export waits at most `COMMON_OTLP_TIMEOUT_MS` (default 500 ms; bounded to 25–750 ms); collector failures do not fail a room request. A separate observability account is not required. Use the guide's short two-browser walkthrough to confirm actual peer video and capture on your devices.

### Peer connections and video

Canvas routing uses the union of three deterministic hash rings. Each browser connects to its predecessor and successor in each ring, yielding at most six canvas neighbors rather than a room-wide mesh. Yjs updates are forwarded across those links, excluding their source; five-second state-vector exchanges repair missed updates. Reliable ordered data channels split large updates into 16 KiB frames with backpressure and bounded queues. A consistent roster gives browsers the same routing choices, and membership changes replace affected neighboring edges.

Video subscriptions are independent of canvas routing. The media layer's `setSubscriptions(ids)` selects the screen owners whose video this browser receives. A watched screen can require an additional direct connection even when its owner is not a canvas neighbor. Pausing remote video leaves the canvas links active. A presenter still uploads a separate stream to each actual viewer, so presenter upload and encoding work grow with the number of viewers.

Direct WebRTC is the default path for canvas and video; the private profile has no public STUN or media relay dependency. Firewalls, NATs, or VPN policy can prevent direct connections even when the page loads. Use connection reports and the actual network configuration to investigate such a failure. A relay is an optional deployment setting, not a requirement to run Common.

### An optional organization relay

If your organization chooses a TURN relay, set `TURN_URLS` plus `TURN_SECRET`, or `TURN_USERNAME` and `TURN_CREDENTIAL`, in the server environment. On Cloudflare, use Worker secrets for credentials; on legacy Netlify, scope them to Functions. Never prefix secrets with `VITE_`. Credentials are returned only after room-token authentication and never appear in public runtime configuration. With coturn REST authentication, match `TURN_SECRET` to `static-auth-secret` with `use-auth-secret` so the server generates expiring credentials; static credentials should use a dedicated, restricted account. The browser refreshes cached ICE settings before connection restarts. Common does not operate a relay service.

## Docker

```sh
docker build -t common .
docker run --name common -p 3001:3001 -v common-data:/data common
```

To customize network policy or an origin allowlist, pass the relevant environment variables with Docker's `--env-file` or `-e` options. The image sets `DATA_FILE=/data/rooms.json`; preserve that location when mounting the data volume. Terminate TLS at the hosting platform or reverse proxy.

## Scope and limits

### Room access and lifetime

Room creation is open to visitors; there is no separate administrator account, identity provider, invitation allowlist, or host recovery flow. The creator's browser holds the host access token in session storage. Room metadata can be looked up by its opaque room ID; participation requires a password-derived session token. Passwords are hashed with scrypt and are not included in room URLs.

On Cloudflare, rooms expire after 24 hours, connected presence leases last two minutes, and an initial admission lease lasts one minute before connecting. These leases track connection activity; they do not reserve seats. An expired presence lease requires reconnecting with a still-valid token. Connecting renews the 24-hour token lifetime, while the room's expiry remains unchanged. Reloading preserves the participant identity and host access; explicitly leaving revokes that token. Durable Object alarms and request-time cleanup remove expired room data. Password hashing retains the Node-compatible scrypt format used by the existing adapters; this does not make their room stores interchangeable.

The admission object permits at most 1000 live room reservations globally, with per-IP limits of 15 creates and 30 joins per minute. Events are retained for up to ten minutes; delivery batches are bounded to 64 events and 512 KiB. A reconnect can require a fresh roster and peer synchronization. These controls are service protections, not a participant cap or measured capacity promise.

The standalone Bun service retains its seven-day room lifetime and refreshes token expiry on a WebSocket connection.

### Capacity and growth

Sparse routing bounds each browser's canvas neighbors, but every browser still receives and stores the full shared document. Local edits are constrained by a 1000-object limit and a 16 MiB materialized-content budget; concurrent peer changes can exceed local budgets, so they are not a global memory guarantee. Yjs history and decoded images add overhead. Hosted delivery omits unchanged rosters and irrelevant signals, but roster changes, presence, chat fan-out, and Durable Object/polling work still grow with usage. Backend room serialization and rate/resource limits remain relevant. There is no measured room-size or simultaneous-video capacity guarantee.

Larger canvases need interest regions or document/awareness sharding, so devices receive relevant content. Larger rooms need incremental roster deltas and less room-wide presence work beyond today's omission of unchanged rosters. A large audience may need a separately operated SFU to receive one upstream presenter stream and forward it. Common does not include that server or a turnkey integration. These remain further development steps.

Before a public rollout, assess your deployment's capacity, access requirements, backup policy, proxy rate limits, and monitoring. Check actual screen capture, network recovery, and multiple real browsers on the networks your team uses. No separate relay service is required for this release.

## How the pieces fit

WebAssembly runs the canvas geometry kernel for grid snapping and drawing simplification. The interface is JavaScript, with a JavaScript geometry fallback. Yjs synchronizes standard canvas content directly between browsers over a sparse WebRTC network. Video connections are selected separately, so joining a room does not require receiving everyone's screen. The standalone Bun server handles temporary room access, presence, chat, and connection signaling on your own machine. Cloudflare Workers uses one SQLite-backed Durable Object per room for those same tasks, with a separate admission object for global controls. The legacy Netlify adapter uses Functions and Postgres. The frontend reads `/api/config` at startup, so the same built files select the local WebSocket or hosted polling transport at runtime.

## Development and troubleshooting

Run `bun run doctor`, then `bun run local` for a fresh build and a private local server. Use `bun run dev` while changing the source, or `bun run build` when you only need the deployable frontend. The same artifact uses `/api/config` to select its hosting transport; no transport-specific rebuild is needed.

For code boundaries, lifecycle and data invariants, troubleshooting, and the release checklist, see the [maintainer guide](maintaining.md).

Classic and Space & Time use shared, framework-free [workspace UI primitives](workspace-ui.md) for shape, motion, keyboard behavior, and lifecycle cleanup.

Use `bun run check` for the default quality check: one build and five real desktop/phone journeys, with the failing step, readable report, and screenshots if something breaks. It starts and cleans up its own temporary local app. Existing Chrome/Chromium works; otherwise install a browser once with `bunx playwright-core install chromium`. Deeper checks are explicit, such as `bun run check:deep canvas` or `bun run check:deep hosted`. See [the validation guide](validation.md) for setup, hosted checks, failure evidence, and the short real-device walkthrough. `bun run test` runs the same lean default.

Follow the [two-browser walkthrough](../public/self-hosting.html#smoke-test) on the devices and network you plan to use. Confirm shared edits, actual window frames, reconnect behavior, and a downloaded recording. For a problem, open **Canvas options → Connection details** and download its report, then use the guide's [troubleshooting steps](../public/self-hosting.html#troubleshooting). The report includes counts, states, and generated request IDs for correlation, without room IDs, canvas content, credentials, or recordings.
