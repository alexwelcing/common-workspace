# Common releases

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
