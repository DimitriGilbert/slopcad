/**
 * The `sketches` and `constraints` guides' runnable example
 * (docs/guides/sketches.md, docs/guides/constraints.md): the 2D
 * parametric sketch domain — a triangle on the XY workplane, first
 * solved under-constrained (degrees of freedom reported honestly), then
 * fully constrained through a horizontal, two distance, and coincident
 * constraints, then serialized and reparsed round-trip-exact, and its
 * profile resolved into the closed loop an `extrude` feature consumes.
 */

import {
  applySolvedParameters,
  createCoincidentConstraint,
  createDistanceConstraint,
  createHorizontalConstraint,
  createLineEntity,
  createPointEntity,
  createReferenceSketchSolver,
  createSketch,
  createSketchConstraintId,
  createSketchEntityId,
  parseSketch,
  pointTarget,
  resolveExtrudeProfile,
  serializeSketch,
  xyWorkplane,
  type SketchSolveResult,
} from "@slopcad/cad-sketch";
import { length } from "@slopcad/cad-core";

import { unwrap } from "../core/document";

/** The example's entity ids. */
const L_AB = createSketchEntityId("skent_guide_ab");
const L_BC = createSketchEntityId("skent_guide_bc");
const L_CA = createSketchEntityId("skent_guide_ca");

/** The guide's triangle sides (mm). */
export const TRIANGLE_SIDES_MM = { ab: 50, bc: 30, ca: 40 } as const;
/** Heron's area of the 50/30/40 triangle (mm²). */
export const TRIANGLE_AREA_MM2 = 600;

/** What the example reports back to the guide and the docs page. */
export interface SketchExampleSummary {
  readonly underConstrainedDof: number;
  readonly solvedDof: number;
  readonly solvedAbLengthMm: number;
  readonly serializedRoundTripExact: boolean;
  readonly profileLoopSegments: number;
  readonly profileSignedAreaMm2: number;
}

/** Runs the sketch tour and reports the facts the guide states. */
export function runSketchExample(): SketchExampleSummary {
  const workplane = xyWorkplane();
  // A construction anchor pinned at the origin (the fixture the reference
  // solver's own tests use), plus the triangle's three lines.
  const anchor = createSketchEntityId("skent_guide_anchor");
  const entities = [
    createPointEntity(
      anchor,
      { x: 0, y: 0 },
      {
        construction: true,
        fixed: true,
      },
    ),
    createLineEntity(L_AB, { x: 0, y: 0 }, { x: 46, y: 12 }),
    createLineEntity(L_BC, { x: 46, y: 12 }, { x: 10, y: 32 }),
    createLineEntity(L_CA, { x: 10, y: 32 }, { x: 0, y: 0 }),
  ];

  // Geometry alone: under-constrained, the solver reports the remaining
  // degrees of freedom honestly.
  const bare = unwrap(
    createSketch(workplane, entities, []),
    "the unconstrained sketch",
  );
  const solver = createReferenceSketchSolver();
  const bareSolve: SketchSolveResult = solver.solve(
    bare.entities,
    bare.constraints,
  );
  if (bareSolve.status === "failed") {
    throw new Error("The unconstrained sketch failed to solve.");
  }

  // The constrained sketch: the loop closes on the fixed anchor through
  // four coincidences, AB sits horizontal, and the three sides carry the
  // distances 50 / 30 / 40 — zero degrees of freedom remain.
  const constraints = [
    createCoincidentConstraint(
      createSketchConstraintId("skcon_guide_anchor_a"),
      pointTarget(L_AB, "start"),
      pointTarget(anchor, "center"),
    ),
    createCoincidentConstraint(
      createSketchConstraintId("skcon_guide_a_b"),
      pointTarget(L_AB, "end"),
      pointTarget(L_BC, "start"),
    ),
    createCoincidentConstraint(
      createSketchConstraintId("skcon_guide_b_c"),
      pointTarget(L_BC, "end"),
      pointTarget(L_CA, "start"),
    ),
    createCoincidentConstraint(
      createSketchConstraintId("skcon_guide_c_a"),
      pointTarget(L_CA, "end"),
      pointTarget(L_AB, "start"),
    ),
    createHorizontalConstraint(
      createSketchConstraintId("skcon_guide_ab_h"),
      L_AB,
    ),
    createDistanceConstraint(
      createSketchConstraintId("skcon_guide_ab_len"),
      pointTarget(L_AB, "start"),
      pointTarget(L_AB, "end"),
      length(50),
    ),
    createDistanceConstraint(
      createSketchConstraintId("skcon_guide_bc_len"),
      pointTarget(L_BC, "start"),
      pointTarget(L_BC, "end"),
      length(30),
    ),
    createDistanceConstraint(
      createSketchConstraintId("skcon_guide_ca_len"),
      pointTarget(L_CA, "start"),
      pointTarget(L_CA, "end"),
      length(40),
    ),
  ];
  const constrained = unwrap(
    createSketch(workplane, entities, constraints),
    "the constrained sketch",
  );
  const solve = solver.solve(constrained.entities, constrained.constraints);
  if (solve.status === "failed") {
    throw new Error(
      `The constrained sketch failed to solve: ${solve.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
    );
  }
  const ab = solve.parameters.entities.find((entity) => entity.id === L_AB);
  if (ab === undefined || !("x1" in ab)) {
    throw new Error("The solver result lost the AB line's endpoints.");
  }

  // Serialization round trip: parse(serialize(sketch)) serializes to
  // identical JSON.
  const serialized = serializeSketch(constrained);
  const reparsed = unwrap(
    parseSketch(JSON.parse(JSON.stringify(serialized)) as unknown),
    "the reparsed sketch",
  );
  const roundTripExact =
    JSON.stringify(serializeSketch(reparsed)) === JSON.stringify(serialized);

  // The solved parameters, applied back onto the sketch, and the closed
  // loop the extrude feature consumes (resolution runs on SOLVED geometry).
  const solved = applySolvedParameters(constrained, solve.parameters);
  const profile = resolveExtrudeProfile(solved.entities);
  if (!profile.ok) {
    throw new Error(`Profile resolution failed: ${profile.error.message}`);
  }

  return {
    underConstrainedDof: bareSolve.dof,
    solvedDof: solve.dof,
    solvedAbLengthMm: Math.hypot(ab.x2 - ab.x1, ab.y2 - ab.y1),
    serializedRoundTripExact: roundTripExact,
    profileLoopSegments: profile.value.segments.length,
    profileSignedAreaMm2: profile.value.signedArea,
  };
}
