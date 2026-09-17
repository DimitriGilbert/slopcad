/**
 * Solver integration fixtures: the classic parametric sketch shapes, built
 * with the public builders, drawn near their intended solved shapes (the
 * reference solver is local — see its honesty note) with ids stable enough
 * to assert against. These are the Phase 24 "solver integration fixture"
 * deliverable and the seed corpus for later browser phases.
 */

import { length } from "@slopcad/cad-core";
import type { SketchConstraint } from "./constraints";
import type { SketchEntity } from "./entities";
import type { Sketch } from "./sketch";

import {
  createCoincidentConstraint,
  createDistanceConstraint,
  createEqualConstraint,
  createHorizontalConstraint,
  createParallelConstraint,
  createRadiusConstraint,
  createSymmetryAboutLineConstraint,
  createTangentConstraint,
  pointTarget,
} from "./constraints";
import {
  createArcEntity,
  createCircleEntity,
  createLineEntity,
  createPointEntity,
  createRectangleEntity,
} from "./entities";
import {
  createSketchConstraintId,
  createSketchEntityId,
} from "./sketch-ids";
import { createSketch } from "./sketch";
import { xyWorkplane } from "./workplane";

function requireSketch(sketch: ReturnType<typeof createSketch>): Sketch {
  if (!sketch.ok) throw new Error(`Fixture sketch is invalid: ${sketch.error.message}`);
  return sketch.value;
}

/**
 * A fully constrained triangle: three chained lines, the first vertex pinned
 * to a fixed construction point at the workplane origin, one edge horizontal,
 * and all three side lengths dimensioned (50/30/40 mm). Zero degrees of
 * freedom; exact side lengths at the solved state.
 */
export function fullyConstrainedTriangleSketch(): Sketch {
  const anchor = createSketchEntityId("skent_anchor");
  const ab = createSketchEntityId("skent_triangle-ab");
  const bc = createSketchEntityId("skent_triangle-bc");
  const ca = createSketchEntityId("skent_triangle-ca");
  const entities: SketchEntity[] = [
    createPointEntity(anchor, { x: 0, y: 0 }, { construction: true, fixed: true }),
    createLineEntity(ab, { x: 0, y: 0 }, { x: 48, y: 6 }),
    createLineEntity(bc, { x: 48, y: 6 }, { x: 9, y: 33 }),
    createLineEntity(ca, { x: 9, y: 33 }, { x: 0, y: 0 }),
  ];
  const c = (raw: string) => createSketchConstraintId(raw);
  const start = pointTarget(ab, "start");
  const constraints: SketchConstraint[] = [
    createCoincidentConstraint(c("skcon_anchor-a"), start, pointTarget(anchor, "center")),
    createCoincidentConstraint(
      c("skcon_a-b"),
      pointTarget(ab, "end"),
      pointTarget(bc, "start"),
    ),
    createCoincidentConstraint(
      c("skcon_b-c"),
      pointTarget(bc, "end"),
      pointTarget(ca, "start"),
    ),
    createCoincidentConstraint(
      c("skcon_c-a"),
      pointTarget(ca, "end"),
      pointTarget(ab, "start"),
    ),
    createHorizontalConstraint(c("skcon_ab-horizontal"), ab),
    createDistanceConstraint(
      c("skcon_ab-length"),
      pointTarget(ab, "start"),
      pointTarget(ab, "end"),
      length(50),
    ),
    createDistanceConstraint(
      c("skcon_bc-length"),
      pointTarget(bc, "start"),
      pointTarget(bc, "end"),
      length(30),
    ),
    createDistanceConstraint(
      c("skcon_ca-length"),
      pointTarget(ca, "start"),
      pointTarget(ca, "end"),
      length(40),
    ),
  ];
  return requireSketch(createSketch(xyWorkplane(), entities, constraints));
}

/**
 * A rectangle composed of four chained line entities plus the rectangle
 * entity carrying the integrity rule, dimensioned 60 × 40 mm with the bottom
 * edge horizontal and the bottom-left corner pinned to a fixed construction
 * point at the origin. Zero degrees of freedom; exact width/height at the
 * solved state.
 */
export function dimensionedRectangleSketch(): Sketch {
  const anchor = createSketchEntityId("skent_rect-anchor");
  const bottom = createSketchEntityId("skent_rect-bottom");
  const right = createSketchEntityId("skent_rect-right");
  const top = createSketchEntityId("skent_rect-top");
  const left = createSketchEntityId("skent_rect-left");
  const rect = createSketchEntityId("skent_rect-frame");
  const entities: SketchEntity[] = [
    createPointEntity(anchor, { x: 0, y: 0 }, { construction: true, fixed: true }),
    createLineEntity(bottom, { x: 0, y: 0 }, { x: 57, y: 2 }),
    createLineEntity(right, { x: 57, y: 2 }, { x: 55, y: 41 }),
    createLineEntity(top, { x: 55, y: 41 }, { x: -2, y: 39 }),
    createLineEntity(left, { x: -2, y: 39 }, { x: 0, y: 0 }),
    createRectangleEntity(rect, [bottom, right, top, left]),
  ];
  const c = (raw: string) => createSketchConstraintId(raw);
  const constraints: SketchConstraint[] = [
    createCoincidentConstraint(
      c("skcon_rect-anchor"),
      pointTarget(bottom, "start"),
      pointTarget(anchor, "center"),
    ),
    createHorizontalConstraint(c("skcon_rect-horizontal"), bottom),
    createDistanceConstraint(
      c("skcon_rect-width"),
      pointTarget(bottom, "start"),
      pointTarget(bottom, "end"),
      length(60),
    ),
    createDistanceConstraint(
      c("skcon_rect-height"),
      pointTarget(right, "start"),
      pointTarget(right, "end"),
      length(40),
    ),
  ];
  return requireSketch(createSketch(xyWorkplane(), entities, constraints));
}

/**
 * A tangent chain: a circle pinned at the origin (fixed anchor point +
 * radius 20), a second circle of radius 30 externally tangent to it, and a
 * line tangent to both circles with its length (100) and the distance of its
 * start from the origin (25) dimensioned. One degree of freedom remains (the
 * chain can rotate about the anchor); every tangency and dimension holds
 * exactly at the solved state.
 */
export function tangentChainSketch(): Sketch {
  const anchor = createSketchEntityId("skent_tan-anchor");
  const small = createSketchEntityId("skent_tan-small");
  const large = createSketchEntityId("skent_tan-large");
  const tangent = createSketchEntityId("skent_tan-line");
  const entities: SketchEntity[] = [
    createPointEntity(anchor, { x: 0, y: 0 }, { construction: true, fixed: true }),
    createCircleEntity(small, { x: 0, y: 0 }, 20),
    createCircleEntity(large, { x: 52, y: 3 }, 28),
    createLineEntity(tangent, { x: 12, y: 21 }, { x: 107, y: 44 }),
  ];
  const c = (raw: string) => createSketchConstraintId(raw);
  const constraints: SketchConstraint[] = [
    createCoincidentConstraint(
      c("skcon_tan-anchor"),
      pointTarget(small, "center"),
      pointTarget(anchor, "center"),
    ),
    createRadiusConstraint(c("skcon_tan-small-r"), small, length(20)),
    createRadiusConstraint(c("skcon_tan-large-r"), large, length(30)),
    createTangentConstraint(c("skcon_tan-circles"), small, large, "external"),
    createTangentConstraint(c("skcon_tan-line-small"), tangent, small),
    createTangentConstraint(c("skcon_tan-line-large"), tangent, large),
    createDistanceConstraint(
      c("skcon_tan-line-length"),
      pointTarget(tangent, "start"),
      pointTarget(tangent, "end"),
      length(100),
    ),
    createDistanceConstraint(
      c("skcon_tan-line-start"),
      pointTarget(anchor, "center"),
      pointTarget(tangent, "start"),
      length(25),
    ),
  ];
  return requireSketch(createSketch(xyWorkplane(), entities, constraints));
}

/**
 * A symmetric pattern: two circles mirrored about a fixed vertical
 * construction axis line, equal radii dimensioned to 10 mm, the first
 * circle's center pinned by coincidence with a fixed construction point.
 * Zero degrees of freedom; the solved centers are exact mirrors.
 */
export function symmetricPatternSketch(): Sketch {
  const axis = createSketchEntityId("skent_sym-axis");
  const pin = createSketchEntityId("skent_sym-pin");
  const left = createSketchEntityId("skent_sym-left");
  const right = createSketchEntityId("skent_sym-right");
  const entities: SketchEntity[] = [
    createLineEntity(axis, { x: 0, y: 0 }, { x: 0, y: 90 }, { construction: true, fixed: true }),
    createPointEntity(pin, { x: -25, y: 50 }, { construction: true, fixed: true }),
    createCircleEntity(left, { x: -23, y: 47 }, 9),
    createCircleEntity(right, { x: 23, y: 47 }, 9),
  ];
  const c = (raw: string) => createSketchConstraintId(raw);
  const constraints: SketchConstraint[] = [
    createSymmetryAboutLineConstraint(
      c("skcon_sym-mirror"),
      pointTarget(left, "center"),
      pointTarget(right, "center"),
      axis,
    ),
    createEqualConstraint(c("skcon_sym-equal"), left, right),
    createRadiusConstraint(c("skcon_sym-radius"), left, length(10)),
    createCoincidentConstraint(
      c("skcon_sym-pin"),
      pointTarget(left, "center"),
      pointTarget(pin, "center"),
    ),
  ];
  return requireSketch(createSketch(xyWorkplane(), entities, constraints));
}

/**
 * A conflicting pair: the same line segment dimensioned twice with
 * incompatible values (50 and 60 mm). Solving fails with
 * `sketch/constraints-conflicting` — removing either dimension alone makes
 * the system solvable.
 */
export function conflictingDimensionsSketch(): Sketch {
  const segment = createSketchEntityId("skent_conflict");
  const entities: SketchEntity[] = [
    createLineEntity(segment, { x: 0, y: 0 }, { x: 52, y: 1 }),
  ];
  const c = (raw: string) => createSketchConstraintId(raw);
  const constraints: SketchConstraint[] = [
    createDistanceConstraint(
      c("skcon_conflict-a"),
      pointTarget(segment, "start"),
      pointTarget(segment, "end"),
      length(50),
    ),
    createDistanceConstraint(
      c("skcon_conflict-b"),
      pointTarget(segment, "start"),
      pointTarget(segment, "end"),
      length(60),
    ),
  ];
  return requireSketch(createSketch(xyWorkplane(), entities, constraints));
}

/**
 * A distributed infeasibility: three points, two coincidences and two
 * distances that cannot all hold (10 and 20 mm across coincident points) —
 * no single constraint removal resolves it, so solving fails with
 * `sketch/constraints-unsatisfiable`.
 */
export function unsatisfiableChainSketch(): Sketch {
  const p1 = createSketchEntityId("skent_unsat-p1");
  const p2 = createSketchEntityId("skent_unsat-p2");
  const p3 = createSketchEntityId("skent_unsat-p3");
  const entities: SketchEntity[] = [
    createPointEntity(p1, { x: 0, y: 0 }),
    createPointEntity(p2, { x: 10, y: 0 }),
    createPointEntity(p3, { x: 20, y: 1 }),
  ];
  const c = (raw: string) => createSketchConstraintId(raw);
  const constraints: SketchConstraint[] = [
    createCoincidentConstraint(c("skcon_unsat-12"), pointTarget(p1, "center"), pointTarget(p2, "center")),
    createCoincidentConstraint(c("skcon_unsat-13"), pointTarget(p1, "center"), pointTarget(p3, "center")),
    createDistanceConstraint(
      c("skcon_unsat-d12"),
      pointTarget(p1, "center"),
      pointTarget(p2, "center"),
      length(10),
    ),
    createDistanceConstraint(
      c("skcon_unsat-d23"),
      pointTarget(p2, "center"),
      pointTarget(p3, "center"),
      length(20),
    ),
  ];
  return requireSketch(createSketch(xyWorkplane(), entities, constraints));
}

/**
 * A redundant-but-consistent system: two lines, one horizontal, the other
 * horizontal, and a parallel constraint between them — the parallel follows
 * from the two horizontals. Solving succeeds with a
 * `sketch/constraints-redundant` warning.
 */
export function redundantConstraintSketch(): Sketch {
  const a = createSketchEntityId("skent_red-a");
  const b = createSketchEntityId("skent_red-b");
  const entities: SketchEntity[] = [
    createLineEntity(a, { x: 0, y: 0 }, { x: 40, y: 0 }),
    createLineEntity(b, { x: 0, y: 20 }, { x: 35, y: 20 }),
  ];
  const c = (raw: string) => createSketchConstraintId(raw);
  const constraints: SketchConstraint[] = [
    createHorizontalConstraint(c("skcon_red-a"), a),
    createHorizontalConstraint(c("skcon_red-b"), b),
    createParallelConstraint(c("skcon_red-parallel"), a, b),
  ];
  return requireSketch(createSketch(xyWorkplane(), entities, constraints));
}

/**
 * An arc chain: a horizontal line from the origin, dimensioned 25 mm, whose
 * end coincides with an arc's start point; the arc's radius (10 mm) and its
 * center's distance from the origin (30 mm) are dimensioned. One degree of
 * freedom remains (the arc's end angle); the join, dimensions, and radius
 * hold exactly at the solved state. Exercises arc endpoint targets and arc
 * parameters in solving.
 */
export function arcChainSketch(): Sketch {
  const anchor = createSketchEntityId("skent_arc-anchor");
  const line = createSketchEntityId("skent_arc-line");
  const arc = createSketchEntityId("skent_arc-arc");
  const entities: SketchEntity[] = [
    createPointEntity(anchor, { x: 0, y: 0 }, { construction: true, fixed: true }),
    createLineEntity(line, { x: 0, y: 0 }, { x: 24, y: 0.4 }),
    createArcEntity(arc, { x: 28.7, y: 9.0 }, 9.7, 4.4, 5.9),
  ];
  const c = (raw: string) => createSketchConstraintId(raw);
  const constraints: SketchConstraint[] = [
    createCoincidentConstraint(
      c("skcon_arc-anchor"),
      pointTarget(line, "start"),
      pointTarget(anchor, "center"),
    ),
    createHorizontalConstraint(c("skcon_arc-horizontal"), line),
    createDistanceConstraint(
      c("skcon_arc-line-length"),
      pointTarget(line, "start"),
      pointTarget(line, "end"),
      length(25),
    ),
    createCoincidentConstraint(
      c("skcon_arc-join"),
      pointTarget(line, "end"),
      pointTarget(arc, "start"),
    ),
    createRadiusConstraint(c("skcon_arc-radius"), arc, length(10)),
    createDistanceConstraint(
      c("skcon_arc-center-distance"),
      pointTarget(anchor, "center"),
      pointTarget(arc, "center"),
      length(30),
    ),
  ];
  return requireSketch(createSketch(xyWorkplane(), entities, constraints));
}
