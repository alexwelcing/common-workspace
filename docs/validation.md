# Check the experience, investigate the cause

Use a real user flow to see whether a change works, then use the failure evidence to find its cause. Common's default check runs five journeys through the built app with separate desktop and phone browsers, real HTTP/WebSocket connections, and native WebRTC. There is no coverage percentage or minimum test count to maintain.

New to the repository? Start with [Contributing](../CONTRIBUTING.md). For code boundaries and the release checklist, see [Maintaining Common](maintaining.md).

For prose-only edits, review the changed links, instructions, and snippets. An application build or browser run is only needed when the change affects application behavior.

## Run the default check

Use Bun 1.4.3. From the repository root:

```sh
bun install --frozen-lockfile
bun run check
```

An installed Chrome/Chromium works. Set `CHROMIUM_PATH` to use another executable. If you need to install a browser, do that once:

```sh
bunx playwright-core install chromium
```

The check command never downloads a browser or starts Docker. Playwright Core is a development dependency, with no additional test framework.

`bun run check` checks setup, runs lint, builds once, and starts a temporary loopback server. It creates and ends synthetic rooms, then stops its processes and removes their local data. It does not connect to your running app or Netlify deployment. `bun run test` is a compatibility alias for the same command.

### What the five journeys cover

1. Write a note on the actual WASM canvas, edit it, and undo the edit.
2. Create a guided room, reject a wrong password, and let a phone join and complete its checklist without requesting capture.
3. Exchange chat, reload with the same participant and progress, and navigate the phone canvas.
4. Reject agent writes before consent, permit an annotation after a visible grant, download a PNG, and reject writes after revocation.
5. Synchronize actual peer edits and layer changes, decode remote video, stop capture, and end the room so its former credentials stop working. In Space & Time, also check shared edits and board placement, autosave/reload, read-only history while live edits continue, and archive export.

Capture uses a generated canvas; it does not open the system source picker. Data channels, signaling, and video decoding remain native. Run on a machine that permits local peer networking. If the browser cannot establish a native peer connection, the check fails and retains earlier successful steps as partial evidence. Missing media is never counted as success, and the command does not add a relay to bypass a restricted environment.

## Read a failure

Start with the first failing checkpoint:

1. Read the journey and checkpoint named in the terminal.
2. Open its report under `artifacts/check/run-…/` for the expected behavior, elapsed time, browser/runtime errors, endpoint/status summaries, and screenshots. Build and server logs sit beside it.
3. Fix the cause. Rerun with `bun run check --skip-build` only if application source is unchanged; otherwise use `bun run check` to rebuild.

There are no automatic retries. Missing browsers or a missing hosted database fail before startup, and an incomplete run is never green.

Password fields and invite links are masked in screenshots. Tokens, request bodies, storage dumps, raw SDP, and traces are not written. Artifacts contain synthetic check content, not a copy of an existing room.

## Check both hosting adapters

CI uses the same five journeys against both the standalone Bun adapter and the Netlify polling adapter, with one built frontend and a disposable real Postgres schema:

```sh
# Configure COMMON_TEST_DATABASE_URL to a disposable Postgres database first.
bun run check --all-adapters

# Or investigate just the hosted adapter.
bun run check --hosted
```

Set `COMMON_TEST_DATABASE_URL` to a **disposable** Postgres database. The hosted harness owns and drops a randomly named schema and never reads Netlify credentials. Never use a production database.

Use the adapter runs when changing their shared boundary; validate both before merging a change that spans them. CI uploads failure evidence for seven days and cancels superseded runs. The workflow runs on pull requests and pushes to `main`; feature-branch pushes and release tags do not trigger duplicate full runs.

## Deeper checks when the change needs them

Choose an existing scope when the changed behavior needs closer investigation. These checks cover concurrency, authorization, token leases, cancellation races, and other behavior a short browser walkthrough cannot prove.

| Change | Command |
| --- | --- |
| Shared document, ordering, merge or topology | `bun run check:deep canvas` |
| Room protocol, local admission or polling transport | `bun run check:deep sessions` |
| Hosted transactions, lease races or cross-room access | `bun run check:deep hosted` |
| Capture lifecycle, video transport or local exports | `bun run check:deep media` |
| Agent permissions, expiry or session boundaries | `bun run check:deep agents` |
| Configuration, startup or diagnostics | `bun run check:deep runtime` |
| Deliberate full regression investigation | `bun run check:deep all` |

Combine scopes with `bun run check:deep sessions hosted`. The `hosted` and `all` scopes require the disposable database and refuse to run without it; missing SQL coverage cannot silently become a pass. The optional FFmpeg exercise reports a skip if FFmpeg is absent.

In GitHub Actions, run **Check** manually and choose a scope. Bun's raw `bun test` still discovers the older test files; use the scoped command for deliberate investigations.

### Keep checks useful

Add a check when it protects a real user outcome or a difficult failure that has been observed. Extend an existing journey or a targeted boundary case. Avoid checks that repeat implementation details, assert private maps or unchanged DOM identity, require timing sleeps, or merely increase a test count. Remove obsolete checks when their behavior is replaced.

When an error is confusing, improve the error and its diagnostic context alongside the fix. Useful errors make the next investigation easier.

## A short real-device check

Before a release that changes capture or mobile behavior, run the [two-browser walkthrough](../public/self-hosting.html#smoke-test) on the team's actual devices and network:

1. Open the real source picker and verify the other device receives video.
2. Type with the native phone keyboard.
3. Interrupt and restore the connection.
4. Download a recording.

Automated canvas capture and browser emulation do not prove system permissions, OS tab suspension, or physical keyboard behavior. For a real incident, use **Canvas options → Connection details → Download report** for the app's existing sanitized diagnostics. The [self-hosting guide](../public/self-hosting.html#troubleshooting) covers setup and network troubleshooting.
