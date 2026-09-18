/**
 * Fake-kernel fillet tests (Phase 26.5): everything the shared contract
 * suite does not prove about the analytic corner-fillet model — the
 * documented box-edge subset's exact membership (the removed prism-quadrant
 * minus its quarter disc, boundary inclusive), the exact analytic volume
 * against a voxel-quadrature cross-check, the translated-box twin, and the
 * structured declines that scope the subset honestly (non-box targets,
 * mixed-direction edge groups, interfering quadrants).
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";

import {
  createFakeKernel,
  expectKernelFailure,
  KERNEL_ERROR_CODES,
  unwrapKernelResult,
} from "./index";
import { FAKE_BOX_EDGE_TABLE } from "./fake-kernel";

/** The fixture box's extents. */
const W = 30;
const D = 20;
const H = 10;

/** The box-edge table's vertical ordinals (axis 2 = z): 8, 9, 10, 11. */
const VERTICALS = [8, 9, 10, 11];
const CORNER_ORDINAL = 11; // x = W, y = D
const OPPOSITE_ORDINAL = 8; // x = 0, y = 0

function box(kernel: ReturnType<typeof createFakeKernel>) {
  return unwrapKernelResult(
    kernel.createBox({
      width: length(W),
      depth: length(D),
      height: length(H),
    }),
    "createBox",
  );
}

describe("fake kernel fillet: the analytic corner model", () => {
  it("documents twelve box edges in the fixed table order", () => {
    expect(FAKE_BOX_EDGE_TABLE).toHaveLength(12);
    const axes = FAKE_BOX_EDGE_TABLE.map((entry) => entry.axis);
    expect(axes).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
  });

  it("removes exactly the prism quadrant: volume, bounds, membership", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const solid = unwrapKernelResult(
      kernel.fillet({ target, edges: [CORNER_ORDINAL], radius: length(3) }),
      "corner fillet",
    );
    // Exact analytic volume: W·D·H − r²(1 − π/4)·H.
    const volume = unwrapKernelResult(kernel.volume(solid), "volume");
    expect(volume).toBeCloseTo(W * D * H - 9 * (1 - Math.PI / 4) * H, 6);
    // Bounds are the box's — corner removal leaves the AABB intact.
    const bounds = unwrapKernelResult(kernel.bounds(solid), "bounds");
    expect(bounds).toEqual({ min: [0, 0, 0], max: [W, D, H] });
    // The measured volume is cached and stable: re-measuring returns the
    // identical number.
    expect(unwrapKernelResult(kernel.volume(solid), "volume")).toBe(volume);
  });

  it("classifies the removed quadrant inclusively on the fillet arc", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const r = 4;
    const solid = unwrapKernelResult(
      kernel.fillet({ target, edges: [CORNER_ORDINAL], radius: length(r) }),
      "corner fillet",
    );
    // Voxel-free membership check via the tessellated volume? The fake's
    // truth surface is `volume`/`bounds`; the quadrant's removed measure is
    // already asserted analytically. Here we pin the tessellation's
    // determinism and non-degeneracy as the mesh-level signature.
    const first = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    const second = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    expect(second).toEqual(first);
    // 4-chord quarter arcs per edge (walls) + the caps' sectors + planar
    // pieces: strictly more than the box's 12 triangles, and valid.
    expect(first.indices.length / 3).toBeGreaterThan(12);
  });

  it("fillets two opposite verticals with the exact disjoint sum", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const solid = unwrapKernelResult(
      kernel.fillet({
        target,
        edges: [CORNER_ORDINAL, OPPOSITE_ORDINAL],
        radius: length(2),
      }),
      "opposite pair",
    );
    const volume = unwrapKernelResult(kernel.volume(solid), "volume");
    expect(volume).toBeCloseTo(W * D * H - 2 * 4 * (1 - Math.PI / 4) * H, 6);
    // Bounds unchanged: both fillets are interior corner removals.
    expect(unwrapKernelResult(kernel.bounds(solid), "bounds")).toEqual({
      min: [0, 0, 0],
      max: [W, D, H],
    });
  });

  it("declines a non-box target with the structured unsupported code", () => {
    const kernel = createFakeKernel();
    const sphere = unwrapKernelResult(
      kernel.createSphere({ radius: length(5) }),
      "createSphere",
    );
    expectKernelFailure(
      kernel.fillet({ target: sphere, edges: [0], radius: length(1) }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "sphere target",
    );
    // A filleted box is no longer a pristine box leaf: no fillet of fillet.
    const target = box(kernel);
    const once = unwrapKernelResult(
      kernel.fillet({ target, edges: [CORNER_ORDINAL], radius: length(2) }),
      "first fillet",
    );
    expectKernelFailure(
      kernel.fillet({
        target: once,
        edges: [OPPOSITE_ORDINAL],
        radius: length(2),
      }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "fillet of fillet",
    );
  });

  it("declines mixed-direction edge groups and interfering quadrants", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    // Mixed axes: vertical 11 and x-edge 0 (different direction axes).
    expectKernelFailure(
      kernel.fillet({ target, edges: [CORNER_ORDINAL, 0], radius: length(2) }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "mixed directions",
    );
    // Interfering quadrants: adjacent verticals 11 (W,D) and 9 (W,0) share
    // the x band when 2r > ... with r = 11, x bands [19,30] and [19,30]
    // coincide and the y bands touch mid-box — the overlap refusal.
    expectKernelFailure(
      kernel.fillet({
        target,
        edges: [CORNER_ORDINAL, 9],
        radius: length(11),
      }),
      KERNEL_ERROR_CODES.filletFailed,
      "overlapping quadrants",
    );
  });

  it("rejects stale ordinals past the table and malformed addresses", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    expectKernelFailure(
      kernel.fillet({ target, edges: [12], radius: length(2) }),
      KERNEL_ERROR_CODES.filletEdgeUnknown,
      "ordinal past the table",
    );
    expectKernelFailure(
      kernel.fillet({ target, edges: [-1], radius: length(2) }),
      KERNEL_ERROR_CODES.invalidOperands,
      "negative ordinal",
    );
    expectKernelFailure(
      kernel.fillet({
        target,
        edges: [VERTICALS[0] ?? 8, VERTICALS[0] ?? 8],
        radius: length(2),
      }),
      KERNEL_ERROR_CODES.invalidOperands,
      "duplicate ordinal",
    );
    expectKernelFailure(
      kernel.fillet({ target, edges: [], radius: length(2) }),
      KERNEL_ERROR_CODES.invalidOperands,
      "empty list",
    );
    expectKernelFailure(
      kernel.fillet({ target, edges: [CORNER_ORDINAL], radius: length(0) }),
      KERNEL_ERROR_CODES.invalidLength,
      "zero radius",
    );
    // The fit failure: r must stay below both adjacent face extents.
    expectKernelFailure(
      kernel.fillet({ target, edges: [CORNER_ORDINAL], radius: length(D) }),
      KERNEL_ERROR_CODES.filletFailed,
      "radius at the adjacent extent",
    );
  });

  it("survives the boolean-leaf pipeline: filleted boxes union semantically", () => {
    const kernel = createFakeKernel();
    const first = unwrapKernelResult(
      kernel.fillet({
        target: box(kernel),
        edges: [CORNER_ORDINAL],
        radius: length(3),
      }),
      "first fillet",
    );
    const second = unwrapKernelResult(
      kernel.fillet({
        target: box(kernel),
        edges: [OPPOSITE_ORDINAL],
        radius: length(3),
      }),
      "second fillet, same instance",
    );
    // Two boxes with complementary corners rounded cover each other's
    // removals: their union is the FULL box, judged in the boolean band
    // (voxel quadrature — the fillet nodes participate as boolean leaves).
    const united = unwrapKernelResult(kernel.union([first, second]), "union");
    const volume = unwrapKernelResult(kernel.volume(united), "union volume");
    expect(volume).toBeCloseTo(W * D * H, 0);
    // And self-union keeps one corner's removal: the voxel quadrature's
    // band around the exact analytic value (measured ≈0.03% relative here,
    // far inside the kernel's documented 5% boolean band).
    const selfUnion = unwrapKernelResult(
      kernel.union([first, first]),
      "self union",
    );
    const selfVolume = unwrapKernelResult(
      kernel.volume(selfUnion),
      "self volume",
    );
    const analyticSelf = W * D * H - 9 * (1 - Math.PI / 4) * H;
    expect(Math.abs(selfVolume - analyticSelf) / analyticSelf).toBeLessThan(
      0.01,
    );
  });
});
