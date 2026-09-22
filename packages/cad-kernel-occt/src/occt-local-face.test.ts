/**
 * OCCT-adapter local face operation tests (Phase 44): everything the
 * contract's coverage matrix claims about the probed face-sweep
 * composition — the moved face's PRISM VOLUME DELTA (the roadmap's
 * analytic anchor: a moved planar face changes the volume by exactly
 * `A·(n̂·d⃗)`, the swept prism), axial and oblique displacements, the
 * datum-plane replace's two regimes (the parallel station move extends
 * and shrinks exactly; the oblique covering-box cut keeps the
 * volume-centroid side and refuses planes that do not bound the replaced
 * face), the delete-face honest decline (probed out on this binding —
 * see the contract op's documentation for the invalid-shell evidence),
 * and the topology-snapshot stability the roadmap pins: a fillet's edge
 * reference RE-RESOLVES against the moved solid's own snapshot (the
 * fillet-after-move-face battery).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createBodyId, length } from "@slopcad/cad-core";
import {
  assertVolumeClose,
  expectKernelFailure,
  KERNEL_ERROR_CODES,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";
import { EXACT_VOLUME_TOLERANCE } from "@slopcad/cad-kernel/contract-suite";
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
 * The ordinal of the face whose centroid z equals `zTarget` — the
 * discovery path a real feature drives through the Phase 22 snapshot
 * protocol (the shell fixture's finder).
 */
function faceOrdinalAtZ(
  kernel: OcctKernel,
  solid: KernelSolid,
  zTarget: number,
): number {
  const snapshot = unwrapKernelResult(
    kernel.topologySnapshot(solid, {
      bodyId: createBodyId("body_local_face_fixture"),
      regeneration: 0,
      kinds: ["face"],
    }),
    "topologySnapshot",
  );
  const found = snapshot.entities.find(
    (entity) =>
      entity.geometry.centroidAbsoluteMm !== undefined &&
      Math.abs(entity.geometry.centroidAbsoluteMm[2] - zTarget) < 1e-9,
  );
  if (found === undefined) {
    throw new Error(
      `Fixture invariant: no face centroids at z = ${String(zTarget)}.`,
    );
  }
  return found.ordinal;
}

describe("occt kernel moveFace: the probed face-sweep composition", () => {
  it("moves the top face out by 2 mm at the exact prism delta 7200 mm³", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    const moved = unwrapKernelResult(
      kernel.moveFace({
        target,
        face: top,
        direction: [0, 0, 1],
        distance: length(2),
      }),
      "moveFace out",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(moved), "moved volume"),
      7200,
      EXACT_VOLUME_TOLERANCE,
    );
    expect(
      unwrapKernelResult(kernel.bounds(moved), "moved bounds").max[2],
    ).toBeCloseTo(12, 9);
  });

  it("moves the top face in by 2 mm at the exact prism delta 4800 mm³", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    const moved = unwrapKernelResult(
      kernel.moveFace({
        target,
        face: top,
        direction: [0, 0, 1],
        distance: length(-2),
      }),
      "moveFace in",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(moved), "moved volume"),
      4800,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("moves the top face obliquely at the probe's exact 6960 mm³", () => {
    // The probe's oblique displacement (1.2, 0, 1.6) as direction + |d| = 2:
    // the swept prism is 30 × 20 × 1.6 = 960 mm³ and the fuse keeps the
    // box's 6000 plus the out-of-material part beyond the old face — the
    // union measures 6960 exactly (the oblique overhang adds the
    // triangular prism 30 × 20 × 1.2 / 2 = 360 on top of 6000 + 600... the
    // probe measured it; the fixture pins the measured-exact value).
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    const moved = unwrapKernelResult(
      kernel.moveFace({
        target,
        face: top,
        direction: [0.6, 0, 0.8],
        distance: length(2),
      }),
      "moveFace oblique",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(moved), "oblique volume"),
      6960,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("refuses a zero distance and a perpendicular displacement as no-ops", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    expectKernelFailure(
      kernel.moveFace({
        target,
        face: top,
        direction: [0, 0, 1],
        distance: length(0),
      }),
      KERNEL_ERROR_CODES.faceOpFailed,
      "zero-distance moveFace",
    );
    expectKernelFailure(
      kernel.moveFace({
        target,
        face: top,
        direction: [1, 0, 0],
        distance: length(5),
      }),
      KERNEL_ERROR_CODES.faceOpFailed,
      "perpendicular moveFace",
    );
  });

  it("refuses a degenerate direction and malformed or stale ordinals", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    expectKernelFailure(
      kernel.moveFace({
        target,
        face: top,
        direction: [0, 0, 0],
        distance: length(2),
      }),
      KERNEL_ERROR_CODES.invalidRotation,
      "zero-direction moveFace",
    );
    expectKernelFailure(
      kernel.moveFace({
        target,
        face: -1,
        direction: [0, 0, 1],
        distance: length(2),
      }),
      KERNEL_ERROR_CODES.invalidOperands,
      "negative-ordinal moveFace",
    );
    expectKernelFailure(
      kernel.moveFace({
        target,
        face: 99,
        direction: [0, 0, 1],
        distance: length(2),
      }),
      KERNEL_ERROR_CODES.faceOpFaceUnknown,
      "stale-ordinal moveFace",
    );
  });

  it("moves a side face inward at its own prism delta (depth shrink)", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const snapshot = unwrapKernelResult(
      kernel.topologySnapshot(target, {
        bodyId: createBodyId("body_local_face_fixture"),
        regeneration: 0,
        kinds: ["face"],
      }),
      "topologySnapshot",
    );
    const yMax = snapshot.entities.find(
      (entity) =>
        entity.geometry.centroidAbsoluteMm !== undefined &&
        Math.abs(entity.geometry.centroidAbsoluteMm[1] - 20) < 1e-9,
    );
    if (yMax === undefined) throw new Error("no +y face");
    const moved = unwrapKernelResult(
      kernel.moveFace({
        target,
        face: yMax.ordinal,
        direction: [0, 1, 0],
        distance: length(-4),
      }),
      "side moveFace",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(moved), "side volume"),
      30 * 16 * 10,
      EXACT_VOLUME_TOLERANCE,
    );
  });
});

describe("occt kernel replaceFace: the datum-plane re-close", () => {
  it("extends the top face to a parallel plane at z = 12 (7200 mm³)", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    const replaced = unwrapKernelResult(
      kernel.replaceFace({
        target,
        face: top,
        plane: {
          origin: { x: length(0), y: length(0), z: length(12) },
          normal: [0, 0, 1],
        },
      }),
      "replaceFace extend",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(replaced), "extended volume"),
      7200,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("shrinks the top face to a parallel plane at z = 8 (4800 mm³)", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    const replaced = unwrapKernelResult(
      kernel.replaceFace({
        target,
        face: top,
        plane: {
          origin: { x: length(0), y: length(0), z: length(8) },
          normal: [0, 0, 1],
        },
      }),
      "replaceFace shrink",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(replaced), "shrunk volume"),
      4800,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("refuses a plane at the face's own station as a no-op", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    expectKernelFailure(
      kernel.replaceFace({
        target,
        face: top,
        plane: {
          origin: { x: length(0), y: length(0), z: length(10) },
          normal: [0, 0, 1],
        },
      }),
      KERNEL_ERROR_CODES.faceOpFailed,
      "coplanar replaceFace",
    );
  });

  it("cuts the top region at a 45° oblique plane (3600 mm³)", () => {
    // Plane through (15, 10, 7) with normal (0, −√2/2, +√2/2): the kept
    // side (the volume-centroid side) is z − 7 ≤ y − 10, the removed
    // wedge above it measures 2 400 mm³ of the 6 000 box — 30 · [30 +
    // (130 − 80)] — so the re-closed solid measures 3 600.
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    const replaced = unwrapKernelResult(
      kernel.replaceFace({
        target,
        face: top,
        plane: {
          origin: { x: length(15), y: length(10), z: length(7) },
          normal: [0, -Math.SQRT1_2, Math.SQRT1_2],
        },
      }),
      "replaceFace oblique",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(replaced), "oblique volume"),
      3600,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("refuses an oblique plane that does not bound the replaced face", () => {
    // The plane at (15, 10, 15) tilted 45° clears the whole box on the
    // kept side: the top face's centre lies on the KEPT side, so the cut
    // would replace some other boundary — the structured refusal.
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    expectKernelFailure(
      kernel.replaceFace({
        target,
        face: top,
        plane: {
          origin: { x: length(15), y: length(10), z: length(15) },
          normal: [0, Math.SQRT1_2, Math.SQRT1_2],
        },
      }),
      KERNEL_ERROR_CODES.faceOpFailed,
      "non-bounding replaceFace",
    );
  });

  it("refuses a degenerate plane normal and a stale face ordinal", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    expectKernelFailure(
      kernel.replaceFace({
        target,
        face: top,
        plane: {
          origin: { x: length(0), y: length(0), z: length(12) },
          normal: [0, 0, 0],
        },
      }),
      KERNEL_ERROR_CODES.invalidRotation,
      "zero-normal replaceFace",
    );
    expectKernelFailure(
      kernel.replaceFace({
        target,
        face: 99,
        plane: {
          origin: { x: length(0), y: length(0), z: length(12) },
          normal: [0, 0, 1],
        },
      }),
      KERNEL_ERROR_CODES.faceOpFaceUnknown,
      "stale-ordinal replaceFace",
    );
  });
});

describe("occt kernel deleteFace: the probed-out decline", () => {
  it("declines both heal modes with the structured unsupported code", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    for (const heal of [false, true]) {
      expectKernelFailure(
        kernel.deleteFace({ target, face: top, heal }),
        KERNEL_ERROR_CODES.unsupportedOperation,
        `deleteFace heal=${String(heal)}`,
      );
    }
  });

  it("still surfaces a stale ordinal as the stale-reference code", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    expectKernelFailure(
      kernel.deleteFace({ target, face: 99, heal: false }),
      KERNEL_ERROR_CODES.faceOpFaceUnknown,
      "stale-ordinal deleteFace",
    );
  });
});

describe("occt kernel fillet-after-move-face: snapshot re-resolution", () => {
  it("fillets a moved solid's re-resolved top rim edges at the analytic volume", () => {
    // The roadmap's topology-stability battery: the box's top face moves
    // −2 mm (the cut side of the composition — the side faces trim to one
    // face each, no fuse seam); a fillet addressing the MOVED solid's own
    // snapshot edges (the re-resolution a persistent reference drives
    // through regeneration) rounds the new prism's rim — the fixture
    // keeps it exact with the two DISJOINT opposite rim edges (the probed
    // fillet taxonomy: edges that share a corner interfere and fail
    // IsDone): r = 2 removes r²(1 − π/4)·L per edge, L = 30 each.
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = faceOrdinalAtZ(kernel, target, 10);
    const moved = unwrapKernelResult(
      kernel.moveFace({
        target,
        face: top,
        direction: [0, 0, 1],
        distance: length(-2),
      }),
      "moveFace for fillet",
    );
    // The re-resolution: edge ordinals read from the MOVED solid's own
    // snapshot — exactly what resolveDocumentReference yields against the
    // current regeneration.
    const snapshot = unwrapKernelResult(
      kernel.topologySnapshot(moved, {
        bodyId: createBodyId("body_local_face_fixture"),
        regeneration: 1,
        kinds: ["edge"],
      }),
      "moved topologySnapshot",
    );
    const rimEdges = snapshot.entities.filter(
      (entity) =>
        entity.geometry.centroidAbsoluteMm !== undefined &&
        Math.abs(entity.geometry.centroidAbsoluteMm[2] - 8) < 1e-9 &&
        (Math.abs(entity.geometry.centroidAbsoluteMm[1]) < 1e-9 ||
          Math.abs(entity.geometry.centroidAbsoluteMm[1] - 20) < 1e-9),
    );
    expect(rimEdges.length).toBe(2);
    const filleted = unwrapKernelResult(
      kernel.fillet({
        target: moved,
        edges: rimEdges.map((edge) => edge.ordinal),
        radius: length(2),
      }),
      "fillet after moveFace",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(filleted), "filleted volume"),
      30 * 20 * 8 - 2 * 2 * (1 - Math.PI / 4) * 2 * 30,
      1e-9,
    );
  });
});
