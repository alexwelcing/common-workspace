# Maintaining Common

Use this guide to find the code behind a behavior, understand the boundaries that keep rooms safe, and prepare a release. For a first contribution, start with [Contributing](../CONTRIBUTING.md).

## Find your starting point

Use Bun 1.4.3. From the repository root:

```sh
bun install --frozen-lockfile
bun run doctor
bun run dev
```

`doctor` explains local setup problems. `dev` starts Vite and the Bun API server for source development. To run Common for your team, follow [hosting and operations](hosting.md); to add it to an existing Bun app, use the [embedding guide](embedding.md).

Pick the boundary below, reproduce the behavior, and make the smallest useful change. Then use the [validation guide](validation.md) to choose a check and read its evidence. The [Space & Time guide](space-time.md) explains room controls, autosave, and replay from the user's perspective.

## Start at the boundary you are changing

| Area | Start here | Responsibility |
| --- | --- | --- |
| Experience selection and mount paths | [`src/entry.js`](../src/entry.js), [`src/app-path.js`](../src/app-path.js) | Choose the engine before loading it; resolve routes and storage keys beneath the current mount. |
| Classic canvas | [`src/main.js`](../src/main.js), [`src/shared-canvas.js`](../src/shared-canvas.js), [`src/peer-canvas.js`](../src/peer-canvas.js) | Classic UI, Yjs state, and peer document synchronization. |
| Space & Time orchestration and templates | [`src/spatial/main.js`](../src/spatial/main.js), [`src/spatial/templates.js`](../src/spatial/templates.js) | Connect the selected board, personal view, session, storage status, media, and agent model; keep starter content separate from browser lifecycle. |
| Space & Time document and history | [`src/spatial/store.js`](../src/spatial/store.js), [`src/spatial/projection.js`](../src/spatial/projection.js) | Loro documents, validated edits, causal history, synchronization, autosave, and accepted immutable presentation values. |
| Device persistence and replay files | [`src/spatial/storage.js`](../src/spatial/storage.js), [`src/spatial/archive.js`](../src/spatial/archive.js) | IndexedDB transactions/upgrades and the bounded binary/legacy archive codecs. |
| Space & Time presentation | [`src/spatial/view.js`](../src/spatial/view.js), [`src/spatial/style.css`](../src/spatial/style.css) | Render controls, board previews, timeline, and personal camera. Shared interaction helpers live in the [UI primitives](workspace-ui.md). |
| Browser performance | [`src/performance-index.js`](../src/performance-index.js), [`src/performance-panel.js`](../src/performance-panel.js) | Bounded local responsiveness evidence, operation budgets, workload context, and explicit report download; see the [performance guide](performance.md). |
| Room access and transport | [`src/spatial/session.js`](../src/spatial/session.js), [`src/session-transport.js`](../src/session-transport.js), [`lib/session-protocol.mjs`](../lib/session-protocol.mjs) | Admission, reconnects, signaling, and portable room validation. Adapters live in `cloudflare/worker.mjs`, `cloudflare/session.mjs`, and `lib/local-session.mjs`; `netlify/lib/api.mjs` is the legacy adapter. |
| Capture and agent consent | [`src/media.js`](../src/media.js), [`src/capture.js`](../src/capture.js), [`src/spatial/agent.js`](../src/spatial/agent.js) | Browser capture, recording, and selected-board agent permissions. |
| Embedding and packaging | [`sdk/client.js`](../sdk/client.js), [`sdk/bun.mjs`](../sdk/bun.mjs), [`scripts/build-module.mjs`](../scripts/build-module.mjs) | Host integration, owned-resource cleanup, and the self-contained module artifact. |

## Preserve these invariants

### Select one engine per room

Classic is the default. `?experience=space` and SDK `experience: 'space'` select a personal Space & Time workspace. For an existing room, resolve its metadata before initializing either engine: `room.experience` overrides query and SDK preferences.

Classic Yjs and Space & Time Loro documents are incompatible. Canvas rendering and peer/media infrastructure can be shared; document packets must reach the matching engine. Space & Time's server stores room metadata. Its canvas and history synchronize between peers.

Space & Time source lives under `src/spatial/`, including `createSpatialStore`, `mountSpatialView`, `SpatialSession`, and `installSpatialAgent`. Preserve these compatibility identifiers when changing presentation:

| Boundary | Identifier |
| --- | --- |
| Legacy entry alias | `?beta=space` |
| Wire experience | `spatial-beta` |
| Authentication keys | `common.beta.auth.*` |
| IndexedDB database | `common-spatial-beta` |

The stable promotion needs no new database or protocol migration. The public SDK's `'space'` preference is distinct from the wire value. Classic chat, guided participant checklists, and featured-screen rotation are not Space & Time interfaces.

Every connected Space & Time peer currently receives all board documents and history. A board-per-document design does not establish selective loading or a supported participant count.

### Keep personal navigation separate from shared edits

Selected history, camera, active board, and navigation mode belong to the viewer. Board poses, objects, and room appearance are document data. Viewing the past stays read-only while attached live documents keep receiving changes.

Bind agent grants and asynchronous edits to their original room, board, and selection generation. `workspaceGeneration` fences room/store work; `selectionGeneration` fences pending board-local edits.

### Make save status and replay truthful

Show “Saved on this device” only after a successful IndexedDB transaction. A render, peer send, or server response does not establish that save. Keep in-memory export available after a storage failure. Merge persisted edits before writing, retain operation history during compaction, and preserve the upgrade from version-1 device snapshots to schema-2 storage.

A screen object records identity and placement. Historical and ended-room views must not display a current stream as past content. Historical pixels require an explicit recording; replay export must not silently start one.

### Keep capture and agent permissions separate

Start window capture from the person's gesture, with no awaited preflight consuming that activation. HTTPS, browser/system permission, and an embedding parent's Permissions Policy still apply. Agent consent cannot grant browser capture permission or survive a room, board, or history switch. Stop any late capture result from an abandoned request.

### Validate before publishing state

Local edits, peer input, saved data, and archive imports all cross validation boundaries. Keep resource checks and rollback together. The current limits are:

| Resource | Limit |
| --- | --- |
| Board records | 64 |
| Entity records per board | 1,000 |
| Current board content | 16 MiB |
| History per document | 12 MiB |
| Aggregate history | 40 MiB |
| Archive | 64 MiB |

These budgets measure different representations. Review the other budgets and packet/storage bounds when changing one. The archive reader accepts `CSPACE02` binary replays and earlier JSON archives. CRC detects damage; it does not establish sender authenticity.

`store.state()` returns fresh mutable data. Internal `store.projection()` values are deeply frozen and reuse unchanged entity and board references. Advance or invalidate those values only after accepting a change. Rejected input and rolled-back edits must never become published presentation state.

### Finish work and release owned resources

Finish text and gesture groups, then await `flush()` before replacing a store. Reject stale asynchronous results through generation checks.

Teardown must release owned timers, requests, listeners, observers, animations, object URLs, streams, connections, IndexedDB handles, and Loro/WASM documents. The SDK stops Common-owned resources; the host retains its listener. Hiding an embedded panel and destroying it have different lifecycles. Admission survives reload; explicit leave revokes it.

## Keep spatial presentation caches at their boundary

When changing rendering or store performance, start in `src/spatial/projection.js`. It materializes accepted state for the Space & Time UI. `store.projection()` reuses unchanged entities, object arrays, and boards so one object edit does not require rebuilding the whole room. Values are read-only all the way down, including drawing points. Public APIs that promise editable copies must keep using independent `store.state()` snapshots.

Keep these responsibilities together:

- **The store accepts changes.** Only the store advances the projection after validation succeeds. Native Loro diffs identify affected room metadata, boards, or entities; an unresolved path falls back to a bounded document read. Local edits, peer input, and storage merges share this boundary. Complete validation and rollback before publication or callbacks. Diff hints tell the renderer what to refresh; they do not validate an edit.
- **The store owns history caches.** Historical presentation shares the existing eight-entry `pastCache`. Public historical `state()` reads copy those values. Accepted edits invalidate historical caches, including grouped actions that extend an existing revision. Keep historical views separate from live documents and current screen pixels. A replacement store or imported archive owns new caches: destroy the old store's caches and reset render comparisons when the room, board, or selected history source changes. Do not add a second cache of whole historical rooms.
- **The renderer reconciles optimistic changes.** It compares accepted references and tracks local optimistic changes separately. Reconcile dirty entities even when the accepted reference is unchanged: rejected or no-op writes may need to restore a prior value. Preserve pending gestures and text drafts. Read-only and ended-room transitions also require reconciliation.
- **Previews trust only the projection contract.** The module's projection brand proves deep immutability. Ordinary mutable input needs the content-sensitive fallback; freezing an array alone does not freeze its children.

## Investigate a reported problem

Start with the visible error and reproduce in a synthetic room. Preserve a device archive before clearing storage. Do not request passwords, tokens, raw signaling payloads, recordings, or canvas content for routine diagnostics.

| Symptom | Inspect first |
| --- | --- |
| Wrong experience opens, or an embedded route/WASM asset fails | `src/entry.js`, `src/app-path.js`, server/browser `basePath`, static routing, and room metadata. A query string must not override a known room's experience. |
| “Not saved,” autosave failure, or storage upgrade blocked | The save indicator, `store.js` status/flush path, IndexedDB transaction errors in `storage.js`, browser quota, and older open tabs. Export before reloading or deleting site data. |
| Peers join but canvas edits or video do not arrive | Admission/connection status in `session.js`, the selected adapter, native peer state in `media.js`, and data-channel callbacks. Check actual device/network connectivity; HTTP success alone does not prove a peer route. |
| History changes when live edits arrive, or past screens show current pixels | Causal selection and historical forks in `store.js`; facade/stream switching and generation guards in `main.js`; historical screen rendering in `board.js` and `capture.js`. |
| Capture picker does not open, or a stopped request returns a stream | The original click path, `browser-permissions.js`, `media.js`, secure context, host Permissions Policy, and capture cancellation/generation checks. |
| Agent writes continue after switching or revoking | Session identity and refresh/revocation in `spatial/agent.js`, `agent-api.js`, and pending capture/command cancellation. |
| Menus trap focus, clip on a phone, or remain active after unmount | View cleanup and `src/ui/workspace-primitives.js`; modal interaction, hidden/inert state, visual viewport placement, reduced motion, and destroyed listeners. |
| Slow input, drawing, navigation, or replay work | **Canvas options → Performance** or Space & Time **Room → Performance**. Compare signal coverage, operation p95/max/count/failures, and workload in the same scene. Likely contributors are clues, not causal proof; async storage/request waiting alone does not establish UI blocking. Follow the [performance guide](performance.md) before changing budgets or adding hooks. |
| A `.common` file fails to open | `archive.js` header/length/compression/CRC validation, then `store.js` document/schema/resource validation. Retain legacy import compatibility. |
| Hosted-only failure | API status/error code, request ID, `cloudflare/worker.mjs`, `cloudflare/session.mjs`, Wrangler bindings/migrations, and Worker logs. For legacy Netlify, inspect its adapter, SQL migrations, and deploy logs. See [request diagnostics](hosting.md#runtime-and-reliability-diagnostics); do not assume Space & Time has the classic canvas's diagnostics menu. |

## Validate the affected behavior

For application behavior changes, start with `bun run check`. It runs lint, builds once, and runs the existing five desktop/phone journeys against a disposable Bun app. The fifth includes native peer media and Space & Time shared edits, placement, autosave/reload, read-only history, and archive export. Read the first failing checkpoint and `artifacts/check/` evidence before rerunning. Use `--skip-build` only while application source is unchanged. Prose-only edits need a review of their links and instructions; see [validation](validation.md).

For Cloudflare adapter changes, run `bun run check:cloudflare --browser`; CI includes that native Worker/Durable Object check. Also run the default Bun check when shared behavior changes. The legacy `bun run check --all-adapters` covers Bun and Netlify only and requires `COMMON_TEST_DATABASE_URL` set to a **disposable** Postgres database. Never use a production database. Missing native peer connectivity is an incomplete check, not a reason to replace it with simulated success.

Run existing deep checks only where needed:

| Changed boundary | Command |
| --- | --- |
| Classic document merging, ordering, or topology | `bun run check:deep canvas` |
| Admission/protocol | `bun run check:deep sessions` plus `bun run check:cloudflare --browser` |
| Legacy Netlify transactions | `bun run check:deep hosted` |
| Capture, video, or recording | `bun run check:deep media` |
| Agent access and cancellation | `bun run check:deep agents` |
| Startup, configuration, or request diagnostics | `bun run check:deep runtime` |

The deep canvas scope is not exhaustive Space & Time history coverage. For Space & Time changes, also follow the short two-profile flow in the [Space & Time guide](space-time.md#current-boundaries), including export/import and live edits while viewing the past.

For UI changes, check keyboard entry and dismissal, phone layout, reduced motion, and unmount cleanup. System capture permission and physical-device behavior need the [real-device walkthrough](validation.md#a-short-real-device-check). Extend an existing journey for a demonstrated regression; avoid adding suites that repeat private implementation details. The [validation guide](validation.md) explains setup, reports, hosted runs, and the full list of existing scopes.

## Prepare and verify a release

### 1. Prepare versions and the diff

Update `package.json` for the application release and `module/package.json` for a changed distributed module. Keep `CHANGELOG.md`, release links, and archive filenames in the README, embedding guide, and Bun example consistent. The application tag is `v<application version>`; the module has its own version.

Review the diff and pass the relevant checks. Verify `public/agent-tools.json` matches its source: builds generate that public schema, so commit intentional changes. Validate each affected hosting adapter before merging changes that span them.

### 2. Verify the packaged module

Run `bun run pack:module`. It rebuilds the complete module and writes `artifacts/common-workspace-<module version>.tgz` plus its SHA-256 file.

Install that archive into a fresh Bun consumer. Exercise the included example, mount prefix, Space & Time room routing, and `await canvas.destroy()` / `await common.close()` cleanup. A source-checkout run does not verify packaged assets.

### 3. Review the deployment

Review the Cloudflare Workers Build for the intended commit. It installs the frozen Bun lockfile, builds `dist/`, and deploys through `wrangler.jsonc`. Review Durable Object binding and migration changes in source; keep existing migration tags stable. A successful frontend build alone does not verify the room backend.

After merging, confirm production's deploy commit and Worker version, `/api/health` reporting `platform: "cloudflare"`, and `/api/config` selecting polling. Correlate `X-Common-Build` with Worker version metadata or the configured build ID. Run a fresh two-profile room at the production origin, including shared edits, chat, reconnect, and peer video. A new deployment does not import legacy Netlify rooms or origin-specific browser storage; follow the [migration notes](hosting.md#moving-from-netlify).

The Netlify adapter and its committed SQL migrations remain for compatibility/rollback. Validate its separate deploy and database only when operating that legacy path.

### 4. Publish and verify the release artifact

Tag the verified application commit and push the stable tag. `.github/workflows/release.yml` verifies the tag against `package.json`, lints, rebuilds and packs the module, checks the generated manifest and checksum, and publishes the release assets. It does not run the five journeys.

Download the published archive and checksum, verify them, and check installation from that artifact. Keep published assets unchanged; publish a new version when contents change.
