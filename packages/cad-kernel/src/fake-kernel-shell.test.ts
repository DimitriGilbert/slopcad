/**
 * Fake-kernel shell tests (Phase 26.7): everything the shared contract
 * suite does not prove about the analytic open-box model — the documented
 * single-face subset's exact volume at EVERY face ordinal (each opening's
 * own cavity), exact membership through the voxel-quadrature boolean
 * cross-check, the fully planar canonical mesh, and the structured
 * declines that scope the subset honestly (non-box targets, multi-face
 * selections, walls that meet).
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";

import {
  createFakeKernel,
  expectKernelFailure,
  KERNEL_ERROR_CODES,
  unwrapKernelResult,
} from "./index";
import { FAKE_BOX_FACE_TABLE } from "./fake-kernel";

/** The fixture box's extents. */
const W = 30;
const D = 20;
const H = 10;

/** The box-face table's z-high ordinal (the fixture's canonical opening). */
const TOP_ORDINAL = 5;

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

describe("fake kernel shell: the analytic open-box model", () => {
  it("removes exactly the inset cavity: volume, bounds, membership", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const solid = unwrapKernelResult(
      kernel.shell({ target, faces: [TOP_ORDINAL], thickness: length(2) }),
      "top-open shell",
    );
    // Exact analytic volume: W·D·H − (W−2t)(D−2t)(H−t).
    const volume = unwrapKernelResult(kernel.volume(solid), "volume");
    expect(volume).toBeCloseTo(W * D * H - (W - 4) * (D - 4) * (H - 2), 6);
    // Bounds are the box's — the walls own the outer boundary.
    expect(unwrapKernelResult(kernel.bounds(solid), "bounds")).toEqual({
      min: [0, 0, 0],
      max: [W, D, H],
    });
    // The measured volume is cached and stable.
    expect(unwrapKernelResult(kernel.volume(solid), "volume")).toBe(volume);
    // Membership, judged through the voxel-quadrature booleans: the cavity
    // box is void (the intersection is empty) and its union with the shell
    // restores the full box.
    const cavity = unwrapKernelResult(
      kernel.transform(
        unwrapKernelResult(
          kernel.createBox({
            width: length(W - 4),
            depth: length(D - 4),
            height: length(H - 2),
          }),
          "cavity box",
        ),
        { x: length(2), y: length(2), z: length(2) },
      ),
      "cavity placement",
    );
    const filled = unwrapKernelResult(kernel.union([solid, cavity]), "union");
    expect(
      unwrapKernelResult(kernel.volume(filled), "union volume"),
    ).toBeCloseTo(W * D * H, 0);
    const voids = unwrapKernelResult(
      kernel.intersect([solid, cavity]),
      "intersect",
    );
    expect(unwrapKernelResult(kernel.volume(voids), "intersect volume")).toBe(
      0,
    );
  });

  it("opens every face ordinal at that opening's own exact cavity", () => {
    const kernel = createFakeKernel();
    for (let ordinal = 0; ordinal < FAKE_BOX_FACE_TABLE.length; ordinal += 1) {
      const entry = FAKE_BOX_FACE_TABLE[ordinal];
      if (entry === undefined) continue;
      const extents = [W, D, H] as const;
      const open = extents[entry.axis];
      const crosses = [0, 1, 2]
        .filter((axis) => axis !== entry.axis)
        .map((axis) => extents[axis]);
      const [crossA, crossB] = crosses as [number, number];
      const t = 2;
      const solid = unwrapKernelResult(
        kernel.shell({
          target: box(kernel),
          faces: [ordinal],
          thickness: length(t),
        }),
        `opening ordinal ${String(ordinal)}`,
      );
      expect(
        unwrapKernelResult(kernel.volume(solid), "volume"),
        `ordinal ${String(ordinal)} volume`,
      ).toBeCloseTo(
        W * D * H - (crossA - 2 * t) * (crossB - 2 * t) * ((open ?? 0) - t),
        6,
      );
    }
  });

  it("parameterizes the thickness: t = 3 removes its own cavity", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.shell({
        target: box(kernel),
        faces: [TOP_ORDINAL],
        thickness: length(3),
      }),
      "t = 3 shell",
    );
    expect(unwrapKernelResult(kernel.volume(solid), "volume")).toBeCloseTo(
      W * D * H - (W - 6) * (D - 6) * (H - 3),
      6,
    );
  });

  it("tessellates a fully planar canonical mesh, deterministically", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.shell({
        target: box(kernel),
        faces: [TOP_ORDINAL],
        thickness: length(2),
      }),
      "top-open shell",
    );
    const first = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    const second = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    expect(second).toEqual(first);
    // Five kept outer faces + four rim strips + four cavity walls + the
    // cavity floor = fourteen quads = twenty-eight triangles — all planar.
    expect(first.indices.length / 3).toBe(28);
    // A thinner wall does not change the planar piece count.
    const thin = unwrapKernelResult(
      kernel.shell({
        target: box(kernel),
        faces: [TOP_ORDINAL],
        thickness: length(1),
      }),
      "thin shell",
    );
    const thinSoup = unwrapKernelResult(kernel.tessellate(thin), "thin soup");
    expect(thinSoup.indices.length / 3).toBe(28);
  });

  it("declines a non-box target with the structured unsupported code", () => {
    const kernel = createFakeKernel();
    const sphere = unwrapKernelResult(
      kernel.createSphere({ radius: length(5) }),
      "createSphere",
    );
    expectKernelFailure(
      kernel.shell({ target: sphere, faces: [0], thickness: length(1) }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "sphere target",
    );
    // A shelled box is no longer a pristine box leaf: no shell of shell.
    const once = unwrapKernelResult(
      kernel.shell({
        target: box(kernel),
        faces: [TOP_ORDINAL],
        thickness: length(2),
      }),
      "first shell",
    );
    expectKernelFailure(
      kernel.shell({
        target: once,
        faces: [TOP_ORDINAL],
        thickness: length(1),
      }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "shell of shell",
    );
  });

  it("declines multi-face selections: the subset opens ONE face per call", () => {
    const kernel = createFakeKernel();
    expectKernelFailure(
      kernel.shell({
        target: box(kernel),
        faces: [TOP_ORDINAL, 4],
        thickness: length(2),
      }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "two faces",
    );
  });

  it("declines walls that meet with the structured shell failure", () => {
    const kernel = createFakeKernel();
    // The 20 mm cross extent binds: 2t = 20 meets it exactly.
    expectKernelFailure(
      kernel.shell({
        target: box(kernel),
        faces: [TOP_ORDINAL],
        thickness: length(10),
      }),
      KERNEL_ERROR_CODES.shellFailed,
      "cross walls meeting",
    );
    // The open axis can bind alone: a 30×30×10 box opened at z with
    // t = 12 clears both 30 mm crosses (2t = 24 < 30) but crosses the
    // 10 mm open extent.
    const slab = unwrapKernelResult(
      kernel.createBox({
        width: length(30),
        depth: length(30),
        height: length(10),
      }),
      "slab",
    );
    expectKernelFailure(
      kernel.shell({
        target: slab,
        faces: [TOP_ORDINAL],
        thickness: length(12),
      }),
      KERNEL_ERROR_CODES.shellFailed,
      "open-axis wall crossing",
    );
    // Just inside both boundaries stays exact.
    const edgeFit = unwrapKernelResult(
      kernel.shell({
        target: box(kernel),
        faces: [TOP_ORDINAL],
        thickness: length(4.9),
      }),
      "near-fit shell",
    );
    expect(unwrapKernelResult(kernel.volume(edgeFit), "volume")).toBeCloseTo(
      W * D * H - (W - 9.8) * (D - 9.8) * (H - 4.9),
      6,
    );
  });

  it("rejects stale ordinals past the table and malformed addresses", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    expectKernelFailure(
      kernel.shell({ target, faces: [6], thickness: length(2) }),
      KERNEL_ERROR_CODES.shellFaceUnknown,
      "ordinal past the table",
    );
    expectKernelFailure(
      kernel.shell({ target, faces: [-1], thickness: length(2) }),
      KERNEL_ERROR_CODES.invalidOperands,
      "negative ordinal",
    );
    expectKernelFailure(
      kernel.shell({ target, faces: [1.5], thickness: length(2) }),
      KERNEL_ERROR_CODES.invalidOperands,
      "non-integer ordinal",
    );
    expectKernelFailure(
      kernel.shell({
        target,
        faces: [TOP_ORDINAL, TOP_ORDINAL],
        thickness: length(2),
      }),
      KERNEL_ERROR_CODES.invalidOperands,
      "duplicate ordinal",
    );
    expectKernelFailure(
      kernel.shell({ target, faces: [], thickness: length(2) }),
      KERNEL_ERROR_CODES.invalidOperands,
      "empty list",
    );
    expectKernelFailure(
      kernel.shell({ target, faces: [TOP_ORDINAL], thickness: length(0) }),
      KERNEL_ERROR_CODES.invalidLength,
      "zero thickness",
    );
    expectKernelFailure(
      kernel.shell({ target, faces: [TOP_ORDINAL], thickness: length(-1) }),
      KERNEL_ERROR_CODES.invalidLength,
      "negative thickness",
    );
  });

  it("survives the boolean-leaf pipeline: shelled boxes union semantically", () => {
    const kernel = createFakeKernel();
    const first = unwrapKernelResult(
      kernel.shell({
        target: box(kernel),
        faces: [TOP_ORDINAL],
        thickness: length(2),
      }),
      "first shell",
    );
    const second = unwrapKernelResult(
      kernel.shell({ target: box(kernel), faces: [4], thickness: length(2) }),
      "second shell, opposite opening",
    );
    // The two openings' cavities overlap in the box's middle — the shared
    // void [t, W−t]×[t, D−t]×[t, H−t] stays empty in the union, so the
    // analytic value is the box minus that one cavity: judged in the
    // boolean band (voxel quadrature — the shell nodes participate as
    // boolean leaves).
    const united = unwrapKernelResult(kernel.union([first, second]), "union");
    const volume = unwrapKernelResult(kernel.volume(united), "union volume");
    const analytic = W * D * H - (W - 4) * (D - 4) * (H - 4);
    expect(Math.abs(volume - analytic) / analytic).toBeLessThan(0.02);
    expect(volume).toBeLessThan(W * D * H);
  });

  it("documents the box-face table: six faces, the fixed order", () => {
    expect(FAKE_BOX_FACE_TABLE).toHaveLength(6);
    expect(FAKE_BOX_FACE_TABLE).toEqual([
      { axis: 0, high: false },
      { axis: 0, high: true },
      { axis: 1, high: false },
      { axis: 1, high: true },
      { axis: 2, high: false },
      { axis: 2, high: true },
    ]);
  });
});
