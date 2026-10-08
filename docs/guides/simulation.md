# Simulation

Phase 61 lays the simulation **spine** — the data model, boundaries, and
plumbing every solver phase builds on. This guide is honest about what
that means: as of Phase 61 there is NO solver. The first real physics
(2D LBM flow) is Phase 63's; the voxelizer and field overlays are Phase
62's; structural analysis is Phase 69's, reserved in the vocabulary and
declined loudly until then. What exists today is everything AROUND the
solvers: the scenario records, the units and regime-honesty boundaries,
the run/result model with its binary payload and exports, the worker
protocol, the result store, and the committed-application counters the
workbench awaits. The plan is `ROADMAP-SIM.md`; the decision record is
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
counters, never timeouts; `frameloop="demand"` stays law, and no overlay
rendering rides this seam yet (Phase 62 owns the field-overlay family).

## What does not exist yet

Honest inventory, per phase: the voxelizer and field visualization (62),
the 2D wind-tunnel CPU kernel and the WGSL GPU provider (63/64), thermal
(65), 3D flow and rotating machinery with motor operating points (66),
mechanism dynamics (67), combustion (68), structural FEM (69 — the kind
declines with `sim/scenario-kind-unsupported` today), and parametric
optimization (70).

## The runnable example

`packages/docs-examples/src/sim/spine.ts` walks the spine end to end: it
authors the wind-tunnel scenario, proves the snapshot hash's key-order
stability and edit sensitivity, compiles through the units/S9 boundary
(Re = ρ·V·L/μ ≈ 3.19e5 at the air record's 300 K fits — flagged
`turbulence-dominated`, Ma below the compressibility line), pins the
structural decline, encodes and decodes the `SMR1` payload, and exports
the `.vti` and CSV bytes. The suite runs it and asserts every one of
those sentences.
