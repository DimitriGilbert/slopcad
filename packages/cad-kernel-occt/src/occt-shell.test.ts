/**
 * OCCT-adapter shell tests (Phase 26.7): everything the shared contract
 * suite does not prove about the BREP hollowing path — face addressing
 * through the kernel's OWN topology snapshots (the Phase 22 machinery:
 * persistent face references resolve to snapshot ordinals, and `shell`
 * consumes the resolved addresses), the two-face opening's exact cavity,
 * the translated target, the too-thick degeneracy's structured refusal
 * (probed: the engine itself NEVER declines degenerate thicknesses — past
 * the collapse it silently returns the pristine target, at an exact
 * cross-collapse a zero-volume solid, and at the exact open-axis collapse
 * `Shape()` throws inside the WASM boundary; the adapter's post-condition
 * and no-throw boundary are the structured answer), and the fake-vs-OCCT
 * equivalence of the analytic open-box model.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { length, createBodyId } from "@slopcad/cad-core";
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
 * The top-face ordinal of a box straight from the kernel's topology
 * snapshot: the face whose centroid z equals the height — the discovery
 * path a real shell feature drives through the Phase 22 protocol.
 */
function topFaceOrdinal(kernel: OcctKernel, solid: KernelSolid): number {
  const snapshot = unwrapKernelResult(
    kernel.topologySnapshot(solid, {
      bodyId: createBodyId("body_shell_fixture"),
      regeneration: 0,
      kinds: ["face"],
    }),
    "topologySnapshot",
  );
  const top = snapshot.entities.find(
    (entity) =>
      entity.geometry.centroidAbsoluteMm !== undefined &&
      Math.abs(entity.geometry.centroidAbsoluteMm[2] - 10) < 1e-9,
  );
  if (top === undefined) {
    throw new Error("Fixture invariant: the box's top face was not found.");
  }
  return top.ordinal;
}

describe("occt kernel shell: snapshot-addressed hollowing", () => {
  it("hollows a snapshot-resolved top face at the exact analytic volume", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = topFaceOrdinal(kernel, target);
    const solid = unwrapKernelResult(
      kernel.shell({ target, faces: [top], thickness: length(2) }),
      "snapshot shell",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "shell volume"),
      30 * 20 * 10 - (30 - 4) * (20 - 4) * (10 - 2),
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "shell bounds"),
      { min: [0, 0, 0], max: [30, 20, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("parameterizes the thickness: t = 3 removes its own cavity", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = topFaceOrdinal(kernel, target);
    const solid = unwrapKernelResult(
      kernel.shell({ target, faces: [top], thickness: length(3) }),
      "t = 3 shell",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "t = 3 volume"),
      30 * 20 * 10 - (30 - 6) * (20 - 6) * (10 - 3),
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("hollows a translated box through its translated snapshot's ordinal", () => {
    const kernel = makeKernel();
    const moved = unwrapKernelResult(
      kernel.transform(box(kernel, 30, 20, 10), {
        x: length(100),
        y: length(-50),
        z: length(7),
      }),
      "transform",
    );
    const snapshot = unwrapKernelResult(
      kernel.topologySnapshot(moved, {
        bodyId: createBodyId("body_shell_translated"),
        regeneration: 0,
        kinds: ["face"],
      }),
      "topologySnapshot",
    );
    const top = snapshot.entities.find(
      (entity) =>
        entity.geometry.centroidAbsoluteMm !== undefined &&
        Math.abs(entity.geometry.centroidAbsoluteMm[2] - 17) < 1e-9,
    );
    if (top === undefined) {
      throw new Error(
        "Fixture invariant: the translated top face was not found.",
      );
    }
    const solid = unwrapKernelResult(
      kernel.shell({
        target: moved,
        faces: [top.ordinal],
        thickness: length(2),
      }),
      "translated shell",
    );
    // Rigid translation leaves the volume exact and shifts the bounds.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "translated shell volume"),
      30 * 20 * 10 - (30 - 4) * (20 - 4) * (10 - 2),
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "translated shell bounds"),
      { min: [100, -50, 7], max: [130, -30, 17] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("opens two faces at the exact combined cavity", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const snapshot = unwrapKernelResult(
      kernel.topologySnapshot(target, {
        bodyId: createBodyId("body_shell_two_face"),
        regeneration: 0,
        kinds: ["face"],
      }),
      "topologySnapshot",
    );
    // The top face (centroid z = 10) and one y-normal side face (area
    // 30 × 10 = 300, centroid z = 5).
    const top = snapshot.entities.find(
      (entity) =>
        entity.geometry.centroidAbsoluteMm !== undefined &&
        Math.abs(entity.geometry.centroidAbsoluteMm[2] - 10) < 1e-9,
    );
    const side = snapshot.entities.find(
      (entity) =>
        entity.geometry.areaMm2 !== undefined &&
        Math.abs(entity.geometry.areaMm2 - 300) < 1e-6 &&
        entity.geometry.centroidAbsoluteMm !== undefined &&
        Math.abs(entity.geometry.centroidAbsoluteMm[2] - 5) < 1e-9,
    );
    if (top === undefined || side === undefined) {
      throw new Error(
        "Fixture invariant: the two opening faces were not found.",
      );
    }
    // Removing the top and one y side: cavity (30−2t) × (20−t) × (10−t).
    const solid = unwrapKernelResult(
      kernel.shell({
        target,
        faces: [top.ordinal, side.ordinal],
        thickness: length(2),
      }),
      "two-face shell",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "two-face volume"),
      30 * 20 * 10 - (30 - 4) * (20 - 2) * (10 - 2),
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("reports full topology on the shelled solid for chained features", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = topFaceOrdinal(kernel, target);
    const solid = unwrapKernelResult(
      kernel.shell({ target, faces: [top], thickness: length(2) }),
      "snapshot shell",
    );
    const snapshot = unwrapKernelResult(
      kernel.topologySnapshot(solid, {
        bodyId: createBodyId("body_shell_chained"),
        regeneration: 1,
      }),
      "topologySnapshot",
    );
    const faces = snapshot.entities.filter((entity) => entity.kind === "face");
    const edges = snapshot.entities.filter((entity) => entity.kind === "edge");
    // Probed: the one-face shell carries 11 faces (5 kept outer + 5 cavity
    // + the rim's opening counted as one face by the engine's face
    // decomposition) and 24 collapsed edges — a fillet or chamfer chained
    // onto the shell's rim addresses real edges.
    expect(faces).toHaveLength(11);
    expect(edges).toHaveLength(24);
  });

  it("rejects a stale ordinal with kernel/shell-face-unknown", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    expectKernelFailure(
      kernel.shell({ target, faces: [999], thickness: length(2) }),
      KERNEL_ERROR_CODES.shellFaceUnknown,
      "ordinal past the snapshot numbering",
    );
    // A malformed ordinal is invalid-operands, not the stale signature.
    expectKernelFailure(
      kernel.shell({ target, faces: [-1], thickness: length(2) }),
      KERNEL_ERROR_CODES.invalidOperands,
      "negative ordinal",
    );
    // The empty list is the closed hollow — out of contract scope (probed:
    // the engine's zero-face answer is the offset cavity region, not the
    // walls).
    expectKernelFailure(
      kernel.shell({ target, faces: [], thickness: length(2) }),
      KERNEL_ERROR_CODES.invalidOperands,
      "empty face list",
    );
    // And a valid ordinal of a DISPOSED solid is ownership, not addressing.
    const other = makeKernel();
    const foreign = box(other, 5, 5, 5);
    expectKernelFailure(
      kernel.shell({ target: foreign, faces: [0], thickness: length(1) }),
      KERNEL_ERROR_CODES.solidNotOwned,
      "foreign target",
    );
  });

  it("surfaces too-thick walls as the structured shell failure, never the degenerate solid", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = topFaceOrdinal(kernel, target);
    // Probed: past the collapse (t = 12 over the 10 mm open extent) the
    // engine silently returns the PRISTINE target — volume 6000 mm³, face
    // removal gone — and the adapter's post-condition is what refuses.
    expectKernelFailure(
      kernel.shell({ target, faces: [top], thickness: length(12) }),
      KERNEL_ERROR_CODES.shellFailed,
      "past the collapse",
    );
    // The exact open-axis collapse (t = H = 10) throws inside Shape(); the
    // no-throw boundary normalizes the throw into the same structured code.
    expectKernelFailure(
      kernel.shell({ target, faces: [top], thickness: length(10) }),
      KERNEL_ERROR_CODES.shellFailed,
      "exact collapse",
    );
    // A zero thickness is pre-validated away from the engine (probed: the
    // one input MakeThickSolidByJoin answers IsDone = false for).
    expectKernelFailure(
      kernel.shell({ target, faces: [top], thickness: length(0) }),
      KERNEL_ERROR_CODES.invalidLength,
      "zero thickness",
    );
  });

  it("agrees with the fake kernel's analytic model on the one-face fixture", () => {
    const kernel = makeKernel();
    const target = box(kernel, 30, 20, 10);
    const top = topFaceOrdinal(kernel, target);
    const occtSolid = unwrapKernelResult(
      kernel.shell({ target, faces: [top], thickness: length(2) }),
      "occt shell",
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
    // The fake's box-face table puts the z-high face at ordinal 5 (its own
    // documented convention — cross-kernel ordinal transport is
    // meaningless by design; only the SEMANTICS must agree).
    const fakeSolid = unwrapKernelResult(
      fakeKernel.shell({
        target: fakeTarget,
        faces: [5],
        thickness: length(2),
      }),
      "fake shell",
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
