/**
 * The cross-kernel semantic-equivalence suite (Phase 21's phase-level
 * criterion: "Supported models produce equivalent semantic results within
 * documented differences"): THE same scenes are built on BOTH real kernels —
 * Manifold (mesh) and OpenCascade (BREP) — and compared semantically, never
 * by buffer equality. This is the permanent regression seed Phase 23 (JSCAD)
 * extends: build the same scenes on a third kernel and widen the pairwise
 * comparisons below.
 *
 * It lives in the OCCT package because the dependency direction runs this
 * way only (the later kernel may depend on the earlier one; Manifold must
 * not know OCCT exists), via a devDependency on
 * `@slopcad/cad-kernel-manifold`. Scenes build through the kernel-neutral
 * fixtures both kernel packages already exercise, so no kernel-specific type
 * crosses this file.
 *
 * ## Comparison policy (mirrors the contract suite's capability honesty)
 *
 * 1. MUST AGREE EXACTLY (the contract suite's EXACT bands: 1e-9 relative
 *    volume, 1e-9 mm bounds): planar geometry — primitive box volumes,
 *    translated bounds, axis-aligned boolean volumes and bounds. Both
 *    kernels declare `exactPrimitiveVolumes`/`exactBooleanVolumes`/
 *    `tightBooleanBounds` AND both are exact w.r.t. the SAME true planar
 *    geometry: OCCT integrates exact BREPs, Manifold's divergence-theorem
 *    volume runs over an exactly-planar boundary mesh. Measured here:
 *    disjoint-box union cross-agrees to 3.4e-16 relative; translated bounds
 *    to 0.
 * 2. AGREES WITHIN DOCUMENTED BANDS (`CURVED_VOLUME_TOLERANCE`, 5%): curved
 *    geometry. `exactBooleanVolumes: true` is exactness w.r.t. each kernel's
 *    OWN representation, and the representations genuinely differ: OCCT
 *    integrates the true curved bore (measured 0 rel err vs analytic on the
 *    plate), while Manifold's cylinder is a polygonal discretization
 *    (measured +0.077% on the plate, worst chain step +0.65%). Volumes
 *    derived from each kernel's tessellation carry their own bands:
 *    Manifold's tessellation IS its representation (float32 noise, measured
 *    2.6e-9), OCCT's is a 0.1 mm-deflection discretization of its exact BREP
 *    (measured +0.089%).
 * 3. LEGITIMATELY DIFFERS: tessellation structure and rotation. Triangle
 *    counts, vertex layout, and normals provenance are per-kernel choices —
 *    OCCT 120 tris vs Manifold 128 on the plate, the Phase 21 pre-spike's §7
 *    note (docs/architecture/occt-prespike-findings.md), reproduced by these
 *    runs — so only counts > 0 and structural validity are asserted, never
 *    counts equality. Rotation is OCCT-only (`transformRotation` differs),
 *    which scopes cross-kernel equivalence to the translation-only common
 *    ops; the OCCT-only rotation is exercised for its own invariants (volume
 *    preserved exactly, analytic rotated bounds), and its measure still
 *    agrees cross-kernel because volume is rotation-invariant.
 *    `persistentTopology` likewise differs (OCCT true, Manifold false) —
 *    Phase 22's concern, not compared here.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  assertBoundsEqual,
  assertVolumeClose,
  type GeometryKernel,
  KERNEL_BACKEND_IDS,
  type KernelSolid,
  tessellationTriangleCount,
  type Tessellation,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";
import {
  CURVED_VOLUME_TOLERANCE,
  EXACT_BOUNDS_TOLERANCE,
  EXACT_VOLUME_TOLERANCE,
} from "@slopcad/cad-kernel/contract-suite";
import {
  createManifoldRuntime,
  manifoldKernelFromRuntime,
  type ManifoldRuntime,
} from "@slopcad/cad-kernel-manifold";

import { buildBooleanChain, buildPlateWithHole } from "./occt-fixtures";
import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

/**
 * Relative band for mesh-derived vs kernel-measured volume on Manifold: its
 * tessellation IS its boundary representation, so the divergence theorem
 * over the soup re-derives the same measure up to float32 vertex noise
 * (measured 2.6e-9 on the plate when this suite was written).
 */
const MANIFOLD_MESH_VOLUME_TOLERANCE = 1e-6;

/**
 * Relative band for mesh-derived vs kernel-measured volume on OCCT: the
 * kernel integrates its exact BREP, while `tessellate` discretizes curved
 * faces at a 0.1 mm linear deflection, so the mesh volume sits slightly off
 * the exact one (measured +0.089% on the plate; the deflection error scales
 * with curvature, not model size, so 1% is the honest ceiling).
 */
const OCCT_MESH_VOLUME_TOLERANCE = 1e-2;

/** The capability flags both real kernels must share for policy 1 to hold. */
const SHARED_EXACTNESS_FLAGS = [
  "booleans",
  "transformTranslation",
  "exactPrimitiveVolumes",
  "exactBooleanVolumes",
  "tightBooleanBounds",
] as const;

/**
 * Derives a mesh's volume (mm³) by the divergence theorem: one sixtet per
 * indexed triangle, summed. Winding orientation is not part of the compared
 * contract (`assertTessellationValid` judges structure, not winding), so the
 * magnitude of the signed sum is the mesh volume.
 */
function meshVolumeMm3(tessellation: Tessellation): number {
  const { positions, indices } = tessellation;
  const coordinate = (flatIndex: number): number => {
    const value = positions[flatIndex];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(
        `Mesh volume divergence read a non-finite position at flat index ${flatIndex}.`,
      );
    }
    return value;
  };
  let signedSixtets = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t];
    const ib = indices[t + 1];
    const ic = indices[t + 2];
    if (ia === undefined || ib === undefined || ic === undefined) {
      throw new Error(`Mesh volume divergence read a missing index at ${t}.`);
    }
    const ax = coordinate(ia * 3);
    const ay = coordinate(ia * 3 + 1);
    const az = coordinate(ia * 3 + 2);
    const bx = coordinate(ib * 3);
    const by = coordinate(ib * 3 + 1);
    const bz = coordinate(ib * 3 + 2);
    const cx = coordinate(ic * 3);
    const cy = coordinate(ic * 3 + 1);
    const cz = coordinate(ic * 3 + 2);
    signedSixtets +=
      ax * (by * cz - bz * cy) +
      ay * (bz * cx - bx * cz) +
      az * (bx * cy - by * cx);
  }
  return Math.abs(signedSixtets / 6);
}

function volumeOf(kernel: GeometryKernel, solid: KernelSolid, label: string) {
  return unwrapKernelResult(kernel.volume(solid), label);
}

function boundsOf(kernel: GeometryKernel, solid: KernelSolid, label: string) {
  return unwrapKernelResult(kernel.bounds(solid), label);
}

function tessellationOf(
  kernel: GeometryKernel,
  solid: KernelSolid,
  label: string,
) {
  return unwrapKernelResult(kernel.tessellate(solid), label);
}

function boxOf(
  kernel: GeometryKernel,
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

function translated(
  kernel: GeometryKernel,
  solid: KernelSolid,
  x: number,
  y: number,
  z: number,
): KernelSolid {
  return unwrapKernelResult(
    kernel.transform(solid, { x: length(x), y: length(y), z: length(z) }),
    "transform",
  );
}

describe("cross-kernel semantic equivalence: manifold vs opencascade", () => {
  let occtRuntime: OcctRuntime;
  let manifoldRuntime: ManifoldRuntime;

  beforeAll(async () => {
    // Both WASM runtimes boot once (~180 ms OCCT, ~12 ms Manifold); every
    // test still creates FRESH kernel instances, preserving per-instance
    // ownership semantics on both sides.
    [occtRuntime, manifoldRuntime] = await Promise.all([
      createOcctRuntime(),
      createManifoldRuntime(),
    ]);
  });

  const makeOcct = (): GeometryKernel => occtKernelFromRuntime(occtRuntime);
  const makeManifold = (): GeometryKernel =>
    manifoldKernelFromRuntime(manifoldRuntime);

  it("declares the shared exactness ground the policy branches on, and the documented divergences", () => {
    const occt = makeOcct();
    const manifold = makeManifold();
    // Two distinct, registry-known backends — the comparison is real.
    expect(manifold.id).not.toBe(occt.id);
    expect(KERNEL_BACKEND_IDS).toContain(manifold.id);
    expect(KERNEL_BACKEND_IDS).toContain(occt.id);
    // Policy 1's precondition: both declare the exactness flags, so
    // exact-to-exact agreement is owed on planar geometry.
    for (const flag of SHARED_EXACTNESS_FLAGS) {
      expect(manifold.capabilities[flag]).toBe(true);
      expect(occt.capabilities[flag]).toBe(true);
    }
    // Documented divergences: rotation and persistent topology are OCCT-only
    // today, which is why cross-kernel equivalence is judged over the
    // translation-only common ops.
    expect(manifold.capabilities.transformRotation).toBe(false);
    expect(occt.capabilities.transformRotation).toBe(true);
    expect(manifold.capabilities.persistentTopology).toBe(false);
    expect(occt.capabilities.persistentTopology).toBe(true);
  });

  it("builds the plate-with-hole on both kernels: exact bounds, curved-band volumes, non-empty meshes", () => {
    const manifold = makeManifold();
    const occt = makeOcct();
    const m = buildPlateWithHole(manifold);
    const o = buildPlateWithHole(occt);
    const manifoldVolume = volumeOf(manifold, m.result, "manifold plate volume");
    const occtVolume = volumeOf(occt, o.result, "occt plate volume");
    // OCCT integrates the true curved bore: exact against the analytic value
    // (measured 0 rel err; the pre-spike's headline exactness result).
    assertVolumeClose(occtVolume, o.analyticVolumeMm3, EXACT_VOLUME_TOLERANCE);
    // Manifold is exact for its own polygonal-bore representation, so its
    // measure sits inside the documented curved band of the analytic value
    // (measured +0.077%, the pre-spike's mesh-divergence number).
    assertVolumeClose(manifoldVolume, m.analyticVolumeMm3, CURVED_VOLUME_TOLERANCE);
    // Cross-kernel agreement carries the same documented band.
    assertVolumeClose(manifoldVolume, occtVolume, CURVED_VOLUME_TOLERANCE);
    // Bounds: both kernels declare tight boolean bounds and every face of
    // the true result lies on the plate's box — exact cross-kernel equality.
    const manifoldBounds = boundsOf(manifold, m.result, "manifold plate bounds");
    const occtBounds = boundsOf(occt, o.result, "occt plate bounds");
    assertBoundsEqual(manifoldBounds, m.tightBounds, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(occtBounds, o.tightBounds, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(manifoldBounds, occtBounds, EXACT_BOUNDS_TOLERANCE);
    // Meshes: structurally different by design (measured 128 tris on
    // Manifold vs 120 on OCCT — the pre-spike §7 note), so only presence is
    // owed; structure is policy 3's legitimate difference.
    expect(
      tessellationTriangleCount(
        tessellationOf(manifold, m.result, "manifold plate tessellation"),
      ),
    ).toBeGreaterThan(0);
    expect(
      tessellationTriangleCount(
        tessellationOf(occt, o.result, "occt plate tessellation"),
      ),
    ).toBeGreaterThan(0);
  });

  it("agrees exactly on the planar boolean common ops: disjoint union and overlapping intersect", () => {
    // The planar halves of the contract suite's boolean battery, run on both
    // kernels: exact-to-exact is owed and measured (worst observed delta
    // 3.4e-16 relative).
    const manifold = makeManifold();
    const occt = makeOcct();
    const unionVolumeOf = (kernel: GeometryKernel) => {
      const left = boxOf(kernel, 10, 10, 10);
      const right = translated(kernel, boxOf(kernel, 10, 10, 10), 30, 0, 0);
      const union = unwrapKernelResult(kernel.union([left, right]), "union");
      return {
        volume: volumeOf(kernel, union, "union volume"),
        bounds: boundsOf(kernel, union, "union bounds"),
      };
    };
    const overlapVolumeOf = (kernel: GeometryKernel) => {
      const big = boxOf(kernel, 20, 20, 10);
      const small = translated(kernel, boxOf(kernel, 10, 10, 10), 5, 5, 0);
      const overlap = unwrapKernelResult(
        kernel.intersect([big, small]),
        "intersect",
      );
      return volumeOf(kernel, overlap, "intersect volume");
    };
    const manifoldUnion = unionVolumeOf(manifold);
    const occtUnion = unionVolumeOf(occt);
    assertVolumeClose(manifoldUnion.volume, 2000, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(occtUnion.volume, 2000, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(
      manifoldUnion.volume,
      occtUnion.volume,
      EXACT_VOLUME_TOLERANCE,
    );
    const unionTight = { min: [0, 0, 0], max: [40, 10, 10] } as const;
    assertBoundsEqual(manifoldUnion.bounds, unionTight, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(occtUnion.bounds, unionTight, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(
      manifoldUnion.bounds,
      occtUnion.bounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    const manifoldOverlap = overlapVolumeOf(manifold);
    const occtOverlap = overlapVolumeOf(occt);
    assertVolumeClose(manifoldOverlap, 1000, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(occtOverlap, 1000, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(manifoldOverlap, occtOverlap, EXACT_VOLUME_TOLERANCE);
  });

  it("agrees step-by-step on the boolean chain within the documented bands", () => {
    const manifold = makeManifold();
    const occt = makeOcct();
    const m = buildBooleanChain(manifold);
    const o = buildBooleanChain(occt);
    // Union step: planar, so exact-to-exact cross-kernel agreement is owed.
    const manifoldUnion = volumeOf(manifold, m.union, "manifold union volume");
    const occtUnion = volumeOf(occt, o.union, "occt union volume");
    assertVolumeClose(manifoldUnion, m.unionVolumeMm3, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(occtUnion, o.unionVolumeMm3, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(manifoldUnion, occtUnion, EXACT_VOLUME_TOLERANCE);
    assertBoundsEqual(
      boundsOf(manifold, m.union, "manifold union bounds"),
      m.unionTightBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    assertBoundsEqual(
      boundsOf(occt, o.union, "occt union bounds"),
      o.unionTightBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    // Drilled and trimmed steps carry the curved bore: OCCT stays exact
    // against the analytic values, Manifold sits in the curved band, and the
    // cross-kernel deltas stay inside the same band (measured worst +0.65%
    // on the trimmed step).
    const manifoldCut = volumeOf(manifold, m.cut, "manifold cut volume");
    const occtCut = volumeOf(occt, o.cut, "occt cut volume");
    assertVolumeClose(occtCut, o.cutAnalyticVolumeMm3, EXACT_VOLUME_TOLERANCE);
    assertVolumeClose(
      manifoldCut,
      m.cutAnalyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(manifoldCut, occtCut, CURVED_VOLUME_TOLERANCE);
    const manifoldTrimmed = volumeOf(
      manifold,
      m.trimmed,
      "manifold trimmed volume",
    );
    const occtTrimmed = volumeOf(occt, o.trimmed, "occt trimmed volume");
    assertVolumeClose(
      occtTrimmed,
      o.trimmedAnalyticVolumeMm3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      manifoldTrimmed,
      m.trimmedAnalyticVolumeMm3,
      CURVED_VOLUME_TOLERANCE,
    );
    assertVolumeClose(manifoldTrimmed, occtTrimmed, CURVED_VOLUME_TOLERANCE);
    // The trimmed result is the left block alone: every face planar and on
    // the block's box, so bounds agree exactly cross-kernel.
    assertBoundsEqual(
      boundsOf(manifold, m.trimmed, "manifold trimmed bounds"),
      m.trimmedTightBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
    assertBoundsEqual(
      boundsOf(occt, o.trimmed, "occt trimmed bounds"),
      o.trimmedTightBounds,
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("derives agreeing volumes from each kernel's own tessellation within the mesh bands", () => {
    const manifold = makeManifold();
    const occt = makeOcct();
    const m = buildPlateWithHole(manifold);
    const o = buildPlateWithHole(occt);
    const manifoldMesh = tessellationOf(
      manifold,
      m.result,
      "manifold plate tessellation",
    );
    const occtMesh = tessellationOf(occt, o.result, "occt plate tessellation");
    // Divergence-theorem volume of each soup vs its own kernel's measure:
    // Manifold's soup IS its representation (float32 noise band), OCCT's is
    // a 0.1 mm-deflection discretization of an exactly-integrated BREP
    // (curved-deflection band).
    assertVolumeClose(
      meshVolumeMm3(manifoldMesh),
      volumeOf(manifold, m.result, "manifold plate volume"),
      MANIFOLD_MESH_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      meshVolumeMm3(occtMesh),
      volumeOf(occt, o.result, "occt plate volume"),
      OCCT_MESH_VOLUME_TOLERANCE,
    );
    // The two independent discretizations of the same plate agree with each
    // other inside the documented curved band (measured 1.2e-4 relative —
    // the meshes agree more closely than the kernel measures themselves,
    // because both under-approximate the bore similarly).
    assertVolumeClose(
      meshVolumeMm3(manifoldMesh),
      meshVolumeMm3(occtMesh),
      CURVED_VOLUME_TOLERANCE,
    );
  });

  it("preserves equivalence under the translation-only common op", () => {
    const manifold = makeManifold();
    const occt = makeOcct();
    const m = buildPlateWithHole(manifold);
    const o = buildPlateWithHole(occt);
    // The one transform both kernels declare: the same translation applied
    // to the same model shifts both kernels' bounds identically (exact) and
    // preserves each kernel's own volume exactly (measured 0 delta on both).
    const moved = { x: length(5), y: length(-2), z: length(7) };
    const manifoldMoved = unwrapKernelResult(
      manifold.transform(m.result, moved),
      "manifold translate",
    );
    const occtMoved = unwrapKernelResult(
      occt.transform(o.result, moved),
      "occt translate",
    );
    const shifted = { min: [5, -2, 7], max: [35, 18, 17] } as const;
    const manifoldBounds = boundsOf(
      manifold,
      manifoldMoved,
      "manifold translated bounds",
    );
    const occtBounds = boundsOf(occt, occtMoved, "occt translated bounds");
    assertBoundsEqual(manifoldBounds, shifted, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(occtBounds, shifted, EXACT_BOUNDS_TOLERANCE);
    assertBoundsEqual(manifoldBounds, occtBounds, EXACT_BOUNDS_TOLERANCE);
    assertVolumeClose(
      volumeOf(manifold, manifoldMoved, "manifold translated volume"),
      volumeOf(manifold, m.result, "manifold plate volume"),
      EXACT_VOLUME_TOLERANCE,
    );
    assertVolumeClose(
      volumeOf(occt, occtMoved, "occt translated volume"),
      volumeOf(occt, o.result, "occt plate volume"),
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("keeps rotation an OCCT-only extension whose measure still agrees cross-kernel", () => {
    // Manifold does not declare transformRotation (asserted by the
    // capability test), so the rotated scene has no Manifold twin — this is
    // the documented difference, not a comparison gap. OCCT's rotation is
    // judged on its own invariants: volume preserved exactly and the tight
    // bounds equal to the analytically rotated plate (x ∈ [-20, 0],
    // y ∈ [0, 30]); and because volume is rotation-invariant, the rotated
    // measure still agrees with Manifold's unrotated one inside the curved
    // band — the cross-kernel volume criterion survives rigid motion.
    const manifold = makeManifold();
    const occt = makeOcct();
    const m = buildPlateWithHole(manifold);
    const o = buildPlateWithHole(occt);
    const rotated = unwrapKernelResult(
      occt.transform(o.result, {
        x: length(0),
        y: length(0),
        z: length(0),
        rotation: { axis: [0, 0, 1], angle: angle(90, "deg") },
      }),
      "occt rotate",
    );
    const rotatedVolume = volumeOf(occt, rotated, "occt rotated volume");
    const occtVolume = volumeOf(occt, o.result, "occt plate volume");
    assertVolumeClose(rotatedVolume, occtVolume, EXACT_VOLUME_TOLERANCE);
    assertBoundsEqual(
      boundsOf(occt, rotated, "occt rotated bounds"),
      { min: [-20, 0, 0], max: [0, 30, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
    assertVolumeClose(
      rotatedVolume,
      volumeOf(manifold, m.result, "manifold plate volume"),
      CURVED_VOLUME_TOLERANCE,
    );
  });
});
