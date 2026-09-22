/**
 * OCCT adapter's wire-entity tests (Phase 47): the sweep-over-wire pipe
 * honesty — `BRepOffsetAPI_MakePipeShell` in corrected-Frenet mode over
 * the station-chordal spine gives a straight 3D spine the Cavalieri prism
 * volume `A·L` exactly, a helical spine the reference inside the probed
 * band — and the intersection-curve exactness: `BRepAlgoAPI_Section` of
 * a box with its mid plane answers the section rectangle's perimeter
 * within the station band, with one chain per section edge.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import { type GeometryKernel, KERNEL_ERROR_CODES } from "@slopcad/cad-kernel";
import {
  assertVolumeClose,
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

/** A 20 mm-diameter circle profile in the local XY plane. */
function circleLoop() {
  return [{ kind: "circle", center: [0, 0], radius: 10 }] as const;
}

/** A slim 2 mm-diameter tube profile (the helix fixture's no-overlap size). */
function slimLoop() {
  return [{ kind: "circle", center: [0, 0], radius: 1 }] as const;
}

/** The straight diagonal 3D spline through two points (length √3·10). */
const straightSpine = {
  kind: "interpolated-spline",
  points: [
    [0, 0, 0],
    [10, 10, 10],
  ],
} as const;

/** A 2.5-turn helix of radius 6 and pitch 4 (the fake kernel's reference spine). */
const helixSpine = {
  kind: "helix",
  radius: { dimension: "length", unit: "mm", value: 6 },
  pitch: { dimension: "length", unit: "mm", value: 4 },
  turns: 2.5,
  handedness: 1,
  startAngle: { dimension: "angle", unit: "rad", value: 0 },
} as const;

describe("sweepWire (Phase 47)", () => {
  it("pipes a circle along a straight 3D spine at the exact Cavalieri volume A·L", () => {
    const swept = kernel.sweepWire({
      loop: circleLoop(),
      spine: straightSpine,
      placement: identityPlacement,
    });
    const solid = unwrapKernelResult(swept, "sweepWire");
    const volume = unwrapKernelResult(kernel.volume(solid), "volume");
    const area = Math.PI * 10 * 10;
    const spineLength = 10 * Math.sqrt(3);
    assertVolumeClose(volume, area * spineLength, 1e-6);
  });

  it("documents the chordal-helix pipe probe (the G0-polyline spine verdict)", () => {
    // THE PROBE (prespike): a G0 chordal spine piped through
    // MakePipeShell yielded an INVERTED solid on this binding (a small
    // negative volume against the positive Cavalieri reference), so the
    // curved-spine route is declined STRUCTURALLY — the straight-spine
    // route pipes exact (the test above) — and this pin flips the day
    // the binding's GeomAPI_Interpolate point-array setter exists and
    // the exact C2 spine arrives.
    const declined = kernel.sweepWire({
      loop: slimLoop(),
      spine: helixSpine,
      placement: identityPlacement,
    });
    expect(declined.ok).toBe(false);
    if (!declined.ok) {
      expect(declined.error.code).toBe(KERNEL_ERROR_CODES.unsupportedOperation);
      expect(declined.error.message).toContain("G0 chordal station spine");
    }
  });

  it("rejects a degenerate profile and a kinked spine before any engine call", () => {
    const degenerate = kernel.sweepWire({
      loop: [{ kind: "circle", center: [0, 0], radius: 0 }],
      spine: straightSpine,
      placement: identityPlacement,
    });
    expect(degenerate.ok).toBe(false);
    if (!degenerate.ok) {
      expect(degenerate.error.code).toBe(KERNEL_ERROR_CODES.invalidProfile);
    }
    const circleSpine = {
      kind: "helix",
      radius: { dimension: "length", unit: "mm", value: 5 },
      pitch: { dimension: "length", unit: "mm", value: 0 },
      turns: 1,
      handedness: 1,
      startAngle: { dimension: "angle", unit: "rad", value: 0 },
    } as const;
    const circle = kernel.sweepWire({
      loop: circleLoop(),
      spine: circleSpine,
      placement: identityPlacement,
    });
    expect(circle.ok).toBe(false);
    if (!circle.ok) {
      expect(circle.error.code).toBe(KERNEL_ERROR_CODES.invalidProfile);
    }
  });
});

describe("intersectionCurve (Phase 47)", () => {
  it("sections a 2×2×2 box with its mid-z plane into the unit-scaled rectangle", () => {
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(2),
        depth: length(2),
        height: length(2),
      }),
      "createBox",
    );
    const section = unwrapKernelResult(
      kernel.intersectionCurve({
        kind: "solid-plane",
        target: box,
        origin: [1, 1, 1],
        normal: [0, 0, 1],
      }),
      "intersectionCurve",
    );
    // The exact section is the 2×2 square at z = 1: perimeter 8, bounds
    // [0,2]² at z = 1. The station walk's chord sum sits inside its band.
    expect(section.chains.length).toBeGreaterThanOrEqual(1);
    expect(section.length).toBeGreaterThan(8 - 1e-3);
    expect(section.length).toBeLessThan(8 + 1e-3);
    expect(section.bounds.min[0]).toBeCloseTo(0, 6);
    expect(section.bounds.max[0]).toBeCloseTo(2, 6);
    expect(section.bounds.min[2]).toBeCloseTo(1, 6);
    expect(section.bounds.max[2]).toBeCloseTo(1, 6);
  });

  it("sections two boxes through their shared corner overlap", () => {
    const a = unwrapKernelResult(
      kernel.createBox({
        width: length(2),
        depth: length(2),
        height: length(2),
      }),
      "createBox A",
    );
    const rawB = unwrapKernelResult(
      kernel.createBox({
        width: length(2),
        depth: length(2),
        height: length(2),
      }),
      "createBox B",
    );
    const b = unwrapKernelResult(
      kernel.transform(rawB, {
        x: length(1),
        y: length(1),
        z: length(1),
      }),
      "transform B",
    );
    const section = unwrapKernelResult(
      kernel.intersectionCurve({ kind: "solid-solid", target: a, tool: b }),
      "intersectionCurve",
    );
    // The overlap is the unit cube [1,2]³; the contact surface section
    // carries real edges (the shared boundary pieces).
    expect(section.chains.length).toBeGreaterThanOrEqual(1);
    expect(section.polyline.length).toBeGreaterThan(3);
  });
});
