import { describe, expect, it } from "vitest";

import {
  CURVE_DEFAULTS,
  curvePayloadOf,
  curveSceneSegments,
  parseCurvePoints,
} from "./curves";

describe("curve authoring payloads", () => {
  it("builds the interpolated spline payload from the points text", () => {
    const outcome = curvePayloadOf(CURVE_DEFAULTS);
    expect(outcome.problems).toEqual([]);
    expect(outcome.payload?.kind).toBe("interpolated-spline");
    if (outcome.payload?.kind !== "interpolated-spline") return;
    expect(outcome.payload.points.length).toBe(3);
    expect(outcome.payload.points[1]).toEqual([20, 0, 20]);
  });

  it("rejects malformed point rows structurally", () => {
    const outcome = curvePayloadOf({
      ...CURVE_DEFAULTS,
      pointsText: "0, 0, 0\nnope, 1, 2",
    });
    expect(outcome.problems.length).toBeGreaterThan(0);
    expect(outcome.problems[0]?.field).toBe("pointsText");
  });

  it("builds the helix payload and rejects the circle degeneracy", () => {
    const helix = curvePayloadOf({
      ...CURVE_DEFAULTS,
      kind: "helix",
    });
    expect(helix.problems).toEqual([]);
    expect(helix.payload?.kind).toBe("helix");
    const circle = curvePayloadOf({
      ...CURVE_DEFAULTS,
      kind: "helix",
      helixPitch: "0",
    });
    expect(circle.problems.length).toBeGreaterThan(0);
  });

  it("builds the equation payload and rejects a dimensionless coordinate", () => {
    const equation = curvePayloadOf({
      ...CURVE_DEFAULTS,
      kind: "equation",
    });
    expect(equation.problems).toEqual([]);
    expect(equation.payload?.kind).toBe("equation");
    const dimensionless = curvePayloadOf({
      ...CURVE_DEFAULTS,
      kind: "equation",
      xExpression: "2 + 2",
    });
    expect(dimensionless.problems.length).toBeGreaterThan(0);
  });

  it("parses points tolerantly of blank lines", () => {
    const outcome = parseCurvePoints("0, 0, 0\n\n  10, 5, 5  \n");
    expect(outcome.problems).toEqual([]);
    expect(outcome.points.length).toBe(2);
  });
});

describe("curve scene segments", () => {
  it("derives the deterministic station soup from the shared evaluation", () => {
    const outcome = curvePayloadOf(CURVE_DEFAULTS);
    const payload = outcome.payload;
    expect(payload).toBeDefined();
    if (payload === undefined) return;
    const segments = curveSceneSegments(payload);
    expect(segments.length).toBeGreaterThan(2);
    expect(segments[0]?.start).toEqual([0, 0, 0]);
    const helixSegments = curveSceneSegments({
      kind: "helix",
      radius: { dimension: "length", unit: "mm", value: 6 },
      pitch: { dimension: "length", unit: "mm", value: 4 },
      turns: 2.5,
      handedness: 1,
      startAngle: { dimension: "angle", unit: "rad", value: 0 },
    });
    expect(helixSegments.length).toBeGreaterThan(100);
  });

  it("answers empty for a degenerate curve (no silent soup)", () => {
    expect(
      curveSceneSegments({
        kind: "helix",
        radius: { dimension: "length", unit: "mm", value: 0 },
        pitch: { dimension: "length", unit: "mm", value: 0 },
        turns: 1,
        handedness: 1,
        startAngle: { dimension: "angle", unit: "rad", value: 0 },
      }),
    ).toEqual([]);
  });
});
