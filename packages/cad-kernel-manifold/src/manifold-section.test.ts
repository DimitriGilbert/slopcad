/**
 * The Manifold kernel's `section` fixtures (Phase 46): the covering-box
 * composition the roadmap rules this engine CAN run — planar cuts exact
 * over its own mesh (the box's cap rectangle), the cylinder's circle in
 * the engine's own discretization band, and the structured section-empty
 * refusal for a missing plane.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import { unwrapKernelResult } from "@slopcad/cad-kernel";

import { manifoldKernelFromRuntime } from "./manifold-kernel";
import {
  createManifoldRuntime,
  type ManifoldRuntime,
} from "./manifold-runtime";

let runtime: ManifoldRuntime;

beforeAll(async () => {
  runtime = await createManifoldRuntime();
});

describe("the Manifold kernel's section operation", () => {
  it("cuts a box at mid-height to the exact rectangle over its mesh", () => {
    const kernel = manifoldKernelFromRuntime(runtime);
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
    // The cut solid is an exact engine boolean: the kept half's volume
    // is exact over the mesh.
    const volume = unwrapKernelResult(kernel.volume(cut.solid));
    expect(volume).toBeCloseTo((W * D * H) / 2, 9);
  });

  it("cuts a cylinder perpendicular to its axis in its discretization band", () => {
    const kernel = manifoldKernelFromRuntime(runtime);
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
    // The engine's own boundary is the meshed cylinder, so the cap is
    // the inscribed polygon of the mesh's own segment count — within
    // the contract suite's curved 5% band of πr².
    const analytic = Math.PI * R * R;
    expect(Math.abs(cut.section.areaMm2 - analytic) / analytic).toBeLessThan(
      0.05,
    );
    expect(cut.section.centroidMm[0]).toBeCloseTo(0, 6);
    expect(cut.section.centroidMm[1]).toBeCloseTo(0, 6);
    expect(cut.section.centroidMm[2]).toBeCloseTo(H / 4, 6);
  });

  it("cuts a box obliquely to the stretched rectangle", () => {
    const kernel = manifoldKernelFromRuntime(runtime);
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
    );
    const cut = unwrapKernelResult(
      kernel.section({
        target: box,
        origin: [length(0), length(10), length(5)],
        normal: [0, 1, 1],
        keepSide: 1,
      }),
    );
    expect(cut.section.areaMm2).toBeCloseTo(30 * 10 * Math.SQRT2, 9);
  });

  it("refuses a plane that misses the target with section-empty", () => {
    const kernel = manifoldKernelFromRuntime(runtime);
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
