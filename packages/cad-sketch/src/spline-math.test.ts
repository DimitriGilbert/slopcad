import { describe, expect, it } from "vitest";

import {
  SPLINE_TESSELLATION_DEFLECTION_MM,
  bezierChainOfSpline,
  evaluateSplinePoint,
  projectOntoSpline,
  splinePointGradient,
  tessellateSpline,
} from "./spline-math";

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
