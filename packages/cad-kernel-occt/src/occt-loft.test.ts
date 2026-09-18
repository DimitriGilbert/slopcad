/**
 * OCCT adapter's loft-specific tests (Phase 26.4): the exact ruled-loft
 * honesty — `BRepOffsetAPI_ThruSections` in ruled mode over the exact
 * section wires gives the prismatic loft the prism volume, concentric
 * circles the exact conical frustum, the twisted square the exact
 * Simpson value of the ruled vertex morph, and multi-station collections
 * the piecewise sum — all at the exact band; the shared validation
 * battery rejects before any engine call.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import { type GeometryKernel, KERNEL_ERROR_CODES } from "@slopcad/cad-kernel";
import {
  assertBoundsEqual,
  assertVolumeClose,
  expectKernelFailure,
  unwrapKernelResult,
} from "@slopcad/cad-kernel/test-utils";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;
let kernel: GeometryKernel;

beforeAll(async () => {
  runtime = await createOcctRuntime();
  kernel = occtKernelFromRuntime(runtime);
});

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

/** A centred CCW square section of the given side. */
function squareSection(side: number, z: number) {
  const h = side / 2;
  return {
    loop: [
      {
        kind: "line" as const,
        start: [h, h] as [number, number],
        end: [-h, h] as [number, number],
      },
      {
        kind: "line" as const,
        start: [-h, h] as [number, number],
        end: [-h, -h] as [number, number],
      },
      {
        kind: "line" as const,
        start: [-h, -h] as [number, number],
        end: [h, -h] as [number, number],
      },
      {
        kind: "line" as const,
        start: [h, -h] as [number, number],
        end: [h, h] as [number, number],
      },
    ],
    z: length(z),
  };
}

/** The square rotated 45° about the origin (the diamond), CCW from top. */
function diamondSection(side: number, z: number) {
  const r = (side / 2) * Math.SQRT2;
  return {
    loop: [
      {
        kind: "line" as const,
        start: [0, r] as [number, number],
        end: [-r, 0] as [number, number],
      },
      {
        kind: "line" as const,
        start: [-r, 0] as [number, number],
        end: [0, -r] as [number, number],
      },
      {
        kind: "line" as const,
        start: [0, -r] as [number, number],
        end: [r, 0] as [number, number],
      },
      {
        kind: "line" as const,
        start: [r, 0] as [number, number],
        end: [0, r] as [number, number],
      },
    ],
    z: length(z),
  };
}

describe("occt loft (exact ruled loft)", () => {
  it("lofts identical squares into the exact prism", () => {
    const solid = unwrapKernelResult(
      kernel.loft({
        sections: [squareSection(10, 0), squareSection(10, 40)],
        placement: identityPlacement,
      }),
      "prism loft",
    );
    // The probe result, pinned: area × height exactly (float noise only).
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "prism volume"),
      100 * 40,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "prism bounds"),
      { min: [-5, -5, 0], max: [5, 5, 40] },
      1e-6,
    );
  });

  it("lofts concentric circles into the exact conical frustum", () => {
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
      "frustum loft",
    );
    // Probed at −3.4e-16 relative: the ruled loft between exact circle
    // wires is the exact conical frustum πh(R² + Rr + r²)/3.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "frustum volume"),
      (Math.PI * 10 * (36 + 18 + 9)) / 3,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "frustum bounds"),
      { min: [-6, -6, 0], max: [6, 6, 10] },
      1e-6,
    );
  });

  it("lofts the twisted square at the exact Simpson value of the ruled morph", () => {
    const solid = unwrapKernelResult(
      kernel.loft({
        sections: [squareSection(10, 0), diamondSection(10, 10)],
        placement: identityPlacement,
      }),
      "twisted loft",
    );
    // The probe result, pinned EXACTLY (measured 0 relative error): the
    // ruled surfaces between the skew walls reproduce the bilinear morph
    // whose Simpson value is h/6·(A + 4·A_mid + A). This is the fixture
    // where flat-wall mesh kernels diverge (documented per kernel) —
    // OCCT is the exact reference for the ruled model.
    const simpson =
      (10 / 6) * (100 + 4 * 100 * Math.cos(Math.PI / 8) ** 2 + 100);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "twisted volume"),
      simpson,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "twisted bounds"),
      {
        min: [-7.0710678118654755, -7.0710678118654755, 0],
        max: [7.0710678118654755, 7.0710678118654755, 10],
      },
      1e-6,
    );
  });

  it("lofts the re-phased square at the index morph's Simpson value (the adapter-enforced correspondence)", () => {
    const solid = unwrapKernelResult(
      kernel.loft({
        sections: [
          squareSection(10, 0),
          {
            // The same square with its first boundary vertex rotated one
            // position: identical segment structure, authored phase shift.
            loop: [
              {
                kind: "line" as const,
                start: [-5, 5] as [number, number],
                end: [-5, -5] as [number, number],
              },
              {
                kind: "line" as const,
                start: [-5, -5] as [number, number],
                end: [5, -5] as [number, number],
              },
              {
                kind: "line" as const,
                start: [5, -5] as [number, number],
                end: [5, 5] as [number, number],
              },
              {
                kind: "line" as const,
                start: [5, 5] as [number, number],
                end: [-5, 5] as [number, number],
              },
            ],
            z: length(10),
          },
        ],
        placement: identityPlacement,
      }),
      "re-phased loft",
    );
    // PINNED (the validator's probe): ThruSections' own compatibility
    // pass re-origins wire 2 on the PHASE shift alone — identical segment
    // structure — silently de-twisting this loft to the prism (measured
    // 1000.0000000000001 mm³). The adapter disables the pass on
    // equal-structure collections, so the authored order rules: vertex
    // (5,5) morphs to (−5,5) &c, the quarter turn whose mid-section is
    // the 5 mm diamond (area 50) and whose Simpson value is
    // h/6·(100 + 4·50 + 100) = 2000/3.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "re-phased volume"),
      2000 / 3,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "re-phased bounds"),
      { min: [-5, -5, 0], max: [5, 5, 10] },
      1e-6,
    );
  });

  it("accepts CW-authored members through the adapter's CCW normalization", () => {
    // Both squares walked clockwise (endpoints swapped, order reversed).
    // With the compatibility pass off the engine no longer reconciles
    // winding — a CW member against a CCW one silently builds an EMPTY
    // solid (probed volume 0) — so the adapter carries every authored-CW
    // wire REVERSED: the wire-level form of the CCW normalization the
    // contract's chord polygons apply.
    const cwSquare = (z: number) => {
      const ccw = squareSection(10, z).loop;
      const cwLoop = [...ccw]
        .reverse()
        .map((segment) =>
          segment.kind === "line"
            ? { ...segment, start: segment.end, end: segment.start }
            : segment,
        );
      return { loop: cwLoop, z: length(z) };
    };
    const prism = unwrapKernelResult(
      kernel.loft({
        sections: [cwSquare(0), cwSquare(10)],
        placement: identityPlacement,
      }),
      "cw-authored loft",
    );
    // CW + CW normalizes to the identical CCW polygons: the prism.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(prism), "cw prism volume"),
      100 * 10,
      1e-9,
    );
    // A CW member against a CCW member is legal and re-phases the
    // starting vertex one step — the 90° twist by the documented index
    // correspondence (the reference kernel's semantics, a different solid,
    // not a failure and never an empty one).
    const twisted = unwrapKernelResult(
      kernel.loft({
        sections: [cwSquare(0), squareSection(10, 10)],
        placement: identityPlacement,
      }),
      "mixed-winding loft",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(twisted), "mixed-winding volume"),
      2000 / 3,
      1e-9,
    );
  });

  it("lofts three stations at the piecewise exact sum", () => {
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
    // Prism span then similar-squares frustum span — probed at 0 relative
    // error: ruled mode joins per span, never smoothing across stations.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "multi-station volume"),
      100 * 10 + (10 / 6) * (100 + 4 * 56.25 + 25),
      1e-9,
    );
  });

  it("rejects the structured collection battery before any engine call", () => {
    expectKernelFailure(
      kernel.loft({ sections: [], placement: identityPlacement }),
      KERNEL_ERROR_CODES.invalidOperands,
      "empty section list",
    );
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
    // The mismatch never reaches ThruSections' own compatibility pass —
    // the rejection is the contract's, not the engine's.
    expect(incompatible.message).toContain("vertex counts");
    expectKernelFailure(
      kernel.loft({
        sections: [squareSection(10, 0), squareSection(10, 0)],
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.loftUnorderedStations,
      "equal stations",
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
});
