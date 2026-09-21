/**
 * Per-entity constrainedness (Phase 37) against the fixture sketches: the
 * analysis partitions the solver's own dof honestly (a fully constrained
 * sketch reads zero everywhere; free entities read their parameter width;
 * shared constraints count where they should), agrees with the solver's
 * system dof, and declines (null) on uncompilable systems.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";

import { analyzeConstrainedness } from "./constrainedness";
import {
  createCoincidentConstraint,
  createDistanceConstraint,
  createHorizontalConstraint,
  createRadiusConstraint,
  pointTarget,
} from "./constraints";
import {
  createCircleEntity,
  createLineEntity,
  createPointEntity,
} from "./entities";
import { createReferenceSketchSolver } from "./reference-solver";
import {
  dimensionedRectangleSketch,
  fullyConstrainedTriangleSketch,
} from "./sketch-fixtures";
import { applySolvedParameters } from "./sketch";
import { createSketchConstraintId, createSketchEntityId } from "./sketch-ids";

const id = createSketchEntityId;
const cid = createSketchConstraintId;

describe("analyzeConstrainedness", () => {
  it("reads zero everywhere on the fully constrained triangle", () => {
    const sketch = fullyConstrainedTriangleSketch();
    const solver = createReferenceSketchSolver();
    const result = solver.solve(sketch.entities, sketch.constraints);
    expect(result.status).toBe("solved");
    if (result.status === "failed") return;
    const solved = applySolvedParameters(sketch, result.parameters);
    const analysis = analyzeConstrainedness(
      solved.entities,
      sketch.constraints,
    );
    expect(analysis).not.toBeNull();
    if (analysis === null) return;
    expect(analysis.dof).toBe(0);
    for (const entity of sketch.entities) {
      expect(analysis.entityDof.get(entity.id)).toBe(0);
    }
  });

  it("agrees with the solver's dof on the dimensioned rectangle", () => {
    const sketch = dimensionedRectangleSketch();
    const solver = createReferenceSketchSolver();
    const result = solver.solve(sketch.entities, sketch.constraints);
    expect(result.status !== "failed").toBe(true);
    if (result.status === "failed") return;
    const solved = applySolvedParameters(sketch, result.parameters);
    const analysis = analyzeConstrainedness(
      solved.entities,
      sketch.constraints,
    );
    expect(analysis).not.toBeNull();
    if (analysis === null) return;
    expect(analysis.dof).toBe(result.dof);
    // The system's dof is the sum of the entities' free directions minus the
    // shared directions — here, just assert every entity is bounded and at
    // least one is free when the solver reports freedom.
    if (result.dof > 0) {
      const maxEntityDof = Math.max(
        ...(analysis.entityDof.values() as IterableIterator<number>),
      );
      expect(maxEntityDof).toBeGreaterThan(0);
    }
  });

  it("reads a lone line's four directions and a lone circle's three", () => {
    const ab = id("skent_ab");
    const c = id("skent_c");
    const line = createLineEntity(ab, { x: 0, y: 0 }, { x: 10, y: 0 });
    const circle = createCircleEntity(c, { x: 30, y: 0 }, 5);
    const analysis = analyzeConstrainedness([line, circle], []);
    expect(analysis).not.toBeNull();
    if (analysis === null) return;
    expect(analysis.dof).toBe(7);
    expect(analysis.entityDof.get(ab)).toBe(4);
    expect(analysis.entityDof.get(c)).toBe(3);
  });

  it("a horizontal constraint removes one direction of its line", () => {
    const ab = id("skent_ab");
    const line = createLineEntity(ab, { x: 0, y: 0 }, { x: 10, y: 0 });
    const constrained = analyzeConstrainedness(
      [line],
      [createHorizontalConstraint(cid("skcon_h"), ab)],
    );
    expect(constrained).not.toBeNull();
    if (constrained === null) return;
    expect(constrained.entityDof.get(ab)).toBe(3);
  });

  it("a coincident constraint pins shared directions on BOTH entities", () => {
    const anchor = id("skent_anchor");
    const ab = id("skent_ab");
    const entities = [
      createPointEntity(anchor, { x: 0, y: 0 }, { fixed: true }),
      createLineEntity(ab, { x: 0, y: 0 }, { x: 10, y: 0 }),
    ];
    const constraints = [
      createCoincidentConstraint(
        cid("skcon_c"),
        pointTarget(anchor, "center"),
        pointTarget(ab, "start"),
      ),
    ];
    const analysis = analyzeConstrainedness(entities, constraints);
    expect(analysis).not.toBeNull();
    if (analysis === null) return;
    // The line lost two directions to the shared coincident; the fixed
    // anchor carries none (its slots are pinned outright). The system's
    // free parameters are the line's four; the (fixed-stripped) coincident
    // rows rank 2 → 4 − 2 = 2 system dof.
    expect(analysis.entityDof.get(ab)).toBe(2);
    expect(analysis.entityDof.get(anchor)).toBe(0);
    expect(analysis.dof).toBe(2);
  });

  it("a fully locked circle (center pinned, radius dimensioned) reads zero", () => {
    const anchor = id("skent_anchor");
    const c = id("skent_c");
    const entities = [
      createPointEntity(anchor, { x: 3, y: 4 }, { fixed: true }),
      createCircleEntity(c, { x: 3, y: 4 }, 5),
    ];
    const constraints = [
      createCoincidentConstraint(
        cid("skcon_c"),
        pointTarget(anchor, "center"),
        pointTarget(c, "center"),
      ),
      createRadiusConstraint(cid("skcon_r"), c, length(5)),
    ];
    const analysis = analyzeConstrainedness(entities, constraints);
    expect(analysis).not.toBeNull();
    if (analysis === null) return;
    expect(analysis.dof).toBe(0);
    expect(analysis.entityDof.get(c)).toBe(0);
  });

  it("returns null when the constraint system does not compile", () => {
    const ab = id("skent_ab");
    const line = createLineEntity(ab, { x: 0, y: 0 }, { x: 10, y: 0 });
    const analysis = analyzeConstrainedness(
      [line],
      [
        createDistanceConstraint(
          cid("skcon_d"),
          pointTarget(ab, "start"),
          pointTarget(id("skent_missing"), "center"),
          length(5),
        ),
      ],
    );
    expect(analysis).toBeNull();
  });
});
