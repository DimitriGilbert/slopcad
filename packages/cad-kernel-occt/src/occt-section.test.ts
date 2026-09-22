/**
 * The Phase 46 `section` operation's fixtures on the REAL kernel: exact
 * BREP cuts whose cross-section areas and centroids are re-derived inline
 * analytically — a mid-height box cut (the rectangle W×D), a perpendicular
 * cylinder cut (the circle πr²), an OBLIQUE box cut (the rectangle
 * stretched by 1/cosθ through the wall), and a revolved plate cut (the
 * ring with its bore), plus the failure taxonomy (miss → section-empty,
 * keep-side flip → complementary cut) and the cut solid's own volume
 * anchor. Every expectation is a hand-derived formula of the inputs; no
 * call into the planner's own helpers.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { angle as angleValue, length } from "@slopcad/cad-core";
import { unwrapKernelResult } from "@slopcad/cad-kernel";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

describe("the OpenCascade kernel's section operation", () => {
  it("cuts a box at mid-height to the exact rectangle and centroid", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const W = 30;
    const D = 20;
    const H = 10;
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(W),
        depth: length(D),
        height: length(H),
      }),
    );
    const cut = unwrapKernelResult(
      kernel.section({
        target: box,
        origin: [length(0), length(0), length(H / 2)],
        normal: [0, 0, 1],
        keepSide: 1,
      }),
    );
    expect(cut.section.areaMm2).toBeCloseTo(W * D, 12);
    expect(cut.section.centroidMm[0]).toBeCloseTo(W / 2, 12);
    expect(cut.section.centroidMm[1]).toBeCloseTo(D / 2, 12);
    expect(cut.section.centroidMm[2]).toBeCloseTo(H / 2, 12);
    // The cut solid itself: the kept half's exact volume and bounds.
    const volume = unwrapKernelResult(kernel.volume(cut.solid));
    expect(volume).toBeCloseTo((W * D * H) / 2, 12);
    const bounds = unwrapKernelResult(kernel.bounds(cut.solid));
    expect(bounds.min[2]).toBeCloseTo(H / 2, 12);
    expect(bounds.max[2]).toBeCloseTo(H, 12);
  });

  it("flips the keep side to the complementary cut", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const W = 30;
    const D = 20;
    const H = 10;
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(W),
        depth: length(D),
        height: length(H),
      }),
    );
    const kept = unwrapKernelResult(
      kernel.section({
        target: box,
        origin: [length(0), length(0), length(H / 2)],
        normal: [0, 0, 1],
        keepSide: 1,
      }),
    );
    const flipped = unwrapKernelResult(
      kernel.section({
        target: box,
        origin: [length(0), length(0), length(H / 2)],
        normal: [0, 0, 1],
        keepSide: -1,
      }),
    );
    // Same face either way; the two cut solids sum to the whole box.
    expect(flipped.section.areaMm2).toBeCloseTo(kept.section.areaMm2, 12);
    const flippedVolume = unwrapKernelResult(kernel.volume(flipped.solid));
    expect(flippedVolume).toBeCloseTo((W * D * H) / 2, 12);
    const flippedBounds = unwrapKernelResult(kernel.bounds(flipped.solid));
    expect(flippedBounds.min[2]).toBeCloseTo(0, 12);
    expect(flippedBounds.max[2]).toBeCloseTo(H / 2, 12);
  });

  it("cuts a cylinder perpendicular to its axis to the exact circle", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const R = 5;
    const H = 20;
    const cylinder = unwrapKernelResult(
      kernel.createCylinder({ radius: length(R), height: length(H) }),
    );
    const cut = unwrapKernelResult(
      kernel.section({
        target: cylinder,
        origin: [length(0), length(0), length(H / 4)],
        normal: [0, 0, 1],
        keepSide: -1,
      }),
    );
    expect(cut.section.areaMm2).toBeCloseTo(Math.PI * R * R, 12);
    expect(cut.section.centroidMm[0]).toBeCloseTo(0, 12);
    expect(cut.section.centroidMm[1]).toBeCloseTo(0, 12);
    expect(cut.section.centroidMm[2]).toBeCloseTo(H / 4, 12);
  });

  it("cuts a box obliquely to the stretched rectangle", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const W = 30;
    const D = 20;
    const H = 10;
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(W),
        depth: length(D),
        height: length(H),
      }),
    );
    // A 45° plane through the box's centre parallel to x: in the y-z
    // rectangle [0,D]×[0,H] the line y + z = D/2 + H/2 runs from
    // (y=5, z=10) to (y=15, z=0) — length 10·√2 — so the section is the
    // rectangle W × 10√2.
    const cut = unwrapKernelResult(
      kernel.section({
        target: box,
        origin: [length(0), length(D / 2), length(H / 2)],
        normal: [0, 1, 1],
        keepSide: 1,
      }),
    );
    expect(cut.section.areaMm2).toBeCloseTo(W * 10 * Math.SQRT2, 12);
    // The centroid sits on the plane, centred in x.
    const n = [0, 1 / Math.SQRT2, 1 / Math.SQRT2] as const;
    const planeOffset =
      (cut.section.centroidMm[1] - D / 2) * n[0] +
      (cut.section.centroidMm[2] - H / 2) * n[1];
    expect(planeOffset).toBeCloseTo(0, 9);
    expect(cut.section.centroidMm[0]).toBeCloseTo(W / 2, 12);
  });

  it("measures a revolve cut's ring section (the plate with its bore)", () => {
    const kernel = occtKernelFromRuntime(runtime);
    // A washer revolved from a profile rectangle: outer R = 12, bore
    // r = 5, thickness 4 — the section at mid-thickness is the ring
    // π(R² − r²).
    const R = 12;
    const r = 5;
    const T = 4;
    const plate = unwrapKernelResult(
      kernel.revolve({
        loop: [
          { kind: "line", start: [r, 0], end: [R, 0] },
          { kind: "line", start: [R, 0], end: [R, T] },
          { kind: "line", start: [R, T], end: [r, T] },
          { kind: "line", start: [r, T], end: [r, 0] },
        ],
        axis: { point: [0, 0], direction: [0, 1] },
        angle: angleValue(Math.PI * 2),
        placement: {
          rotation: { axis: [0, 0, 1], angle: angleValue(0) },
          translation: { x: length(0), y: length(0), z: length(0) },
        },
      }),
    );
    const plateVolume = unwrapKernelResult(kernel.volume(plate));
    expect(plateVolume).toBeCloseTo(Math.PI * (R * R - r * r) * T, 9);
    // The revolve's axis is the profile-plane axis through the origin
    // along the loop's second coordinate — the washer stands with its
    // thickness along world y, so the ring section lies at y = T/2.
    const cut = unwrapKernelResult(
      kernel.section({
        target: plate,
        origin: [length(0), length(T / 2), length(0)],
        normal: [0, 1, 0],
        keepSide: 1,
      }),
    );
    expect(cut.section.areaMm2).toBeCloseTo(Math.PI * (R * R - r * r), 12);
    expect(cut.section.centroidMm[0]).toBeCloseTo(0, 9);
    expect(cut.section.centroidMm[1]).toBeCloseTo(T / 2, 12);
    expect(cut.section.centroidMm[2]).toBeCloseTo(0, 9);
  });

  it("refuses a plane that misses the target with section-empty", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
    );
    const missed = kernel.section({
      target: box,
      origin: [length(0), length(0), length(40)],
      normal: [0, 0, 1],
      keepSide: 1,
    });
    expect(missed.ok).toBe(false);
    if (!missed.ok) {
      expect(missed.error.code).toBe("kernel/section-empty");
    }
    const past = kernel.section({
      target: box,
      origin: [length(0), length(0), length(40)],
      normal: [0, 0, 1],
      keepSide: -1,
    });
    expect(past.ok).toBe(false);
    if (!past.ok) {
      expect(past.error.code).toBe("kernel/section-empty");
    }
  });

  it("refuses a zero normal with invalid-length", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
    );
    const degenerate = kernel.section({
      target: box,
      origin: [length(0), length(0), length(5)],
      normal: [0, 0, 0],
      keepSide: 1,
    });
    expect(degenerate.ok).toBe(false);
    if (!degenerate.ok) {
      expect(degenerate.error.code).toBe("kernel/invalid-length");
    }
  });
});
