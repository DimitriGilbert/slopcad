# ADR: Assembly mates, joints, and interference (Phase 51)

Date: 2026-09-23 · Status: accepted · Phase: 51 (Assemblies II) · Depends: 22 (persistent references), 50 (assemblies I)

## Context

Phase 50 made every document an assembly root with occurrence trees and
deterministic instance transforms. Phase 51 adds the constraint and motion
vocabulary on top: mates (coincident, concentric, distance, angle, parallel,
perpendicular, tangent), joints (rigid, revolute, slider, cylindrical,
planar, ball), a deterministic mate solver with DOF accounting, and pairwise
interference detection — the roadmap's staged "mates-without-motion first,
then joints/DOF" plan.

## Decisions

1. **Mates address mated geometry through Phase 22 machinery generalized
   across instance paths.** A mate endpoint is `(occurrenceId, referenceId)`:
   the occurrence names the instance, the `ReferenceId` names a document
   persistent-reference record (face/edge/vertex) resolved against that
   occurrence's source topology. cad-core never resolves topology; the
   executor-boundary seam hands the solver pre-resolved anchor frames in
   occurrence-local coordinates — the same seam pattern as
   `resolveOccurrencePlacementFromFrames` (assembly.ts).
2. **The solver is staged: mates hold, joints sit at their zero station.**
   Numeric solve = damped Gauss-Newton (Levenberg damping, fixed schedule)
   over each free occurrence's 6-DOF pose (translation + rotation vector,
   Rodrigues exponential map), with fixed-order residuals (mates in document
   order, then joints), a fixed forward-difference step, a fixed-pivot dense
   solve, and a fixed iteration cap. Identical inputs solve bitwise-
   identically (pinned by fixtures). Drag-based motion along the remaining
   DOF is Phase 52; this phase contributes the DOF table
   (`JOINT_REMAINING_DOF`), the joint-frame convention, and
   `jointMotionTransform` (the conjugated pivot `baseWorld ∘ frame ∘ motion
∘ frame⁻¹ ∘ movedWorld`).
3. **Joint-frame convention.** A joint's frame (`origin`, `axis`) lives in
   the BASE occurrence's local coordinates; the zero station anchors the
   moved occurrence's frame origin at the joint origin and its z along the
   axis. Per-kind residual row counts match the DOF table exactly (rigid 6,
   revolute/slider 5, cylindrical 4, planar/ball 3), so the solver's numeric
   rank and the analytic table agree (both are fixture-pinned).
4. **Diagnostics reuse the sketch status model.** Statuses `solved` /
   `underConstrained` / `conflicting` / `unresolved` with structured
   `assembly/mate-*` codes (`assembly/mate-unresolved`,
   `assembly/mate-conflicting`, `assembly/mate-underconstrained`) — the
   sketch solver's vocabulary, assembly-scoped. A golden reference solver
   (`referenceSolveCoincident`, the cad-sketch reference-solver pattern)
   provides the closed forms the numeric solve is checked against.
5. **Interference is a cad-core batch over a kernel seam.** Pairwise boolean
   intersection is kernel work (every kernel's contract exposes `intersect`
   and `volume`); the detector consumes a host-bound
   `intersectVolume(a, b) → number | null` seam, owns the deterministic
   batch (fixed path-then-body pair order, analytic bounding-box pre-filter,
   tolerance rule), and reports pairs with exact volumes and world bounding
   boxes. `null` answers are recorded as `kernel-declined` skips, never
   folded into "no interference".
6. **Native v4→v5.** The additive `mates`/`joints` document sections and
   their id counters are content-additive (the v4→v5 migration is the
   identity), but the envelope stamp moves to 5: an old reader would
   silently drop the standalone sections and counters — the version policy's
   exact trigger (version.ts).
7. **Id space.** `mate` (`mat_`) and `joint` (`jnt_`) join `CAD_ID_KINDS`;
   their counters serialize zero-omitted, so mate-free documents serialize
   byte-identically to their pre-Phase-51 form.
8. **Removal discipline.** `removeOccurrence` now refuses while a mate or
   joint addresses the occurrence (`assembly/occurrence-in-use`) — the
   document model's `document/in-use` rule applied to the assembly
   vocabulary. Mate/joint records themselves remove freely.

## Structured declines

- **Interference report UX** (results panel, isolation, snapshot export) is
  Phase 58's surface; Phase 51 ships the pure detector + batch command.
- **The workbench-level Playwright interference journey** rides the Phase 58
  panel; Phase 51's "overlapping boxes detected with exact volume"
  validation is covered at the cad-core batch level (exact 500 mm³ fixture)
  plus the walk-to-report integration over a real Phase 50 resolution.
- **Drag-based solving with remaining-DOF motion** is Phase 52; the zero-
  station solve, DOF table, and motion transform are this phase's contract.
- **No new kernel probes** — interference consumes the existing
  `intersect`/`volume` contract surface, so no OCCT prespike is owed.

## Consequences

- Deterministic solve fixtures pin bitwise reproducibility and the golden
  closed forms; DOF fixtures pin the joint table and numeric rank.
- `addMate`/`addJoint` validate every address at add time (occurrence +
  reference existence, endpoint distinctness), so the document never carries
  dangling assembly constraints.
- The serialize/parse round-trip, byte-stability, and migration are covered
  by the native-format suites and the re-stamped v5 fixtures.
