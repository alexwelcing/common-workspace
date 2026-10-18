# Check the experience, investigate the cause

The default check is five user journeys through the built app, rather than hundreds of helper assertions. It uses separate desktop and phone browsers, real HTTP/WebSocket connections, native WebRTC, and the same frontend shipped to users. There is no coverage percentage or minimum test count to maintain.

```sh
bun install --frozen-lockfile
bun run check
```

An installed Chrome/Chromium works; use `CHROMIUM_PATH` for another executable. If you do not have a browser, install it once with `bunx playwright-core install chromium`. The check command never downloads a browser or starts Docker. Playwright Core is a development dependency, with no additional test framework.

The command checks setup before building, runs lint, builds once, and starts its own temporary loopback server. It creates only synthetic rooms and ends them, then stops its processes and removes their local data. It does not connect to your running app or Netlify deployment. `bun run test` is a compatibility alias for the same command.

The five journeys cover:

1. Write a note on the actual WASM canvas, edit it, and undo the edit.
2. Create a guided room, reject a wrong password, and let a phone join and complete its checklist without requesting capture.
3. Exchange chat, reload with the same participant and progress, and navigate the phone canvas.
4. Reject agent writes before consent, permit an annotation after a visible grant, download a PNG, and reject writes after revocation.
5. Synchronize actual peer edits and layer changes, decode remote video, stop capture, and end the room so its former credentials stop working.

Capture uses a generated canvas instead of a native source picker. The data channels, signaling, and video decoding remain native. A browser that cannot establish its native peer connection fails the check; earlier successful steps are retained as partial evidence, rather than treating missing media as success. This command needs a machine that permits local peer networking. It does not add a relay to make a restricted environment pass.

## Read a failure

The terminal names the journey and checkpoint that failed. Its report path points to the expected behavior, elapsed time, browser/runtime errors, endpoint/status summaries, and screenshots. Build and server logs accompany the report under `artifacts/check/run-…/`. Password fields and invite links are masked in browser screenshots; tokens, request bodies, storage dumps, raw SDP, and traces are not written. Artifacts contain synthetic check content, not a copy of an existing room.

There are no automatic retries. Fix the reported cause, then use `bun run check --skip-build` to reuse your build if the source has not changed. Rebuild after changing application code. Missing browsers or a missing hosted database fail before startup; an incomplete run is never green.

CI uses the same five journeys against both the standalone Bun adapter and the Netlify polling adapter, with one built frontend and a disposable real Postgres schema:

```sh
# Configure COMMON_TEST_DATABASE_URL to a disposable Postgres database first.
bun run check --all-adapters

# Or investigate just the hosted adapter.
bun run check --hosted
```

The hosted harness owns and drops a randomly named schema. It never reads Netlify credentials. Do not point `COMMON_TEST_DATABASE_URL` at a production database. CI uploads failure evidence for seven days and cancels superseded runs. Pull requests run once; branch pushes and release tags no longer trigger duplicate full runs.

## Deeper checks when the change needs them

Existing regression checks remain available explicitly. They are useful for concurrency, authorization, token leases, cancellation races, and other behavior that a short browser walkthrough cannot prove.

| Change | Command |
| --- | --- |
| Shared document, ordering, merge or topology | `bun run check:deep canvas` |
| Room protocol, local admission or polling transport | `bun run check:deep sessions` |
| Hosted transactions, lease races or cross-room access | `bun run check:deep hosted` |
| Capture lifecycle, video transport or local exports | `bun run check:deep media` |
| Agent permissions, expiry or session boundaries | `bun run check:deep agents` |
| Configuration, startup or diagnostics | `bun run check:deep runtime` |
| Deliberate full regression investigation | `bun run check:deep all` |

Combine scopes, for example `bun run check:deep sessions hosted`. Hosted and all require the disposable database and refuse to run without it; missing SQL coverage cannot silently become a pass. The optional FFmpeg exercise still reports a skip if FFmpeg is absent. In GitHub Actions, run **Check** manually and choose the scope. Running Bun's raw `bun test` still discovers the older test files; use the scoped command for deliberate investigations.

Add a check when it protects a real user outcome or a difficult failure that has been observed. Prefer extending one existing journey or a targeted boundary case. Avoid checks that repeat implementation details, assert private maps or unchanged DOM identity, require timing sleeps, or merely increase a test count. Remove obsolete checks when their behavior is replaced. When an error is confusing, improve the error and its diagnostic context alongside the fix.

## A short real-device check

Before a release that changes capture or mobile behavior, run the [two-browser walkthrough](../public/self-hosting.html#smoke-test) on the team's actual devices and network. Open the real source picker, verify video arrives, type with the native phone keyboard, interrupt and restore the connection, and download a recording. Automated canvas capture and browser emulation do not prove system permissions, OS tab suspension, or physical keyboard behavior. For a real incident, use **Canvas options → Connection details → Download report** to get the app's existing sanitized diagnostics.
