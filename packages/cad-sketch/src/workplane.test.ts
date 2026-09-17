import { describe, expect, it } from "vitest";

import { SKETCH_DIAGNOSTIC_CODES } from "./diagnostics";
import {
  WORKPLANE_DIRECTION_EPSILON,
  WORKPLANE_ORTHONORMALITY_TOLERANCE,
  createWorkplane,
  frontWorkplane,
  orthonormalizeWorkplane,
  parseWorkplane,
  serializeWorkplane,
  worldToWorkplane,
  workplaneBasis,
  workplaneToWorld,
  xyWorkplane,
} from "./workplane";

describe("workplane orthonormalization", () => {
  it("normalizes and orthogonalizes skewed input into a right-handed frame", () => {
    const plane = createWorkplane(
      { x: 10, y: -5, z: 3 },
      { x: 0, y: 0, z: 5 },
      { x: 3, y: 1, z: 0.5 },
    );
    expect(plane.ok).toBe(true);
    if (!plane.ok) return;
    const { xAxis, yAxis, normal } = workplaneBasis(plane.value);
    // Unit vectors.
    expect(Math.hypot(xAxis.x, xAxis.y, xAxis.z)).toBeCloseTo(1, 12);
    expect(Math.hypot(yAxis.x, yAxis.y, yAxis.z)).toBeCloseTo(1, 12);
    expect(Math.hypot(normal.x, normal.y, normal.z)).toBeCloseTo(1, 12);
    // Mutual orthogonality.
    expect(xAxis.x * yAxis.x + xAxis.y * yAxis.y + xAxis.z * yAxis.z).toBeCloseTo(0, 12);
    expect(xAxis.x * normal.x + xAxis.y * normal.y + xAxis.z * normal.z).toBeCloseTo(
      0,
      12,
    );
    // xAxis keeps its in-plane direction: mostly +x after projection.
    expect(xAxis.x).toBeGreaterThan(0.9);
    // Right-handed: normal = xAxis × yAxis.
    const cross = {
      x: xAxis.y * yAxis.z - xAxis.z * yAxis.y,
      y: xAxis.z * yAxis.x - xAxis.x * yAxis.z,
      z: xAxis.x * yAxis.y - xAxis.y * yAxis.x,
    };
    expect(cross.x).toBeCloseTo(normal.x, 12);
    expect(cross.y).toBeCloseTo(normal.y, 12);
    expect(cross.z).toBeCloseTo(normal.z, 12);
  });

  it("rejects a degenerate (zero) normal", () => {
    const result = orthonormalizeWorkplane(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    );
    expect(!result.ok && result.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.workplaneDegenerate,
    );
  });

  it("rejects a near-zero normal below the direction epsilon", () => {
    const result = orthonormalizeWorkplane(
      { x: 0, y: 0, z: WORKPLANE_DIRECTION_EPSILON / 2 },
      { x: 1, y: 0, z: 0 },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an xAxis parallel to the normal", () => {
    const result = orthonormalizeWorkplane(
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 4 },
    );
    expect(!result.ok && result.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.workplaneDegenerate,
    );
  });

  it("rejects a zero xAxis (no in-plane direction)", () => {
    const result = orthonormalizeWorkplane({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 });
    expect(!result.ok && result.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.workplaneDegenerate,
    );
  });

  it("rejects non-finite origins with a malformed diagnostic", () => {
    const result = createWorkplane(
      { x: Number.NaN, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 0 },
    );
    expect(!result.ok && result.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.workplaneMalformed,
    );
  });

  it("is deterministic: identical skewed input yields the identical frame", () => {
    const build = () =>
      createWorkplane(
        { x: 1, y: 2, z: 3 },
        { x: 0.1, y: -0.3, z: 1 },
        { x: 2, y: 0.5, z: 0.1 },
      );
    const first = build();
    const second = build();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(serializeWorkplane(first.value)).toEqual(serializeWorkplane(second.value));
  });
});

describe("workplane placement into 3D", () => {
  it("maps workplane points through the documented transform", () => {
    const plane = xyWorkplane();
    const world = workplaneToWorld(plane, { x: 2, y: 3 });
    expect(world).toEqual({ x: 2, y: 3, z: 0 });
  });

  it("places points on a tilted workplane", () => {
    const plane = createWorkplane(
      { x: 5, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
    );
    expect(plane.ok).toBe(true);
    if (!plane.ok) return;
    const world = workplaneToWorld(plane.value, { x: 3, y: 2 });
    // y axis of the plane is normal × xAxis = (1,−1,0)/√2; workplane y=2
    // contributes (0, √2·… ): check via the inverse instead of closed form.
    const back = worldToWorkplane(plane.value, world);
    expect(back.x).toBeCloseTo(3, 12);
    expect(back.y).toBeCloseTo(2, 12);
    expect(back.offset).toBeCloseTo(0, 12);
  });

  it("projects off-plane world points along the normal", () => {
    const plane = frontWorkplane(4);
    const back = worldToWorkplane(plane, { x: 1, y: 6, z: -2 });
    expect(back.x).toBeCloseTo(1, 12);
    expect(back.y).toBeCloseTo(-2, 12);
    // The normal is -y, so a point 2 mm above the plane reads as -2.
    expect(back.offset).toBeCloseTo(-2, 12);
  });

  it("exposes an orthonormal basis for downstream consumers", () => {
    const basis = workplaneBasis(frontWorkplane(0));
    expect(basis.normal).toEqual({ x: 0, y: -1, z: 0 });
    expect(basis.xAxis).toEqual({ x: 1, y: 0, z: 0 });
    expect(basis.yAxis.x).toBeCloseTo(0, 12);
    expect(basis.yAxis.y).toBeCloseTo(0, 12);
    expect(basis.yAxis.z).toBeCloseTo(1, 12);
  });
});

describe("workplane serialization", () => {
  it("round-trips a canonical workplane exactly", () => {
    const plane = createWorkplane(
      { x: 1.5, y: -2, z: 0.25 },
      { x: 0.3, y: 0.3, z: 1 },
      { x: 1, y: -0.1, z: -0.37 },
    );
    expect(plane.ok).toBe(true);
    if (!plane.ok) return;
    const serialized = serializeWorkplane(plane.value);
    const parsed = parseWorkplane(JSON.parse(JSON.stringify(serialized)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeWorkplane(parsed.value)).toEqual(serialized);
  });

  it("emits fixed key order origin, normal, xAxis", () => {
    const serialized = serializeWorkplane(xyWorkplane());
    expect(Object.keys(serialized)).toEqual(["origin", "normal", "xAxis"]);
    expect(Object.keys(serialized.origin)).toEqual(["x", "y", "z"]);
  });

  it("rejects a stored frame that is not orthonormal within tolerance", () => {
    const skewed = {
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1.1 },
      xAxis: { x: 1, y: 0, z: 0 },
    };
    const result = parseWorkplane(skewed);
    expect(!result.ok && result.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.workplaneNotOrthonormal,
    );
  });

  it("rejects a stored frame whose axes are not perpendicular", () => {
    const tilted = {
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: 0.1, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 },
    };
    const result = parseWorkplane(tilted);
    expect(!result.ok && result.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.workplaneNotOrthonormal,
    );
  });

  it("rejects non-object input with a malformed diagnostic", () => {
    expect(!parseWorkplane(null).ok).toBe(true);
    expect(!parseWorkplane(3).ok).toBe(true);
    expect(
      !parseWorkplane({ origin: { x: 0, y: 0 }, normal: { x: 0, y: 0, z: 1 }, xAxis: { x: 1, y: 0, z: 0 } }).ok,
    ).toBe(true);
    expect(
      !parseWorkplane({
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: Number.POSITIVE_INFINITY },
        xAxis: { x: 1, y: 0, z: 0 },
      }).ok,
    ).toBe(true);
  });

  it("ignores unknown fields so future versions deserialize", () => {
    const withExtra = {
      ...serializeWorkplane(xyWorkplane()),
      futureField: true,
    };
    expect(parseWorkplane(withExtra).ok).toBe(true);
  });

  it("accepts constructor-produced frames back at the tolerance boundary", () => {
    // A frame built by the constructor is always accepted back.
    const plane = createWorkplane(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 1e-6, z: 0 },
    );
    expect(plane.ok).toBe(true);
    if (!plane.ok) return;
    expect(parseWorkplane(serializeWorkplane(plane.value)).ok).toBe(true);
    expect(WORKPLANE_ORTHONORMALITY_TOLERANCE).toBe(1e-9);
  });
});
