/**
 * Tests of the semantic assertion utilities themselves: each helper passes
 * on honest input and throws a descriptive error on each violation mode it
 * promises to catch.
 */

import { describe, expect, it } from "vitest";

import { KERNEL_ERROR_CODES } from "./contract";
import {
  assertAreaClose,
  assertBoundsContain,
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  assertVolumeLessThan,
  expectKernelFailure,
  unwrapKernelResult,
} from "./test-utils";

const PLATE_BOUNDS = { min: [0, 0, 0] as const, max: [30, 20, 10] as const };

describe("unwrapKernelResult", () => {
  it("returns the value of a successful result", () => {
    expect(unwrapKernelResult({ ok: true, value: 42 }, "measure")).toBe(42);
  });

  it("throws with code and message on failure", () => {
    expect(() =>
      unwrapKernelResult(
        {
          ok: false,
          error: {
            code: KERNEL_ERROR_CODES.invalidLength,
            message: "rejected",
            input: null,
          },
        },
        "measure",
      ),
    ).toThrow(/measure failed with kernel\/invalid-length: rejected/);
  });
});

describe("expectKernelFailure", () => {
  const failure = {
    ok: false as const,
    error: {
      code: KERNEL_ERROR_CODES.boundsEmpty,
      message: "empty",
      input: null,
    },
  };

  it("returns the structured error when the code matches", () => {
    expect(expectKernelFailure(failure, "kernel/bounds-empty").message).toBe(
      "empty",
    );
  });

  it("throws when the operation succeeded", () => {
    expect(() =>
      expectKernelFailure({ ok: true, value: 1 }, "kernel/bounds-empty"),
    ).toThrow(/was expected to fail with kernel\/bounds-empty but succeeded/);
  });

  it("throws when the failure code differs", () => {
    expect(() => expectKernelFailure(failure, "kernel/invalid-length")).toThrow(
      /expected to fail with kernel\/invalid-length but failed with kernel\/bounds-empty/,
    );
  });
});

describe("assertBoundsEqual", () => {
  it("accepts bounds equal within the tolerance", () => {
    expect(() =>
      assertBoundsEqual(
        { min: [0, 0, 0], max: [30, 20, 10] },
        { min: [1e-9, -1e-9, 0], max: [30, 20, 10 + 1e-9] },
        1e-6,
      ),
    ).not.toThrow();
  });

  it("rejects any component beyond the tolerance", () => {
    expect(() =>
      assertBoundsEqual(
        { min: [0, 0, 0], max: [30, 20, 10] },
        { min: [0, 0, 0], max: [30, 21, 10] },
      ),
    ).toThrow(/Bounds mismatch/);
  });

  it("rejects a non-finite actual component", () => {
    expect(() =>
      assertBoundsEqual(
        { min: [Number.NaN, 0, 0], max: [30, 20, 10] },
        PLATE_BOUNDS,
      ),
    ).toThrow(/non-finite component/);
    expect(() =>
      assertBoundsEqual(
        { min: [0, 0, 0], max: [30, 20, Number.POSITIVE_INFINITY] },
        PLATE_BOUNDS,
      ),
    ).toThrow(/non-finite component/);
  });
});

describe("assertBoundsContain", () => {
  it("accepts an inner box fully inside the outer box", () => {
    expect(() =>
      assertBoundsContain(PLATE_BOUNDS, { min: [5, 5, 0], max: [25, 15, 10] }),
    ).not.toThrow();
  });

  it("rejects an inner box poking out on any axis", () => {
    expect(() =>
      assertBoundsContain(PLATE_BOUNDS, { min: [0, 0, 0], max: [31, 20, 10] }),
    ).toThrow(/do not contain/);
  });

  it("honours the tolerance for boundary-aligned boxes", () => {
    expect(() =>
      assertBoundsContain(PLATE_BOUNDS, { min: [0, 0, 0], max: [30, 20, 10] }),
    ).not.toThrow();
  });

  it("rejects a NaN outer box (a NaN container contains nothing)", () => {
    expect(() =>
      assertBoundsContain(
        { min: [Number.NaN, 0, 0], max: [30, 20, 10] },
        { min: [5, 5, 0], max: [25, 15, 10] },
      ),
    ).toThrow(/do not contain/);
  });

  it("rejects a NaN inner corner (NaN corners sit inside nothing)", () => {
    expect(() =>
      assertBoundsContain(PLATE_BOUNDS, {
        min: [Number.NaN, 5, 0],
        max: [25, 15, 10],
      }),
    ).toThrow(/do not contain/);
  });
});

describe("assertVolumeClose", () => {
  it("accepts volumes within the relative tolerance", () => {
    expect(() => assertVolumeClose(1010, 1000, 0.02)).not.toThrow();
    expect(() => assertVolumeClose(0, 0, 0.05)).not.toThrow();
  });

  it("rejects volumes beyond the relative tolerance", () => {
    expect(() => assertVolumeClose(1030, 1000, 0.02)).toThrow(
      /not within 2% of the expected/,
    );
  });

  it("rejects a non-finite actual volume", () => {
    expect(() => assertVolumeClose(Number.NaN, 1000, 0.02)).toThrow(
      /not a finite number/,
    );
    expect(() =>
      assertVolumeClose(Number.POSITIVE_INFINITY, 1000, 0.02),
    ).toThrow(/not a finite number/);
  });
});

describe("assertAreaClose", () => {
  it("accepts areas within the relative tolerance", () => {
    expect(() => assertAreaClose(606, 600, 0.02)).not.toThrow();
    expect(() => assertAreaClose(0, 0, 0.05)).not.toThrow();
  });

  it("rejects areas beyond the relative tolerance", () => {
    expect(() => assertAreaClose(620, 600, 0.02)).toThrow(
      /not within 2% of the expected/,
    );
  });

  it("rejects a non-finite actual area", () => {
    expect(() => assertAreaClose(Number.NaN, 600, 0.02)).toThrow(
      /not a finite number/,
    );
    expect(() => assertAreaClose(Number.NEGATIVE_INFINITY, 600, 0.02)).toThrow(
      /not a finite number/,
    );
  });
});

describe("assertVolumeLessThan", () => {
  it("accepts a strict ordering", () => {
    expect(() => assertVolumeLessThan(500, 600)).not.toThrow();
  });

  it("rejects equality and inversion", () => {
    expect(() => assertVolumeLessThan(600, 600)).toThrow(/strictly less than/);
    expect(() => assertVolumeLessThan(700, 600)).toThrow(/strictly less than/);
  });
});

describe("assertTessellationValid", () => {
  const valid = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
  };

  it("accepts a minimal valid soup", () => {
    expect(() => assertTessellationValid(valid)).not.toThrow();
  });

  it("rejects position arrays not divisible by three", () => {
    expect(() =>
      assertTessellationValid({ positions: [0, 0], indices: [] }),
    ).toThrow(/positions length 2 is not divisible by 3/);
  });

  it("rejects index arrays not divisible by three", () => {
    expect(() =>
      assertTessellationValid({ positions: [0, 0, 0], indices: [0, 1] }),
    ).toThrow(/indices length 2 is not divisible by 3/);
  });

  it("rejects out-of-range indices", () => {
    expect(() =>
      assertTessellationValid({ positions: [0, 0, 0], indices: [0, 1, 3] }),
    ).toThrow(/outside the vertex range/);
  });

  it("rejects non-finite coordinates", () => {
    expect(() =>
      assertTessellationValid({
        positions: [0, 0, Number.NaN],
        indices: [0, 0, 0],
      }),
    ).toThrow(/not a finite number/);
  });

  it("rejects an empty soup when triangles are required", () => {
    expect(() =>
      assertTessellationValid({ positions: [], indices: [] }),
    ).toThrow(/empty but at least one triangle/);
  });

  it("allows an empty soup when triangles are not required", () => {
    expect(() =>
      assertTessellationValid(
        { positions: [], indices: [] },
        { requireTriangles: false },
      ),
    ).not.toThrow();
  });

  it("rejects vertices outside the supplied bounds", () => {
    expect(() =>
      assertTessellationValid(valid, {
        bounds: { min: [5, 5, 5], max: [10, 10, 10] },
      }),
    ).toThrow(/lies outside the bounds/);
  });

  it("accepts unit normals paired with positions", () => {
    expect(() =>
      assertTessellationValid({
        positions: valid.positions,
        indices: valid.indices,
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      }),
    ).not.toThrow();
  });

  it("rejects normals whose length does not match positions", () => {
    expect(() =>
      assertTessellationValid({
        positions: valid.positions,
        indices: valid.indices,
        normals: [0, 0, 1],
      }),
    ).toThrow(/does not match positions length/);
  });

  it("rejects non-finite normals", () => {
    expect(() =>
      assertTessellationValid({
        positions: valid.positions,
        indices: valid.indices,
        normals: [0, 0, Number.NaN, 0, 0, 1, 0, 0, 1],
      }),
    ).toThrow(/not a finite vector/);
  });

  it("rejects non-unit normals", () => {
    expect(() =>
      assertTessellationValid({
        positions: valid.positions,
        indices: valid.indices,
        normals: [0, 0, 0.7, 0, 0, 0.7, 0, 0, 0.7],
      }),
    ).toThrow(/not unit within/);
  });
});
