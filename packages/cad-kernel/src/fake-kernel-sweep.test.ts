/**
 * Fake-kernel sweep-specific tests (Phase 26.3): the reference
 * implementation's honesty — Pappus-exact volumes (straight, offset,
 * mirrored, chained, closed ring), exact per-piece bounds, the canonical
 * mesh (deflection-pinned triangle counts, outward wall normals), the
 * contains() path through booleans, and the placement composition.
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";

import {
  createFakeKernel,
  KERNEL_ERROR_CODES,
  type ProfileSweepInput,
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

/** The 6×4 rectangular section centred on the path. */
function sectionLoop(): ProfileSweepInput["loop"] {
  return [
    { kind: "line", start: [-3, -2], end: [3, -2] },
    { kind: "line", start: [3, -2], end: [3, 2] },
    { kind: "line", start: [3, 2], end: [-3, 2] },
    { kind: "line", start: [-3, 2], end: [-3, -2] },
  ];
}

/** The CCW quarter-arc bend of radius 30 from the origin along +z. */
function quarterArcPath(): ProfileSweepInput["path"] {
  return [
    {
      kind: "arc",
      center: [-30, 0],
      radius: 30,
      startAngle: angle(0),
      endAngle: angle(Math.PI / 2),
    },
  ];
}

describe("fake kernel sweep (the analytic reference)", () => {
  it("sweeps a straight path at the exact Cavalieri volume and bounds", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: [{ kind: "line", start: [0, 0], end: [0, 40] }],
        placement: identityPlacement,
      }),
      "straight sweep",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      24 * 40,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bounds"),
      { min: [-3, -2, 0], max: [3, 2, 40] },
      1e-9,
    );
  });

  it("sweeps offset and mirrored profiles at the exact Pappus distances", () => {
    const kernel = createFakeKernel();
    // Centroid 2 mm toward the bend's outside: d̄ = 32.
    const offset = unwrapKernelResult(
      kernel.sweep({
        loop: [
          { kind: "line", start: [-1, -2], end: [5, -2] },
          { kind: "line", start: [5, -2], end: [5, 2] },
          { kind: "line", start: [5, 2], end: [-1, 2] },
          { kind: "line", start: [-1, 2], end: [-1, -2] },
        ],
        path: quarterArcPath(),
        placement: identityPlacement,
      }),
      "offset sweep",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(offset), "offset volume"),
      (Math.PI / 2) * 32 * 24,
      1e-9,
    );
    // A clockwise bend mirrors the family: same section, d̄ = 30.
    const mirrored = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: [
          {
            kind: "arc",
            center: [30, 0],
            radius: 30,
            startAngle: angle(Math.PI),
            endAngle: angle(Math.PI / 2),
          },
        ],
        placement: identityPlacement,
      }),
      "mirrored sweep",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(mirrored), "mirrored volume"),
      (Math.PI / 2) * 30 * 24,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(mirrored), "mirrored bounds"),
      { min: [-3, -2, 0], max: [30, 2, 33] },
      1e-9,
    );
    // The clockwise bend's winding: at the start corner (−3, −2, 0) the
    // three incident faces — the outer wall (u = −3), the side wall
    // (v = −2), and the start cap — carry the outward normals −x̂, −ŷ,
    // −ẑ; a wrongly-flipped mirror would answer +x̂ on the outer wall.
    // The arc wall's first quad tilts by up to half the station
    // deflection (~0.05 rad), so the axis matchers absorb that tilt.
    const soup = unwrapKernelResult(kernel.tessellate(mirrored), "soup");
    const positions = soup.positions;
    const normals = soup.normals ?? [];
    const atCorner: number[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] ?? 0;
      const y = positions[i + 1] ?? 0;
      const z = positions[i + 2] ?? 0;
      if (Math.abs(x + 3) < 1e-7 && Math.abs(y + 2) < 1e-7 && z < 1e-7) {
        atCorner.push(i);
      }
    }
    expect(atCorner.length).toBeGreaterThanOrEqual(3);
    const axisOutward = [false, false, false];
    for (const base of atCorner) {
      const nx = normals[base] ?? 0;
      const ny = normals[base + 1] ?? 0;
      const nz = normals[base + 2] ?? 0;
      if (nx < -0.95 && Math.abs(ny) < 0.01 && Math.abs(nz) < 0.1) {
        axisOutward[0] = true;
      }
      if (ny < -0.99 && Math.abs(nx) < 0.01 && Math.abs(nz) < 0.01) {
        axisOutward[1] = true;
      }
      if (nz < -0.99 && Math.abs(nx) < 0.01 && Math.abs(ny) < 0.01) {
        axisOutward[2] = true;
      }
    }
    expect(axisOutward).toEqual([true, true, true]);
  });

  it("sweeps the closed ring at the exact torus volume with uncapped walls", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: [
          {
            kind: "arc",
            center: [-30, 0],
            radius: 30,
            startAngle: angle(0),
            endAngle: angle(Math.PI * 2),
          },
        ],
        placement: identityPlacement,
      }),
      "ring sweep",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "ring volume"),
      Math.PI * 2 * 30 * 24,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "ring bounds"),
      { min: [-63, -2, -33], max: [3, 2, 33] },
      1e-9,
    );
    // Triangle count pins the mesh: 63 station intervals × 2 triangles per
    // polygon edge × 4 edges — walls only, a closed ring carries no caps.
    const soup = unwrapKernelResult(kernel.tessellate(solid), "ring soup");
    expect(tessellationTriangleCount(soup)).toBe(63 * 2 * 4);
  });

  it("builds the straight sweep's canonical mesh with outward wall normals", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: [{ kind: "line", start: [0, 0], end: [0, 40] }],
        placement: identityPlacement,
      }),
      "straight sweep",
    );
    const soup = unwrapKernelResult(kernel.tessellate(solid), "soup");
    // Walls (2 per polygon edge × 4) + two fan caps (2 each): 12.
    expect(tessellationTriangleCount(soup)).toBe(12);
    assertTessellationValid(soup, {
      bounds: { min: [-3, -2, 0], max: [3, 2, 40] },
    });
    // The +x wall's triangles carry the outward +x normal — the winding
    // honesty the fake kernel promises for every canonical mesh. The +x
    // wall is planar at x = 3 (all three corners there); cap triangles
    // keep at most two corners on that plane, so the all-three rule picks
    // exactly the wall's quad.
    expect(soup.normals).toBeDefined();
    const positions = soup.positions;
    const normals = soup.normals ?? [];
    let outwardWallTriangles = 0;
    for (let t = 0; t < soup.indices.length; t += 3) {
      const a = soup.indices[t];
      const b = soup.indices[t + 1];
      const c = soup.indices[t + 2];
      if (a === undefined || b === undefined || c === undefined) continue;
      const corners = [a, b, c];
      const onXWall = corners.every(
        (index) => Math.abs((positions[index * 3] ?? 0) - 3) <= 1e-9,
      );
      if (!onXWall) continue;
      outwardWallTriangles += 1;
      for (const index of corners) {
        expect(normals[index * 3] ?? 0).toBeCloseTo(1, 9);
        expect(normals[index * 3 + 1] ?? 0).toBeCloseTo(0, 9);
        expect(normals[index * 3 + 2] ?? 0).toBeCloseTo(0, 9);
      }
    }
    expect(outwardWallTriangles).toBe(2);
  });

  it("classifies swept material exactly through the boolean path", () => {
    const kernel = createFakeKernel();
    const swept = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: quarterArcPath(),
        placement: identityPlacement,
      }),
      "bend sweep",
    );
    // A box hull around the bend minus the tube: the voxel quadrature
    // exercises sweepContains on both piece kinds.
    const hull = unwrapKernelResult(
      kernel.createBox({
        width: length(40),
        depth: length(20),
        height: length(40),
      }),
      "hull box",
    );
    const moved = unwrapKernelResult(
      kernel.transform(hull, {
        x: length(-33),
        y: length(-10),
        z: length(-3),
      }),
      "place hull",
    );
    const carved = unwrapKernelResult(kernel.subtract(moved, [swept]), "carve");
    // Hull volume 32000 minus the tube's 360π — the estimation band the
    // fake kernel declares for curved boolean boundaries.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(carved), "carved volume"),
      40 * 20 * 40 - (Math.PI / 2) * 30 * 24,
      0.05,
    );
  });

  it("places the sweep: rotation first about the world origin, then translation", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: [{ kind: "line", start: [0, 0], end: [0, 40] }],
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
          translation: { x: length(5), y: length(5), z: length(0) },
        },
      }),
      "placed sweep",
    );
    // The straight tube rotated 90° about z spans x ∈ [−2−5, 2−5]… the
    // section's local x maps to world −y and local y to world +x: bounds
    // x ∈ [−2, 2]+5 → [3, 7], y ∈ [−3, 3]+5 → [2, 8], z ∈ [0, 40].
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "placed bounds"),
      { min: [3, 2, 0], max: [7, 8, 40] },
      1e-6,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "placed volume"),
      24 * 40,
      1e-9,
    );
  });

  it("bounds an asymmetric placed sweep by the rotation ROW support (not the inverse rotation's)", () => {
    const kernel = createFakeKernel();
    // Asymmetric section x ∈ [0,6], y ∈ [−2,2], straight +z path 40 mm,
    // placed rotated +90° about z and translated (5,5,0): local x maps to
    // world +y and local y to world −x, so the true placed AABB is
    // x ∈ [3,7], y ∈ [5,11], z ∈ [0,40]. Building the support direction
    // from the rotation matrix's COLUMN instead of its row would report the
    // AABB of the −90°-rotated solid — y ∈ [−1,5] — not even a
    // conservative container for material reaching y = 11.
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: [
          { kind: "line", start: [0, -2], end: [6, -2] },
          { kind: "line", start: [6, -2], end: [6, 2] },
          { kind: "line", start: [6, 2], end: [0, 2] },
          { kind: "line", start: [0, 2], end: [0, -2] },
        ],
        path: [{ kind: "line", start: [0, 0], end: [0, 40] }],
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
          translation: { x: length(5), y: length(5), z: length(0) },
        },
      }),
      "placed asymmetric sweep",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      6 * 4 * 40,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "placed bounds"),
      { min: [3, 5, 0], max: [7, 11, 40] },
      1e-6,
    );
    // The soup's own extents must agree with the reported box (the placed
    // walls reach y = 11, inside the reported bounds).
    const soup = unwrapKernelResult(kernel.tessellate(solid), "soup");
    assertTessellationValid(soup, {
      bounds: { min: [3, 5, 0], max: [7, 11, 40] },
      toleranceMm: 1e-6,
    });
  });

  it("keeps tessellations deterministic", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: [
          { kind: "line", start: [0, 0], end: [0, 20] },
          {
            kind: "arc",
            center: [-30, 20],
            radius: 30,
            startAngle: angle(0),
            endAngle: angle(Math.PI / 2),
          },
          { kind: "line", start: [-30, 50], end: [-50, 50] },
        ],
        placement: identityPlacement,
      }),
      "chained sweep",
    );
    const first = unwrapKernelResult(kernel.tessellate(solid), "first");
    const second = unwrapKernelResult(kernel.tessellate(solid), "second");
    expect(second).toEqual(first);
  });

  it("answers the structured path codes before any geometry exists", () => {
    const kernel = createFakeKernel();
    const failure = kernel.sweep({
      loop: sectionLoop(),
      path: [
        { kind: "line", start: [0, 0], end: [0, 20] },
        { kind: "line", start: [0, 20], end: [20, 20] },
      ],
      placement: identityPlacement,
    });
    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    expect(failure.error.code).toBe(KERNEL_ERROR_CODES.invalidPath);
    expect(failure.error.message).toContain("tangent discontinuity");
  });
});
