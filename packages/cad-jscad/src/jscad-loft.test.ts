/**
 * JSCAD adapter's loft-specific tests (Phase 26.4): the slice-loft
 * honesty — planar-wall lofts (the prism, the frustum family, the
 * multi-station piecewise sum) agree with the fake kernel's Simpson
 * reference to float noise over the SAME chord vertices; curved members
 * sit inside the documented chord band; and the twisted square carries
 * the probed flat-wall divergence (its skew walls cannot flatten), pinned
 * here per kernel — never cross-kernel.
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  createFakeKernel,
  KERNEL_ERROR_CODES,
  type ProfileLoftInput,
  type ProfileLoftSectionInput,
} from "@slopcad/cad-kernel";
import {
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  expectKernelFailure,
  unwrapKernelResult,
} from "@slopcad/cad-kernel/test-utils";

import { createJscadKernel } from "./jscad-kernel";

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

/** The reference (fake kernel) volume of the same loft input (mm³). */
function referenceVolume(input: ProfileLoftInput): number {
  const fake = createFakeKernel();
  const solid = unwrapKernelResult(fake.loft(input), "fake loft");
  return unwrapKernelResult(fake.volume(solid), "fake volume");
}

describe("jscad loft (slice loft)", () => {
  it("lofts identical squares into the exact prism, agreeing with the reference", () => {
    const kernel = createJscadKernel();
    const input: ProfileLoftInput = {
      sections: [squareSection(10, 0), squareSection(10, 40)],
      placement: identityPlacement,
    };
    const solid = unwrapKernelResult(kernel.loft(input), "prism loft");
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "prism volume"),
      100 * 40,
      1e-9,
    );
    // The planar walls are exact over the same chord vertices as the fake
    // kernel's Simpson model (probed agreement at float noise).
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "prism volume"),
      referenceVolume(input),
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "prism bounds"),
      { min: [-5, -5, 0], max: [5, 5, 40] },
      1e-9,
    );
  });

  it("lofts concentric circles inside the chord band of the analytic frustum", () => {
    const kernel = createJscadKernel();
    const input: ProfileLoftInput = {
      sections: [
        { loop: [{ kind: "circle", center: [0, 0], radius: 6 }], z: length(0) },
        {
          loop: [{ kind: "circle", center: [0, 0], radius: 3 }],
          z: length(10),
        },
      ],
      placement: identityPlacement,
    };
    const solid = unwrapKernelResult(kernel.loft(input), "frustum loft");
    // πh(R² + Rr + r²)/3 within the documented 63-chord band (measured
    // −0.166%, the same inscribed-polygon class as every curved member).
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "frustum volume"),
      (Math.PI * 10 * (36 + 18 + 9)) / 3,
      0.05,
    );
    // And exactly the chord-polygon value the fake kernel computes (the
    // trapezoid walls between corresponding chords are planar — probed
    // agreement at 1e-12 relative).
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "frustum volume"),
      referenceVolume(input),
      1e-9,
    );
    const soup = unwrapKernelResult(kernel.tessellate(solid), "frustum soup");
    assertTessellationValid(soup, {
      bounds: { min: [-6, -6, 0], max: [6, 6, 10] },
      toleranceMm: 0.05,
    });
  });

  it("lofts the twisted square into the flat-wall solid — the probed divergence", () => {
    const kernel = createJscadKernel();
    const solid = unwrapKernelResult(
      kernel.loft({
        sections: [squareSection(10, 0), diamondSection(10, 10)],
        placement: identityPlacement,
      }),
      "twisted loft",
    );
    // PROBED, per kernel: a skew wall's bilinear patch cannot flatten, so
    // extrudeFromSlices' two flat triangles per wall build the flat-wall
    // solid — 2000/3 mm³ on this fixture (the square-antiprism family),
    // NOT the ruled model's Simpson value 902.37 mm³ that OCCT reaches
    // exactly. The bounds still agree (the station-vertex hull).
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "twisted volume"),
      2000 / 3,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "twisted bounds"),
      {
        min: [-7.0710678118654755, -7.0710678118654755, 0],
        max: [7.0710678118654755, 7.0710678118654755, 10],
      },
      1e-9,
    );
  });

  it("lofts three stations at the piecewise sum, agreeing with the reference", () => {
    const kernel = createJscadKernel();
    const input: ProfileLoftInput = {
      sections: [
        squareSection(10, 0),
        squareSection(10, 10),
        squareSection(5, 20),
      ],
      placement: identityPlacement,
    };
    const solid = unwrapKernelResult(kernel.loft(input), "multi-station loft");
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "multi-station volume"),
      100 * 10 + (10 / 6) * (100 + 4 * 56.25 + 25),
      1e-9,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "multi-station volume"),
      referenceVolume(input),
      1e-9,
    );
  });

  it("places the loft with the composed rotation-then-translation", () => {
    const kernel = createJscadKernel();
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
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "placed bounds"),
      { min: [-20, 15, 0], max: [-5, 35, 20] },
      1e-6,
    );
  });

  it("answers the structured collection codes before any JSCAD work", () => {
    const kernel = createJscadKernel();
    // The 26.1 lesson, pinned: the library's own mismatch behaviour
    // (repartition to the LCM edge count, probed in the library source)
    // must NEVER run — the contract's compatibility rejection answers
    // first.
    const incompatible = expectKernelFailure(
      kernel.loft({
        sections: [
          squareSection(10, 0),
          {
            loop: [{ kind: "circle", center: [0, 0], radius: 5 }],
            z: length(10),
          },
        ],
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.loftIncompatibleProfiles,
      "square-to-circle mismatch",
    );
    expect(incompatible.message).toContain("vertex counts");
    expectKernelFailure(
      kernel.loft({ sections: [], placement: identityPlacement }),
      KERNEL_ERROR_CODES.invalidOperands,
      "empty section list",
    );
    expectKernelFailure(
      kernel.loft({
        sections: [squareSection(10, 10), squareSection(10, 5)],
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.loftUnorderedStations,
      "fold-back stations",
    );
    expectKernelFailure(
      kernel.loft({
        sections: [
          {
            ...squareSection(10, 0),
            loop: squareSection(10, 0).loop.slice(0, 3),
          },
          squareSection(10, 10),
        ],
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidProfile,
      "open member loop",
    );
  });

  it("builds identical lofts in fresh kernel instances", () => {
    const build = (): readonly number[] => {
      const kernel = createJscadKernel();
      const solid = unwrapKernelResult(
        kernel.loft({
          sections: [squareSection(10, 0), squareSection(5, 12)],
          placement: identityPlacement,
        }),
        "tapered loft",
      );
      return unwrapKernelResult(kernel.tessellate(solid), "soup").positions;
    };
    const first = build();
    const second = build();
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });
});
