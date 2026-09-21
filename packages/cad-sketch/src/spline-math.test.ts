import { describe, expect, it } from "vitest";

import {
  SPLINE_TESSELLATION_DEFLECTION_MM,
  bezierChainOfSpline,
  cubicStationaryParameters,
  evaluateSplinePoint,
  projectOntoSpline,
  splinePointGradient,
  splineTangent,
  splineTangentGradient,
  tessellateSpline,
} from "./spline-math";

/** The arch's mirror continuation — one 7-point two-segment control spline. */
const ARCH_CHAIN_POINTS = [
  { x: 0, y: 0 },
  { x: 1, y: 2 },
  { x: 3, y: 2 },
  { x: 4, y: 0 },
  { x: 5, y: -2 },
  { x: 7, y: -2 },
  { x: 8, y: 0 },
];

/** The spec's "arch": control spline (0,0) (1,2) (3,2) (4,0). */
const ARCH = {
  flavor: "control" as const,
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 2 },
    { x: 3, y: 2 },
    { x: 4, y: 0 },
  ],
};

const CONTROL_SPLINE = {
  flavor: "control" as const,
  points: [
    { x: 0, y: 0 },
    { x: 2, y: 8 },
    { x: 8, y: -8 },
    { x: 12, y: 0 },
  ],
};

const FIT_SPLINE = {
  flavor: "interpolated" as const,
  points: [
    { x: 0, y: 0 },
    { x: 5, y: 6 },
    { x: 10, y: 0 },
  ],
};

describe("spline chain construction", () => {
  it("chains a control spline into one cubic Bézier per three new points", () => {
    const chain = bezierChainOfSpline(CONTROL_SPLINE);
    expect(chain.segments).toHaveLength(1);
    const segment = chain.segments[0];
    expect(segment?.b0).toEqual({ x: 0, y: 0 });
    expect(segment?.b3).toEqual({ x: 12, y: 0 });
    const twoSegments = bezierChainOfSpline({
      flavor: "control",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 2 },
        { x: 3, y: 2 },
        { x: 4, y: 0 },
        { x: 5, y: -2 },
        { x: 7, y: -2 },
        { x: 8, y: 0 },
      ],
    });
    expect(twoSegments.segments).toHaveLength(2);
    // The junction point is shared: segment 1 starts where segment 0 ends.
    expect(twoSegments.segments[0]?.b3).toEqual(twoSegments.segments[1]?.b0);
  });

  it("interpolates every fit point exactly (the Catmull-Rom map)", () => {
    const chain = bezierChainOfSpline(FIT_SPLINE);
    expect(chain.segments).toHaveLength(2);
    expect(evaluateSplinePoint(chain, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(evaluateSplinePoint(chain, 0, 1)).toEqual({ x: 5, y: 6 });
    expect(evaluateSplinePoint(chain, 1, 1)).toEqual({ x: 10, y: 0 });
  });

  it("evaluates the control spline through its junction points only", () => {
    const chain = bezierChainOfSpline(CONTROL_SPLINE);
    expect(evaluateSplinePoint(chain, 0, 0)).toEqual(CONTROL_SPLINE.points[0]);
    expect(evaluateSplinePoint(chain, 0, 1)).toEqual(CONTROL_SPLINE.points[3]);
    // The midpoint is the Bézier average, not any stored point.
    const mid = evaluateSplinePoint(chain, 0, 0.5);
    expect(mid.x).toBeCloseTo(5.25, 12);
  });
});

describe("spline gradients", () => {
  it("gives the exact Bernstein weights for the control flavor", () => {
    const chain = bezierChainOfSpline(CONTROL_SPLINE);
    const grad = splinePointGradient(chain, 0, 0.5);
    expect(grad.get(0)).toBeCloseTo(0.125, 12);
    expect(grad.get(1)).toBeCloseTo(0.375, 12);
    expect(grad.get(2)).toBeCloseTo(0.375, 12);
    expect(grad.get(3)).toBeCloseTo(0.125, 12);
    // At the start only the first point moves the curve.
    const startGrad = splinePointGradient(chain, 0, 0);
    expect(startGrad.get(0)).toBe(1);
    expect(startGrad.get(1) ?? 0).toBe(0);
  });

  it("chains the Catmull-Rom conversion for the interpolated flavor", () => {
    const chain = bezierChainOfSpline(FIT_SPLINE);
    // At span 0 parameter 0 the curve point is P0 exactly; its gradient
    // w.r.t. the fit points is the identity on P0.
    const grad = splinePointGradient(chain, 0, 0);
    expect(grad.get(0)).toBe(1);
    expect(grad.get(1) ?? 0).toBe(0);
    // Interior parameters spread over the neighboring fit points with
    // weights that sum to 1 (affine combination).
    const mid = splinePointGradient(chain, 0, 0.5);
    let sum = 0;
    for (const weight of mid.values()) sum += weight;
    expect(sum).toBeCloseTo(1, 12);
  });

  it("matches numeric differentiation of the interpolated chain", () => {
    const chain = bezierChainOfSpline(FIT_SPLINE);
    const h = 1e-6;
    const original = FIT_SPLINE.points;
    for (const index of [0, 1, 2]) {
      const analytic = splinePointGradient(chain, 0, 0.3).get(index) ?? 0;
      const bumped = original.map((point, i) =>
        i === index ? { x: point.x + h, y: point.y } : point,
      );
      const bumpedChain = bezierChainOfSpline({
        flavor: "interpolated",
        points: bumped,
      });
      const numeric =
        (evaluateSplinePoint(bumpedChain, 0, 0.3).x -
          evaluateSplinePoint(chain, 0, 0.3).x) /
        h;
      expect(analytic).toBeCloseTo(numeric, 5);
    }
  });
});

describe("spline tangents (the derivative primitive)", () => {
  it("sums derivative weights to zero on every flavor (Σ B'_j = 0)", () => {
    for (const entity of [ARCH, FIT_SPLINE]) {
      const chain = bezierChainOfSpline(entity);
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        let sum = 0;
        for (const weight of splineTangentGradient(chain, 0, t).values()) {
          sum += weight;
        }
        expect(sum).toBeCloseTo(0, 12);
      }
    }
  });

  it("evaluates the arch's tangents exactly: (4.5,0) at ½, (3,6) at 0, (3,−6) at 1", () => {
    const chain = bezierChainOfSpline(ARCH);
    expect(splineTangent(chain, 0, 0.5)).toEqual({ vx: 4.5, vy: 0 });
    expect(splineTangent(chain, 0, 0)).toEqual({ vx: 3, vy: 6 });
    expect(splineTangent(chain, 0, 1)).toEqual({ vx: 3, vy: -6 });
  });

  it("gives the control flavor's end tangents weights (+3, −3) on (P1, P0)", () => {
    const chain = bezierChainOfSpline(ARCH);
    const start = splineTangentGradient(chain, 0, 0);
    expect(start.get(1)).toBe(3);
    expect(start.get(0)).toBe(-3);
    expect(start.size).toBe(2);
    const end = splineTangentGradient(chain, chain.segments.length - 1, 1);
    expect(end.get(3)).toBe(3);
    expect(end.get(2)).toBe(-3);
    expect(end.size).toBe(2);
  });

  it("interpolates: T_start = (P1 − P0)/2 with weights (+1/2, −1/2)", () => {
    const entity = {
      flavor: "interpolated" as const,
      points: [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 3 },
        { x: 0, y: 3 },
      ],
    };
    const chain = bezierChainOfSpline(entity);
    expect(splineTangent(chain, 0, 0)).toEqual({ vx: 1.5, vy: 0 });
    const grad = splineTangentGradient(chain, 0, 0);
    expect(grad.get(1)).toBe(0.5);
    expect(grad.get(0)).toBe(-0.5);
  });

  it("matches the interpolated junction equality (P_{i+2} − P_i)/2 from both sides", () => {
    const chain = bezierChainOfSpline(FIT_SPLINE);
    // FIT_SPLINE fit points (0,0) (5,6) (10,0): span 0's end tangent and
    // span 1's start tangent are both (P2 − P0)/2 = (5, 0).
    const left = splineTangent(chain, 0, 1);
    const right = splineTangent(chain, 1, 0);
    expect(left).toEqual(right);
    expect(left).toEqual({ vx: 5, vy: 0 });
  });

  it("matches numeric differentiation of the chain point", () => {
    const chain = bezierChainOfSpline(FIT_SPLINE);
    const h = 1e-6;
    const t = 0.3;
    const ahead = evaluateSplinePoint(chain, 0, t + h);
    const behind = evaluateSplinePoint(chain, 0, t - h);
    const tangent = splineTangent(chain, 0, t);
    expect(tangent.vx).toBeCloseTo((ahead.x - behind.x) / (2 * h), 5);
    expect(tangent.vy).toBeCloseTo((ahead.y - behind.y) / (2 * h), 5);
  });

  it("chains the flavor stencil exactly (gradient vs numeric point-bump)", () => {
    const chain = bezierChainOfSpline(FIT_SPLINE);
    const h = 1e-6;
    const t = 0.3;
    for (const index of [0, 1, 2]) {
      const analytic = splineTangentGradient(chain, 0, t).get(index) ?? 0;
      const bumped = FIT_SPLINE.points.map((point, i) =>
        i === index ? { x: point.x + h, y: point.y } : point,
      );
      const bumpedChain = bezierChainOfSpline({
        flavor: "interpolated",
        points: bumped,
      });
      const numeric =
        (splineTangent(bumpedChain, 0, t).vx - splineTangent(chain, 0, t).vx) /
        h;
      expect(analytic).toBeCloseTo(numeric, 5);
    }
  });
});

describe("scalar-cubic stationary parameters", () => {
  it("finds the arch's single stationary parameter at t = 1/2", () => {
    // y-controls (0, 2, 2, 0): derivative controls 3(2, 0, −2) = (6, 0, −6),
    // power form −6t² + 6t + 0 → root exactly 1/2.
    expect(cubicStationaryParameters(0, 2, 2, 0)).toEqual([0.5]);
  });

  it("returns both strictly interior roots ascending, none at or outside", () => {
    // A monotone cubic (derivative one-signed) has no interior root.
    expect(cubicStationaryParameters(0, 1, 2, 3)).toEqual([]);
    // Both roots interior and distinct: the wiggle (0, 3, −3, 0) peaks and
    // dips at t = (3 ± √3)/6.
    const roots = cubicStationaryParameters(0, 3, -3, 0);
    expect(roots).toHaveLength(2);
    expect(roots[0]).toBeCloseTo((3 - Math.sqrt(3)) / 6, 12);
    expect(roots[1]).toBeCloseTo((3 + Math.sqrt(3)) / 6, 12);
    // Roots exactly at the boundary stay out (strictly interior only).
    expect(cubicStationaryParameters(0, 0, 1, 2)).toEqual([]);
  });

  it("keeps the root of a near-degenerate (A ≈ 0) derivative quadratic — the Kahan/near-linear form", () => {
    // A span whose signed-distance cubic is analytically a quadratic (third
    // difference zero): computed A lands at ~1e-15 scale, where the naive
    // (−B ± √D)/2A form cancels catastrophically and loses the root
    // entirely (both computed roots fall outside (0,1)), making the
    // anywhere-tangency anchor jump discontinuously under 1e-6 parameter
    // perturbations. The true stationary point is ≈ 0.028125 (verified by
    // bisection against the Bernstein derivative).
    const base = cubicStationaryParameters(11.7, 12.0, 6.9667, -3.4);
    expect(base).toHaveLength(1);
    expect(base[0]).toBeCloseTo(0.0281252, 6);
    // Continuity: ±1e-6 control nudges keep exactly one root, displaced by
    // far less than the nudge (the naive form flips between [] and [t]).
    for (const [index, eps] of [
      [0, 1e-6],
      [0, -1e-6],
      [1, 1e-6],
      [1, -1e-6],
    ] as const) {
      const controls = [11.7, 12.0, 6.9667, -3.4];
      controls[index] = (controls[index] ?? 0) + eps;
      const nudged = cubicStationaryParameters(
        controls[0] ?? 0,
        controls[1] ?? 0,
        controls[2] ?? 0,
        controls[3] ?? 0,
      );
      expect(nudged).toHaveLength(1);
      expect(Math.abs((nudged[0] ?? 0) - (base[0] ?? 0))).toBeLessThan(1e-5);
    }
  });

  it("resolves the exactly-quadratic case (A = 0) at its true stationary point", () => {
    // g(t) = (t − 1/4)² in Bézier controls: stationary minimum at t = 1/4.
    const roots = cubicStationaryParameters(
      0.0625,
      -0.10416666666666667,
      0.0625,
      0.5625,
    );
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBeCloseTo(0.25, 12);
  });

  it("keeps full root precision when A is fp-noise but nonzero", () => {
    // The quadratic fixture with a 1e-12 control nudge leaves A ≈ 9e-12 —
    // nonzero, so the naive (−B ± √D)/2A path divides a 4.5e-12 numerator
    // (itself only a few digits of √D's rounding) by 1.8e-11 and loses the
    // root's precision (computed 0.2499938, true 0.25); the Kahan products
    // C/Q stay at full width (0.24999999999972).
    const roots = cubicStationaryParameters(
      0.0625,
      -0.10416666666666667 + 1e-12,
      0.0625,
      0.5625,
    );
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBeCloseTo(0.25, 9);
  });
});

describe("multi-segment control-spline gradients (the 3k+which control map)", () => {
  // The arch plus its mirror continuation: ONE control spline of 7 points
  // (two Bézier segments). The control flavor packs one segment per three
  // new points — segment 1's controls are stored points 3..6, so gradients
  // anchored on segment 1 must land on points 3..6, never 4..7 (the old
  // 4k+which identity mapped them one point too far and silently dropped
  // the out-of-range columns).
  const TWO_SEGMENTS = {
    flavor: "control" as const,
    points: ARCH_CHAIN_POINTS,
  };

  it("maps segment 1's junction anchors onto the stored points", () => {
    const chain = bezierChainOfSpline(TWO_SEGMENTS);
    expect(chain.segments).toHaveLength(2);
    expect([...splinePointGradient(chain, 1, 0).entries()]).toEqual([[3, 1]]);
    expect([...splinePointGradient(chain, 1, 1).entries()]).toEqual([[6, 1]]);
  });

  it("maps segment 1's end tangents onto the stored point pairs (+3, −3)", () => {
    const chain = bezierChainOfSpline(TWO_SEGMENTS);
    expect([...splineTangentGradient(chain, 1, 0).entries()]).toEqual([
      [3, -3],
      [4, 3],
    ]);
    expect([...splineTangentGradient(chain, 1, 1).entries()]).toEqual([
      [5, -3],
      [6, 3],
    ]);
  });

  it("chains segment 1 exactly against numeric point-bumps", () => {
    const chain = bezierChainOfSpline(TWO_SEGMENTS);
    const h = 1e-6;
    for (const index of [2, 3, 4, 5, 6]) {
      const analyticPoint = splinePointGradient(chain, 1, 0.3).get(index) ?? 0;
      const analyticTangent =
        splineTangentGradient(chain, 1, 0.3).get(index) ?? 0;
      const bumped = TWO_SEGMENTS.points.map((point, i) =>
        i === index ? { x: point.x + h, y: point.y } : point,
      );
      const bumpedChain = bezierChainOfSpline({
        flavor: "control",
        points: bumped,
      });
      const numericPoint =
        (evaluateSplinePoint(bumpedChain, 1, 0.3).x -
          evaluateSplinePoint(chain, 1, 0.3).x) /
        h;
      const numericTangent =
        (splineTangent(bumpedChain, 1, 0.3).vx -
          splineTangent(chain, 1, 0.3).vx) /
        h;
      expect(analyticPoint, `point weight P${String(index)}`).toBeCloseTo(
        numericPoint,
        5,
      );
      expect(analyticTangent, `tangent weight P${String(index)}`).toBeCloseTo(
        numericTangent,
        3,
      );
    }
  });
});

describe("spline tessellation", () => {
  it("places every vertex on the true curve and the endpoints exactly", () => {
    const vertices = tessellateSpline(CONTROL_SPLINE);
    const chain = bezierChainOfSpline(CONTROL_SPLINE);
    expect(vertices[0]?.point).toEqual({ x: 0, y: 0 });
    expect(vertices[vertices.length - 1]?.point).toEqual({ x: 12, y: 0 });
    for (const vertex of vertices) {
      const exact = evaluateSplinePoint(chain, vertex.segment, vertex.t);
      // The recovered parameter is chord-projected; the vertex itself was
      // Bézier-evaluated, so re-evaluating at the recovered parameter must
      // land within the deflection band of the vertex.
      expect(
        Math.hypot(exact.x - vertex.point.x, exact.y - vertex.point.y),
      ).toBeLessThanOrEqual(SPLINE_TESSELLATION_DEFLECTION_MM);
    }
  });

  it("keeps chords within the deflection of the true curve", () => {
    const vertices = tessellateSpline(FIT_SPLINE);
    const chain = bezierChainOfSpline(FIT_SPLINE);
    // Sample the true curve densely and confirm every sample lies within
    // the deflection of some tessellated chord (the convex-hull bound's
    // observable form).
    for (let segment = 0; segment < chain.segments.length; segment += 1) {
      for (let step = 0; step <= 20; step += 1) {
        const sample = evaluateSplinePoint(chain, segment, step / 20);
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i + 1 < vertices.length; i += 1) {
          const a = vertices[i]?.point;
          const b = vertices[i + 1]?.point;
          if (a === undefined || b === undefined) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const lengthSquared = dx * dx + dy * dy;
          const t =
            lengthSquared === 0
              ? 0
              : Math.max(
                  0,
                  Math.min(
                    1,
                    ((sample.x - a.x) * dx + (sample.y - a.y) * dy) /
                      lengthSquared,
                  ),
                );
          best = Math.min(
            best,
            Math.hypot(a.x + t * dx - sample.x, a.y + t * dy - sample.y),
          );
        }
        expect(best).toBeLessThanOrEqual(SPLINE_TESSELLATION_DEFLECTION_MM);
      }
    }
  });

  it("is deterministic: identical points tessellate identically", () => {
    expect(tessellateSpline(FIT_SPLINE)).toEqual(tessellateSpline(FIT_SPLINE));
  });
});

describe("spline projection", () => {
  it("projects a curve point onto itself at zero distance", () => {
    const vertices = tessellateSpline(FIT_SPLINE);
    const onCurve = vertices[Math.floor(vertices.length / 2)]?.point ?? {
      x: 0,
      y: 0,
    };
    const projection = projectOntoSpline(FIT_SPLINE, onCurve);
    expect(projection).not.toBeNull();
    expect(projection?.distance).toBeLessThanOrEqual(
      SPLINE_TESSELLATION_DEFLECTION_MM,
    );
  });

  it("finds the nearest side of a bent curve", () => {
    // The fit spline rises through (5, 6); a point above its middle is
    // nearer to the curve's crown than to its ends.
    const projection = projectOntoSpline(FIT_SPLINE, { x: 5, y: 20 });
    expect(projection?.point.y).toBeGreaterThan(1);
    expect(projection?.distance).toBeGreaterThan(0);
  });
});
