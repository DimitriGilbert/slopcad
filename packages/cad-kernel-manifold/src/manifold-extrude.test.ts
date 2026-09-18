/**
 * Manifold adapter's extrude-specific tests (Phase 26.1): the probe-backed
 * behaviors the shared contract suite cannot pin per kernel — the
 * documented chord-fan deviation for curved profiles, the zero-area
 * degeneracy floor (self-intersection itself is NOT detected here — the
 * contract documents that rejection as resolution-side, in cad-sketch's
 * profile resolution), and the Mat4 placement convention probed during
 * the spike.
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

import { manifoldKernelFromRuntime } from "./manifold-kernel";
import {
  createManifoldRuntime,
  type ManifoldRuntime,
} from "./manifold-runtime";

let runtime: ManifoldRuntime;
let kernel: GeometryKernel;

beforeAll(async () => {
  runtime = await createManifoldRuntime();
  kernel = manifoldKernelFromRuntime(runtime);
});

function rectLoop(
  x0: number,
  y0: number,
  w: number,
  h: number,
): Parameters<GeometryKernel["extrude"]>[0]["loop"] {
  return [
    { kind: "line", start: [x0, y0], end: [x0 + w, y0] },
    { kind: "line", start: [x0 + w, y0], end: [x0 + w, y0 + h] },
    { kind: "line", start: [x0 + w, y0 + h], end: [x0, y0 + h] },
    { kind: "line", start: [x0, y0 + h], end: [x0, y0] },
  ];
}

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

describe("manifold extrude", () => {
  it("is exact for a straight-polygon profile", () => {
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: rectLoop(10, 10, 20, 15),
        height: length(10),
        direction: 1,
        placement: identityPlacement,
      }),
      "rectangle extrude",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      20 * 15 * 10,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bounds"),
      { min: [10, 10, 0], max: [30, 25, 10] },
      1e-9,
    );
  });

  it("deviates from the analytic disc by at most the documented chord-fan band (measured basis ≈0.166%)", () => {
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: [{ kind: "circle", center: [0, 0], radius: 20 }],
        height: length(10),
        direction: 1,
        placement: identityPlacement,
      }),
      "circle extrude",
    );
    const analytic = Math.PI * 20 ** 2 * 10;
    const measured = unwrapKernelResult(kernel.volume(solid), "circle volume");
    // Measured basis (see PROFILE_MAX_SEGMENT_ANGLE_RAD's derivation): the
    // shared tessellation resolves a full circle to n = ceil(2π/0.1) = 63
    // chords (Δ = 2π/63 ≈ 0.0997 rad), so the inscribed chord-polygon area
    // is sin(Δ)/Δ of the disc — a 0.1657% deficit (mid-chord radius deficit
    // 1 − cos(Δ/2) ≈ 1.24e-3). The band below keeps float headroom over
    // that measured deficit.
    assertVolumeClose(measured, analytic, 0.003);
    expect(measured).toBeLessThan(analytic);
    expect(measured).toBeGreaterThan(analytic * 0.998);
  });

  it("rejects a self-intersecting bowtie via the adapter's zero-area floor (self-intersection itself is resolution-side)", () => {
    // The bowtie quadrilateral tessellates to a zero-signed-area polygon,
    // so it trips the ADAPTER's own degeneracy floor — not Manifold, which
    // accepts crossing contours without throwing (probed). A crossing
    // contour with non-zero area (e.g. the arc×arc fixture) is rejected
    // upstream by cad-sketch's profile resolution instead; see
    // cad-sketch's profile.test.ts.
    const bowtie: Parameters<GeometryKernel["extrude"]>[0]["loop"] = [
      { kind: "line", start: [0, 0], end: [10, 10] },
      { kind: "line", start: [10, 10], end: [10, 0] },
      { kind: "line", start: [10, 0], end: [0, 10] },
      { kind: "line", start: [0, 10], end: [0, 0] },
    ];
    expectKernelFailure(
      kernel.extrude({
        loop: bowtie,
        height: length(10),
        direction: 1,
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidProfile,
      "self-intersecting bowtie",
    );
  });

  it("places the prism with a 90° rotation about z exactly (probed Mat4 convention)", () => {
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: rectLoop(0, 0, 10, 20),
        height: length(5),
        direction: 1,
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
          translation: { x: length(3), y: length(4), z: length(0) },
        },
      }),
      "rotated extrude",
    );
    // Local corners (0,0)…(10,20) rotate to x ∈ [-20,0], y ∈ [0,10];
    // translation by (3,4,0) shifts to x ∈ [-17,3], y ∈ [4,14].
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "rotated bounds"),
      { min: [-17, 4, 0], max: [3, 14, 5] },
      1e-6,
    );
  });

  it("extrudes the negative direction to z ∈ [-h, 0]", () => {
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: rectLoop(0, 0, 10, 10),
        height: length(4),
        direction: -1,
        placement: identityPlacement,
      }),
      "negative extrude",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "negative bounds"),
      { min: [0, 0, -4], max: [10, 10, 0] },
      1e-9,
    );
  });
});
