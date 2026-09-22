/**
 * The JSCAD kernel's `section` fixtures (Phase 46): the same covering-box
 * composition Manifold runs, over this engine's own polygon-set booleans —
 * planar cuts exact over its mesh, the cylinder's circle in the engine's
 * documented chord band, and the structured section-empty refusal.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import { unwrapKernelResult } from "@slopcad/cad-kernel";

import { createJscadKernel } from "./jscad-kernel";

describe("the JSCAD kernel's section operation", () => {
  it("cuts a box at mid-height to the exact rectangle over its mesh", () => {
    const kernel = createJscadKernel();
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
    expect(cut.section.areaMm2).toBeCloseTo(W * D, 9);
    expect(cut.section.centroidMm[0]).toBeCloseTo(W / 2, 9);
    expect(cut.section.centroidMm[1]).toBeCloseTo(D / 2, 9);
    expect(cut.section.centroidMm[2]).toBeCloseTo(H / 2, 9);
  });

  it("cuts a cylinder perpendicular to its axis in its chord band", () => {
    const kernel = createJscadKernel();
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
    // The engine's cylinder is the 32-segment inscribed prism (the
    // documented −0.64% volume band), so the cap polygon sits inside
    // the contract suite's curved 5% band of πr².
    const analytic = Math.PI * R * R;
    expect(Math.abs(cut.section.areaMm2 - analytic) / analytic).toBeLessThan(
      0.05,
    );
  });

  it("refuses a plane that misses the target with section-empty", () => {
    const kernel = createJscadKernel();
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
});
