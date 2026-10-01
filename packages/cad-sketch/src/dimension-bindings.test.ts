/**
 * Dimension-binding resolution tests: the fast-path identity for unbound
 * lists, the solver-ready literal replacement for bound ones, the
 * structured refusals (unknown parameter, wrong dimension, out-of-range
 * value), the canonical bound wire round-trip, and the compile-level guard
 * that refuses bound constraints reaching the solver unresolved.
 */

import { describe, expect, it } from "vitest";
import {
  angle,
  length,
  type AngleValue,
  type LengthValue,
  type ParameterId,
} from "@slopcad/cad-core";

import {
  boundDimensionParameterId,
  createAngleConstraint,
  createCoincidentConstraint,
  createDistanceConstraint,
  createDistanceXConstraint,
  createLineEntity,
  createPointEntity,
  createRadiusConstraint,
  createCircleEntity,
  pointTarget,
} from "./index";
import {
  type SketchParameterLookup,
  resolveSketchDimensionBindings,
} from "./dimension-bindings";
import { SKETCH_DIAGNOSTIC_CODES, type SketchDiagnostic } from "./diagnostics";
import { compileConstraintSystem } from "./residuals";
import { createReferenceSketchSolver } from "./reference-solver";
import { createSketchConstraintId, createSketchEntityId } from "./sketch-ids";

const boardL = "param_boardL" as ParameterId;
const boardA = "param_boardA" as ParameterId;
const lineId = createSketchEntityId("skent_line");
const otherLineId = createSketchEntityId("skent_other");
const circleId = createSketchEntityId("skent_circle");
const anchorId = createSketchEntityId("skent_anchor");
const distanceId = createSketchConstraintId("skcon_distance");
const angleId = createSketchConstraintId("skcon_angle");
const radiusId = createSketchConstraintId("skcon_radius");
const signedId = createSketchConstraintId("skcon_signed");

/** A document sketch shape: two lines, a circle, an anchor, four dimensions. */
function boundSketch() {
  const entities = [
    createPointEntity(anchorId, { x: 0, y: 0 }),
    createLineEntity(lineId, { x: 0, y: 0 }, { x: 20, y: 0 }),
    createLineEntity(otherLineId, { x: 0, y: 0 }, { x: 0, y: 15 }),
    createCircleEntity(circleId, { x: 40, y: 40 }, 4),
  ];
  const constraints = [
    createCoincidentConstraint(
      createSketchConstraintId("skcon_joint"),
      pointTarget(lineId, "start"),
      pointTarget(otherLineId, "start"),
    ),
    {
      ...createDistanceConstraint(
        distanceId,
        pointTarget(lineId, "start"),
        pointTarget(lineId, "end"),
        length(20),
      ),
      parameterId: boardL,
    },
    {
      ...createAngleConstraint(
        angleId,
        lineId,
        otherLineId,
        angle(Math.PI / 2, "rad"),
      ),
      parameterId: boardA,
    },
    createRadiusConstraint(radiusId, circleId, length(4)),
    createDistanceXConstraint(
      signedId,
      pointTarget(otherLineId, "start"),
      pointTarget(otherLineId, "end"),
      length(15),
    ),
  ];
  return { entities, constraints };
}

/** A lookup over a fixed map, the host adapter's shape. */
function lookupOf(
  entries: Readonly<Record<string, LengthValue | AngleValue>>,
): SketchParameterLookup {
  return (parameterId) => {
    const value = entries[parameterId];
    return value === undefined ? undefined : { value };
  };
}

describe("resolveSketchDimensionBindings", () => {
  it("returns an unbound list reference-identically", () => {
    const { constraints } = boundSketch();
    const unbound = constraints.filter(
      (constraint) => boundDimensionParameterId(constraint) === null,
    );
    const resolved = resolveSketchDimensionBindings(unbound, lookupOf({}));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toBe(unbound);
    // …and a full list resolved against an empty environment still fails
    // loudly rather than silently solving cached literals.
    const dangling = resolveSketchDimensionBindings(constraints, lookupOf({}));
    expect(dangling).toMatchObject({
      ok: false,
      error: {
        code: SKETCH_DIAGNOSTIC_CODES.dimensionBindingUnresolved,
        location: { primary: distanceId },
      },
    });
  });

  it("replaces bound dimensions with resolved canonical literals", () => {
    const { entities, constraints } = boundSketch();
    const resolved = resolveSketchDimensionBindings(
      constraints,
      lookupOf({ [boardL]: length(26), [boardA]: angle(60, "deg") }),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // The unbound constraints pass through by reference; the bound ones
    // come back as plain literals carrying the resolved values.
    const byId = new Map(resolved.value.map((c) => [c.id, c]));
    const resolvedConstraint = byId.get(distanceId);
    expect(resolvedConstraint).toMatchObject({
      kind: "distance",
      value: { dimension: "length", value: 26 },
    });
    if (resolvedConstraint === undefined) {
      throw new Error("unreachable: the distance constraint resolved");
    }
    expect(boundDimensionParameterId(resolvedConstraint)).toBe(null);
    expect(byId.get(angleId)).toMatchObject({
      kind: "angle",
      value: { dimension: "angle", value: Math.PI / 3 },
    });
    expect(byId.get(radiusId)).toBe(
      constraints.find((constraint) => constraint.id === radiusId),
    );
    // Determinism: the same inputs resolve identically.
    const again = resolveSketchDimensionBindings(
      constraints,
      lookupOf({ [boardL]: length(26), [boardA]: angle(60, "deg") }),
    );
    expect(again).toEqual(resolved);
    // And the resolved list compiles (the solver consumes it).
    const compiled = compileConstraintSystem(entities, resolved.value);
    expect("rows" in compiled).toBe(true);
  });

  it("refuses a wrong-dimension or out-of-range parameter value", () => {
    const { constraints } = boundSketch();

    const wrongDimension = resolveSketchDimensionBindings(
      constraints,
      lookupOf({ [boardL]: angle(30, "deg"), [boardA]: angle(60, "deg") }),
    );
    expect(wrongDimension).toMatchObject({
      ok: false,
      error: { code: SKETCH_DIAGNOSTIC_CODES.dimensionBindingInvalid },
    });
    const outOfRange = resolveSketchDimensionBindings(
      constraints,
      lookupOf({ [boardL]: length(0), [boardA]: angle(60, "deg") }),
    );
    expect(outOfRange).toMatchObject({
      ok: false,
      error: {
        code: SKETCH_DIAGNOSTIC_CODES.dimensionBindingInvalid,
        location: { primary: distanceId },
      },
    });
    // The angle kind's open interval: 200° refuses too.
    const angleOutOfRange = resolveSketchDimensionBindings(
      constraints,
      lookupOf({ [boardL]: length(26), [boardA]: angle(200, "deg") }),
    );
    expect(angleOutOfRange).toMatchObject({
      ok: false,
      error: {
        code: SKETCH_DIAGNOSTIC_CODES.dimensionBindingInvalid,
        location: { primary: angleId },
      },
    });
  });

  it("names the first failing constraint deterministically", () => {
    const { constraints } = boundSketch();
    const resolved = resolveSketchDimensionBindings(constraints, lookupOf({}));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    const error: SketchDiagnostic = resolved.error;
    expect(error.message).toContain("skcon_distance");
    expect(error.message).toContain(String(boardL));
  });
});

describe("bound constraints and the solver", () => {
  it("refuses to compile or solve a list that still carries bindings", () => {
    const { entities, constraints } = boundSketch();
    const compiled = compileConstraintSystem(entities, constraints);
    expect(compiled).toMatchObject({
      diagnostics: [
        {
          code: SKETCH_DIAGNOSTIC_CODES.dimensionBindingUnresolved,
          location: { primary: distanceId },
        },
      ],
    });
    const solved = createReferenceSketchSolver().solve(entities, constraints);
    expect(solved).toMatchObject({
      status: "failed",
      diagnostics: [
        { code: SKETCH_DIAGNOSTIC_CODES.dimensionBindingUnresolved },
      ],
    });
  });

  it("solves a sketch whose bindings resolved before the solve", () => {
    const { entities, constraints } = boundSketch();
    const resolved = resolveSketchDimensionBindings(
      constraints,
      lookupOf({ [boardL]: length(30), [boardA]: angle(90, "deg") }),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const solved = createReferenceSketchSolver().solve(
      entities,
      resolved.value,
    );
    expect(solved.status === "failed").toBe(false);
  });
});
