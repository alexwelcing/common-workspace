# Understanding performance

Open **Canvas options → Performance** in the standard canvas, or **Room → Performance** in Space & Time. The panel describes the current browser. It cannot report the health of every participant, the host server, or the whole room.

Measurements stay in this tab. There is no analytics service, account, or diagnostic upload. The same collector runs in local Bun installations and on Netlify.

Use it during feature development to spot expensive work, compare a change, and decide where to profile next. The score is a starting point; operation timings and the complete user action provide the evidence.

## Read the index

The index runs from **0 to 100**, with 100 best. After five seconds of visible observation, it follows the weakest available responsiveness signal rather than averaging away a bad result. Scores of 80–100 are healthy, 50–79 show strain, and below 50 indicate poor responsiveness. These are troubleshooting guides, not device benchmarks or capacity guarantees.

The rolling window covers the most recent 60 seconds and keeps bounded samples. Older or excess samples expire. Hiding the tab or pausing an embedded canvas pauses observation; background throttling must not look like application slowness. Frame observation runs briefly during input activity rather than continuously while idle.

**Unavailable**, **Not observed yet**, and a dash mean that evidence is missing. They do not mean zero delay or a healthy result. Browser support and the actions you perform determine coverage; always read the coverage alongside the score.

| Signal | Comfortable guide | Poor guide | What it observes |
| --- | --- | --- | --- |
| Main-thread delay | ≤ 50 ms | ≥ 250 ms | Delay in a one-second browser heartbeat. |
| Long-task blocking | ≤ 10 ms/s | ≥ 100 ms/s | Time beyond 50 ms in supported browser long-task entries, per visible second. |
| Active frame stalls | ≤ 1% | ≥ 10% | Active frame intervals exceeding 50 ms; at least 30 intervals are needed. |
| Observed slow interactions | ≤ 200 ms | ≥ 500 ms | The p95 of observed Event Timing entries. Browsers may omit short interactions; this is **not standard INP**. |

Timed synchronous canvas renders, spatial renders/edits, object projection, historical reconstruction, and peer merges can also lower the index. They normally need five samples; a single measured stall of at least 250 ms is enough to count. Budgets live in [`src/performance-index.js`](../src/performance-index.js).

**Object projection** (`state-projection`) measures actual Space & Time presentation rebuilding, with 16 ms as its comfortable guide and 100 ms as its poor guide. It includes uncached historical projection work. Returning an already accepted cached projection does not add a sample; a missing sample can reflect cache reuse rather than missing instrumentation.

## Find useful clues

**Likely contributors** connects measured delays with places to investigate. A slow operation overlapping a poor score is evidence to inspect, not causal proof. Other tabs, browser extensions, power settings, hardware, and unrelated work on the main thread can affect the result.

Read **Measured work** for the median, p95, maximum, sample count, and failures. p95 means 95% of sampled operations completed at or below that duration. A maximum catches an isolated severe stall; a small sample count limits conclusions. Failure counts say an operation failed, not why: use the application's readable error and connection diagnostics for that reason.

Autosave and replay import/export include asynchronous waiting. A slow storage transaction or compression operation can explain waiting without proving the UI was blocked. These elapsed times do not lower the responsiveness score by themselves. Request timings also stay separate: long polling intentionally waits for events, so a long request is not automatically a problem.

**Current workload** shows safe numeric context such as object, board, participant, connection, watched-window, queued-byte, and history-byte counts where available. Counts do not lower the score by themselves. Compare them with measured work before deciding to reduce a canvas or change synchronization.

## Compare a change

1. Run `bun run dev` and open the URL it prints. Build a synthetic scene representative of the feature: object types and counts, boards, history, and watched windows. Write down a short, repeatable sequence such as typing, dragging, switching boards, and replaying history.
2. Keep the browser profile, device, viewport, scene, and network conditions comparable. Run one investigation at a time; another benchmark, browser profiler, or busy development process can distort the result. Freeze source saves during a run: hot reload restarts observation. Let the scene finish loading, select **Start fresh**, and wait through the five visible seconds of warmup. Reset clears measurements, not canvas data.
3. Perform the sequence several times. Read coverage, sample counts, raw operation median/p95/maximum, failures, and workload alongside the score. Check that the expected operations were actually measured. Download the baseline report and keep its build identifiers with the action sequence and environment notes. Development build identifiers describe committed source; record the working-tree diff as well.
4. Make one change, reload the same scene, reset, warm up, and repeat. Keep the second report beside the baseline. Compare complete-action time as well as named operations; fewer repeated renders or history reads can matter even when each individual sample is fast.
5. Use Chrome DevTools **Performance** to record the specific action when the expensive call is unclear. Inspect the main-thread call tree and self time; use temporary numeric counters to check suspected repeated work. Capture this trace separately from the comparison runs because profiling adds overhead. Check idle periods, inactive boards, and hidden tabs for work that should have stopped or reused a cached result.
6. For collaboration changes, repeat with two real browser profiles and the intended network. Compare local Bun and Netlify runs when the hosting boundary matters; reports from different devices are not interchangeable benchmarks.

Timing boundaries matter. The [first developer investigation](performance-investigation.md) found spatial edit preflight work outside the `spatial-edit` timer. A fast named operation can miss expensive work before or after it, and short delays may escape the responsiveness signals. Follow a suspicious action through the profiler rather than treating a healthy index as proof that it is cheap.

The index does not measure video quality, GPU time, WebRTC bitrate, server capacity, or cross-device latency. A green index does not prove those systems are healthy.

The existing CI browser journeys retain their privacy-checked synthetic reports in the workflow's `performance-<run ID>` artifact for 14 days. Compare those reports across builds using the same workload and coverage. CI verifies collection and export; variable scores do not act as a release gate. These artifacts come from the CI rooms.

## Download or inspect a report

**Download report** explicitly saves JSON on your device. It contains experience/build identifiers, coverage, scores, predefined operation labels, and numeric timing/workload evidence. It excludes canvas content, names, room/participant identifiers, passwords, tokens, URLs, recordings, and DOM targets. Review the file before sharing it. Nothing is sent automatically.

For local inspection, the read-only browser debug API returns a snapshot:

```js
window.commonPerformance.snapshot()
```

For an embedded workspace, select Common's iframe context in the browser developer tools.

This API observes the current experience; it does not grant canvas or agent permissions. Reloading or destroying the experience ends its in-memory measurements.

## Maintain the instrumentation

Start with [`src/performance-index.js`](../src/performance-index.js) for collection, budgets, and bounded snapshots; [`src/performance-panel.js`](../src/performance-panel.js) owns presentation. Experience orchestration supplies lifecycle, workload context, and report build metadata. Board and spatial-store hooks time the work they own.

Use an existing allowlisted operation, or add a deliberately reviewed definition to the collector. Only synchronous work belongs in a responsiveness budget. Keep elapsed asynchronous work as supporting evidence. Do not accept arbitrary metric names, labels, identifiers, payloads, or error text.

Keep timing around a meaningful operation, including its failure path:

```js
let finish, failed = true;
try { finish = monitor?.start('canvas-render'); } catch { /* Optional diagnostics. */ }
try {
  renderCanvas();
  failed = false;
} finally {
  try { finish?.({ failed }); } catch { /* Preserve application behavior. */ }
}
```

For asynchronous work, finish after the awaited operation; do not mark time spent awaiting storage as synchronous blocking. Let the original operation error reach its existing error handler. Diagnostic errors must never stop editing or replace that error.

Avoid nested render samples, per-point serialization, document exports for counting, payload logging, and new idle animation loops. Reuse cached sizes and counters, and bound new collections. A sample started before reset or a visibility change must not finish in the new observation period.

For Space & Time presentation work, use `store.projection()` and the [presentation cache ownership rules](maintaining.md#keep-spatial-presentation-caches-at-their-boundary). Compare changed-entity and changed-board work with whole-room work. Temporary numeric counters can reveal repeated normalization, preview rebuilding, and `Board.upsert()` calls even when the responsiveness score stays healthy. Keep whole-action measurements alongside operation timers so preflight, validation, and cache maintenance remain visible.

Stable references are valid only for accepted, deeply immutable projection values. Include rejected edits, no-op writes, live updates while viewing history, imports, source switches, and mutable preview input in a focused reproduction. Skipping required reconciliation can look fast while leaving stale content on screen.

Wire document visibility and embed visibility into the collector. Destroy it, unsubscribe the panel/indicator, remove the owned debug API, and cancel timers/observers/frame callbacks when the experience ends. Verify the changed flow with the existing browser journeys and a focused reproduction; no separate performance test suite is required.
