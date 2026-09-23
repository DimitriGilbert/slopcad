/**
 * The Phase 53 `drawingView` fixtures on the REAL kernel: exact HLR
 * projections whose visible/hidden edge sets are pinned analytically —
 * the box (12 edges split 8 visible / 4 hidden in every orthographic base
 * view; 9 visible / 3 hidden isometric), the cylinder (2 sharp rims + 2
 * outline silhouettes visible, none hidden, from the front), and the
 * protrusion (plate + boss: the boss footprint's far edges go hidden).
 * Coordinates are asserted exactly where analytic — the deterministic
 * output requirement applies to the extracted edge sets (the probe record
 * lives in `docs/architecture/occt-prespike-findings.md`, Phase 53
 * addendum).
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  DRAWING_VIEW_EYE_DIRECTIONS,
  DRAWING_VIEW_UP_HINTS,
  length,
} from "@slopcad/cad-core";
import { unwrapKernelResult } from "@slopcad/cad-kernel";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

describe("the OpenCascade kernel's drawingView operation", () => {
  it("projects a box's front view to 8 visible and 4 hidden edges at exact coordinates", () => {
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
    const view = unwrapKernelResult(
      kernel.drawingView({
        target: box,
        eye: DRAWING_VIEW_EYE_DIRECTIONS.front,
        up: DRAWING_VIEW_UP_HINTS.front,
      }),
    );
    expect(view.fidelity).toBe("hlr-exact");
    // The probe-recorded split: the projected rectangle's 4 outline
    // segments are the VISIBLE set (the front face's edges; the 4 side
    // connectors project onto those same segments and the sharp-outline
    // compounds contribute nothing for a box), and the back face's 4 edges
    // are the HIDDEN set. 8 of the 12 edges project onto the rectangle's
    // four sides; HLR's output is that minimal exact drawing.
    expect(view.visible.length).toBe(4);
    expect(view.hidden.length).toBe(4);
    // The view-plane extent is exactly the projected rectangle
    // [0, W] x [0, H] (front basis: sheet right +X, sheet up +Z).
    expect(view.bounds).not.toBeNull();
    expect(view.bounds?.minU).toBeCloseTo(0, 9);
    expect(view.bounds?.maxU).toBeCloseTo(W, 9);
    expect(view.bounds?.minV).toBeCloseTo(0, 9);
    expect(view.bounds?.maxV).toBeCloseTo(H, 9);
    // The hidden set is exactly the back face's rectangle at v in [0, H]:
    // its four chains each span the full projected extent.
    for (const chain of view.hidden) {
      const us = chain.map((point) => point[0]);
      const vs = chain.map((point) => point[1]);
      expect(Math.min(...us)).toBeGreaterThanOrEqual(-1e-9);
      expect(Math.max(...us)).toBeLessThanOrEqual(W + 1e-9);
      expect(Math.min(...vs)).toBeGreaterThanOrEqual(-1e-9);
      expect(Math.max(...vs)).toBeLessThanOrEqual(H + 1e-9);
    }
  });

  it("projects the box's top and right views with the same 8/4 split at exact extents", () => {
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
    const top = unwrapKernelResult(
      kernel.drawingView({
        target: box,
        eye: DRAWING_VIEW_EYE_DIRECTIONS.top,
        up: DRAWING_VIEW_UP_HINTS.top,
      }),
    );
    expect(top.visible.length).toBe(4);
    expect(top.hidden.length).toBe(4);
    expect(top.bounds?.minU).toBeCloseTo(0, 9);
    expect(top.bounds?.maxU).toBeCloseTo(W, 9);
    expect(top.bounds?.minV).toBeCloseTo(0, 9);
    expect(top.bounds?.maxV).toBeCloseTo(D, 9);
    const right = unwrapKernelResult(
      kernel.drawingView({
        target: box,
        eye: DRAWING_VIEW_EYE_DIRECTIONS.right,
        up: DRAWING_VIEW_UP_HINTS.right,
      }),
    );
    expect(right.visible.length).toBe(4);
    expect(right.hidden.length).toBe(4);
    // Right basis: sheet right +Y (u in [0, D]), sheet up +Z (v in [0, H]).
    expect(right.bounds?.minU).toBeCloseTo(0, 9);
    expect(right.bounds?.maxU).toBeCloseTo(D, 9);
    expect(right.bounds?.minV).toBeCloseTo(0, 9);
    expect(right.bounds?.maxV).toBeCloseTo(H, 9);
  });

  it("projects the box's isometric view to 9 visible and 3 hidden edges", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
    );
    const iso = unwrapKernelResult(
      kernel.drawingView({
        target: box,
        eye: DRAWING_VIEW_EYE_DIRECTIONS.isometric,
        up: DRAWING_VIEW_UP_HINTS.isometric,
      }),
    );
    expect(iso.visible.length).toBe(9);
    expect(iso.hidden.length).toBe(3);
  });

  it("projects a cylinder's front view to 2 rims + 2 silhouettes, none hidden", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const R = 10;
    const H = 20;
    const cylinder = unwrapKernelResult(
      kernel.createCylinder({ radius: length(R), height: length(H) }),
    );
    const view = unwrapKernelResult(
      kernel.drawingView({
        target: cylinder,
        eye: DRAWING_VIEW_EYE_DIRECTIONS.front,
        up: DRAWING_VIEW_UP_HINTS.front,
      }),
    );
    // 2 sharp rim near-arcs (VCompound) + 2 smooth outline silhouette
    // lines (OutLineVCompound), all visible; HLR hides the rims' FAR arcs
    // (the body occludes them) — 2 hidden chains, the exact split.
    expect(view.visible.length).toBe(4);
    expect(view.hidden.length).toBe(2);
    expect(view.bounds?.minU).toBeCloseTo(-R, 6);
    expect(view.bounds?.maxU).toBeCloseTo(R, 6);
    expect(view.bounds?.minV).toBeCloseTo(0, 6);
    expect(view.bounds?.maxV).toBeCloseTo(H, 6);
    // No visible chain is closed: every rim circle is split into its
    // visible near arc and hidden far arc.
    const closed = view.visible.filter((chain) => {
      const first = chain[0];
      const last = chain[chain.length - 1];
      if (first === undefined || last === undefined) return false;
      return (
        Math.abs(first[0] - last[0]) < 1e-9 &&
        Math.abs(first[1] - last[1]) < 1e-9
      );
    });
    expect(closed.length).toBe(0);
  });

  it("hides the far footprint edges of a plate-plus-boss protrusion's front view", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const W = 60;
    const D = 40;
    const H = 10;
    const plate = unwrapKernelResult(
      kernel.createBox({
        width: length(W),
        depth: length(D),
        height: length(H),
      }),
    );
    const boss = unwrapKernelResult(
      kernel.createBox({
        width: length(20),
        depth: length(20),
        height: length(15),
      }),
    );
    const placed = unwrapKernelResult(
      kernel.transform(boss, { x: length(20), y: length(10), z: length(H) }),
    );
    const fused = unwrapKernelResult(kernel.union([plate, placed]));
    const view = unwrapKernelResult(
      kernel.drawingView({
        target: fused,
        eye: DRAWING_VIEW_EYE_DIRECTIONS.front,
        up: DRAWING_VIEW_UP_HINTS.front,
      }),
    );
    // The front view's minimal exact drawing: 7 visible chains (the plate
    // outline 4 + the boss's two vertical sides + its top; the boss's
    // footprint edge projects onto the plate's top edge — one segment) and
    // 9 hidden chains (the plate's back face 4 plus the boss's far-side
    // and footprint-back edges the solid itself occludes).
    expect(view.visible.length).toBe(7);
    expect(view.hidden.length).toBe(9);
    expect(view.bounds?.minU).toBeCloseTo(0, 9);
    expect(view.bounds?.maxU).toBeCloseTo(W, 9);
    expect(view.bounds?.minV).toBeCloseTo(0, 9);
    expect(view.bounds?.maxV).toBeCloseTo(H + 15, 9);
  });

  it("refuses a zero eye direction and an up hint parallel to it", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
    );
    const zeroEye = kernel.drawingView({
      target: box,
      eye: [0, 0, 0],
      up: DRAWING_VIEW_UP_HINTS.front,
    });
    expect(zeroEye.ok).toBe(false);
    if (!zeroEye.ok) expect(zeroEye.error.code).toBe("kernel/invalid-operands");
    const parallelUp = kernel.drawingView({
      target: box,
      eye: DRAWING_VIEW_EYE_DIRECTIONS.front,
      up: [0, -1, 0],
    });
    expect(parallelUp.ok).toBe(false);
    if (!parallelUp.ok)
      expect(parallelUp.error.code).toBe("kernel/invalid-operands");
  });
});
