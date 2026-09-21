/**
 * Residual-layer tests. Two families:
 *
 * 1. The degenerate-arc guard: `unpackSolvedParameters` must never emit a
 *    degenerate arc — a collapsed (near-zero) sweep or a tiny negative raw
 *    remainder that independent canonicalization would wrap into a near-full
 *    circle — because applied sketches must always satisfy the entity
 *    layer's own positive-sweep invariant (parseSketch round-trip).
 *
 * 2. The Phase 37 constraint-math closure: every worked numeric example of
 *    docs/design/spline-constraint-math.md as executed row tests (values
 *    AND analytic gradients, the latter verified against central finite
 *    differences over every parameter slot), plus the §1.3 finite-difference
 *    regression for the pointOnLineRow / line↔circle tangent p1 columns.
 */

import { angle } from "@slopcad/cad-core";
import { describe, expect, it } from "vitest";

import {
  createCircleEntity,
  createArcEntity,
  createLineEntity,
  createPointEntity,
  createPolygonEntity,
  createSplineEntity,
  createStraightSlotEntity,
} from "./entities";
import {
  type ResidualRow,
  ParameterLayout,
  compileConstraintSystem,
  packInitialParameters,
  unpackSolvedParameters,
} from "./residuals";
import {
  createAngleConstraint,
  createEqualConstraint,
  createParallelConstraint,
  createPerpendicularConstraint,
  createPointOnEntityConstraint,
  createPointOnTangentConstraint,
  createTangentConstraint,
  pointTarget,
} from "./constraints";
import { createSketchConstraintId, createSketchEntityId } from "./sketch-ids";

describe("unpackSolvedParameters — degenerate arc sweep guard", () => {
  const arc = createArcEntity(
    createSketchEntityId("skent_arc"),
    { x: 0, y: 0 },
    5,
    0.5,
    2.6,
  );
  const layout = new ParameterLayout([arc]);

  it("rejects solved angles whose sweep collapses to (near) zero", () => {
    expect(() =>
      unpackSolvedParameters([arc], [0, 0, 5, 1.55, 1.55], layout),
    ).toThrowError(RangeError);
    expect(() =>
      unpackSolvedParameters([arc], [0, 0, 5, 1.55, 1.55 + 1e-12], layout),
    ).toThrowError(/degenerate/);
  });

  it("rejects a tiny negative raw sweep instead of wrapping it to a near-full circle", () => {
    // The verified reproduction's solved angles: raw sweep −6.15e-13, which
    // independent canonicalization used to turn into a 2π − 6e-13 sweep.
    const parameters = [0, 0, 5, 0.5400000000003121, 0.5399999999996971];
    expect(() =>
      unpackSolvedParameters([arc], parameters, layout),
    ).toThrowError(/degenerate/);
  });

  it("still canonicalizes a legitimate arc whose raw end angle is below its raw start", () => {
    // Raw sweep −2 rad is a real 2π − 2 ≈ 4.28 rad arc once canonicalized —
    // not degenerate, so the guard must not over-reject it.
    const solved = unpackSolvedParameters([arc], [0, 0, 5, 3, 1], layout);
    expect(solved.entities[0]).toEqual({
      id: arc.id,
      kind: "arc",
      cx: 0,
      cy: 0,
      radius: 5,
      startAngle: 3,
      endAngle: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 37 constraint-math closure (docs/design/spline-constraint-math.md)
// ---------------------------------------------------------------------------

const cid = (raw: string) => createSketchConstraintId(raw);
const eid = (raw: string) => createSketchEntityId(raw);

/** The spec's "arch": control spline (0,0) (1,2) (3,2) (4,0). */
const ARCH_POINTS = [
  { x: 0, y: 0 },
  { x: 1, y: 2 },
  { x: 3, y: 2 },
  { x: 4, y: 0 },
];

/** The arch's mirror (equal endpoint chord, opposite bulge). */
const MIRROR_POINTS = [
  { x: 0, y: 0 },
  { x: 1, y: -2 },
  { x: 3, y: -2 },
  { x: 4, y: 0 },
];

/** The arch's G1 continuation: starts at (4,0), tangent (3,−6). */
const CONTINUATION_POINTS = [
  { x: 4, y: 0 },
  { x: 5, y: -2 },
  { x: 7, y: -2 },
  { x: 8, y: 0 },
];

function rowsOf(
  entities: Parameters<typeof compileConstraintSystem>[0],
  constraints: Parameters<typeof compileConstraintSystem>[1],
): readonly ResidualRow[] {
  const compiled = compileConstraintSystem(entities, constraints);
  if ("diagnostics" in compiled) {
    throw new Error(
      `Compilation failed: ${compiled.diagnostics.map((d) => d.message).join("; ")}`,
    );
  }
  return compiled.rows;
}

/**
 * Finite-difference verification of one row's analytic gradient over every
 * parameter slot (central differences; the frozen-anchor rows are Danskin
 * gradients, exact at stationary anchors, so the agreement holds to the
 * differencing error away from constituent/anchor kinks).
 */
function expectGradientMatchesFiniteDifferences(
  row: ResidualRow,
  parameters: readonly number[],
  tolerance = 1e-5,
): void {
  const base = row.evaluate(parameters);
  const h = 1e-6;
  for (let slot = 0; slot < parameters.length; slot += 1) {
    const bumpedUp = [...parameters];
    bumpedUp[slot] = (bumpedUp[slot] ?? 0) + h;
    const bumpedDown = [...parameters];
    bumpedDown[slot] = (bumpedDown[slot] ?? 0) - h;
    const numeric =
      (row.evaluate(bumpedUp).value - row.evaluate(bumpedDown).value) / (2 * h);
    const analytic = base.grad.get(slot) ?? 0;
    // Skip slots where both sides are ~0 (untouched columns).
    if (Math.abs(numeric) < 1e-9 && Math.abs(analytic) < 1e-9) continue;
    expect(
      Math.abs(numeric - analytic),
      `slot ${String(slot)}: numeric ${String(numeric)} vs analytic ${String(analytic)}`,
    ).toBeLessThan(tolerance);
  }
}

describe("§1.3 p1-column regression — pointOnLineRow and line↔circle tangent", () => {
  it("carries ∂r/∂y1 = −1 for P = (0,1) on the line (0,0) → (1,0) (the minimal repro)", () => {
    const line = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    );
    const point = createPointEntity(eid("skent_point"), { x: 0, y: 1 });
    const [row] = rowsOf(
      [point, line],
      [
        createPointOnEntityConstraint(
          cid("skcon_poe"),
          pointTarget(eid("skent_point"), "center"),
          eid("skent_line"),
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    const parameters = [0, 1, 0, 0, 1, 0];
    const evaluation = row.evaluate(parameters);
    expect(evaluation.value).toBeCloseTo(1, 12);
    // Layout: point (0,1); line x1=2, y1=3, x2=4, y2=5. The corrected
    // start-slot column: moving only the start tilts the line through the
    // point by the full offset (previously this column read 0).
    expect(evaluation.grad.get(3)).toBeCloseTo(-1, 12);
    expectGradientMatchesFiniteDifferences(row, parameters);
  });

  it("carries the same columns on the line↔circle tangent row", () => {
    const line = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    );
    const circle = createCircleEntity(eid("skent_circle"), { x: 0, y: 1 }, 1);
    const [row] = rowsOf(
      [circle, line],
      [
        createTangentConstraint(
          cid("skcon_tan"),
          eid("skent_line"),
          eid("skent_circle"),
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    const parameters = [0, 1, 1, 0, 0, 1, 0];
    const evaluation = row.evaluate(parameters);
    expect(evaluation.value).toBeCloseTo(0, 12);
    // circle (cx,cy,r) = slots 0..2; line x1=3, y1=4, x2=5, y2=6.
    // distance 1 − radius 1 = 0; ∂r/∂y1 = (−wx − dx)/L = −1.
    expect(evaluation.grad.get(4)).toBeCloseTo(-1, 12);
    expectGradientMatchesFiniteDifferences(row, parameters);
  });

  it("sweeps three pinned fixtures against finite differences (every slot)", () => {
    const fixtures: {
      readonly point: { x: number; y: number };
      readonly line: [{ x: number; y: number }, { x: number; y: number }];
    }[] = [
      {
        point: { x: 3.1, y: -2.7 },
        line: [
          { x: -2, y: 1.5 },
          { x: 4.5, y: 0.25 },
        ],
      },
      {
        point: { x: -0.8, y: 0.6 },
        line: [
          { x: 2.25, y: -3 },
          { x: -1.75, y: 2 },
        ],
      },
      {
        point: { x: 10.2, y: 6.4 },
        line: [
          { x: 0, y: 0 },
          { x: 9.1, y: 7.3 },
        ],
      },
    ];
    for (const fixture of fixtures) {
      const line = createLineEntity(
        eid("skent_line"),
        fixture.line[0],
        fixture.line[1],
      );
      const point = createPointEntity(eid("skent_point"), fixture.point);
      const [row] = rowsOf(
        [point, line],
        [
          createPointOnEntityConstraint(
            cid("skcon_poe"),
            pointTarget(eid("skent_point"), "center"),
            eid("skent_line"),
          ),
        ],
      );
      if (row === undefined) throw new Error("missing row");
      expectGradientMatchesFiniteDifferences(
        row,
        packInitialParameters([point, line]),
      );
    }
  });
});

describe("§1.3/§1.8 tangent(line, spline) — the eliminated stationary-anchor row", () => {
  const spline = createSplineEntity(
    eid("skent_spline"),
    "control",
    ARCH_POINTS,
  );
  const lineOf = (y: number) =>
    createLineEntity(eid("skent_line"), { x: 0, y }, { x: 4, y });
  const tangentRowOf = (lineY: number): ResidualRow => {
    const line = lineOf(lineY);
    const rows = rowsOf(
      [spline, line],
      [
        createTangentConstraint(
          cid("skcon_tan"),
          eid("skent_line"),
          eid("skent_spline"),
        ),
      ],
    );
    const [row] = rows;
    if (row === undefined) throw new Error("missing tangent row");
    return row;
  };

  it("is exactly zero at the arch's apex on the line y = 1.5 (one row, anchor (0, ½))", () => {
    const row = tangentRowOf(1.5);
    // Layout: spline 8 slots (0..7), line x1=8, y1=9, x2=10, y2=11.
    const parameters = [0, 0, 1, 2, 3, 2, 4, 0, 0, 1.5, 4, 1.5];
    const evaluation = row.evaluate(parameters);
    expect(evaluation.value).toBeCloseTo(0, 12);
    // Gradient spot entries (§1.8): apex weights 3/8 on P1/P2.
    expect(evaluation.grad.get(3)).toBeCloseTo(0.375, 12);
    expect(evaluation.grad.get(5)).toBeCloseTo(0.375, 12);
    // Start-slot partial: (wx − dx)/L = (2 − 4)/4 = −0.5.
    expect(evaluation.grad.get(9)).toBeCloseTo(-0.5, 12);
    expectGradientMatchesFiniteDifferences(row, parameters);
  });

  it("reads −0.5 with the line raised to y = 2 (the ready GN fixture)", () => {
    const row = tangentRowOf(2);
    const parameters = [0, 0, 1, 2, 3, 2, 4, 0, 0, 2, 4, 2];
    expect(row.evaluate(parameters).value).toBeCloseTo(-0.5, 12);
  });

  it("falls back to the chain end when s is monotone (the earlier end wins ties)", () => {
    // A skewed arch whose end heights differ, below a line at y = −1: the
    // first end gives |s| = 1, the last 1.5, the interior stationary apex
    // 2.5 — the argmin is the FIRST end (strict-< tie-break to the earlier
    // candidate; an exact tie picks segment 0's end the same way).
    const skewed = createSplineEntity(eid("skent_skew"), "control", [
      { x: 0, y: 0 },
      { x: 1, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 0.5 },
    ]);
    const line = createLineEntity(
      eid("skent_line"),
      { x: 0, y: -1 },
      { x: 4, y: -1 },
    );
    const [row] = rowsOf(
      [skewed, line],
      [
        createTangentConstraint(
          cid("skcon_tan"),
          eid("skent_line"),
          eid("skent_skew"),
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    const parameters = [0, 0, 1, 2, 3, 2, 4, 0.5, 0, -1, 4, -1];
    expect(row.evaluate(parameters).value).toBeCloseTo(1, 12);
    // The end anchor is named-constant exact — the gradient is Danskin.
    expectGradientMatchesFiniteDifferences(row, parameters);
  });

  it("eliminates exactly one degree of freedom (12 parameters, 1 row)", () => {
    const line = lineOf(1.5);
    expect(
      rowsOf(
        [spline, line],
        [
          createTangentConstraint(
            cid("skcon_tan"),
            eid("skent_line"),
            eid("skent_spline"),
          ),
        ],
      ),
    ).toHaveLength(1);
  });
});

describe("§2–§4 end-tangent direction rows", () => {
  const spline = createSplineEntity(
    eid("skent_spline"),
    "control",
    ARCH_POINTS,
  );

  it("parallel: cross((1,2),(3,6)) = 0 against the arch's start tangent", () => {
    const line = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 0 },
      { x: 1, y: 2 },
    );
    const [row] = rowsOf(
      [spline, line],
      [
        createParallelConstraint(
          cid("skcon_par"),
          eid("skent_spline"),
          eid("skent_line"),
          "start",
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    const parameters = [...ARCH_POINTS.flatMap((p) => [p.x, p.y]), 0, 0, 1, 2];
    const evaluation = row.evaluate(parameters);
    expect(evaluation.value).toBeCloseTo(0, 12);
    // §3 spot check: ∂r/∂X_0 = −H_{P0}·dy = −(−3)(2) = 6.
    expect(evaluation.grad.get(0)).toBeCloseTo(6, 12);
    expectGradientMatchesFiniteDifferences(row, parameters);
  });

  it("perpendicular: dot((−2,1),(3,6)) = 0 with the §2 gradient spot check", () => {
    const line = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 0 },
      { x: -2, y: 1 },
    );
    const [row] = rowsOf(
      [spline, line],
      [
        createPerpendicularConstraint(
          cid("skcon_perp"),
          eid("skent_spline"),
          eid("skent_line"),
          "start",
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    const parameters = [...ARCH_POINTS.flatMap((p) => [p.x, p.y]), 0, 0, -2, 1];
    const evaluation = row.evaluate(parameters);
    expect(evaluation.value).toBeCloseTo(0, 12);
    // §2 spot check: ∂r/∂P0x = H·dx = (−3)(−2) = 6.
    expect(evaluation.grad.get(0)).toBeCloseTo(6, 12);
    expectGradientMatchesFiniteDifferences(row, parameters);
  });

  it("angle: 24/25 − 24/25 = 0 at θ = acos(24/25) (exact rationals)", () => {
    const tangentSpline = createSplineEntity(eid("skent_spline"), "control", [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 6, y: 4 },
      { x: 9, y: 0 },
    ]);
    const line = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 0 },
      { x: 4, y: 3 },
    );
    const [row] = rowsOf(
      [tangentSpline, line],
      [
        createAngleConstraint(
          cid("skcon_ang"),
          eid("skent_spline"),
          eid("skent_line"),
          angle(Math.acos(24 / 25), "rad"),
          "start",
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    const parameters = [0, 0, 3, 4, 6, 4, 9, 0, 0, 0, 4, 3];
    const evaluation = row.evaluate(parameters);
    // dot = 4·9 + 3·12 = 72; ‖T‖ = 15; L = 5; 72/75 = 24/25.
    expect(evaluation.value).toBeCloseTo(0, 12);
    expectGradientMatchesFiniteDifferences(row, parameters);
  });

  it("interpolated flavor: T_start = (1.5, 0) parallel to (1, 0); the 6:1 flavor scale", () => {
    const fit = createSplineEntity(eid("skent_fit"), "interpolated", [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 3 },
      { x: 0, y: 3 },
    ]);
    const line = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    );
    const [row] = rowsOf(
      [fit, line],
      [
        createParallelConstraint(
          cid("skcon_par"),
          eid("skent_fit"),
          eid("skent_line"),
          "start",
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    const parameters = [0, 0, 3, 0, 3, 3, 0, 3, 0, 0, 1, 0];
    expect(row.evaluate(parameters).value).toBeCloseTo(0, 12);
    expectGradientMatchesFiniteDifferences(row, parameters);
    // The same geometric start direction on the control flavor scales the
    // row by 6 (T = 3(P1−P0) vs (P1−P0)/2) — one assertion, per §3.
    const control = createSplineEntity(eid("skent_ctrl"), "control", [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 3, y: 3 },
      { x: 0, y: 3 },
    ]);
    const [controlRow] = rowsOf(
      [control, line],
      [
        createParallelConstraint(
          cid("skcon_par"),
          eid("skent_ctrl"),
          eid("skent_line"),
          "start",
        ),
      ],
    );
    if (controlRow === undefined) {
      throw new Error("missing control row");
    }
    // T_control = (0,3): cross((1,0),(0,3)) = 3; T_fit(0,1)-directed
    // variant scales by 1/6 — compare like-for-like with a (0,1) fit start.
    const fitSteep = createSplineEntity(eid("skent_fit2"), "interpolated", [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 3, y: 3 },
      { x: 0, y: 3 },
    ]);
    const [fitSteepRow] = rowsOf(
      [fitSteep, line],
      [
        createParallelConstraint(
          cid("skcon_par"),
          eid("skent_fit2"),
          eid("skent_line"),
          "start",
        ),
      ],
    );
    if (fitSteepRow === undefined) throw new Error("missing fit row");
    const controlValue = controlRow.evaluate([
      0, 0, 0, 1, 3, 3, 0, 3, 0, 0, 1, 0,
    ]).value;
    const fitValue = fitSteepRow.evaluate([
      0, 0, 0, 1, 3, 3, 0, 3, 0, 0, 1, 0,
    ]).value;
    expect(controlValue / fitValue).toBeCloseTo(6, 12);
  });
});

describe("§1.5 G1 joint rows", () => {
  it("arch + mirror continuation: all three rows exactly zero", () => {
    const a = createSplineEntity(eid("skent_a"), "control", ARCH_POINTS);
    const b = createSplineEntity(
      eid("skent_b"),
      "control",
      CONTINUATION_POINTS,
    );
    const rows = rowsOf(
      [a, b],
      [
        createTangentConstraint(
          cid("skcon_tan"),
          eid("skent_a"),
          eid("skent_b"),
        ),
      ],
    );
    expect(rows).toHaveLength(3);
    const parameters = [
      ...ARCH_POINTS.flatMap((p) => [p.x, p.y]),
      ...CONTINUATION_POINTS.flatMap((p) => [p.x, p.y]),
    ];
    for (const row of rows) {
      expect(row.evaluate(parameters).value).toBeCloseTo(0, 12);
    }
    expectGradientMatchesFiniteDifferences(rows[2] as ResidualRow, parameters);
  });
});

describe("§5(a) equal endpoint chord", () => {
  it("arch vs mirror: r = 0 and ∂r/∂P3x = 1", () => {
    const a = createSplineEntity(eid("skent_a"), "control", ARCH_POINTS);
    const b = createSplineEntity(eid("skent_b"), "control", MIRROR_POINTS);
    const [row] = rowsOf(
      [a, b],
      [createEqualConstraint(cid("skcon_eq"), eid("skent_a"), eid("skent_b"))],
    );
    if (row === undefined) throw new Error("missing row");
    const parameters = [
      ...ARCH_POINTS.flatMap((p) => [p.x, p.y]),
      ...MIRROR_POINTS.flatMap((p) => [p.x, p.y]),
    ];
    const evaluation = row.evaluate(parameters);
    expect(evaluation.value).toBeCloseTo(0, 12);
    // chordA = ‖(4,0)‖ = 4; ∂r/∂P^A_{3x} = (4−0)/4 = 1 (slot 6).
    expect(evaluation.grad.get(6)).toBeCloseTo(1, 12);
    expectGradientMatchesFiniteDifferences(row, parameters);
  });

  it("mixed pair: a line's length vs a spline's endpoint chord", () => {
    const spline = createSplineEntity(eid("skent_s"), "control", ARCH_POINTS);
    const line = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    );
    const [row] = rowsOf(
      [spline, line],
      [
        createEqualConstraint(
          cid("skcon_eq"),
          eid("skent_line"),
          eid("skent_s"),
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    const parameters = [...ARCH_POINTS.flatMap((p) => [p.x, p.y]), 0, 0, 4, 0];
    expect(row.evaluate(parameters).value).toBeCloseTo(0, 12);
    expectGradientMatchesFiniteDifferences(row, parameters);
  });
});

describe("§6(b) pointOnTangent — the end-tangent line", () => {
  it("(1,2) lies on the arch's start tangent: r = 0; (1,3): r = 1/√5", () => {
    const spline = createSplineEntity(eid("skent_s"), "control", ARCH_POINTS);
    const rowFor = (point: { x: number; y: number }): ResidualRow => {
      const entity = createPointEntity(eid("skent_point"), point);
      const [row] = rowsOf(
        [entity, spline],
        [
          createPointOnTangentConstraint(
            cid("skcon_pot"),
            pointTarget(eid("skent_point"), "center"),
            eid("skent_s"),
            "start",
          ),
        ],
      );
      if (row === undefined) throw new Error("missing row");
      return row;
    };
    const onLine = rowFor({ x: 1, y: 2 });
    const parametersOn = [1, 2, ...ARCH_POINTS.flatMap((p) => [p.x, p.y])];
    expect(onLine.evaluate(parametersOn).value).toBeCloseTo(0, 12);
    expectGradientMatchesFiniteDifferences(onLine, parametersOn);

    const offLine = rowFor({ x: 1, y: 3 });
    const parametersOff = [1, 3, ...ARCH_POINTS.flatMap((p) => [p.x, p.y])];
    expect(offLine.evaluate(parametersOff).value).toBeCloseTo(
      1 / Math.sqrt(5),
      12,
    );
    expectGradientMatchesFiniteDifferences(offLine, parametersOff);
  });
});

describe("§7.2 pointOnEntity on a polygon", () => {
  const polygon = createPolygonEntity(
    eid("skent_polygon"),
    { x: 0, y: 0 },
    5,
    4,
    0,
    "inscribed",
  );
  const rowFor = (point: { x: number; y: number }): ResidualRow => {
    const entity = createPointEntity(eid("skent_point"), point);
    const [row] = rowsOf(
      [entity, polygon],
      [
        createPointOnEntityConstraint(
          cid("skcon_poe"),
          pointTarget(eid("skent_point"), "center"),
          eid("skent_polygon"),
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    return row;
  };

  it("(2.5, 2.5) on the diamond's edge 0: r = 0", () => {
    expect(
      rowFor({ x: 2.5, y: 2.5 }).evaluate([2.5, 2.5, 0, 0, 5, 0]).value,
    ).toBeCloseTo(0, 12);
  });

  it("(2.5, 3): r = 1/(2√2) with edge 0 active and ∂r/∂cy = −√2/2", () => {
    const row = rowFor({ x: 2.5, y: 3 });
    const parameters = [2.5, 3, 0, 0, 5, 0];
    const evaluation = row.evaluate(parameters);
    expect(evaluation.value).toBeCloseTo(1 / (2 * Math.sqrt(2)), 12);
    // Point slots (0,1); polygon slots cx=2, cy=3, r=4, ρ=5. Moving cy up
    // slides the edge toward the outside point: ∂r/∂cy = −√2/2 (§7.2).
    expect(evaluation.grad.get(3)).toBeCloseTo(-Math.sqrt(2) / 2, 12);
    expect(evaluation.grad.get(1)).toBeCloseTo(Math.sqrt(2) / 2, 12);
    expectGradientMatchesFiniteDifferences(row, parameters);
  });
});

describe("§7.3 pointOnEntity on a straight slot", () => {
  const slot = createStraightSlotEntity(
    eid("skent_slot"),
    { x: 0, y: 0 },
    { x: 6, y: 0 },
    2,
  );
  const rowFor = (point: { x: number; y: number }): ResidualRow => {
    const entity = createPointEntity(eid("skent_point"), point);
    const [row] = rowsOf(
      [entity, slot],
      [
        createPointOnEntityConstraint(
          cid("skcon_poe"),
          pointTarget(eid("skent_point"), "center"),
          eid("skent_slot"),
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    return row;
  };

  it("(3,2) on the top edge: r = 0 (the containing segment's line gradient delegates)", () => {
    const row = rowFor({ x: 3, y: 2 });
    const evaluation = row.evaluate([3, 2, 0, 0, 6, 0, 2]);
    expect(evaluation.value).toBeCloseTo(0, 12);
    // Just outside the boundary (above the top edge) the radius partial is
    // the doc's −1: raising r moves the edge toward an outside point.
    const outside = rowFor({ x: 3, y: 2.1 });
    const outsideParameters = [3, 2.1, 0, 0, 6, 0, 2];
    const outsideEvaluation = outside.evaluate(outsideParameters);
    expect(outsideEvaluation.value).toBeCloseTo(0.1, 12);
    expect(outsideEvaluation.grad.get(6)).toBeCloseTo(-1, 12);
    expectGradientMatchesFiniteDifferences(outside, outsideParameters);
  });

  it("(8,0) on the right cap: r = 0 with ∂r/∂x2 = −1 and ∂r/∂radius = −1", () => {
    const row = rowFor({ x: 8, y: 0 });
    const evaluation = row.evaluate([8, 0, 0, 0, 6, 0, 2]);
    expect(evaluation.value).toBeCloseTo(0, 12);
    expect(evaluation.grad.get(4)).toBeCloseTo(-1, 12);
    expect(evaluation.grad.get(6)).toBeCloseTo(-1, 12);
    // FD-checked just outside the cap, where the unsigned kink is absent.
    const outside = rowFor({ x: 9, y: 0 });
    expect(outside.evaluate([9, 0, 0, 0, 6, 0, 2]).value).toBeCloseTo(1, 12);
    expectGradientMatchesFiniteDifferences(outside, [9, 0, 0, 0, 6, 0, 2]);
  });

  it("(7,0): the cap is the argmin at |1 − 2| = 1", () => {
    const row = rowFor({ x: 7, y: 0 });
    const parameters = [7, 0, 0, 0, 6, 0, 2];
    expect(row.evaluate(parameters).value).toBeCloseTo(1, 12);
    // FD across the P slots only: the slot parameters sit at an unsigned
    // kink of |‖P − c‖ − r| for center/radius slots... no — (7,0) is INSIDE
    // the cap circle, the sign is stably negative, so every slot FD-checks.
    expectGradientMatchesFiniteDifferences(row, parameters);
  });
});

// ---------------------------------------------------------------------------
// §37.1 regression: the control flavor's 3k+which gradient map. A ≥7-point
// control spline (two Bézier segments) puts every segment-1 anchor on
// stored points 3..6; the former 4k+which identity landed segment-1
// gradients one point too far (or past the point list, silently dropped).
// Every row whose anchor can live on segment 1 is FD-swept here.
// ---------------------------------------------------------------------------

describe("§37.1 multi-segment control splines — every affected row, FD-swept", () => {
  /** The arch + mirror continuation as ONE 7-point control spline. */
  const spline7 = createSplineEntity(eid("skent_spline"), "control", [
    { x: 0, y: 0 },
    { x: 1, y: 2 },
    { x: 3, y: 2 },
    { x: 4, y: 0 },
    { x: 5, y: -2 },
    { x: 7, y: -2 },
    { x: 8, y: 0 },
  ]);
  /** Spline slots 0..13; entity line slots follow. */
  const parametersOf = (
    line?: { x1: number; y1: number; x2: number; y2: number },
    point?: { x: number; y: number },
  ): number[] => [
    ...(point ? [point.x, point.y] : []),
    ...spline7.points.flatMap((p) => [p.x, p.y]),
    ...(line ? [line.x1, line.y1, line.x2, line.y2] : []),
  ];

  it("pointOnEntity(point, spline): both segments' projections FD-check", () => {
    // Probes sit off the apex/kink axes so the chord-form projection's
    // foot is unique (the frozen gradient is a subgradient at a projection
    // kink, where central differences read the bisector instead).
    for (const probe of [
      { x: 2.2, y: 0.5 },
      { x: 5.7, y: 0.3 },
    ]) {
      const point = createPointEntity(eid("skent_point"), probe);
      const [row] = rowsOf(
        [point, spline7],
        [
          createPointOnEntityConstraint(
            cid("skcon_poe"),
            pointTarget(eid("skent_point"), "center"),
            eid("skent_spline"),
          ),
        ],
      );
      if (row === undefined) throw new Error("missing row");
      // The point-on-spline row's gradient is FROZEN at the chord-form
      // projection (the pinned Phase 36 honesty: exact for the current
      // anchor, deflection-banded otherwise) — a looser FD tolerance than
      // the exact-gradient rows, per the row's own documented contract.
      expectGradientMatchesFiniteDifferences(
        row,
        parametersOf(undefined, probe),
        5e-3,
      );
    }
  });

  it("tangent(line, spline) anywhere: a segment-1 interior anchor FD-checks", () => {
    // The line y = −1 sits 0.5 above the second arch's apex (−1.5) — the
    // |s|-argmin stationary anchor lives at (segment 1, t = 1/2).
    const line = createLineEntity(
      eid("skent_line"),
      { x: 4, y: -1 },
      { x: 8, y: -1 },
    );
    const [row] = rowsOf(
      [spline7, line],
      [
        createTangentConstraint(
          cid("skcon_tan"),
          eid("skent_line"),
          eid("skent_spline"),
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    const parameters = parametersOf({
      x1: 4,
      x2: 8,
      y1: -1,
      y2: -1,
    });
    // Anchor value: s at the apex of the second arch = −0.5.
    expect(row.evaluate(parameters).value).toBeCloseTo(-0.5, 12);
    expectGradientMatchesFiniteDifferences(row, parameters);
  });

  it("tangent(line, spline) anywhere: a segment-1 CHAIN-END anchor FD-checks", () => {
    // A line through the far end (8,0): the argmin is (segment 1, t = 1),
    // the anchor whose gradient columns the mis-indexing dropped entirely.
    const line = createLineEntity(
      eid("skent_line"),
      { x: 8, y: -2 },
      { x: 8, y: 2 },
    );
    const [row] = rowsOf(
      [spline7, line],
      [
        createTangentConstraint(
          cid("skcon_tan"),
          eid("skent_line"),
          eid("skent_spline"),
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    const parameters = parametersOf({ x1: 8, x2: 8, y1: -2, y2: 2 });
    // The end point (8,0) lies ON the line: r = 0 exactly.
    expect(row.evaluate(parameters).value).toBeCloseTo(0, 12);
    expectGradientMatchesFiniteDifferences(row, parameters);
  });

  it('parallel/perpendicular/angle at "end": the segment-1 end tangent FD-checks', () => {
    const lineParallel = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 0 },
      { x: 1, y: 2 },
    );
    // T_end = 3(P6 − P5) = (3, 6).
    const [parallelRow] = rowsOf(
      [spline7, lineParallel],
      [
        createParallelConstraint(
          cid("skcon_par"),
          eid("skent_line"),
          eid("skent_spline"),
          "end",
        ),
      ],
    );
    if (parallelRow === undefined) throw new Error("missing parallel row");
    expect(
      parallelRow.evaluate(parametersOf({ x1: 0, x2: 1, y1: 0, y2: 2 })).value,
    ).toBeCloseTo(0, 12);
    expectGradientMatchesFiniteDifferences(
      parallelRow,
      parametersOf({ x1: 0, x2: 1, y1: 0, y2: 2 }),
    );

    const linePerp = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 0 },
      { x: -2, y: 1 },
    );
    const [perpRow] = rowsOf(
      [spline7, linePerp],
      [
        createPerpendicularConstraint(
          cid("skcon_perp"),
          eid("skent_line"),
          eid("skent_spline"),
          "end",
        ),
      ],
    );
    if (perpRow === undefined) throw new Error("missing perpendicular row");
    expect(
      perpRow.evaluate(parametersOf({ x1: 0, x2: -2, y1: 0, y2: 1 })).value,
    ).toBeCloseTo(0, 12);
    expectGradientMatchesFiniteDifferences(
      perpRow,
      parametersOf({ x1: 0, x2: -2, y1: 0, y2: 1 }),
    );

    const lineAngle = createLineEntity(
      eid("skent_line"),
      { x: 0, y: 0 },
      { x: 4, y: 3 },
    );
    const [angleRow] = rowsOf(
      [spline7, lineAngle],
      [
        createAngleConstraint(
          cid("skcon_ang"),
          eid("skent_line"),
          eid("skent_spline"),
          angle(Math.acos(2 / Math.sqrt(5)), "rad"),
          "end",
        ),
      ],
    );
    if (angleRow === undefined) throw new Error("missing angle row");
    expect(
      angleRow.evaluate(parametersOf({ x1: 0, x2: 4, y1: 0, y2: 3 })).value,
    ).toBeCloseTo(0, 12);
    expectGradientMatchesFiniteDifferences(
      angleRow,
      parametersOf({ x1: 0, x2: 4, y1: 0, y2: 3 }),
    );
  });

  it("G1 joint tangent row: both splines 7-point, FD-checked", () => {
    const a = spline7;
    const b = createSplineEntity(eid("skent_b"), "control", [
      { x: 8, y: 0 },
      { x: 9, y: -2 },
      { x: 11, y: -2 },
      { x: 12, y: 0 },
      { x: 13, y: 2 },
      { x: 15, y: 2 },
      { x: 16, y: 0 },
    ]);
    const rows = rowsOf(
      [a, b],
      [
        createTangentConstraint(
          cid("skcon_tan"),
          eid("skent_spline"),
          eid("skent_b"),
        ),
      ],
    );
    expect(rows).toHaveLength(3);
    const tangentRow = rows[2];
    if (tangentRow === undefined) throw new Error("missing tangent row");
    const parameters = [
      ...a.points.flatMap((p) => [p.x, p.y]),
      ...b.points.flatMap((p) => [p.x, p.y]),
    ];
    // A's end tangent (3,6); B's start tangent 3(P1 − P0) = (3,−6):
    // cross = −18 − 18 = −36.
    expect(tangentRow.evaluate(parameters).value).toBeCloseTo(-36, 9);
    expectGradientMatchesFiniteDifferences(tangentRow, parameters);
  });

  it('pointOnTangent at "end": the segment-1 end-tangent line FD-checks', () => {
    const point = createPointEntity(eid("skent_point"), { x: 9, y: 3 });
    const [row] = rowsOf(
      [point, spline7],
      [
        createPointOnTangentConstraint(
          cid("skcon_pot"),
          pointTarget(eid("skent_point"), "center"),
          eid("skent_spline"),
          "end",
        ),
      ],
    );
    if (row === undefined) throw new Error("missing row");
    // The end tangent line runs through (8,0) along (3,6) ∥ (1,2):
    // (9,3) − (8,0) = (1,3) has cross 3·3 − 6·1 = 3 over ‖T‖ = 3√5.
    const parameters = parametersOf(undefined, { x: 9, y: 3 });
    expect(row.evaluate(parameters).value).toBeCloseTo(
      3 / (3 * Math.sqrt(5)),
      12,
    );
    expectGradientMatchesFiniteDifferences(row, parameters);
  });
});

// ---------------------------------------------------------------------------
// §1.3 anchor continuity at a degenerate derivative quadratic: a span whose
// signed-distance cubic is analytically a QUADRATIC (A ≈ 0 at fp scale).
// The naive quadratic form lost the stationary root entirely, flipping the
// anywhere-tangency anchor to a chain end — a multi-millimetre residual
// jump under ±1e-6 parameter perturbations.
// ---------------------------------------------------------------------------

describe("§1.3 anchor continuity — the degenerate-A span", () => {
  /**
   * The span fixture: fit points chosen so span 1's Bézier y-controls are
   * (3.7, 4.0, −1.0333…, −11.4) — third difference (analytically) zero, so
   * the derivative quadratic has A ≈ 0 with its one stationary root at
   * t ≈ 0.028125. The x-axis line makes the signed distance exactly y.
   */
  const spline = createSplineEntity(eid("skent_spline"), "interpolated", [
    { x: 0, y: -13.2 },
    { x: 10, y: 3.7 },
    { x: 20, y: -11.4 },
    { x: 30, y: -58.5 },
  ]);
  const line = createLineEntity(
    eid("skent_line"),
    { x: 0, y: 0 },
    { x: 30, y: 0 },
  );
  const tangencyRow = (): ResidualRow => {
    const [row] = rowsOf(
      [spline, line],
      [
        createTangentConstraint(
          cid("skcon_tan"),
          eid("skent_line"),
          eid("skent_spline"),
        ),
      ],
    );
    if (row === undefined) throw new Error("missing tangency row");
    return row;
  };
  const parameters = [...spline.points.flatMap((p) => [p.x, p.y]), 0, 0, 30, 0];

  it("anchors at the degenerate span's stationary contact, not a chain end", () => {
    // The stationary candidate's s ≈ 3.7127 beats both chain ends (−13.2,
    // −58.5); the lost-root bug read the first end's −13.2 instead.
    expect(tangencyRow().evaluate(parameters).value).toBeCloseTo(3.71265625, 9);
  });

  it("stays continuous under ±1e-6 perturbation of every parameter", () => {
    const row = tangencyRow();
    const base = row.evaluate(parameters).value;
    for (let slot = 0; slot < parameters.length; slot += 1) {
      for (const sign of [1, -1]) {
        const perturbed = [...parameters];
        perturbed[slot] = (perturbed[slot] ?? 0) + sign * 1e-6;
        const value = row.evaluate(perturbed).value;
        expect(
          Math.abs(value - base),
          `slot ${String(slot)} sign ${String(sign)}`,
        ).toBeLessThan(1e-4);
      }
    }
  });

  it("carries an FD-exact gradient at the degenerate anchor", () => {
    expectGradientMatchesFiniteDifferences(tangencyRow(), parameters);
  });
});
