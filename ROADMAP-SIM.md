# ROADMAP-SIM — the client-side simulation plan (Phases 61+)

_Epoch: 2026-09-25, branch `camera-ledger`, after Phase 59 (visualization II)
and the camera-ledger session work, with Phase 60 (hardening) believed still
pending in ROADMAP-CAD-PARITY. Simulation was raised by the owner from that
document's §5.1 out-of-scope boundary; this document is the re-opened
planning it calls for. It plans; it does not implement. The architectural
decision record is `docs/architecture/adr-simulation.md`; the owner rulings
that shaped it are logged in §7._

_Re-verified 2026-10-07 against `fixes/review-2026-10-06` (4aec48d): every
§3 inventory anchor holds. Two stale facts corrected: the parity tail this
document deferred to — 56 and 60 — had already landed (2026-09-23, before
the epoch above), and the native format has moved v6 → v9 (expression
payloads, parameter lifecycle, `duplicate`), so the sim section's identity
bump is v10, not the v7 drafted against._

_Scope extended 2026-10-07: phases 69 (structural, coarse voxel FEM) and 70
(parametric optimization) plus the worktree concurrency protocol join the
plan; the owner rulings are §7.6–7.8._

_Scope extended 2026-10-08: motor specs join the fan story — a `motors`
document section (the materials precedent), the Phase 66 operating point,
a Phase 67 transient cross-reference, and a Phase 70 co-optimization
objective; the owner ruling is §7.9._

_Scope extended 2026-10-08 (follow-up ruling): friction joins the model —
per-joint viscous/Coulomb friction in the Phase 67 dynamics contract and
an FMEP correlation making Phase 68's engine outputs brake quantities,
not just indicated; the owner ruling is §7.10._

_Scope extended 2026-10-08 (completeness batch): physics bookkeeping and
workflow completeness join the plan — regime honesty as law S9 (every run
reports the dimensionless numbers that gate its validity), fluid property
sets, gravity, boundary-condition and structural-load completeness, a
scenario-snapshot hash with a run comparison surface, and a known-cases
gallery; the owner ruling is §7.11._

_Scope extended 2026-10-08 (heat dissipation): radiation and equilibrium
boundaries join the thermal path — stoves and enclosures reach real
equilibrium temperatures and the 0D engine rejects heat through its
walls; the owner ruling is §7.12._

## 1. What this is — and what it is not

slopcad gains a simulation workbench, client-side first:

- **external flow** over bodies — a wind tunnel around any part
  (streamlines, velocity/pressure fields, lift and drag histories);
- **rotating machinery** — fans and impellers, steady (moving-reference-frame)
  and resolved rotation, torque and performance trends (driven by motor
  specs — the operating point is found, not assumed: stall/no-load curves
  meet the fan load curve);
- **conjugate heat transfer with real materials** — conduction in solids,
  convection in fluid, on one grid, driven by extended material records
  (stoves, heat sinks, enclosures), with radiation and ambient losses so
  systems reach real equilibrium temperatures;
- **thermochemistry for combustion** — equilibrium and reduced chemistry
  (0D reactors) coupled into the flow as heat release (a stove with fire in
  it) and into the mechanism layer as 0D engine cycles: premixed/Otto
  pressure-vs-crank-angle traces, torque curves, efficiency trends
  (Phase 68). Flame fronts are modeled, never resolved; spray combustion is
  out of scope (§6);
- **mechanism dynamics over the existing joint records** — engines as
  articulated mechanisms (slider-crank, valvetrain shapes) with motors,
  quasi-statically coupled to flow and combustion loads, with component
  friction modeled (per-joint viscous/Coulomb; engine FMEP) so torque and
  efficiency curves are brake, not indicated;
- **structural analysis** — coarse voxel FEM: fixtures and loads on any
  body, displacement/von Mises fields, factor of safety (comparative,
  staircase-banded; implemented last by ruling — Phase 69; tet-FEM
  fidelity stays the raised-path escape hatch);
- **parametric optimization studies** — bounded parameter subsets evolved
  against result scalars (NSGA-II), generations replayable ("the lightest
  bracket that survives the load") — Phase 70, the finale.

Positioning: **interactive and engineering-adjacent.** Qualitatively correct
flow structure, trustworthy comparative trends (geometry A vs geometry B),
respectable integrated quantities at coarse-to-medium resolution, with
accuracy bands that state their limits (voxel boundaries until a cut-cell
phase exists). It is not a RANS-suite replacement and will not pretend to be.
Nothing here requires a server: the server is a result store, never the
compute.

Per the owner's ruling, every phase ships a user-visible outcome, and phases
are ordered most-reusable-part-first (§7.1): the spine before the solvers,
the solvers before the physics couplings.

## 2. The laws every simulation phase obeys

All nine laws of ROADMAP-CAD-PARITY §1 are inherited unchanged (capability
flags with honest declines, byte-determinism of persisted data, budgets
discipline, public-API UI composition, Formedible forms, the `pnpm run
verify` gate, OCCT-first where BREP is required, docs-follow-code, OCCT
memory discipline). Simulation adds its own:

- **S1 — Scenarios are document records.** Simulation intent lives in an
  additive `simulations` document section — `SimScenario` records addressed
  like configurations (deltas over the same document, never a second
  document). Native format bumps to v10 as a content-additive identity
  migration, the exact configurations precedent (`native-format.ts`,
  `native-migration.ts`; `CAD_NATIVE_FORMAT_VERSION` is 9 today — v7
  expression payloads, v8 parameter lifecycle, and v9 the `duplicate`
  feature kind landed after this document's epoch).
- **S2 — Deterministic TS core, pluggable providers.** Every solver domain
  ships an own pure-TypeScript reference kernel: bitwise deterministic,
  runnable in plain vitest (node env, no GPU, no network) — a stance the
  researched prior art (§3) converged on independently after shipping the
  alternative: adaptive quality changed simulation results per machine and
  had to be deleted (global report §Phase 61). High-performance
  implementations — WGSL compute, MuJoCo — are providers behind a contract,
  validated against the reference. GPU is a mandatory hardware target per
  the owner's ruling, not optional polish; it lands as a provider
  immediately after the CPU slice.
- **S3 — The voxel is the geometry interface.** `Tessellation` → occupancy
  grid (+ signed-distance field). No tetrahedral meshing in scope; staircase
  boundaries are stated honestly in accuracy bands; cut-cell accuracy is a
  dedicated later phase if the owner raises it. This keeps the default
  bundle free of every browser-meshing license trap (gmsh GPL, TetGen AGPL,
  Triangle non-commercial — §9).
- **S4 — SI inside, millimetres outside.** The document is canonical-mm
  (`units.ts`); solvers run in SI. Conversion happens in exactly two places:
  scenario compile (document → solver space) and result projection (solver
  → document space, with explicit units on every projected quantity).
- **S5 — The CPU oracle is the test truth.** Unit and e2e suites assert the
  CPU path. The GPU path is gated by a tolerance harness against the oracle
  plus recorded perf budgets — never bit-asserted, never silently trusted.
- **S6 — Streaming preview is committed applications.** A running sim
  publishes field updates; each update applied to the scene is a
  ledger-counter commit (`data-sim-*`), the exact `renderedFrames`
  discipline. `frameloop="demand"` stays law; there is no ambient rAF loop.
- **S7 — Results are versioned, exportable, and client-only-capable.** Runs
  persist keyed to `document_version` with compact binary payloads, through
  a `SimResultStore` with two first-class backends: server (drizzle + tRPC)
  and local (IndexedDB) — client-only use is a mode, not a degradation.
  Every result has deterministic exports: VTK `.vti` for grids (ParaView
  reads them), CSV for histories, images via the existing snapshot pipeline.
- **S8 — Permissive-only default bundle.** Own code is MIT; externals are
  Apache-2.0/BSD-3 (MuJoCo today; NASA CEA and Cantera noted for Phase 68).
  GPL options (gmsh-wasm, WebXFOIL, openfoam-wasm) may only ever ship as
  clearly-separated opt-in plugins, never as defaults (§9).
- **S9 — Regime honesty.** Every run reports the dimensionless numbers
  that gate its validity — Re, Ma, Pr, Ra as applicable per domain —
  computed from scenario inputs at compile time. A turbulence-dominated
  or compressibility-affected scenario is flagged qualitative in the
  result summary — a `sim/*`-adjacent honesty field, not a decline; the
  run proceeds. Resolved unsteady runs may be time-averaged post-hoc
  (mean + fluctuation fields) as the turbulence answer; no-RANS stands,
  honesty replaces it.

## 3. Verified inventory — what simulation builds on

Everything below exists in code on this branch; paths are the anchors.

- **Worker transport**: versioned envelope + cancellation ledger +
  crash-settling boot (`packages/cad-kernel/src/worker-protocol.ts`,
  `worker-boot.ts`, `worker-boot-failure-report.ts`,
  `worker-cancellation.ts`), Node hosting for tests
  (`node-worker-channel.ts`). The sim worker speaks the same envelope with a
  `sim.*` operation vocabulary and one new message class: progress/field
  notifications.
- **Joints and motion**: `JOINT_KINDS` — rigid, revolute, slider,
  cylindrical, planar, ball — with DOF accounting
  (`packages/cad-core/src/mates.ts:304`), LM pose solver (`mate-solver.ts`),
  parameter-driven motion + clearance probing (`assembly-motion.ts`).
  Dynamics consumes these records; it does not replace them.
- **Materials and mass**: `DocumentMaterialRecord` — named, density in
  g/cm³ (`packages/cad-core/src/document-mass.ts:77`), aggregated to mass
  and COG. Thermal properties extend this record additively; the kernel
  contract stays analysis-free.
- **Geometry currency**: `Tessellation` from any kernel
  (`packages/cad-kernel/src/contract.ts`), watertight meshes from Manifold
  (`packages/cad-kernel-manifold`), bounds in canonical mm. This is the
  voxelizer's input.
- **Renderer**: R3F demand-render with appearance/lighting/quality-mode as
  data (`packages/cad-r3f`), snapshot and turntable export
  (`apps/web/src/cad-workbench/snapshot-export.ts`). Field overlays join
  this family.
- **Ledger counters**: the committed-application discipline
  (`workbench-engine.tsx` `renderedFrames`, the `SettleLedger` in
  `cad-scene.tsx`) that e2e awaits instead of timeouts.
- **Prior art, in-house**: the owner's `cfd-ts` — D2Q9 BGK LBM, full-way
  bounce-back, momentum-exchange force accumulation, jet colormap,
  SVG-rasterized obstacles. LGPL-2.1, but solely authored by this repo's
  owner: its ideas seed the Phase 63 kernel as a clean MIT rewrite informed
  by it, never a copy (its known flaws — four-edge equilibrium boundaries,
  broken resize, commented-out worker path — are the rewrite spec).
- **Prior art, researched**: AngeTheGreat's engine-simulation devlogs — 26
  transcripts cataloged, 276 sourced findings, at
  `docs/research/ange-engine-sim/` (`global-report.md` for the synthesis,
  `reports/report-C1.md` for the catalog, `manifest.md` for the corpus).
  Independent single-author work on a different architecture, mined for
  technique — like cfd-ts, ideas not code (his licensing is his own; nothing
  is copied). Phase-targeted cross-references are marked inline in §5.

## 4. Architecture

```
packages/sim-core      pure data + contracts, no solver logic:
                       SimScenario records, SimEngine contract, result
                       model, units boundary, voxelizer + distance field,
                       material thermal types, SimResultStore (server +
                       local backends), .vti/CSV exporters
packages/sim-flow      LBM domain: CPU reference kernel (TS) + WGSL
                       provider, 2D → 3D, force integration, rotating
                       boundaries, thermal coupling
packages/sim-combustion
                       premixed combustion chemistry (Phase 68a):
                       11-species HP equilibrium, adiabatic flame
                       temperature, fuel–air tables; promoted at birth
                       (the sim-thermal/sim-dynamics precedent), and
                       68b's reactor must not import the LBM package
packages/sim-dynamics  DynamicsEngine contract + TS reference kernel +
                       MuJoCo provider (Rapier eligible later through the
                       same contract)
packages/cad-r3f       field overlay family: colormap slices, contours,
                       seeded streamlines, glyphs (colormaps as data)
packages/db            simulation_run table (version-keyed, binary payload)
packages/api           simulations router (list/get/put runs)
apps/web               sim worker host, /workbench-sim fixture → workbench
                       panels, Formedible scenario forms
```

The split mirrors `cad-core` (pure data) vs `cad-kernel` + kernel packages
(engines behind a contract): `sim-core` never imports a solver; solver
packages never import React or the document beyond `sim-core` types.

## 5. Execution plan

### Phase 61 — Simulation foundations (the spine)

**Requirements**: `sim-core` with `SimScenario` records (kind, domain
bounds/resolution or body-derived, boundary conditions, fluid/material
selections, a gravity vector (default standard gravity, −Y — buoyancy
and self-weight consume it), motor selection for fan scenarios, backend
preference) as an
additive document section; the companion `motors` section, named records
on the S1 additive-section discipline — `DocumentMotorRecord` to match
`DocumentMaterialRecord`: kind (DC brushed / BLDC / tabulated), parameters
(stall torque, no-load speed, nominal voltage — or Kv/Kt; the tabulated
kind a torque-vs-speed point list), optional rotor inertia for the Phase
67 transient path, units authored honestly (mN·m, rpm) and converted to
SI at the S4 boundary; native v10
identity migration; the `sim.*` worker vocabulary over the existing envelope
including the progress/field-chunk notification message type; thermal
material properties — `thermalConductivity` (W/(m·K)), `specificHeat`
(J/(kg·K)), `emissivity` — additive to `DocumentMaterialRecord`; a
starter fluid property set on the same named-record precedent — air,
water, and glycol, density and dynamic viscosity as permissive own curve
fits over temperature (sources noted) plus the thermal-expansion
coefficient buoyancy needs, consumed by 63 and 65; the units
boundary module; `SimResultStore` with the server backend (drizzle
`simulation_run` keyed to `document_version`: status, summary JSON, binary
payload) and the local IndexedDB backend; result summaries gain the
regime-honesty fields (Re, Ma, Pr, Ra as applicable per domain, computed
at compile time from scenario inputs and fluid properties) and every run
records a scenario-snapshot hash — the scenario record's content hash at
run time, the honest provenance the Phase 63 comparison surface keys on;
`.vti` and CSV exporters;
`data-sim-*` committed-application counter threaded through the workbench
engine; docs guide entry + runnable example per the docs-follow-code law.
The motors anchors are carved here by the same rule Phase 69's anchors
are — the spine lays the section, the record shape, and the scenario
selection clause now so Phase 66 never reworks them; only the
operating-point solve waits for 66.

**Validation**: unit suites (node env, no network, no real DB —
`createInMemoryDb()` for router tests); worker round-trip through
`node-worker-channel`; native save/load round-trip byte-identical; v9→v10
migration fixture (identity); regime fields vs hand-computed Re/Ma/Pr;
the scenario-snapshot hash stable across identical scenarios;
fluid-property fits vs published points at their range ends;
export byte-determinism pinned; tRPC router against the in-memory DB.

**Dependencies**: none open — assemblies (50–52), configurations (57),
inspection (58), visualization (45/59) all landed, and so has the parity
tail this document deferred to: 56 (exchange breadth) and 60 (hardening
sweep) shipped 2026-09-23. Nothing in ROADMAP-CAD-PARITY remains open to
interleave with.

**Risk**: low-medium — plumbing only, but the notification message shape is
the protocol every later phase speaks; design it against a fake engine
before any real solver exists (the `fake-kernel.ts` precedent).

### Phase 62 — Voxelizer and field visualization

**Requirements**: tessellation → occupancy grid in 2D (cross-section slice)
and 3D, plus a signed-distance field (groundwork for cut-cells and
refinement — optional until Phase 66); deterministic, analytic-ground-truthed
(box/sphere occupancy exact at aligned resolutions); the cad-r3f field
overlay family — colormap slice planes, iso-contours, seeded streamlines,
vector glyphs, colormaps-as-data (the lighting-rig precedent); the
`/workbench-sim` fixture page rendering any document body as a simulation
grid. First user-visible outcome: "here is your part as a grid."

**Validation**: analytic occupancy/distance fixtures; overlay render
baselines under SwiftShader; overlay application advances `data-sim-*`.

**Dependencies**: 61.

**Risk**: medium — the distance field is where mesh-grid interpolation bugs
live; keep it behind its own fixtures and optional flag.

### Phase 63 — 2D wind tunnel (CPU reference kernel)

**Requirements**: D2Q9 LBM reference kernel in pure TS — BGK collision
first, TRT as a stability knob second; proper inflow (equilibrium +
Zou/He-style) and convective outflow boundaries — not the four-edge
equilibrium of cfd-ts — completed with the boundary-condition set real
scenarios need: a pressure outlet (ambient), a slip vs no-slip wall
choice, and symmetry planes (the primary compute saver — half the domain
for free, in natural synergy with the resolution ladders); a porous
pressure-jump zone (Darcy–Forchheimer, for filters and grilles) is named
and explicitly deferred unless a ruling raises it or it falls out
trivially; full-way bounce-back on the Phase 62 grid;
momentum-exchange force integration → lift/drag histories (the cfd-ts
lineage, rewritten); regime honesty per law S9 — Re and Ma computed from
scenario inputs and the Phase 61 fluid property set, reported in the
summary, with turbulence-dominated or compressibility-affected runs
flagged qualitative rather than declined, and resolved unsteady runs
time-averaged post-hoc (mean + fluctuation fields) as the turbulence
answer; an optional grid-convergence self-check — a per-scenario flag
that runs the same scenario at two resolutions and reports the drift (a
built-in trust indicator riding the resolution-ladder machinery);
streaming preview at interactive rates on reference
grids (~512×256); scenario authoring UI (Formedible); runs persist
through `SimResultStore`, keyed by the Phase 61 scenario-snapshot hash;
the run comparison surface — overlay two runs' history curves plus a
field-diff view in the workbench panels (first flow curves; Phase 70's
Pareto views are its multi-run generalization); exports (decimated
`.vti` field series, CSV force histories); a known-cases gallery in the
docs guide per the docs-follow-code law — runnable examples with
published answers: cylinder vortex shedding against the Re band, NACA
airfoil lift/drag vs angle of attack against public-domain data,
blockage honesty stated for the confined tunnel. The AngeTheGreat prior
art (§3) is design input for this validation layer (global report
§Phase 63/66): the shock tube as the canonical CFD fixture ahead of the
airfoil, the dissipation-versus-refinement tradeoff the grid-convergence
self-check should expect in its drift report, and cross-implementation
convergence as the strongest bug-excluder.

**Validation**: Poiseuille channel vs the analytic parabola; cylinder
vortex-shedding period vs Re (qualitative band); a half-domain symmetry
run matching the mirrored full domain; the comparison fixture — curve
overlay + field diff against two known-different runs; the
grid-convergence self-check reporting its drift on the cylinder case;
the gallery examples ARE fixtures — airfoil coefficients pinned to
public-domain data within stated bands; bitwise determinism on
repeat runs; initial perf budget recorded via the sanctioned
`PERF_BASELINE=1 pnpm test:perf` mode only; e2e wind-tunnel fixture awaiting
`data-sim-*` counters, never timeouts.

**Dependencies**: 61, 62.

**Risk**: medium — CPU preview interactivity; if TS falls short the fix is
a resolution ladder, not premature GPU work (Phase 64 is committed next
regardless).

### Phase 64 — WGSL compute backend (GPU is a must)

**Requirements**: D2Q9 compute pipeline in `sim-flow` as a provider behind
the Phase 61 contract; same memory layout as the CPU kernel (SoA
Float32Arrays mirrored into GPU buffers); feature-detect with CPU fallback;
the oracle-vs-GPU tolerance harness (L2/L∞ field deltas at matched step
counts across a scenario matrix, reference values recorded); perf budgets
on a reference integrated-GPU class; a WebGPU-under-Playwright/Dawn spike —
adopt into e2e only if stable, otherwise decline loudly (e2e stays CPU per
S5 either way; the spike findings doc follows the `occt-prespike-findings`
precedent).

**Validation**: oracle-vs-GPU matrix pinned with tolerances; fallback-path
e2e; budgets recorded; no regression in CPU-path suites.

**Dependencies**: 63.

**Risk**: medium-high — WebGPU device variance; mitigated by CPU fallback
and the oracle harness. Not skippable: the owner ruled GPU mandatory, and
3D flow (Phase 66) is impractical without it.

### Phase 65 — Thermal: conduction and conjugate heat transfer

**Requirements**: FVM conduction solver on the same voxel grid (steady +
transient); Dirichlet/Neumann/convection boundaries — completed with
equilibrium boundaries, external convection plus radiation to ambient,
so steady solves settle at real temperatures (the stove reaches a
believable wall temperature); material map from the extended
`DocumentMaterialRecord`; fluid properties from the Phase 61 starter
set; radiation is the owner-named addition (§7.12) — surface-to-ambient
Stefan–Boltzmann loss (with the standard linearized option for solver
friendliness) using the `emissivity` field Phase 61 already defined (the
field exists; the physics arrives now), and simplified grey-diffuse
surface-to-surface exchange within the enclosure as the honest coarse
in-scope form (participating-media/spectral radiation stays declined,
§6); conjugate coupling to the flow thermal field (double-distribution
vs passive scalar decided in-phase with fixtures) with Boussinesq
buoyancy named as the coupling's driving term — the stove's physical
driver, consuming the Phase 61 gravity vector and the fluid
thermal-expansion coefficient; regime honesty per law S9 — Pr always, Ra
whenever buoyancy participates; motor thermal (I²R winding heat feeding
this solver, derating curves) is explicitly deferred unless a ruling
raises it — the Phase 68 per-component-FMEP precedent; demo scenario:
heated solid → wall conduction → air convection (a stove without fire).
Parallel-eligible with Phase 64 once 63 lands.

**Validation**: 1D conduction vs analytic; lumped-capacitance transient;
enclosed-heat-source steady state vs a hand energy balance (source =
wall convection + radiation at the settled temperature); linearized vs
full Stefan–Boltzmann cross-check; a buoyant-cavity fixture (Ra band,
qualitative per law S9); closed-domain energy-conservation audit; render
baselines for temperature overlays.

**Dependencies**: 62 (grid), 63 (flow field for coupling).

**Risk**: medium — coupling stability at fluid–solid voxels; conservative
interpolation is the default answer.

### Phase 66 — 3D flow and rotating machinery

**Requirements**: D3Q19 GPU-first with the CPU oracle at reduced
resolutions; rotating boundaries — immersed moving boundary for resolved
rotation and MRF (moving reference frame) for steady fan analysis, with MRF
as the honest default and resolved rotation as the showcase; force/torque
integration; motor coupling — the MRF sweep already yields the fan load
curve T_load(ω), and a selected motor record turns it into an operating
point: the sim solves T_motor(ω) = T_load(ω), stable where
dT_load/dω > dT_motor/dω; multiple intersections are all reported with
the stable one taken, and a genuinely ambiguous pairing declines with a
`sim/*` code rather than guessing; operating RPM, airflow and ΔP at the
operating point, shaft torque, electrical and mechanical power draw,
motor+fan system efficiency, and the blade-passing frequency — BPF =
blades × operating RPM, arithmetic from the found operating point, with
resolved-run fluctuation metrics split mean/fluctuation per law S9 —
join the result summaries, and the published
fan performance chart becomes the fan curve with the operating point
superimposed; the load curve is friction-inclusive — Phase 67's per-joint
bearing drag rides the fan shaft, so the operating point and its power
figures are brake-side numbers; fixed-RPM mode remains for motor-less
scenarios — the default fan-in-a-tube demo becomes motor-driven, its
performance-trend extraction (ΔP vs flow) evaluated at the found operating
point;
resolution guidance and accuracy bands published in the guide
(staircase honesty per S3), with a fan Re guidance line — the operating
Reynolds number reported per law S9 so low-Re fan results carry their
qualitative flag; the cut-cell decision point — raise or decline
explicitly against the distance field from Phase 62.

**Validation**: oracle-vs-GPU at reduced grids; resolved-rotation torque vs
MRF cross-check; budgets; fan demo e2e fixture on the CPU path; the
operating point vs a hand-solvable fixture (linear-torque motor against a
quadratic load, closed-form intersection); BPF arithmetic pinned on the
same hand-solvable fixture; the stability criterion pinned;
the multiple-intersection decline pinned.

**Dependencies**: 64, 65 (thermal for hot-fan scenarios is optional).

**Risk**: highest in the flow line — rotating-boundary LBM is the single
hardest algorithm in this roadmap; MRF exists precisely as the fallback.

### Phase 67 — Mechanism dynamics (providerised)

**Requirements**: the `DynamicsEngine` contract — build(occurrences, joint
records, inertias from mass properties) → step/control, results as data; the
own TS reference kernel (Featherstone-style articulated-body dynamics over
`JOINT_KINDS`, loop closure through the existing LM machinery) —
deterministic, zero deps, the oracle; gravity enters as a body force —
the Phase 61 scenario vector mapped to Featherstone kernel body forces —
first-class in the contract so self-weight is honest and Phase 69's
loads share the term; the MuJoCo provider (official wasm
build, Apache-2.0, npm `mujoco`) — document→model mapping and state
round-trip; engine kinematics demo: a slider-crank built from existing joint
records with a motor, animated through the assembly-motion surface;
quasi-static load coupling — flow forces (63/66) and combustion torque
estimates (68) applied as loads. Friction is first-class in the contract:
joint records gain additive friction fields — a viscous damping
coefficient (N·m·s/rad) and a Coulomb friction-loss torque (N·m) — the
materials/motors additive-field precedent applied to the `mates.ts`
records, the geometry-kernel contract staying analysis-free (the
`DynamicsEngine` contract consumes them, not the geometry kernel).
Friction is part of `step`, not a post-pass — state-deterministic, same
inputs → same outputs, so S2 holds; the TS reference kernel implements
the viscous and Coulomb terms explicitly, and the MuJoCo provider maps
them to its native `damping`/`frictionloss` joint attributes — a
near-free mapping, validated against the reference through the existing
cross-tolerance matrix. The AngeTheGreat prior art (§3) is design input
for the friction semantics and the reference-kernel solver choice
(global report §Phase 67): friction as force-limited constraints with
emergent slip and free per-constraint reaction forces — §7.10's ruling
validated and Phase 69's structural read seeded — and solver fit decided
on evidence, not preference (CG's 10× on trusses failed to transfer to
velocity constraints; sparse Gauss-Seidel with warm starts won, iteration
counts pinned for benchmarking). Result summaries gain dissipated power and
dissipated work per joint — machine-readable, Phase 70 objective
material. The Phase 66 motor record rides the same motor abstraction as
the slider-crank demo — rotor inertia + motor torque
− aero load → ω(t), with the transient's steady state checked against the
Phase 66 operating point — a cross-reference, not a new deliverable.
Rapier stays eligible later through the same contract.

**Validation**: energy/momentum conservation fixtures for the reference
kernel; constrained pendulum vs analytic; free fall vs analytic under
the gravity body force; spin-down decay vs analytic —
viscous-only exponential, Coulomb-only a linear ramp to rest, with the
stiction posture stated honestly (breakaway taken as the same Coulomb
value; no separate stiction model unless a later ruling adds one); a
steady drag-torque fixture; the conservation audit extended with
dissipated energy = friction work; friction-bearing fixtures in the
MuJoCo-vs-reference cross-tolerance matrix; TS-kernel determinism.

**Dependencies**: 50–52 (landed); load coupling on 63/66.

**Risk**: medium-high — the document↔engine mapping layer is the real work;
the contract-first order (reference kernel before adapter) pins semantics
before any wasm enters.

### Phase 68 — Combustion and full coupling (provisional)

**Requirements**: equilibrium solver in TS (NASA-7 polynomial data — freely
redistributable with citation — Gibbs minimization) for adiabatic flame
temperatures and fuel–air tables; 0D reactor with reduced (1–2 step)
Arrhenius chemistry; progress-variable heat release coupled into the Phase
65 thermal flow — a stove with fire; and the **0D engine cycle** as a named
deliverable: the Phase 67 slider-crank supplies the chamber volume history,
the 0D chamber integrates pressure/temperature with equilibrium properties
and Wiebe/progress-variable heat release grounded in premixed flame-speed
correlations (never a fitted diesel-style burn curve), and the outputs are
the pressure-vs-crank-angle trace, IMEP, torque curve, and efficiency
trends against compression ratio, air–fuel ratio, and spark timing — the
demo is a runnable premixed (Otto) engine. The AngeTheGreat prior art
(§3) is design input for the chamber and its fixtures (global report
§Phase 68): kinetic-energy gas state whose energy bookkeeping conserves
by construction, Pulkrabek orifice valve flow, and composition/AFR as
transported state with data-driven misfire — his P/T/V-only chamber ran
with the throttle fully closed, the named failure mode. Friction makes the outputs
**brake** quantities: a Chen–Flynn-family FMEP correlation — FMEP = a +
b·p_max + c·v̄_piston (+ d·v̄_piston²) — rides the engine scenario as
fields (the motor-record precedent: coefficients per scenario entry),
defaults from published ranges with the source noted, pumping losses
included per the correlation's standard use; brake torque, brake power,
and brake thermal efficiency join the summaries beside the indicated
family — both reported, IMEP staying the gas-path truth — the
pressure-vs-crank trace unchanged, and the friction overlay on the
torque curve stated as correlation-band honest, not a component model.
Per-component breakdown (rings/bearings/valvetrain) is explicitly
deferred unless a later ruling raises it. Heat rejection closes the
balance through the walls: a Woschni-style cylinder heat-transfer
correlation rides the 0D chamber — the standard 0D move, coefficients
published-range defaults with the source noted, authored as scenario
fields per the FMEP precedent (so the adiabatic trace stays one entry
away); the energy balance becomes fuel = brake + exhaust enthalpy +
wall/coolant loss, the loss family joining the summaries beside the
indicated and brake families, and the efficiency curves turn
brake-realistic. Knock is the natural extension:
a Livengood–Wu ignition-delay integral over the unburned zone marking the
spark-advance boundary. Non-premixed (spray, diesel) combustion is declined
with a `sim/*` code at every level, not approximated. Re-plan at entry;
detail deliberately deferred.

**Validation**: equilibrium vs published table values; adiabatic reactor
energy balance; engine cycle vs textbook Otto traces (pressure–crank
signature, thermal-efficiency band) with a closed-cycle energy balance
extended to include friction dissipation and wall heat rejection
(fuel = brake + exhaust enthalpy + wall/coolant loss); brake-vs-indicated arithmetic
pinned on a hand-solvable case (friction work over the cycle = FMEP·V_d);
stove demo render baselines.

**Dependencies**: 65, 67.

**Risk**: high — chemistry data curation and coupling stiffness; explicitly
provisional.

### Phase 69 — Structural (coarse voxel FEM; implemented last by ruling)

**Requirements**: linear-elastic static analysis on the Phase 62 occupancy
grid — uniform hex-element FEM over cells the voxelizer already produces;
no new geometry interface, no new meshing law (S3 holds; this is the
thermal-precedent move, not a fourth pillar). A `structural` scenario kind
rides S1 exactly as flow and thermal do: boundary conditions are fixtures
(fixed faces) and loads (force or pressure at selected faces or points)
— completed with the body-force family: self-weight (gravity through the
Phase 61 vector), centrifugal load (an RPM body force; the fan-blade
root case, composing with Phase 66's operating RPM), and thermal
expansion load from a Phase 65 temperature field (CHT→structural
chaining — "will the bracket warp when hot").
`DocumentMaterialRecord` gains the structural fields additively —
`youngsModulus` (Pa), `poissonRatio`, `yieldStrength` for factor-of-safety
reporting — the exact Phase 61 thermal extension, again; the kernel
contract stays analysis-free. The solver is a pure-TypeScript
deterministic reference kernel (the S2 law: sparse CG/AMG over the grid,
zero dependencies, sketchable and runnable in plain vitest); positioning
is the standing honesty — comparative and stiffness-adjacent, geometry A
vs geometry B, with staircase accuracy bands stated (the risk-register S2
mitigation, unchanged). Outputs: displacement field (rendered through the
Phase 62 overlay family), von Mises field, max deflection, and factor of
safety against yield — each a `SimResultStore` summary scalar,
machine-readable, which is precisely what Phase 70 optimizes against. The
§9 MFEM note is promoted into this phase as the fidelity path should the
owner ever raise it (BSD-3 wasm, behind the same provider contract); coarse
voxel FEM is the committed default.

**Validation**: cantilever tip deflection vs beam theory; uniform
thermal expansion of a constrained bar (σ = EαΔT restrained, zero
stress free); centrifugal stress vs the closed-form thin-ring case;
self-weight sag vs beam theory where the staircase permits; the patch test
(a constant-strain field reproduced exactly); a convergence-band fixture
(deflection vs grid resolution — bands published, not hidden); FoS
arithmetic vs hand calculation; bitwise determinism of repeat runs.

**Dependencies**: 61, 62 (the grid). Composes with nothing else required —
deliberately LAST in implementation order, after 68, per the owner's
2026-10-07 ruling that strength testing enters scope "to the best ability
— kept for full implementation at the end if the backbone can support
it." The spine must carve the anchors now so 61 never reworks: the
scenario-kind vocabulary and the material-field additivity are reserved
at Phase 61 time, with structural kinds declining loudly (`sim/*`) until
this phase lands.

**Risk**: medium — voxel FEM accuracy expectations (the S2 mitigation
applies unchanged); the boundary-condition selection UX (face/point
picking for fixtures and loads) is the real product risk, not the solver.

### Phase 70 — Parametric optimization (the finale)

**Requirements**: a `SimStudy` record — document-additive, the
configurations precedent once more. The genome is a bounded subset of the
document parameter table (per-parameter min/max/step or continuous
bounds; integer/decimal kind declared; discrete/categorical genes too —
a choice among named records, e.g. a `DocumentMotorRecord`, is an
enum-valued gene); objectives are selected from result-store summary
scalars (mass today; drag/lift/ΔP from 63/66; deflection/FoS from 69;
air per watt from the Phase 66 operating-point summary — the motor in
the loop makes it a system objective; brake thermal efficiency from
Phase 68's brake summaries, and dissipation-aware system variants —
"air per electrical watt including bearing losses"); constraints are
parameter
expressions the document already validates — an invalid genome is a
structured decline (`sim/*`) that counts as dominated/penalized, never a
crash. The engine
is NSGA-II multi-objective GA as the committed algorithm — population,
generations, mutation and crossover rates as study fields; deterministic
seeding for reproducibility (the whole loop is bitwise deterministic
given the deterministic kernels, per S2/S5) — with single-objective GA as
the degenerate case. The driver rides the batch spine (§7.3): the sim
worker envelope gains an optimization-run mode that iterates compile →
parametric re-drive → solve → objective extraction per candidate,
generation-logged; live preview shows best-of-generation through the
`data-sim-*` discipline. The fitness-landscape caveat is law-adjacent
guidance: the voxel staircase quantizes objectives into plateaus and
jumps — mitigations are a resolution ladder per study, multi-seed
campaigns, and (later) distance-field-smoothed objectives once cut-cells
exist. Campaigns persist as versioned run families keyed to study +
generation (S7 unchanged); the Pareto front exports as CSV; any
individual candidate replays. UI: a Formedible study form (parameter
selection with bounds), a Pareto results view (the Phase 63 comparison
surface generalized to N runs), replay.

**Validation**: analytic optimization fixtures (a study whose optimum is
known in closed form on a toy document); reproducibility (same seed →
same front); candidate-refusal handling (penalized, not crashed); e2e
fixture awaiting the ledger counters.

**Dependencies**: 61 (studies ride the spine) plus at least one
objective-bearing phase — 63 is the minimum; the showcase objective set
is 63+66+69, mass vs drag vs FoS. The two named demo scenarios: "the
lightest bracket that survives the load" and "the most efficient fan" —
the latter now motor+fan co-optimization, the motor record a gene beside
the fan geometry.
Added at the end by the owner's 2026-10-07 ruling — after structural,
nothing after it.

**Risk**: medium — cost per evaluation (re-drive + re-voxelize + solve,
multiplied by population × generations); mitigated by resolution ladders,
early-terminated generations, and coarse-first objectives; never a server
farm (§6 stands).

### Sequencing

```
61 spine → 62 voxels/viz → 63 2D flow (CPU) → 64 GPU provider
                                   │
                                   ├──→ 65 thermal ──→ 66 3D/fans ──→ 67 dynamics
                                   │                            │              │
                                   │                            └── 68 combustion ←┘
                                   │
                                   └──────────→ 69 structural (last, by ruling)
                                                        │
                                                        └──→ 70 optimization (the finale)
```

Milestones for the owner: **M-S1 "the spine"** (61–62), **M-S2 "watch it
flow"** (63–64), **M-S3 "feel the heat"** (65), **M-S4 "fans in 3D"** (66),
**M-S5 "engines move"** (67), **M-S6 "fire"** (68), **M-S7 "hold the
load"** (69), **M-S8 "evolve"** (70). Phases 69–70 are deliberate tail
phases (§7.6–7.7): their data dependencies are the spine and the
objective-bearing solvers alone, but both land after 68 by ruling.

### Concurrent execution protocol (worktrees)

The owner asked (2026-10-07) whether this plan exploits git worktrees for
concurrent, relatively isolated phases even where files overlap,
reconciled by a reconciliation step. It does; the protocol was proven on
this very repo by the `fixes/review-2026-10-06` run (13 commits, landed
2026-10-07):

- **One worktree per phase-in-flight**, branched from the same validated
  base tip; per-phase validated commits (implement → independent
  validation → full gate → commit) keep every worktree always-green.
- **Disjoint-file phases run fully concurrent** — the run's Phases 6/7
  pattern: 4 and 3 parallel implementers on strictly disjoint files, with
  validators fired per landing.
- **File overlap does not block concurrency; it changes the merge
  shape.** Overlapping phases run concurrently in their worktrees and
  land through an explicit reconciliation phase: a sequential
  merge/rebase order fixed in advance by the plan (lowest-churn first),
  then a full-gate re-validation of the reconciled tree and one merge
  commit, squashed or plain. The run's phase-wide validators are the
  template for that re-validation.
- **Protocol lines that made it work**: never hand-resolve a semantic
  conflict silently — a conflicting hunk in shared files
  (`registry.json`, `native-format.ts`, the workbench engine) gets a
  dedicated reconciler pass with its own validation; the base tip only
  ever advances through validated commits; user-owned uncommitted files
  are never touched by any worktree (worktrees share nothing of the main
  tree's dirty state).

Applicability to this plan: 61 — the spine, touching many shared files
(native format, db, api) — is the serial anchor; 63/65/67 are
worktree-concurrent candidates from day one (new packages, disjoint by
construction); 62/66 share `cad-r3f` and land through reconciliation;
69/70 open new surfaces again.

## 6. Out-of-scope boundary (explicit, overridable by the owner)

RANS/LES-grade turbulence modeling; full aeroacoustics (FW-H and
friends — Phase 66's BPF arithmetic is the honest ceiling);
adaptive/unstructured meshing and tet FEM — coarse voxel structural
analysis is IN at Phase 69, riding the existing grid, and tet/adaptive
FEM stays declined with MFEM→wasm as the raised-path escape hatch;
resolved 3D reacting flow with detailed chemistry;
non-premixed/spray combustion (diesel-class: liquid injection,
atomization, evaporation, mixing-controlled burn — the premixed/Otto
path is in scope at the 0D cycle level, spray is declined at every
level); participating-media/spectral radiation (the grey-diffuse
enclosure exchange of Phase 65 is the coarse in-scope form);
fluid–structure interaction (Phase 69 is one-way load application, not
FSI); buckling (thin-part instability — Phase 69 is linear-elastic
statics, no stability path); contact/collision dynamics in the reference
kernel (the MuJoCo provider may expose its own); server-side solve farms;
GPL components in the default bundle. Raising any of these re-opens this
document.

## 7. Decision log (owner rulings: 2026-09-25, 2026-10-07, 2026-10-08, and 2026-10-12)

1. **First vertical slice: the 2D wind tunnel**, under the global ruling
   that phases are ordered most-reusable-part-first with a quick, visible
   outcome at every step.
2. **Dynamics is providerised.** An own TS reference kernel always ships
   (the oracle and the zero-dependency baseline); if an external engine is
   used, use the best — MuJoCo first (performance and solver quality are
   the criteria), Rapier eligible later through the same contract.
3. **Interaction: batch spine + live preview — but GPU is mandatory.**
   Performance must be decent; hence the WGSL provider is committed
   immediately after the CPU slice (Phase 64), not deferred.
4. **Persistence: new DB tables**, designed from day one for easy export
   and for client-only use — the local store backend is first-class, not a
   fallback.
5. **Combustion follows the premixed line** (follow-up ruling, same day):
   the 0D premixed engine cycle (Otto) is a named Phase 68 deliverable —
   pressure traces, torque curves, efficiency trends, knock via
   Livengood–Wu as the extension — while spray/mixing-controlled diesel is
   declined at every level rather than approximated with fitted curves.
6. **Structural is coarse-first and last** (2026-10-07): strength testing
   enters scope "to the best ability — kept for full implementation at
   the end if the backbone can support it." Phase 69 rides the existing
   voxel law — no tet meshing, no new geometry interface — and the spine
   reserves the scenario-kind vocabulary and the material-field
   additivity now so 61 never reworks.
7. **Parametric optimization is the finale** (2026-10-07): Phase 70,
   NSGA-II over bounded document parameters against result-store summary
   scalars; added at the end, after structural, nothing after it.
8. **Concurrency runs on worktrees** (2026-10-07): one worktree per
   phase-in-flight, always-green validated commits, reconciliation for
   overlapping landings — the §5 protocol, proven by the
   `fixes/review-2026-10-06` run on this repo.
9. **Motors are part of the fan sim** (2026-10-08): "for fans, I'd like
   to be able to provide motor spec and this should be part of the sim."
   Motor specs enter as an additive `motors` document section — the
   materials precedent, carved at the Phase 61 spine — fan scenarios gain
   a motor selection, Phase 66 finds the fan's operating point instead of
   assuming an RPM, and the Phase 70 fan showcase gains motor+fan
   co-optimization.
10. **Component friction goes in — brake, not just indicated**
    (2026-10-08, follow-up ruling): "FMEP for the engine path, joint
    friction in the dynamics contract." Phase 67's joint records gain
    additive viscous/Coulomb friction fields that the `DynamicsEngine`
    contract consumes; the Chen–Flynn FMEP overlay turns Phase 68's
    engine outputs into brake quantities, indicated figures still
    reported alongside.
11. **Physics bookkeeping and workflow completeness** (2026-10-08,
    consolidated): "all your propositions are great." Regime honesty
    becomes law S9 — every run reports the dimensionless numbers that
    gate its validity, and turbulence- or compressibility-limited runs
    are flagged qualitative, not declined; fluid property sets join the
    Phase 61 spine (the materials precedent); gravity and Boussinesq
    buoyancy ride the scenario record; flow boundary conditions and
    structural loads reach working completeness; every run carries a
    scenario-snapshot hash and the workbench gains the run comparison
    surface (Phase 70's Pareto view is its multi-run generalization); a
    grid-convergence self-check and a known-cases gallery make trust
    visible instead of promised.
12. **Heat dissipation is in** (2026-10-08): "very important for the
    stove/engine simulation." Phase 65 gains radiation —
    surface-to-ambient Stefan–Boltzmann (linearized option) on the
    already-defined `emissivity` field, plus grey-diffuse
    surface-to-surface exchange in the enclosure — and equilibrium
    boundaries so steady solves settle at real temperatures; Phase 68's
    0D chamber gains a Woschni-style wall heat-transfer correlation so
    the engine energy balance closes as fuel = brake + exhaust enthalpy +
    wall/coolant loss.
13. **Combustion is born promoted** (2026-10-12, docs-follow-code):
    Phase 68a's chemistry ships as `packages/sim-combustion`, not as a
    module inside sim-flow — a deliberate deviation from §4's original
    epoch diagram, applying the sim-thermal/sim-dynamics precedent at
    birth. The dependency rule it fixes: 68b's 0D reactor builds on
    sim-combustion and must not import the LBM package.

## 8. Risk register

| #   | Risk                                                                                           | Phases         | Severity    | Mitigation                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------- | -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | WGSL provider device variance and correctness                                                  | 64, 66         | high        | CPU fallback everywhere; oracle tolerance matrix; budgets on a reference GPU class                                                                                                   |
| S2  | Staircase-boundary accuracy expectations                                                       | 63, 66         | medium      | publish accuracy bands; distance field (62) enables a dedicated cut-cell phase if the owner raises it                                                                                |
| S3  | Rotating-boundary LBM (resolved rotation)                                                      | 66             | highest     | MRF as the honest default; resolved rotation scoped as showcase                                                                                                                      |
| S4  | WebGPU unreachable in e2e (SwiftShader)                                                        | 64+            | medium      | S5: e2e asserts the CPU path; GPU gated by the oracle harness + a manual device matrix                                                                                               |
| S5  | Result payload growth (field series)                                                           | 61, 63         | medium      | binary payloads, decimation on export, never stored inside the document                                                                                                              |
| S6  | Scope creep toward full-multiphysics parity                                                    | all            | medium      | §6 is law; phases ship visible outcomes instead of fidelity promises                                                                                                                 |
| S7  | Low-end GPU throughput                                                                         | 64, 66         | medium      | resolution ladders + quality modes (the `render-quality.ts` precedent)                                                                                                               |
| S8  | Document↔engine mapping complexity (dynamics)                                                  | 67             | medium-high | contract-first; TS reference kernel pins semantics before the MuJoCo adapter                                                                                                         |
| S9  | Chemistry data curation and coupling stiffness                                                 | 68             | high        | provisional phase; reduced mechanisms only; NASA-7 data redistributable with citation                                                                                                |
| S10 | Voxel FEM accuracy expectations (staircase stiffness)                                          | 69             | medium      | the register-S2 mitigation unchanged: accuracy bands, comparative framing, convergence-band fixtures; MFEM stays raised-path-only                                                    |
| S11 | Optimization cost per evaluation (re-drive + re-voxelize + solve per candidate)                | 70             | medium      | resolution ladders; early-terminated generations; coarse-first objectives; the §6 server-farm boundary stands                                                                        |
| S12 | Reconciliation complexity across concurrent worktrees                                          | 61+            | medium      | merge order fixed in advance (lowest-churn first); dedicated reconciler pass with its own validation; full gate re-run on the reconciled tree                                        |
| S13 | Motor-curve data quality and operating-point ambiguity                                         | 61, 66         | medium      | units and ranges validated at record entry; multi-intersection cases report all candidates and decline (`sim/*`) unless exactly one is stable                                        |
| S14 | Friction-model honesty (FMEP coefficient provenance, stiction simplification)                  | 67, 68         | medium      | published-range defaults with sources noted; correlation-band framing on brake quantities; the stiction posture stated, raisable by ruling                                           |
| S15 | Radiation simplification honesty (grey-diffuse surface-to-surface is a coarse enclosure model) | 65             | medium      | the coarse form stated as such; hand energy-balance fixture (source = convection + radiation at settled T); linearized vs full cross-check; participating media declined loudly (§6) |
| S16 | Regime-guard thresholds advisory, not exact validity gates                                     | 61, 63, 65, 66 | medium      | flags are honesty markers, never acceptance certificates; thresholds published with sources; near-boundary runs carry the qualitative framing                                        |
| S17 | Comparison-tooling scope creep (diff views becoming dashboards)                                | 61, 63, 70     | low         | the surface is two-run curve overlay + field diff, nothing more; Pareto is its N-run generalization; new views need a ruling                                                         |

## 9. Prior art and the licensing minefield (researched 2026-09)

Adopted (permissive): **MuJoCo** — Apache-2.0, official wasm build and npm
package, very active — for Phase 67. Noted for Phase 68: **NASA CEA** (now
Apache-2.0 on GitHub, small enough to compile) and **Cantera** (BSD-3, wasm
support merged 2026-03, Pyodide-sized). Noted escape hatch for any future
tet-FEM: **MFEM** (BSD-3). Existence proofs studied for the WGSL provider:
current WebGPU LBM implementations (e.g. WebLBM) — references only, license
unverified, no code borrowed.

Declined for the default bundle by license: OpenFOAM, XFOIL (+ its wasm
ports), AVL, gmsh (+ gmsh-wasm), CalculiX, Elmer, xflr5 (GPL family);
Palabos (AGPL); TetGen (AGPL); Triangle (non-commercial); FluidX3D (custom
non-commercial license — and OpenCL, which has no browser path regardless).
Any of these can return later as a clearly-separated opt-in plugin; none
may ever be a default dependency.
