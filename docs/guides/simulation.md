# Simulation

Phase 61 laid the simulation **spine** — the data model, boundaries, and
plumbing every solver phase builds on. Phase 62 added the geometry
interface: the voxelizer (tessellation → occupancy grid + signed
distance, law S3) and the field-overlay family in the renderer, with
the `/workbench-sim` fixture page showing any document body as a grid.
Phase 63 added the first real physics: the **2D wind tunnel** — a
deterministic D2Q9 LBM reference kernel (`@slopcad/sim-flow`) behind
the `SimEngine` contract, with the run comparison surface and the
known-cases gallery closing the phase. Phase 65 added the **thermal
domain**: FVM conduction with real materials and equilibrium
boundaries, the conjugate buoyant coupling to the flow field, and the
stove demo — a heated solid conducting through its wall and convecting
to air, without fire. What does NOT exist yet: 3D flow and rotating
machinery with motor operating points (66), mechanism dynamics (67),
combustion (68), structural FEM (69 — the kind declines with
`sim/scenario-kind-unsupported` today), and parametric optimization
(70). The plan is `ROADMAP-SIM.md`; the decision record is
`docs/architecture/adr-simulation.md`.

## Scenarios are document records (law S1)

Simulation intent lives in an additive `simulations` document section:
`SimScenario` records addressed like configurations — deltas over the same
document, never a second document (the native format carries them through
the v10 identity migration). A record is canonical serialized JSON in
document space: a kind (`flow`, `thermal`, `structural`), a domain
(explicit bounds or body-derived with a margin, plus a resolution in mm),
boundary conditions, a fluid selection, optional material selections, a
gravity vector (default standard gravity, −Y), and a backend preference.
A companion `motors` section holds `DocumentMotorRecord`s (the materials
precedent: dc-brushed/BLDC/tabulated, datasheet units mN·m and rpm), and
`DocumentMaterialRecord` gained the thermal fields
(`thermalConductivity`, `specificHeat`, `emissivity`) additively.

## The two conversion sites (law S4)

SI inside, millimetres outside — and the conversions live in exactly two
functions:

- `compileSimScenario` (`@slopcad/sim-core`) — document → solver space:
  the domain's millimetres become metres, the fluid evaluates at its
  record's reference temperature, a selected motor's mN·m/rpm become
  N·m/rad·s⁻¹ (the only site), the S9 regime numbers are computed, and
  the scenario-snapshot hash is stamped. Everything downstream of this
  boundary is pure SI.
- `projectSimResult` — solver → document space: every projected quantity
  carries an explicit unit (`{name, value, unit}`).

## Regime honesty (law S9)

Every run reports the dimensionless numbers that gate its validity — Re,
Ma, Pr, Ra as applicable — computed from the scenario inputs at COMPILE
time and carried in the result summary's `regime` block with advisory
`qualitative` flags (`turbulence-dominated`, `compressibility-affected`,
`buoyancy-driven`). A flagged run still runs: the flag is honesty, not a
decline. The starter fluid set (`SIM_FLUIDS` — air, water, glycol) holds
permissive own curve fits for density and viscosity over temperature with
the sources noted in the module.

## Provenance: the scenario-snapshot hash

`simScenarioSnapshotHash` hashes the scenario record's canonical JSON
(recursively key-sorted, djb2 — a stability stamp, explicitly not
cryptographic). Identical content hashes identically regardless of key
order; any authored change moves it. The compiled scenario and every
persisted run carry it — the honest key the Phase 63 run-comparison
surface joins on.

## Results, payloads, exports (law S7)

A `SimResult` is the summary JSON (schema-versioned: status, regime,
projected quantities, the snapshot hash), field blocks (uniform grids in
document space: extent, origin/spacing mm, x-fastest values), and history
series. The field blocks encode to the deterministic `SMR1` binary
payload (`encodeSimResultPayload`/`decodeSimResultPayload`) — the bytes
that persist and the bytes the worker's `sim.finalize` returns. Every run
has deterministic exports: `exportSimFieldVti` writes ParaView-readable
VTK XML ImageData, `exportSimHistoryCsv` writes the quoting-free CSV
dialect.

Runs persist through the `SimResultStore` with two first-class backends —
server (the `simulation_run` table through the tRPC `simulations` router,
keyed to `document_version`) and local (IndexedDB; client-only use is a
mode, not a degradation).

## The `sim.*` worker protocol

The sim worker speaks the kernel worker envelope with a `sim.*` operation
vocabulary — `sim.compile` (scenario → compiled problem, minting a
problem id), `sim.run` (drive the hosted engine, streaming progress and
field-chunk notifications), `sim.finalize` (the authoritative result,
repeatable, identical bytes) — plus the cancellation ledger and the
crash-settling boot (`bootSimWorkerChannel`). The notification class is
the streaming surface: field chunks are slices of the finalized block
(gapless indices, one header per field), so a reassembled stream is
byte-identical to the persisted payload.

The hosted engine is routed (Phase 63c, extended 64a/64b and 65c):
**flow** scenarios run the real 2D LBM engine (`@slopcad/sim-flow`),
**thermal** scenarios run the REAL thermal engines (Phase 65c retired
the interim fake-engine thermal route): the coupled conjugate march
(`@slopcad/sim-flow`'s CHT engine, `thermal-cht-cpu-reference`) when
the scenario flags the coupling, the sealed conduction solve
(`@slopcad/sim-thermal`'s engine, `thermal-fvm-cpu-reference`)
otherwise — the split is exactly where the solvers live; `structural`
is declined by no engine's kind list — the Phase 69 carve. A
`gpu`-preferred flow scenario routes to the **WGSL compute provider**
(Phase 64a) when the feature detect finds a WebGPU device, and falls
back GRACEFULLY to the CPU oracle twin when it does not — never a
silent fallback you cannot see: the completed run's summary carries
`servedBackend` (`"cpu"`/`"gpu"`), the honest record of which kernel
executed it (the `/workbench-sim` fixture surfaces it as
`data-sim-served-backend`).

## The GPU path's honesty gates (law S5)

The CPU oracle stays the test truth; the WGSL provider is never
bit-asserted and never silently trusted. Three gates hold that line:

- **The oracle-vs-GPU tolerance matrix** (`GPU_ORACLE_MATRIX` in
  `@slopcad/sim-flow`): matched-step comparisons over a laminar
  scenario matrix (Poiseuille channel, cylinder attached wake,
  symmetry half-domain) with RECORDED tolerances — relative L2/L∞ on
  the nine distribution arrays, the macroscopic fields, and the force
  histories (a symmetric case's identically-zero lift compares its
  provider's rounding noise against the run's force scale). The
  comparison arithmetic is pinned headlessly; the matrix itself runs
  under any WebGPU-capable host and SKIPS LOUDLY where none exists.
- **The WebGPU e2e door** (`pnpm test:gpu-spike`): the matrix executed
  in-browser against the production build under Dawn's SwiftShader
  software adapter (`--enable-unsafe-webgpu` — the launch door the
  Phase 64b spike validated; every case, every repeat, zero violations,
  bitwise-stable across runs). A GPU-less host makes this harness fail
  loudly — the door never silently passes. The spike's evidence and
  the adopt decision are recorded in
  `docs/architecture/wgsl-prespike-findings.md`.
- **Perf budgets, honestly labeled**: `kernel.lbm2d-wgsl.referenceGrid.
stepBatchMs` (same grid, same batch protocol as the CPU budget)
  records the SOFTWARE-device cost — an upper bound on the
  correctness-path cost, not a hardware-GPU perf claim; the
  hardware-class budget is recorded as not-recordable-here in the
  findings doc until a real device run exists. The perf run's
  environment block records the adapter class beside every number.

## Committed applications in the workbench (law S6)

A running sim publishes field updates; each update the workbench APPLIES
is a ledger-counter commit — the `renderedFrames` discipline, restated.
The workbench engine carries a `data-sim-*` attribute family
(`data-sim-applied-notifications`, `data-sim-applied-field-chunks`,
`data-sim-applied-progress-step`) stamped synchronously on the settle
root, advancing ONLY when a notification actually applies (a gapped or
duplicated chunk, a retrograde step — no commit). E2E awaits these
counters, never timeouts; `frameloop="demand"` stays law, and the
Phase 62 field overlays ride the same seam — the `/workbench-sim`
fixture's grid overlay mounts only from chunks the ledger applied.

## The voxelizer and the field overlays (Phase 62, law S3)

The voxel is the geometry interface: a watertight `Tessellation` in
canonical millimetres becomes a deterministic occupancy grid (full 3D,
or a 2D cross-section slice at a plane) plus an optional
signed-distance field — `voxelizeSimTessellation` /
`voxelizeSimTessellationSlice` / `simSignedDistanceGrid` in
`@slopcad/sim-core`. A grid IS a Phase 61 field block: the same extent
triples, origin/spacing geometry, and x-fastest value order, riding
the `SMR1` payload unchanged (`simGridToFieldBlock` is the document-
space door), so grids persist, export (`.vti`), and decode through the
exact paths every other result field uses.

**Honest scope** (stated, never hidden):

- **Staircase boundaries.** Occupancy classifies node points against
  the closed solid; a sloped or curved face becomes a voxel staircase.
  That is law S3's stated accuracy band — comparative geometry A vs
  geometry B is trustworthy, absolute values carry the staircase —
  until a dedicated cut-cell phase exists (the Phase 66 decision
  point, raised against the distance field).
- **Node-centered samples.** The value at extent index (i, j, k)
  belongs to the point `origin + i·spacing` per axis — VTK
  ImageData's point-sample convention, which the `.vti` exporter
  writes. A solver's cell interpretation is the consumer's documented
  mapping, never a second grid geometry.
- **Dyadic exactness.** The classification runs in the tessellation's
  own millimetres; aligned fixtures (faces on node planes, dyadic
  coordinates) classify EXACTLY, and the mm ↔ m leg of the S4
  boundary is exact for dyadic values — any other double lands within
  1 ulp. Analytic box/sphere fixtures pin the exactness.
- **The distance field is optional.** `simSignedDistanceGrid` is never
  called by the voxelizer; computing it is a consumer choice, and it
  carries the exact Euclidean distance to the triangle soup (negative
  inside), sign taken from the occupancy classification.

The render side is the **field overlay family** (`@slopcad/cad-r3f`):
colormap slice planes, iso-contours, seeded streamlines, and vector
glyphs, painted through colormaps-as-data (the lighting-rig
precedent). Overlays mount into the `CadScene` children slot, obey the
demand-render law (one `invalidate()` per applied geometry, no frame
loop), and never enter the pick path.

**See it**: the `/workbench-sim` fixture page — a cad-jsx demo body
tessellates through the real Manifold worker, voxelizes under an
explicit domain, and renders as an occupancy grid (the colormap slice
plus the 0.5 iso-contour at the grid's mid-height node plane, with the
signed-distance field one toggle away). Each grid publishes as a chunk
stream and applies through the law-S6 ledger, so the overlay you see
is a committed application.

## The 2D wind tunnel (Phase 63) and comparing runs

A saved flow scenario with a voxelized body runs the real kernel:
scenario → geometry-aware compile (the occupancy slice at the domain's
mid-height plane) → the streamed run (Zou/He inlets, pressure/convective
outlets, no-slip/slip walls and symmetry planes, full-way bounce-back
on the voxelized body, momentum-exchange lift/drag histories) → the
persisted `SimResult` with post-hoc mean/fluctuation fields (law S9's
turbulence answer), the regime report, and — when the scenario flags
it — the factor-2 grid-convergence self-check's drift numbers. The
`/workbench-sim` panel authors scenarios (Formedible), runs them, lists
the persisted runs, and exports the decimated `.vti` series plus the
force CSV.

**Comparing two runs** (the Phase 63d comparison surface, risk S17's
exact boundary — two-run curve overlay + field diff, nothing more):
pick two persisted runs in the panel's native selects and press
Compare. You get two views:

- **Curve overlay** — both runs' drag and lift histories against one
  shared min/max window per quantity, as deterministic SVG polylines
  (`simCurveOverlayOf` in `apps/web/src/sim-workbench/sim-compare.ts`).
- **Field diff** — the same-field, same-geometry per-node difference
  rendered through the Phase 62 overlay family with the diverging
  cool–warm colormap over a symmetric window, plus the relative L2 and
  L∞ difference norms (`simFieldDiffOf`). Two runs whose grids or
  units disagree decline loudly (`sim/compare-geometry-mismatch`,
  `sim/compare-unit-mismatch`) — the surface never resamples one run
  onto another; that question is the grid-convergence ladder's, not a
  comparison's.

The diff's chunk round applies through the same committed-application
ledger as every other overlay (law S6) — the `data-sim-*` counters
advance on the commit, and e2e awaits exactly that.

## The known-cases gallery (Phase 63d)

Trust is visible, not promised: `packages/docs-examples/src/sim/gallery.ts`
holds runnable, machine-verified examples pinned to published answers,
each a deterministic scenario over the real air record with its
confounders stated.

- **Cylinder vortex shedding** — 128×48 lattice, D = 12 cells (25%
  blockage, free-slip walls, convective outflow), Re = 100: the lift
  history's oscillation period gives **St ≈ 0.231**, inside the stated
  band [0.9, 1.8]× Roshko's unconfined correlation St = 0.212(1 −
  21.2/Re) ≈ 0.167 (NACA TN 3169, public domain). The band is the
  honest qualitative window per law S9: confinement at 25% blockage
  inflates St; the suite asserts the sentence.
- **NACA 0012 lift slope** — 160×64 lattice, 48-cell chord at Re = 200:
  Cl(0°) = 0 exactly (the mirror-symmetric mask), Cl(8°) ≈ 0.80, slope
  ≈ 0.91 × the thin-airfoil 2π/rad reference (textbook inviscid; the
  NACA Report 824 experimental slope ≈ 0.11/deg at flight Re brackets
  it from above), stated band [0.7, 1.1]×, tunnel blockage ≈ 19%
  stated beside the coefficients. The Cd statement is honest about
  low-Re + staircase drag: comparative, not absolute.
- **The shock tube — declined loudly.** The researched prior art
  (AngeTheGreat's engine-simulation corpus, `docs/research/
ange-engine-sim/global-report.md` §Phase 63) leads its validation
  ladder with the Sod shock tube. This kernel declines it, on three
  machine-verified walls: the S9 compile flags the scenario
  `compressibility-affected` (shock Ma ≈ 1.75, far outside the D2Q9
  weakly-compressible Ma ≲ 0.3 validity); the Ma-1.75 inlet collapses
  the unit closure onto the τ⁺ stability floor and the kernel refuses
  it; and the Sod 10:1 atmospheric pressure ratio drives the lattice
  density non-positive at any viscosity-feasible closure. A lattice
  big enough to sneak under the mechanical checks would smear the
  discontinuity into physically meaningless output — the gallery
  states the reasoning (`SHOCK_TUBE_DECLINE_REASON`) instead of
  running it.

The suite runs each case (`packages/docs-examples/src/
docs-examples.test.ts`) and asserts every sentence above. The kernel
level carries the phase's remaining validation fixtures: the Poiseuille
channel, the static-cylinder force audit, bitwise determinism
(`packages/sim-flow/src/*.test.ts`), and the half-domain symmetry
fixture (`symmetry.test.ts`) — a symmetry-plane run at half the domain
whose fields match the mirrored full run within the stated band, with
the full run's mirror symmetry itself pinned bitwise.

## The stove: conduction and conjugate heat transfer (Phase 65)

A saved thermal scenario runs the real thermal domain end to end:
scenario → the geometry-aware compile's THERMAL branch (each referenced
body's OWN tessellation voxelized at the domain's mid-height plane,
unioned into the occupancy slice, and resolved into a PER-CELL material
map — one index per voxel, the serialized `DocumentMaterialRecord` wire
records riding the `sim.compile` input beside the per-body
tessellations) → the routed engine (the sealed conduction solve or the
coupled march, per the scenario's stance) → the persisted `SimResult`
with the S9 regime (Prandtl always, Rayleigh under the compile's ΔT
rule), the temperature extremes, the MEASURED energy-ledger facts (the
source, the convection and radiation losses, the closing imbalance),
and the temperature field as the overlay block.

The scenario record carries its solve stance as a kind-locked
`thermal` clause (a thermal scenario without one declines at the
document boundary; no other kind accepts one): the radiation mode
(off / linearized / full Stefan–Boltzmann), the steady-vs-transient
stance with its budget (duration + sample cadence, an integer
multiple), the total source power, the initial/ambient temperature,
the equilibrium boundary's ambient convection coefficient, and the
conjugate-coupling flag (transient-only — a steady coupled stance
cannot even save).

**Both modes of the demo are one form away on `/workbench-sim`** (the
Formedible thermal form beside the flow form): the SEALED mode (steady
equilibrium — every exposed face loses through the §7.12 boundary:
ambient convection plus the radiation mode's loss, so the heated plate
settles at a REAL wall temperature) and the COUPLED mode (the transient
buoyant plume — the solid conducts, the interface exchanges heat
conservatively with the fluid, Boussinesq buoyancy drives the plume,
and fixed-temperature room walls at ambient are the loss path a sealed
cavity otherwise lacks). The completed run's temperature preview round
applies through the committed-application ledger (law S6) and paints
the cool–warm colormap over the field's own range; runs persist through
the same SimResultStore panel family (law S7).

**Honest scope** (stated, never hidden):

- **Coarse enclosure radiation.** The grey-diffuse enclosure exchange
  is the uniform-radiosity form — one radiosity temperature per cavity,
  no view factors, no participating media, no spectral bands. The
  surface-to-ambient Stefan–Boltzmann loss is exact (full quartic,
  Picard-lagged) or linearized (the standard solver-friendly slope at a
  stated reference temperature — the cross-check band the fixtures
  pin).
- **Equilibrium boundaries, not CFD convection.** The sealed mode's
  ambient convection uses the scenario's authored h — a constant, not a
  solved boundary layer. The coupled mode's fluid convection is the
  2D lattice's, per the wind tunnel's own honesty bands.
- **S9 framing, not CFD-grade claims.** Pr always, Ra whenever the
  buoyancy gate's inputs exist (the largest |T − T_ref| across the
  temperature-bearing conditions); the numbers are advisory honesty
  about the regime, never a validity certificate. The stove's settled
  wall is trustworthy as a comparative equilibrium (geometry A vs
  geometry B), stated with its staircase boundary band — not a
  certified absolute.
- **The 2D slab convention.** The thermal slice is a unit-depth slab:
  every watt, joule and capacity is PER METRE OF DEPTH, the same
  convention the coupled march and the flow kernel's forces use.

## What does not exist yet

Honest inventory, per phase: 3D flow and rotating machinery with motor
operating points (66 — the WGSL provider exists and is tolerance-gated
for 2D, but 3D D3Q19 is 66's), mechanism dynamics (67), combustion
(68), structural FEM (69 — the kind declines with
`sim/scenario-kind-unsupported` today), and parametric optimization
(70). Motor thermal (I²R winding heat feeding the thermal solver,
derating curves) is likewise deferred until a ruling raises it. The GPU
path's hardware-class perf budget is likewise not recorded yet (not
recordable on the spike's software device — see
`docs/architecture/wgsl-prespike-findings.md` §4).

## The runnable examples

`packages/docs-examples/src/sim/spine.ts` walks the spine end to end: it
authors the wind-tunnel scenario, proves the snapshot hash's key-order
stability and edit sensitivity, compiles through the units/S9 boundary
(Re = ρ·V·L/μ ≈ 3.19e5 at the air record's 300 K fits — flagged
`turbulence-dominated`, Ma below the compressibility line), pins the
structural decline, encodes and decodes the `SMR1` payload, and exports
the `.vti` and CSV bytes. The suite runs it and asserts every one of
those sentences.

`packages/docs-examples/src/sim/voxel.ts` walks the Phase 62 geometry
interface over an analytic box: the explicit-domain occupancy is exact
(125 of 729 nodes for the box-in-a-box fixture, boundary nodes inside —
the closed-set convention), the z-slice resolves its plane exactly, the
signed distances at the probed nodes are exact millimetres-in-metres,
and the grid → block → payload → decode → grid door round-trips
identically. `packages/docs-examples/src/sim/gallery.ts` is the
known-cases gallery above. `packages/docs-examples/src/sim/thermal.ts`
is the Phase 65 stove walk: the kind-locked stance decline, the sealed
equilibrium's closing energy balance, the coupled plume's warmed air
and closing ledger, and both engines' end-to-end determinism. `packages/docs-examples/src/cadjsx/sim-demo-body.tsx` is
the `/workbench-sim` fixture's demo model — the plate-with-bore
cad-jsx authoring the page voxelizes.
