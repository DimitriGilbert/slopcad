/**
 * Manifold adapter's revolve-specific tests (Phase 26.2): the probe-backed
 * behaviors the shared contract suite cannot pin per kernel — the measured
 * inscribed-chord band of the 63-segment revolution (the revolve twin of
 * the extrude chord-fan deviation), the sweep-start convention (profile at
 * +x, CCW toward +y about the engine's z, rebased onto the contract's axis
 * frame), the mirrored −v-side profile, and the silent-clipping honesty:
 * Manifold.revolve keeps only the positive-radial part of a crossing
 * contour, so the crossing rejection must run BEFORE the engine.
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

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

function touchingRectangleRevolve(
  sweepRad: number,
): Parameters<GeometryKernel["revolve"]>[0] {
  return {
    loop: [
      { kind: "line", start: [0, 0], end: [30, 0] },
      { kind: "line", start: [30, 0], end: [30, 25] },
      { kind: "line", start: [30, 25], end: [0, 25] },
      { kind: "line", start: [0, 25], end: [0, 0] },
    ],
    axis: { point: [0, 0], direction: [1, 0] },
    angle: angle(sweepRad, "rad"),
    placement: identityPlacement,
  };
}

describe("manifold revolve", () => {
  it("deviates from the analytic cylinder by at most the documented chord band (measured ≈0.166%)", () => {
    const solid = unwrapKernelResult(
      kernel.revolve(touchingRectangleRevolve(Math.PI * 2)),
      "full revolve",
    );
    const analytic = Math.PI * 25 ** 2 * 30;
    const measured = unwrapKernelResult(kernel.volume(solid), "volume");
    // Same measured basis as the extrude chord-fan: the 63-segment
    // revolution is the inscribed isoprism, area sin(Δ)/Δ of the analytic
    // disc (Δ = 2π/63 ≈ 0.0997 rad → 0.1657% deficit). Probed: 58807.259
    // vs 58904.862 analytic.
    assertVolumeClose(measured, analytic, 0.003);
    expect(measured).toBeLessThan(analytic);
    expect(measured).toBeGreaterThan(analytic * 0.998);
  });

  it("sweeps the quarter turn into the +v/+w quadrant (probed sweep-start convention)", () => {
    const solid = unwrapKernelResult(
      kernel.revolve(touchingRectangleRevolve(Math.PI / 2)),
      "quarter revolve",
    );
    const analytic = (Math.PI * 25 ** 2 * 30) / 4;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "quarter volume"),
      analytic,
      0.001,
    );
    // The composed placement rebases the engine frame (profile at +x,
    // sweep CCW) onto the contract's axis frame: the quarter cylinder
    // occupies y ≥ 0, z ≥ 0. Quarter-turn vertices land on the extremes
    // exactly (probed), so identity-band bounds hold here.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "quarter bounds"),
      { min: [0, 0, 0], max: [30, 25, 25] },
      1e-6,
    );
  });

  it("half-turn volume is the full turn's half (partial sweep scales)", () => {
    const full = unwrapKernelResult(
      kernel.volume(
        unwrapKernelResult(
          kernel.revolve(touchingRectangleRevolve(Math.PI * 2)),
          "full",
        ),
      ),
      "full volume",
    );
    const half = unwrapKernelResult(
      kernel.volume(
        unwrapKernelResult(
          kernel.revolve(touchingRectangleRevolve(Math.PI)),
          "half",
        ),
      ),
      "half volume",
    );
    expect(Math.abs(half - full / 2) / (full / 2)).toBeLessThan(0.002);
  });

  it("revolves a −v-side profile identically (the mirror sweep convention)", () => {
    const solid = unwrapKernelResult(
      kernel.revolve({
        loop: [
          { kind: "line", start: [0, -25], end: [30, -25] },
          { kind: "line", start: [30, -25], end: [30, 0] },
          { kind: "line", start: [30, 0], end: [0, 0] },
          { kind: "line", start: [0, 0], end: [0, -25] },
        ],
        axis: { point: [0, 0], direction: [1, 0] },
        angle: angle(Math.PI * 2, "rad"),
        placement: identityPlacement,
      }),
      "negative-side revolve",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      Math.PI * 25 ** 2 * 30,
      0.003,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bounds"),
      { min: [0, -25, -25], max: [30, 25, 25] },
      0.05,
    );
  });

  it("keeps a legal touching profile's quarter turn on the +v side when the touch vertex rounds to −ε", () => {
    // Oblique axis [1,1] through the origin: a vertex authored at decimal
    // coordinates (0.1 + 0.2, 0.3) reads signed radial −5.6e-17 — legal
    // touching under REVOLVE_AXIS_TOUCH_TOLERANCE_MM, but below an exact
    // `>= 0` side test, which would append the π-rotated −v placement and
    // put the quarter turn at z ∈ [−10, 0] instead of [0, 10].
    const r = Math.SQRT1_2;
    const u: readonly [number, number] = [r, r];
    const v: readonly [number, number] = [-r, r];
    const along = (
      p: readonly [number, number],
      q: readonly [number, number],
      k: number,
    ): [number, number] => [p[0] + k * q[0], p[1] + k * q[1]];
    const p1: readonly [number, number] = [0.1 + 0.2, 0.3];
    const p2 = along(p1, u, 20);
    const p3 = along(p2, v, 10);
    const p4 = along(p1, v, 10);
    const loop: Parameters<GeometryKernel["revolve"]>[0]["loop"] = [
      { kind: "line", start: p1, end: p2 },
      { kind: "line", start: p2, end: p3 },
      { kind: "line", start: p3, end: p4 },
      { kind: "line", start: p4, end: p1 },
    ];
    const input = (sweepRad: number) => ({
      loop,
      axis: {
        point: [0, 0] as [number, number],
        direction: [1, 1] as [number, number],
      },
      angle: angle(sweepRad, "rad"),
      placement: identityPlacement,
    });
    const quarter = unwrapKernelResult(
      kernel.revolve(input(Math.PI / 2)),
      "touching quarter revolve",
    );
    // Straight-line profile: the Pappus value is exact (200 mm² at centroid
    // distance 5 mm, swept π/2).
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(quarter), "quarter volume"),
      200 * 5 * (Math.PI / 2),
      0.003,
    );
    const quarterBounds = unwrapKernelResult(
      kernel.bounds(quarter),
      "quarter bounds",
    );
    expect(quarterBounds.min[2]).toBeGreaterThanOrEqual(-1e-6);
    expect(quarterBounds.max[2]).toBeGreaterThan(9);
    // The full turn is placement-symmetric: unaffected by the side choice.
    const full = unwrapKernelResult(
      kernel.revolve(input(Math.PI * 2)),
      "touching full revolve",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(full), "full volume"),
      200 * 5 * Math.PI * 2,
      0.003,
    );
    const fullBounds = unwrapKernelResult(kernel.bounds(full), "full bounds");
    expect(fullBounds.min[2]).toBeLessThan(0);
    expect(fullBounds.max[2]).toBeGreaterThan(0);
  });

  it("rejects a crossing profile with the structured code BEFORE Manifold can silently clip it", () => {
    // Manifold.revolve would keep only the positive-radial part of this
    // contour without any diagnostic (probed, and stated in its API docs);
    // the shared validator must reject it first.
    const failure = expectKernelFailure(
      kernel.revolve({
        loop: [
          { kind: "line", start: [0, -10], end: [30, -10] },
          { kind: "line", start: [30, -10], end: [30, 25] },
          { kind: "line", start: [30, 25], end: [0, 25] },
          { kind: "line", start: [0, 25], end: [0, -10] },
        ],
        axis: { point: [0, 0], direction: [1, 0] },
        angle: angle(Math.PI * 2, "rad"),
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.profileAxisCrossing,
      "crossing revolve",
    );
    expect(failure.message).toContain("crosses");
  });
});
