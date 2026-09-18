/**
 * OCCT-adapter chamfer tests (Phase 26.6): everything the shared contract
 * suite does not prove about the BREP chamfer path — edge addressing
 * through the kernel's OWN topology snapshots (the Phase 22 machinery, the
 * fillet path's twin), the stale-ordinal structured failure, the oversized
 * distance's `IsDone` diagnosis (probed: no throw, including exactly at
 * the smaller adjacent extent), the distance-past-edge-length exactness
 * (probed: the analytic prism holds — the corner cross-section lives in
 * the cross plane), the interfering same-face pair's `IsDone` decline, the
 * seam-edge scope boundary (probed: `MakeChamfer` on the cylinder's TRUE
 * seam — the straight stitched edge whose measure is the height — THROWS
 * inside the WASM boundary at every probed distance, unlike the fillet's
 * clean `IsDone = false`; the adapter's no-throw boundary normalizes the
 * throw into the structured `kernel/chamfer-failed`), the rim-circle
 * chamfer at its measured volume, and the fake-vs-OCCT equivalence of the
 * analytic corner-prism model.
 */

import { beforeAll, describe, it } from "vitest";
import { createBodyId, length } from "@slopcad/cad-core";
import {
  assertBoundsEqual,
  assertVolumeClose,
  createFakeKernel,
  expectKernelFailure,
  KERNEL_ERROR_CODES,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";
import {
  EXACT_BOUNDS_TOLERANCE,
  EXACT_VOLUME_TOLERANCE,
} from "@slopcad/cad-kernel/contract-suite";
import type { KernelSolid } from "@slopcad/cad-kernel";

import { occtKernelFromRuntime, type OcctKernel } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

function makeKernel(): OcctKernel {
  return occtKernelFromRuntime(runtime);
}

function box(
  kernel: OcctKernel,
  width: number,
  depth: number,
  height: number,
): KernelSolid {
  return unwrapKernelResult(
    kernel.createBox({
      width: length(width),
      depth: length(depth),
      height: length(height),
    }),
    "createBox",
  );
}

/**
 * The vertical-edge ordinals of a box(30, 20, 10) straight from the
 * kernel's topology snapshot: edges whose measured length is the height —
 * the discovery path a real chamfer feature drives through the Phase 22
 * protocol.
 */
function verticalEdges(
  kernel: OcctKernel,
  solid: KernelSolid,
): readonly number[] {
  const snapshot = unwrapKernelResult(
    kernel.topologySnapshot(solid, {
      bodyId: createBodyId("body_chamfer_fixture"),
      regeneration: 0,
      kinds: ["edge"],
    }),
    "topologySnapshot",
  );
  const verticals = snapshot.entities
    .filter((entity) => entity.geometry.lengthMm === 10)
    .map((entity) => entity.ordinal);
  if (verticals.length !== 4) {
    throw new Error(
      `Fixture invariant: a 30×20×10 box has four 10 mm edges, found ${String(verticals.length)}.`,
    );
  }
  return verticals;
}

describe("occt kernel chamfer: snapshot-addressed edge beveling", () => {
  it("chamfers a snapshot-resolved corner edge at the exact analytic prism volume", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const verticals = verticalEdges(kernel, target);
    const solid = unwrapKernelResult(
      kernel.chamfer({
        target,
        edges: [verticals[0] ?? 0],
        distance: length(3),
      }),
      "snapshot chamfer",
    );
    // Probed exact: the symmetric chamfer removes the corner prism of
    // cross-section d²/2, the edge length tall.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "chamfer volume"),
      30 * 20 * 10 - ((3 * 3) / 2) * 10,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "chamfer bounds"),
      { min: [0, 0, 0], max: [30, 20, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("chamfers a translated box through its translated snapshot's ordinals", () => {
    const kernel = makeKernel();
    const moved = unwrapKernelResult(
      kernel.transform(box(kernel, 30, 20, 10), {
        x: length(100),
        y: length(-50),
        z: length(7),
      }),
      "transform",
    );
    const verticals = verticalEdges(kernel, moved);
    const solid = unwrapKernelResult(
      kernel.chamfer({
        target: moved,
        edges: [verticals[0] ?? 0],
        distance: length(3),
      }),
      "translated chamfer",
    );
    // Rigid translation leaves the volume exact and shifts the bounds.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "translated chamfer volume"),
      30 * 20 * 10 - ((3 * 3) / 2) * 10,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "translated chamfer bounds"),
      { min: [100, -50, 7], max: [130, -30, 17] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("rejects a stale ordinal with kernel/chamfer-edge-unknown", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    expectKernelFailure(
      kernel.chamfer({ target, edges: [999], distance: length(3) }),
      KERNEL_ERROR_CODES.chamferEdgeUnknown,
      "ordinal past the snapshot numbering",
    );
    // And a valid ordinal of a DISPOSED solid is ownership, not addressing.
    const other = makeKernel();
    const foreign = box(other, 5, 5, 5);
    expectKernelFailure(
      kernel.chamfer({ target: foreign, edges: [0], distance: length(1) }),
      KERNEL_ERROR_CODES.solidNotOwned,
      "foreign target",
    );
  });

  it("surfaces an oversized distance as the structured chamfer failure, no throw", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const verticals = verticalEdges(kernel, target);
    // d = 25 outruns both 30 mm and 20 mm faces, and d = 20 meets the
    // smaller adjacent extent exactly: probed, OCCT answers IsDone() =
    // false for both, no throw — the adapter maps that to the structured
    // code instead of letting the failure surface as a throw or a
    // silently-degenerate solid.
    for (const distance of [25, 20]) {
      expectKernelFailure(
        kernel.chamfer({
          target,
          edges: [verticals[0] ?? 0],
          distance: length(distance),
        }),
        KERNEL_ERROR_CODES.chamferFailed,
        `oversized distance ${distance} mm`,
      );
    }
  });

  it("chamfers past the edge's own length at the exact prism volume", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const verticals = verticalEdges(kernel, target);
    // d = 10.5 exceeds the 10 mm edge length but fits both adjacent face
    // extents (30 and 20): probed, OCCT builds it and measures the analytic
    // prism exactly — the corner cross-section lives in the cross plane,
    // so the edge length bounds nothing. The fake kernel's model agrees
    // (its fit check tests the cross-section extents only).
    const solid = unwrapKernelResult(
      kernel.chamfer({
        target,
        edges: [verticals[0] ?? 0],
        distance: length(10.5),
      }),
      "long-distance chamfer",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "long-distance volume"),
      30 * 20 * 10 - ((10.5 * 10.5) / 2) * 10,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("declines interfering same-face chamfers with IsDone, and sums disjoint ones exactly", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const [first, second] = verticalEdges(kernel, target);
    // The first two snapshot verticals sit on one face at disjoint corners:
    // at d = 11 their cross bands overlap on both axes (x band shared, y
    // bands [0,11] and [9,20] intersect) — probed IsDone() = false.
    expectKernelFailure(
      kernel.chamfer({
        target,
        edges: [first ?? 0, second ?? 2],
        distance: length(11),
      }),
      KERNEL_ERROR_CODES.chamferFailed,
      "interfering same-face pair",
    );
    // At d = 2 the same pair is disjoint: probed exact summed removal.
    const solid = unwrapKernelResult(
      kernel.chamfer({
        target,
        edges: [first ?? 0, second ?? 2],
        distance: length(2),
      }),
      "disjoint pair chamfer",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "disjoint pair volume"),
      30 * 20 * 10 - 2 * ((2 * 2) / 2) * 10,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("chamfers a rim-circle edge of a cylinder at its measured volume", () => {
    const kernel = makeKernel();
    const cylinder = unwrapKernelResult(
      kernel.createCylinder({ radius: length(5), height: length(10) }),
      "createCylinder",
    );
    const snapshot = unwrapKernelResult(
      kernel.topologySnapshot(cylinder, {
        bodyId: createBodyId("body_chamfer_rim_fixture"),
        regeneration: 0,
        kinds: ["edge"],
      }),
      "topologySnapshot",
    );
    // The two rim circles (planar cap meeting the cylindrical side) are
    // ordinary crease edges; their measure is the full circumference. The
    // cylinder's other edge is the seam — see the test below.
    const rim = snapshot.entities.find(
      (entity) =>
        entity.geometry.lengthMm !== undefined &&
        Math.abs(entity.geometry.lengthMm - 2 * Math.PI * 5) < 1e-6,
    );
    if (rim === undefined) {
      throw new Error(
        "Fixture invariant: the cylinder's rim edge was not found.",
      );
    }
    const solid = unwrapKernelResult(
      kernel.chamfer({
        target: cylinder,
        edges: [rim.ordinal],
        distance: length(1),
      }),
      "rim chamfer",
    );
    const volume = unwrapKernelResult(
      kernel.volume(solid),
      "rim chamfer volume",
    );
    // Probed 770.7373977 mm³ on this binding: the rim chamfer removes a
    // conical-notch wedge of corner material (the pristine cylinder is
    // π·25·10 ≈ 785.398 mm³). A measured value, pinned at the probe's
    // precision — not an analytic model.
    assertVolumeClose(volume, 770.7373976806958, 1e-3);
  });

  it("rejects a true seam-edge chamfer with the structured kernel/chamfer-failed (a normalized throw)", () => {
    const kernel = makeKernel();
    const cylinder = unwrapKernelResult(
      kernel.createCylinder({ radius: length(5), height: length(10) }),
      "createCylinder",
    );
    const snapshot = unwrapKernelResult(
      kernel.topologySnapshot(cylinder, {
        bodyId: createBodyId("body_chamfer_seam_fixture"),
        regeneration: 0,
        kinds: ["edge"],
      }),
      "topologySnapshot",
    );
    // The TRUE seam is the straight edge whose measure is the height —
    // the periodic side surface stitched to itself, tangent-continuous,
    // beveling no corner. Probed: MakeChamfer THROWS inside the WASM
    // boundary at every probed distance (0.1 to 2 mm) — a DIFFERENT
    // decline than the fillet's clean IsDone() = false on the same edge —
    // and the adapter's no-throw boundary normalizes the throw into the
    // structured kernel/chamfer-failed, never a raw exception.
    const seam = snapshot.entities.find(
      (entity) =>
        entity.geometry.lengthMm !== undefined &&
        Math.abs(entity.geometry.lengthMm - 10) < 1e-9,
    );
    if (seam === undefined) {
      throw new Error(
        "Fixture invariant: the cylinder's seam edge was not found.",
      );
    }
    for (const distance of [0.1, 0.5, 1, 2]) {
      expectKernelFailure(
        kernel.chamfer({
          target: cylinder,
          edges: [seam.ordinal],
          distance: length(distance),
        }),
        KERNEL_ERROR_CODES.chamferFailed,
        `seam chamfer at d=${distance} mm`,
      );
    }
  });

  it("agrees with the fake kernel's analytic model on the box-corner fixture", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const verticals = verticalEdges(kernel, target);
    const occtSolid = unwrapKernelResult(
      kernel.chamfer({
        target,
        edges: [verticals[0] ?? 0],
        distance: length(3),
      }),
      "occt chamfer",
    );
    const fakeKernel = createFakeKernel();
    const fakeTarget = unwrapKernelResult(
      fakeKernel.createBox({
        width: length(30),
        depth: length(20),
        height: length(10),
      }),
      "fake box",
    );
    // The fake's box-edge table puts its verticals at ordinals 8-11 (its
    // own documented convention — cross-kernel ordinal transport is
    // meaningless by design; only the SEMANTICS must agree).
    const fakeSolid = unwrapKernelResult(
      fakeKernel.chamfer({
        target: fakeTarget,
        edges: [8],
        distance: length(3),
      }),
      "fake chamfer",
    );
    const occtVolume = unwrapKernelResult(
      kernel.volume(occtSolid),
      "occt volume",
    );
    const fakeVolume = unwrapKernelResult(
      fakeKernel.volume(fakeSolid),
      "fake volume",
    );
    assertVolumeClose(occtVolume, fakeVolume, EXACT_VOLUME_TOLERANCE);
  });
});
