/**
 * Fake-kernel loft-specific tests (Phase 26.4): the reference
 * implementation's honesty — Simpson-exact volumes over the ruled-morph
 * model (prism identity, similar-squares frustum, the twisted square's
 * closed form, piecewise multi-station), exact bounds (the station hull),
 * the morph-classification path through booleans, the canonical mesh's
 * triangle counts, and the placement composition.
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";

import {
  createFakeKernel,
  KERNEL_ERROR_CODES,
  type ProfileLoftSectionInput,
  tessellationTriangleCount,
} from "./index";
import {
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  unwrapKernelResult,
} from "./test-utils";

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

/** A centred CCW square section of the given side. */
function squareSection(side: number, z: number): ProfileLoftSectionInput {
  const h = side / 2;
  return {
    loop: [
      { kind: "line", start: [h, h], end: [-h, h] },
      { kind: "line", start: [-h, h], end: [-h, -h] },
      { kind: "line", start: [-h, -h], end: [h, -h] },
      { kind: "line", start: [h, -h], end: [h, h] },
    ],
    z: length(z),
  };
}

/** The square rotated 45° about the origin (the diamond), CCW from top. */
function diamondSection(side: number, z: number): ProfileLoftSectionInput {
  const r = (side / 2) * Math.SQRT2;
  return {
    loop: [
      { kind: "line", start: [0, r], end: [-r, 0] },
      { kind: "line", start: [-r, 0], end: [0, -r] },
      { kind: "line", start: [0, -r], end: [r, 0] },
      { kind: "line", start: [r, 0], end: [0, r] },
    ],
    z: length(z),
  };
}

/** The Simpson (prismoidal) value of the 10 mm square → 45° diamond morph. */
const TWISTED_SIMPSON_MM3 =
  (10 / 6) * (100 + 4 * 100 * Math.cos(Math.PI / 8) ** 2 + 100);

describe("fake kernel loft (the Simpson reference)", () => {
  it("lofts identical sections at the exact prism volume (the extrude identity)", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.loft({
        sections: [squareSection(10, 0), squareSection(10, 40)],
        placement: identityPlacement,
      }),
      "prism loft",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      100 * 40,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bounds"),
      { min: [-5, -5, 0], max: [5, 5, 40] },
      1e-9,
    );
  });

  it("lofts similar concentric squares at the exact frustum value", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.loft({
        sections: [squareSection(10, 0), squareSection(5, 10)],
        placement: identityPlacement,
      }),
      "frustum loft",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      (10 / 3) * (100 + 25 + 50),
      1e-9,
    );
  });

  it("lofts the twisted square at the exact Simpson value of the ruled morph", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.loft({
        sections: [squareSection(10, 0), diamondSection(10, 10)],
        placement: identityPlacement,
      }),
      "twisted loft",
    );
    // The ruled model's exact volume (probed identical on OCCT's ruled
    // ThruSections). The soup's flat walls carry the triangulated variant
    // — the candidate-soup honesty the leaf documents.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      TWISTED_SIMPSON_MM3,
      1e-9,
    );
    // Bounds stay exact either way: the station-vertex hull.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bounds"),
      {
        min: [-7.0710678118654755, -7.0710678118654755, 0],
        max: [7.0710678118654755, 7.0710678118654755, 10],
      },
      1e-9,
    );
  });

  it("lofts concentric circles inside the chord band of the conical frustum", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.loft({
        sections: [
          {
            loop: [{ kind: "circle", center: [0, 0], radius: 6 }],
            z: length(0),
          },
          {
            loop: [{ kind: "circle", center: [0, 0], radius: 3 }],
            z: length(10),
          },
        ],
        placement: identityPlacement,
      }),
      "circle loft",
    );
    // πh(R² + Rr + r²)/3 with the documented 63-chord deficit (measured
    // −0.166%, the same inscribed-polygon class every curved member of
    // the fake kernel carries).
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      (Math.PI * 10 * (36 + 18 + 9)) / 3,
      0.005,
    );
  });

  it("sums piecewise over multi-station spans", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.loft({
        sections: [
          squareSection(10, 0),
          squareSection(10, 10),
          squareSection(5, 20),
        ],
        placement: identityPlacement,
      }),
      "multi-station loft",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      100 * 10 + (10 / 6) * (100 + 4 * 56.25 + 25),
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bounds"),
      { min: [-5, -5, 0], max: [5, 5, 20] },
      1e-9,
    );
  });

  it("classifies through the morph polygon: subtracting a probe box removes its overlap", () => {
    const kernel = createFakeKernel();
    const loft = unwrapKernelResult(
      kernel.loft({
        sections: [squareSection(20, 0), squareSection(10, 10)],
        placement: identityPlacement,
      }),
      "tapered loft",
    );
    // A 4×4×10 box at the taper's wide corner: the morph at z has vertices
    // on the segment from (±10, ±10) to (±5, ±5), so the corner box
    // [6,10]×[6,10]×[0,10] lies half inside (up to where the section
    // shrinks past it) — the subtraction must strictly remove material,
    // exercising loftContains through the voxel path.
    const probe = unwrapKernelResult(
      kernel.transform(
        unwrapKernelResult(
          kernel.createBox({
            width: length(4),
            depth: length(4),
            height: length(10),
          }),
          "probe box",
        ),
        { x: length(6), y: length(6), z: length(0) },
      ),
      "probe placement",
    );
    const carved = unwrapKernelResult(
      kernel.subtract(loft, [probe]),
      "subtract",
    );
    const loftVolume = unwrapKernelResult(kernel.volume(loft), "loft volume");
    const carvedVolume = unwrapKernelResult(
      kernel.volume(carved),
      "carved volume",
    );
    expect(carvedVolume).toBeGreaterThan(0);
    expect(carvedVolume).toBeLessThan(loftVolume);
  });

  it("builds the canonical mesh: one quad per wall edge pair plus two cap fans", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.loft({
        sections: [squareSection(10, 0), squareSection(10, 10)],
        placement: identityPlacement,
      }),
      "prism loft",
    );
    const soup = unwrapKernelResult(kernel.tessellate(solid), "soup");
    // 4 edges × 2 wall triangles + 2 caps × (4 − 2) fan triangles = 12.
    expect(tessellationTriangleCount(soup)).toBe(12);
    assertTessellationValid(soup, {
      bounds: { min: [-5, -5, 0], max: [5, 5, 10] },
    });
    // Deterministic: the same solid tessellates to the same bytes.
    expect(unwrapKernelResult(kernel.tessellate(solid), "again")).toEqual(soup);
  });

  it("accepts CW-authored members identically (winding normalized per loop)", () => {
    const kernel = createFakeKernel();
    // Both squares walked clockwise (endpoints swapped, order reversed):
    // a valid closed CW loop normalizes to the identical CCW polygon, so
    // the loft is the prism — winding is a convention, not a rule. (A
    // CW member against a CCW member is legal too, but re-phases the
    // starting vertex one step — a 90° twist by the documented index
    // correspondence, a different solid, not a failure.)
    const cwSquare = (z: number) => {
      const ccw = squareSection(10, z).loop;
      const cwLoop = [...ccw]
        .reverse()
        .map((segment) =>
          segment.kind === "line"
            ? { ...segment, start: segment.end, end: segment.start }
            : segment,
        );
      return { loop: cwLoop, z: length(z) } satisfies ProfileLoftSectionInput;
    };
    const solid = unwrapKernelResult(
      kernel.loft({
        sections: [cwSquare(0), cwSquare(40)],
        placement: identityPlacement,
      }),
      "cw-authored loft",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      100 * 40,
      1e-9,
    );
  });

  it("places the loft with the composed rotation-then-translation", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.loft({
        sections: [
          {
            loop: [
              { kind: "line", start: [10, 10], end: [30, 10] },
              { kind: "line", start: [30, 10], end: [30, 25] },
              { kind: "line", start: [30, 25], end: [10, 25] },
              { kind: "line", start: [10, 25], end: [10, 10] },
            ],
            z: length(0),
          },
          {
            loop: [
              { kind: "line", start: [10, 10], end: [30, 10] },
              { kind: "line", start: [30, 10], end: [30, 25] },
              { kind: "line", start: [30, 25], end: [10, 25] },
              { kind: "line", start: [10, 25], end: [10, 10] },
            ],
            z: length(20),
          },
        ],
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
          translation: { x: length(5), y: length(5), z: length(0) },
        },
      }),
      "placed loft",
    );
    // Local (10,10)–(30,25) rotated 90° about z spans x ∈ [−25,−10],
    // y ∈ [10,30]; the translation shifts both.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "placed bounds"),
      { min: [-20, 15, 0], max: [-5, 35, 20] },
      1e-9,
    );
  });

  it("answers the structured collection codes with the shared battery's phrasing", () => {
    const kernel = createFakeKernel();
    // The fake kernel returns the shared validator's code and message
    // verbatim (prefixed by the operation name), exactly like the real
    // adapters — one battery, one phrasing, everywhere.
    const failure = kernel.loft({
      sections: [
        squareSection(10, 0),
        {
          loop: [{ kind: "circle", center: [0, 0], radius: 5 }],
          z: length(10),
        },
      ],
      placement: identityPlacement,
    });
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error.code).toBe(
        KERNEL_ERROR_CODES.loftIncompatibleProfiles,
      );
      expect(failure.error.message).toContain(
        "loft rejected the section collection",
      );
      expect(failure.error.message).toContain("vertex counts");
    }
  });
});
