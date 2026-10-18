# Maintaining Common

This guide is for changing and supporting the code. Use the [spatial beta guide](spatial-beta.md) for room controls, autosave, and replay behavior; [embedding](embedding.md) for the supported Bun/SDK interface; and [validation](validation.md) for running checks and reading their evidence.

## Start at the boundary you are changing

| Area | Start here | Responsibility |
| --- | --- | --- |
| Experience selection and mount paths | [`src/entry.js`](../src/entry.js), [`src/app-path.js`](../src/app-path.js) | Choose the engine before loading it; resolve routes and storage keys beneath the current mount. |
| Standard canvas | [`src/main.js`](../src/main.js), [`src/shared-canvas.js`](../src/shared-canvas.js), [`src/peer-canvas.js`](../src/peer-canvas.js) | Standard UI, Yjs state, and peer document synchronization. |
| Beta orchestration and templates | [`src/beta/main.js`](../src/beta/main.js), [`src/beta/templates.js`](../src/beta/templates.js) | Connect the selected board, personal view, session, storage status, media, and agent model; keep starter content separate from browser lifecycle. |
| Beta document and history | [`src/beta/store.js`](../src/beta/store.js) | Loro manifest/board documents, validated edits, causal history, branches, synchronization, and autosave scheduling. |
| Device persistence and replay files | [`src/beta/storage.js`](../src/beta/storage.js), [`src/beta/archive.js`](../src/beta/archive.js) | IndexedDB transactions/upgrades and the bounded binary/legacy archive codecs. |
| Beta presentation | [`src/beta/view.js`](../src/beta/view.js), [`src/beta/style.css`](../src/beta/style.css) | Render controls, board previews, timeline, and personal camera. Shared interaction helpers live in the [UI primitives](workspace-ui.md). |
| Room access and transport | [`src/beta/session.js`](../src/beta/session.js), [`src/session-transport.js`](../src/session-transport.js), [`lib/session-protocol.mjs`](../lib/session-protocol.mjs) | Admission, reconnects, signaling, and portable room validation. Adapters live in `lib/local-session.mjs` and `netlify/lib/api.mjs`. |
| Capture and agent consent | [`src/media.js`](../src/media.js), [`src/capture.js`](../src/capture.js), [`src/beta/agent.js`](../src/beta/agent.js) | Browser capture, recording, and selected-board agent permissions. |
| Embedding and packaging | [`sdk/client.js`](../sdk/client.js), [`sdk/bun.mjs`](../sdk/bun.mjs), [`scripts/build-module.mjs`](../scripts/build-module.mjs) | Host integration, owned-resource cleanup, and the self-contained module artifact. |

## Preserve these invariants

- **Select one engine per room.** The server's `room.experience` is authoritative for invitations; a query parameter is only a personal entry point. Standard Yjs and beta Loro documents are incompatible. Reuse canvas rendering and peer/media infrastructure without feeding one engine's packets into the other. Beta rooms use peer collaboration; their server stores room metadata, not the spatial canvas or its history.
- **Separate personal views from shared edits.** Selected history, camera, active board, and navigation mode belong to the viewer. Board poses, objects, and room appearance are document data. Viewing the past must remain read-only while the attached live documents keep receiving changes. Agent grants and asynchronous edits must stay bound to their original room, board, and selection generation. `workspaceGeneration` fences room/store work; `selectionGeneration` fences pending board-local edits.
- **Report persistence truthfully.** “Saved on this device” follows a successful IndexedDB transaction, not a render, a peer send, or a server response. Storage failure keeps in-memory export available. Merge persisted edits before writing; compaction retains operation history rather than trimming it. Keep the upgrade path from version-1 device snapshots to schema-2 storage.
- **Keep replay and video distinct.** A screen object records identity and placement, not historical pixels. Historical and ended-room views must not display a current stream as past content. Pixel capture requires an explicit recording; replay export must not silently start one.
- **Keep permissions separate.** Window capture must begin from the person's gesture, with no awaited preflight consuming that activation. HTTPS, browser/system permission, and an embedding parent's Permissions Policy still apply. Agent consent cannot grant browser capture permission or survive a room/board/history switch. Stop any late capture result from an abandoned request.
- **Validate before publishing state.** Local edits, peer input, saved data, and archive imports all cross validation boundaries. Keep resource checks and rollback behavior together: currently 64 board records, 1,000 entity records per board, 16 MiB current board content, 12 MiB history per document, 40 MiB aggregate history, and a 64 MiB archive limit. These budgets measure different representations. Changing one requires reviewing the others and the packet/storage bounds. The archive reader accepts `CSPACE02` binary replays and earlier JSON archives; CRC detects damage, not sender authenticity.
- **Release only resources you own.** Finish text/gesture groups and await `flush()` before replacing a store. Generation checks must reject stale asynchronous results. Teardown must release timers, requests, listeners, observers, animations, object URLs, streams, connections, IndexedDB handles, and Loro/WASM documents. The SDK stops Common-owned resources while the host retains its listener; hiding an embedded panel differs from destroying it. Admission survives reload, while explicit leave revokes it.

Every connected beta peer currently receives all board documents and history. A board-per-document design does not establish selective loading or a supported participant count.

## Investigate a reported problem

Start with the visible error and reproduce in a synthetic room. Preserve a device archive before clearing storage. Do not request passwords, tokens, raw signaling payloads, recordings, or canvas content for routine diagnostics.

| Symptom | Inspect first |
| --- | --- |
| Wrong experience opens, or an embedded route/WASM asset fails | `src/entry.js`, `src/app-path.js`, server/browser `basePath`, static routing, and room metadata. A query string must not override a known room's experience. |
| “Not saved,” autosave failure, or storage upgrade blocked | The save indicator, `store.js` status/flush path, IndexedDB transaction errors in `storage.js`, browser quota, and older open tabs. Export before reloading or deleting site data. |
| Peers join but canvas edits or video do not arrive | Admission/connection status in `session.js`, the selected adapter, native peer state in `media.js`, and data-channel callbacks. Check actual device/network connectivity; HTTP success alone does not prove a peer route. |
| History changes when live edits arrive, or past screens show current pixels | Causal selection and historical forks in `store.js`; facade/stream switching and generation guards in `main.js`; historical screen rendering in `board.js` and `capture.js`. |
| Capture picker does not open, or a stopped request returns a stream | The original click path, `browser-permissions.js`, `media.js`, secure context, host Permissions Policy, and capture cancellation/generation checks. |
| Agent writes continue after switching or revoking | Session identity and refresh/revocation in `beta/agent.js`, `agent-api.js`, and pending capture/command cancellation. |
| Menus trap focus, clip on a phone, or remain active after unmount | View cleanup and `src/ui/workspace-primitives.js`; modal interaction, hidden/inert state, visual viewport placement, reduced motion, and destroyed listeners. |
| A `.common` file fails to open | `archive.js` header/length/compression/CRC validation, then `store.js` document/schema/resource validation. Retain legacy import compatibility. |
| Hosted-only failure | API status/error code, request ID, `netlify/lib/api.mjs`, committed migrations, and deploy logs. Existing request diagnostics are described in the README; do not assume the beta has the standard canvas's diagnostics menu. |

## Validate the affected behavior

Use Bun 1.4.3 and `bun install --frozen-lockfile`. `bun run check` runs lint, builds once, and runs the existing five desktop/phone journeys against a disposable Bun app. The fifth includes native peer media and the beta's shared edits, placement, autosave/reload, read-only history, and archive export. Read the first failing checkpoint and `artifacts/check/` evidence before rerunning. `--skip-build` is only for unchanged application source.

For adapter changes, set `COMMON_TEST_DATABASE_URL` to a **disposable** Postgres database and run `bun run check --all-adapters`; CI does the same. Never use a production database. Missing native peer connectivity is an incomplete check, not a reason to replace it with simulated success.

Run existing deep checks only where needed:

| Changed boundary | Command |
| --- | --- |
| Classic document merging, ordering, or topology | `bun run check:deep canvas` |
| Admission/protocol and hosted transactions | `bun run check:deep sessions hosted` |
| Capture, video, or recording | `bun run check:deep media` |
| Agent access and cancellation | `bun run check:deep agents` |
| Startup, configuration, or request diagnostics | `bun run check:deep runtime` |

The deep canvas scope is not exhaustive beta history coverage. For beta changes, also follow the short two-profile flow in the [beta guide](spatial-beta.md#current-boundaries), including export/import and live edits while viewing the past. For UI changes, check keyboard entry/dismissal, phone layout, reduced motion, and unmount cleanup. System capture permission and physical-device behavior need the [real-device walkthrough](validation.md#a-short-real-device-check). Extend an existing journey for a demonstrated regression; avoid adding suites that repeat private implementation details.

## Prepare and verify a release

1. Update `package.json` for the application release and `module/package.json` for a changed distributed module. Keep `CHANGELOG.md`, release links, and archive filenames in the README, embedding guide, and Bun example consistent. The application tag is `v<application version>`; the module has its own version.
2. Review the diff, pass the relevant checks, and verify `public/agent-tools.json` matches its source. Builds generate that public schema; commit intentional changes. Validate both adapters before merging changes that span them.
3. Run `bun run pack:module`. It rebuilds the complete module and writes `artifacts/common-workspace-<module version>.tgz` plus its SHA-256 file. Install that archive into a fresh Bun consumer and exercise the included example, mount prefix, beta room routing, and `await canvas.destroy()` / `await common.close()` cleanup. Source-checkout success does not verify packaged assets.
4. Review the Netlify Deploy Preview for the intended commit. Netlify uses `netlify.toml` to build `dist/`; committed migrations apply through deployment. Review additive migrations in source rather than making production-only schema changes. After merging, confirm production's deploy commit, migration result, and `/api/health`; correlate `X-Common-Build` with the configured commit/deploy ID.
5. Tag the verified application commit and push the stable tag. `.github/workflows/release.yml` verifies the tag against `package.json`, lints, rebuilds/packs the module, checks the generated manifest and checksum, and publishes the release assets. It does not run the five journeys. Download the published archive and checksum, verify them, and check installation from that artifact. Do not replace assets on an already published release; publish a new version for changed contents.
