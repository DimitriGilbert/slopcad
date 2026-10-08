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
