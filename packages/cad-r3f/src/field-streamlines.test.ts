/**
 * Phase 62b streamline coverage: the fixed-step RK4 integrator pinned
 * against analytic fields — the uniform field is integrated EXACTLY (a
 * constant direction makes every RK4 stage agree, and the pinned step is
 * float-exact), the circular field pins curvature (radius preserved,
 * angle advanced by arc/radius) — plus termination, order independence,
 * determinism, the geometry build, and the loud-refusal cases.
 */

import type * as THREE from "three";
import { describe, expect, it } from "vitest";

import { CAD_FIELD_COLORMAP_JET, fieldColorRamp } from "./field-colormaps";
import { decodedVectorField } from "./field-grid";
import {
  buildFieldStreamlinesGeometry,
  integrateFieldStreamline,
} from "./field-streamlines";
import { PLANE_LATTICE, vectorFieldBlocks } from "./field-fixtures";

/** The uniform +x field on the centered plane lattice. */
const UNIFORM = decodedVectorField(
  vectorFieldBlocks("uniform", PLANE_LATTICE, () => [2, 0, 0], "mm/s"),
);

/** The solid-rotation field v = (−y, x, 0) on the same lattice. */
const CIRCULAR = decodedVectorField(
  vectorFieldBlocks("circular", PLANE_LATTICE, (x, y) => [-y, x, 0], "mm/s"),
);

describe("integrateFieldStreamline", () => {
  it("integrates a uniform field exactly: a straight line of arc steps", () => {
    // Step 6: (h/6)·(k1+2k2+2k3+k4) = h in exact float arithmetic for a
    // constant direction — every stage is (1, 0, 0) and 6/6 = 1.
    const points = integrateFieldStreamline(UNIFORM, [-9, 0, 0], {
      stepMm: 6,
      stepCount: 3,
    });
    expect(points).toEqual([
      [-9, 0, 0],
      [-3, 0, 0],
      [3, 0, 0],
      [9, 0, 0],
    ]);
  });

  it("pins the circular field's curvature: radius kept, angle = arc/radius", () => {
    const radius = 10;
    const step = 0.5;
    const steps = 8;
    const points = integrateFieldStreamline(CIRCULAR, [radius, 0, 0], {
      stepMm: step,
      stepCount: steps,
    });
    expect(points).toHaveLength(steps + 1);
    const end = points[steps];
    if (end === undefined) {
      throw new Error("Expected the integrated endpoint to exist.");
    }
    const [x, y, z] = end;
    // Fourth-order on the direction field: the radius survives to well
    // under a 1e-7 relative error and the angle advances by arc/radius.
    expect(Math.sqrt(x * x + y * y)).toBeCloseTo(radius, 7);
    expect(Math.atan2(y, x)).toBeCloseTo((step * steps) / radius, 7);
    expect(z).toBe(0);
    // Every intermediate point stays on the circle too (curvature, not
    // just the endpoint).
    for (const [px, py] of points) {
      expect(Math.sqrt(px * px + py * py)).toBeCloseTo(radius, 7);
    }
  });

  it("terminates at the grid boundary without the exiting point", () => {
    const points = integrateFieldStreamline(UNIFORM, [-9, 0, 0], {
      stepMm: 6,
      stepCount: 10,
    });
    // The point past x = 10 would leave the lattice: 4 points total.
    expect(points).toHaveLength(4);
    expect(points[3]).toEqual([9, 0, 0]);
  });

  it("a stagnation seed yields the degenerate single-point curve", () => {
    // The rotation field's centre: v = (0, 0, 0) exactly.
    expect(
      integrateFieldStreamline(CIRCULAR, [0, 0, 0], {
        stepMm: 0.5,
        stepCount: 5,
      }),
    ).toEqual([[0, 0, 0]]);
  });

  it("a seed outside the field yields the degenerate single-point curve", () => {
    expect(
      integrateFieldStreamline(UNIFORM, [100, 0, 0], {
        stepMm: 0.5,
        stepCount: 5,
      }),
    ).toEqual([[100, 0, 0]]);
  });

  it("is order-independent: each seed's curve equals its solo integration", () => {
    const seeds = [
      [-9, 0, 0],
      [0, 5, 0],
      [3, -3, 0],
    ] as const;
    const options = { stepMm: 0.5, stepCount: 20 };
    const solo = seeds.map((seed) =>
      integrateFieldStreamline(CIRCULAR, seed, options),
    );
    // Swapping the seed order (and interleaving unrelated work) never
    // changes a curve: the integrator is pure per seed.
    const swapped = [...seeds]
      .reverse()
      .map((seed) => integrateFieldStreamline(CIRCULAR, seed, options));
    for (let index = 0; index < seeds.length; index += 1) {
      expect(swapped[index]).toEqual(solo[seeds.length - 1 - index]);
    }
    // And a repeated call is identical.
    for (const seed of seeds) {
      expect(integrateFieldStreamline(CIRCULAR, seed, options)).toEqual(
        integrateFieldStreamline(CIRCULAR, seed, options),
      );
    }
  });

  it("refuses non-positive, non-finite, or non-integral controls", () => {
    for (const stepMm of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        integrateFieldStreamline(UNIFORM, [0, 0, 0], {
          stepMm,
          stepCount: 1,
        }),
      ).toThrow(RangeError);
    }
    for (const stepCount of [-1, 2.5, Number.NaN]) {
      expect(() =>
        integrateFieldStreamline(UNIFORM, [0, 0, 0], {
          stepMm: 1,
          stepCount,
        }),
      ).toThrow(RangeError);
    }
  });
});

describe("buildFieldStreamlinesGeometry", () => {
  it("builds one segment pair per consecutive curve points, in seed order", () => {
    const geometry = buildFieldStreamlinesGeometry(
      UNIFORM,
      [
        [-9, 0, 0],
        [-3, 2, 0],
      ],
      { stepMm: 6, stepCount: 3 },
      { colormap: CAD_FIELD_COLORMAP_JET },
    );
    const position = geometry.getAttribute("position");
    // Three segments from the first curve (x = −9 → 9) plus two from the
    // second (x = −3 → 9, the boundary trims its third step).
    expect(position.count).toBe(10);
    // The first segment of the first curve: the seed and its first step.
    expect([position.getX(0), position.getY(0), position.getZ(0)]).toEqual([
      -9, 0, 0,
    ]);
    expect([position.getX(1), position.getY(1), position.getZ(1)]).toEqual([
      -3, 0, 0,
    ]);
    // The second curve's first segment starts at its own seed.
    expect([position.getX(6), position.getY(6), position.getZ(6)]).toEqual([
      -3, 2, 0,
    ]);
  });

  it("paints both endpoints of every segment the local magnitude's color", () => {
    const scale = { colormap: CAD_FIELD_COLORMAP_JET } as const;
    const geometry = buildFieldStreamlinesGeometry(
      CIRCULAR,
      [[10, 0, 0]],
      { stepMm: 0.5, stepCount: 4 },
      scale,
    );
    const color = geometry.getAttribute("color");
    const position = geometry.getAttribute("position");
    const ramp = fieldColorRamp(scale, [0, CIRCULAR.maxMagnitude]);
    for (let index = 0; index < color.count; index += 1) {
      // The curve's local magnitude is the radius (solid rotation);
      // closeness, not bit equality — the interpolated read and the
      // recomputed hypot agree to float rounding, the ramp amplifies
      // nothing.
      const expected = ramp(
        Math.hypot(position.getX(index), position.getY(index)),
      );
      // Colors land in a float32 attribute: six digits, not bit equality.
      expect(color.getX(index)).toBeCloseTo(expected[0], 6);
      expect(color.getY(index)).toBeCloseTo(expected[1], 6);
      expect(color.getZ(index)).toBeCloseTo(expected[2], 6);
    }
  });

  it("is deterministic: identical inputs build identical buffers", () => {
    const build = (): THREE.BufferGeometry =>
      buildFieldStreamlinesGeometry(
        CIRCULAR,
        [
          [10, 0, 0],
          [0, 10, 0],
        ],
        { stepMm: 0.5, stepCount: 16 },
        { colormap: CAD_FIELD_COLORMAP_JET },
      );
    expect([...build().getAttribute("position").array]).toEqual([
      ...build().getAttribute("position").array,
    ]);
    expect([...build().getAttribute("color").array]).toEqual([
      ...build().getAttribute("color").array,
    ]);
  });

  it("degenerate curves contribute no segments", () => {
    const geometry = buildFieldStreamlinesGeometry(
      CIRCULAR,
      [[0, 0, 0]],
      { stepMm: 0.5, stepCount: 4 },
      { colormap: CAD_FIELD_COLORMAP_JET },
    );
    expect(geometry.getAttribute("position").count).toBe(0);
  });
});
