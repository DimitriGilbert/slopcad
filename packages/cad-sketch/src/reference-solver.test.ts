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
  applySolvedParameters,
  createAngleConstraint,
  createCircleEntity,
  createCoincidentConstraint,
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

describe("reference solver — integration with the sketch aggregate", () => {
  it("applies solved parameters to a sketch that round-trips through serialization", () => {
    const sketch = dimensionedRectangleSketch();
    const result = solver.solve(sketch.entities, sketch.constraints);
    expect(result.status).toBe("solved");
    if (result.status === "failed") return;
    const applied = applySolvedParameters(sketch, result.parameters);
    const serialized = serializeSketch(applied);
    expect(serialized.formatVersion).toBe(1);
    const revived: unknown = JSON.parse(JSON.stringify(serialized));
    expect(revived).toEqual(serialized);
  });

  it("exposes a stable solver id", () => {
    expect(solver.id).toBe("reference-gauss-newton");
  });
});
