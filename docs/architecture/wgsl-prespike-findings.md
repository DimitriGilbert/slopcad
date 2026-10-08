# Phase 64b Pre-Spike — WebGPU under Playwright/Dawn Findings

_Executed 2026-10-08, on branch `sim/roadmap-sim`, as Phase 64's spike
mandate (ROADMAP-SIM §5 Phase 64: "a WebGPU-under-Playwright/Dawn spike —
adopt into e2e only if stable, otherwise decline loudly (e2e stays CPU per
S5 either way)"). Everything below was produced against THIS repo's own
code: the 64a WGSL provider (`packages/sim-flow`), its oracle harness, the
production build booted by the repo's Playwright harnesses. Claims are
marked **[probed]** (I ran it — command or harness named) or **[cited]**
(link). This document follows the `occt-prespike-findings` precedent._

**Probe environment**: Fedora 44, Linux x86_64, Node v24.21.0,
`@playwright/test` 1.63.0 with its bundled Chromium **153.0.8010.12**
(default headless shell) and the full `chromium` channel build; pnpm
workspaces at the repo root. The MACHINE carries an AMD Barceló iGPU with
Mesa Vulkan 1.4.341 (RADV ICD installed) — a real integrated GPU is
PRESENT on this host, a fact that matters for §4's honesty.

---

## 1. The launch door — what actually works headlessly [probed]

Systematic flag probes against a blank page served over
`http://127.0.0.1` (a scratch `python3 -m http.server`, deleted after;
then the repo's own production build via the new gpu-spike harness):

| Launch variant                                                                                                                                                          | `navigator.gpu`           | adapter                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------- |
| default headless shell, the sanctioned SwiftShader flags (`--use-angle=swiftshader --enable-unsafe-swiftshader`)                                                        | absent                    | —                               |
| default headless shell + `--enable-unsafe-webgpu`, on `about:blank`/`data:`                                                                                             | **absent**                | —                               |
| full `chromium` channel (new headless) + `--enable-unsafe-webgpu`, on `about:blank`/`data:`                                                                             | **absent**                | —                               |
| full `chromium` + `--enable-unsafe-webgpu` + `--enable-gpu`, `--ignore-gpu-blocklist`, `--enable-features=Vulkan`/`WebGPU`, `--use-angle=swiftshader/vulkan/egl` (each) | **absent** on blank pages | —                               |
| default headless shell + `--enable-unsafe-webgpu`, on an **http origin**                                                                                                | **present**               | Dawn **SwiftShader** (software) |
| same, plus the sanctioned SwiftShader flags                                                                                                                             | present                   | SwiftShader                     |

The two load-bearing facts:

1. **`--enable-unsafe-webgpu` is the whole door.** Without it, a
   SwiftShader-only host exposes no WebGPU at all (Dawn classifies its
   software adapter as unsafe). With it, the DEFAULT headless shell
   suffices — no `channel: "chromium"`, no `--no-sandbox`, no
   GPU-sandbox flags (verified: adding them changes nothing on http
   origins). It composes cleanly with the repo's sanctioned
   `--use-angle=swiftshader --enable-unsafe-swiftshader` pair (those
   steer WebGL/ANGLE; Dawn enumerates independently).
2. **Opaque origins lie.** On `about:blank` and `data:` URLs —
   Playwright's default first page — `navigator.gpu` is ABSENT even with
   the flag, on both the shell and the full build, deterministically
   across a 0–4 s spin-up window (a GPU-process race was ruled out
   [probed: fresh contexts at increasing delays, all absent]). Probing
   WebGPU on a blank page reports a false absence; the probe must
   navigate to a real origin first. This cost the spike its first hour
   and is recorded so no future spike repeats it.

**Adapter identity** [probed]: `requestAdapter()` and
`requestAdapter({ forceSoftwareAdapter: true })` both answer
`{ vendor: "google", architecture: "swiftshader" }` with limits
comfortably above the provider's recorded requirements
(`maxStorageBufferBindingSize` 1 GiB vs the 128 MiB check,
`maxComputeInvocationsPerWorkgroup` 256 vs 64,
`maxComputeWorkgroupsPerDimension` 65 535).

**The hardware adapter is NOT reachable** [probed]: despite the AMD
Barceló iGPU and RADV being installed and functional at the OS level
(`vulkaninfo` answers 1.4.341), headless Chromium — shell and full
build, with `--enable-features=Vulkan`, `--use-angle=vulkan`, or
`--use-angle=egl` — never enumerates anything but SwiftShader. This
environment cannot produce hardware-class GPU numbers; see §4.

## 2. The oracle matrix under a real device — numbers and stability

**Wiring** [probed]: a production-build fixture page
(`/sim-gpu`, `apps/web/src/sim-gpu-fixture/`) drives the 64a harness
itself — `runGpuOracleCase` over `GPU_ORACLE_MATRIX` through
`requestWebGpuDevice()` — on the main thread, publishing the whole
record (per-repeat L2/L∞ deltas, tolerance violations, adapter
provenance) as JSON on the root attribute. A dedicated harness
(`pnpm test:gpu-spike`, `playwright.gpu-spike.config.ts` — the spike
config's boot discipline plus `--enable-unsafe-webgpu`) collects it and
asserts: every case, every repeat, ZERO tolerance violations, no
divergence, adapter recorded, and — the stability half — a SECOND full
matrix run on a fresh device request holding the same line. The spec
prints every number; they are re-derivable by re-running the command.

**Numbers** (Dawn SwiftShader, Chromium 153, 3 repeats per case, two
full matrix runs per harness run; all repeats and both runs produced
IDENTICAL values — the deltas below are exact to the printed precision):

| Case (steps)                 | worst rel-L2 | worst rel-L∞ | drag L2            | lift L∞                          |
| ---------------------------- | ------------ | ------------ | ------------------ | -------------------------------- |
| poiseuille-channel (400)     | 1.498e-5     | 1.107e-5     | 0.000e+0 (bitwise) | 0.000e+0 (both identically zero) |
| cylinder-attached-wake (600) | 4.925e-5     | 4.017e-5     | 9.702e-6           | 6.077e-6                         |
| symmetry-half-domain (400)   | 1.525e-5     | 1.024e-5     | 1.273e-5           | 4.902e-6                         |

Against the 64a recorded tolerances (distributions 1e-2 L2 / 5e-2 L∞,
forces 1e-1 / 2e-1) that is **three to four orders of headroom**, the
f32-rounding attractor floor the 64a derivation predicted
("a few orders above 1e-7"). Run-to-run drift across the two full
matrix runs: **0.0e+0** on every case and repeat — bitwise-stable
stepping on this device, consistent with the provider's fixed
orchestration (no clocks, no randomness, fixed dispatch order).

**Stability across harness runs** [probed]: the full harness was run
twice end-to-end (fresh build + browser each time) during the spike —
both green, identical numbers (§5's confirmation run is the second).

## 3. Spike-discovered provider bugs (the spike doing its job)

Two 64a defects surfaced ONLY under a real device — the fake device
validates orchestration, not IDL physics:

1. **The browser adapter omitted the now-required pipeline `layout`**
   [probed: the first in-browser matrix run failed instantly with
   `Failed to execute 'createComputePipelineAsync' … 'layout' …
Required member is undefined`]. Current WebGPU requires the
   `layout` member; the wrapper now passes `layout: "auto"` — exactly
   the layout it already reflects through `getBindGroupLayout(0)`.
   Fix: `packages/sim-flow/src/gpu-device.ts`.
2. **The recorded matrix could never run past its own normalizer.**
   The poiseuille channel and the centered cylinder are symmetric
   cases: the f64 oracle's lift history is IDENTICALLY ZERO, and
   `gpuForceDelta` refused to normalize a zero oracle history — a
   refusal the headless unit pins never exercised because the matrix
   itself skips without a device. The honest comparisons now are:
   both sides identically zero = exact agreement; an identically-zero
   oracle against the provider's f32 reduction noise measures against
   the run's FORCE SCALE (the drag peak, passed by `runGpuOracleCase`)
   — the physically meaningful yardstick; no scale, no comparison, the
   refusal stands. On this device the poiseuille lift is exactly zero
   on BOTH kernels (the both-zero branch); the cylinder's tiny lift
   compares through the drag scale. Fix + re-pinned arithmetic:
   `packages/sim-flow/src/gpu-oracle-harness.ts`,
   `gpu-oracle.test.ts`.

Both are exactly the spike's mandate: fix, and record as findings.

## 4. Perf budgets on the GPU path — what is honestly recordable

The perf fixture (`/perf`) gained `kernel.lbm2d-wgsl.referenceGrid.
stepBatchMs`: the SAME reference grid (512×256 cylinder tunnel) and the
SAME batch protocol as the CPU budget (10-step batches, 10-step warmup,
7 samples) executed by the production WGSL stepper — one sample =
submit ten steps, then await the status readback that completes them
(the provider's submits are fire-and-forget; the readback is the
completion gate). The perf harness's launch config gained
`--enable-unsafe-webgpu`, and the fixture's environment block records
the adapter class (`google / swiftshader`) beside every run, so a
software-device number can never masquerade as a hardware claim.

**Recorded** [probed, `PERF_BASELINE=1 pnpm test:perf`, Dawn
SwiftShader]: `kernel.lbm2d-wgsl.referenceGrid.stepBatchMs` **median
1228.3 ms** (p10 1204.0 / p90 1285.7, n = 7) against the CPU kernel's
**268 ms** median on the identical grid and protocol — the software
device costs ~4.6× the CPU oracle per batch, exactly what "WGSL
executed on CPU threads through a Vulkan software layer" should cost.
The recorded budget is **2000 ms** (`apps/web/e2-perf/budgets.json`;
~55 % headroom over the p90, the software-device variance class), and
the live numbers re-derive by re-running the command into
`apps/web/e2e-artifacts/perf/perf-results.json`. The budget is labeled
here, permanently: **a SOFTWARE-DEVICE number, an upper bound on the
correctness-path cost, not a GPU perf claim.** Dawn's SwiftShader
executes the WGSL on CPU threads; it cannot represent the
"reference integrated-GPU class" the roadmap names.

**The hardware-class budget is NOT RECORDABLE HERE** — stated, not
approximated. This machine's AMD Barceló iGPU (a genuine
integrated-GPU-class part, Vulkan-capable at the OS level) is not
enumerated by headless Chromium under any flag combination probed
(§1). A hardware-class budget needs either a headed run against a real
display stack or a Cloud GPU setup with a driver Dawn accepts
([cited: tigerabrodi.blog — Dawn rejects some NVIDIA drivers; the
`--enable-dawn-features=allow_unsafe_apis` door exists]). Neither is
this environment; the honest record is "not-recordable-here", and the
roadmap's hardware-class budget line stays open until a real device
run records it.

## 5. The decision — ADOPTED into e2e as a dedicated, documented door

**Adopted: `pnpm test:gpu-spike` is the standing WebGPU e2e door.**
The evidence: the matrix is green under a real device with three to
four orders of tolerance headroom, bitwise-stable across repeats and
across full harness runs, zero flakes observed across every run of the
spike (including the two failed iterations that caught the §3 bugs —
failures were deterministic provider defects, not flakiness, and each
failed FAST with the exact browser message). The harness is kept OUT
of `pnpm verify` like every e2e harness in this repo (TEST-ALIGNMENT
policy), fails loudly when its flag cannot find a device (the door
itself is then broken), and the headless unit suites keep the
skip-loudly path for GPU-less hosts — law S5 unchanged: the CPU oracle
stays the test truth, the session/render harnesses stay CPU-launched,
and the GPU path is gated by this tolerance harness, never
bit-asserted, never silently trusted.

What adoption deliberately does NOT mean: the session harness does not
gain the WebGPU flag (that would silently change what its s24e
fallback stage proves), and no unit suite grows a device dependency.
The GPU door is one command, one page, one config — the exact shape
risk S4's mitigation names ("S5: e2e asserts the CPU path; GPU gated
by the oracle harness + a manual device matrix", now better than
manual).

**The fallback-path e2e** [probed, session harness s24e]: a
gpu-preferred flow scenario authored through the `/workbench-sim`
Formedible form completes end to end on the CPU twin when WebGPU is
absent (the session harness launches without the flag), awaited on the
`data-sim-*` committed-application counters, and — new with 64b — the
result summary's `servedBackend` marker records `"cpu"` (the router's
fallback made machine-readable: `SimResultSummary.servedBackend`,
stamped by whichever engine executed the run, persisted through the
store round-trip, surfaced as `data-sim-served-backend` on the fixture
root). The WGSL engine stamps `"gpu"`; a gpu-preferred run under the
gpu-spike door would record exactly that.

## 6. Unknowns handed forward

- **Hardware-device variance** (risk S1's core): every number here is
  one device class (Dawn SwiftShader). A hardware campaign — adapter
  identity recorded per run through the same report surface — is the
  natural follow-up when a real GPU is reachable; the harness already
  records provenance for it.
- **Chaotic (shedding) cases**: the 64a bands are for the laminar
  matrix; the harness module block already declines to guess
  Lyapunov-grown bands. A shedding case needs a real-device growth
  measurement before it joins the matrix.
- **The opaque-origin rule's mechanism** (why `navigator.gpu` is
  absent on `about:blank`/`data:` under this build) was pinned as
  behavior, not explained; if Playwright or Chromium changes it, §1's
  probe table is the re-verification recipe.
- **Dawn SwiftShader throughput vs 3D grids**: the software-device
  step-batch number is an upper bound for correctness-path cost only;
  Phase 66's D3Q19 sizing decisions must wait for hardware numbers,
  per §4's not-recordable-here stance.
