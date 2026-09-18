/**
 * OCCT-adapter fillet tests (Phase 26.5): everything the shared contract
 * suite does not prove about the BREP fillet path — edge addressing through
 * the kernel's OWN topology snapshots (the Phase 22 machinery: persistent
 * edge references resolve to snapshot ordinals, and `fillet` consumes the
 * resolved addresses), the stale-ordinal structured failure, the oversized
 * radius's `IsDone` diagnosis (probed: no throw), the seam-edge scope
 * boundary (probed: OCCT rejects the cylinder's TRUE seam — the straight
 * stitched edge whose measure is the height — with the structured
 * `kernel/fillet-failed` at every probed radius, while the rim circles,
 * ordinary crease edges, fillet normally at their measured volume), and
 * the fake-vs-OCCT equivalence of the analytic corner-fillet model.
 */

import { beforeAll, describe, it } from "vitest";
import { length } from "@slopcad/cad-core";
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
import { createBodyId } from "@slopcad/cad-core";

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
 * the discovery path a real fillet feature drives through the Phase 22
 * protocol.
 */
function verticalEdges(
  kernel: OcctKernel,
  solid: KernelSolid,
): readonly number[] {
  const snapshot = unwrapKernelResult(
    kernel.topologySnapshot(solid, {
      bodyId: createBodyId("body_fillet_fixture"),
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

describe("occt kernel fillet: snapshot-addressed edge rounding", () => {
  it("fillets a snapshot-resolved corner edge at the exact analytic volume", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const verticals = verticalEdges(kernel, target);
    const solid = unwrapKernelResult(
      kernel.fillet({ target, edges: [verticals[0] ?? 0], radius: length(3) }),
      "snapshot fillet",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "fillet volume"),
      30 * 20 * 10 - 9 * (1 - Math.PI / 4) * 10,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "fillet bounds"),
      { min: [0, 0, 0], max: [30, 20, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("fillets a translated box through its translated snapshot's ordinals", () => {
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
      kernel.fillet({
        target: moved,
        edges: [verticals[0] ?? 0],
        radius: length(3),
      }),
      "translated fillet",
    );
    // Rigid translation leaves the volume exact and shifts the bounds.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "translated fillet volume"),
      30 * 20 * 10 - 9 * (1 - Math.PI / 4) * 10,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "translated fillet bounds"),
      { min: [100, -50, 7], max: [130, -30, 17] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("rejects a stale ordinal with kernel/fillet-edge-unknown", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    expectKernelFailure(
      kernel.fillet({ target, edges: [999], radius: length(3) }),
      KERNEL_ERROR_CODES.filletEdgeUnknown,
      "ordinal past the snapshot numbering",
    );
    // And a valid ordinal of a DISPOSED solid is ownership, not addressing.
    const other = makeKernel();
    const foreign = box(other, 5, 5, 5);
    expectKernelFailure(
      kernel.fillet({ target: foreign, edges: [0], radius: length(1) }),
      KERNEL_ERROR_CODES.solidNotOwned,
      "foreign target",
    );
  });

  it("surfaces an oversized radius as the structured fillet failure, no throw", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const verticals = verticalEdges(kernel, target);
    // r = 25 outruns both 30 mm and 20 mm faces: probed, OCCT answers
    // IsDone() = false inside — the adapter maps that to the structured
    // code instead of letting the failure surface as a throw or a
    // silently-degenerate solid.
    expectKernelFailure(
      kernel.fillet({
        target,
        edges: [verticals[0] ?? 0],
        radius: length(25),
      }),
      KERNEL_ERROR_CODES.filletFailed,
      "oversized radius",
    );
  });

  it("fillets a rim-circle edge of a cylinder at its measured volume", () => {
    const kernel = makeKernel();
    const cylinder = unwrapKernelResult(
      kernel.createCylinder({ radius: length(5), height: length(10) }),
      "createCylinder",
    );
    const snapshot = unwrapKernelResult(
      kernel.topologySnapshot(cylinder, {
        bodyId: createBodyId("body_rim_fixture"),
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
      kernel.fillet({
        target: cylinder,
        edges: [rim.ordinal],
        radius: length(1),
      }),
      "rim fillet",
    );
    const volume = unwrapKernelResult(
      kernel.volume(solid),
      "rim fillet volume",
    );
    // Probed 778.9574334 mm³ on this binding: the rim fillet removes a
    // torus-notch of corner material (the pristine cylinder is
    // π·25·10 ≈ 785.398 mm³). A measured value, pinned at the probe's
    // precision — not an analytic model.
    assertVolumeClose(volume, 778.9574334197121, 1e-3);
  });

  it("rejects a true seam-edge fillet with the structured kernel/fillet-failed", () => {
    const kernel = makeKernel();
    const cylinder = unwrapKernelResult(
      kernel.createCylinder({ radius: length(5), height: length(10) }),
      "createCylinder",
    );
    const snapshot = unwrapKernelResult(
      kernel.topologySnapshot(cylinder, {
        bodyId: createBodyId("body_seam_fixture"),
        regeneration: 0,
        kinds: ["edge"],
      }),
      "topologySnapshot",
    );
    // The TRUE seam is the straight edge whose measure is the height —
    // the periodic side surface stitched to itself, tangent-continuous,
    // rounding no corner. Probed: OCCT declines it at every probed radius
    // (0.1 to 2 mm) with IsDone() = false — the structured refusal the
    // adapter maps to kernel/fillet-failed, never a throw or a
    // degenerate solid.
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
    for (const radius of [0.1, 0.5, 1, 2]) {
      expectKernelFailure(
        kernel.fillet({
          target: cylinder,
          edges: [seam.ordinal],
          radius: length(radius),
        }),
        KERNEL_ERROR_CODES.filletFailed,
        `seam fillet at r=${radius} mm`,
      );
    }
  });

  it("agrees with the fake kernel's analytic model on the box-corner fixture", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const verticals = verticalEdges(kernel, target);
    const occtSolid = unwrapKernelResult(
      kernel.fillet({ target, edges: [verticals[0] ?? 0], radius: length(3) }),
      "occt fillet",
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
      fakeKernel.fillet({ target: fakeTarget, edges: [8], radius: length(3) }),
      "fake fillet",
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
