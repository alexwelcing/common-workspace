# Common releases

## 1.4.1 — 2026-10-18

A maintenance release for the spatial beta and portable module **0.4.1**.

- Separate starter templates from browser orchestration, name workspace/selection cancellation guards, and give board rendering, archive export, and history branching dedicated helpers.
- Expand dense history, storage, archive, view, and UI primitive code. Document causal replay, journal ownership, validation/rollback, personal view state, browser activation, and resource cleanup without changing formats, budgets, permissions, layout, or APIs.
- Add a maintainer guide with a source map, invariants, symptom-to-code troubleshooting, focused validation, and the app/module release checklist.

Verification compares the cleanup with the shipped behavior: core compiled output, ordered CSS rules, view transitions, and every template field/ID sequence are preserved. Existing real-browser journeys and focused history, archive, capture, keyboard, viewport, and cleanup walkthroughs provide release verification; no test cases, suites, or dependencies are added.

## 1.4.0 — 2026-10-18

Space & time beta ships as a separate opt-in experience in the app and portable module **0.4.0**. Open `?beta=space`; standard rooms retain their existing canvas.

- Edit ordinary flat boards in **Work**, or step outside with **Space**. Shared board positions and rotations use all three axes; camera and timeline positions stay personal.
- Changes create automatic revisions and autosave to IndexedDB. Explore a read-only past while teammates continue live, return to the present, or branch into a new local workspace with fresh identities. There is no manual save or named-moment workflow.
- A Loro WASM manifest and per-board documents synchronize content and history directly between peers. IndexedDB schema 2 appends small edit records and occasionally compacts them into full-history snapshots; earlier device storage upgrades automatically. Device saves report failures honestly, and same-installation tabs exchange updates and coordinate writes where supported. Ending a room leaves device archives intact.
- Export portable binary `.common` replays containing raw Loro history, CRC32 integrity checks, and optional built-in browser GZIP, avoiding JSON/base64 expansion. Earlier JSON archives still import. Export remains available if device autosave fails. Browser data removal or eviction can lose device copies. Canvas replay reconstructs structured edits; screen history preserves metadata, while past pixels need a separately downloaded recording.
- Start from current boards, Team walkthrough, Design review, or Open room, then customize boards and themes. **On this device** reopens saved branches and room history, including closed-room archives. Existing opt-in agents, snapshots, and recording tools work on the active flat board without new spatial or timeline commands.
- A compact workspace uses bookmark board tabs, one view capsule, a small floating tool dock, tucked-away palettes and room actions, and contextual history controls. Shared UI primitives own keyboard/focus behavior, viewport-aware surfaces, short cancelable motion, and reduced-motion support.
- Beta room metadata selects the correct experience for invitations and embedded `roomId` mounts. An additive hosted migration records the room experience; existing room files remain compatible. The separate beta is lazy-loaded and uses the existing Bun or Netlify room service.
- Current budgets are 64 board records, 1,000 object records per board, 16 MiB current board content, 12 MiB per history document, 40 MiB combined workspace history, and 64 MiB per archive. All board documents and history still replicate to every browser; selective loading and measured large-room capacity are future work.

Validation extends the existing five browser journeys with the beta peer, history, autosave, and archive flow. No new checked-in suites are added.

## 1.3.0 — 2026-10-18

Room styling is shared by the hosted app, local Bun rooms, and portable module **0.3.0**.

- Choose **Meadow**, **Rose**, **Lagoon**, or **Lavender** while creating a session, or use **Canvas options → Room style** afterward. Custom accent and canvas colors pair with dots, grid, or plain backgrounds; the editor previews changes before applying them.
- The host owns the room style. Authenticated updates synchronize to participants, late joins, and reloads through both WebSocket and hosted polling. Catch-up pages apply their canonical style once instead of replaying obsolete colors. Existing rooms default to Meadow, and personal Canvas style stays in browser-local storage.
- Interface colors remain readable when custom accents are very light or bright. Styling preserves existing object colors and never requests capture, changes agent grants, or edits canvas history.
- PNG snapshots, canvas recordings, and SVG exports reflect the room background. Floating and inline embeds keep their theme inside their own document and restore owned variables during teardown.
- Hosted hosts close their session as soon as End is acknowledged, preventing queued signaling from racing the final poll.
- Styles accept bounded preset/hex-color/pattern data rather than custom CSS or remote assets. An additive nullable `appearance` JSONB migration supports hosted persistence; local room files remain compatible. Handshakes advertise `roomStyling:1` for compatible controls.
- The development workflow now defaults to five real browser journeys with one build, readable step reports, screenshots, and native peer verification. Deeper concurrency/auth/cancellation checks remain explicit by scope. Redundant runners/builds were removed, and partial harness startup cleans up its disposable database schema.

Verification extends the existing five journeys for style creation, shared updates, host-only controls, reload persistence, and PNG background pixels. No new checked-in test cases or suites. Temporary color/contrast, export rasterization, persistence, authorization, and paged-polling probes supplement the relevant scoped checks.

## 1.2.0 — 2026-10-18

Mobile participation, touch navigation, and keyboard-aware layouts are included in the hosted app and portable Bun module **0.2.0**.

- Pinch to zoom around the two-finger midpoint and slide two fingers to pan. Converting a drag or drawing into navigation cancels the unfinished edit without broadcasting it or adding undo history. Remote updates remain intact. A single-finger edit commits on release.
- Pinching out of Focus keeps the current scale and opts into Explore. Mobile Focus hides the drawing and zoom palettes for an unobstructed presentation; Back restores them.
- Guided participants explicitly choose **Share a window** or **Watch & contribute**. Viewers can become ready by completing their manual tasks without approving capture. An optional window row continues to show actual capture status, and a viewer's real shared window can still be featured.
- The additive `guidedParticipation:1` capability enables the choice. Older servers keep their existing presenter flow. Mode changes affect only the authenticated participant, preserve progress, and use existing local/hosted persistence without a database migration.
- Capture capability is checked before asking. Unsupported browsers receive **Sharing help** and **Join without sharing**, without attempting an impossible browser picker. Participation never starts/stops capture or unpauses video.
- Main touch controls use 44px targets, phone text inputs avoid automatic focus zoom, and People/chat has a close control with focus return. Touch hints explain navigation and editing.
- The app follows the visible viewport and safe areas when browser chrome or the keyboard changes. Viewport observation batches updates, preserves accessibility zoom, and restores prior state on teardown. Floating module mounts observe the parent viewport independently; inline mounts stay in host layout.
- Updated local/module instructions describe touch navigation, viewer readiness, permissions, and mobile browser limits. No required service, account, relay, or new infrastructure is introduced.

Verification passed lint, all 232 existing checks with real Postgres, hosted and portable builds, manifest consistency, and standalone startup. Temporary native Chromium touch, responsive-layout, viewport/SDK lifecycle, and two-browser Postgres polling walkthroughs checked pinch cancellation, viewer readiness, persisted progress, chat, keyboard contraction, focus return, and unchanged host capture. No new checked-in test cases or suites. Physical-device keyboard, capture, and cross-device media behavior remain a team-device verification step.

## 1.1.0 — 2026-10-18

Common brings guided team sessions, an installable Bun module, and the canvas, chat, permissions, and reliability improvements from the complete release branch to `main`. The portable module is promoted from `0.1.0-embed.5` to `0.1.0`.

### Guided team sessions

- Start with **Team walkthrough**, **Weekly check-in**, or **Design review**, each with editable canvas prompts. **Open canvas** remains available for freeform sessions.
- Plan expected attendees and customize a personal checklist before creating the room. The Session guide shows waiting names, joined participants, window availability, and progress.
- Each participant chooses their planned name or joins as an additional participant, approves their own window share, and checks off their own tasks. Joined and window-sharing status are derived from the live session.
- The first approved host window becomes featured. Hosts use **Feature**, **Next window**, and **Feature my window** to rotate presentations in planned order.
- Viewers choose **Follow featured** or **Explore canvas** independently. Rotation preserves typing focus and paused video; following never starts capture or resumes a paused window.
- Planning supports 200 expected names and 12 manual checklist items. These bounds do not limit room admission. Names are self-selected labels, checkboxes are self-reported, and plans are configured before session creation.
- Local WebSocket and hosted polling sessions share authenticated checklist and feature state. Planned names and tasks are absent from unauthenticated room lookup.

### Embed Common in an existing Bun application

- Install the `common-workspace` **0.1.0** archive for an inline canvas or floating workspace.
- `common-workspace/bun` supplies `createCommon`; `common-workspace/client` supplies `mountCommon`. The package contains types, built frontend assets, bundled fonts and diagrams, the WASM geometry kernel, notices, and a runnable example, with no runtime npm dependencies.
- The host retains its HTTP listener, routes, WebSockets, and authentication. Common runs under a same-origin mount without another port and defaults to private networking and in-memory rooms. Explicit local persistence is optional.
- Mounts have independent identities and lifecycle state. Cancellation reaches pending agent calls; iframe reload rejects stale work; hiding preserves the session; destruction stops that mount's media, connections, and timers.
- The archive and SHA-256 checksum accompany the GitHub release. Source access requires permission to the private repository; administrators can distribute an archive directly. No package registry or cloud account is required to install an archive already provided.

### Canvas and collaboration

- **Focus** enlarges one object locally; **Back to canvas** or Escape restores the previous view. Snapshots and recordings respect Focus, while full-document export stays complete.
- Personal **Undo/Redo** reverses local actions while guarding newer peer field changes. Recovering a deletion creates a new-ID copy of its deletion snapshot. Live screens are excluded; history is bounded and stays in the current tab/session.
- Drop image batches at the pointer, select multiple files, or paste screenshots without clipboard-read access. Up to five images import as one undo action; imports finishing after a session change are discarded.
- Resize handles stay usable across zoom levels. Explicit **Edit**, keyboard movement/resizing, and layer shortcuts complement the existing shared layer ordering and position locks.
- Closing an untouched text or diagram editor preserves newer remote content. Deferred text rendering refreshes on exit. Multiple pointers cannot take over or end another pointer's active drag.

### Chat, permissions, and accessibility

- Chat preserves drafts, caret, keyboard focus, and reading position across incoming activity, reconnects, and panel switches. Enter sends; Shift + Enter adds a line; composition input is protected.
- Unread counts and a jump control let people read older messages without being scrolled away. Hidden mounts and covering dialogs preserve unread state.
- Sending retains a draft until its echo arrives. Uncertain delivery keeps the text without automatically retrying. Retrying identical text now resolves the current attempt correctly. Drafts are in-memory and reset on reload, room change, room end, or destruction.
- Screen sharing opens the native picker directly from a click. The visible sharing strip provides request/source status, audience, Stop, recording access, and specific browser/system/embedding recovery guidance. Abandoned requests cannot attach a late capture to another session.
- Agent scope and duration choices are staged until **Allow selected access** or **Update access**. Access expires, can be revoked, and remains separate from native screen approval and manual recording.
- Dialogs contain keyboard focus, make background controls inactive, restore the opener across replacements, and clean up on Escape. Destructive room confirmation starts on **Keep session open**.

### Reliability and quality

- Replacing a Bun connection retires old peer connections and obsolete captures before reconnecting the participant.
- Repeated or unsolicited WebRTC answers are ignored unless a local offer is outstanding, preventing a settled connection from raising a duplicate-answer warning. Valid renegotiation and ICE-restart answers continue through the same queue.
- Hosted authorization rechecks room/token expiry after asynchronous database reads; leave checks the current connection lease. Concurrent local room creation respects the existing storage budget, and malformed templates return readable validation errors.
- Polling recovers canonical checklist state across historical pages; recoverable claim conflicts keep the session connected.
- Session entry and ICE requests have deadlines through JSON body consumption. Teardown cancels pending bodies, and late create/join responses cannot switch the current session.
- Guide rendering uses indexed lookups and preserves unchanged attendee rows. Non-hosts do not build the hidden host roster. This improves UI work without claiming a supported large-room media capacity.
- Optional browser storage failures remain readable. Static assets stay confined to the mount, including symlinks. Failed module builds preserve the last usable output.
- Lint covers production frontend, SDK, backend, scripts, and the embedding example.
- Stable application tags build and publish the module archive, checksum, and notes through the existing GitHub Actions setup. Interrupted draft uploads can be retried; a published release is left unchanged.

### Existing platform capabilities included

This release retains the earlier work already on `main`: password-protected invite links without a fixed seat limit; sparse peer canvas synchronization; selective window watching; text, images, drawing, Mermaid and consented PlantUML diagrams; browser-agent commands and generated-image import; local snapshots and video recordings; laptop self-hosting; runtime network profiles; and sanitized connection diagnostics. Image generation uses the agent's own tools. Optional local FFmpeg conversion remains separately configurable.

Direct browser connections remain the default. No relay service, Cloudflare account, or additional network infrastructure is required for this release. Existing advanced network configuration stays optional. The local/module installation needs Bun; team window sharing over a LAN uses the documented HTTPS setup.

### Upgrade and data handling

- Hosted Git deployment uses the existing Netlify build and Functions setup. The additive migration `20261018000100_guided_sessions.sql` adds nullable room-plan and checklist JSONB columns and is applied by Netlify during deployment.
- Local installations continue using `bun install --frozen-lockfile` and `bun run local`; existing local room files remain compatible. Embedded consumers install the new archive and follow [the integration guide](https://github.com/alexwelcing/common-workspace/blob/v1.1.0/docs/embedding.md), also included as the module's README.
- The room service retains temporary access metadata, chat, guided plans, and checklists until expiry. Peer canvas content remains in participating browsers; recordings remain local until downloaded. This release adds no durable shared-content storage, invitation delivery, verified attendee identity, or automatic host handoff.

### Validation

The release branch passed expanded lint, all 232 existing checks, hosted and standalone builds, the generated-manifest check, local startup smoke, and independent module installation. Browser walkthroughs exercised real peer video, late join, checklist synchronization, leader rotation, chat typing and unread state, Focus/Explore/Pause, editor conflicts, pointer ownership, and slow-response cancellation. The production-shaped polling walkthrough used a real disposable Postgres database. SDK route isolation, iframe lifecycle, and a strict TypeScript consumer were checked independently. No new test cases or suites were added in the final review round.
