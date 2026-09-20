/**
 * The Phase 36 vocabulary example (docs/guides/sketches.md's entity
 * section): the new entity and constraint kinds exercised end to end — an
 * ellipse dimensioned through the signed axis constraints, a spline whose
 * endpoints are pinned, and a slot sized by its radius — every fact the
 * guide states machine-verified.
 */

import {
  createCoincidentConstraint,
  createDistanceXConstraint,
  createDistanceYConstraint,
  createEllipseEntity,
  createHorizontalPairConstraint,
  createPointEntity,
  createRadiusConstraint,
  createReferenceSketchSolver,
  createSketch,
  createSketchConstraintId,
  createSketchEntityId,
  createSplineEntity,
  createStraightSlotEntity,
  parseSketch,
  pointTarget,
  resolveProfileLoops,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";
import { length } from "@slopcad/cad-core";

import { unwrap } from "../core/document";

const ELLIPSE = createSketchEntityId("skent_guide_ellipse");
const ANCHOR = createSketchEntityId("skent_guide_anchor");
const SPLINE = createSketchEntityId("skent_guide_spline");
const A = createSketchEntityId("skent_guide_a");
const B = createSketchEntityId("skent_guide_b");
const SLOT = createSketchEntityId("skent_guide_slot");

/** What the example reports back to the guide and the docs page. */
export interface SketchVocabularySummary {
  /** The ellipse's bare degrees of freedom (5). */
  readonly ellipseDof: number;
  /** The fully constrained ellipse's degrees of freedom (0). */
  readonly ellipseConstrainedDof: number;
  /** The solved major semi-axis (mm). */
  readonly solvedRadiusXMm: number;
  /** The solved minor semi-axis (mm). */
  readonly solvedRadiusYMm: number;
  /** The spline's interior freedoms after pinning both endpoints (4). */
  readonly splineInteriorDof: number;
  /** The slot profile loop's segment count (2 cap arcs + 2 tangent lines). */
  readonly slotLoopSegments: number;
  /** The slot's exact stadium area πr² + 2rL (mm²). */
  readonly slotLoopAreaMm2: number;
  /** The serialized sketch round-trips byte-identically. */
  readonly serializedRoundTripExact: boolean;
}

/** Runs the Phase 36 vocabulary tour and reports the facts it proves. */
export function runSketchVocabularyExample(): SketchVocabularySummary {
  const solver = createReferenceSketchSolver();

  // An ellipse alone: exactly its 5 degrees of freedom.
  const ellipse = createEllipseEntity(ELLIPSE, { x: 2, y: 1 }, 7.5, 4.2, 0.3);
  const bare = unwrap(
    createSketch(xyWorkplane(), [ellipse], []),
    "the bare ellipse",
  );
  const bareSolve = solver.solve(bare.entities, bare.constraints);
  if (bareSolve.status === "failed") {
    throw new Error("The bare ellipse failed to solve.");
  }

  // Fully constrained: the center pinned to a fixed anchor (2 rows), the
  // two semi-axes dimensioned through the SIGNED axis separations from the
  // center to the axis ends (2 rows), and the major axis aligned with x
  // through a point pair (1 row) — 0 dof.
  const anchor = createPointEntity(
    ANCHOR,
    { x: 0, y: 0 },
    {
      construction: true,
      fixed: true,
    },
  );
  const constrained = unwrap(
    createSketch(
      xyWorkplane(),
      [anchor, ellipse],
      [
        createCoincidentConstraint(
          createSketchConstraintId("skcon_guide_e_center"),
          pointTarget(ELLIPSE, "center"),
          pointTarget(ANCHOR, "center"),
        ),
        createDistanceXConstraint(
          createSketchConstraintId("skcon_guide_e_major"),
          pointTarget(ELLIPSE, "center"),
          pointTarget(ELLIPSE, "start"),
          length(8),
        ),
        createDistanceYConstraint(
          createSketchConstraintId("skcon_guide_e_minor"),
          pointTarget(ELLIPSE, "center"),
          pointTarget(ELLIPSE, "end"),
          length(5),
        ),
        createHorizontalPairConstraint(
          createSketchConstraintId("skcon_guide_e_align"),
          pointTarget(ELLIPSE, "center"),
          pointTarget(ELLIPSE, "start"),
        ),
      ],
    ),
    "the constrained ellipse",
  );
  const solve = solver.solve(constrained.entities, constrained.constraints);
  if (solve.status === "failed") {
    throw new Error(
      `The constrained ellipse failed to solve: ${solve.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
    );
  }
  const solvedEllipse = solve.parameters.entities.find(
    (entity) => entity.id === ELLIPSE,
  );
  if (solvedEllipse?.kind !== "ellipse") {
    throw new Error("The solver result lost the ellipse.");
  }

  // A control-point spline with both endpoints pinned to fixed anchors:
  // 8 unknowns − 4 endpoint rows = 4 interior freedoms (the pinned scope).
  const a = createPointEntity(
    A,
    { x: 0, y: 0 },
    {
      construction: true,
      fixed: true,
    },
  );
  const b = createPointEntity(
    B,
    { x: 10, y: 0 },
    {
      construction: true,
      fixed: true,
    },
  );
  const spline = createSplineEntity(SPLINE, "control", [
    { x: 0, y: 0 },
    { x: 2, y: 6 },
    { x: 6, y: -6 },
    { x: 10, y: 0 },
  ]);
  const pinned = unwrap(
    createSketch(
      xyWorkplane(),
      [a, b, spline],
      [
        createCoincidentConstraint(
          createSketchConstraintId("skcon_guide_s_start"),
          pointTarget(SPLINE, "start"),
          pointTarget(A, "center"),
        ),
        createCoincidentConstraint(
          createSketchConstraintId("skcon_guide_s_end"),
          pointTarget(SPLINE, "end"),
          pointTarget(B, "center"),
        ),
      ],
    ),
    "the endpoint-pinned spline",
  );
  const pinnedSolve = solver.solve(pinned.entities, pinned.constraints);
  if (pinnedSolve.status === "failed") {
    throw new Error("The endpoint-pinned spline failed to solve.");
  }

  // A straight slot: its profile loop resolves to exactly two cap arcs and
  // two tangent lines enclosing the exact stadium area.
  const slot = createStraightSlotEntity(
    SLOT,
    { x: -5, y: 0 },
    { x: 5, y: 0 },
    2,
  );
  const slotted = unwrap(
    createSketch(
      xyWorkplane(),
      [slot],
      [
        createRadiusConstraint(
          createSketchConstraintId("skcon_guide_slot_r"),
          SLOT,
          length(2),
        ),
      ],
    ),
    "the slot",
  );
  const loops = resolveProfileLoops(slotted.entities);
  if (!loops.ok) {
    throw new Error(`Slot profile resolution failed: ${loops.error.message}`);
  }
  const loop = loops.value.loops[0];
  if (loop === undefined) {
    throw new Error("The slot resolved no loop.");
  }

  // Serialization round trip over the whole tour: byte-identical.
  const serialized = serializeSketch(slotted);
  const reparsed = unwrap(
    parseSketch(JSON.parse(JSON.stringify(serialized)) as unknown),
    "the reparsed slot sketch",
  );
  const roundTripExact =
    JSON.stringify(serializeSketch(reparsed)) === JSON.stringify(serialized);

  return {
    ellipseDof: bareSolve.dof,
    ellipseConstrainedDof: solve.dof,
    solvedRadiusXMm: solvedEllipse.radiusX,
    solvedRadiusYMm: solvedEllipse.radiusY,
    splineInteriorDof: pinnedSolve.dof,
    slotLoopSegments: loop.segments.length,
    slotLoopAreaMm2: Math.abs(loop.signedArea),
    serializedRoundTripExact: roundTripExact,
  };
}
