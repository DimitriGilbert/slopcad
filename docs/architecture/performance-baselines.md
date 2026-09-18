# Phase 29 — Performance Baselines and Budgets

_Executed 2026-09-18 (machine clock; matches every timestamp inside the
recorded artifacts). Machine: AMD Ryzen 5 7430U (12 cores), 30.8 GB RAM,
Fedora Linux x64, Node v24.21.0, HeadlessChrome 153.0.7810.12 (Playwright
bundled Chromium), 12 logical cores reported to the browser. Every number
below was measured on this machine by the harness in this repo — nothing
is quoted from memory, docs, or vendor claims._

## The harness (how to reproduce everything)

| Piece                                                             | Purpose                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/routes/perf.tsx` + `src/perf-fixture/**`            | The `/perf` benchmark fixture: the real Manifold worker, real worker client/protocol, real plate chain, real projection boundary, real workbench document — measured in-page, publishing one JSON surface.                                                  |
| `apps/web/playwright.perf.config.ts`                              | The perf Playwright harness: production build (`vite build` + nitro), port 3006, SwiftShader, 1280×720, DPR 1, one worker, **video/trace off** (encoder load would sit inside every timing; deviation from the other harnesses, deliberate and documented). |
| `apps/web/e2e-perf/perf.spec.ts`                                  | The two specs: the `/perf` fixture benchmarks, and the `/render` **production page** interaction latencies.                                                                                                                                                 |
| `apps/web/e2e-perf/helpers.ts`                                    | Median + p10/p90 (nearest-rank: index `ceil(p·n)−1`), the budgets gate, the results writer.                                                                                                                                                                 |
| `apps/web/e2e-perf/budgets.json`                                  | The recorded budgets (median-over-budget fails the suite).                                                                                                                                                                                                  |
| `apps/web/e2e-artifacts/perf/perf-results.json`                   | The machine-readable record of the latest run (environment + per-metric samples/aggregates + budget verdicts).                                                                                                                                              |
| `packages/cad-kernel-manifold/src/manifold-worker-boot-report.ts` | The Manifold web entry's boot report (module eval → WASM runtime ready), the twin of the OCCT entry's report — the instrumentation that makes `startup.wasmBoot.workerMs` measurable.                                                                       |

Commands (from the repo root): `pnpm test:perf` (enforces budgets);
`PERF_BASELINE=1 pnpm test:perf` (recording mode — identical measurements,
budgets not enforced; how the baseline below was taken). Each run boots its
own production-build server; nothing is reused.

Measurement discipline:

- All timings are taken **in-page** with `performance.now()` — the driver
  (Playwright) never sits inside a measurement; it only triggers work
  (real input events, real mouse clicks) and reads published surfaces.
- The `/render` latencies are measured **on the production page the
  87-test render suite pins**, via `MutationObserver` on the settle
  attributes — no production code was modified to measure it.
- Per-run N is baked into the fixtures (7 boots, 25 chain iterations,
  25 projection/transfer samples, 50 invalidation samples, 10 scene
  updates, 10 param updates, 10 selection clicks); the two single-sample
  metrics (`scene.firstSettle.ms`, `render.firstScene.loadToSettledMs`)
  take their dispersion from repeated suite runs (6 full runs recorded
  below), as documented.
- The settle-attribute family of metrics (param update, selection, settle)
  ends at the **settle stamp** (the first frame that provably carries the
  new state), not at pixels; the raster itself happens after the stamp.
  Under SwiftShader (software WebGL) absolute raster cost is inflated
  relative to a GPU — these are budget numbers for THIS harness
  environment, which is the same environment every other browser gate
  uses.
- `transfer.tessellateResponse.structuredCloneMs` is a **documented
  proxy**: `structuredClone` of the exact captured tessellate wire
  response (same algorithm, same runtime, same payload as the postMessage
  clone; a cross-thread postMessage cannot itself be timed from one
  thread). The measured tessellation: 128 triangles, 408 positions, 384
  indices, kernel normals included, 8,392 JSON bytes on the wire.

## Baselines and budgets

Nine full runs were recorded (three in baseline mode while calibrating,
then six consecutive enforcing runs — the last two after the final code
cleanup — every run green, budgets never closer than 2× to their limits).
The table shows the enforcing run of record
(`e2e-artifacts/perf/perf-results.json` of 2026-09-18; every other run's
console output agreed within noise — e.g. end-to-end param-update medians:
16.45, 16.35, 16.50, 16.50, 16.50, 16.50, 16.45 ms).

Percentiles are nearest-rank; spread is p10–p90. Budget rationale: every
budget is ≥ ~2.35× its median (the two tightest ratios:
`render.firstScene.loadToSettledMs` at 2.37× and
`scene.paramUpdate.dispatchToSettledMs` at 2.43×) and ≥ ~1.75× the widest
p90 the nine runs observed (`scene.paramUpdate.dispatchToSettledMs`: 40 ms
over a 22.6 ms p90 — its row's own 1.8×), rounded to a round number —
machine noise (including the observed one-off outliers: createBox max
29.8 ms on a GC pause, one 164.7 ms param-update during a compositor
hiccup) never trips the median gate, while a real regression that roughly
doubles a median does. Sub-millisecond metrics get 2–5 ms budgets because
their medians quantize at 0.1 ms.

| Metric                                               | Fixture | N     | Median | p10–p90                | Budget | Headroom rationale                              |
| ---------------------------------------------------- | ------- | ----- | ------ | ---------------------- | ------ | ----------------------------------------------- |
| `startup.wasmBoot.workerMs`                          | /perf   | 7     | 13.9   | 13.3–15.1              | 40     | 2.9× median; worker-side, low variance          |
| `startup.bootReport.mainThreadMs`                    | /perf   | 7     | 28.7   | 27.2–31.4              | 80     | 2.8× median                                     |
| `startup.firstResponse.mainThreadMs`                 | /perf   | 7     | 30.8   | 29.3–33.8              | 80     | 2.6× median (script fetch + WASM + op)          |
| `op.solid.createBox.roundTripMs`                     | /perf   | 25    | 0.1    | 0.0–0.2                | 2      | 10× median (quantized at 0.1 ms)                |
| `op.solid.createCylinder.roundTripMs`                | /perf   | 25    | 0.2    | 0.1–0.4                | 2      | 10× median                                      |
| `op.solid.transform.roundTripMs`                     | /perf   | 25    | 0.1    | 0.0–0.3                | 2      | 10× median                                      |
| `op.solid.subtract.roundTripMs`                      | /perf   | 25    | 0.1    | 0.0–0.1                | 2      | 10× median                                      |
| `op.solid.volume.roundTripMs`                        | /perf   | 25    | 0.8    | 0.6–1.2                | 5      | 6× median (the chain's costliest op)            |
| `op.solid.area.roundTripMs`                          | /perf   | 25    | 0.1    | 0.0–0.2                | 2      | 10× median                                      |
| `op.solid.bounds.roundTripMs`                        | /perf   | 25    | 0.1    | 0.0–0.1                | 2      | 10× median                                      |
| `op.solid.tessellate.roundTripMs`                    | /perf   | 25    | 0.3    | 0.2–0.6                | 5      | 8× median (kernel tessellation + clone)         |
| `op.chain.plateWithHole.totalMs`                     | /perf   | 25    | 1.6    | 1.2–2.4                | 8      | 3.3× p90 (catches e.g. a double tessellation)   |
| `projection.plate.totalMs`                           | /perf   | 25    | 0.1    | 0.0–0.1                | 2      | 10× median                                      |
| `transfer.tessellateResponse.structuredCloneMs`      | /perf   | 25    | 0.1    | 0.0–0.2                | 2      | 10× median (proxy — see discipline)             |
| `invalidation.parameterEdit.transactionMs`           | /perf   | 50    | 0.0    | 0.0–0.0                | 2      | quantized zero; 2 ms is the honest floor        |
| `invalidation.featureParamEdit.diffMarkRegenerateMs` | /perf   | 50    | 0.0    | 0.0–0.1                | 2      | 20× p90                                         |
| `invalidation.grownDoc.diffMarkRegenerateMs`         | /perf   | 50    | 0.1    | 0.1–0.2                | 5      | 10× p90 (41-feature cascade)                    |
| `scene.firstSettle.ms`                               | /perf   | 1/run | 168.7  | — (run spread 158–173) | 450    | 2.7× median over 9 runs                         |
| `scene.paramUpdate.dispatchToSettledMs`              | /perf   | 10    | 16.5   | 15.7–22.6              | 40     | 1.8× p90; frame-clock coupled                   |
| `scene.paramUpdate.dispatchToAppliedMs`              | /perf   | 10    | 4.2    | 2.3–4.6                | 20     | 4.3× p90 (worker + coordinator share)           |
| `scene.paramUpdate.applyToFrameMs`                   | /perf   | 10    | 12.7   | 11.5–16.8              | 35     | 2.1× p90 (React commit + effects + frame clock) |
| `render.firstScene.loadToSettledMs`                  | /render | 1/run | 337.7  | — (run spread 322–377) | 800    | 2.37× median; 2.13× widest run (376.5 ms)       |
| `render.paramUpdate.inputToSettledMs`                | /render | 10    | 13.4   | 12.2–15.2              | 40     | 2.6× p90; production page, frame-coupled        |
| `render.selection.pointerToSelectionFrameMs`         | /render | 10    | 6.9    | 2.6–10.2               | 30     | 3× p90 (widest spread: 2.6–12.6 observed)       |

### The latency decomposition (the phase's main finding)

A parameter edit on the production `/render` page settles in ~13–16 ms
end-to-end. The decomposition (perf fixture, same pipeline):

```
dispatch ──▶ applied ──▶ first frame carrying it
   4.2 ms        12.7 ms
   (worker chain 1.6 ms + coordinator settle incl. 4 disposals)
                (React commit + effects + demand-frame clock wait)
```

The CAD data plane (kernel chain + transfer + projection + invalidation)
costs **under 2 ms** of a ~16 ms update; the rest is the browser's frame
clock and the SwiftShader raster pipeline. The system is frame-clock
bound, not compute bound, at the fixture's scale.

## Optimization ledger (measure-then-decide, declines included)

Every candidate the plan names was measured first. **No production
optimization shipped: every candidate was declined by its own before
numbers.** Declines are the deliverable here — recorded with the
measurements that decided them.

| Candidate                                       | Before (measured)                                                                                                                                                                   | Decision and the reason the numbers give                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tessellation caching                            | Whole worker chain (incl. tessellate + transfer) median 1.6–1.8 ms; worker+coordinator share of an update 4.2 ms; end-to-end update 16.5 ms                                         | **Declined.** A cache keyed by parameter value would eliminate at most the 4.2 ms worker share — only on revisited values — while adding cache-key/invalidation complexity against the revision semantics the stale-result specs pin. The end-to-end latency is already ~6× under a 100 ms interaction budget.                                                   |
| Caching (general, projection/anchors)           | Projection boundary 0.1 ms median; face-anchor + surface work sits inside the 12.7 ms frame share that is frame-clock dominated                                                     | **Declined.** Sub-millisecond costs; nothing to win.                                                                                                                                                                                                                                                                                                             |
| Incremental graph invalidation                  | Workbench-document derivation pass (diff + markStale + regenerate, features re-executing): 0.0 ms median, p90 0.1 ms. 41-feature chain head-edit cascade: 0.1 ms median, p90 0.2 ms | **Declined.** The existing incremental scheme (identity diff → affectedFeatures → execute-only-stale) is sub-millisecond at 20× the shipped document's feature count. The known O(F·R) term in `documentChangeInvalidations` (removed-feature scan) would matter near hundreds of features; nothing shipped approaches that.                                     |
| Worker batching for rapid updates               | Per-op round trip overhead ≈ 0.1–0.2 ms (bounds/area/subtract medians); the 8-op chain totals 1.6–1.8 ms                                                                            | **Declined.** Batching the plate chain would save under 1 ms per update — ~6% of end-to-end — at the cost of a protocol change. Rapid updates already do not queue: the coordinator's default `cancel` policy voids superseded work eagerly (pinned by the worker cancellation specs; the burst fixture proves 12 rapid edits leave exactly one settled result). |
| Tessellation wire format (typed-array transfer) | structuredClone proxy of the real 128-triangle/8.4 KB wire response: 0.1 ms median                                                                                                  | **Declined.** The transfer cost is unmeasurable at shipped-model scale; a typed-array protocol rewrite buys nothing today.                                                                                                                                                                                                                                       |
| Coordinator disposal settle                     | The coordinator awaits the replaced state's 4 solid disposals before the update settles (documented leak-free invariant)                                                            | **Declined.** Fire-and-forget disposal would shave <1 ms but break the pinned "disposals complete before the update's outcome settles" invariant the leak-free specs assert. Not worth an invariant change for noise.                                                                                                                                            |

Changes that DID ship, with their own before/after:

1. **Manifold worker boot report** (`packages/cad-kernel-manifold/src/manifold-worker-boot-report.ts` + the web entry, the OCCT twin's exact pattern). Instrumentation, not optimization: it posts one plain non-protocol message per boot. Before: Manifold's WASM boot was unmeasurable from the main thread (the number only existed for OCCT). After: `startup.wasmBoot.workerMs` = 13.9 ms median (n=7). The message is dropped by every protocol parse boundary; the existing worker e2e suites stay green (validated in the final full run).
2. **React render-time metric corrected** (harness, not production): the first draft measured React commit work with `<Profiler>`; in the production bundle React's Profiler API is a **no-op** — the baseline run published a fake `0.00 ms` with a commit-count audit of 0, which exposed it. Replaced with the observable `applyToFrameMs` window (apply callback → settle probe's frame): 12.7 ms median. The fake metric was never recorded as a baseline.

## Wiring and stability

- `pnpm test:perf` (root and `apps/web`) runs the suite and **fails on any
  blown budget** (median over budget). Recorded budgets live in
  `apps/web/e2e-perf/budgets.json`; a missing or empty budgets file fails
  the suite rather than silently going report-only.
- **Kept out of `pnpm verify`**, like every other browser gate in this
  repo (`test:e2e`, `test:render`, `test:worker`, `test:workbench` — the
  repo's convention since Phase 1.5): it needs the Playwright browser
  stack and boots its own production server, which would double-`build`
  inside `verify`. Stability evidence, as required for the wiring
  decision: **6 consecutive full enforcing runs green** (plus 3
  calibrating baseline-mode runs, the last two enforcing runs after the
  final code cleanup) on 2026-09-18, medians repeatable within ~1 ms on
  every metric; no budget was ever within 2× of tripping.
- Recording mode (`PERF_BASELINE=1`) skips only the gate, never the
  measurements; it is how these baselines were taken and how future
  re-baselining should be done (with the decline/adopt ledger in this
  file updated alongside).

## What was NOT measured, and why (honestly)

- **OCCT WASM startup** is not re-measured here: the composed workbench
  data plane runs Manifold, and OCCT's boot cost is already surfaced as
  data by its own fixture (`/worker-occt`'s `data-boot-ms`, Phase 21.2).
  Re-measuring it in this harness would duplicate that surface.
- **GPU raster time**: the harness environment is SwiftShader by policy
  (the same environment as every other browser gate); raster-relative
  numbers are budgets for this environment, not claims about hardware
  GPUs.
- **Worker-batching under concurrent multi-op storms** (as opposed to
  sequential chains): the protocol executes one op per request by design;
  the burst fixture's cancellation behavior — not batching — is the
  shipped answer to rapid updates, and its evidence lives in the worker
  e2e suite.
