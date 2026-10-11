# ADR: Simulation — deterministic cores, providers, and the voxel interface

Phase 61 groundwork. Status: accepted. Supersedes none; complements
`adr-configurations.md` (additive document sections, identity migrations)
and `adr-assembly-mates.md` (the joint records the dynamics layer consumes).
The phased execution plan lives in `ROADMAP-SIM.md`.

## Context

The owner asked for simulation in slopcad, client-side first: aero profiles
and wind tunnels, fans, stoves with combustion and heat transfer through
real materials, and engines — the last implying mechanism dynamics over
joints. WASM and WebGPU are on the table.

Exploration (2026-09-25) established three load-bearing facts. First, no
production-grade CFD runs in a browser today: the only full-solver precedent
is a minimal OpenFOAM wasm proof-of-concept (GPL, tens of MB); the realistic
client-side fluid path is lattice-Boltzmann on GPU compute, for which
current WebGPU implementations exist as references. Second, the licensing
terrain is a minefield: FluidX3D (non-commercial custom license, OpenCL),
Palabos (AGPL), TetGen (AGPL), Triangle (non-commercial), and the GPL family
(OpenFOAM, XFOIL, AVL, gmsh, CalculiX, Elmer) — a wasm build of any of them
shipped in the bundle is distribution, and this repo is MIT. Third, the one
clean dodge for the hardest infrastructure problem (3D tet meshing for
FEM/CFD) is to not mesh at all: voxel/cut-cell methods consume a
tessellation directly, and slopcad already has watertight tessellations from
Manifold plus a mature worker protocol with cancellation.

The repo also already owns the "engines need joints" concern: `JOINT_KINDS`
with DOF accounting and an LM pose solver exist (`mates.ts`, `mate-solver.ts`),
inertias derive from existing mass properties (`document-mass.ts`), and the
kernel-contract pattern (`GeometryKernel` + a deterministic fake for tests)
shows exactly how pluggable engines are hosted here.

## Decision

1. **Simulation intent is a document section, not a fork.** `SimScenario`
   records ride an additive `simulations` section — the configurations
   pattern: deltas over the same document, ids enforced at the add boundary
   and re-enforced at native parse, removal refusing with a
   `document/simulation-in-use` style code when referenced. Native format
   bumps to v10 — the next free stamp; v7–v9 (expression payloads,
   parameter lifecycle, `duplicate`) landed after this ADR was written —
   as a content-additive identity migration.

2. **Every solver domain = an own deterministic TS reference kernel + a
   contract + pluggable providers.** The reference kernel is bitwise
   deterministic, dependency-free, and runnable in plain vitest — it is the
   oracle and the zero-dependency baseline (the `fake-kernel.ts` precedent
   at solver scale). High-performance implementations are providers behind
   the contract: WGSL compute for flow, MuJoCo wasm for dynamics. GPU is
   mandatory per the owner's ruling, so the WGSL provider is committed
   immediately after the CPU slice, not deferred.

3. **The voxel is the geometry interface.** `Tessellation` → occupancy grid
   (+ signed-distance field for future cut-cells). No tetrahedral meshing in
   scope. Staircase boundary accuracy is stated in published accuracy bands;
   cut-cell accuracy is a dedicated later phase, not a hidden approximation.
   This decision exists as much for licensing (S8 of the roadmap) as for
   engineering: it removes the browser-meshing dependency entirely.

4. **Units: SI inside the sim boundary, canonical millimetres outside.**
   Conversion happens only in scenario compile and result projection; every
   projected quantity carries explicit units through the existing
   dimensional-value types.

5. **Interaction is a batch spine with a streaming preview.** Runs are
   deterministic jobs producing versioned results; while running, field
   updates stream to the viewport where each application is a committed,
   ledger-counted render application (`data-sim-*`). The demand-render law
   holds; there is no ambient frame loop.

6. **Results are versioned records with first-class local use.** A
   `simulation_run` table keyed to `document_version` holds binary payloads
   server-side; a local (IndexedDB) backend makes client-only use a mode,
   not a degradation; exports are deterministic `.vti` (VTK uniform grids —
   ParaView-compatible), CSV histories, and images through the existing
   snapshot pipeline. Field data never enters the document or its undo
   history.

7. **Dynamics is providerised.** A `DynamicsEngine` contract maps document
   occurrences + joint records + mass-derived inertias to a step-able model.
   The own TS reference kernel (Featherstone-style, loop closure through the
   existing LM machinery) ships first; MuJoCo (Apache-2.0, official wasm)
   follows as the performance/fidelity provider — the owner's ruling: if
   external, use the best. Rapier remains eligible later through the same
   contract.

8. **Licensing: permissive-only defaults, GPL only as separated opt-ins.**
   Own code MIT; externals Apache-2.0/BSD-3. The GPL watchlist (OpenFOAM,
   XFOIL, AVL, gmsh, CalculiX, Elmer, Palabos, TetGen, Triangle, FluidX3D)
   is documented in ROADMAP-SIM §9 and may only ever return as a
   clearly-separated plugin, never as a default dependency.

## Consequences

- Phase 63's CPU kernel can be seeded by the owner's own `cfd-ts` (D2Q9 BGK,
  bounce-back, momentum-exchange forces) — rewritten clean under MIT
  informed by it; its flaws (four-edge equilibrium boundaries, broken
  resize, commented-out worker path) become the rewrite spec.
- e2e always exercises the CPU path; GPU correctness is a tolerance harness
  against the oracle plus a manual device matrix. Bitwise determinism is
  claimed for the CPU path only — stated, not hidden.
- Boundary accuracy is voxel-limited until a cut-cell phase exists; guides
  and result panels must present accuracy bands, not false precision.
- The v10 native bump is required even though the migration is identity —
  old readers would silently drop the new section.
- Simulation failure modes join the structured-decline family (`sim/*`
  codes): an unsupported scenario is a loud decline, never a fake result.
- Phase 68 (combustion) stays deliberately provisional; reduced chemistry,
  equilibrium, and the 0D premixed (Otto) engine cycle are in scope;
  resolved reacting flow and spray (diesel-class) combustion are not —
  declined loudly, never approximated with fitted burn curves.

## Addendum (2026-10-07): phases 69–70 stay inside these decisions

The roadmap extended (ROADMAP-SIM §5, phases 69–70; owner rulings
§7.6–7.8). No decision here is reversed. Phase 69 (coarse voxel FEM) rides
Decision 3's voxel interface: "no tetrahedral meshing" still holds — the
elements are the occupancy grid's own hex cells, and MFEM remains the
raised-path escape hatch, never a default. Phase 70 (parametric
optimization, `SimStudy`) rides Decision 1's additive-section pattern and
Decision 5's deterministic batch spine — a study is a record, a campaign
is a versioned run family, and the GA loop is bitwise deterministic on the
CPU path.

## Implementation status (2026-10-08): the Phase 61 spine has landed

Phase 61 is implemented: the `simulations` and `motors` document sections
ride the native v10 identity migration (`@slopcad/cad-core`); the
`@slopcad/sim-core` package carries the S4 compile/projection boundary,
the S9 regime report, the starter fluid set (air/water/glycol), the
scenario-snapshot hash, the `SimResult` model with its `SMR1` binary
payload and the `.vti`/CSV exporters; the `sim.*` worker vocabulary over
the kernel envelope — including the progress/field-chunk notification
class, exercised end to end by the deterministic fake engine — is live
with the workbench sim worker host (`apps/web/src/sim-workbench/`); the
`SimResultStore` ships with its server backend (the `simulation_run`
table and the tRPC `simulations` router) and its local first-class
backend; and the workbench engine threads the `data-sim-*`
committed-application counters (Decision 5's ledger discipline, law S6).
Documented in `docs/guides/simulation.md` with a machine-verified
runnable example (`packages/docs-examples/src/sim/spine.ts`). No solver
exists yet: the first (2D LBM flow) is Phase 63's, the voxelizer and
field overlays Phase 62's, and the `structural` kind still declines with
`sim/scenario-kind-unsupported` until Phase 69.

## Implementation status (2026-10-08): Phase 63 is implemented

Phase 62 (the voxelizer, the signed-distance field, the field-overlay
family, the `/workbench-sim` fixture) and Phase 63 are implemented.
Phase 63 in full: the deterministic D2Q9 LBM reference kernel in
`@slopcad/sim-flow` (BGK/TRT collision, push streaming with full-way
bounce-back, Zou/He velocity and pressure boundaries, convective
outflow, no-slip/slip walls and symmetry planes, momentum-exchange
force integration with the exact per-step momentum audit); the run
orchestration layer (fixed step budgets, force histories, post-hoc
mean/fluctuation averaging per law S9, the regime wiring, the
scenario-snapshot provenance); the factor-2 grid-convergence
self-check; the real flow engine behind the `SimEngine` contract with
the geometry-aware compile door; the `/workbench-sim` product surface
(Formedible scenario authoring, the streamed run through the
committed-application ledger, persistence through the local store,
exports); the run comparison surface (two-run curve overlay + field
diff, `apps/web/src/sim-workbench/sim-compare.ts` — risk S17's exact
boundary); the known-cases gallery
(`packages/docs-examples/src/sim/gallery.ts` — cylinder Strouhal vs
Roshko's public-domain band, NACA 0012 lift slope vs the public-domain
reference with blockage stated, and the shock tube DECLINED loudly on
three machine-verified walls per the prior-art note); and the
validation fixtures — Poiseuille vs the analytic parabola, the
cylinder force audit, bitwise determinism, the half-domain symmetry
fixture (`packages/sim-flow/src/symmetry.test.ts`), and the
session-harness stages s24b/s24c/s24d. The WGSL GPU provider (Phase 64) is next; thermal stays the fake engine's until Phase 65;
`structural` still declines with `sim/scenario-kind-unsupported` until
Phase 69.

## Implementation status (2026-10-08): Phase 64 is implemented (provider + spike + fallback e2e)

Phase 64a: the WGSL compute provider lives in `@slopcad/sim-flow` —
the narrow `WgslDevice` seam with its honest feature detect
(`requestWebGpuDevice`), the D2Q9 WGSL shader mirrored buffer-for-
buffer onto the CPU layout, the provider stepper/engine behind the
Phase 61 contract, and the routed default engine serving gpu-preferred
flow scenarios on the provider with a GRACEFUL CPU-twin fallback.
Phase 64b: the WebGPU-under-Playwright/Dawn spike ran the S5
oracle-vs-GPU matrix in-browser against the production build under
Dawn's SwiftShader adapter (launch door: `--enable-unsafe-webgpu`,
probed and recorded) — every case, every repeat inside the recorded
tolerances with three-plus orders of headroom, bitwise-stable across
repeats and full harness runs — and the decision was **ADOPT into e2e
as a dedicated door** (`pnpm test:gpu-spike`), law S5 unchanged (the
session/render harnesses stay CPU-launched; the CPU oracle stays the
test truth). The spike found and fixed two real 64a defects (the
missing required pipeline `layout`; the symmetric-case zero-lift
normalizer refusal) — evidence the gate works. The WGSL step-batch
perf budget is recorded as a SOFTWARE-device ceiling (median 1228.3 ms
vs the CPU's 268 ms on the identical protocol); the hardware-class
budget is honestly not-recordable-here (no hardware adapter is
enumerable in headless Chromium on this machine). The fallback path is
e2e-pinned (session stage s24e: a gpu-preferred scenario completes on
the CPU twin when WebGPU is absent), and result summaries now carry
`servedBackend` — the machine-readable record of which kernel
executed a run. Evidence and rationale:
`docs/architecture/wgsl-prespike-findings.md` (the
`occt-prespike-findings` precedent). Thermal stays the fake engine's
until Phase 65.

## Implementation status (2026-10-10): Phase 65 is implemented (conduction, conjugate coupling, the stove)

Phase 65a: the FVM conduction domain lives in `@slopcad/sim-thermal` —
the cell-centred energy balance over the voxel cells with per-cell
materials from the extended `DocumentMaterialRecord` (re-validated at
the package's own material door), the deterministic implicit steady
solve (Jacobi-preconditioned CG, Picard-lagged full radiation, loud
iteration-cap declines) and the explicit/implicit transient march, the
complete boundary set (Dirichlet, Neumann, convection-to-ambient,
surface-to-ambient Stefan–Boltzmann in both the linearized and the
exact quartic form, and the grey-diffuse uniform-radiosity enclosure
exchange), the per-connected-component steady-anchor analysis, the
energy-conservation audit, and the S9 wiring (Prandtl always, Rayleigh
under the 61a ΔT magnitude rule). Phase 65b: the conjugate coupling
lives in `@slopcad/sim-flow` — the passive-scalar fluid thermal march
(decided over double-distribution on measured fixtures: conservative
by construction, interface-continuous at the stove's 1700:1 contrast),
the Boussinesq buoyancy force through Guo collision forcing, and the
lockstep coupled march (flow → fluid thermal → solid per coupling
interval) whose interface exchange is conservative BY CONSTRUCTION and
whose energy ledger is measured, never assumed. Phase 65c: the product
surface — the real thermal engines behind the Phase 61 `SimEngine`
contract (`@slopcad/sim-thermal`'s conduction engine for the sealed
stance, `@slopcad/sim-flow`'s CHT engine for the coupled stance — the
split exactly where the solvers live, composed by the routed default
engine which retired the interim fake-engine thermal route); the
geometry-aware compile's thermal branch (per-body tessellations → the
union occupancy slice + the per-cell material map, with the serialized
material records riding the `sim.compile` wire); the scenario record's
kind-locked thermal stance (radiation mode, steady/transient budget,
source, ambient equilibrium boundary, coupling flag); the stove demo on
`/workbench-sim` (the Formedible thermal form beside the flow form, the
temperature overlay through the Phase 62 family with the cool–warm
colormap, persistence through the same SimResultStore panel family);
the render baselines for the temperature overlay under SwiftShader and
the session stage s24f (both stove modes driven from the UI, awaited on
`data-sim-*` counters); and the runnable docs example
(`packages/docs-examples/src/sim/thermal.ts`). Honest scope stated in
the guide: the enclosure exchange is the coarse uniform-radiosity form,
the sealed mode's ambient convection is the authored constant h, and
the S9 numbers are advisory regime honesty, never CFD-grade
certificates. `structural` still declines with
`sim/scenario-kind-unsupported` until Phase 69.
