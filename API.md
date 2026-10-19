# Common session API

The standalone Vite client proxies `/api` and `/ws` to port 3001. Standalone production runs `bun server.mjs` and serves `dist/`. Netlify uses the same room REST paths with a polling transport, described below. JSON errors use `{error,code}`. Passwords must contain 8–128 characters; names 1–60. There is no fixed participant admission cap; authentication, rate, payload, lease, canvas, and hosting resource limits still apply. Room links use `/room/:id`.

## Netlify transport

The browser reads `/api/config` before opening a session. Netlify returns `transport:'polling'`; the standalone Bun server returns `'websocket'`, so the same frontend build works on either host. The modern Function at `/api/*` uses Postgres for room access, membership leases, chat, guided-session metadata and ordered signaling events. It accepts peer rooms only; public room metadata includes `collaboration:'peer',transport:'poll'`. Every canvas initialization has `entities:[]`; canvas writes return `409 PEER_CANVAS`.

Room creation, join, metadata, saved-session validation, and ICE configuration follow the REST shapes below. `GET /api/health` checks database availability; Netlify's CDN may answer it for up to 15 seconds. `GET /api/ice` without a `room` parameter returns the profile's STUN configuration without credentials. Room creation and joining run as separate Functions with Netlify rate limits of 15 creates and 30 joins per visitor IP per minute; excess requests receive `429` before reaching the database. Authenticated ICE configuration includes `expiresAt` in epoch milliseconds when using expiring TURN credentials.

After obtaining a room token:

1. `POST /api/rooms/:id/connect` with Bearer authorization and JSON `{}` returns `{init,cursor,connectionId,rosterVersion,capabilities}`. `init` has the same canvas/session envelope as the standalone socket. Top-level capabilities include `{protocolVersion:1,transport:'poll',guidedSessions:1,guidedParticipation:1,roomStyling:1,targetedEvents:true,signalIdempotency:true}`; `init.capabilities` contains the first five fields. Reconnecting preserves the participant's identity and host role, while replacing any older connection.
2. `GET /api/rooms/:id/events?after=CURSOR&delivery=targeted-v1&rosterVersion=VERSION` with Bearer authorization and `X-Common-Connection: connectionId` returns `{events:[{sequence,message}],cursor,hasMore,rosterVersion,appearance,participants?}`. Use targeted delivery only when advertised. Unchanged rosters omit `participants`; retain the last roster. Clients without a roster version receive the full list. Deliver messages in order, then apply the top-level canonical `appearance` after every page, and save the returned decimal-string cursor; it skips irrelevant events without skipping undelivered visible ones. The canonical appearance shares the event batch's database snapshot and prevents historical style events in later catch-up pages from restoring an old style. Batches contain at most 64 visible events or 512 KiB of payload, except that a first single event is allowed. `hasMore:true` requires an immediate catch-up poll. Normal polling is every second while active, every 3 seconds once selected canvas neighbors are linked and the room is idle, and every 15 seconds while hidden. Activity returns visible polling to 1 second for 10 seconds.
3. `POST /api/rooms/:id/messages` with the same authorization and connection header sends a JSON message envelope from the list below: `signal`, `chat`, `cursor`, `workshop`, `ping`, or host-only `appearance` and `end`. Signals can only target active participants in the same room. With advertised `signalIdempotency`, a signal may include `requestId` matching `[A-Za-z0-9_-]{8,100}`. Identical retries within the same member/connection produce one retained event; different payloads with that key return `409 REQUEST_ID_REUSED`. Keys last with the ten-minute event history. The client retries eligible signals at most twice after network/5xx failures; it does not retry chat automatically. Sends are serialized, cursor requests coalesced to one per second, and requests limited to 128 KiB.
4. `POST /api/rooms/:id/leave` with the same headers and `{}` explicitly revokes that participant's token and removes its active presence. A reload only stops polling; it preserves the token. Undelivered leaves expire through the presence lease.

Room writes lock the room row to serialize admission and allocate event sequence numbers. There is no participant-count admission check. Polling reads without that lock and renews the lease at most every 30 seconds. A scheduled Function runs every minute to remove expired rooms, expired events and stale connections; connects and room creation also clean up, because scheduled Functions only run on the published deploy. Connected presence expires after a two-minute lease without polling or accepted activity. Initial admission leases last one minute before the first connection; they do not reserve seats. An expired presence lease requires `/connect` with a valid token to become active again. Tokens last 24 hours and are renewed on connect; room expiry remains 24 hours from creation. Event history expires after ten minutes; an outdated cursor returns `409 RESYNC_REQUIRED`, requiring reconnect. Replaced connections return `409 CONNECTION_REPLACED`; expired tokens return `401 SESSION_EXPIRED`. Ending a room immediately denies further admission and lets active pollers receive `ended`.

## Standalone Bun transport

Use `bun run local` to build and start the private local profile, or build with `bun run build:local` and start with `bun run start` using your own environment. `/api/config` selects WebSocket transport at runtime regardless of the build's inherited transport setting. The [self-hosting guide](public/self-hosting.html) covers the launcher, diagnostics, a shared LAN/VPN HTTPS origin, and Caddy.

* `POST /api/rooms` with `{name,displayName,password,collaboration?:'peer'|'server',appearance?:{...},workshop?:{...}}` returns `{room,token,participantId,isAdmin:true,workshop?}` (201). New browser sessions request `collaboration:'peer'`. Omitted mode defaults to `server` for existing clients. Other values return 400 `INVALID_COLLABORATION`. Peer room metadata is `{id,name,createdAt,appearance,collaboration:'peer'}`; legacy/server metadata is `{id,name,createdAt,appearance}`. The mode is fixed when the room is created and appears consistently in room, join, session, and socket initialization responses. The optional appearance and guided-session fields are described below; room creation accepts at most 64 KiB of JSON.
* `GET /api/rooms/:id` returns `{room:{id,name,createdAt,appearance,...}}` (404 after end). Appearance is public presentation metadata, including before admission.
* `GET /api/rooms/:id/session` with `Authorization: Bearer TOKEN` validates saved/reconnecting credentials and returns `{room,participantId,isAdmin,displayName,workshop?}`. Returns 401 for expired/revoked tokens, 404 if the room ended. Validate after unexpected WebSocket handshake failure; browsers hide the handshake HTTP status and report close code 1006.
* `POST /api/rooms/:id/join` with `{displayName,password}` returns the creation authentication shape, with `isAdmin:false` (200). Keep the token and participant identity scoped to the room; the browser client uses sessionStorage and excludes the workshop plan from that saved authentication record. Password stays out of the URL and storage.
* `GET /api/ice` returns the active profile's STUN configuration without credentials. `GET /api/ice?room=ID` with `Authorization: Bearer TOKEN` also returns configured TURN credentials to authenticated room participants. Configure `TURN_URLS` and `TURN_SECRET` for time-limited coturn-compatible HMAC credentials (`TURN_TTL_SECONDS`, default 3600, bounds 60–86400). Alternatively set `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` for a dedicated static account. Never distribute the shared secret to browsers.
* Open `ws(s)://HOST/ws?room=ROOM_ID&token=TOKEN`. Tokens last 24 hours and are renewed on a successful connection. Each participant has one socket (new connection replaces the old one). No seat reservation or participant-count admission check is involved; heartbeat cleanup removes dead sockets, while valid tokens permit reconnecting.

All socket messages are JSON objects. Server sends an initial `{type:'init', room, self:{id,name,color,isAdmin,checklist?}, workshop?, participants:[...], entities:[...], chat:[...], capabilities:{protocolVersion:1,transport:'websocket',guidedSessions:1,guidedParticipation:1,roomStyling:1}}`. `room.appearance` holds the canonical room style. `participants` entries are `{id,name,color,isAdmin,checklist?}`. Server then broadcasts `{type:'participants',participants:[...]}` on presence changes. Both adapters share admission/chat/signal/cursor validation and session policy from `lib/session-protocol.mjs`.

## Space & Time admission

Create a Space & Time room with `POST /api/rooms` and the compatibility wire value `experience:'spatial-beta'`. These rooms always use peer collaboration: omitted `collaboration` selects `peer` on both adapters, while an explicit non-peer mode returns `400 INVALID_COLLABORATION`. An unsupported non-null experience returns `400 INVALID_EXPERIENCE`. Omitted or `null` experience creates an ordinary room with its existing collaboration defaults and response shape.

For Space & Time rooms, every public room lookup, authenticated create/join/session response, and connection initialization includes `room.experience:'spatial-beta'`. Ordinary rooms omit the field. The browser uses this metadata to select the correct experience, overriding query or SDK preferences. Classic remains the default for a personal workspace. This field selects the document experience; it grants no identity, host privilege, or capture permission. Password, token, room-expiry, and connection checks are unchanged. The room experience is fixed at creation, and no message can change it.

Standalone Bun persists the marker in its configured room file. Netlify stores it in nullable `common_rooms.experience`, added by `20261018000300_spatial_beta_rooms.sql`; existing rows stay ordinary. Spatial documents and automatic history remain in participating browsers rather than the admission database. The backend continues to provide room admission, presence, signaling, chat, and room styles, and rejects server canvas writes in peer rooms.

## Room appearance

Both transports advertise `roomStyling:1`. Clients should offer shared room styling only when this capability is present. Creation accepts an optional `appearance` object; all room snapshots include the canonical value:

```json
{
  "preset": "meadow",
  "accent": "#365d49",
  "canvas": "#fbf8f0",
  "pattern": "dots"
}
```

`preset` is `meadow`, `rose`, `lagoon`, or `lavender`. Missing fields use that preset's defaults; omitted or `null` appearance uses Meadow. Each preset defaults to `dots`. Accent/canvas defaults are Meadow `#365d49` / `#fbf8f0`, Rose `#94566b` / `#fbf3f3`, Lagoon `#2c6975` / `#f0f7f6`, and Lavender `#735d91` / `#f6f3fa`. Custom `accent` and `canvas` override the preset and must be six-digit hex colors; they are returned lowercase. `pattern` is `dots`, `grid`, or `plain`. Unknown fields, unsupported values, arrays, and wrong types return `400 INVALID_ROOM_APPEARANCE`; arbitrary CSS, images, and URLs are not accepted.

The authenticated host can send `{type:'appearance',appearance:{...}}`. The appearance field is required; `null` resets it to Meadow. This replaces the entire room style, using preset defaults for omitted fields rather than merging with the previous style. Guests receive `403 FORBIDDEN`, even if they supply a different identity or host role. Accepted updates broadcast `{type:'appearance',appearance:{...}}` to everyone, including the host, and are included in reconnect initialization and admission responses. Apply polling's top-level `appearance` after ordered events on every catch-up page. Role, capture permissions, media, canvas entities, and object colors are unaffected.

Standalone Bun saves appearance in its configured room file; old or invalid persisted styles safely restore Meadow. Netlify stores it in nullable `common_rooms.appearance` JSONB, added by `20261018000200_room_appearance.sql`. Existing rows with `NULL` appear as Meadow. Room expiry and metadata retention are unchanged.

## Guided-session protocol

Both transports advertise `guidedSessions:1` and `guidedParticipation:1` in their session capabilities, including for ordinary rooms. Clients should only offer shared viewer/presenter selection when `guidedParticipation:1` is advertised; older servers keep their existing guided checklist behavior. Add `workshop` to a room-creation request to create a guided session:

```json
{
  "name": "Product walkthrough",
  "displayName": "Alex",
  "password": "a-room-password",
  "collaboration": "peer",
  "workshop": {
    "template": "team-walkthrough",
    "attendees": [{ "id": "sam", "name": "Sam Chen" }],
    "tasks": [{ "id": "ready", "label": "Ready for my turn" }]
  }
}
```

`template` must be `team-walkthrough`, `weekly-check-in`, or `design-review`. `attendees` defaults to `[]` and accepts at most 200 entries. `tasks` defaults to the chosen template's server-defined checklist and accepts 1–12 entries when supplied. Attendee IDs must be unique within the attendee list, and task IDs within the task list; each ID matches `[A-Za-z0-9_-]{1,100}`. Names are trimmed nonempty strings of at most 60 characters; task labels are trimmed nonempty strings of at most 160 characters. Invalid plans return `400 INVALID_WORKSHOP`. These are planning bounds, with no participant admission cap or restriction to listed names. IDs are application labels, and claiming a name does not verify identity. Omit `workshop`, or set it to `null`, for an ordinary canvas; guided state fields are then absent.

The server normalizes the plan to `{template,attendees,tasks,featuredParticipantId:null}`. A supplied initial featured ID is ignored. Authenticated creation, join, and saved-session responses include this snapshot as a top-level `workshop` field. Initialization includes the current snapshot plus `checklist:{slotId:null,completed:[],participation:'presenter'}` on each `self`/`participants` entry, updated with that member's state. Completed task IDs are returned in plan order. `participation` is `presenter` or `viewer`, defaulting to `presenter` for new members and persisted checklists that predate this field. Plain `GET /api/rooms/:id` never includes the plan, checklist, expected names, or task labels, even if authorization is supplied; room credentials are required through the authenticated routes. All admitted participants can see the shared plan and connected members' progress.

Send guided actions through the existing authenticated WebSocket or polling `/messages` route:

| Client message | Effect |
| --- | --- |
| `{type:'workshop',action:'claim',slotId:'sam'}` | Assigns that planned attendee label to the authenticated sender. `slotId:null` releases the claim and joins as an additional participant. The sender's completed tasks are retained when changing or releasing their own claim. |
| `{type:'workshop',action:'complete',taskId:'ready',completed:true}` | Adds or removes a task from the sender's checklist; `completed` must be a boolean. No other participant's checklist can be selected through this action. |
| `{type:'workshop',action:'participation',mode:'viewer'}` | Sets the sender's participation to `viewer` or `presenter`, retaining their claimed label and completed tasks. Viewer participation makes the UI's live-window checklist item optional; it does not change identity, host role, canvas access, or media state. |
| `{type:'workshop',action:'feature',participantId:'PARTICIPANT_ID'}` | Host only: sets the featured connected participant, or clears the selection with `participantId:null`. The ID is a live participant ID, not a planned attendee ID. |

Identity and role come from the connection/token; extra participant or host fields cannot redirect a claim, completion, or participation choice, or grant host privileges. The room plan itself is fixed at creation; there is no plan-edit action. The UI's automatic Joined and live-window indicators derive from presence and screen state; they are not manual checklist task IDs.

An accepted claim/completion/participation change broadcasts `{type:'checklist',id:PARTICIPANT_ID,checklist:{slotId,completed,participation}}` to the room, including the sender. Polling checklist events also contain `rosterVersion` and increment the canonical roster version. A feature change broadcasts `{type:'workshop',workshop:{...}}`. Reconnecting receives current state in initialization. For polling, process events in sequence and then apply any top-level `participants` snapshot; catch-up pages can carry older checklist/presence events, so a returned canonical roster must replace their earlier roster state even when its version was previously seen.

An active member's claimed slot cannot be taken. Reclaiming an inactive member's slot clears that old member's claim and completed tasks while preserving both members' participation choices, with checklist events for affected members. A disconnect, leave, or expired presence clears an unavailable featured participant when the adapter processes that presence change. Feature selection validates active membership, not live video: stopping capture alone does not clear the selected person. The browser chooses which known screen to display, and each viewer controls following, exploring, and paused subscriptions. Changing participation never starts or stops a capture or a video subscription. A server feature event cannot open a capture picker, start another person's share, or force a viewer to watch.

Guided action errors use the regular socket error envelope or HTTP `{error,code}`:

| Status / code | Meaning |
| --- | --- |
| `409 NO_WORKSHOP` | The room has no guided plan. |
| `409 RESYNC_REQUIRED` | The sender is no longer active; reconnect before updating. |
| `400 INVALID_WORKSHOP_SLOT` | The claimed slot does not exist. |
| `409 WORKSHOP_SLOT_TAKEN` | Another active participant holds the claim. |
| `400 INVALID_WORKSHOP_TASK` | The task is unknown or `completed` is not boolean. |
| `400 INVALID_WORKSHOP_PARTICIPATION` | The participation mode is neither `viewer` nor `presenter`. |
| `403 FORBIDDEN` | A non-host tried to change the featured person. |
| `409 WORKSHOP_MEMBER_UNAVAILABLE` | The feature target is not an active member. |
| `400 INVALID_WORKSHOP_ACTION` | The guided action is unsupported. |

Claim conflicts and unavailable targets are recoverable without disconnecting; choose a different slot/target and keep the existing session. Normal token, room-expiry, and connection-replacement checks still apply. Guided actions do not use signal request-id deduplication.

Netlify stores the plan and member checklists in the nullable `common_rooms.workshop` and `common_members.checklist` JSONB columns, added by `20261018000100_guided_sessions.sql`, until their room/member records expire or are removed. Standalone Bun includes them in its configured room file; the embeddable adapter defaults to memory unless `dataFile` is explicitly configured. No additional service is needed. This metadata does not persist peer canvas objects or video: canvas retention still requires a connected browser holding the document. Template canvas prompts are seeded by the creating browser, rather than returned as server canvas entities.

## Public runtime configuration

`GET /api/config` returns `{version:1,protocolVersion:1,transport,networkProfile,buildId,rtc:{iceServers,iceTransportPolicy,hasTurn},plantUml:{enabled,endpoint}}`. Transport is `websocket` or `polling`; the protocol's capability envelope uses `poll` for polling sessions. Public `iceServers` contain STUN URLs only. Shared TURN secrets, relay credentials, room passwords, and tokens are not exposed by this endpoint.

`COMMON_NETWORK_PROFILE=private` removes default public STUN and PlantUML services. The local launcher selects this profile unless overridden; bare servers and hosted deployments default to `standard`. `STUN_URLS` overrides STUN URLs, with `none` disabling them. `PLANTUML_URL` explicitly chooses a renderer, with `none` disabling it. `ICE_TRANSPORT_POLICY=relay` restricts ICE to relay routes and requires configured TURN. Fonts and Mermaid are bundled locally. If startup configuration cannot be read, external services remain disabled; do not infer a working room connection from an offline personal canvas.

For peer rooms, `entities` is always empty. Canvas objects, layer order, position locks, geometry, and screen-tile metadata are synchronized between admitted browsers as a Yjs document over WebRTC data channels. The server accepts no canvas upserts or deletes, stores no canvas snapshot, and never restores canvas data for peer rooms. A late joiner obtains the document from connected peers. When no browser retains that live document, a later admission starts with an empty canvas. Password admission, host authorization, presence, WebRTC signaling, chat, and TURN credential issuance still use this rendezvous server. Room credentials/metadata and chat retain the existing server persistence behavior. Screen metadata cleanup follows peer presence in the browser.

## Browser routing and video subscriptions

`src/peer-topology.js` chooses canvas neighbors from the union of three stable deterministic hash rings. Every participant links to its predecessor and successor in each ring, with duplicates removed: at most six canvas neighbors per browser. The same roster produces symmetric edges. Yjs updates are forwarded to other open neighbors, excluding the sender; five-second state-vector exchanges request missing state. This spreads canvas changes across the connected overlay without requiring a full mesh or backend canvas writes. Connectivity still depends on working WebRTC edges, and partitions can delay convergence until links recover.

Video subscriptions are separate from canvas neighbor selection. `ScreenSharing.setSubscriptions(ids)` selects screen-owner IDs to watch. The frontend defaults to up to four remote windows on desktop and two on small devices, and pauses incoming subscriptions while its tab is hidden. **Watch window** and **Pause view** affect only that browser; they do not stop the owner's capture or mutate the shared screen object. Video may add direct peer connections beyond the six canvas neighbors. A presenter sends a stream to each actual viewer, so its upload and encoding work grow with viewer count.

Every browser still replicates the full canvas. Local editing checks a 1000-object limit and 16 MiB materialized-content budget, rather than sharding content; concurrent peer edits can exceed those local budgets. Hosted polling omits unchanged rosters and targets events, but roster changes still carry a full room list and signaling/chat still use Postgres transactions and HTTP polling. Removing the admission cap and bounding canvas degree does not establish a supported room size or video audience. Synthetic 100-peer convergence and 1000-ID topology tests are routing/model checks, not real-browser or media load tests.

Further scale work includes interest regions or document/awareness sharding, incremental roster deltas and less room-wide presence work, and an optional SFU for large video audiences. No SFU server or turnkey integration is included. It needs a reachable server outside participants' browsers. Restrictive NATs or firewalls can still require a configured TURN relay even when canvas routing is sparse.

`PollingSessionTransport.diagnostics()` exposes `queuedMessages`, `queueAgeMs`, `pollFailures`, `lastPollMs`, `pollCount`, and `eventsReceived`. `getDiagnostics()` also supplies aggregate counters. The optional constructor callback `onDiagnostic(type, values)` reports allowlisted `poll`, `queue`, and `connection` measurements/states, without contents or credentials. These do not prove media connectivity. **Canvas options → Connection details** offers the combined sanitized report and JSON download.

## Correlation and optional observability

Both hosting adapters emit `X-Common-Request-Id`, `X-Common-Build`, `X-Common-Protocol`, and `traceparent`. `COMMON_LOG_DIAGNOSTICS=1` enables redacted JSON summaries containing route category, method/status, duration, build/protocol and generated correlation IDs. Logs exclude actual paths/queries, room IDs, bodies, canvas data, credentials, and raw error details.

`COMMON_OTLP_ENDPOINT` optionally exports these spans to a full HTTP(S) OTLP traces endpoint; `COMMON_OTLP_TOKEN` supplies a server-side Bearer token. Export is bounded by `COMMON_OTLP_TIMEOUT_MS` (default 500 ms, range 25–750 ms) and collector failure does not fail the room request. Logging and export are off by default and need no Cloudflare service.

## Session messages

Text in `text`, `sticky`, `rectangle`, and `ellipse` objects automatically fits the shared `width` and `height` in both browser experiences. Fitting preserves raw text and geometry; resizing the box controls the visual text size. The legacy `fontSize` field remains accepted and stored for compatibility but does not control fitted text size.

Client → server:

* `{type:'upsert',entity}` is available in server rooms only. The entity is `{id,type,x,y,width,height,...}`. Type is `text`, `sticky`, `rectangle`, `ellipse`, `arrow`, `draw`, `image`, `diagram`, or `screen`. Allowed fields: `text`, `color`, `fill`, `fontSize`, `points:[{x,y}]`, `url` (image data URL only), `source`, `language:'mermaid'|'plantuml'`, `externalConsent` (boolean, defaults false), `participantId` (screen must match sender), `title`, `streamId`, `screenId`, `z`, `orderKey` (1–200 ASCII letters/digits), and `locked` (boolean). `orderKey` carries fractional layer ordering; `locked` prevents accidental position/size edits in the interface and is not an authorization boundary. Server adds `updatedBy` and `updatedAt`. Each screen has one stream and optional screenId. Coordinates may range −100000…100000; positive width/height ≤10000. Max image ~2 MB base64; max text/source 20000 characters. Peer rooms return `PEER_CANVAS` without accepting the entity.
* `{type:'delete',id}` removes an entity in server rooms only. Only the screen owner can edit a screen; its owner or the host can remove it. Any participant can edit board content. Peer rooms return `PEER_CANVAS`, even if the ID is unknown.
* `{type:'cursor',x,y}` → other clients receive `{type:'cursor',participantId,x,y}`.
* `{type:'signal',to,data}` → target in the same room receives `{type:'signal',from,data}`. `data` is an opaque WebRTC offer/answer/ICE payload; `{description}` or `{candidate}` is recommended. Never trust participant IDs supplied in payloads.
* `{type:'chat',text}` → all receive `{type:'chat',message:{id,participantId,name,text,createdAt}}`.
* `{type:'end'}` (host only) → all receive `{type:'ended'}` and sockets close. Room and board are deleted.
* `{type:'leave'}` revokes this token and closes the connection; the host leaving does not end the room.
* `{type:'ping'}` → `{type:'pong'}`.

In server rooms, the server broadcasts accepted `{type:'upsert',entity}` and `{type:'delete',id}` to **all**, including sender. Errors on socket use `{type:'error',error,code}` in both modes. Server-room screen entities are ephemeral and removed on disconnect; other server-room entities and both modes' chat persist in `data/rooms.json`. Password hashes and token hashes are private server data. Abrupt disconnect updates presence in both modes and emits screen deletions in server rooms. Server-room incoming canvas changes use server receive order (last change wins per entity); peer rooms converge through Yjs instead.

Browser screen sharing requires HTTPS (localhost allowed), an explicit user click, and the browser picker. A browser cannot accept an operating system window by drag and drop; the share button opens the picker. This API carries signaling, not media; media travels over WebRTC and TURN when configured.
