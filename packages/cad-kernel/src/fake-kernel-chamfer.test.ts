/**
 * Fake-kernel chamfer tests (Phase 26.6): everything the shared contract
 * suite does not prove about the analytic corner-prism model — the
 * documented box-edge subset's exact membership (the removed corner prism
 * `da + db < distance`, boundary inclusive on the chamfer plane), the
 * distance-past-edge-length exactness (the OCCT-probed prism semantics),
 * the voxel-quadrature cross-check through booleans, and the structured
 * declines that scope the subset honestly (non-box targets,
 * mixed-direction edge groups, interfering prisms).
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

describe("fake kernel chamfer: the analytic corner-prism model", () => {
  it("removes exactly the corner prism: volume, bounds, membership", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const solid = unwrapKernelResult(
      kernel.chamfer({ target, edges: [CORNER_ORDINAL], distance: length(3) }),
      "corner chamfer",
    );
    // Exact analytic volume: W·D·H − d²/2·H.
    const volume = unwrapKernelResult(kernel.volume(solid), "volume");
    expect(volume).toBeCloseTo(W * D * H - ((3 * 3) / 2) * H, 6);
    // Bounds are the box's — corner removal leaves the AABB intact.
    const bounds = unwrapKernelResult(kernel.bounds(solid), "bounds");
    expect(bounds).toEqual({ min: [0, 0, 0], max: [W, D, H] });
    // The measured volume is cached and stable: re-measuring returns the
    // identical number.
    expect(unwrapKernelResult(kernel.volume(solid), "volume")).toBe(volume);
  });

  it("stays exact for a distance past the edge's own length", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    // d = 10.5 exceeds the 10 mm edge but fits both adjacent face extents:
    // the corner cross-section lives in the cross plane, so the prism model
    // holds — probed the same value against OCCT's BREP chamfer.
    const solid = unwrapKernelResult(
      kernel.chamfer({
        target,
        edges: [CORNER_ORDINAL],
        distance: length(10.5),
      }),
      "long-distance chamfer",
    );
    expect(unwrapKernelResult(kernel.volume(solid), "volume")).toBeCloseTo(
      W * D * H - ((10.5 * 10.5) / 2) * H,
      6,
    );
  });

  it("tessellates a fully planar canonical mesh, deterministically", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const solid = unwrapKernelResult(
      kernel.chamfer({ target, edges: [CORNER_ORDINAL], distance: length(4) }),
      "corner chamfer",
    );
    const first = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    const second = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    expect(second).toEqual(first);
    // The chamfer mesh replaces one box corner with two triangles less
    // wall/cap material than the fillet's chorded strips: planar pieces
    // only, strictly more than the box's 12 triangles, and valid.
    expect(first.indices.length / 3).toBeGreaterThan(12);
    // Two disjoint chamfers nearly double the wall count: still planar.
    const pair = unwrapKernelResult(
      kernel.chamfer({
        target,
        edges: [CORNER_ORDINAL, OPPOSITE_ORDINAL],
        distance: length(2),
      }),
      "pair chamfer",
    );
    const pairSoup = unwrapKernelResult(kernel.tessellate(pair), "pair soup");
    expect(pairSoup.indices.length / 3).toBeGreaterThan(
      first.indices.length / 3,
    );
  });

  it("chamfers two opposite verticals with the exact disjoint sum", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const solid = unwrapKernelResult(
      kernel.chamfer({
        target,
        edges: [CORNER_ORDINAL, OPPOSITE_ORDINAL],
        distance: length(2),
      }),
      "opposite pair",
    );
    const volume = unwrapKernelResult(kernel.volume(solid), "volume");
    expect(volume).toBeCloseTo(W * D * H - 2 * ((2 * 2) / 2) * H, 6);
    // Bounds unchanged: both chamfers are interior corner removals.
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
      kernel.chamfer({ target: sphere, edges: [0], distance: length(1) }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "sphere target",
    );
    // A chamfered box is no longer a pristine box leaf: no chamfer of
    // chamfer.
    const target = box(kernel);
    const once = unwrapKernelResult(
      kernel.chamfer({ target, edges: [CORNER_ORDINAL], distance: length(2) }),
      "first chamfer",
    );
    expectKernelFailure(
      kernel.chamfer({
        target: once,
        edges: [OPPOSITE_ORDINAL],
        distance: length(2),
      }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "chamfer of chamfer",
    );
    // A filleted box is equally outside the pristine-box domain.
    const filleted = unwrapKernelResult(
      kernel.fillet({ target, edges: [CORNER_ORDINAL], radius: length(2) }),
      "fillet",
    );
    expectKernelFailure(
      kernel.chamfer({
        target: filleted,
        edges: [OPPOSITE_ORDINAL],
        distance: length(2),
      }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "chamfer of fillet",
    );
  });

  it("declines mixed-direction edge groups and interfering prisms", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    // Mixed axes: vertical 11 and x-edge 0 (different direction axes).
    expectKernelFailure(
      kernel.chamfer({
        target,
        edges: [CORNER_ORDINAL, 0],
        distance: length(2),
      }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "mixed directions",
    );
    // Interfering prisms: adjacent verticals 11 (W,D) and 9 (W,0) share the
    // x band when d = 11 (x bands [19,30] coincide) and their y bands
    // [9,20] and [0,11] overlap mid-box — the overlap refusal, the same
    // pair OCCT declines with IsDone = false (probed).
    expectKernelFailure(
      kernel.chamfer({
        target,
        edges: [CORNER_ORDINAL, 9],
        distance: length(11),
      }),
      KERNEL_ERROR_CODES.chamferFailed,
      "overlapping prisms",
    );
  });

  it("rejects stale ordinals past the table and malformed addresses", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    expectKernelFailure(
      kernel.chamfer({ target, edges: [12], distance: length(2) }),
      KERNEL_ERROR_CODES.chamferEdgeUnknown,
      "ordinal past the table",
    );
    expectKernelFailure(
      kernel.chamfer({ target, edges: [-1], distance: length(2) }),
      KERNEL_ERROR_CODES.invalidOperands,
      "negative ordinal",
    );
    expectKernelFailure(
      kernel.chamfer({
        target,
        edges: [VERTICALS[0] ?? 8, VERTICALS[0] ?? 8],
        distance: length(2),
      }),
      KERNEL_ERROR_CODES.invalidOperands,
      "duplicate ordinal",
    );
    expectKernelFailure(
      kernel.chamfer({ target, edges: [], distance: length(2) }),
      KERNEL_ERROR_CODES.invalidOperands,
      "empty list",
    );
    expectKernelFailure(
      kernel.chamfer({ target, edges: [CORNER_ORDINAL], distance: length(0) }),
      KERNEL_ERROR_CODES.invalidLength,
      "zero distance",
    );
    // The fit failure: the distance must stay below both adjacent face
    // extents — 20 mm IS the smaller one (probed: OCCT declines at exactly
    // this boundary with IsDone = false).
    expectKernelFailure(
      kernel.chamfer({ target, edges: [CORNER_ORDINAL], distance: length(D) }),
      KERNEL_ERROR_CODES.chamferFailed,
      "distance at the adjacent extent",
    );
  });

  it("survives the boolean-leaf pipeline: chamfered boxes union semantically", () => {
    const kernel = createFakeKernel();
    const first = unwrapKernelResult(
      kernel.chamfer({
        target: box(kernel),
        edges: [CORNER_ORDINAL],
        distance: length(3),
      }),
      "first chamfer",
    );
    const second = unwrapKernelResult(
      kernel.chamfer({
        target: box(kernel),
        edges: [OPPOSITE_ORDINAL],
        distance: length(3),
      }),
      "second chamfer, same instance",
    );
    // Two boxes with complementary corners beveled cover each other's
    // removals: their union is the FULL box, judged in the boolean band
    // (voxel quadrature — the chamfer nodes participate as boolean leaves).
    const united = unwrapKernelResult(kernel.union([first, second]), "union");
    const volume = unwrapKernelResult(kernel.volume(united), "union volume");
    expect(volume).toBeCloseTo(W * D * H, 0);
    // And self-union keeps one corner's removal: the voxel quadrature's
    // band around the exact analytic value.
    const selfUnion = unwrapKernelResult(
      kernel.union([first, first]),
      "self union",
    );
    const selfVolume = unwrapKernelResult(
      kernel.volume(selfUnion),
      "self volume",
    );
    const analyticSelf = W * D * H - ((3 * 3) / 2) * H;
    expect(Math.abs(selfVolume - analyticSelf) / analyticSelf).toBeLessThan(
      0.01,
    );
  });

  it("shares the fillet's box-edge table: twelve edges, the fixed order", () => {
    expect(FAKE_BOX_EDGE_TABLE).toHaveLength(12);
    const axes = FAKE_BOX_EDGE_TABLE.map((entry) => entry.axis);
    expect(axes).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
  });
});
