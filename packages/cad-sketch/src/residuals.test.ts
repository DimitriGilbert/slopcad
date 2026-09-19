/**
 * Residual-layer guard tests: `unpackSolvedParameters` must never emit a
 * degenerate arc — a collapsed (near-zero) sweep or a tiny negative raw
 * remainder that independent canonicalization would wrap into a near-full
 * circle — because applied sketches must always satisfy the entity layer's
 * own positive-sweep invariant (parseSketch round-trip).
 */

import { describe, expect, it } from "vitest";

import { createArcEntity } from "./entities";
import { ParameterLayout, unpackSolvedParameters } from "./residuals";
import { createSketchEntityId } from "./sketch-ids";

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
