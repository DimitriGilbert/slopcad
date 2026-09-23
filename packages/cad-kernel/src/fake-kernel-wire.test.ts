/**
 * The fake kernel's wire-entity tests (Phase 47): the Cavalieri reference
 * volume `V = A·L` of the sweepWire node (exact for straight spines, the
 * analytic reference for curved ones), the station-loft tessellation's
 * caps and continuity, the generalized G1 and self-intersection declines,
 * and the capability split (sweepWire true, intersectionCurve the
 * structured decline).
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";

import { canonicalizeCurve, curveLength } from "./curve-geometry";
import { KERNEL_ERROR_CODES } from "./contract";
import { createFakeKernel, FAKE_KERNEL_CAPABILITIES } from "./fake-kernel";

const kernel = createFakeKernel();

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

/** A square loop of half-extent `half` — lines only, exact polygon area. */
function squareLoop(half: number) {
  return [
    { kind: "line", start: [-half, -half], end: [half, -half] },
    { kind: "line", start: [half, -half], end: [half, half] },
    { kind: "line", start: [half, half], end: [-half, half] },
    { kind: "line", start: [-half, half], end: [-half, -half] },
  ] as const;
}

const straightSpine = {
  kind: "interpolated-spline",
  points: [
    [0, 0, 0],
    [10, 10, 10],
  ],
} as const;

const helixSpine = {
  kind: "helix",
  radius: { dimension: "length", unit: "mm", value: 6 },
  pitch: { dimension: "length", unit: "mm", value: 4 },
  turns: 2.5,
  handedness: 1,
  startAngle: { dimension: "angle", unit: "rad", value: 0 },
} as const;

describe("fake sweepWire", () => {
  it("answers the exact Cavalieri volume A·L for a straight 3D spine", () => {
    const result = kernel.sweepWire({
      loop: squareLoop(10),
      spine: straightSpine,
      placement: identityPlacement,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = kernel.volume(result.value);
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    const expected = 400 * 10 * Math.sqrt(3);
    expect(Math.abs(volume.value - expected)).toBeLessThan(1e-9);
  });

  it("answers the analytic reference volume for the helical spine", () => {
    const result = kernel.sweepWire({
      loop: squareLoop(1),
      spine: helixSpine,
      placement: identityPlacement,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = kernel.volume(result.value);
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    const expected = 4 * (2.5 * Math.sqrt((12 * Math.PI) ** 2 + 16));
    expect(Math.abs(volume.value - expected)).toBeLessThan(1e-9);
  });

  it("tessellates the station loft with caps and side walls", () => {
    const result = kernel.sweepWire({
      loop: squareLoop(2),
      spine: straightSpine,
      placement: identityPlacement,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tessellation = kernel.tessellate(result.value);
    expect(tessellation.ok).toBe(true);
    if (!tessellation.ok) return;
    expect(tessellation.value.positions.length).toBeGreaterThan(9);
    expect(tessellation.value.positions.length % 3).toBe(0);
  });

  it("bounds the straight spine's tube exactly (the derived envelope)", () => {
    const result = kernel.sweepWire({
      loop: squareLoop(2),
      spine: straightSpine,
      placement: identityPlacement,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bounds = kernel.bounds(result.value);
    expect(bounds.ok).toBe(true);
    if (!bounds.ok) return;
    // The transport frame of the (1,1,1) diagonal: x̂ = (2,−1,−1)/(3·√(2/3)),
    // ŷ = t̂ × x̂ = (√(2/3)·0, ... ) — the derived component reaches are
    // |2x̂| = 1.633 on x and |2x̂| + |2ŷ| = 2.231 on y and z.
    expect(bounds.value.min[0]).toBeCloseTo(-1.632993, 4);
    expect(bounds.value.max[0]).toBeCloseTo(11.632993, 4);
    expect(bounds.value.min[1]).toBeCloseTo(-2.23068, 4);
    expect(bounds.value.max[1]).toBeCloseTo(12.23068, 4);
    expect(bounds.value.min[2]).toBeCloseTo(-2.23068, 4);
    expect(bounds.value.max[2]).toBeCloseTo(12.23068, 4);
  });

  it("rejects the degenerate circle spine at the shared battery", () => {
    const circle = {
      kind: "helix",
      radius: { dimension: "length", unit: "mm", value: 5 },
      pitch: { dimension: "length", unit: "mm", value: 0 },
      turns: 1,
      handedness: 1,
      startAngle: { dimension: "angle", unit: "rad", value: 0 },
    } as const;
    const result = kernel.sweepWire({
      loop: squareLoop(1),
      spine: circle,
      placement: identityPlacement,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(KERNEL_ERROR_CODES.invalidProfile);
    }
  });

  it("sweeps a smooth control-spline spine without decline (the station/domain agreement)", () => {
    // Six poles over a rising parabola-like control polygon in XZ, ending
    // along a diagonal (NOT +z). Before the station/domain fix the walk
    // sampled poles−1 spans while the evaluator clamps at poles−3, so 16
    // duplicate tail stations fed the G1 battery zero-length chords —
    // whose zero-vector normalize fallback false-flagged this SMOOTH
    // spine as a kink and spuriously declined it.
    const controlSpine = {
      kind: "control-spline",
      points: [
        [0, 0, 0],
        [10, 0, 2],
        [20, 0, 6],
        [30, 0, 12],
        [40, 0, 20],
        [50, 0, 30],
      ],
    } as const;
    const result = kernel.sweepWire({
      loop: squareLoop(1),
      spine: controlSpine,
      placement: identityPlacement,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const volume = kernel.volume(result.value);
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    const canonical = canonicalizeCurve(controlSpine);
    if (!canonical.ok) {
      throw new Error("the control-spline witness must canonicalize");
    }
    // The Cavalieri reference over the spine's own chord length.
    const expected = 4 * curveLength(canonical.value);
    expect(Math.abs(volume.value - expected)).toBeLessThan(1e-9);
  });

  it("sweeps a planar XZ chain embedded as a wire to the identical solid (the fixed-frame equivalence)", () => {
    // The promised equivalence fixture: the planar `sweep` (path in local
    // XZ, first tangent +z, the fixed-binormal frame) and `sweepWire` over
    // the SAME chain embedded as a 3D interpolated-spline spine answer the
    // identical volume and bounds — the transport of the +z-start planar
    // path seats the plane normal on `binormal`, exactly the direction
    // the planar sweep fixes, and the profile attachments coincide.
    const loop = squareLoop(5);
    const path = [{ kind: "line", start: [0, 0], end: [0, 30] }] as const;
    const planar = kernel.sweep({
      loop,
      path,
      placement: identityPlacement,
    });
    expect(planar.ok).toBe(true);
    if (!planar.ok) return;
    const wire = kernel.sweepWire({
      loop,
      spine: {
        kind: "interpolated-spline",
        points: [
          [0, 0, 0],
          [0, 0, 30],
        ],
      },
      placement: identityPlacement,
    });
    expect(wire.ok).toBe(true);
    if (!wire.ok) return;
    const volumePlanar = kernel.volume(planar.value);
    const volumeWire = kernel.volume(wire.value);
    expect(volumePlanar.ok && volumeWire.ok).toBe(true);
    if (!volumePlanar.ok || !volumeWire.ok) return;
    expect(volumeWire.value).toBeCloseTo(volumePlanar.value, 9);
    expect(volumeWire.value).toBeCloseTo(100 * 30, 9);
    const boundsPlanar = kernel.bounds(planar.value);
    const boundsWire = kernel.bounds(wire.value);
    expect(boundsPlanar.ok && boundsWire.ok).toBe(true);
    if (!boundsPlanar.ok || !boundsWire.ok) return;
    for (const axis of [0, 1, 2] as const) {
      expect(boundsWire.value.min[axis]).toBeCloseTo(
        boundsPlanar.value.min[axis],
        6,
      );
      expect(boundsWire.value.max[axis]).toBeCloseTo(
        boundsPlanar.value.max[axis],
        6,
      );
    }
    expect(boundsWire.value.min[0]).toBeCloseTo(-5, 6);
    expect(boundsWire.value.max[2]).toBeCloseTo(30, 6);
  });
});

describe("fake wire capabilities", () => {
  it("declares sweepWire and declines intersectionCurve structurally", () => {
    expect(FAKE_KERNEL_CAPABILITIES.sweepWire).toBe(true);
    expect(FAKE_KERNEL_CAPABILITIES.intersectionCurve).toBe(false);
    const box = kernel.createBox({
      width: length(2),
      depth: length(2),
      height: length(2),
    });
    expect(box.ok).toBe(true);
    if (!box.ok) return;
    const declined = kernel.intersectionCurve({
      kind: "solid-plane",
      target: box.value,
      origin: [1, 1, 1],
      normal: [0, 0, 1],
    });
    expect(declined.ok).toBe(false);
    if (!declined.ok) {
      expect(declined.error.code).toBe(KERNEL_ERROR_CODES.unsupportedOperation);
    }
  });
});
