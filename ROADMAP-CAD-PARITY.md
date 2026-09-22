# ROADMAP-CAD-PARITY — the everything-a-real-CAD-has plan

_Epoch: 2026-09-20, branch `design-final`, after Phase 35 (Compatibility and
Release Hardening) plus the deep-review and design-vision rounds. The owner's
ruling: the product must have EVERYTHING a real CAD software has — not a
curated subset. This document is the definitive gap inventory and the phased
execution plan. It plans; it does not implement._

The comparison surface is the modeling feature surface of Fusion 360,
SolidWorks, FreeCAD, and Onshape: sketching, part features, surfacing,
assemblies, drawings, visualization, curves, datums, exchange, parameters,
inspection. Adjacent disciplines a CAD vendor bolts on top — CAM toolpaths,
FEM/simulation, PCB/electronics, PDM workflow — are **out of parity scope**
(the owner can overrule; they are listed in §5.1 so the boundary is explicit,
not silent).

Every claim about what exists below was verified in code on this branch.
File paths are the anchors.

---

## 1. The laws every phase obeides (binding constraints)

These are the repo's established contracts. Each phase's Requirements assume
them; each phase's Validation enforces them.

1. **Capability-flagged kernels with honest declines.** Every new kernel
   operation extends `GeometryKernel`
   (`packages/cad-kernel/src/contract.ts`) AND `KernelCapabilities`
   (`packages/cad-kernel/src/capabilities.ts`) with a flag; a kernel that
   cannot do it honestly answers the structured `kernel/unsupported-operation`
   — never a silent approximation. The contract suite
   (`packages/cad-kernel/src/contract-suite.ts`) gates fixtures per flag, and
   every new feature kind rides the fake kernel's reference semantics or
   declines loudly (see the fillet/chamfer/shell precedent in
   `packages/cad-kernel/src/fake-kernel.ts`).
2. **Byte-determinism everywhere.** Native format resaves byte-identical
   (`packages/cad-core/src/native-format.ts`; the suite pins it); every new
   document-model growth (assemblies, sheets, appearances, drawings,
   configurations) bumps `formatVersion` with a migration in
   `native-migration.ts`. STEP export refuses nondeterministic bytes
   (`STEP_EXPORT_EPOCH_STAMP`, `step-export/nondeterministic`); any new
   exporter (SVG, PDF, DXF) inherits the same discipline. Render baselines:
   the deterministic `RenderCamera` spec stays law — **user-initiated camera
   state is a session overlay that must not break baselines** (Phase 45
   designs this).
3. **`budgets.json` is never edited.** Existing rows are immutable; a phase
   that adds perf-relevant surface records new budgets only through the
   sanctioned `PERF_BASELINE=1 pnpm test:perf` recording mode
   (`apps/web/e2e-perf/budgets.json`, `docs/architecture/performance-baselines.md`).
4. **All UI through public APIs.** Workbench surfaces compose through the
   slot/hook architecture (`apps/web/src/cad-workbench/complete-workbench.tsx`,
   `workbench-engine.tsx`, `@slopcad/cad-react`, the
   `packages/ui/src/components/cad/*` family). No reaching into internals.
5. **Formedible for every new form** (`packages/ui/src/components/formedible`
   - the `formedible` skill): thread/hole dialogs, mate editors, drawing
     sheet setup, configuration tables — config objects, not long TSX.
6. **`pnpm run verify` is the gate** (check-types → lint → test → build);
   fix every error at the cause; no `any`; `import type` under
   verbatimModuleSyntax; import ordering per house style.
7. **OCCT-first where the BREP engines are required, honest declines
   elsewhere.** Surface modeling, HLR drawings, local face ops, and helical
   sweeps are OCCT territory; Manifold/JSCAD/fake decline with the structured
   code. Probe before promising: the binding truth lives in
   `docs/architecture/occt-prespike-findings.md` — XCAF (`STEPCAFControl_*`)
   is NOT bound (STEP names/colors unreachable today),
   `BRepBuilderAPI_GTransform` is NOT bound (non-uniform scale unavailable;
   uniform scale rides `gp_Trsf`), but `HLRBRep`, `BRepFeat`,
   `GeomAPI_Interpolate`, `Geom_BSplineCurve/Surface`, and
   `BRepAlgoAPI_Section` ARE bound in `replicad-opencascadejs@1.1.0`
   (verified against its `dist/replicad_multi.d.ts`).
8. **Docs follow code**: every new public API gets a guide entry in `docs/`
   and, where browser-safe, a runnable `packages/docs-examples` example;
   `pnpm test:docs` gates the `/docs` page.
9. **OCCT memory discipline** (`.delete()` every embind wrapper, extract-
   copy-immediately out of the WASM heap) applies to every new adapter path.

---

## 2. Verified inventory — what EXISTS (all confirmed in code)

### 2.1 Packages and layers

| Layer               | Package(s)                                                  | Verified surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Document model      | `@slopcad/cad-core`                                         | Documents (params/bodies/features/sketches/references), features are open-`kind` records with 5 input kinds (`parameter`/`feature`/`body`/`sketch`/`reference` — `src/document.ts`), parameters + expression AST/parser/evaluator (`src/expression*.ts`), units with canonical mm (`src/units.ts`), transactions + undo/redo history (`src/transaction.ts`, `src/history.ts`), diff-based regeneration with stale-marking (`src/regeneration.ts`), persistent topology references (`src/persistent-reference.ts`), selection (`src/selection.ts`), headless tool system (`src/tool-*.ts`: select/measure/translate/rotate + tool manager/context/events), synthetic faces for picking (`src/synthetic-faces.ts`), renderer-neutral projection + camera spec (`src/projection.ts`), native format with migrations (`src/native-format.ts`), measurement: bounds/distance/radius/mass-properties (`src/bounds.ts`, `src/distance.ts`, `src/radius.ts`, `src/mass-properties.ts`) |
| Kernel contract     | `@slopcad/cad-kernel`                                       | `GeometryKernel`: box/sphere/cylinder/cone, extrude, revolve, sweep (planar XZ path, G1), loft (ruled index-morph), fillet, chamfer, shell, union/subtract/intersect, transform (translate+rotate), mirror (world axis planes), bounds/volume/area/tessellate/dispose (`src/contract.ts`); 15 capability flags (`src/capabilities.ts`); worker protocol with 24 ops (`src/worker-operations.ts`: `solid.*` ×20, `step.import/export`, `brep.import/export`); no-throw WASM boundary; diagnostic log; stale-result guard                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Bridge (doc→kernel) | `@slopcad/cad-kernel` `src/core-bridge.ts`                  | `BRIDGE_FEATURE_KINDS` (17): box, sphere, cylinder, cone, union, subtract, intersect, translate, extrude, revolve, fillet, chamfer, shell, patternLinear, patternCircular, mirror, hole — with structured diagnostics, reference resolution against current-regeneration topology, capability gates, volume post-conditions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Kernels (4)         | fake / manifold / occt / jscad                              | fake: analytic reference (fillet/chamfer/shell on documented box subsets, declines elsewhere); manifold: exact mesh booleans/extrude/revolve, declines sweep/loft/fillet/chamfer/shell; occt: BREP-exact everything incl. sweep/loft/fillet/chamfer/shell/mirror + persistent topology + STEP/BREP IO; jscad: sweep/loft/mirror, declines fillet/chamfer/shell                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Sketch domain       | `@slopcad/cad-sketch`                                       | Entities: point/line/circle/arc/rectangle (+ construction + fixed pins); constraints (13): coincident, horizontal, vertical, parallel, perpendicular, distance, angle, radius, diameter, equal, tangent(external/internal), midpoint, symmetry(about point/line); deterministic solver with DOF reporting and statuses solved/under-constrained/failed + conflicting/unsatisfiable/redundant/not-converged diagnostics (`src/solver.ts`, `src/solver-math.ts`, `src/reference-solver.ts`); profile resolution with exact self-intersection detection (`src/profile.ts`); arbitrary workplanes (`src/workplane.ts`) + placement→kernel rotation (`src/workplane-placement.ts`); sketch fixtures                                                                                                                                                                                                                                                                                 |
| Renderer            | `@slopcad/cad-r3f`                                          | Deterministic scene camera from `RenderCamera` spec — perspective/ortho, spec-is-law, no auto-framing (`src/scene-camera.ts`); picking + selection highlight; ground/grid/axes/lights; fixed palette + model material color; demand-frame rendering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| IO                  | `@slopcad/cad-io` + occt                                    | STL binary+ASCII (deterministic), 3MF export (browser) / import (Node zlib), GLB export; STEP export (AP214IS/AP203/AP242DIS, units, deterministic epoch stamp), STEP import (solids, mm canonical, provenance literal, no names/colors — XCAF unbound), BREP import/export, IGES import (mesh-only via `occt-import-js@0.0.23`); native parametric format (only format carrying history)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Workbench UX        | `apps/web/src/cad-workbench` + `packages/ui` CAD components | 8 composed surfaces (toolbar, command menu Ctrl+K, viewport, model tree, property panel, parameter panel, timeline, status bar) + IO dialogs; command menu: undo/redo/clear-rollback/clear-selection/sketch/hole/export/import; create bridges: extrude/revolve/hole; sketch mode with drawing tools (select/line/circle/rectangle/trim/construction) + 12 constraint tools (`src/sketch-editor.ts`); inspection readouts (bounds/distance/radius/mass); rollback marker + suppression; a11y-hardened                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Components/registry | `@slopcad/cad-components`                                   | Component contract + direct/context kernels; `enclosure`, `nema17Mount`, `arduinoMount`; registry distribution (`packages/ui/registry.json` → shadcn build → consumer fixtures)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Persistence         | `@slopcad/api` + web                                        | tRPC routers `projects`/`documents` (Drizzle/SQLite); project workbench page with native-document bridge + latest-content gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Tests               | all                                                         | Vitest unit suites colocated; Playwright families: smoke, worker, render (incl. fillet/sketch/io-step/brep-iges/measurement specs), workbench, matrix, a11y, components, docs, projects, perf (budgets enforced)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### 2.2 The honest caveats inside "exists"

- **Sweep and loft exist ONLY at the kernel-contract level.** They are NOT in
  `BRIDGE_FEATURE_KINDS`, NOT in `WORKER_OPERATION_IDS`, and have no workbench
  command. A user cannot author one.
- **Fillet/chamfer/shell/patterns/mirror/booleans exist as bridge feature
  kinds** (and as worker ops + fixture pages + e2e specs), but the complete
  workbench's command surface exposes only extrude/revolve/hole. The rest are
  engine-level, not user-level.
- **Booleans are user-reachable only through fixture pages.**
- **Fillet/chamfer are edge-based** (snapshot ordinals resolved from
  persistent references) with a shared radius/distance — no variable-radius
  fillets, no asymmetric chamfers.
- **Patterns are body-level** (count/spacing/axis selectors are world-axis
  integers), not feature-level or path-driven; no skip instances.
- **Mirror is world-axis-plane + offset only** (no arbitrary/datum planes).
- **Hole is a composed straight cut** (diameter/depth/position/axis) — no
  counterbore/countersink/taper/thread.
- **IGES is import-only and yields meshes**, never solids.
- **STEP import loses names/colors** (XCAF unbound — probed).
- **The camera is spec-only** — there is no interactive orbit/pan/zoom; the
  viewport is a fixed 800×520 determinism-contract box.

---

## 3. Gap analysis — slopcad vs the real-CAD surface

Classification: **MISSING** (nothing), **PARTIAL** (exists with named limits),
**PRESENT** (parity-grade for this axis).

### 3.1 Sketch entities & constraints

| Capability                                   | Status  | Evidence / what's partial                                                                                                                                  |
| -------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| line / circle / arc / point / rectangle      | PRESENT | `SKETCH_ENTITY_KINDS`                                                                                                                                      |
| construction geometry, fix pins              | PRESENT | entity flags                                                                                                                                               |
| trim                                         | PARTIAL | one trim tool in `SKETCH_DRAWING_TOOLS`; no extend, no offset/mirror/rotate-array entity ops, no convert-entities (projecting model edges into the sketch) |
| splines (interpolated / control-point)       | MISSING | no entity kind; no solver rows; no profile chord semantics                                                                                                 |
| ellipse / elliptical arc                     | MISSING |                                                                                                                                                            |
| regular polygon (n-sided)                    | MISSING | rectangle only                                                                                                                                             |
| slot (straight/arc)                          | MISSING |                                                                                                                                                            |
| point-on-entity (on line/arc/circle/spline)  | MISSING | big one: real sketching leans on it                                                                                                                        |
| collinear                                    | MISSING | `SKETCH_CONSTRAINT_KINDS` has 13 kinds, no collinear                                                                                                       |
| horizontal/vertical on point PAIRS           | PARTIAL | H/V are line-only today                                                                                                                                    |
| distanceX / distanceY                        | MISSING | distance is point-pair only                                                                                                                                |
| tangent at endpoint (sense-carrying)         | PARTIAL | modeled as tangent + coincident (documented workaround)                                                                                                    |
| spline-tangent/curvature constraints         | MISSING | depends on splines                                                                                                                                         |
| equation-driven curves                       | MISSING | expression engine exists (`cad-core/src/expression-evaluator.ts`) — no curve consumer                                                                      |
| dimension display / drag-with-constraints UX | PARTIAL | constraint tools exist; canvas dimension rendering and interactive drag re-solve are minimal                                                               |

### 3.2 3D part features

| Capability                                  | Status  | Notes                                                                                                                                             |
| ------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| extrude                                     | PRESENT | profile + signed distance; no taper/draft, no multi-body per-side, no thin-glyph extrude                                                          |
| revolve                                     | PRESENT | angle + in-plane axis; axis via angle selector, not a line/datum                                                                                  |
| sweep along path                            | PARTIAL | kernel-only; planar XZ G1 paths; no user feature, no 3D paths, no guide rails, no twist control                                                   |
| loft                                        | PARTIAL | kernel-only; station-z sections; no user feature, no rails, no closed loft, no centerline                                                         |
| fillet                                      | PARTIAL | edge-based, shared radius; no variable radius, no face fillet, no full-round                                                                      |
| chamfer                                     | PARTIAL | symmetric distance only; no asymmetric (two-distance/angle), no vertex chamfer                                                                    |
| shell                                       | PARTIAL | uniform thickness, ≥1 removed face; no closed hollow (probed OCCT behavior), no directional thickness, no multi-thickness                         |
| hole                                        | PARTIAL | straight composed cut; no counterbore/countersink/taper/thread/series; positions are parameters, not sketch points                                |
| patterns                                    | PARTIAL | body-level linear/circular, world axes; no feature patterns, no path/sketch patterns, no curve-driven, no skip instances                          |
| mirror                                      | PARTIAL | world-axis planes at offset; no arbitrary/datum plane                                                                                             |
| booleans at user level                      | PARTIAL | bridge kinds + fixture pages; no workbench command, no keep-tool options                                                                          |
| move/rotate body                            | PARTIAL | translate feature + tools; no rotate feature (tool-only rotate exists), no mate-based move                                                        |
| helix / coil                                | MISSING | no entity, no feature                                                                                                                             |
| threads (standard + cosmetic)               | MISSING |                                                                                                                                                   |
| draft / taper on extrude/wall               | MISSING |                                                                                                                                                   |
| rib                                         | MISSING |                                                                                                                                                   |
| scale                                       | MISSING | capability flag `transformScale` exists; no contract input (uniform scale reachable via OCCT `gp_Trsf`; non-uniform needs the w1ne fork — probed) |
| thicken / offset solid                      | MISSING |                                                                                                                                                   |
| wrap / emboss / deboss / project-to-surface | MISSING |                                                                                                                                                   |
| move face / replace face / delete face      | MISSING | OCCT `BRepFeat` is bound                                                                                                                          |
| split body / combine-divide                 | MISSING |                                                                                                                                                   |
| draft-critical features (ribs, gussets)     | MISSING |                                                                                                                                                   |
| gussets/domes/lib features                  | MISSING | (library features = configurations + components, later)                                                                                           |

### 3.3 Surfaces

| Capability                                  | Status  | Notes                                                                  |
| ------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| sheet bodies as first-class document bodies | MISSING | document bodies are solids; renderer/projection/IO assume closed soups |
| extrude/revolve/loft/sweep SURFACE          | MISSING | OCCT can (`BRepBuilderAPI` family); no contract/document surface       |
| trim / untrim surface                       | MISSING |                                                                        |
| extend surface                              | MISSING |                                                                        |
| knit / unstitch / sew                       | MISSING |                                                                        |
| fill/patch (N-sided)                        | MISSING | `Geom_BSplineSurface` bound                                            |
| offset surface                              | MISSING |                                                                        |
| thicken sheet → solid                       | MISSING | (pairs with solid thicken)                                             |
| intersection curves body×body / body×plane  | MISSING | `BRepAlgoAPI_Section` bound                                            |
| silhouette/edge extraction for surfaces     | MISSING | needed by drawings anyway (HLR)                                        |

### 3.4 Assemblies

| Capability                        | Status  | Notes                                                                    |
| --------------------------------- | ------- | ------------------------------------------------------------------------ |
| component instances / occurrences | MISSING | `cad-components` are reusable parametric RECIPES, not placed instances   |
| sub-assemblies / instance trees   | MISSING |                                                                          |
| mates / joints + solver           | MISSING | no constraint system in 3D                                               |
| component patterns / mirror       | MISSING |                                                                          |
| interference detection & report   | MISSING | (pairwise boolean volume intersection is kernelable today — no consumer) |
| explode states / animation        | MISSING |                                                                          |
| motion studies / DOF drag         | MISSING |                                                                          |
| BOM structure (phantom/etc.)      | MISSING |                                                                          |

### 3.5 Drawings

| Capability                                  | Status  | Notes                                          |
| ------------------------------------------- | ------- | ---------------------------------------------- |
| drawing sheets / document                   | MISSING |                                                |
| base + projected views                      | MISSING | HLR (`HLRBRep`) is bound — probed reachable    |
| section / detail / auxiliary / broken views | MISSING |                                                |
| model dimensions + reference dims           | MISSING | sketch constraints carry the data; no consumer |
| annotations (notes, leaders, GD&T, symbols) | MISSING |                                                |
| title blocks / frames / templates           | MISSING |                                                |
| BOM tables + balloons                       | MISSING | depends on assemblies                          |
| drawing output (SVG/PDF/DXF)                | MISSING | deterministic-serialization laws apply         |

### 3.6 Visualization

| Capability                                      | Status  | Notes                                                                          |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| interactive camera (orbit/pan/zoom/fit)         | MISSING | spec-only camera; the determinism contract must be preserved (law §1.2)        |
| view cube / standard views / persp-ortho toggle | PARTIAL | ortho+persp specs exist; no navigation UX                                      |
| display modes (shaded/wireframe/hidden-line)    | PARTIAL | shaded only                                                                    |
| section / clipping planes                       | MISSING | near/far clip constants only (`CAD_SCENE_CAMERA_NEAR_MM/FAR_MM`)               |
| explode view                                    | MISSING |                                                                                |
| materials / appearances / per-body color        | PARTIAL | one model material color + fixed metalness/roughness (`cad-scene.tsx` palette) |
| lighting presets / environment / studio         | PARTIAL | fixed `scene-lights.tsx` rig                                                   |
| isolate / hide bodies, visibility toggles       | PARTIAL | feature suppression exists; no body visibility flags                           |
| measurement overlays in viewport                | PARTIAL | readout panels exist; no in-scene dimension ink                                |
| render quality / snapshot export                | MISSING |                                                                                |

### 3.7 Curves (3D) & datums

| Capability                               | Status  | Notes                                                                                   |
| ---------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| 3D splines through points                | MISSING | `GeomAPI_Interpolate` bound                                                             |
| intersection / projected curves          | MISSING |                                                                                         |
| equation-driven curves                   | MISSING |                                                                                         |
| named datum planes                       | MISSING | workplanes are sketch-local frames, not document records                                |
| datum axes / points / coordinate systems | MISSING |                                                                                         |
| sketch-on-face / attached workplanes     | MISSING | references exist for edges/faces (fillet/chamfer/shell) but no workplane-from-face flow |

### 3.8 Import/export breadth

| Format                                                      | Status  | Notes                                              |
| ----------------------------------------------------------- | ------- | -------------------------------------------------- |
| STL / 3MF / GLB-export / STEP / BREP / IGES-import / native | PRESENT | §2.1                                               |
| DXF import (→ sketches)                                     | MISSING |                                                    |
| DWG                                                         | MISSING |                                                    |
| SVG import (→ sketches)                                     | MISSING |                                                    |
| OBJ import/export                                           | MISSING |                                                    |
| IGES export                                                 | MISSING |                                                    |
| STEP with names/colors/assembly structure                   | PARTIAL | XCAF unbound (probed); needs upstream binding work |
| 3MF import in-browser                                       | PARTIAL | Node-side zlib today (documented)                  |
| glTF import                                                 | MISSING | GLB export only                                    |

### 3.9 Parameters & configurations

| Capability                                     | Status  | Notes                                     |
| ---------------------------------------------- | ------- | ----------------------------------------- |
| parameters + expressions + units               | PRESENT | full expression engine                    |
| configurations / parameter tables              | MISSING | no concept of parameter-set-driven states |
| feature/visibility variation per configuration | MISSING |                                           |
| linked/external parameters                     | MISSING |                                           |

### 3.10 Inspection

| Capability                                      | Status  | Notes                                   |
| ----------------------------------------------- | ------- | --------------------------------------- |
| bounds / distance / radius / mass (volume+area) | PRESENT | `cad-core` measurement modules          |
| section mass properties                         | MISSING |                                         |
| interference / clearance                        | MISSING | kernels can; no consumer                |
| draft analysis                                  | MISSING |                                         |
| curvature display (combs/maps)                  | MISSING |                                         |
| zebra / environment reflections                 | MISSING |                                         |
| center-of-gravity visualization                 | PARTIAL | mass props compute; no COG marker/datum |

### 3.11 Infrastructure

| Capability                                                  | Status  |
| ----------------------------------------------------------- | ------- |
| undo/redo, rollback, suppression, regeneration, diagnostics | PRESENT |
| persistence (projects/documents, native bridge)             | PRESENT |
| perf budgets + incremental regen                            | PRESENT |
| a11y hardening                                              | PRESENT |
| registry/consumer distribution                              | PRESENT |

**Summary count**: ~46 MISSING axes, ~24 PARTIAL axes, ~14 PRESENT axes
against the reference surface.

---

## 4. Execution plan — 25 phases (Phase 36 → Phase 60)

Numbering continues the repo's phase history (Phase 35 landed 475f7eb).
Ordering principle: sketch entities before features that consume them;
helix before threads; parts stabilize before assemblies; drawings late;
visualization interleaved. Each phase lists **Type** (Sequential = on the
critical chain; Parallel = startable whenever its deps land), Requirements
(file-anchored), Validation (the repo's gates), Dependencies, and Risk.

Validation baseline for EVERY phase: `pnpm run verify` green; new public APIs
documented (`docs/guides/*` + `packages/docs-examples` where browser-safe);
`pnpm test:e2e` green including new specs; no hand-edited budgets (recording
mode only where a new perf-relevant metric is introduced); native-format
round-trip byte-identical for every document-model growth; capability flags +
contract-suite fixtures for every kernel op; the fake kernel either models
the new op's reference semantics on a documented subset or declines loudly.

---

### Phase 36 — Sketch entity & constraint vocabulary expansion

**Type**: Sequential (foundation for 37, 38, 40, 47, 54).

**Requirements**:

- New entities in `packages/cad-sketch/src/entities.ts`: `spline`
  (control-point + interpolated flavors), `ellipse`, `ellipticalArc`,
  `polygon` (n, circumscribed/inscribed), `slot` (straight/3-point arc).
  Each with parameterization doc (solver unknowns), strict builders, fixed
  key-order serialization, `formatVersion` bump + migration in
  `packages/cad-core/src/native-format.ts` + `native-migration.ts`.
- Solver rows: Jacobian entries + DOF accounting in
  `packages/cad-sketch/src/solver.ts` / `solver-math.ts` for every new
  entity; spline solving scope pinned honestly (endpoint constraints +
  tangent handles; full variational spline solving may be staged — document
  the reachable subset, decline the rest with `sketch/*` diagnostics).
- New constraints: `pointOnEntity` (point on line/arc/circle/ellipse/
  spline), `collinear`, point-pair `horizontal`/`vertical` variants,
  `distanceX`/`distanceY` in `constraints.ts` + solver rows.
- Profile resolution: deterministic chord/tessellation semantics for
  splines/ellipses in `packages/cad-sketch/src/profile.ts` (fixed deflection
  table like the kernels'), self-intersection checks extended.
- Kernel contract impact: `ProfileSegmentInput` gains a `spline`/`ellipse`
  segment kind (or a tessellated boundary form — decide by probing OCCT
  exactness vs mesh kernels' chord band; the loft/extrude validators in
  `packages/cad-kernel/src/contract.ts` extend accordingly).

**Validation**: solver fixtures (DOF counts for each new entity/constraint);
profile fixtures with analytic areas (ellipse exact; spline via Green's
theorem on the chord form with documented band); contract-suite curved band
fixtures; sketch e2e specs extended (`apps/web/e2e-render/sketch.spec.ts`);
byte-identical resave on migrated fixtures.

**Dependencies**: none.

**Risk**: spline solver scope creep — pin the constraint subset up front.

---

### Phase 37 — Sketch editing operations & interaction completion

**Type**: Sequential (after 36).

**Requirements**:

- Entity operations in `cad-sketch` + sketch-editor: offset entity/chain,
  mirror entities about line, circular/rectangular entity arrays,
  extend (complement of the existing trim), convert-entities (project model
  edges/faces into the sketch as reference geometry — consumes persistent
  references from `cad-core/src/persistent-reference.ts` and the
  `TopologyView`).
- Drag-with-constraints interaction: pointer drag re-solves through the
  solver per move, with under/over-constrained feedback (blue/black entity
  ink convention) in `packages/ui/src/components/cad/cad-sketch-canvas.tsx`.
- In-canvas dimension rendering for `distance`/`radius`/`diameter`/`angle`
  constraints (SVG overlay, deterministic serialization).

**Validation**: interaction e2e in `apps/web/e2e-render/sketch.spec.ts`
(drag keeps constraints held — settled geometry asserted via solver status);
unit suites for each op against hand fixtures; a11y suite stays green
(keyboard paths for every new tool).

**Dependencies**: 36.

**Risk**: drag re-solve performance — budget via recording mode if needed.

---

### Phase 38 — User-level sweep & loft features

**Type**: Sequential.

**Requirements**:

- Add `sweep`/`loft` to `BRIDGE_FEATURE_KINDS` in
  `packages/cad-kernel/src/core-bridge.ts`: SKETCH inputs (profile; path
  sketch or ordered section sketches), parameter inputs (per the extrude
  precedent), reference resolution, capability gates (Manifold declines).
- Worker ops `solid.sweep` / `solid.loft` in
  `packages/cad-kernel/src/worker-operations.ts` (codec table rows + wire
  forms; the contract input types already exist).
- Workbench commands + property panels: sweep (pick profile sketch + path
  sketch), loft (pick ≥2 section sketches in order) in
  `apps/web/src/cad-workbench/workbench-engine.tsx` /
  `complete-workbench.tsx` command vocabulary; Formedible parameter forms.
- Path sources for sweep initially: a second sketch's resolved profile chain
  (the planar XZ contract); document the constraint mapping.

**Validation**: cross-kernel equivalence fixtures (OCCT exact vs fake
Pappus/Simpson bands — the existing sweep/loft contract suites are the
template, in `packages/cad-kernel-occt/src/cross-kernel-equivalence.test.ts`
style); workbench e2e creating a swept and a lofted body end-to-end;
regeneration re-drives on `parameter.set` (param edit e2e pattern).

**Dependencies**: 36 (spline sections optional but wanted); kernel contract
already present.

**Risk**: low-medium — the geometry exists; this is surface + vocabulary.

---

### Phase 39 — Datum geometry system

**Type**: Sequential.

**Requirements**:

- Document records for named datums in `cad-core` (`document.ts` record
  union + native format growth + migration): datum plane (origin + frame,
  or from-3-points, or from-face reference + offset), datum axis (from edge
  reference / 2 points / face-cylinder axis), datum point, coordinate
  system.
- Reference kinds grow to address datums (`FeatureInputRef` /
  `DocumentReference` vocabulary).
- Sketch-on-datum and sketch-on-face flows: workplane derived from a datum
  record or a resolved face reference (`packages/cad-sketch/src/workplane.ts`
  unchanged; a resolver in the workbench/session layer).
- Generalize the selector-precedent features: mirror about a datum plane
  (replacing the world-axis integer selector behind a compat shim — the
  bridge validates either form), pattern axes from datum axes, revolve axis
  from a datum axis/line, hole axis from datum.

**Validation**: reference-resolution fixtures (moved-face → re-resolve or
structured invalidity, the Phase 22 battery); native-format round-trip;
workbench e2e: sketch on a face of an existing extrusion, extrude, edit
driving face — geometry follows.

**Dependencies**: persistent references (present); benefits from 38.

**Risk**: medium — document-model growth touches serialization + migration.

---

### Phase 40 — Helix, spiral, and threads

**Type**: Sequential (after 38; 39 recommended).

**Requirements**:

- `helixSweep` contract op in `packages/cad-kernel/src/contract.ts`
  (profile loop + analytic helix spine parameters: radius/axis datum,
  pitch, turns/height, handedness, taper optional) with capability flag
  `helix`; validation battery (path legality adapted: no self-intersection
  for the analytic spine, profile attachment rule) — probing first whether
  the OCCT binding builds `gp_Helix`-class spines (`Geom_CylindricalSurface`
  - parametric curve or `BRepOffsetAPI_MakePipeShell` over a sampled
    analytic wire — pick the exactness the probe certifies; a sampled spine
    must be banded honestly, never silently exact).
- OCCT implementation; fake kernel declines or models the untapered spring
  on a documented subset (Pappus is unavailable — decline unless an honest
  analytic volume exists); Manifold/JSCAD decline.
- Thread feature at the bridge level: real thread (helical profile sweep of
  a standard tooth section) + cosmetic thread (annotation-driven, no
  geometry) modes; ISO metric coarse/fine tables as data (major diameter,
  pitch, tap drill) in a new `cad-core` or bridge-local module.
- Worker ops + workbench command + Formedible spec form.

**Validation**: probed OCCT exactness recorded in fixtures; thread geometry
fixtures (volume deltas vs analytic annulus estimates with documented
bands); e2e thread creation + parameter re-drive; capability decline specs
on non-OCCT kernels (structured `kernel/unsupported-operation`).

**Dependencies**: 38 (sweep machinery), 39 (axis datums optional).

**Risk**: medium-high — spine exactness honesty; document bands up front.

---

### Phase 41 — Feature richness batch: draft, rib, scale, thicken, split

**Type**: Parallel (after 38/39; independent of 40).

**Requirements**:

- Draft/taper on extrude: extrude input gains optional taper angle
  (`ProfileExtrudeInput` extension + capability flag; OCCT
  `BRepPrimAPI`/draft via `BRepOffsetAPI_DraftAngle` — probe; mesh kernels
  honest band or decline).
- Rib feature: profile + thickness + direction → symmetric extrude-to-next-
  face (bridge-level composition of extrude + boolean to target; needs a
  target reference input).
- Scale: `transformScale` input (uniform via OCCT `gp_Trsf.SetScale` +
  `BRepBuilderAPI_Transform`; capability flag exists already; non-uniform
  documented OUT until the binding grows `BRepBuilderAPI_GTransform` —
  probed absent; volume scales by factor³, bounds by factor — analytic
  validation).
- Thicken/offset solid: OCCT `BRepOffsetAPI_MakeThickSolid` with zero faces
  removed (the closed hollow the shell probed OCCT cannot build — probe
  again via the offset API before promising; decline honestly otherwise).
- Split body: boolean cut by a tool plane/datum (half-space from a datum
  plane — composition or dedicated op per probe).
- Each: bridge feature kind, worker op, workbench command, Formedible form.

**Validation**: analytic volume deltas for every composed/derived op
(draft = prismatoid bounds, rib = extrude math, thicken = shell math);
cross-kernel coverage matrix per op in the contract suite; e2e per feature.

**Dependencies**: 38, 39.

**Risk**: medium — OCCT probe outcomes gate thicken-closed and draft;
plan declines as first-class outcomes.

---

### Phase 42 — Hole feature completion

**Type**: Parallel (after 40 for threads).

**Requirements**:

- Structured hole parameters replacing the flat five: type (straight/
  counterbore/countersink/taper/threaded), diameter, depth (blind/through),
  cbore/csink dimensions, thread spec (ISO table ref from Phase 40), tip
  angle; positions from SKETCH points (sketch input of selected points) in
  addition to parameters — one feature, many positions.
- Hole series at assembly level deferred to assemblies (Phase 52).
- Workbench hole dialog (Formedible, schema-driven from the parameter
  schema), preview ghost, standard-table picker.

**Validation**: geometry fixtures per hole type (volume deltas analytic —
cylinders + cones + thread deltas from Phase 40 bands); e2e hole dialog flow
incl. parameter re-drive; contract of the composed cut unchanged (the
post-condition: a cut that removed nothing refuses).

**Dependencies**: 40 (thread geometry); 39 (datum axes optional).

**Risk**: low-medium — composition on existing ops, following the existing
hole design decision.

---

### Phase 43 — Pattern & mirror completion

**Type**: Parallel (after 36, 39).

**Requirements**:

- Feature-level patterns (repeat a feature — or a feature range — not just
  a body): bridge composition using feature references, union at the end;
  skip-instance list; asymmetric spacing arrays (direction + count pairs).
- Path patterns: instances distributed along a sketch path (the Phase 36/38
  path resolution), with spacing/instance-count parameters and orientation
  options (tangent-follow vs fixed).
- Pattern on face (rectangular/grid within a face boundary) — needs face
  reference input + point-in-face tests (synthetic-face machinery reuse).
- Mirror about datum planes (Phase 39) for bodies and features; mirror
  merge option (union with original vs standalone copy).
- Direction inputs generalized to datum axes + sketch lines.

**Validation**: instance-count × geometry equivalence fixtures (N unions vs
single pattern — deterministic byte-level equality where composition is
identical); e2e pattern editor (skip instances re-drive); capability notes
(circular needs `transformRotation` — existing gate).

**Dependencies**: 36, 39; uses 38's path machinery.

**Risk**: low-medium — composition explosion is the cost center; budget
large counts via recording mode.

---

### Phase 44 — Booleans at user level, multi-body management, local face ops

**Type**: Parallel (after 39; OCCT probe for BRepFeat).

**Requirements**:

- Workbench boolean commands (union/subtract/intersect with body
  multi-selection, keep-tool toggles) through the existing bridge kinds —
  transaction choreography + Formedible option forms.
- Body management: visibility/isolate flags on body records (native-format
  growth + renderer projection filter), body rename, move body via
  translate/rotate features (UI for existing tools).
- Local face operations, OCCT-first (`BRepFeat` bound — probe which
  sub-classes): move face (draft-free offset along direction), replace face
  (with datum plane/surface), delete face (with and without heal). New
  contract ops + capability flag `localFaceOps`; other kernels decline.

**Validation**: boolean e2e (plate-with-hole through the UI); face-op
fixtures with analytic deltas (moved face = prism volume delta);
capability-decline specs; topology snapshot stability specs (fillet-after-
move-face re-resolution).

**Dependencies**: 39; booleans surface needs nothing new at kernel level.

**Risk**: medium — BRepFeat sub-class availability (probe first; decline
scope honestly).

---

### Phase 45 — Interactive visualization I: navigation, views, display modes

**Type**: Parallel (start ASAP — highest UX leverage; no geometry deps).

**Requirements**:

- User camera state as an explicit overlay: the deterministic
  `RenderCamera` spec remains the default and the e2e pin
  (`packages/cad-r3f/src/scene-camera.ts` stays spec-is-law); orbit/pan/
  zoom/fit write a session-scoped user-camera record that, when present,
  replaces the spec for rendering ONLY — never serialized into baselines,
  never written by non-user actions, with an explicit reset-to-spec
  command. All existing e2e/perf suites keep passing untouched (the law:
  user-initiated camera state must not break baselines).
- View cube + standard views (front/top/right/iso, first/third-angle
  convention setting), perspective/ortho toggle writing the same overlay.
- Display modes: shaded (default), shaded+edges, wireframe, hidden-line
  (edges-only with occlusion — reachable without full HLR via edge
  overlay + depth; the real HLR belongs to drawings).
- Fit-to-bounds (from kernel bounds), zoom window, look-at selection.

**Validation**: every existing e2e/perf suite green with zero edits (the
overlay defaults off); new e2e exercising orbit/fit/display modes with the
overlay asserted resettable; pointer latency budget recorded (not
hand-added) if introduced.

**Dependencies**: none (bounds readout exists).

**Risk**: the determinism law is the risk — the overlay design above is the
mitigation; review at the ADR level before implementing (extend
`docs/architecture/` with an ADR for user camera).

---

### Phase 46 — Section & clipping

**Type**: Sequential (after 45).

**Requirements**:

- Section planes (up to 3, from datums or ad-hoc) + clipping box: render-
  level clipping (three.js clipping planes — deterministic given state) and
  a viewport "section view" mode with cap faces.
- Kernel section op: `section` (target × plane/datum → cross-section face
  - resulting cut solid) — OCCT `BRepAlgoAPI_Section`/half-space boolean
    (bound); capability flag; mesh kernels: Manifold CAN cut with a box tool
    (compose) — implement via composition where honest, else decline.
- Section mass properties: the inspection readout family
  (`apps/web/src/cad-workbench/*-inspection.ts` + `cad-core/src/mass-properties.ts`)
  gains section-area/COG on the active section plane.
- Section state persistence (per-document display state, user-scoped like
  camera — decide serialization honestly: document display records vs
  session; recommend document records for sections since they are model
  artifacts, camera stays session).

**Validation**: section fixtures with analytic cross-section areas (box/
cylinder/revolve cuts); render e2e with section on/off (frames counted,
deterministic raster assertions); mass-property readout e2e.

**Dependencies**: 45, 39.

**Risk**: medium — cap-face quality on mesh kernels; scope cap faces OCCT-
exact, mesh-tessellated-honest.

---

### Phase 47 — 3D curve entities

> **Status (wt-47 pass 2)**: DELIVERED — curve records (`crv_*`, the
> `curves` collection, native additive section, `{ kind: "curve" }`
> feature inputs), the four curve kinds' pure geometry, the `wire` op
> (byte-identical across all four kernels), `sweepWire` (fake: the exact
> Cavalieri `V = A·L` node with the station loft and the generalized
> G1/self-intersection battery; OCCT: exact collinear-spine pipes with
> the curved-spine G0-polyline probe documented in the prespike
> findings; JSCAD/Manifold: structured declines), `intersectionCurve`
> (OCCT exact via `BRepAlgoAPI_Section` + the edge station walk; others
> decline), workbench curve authoring (payload builders, validators,
> Formedible field config, the deterministic scene soup —
> `cad-workbench/curves.ts`), docs + probe evidence. DECLINED with
> probes: projected curves (`ProjLib` absent from the binding) — the
> pinned vocabulary carries to the surface phases. OPEN: workbench React
> wiring (command-menu/toolbar entry + live render host), worker ops
> (`solid.wire`/`solid.sweepWire`), the core-bridge feature seam, and
> the native golden-list enrollment.

**Type**: Sequential (after 38; enables 48, generalizes 40).

**Requirements**:

- 3D curve document records + kernel wire vocabulary: interpolated spline
  through points (workplane points or 3D), control-point spline, helix/
  spiral as first-class curves (generalizing Phase 40's embedded spine),
  equation-driven curve (expression engine consumer: parameter range +
  x(t)/y(t)/z(t) expressions — `cad-core/src/expression-evaluator.ts`),
  intersection curves (body×body, body×plane — OCCT section reuse), and
  projected curve (sketch curve → body face, OCCT `ProjLib`/projection —
  probe).
- Generalized sweep path input: the contract's `ProfileSweepInput.path`
  grows a 3D wire form (or a `sweepWire` op) with G1 validation generalized;
  planar XZ path remains the compatible subset.
- Deterministic tessellation/serialization for all curve kinds; workbench
  curve authoring UX (points, handles).

**Validation**: curve fixtures (interpolation round-trips, helix analytic
properties: length/turns/pitch); sweep-over-3D-path fixtures with OCCT
exactness probed and banded; equation-curve unit fixtures reusing
expression parser tests.

**Dependencies**: 38; expression engine (present).

**Risk**: medium — wire/brep duality in the document model; keep curves as
records + kernel wires, not bodies.

---

### Phase 48 — Surfaces I: sheet bodies and surface creation

**Type**: Sequential (after 47). **OCCT-first; hard-flagged.**

**Requirements**:

- Sheet bodies: a second body kind in the document model (`cad-core`
  body records + native format + migration) with open-shell semantics;
  renderer projection carries open soups (tessellation of faces — OCCT
  already returns per-face ranges); picking/selection extended.
- Contract: `extrudeSurface`/`revolveSurface`/`loftSurface`/`sweepSurface`
  (or a `sheet` flag on the existing profile ops — pick the smaller
  contract surface after probing) + capability flag `sheets`: OCCT true;
  Manifold/JSCAD/fake decline (their engines are closed-solid; document
  the probe).
- Untrimmed base sheets: plane, cylinder, cone, sphere, torus patches from
  datum + parameters.
- IO: STEP/BREP exchange already carries open shells (OCCT) — provenance
  `imported-step` solid refs grow a sheet class.

**Validation**: contract-suite fixtures per sheet op (area exact via
`BRepGProp`, bounds exact); cross-kernel decline specs; native-format
round-trip with sheet bodies; render e2e showing both sides of a sheet
(backface rendering).

**Dependencies**: 47.

**Risk**: HIGH — ripples through document model, native format, renderer,
IO, and every boolean/feature validator ("does this op accept sheets?"
answered per op with honest declines). Scope one op at a time.

---

### Phase 49 — Surfaces II: trim, extend, knit, patch, offset, thicken

**Type**: Sequential (after 48). **OCCT-only surface; hard-flagged.**

**Requirements**:

- Trim (sheet × trimming curve/plane/sheet), untrim, extend (by length or
  to boundary), knit (sew sheets → closed when boundary-consistent; sew
  sheet+solid cases), unstitch (explode to faces), N-sided fill/patch
  (`Geom_BSplineSurface` bound), offset sheet, thicken sheet → solid,
  replace solid face with sheet, delete-face-keep-surface.
- Each op: contract entry + capability flags (likely one `surfaceOps` flag
  with per-op fixture gating), OCCT implementation with the no-throw
  boundary discipline, structured failure taxonomy (`kernel/surface-*`
  codes), topology snapshot integration for reference stability.
- Workbench surface tab + selection of sheet bodies/faces.

**Validation**: analytic area/volume deltas (thickened sheet = area × t +
curvature terms for developable vs general — document bands honestly);
knit-closure fixtures (sewn shell recognized as solid — volume becomes
measurable); interference with sheets at boolean boundaries declines or
composes per probe; e2e surface workflow (loft surface → trim → thicken →
fillet the solid).

**Dependencies**: 48.

**Risk**: HIGH — this is the deepest OCCT-only surface; probe-first
discipline is mandatory (extend `occt-prespike-findings.md` with a
surfaces addendum before scoping details).

---

### Phase 50 — Assemblies I: instances, sub-assemblies, structure

**Type**: Sequential (parts stable after 41-44). **Hard-flagged.**

**Requirements**:

- Assembly concept: a document (or document section — decide by
  persistence shape) holding component occurrences: each occurrence
  references a source (body in this document, another document via the
  persistence layer `@slopcad/api` documents router, or a registry
  component) + a placement (transform composition from datum/parameters).
- Instance trees: nested sub-assemblies with occurrence paths; model tree
  rendering of the tree (packages/ui `cad-model-tree` growth).
- BOM structure flags per occurrence (default/phantom/purchased) — data
  first, tables in drawings later.
- Native format + migrations; regeneration: an occurrence's geometry is
  its source's regenerated output (no re-execution); stale propagation
  across document links (project-local first).
- Placed-instance rendering: projection carries occurrence transforms
  (deterministic composition order — instance path order, fixed).

**Validation**: instance fixtures (placement math = transform composition
unit tests); cross-document stale propagation e2e (edit source part →
assembly marks stale → regenerates); native round-trip; tree e2e.

**Dependencies**: 39 (datum placements), persistence (present).

**Risk**: HIGH — the document-model shape decision (assembly-as-document
vs section) gates everything downstream; write an ADR first.

---

### Phase 51 — Assemblies II: mates, joints, interference

**Type**: Sequential (after 50). **The single riskiest phase.**

**Requirements**:

- Mate vocabulary: coincident (face/edge/point), concentric, distance,
  angle, parallel, perpendicular, tangent — on persistent topology
  references of occurrence geometry (Phase 22 machinery generalized
  through instance paths); joint vocabulary for motion: rigid, revolute,
  slider, cylindrical, planar, ball.
- Mate solver: 3D constraint reduction (DOF accounting like the sketch
  solver's — reuse its diagnostic vocabulary and status model); numeric
  solve with structured diagnostics (`assembly/mate-*` codes), deterministic
  pure functions, reference solver for golden fixtures; drag-based solving
  with remaining-DOF motion.
- Interference detection: pairwise occurrence boolean intersection
  (kernels compute this today) with a structured report (occurrence pairs,
  volume, bounding boxes); batch check command.

**Validation**: mate solver unit fixtures with DOF assertions (box+
cylindrical joint has 1 rotational DOF, etc.); golden solved assemblies
(reference-solver pattern from `cad-sketch/src/reference-solver.ts`);
interference e2e (overlapping boxes detected with exact volume);
determinism: identical assembly solves bitwise-identically.

**Dependencies**: 50.

**Risk**: HIGHEST — solver design, UX of conflicting-mate diagnostics, and
cross-document stability. Stage internally: mates-without-motion first
(rigid solve), then joints/DOF.

---

### Phase 52 — Assemblies III: patterns, mirror, explode, motion

**Type**: Sequential (after 51).

**Requirements**:

- Component patterns (linear/circular about datum axes; path-driven) and
  mirror components (datum plane; mirrored placement vs mirrored geometry
  — decide handedness handling honestly with the mirror kernel op).
- Exploded views: per-occurrence explode offsets (direction + distance,
  or radial pattern auto-explode), stored explode states, animation
  playback in the viewport (deterministic when scrubbed by parameter).
- Motion basics: joint-driven drag/animate (revolute/slider limits),
  minimum-distance/clearance probing between moving occurrences.

**Validation**: pattern instance-count fixtures; explode state round-trip;
motion limit fixtures; e2e explode authoring + animation scrub; interference
re-check under motion at sampled stations.

**Dependencies**: 51.

**Risk**: medium-high (explode state serialization + animation
determinism).

---

### Phase 53 — Drawings I: sheets and views

**Type**: Sequential (after parts stable; parallel with assemblies II/III
is fine — BOM views wait). **Hard-flagged.**

**Requirements**:

- Drawing document model: sheets (size standards A0-A4, orientation,
  scale), view records referencing model bodies/assemblies; native format
  growth + migration; project persistence integration.
- Base views from geometry: front/top/right/iso via HLR — OCCT
  `HLRBRep` (bound — probe `HLRBRep_Algo`/`HLRBRep_HLRToShape` first and
  extend `occt-prespike-findings.md`; the deterministic output requirement
  applies to the extracted edge sets). Fallback: edges-overlay projection
  for mesh kernels — classify fidelity honestly.
- View placement, scale, alignment (first/third angle), view frames;
  2D render layer (SVG-backed canvas in the workbench — deterministic
  serialization discipline like every exporter).

**Validation**: HLR fixtures (box/cylinder/protrusion views with exact
edge counts and coordinates where analytic); view-layout round-trip;
a11y for the drawing canvas; e2e create sheet + 3 views.

**Dependencies**: 39 (view direction conventions), 48 optional (sheet
bodies as view sources decline honestly).

**Risk**: HIGH — HLR binding behavior under probe + a whole new 2D module
(edge/annotation rendering, snapping) in a 3D-native codebase.

---

### Phase 54 — Drawings II: dimensions, annotations, title blocks

**Type**: Sequential (after 53).

**Requirements**:

- Model dimensions recovered from the parametric source: sketch constraint
  dims (Phase 36 vocabulary), feature parameters (extrude height, fillet
  radius...) projected into views as dimension entities — the
  parametric-history advantage; reference dimensions authored on-view.
- Dimension entities: linear (aligned/horizontal/vertical), radial,
  diameter, angular; annotation entities: notes, leaders, hole/thread call-
  outs (Phase 40/42 data), basic GD&T symbols (feature control frames) —
  data model + deterministic rendering + snap/placement interaction.
- Title block, sheet frame, revision table; template sheets
  (Formedible-driven template picker).

**Validation**: dimension-value fixtures (a 20mm extrude carries a 20mm
dim — value derived from the same parameter, unit-converted); annotation
round-trip; e2e dimension a feature end-to-end; export preview (SVG).

**Dependencies**: 53, 36.

**Risk**: medium-high (breadth; pin symbol library scope to ISO subset).

---

### Phase 55 — Drawings III: projected/section/detail views, BOM, output

**Type**: Sequential (after 54; BOM after 50).

**Requirements**:

- Projected views (fold-line method from a base view), section views
  (from datum/section planes — Phase 46 reuse, cut-plane hatching),
  detail views (crop + scale), auxiliary views, broken-out sections.
- BOM tables from assembly structure (Phase 50 flags) + balloons keyed to
  occurrences; table auto-numbering deterministic.
- Output: SVG (deterministic bytes — law §1.2), PDF (vector, deterministic
  builder), DXF (2D entities: lines/arcs/circles/dims/splines as polylines
  or SPLINE entities — deterministic writer); print layout.

**Validation**: byte-determinism suites for all three exporters (resave/
re-export identical); section-view geometry fixtures (section area matches
Phase 46 kernel section); DXF round-trip into itself; e2e full drawing
production from an assembly.

**Dependencies**: 54, 50, 46.

**Risk**: medium-high (DXF writer breadth; pin entity subset honestly).

---

### Phase 56 — Exchange breadth: DXF/DWG/SVG/OBJ in, IGES out, STEP richness

**Type**: Parallel (importers independent of drawings; STEP colors blocked
on bindings — flagged).

**Requirements**:

- DXF import → sketch entities (parser: lines/arcs/circles/polylines/
  splines subset; layer filtering; unit handling) feeding Phase 36's
  vocabulary; SVG import → sketches (path subset); OBJ import/export
  (mesh, cad-io family discipline: deterministic export, structured
  import); IGES export (OCCT writer — probe; meshes today import IGES only).
- 3MF in-browser import (replace Node-zlib constraint or document it
  remains server-routed — decide by bundling probe).
- STEP names/colors/assembly structure: **blocked** on `STEPCAFControl_*`
  bindings (probed absent). Path: upstream request/fork
  (replicad-opencascadejs is actively maintained — the w1ne fork precedent
  for `GTransform`). Until bound: document the limit; no fabricated
  metadata (the no-fabrication law).

**Validation**: importer golden fixtures (DXF/SVG/OBJ samples → expected
entities with tolerance bands); round-trips (OBJ export→import volume
stable); e2e import flows; STEP: if bindings land, color/name round-trip
fixtures, else the documented-decline test.

**Dependencies**: 36 (sketch vocabulary target), 55 (DXF writer shares
entity code).

**Risk**: medium — upstream binding dependency for STEP richness is the
one external blocker; everything else is in-repo.

---

### Phase 57 — Configurations & parameter tables

**Type**: Parallel (after 36; valuable early — schedule by capacity).

**Requirements**:

- Configuration model: named parameter-set rows over the same document
  (parameter overrides + feature suppression/visibility flags + body
  presence), deterministic evaluation (config → effective document view
  without duplicating records); native format growth + migration.
- Configuration table UI (Formedible grid), configuration switcher in the
  workbench + project persistence; per-configuration regeneration caching
  (reuse the diff/stale machinery).
- Configuration export: derived geometry per config through any exporter;
  drawing views can pin a configuration (with 55).
- Parameter import/export: CSV of the parameter table (deterministic
  bytes).

**Validation**: config-switch fixtures (effective parameter values,
suppression, geometry volumes per config); regeneration performance for
config switching budgeted via recording mode if the stale-set grows; e2e
authoring a two-config part and exporting both.

**Dependencies**: parameter system (present); benefits from 44 (visibility).

**Risk**: medium — effective-view semantics must not fork the document
model; ADR on the representation first.

---

### Phase 58 — Inspection & analysis completion

**Type**: Parallel (after 46, 51).

**Requirements**:

- Interference report UX (from Phase 51's detector): results panel,
  isolation of pairs, snapshot report (deterministic JSON/HTML export).
- Clearance/minimum-distance between occurrences/bodies (kernel distance on
  tessellations with documented precision, or OCCT `BRepExtrema` — probe).
- Draft analysis: face angle vs pull-direction datum, colored face map
  (per-face classification from topology + normals — deterministic color
  banding).
- Curvature display: sketch spline combs (2D), surface curvature maps
  (per-vertex from tessellation normals — honest mesh-based band, OCCT
  exact where surface props reachable).
- Zebra/environment reflection striping in the viewport (shader-level,
  deterministic given state); COG marker datum + mass properties with
  density/material assignment (document-level material records feeding
  `mass = Σ density_i × volume_i` — the contract keeps out of density; this
  is the consumer layer).

**Validation**: interference/clearance fixtures (constructed overlaps with
exact volumes); draft-analysis classification fixtures on analytically
known faces; COG fixtures (compound of boxes at offsets); e2e panel flows.

**Dependencies**: 46, 51, 44 (materials on bodies).

**Risk**: medium — mostly consumers of existing kernels; probe BRepExtrema.

---

### Phase 59 — Visualization II: appearances, materials, rendering, capture

**Type**: Parallel (after 45; pairs with 58's material records).

**Requirements**:

- Appearance model: per-body/per-face appearance records (base color,
  metalness, roughness, optional texture — deterministic asset handling),
  appearance library (named presets as data), persisted in the document
  (display records; native format growth). Face-level color needs the
  topology snapshot mapping.
- Lighting presets/studio: light rigs as data (the fixed
  `scene-lights.tsx` becomes the default preset), environment/
  ground settings, all deterministic given state.
- Quality render mode: soft shadows + AO + post pass toggle (SwiftShader-
  safe defaults), snapshot export (PNG, deterministic raster under the
  fixed-viewport/DPR discipline — the e2e-render contract), turntable/
  isometric export series.
- STEP color export linkage if Phase 56's bindings landed.

**Validation**: appearance round-trip; render-mode e2e under the existing
SwiftShader harness; snapshot determinism suite (same state → identical
bytes); budgets for the quality mode recorded, not hand-set.

**Dependencies**: 45, 44 (body records), 58 (material linkage).

**Risk**: medium (raster determinism under post-processing — keep quality
mode opt-in and unpinned by baselines, like the camera overlay).

---

### Phase 60 — Parity hardening sweep

**Type**: Sequential (last).

**Requirements**:

- Command-surface audit: every feature/inspection/exchange capability this
  roadmap shipped is reachable from the complete workbench's command menu
  or a named panel — a mechanical checklist generated from this document,
  each item e2e-asserted (the Phase 28 discipline applied to the full
  vocabulary).
- Documentation sweep: guides for every new surface, `/docs` examples,
  `TEST-ALIGNMENT-PLAN.md` and `docs/architecture/api-audit.md` re-run at
  the new epoch (barrel counts, accidental-export purge).
- Registry/consumer refresh: new UI pieces and components flow through
  `packages/ui/registry.json` + consumer fixtures.
- Perf epoch: full `PERF_BASELINE=1` re-record if new metrics accumulated;
  old rows untouched.

**Validation**: the audit's checklist green; `pnpm run verify`, `test:e2e`,
`test:perf`, `test:docs` all green; api-audit epoch updated.

**Dependencies**: all.

**Risk**: low — but it is the phase that certifies "everything a real CAD
has" is actually user-reachable, not just kernel-reachable.

---

## 5. Sequencing summary

```
Critical chain (Sequential):
36 sketch vocab → 37 sketch UX → (38 sweep/loft) → 40 helix → 42 holes
39 datums ────────────┬────────→ 41 feature batch → 44 booleans/local ops
                      └────────→ 43 patterns
45 viz I → 46 sections ──→ 58 inspection
47 3D curves → 48 surfaces I → 49 surfaces II
50 assemblies I → 51 assemblies II (mates) → 52 assemblies III
53 drawings I → 54 drawings II → 55 drawings III
60 hardening sweep (last, after all)

Parallel-eligible (start when deps land, capacity permitting):
43, 44, 45, 56 (importers), 57 (configurations), 58, 59
```

Milestones for the owner: **M1 "real parts"** (36-44 done), **M2 "real
inspection/views"** (45-46, 58), **M3 "surfaces"** (47-49), **M4
"assemblies"** (50-52), **M5 "drawings"** (53-55), **M6 "parity certified"**
(56-60).

### 5.1 Out-of-scope boundary (explicit, overridable by the owner)

CAM toolpaths, FEM/simulation, PCB/electronics, generative design, cloud
collaboration/multi-user editing, PDM release workflow, rendering farm /
ray-traced photo render, point-cloud/reverse engineering, sheet-metal
dedicated workbench (fold/flatten — NOTE: flange features could be modeled
as a later feature batch over the sweep/loft/draft machinery if the owner
wants it; it is absent above only because the reference set treats it as a
workbench, not a core axis). Each is a product decision, not a geometry
gap — raising any of them re-opens planning, not this document's phases.

---

## 6. Risk register (the flagged ones)

| #   | Risk                                                          | Phases    | Severity   | Mitigation                                                                                                                   |
| --- | ------------------------------------------------------------- | --------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| R1  | Mate/joint solver design + diagnostics + UX                   | 51        | highest    | stage rigid-solve before motion; reuse sketch-solver diagnostic vocabulary; reference-solver golden fixtures; ADR first      |
| R2  | Drawings module breadth + HLR binding behavior                | 53-55     | high       | probe `HLRBRep` before scoping detail; deterministic edge extraction pinned by fixtures; pin GD&T symbol scope to ISO subset |
| R3  | Sheet-body ripple through document/format/renderer/IO         | 48-49     | high       | OCCT-only capability flag; one op at a time; ADR on body-kind representation before code                                     |
| R4  | User camera vs byte-determinism baselines                     | 45        | high (law) | spec-is-law default; session overlay opt-in; zero-edit green suites as the acceptance bar; ADR                               |
| R5  | OCCT binding gaps (XCAF, GTransform)                          | 56, 41    | medium     | upstream/fork path documented (w1ne precedent); honest declines meanwhile                                                    |
| R6  | Helical/thread exactness honesty                              | 40        | medium     | probe spine construction first; band everything not exact                                                                    |
| R7  | Assembly document-model shape choice                          | 50        | high       | ADR: assembly-as-document vs section; persistence round-trip fixture before features                                         |
| R8  | Performance of composed features (patterns, large assemblies) | 43, 50-52 | medium     | incremental regen reuse; budgets via recording mode only                                                                     |
