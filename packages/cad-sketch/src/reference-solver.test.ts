import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import type {
  SketchEntity,
  SketchSolveResult,
  SolvedEntityParameters,
} from "./index";

import {
  arcChainSketch,
  conflictingDimensionsSketch,
  createReferenceSketchSolver,
  dimensionedRectangleSketch,
  fullyConstrainedTriangleSketch,
  redundantConstraintSketch,
  symmetricPatternSketch,
  tangentChainSketch,
  unsatisfiableChainSketch,
} from "./index";
import {
  SKETCH_DIAGNOSTIC_CODES,
  SPLINE_TESSELLATION_DEFLECTION_MM,
  cubicStationaryParameters,
  projectOntoSpline,
  applySolvedParameters,
  createAngleConstraint,
  createArcEntity,
  createCircleEntity,
  createCoincidentConstraint,
  createCollinearConstraint,
  createDistanceXConstraint,
  createDistanceYConstraint,
  createEllipseEntity,
  createEllipticalArcEntity,
  createHorizontalPairConstraint,
  createPointOnEntityConstraint,
  createPointOnTangentConstraint,
  createPolygonEntity,
  createSplineEntity,
  createStraightSlotEntity,
  createDiameterConstraint,
  createDistanceConstraint,
  createEqualConstraint,
  createHorizontalConstraint,
  createLineEntity,
  createMidpointConstraint,
  createParallelConstraint,
  createPerpendicularConstraint,
  createPointEntity,
  createRadiusConstraint,
  createRectangleEntity,
  createSymmetryAboutLineConstraint,
  createSymmetryAboutPointConstraint,
  createTangentConstraint,
  createVerticalConstraint,
  pointTarget,
  serializeSketch,
  solvedEntityParametersById,
} from "./index";
import { createSketchConstraintId, createSketchEntityId } from "./index";

const solver = createReferenceSketchSolver();
const eid = (raw: string) => createSketchEntityId(raw);
const cid = (raw: string) => createSketchConstraintId(`skcon_${raw}`);

function solvedOf(
  result: Extract<
    SketchSolveResult,
    { status: "solved" | "under-constrained" }
  >,
): ReadonlyMap<string, SolvedEntityParameters> {
  return solvedEntityParametersById(result.parameters);
}

function solvedLine(
  result: Extract<
    SketchSolveResult,
    { status: "solved" | "under-constrained" }
  >,
  id: string,
): { x1: number; y1: number; x2: number; y2: number } {
  const solved = solvedOf(result).get(id);
  if (solved === undefined || solved.kind !== "line") {
    throw new Error(`Missing solved line ${id}`);
  }
  return solved;
}

function solvedCircle(
  result: Extract<
    SketchSolveResult,
    { status: "solved" | "under-constrained" }
  >,
  id: string,
): { cx: number; cy: number; radius: number } {
  const solved = solvedOf(result).get(id);
  if (
    solved === undefined ||
    (solved.kind !== "circle" && solved.kind !== "arc")
  ) {
    throw new Error(`Missing solved circle ${id}`);
  }
  return solved;
}

function solvedPoint(
  result: Extract<
    SketchSolveResult,
    { status: "solved" | "under-constrained" }
  >,
  id: string,
): { x: number; y: number } {
  const solved = solvedOf(result).get(id);
  if (solved === undefined || solved.kind !== "point") {
    throw new Error(`Missing solved point ${id}`);
  }
  return solved;
}

function pointLineDistance(
  point: { x: number; y: number },
  line: { x1: number; y1: number; x2: number; y2: number },
): number {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const norm = Math.hypot(dx, dy);
  return Math.abs(dx * (point.y - line.y1) - dy * (point.x - line.x1)) / norm;
}

describe("reference solver — classic fixtures", () => {
  it("solves a fully constrained triangle to exact dimensions with zero DoF", () => {
    const sketch = fullyConstrainedTriangleSketch();
    const result = solver.solve(sketch.entities, sketch.constraints);
    expect(result.status).toBe("solved");
    if (result.status === "failed") return;
    expect(result.dof).toBe(0);
    expect(result.diagnostics).toHaveLength(0);
    const ab = solvedLine(result, "skent_triangle-ab");
    const bc = solvedLine(result, "skent_triangle-bc");
    const ca = solvedLine(result, "skent_triangle-ca");
    expect(ab.x1).toBeCloseTo(0, 6);
    expect(ab.y1).toBeCloseTo(0, 6);
    expect(ab.x2).toBeCloseTo(50, 6);
    expect(ab.y2).toBeCloseTo(0, 6);
    expect(Math.hypot(bc.x2 - bc.x1, bc.y2 - bc.y1)).toBeCloseTo(30, 6);
    expect(Math.hypot(ca.x2 - ca.x1, ca.y2 - ca.y1)).toBeCloseTo(40, 6);
    expect(bc.x1).toBeCloseTo(50, 6);
    expect(ca.x2).toBeCloseTo(0, 6);
    expect(ca.y2).toBeCloseTo(0, 6);
    expect(bc.y1).toBeCloseTo(0, 6);
    expect(bc.y2).toBeCloseTo(24, 6);
    expect(bc.x2).toBeCloseTo(32, 6);
  });

  it("solves a dimensioned rectangle to exact corners with zero DoF", () => {
    const sketch = dimensionedRectangleSketch();
    const result = solver.solve(sketch.entities, sketch.constraints);
    expect(result.status).toBe("solved");
    if (result.status === "failed") return;
    expect(result.dof).toBe(0);
    expect(result.diagnostics).toHaveLength(0);
    const bottom = solvedLine(result, "skent_rect-bottom");
    expect(bottom.x1).toBeCloseTo(0, 6);
    expect(bottom.y1).toBeCloseTo(0, 6);
    expect(bottom.x2).toBeCloseTo(60, 6);
    expect(bottom.y2).toBeCloseTo(0, 6);
    const right = solvedLine(result, "skent_rect-right");
    expect(right.x1).toBeCloseTo(60, 6);
    expect(right.y1).toBeCloseTo(0, 6);
    expect(right.x2).toBeCloseTo(60, 6);
    expect(right.y2).toBeCloseTo(40, 6);
    const top = solvedLine(result, "skent_rect-top");
    expect(top.x1).toBeCloseTo(60, 6);
    expect(top.y1).toBeCloseTo(40, 6);
    expect(top.x2).toBeCloseTo(0, 6);
    expect(top.y2).toBeCloseTo(40, 6);
    const left = solvedLine(result, "skent_rect-left");
    expect(left.x1).toBeCloseTo(0, 6);
    expect(left.y1).toBeCloseTo(40, 6);
    expect(left.x2).toBeCloseTo(0, 6);
    expect(left.y2).toBeCloseTo(0, 6);
  });

  it("solves a tangent chain exactly, surfacing its remaining DoF", () => {
    const sketch = tangentChainSketch();
    const result = solver.solve(sketch.entities, sketch.constraints);
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    expect(result.dof).toBe(1);
    const small = solvedCircle(result, "skent_tan-small");
    const large = solvedCircle(result, "skent_tan-large");
    const line = solvedLine(result, "skent_tan-line");
    expect(small.cx).toBeCloseTo(0, 6);
    expect(small.cy).toBeCloseTo(0, 6);
    expect(small.radius).toBeCloseTo(20, 6);
    expect(large.radius).toBeCloseTo(30, 6);
    expect(Math.hypot(large.cx - small.cx, large.cy - small.cy)).toBeCloseTo(
      50,
      6,
    );
    expect(
      pointLineDistance({ x: small.cx, y: small.cy }, line),
      "line tangent to small circle",
    ).toBeCloseTo(20, 6);
    expect(
      pointLineDistance({ x: large.cx, y: large.cy }, line),
      "line tangent to large circle",
    ).toBeCloseTo(30, 6);
    expect(Math.hypot(line.x2 - line.x1, line.y2 - line.y1)).toBeCloseTo(
      100,
      6,
    );
    expect(Math.hypot(line.x1, line.y1)).toBeCloseTo(25, 6);
    expect(
      result.diagnostics.some(
        (d) => d.code === SKETCH_DIAGNOSTIC_CODES.underConstrained,
      ),
    ).toBe(true);
  });

  it("solves an arc chain join exactly", () => {
    const sketch = arcChainSketch();
    const result = solver.solve(sketch.entities, sketch.constraints);
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    expect(result.dof).toBe(1);
    const arc = solvedCircle(result, "skent_arc-arc");
    const line = solvedLine(result, "skent_arc-line");
    expect(line.x1).toBeCloseTo(0, 6);
    expect(line.y1).toBeCloseTo(0, 6);
    expect(line.x2).toBeCloseTo(25, 6);
    expect(line.y2).toBeCloseTo(0, 6);
    expect(arc.radius).toBeCloseTo(10, 6);
    expect(Math.hypot(arc.cx, arc.cy)).toBeCloseTo(30, 6);
    // The arc's start sits exactly on the line's end, above the x axis
    // (the drawn branch), so the center is at (28.5, 10·√0.8775).
    expect(arc.cx).toBeCloseTo(28.5, 5);
    expect(arc.cy).toBeCloseTo(9.36749, 4);
    const arcSolved = solvedOf(result).get("skent_arc-arc");
    expect(arcSolved?.kind === "arc" && arcSolved.startAngle).toBeCloseTo(
      4.35484,
      4,
    );
    const startPoint =
      arcSolved?.kind === "arc"
        ? {
            x: arcSolved.cx + arcSolved.radius * Math.cos(arcSolved.startAngle),
            y: arcSolved.cy + arcSolved.radius * Math.sin(arcSolved.startAngle),
          }
        : undefined;
    expect(startPoint?.x).toBeCloseTo(25, 6);
    expect(startPoint?.y).toBeCloseTo(0, 6);
  });

  it("solves a symmetric pattern to exact mirrors with zero DoF", () => {
    const sketch = symmetricPatternSketch();
    const result = solver.solve(sketch.entities, sketch.constraints);
    expect(result.status).toBe("solved");
    if (result.status === "failed") return;
    expect(result.dof).toBe(0);
    const left = solvedCircle(result, "skent_sym-left");
    const right = solvedCircle(result, "skent_sym-right");
    expect(left.cx).toBeCloseTo(-25, 6);
    expect(left.cy).toBeCloseTo(50, 6);
    expect(right.cx).toBeCloseTo(25, 6);
    expect(right.cy).toBeCloseTo(50, 6);
    expect(left.radius).toBeCloseTo(10, 6);
    expect(right.radius).toBeCloseTo(10, 6);
  });

  it("diagnoses a conflicting dimension pair structurally", () => {
    const sketch = conflictingDimensionsSketch();
    const result = solver.solve(sketch.entities, sketch.constraints);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.constraintsConflicting,
    );
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.location?.primary).toBe("skcon_conflict-a");
    expect(diagnostic?.location?.related).toEqual(["skcon_conflict-b"]);
    expect(diagnostic?.data?.conflictingCount).toBe(2);
  });

  it("diagnoses distributed infeasibility as unsatisfiable, distinct from conflicting", () => {
    const sketch = unsatisfiableChainSketch();
    const result = solver.solve(sketch.entities, sketch.constraints);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.constraintsUnsatisfiable,
    );
  });

  it("diagnoses redundant-but-consistent systems without failing them", () => {
    const sketch = redundantConstraintSketch();
    const result = solver.solve(sketch.entities, sketch.constraints);
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    expect(result.dof).toBe(6);
    const redundant = result.diagnostics.find(
      (d) => d.code === SKETCH_DIAGNOSTIC_CODES.constraintsRedundant,
    );
    expect(redundant?.severity).toBe("warning");
    expect(redundant?.location?.primary).toBe("skcon_red-parallel");
    expect(redundant?.data?.redundantEquations).toBe(1);
  });
});

describe("reference solver — per-constraint battery", () => {
  it("coincident merges two points onto one position", () => {
    const a = createPointEntity(eid("skent_a"), { x: 2, y: 0 });
    const b = createPointEntity(eid("skent_b"), { x: 10, y: 4 });
    const constraints = [
      createCoincidentConstraint(
        cid("coincident"),
        pointTarget(eid("skent_a"), "center"),
        pointTarget(eid("skent_b"), "center"),
      ),
    ];
    const result = solver.solve([a, b], constraints);
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    expect(result.dof).toBe(2);
    const pa = solvedPoint(result, "skent_a");
    const pb = solvedPoint(result, "skent_b");
    expect(pa.x).toBeCloseTo(pb.x, 6);
    expect(pa.y).toBeCloseTo(pb.y, 6);
  });

  it("horizontal and vertical level the respective axis", () => {
    const hLine = createLineEntity(
      eid("skent_h"),
      { x: 0, y: 0 },
      { x: 10, y: 4 },
    );
    const hResult = solver.solve(
      [hLine],
      [createHorizontalConstraint(cid("h"), eid("skent_h"))],
    );
    expect(hResult.status).toBe("under-constrained");
    if (hResult.status !== "failed") {
      expect(hResult.dof).toBe(3);
      const solved = solvedLine(hResult, "skent_h");
      expect(solved.y1).toBeCloseTo(solved.y2, 9);
      expect(solved.x1).toBeCloseTo(0, 9);
      expect(solved.x2).toBeCloseTo(10, 9);
    }
    const vLine = createLineEntity(
      eid("skent_v"),
      { x: 0, y: 0 },
      { x: 4, y: 10 },
    );
    const vResult = solver.solve(
      [vLine],
      [createVerticalConstraint(cid("v"), eid("skent_v"))],
    );
    expect(vResult.status).toBe("under-constrained");
    if (vResult.status !== "failed") {
      const solved = solvedLine(vResult, "skent_v");
      expect(solved.x1).toBeCloseTo(solved.x2, 9);
      expect(solved.y1).toBeCloseTo(0, 9);
      expect(solved.y2).toBeCloseTo(10, 9);
    }
  });

  it("parallel and perpendicular align line directions", () => {
    const a = createLineEntity(eid("skent_a"), { x: 0, y: 0 }, { x: 10, y: 1 });
    const b = createLineEntity(eid("skent_b"), { x: 0, y: 5 }, { x: 9, y: 8 });
    const parallel = solver.solve(
      [a, b],
      [createParallelConstraint(cid("par"), eid("skent_a"), eid("skent_b"))],
    );
    expect(parallel.status).toBe("under-constrained");
    if (parallel.status !== "failed") {
      expect(parallel.dof).toBe(7);
      const sa = solvedLine(parallel, "skent_a");
      const sb = solvedLine(parallel, "skent_b");
      const cross =
        (sa.x2 - sa.x1) * (sb.y2 - sb.y1) - (sa.y2 - sa.y1) * (sb.x2 - sb.x1);
      expect(cross).toBeCloseTo(0, 6);
    }
    const c = createLineEntity(eid("skent_c"), { x: 0, y: 0 }, { x: 10, y: 0 });
    const d = createLineEntity(eid("skent_d"), { x: 1, y: 1 }, { x: 4, y: 3 });
    const perpendicular = solver.solve(
      [c, d],
      [
        createPerpendicularConstraint(
          cid("perp"),
          eid("skent_c"),
          eid("skent_d"),
        ),
      ],
    );
    expect(perpendicular.status).toBe("under-constrained");
    if (perpendicular.status !== "failed") {
      const sc = solvedLine(perpendicular, "skent_c");
      const sd = solvedLine(perpendicular, "skent_d");
      const dot =
        (sc.x2 - sc.x1) * (sd.x2 - sd.x1) + (sc.y2 - sc.y1) * (sd.y2 - sd.y1);
      expect(dot).toBeCloseTo(0, 6);
    }
  });

  it("distance enforces the exact separation between two point targets", () => {
    const a = createPointEntity(eid("skent_a"), { x: 0, y: 0 });
    const b = createPointEntity(eid("skent_b"), { x: 30, y: 4 });
    const result = solver.solve(
      [a, b],
      [
        createDistanceConstraint(
          cid("dist"),
          pointTarget(eid("skent_a"), "center"),
          pointTarget(eid("skent_b"), "center"),
          length(50),
        ),
      ],
    );
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    expect(result.dof).toBe(3);
    const pa = solvedPoint(result, "skent_a");
    const pb = solvedPoint(result, "skent_b");
    expect(Math.hypot(pb.x - pa.x, pb.y - pa.y)).toBeCloseTo(50, 6);
  });

  it("angle enforces the exact angle between two lines", () => {
    const a = createLineEntity(eid("skent_a"), { x: 0, y: 0 }, { x: 10, y: 0 });
    const b = createLineEntity(
      eid("skent_b"),
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    );
    const result = solver.solve(
      [a, b],
      [
        createAngleConstraint(
          cid("ang"),
          eid("skent_a"),
          eid("skent_b"),
          angle(30, "deg"),
        ),
      ],
    );
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    expect(result.dof).toBe(7);
    const sa = solvedLine(result, "skent_a");
    const sb = solvedLine(result, "skent_b");
    const dot =
      (sa.x2 - sa.x1) * (sb.x2 - sb.x1) + (sa.y2 - sa.y1) * (sb.y2 - sb.y1);
    const cross =
      (sa.x2 - sa.x1) * (sb.y2 - sb.y1) - (sa.y2 - sa.y1) * (sb.x2 - sb.x1);
    expect(Math.atan2(Math.abs(cross), dot)).toBeCloseTo(
      (30 * Math.PI) / 180,
      6,
    );
  });

  it("angle solves to the requested angle even when drawn at the supplementary branch, never converging to the supplement", () => {
    // Drawn at ~170° between the directions — nearest zero of the OLD
    // sine-form residual was the supplement (150° for a requested 30°);
    // the cosine form's only zero on the unsigned domain is 30° itself.
    const a = createLineEntity(eid("skent_a"), { x: 0, y: 0 }, { x: 10, y: 0 });
    const b = createLineEntity(
      eid("skent_b"),
      { x: 0, y: 0 },
      { x: -9.85, y: 1.74 },
    );
    const result = solver.solve(
      [a, b],
      [
        createAngleConstraint(
          cid("ang"),
          eid("skent_a"),
          eid("skent_b"),
          angle(30, "deg"),
        ),
      ],
    );
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    const sa = solvedLine(result, "skent_a");
    const sb = solvedLine(result, "skent_b");
    const dot =
      (sa.x2 - sa.x1) * (sb.x2 - sb.x1) + (sa.y2 - sa.y1) * (sb.y2 - sb.y1);
    const cross =
      (sa.x2 - sa.x1) * (sb.y2 - sb.y1) - (sa.y2 - sa.y1) * (sb.x2 - sb.x1);
    const measuredDegrees = (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
    expect(measuredDegrees).toBeCloseTo(30, 6);
  });

  it("radius and diameter size circles exactly", () => {
    const circle = createCircleEntity(eid("skent_c"), { x: 0, y: 0 }, 7);
    const radius = solver.solve(
      [circle],
      [createRadiusConstraint(cid("r"), eid("skent_c"), length(25))],
    );
    expect(radius.status).toBe("under-constrained");
    if (radius.status !== "failed") {
      expect(radius.dof).toBe(2);
      expect(solvedCircle(radius, "skent_c").radius).toBeCloseTo(25, 6);
    }
    const circle2 = createCircleEntity(eid("skent_c2"), { x: 0, y: 0 }, 7);
    const diameter = solver.solve(
      [circle2],
      [createDiameterConstraint(cid("d"), eid("skent_c2"), length(20))],
    );
    expect(diameter.status).toBe("under-constrained");
    if (diameter.status !== "failed") {
      expect(solvedCircle(diameter, "skent_c2").radius).toBeCloseTo(10, 6);
    }
  });

  it("equal matches line lengths and circle radii", () => {
    const a = createLineEntity(eid("skent_a"), { x: 0, y: 0 }, { x: 10, y: 0 });
    const b = createLineEntity(eid("skent_b"), { x: 0, y: 5 }, { x: 20, y: 5 });
    const lines = solver.solve(
      [a, b],
      [createEqualConstraint(cid("eq"), eid("skent_a"), eid("skent_b"))],
    );
    expect(lines.status).toBe("under-constrained");
    if (lines.status !== "failed") {
      const sa = solvedLine(lines, "skent_a");
      const sb = solvedLine(lines, "skent_b");
      expect(Math.hypot(sa.x2 - sa.x1, sa.y2 - sa.y1)).toBeCloseTo(
        Math.hypot(sb.x2 - sb.x1, sb.y2 - sb.y1),
        6,
      );
    }
    const c1 = createCircleEntity(eid("skent_c1"), { x: 0, y: 0 }, 5);
    const c2 = createCircleEntity(eid("skent_c2"), { x: 30, y: 0 }, 9);
    const circles = solver.solve(
      [c1, c2],
      [createEqualConstraint(cid("eqc"), eid("skent_c1"), eid("skent_c2"))],
    );
    expect(circles.status).toBe("under-constrained");
    if (circles.status !== "failed") {
      expect(solvedCircle(circles, "skent_c1").radius).toBeCloseTo(
        solvedCircle(circles, "skent_c2").radius,
        6,
      );
    }
  });

  it("tangent enforces line-to-circle and circle-to-circle tangency", () => {
    const line = createLineEntity(
      eid("skent_l"),
      { x: 0, y: 0 },
      { x: 10, y: 4 },
    );
    const circle = createCircleEntity(eid("skent_c"), { x: 5, y: 10 }, 5);
    const lineCase = solver.solve(
      [line, circle],
      [createTangentConstraint(cid("t"), eid("skent_l"), eid("skent_c"))],
    );
    expect(lineCase.status).toBe("under-constrained");
    if (lineCase.status !== "failed") {
      const solvedCenter = solvedCircle(lineCase, "skent_c");
      expect(
        pointLineDistance(
          { x: solvedCenter.cx, y: solvedCenter.cy },
          solvedLine(lineCase, "skent_l"),
        ),
      ).toBeCloseTo(solvedCenter.radius, 6);
    }
    const c1 = createCircleEntity(eid("skent_c1"), { x: 0, y: 0 }, 5);
    const c2 = createCircleEntity(eid("skent_c2"), { x: 20, y: 0 }, 7);
    const external = solver.solve(
      [c1, c2],
      [
        createTangentConstraint(
          cid("tx"),
          eid("skent_c1"),
          eid("skent_c2"),
          "external",
        ),
      ],
    );
    expect(external.status).toBe("under-constrained");
    if (external.status !== "failed") {
      const s1 = solvedCircle(external, "skent_c1");
      const s2 = solvedCircle(external, "skent_c2");
      expect(Math.hypot(s2.cx - s1.cx, s2.cy - s1.cy)).toBeCloseTo(12, 6);
    }
    const c3 = createCircleEntity(eid("skent_c3"), { x: 0, y: 0 }, 5);
    const c4 = createCircleEntity(eid("skent_c4"), { x: 20, y: 0 }, 7);
    const internal = solver.solve(
      [c3, c4],
      [
        createTangentConstraint(
          cid("tn"),
          eid("skent_c3"),
          eid("skent_c4"),
          "internal",
        ),
      ],
    );
    expect(internal.status).toBe("under-constrained");
    if (internal.status !== "failed") {
      const s3 = solvedCircle(internal, "skent_c3");
      const s4 = solvedCircle(internal, "skent_c4");
      expect(Math.hypot(s4.cx - s3.cx, s4.cy - s3.cy)).toBeCloseTo(2, 6);
    }
  });

  it("midpoint places the point at the line's midpoint", () => {
    const point = createPointEntity(eid("skent_p"), { x: 2, y: 3 });
    const line = createLineEntity(
      eid("skent_l"),
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    );
    const result = solver.solve(
      [point, line],
      [
        createMidpointConstraint(
          cid("mid"),
          pointTarget(eid("skent_p"), "center"),
          eid("skent_l"),
        ),
      ],
    );
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    expect(result.dof).toBe(4);
    expect(solvedPoint(result, "skent_p").x).toBeCloseTo(5, 6);
    expect(solvedPoint(result, "skent_p").y).toBeCloseTo(0, 6);
  });

  it("symmetry mirrors point pairs about a point and about a line", () => {
    const a = createPointEntity(eid("skent_a"), { x: 0, y: 0 });
    const b = createPointEntity(eid("skent_b"), { x: 10, y: 0 });
    const c = createPointEntity(eid("skent_c"), { x: 4, y: 0 });
    const aboutPoint = solver.solve(
      [a, b, c],
      [
        createSymmetryAboutPointConstraint(
          cid("sym-p"),
          pointTarget(eid("skent_a"), "center"),
          pointTarget(eid("skent_b"), "center"),
          pointTarget(eid("skent_c"), "center"),
        ),
      ],
    );
    expect(aboutPoint.status).toBe("under-constrained");
    if (aboutPoint.status !== "failed") {
      const pa = solvedPoint(aboutPoint, "skent_a");
      const pb = solvedPoint(aboutPoint, "skent_b");
      const pc = solvedPoint(aboutPoint, "skent_c");
      expect((pa.x + pb.x) / 2).toBeCloseTo(pc.x, 6);
      expect((pa.y + pb.y) / 2).toBeCloseTo(pc.y, 6);
    }
    const d = createPointEntity(eid("skent_d"), { x: -3, y: 4 });
    const e = createPointEntity(eid("skent_e"), { x: 5, y: 2 });
    const axis = createLineEntity(
      eid("skent_axis"),
      { x: 0, y: -10 },
      { x: 0, y: 10 },
      { fixed: true },
    );
    const aboutLine = solver.solve(
      [d, e, axis],
      [
        createSymmetryAboutLineConstraint(
          cid("sym-l"),
          pointTarget(eid("skent_d"), "center"),
          pointTarget(eid("skent_e"), "center"),
          eid("skent_axis"),
        ),
      ],
    );
    expect(aboutLine.status).toBe("under-constrained");
    if (aboutLine.status !== "failed") {
      const pd = solvedPoint(aboutLine, "skent_d");
      const pe = solvedPoint(aboutLine, "skent_e");
      expect((pd.x + pe.x) / 2).toBeCloseTo(0, 6);
      expect(pd.y).toBeCloseTo(pe.y, 6);
    }
  });
});

describe("reference solver — semantics and diagnostics", () => {
  it("reports malformed references instead of throwing", () => {
    const line = createLineEntity(
      eid("skent_l"),
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    );
    const missing = createCoincidentConstraint(
      cid("ghost"),
      pointTarget(eid("skent_l"), "start"),
      pointTarget(eid("skent_missing"), "center"),
    );
    const missingResult = solver.solve([line], [missing]);
    expect(missingResult.status).toBe("failed");
    if (missingResult.status !== "failed") return;
    expect(missingResult.diagnostics[0]?.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.constraintReferenceMalformed,
    );
    const circle = createCircleEntity(eid("skent_c"), { x: 0, y: 0 }, 5);
    const wrongKind = createHorizontalConstraint(cid("h"), eid("skent_c"));
    const wrongResult = solver.solve([circle], [wrongKind]);
    expect(wrongResult.status).toBe("failed");
    if (wrongResult.status !== "failed") return;
    expect(wrongResult.diagnostics[0]?.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.constraintReferenceMalformed,
    );
  });

  it("collects every malformed constraint, not just the first", () => {
    const line = createLineEntity(
      eid("skent_l"),
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    );
    const constraints = [
      createHorizontalConstraint(cid("h1"), eid("skent_ghost-1")),
      createHorizontalConstraint(cid("h2"), eid("skent_ghost-2")),
    ];
    const result = solver.solve([line], constraints);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.diagnostics).toHaveLength(2);
  });

  it("treats a constraint contradicting a fixed entity as conflicting", () => {
    const line = createLineEntity(
      eid("skent_l"),
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      {
        fixed: true,
      },
    );
    const result = solver.solve(
      [line],
      [
        createDistanceConstraint(
          cid("d"),
          pointTarget(eid("skent_l"), "start"),
          pointTarget(eid("skent_l"), "end"),
          length(60),
        ),
      ],
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.diagnostics[0]?.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.constraintsConflicting,
    );
  });

  it("solves an empty system as fully constrained", () => {
    const result = solver.solve([], []);
    expect(result.status).toBe("solved");
    if (result.status === "failed") return;
    expect(result.dof).toBe(0);
    expect(result.parameters.entities).toEqual([]);
  });

  it("leaves unconstrained geometry exactly where it was drawn", () => {
    const point = createPointEntity(eid("skent_p"), { x: 12.5, y: -3.25 });
    const result = solver.solve([point], []);
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    expect(result.dof).toBe(2);
    expect(solvedPoint(result, "skent_p").x).toBe(12.5);
    expect(solvedPoint(result, "skent_p").y).toBe(-3.25);
  });

  it("counts a bare rectangle's implicit integrity rule as exactly five DoF", () => {
    const [edge0, edge1, edge2, edge3] = [
      createLineEntity(eid("skent_e0"), { x: 0, y: 0 }, { x: 57, y: 2 }),
      createLineEntity(eid("skent_e1"), { x: 57, y: 2 }, { x: 55, y: 41 }),
      createLineEntity(eid("skent_e2"), { x: 55, y: 41 }, { x: -2, y: 39 }),
      createLineEntity(eid("skent_e3"), { x: -2, y: 39 }, { x: 0, y: 0 }),
    ];
    if (
      edge0 === undefined ||
      edge1 === undefined ||
      edge2 === undefined ||
      edge3 === undefined
    ) {
      throw new Error("Rectangle edge fixtures failed to build.");
    }
    const rectangle = createRectangleEntity(eid("skent_rect"), [
      edge0.id,
      edge1.id,
      edge2.id,
      edge3.id,
    ]);
    const entities: SketchEntity[] = [edge0, edge1, edge2, edge3, rectangle];
    const result = solver.solve(entities, []);
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    expect(result.dof).toBe(5);
    const solved0 = solvedLine(result, "skent_e0");
    const solved1 = solvedLine(result, "skent_e1");
    expect(solved0.x2).toBeCloseTo(solved1.x1, 6);
    expect(solved0.y2).toBeCloseTo(solved1.y1, 6);
    expect(result.parameters.entities[4]).toEqual({
      id: "skent_rect",
      kind: "rectangle",
    });
  });

  it("solves construction geometry identically to real geometry", () => {
    const line = createLineEntity(
      eid("skent_l"),
      { x: 0, y: 0 },
      { x: 10, y: 4 },
      {
        construction: true,
      },
    );
    const result = solver.solve(
      [line],
      [createHorizontalConstraint(cid("h"), eid("skent_l"))],
    );
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    expect(solvedLine(result, "skent_l").y1).toBeCloseTo(
      solvedLine(result, "skent_l").y2,
      9,
    );
  });

  it("is deterministic across calls and instances, bitwise", () => {
    const sketch = fullyConstrainedTriangleSketch();
    const first = solver.solve(sketch.entities, sketch.constraints);
    const second = solver.solve(sketch.entities, sketch.constraints);
    const third = createReferenceSketchSolver().solve(
      sketch.entities,
      sketch.constraints,
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).toBe(JSON.stringify(third));
    const failedSketch = conflictingDimensionsSketch();
    const failedFirst = solver.solve(
      failedSketch.entities,
      failedSketch.constraints,
    );
    const failedSecond = solver.solve(
      failedSketch.entities,
      failedSketch.constraints,
    );
    expect(JSON.stringify(failedFirst)).toBe(JSON.stringify(failedSecond));
  });

  it("returns only solver-neutral data: results survive JSON round-trips", () => {
    for (const sketch of [
      fullyConstrainedTriangleSketch(),
      dimensionedRectangleSketch(),
      tangentChainSketch(),
      arcChainSketch(),
      symmetricPatternSketch(),
      conflictingDimensionsSketch(),
      unsatisfiableChainSketch(),
      redundantConstraintSketch(),
    ]) {
      const result = solver.solve(sketch.entities, sketch.constraints);
      const revived: unknown = JSON.parse(JSON.stringify(result));
      expect(revived).toEqual(result);
    }
  });
});

describe("reference solver — degenerate arc solves are rejected, not applied", () => {
  it("fails a solve whose arc collapses to a zero sweep (coincident arc endpoints), instead of reporting success", () => {
    // The system is consistent (both endpoints pin to one angle), so the
    // iteration converges — but the only convergent arcs are degenerate:
    // start ≡ end (mod 2π). The physicality guard must convert that into a
    // structured failure, never a success-family status carrying an arc
    // that would fail parseSketch once applied.
    const arc = createArcEntity(eid("skent_arc"), { x: 0, y: 0 }, 5, 0.5, 2.6);
    const result = solver.solve(
      [arc],
      [
        createCoincidentConstraint(
          cid("collapse"),
          pointTarget(eid("skent_arc"), "start"),
          pointTarget(eid("skent_arc"), "end"),
        ),
      ],
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.diagnostics[0]?.severity).toBe("error");
    expect(result.diagnostics[0]?.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.solverNotConverged,
    );
  });

  it("fails a solve whose tiny negative raw sweep would wrap into a near-full circle", () => {
    // Both arc endpoints coincident to one fixed point on the circle: the
    // solved angles straddle the pinned angle with a tiny negative raw
    // remainder (end − start ≈ −1e-12), which independent canonicalization
    // used to wrap into a 2π − ε sweep — a small drawn arc silently turned
    // into a near-full circle that round-trips cleanly.
    const pinAngle = 0.54;
    const pin = createPointEntity(
      eid("skent_pin"),
      { x: 5 * Math.cos(pinAngle), y: 5 * Math.sin(pinAngle) },
      { fixed: true },
    );
    const arc = createArcEntity(eid("skent_arc"), { x: 0, y: 0 }, 5, 0.5, 0.58);
    const result = solver.solve(
      [arc, pin],
      [
        createCoincidentConstraint(
          cid("pin-start"),
          pointTarget(eid("skent_arc"), "start"),
          pointTarget(eid("skent_pin"), "center"),
        ),
        createCoincidentConstraint(
          cid("pin-end"),
          pointTarget(eid("skent_arc"), "end"),
          pointTarget(eid("skent_pin"), "center"),
        ),
      ],
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.diagnostics[0]?.severity).toBe("error");
    expect(result.diagnostics[0]?.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.solverNotConverged,
    );
  });
});

describe("reference solver — integration with the sketch aggregate", () => {
  it("applies solved parameters to a sketch that round-trips through serialization", () => {
    const sketch = dimensionedRectangleSketch();
    const result = solver.solve(sketch.entities, sketch.constraints);
    expect(result.status).toBe("solved");
    if (result.status === "failed") return;
    const applied = applySolvedParameters(sketch, result.parameters);
    const serialized = serializeSketch(applied);
    expect(serialized.formatVersion).toBe(2);
    const revived: unknown = JSON.parse(JSON.stringify(serialized));
    expect(revived).toEqual(serialized);
  });

  it("exposes a stable solver id", () => {
    expect(solver.id).toBe("reference-gauss-newton");
  });
});

describe("reference solver — phase 36 entity and constraint battery", () => {
  it("accounts the new entities' degrees of freedom bare", () => {
    const solverCases: readonly {
      readonly name: string;
      readonly entity: SketchEntity;
      readonly dof: number;
    }[] = [
      {
        name: "ellipse",
        dof: 5,
        entity: createEllipseEntityFromIndex(),
      },
      {
        name: "ellipticalArc",
        dof: 7,
        entity: createEllipticalArcEntityFromIndex(),
      },
      {
        name: "spline-control",
        dof: 8,
        entity: createSplineEntityFromIndex(),
      },
      {
        name: "polygon",
        dof: 4,
        entity: createPolygonEntityFromIndex(),
      },
      {
        name: "slot-straight",
        dof: 5,
        entity: createStraightSlotEntityFromIndex(),
      },
    ];
    for (const { name, entity, dof } of solverCases) {
      const result = solver.solve([entity], []);
      expect(result.status, name).toBe("under-constrained");
      if (result.status === "failed") continue;
      expect(result.dof, name).toBe(dof);
    }
  });

  it("fully constrains an ellipse through center pin, axis distances, and pair alignment", () => {
    const anchor = createPointEntity(
      eid("skent_anchor"),
      { x: 0, y: 0 },
      {
        construction: true,
        fixed: true,
      },
    );
    const ellipse = createEllipseEntityFromIndex();
    const result = solver.solve(
      [anchor, ellipse],
      [
        createCoincidentConstraint(
          cid("ellipse-center"),
          pointTarget(eid("skent_ellipse"), "center"),
          pointTarget(eid("skent_anchor"), "center"),
        ),
        createDistanceConstraint(
          cid("ellipse-major"),
          pointTarget(eid("skent_ellipse"), "center"),
          pointTarget(eid("skent_ellipse"), "start"),
          length(8),
        ),
        createDistanceConstraint(
          cid("ellipse-minor"),
          pointTarget(eid("skent_ellipse"), "center"),
          pointTarget(eid("skent_ellipse"), "end"),
          length(5),
        ),
        createHorizontalPairConstraint(
          cid("ellipse-align"),
          pointTarget(eid("skent_ellipse"), "center"),
          pointTarget(eid("skent_ellipse"), "start"),
        ),
      ],
    );
    expect(result.status).toBe("solved");
    if (result.status === "failed") return;
    const solved = solvedOf(result);
    const ellipseSolved = solved.get("skent_ellipse");
    expect(ellipseSolved?.kind).toBe("ellipse");
    if (ellipseSolved?.kind !== "ellipse") return;
    expect(ellipseSolved.cx).toBeCloseTo(0, 9);
    expect(ellipseSolved.cy).toBeCloseTo(0, 9);
    expect(ellipseSolved.radiusX).toBeCloseTo(8, 9);
    expect(ellipseSolved.radiusY).toBeCloseTo(5, 9);
    // The major-axis end sits on +x: horizontalPair pinned the alignment
    // (the equivalent 2π branch canonicalizes to the same geometry).
    expect(
      Math.min(ellipseSolved.rotation, 2 * Math.PI - ellipseSolved.rotation),
    ).toBeCloseTo(0, 9);
  });

  it("fully constrains a polygon through center pin, radius, and vertex alignment", () => {
    const anchor = createPointEntity(
      eid("skent_anchor"),
      { x: 1, y: 2 },
      {
        construction: true,
        fixed: true,
      },
    );
    const polygon = createPolygonEntityFromIndex();
    const result = solver.solve(
      [anchor, polygon],
      [
        createCoincidentConstraint(
          cid("hex-center"),
          pointTarget(eid("skent_polygon"), "center"),
          pointTarget(eid("skent_anchor"), "center"),
        ),
        createRadiusConstraint(
          cid("hex-radius"),
          eid("skent_polygon"),
          length(6),
        ),
        createHorizontalPairConstraint(
          cid("hex-align"),
          pointTarget(eid("skent_polygon"), "center"),
          pointTarget(eid("skent_polygon"), "start"),
        ),
      ],
    );
    expect(result.status).toBe("solved");
    if (result.status === "failed") return;
    const solved = solvedOf(result);
    const hex = solved.get("skent_polygon");
    expect(hex?.kind).toBe("polygon");
    if (hex?.kind !== "polygon") return;
    expect(hex.cx).toBeCloseTo(1, 9);
    expect(hex.cy).toBeCloseTo(2, 9);
    expect(hex.radius).toBeCloseTo(6, 9);
    expect(Math.min(hex.rotation, 2 * Math.PI - hex.rotation)).toBeCloseTo(
      0,
      9,
    );
  });

  it("fully constrains a straight slot through cap pins and its radius", () => {
    const a = createPointEntity(
      eid("skent_a"),
      { x: -6, y: 0 },
      {
        construction: true,
        fixed: true,
      },
    );
    const b = createPointEntity(
      eid("skent_b"),
      { x: 6, y: 0 },
      {
        construction: true,
        fixed: true,
      },
    );
    const slot = createStraightSlotEntityFromIndex();
    const result = solver.solve(
      [a, b, slot],
      [
        createCoincidentConstraint(
          cid("slot-start"),
          pointTarget(eid("skent_slot"), "start"),
          pointTarget(eid("skent_a"), "center"),
        ),
        createCoincidentConstraint(
          cid("slot-end"),
          pointTarget(eid("skent_slot"), "end"),
          pointTarget(eid("skent_b"), "center"),
        ),
        createRadiusConstraint(
          cid("slot-radius"),
          eid("skent_slot"),
          length(2.5),
        ),
      ],
    );
    expect(result.status).toBe("solved");
    if (result.status === "failed") return;
    const solved = solvedOf(result);
    const slotSolved = solved.get("skent_slot");
    if (slotSolved?.kind !== "slot") {
      throw new Error("solved slot record is missing");
    }
    expect(slotSolved.radius).toBeCloseTo(2.5, 9);
    expect(slotSolved.x1).toBeCloseTo(-6, 9);
    expect(slotSolved.y1).toBeCloseTo(0, 9);
    expect(slotSolved.x2).toBeCloseTo(6, 9);
  });

  it("pins spline endpoints and leaves the interior freedoms", () => {
    const a = createPointEntity(
      eid("skent_a"),
      { x: 0, y: 0 },
      {
        construction: true,
        fixed: true,
      },
    );
    const b = createPointEntity(
      eid("skent_b"),
      { x: 10, y: 0 },
      {
        construction: true,
        fixed: true,
      },
    );
    const spline = createSplineEntityFromIndex();
    const result = solver.solve(
      [a, b, spline],
      [
        createCoincidentConstraint(
          cid("spline-start"),
          pointTarget(eid("skent_spline"), "start"),
          pointTarget(eid("skent_a"), "center"),
        ),
        createCoincidentConstraint(
          cid("spline-end"),
          pointTarget(eid("skent_spline"), "end"),
          pointTarget(eid("skent_b"), "center"),
        ),
      ],
    );
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    // 8 unknowns − 4 endpoint rows = 4 interior freedoms.
    expect(result.dof).toBe(4);
    const solved = solvedOf(result);
    const solvedSpline = solved.get("skent_spline");
    if (solvedSpline?.kind !== "spline") {
      throw new Error("solved spline record is missing");
    }
    expect(solvedSpline.points[0]).toEqual({ x: 0, y: 0 });
    expect(solvedSpline.points[3]).toEqual({ x: 10, y: 0 });
  });

  it("pulls a point onto a fixed circle, ellipse, and spline exactly", () => {
    // The curves are pinned (the CAD fix convention): |P − C| = r has a
    // one-parameter family otherwise, and the least-squares step would
    // legitimately split the correction between the point and the curve.
    const circle = createCircleEntity(eid("skent_circle"), { x: 0, y: 0 }, 5, {
      fixed: true,
    });
    const ellipse = createEllipseEntityFromIndex({ fixed: true });
    const spline = createSplineEntityFromIndex({ fixed: true });
    const onCircle = createPointEntity(eid("skent_p1"), { x: 3, y: 3.5 });
    const onEllipse = createPointEntity(eid("skent_p2"), { x: 7.7, y: 1.2 });
    const onSpline = createPointEntity(eid("skent_p3"), { x: 5.1, y: 0.6 });
    const circleResult = solver.solve(
      [circle, onCircle],
      [
        createPointOnEntityConstraint(
          cid("poe-circle"),
          pointTarget(eid("skent_p1"), "center"),
          eid("skent_circle"),
        ),
      ],
    );
    expect(circleResult.status).toBe("under-constrained");
    if (circleResult.status !== "failed") {
      const point = solvedOf(circleResult).get("skent_p1");
      if (point?.kind === "point") {
        expect(Math.hypot(point.x, point.y)).toBeCloseTo(5, 9);
      }
    }
    const ellipseResult = solver.solve(
      [ellipse, onEllipse],
      [
        createPointOnEntityConstraint(
          cid("poe-ellipse"),
          pointTarget(eid("skent_p2"), "center"),
          eid("skent_ellipse"),
        ),
      ],
    );
    expect(ellipseResult.status).toBe("under-constrained");
    if (ellipseResult.status !== "failed") {
      const point = solvedOf(ellipseResult).get("skent_p2");
      const ell = solvedOf(ellipseResult).get("skent_ellipse");
      if (point?.kind === "point" && ell?.kind === "ellipse") {
        // The implicit form in the ellipse's own (rotated) frame.
        const wx = point.x - ell.cx;
        const wy = point.y - ell.cy;
        const c = Math.cos(ell.rotation);
        const sn = Math.sin(ell.rotation);
        const ex = c * wx + sn * wy;
        const ey = -sn * wx + c * wy;
        expect(
          (ex * ex) / (ell.radiusX * ell.radiusX) +
            (ey * ey) / (ell.radiusY * ell.radiusY),
        ).toBeCloseTo(1, 7);
      }
    }
    const splineResult = solver.solve(
      [spline, onSpline],
      [
        createPointOnEntityConstraint(
          cid("poe-spline"),
          pointTarget(eid("skent_p3"), "center"),
          eid("skent_spline"),
        ),
      ],
    );
    expect(splineResult.status).toBe("under-constrained");
    if (splineResult.status !== "failed") {
      const point = solvedOf(splineResult).get("skent_p3");
      const solvedSpline = solvedOf(splineResult).get("skent_spline");
      if (point?.kind === "point" && solvedSpline?.kind === "spline") {
        // The solved record carries the spline's points; the flavor lives
        // on the authored entity (the same pairing applySolvedParameters
        // performs).
        const projection = projectOntoSpline(
          { flavor: "control", points: solvedSpline.points },
          { x: point.x, y: point.y },
        );
        expect(projection?.distance).toBeLessThanOrEqual(
          SPLINE_TESSELLATION_DEFLECTION_MM,
        );
      }
    }
  });

  it("collinear puts one line onto another's infinite line", () => {
    const first = createLineEntity(
      eid("skent_first"),
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    );
    const second = createLineEntity(
      eid("skent_second"),
      { x: 1, y: 2.5 },
      { x: 9, y: 1.5 },
    );
    const result = solver.solve(
      [first, second],
      [
        createCollinearConstraint(
          cid("col"),
          eid("skent_first"),
          eid("skent_second"),
        ),
      ],
    );
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    // Two lines (8 unknowns) − collinear's 2 rows − the lines' own shape
    // freedoms: rank gain is exactly 2 → 6 DoF remain.
    expect(result.dof).toBe(6);
    const solved = solvedOf(result);
    const secondSolved = solved.get("skent_second");
    if (secondSolved?.kind !== "line") {
      throw new Error("solved line record is missing");
    }
    expect(secondSolved.y1).toBeCloseTo(0, 9);
    expect(secondSolved.y2).toBeCloseTo(0, 9);
  });

  it("distanceX and distanceY carry signed separations", () => {
    const first = createLineEntity(
      eid("skent_first"),
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    );
    const second = createLineEntity(
      eid("skent_second"),
      { x: 1, y: 6 },
      { x: 5, y: 7 },
    );
    const result = solver.solve(
      [first, second],
      [
        createDistanceXConstraint(
          cid("dx"),
          pointTarget(eid("skent_first"), "start"),
          pointTarget(eid("skent_second"), "start"),
          length(-12),
        ),
        createDistanceYConstraint(
          cid("dy"),
          pointTarget(eid("skent_first"), "start"),
          pointTarget(eid("skent_second"), "start"),
          length(8),
        ),
      ],
    );
    expect(result.status).toBe("under-constrained");
    if (result.status === "failed") return;
    const solved = solvedOf(result);
    const secondSolved = solved.get("skent_second");
    if (secondSolved?.kind !== "line") {
      throw new Error("solved line record is missing");
    }
    // The signed separations hold exactly; the least-squares step splits
    // each correction across both free endpoints (both are unconstrained),
    // so the assertion is on the separations, not absolute positions.
    const firstSolved = solvedOf(result).get("skent_first");
    if (firstSolved?.kind !== "line") {
      throw new Error("solved first line record is missing");
    }
    expect(secondSolved.x1 - firstSolved.x1).toBeCloseTo(-12, 9);
    expect(secondSolved.y1 - firstSolved.y1).toBeCloseTo(8, 9);
  });

  it("declines out-of-scope spline constraint systems structurally", () => {
    const spline = createSplineEntityFromIndex();
    const line = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    );
    // collinear on a spline operand stays outside the solving subset (its
    // meaningful spline reading is the pointOnTangent kind); the
    // direction pairs parallel/perpendicular/angle now solve.
    const result = solver.solve(
      [spline, line],
      [
        createCollinearConstraint(
          cid("col"),
          eid("skent_line"),
          eid("skent_spline"),
        ),
      ],
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.diagnostics[0]?.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.constraintUnsupported,
    );
  });
});

describe("reference solver — phase 37 spline constraint closure", () => {
  /** Narrows a solve to its under-constrained shape (DoF assertions). */
  const underConstrainedOf = (
    result: SketchSolveResult,
  ): Extract<SketchSolveResult, { status: "under-constrained" }> => {
    if (result.status !== "under-constrained") {
      throw new Error(
        `expected under-constrained, got ${result.status}: ${JSON.stringify(result.diagnostics.map((d) => d.message))}`,
      );
    }
    return result;
  };

  /** The spec's arch: control spline (0,0) (1,2) (3,2) (4,0). */
  const archEntity = (id = "skent_spline") =>
    createSplineEntity(eid(id), "control", [
      { x: 0, y: 0 },
      { x: 1, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 0 },
    ]);

  it("anywhere tangent(line, spline) removes exactly one DoF and restores tangency", () => {
    const spline = archEntity();
    // §1.8's fixture pins the line (raised to y = 2) so the whole
    // correction lands on the spline's controls.
    const line = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 2 },
      { x: 4, y: 2 },
      { fixed: true },
    );
    const result = solver.solve(
      [spline, line],
      [
        createTangentConstraint(
          cid("tan"),
          eid("skent_line"),
          eid("skent_spline"),
        ),
      ],
    );
    const solvedResult = underConstrainedOf(result);
    // 8 free spline parameters − 1 row: codimension 1, the line↔circle
    // precedent of §0.5 (the sliding contact is eliminated, not added).
    expect(solvedResult.dof).toBe(7);
    expect(solvedResult.diagnostics).toHaveLength(1);
    // §1.8: the line at y = 2 leaves r = −0.5; Gauss–Newton restores
    // tangency — the solved curve TOUCHES y = 2 at a stationary point of
    // the signed distance (s = 0 with s' = 0: a double root, not a
    // crossing; the contact parameter is wherever the Seidel iteration
    // settles, so the assertion finds it via the derivative roots).
    const solved = solvedOf(solvedResult);
    const splineSolved = solved.get("skent_spline");
    if (splineSolved === undefined || splineSolved.kind !== "spline") {
      throw new Error("missing solved spline");
    }
    const [p0, p1, p2, p3] = splineSolved.points;
    if (
      p0 === undefined ||
      p1 === undefined ||
      p2 === undefined ||
      p3 === undefined
    ) {
      throw new Error("missing solved points");
    }
    const candidates = [
      0,
      1,
      ...cubicStationaryParameters(p0.y - 2, p1.y - 2, p2.y - 2, p3.y - 2),
    ];
    const touches = candidates.some((t) => {
      const u = 1 - t;
      const y =
        u * u * u * p0.y +
        3 * u * u * t * p1.y +
        3 * u * t * t * p2.y +
        t * t * t * p3.y;
      return Math.abs(y - 2) <= 1e-7;
    });
    expect(
      touches,
      `solved controls ${JSON.stringify(splineSolved.points)}`,
    ).toBe(true);
  });

  it("composes endpoint tangency as pointOnEntity + parallel at the end (codimension 2)", () => {
    const spline = archEntity();
    const line = createLineEntity(
      eid("skent_line"),
      { x: 4, y: 0 },
      { x: 8, y: 0 },
    );
    const result = solver.solve(
      [spline, line],
      [
        createPointOnEntityConstraint(
          cid("poe"),
          pointTarget(eid("skent_spline"), "end"),
          eid("skent_line"),
        ),
        createParallelConstraint(
          cid("par"),
          eid("skent_line"),
          eid("skent_spline"),
          "end",
        ),
      ],
    );
    const solvedResult = underConstrainedOf(result);
    // 12 parameters − 2 rows: the pinned form is strictly stronger than
    // the anywhere form's 1 (§0.5's table).
    expect(solvedResult.dof).toBe(10);
  });

  it("joins a kinked continuation to the arch at G1", () => {
    const a = archEntity("skent_a");
    const b = createSplineEntity(eid("skent_b"), "control", [
      { x: 4, y: 0 },
      { x: 5, y: -1 },
      { x: 7, y: -1 },
      { x: 8, y: 0 },
    ]);
    const result = solver.solve(
      [a, b],
      [createTangentConstraint(cid("g1"), eid("skent_a"), eid("skent_b"))],
    );
    const solvedResult = underConstrainedOf(result);
    // 16 parameters − 3 rows (coincidence ×2 + tangent direction).
    expect(solvedResult.dof).toBe(13);
    const solved = solvedOf(solvedResult);
    const aSolved = solved.get("skent_a");
    const bSolved = solved.get("skent_b");
    if (aSolved === undefined || aSolved.kind !== "spline") {
      throw new Error("missing solved A");
    }
    if (bSolved === undefined || bSolved.kind !== "spline") {
      throw new Error("missing solved B");
    }
    const aEnd = aSolved.points[aSolved.points.length - 1];
    const bStart = bSolved.points[0];
    const aP2 = aSolved.points[aSolved.points.length - 2];
    const bP1 = bSolved.points[1];
    if (
      aEnd === undefined ||
      bStart === undefined ||
      aP2 === undefined ||
      bP1 === undefined
    ) {
      throw new Error("missing solved end points");
    }
    // Coincident ends and matching tangent directions (T ∝ P_k − P_{k−1}
    // on the control flavor — parallelism is the check).
    expect(aEnd.x).toBeCloseTo(bStart.x, 6);
    expect(aEnd.y).toBeCloseTo(bStart.y, 6);
    const tax = aEnd.x - aP2.x;
    const tay = aEnd.y - aP2.y;
    const tbx = bP1.x - bStart.x;
    const tby = bP1.y - bStart.y;
    expect(tax * tby - tay * tbx).toBeCloseTo(0, 6);
  });

  it("solves an angle between a line and a spline's start tangent", () => {
    const spline = createSplineEntity(eid("skent_spline"), "control", [
      { x: 0, y: 0 },
      { x: 0, y: 3 },
      { x: 3, y: 3 },
      { x: 6, y: 0 },
    ]);
    const line = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    );
    // T_start = (0,9) (vertical), line horizontal: φ = 90°; demand 60°.
    const result = solver.solve(
      [spline, line],
      [
        createAngleConstraint(
          cid("ang"),
          eid("skent_line"),
          eid("skent_spline"),
          angle(60, "deg"),
          "start",
        ),
      ],
    );
    const solvedResult = underConstrainedOf(result);
    expect(solvedResult.dof).toBe(11);
    const solved = solvedOf(solvedResult);
    const splineSolved = solved.get("skent_spline");
    const lineSolved = solved.get("skent_line");
    if (splineSolved === undefined || splineSolved.kind !== "spline") {
      throw new Error("missing solved spline");
    }
    if (lineSolved === undefined || lineSolved.kind !== "line") {
      throw new Error("missing solved line");
    }
    const p0 = splineSolved.points[0];
    const p1 = splineSolved.points[1];
    if (p0 === undefined || p1 === undefined) {
      throw new Error("missing solved start points");
    }
    const tx = p1.x - p0.x;
    const ty = p1.y - p0.y;
    const dot =
      (lineSolved.x2 - lineSolved.x1) * tx +
      (lineSolved.y2 - lineSolved.y1) * ty;
    const cosPhi =
      dot /
      (Math.hypot(
        lineSolved.x2 - lineSolved.x1,
        lineSolved.y2 - lineSolved.y1,
      ) *
        Math.hypot(tx, ty));
    expect(cosPhi).toBeCloseTo(Math.cos(Math.PI / 3), 6);
  });

  it("equal endpoint chords converge and pin equality, not a value", () => {
    const a = archEntity("skent_a");
    const b = createSplineEntity(eid("skent_b"), "control", [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 0 },
    ]);
    const result = solver.solve(
      [a, b],
      [createEqualConstraint(cid("eq"), eid("skent_a"), eid("skent_b"))],
    );
    const solvedResult = underConstrainedOf(result);
    expect(solvedResult.dof).toBe(15);
    const solved = solvedOf(solvedResult);
    const aSolved = solved.get("skent_a");
    const bSolved = solved.get("skent_b");
    if (aSolved === undefined || aSolved.kind !== "spline") {
      throw new Error("missing solved A");
    }
    if (bSolved === undefined || bSolved.kind !== "spline") {
      throw new Error("missing solved B");
    }
    const chord = (points: readonly { x: number; y: number }[]): number => {
      const first = points[0];
      const last = points[points.length - 1];
      if (first === undefined || last === undefined) {
        throw new Error("empty spline");
      }
      return Math.hypot(last.x - first.x, last.y - first.y);
    };
    expect(chord(aSolved.points)).toBeCloseTo(chord(bSolved.points), 6);
  });

  it("pointOnTangent pulls a point onto the end-tangent line", () => {
    const spline = archEntity();
    const point = createPointEntity(eid("skent_point"), { x: 1, y: 3 });
    const result = solver.solve(
      [point, spline],
      [
        createPointOnTangentConstraint(
          cid("pot"),
          pointTarget(eid("skent_point"), "center"),
          eid("skent_spline"),
          "start",
        ),
      ],
    );
    const solvedResult = underConstrainedOf(result);
    expect(solvedResult.dof).toBe(9);
    const pointSolved = solvedPoint(solvedResult, "skent_point");
    const splineSolved = solvedOf(solvedResult).get("skent_spline");
    if (splineSolved === undefined || splineSolved.kind !== "spline") {
      throw new Error("missing solved spline");
    }
    const p0 = splineSolved.points[0];
    const p1 = splineSolved.points[1];
    if (p0 === undefined || p1 === undefined) {
      throw new Error("missing solved start points");
    }
    // On the SOLVED start-tangent line (the solver may bend the spline or
    // move the point — both keep the point on the line through P0 along
    // P1 − P0).
    const wx = pointSolved.x - p0.x;
    const wy = pointSolved.y - p0.y;
    const tx = p1.x - p0.x;
    const ty = p1.y - p0.y;
    expect(wx * ty - wy * tx).toBeCloseTo(0, 6);
  });

  it("pointOnEntity pulls a point onto a polygon's boundary", () => {
    const polygon = createPolygonEntity(
      eid("skent_polygon"),
      { x: 0, y: 0 },
      5,
      4,
      0,
      "inscribed",
    );
    const point = createPointEntity(eid("skent_point"), { x: 2.5, y: 3 });
    const result = solver.solve(
      [point, polygon],
      [
        createPointOnEntityConstraint(
          cid("poe"),
          pointTarget(eid("skent_point"), "center"),
          eid("skent_polygon"),
        ),
      ],
    );
    const solvedResult = underConstrainedOf(result);
    expect(solvedResult.dof).toBe(5);
    const pointSolved = solvedPoint(solvedResult, "skent_point");
    const polygonSolved = solvedOf(solvedResult).get("skent_polygon");
    if (polygonSolved === undefined || polygonSolved.kind !== "polygon") {
      throw new Error("missing solved polygon");
    }
    // The point lands on the SOLVED boundary: min distance over the four
    // perimeter segments is zero. (sides/fit are discrete parameters the
    // solved record omits — read them from the authored entity.)
    const scale =
      polygon.fit === "inscribed" ? 1 : 1 / Math.cos(Math.PI / polygon.sides);
    const effective = scale * polygonSolved.radius;
    const vertex = (k: number): { x: number; y: number } => {
      const theta = polygonSolved.rotation + (Math.PI * 2 * k) / polygon.sides;
      return {
        x: polygonSolved.cx + effective * Math.cos(theta),
        y: polygonSolved.cy + effective * Math.sin(theta),
      };
    };
    let minDistance = Number.POSITIVE_INFINITY;
    for (let k = 0; k < polygon.sides; k += 1) {
      const a = vertex(k);
      const b = vertex(k + 1);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const u = Math.max(
        0,
        Math.min(
          1,
          ((pointSolved.x - a.x) * dx + (pointSolved.y - a.y) * dy) /
            (dx * dx + dy * dy),
        ),
      );
      minDistance = Math.min(
        minDistance,
        Math.hypot(a.x + u * dx - pointSolved.x, a.y + u * dy - pointSolved.y),
      );
    }
    expect(minDistance).toBeCloseTo(0, 6);
  });

  it("pointOnEntity pulls a point onto a straight slot's cap", () => {
    const slot = createStraightSlotEntity(
      eid("skent_slot"),
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      2,
    );
    const point = createPointEntity(eid("skent_point"), { x: 7, y: 0 });
    const result = solver.solve(
      [point, slot],
      [
        createPointOnEntityConstraint(
          cid("poe"),
          pointTarget(eid("skent_point"), "center"),
          eid("skent_slot"),
        ),
      ],
    );
    const solvedResult = underConstrainedOf(result);
    expect(solvedResult.dof).toBe(6);
    const solved = solvedPoint(solvedResult, "skent_point");
    const slotSolved = solvedOf(solvedResult).get("skent_slot");
    if (slotSolved === undefined || slotSolved.kind !== "slot") {
      throw new Error("missing solved slot");
    }
    // The right cap: |‖P − c_2‖ − r| = 0.
    const distance = Math.hypot(
      solved.x - slotSolved.x2,
      solved.y - slotSolved.y2,
    );
    expect(Math.abs(distance - slotSolved.radius)).toBeCloseTo(0, 6);
  });
});

// Local entity factories (stable ids for the assertions above).
function createEllipseEntityFromIndex(
  options: { fixed?: boolean } = {},
): SketchEntity {
  return createEllipseEntity(
    eid("skent_ellipse"),
    { x: 2, y: 1 },
    7.5,
    4.5,
    0.35,
    options,
  );
}

function createEllipticalArcEntityFromIndex(): SketchEntity {
  return createEllipticalArcEntity(
    eid("skent_earc"),
    { x: 0, y: 0 },
    6,
    3,
    0.2,
    0.3,
    2.2,
  );
}

function createSplineEntityFromIndex(
  options: { fixed?: boolean } = {},
): SketchEntity {
  return createSplineEntity(
    eid("skent_spline"),
    "control",
    [
      { x: 0, y: 0 },
      { x: 2, y: 6 },
      { x: 6, y: -6 },
      { x: 10, y: 0 },
    ],
    options,
  );
}

function createPolygonEntityFromIndex(): SketchEntity {
  return createPolygonEntity(
    eid("skent_polygon"),
    { x: 0, y: 0 },
    5,
    6,
    0.4,
    "inscribed",
  );
}

function createStraightSlotEntityFromIndex(): SketchEntity {
  return createStraightSlotEntity(
    eid("skent_slot"),
    { x: -5, y: 0 },
    { x: 5, y: 0 },
    2,
  );
}
