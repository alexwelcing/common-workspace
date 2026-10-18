# First development performance investigation

On 2026-10-18 we used the local index to investigate the application, then used Chromium CPU profiles and temporary numeric counters to attribute the work. The baseline was commit `c65e2683c8f7e5eedf916ab3d07cce00426c0f18` (1.5.0); the resulting fixes ship in 1.5.1 / module 0.5.1.

These are paired observations from one managed Linux browser running headless Chromium against Bun/Vite, not production benchmarks or participant capacity claims. Runs were serialized, with the same synthetic scenes and viewport. Source saves were frozen for final comparisons to prevent hot reload from restarting observation. Each case has one before/after workload run; startup and store comparisons include the same CPU-profiler overhead on both sides. The isolated view timings were collected separately from CPU profiles. See the [numeric evidence](performance-investigation.json) and [investigation workflow](performance.md#compare-a-change).

## Standard canvas restoration

The actual app restored synthetic sticky notes from its normal local storage. Startup measures navigation through the last entity appearing; it includes development asset loading, whose cache/JIT effects explain the non-monotonic small-scene numbers. We then reset, warmed up, selected a note, and performed 60 alternating arrow-key edits.

| Notes | Startup before | Startup after | Startup index before → after |
| ---: | ---: | ---: | ---: |
| 100 | 736 ms | 393 ms | 100 → 100 |
| 300 | 2,315 ms | 363 ms | 0 → 100 |
| 700 | 10,157 ms | 503 ms | 0 → 99 |

The collapsed Layers list rebuilt a canvas-sized DOM tree repeatedly. Each restored item also sorted/materialized the shared document and synchronously saved a progressively larger canvas. Board rendering now defers stacking/control refresh until a bulk update finishes, preserves ranks during geometry/content changes, and creates layer rows only while the panel is open. Sandbox restoration publishes one complete canvas update and saves once: **700 storage writes became one**.

The 700-note editing workload still reports index **46**, versus 0 before. Its 60 arrow edits took 973 ms versus 1,186 ms; maximum measured render dropped from 663 to 94 ms, and observed interaction latency from 920 to 232 ms. Large DOM interaction remains a separate investigation. Startup render samples changed from per-item to one bulk operation, so their p95 values must not be compared as equivalent units.

## Beta edits and timer coverage

An isolated real-WASM store used real IndexedDB, 150 mixed notes, boxes, and 32-point drawings per board, and 80 position edits on one existing object. External `performance.now()` measurements surrounded the public `setEntity` call.

| Boards | Public edit p95 before | Public edit p95 after |
| ---: | ---: | ---: |
| 1 | 7.5 ms | 6.2 ms |
| 8 | 31.3 ms | 6.4 ms |
| 16 | 65.4 ms | 7.5 ms |

Editing one board normalized every other board and counted the edited board's bytes again. Validation now reads only the affected board and reuses its normalized byte total. Moving a board reads its manifest metadata without materializing unrelated objects. Existing content/history limits and rollback checks remain in place.

The 16-board editing phase improved from index **40 to 100**. Before the fix, `spatial-edit` p95 showed only 3 ms: its timer began after the expensive preparation. Timing now includes `setEntity` and `updateBoard` preparation, suppresses nested commit samples, and excludes unchanged edits. Other edit entry points may still perform preparation outside their commit timer. Compare the external public-call measurements above; the old and new named spans cover different work.

## Beta previews and layout

The isolated actual view rendered 100 mixed objects per board, including images, window placeholders, diagrams, and drawings. Forty frame-spaced changes moved and renamed one note. Each scene had five visible seconds of warmup and 40 measured spatial-render samples.

| Boards | Mode | Render p95 before | Render p95 after | Index before → after |
| ---: | --- | ---: | ---: | ---: |
| 8 | Work | 10.8 ms | 0.9 ms | 100 → 100 |
| 8 | Space | 46.0 ms | 5.1 ms | 64 → 100 |
| 24 | Work | 29.9 ms | 1.0 ms | 84 → 100 |
| 24 | Space | 119.8 ms | 7.5 ms | 0 → 100 |

Every content change rebuilt previews for all boards, including hidden ones. At 24 boards, 40 edits created **140,160 preview descendant nodes**. Work now creates zero during the sequence; Space creates 5,840, belonging only to the changed board. Entering Space checks the latest contents, including edits made while it was hidden; history/live state and dimensions participate in invalidation.

CPU profiles also identified `fitScene()` reading layout after those DOM writes. Board bounds depend on board placement/dimensions, not object contents. Fitting now runs on geometry changes, Space entry, and viewport resize, preserving the personal camera. Per-board signatures replace the previous whole-room serialized content signature rather than retaining both copies.

## Remaining work exposed by the complete app

These observations describe 1.5.1. The live projection bottleneck is addressed in the 1.5.2 follow-up below.

Component results do not establish complete-app performance. A separate workload generated a valid archive containing **16 boards × 150 mixed objects**, imported it through the actual file picker, visibly granted agent tools, and performed 40 updates on a note in the active board.

The complete app still reported index **0**: spatial-render p95 **98.1 ms**, spatial-edit p95 **5.3 ms**, canvas-render p95 **0.1 ms**, and main-thread delay p95 **394.5 ms**. Agent calls took 116.6–151 ms. This localizes the next investigation to workspace projection/orchestration around rendering and agent access, where repeated `state()` calls normalize the entire room. It does not implicate the already-fast canvas renderer or prove one specific call is solely responsible. Capture a CPU profile before designing a cache; freshness across live edits, history, imports, room changes, and rollback is essential.

Uncached historical reconstruction of the 16-board store also remained around **131 ms p95** across ten reads. It reconstructs the whole causal workspace. Those reads were measured after the editing-phase index snapshot, so the healthy store editing score does not include their cost.

No large-participant, video quality, physical-phone, or cross-network capacity result follows from these scenes. All beta peers still receive every board and its history.

## Follow-up: object-level projection in 1.5.2

We repeated the actual 16-board, 2,400-object archive/agent workflow against 1.5.1 (`3b07de17e5c9118c92b957141adbadc3d9a45c5f`) and the projection change. Forty frame-spaced edits used the same synthetic scene, browser, and viewport, with sources frozen and runs serialized. Timings below come from one clean paired run, without the CPU profiler. Its fresh baseline differs from the earlier 98.1 ms observation; the comparison uses its own matching before/after evidence.

| Complete-app measurement | Before | After |
| --- | ---: | ---: |
| Spatial render p95, 41 samples | 115.9 ms | 5.2 ms |
| Local agent command completion p95, 40 samples | 151.3 ms | 3.3 ms |
| Spatial edit p95, 40 samples | 5.5 ms | 2.8 ms |
| Performance index | 0 | 100 |
| Observed long-task blocking | 7,429 ms | 0 ms |

Separate CPU profiles attributed about 88% of baseline sampled time to whole-room reads: 40 edits caused **200 `state()` calls**. The after trace has 200 cheap projection reads and zero `state()` calls during those edits. Real projection rebuilds were measured 40 times, at **0.4 ms p95**. Canvas-render samples fell from the collector's capped 256 samples to 40, one per changed object; the capped before count must not be treated as a total.

`store.projection()` now materializes accepted changes into an immutable display view. Native Loro diffs identify affected entities and metadata. Unchanged entities, boards, object arrays, points, and appearance retain references; the active renderer compares those references instead of serializing every entity. Byte checks reuse accepted per-entity sizes. Ordinary `state()` keeps its original validation and detached mutable-copy behavior. Space previews recognize only our branded deep-immutable values; mutable callers retain a content comparison fallback.

Pending changes become visible before callbacks, and multiple edits before a read are combined. Rejected imports and failed commits preserve the accepted projection. Unknown/custom commits take a conservative full-validation path. Historical views share the existing bounded eight-entry cache and are invalidated on accepted history changes, including extensions to the same grouped revision. Imports and workspace changes construct a new owner; teardown releases its cache.

Reference equality also needs a separate track for optimistic UI edits. Failed or unchanged writes restore accepted content, while status updates preserve an uncommitted shape, text editor/caret, and live video. Read-only cancellation reconciles after Board restores its gesture, preserving the personal camera. Actual-browser checks verified those cases, mutable-copy isolation, untouched object/board identity, live cross-tab changes while exploring history, same-ID import, room changes, and cleanup.

These results concern this local synthetic workload, not network latency or participant capacity. Cold full materialization and uncached historical reconstruction still do real work; they are not eliminated or hidden by cache-hit samples. The earlier 700-note standard-canvas interaction result is a separate engine/workload and remains outside this change.

## Behavior verification

Existing focused checks and actual-browser walkthroughs verified ordering, locks, undo, read-only history, node/video reuse, autosave/reload, same-ID archive import, device workspace switching, quota failure/retry, rollback, peer/cross-tab convergence, live versus historical screen labels, permission teardown, and owned-room cleanup. Preview checks covered hidden edits, dimensions, removal/readdition, hidden resize, and camera preservation. No new test suite or dependency was introduced.
