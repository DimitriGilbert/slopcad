# Plan: fillet/chamfer/face-ops/shell/patternFace/primitives on the document timeline

## Overview

Add document-scene producers, agent-plane surface, and UI authoring for the
feature kinds the kernel already supports but the workbench document scene
does not render: `box`, `sphere`, `cylinder`, `cone`, `fillet`, `chamfer`,
`shell`, `moveFace`, `deleteFace`, `replaceFace`, `patternFace`.

Execution model: orchestrated subagents per `subagent-orchestration` skill —
the orchestrator only dispatches implementers, validators, and fixers;
subagents do all file and command work. Commit after each phase validates.
Branch: `document-feature-ops` (cut from `glm` @ `5f8256c`). PR against
`glm` when all phases pass.

## Ground truth (verified against HEAD)

- Kernel ops exist on both backends: `createBox`/`createSphere`/`createCylinder`/
  `createCone`, `solid.fillet`/`chamfer`/`shell`/`moveFace`/`deleteFace`/
  `replaceFace` — see `packages/cad-kernel/src/contract.ts`.
- `packages/cad-kernel/src/core-bridge.ts` already has readers resolving
  canonical feature layouts (edge/face refs → ordinals, persistent-id
  snapshots; fillet/chamfer/shell ~line 2516, face-ops ~line 6977).
- `@slopcad/cad-jsx` already compiles `<Box>`/`<Sphere>`/`<Cylinder>`/
  `<Cone>`/`<Fillet>`/`<Chamfer>`/`<Shell>` — imported and agent-authored
  documents can already carry these features; they only fail to render.
- `cad_apply_commands`/`cad_run_command` accept generic `feature.create` —
  no kind allowlist. A `cad_skill` tool serves an authoring guide.
- `documentSceneBodies` in `apps/web/src/cad-workbench/document-scene.ts`
  has producers for: extrude, revolve, sweep, loft, helix, sheet, pad,
  hole, booleans, moveBody, thread, rib, scale, thicken, split,
  patternFeature, patternPath, patternTransform, mirror, duplicate,
  plate, empty. NOT for: primitives, fillet, chamfer, shell, face-ops,
  patternFace.
- `sceneOperandOfBody` in `apps/web/src/cad-workbench/extrude.ts` serves
  computed operands by kind-specific rules; the new kinds must be added
  there per their actual serving rule (every-feature vs computed-consumer).
- `fallbackSourcesOf` in `extrude.ts` must gain branches for new kinds so
  a refused scene surfaces its target's valid source instead of hiding it.
- Readers must enforce bridge domains BEFORE producing a scene (the
  `pattern.ts` precedent): an out-of-domain feature emits no scene entry.
- Every new command surface needs a manifest entry + session stage or the
  `s99` coverage gate in `pnpm test:session` fails.
- The default `/workbench-complete` route boots Manifold, which declares
  fillet/chamfer/shell/localFaceOps/persistentTopology false — every
  non-primitive kind refuses there. OCCT implements them all. Decision:
  OCCT becomes the workbench default (these are core CAD features);
  Manifold stays for the fixtures/baselines that boot it explicitly. The
  ~22 MB `replicad_single.wasm` (`replicad-opencascadejs@1.1.0`) is served
  from jsDelivr — verified: CORS `*`, `application/wasm`, immutable
  1-year cache — with the local `?url` asset kept as fallback; the
  `locateFile` seam already exists in `occt-runtime.ts`.
- OCCT topology identity today is `ReplicadShapeHasher.HashCode`, which comes from
  allocation addresses (`packages/cad-kernel-occt/src/occt-topology.ts`). Every
  rebuild produces a different set of hashes (proved by `topology-identity.test.ts`).
  `computeDocumentScene` rebuilds every pass, so a reference minted at pass N
  stands `missing` at pass N+1. Fillet/chamfer/shell/face-ops/patternFace
  references therefore never survive a rebuild. Both resolution sites match on
  identity-payload equality: the worker's `resolveReferenceOrdinals`
  (`apps/web/src/worker-fixture/topology-cut-scene.ts`) and the bridge's
  `resolveDocumentReference` calls in `core-bridge.ts`.
- `TopologyIdentityPayload` is opaque `{kernelId, schema, data}`
  (`packages/cad-core/src/persistent-reference.ts`), so a deterministic name can be
  a new identity schema without changing the reference model.
- The OCCT wasm (`replicad-opencascadejs@1.1.0`) exposes
  `BRepBuilderAPI_MakeShape.Generated/Modified/IsDeleted` (see
  `dist/replicad_single.d.ts`). The kernel drives these builders directly: MakeBox/
  Cylinder/Sphere, MakePrism, MakeRevol, Fuse/Cut, MakeFillet, MakeChamfer,
  MakeThickSolid, Transform, ThruSections, PipeShell, Splitter, DraftAngle.

## Rules

- pnpm only, commands from repo root.
- No `any`/`as any`/`: any`; `import type` for type-only imports;
  external imports, blank line, local imports.
- No placeholders, no TODO/FIXME, no unused imports/vars.
- Do not hand-edit generated fixtures (`packages/cad-jsx/*.native.json`,
  `*.commands.json` — prettier-ignored).
- Gatekeeping per phase: `pnpm --filter web run check-types`,
  `pnpm --filter web run lint`, vitest on touched test files, prettier
  `--check` on touched files. Commit only after validator PASS.

---

## Phase 0: OCCT default + CDN wasm
**Type**: Sequential. Commit after validation.

**Requirements**:
- OCCT becomes the workbench default backend (`CompleteWorkbenchPage`'s
  `backend` default / `/workbench-complete` route); fixtures that
  explicitly pin `backend="manifold"` keep it — established render
  baselines must not move.
- Worker entry: `locateFile` resolves the version-pinned jsDelivr URL
  first; on fetch failure it falls back to the local `?url` asset (kept in
  the bundle as the spare). Pin `@1.1.0` — never `@latest`.
- Unit test: fallback fires on CDN fetch failure.
- E2E consequence: stages for the new OCCT-only kinds run on the default
  route once it IS OCCT; no separate-route plumbing needed.

**Inputs**: CompleteWorkbenchPage.tsx, routes/workbench-complete*.tsx,
occt-worker-entry.ts, occt-runtime.ts (locateFile seam).

**Validation**: gatekeeping green; workbench boots on OCCT; Manifold
fixtures unchanged.

---

## Phase 1: Document scene producers
**Type**: Sequential sub-phases + phase-wide validator, then commit.

### 1a: Primitives (`box`, `sphere`, `cylinder`, `cone`)

**Requirements**:
- `document*SceneRequest(s)` reader per established naming/style; every
  primitive feature produces a scene entry (every-feature producer, like
  extrude). Reuse core-bridge canonical layout — do not invent layouts.
- Domain validation in the reader: positive box w/d/h, positive
  sphere/cylinder radius, positive cylinder/cone height, cone bottomRadius
  positive + topRadius non-negative. Out-of-domain → no scene entry.
- New scene kind(s) in `WorkbenchSceneKind` (workbench-engine.tsx) and
  sibling unions/sites (viewer-engine, worker-fixture, native-document-bridge
  `sceneKindOfDocument`); wire through worker dispatch to the kernel ops.
- `sceneOperandOfBody`: primitives admitted as every-feature producers.
- `fallbackSourcesOf`: primitive branch per the no-target precedent.
- Unit tests: valid → entry; each bad domain → no entry; suppressed →
  skipped; multiple primitives → multiple entries; primitive body as
  boolean/pattern target → admitted.

**Inputs**: document-scene.ts, extrude.ts, pattern.ts, scene-fallback.ts,
workbench-engine.tsx, viewer-engine.ts, native-document-bridge.ts,
worker-fixture/document-scene.ts, contract.ts, core-bridge.ts primitive
reader, a `*.native.json` fixture containing `"kind": "box"`.

**Validation**: gatekeeping green + new tests pass.

### 1b: Fillet, chamfer, shell

**Requirements**:
- Readers consuming the target's computed solid — admit through the
  computed-operand queue like booleans/patternTransform so chains order
  correctly (each op's output is the next op's target).
- Domain validation: positive radius (fillet), positive distance
  (chamfer), positive thickness (shell), non-empty edge/face selections.
- Same kind-union/operand/fallback/test coverage as 1a. Multi-op chains
  must render in order; a refused op falls back to its target's scene.

**Inputs**: same as 1a + core-bridge edge/face-ordinal readers (~2516) +
chain.ts (how the chain workbench authors/resolves fillet edge ids).

**Validation**: gatekeeping green + tests incl. chained ops + refusal
fallback.

### 1c: Face-ops + patternFace (`moveFace`, `deleteFace`, `replaceFace`, `patternFace`)

**Requirements**:
- Same admission model as 1b (computed-operand consumers).
- Layouts per core-bridge ~6977: moveFace = target + face ref + axis +
  distance params; deleteFace = target + face ref + heal param;
  replaceFace = target + face ref + datum input. patternFace per its
  bridge layout.
- Domain validation per bridge expectations; same union/operand/fallback/
  test coverage.

**Validation**: gatekeeping green + tests.

### Phase 1-wide validation

- One validator reads all Phase-1 code together: admission-order coherence,
  shared types, no duplicated helpers, operand rules consistent.
- Then commit (message per repo style).

**Dependencies**: none.

---

## Phase P: Park Phase 2 WIP
**Type**: Sequential. No validator (no code change).

- Commit this plan update on `document-feature-ops` first. Then commit the
  remaining uncommitted Phase 2 working tree to a side branch
  `document-feature-ops-p2-wip`, then return to `document-feature-ops` with a clean tree.
  Non-destructive (no stash/reset/clean). Phase 2 later reuses it (`git diff
  document-feature-ops document-feature-ops-p2-wip`).

---

## Phase N1: History-based topological naming — core + primitives + extrude/revolve
**Type**: Sequential. Commit after validation.

**Requirements**:
- New OCCT identity schema (e.g. `occt-name/1`): payload `data = { name }`, with
  `name` a deterministic string. It replaces the address hash as the identity a
  snapshot reports and a reference stores. The hash schema stays parseable, so
  old references resolve `missing` honestly; they don't crash.
- Faces are named by construction; edges and vertices derive from their adjacent
  faces (edge = sorted pair of its two face names, vertex = sorted set of face
  names). When two entities would get the same derived name (seam edges, a face
  pair meeting twice), add a deterministic suffix ordered by body-relative
  geometry. If no deterministic order exists, report it as ambiguous; never guess.
- Names travel with the solid in the OCCT kernel's solid store (a face→name map
  kept next to each TopoDS_Shape). `topologySnapshot` reports them.
- Primitives: box faces by role (`±X/±Y/±Z` in the box frame), cylinder/cone
  `start/end/lateral`, sphere `surface`, each prefixed by the producing feature id.
- Extrude (`MakePrism`): side faces from `Generated(profileEdge)` → `<feature>/side/<segment key>`,
  caps from `FirstShape/LastShape` → `<feature>/start|end`. The segment key is the
  sketch segment id if the extrude input carries it; otherwise the profile-loop
  index. Verify which one and document it. Revolve (`MakeRevol`) uses the same
  scheme.
- A name must not depend on dimensions: changing a box/extrude dimension keeps
  every name the same.

**Tests** (OCCT-backed, `packages/cad-kernel-occt`):
- An identical rebuild gives identical names.
- A dimension change gives identical names.
- A reference minted on build 1 resolves `valid` on build 2 through
  `resolveTopologyReference`.
- Derived edge/vertex names are unique on box/cylinder/extrude.
- The duplicate-name case is ordered deterministically, or refused as ambiguous.

**Inputs**: occt-topology.ts, occt-kernel.ts (primitive/prism/revol builders + solid
store), persistent-reference.ts (identity payload, resolve), topology-identity.test.ts,
reference-resolution.test.ts.

**Validation**: gatekeeping green for cad-core, cad-kernel, cad-kernel-occt, web.
New tests pass. Existing reference/topology tests pass. Any test changed only
because the identity schema changed is justified in the report.

---

## Phase N2: Carry names through topology-changing ops
**Type**: Sequential sub-phases + phase-wide validator, then commit.

Shared rule for every op: for each named input face, `Modified(face)` → same name.
If one face splits into k faces, each gets `name#i`, ordered by body-relative
geometry. `IsDeleted(face)` → the name is dropped. Faces the op creates get
`<feature>/<role>/<source name>`, built from `Generated(source)`. Edges and
vertices are re-derived per N1. An op that cannot report history marks its
output unnamed. References into unnamed output fall back to
`repairTopologyReference`: an explicit `repaired` state, refused when ambiguous.
Every such op is listed in the occt-topology.ts module doc.

### N2a: Booleans, transforms, fillet, chamfer, shell
- Fuse/Cut (the tool body's names come from its own feature), Transform (names
  preserved), MakeFillet (`<feature>/fillet/<edge name>`), MakeChamfer, MakeThickSolid
  (inner faces `<feature>/inner/<face name>`, removed faces deleted).

### N2b: Face-ops, patterns, remaining builders
- moveFace/deleteFace/replaceFace, patternFace/patternFeature/patternTransform/mirror
  (instance index in the name), ThruSections/PipeShell (sweep/loft), Splitter
  (split), DraftAngle, thicken. Each one gets history-based names, or is marked
  unnamed and documented.

**Tests per sub-phase** (OCCT-backed):
- Chain `box → fillet(edge) → chamfer(edge of the fillet output)`: rebuild, then a
  box dimension edit. Every reference stays `valid` and the volumes match the
  analytic/probed values.
- A boolean that splits a named face gives `#i` names in a stable order.
- A deleted face's reference resolves `missing`. Repair fallback works, and refuses
  geometric twins.

### Phase N2-wide validation
- One validator reads all N2 code together: one naming helper shared by every op
  (no per-op copies), consistent suffix ordering, the unnamed-op list is complete.

---

## Phase N3: Wire name-based references end-to-end
**Type**: Sequential. Commit after validation.

**Requirements**:
- Worker `resolveReferenceOrdinals` and the bridge's `resolveDocumentReference`
  sites resolve name-based references `valid` across `computeDocumentScene` passes.
  For a `missing` reference they try `repairTopologyReference` (unnamed-op
  fallback) before refusing. The state rides the diagnostic.
- Web-level OCCT test: a reference minted from one `computeDocumentScene` pass
  drives a fillet that renders in the next pass. It still renders after a
  parameter edit that changes the box width.
- Chain workbench picking (chain.ts / CadChainWorkbenchPage.tsx) mints name-based
  references. It keeps working with no UI change.

**Validation**: gatekeeping green across touched packages. New tests pass. Existing
Phase 1 scene tests pass.

---

## Phase E: Make `test:session` runnable on this box
**Type**: Sequential. No commit unless a real repo bug is found.

- Diagnose why `pnpm --filter web run test:session` fails at webServer
  (`db:migrate && build && server` exits 1) and fix the environment: env vars,
  Playwright browsers, local db. Report the exact setup steps so they can be
  baked into the environment blueprint. Don't change app code to work around the
  environment.

---

## Phase 2: Agent plane (webmcp)
**Type**: Sequential. Commit after validation.

**Requirements**:
- `cad_list_commands` verb vocabulary covers the new feature kinds with
  their canonical input layouts (so agents can author them via
  `cad_apply_commands`).
- `cad_get_document_summary` exposes persistent edge/face inventory per
  body so agents can address selections in reference inputs (the layout
  core-bridge already resolves) — follow how it reports ids today.
- `cad_skill` guide updated to teach the new verbs + selection addressing.
- Start from the parked WIP (`document-feature-ops-p2-wip`) and keep what still holds.
- The edge/face inventory is computed only when `cad_get_document_summary` is
  called. The render pass does no per-pass `solid.topology` work for it.
- Rename `cad_list_commands`' layout list to `featureVocabulary`. `featureKinds` in
  the summary keeps meaning "kinds in the timeline". Update the skill and tests.
- The skill and tool text state the real guarantee: name-based references
  survive rebuilds and dimension edits. A reference into a deleted, split-ambiguous
  or unnamed-op entity is repaired or refused, and the state is named.
- Tests for the new tool surface.

**Inputs**: apps/web/src/webmcp/workbench-tools.ts, cad-skill.ts,
workbench-tools.test.tsx, core-bridge layouts.

**Validation**: gatekeeping green + tool tests pass.
**Dependencies**: Phase 1, N3 (references must survive rebuilds before agents author them).

---

## Phase 3: UI authoring
**Type**: Sequential sub-phases + phase-wide validator, then commit.

### 3a: Primitive verbs + forms
- Command-menu entries in complete-workbench.tsx (keyword + empty-state
  guidance pattern); feature forms for dimensions + placement.

### 3b: Fillet/chamfer/shell verbs + edge/face picking
- Reuse the chain workbench's pick surface (name-based references after N3)
  — no new picking mechanism.
- Forms: radius; distance(+angle); thickness + open-face selection.

### 3c: Face-op verbs + forms
- moveFace (axis+distance), deleteFace (heal), replaceFace (datum plane).

**Inputs**: complete-workbench.tsx (verb/keyword/form patterns),
chain.ts + CadChainWorkbenchPage.tsx (pick-surface precedent),
property-panel components.

**Validation**: gatekeeping green; each verb authors a feature that
renders (smoke via unit tests where the harness allows; e2e in Phase 4).
**Dependencies**: Phase 1.

---

## Phase 4: e2e + fixtures
**Type**: Sequential. Commit after validation.

**Requirements**:
- Manifest entries + session stages for every new command surface
  (s99 coverage gate).
- One cad-jsx fixture exercising a primitive + fillet compiled to
  `.native.json`/`.commands.json`, asserted through the document scene.
- Regenerate fixtures only via the project's generation path; do not
  hand-edit generated outputs.

**Inputs**: e2e-session/session.spec.ts, helpers.ts, manifest json,
packages/cad-jsx fixture conventions.

**Validation**: `pnpm test:session` green incl. coverage gate.
**Dependencies**: Phases 1–3, E.
- Include one stage: fillet an edge, edit the box width, the fillet still renders.

---

## Success criteria

- All phases validated; per-phase commits land.
- `pnpm run verify` green; `pnpm test:session` 66+/66+ stages green.
- Branch pushed; PR opened against `glm`.