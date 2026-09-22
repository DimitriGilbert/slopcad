/**
 * The fake kernel's `section` fixtures (Phase 46): the analytic
 * cross-section model over the pristine-box subset — exact rectangle and
 * oblique areas/centroids re-derived inline, the cut solid riding the
 * split composition's own boolean semantics, the subset decline for
 * non-box targets, and the section-empty refusal for a missing plane.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";

import { createFakeKernel } from "./fake-kernel";
import { unwrapKernelResult } from "./test-utils";

describe("the fake kernel's section operation", () => {
  it("cuts a pristine box at mid-height to the exact rectangle", () => {
    const kernel = createFakeKernel();
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
    // The cut solid is the split composition's subtract node: the kept
    // half's volume answers at the kernel's documented voxel-quadrature
    // band, close to the analytic half.
    const volume = unwrapKernelResult(kernel.volume(cut.solid));
    expect(volume).toBeGreaterThan((W * D * H) / 2 - 1);
    expect(volume).toBeLessThan((W * D * H) / 2 + 1);
  });

  it("cuts a pristine box obliquely to the stretched rectangle", () => {
    const kernel = createFakeKernel();
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
    // The 45° plane through the centre parallel to x: in the y-z
    // rectangle the line y + z = 15 runs from (5, 10) to (15, 0) —
    // length 10·√2 — so the section is W × 10√2, its centroid the
    // segment's midpoint swept along x.
    const cut = unwrapKernelResult(
      kernel.section({
        target: box,
        origin: [length(0), length(D / 2), length(H / 2)],
        normal: [0, 1, 1],
        keepSide: 1,
      }),
    );
    expect(cut.section.areaMm2).toBeCloseTo(W * 10 * Math.SQRT2, 12);
    expect(cut.section.centroidMm[0]).toBeCloseTo(W / 2, 12);
    expect(cut.section.centroidMm[1]).toBeCloseTo(10, 12);
    expect(cut.section.centroidMm[2]).toBeCloseTo(5, 12);
  });

  it("flips the keep side to the same face either way", () => {
    const kernel = createFakeKernel();
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
    );
    const kept = unwrapKernelResult(
      kernel.section({
        target: box,
        origin: [length(0), length(0), length(5)],
        normal: [0, 0, 1],
        keepSide: 1,
      }),
    );
    const flipped = unwrapKernelResult(
      kernel.section({
        target: box,
        origin: [length(0), length(0), length(5)],
        normal: [0, 0, 1],
        keepSide: -1,
      }),
    );
    expect(flipped.section.areaMm2).toBeCloseTo(kept.section.areaMm2, 12);
    expect(flipped.section.centroidMm).toEqual(kept.section.centroidMm);
  });

  it("declines a non-box target naming the subset", () => {
    const kernel = createFakeKernel();
    const cylinder = unwrapKernelResult(
      kernel.createCylinder({ radius: length(5), height: length(20) }),
    );
    const declined = kernel.section({
      target: cylinder,
      origin: [length(0), length(0), length(5)],
      normal: [0, 0, 1],
      keepSide: 1,
    });
    expect(declined.ok).toBe(false);
    if (!declined.ok) {
      expect(declined.error.code).toBe("kernel/unsupported-operation");
      expect(declined.error.message).toContain("pristine-box");
    }
  });

  it("refuses a plane that misses the box with section-empty", () => {
    const kernel = createFakeKernel();
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
  });

  it("refuses a zero normal with invalid-length", () => {
    const kernel = createFakeKernel();
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
