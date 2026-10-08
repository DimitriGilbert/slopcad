# Simulation

Phase 61 laid the simulation **spine** — the data model, boundaries, and
plumbing every solver phase builds on. Phase 62 added the geometry
interface: the voxelizer (tessellation → occupancy grid + signed
distance, law S3) and the field-overlay family in the renderer, with
the `/workbench-sim` fixture page showing any document body as a grid.
This guide is honest about what that means: as of Phase 62 there is
still NO solver. The first real physics (2D LBM flow) is Phase 63's;
structural analysis is Phase 69's, reserved in the vocabulary and
declined loudly until then. What exists today is everything AROUND the
solvers: the scenario records, the units and regime-honesty boundaries,
the run/result model with its binary payload and exports, the worker
protocol, the result store, the voxelizer and overlays, and the
committed-application counters the workbench awaits. The plan is
`ROADMAP-SIM.md`; the decision record is
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

The hosted engine is, today, the deterministic **fake engine**
(`FAKE_SIM_ENGINE`) — the `fake-kernel` precedent: it exercises every
protocol path (scheduled progress, three chunk rounds whose final round
reassembles to the finalized blocks, honest declines, cooperative
cancellation) until Phase 63's real kernel replaces it behind the same
`SimEngine` contract.

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

## What does not exist yet

Honest inventory, per phase: the 2D wind-tunnel CPU kernel and the
WGSL GPU provider (63/64), thermal
(65), 3D flow and rotating machinery with motor operating points (66),
mechanism dynamics (67), combustion (68), structural FEM (69 — the kind
declines with `sim/scenario-kind-unsupported` today), and parametric
optimization (70).

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
identically. `packages/docs-examples/src/cadjsx/sim-demo-body.tsx` is
the `/workbench-sim` fixture's demo model — the plate-with-bore
cad-jsx authoring the page voxelizes.
